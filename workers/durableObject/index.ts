// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, typeof schema.emails[keyof typeof schema.emails]>;

interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
	source?: string;
	tag?: string;
	unread?: boolean;
}

interface GetEmailsOptions {
	folder?: string;
	thread_id?: string;
	page?: number;
	limit?: number;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	// poxme unified columns (optional; nullable/defaulted so existing callers keep working)
	source?: string;
	direction?: string;
	source_id?: string | null;
	source_metadata?: string | null;
	address?: string | null;
	from_name?: string | null;
	text_body?: string | null;
	html?: string | null;
	snippet?: string | null;
	size_bytes?: number | null;
	has_attachments?: boolean;
	identity_id?: string | null;
	raw_s3_key?: string | null;
	tags?: string[];
	received_at?: string;
	created_at?: string;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

/**
 * A row read verbatim from poxme's D1 `emails` table (poxme-api-db) during
 * the one-time Phase 6 migration. Column names are D1 snake_case; several
 * differ from the DO schema (e.g. `recipients` JSON array, `references_header`,
 * `is_read`). Fields are loosely typed because they come straight off a
 * `SELECT *` and may be null.
 */
export interface D1EmailRow {
	id: string;
	user_id?: string;
	message_id?: string | null;
	thread_id?: string | null;
	folder?: string | null;
	subject?: string | null;
	sender?: string | null;
	from_name?: string | null;
	recipients?: string | null;
	snippet?: string | null;
	text_body?: string | null;
	html?: string | null;
	raw_s3_key?: string | null;
	is_read?: number | null;
	has_attachments?: number | null;
	size_bytes?: number | null;
	attachments_meta?: string | null;
	in_reply_to?: string | null;
	references_header?: string | null;
	tags?: string | null;
	starred?: number | null;
	source?: string | null;
	source_id?: string | null;
	source_metadata?: string | null;
	direction?: string | null;
	identity_id?: string | null;
	form_id?: string | null;
	submission_id?: string | null;
	received_at?: string | null;
	created_at?: string | null;
}

/**
 * Map a poxme D1 folder NAME to a DO folder id. Tolerates the legacy
 * singular `draft`/`archive` names by folding them onto the current
 * `drafts`/`archived` ids. Values already equal to a DO folder id pass
 * through unchanged.
 */
const D1_FOLDER_TO_DO_FOLDER: Record<string, string> = {
	inbox: "inbox",
	sent: "sent",
	drafts: "drafts",
	archived: "archived",
	trash: "trash",
	spam: "spam",
	draft: "drafts",
	archive: "archived",
};

export class CommsDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
	}

	async purgeAll(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	async getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				sender: schema.emails.sender,
				recipient: schema.emails.recipient,
				cc: schema.emails.cc,
				bcc: schema.emails.bcc,
				date: schema.emails.date,
				read: schema.emails.read,
				starred: schema.emails.starred,
				in_reply_to: schema.emails.in_reply_to,
				email_references: schema.emails.email_references,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
				snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(options: { folder?: string; thread_id?: string } = {}) {
		const { folder, thread_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			page = 1,
			limit: rawLimit = 25,
		} = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}

		const offset = (page - 1) * limit;

		// Thread grouping strategy:
		// For DRAFT folder: group by in_reply_to (the email being replied to).
		//   This ensures reply-drafts to different emails stay separate, even if
		//   they share a thread_id or subject. New drafts (no in_reply_to) each
		//   get their own group via their unique id.
		// For other folders:
		//   1. Primary: group by thread_id (from email threading headers)
		//   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
		//      for legacy emails that lack threading headers (thread_id IS NULL).
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				folder, limit, offset
			);

			const rows = [...result];
			return rows.map((row: any) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
			}));
		}

		// Non-draft folders: full threading logic
		const result = this.ctx.storage.sql.exec(
			`WITH
			folder_emails AS (
				SELECT *,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
			),
			thread_to_conversation AS (
				SELECT
					raw_thread_id,
					normalized_subject,
					CASE
						WHEN thread_id IS NOT NULL THEN raw_thread_id
						ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			all_emails_with_conversation AS (
				SELECT
					e.*,
					COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc
					ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE name = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conversation
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE name = 'sent' LIMIT 1)
					AND lmc.folder_id != (SELECT id FROM folders WHERE name = 'draft' LIMIT 1)
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1
			ORDER BY lif.date DESC
			LIMIT ?2 OFFSET ?3`,
			folder, limit, offset
		);

		const rows = [...result];
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
		}));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails.
	 */
	async countThreadedEmails(folder: string) {
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)`,
					folder,
				),
			][0] as { total: number } | undefined;
			return row?.total ?? 0;
		}

		const row = [
			...this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT
						COALESCE(thread_id, id) as raw_thread_id,
						thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						CASE
							WHEN thread_id IS NOT NULL THEN raw_thread_id
							WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
							ELSE raw_thread_id
						END as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT conversation_id) as total
				FROM thread_to_conversation`,
				folder,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		const email = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: emailAttachments,
		};
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	async getThreadEmails(threadId: string) {
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails WHERE thread_id = ?1 ORDER BY date ASC`,
				threadId,
			),
		] as any[];

		if (emailRows.length === 0) return [];

		const emailIds = emailRows.map((e) => e.id as string);

		// Batch-fetch all attachments for the thread in a single query
		const placeholders = emailIds.map((_, i) => `?${i + 1}`).join(",");
		const attachmentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
				...emailIds,
			),
		] as any[];

		// Group attachments by email_id
		const attachmentsByEmail = new Map<string, any[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		return emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.db
			.update(schema.emails)
			.set(data)
			.where(eq(schema.emails.id, id))
			.run();

		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
			threadId,
		);
		return { threadId, markedRead: true };
	}

	async deleteEmail(id: string) {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		this.db
			.delete(schema.emails)
			.where(eq(schema.emails.id, id))
			.run();

		return emailAttachments;
	}

	async getAttachment(id: string) {
		return (
			this.db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.id, id))
				.get() ?? null
		);
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				unreadCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(Number),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	async createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({ id, name, is_deletable })
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		const result = this.db
			.update(schema.folders)
			.set({ name })
			.where(eq(schema.folders.id, id))
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return result;
	}

	async deleteFolder(id: string) {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder || folder.is_deletable === 0) {
			return false;
		}

		this.db
			.delete(schema.folders)
			.where(eq(schema.folders.id, id))
			.run();

		return true;
	}

	async moveEmail(id: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;

		this.db
			.update(schema.emails)
			.set({ folder_id: folderId })
			.where(eq(schema.emails.id, id))
			.run();

		return true;
	}

	// ── Search (raw SQL — dynamic condition builder) ───────────────

	/**
	 * Build WHERE conditions and params for search queries.
	 * Shared between searchEmails and countSearchResults.
	 */
	#buildSearchConditions(
		options: SearchFilterOptions,
		tableAlias = "",
	): { conditions: string[]; params: (string | number)[] } {
		const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment, source, tag, unread } = options;
		const prefix = tableAlias ? `${tableAlias}.` : "";
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		let paramIdx = 0;

		const addParam = (value: string | number) => {
			paramIdx++;
			params.push(value);
			return `?${paramIdx}`;
		};

		// Guard against pathological LIKE inputs (upstream #36/#40): SQLite's
		// LIKE degrades badly on very long patterns, so cap the term length.
		const clampTerm = (value: string) => (value.length > 512 ? value.slice(0, 512) : value);

		if (query) {
			const term = clampTerm(query);
			const p1 = addParam(`%${term}%`);
			const p2 = addParam(`%${term}%`);
			const p3 = addParam(`%${term}%`);
			const p4 = addParam(`%${term}%`);
			conditions.push(`(${prefix}subject LIKE ${p1} OR ${prefix}body LIKE ${p2} OR ${prefix}sender LIKE ${p3} OR ${prefix}recipient LIKE ${p4} OR ${prefix}cc LIKE ${p4} OR ${prefix}bcc LIKE ${p4})`);
		}
		if (folder) {
			const p = addParam(folder);
			conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
		}
		if (from) { const p = addParam(`%${clampTerm(from)}%`); conditions.push(`${prefix}sender LIKE ${p}`); }
		if (to) { const p = addParam(`%${clampTerm(to)}%`); conditions.push(`(${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p} OR ${prefix}bcc LIKE ${p})`); }
		if (subject) { const p = addParam(`%${clampTerm(subject)}%`); conditions.push(`${prefix}subject LIKE ${p}`); }
		if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
		if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
		if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
		if (unread) { conditions.push(`${prefix}read = 0`); }
		if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
		if (has_attachment) { conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`); }
		if (source) { const p = addParam(source); conditions.push(`${prefix}source = ${p}`); }
		if (tag) { const p = addParam(tag); conditions.push(`EXISTS (SELECT 1 FROM json_each(${prefix}tags) WHERE json_each.value = ${p})`); }

		return { conditions, params };
	}

	async searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = this.#buildSearchConditions(options, "e");

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = (page - 1) * limit;

		const query = `
			SELECT e.id, e.subject, e.sender, e.from_name, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id, e.source, e.direction, e.source_id, e.source_metadata,
				e.identity_id, e.form_id, e.submission_id, e.message_id, e.size_bytes,
				e.has_attachments, e.tags,
				SUBSTR(COALESCE(e.snippet, e.body), 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
		params.push(limit, offset);

		const result = this.ctx.storage.sql.exec(query, ...params);
		return [...result].map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
		}));
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	async countSearchResults(options: SearchFilterOptions) {
		const { conditions, params } = this.#buildSearchConditions(options);

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT COUNT(*) as total FROM emails ${where}`;

		const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		const result = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
		);

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of result) {
			const rowSubject = String((row as any).subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = String((row as any).senders || "");
				const threadRecipients = String((row as any).recipients || "");
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			return String((row as any).thread_id);
		}
		return null;
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 * Limits: 20 emails per hour, 100 per day per mailbox.
	 * Returns null if under limit, or an error message string if exceeded.
	 */
	async checkSendRateLimit(): Promise<string | null> {
		const hourRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 hour')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 day')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((dayRow?.cnt ?? 0) >= 100) {
			return "Rate limit exceeded: max 100 emails per day per mailbox";
		}

		return null;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	async createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	) {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;
		const isSent = folderId === Folders.SENT;

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		this.db
			.insert(schema.emails)
			.values({
				id: email.id,
				folder_id: folderId,
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
				date: email.date,
				read: isSent ? 1 : (email.read ? 1 : 0),
				starred: email.starred ? 1 : 0,
				body: email.body,
				in_reply_to: email.in_reply_to ?? null,
				email_references: email.email_references ?? null,
				thread_id: email.thread_id ?? null,
				message_id: email.message_id ?? null,
				raw_headers: email.raw_headers ?? null,
				source: email.source ?? "email",
				direction: email.direction ?? "inbound",
				source_id: email.source_id ?? null,
				source_metadata: email.source_metadata ?? null,
				address: email.address ?? null,
				from_name: email.from_name ?? null,
				text_body: email.text_body ?? null,
				html: email.html ?? null,
				snippet: email.snippet ?? null,
				size_bytes: email.size_bytes ?? null,
				has_attachments: email.has_attachments ? 1 : 0,
				identity_id: email.identity_id ?? null,
				raw_s3_key: email.raw_s3_key ?? null,
				tags: JSON.stringify(email.tags ?? []),
				received_at: email.received_at ?? email.date,
				created_at: email.created_at ?? email.date,
			})
			.run();

		if (attachments.length > 0) {
			this.db.insert(schema.attachments).values(attachments).run();
		}
	}

	// ── Unified per-user views (raw SQL) ───────────────────────────

	/** Parse a stored tags JSON column, tolerating null/malformed values. */
	#parseTags(raw: unknown): string[] {
		if (typeof raw !== "string") return [];
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	/**
	 * Build the WHERE clause + params for the unified inbox listing.
	 * Shared between listInbox and countInbox.
	 */
	#buildInboxConditions(
		options: { source?: string; folder?: string; identity_id?: string; starred?: boolean; unread?: boolean },
	): { where: string; params: (string | number)[] } {
		const { source, folder, identity_id, starred, unread } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (source) {
			params.push(source);
			conditions.push(`source = ?${params.length}`);
		}
		if (folder) {
			params.push(folder);
			const p = `?${params.length}`;
			conditions.push(`folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
		}
		if (identity_id) {
			params.push(identity_id);
			conditions.push(`identity_id = ?${params.length}`);
		}
		if (starred !== undefined) {
			conditions.push(`starred = ${starred ? 1 : 0}`);
		}
		if (unread) {
			conditions.push(`read = 0`);
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		return { where, params };
	}

	async listInbox(options: { source?: string; folder?: string; identity_id?: string; starred?: boolean; unread?: boolean; page?: number; limit?: number } = {}) {
		const { source, folder, identity_id, starred, unread, page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const offset = (page - 1) * limit;

		const { where, params } = this.#buildInboxConditions({ source, folder, identity_id, starred, unread });

		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT id, subject, sender, from_name, recipient, cc, bcc, date, read, starred,
					thread_id, folder_id, source, direction, source_id, source_metadata,
					identity_id, form_id, submission_id, message_id, size_bytes,
					in_reply_to, email_references, has_attachments, tags,
					SUBSTR(COALESCE(snippet, body), 1, 300) as snippet
				 FROM emails ${where}
				 ORDER BY COALESCE(created_at, date) DESC
				 LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
				...params, limit, offset,
			),
		] as any[];

		return rows.map((row) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			has_attachments: !!row.has_attachments,
			tags: this.#parseTags(row.tags),
		}));
	}

	async countInbox(options: { source?: string; folder?: string; identity_id?: string; starred?: boolean; unread?: boolean } = {}) {
		const { where, params } = this.#buildInboxConditions(options);
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	async sourceCounts() {
		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT source, COUNT(*) as count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as unread
				 FROM emails
				 GROUP BY source`,
			),
		] as any[];
		return rows.map((row) => ({
			source: row.source as string,
			count: Number(row.count),
			unread: Number(row.unread),
		}));
	}

	async folderCounts() {
		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT f.id, f.name,
					COUNT(e.id) as total,
					COALESCE(SUM(CASE WHEN e.read = 0 THEN 1 ELSE 0 END), 0) as unread
				 FROM folders f
				 LEFT JOIN emails e ON e.folder_id = f.id
				 GROUP BY f.id, f.name`,
			),
		] as any[];

		const starredRow = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as starred FROM emails WHERE starred = 1`,
			),
		][0] as { starred: number } | undefined;

		return {
			folders: rows.map((row) => ({
				id: row.id as string,
				name: row.name as string,
				total: Number(row.total),
				unread: Number(row.unread),
			})),
			starred: starredRow?.starred ?? 0,
		};
	}

	async ingest(row: {
		id?: string;
		source: string;
		source_id?: string;
		direction?: string;
		subject?: string;
		sender?: string;
		from_name?: string;
		recipient?: string;
		snippet?: string;
		text_body?: string;
		html?: string;
		body?: string;
		tags?: string[];
		identity_id?: string;
		source_metadata?: unknown;
		folder?: string;
		date?: string;
	}) {
		const folderName = row.folder ?? Folders.INBOX;
		const folderRow = [
			...this.ctx.storage.sql.exec(
				`SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1`,
				folderName,
			),
		][0] as { id: string } | undefined;
		if (!folderRow) {
			throw new Error(
				`ingest: folder "${folderName}" not found. ` +
					"Ensure the folder exists before ingesting a message.",
			);
		}

		const id = row.id ?? crypto.randomUUID();
		const date = row.date ?? new Date().toISOString();
		const body = row.body ?? row.html ?? row.text_body ?? "";
		const tags = JSON.stringify(row.tags ?? []);
		const sourceMetadata =
			row.source_metadata === undefined || row.source_metadata === null
				? null
				: typeof row.source_metadata === "string"
					? row.source_metadata
					: JSON.stringify(row.source_metadata);

		// OR IGNORE relies on the unique (source, source_id) partial index for dedup.
		const cursor = this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO emails
				(id, folder_id, source, direction, source_id, source_metadata,
				 subject, sender, from_name, recipient, body, text_body, html,
				 snippet, tags, identity_id, date, created_at, read, starred, has_attachments)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 0, 0, 0)`,
			id,
			folderRow.id,
			row.source,
			row.direction ?? "inbound",
			row.source_id ?? null,
			sourceMetadata,
			row.subject ?? null,
			row.sender ?? null,
			row.from_name ?? null,
			row.recipient ?? null,
			body,
			row.text_body ?? null,
			row.html ?? null,
			row.snippet ?? null,
			tags,
			row.identity_id ?? null,
			date,
			date,
		);

		return { id, inserted: cursor.rowsWritten > 0 };
	}

	/**
	 * Import a single row from poxme's D1 `emails` table into this user's DO.
	 * One-time, idempotent (Phase 6). Dedup is keyed on the primary key `id`
	 * via INSERT OR IGNORE, so re-running the migration never duplicates.
	 *
	 * Attachments are METADATA-ONLY here: we preserve `has_attachments` and
	 * `raw_s3_key` so the raw .eml can be lazily re-parsed later, but we do
	 * NOT create attachment rows.
	 */
	async importEmail(row: D1EmailRow): Promise<{ imported: boolean }> {
		// Resolve target folder id: apply the D1→DO name mapping, then verify
		// the result against this DO's folders table. Default to 'inbox' when
		// the folder is unknown/missing.
		const rawFolder = row.folder ?? "inbox";
		const mappedFolder = D1_FOLDER_TO_DO_FOLDER[rawFolder] ?? rawFolder;
		const folderRow = [
			...this.ctx.storage.sql.exec(
				`SELECT id FROM folders WHERE id = ?1 OR name = ?1 LIMIT 1`,
				mappedFolder,
			),
		][0] as { id: string } | undefined;
		const folderId = folderRow?.id ?? "inbox";

		// Recipients arrive as a JSON array text column. Parse to a display
		// string ("a, b") and take the first entry as the primary address.
		let recipient: string | null = null;
		let address: string | null = null;
		if (typeof row.recipients === "string") {
			try {
				const parsed = JSON.parse(row.recipients);
				if (Array.isArray(parsed)) {
					recipient = parsed.join(", ");
					address = parsed[0] ?? null;
				} else {
					recipient = row.recipients;
				}
			} catch {
				recipient = row.recipients;
			}
		} else {
			recipient = row.recipients ?? null;
		}

		const date = row.received_at ?? row.created_at ?? new Date().toISOString();
		const body = row.html ?? row.text_body ?? "";

		const cursor = this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO emails
				(id, folder_id, subject, sender, from_name, recipient, cc, bcc, date,
				 read, starred, body, in_reply_to, email_references, thread_id, message_id,
				 raw_headers, source, direction, source_id, source_metadata, address,
				 text_body, html, snippet, size_bytes, has_attachments, identity_id,
				 form_id, submission_id, raw_s3_key, tags, received_at, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
				 ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29,
				 ?30, ?31, ?32, ?33, ?34)`,
			row.id,
			folderId,
			row.subject ?? null,
			row.sender ?? null,
			row.from_name ?? null,
			recipient,
			null, // cc — D1 doesn't separate these here
			null, // bcc
			date,
			row.is_read ? 1 : 0,
			row.starred ? 1 : 0,
			body,
			row.in_reply_to ?? null,
			row.references_header ?? null,
			row.thread_id ?? null,
			row.message_id ?? null,
			null, // raw_headers
			row.source ?? "email",
			row.direction ?? "inbound",
			row.source_id ?? null,
			row.source_metadata ?? null,
			address,
			row.text_body ?? null,
			row.html ?? null,
			row.snippet ?? null,
			row.size_bytes ?? null,
			row.has_attachments ? 1 : 0,
			row.identity_id ?? null,
			row.form_id ?? null,
			row.submission_id ?? null,
			row.raw_s3_key ?? null,
			row.tags ?? "[]",
			row.received_at ?? null,
			row.created_at ?? date,
		);

		return { imported: cursor.rowsWritten > 0 };
	}

	async batchOp(ids: string[], action: string) {
		if (ids.length === 0) return { action, count: 0 };

		const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
		const idIn = `id IN (${placeholders})`;

		// Resolve a target folder (by name or id) and move the selected emails.
		const moveTo = (folder: string) => {
			const p = `?${ids.length + 1}`;
			this.ctx.storage.sql.exec(
				`UPDATE emails SET folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)
				 WHERE ${idIn}`,
				...ids,
				folder,
			);
		};

		if (action === "mark_read") {
			this.ctx.storage.sql.exec(`UPDATE emails SET read = 1 WHERE ${idIn}`, ...ids);
		} else if (action === "mark_unread") {
			this.ctx.storage.sql.exec(`UPDATE emails SET read = 0 WHERE ${idIn}`, ...ids);
		} else if (action === "star") {
			this.ctx.storage.sql.exec(`UPDATE emails SET starred = 1 WHERE ${idIn}`, ...ids);
		} else if (action === "unstar") {
			this.ctx.storage.sql.exec(`UPDATE emails SET starred = 0 WHERE ${idIn}`, ...ids);
		} else if (action === "archive") {
			moveTo("archived");
		} else if (action === "trash") {
			moveTo(Folders.TRASH);
		} else if (action === "spam") {
			moveTo(Folders.SPAM);
		} else if (action.startsWith("move:")) {
			moveTo(action.slice("move:".length));
		} else if (action === "delete") {
			// Gather attachment R2 keys first so the caller can clean the bucket.
			const attachmentRows = [
				...this.ctx.storage.sql.exec(
					`SELECT email_id, id, filename FROM attachments WHERE email_id IN (${placeholders})`,
					...ids,
				),
			] as any[];
			const deletedAttachmentKeys = attachmentRows.map(
				(a) => `attachments/${a.email_id}/${a.id}/${a.filename}`,
			);
			this.ctx.storage.sql.exec(`DELETE FROM emails WHERE ${idIn}`, ...ids);
			return { action, affected: ids, deletedAttachmentKeys };
		} else if (action.startsWith("tag:") || action.startsWith("untag:")) {
			const isTag = action.startsWith("tag:");
			const tagValue = action.slice(isTag ? "tag:".length : "untag:".length);
			for (const id of ids) {
				const existing = [
					...this.ctx.storage.sql.exec(
						`SELECT tags FROM emails WHERE id = ?1`,
						id,
					),
				][0] as { tags: string } | undefined;
				if (!existing) continue;
				const current = this.#parseTags(existing.tags);
				const next = isTag
					? current.includes(tagValue) ? current : [...current, tagValue]
					: current.filter((t) => t !== tagValue);
				this.ctx.storage.sql.exec(
					`UPDATE emails SET tags = ?1 WHERE id = ?2`,
					JSON.stringify(next),
					id,
				);
			}
		} else {
			throw new Error(`batchOp: unsupported action "${action}"`);
		}

		return { action, count: ids.length };
	}
}
