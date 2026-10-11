# claude-mail-mcp (safe IMAP fork)

Self-hosted **IMAP connector for Claude**: a Streamable HTTP MCP server that lets [Claude.ai](https://claude.ai) read and organise a mailbox — and nothing more. Fork of [maxx3250/claude-mail-mcp](https://github.com/maxx3250/claude-mail-mcp) cut down for personal use with iCloud Mail.

What this fork deliberately **cannot** do:

- **Send mail.** There is no send tool and no SMTP code or SMTP credentials. Replies are written as drafts; you send them from your own mail client.
- **Permanently delete.** Nothing sets `\Deleted` or issues `EXPUNGE`. "Delete" moves a message to Trash, and moves refuse to run on servers without IMAP `MOVE` (instead of silently falling back to COPY + EXPUNGE).
- **Touch calendars or contacts.** CalDAV support is removed.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E=20-brightgreen.svg)](https://nodejs.org)

---

## Tools

| Tool | Purpose | Writes? |
|------|---------|---------|
| `list_accounts` | Configured mailboxes — id, label, address. Never credentials. | no |
| `list_folders` | IMAP folders with special-use flags | no |
| `list_messages` | Newest N messages in a folder | no |
| `search_messages` | Server-side IMAP search (from/to/subject/body/date/flags) | no |
| `get_message` | Full body + headers + attachment metadata | no |
| `create_draft` | Compose locally and APPEND to Drafts | yes |
| `mark_read` | Set / clear `\Seen` | yes, reversible |
| `set_flagged` | Set / clear `\Flagged` | yes, reversible |
| `move_message` | Move between folders (IMAP `MOVE` only) | yes, reversible |
| `move_to_trash` | Move to Trash | yes, reversible |

Read tools open the folder with `EXAMINE`, so reading never marks mail as read. Every tool carries MCP annotations (`readOnlyHint` / `destructiveHint`).

## Authentication

The server listens on `127.0.0.1` only and is published through a **Cloudflare Tunnel**. The tunnel hostname is a self-hosted **Cloudflare Access** application with **Managed OAuth** enabled: Access acts as the OAuth 2.1 authorization server (discovery, dynamic client registration, PKCE) that claude.ai's custom connector expects, and only identities allowed by the Access policy can finish the login.

The server validates every request's `Cf-Access-Jwt-Assertion` header itself — signature against the team's public keys, issuer, application audience, expiry, and an e-mail allow-list. A request without a valid Access JWT gets `401`, even if it reaches the origin some other way. There is no shared static token.

## Configuration

- `.env.example` — bind address, Access team domain + AUD tag, allowed e-mails.
- `deploy/accounts.example.json` — mailbox credentials (keep the real file `chmod 600`, owned by the service user, outside the repo).

Deployment on a Raspberry Pi with systemd and a locally-managed tunnel: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Development

```bash
npm ci
npm test        # tool list, auth, no-send / no-expunge guarantees
npm run build
```

## iCloud notes

- IMAP: `imap.mail.me.com:993`, TLS. User: your Apple ID e-mail (or the @icloud.com address).
- Password: an app-specific password from <https://account.apple.com> → Sign-In and Security → App-Specific Passwords.
- Trash is called `Deleted Messages`; Drafts is `Drafts`.

## License

MIT — see [LICENSE](LICENSE). Original work by [Markus Stöger](https://markusstoeger.com).

Built on [imapflow](https://imapflow.com/), [mailparser](https://nodemailer.com/extras/mailparser/), nodemailer's MailComposer (compose only, no transport), [jose](https://github.com/panva/jose) and the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
