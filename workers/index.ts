// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import {
	resolveDeliveryTarget,
	writeInboundToD1,
	loadEmailRules,
	matchesConditions,
	isAutomatedSender,
	validateWebhookUrl,
} from "./lib/delivery";
import { publishMessageCreated } from "./lib/realtime";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import type { D1EmailRow } from "./durableObject";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.string(), z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/mailboxes", async (c) =>
	c.json({ error: "legacy_mailbox_api_disabled" }, 410));
app.use("/api/v1/mailboxes/*", async (c) =>
	c.json({ error: "legacy_mailbox_api_disabled" }, 410));
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	return c.json({ domains, emailAddresses });
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists" }, 409);
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	const finalSettings = { ...defaultSettings, ...settings };
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = c.env.COMMS.get(c.env.COMMS.idFromName(email));
	await stub.getFolders();
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.delete(key); // TODO: also delete DO data and R2 attachment blobs
	return c.body(null, 204);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, attachmentData);

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		}).catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
	);
	return c.json({ id: messageId, status: "sent" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	if (draft_id) await stub.deleteEmail(draft_id); // not atomic — create-then-delete would be safer
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, []);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await c.var.mailboxStub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

function normalizeRecipient(value: string | undefined): string {
	if (!value) return "";
	const trimmed = value.trim().toLowerCase();
	const angle = trimmed.match(/<([^>]+)>/);
	return (angle ? angle[1] : trimmed).trim();
}

interface InboundMessage {
	raw: ReadableStream;
	rawSize: number;
	to?: string;
	from?: string;
	setReject?: (reason: string) => void;
	// Cloudflare ForwardableEmailMessage.forward — present at runtime for real
	// Email Routing deliveries, undefined for the DEV /_test/receive path.
	// Return type is widened to unknown so the concrete ForwardableEmailMessage
	// (which resolves to EmailSendResult) is assignable here.
	forward?: (rcpt: string) => Promise<unknown>;
}

async function receiveEmail(
	message: InboundMessage,
	env: Env,
	ctx: ExecutionContext,
	overrideUserId?: string,
) {
	const rawEmail = await streamToArrayBuffer(message.raw, message.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	// Email Routing calls this once per SMTP RCPT TO. That envelope address is
	// the mailbox. The first To: header is not: lists, BCC, and messages whose
	// first To: has no mailbox would otherwise be stored in the wrong place.
	const recipient = normalizeRecipient(message.to) || normalizeRecipient(parsedEmail.to?.[0]?.address);
	if (!recipient) throw new Error("received email with empty recipient");

	// Resolve recipient → poxme user against POXME_DB (or use the override in tests).
	const resolved = overrideUserId
		? { userId: overrideUserId, identityId: null as string | null }
		: await resolveDeliveryTarget(env.POXME_DB, recipient);
	if (!resolved) {
		message.setReject?.("Mailbox not found");
		console.log(`Rejecting email for ${recipient}: mailbox not found`);
		return;
	}

	const userId = resolved.userId;
	const emailId = crypto.randomUUID();

	const sender = (parsedEmail.from?.address || "").toLowerCase();
	const subject = parsedEmail.subject || "";
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const hasAttachments = (parsedEmail.attachments?.length ?? 0) > 0;
	const snippet = (parsedEmail.text || "").replace(/\s+/g, " ").trim().slice(0, 300);

	const rawS3Key = `${userId}/${emailId}.eml`;
	const stub = env.COMMS.get(env.COMMS.idFromName(userId));

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

	// Persist the message into the given folder: raw MIME + attachments to R2,
	// the canonical DO record, poxme's D1 mirror, the auto-draft trigger, and
	// the realtime event. Idempotent via `stored` so store/forward/autoreply
	// rules that each want to store only persist once.
	let stored = false;
	const storeInto = async (folder: string) => {
		if (stored) return;
		stored = true;

		// Store the raw MIME to R2 under the poxme convention → raw_s3_key.
		await env.BUCKET.put(rawS3Key, rawEmail, {
			customMetadata: { userId, from: sender, to: recipient, subject },
		});

		const attachmentData: StoredAttachment[] = [];
		if (parsedEmail.attachments) {
			for (const att of parsedEmail.attachments) {
				const attId = crypto.randomUUID();
				const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
				await env.BUCKET.put(`attachments/${emailId}/${attId}/${filename}`, att.content);
				attachmentData.push({ id: attId, email_id: emailId, filename, mimetype: att.mimeType,
					size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
					content_id: att.contentId || null, disposition: att.disposition || "attachment" });
			}
		}

		let threadId = emailReferences[0] || inReplyTo || emailId;
		if (!inReplyTo && emailReferences.length === 0) {
			const subjectThread = await (stub as any).findThreadBySubject(subject, parsedEmail.from?.address || undefined);
			if (subjectThread) threadId = subjectThread;
		}

		await stub.createEmail(folder, {
			id: emailId, subject,
			sender, recipient,
			cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
			date: new Date().toISOString(), // uses receive time, not the email's Date header
			body: parsedEmail.html || parsedEmail.text || "",
			in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
			thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
			source: "email", direction: "inbound", address: recipient,
			from_name: parsedEmail.from?.name || null,
			text_body: parsedEmail.text || null, html: parsedEmail.html || null,
			snippet: (parsedEmail.text || "").slice(0, 300),
			size_bytes: rawEmail.byteLength, has_attachments: attachmentData.length > 0,
			identity_id: resolved.identityId, raw_s3_key: rawS3Key,
		}, attachmentData);

		// Auto-draft: pass userId as mailboxId so the agent keys its stub/settings by userId.
		const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(userId));
		ctx.waitUntil(agentStub.fetch(new Request("https://agents/onNewEmail", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mailboxId: userId, emailId, sender, subject, threadId }),
		})).catch((e) => console.error("Auto-draft trigger failed:", (e as Error).message)));

		// Dual-write into poxme's D1 `emails` so the existing webapp inbox keeps
		// working now that poxme-inbox is the catch-all (DO stays canonical). Awaited
		// but best-effort inside — never bounces the message.
		await writeInboundToD1(env.POXME_DB, {
			id: emailId,
			userId,
			messageId: originalMessageId || emailId,
			threadId,
			identityId: resolved.identityId,
			folder,
			subject,
			sender,
			fromName: parsedEmail.from?.name || null,
			recipients: JSON.stringify([recipient, ...ccRecipients]),
			snippet: (parsedEmail.text || "").slice(0, 200),
			textBody: parsedEmail.text ? parsedEmail.text.slice(0, 100000) : null,
			html: parsedEmail.html ? parsedEmail.html.slice(0, 500000) : null,
			rawS3Key,
			hasAttachments: attachmentData.length > 0 ? 1 : 0,
			sizeBytes: rawEmail.byteLength,
			attachmentsMeta: JSON.stringify(
				attachmentData.map((a) => ({ filename: a.filename, contentType: a.mimetype, size: a.size })),
			),
			inReplyTo,
			referencesHeader: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		});

		// Best-effort realtime notification (never throws).
		ctx.waitUntil(publishMessageCreated(env.POXME_DB, userId, emailId, {
			folder, subject, sender, source: "email",
		}));
	};

	// Apply the user's email rules (poxme D1 `email_rules`) in priority order,
	// reproducing the retired poxme-email worker's engine. A matching rule can
	// store/forward/reject/auto-reply/webhook/drop; reject and drop stop all
	// processing without storing. Default behaviour (no matching rule, or no
	// rule that suppresses storage) is to store into the inbox.
	const rules = await loadEmailRules(env.POXME_DB, userId, recipient);
	let shouldStore = true;
	let targetFolder = Folders.INBOX as string;

	for (const rule of rules) {
		if (!matchesConditions(rule, sender, subject, hasAttachments)) continue;

		switch (rule.action) {
			case "store":
				targetFolder = rule.folder || Folders.INBOX;
				await storeInto(targetFolder);
				shouldStore = false;
				break;

			case "forward":
				if (rule.destination) {
					try {
						await message.forward?.(rule.destination);
					} catch (e) {
						console.error("Forward failed:", (e as Error).message);
					}
				}
				if (rule.also_store) await storeInto(Folders.INBOX);
				shouldStore = false;
				break;

			case "reject":
				message.setReject?.(rule.reject_reason || "Rejected");
				return;

			case "autoreply":
				targetFolder = rule.folder || targetFolder;
				await storeInto(targetFolder);
				shouldStore = false;
				// Never auto-reply to automated/no-reply senders — avoids mail loops.
				if (!isAutomatedSender(sender)) {
					ctx.waitUntil(sendEmail(env.EMAIL, {
						to: sender,
						from: recipient,
						subject: rule.reply_subject || `Re: ${subject}`,
						text: rule.reply_body || "",
						...(originalMessageId
							? { headers: { "In-Reply-To": `<${originalMessageId}>`, References: `<${originalMessageId}>` } }
							: {}),
					}).catch((e) => console.error("Auto-reply failed:", (e as Error).message)));
				}
				break;

			case "webhook": {
				const url = await validateWebhookUrl(rule.webhook_url || "");
				if (url) {
					// Never forward the raw body — only a small JSON summary.
					ctx.waitUntil(fetch(url.toString(), {
						method: "POST",
						redirect: "error",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ from: sender, to: recipient, subject, snippet }),
					}).catch((e) => console.error("Webhook failed:", (e as Error).message)));
				} else {
					console.error("Blocked unsafe webhook URL:", rule.webhook_url);
				}
				break;
			}

			case "drop":
				return;
		}

		// stop_processing defaults to 1 — halt after the first matching rule
		// fires unless it is explicitly disabled (0).
		if (rule.stop_processing !== 0) break;
	}

	if (shouldStore && !stored) await storeInto(targetFolder);
}

// -- Unified per-user endpoints (poxme) -----------------------------
// These derive the CommsDO from the authenticated userId (set by the
// requireLogto middleware in app.ts) rather than a :mailboxId path
// param. One CommsDO per user, keyed by userId. They live alongside the
// per-mailbox routes above and are NOT gated by requireMailbox.

const BatchBody = z.object({
	ids: z.array(z.string()).min(1),
	action: z.string().min(1),
});

const IngestBody = z.object({
	source: z.string(),
	source_id: z.string().optional(),
	direction: z.string().optional(),
	subject: z.string().optional(),
	sender: z.string().optional(),
	from_name: z.string().optional(),
	recipient: z.string().optional(),
	snippet: z.string().optional(),
	text_body: z.string().optional(),
	html: z.string().optional(),
	body: z.string().optional(),
	tags: z.array(z.string()).optional(),
	identity_id: z.string().optional(),
	source_metadata: z.any().optional(),
	folder: z.string().optional(),
	date: z.string().optional(),
});

app.get("/api/v1/inbox", async (c: AppContext) => {
	const userId = c.get("userId");
	const stub = c.env.COMMS.get(c.env.COMMS.idFromName(userId));
	const source = c.req.query("source");
	const folder = c.req.query("folder");
	const identity_id = c.req.query("identity_id");
	const unread = boolQuery(c, "unread");
	const opts = { source, folder, identity_id, unread, page: intQuery(c, "page"), limit: intQuery(c, "limit") };
	const emails = await (stub as any).listInbox(opts);
	const totalCount = await stub.countInbox({ source, folder, identity_id, unread });
	return c.json({ emails, totalCount });
});

// Single message (userId-keyed). Marks the message read as a side effect,
// mirroring the previous D1 read behaviour. getEmail already returns the row
// plus its attachments.
app.get("/api/v1/messages/:id", async (c: AppContext) => {
	const userId = c.get("userId");
	const stub = c.env.COMMS.get(c.env.COMMS.idFromName(userId));
	const id = c.req.param("id")!;
	const email = await stub.getEmail(id);
	if (!email) return c.json({ error: "Not found" }, 404);
	await stub.updateEmail(id, { read: true });
	return c.json(email);
});

// Full thread (userId-keyed) — all messages with bodies + attachments.
app.get("/api/v1/threads/:threadId", async (c: AppContext) => {
	const userId = c.get("userId");
	const stub = c.env.COMMS.get(c.env.COMMS.idFromName(userId));
	return c.json(await (stub as any).getThreadEmails(c.req.param("threadId")!));
});

// Folder listing (userId-keyed).
app.get("/api/v1/folders/:folder/messages", async (c: AppContext) => {
	const userId = c.get("userId");
	const stub = c.env.COMMS.get(c.env.COMMS.idFromName(userId));
	const folder = c.req.param("folder")!;
	const emails = await (stub as any).listInbox({ folder, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countInbox({ folder });
	return c.json({ emails, totalCount });
});

// Starred listing (userId-keyed, all folders).
app.get("/api/v1/starred", async (c: AppContext) => {
	const userId = c.get("userId");
	const stub = c.env.COMMS.get(c.env.COMMS.idFromName(userId));
	const emails = await (stub as any).listInbox({ starred: true, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countInbox({ starred: true });
	return c.json({ emails, totalCount });
});

app.get("/api/v1/sources", async (c: AppContext) => {
	const userId = c.get("userId");
	const stub = c.env.COMMS.get(c.env.COMMS.idFromName(userId));
	return c.json(await stub.sourceCounts());
});

app.get("/api/v1/counts", async (c: AppContext) => {
	const userId = c.get("userId");
	const stub = c.env.COMMS.get(c.env.COMMS.idFromName(userId));
	return c.json(await stub.folderCounts());
});

app.get("/api/v1/search", async (c: AppContext) => {
	const userId = c.get("userId");
	const stub = c.env.COMMS.get(c.env.COMMS.idFromName(userId));
	const searchOpts = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
		source: c.req.query("source"), tag: c.req.query("tag"), unread: boolQuery(c, "unread"),
	};
	const emails = await (stub as any).searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await (stub as any).countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

app.post("/api/v1/batch", async (c: AppContext) => {
	const parsed = BatchBody.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: "Invalid request body" }, 400);
	const userId = c.get("userId");
	const stub = c.env.COMMS.get(c.env.COMMS.idFromName(userId));
	const result = await stub.batchOp(parsed.data.ids, parsed.data.action);
	const keys = (result as { deletedAttachmentKeys?: string[] }).deletedAttachmentKeys;
	if (keys && keys.length > 0) await c.env.BUCKET.delete(keys);
	return c.json(result);
});

app.post("/api/v1/ingest", async (c: AppContext) => {
	const parsed = IngestBody.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: "Invalid request body" }, 400);
	const userId = c.get("userId");
	const stub = c.env.COMMS.get(c.env.COMMS.idFromName(userId));
	const result = await stub.ingest(parsed.data);
	return c.json(result, 201);
});

// -- DEV-only inbound test route ------------------------------------
// Lets us exercise the inbound path locally without Email Routing or a
// seeded D1 (pass userId to bypass recipient→user resolution). Never
// exposed in production.

const TestReceiveBody = z.object({
	recipient: z.string(),
	rawEmailBase64: z.string(),
	userId: z.string().optional(),
});

app.post("/_test/receive", async (c: AppContext) => {
	if (!import.meta.env.DEV) return c.notFound();
	const parsed = TestReceiveBody.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: "Invalid request body" }, 400);
	const { recipient, rawEmailBase64, userId } = parsed.data;

	const bytes = Uint8Array.from(atob(rawEmailBase64), (ch) => ch.charCodeAt(0));

	let rejected: string | null = null;
	const msg: InboundMessage = {
		raw: new Response(bytes).body as ReadableStream,
		rawSize: bytes.length,
		to: recipient,
		setReject: (reason: string) => { rejected = reason; },
	};

	await receiveEmail(msg, c.env, c.executionCtx as ExecutionContext, userId);
	return c.json({ ok: true, rejected });
});

// -- Phase 6: one-time D1 → Durable Object migration ----------------
// Chunked, idempotent import of poxme's existing D1 `emails` rows into the
// per-user CommsDO instances. Idempotency comes from importEmail's
// INSERT OR IGNORE on the primary key `id`, so re-running is always safe.

app.post("/admin/migrate", async (c: AppContext) => {
	// Auth: allow freely in dev; otherwise require the shared admin secret.
	if (!import.meta.env.DEV) {
		const provided = c.req.header("x-admin-secret");
		if (
			!provided ||
			!c.env.ADMIN_MIGRATE_SECRET ||
			!(await timingSafeSecretEqual(provided, c.env.ADMIN_MIGRATE_SECRET))
		) {
			return c.json({ error: "Forbidden" }, 403);
		}
	}

	const dryRun = boolQuery(c, "dryRun") ?? false;
	const cursor = c.req.query("cursor") ?? "";
	const rawLimit = intQuery(c, "limit") ?? 200;
	const limit = Math.min(Math.max(rawLimit, 1), 1000);

	try {
		// Read a chunk ordered by created_at. NOTE: created_at is not unique,
		// so rows sharing the exact created_at value at a chunk boundary are an
		// accepted known edge — they may be re-scanned in the next chunk. That
		// is harmless because importEmail is idempotent (INSERT OR IGNORE).
		const { results } = await c.env.POXME_DB.prepare(
			`SELECT * FROM emails WHERE created_at > ?1 ORDER BY created_at ASC LIMIT ?2`,
		)
			.bind(cursor || "", limit)
			.all<D1EmailRow & { user_id: string }>();
		const rows = results ?? [];

		const perUser: Record<string, number> = {};
		for (const row of rows) {
			perUser[row.user_id] = (perUser[row.user_id] ?? 0) + 1;
		}

		// nextCursor is the created_at of the last scanned row, or null when we
		// received fewer than `limit` rows (i.e. migration is complete).
		const nextCursor =
			rows.length < limit ? null : (rows[rows.length - 1]?.created_at ?? null);

		if (dryRun) {
			return c.json({ dryRun: true, scanned: rows.length, perUser, nextCursor });
		}

		let migrated = 0;
		let skipped = 0;
		for (const row of rows) {
			const stub = c.env.COMMS.get(c.env.COMMS.idFromName(row.user_id));
			const r = await stub.importEmail(row);
			if (r.imported) migrated++;
			else skipped++;
		}

		return c.json({
			dryRun: false,
			scanned: rows.length,
			migrated,
			skipped,
			perUser,
			nextCursor,
		});
	} catch (e) {
		// A missing/broken POXME_DB `emails` table must surface as clean JSON,
		// not an unhandled crash.
		return c.json(
			{ error: "Migration failed", detail: (e as Error).message },
			500,
		);
	}
});

// -- DEV-only seed for the migration verification -------------------
// Seeds the SAME POXME_DB binding the dev server reads, so /admin/migrate
// exercises real rows without any external persist-path plumbing.

app.post("/_test/seed-poxme-db", async (c: AppContext) => {
	if (!import.meta.env.DEV) return c.notFound();

	await c.env.POXME_DB.prepare(
		`CREATE TABLE IF NOT EXISTS emails (id TEXT PRIMARY KEY, user_id TEXT, message_id TEXT, thread_id TEXT, folder TEXT, subject TEXT, sender TEXT, from_name TEXT, recipients TEXT, snippet TEXT, text_body TEXT, html TEXT, raw_s3_key TEXT, is_read INTEGER, has_attachments INTEGER, size_bytes INTEGER, attachments_meta TEXT, in_reply_to TEXT, references_header TEXT, tags TEXT, starred INTEGER, source TEXT, source_id TEXT, source_metadata TEXT, direction TEXT, identity_id TEXT, form_id TEXT, submission_id TEXT, received_at TEXT, created_at TEXT)`,
	).run();

	const insert = c.env.POXME_DB.prepare(
		`INSERT OR REPLACE INTO emails
			(id, user_id, folder, source, source_id, direction, recipients, subject,
			 text_body, is_read, starred, tags, raw_s3_key, received_at, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
	);

	await c.env.POXME_DB.batch([
		insert.bind(
			"mig-1", "mig-user-1", "inbox", "email", null, "inbound",
			'["me@mail.pox.me"]', "Migrated One", "body one", 0, 0, null,
			"mig-user-1/aaa.eml", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z",
		),
		insert.bind(
			"mig-2", "mig-user-1", "sent", null, null, "outbound",
			null, "Migrated Two", null, null, null, null,
			null, null, "2026-01-02T00:00:00Z",
		),
		insert.bind(
			"mig-3", "mig-user-1", "inbox", "twitter", "tw-9", null,
			null, "Migrated Tweet", null, null, null, '["vip"]',
			null, null, "2026-01-03T00:00:00Z",
		),
	]);

	return c.json({ seeded: 3 });
});

export { app, receiveEmail };

async function timingSafeSecretEqual(left: string, right: string): Promise<boolean> {
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
