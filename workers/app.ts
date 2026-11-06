// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";

export { CommsDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

// ── Logto access-token verification (poxme integration) ────────────
// Replaces the upstream Cloudflare Access gate. Mirrors the canonical
// pattern in poxme-platform/cloudflare/api-worker/src/middleware/auth.ts:
// verify a Logto-issued `at+jwt` bearer against auth.pox.me's JWKS.
//
// Scoped (below) to /api/v1/*, /mcp*, and /agents/* — NOT the React Router
// SPA catch-all, which must serve HTML/assets unauthenticated so the client
// can run its own login flow.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksCreatedAt = 0;
const JWKS_MAX_AGE_MS = 10 * 60 * 1000; // refresh JWKS every 10 min

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [leftHash, rightHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(left)),
		crypto.subtle.digest("SHA-256", encoder.encode(right)),
	]);
	const a = new Uint8Array(leftHash);
	const b = new Uint8Array(rightHash);
	let mismatch = 0;
	for (let i = 0; i < a.length; i += 1) mismatch |= a[i] ^ b[i];
	return mismatch === 0;
}

export function bearerTokenFromRequest(request: Request): string {
	const authorization = request.headers.get("Authorization");
	if (authorization?.startsWith("Bearer ")) {
		return authorization.slice(7);
	}

	const protocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
		.split(",")
		.map((protocol) => protocol.trim());
	const authProtocol = protocols.find((protocol) => protocol.startsWith("poxme-auth."));
	return authProtocol?.slice("poxme-auth.".length) ?? "";
}

const requireLogto = createMiddleware<{
	Bindings: Env;
	Variables: { userId: string };
}>(async (c, next) => {
	// Skip auth entirely in local development.
	if (import.meta.env.DEV) {
		c.set("userId", c.req.header("x-poxme-user-id") || "dev-user");
		return next();
	}

	// Trust internal calls arriving over the api-worker service binding.
	const internalSecret = c.req.header("x-internal-secret");
	const internalUser = c.req.header("x-poxme-user-id");
	if (
		internalSecret &&
		c.env.INTERNAL_SECRET &&
		await timingSafeEqual(internalSecret, c.env.INTERNAL_SECRET) &&
		internalUser
	) {
		c.set("userId", internalUser);
		return next();
	}

	const { LOGTO_ENDPOINT, API_AUDIENCE } = c.env;
	if (!LOGTO_ENDPOINT || !API_AUDIENCE) {
		return c.text(
			"Logto auth is not configured. Set LOGTO_ENDPOINT and API_AUDIENCE.",
			500,
		);
	}

	// Browsers may carry WebSocket credentials in the `poxme-auth.<JWT>`
	// subprotocol. Query-string bearer tokens are deliberately rejected because
	// URLs are routinely retained in logs, history, and monitoring systems.
	const token = bearerTokenFromRequest(c.req.raw);
	if (token.length < 10 || token.length > 4096) {
		return c.text("Missing or malformed bearer token", 401);
	}

	try {
		if (!jwks || Date.now() - jwksCreatedAt > JWKS_MAX_AGE_MS) {
			jwks = createRemoteJWKSet(new URL(`${LOGTO_ENDPOINT}/oidc/jwks`));
			jwksCreatedAt = Date.now();
		}
		const { payload, protectedHeader } = await jwtVerify(token, jwks, {
			issuer: `${LOGTO_ENDPOINT}/oidc`,
			audience: API_AUDIENCE,
		});
		const trustedClientIds = new Set(
			(c.env.TRUSTED_FIRST_PARTY_CLIENT_IDS ?? "")
				.split(",")
				.map((clientId) => clientId.trim())
				.filter(Boolean),
		);
		if (
			protectedHeader.typ !== "at+jwt" ||
			!payload.sub ||
			typeof payload.client_id !== "string" ||
			!trustedClientIds.has(payload.client_id)
		) {
			return c.text("Invalid access token", 401);
		}
		c.set("userId", payload.sub);
	} catch {
		// Force a JWKS refresh next request in case keys rotated.
		jwks = null;
		jwksCreatedAt = 0;
		return c.text("Invalid or expired access token", 401);
	}

	return next();
});

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

// Gate the API, MCP, and agent surfaces with Logto. Registered before the
// route handlers below so it runs first for matching paths.
app.use("/api/v1/*", requireLogto);
app.use("/mcp", requireLogto);
app.use("/mcp/*", requireLogto);
app.use("/agents/*", requireLogto);

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
	let cursor: string | undefined;
	let deleted = 0;
	do {
		const page = await bucket.list({ prefix, cursor, limit: 1000 });
		const keys = page.objects.map((object) => object.key);
		if (keys.length > 0) {
			await bucket.delete(keys);
			deleted += keys.length;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return deleted;
}

app.post("/api/v1/internal/account-purge", async (c) => {
	const presented = c.req.header("x-internal-secret") ?? "";
	if (
		!presented ||
		!c.env.INTERNAL_SECRET ||
		!(await timingSafeEqual(presented, c.env.INTERNAL_SECRET))
	) {
		return c.json({ error: "forbidden" }, 403);
	}

	const userId = c.get("userId");
	if (!userId || userId.length > 255) {
		return c.json({ error: "invalid_user" }, 400);
	}

	const comms = c.env.COMMS.get(c.env.COMMS.idFromName(userId));
	const agent = c.env.EMAIL_AGENT.get(c.env.EMAIL_AGENT.idFromName(userId));
	await Promise.all([comms.purgeAll(), agent.purgeAll()]);

	const deletedObjects =
		(await deleteR2Prefix(c.env.BUCKET, `${userId}/`)) +
		(await deleteR2Prefix(c.env.BUCKET, `mailboxes/${userId}`));

	return c.json({ purged: true, deleted_objects: deletedObjects });
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => {
	if (c.env.MCP_ENABLED !== "1") {
		return c.json({ error: "temporarily_disabled" }, 503);
	}
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	if (c.env.MCP_ENABLED !== "1") {
		return c.json({ error: "temporarily_disabled" }, 503);
	}
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	if (c.env.AGENT_WEBSOCKET_ENABLED !== "1") {
		return c.json({ error: "temporarily_disabled" }, 503);
	}
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw);
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		message: ForwardableEmailMessage,
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(message, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
