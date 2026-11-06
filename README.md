# pox.me Inbox

Mail for [pox.me](https://pox.me). This tree is the maintained inbox. It started from [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) (Apache-2.0). That repository's last commit is from April 2026, so pox.me development continues here.

The Worker name is `poxme-inbox`. Cloudflare Email Routing delivers each message to the worker once per SMTP recipient. The worker stores that user's mail in a Durable Object, keeps attachments and the raw message in the `poxme-emails` R2 bucket, and writes a copy into `poxme-api-db` so the pox.me webapp can read it. Sign-in is Logto at `https://auth.pox.me`.

`workers_dev` is off, and `mail.pox.me` is not routed yet. Until that cutover the worker is reached through a service binding.

## Develop

```bash
npm install
npm run dev
```

Local requests skip Logto. Send the `x-poxme-user-id` header to act as a user.

## Configuration

`wrangler.jsonc` targets the pox.me Cloudflare account:

- `DOMAINS` is `mail.pox.me`
- `LOGTO_ENDPOINT` is `https://auth.pox.me`
- `API_AUDIENCE` is `https://mail.pox.me`
- `POXME_DB` is the `poxme-api-db` D1 database
- `BUCKET` is the `poxme-emails` R2 bucket

Set these with `wrangler secret put`. They are not committed:

- `INTERNAL_SECRET`, for calls from the api worker
- `ADMIN_MIGRATE_SECRET`, for the one-time import

Inbound delivery uses the envelope recipient (`message.to`). The worker looks that address up as a verified email credential. A message whose first `To:` header belongs to someone else still lands in the envelope recipient's mailbox. If the envelope address is not a pox.me mailbox, the delivery is rejected.

`MCP_ENABLED` and `AGENT_WEBSOCKET_ENABLED` stay unset until mailbox tools are checked against the signed-in user.

## What changed from upstream

- Logto replaces Cloudflare Access.
- Mailboxes are per pox.me user (`CommsDO`), not one Durable Object per header address.
- Delivery is mirrored into the pox.me D1 `emails` table.
- The agent and MCP endpoints stay disabled until they enforce the signed-in user.

Copyright headers and the Apache-2.0 license from the original project stay in place.

## License

Apache 2.0. See [LICENSE](LICENSE).
