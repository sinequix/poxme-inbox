# pox.me Inbox

Open source email for [pox.me](https://pox.me), maintained by [Sinequix](https://sinequix.com).

This repository is the mail core of pox.me. Addresses at `mail.pox.me` are delivered here, stored per user, and mirrored into the pox.me database that the rest of the product reads.

It started from [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) (Apache-2.0). That repository's last commit is from April 2026. Sinequix maintains this tree.

The Worker name is `poxme-inbox`. Cloudflare Email Routing delivers each message once per SMTP recipient. The worker stores that user's mail in a Durable Object, keeps attachments and the raw message in the `poxme-emails` R2 bucket, and writes a copy into `poxme-api-db`. Sign-in is Logto at `https://auth.pox.me`.

## Develop

```bash
npm install
npm run dev
```

Local requests skip Logto. Send the `x-poxme-user-id` header to act as a user.

## Configuration

`wrangler.jsonc` is the pox.me deployment:

- `DOMAINS` is `mail.pox.me`
- `LOGTO_ENDPOINT` is `https://auth.pox.me`
- `API_AUDIENCE` is `https://mail.pox.me`
- `POXME_DB` is the `poxme-api-db` D1 database
- `BUCKET` is the `poxme-emails` R2 bucket

Set the Cloudflare account with `CLOUDFLARE_ACCOUNT_ID`. It is not committed.

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

## Maintainer

[Sinequix](https://sinequix.com). Issues and pull requests are welcome in this repository.

## License

Apache 2.0. See [LICENSE](LICENSE).
