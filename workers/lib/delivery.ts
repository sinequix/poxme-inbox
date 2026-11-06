// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Recipient → poxme user resolution against poxme's D1 (POXME_DB).
 *
 * Mirrors the query in poxme-platform/cloudflare/email-worker/src/index.ts
 * (`resolveDeliveryTarget`): a recipient address maps to a verified, active
 * email credential and, when available, the identity that owns the local part.
 */

const DELIVERY_QUERY = `SELECT c.user_id AS user_id, COALESCE(ch.identity_id, i.id) AS identity_id
FROM credentials c
LEFT JOIN identity_communication_channels ch
  ON ch.credential_id = c.id AND ch.user_id = c.user_id
     AND ch.type = 'email' AND ch.enabled = 1
LEFT JOIN identities i
  ON i.user_id = c.user_id AND i.content = 'core' AND i.active = 1
     AND lower(i.handler_name) = ?1
WHERE c.kind = 'email' AND c.verified = 1 AND c.active = 1
  AND (lower(c.handler) = ?2 OR lower(c.value) = ?2)
ORDER BY CASE WHEN ch.identity_id IS NULL AND i.id IS NULL THEN 1 ELSE 0 END
LIMIT 1`;

export interface DeliveryTarget {
	userId: string;
	identityId: string | null;
}

/**
 * Resolve a full recipient email address to the owning poxme user.
 * Returns null when no matching mailbox exists (or on DB error).
 */
export async function resolveDeliveryTarget(
	db: D1Database,
	recipient: string,
): Promise<DeliveryTarget | null> {
	const recipientLower = recipient.trim().toLowerCase();
	const localPart = recipientLower.split("@")[0] ?? "";

	try {
		const row = await db
			.prepare(DELIVERY_QUERY)
			.bind(localPart, recipientLower)
			.first<{ user_id: string; identity_id: string | null }>();

		if (!row?.user_id) return null;
		return { userId: row.user_id, identityId: row.identity_id ?? null };
	} catch (e) {
		console.error("resolveDeliveryTarget failed:", (e as Error).message);
		return null;
	}
}

export interface InboundD1Row {
	id: string;
	userId: string;
	messageId: string | null;
	threadId: string | null;
	identityId: string | null;
	folder: string;
	subject: string;
	sender: string;
	fromName: string | null;
	recipients: string; // JSON array text
	snippet: string;
	textBody: string | null;
	html: string | null;
	rawS3Key: string;
	hasAttachments: number;
	sizeBytes: number;
	attachmentsMeta: string; // JSON array text
	inReplyTo: string | null;
	referencesHeader: string | null;
}

/**
 * Dual-write an inbound email into poxme's D1 `emails` table so the existing
 * webapp inbox (which reads api.pox.me → D1) keeps working now that poxme-inbox
 * is the Email Routing catch-all. The Durable Object remains the canonical
 * store; this keeps D1 in sync during/after the cutover. Best-effort — a D1
 * failure here must never bounce the message (the DO already has it), so it
 * catches and logs. Uses INSERT OR IGNORE to tolerate the UNIQUE(message_id)
 * constraint on re-delivery.
 */
export async function writeInboundToD1(db: D1Database, row: InboundD1Row): Promise<void> {
	try {
		await db
			.prepare(
				`INSERT OR IGNORE INTO emails
					(id, user_id, message_id, thread_id, folder, identity_id, source, direction,
					 subject, sender, from_name, recipients, snippet, text_body, html, raw_s3_key,
					 is_read, has_attachments, size_bytes, attachments_meta, in_reply_to,
					 references_header, received_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'email', 'inbound',
					 ?, ?, ?, ?, ?, ?, ?, ?,
					 0, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
			)
			.bind(
				row.id,
				row.userId,
				row.messageId,
				row.threadId,
				row.folder,
				row.identityId,
				row.subject,
				row.sender,
				row.fromName,
				row.recipients,
				row.snippet,
				row.textBody,
				row.html,
				row.rawS3Key,
				row.hasAttachments,
				row.sizeBytes,
				row.attachmentsMeta,
				row.inReplyTo,
				row.referencesHeader,
			)
			.run();
	} catch (e) {
		console.error("[d1-mirror] inbound write failed:", (e as Error).message);
	}
}

// ── Email rule engine ────────────────────────────────────────────────
//
// Reproduces the per-address rule engine from the retired poxme-email
// worker (poxme-platform/cloudflare/email-worker/src/index.ts). Rules live
// in poxme's D1 `email_rules` table and are applied to inbound mail in
// priority order before the message is stored.

/**
 * A single row from poxme's `email_rules` table. Mirrors the `EmailRule`
 * interface in email-worker/src/env.ts.
 */
export interface EmailRule {
	id: string;
	user_id: string;
	address: string;
	name: string;
	priority: number;
	active: number;
	condition_from: string | null;
	condition_subject: string | null;
	condition_has_attachment: number | null;
	action: "store" | "forward" | "reject" | "autoreply" | "webhook" | "drop";
	folder: string | null;
	destination: string | null;
	also_store: number;
	reject_reason: string | null;
	reply_subject: string | null;
	reply_body: string | null;
	webhook_url: string | null;
	stop_processing: number;
}

const RULES_QUERY =
	"SELECT * FROM email_rules WHERE user_id = ?1 AND address = ?2 AND active = 1 ORDER BY priority ASC";

/**
 * Load the active rules for a given user + recipient address, in priority
 * order (lowest priority number first). Returns [] on any DB error so a
 * rules-table problem never bounces inbound mail.
 */
export async function loadEmailRules(
	db: D1Database,
	userId: string,
	address: string,
): Promise<EmailRule[]> {
	try {
		const { results } = await db
			.prepare(RULES_QUERY)
			.bind(userId, address)
			.all<EmailRule>();
		return results ?? [];
	} catch (e) {
		console.error("loadEmailRules failed:", (e as Error).message);
		return [];
	}
}

function escapeRegex(s: string): string {
	return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a value against a rule condition pattern. When the pattern contains
 * no `*` this is a case-insensitive substring test; a `*` acts as a wildcard
 * spanning the whole value. Mirrors email-worker's `globMatch`.
 */
function globMatch(value: string, pattern: string): boolean {
	if (!pattern.includes("*")) return value.includes(pattern);
	const escaped = escapeRegex(pattern).replace(/\\\*/g, ".*");
	try {
		return new RegExp("^" + escaped + "$").test(value);
	} catch {
		return value.includes(pattern);
	}
}

/**
 * Whether an inbound message satisfies a rule's conditions. A rule with no
 * conditions always matches. Mirrors email-worker's `matchesConditions`:
 * condition_from / condition_subject are case-insensitive glob/substring
 * tests, and condition_has_attachment (1 = require, 0 = require-absent)
 * gates on attachment presence.
 */
export function matchesConditions(
	rule: EmailRule,
	sender: string,
	subject: string,
	hasAttachments: boolean,
): boolean {
	if (rule.condition_from) {
		if (!globMatch(sender.toLowerCase(), rule.condition_from.toLowerCase()))
			return false;
	}
	if (rule.condition_subject) {
		if (!globMatch(subject.toLowerCase(), rule.condition_subject.toLowerCase()))
			return false;
	}
	if (
		rule.condition_has_attachment !== null &&
		rule.condition_has_attachment !== undefined
	) {
		if (rule.condition_has_attachment === 1 && !hasAttachments) return false;
		if (rule.condition_has_attachment === 0 && hasAttachments) return false;
	}
	return true;
}

/**
 * Whether a sender looks automated (no-reply, bounce, daemon) and so must
 * not receive an auto-reply. Guards against mail loops — an empty sender is
 * treated as automated too.
 */
export function isAutomatedSender(sender: string): boolean {
	if (!sender) return true;
	const local = sender.split("@")[0] ?? "";
	return /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|noreply|mailer-daemon|postmaster|bounce)/i.test(
		local,
	);
}

// ── SSRF-guarded webhook URL validation ──────────────────────────────
//
// Reproduces email-worker's `validateWebhookUrl` and its helpers so a
// user-supplied webhook_url cannot be pointed at internal/private hosts.
// Only https, only the default 443 port, no credentials, and the resolved
// A/AAAA addresses must not fall in a private/reserved range.

const DNS_JSON_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const BLOCKED_WEBHOOK_HOST_SUFFIXES = [
	".localhost",
	".local",
	".internal",
	".home.arpa",
	".workers.dev",
];

function isBlockedWebhookHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	return (
		normalized === "localhost" ||
		BLOCKED_WEBHOOK_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
	);
}

function isIpv4Address(value: string): boolean {
	const parts = value.split(".");
	if (parts.length !== 4) return false;
	return parts.every(
		(part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255,
	);
}

function isPrivateIpv4Address(value: string): boolean {
	if (!isIpv4Address(value)) return false;
	const [a, b] = value.split(".").map(Number);
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	return false;
}

function isPrivateIpv6Address(value: string): boolean {
	const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
	if (!normalized.includes(":")) return false;
	if (normalized === "::" || normalized === "::1") return true;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
	if (
		normalized.startsWith("fe8") ||
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb")
	) {
		return true;
	}
	if (normalized.startsWith("::ffff:")) {
		return isPrivateIpv4Address(normalized.slice("::ffff:".length));
	}
	return false;
}

function isPrivateIpAddress(value: string): boolean {
	return isPrivateIpv4Address(value) || isPrivateIpv6Address(value);
}

async function resolveHostnameAddresses(hostname: string): Promise<string[]> {
	const addresses: string[] = [];

	for (const recordType of ["A", "AAAA"]) {
		const response = await fetch(
			`${DNS_JSON_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${recordType}`,
			{ headers: { accept: "application/dns-json" } },
		);

		if (!response.ok) {
			throw new Error(`DNS lookup failed with status ${response.status}`);
		}

		const payload = (await response.json()) as {
			Answer?: Array<{ data?: string; type?: number }>;
		};

		for (const answer of payload.Answer ?? []) {
			if (typeof answer.data !== "string") continue;
			if (isIpv4Address(answer.data) || answer.data.includes(":")) {
				addresses.push(answer.data);
			}
		}
	}

	return addresses;
}

/**
 * Validate a webhook URL for SSRF safety. Returns a parsed `URL` when safe
 * to POST to, or null when it must be blocked. Mirrors email-worker's
 * `validateWebhookUrl`.
 */
export async function validateWebhookUrl(rawUrl: string): Promise<URL | null> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return null;
	}

	if (url.protocol !== "https:") return null;
	if (url.username || url.password) return null;
	if (url.port && url.port !== "443") return null;

	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (isBlockedWebhookHostname(hostname)) return null;

	if (isIpv4Address(hostname) || hostname.includes(":")) {
		return isPrivateIpAddress(hostname) ? null : url;
	}

	try {
		const resolvedAddresses = await resolveHostnameAddresses(hostname);
		if (resolvedAddresses.length === 0) return null;
		if (resolvedAddresses.some((address) => isPrivateIpAddress(address)))
			return null;
	} catch (e) {
		console.error("Webhook DNS validation failed:", (e as Error).message);
		return null;
	}

	return url;
}
