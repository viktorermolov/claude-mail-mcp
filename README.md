# claude-mail-mcp (safe IMAP fork)

Self-hosted **IMAP connector for Claude**: a Streamable HTTP MCP server that lets [Claude.ai](https://claude.ai) read and organise a mailbox — and nothing more. Fork of [maxx3250/claude-mail-mcp](https://github.com/maxx3250/claude-mail-mcp) cut down for personal use with iCloud Mail.

What this fork deliberately **cannot** do:

- **Send mail.** There is no send tool and no SMTP code or SMTP credentials. Replies are written as drafts; you send them from your own mail client.
- **Permanently delete.** "Delete" moves a message to Trash; nothing can remove a message from Trash, and a plain `EXPUNGE` is never sent. The single removal path is `UID EXPUNGE` of one message, used only (a) after a move's copy has been confirmed by the server (`COPYUID`) — iCloud has no IMAP `MOVE`, so this is the RFC 6851 §3.3 equivalent — and (b) for the superseded version of a draft inside Drafts after the new version's UID is confirmed. Servers without `UIDPLUS` are refused.
- **Touch calendars or contacts.** CalDAV support is removed.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E=20-brightgreen.svg)](https://nodejs.org)

---

## Tools

| Tool | Purpose | Writes? |
|------|---------|---------|
| `list_accounts` | Configured mailboxes — id, label, address. Never credentials. | no |
| `list_folders` | IMAP folders with special-use flags | no |
| `list_messages` | Newest N messages in a folder, with a clean one-line preview | no |
| `search_messages` | Server-side IMAP search (from/to/subject/body/date/flags), same previews | no |
| `get_message` | Headers, attachment metadata and the body as clean, paged plain text | no |
| `create_draft` | Compose locally and APPEND to Drafts | yes |
| `update_draft` | Save a new version of a draft, then remove the old one (Drafts only, `\Draft` only) | yes |
| `mark_read` | Set / clear `\Seen` | yes, reversible |
| `set_flagged` | Set / clear `\Flagged` | yes, reversible |
| `move_message` | Move between folders, including restoring from Trash | yes, reversible |
| `move_to_trash` | Move to Trash (refused for messages already in Trash) | yes, reversible |

Read tools open the folder with `EXAMINE`, so reading never marks mail as read.

### Compact bodies

`get_message` returns readable plain text, not raw MIME: the text/plain part when it is real text, otherwise the HTML part converted with [html-to-text](https://github.com/html-to-text/node-html-to-text) (no images, styles or hidden preheaders; layout tables flattened). Links become numbered references (`Sign up [3]`) and `body.links` maps the numbers on the current page to URLs — tracking URLs can be hundreds of characters and stay intact. Pages are about `max_length` characters (default 15 000) counting text and link URLs; `truncated`, `total_length` and `next_offset` let the client read on with `offset`. Raw HTML only with `include_html: true` (paged with `html_offset`).

Previews in `list_messages` / `search_messages` come from the first few KB of each message's own text part, fetched in batches by MIME part number (`BODY.PEEK`), decoded locally and cleaned the same way. Every tool carries MCP annotations (`readOnlyHint` / `destructiveHint`).

## Authentication

The server runs in a container with no published ports and is reachable only through a **Cloudflare Tunnel** (cloudflared runs as a second container on the same compose network). The tunnel hostname is a self-hosted **Cloudflare Access** application with **Managed OAuth** enabled: Access acts as the OAuth 2.1 authorization server (discovery, dynamic client registration, PKCE) that claude.ai's custom connector expects, and only identities allowed by the Access policy can finish the login.

The server validates every request's `Cf-Access-Jwt-Assertion` header itself — signature against the team's public keys, issuer, application audience, expiry, and an e-mail allow-list. A request without a valid Access JWT gets `401`, even if it reaches the origin some other way. There is no shared static token.

## Configuration

- `.env.example` — service user uid/gid, Access team domain + AUD tag, allowed e-mails.
- `deploy/accounts.example.json` — template for `secrets/accounts.json` (git-ignored, `chmod 600`, owned by the service user).

Deployment with Docker Compose and a locally-managed tunnel: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Development

```bash
npm ci
npm test        # tool list, auth, no-send guarantees, move/trash/draft safety on a fake server
npm run build
```

## iCloud notes

- IMAP: `imap.mail.me.com:993`, TLS. User: your Apple ID e-mail (or the @icloud.com address).
- Password: an app-specific password from <https://account.apple.com> → Sign-In and Security → App-Specific Passwords.
- Drafts is `Drafts`, Trash is `Deleted Messages`. iCloud IMAP advertises `UIDPLUS` but not `MOVE` (or `REPLACE`), so moves and draft updates use the guarded `UID COPY`/`APPEND` + `UID EXPUNGE` path.

## License

MIT — see [LICENSE](LICENSE). Original work by [Markus Stöger](https://markusstoeger.com).

Built on [imapflow](https://imapflow.com/), [mailparser](https://nodemailer.com/extras/mailparser/), nodemailer's MailComposer (compose only, no transport), [jose](https://github.com/panva/jose) and the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
