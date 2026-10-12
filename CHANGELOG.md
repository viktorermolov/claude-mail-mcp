# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.6.0] — reliability and security audit fixes

### Reliability
- A failed IMAP connect is no longer cached forever: the next call reconnects after a short back-off (2 s doubling to 60 s), and failures are logged with an error code.
- Every IMAP operation has a 60 s deadline (socket timeout 60 s, lock wait 30 s); on expiry the connection is dropped so queued calls fail fast instead of hanging for minutes.
- A failed IMAP SEARCH is an error, never an empty result; a message with an unparseable Date header no longer breaks list/search.
- Text processing is linear-time on hostile input (spaces, NBSP, `![`, U+2028 runs); inputs are capped and HTML depth is limited, so a crafted mail can't freeze the server or blank other previews.
- Messages over 8 MB are read part by part (text parts capped at 2 MB) instead of loading the whole source.
- Graceful shutdown: new requests get 503, in-flight ones get up to 15 s to finish (compose `stop_grace_period: 20s`); a listen failure exits non-zero with a logged error code.
- An invalid `accounts.json` at startup no longer crash-loops the container: the server starts, logs the reason and reports it from the tools until the file is fixed.
- Pool resets during in-flight calls no longer leave orphaned IMAP sessions.
- The \Deleted STORE result is checked and the original's removal verified, so a move is never reported as done when it wasn't.

### Safety
- `update_draft` moves the previous version to Trash (COPY + COPYUID + UID EXPUNGE) instead of expunging it in place: every edit is recoverable, attachments of the old version included.
- Folder names are resolved against the server's LIST exactly (INBOX in any case); case/variant names can no longer slip past the "nothing leaves Trash" and same-folder guards.
- Writes check the request's abort signal before the first mutating command; each write logs one structured line (tool, folder, UID, outcome).

### Security
- Access JWT: `exp` is now required; the team's keys are cached 12 h and the last good set is used for up to 24 h if refetching fails; a key outage answers 503 instead of 401. Rejections log the compose-network peer.
- The request body is parsed only after the JWT check (1 MB, no gzip); errors are JSON-RPC shaped without stack traces.
- Drafts are plain text only (HTML drafts could make a client fetch attacker URLs); recipients must be bare addresses and header fields can't contain line breaks; display names in tool output are RFC 5322-quoted.
- Server instructions and read-tool descriptions mark message content as untrusted; `update_draft` and `move_message` are annotated destructive.
- Search dates must be real calendar dates.

### Links (get_message)
- `body.links` is returned only with `include_links: true`; references `[n]` stay in the text.
- Bare URLs of 100+ characters (tracking and image links) become references too; numbering follows reading order; a mail's own "[1]" is shown as "(1)".
- Unicode layout spaces and blank letters collapse like spaces; paging never splits an emoji or a reference.

### Repository and CI
- New SECURITY.md for this fork (private vulnerability reporting); package metadata points at the fork.
- CI on Node 24, weekly schedule, actions pinned by SHA; the Docker job starts the built image and checks `/health` and an unauthenticated `/mcp`.
- Dependabot for npm, Docker, compose and Actions with a 7-day cooldown; base images and cloudflared pinned by digest.
- DEPLOYMENT.md: working step order, reviewed-commit updates with a rollback image, host trust note.
- Protocol-level tests against a fake IMAP server pin the removal rules, read-only reads and connection recovery; test fixtures use synthetic data.

## [0.5.0]

### Changed
- `get_message` returns clean plain text by default instead of `bodyText` + full `bodyHtml`. text/plain is used when it is real text; otherwise (missing, or MSO/table leftovers) the HTML part is converted with html-to-text. Images, styles and hidden preheaders are dropped.
- Links are numbered references in the text with URLs in `body.links` (only those on the current page, deduplicated); `include_links: false` omits them.
- Bodies are paged: `offset`, `max_length` (default 15 000, counting text and link URLs), `truncated`, `total_length`, `next_offset`. Raw HTML only with `include_html: true`, paged by `html_offset`.
- `list_messages` / `search_messages` previews are built from each message's decoded text part, fetched in batches per MIME part number (a few FETCH round trips per listing instead of one per message), and cleaned the same way.
- Tool output is compact JSON.

On a large real-world HTML newsletter: ~137 000 characters before, two pages of ~10 500 and ~15 400 characters now (whole text 10 900 characters + 28 links). `list_messages(25)` on iCloud: ~3 s.

## [0.4.0]

### Added
- `move_message` (including restoring from Trash), `move_to_trash` and `update_draft`.
- Without IMAP `MOVE` (iCloud) a move is `UID COPY` → confirmed `COPYUID` → `\Deleted` + `UID EXPUNGE` of that single UID (RFC 6851 §3.3). `update_draft` is `APPEND` → confirmed `APPENDUID` → `UID EXPUNGE` of the old draft, only inside Drafts and only for `\Draft` messages.
- All removal goes through one guarded function; servers without `UIDPLUS` are refused, plain `EXPUNGE` is never sent, and messages already in Trash cannot be removed.
- `create_draft` now returns the new draft's UID.
- Tests for every write path against a fake IMAP server.

## [0.3.1]

### Removed
- `move_message` and `move_to_trash`: iCloud IMAP has no `MOVE`, and the connector must not EXPUNGE, so both tools could never succeed there. `mail.trashFolder` is no longer read.

## [0.3.0] — fork: safe IMAP-only connector

### Removed
- `send_message`, the SMTP client and SMTP credentials. Drafts are composed locally with nodemailer's MailComposer (no transport) and APPENDed to Drafts.
- Calendar tools and CalDAV support (`tsdav`, `ical.js`).
- `delete_message`, which set `\Deleted` + EXPUNGE (permanent on iCloud).
- Static Bearer `AUTH_TOKEN` auth and the pm2 ecosystem file.

### Added
- `move_to_trash` (moves to the `\Trash` special-use folder or `mail.trashFolder`) and `set_flagged`.
- Cloudflare Access JWT validation (`Cf-Access-Jwt-Assertion`: signature, issuer, audience, expiry, e-mail allow-list). OAuth 2.1 is provided by Access Managed OAuth.
- MCP tool annotations; tests for the tool set, auth and the no-send / no-expunge guarantees.
- `Dockerfile` (distroless, non-root) and `compose.yaml` with a cloudflared sidecar; no published ports, read-only root FS, all capabilities dropped.

### Changed
- `move_message` refuses servers without IMAP `MOVE` instead of falling back to COPY + EXPUNGE.
- Read tools open folders with EXAMINE, so reading never changes flags.
- A fresh MCP server per request (stateless mode) — concurrent requests no longer share one transport.
- `/health` returns only `{"status":"ok"}`; logs carry no addresses or error text from mail servers.
- `accounts.json` parse errors no longer echo file contents.
- Dependencies updated (`@modelcontextprotocol/sdk`, `nodemailer`, `imapflow`, `mailparser`); `npm audit` clean.

## [0.2.1] — 2026-05-21

Security hardening pass. No new features; no breaking API changes.

### Security

- **Upgraded `nodemailer` to 8.0.7** — fixes 4 high-severity CVEs (GHSA-mm7p-fcc7-pg87 wrong-domain, GHSA-rcmh-qjqh-p98v DoS via addressparser, GHSA-c7w3-x93f-qmm8 SMTP injection via envelope.size, GHSA-vvjj-xcjg-gr5g SMTP injection via transport name).
- **Backend now binds to `127.0.0.1` by default** (`HOST` env var, default `127.0.0.1`). Defense-in-depth on top of UFW.
- **CSRF guard on `/settings/save`, `/settings/delete`, `/settings/set-default`** — Origin/Referer header must match the configured issuer. Rejects state-changing cross-origin POSTs.
- **nginx security headers added**: `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow, noarchive`.
- **nginx rate-limit on auth endpoints**: 10 req/min per IP with burst of 5 on `/authorize` and `/settings`. Brute-force htpasswd attempts return 429.
- **Backend and OAuth shim now run as a dedicated non-root `mailmcp` system user** (no shell, no home directory). Both services have full systemd hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=true`, `ProtectKernel*`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`, `RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality`, `SystemCallFilter=@system-service ~@privileged @resources`.
- **Backend migrated from pm2 to a hardened systemd unit** (`claude-mail-mcp.service`). pm2 still works for local dev; production uses systemd.
- **State directory moved to `/var/lib/mail-mcp/`** (owned by `mailmcp`, chmod 700) from `/root/.config/mail-mcp/`. The htpasswd file is now `chmod 640 root:mailmcp` (was `644`).
- **New [SECURITY.md](SECURITY.md) and [docs/HARDENING.md](docs/HARDENING.md)** — full threat model, defaults explained, operator hardening checklist, walked-through scenarios.

### Added

- `HOST` env var for the listen interface (default `127.0.0.1`).

### Changed

- The DEPLOYMENT.md recipe now uses systemd for the backend (not pm2), runs as `mailmcp`, and stores state under `/var/lib/mail-mcp/`. The pm2 example is kept for local dev.

## [0.2.0] — 2026-05-21

Multi-account per deployment. Browser-based setup flow.

### Added

- **`list_accounts` tool** — returns all configured accounts (id, label, default flag, From-address, CalDAV-enabled flag), never credentials
- **Optional `account` parameter on every tool** — selects which mailbox to act on; omit for the default account
- **`accounts.json` credential store** — JSON file replaces v0.1's IMAP/SMTP env vars; chmod 600, hot-reloaded via `fs.watch`
- **Browser-based setup UI** in the bundled OAuth shim — add / edit / delete accounts through a form, no SSH required
- Friendly error when no accounts are configured: `list_accounts` returns an explanatory note; other tools surface a clear "open /settings" message

### Changed

- **BREAKING:** `.env` no longer contains IMAP_, SMTP_, CALDAV_, DEFAULT_FROM_, DRAFTS_FOLDER, SENT_FOLDER. Those move to `accounts.json`. Only PORT, PUBLIC_URL, LOG_LEVEL, AUTH_TOKEN, ACCOUNTS_FILE remain.
- Calendar tools (`list_calendars`, `list_events`, `create_event`, `find_free_slot`) are now always registered; they error with a clear message if the resolved account has no CalDAV configured.
- IMAP/SMTP/CalDAV clients are instantiated per account via a lazy `ClientPool`. Reset on every `accounts.json` change.

### Migration from v0.1

Before:
```env
IMAP_HOST=imap.mailbox.org
IMAP_USER=hi@example.com
IMAP_PASS=secret
... etc
```

After (`accounts.json`, chmod 600):
```json
{
  "version": 1,
  "accounts": [
    {
      "id": "main",
      "label": "Main mailbox",
      "default": true,
      "imap": { "host": "imap.mailbox.org", "port": 993, "user": "hi@example.com", "pass": "secret", "tls": true },
      "smtp": { "host": "smtp.mailbox.org", "port": 465, "user": "hi@example.com", "pass": "secret", "tls": true },
      "mail": { "defaultFrom": "hi@example.com", "draftsFolder": "Drafts", "sentFolder": "Sent" }
    }
  ]
}
```

Or visit `/settings` on the deployed connector and fill in the form.

## [0.1.0] — 2026-05-21

Initial release. Single-tenant alpha.

### Added

- **Mail tools (9):** `list_folders`, `list_messages`, `search_messages`, `get_message`, `send_message`, `create_draft`, `mark_read`, `move_message`, `delete_message`
- **Calendar tools (4):** `list_calendars`, `list_events`, `create_event`, `find_free_slot` — only registered if `CALDAV_URL` is set
- IMAP via `imapflow` (single long-lived connection + per-mailbox locks)
- SMTP via `nodemailer` (optional best-effort copy to Sent folder)
- CalDAV via `tsdav` + iCalendar parsing via `ical.js`
- Bearer-token auth on `/mcp`, public `/health` endpoint
- Streamable HTTP MCP transport (compatible with Claude.ai web)
- pm2 ecosystem config for production deployment

### Known limitations

- Single-tenant: one IMAP/SMTP/CalDAV credential set per deployment
- `find_free_slot` working-hours window is interpreted in UTC — pass ISO with offset for local-time anchoring
- CalDAV does not send iMIP invitations automatically (attendees on `create_event` are stored but not notified)
- No threading view (`list_threads` planned for v0.3)
