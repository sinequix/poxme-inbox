# sinequix.com Inbox

Mail for [sinequix.com](https://sinequix.com), hosted at `inbox.sinequix.com`. This tree started from [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) (Apache-2.0). That repository's last commit is from April 2026.

The Worker name is `poxme-inbox`. Cloudflare Email Routing on `inbox.sinequix.com` delivers each message once per SMTP recipient. The worker stores that user's mail in a Durable Object, keeps attachments and the raw message in the `poxme-emails` R2 bucket, and writes a copy into `poxme-api-db`. Sign-in stays on Logto at `https://auth.pox.me`.

`sinequix.com` company mail stays on Google Workspace. This inbox does not take the apex MX. `n8n@inbox.sinequix.com` already routes to the `n8n-email-bridge` worker and is left as it is.

## Develop

```bash
npm install
npm run dev
```

Local requests skip Logto. Send the `x-poxme-user-id` header to act as a user.

## Configuration

`wrangler.jsonc` targets the pox.me Cloudflare account:

- `DOMAINS` is `inbox.sinequix.com`
- `LOGTO_ENDPOINT` is `https://auth.pox.me`
- `API_AUDIENCE` is `https://inbox.sinequix.com`
- `POXME_DB` is the `poxme-api-db` D1 database
- `BUCKET` is the `poxme-emails` R2 bucket

Set these with `wrangler secret put`. They are not committed:

- `INTERNAL_SECRET`, for calls from the api worker
- `ADMIN_MIGRATE_SECRET`, for the one-time import

Inbound delivery uses the envelope recipient (`message.to`). The worker looks that address up as a verified email credential. A message whose first `To:` header belongs to someone else still lands in the envelope recipient's mailbox. If the envelope address is not a mailbox, the delivery is rejected.

The custom domain in `wrangler.jsonc` attaches on the next deploy. Mail for the worker still needs an Email Routing rule for `*@inbox.sinequix.com` that does not outrank `n8n@inbox.sinequix.com`. That rule is not enabled yet.

`MCP_ENABLED` and `AGENT_WEBSOCKET_ENABLED` stay unset until mailbox tools are checked against the signed-in user.

## What changed from upstream

- Logto replaces Cloudflare Access.
- Mailboxes are per pox.me user (`CommsDO`), not one Durable Object per header address.
- Delivery is mirrored into the pox.me D1 `emails` table.
- The agent and MCP endpoints stay disabled until they enforce the signed-in user.

Copyright headers and the Apache-2.0 license from the original project stay in place.

## License

Apache 2.0. See [LICENSE](LICENSE).
