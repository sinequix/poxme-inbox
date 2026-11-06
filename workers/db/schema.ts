// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const folders = sqliteTable("folders", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	is_deletable: integer("is_deletable").notNull().default(1),
});

export const emails = sqliteTable("emails", {
	id: text("id").primaryKey(),
	folder_id: text("folder_id")
		.notNull()
		.references(() => folders.id, { onDelete: "cascade" }),
	subject: text("subject"),
	sender: text("sender"),
	recipient: text("recipient"),
	cc: text("cc"),
	bcc: text("bcc"),
	date: text("date"),
	read: integer("read").default(0),
	starred: integer("starred").default(0),
	body: text("body"),
	in_reply_to: text("in_reply_to"),
	email_references: text("email_references"),
	thread_id: text("thread_id"),
	message_id: text("message_id"),
	raw_headers: text("raw_headers"),
	source: text("source").notNull().default("email"),
	direction: text("direction").notNull().default("inbound"),
	source_id: text("source_id"),
	source_metadata: text("source_metadata"),
	tags: text("tags").notNull().default("[]"),
	from_name: text("from_name"),
	address: text("address"),
	identity_id: text("identity_id"),
	form_id: text("form_id"),
	submission_id: text("submission_id"),
	text_body: text("text_body"),
	html: text("html"),
	snippet: text("snippet"),
	size_bytes: integer("size_bytes"),
	has_attachments: integer("has_attachments").notNull().default(0),
	raw_s3_key: text("raw_s3_key"),
	received_at: text("received_at"),
	created_at: text("created_at"),
});

export const attachments = sqliteTable("attachments", {
	id: text("id").primaryKey(),
	email_id: text("email_id")
		.notNull()
		.references(() => emails.id, { onDelete: "cascade" }),
	filename: text("filename").notNull(),
	mimetype: text("mimetype").notNull(),
	size: integer("size").notNull(),
	content_id: text("content_id"),
	disposition: text("disposition"),
});

export const emailRules = sqliteTable("email_rules", {
	id: text("id").primaryKey(),
	address: text("address").notNull(),
	name: text("name").notNull(),
	priority: integer("priority").notNull().default(100),
	active: integer("active").notNull().default(1),
	condition_from: text("condition_from"),
	condition_subject: text("condition_subject"),
	condition_has_attachment: integer("condition_has_attachment"),
	action: text("action").notNull().default("store"),
	folder: text("folder").default("inbox"),
	destination: text("destination"),
	also_store: integer("also_store").default(0),
	reject_reason: text("reject_reason"),
	reply_subject: text("reply_subject"),
	reply_body: text("reply_body"),
	webhook_url: text("webhook_url"),
	stop_processing: integer("stop_processing").default(1),
	created_at: text("created_at"),
	updated_at: text("updated_at"),
});

export const tagCategories = sqliteTable("tag_categories", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	color: text("color").default("#6B7280"),
	icon: text("icon"),
	sort_order: integer("sort_order").default(0),
	created_at: text("created_at"),
});
