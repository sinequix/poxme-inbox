// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Best-effort realtime notification for poxme.
 *
 * poxme's realtime transport is a plain INSERT into the `realtime_events`
 * table in poxme-api-db (POXME_DB). Mirrors `publishRealtimeEvent` in
 * poxme-platform/cloudflare/api-worker/src/lib/realtime.ts. Never throws —
 * realtime delivery is non-critical and must not break the store path.
 */

const INSERT_EVENT = `INSERT INTO realtime_events (id, user_id, type, entity_type, entity_id, payload, created_at)
VALUES (?, ?, 'message.created', 'message', ?, ?, datetime('now'))`;

export async function publishMessageCreated(
	db: D1Database,
	userId: string,
	messageId: string,
	payload: Record<string, unknown>,
): Promise<void> {
	try {
		await db
			.prepare(INSERT_EVENT)
			.bind(crypto.randomUUID(), userId, messageId, JSON.stringify(payload))
			.run();
	} catch (e) {
		console.error("publishMessageCreated failed:", (e as Error).message);
	}
}
