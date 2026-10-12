# Security policy

This is a personal fork of [maxx3250/claude-mail-mcp](https://github.com/maxx3250/claude-mail-mcp), cut down to a read-and-organise IMAP connector. It is not the upstream project — please report issues **here**, not upstream.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on [viktorermolov/claude-mail-mcp](https://github.com/viktorermolov/claude-mail-mcp/security/advisories/new). Please do not open a public issue for security problems.

## Supported versions

Only the latest release on `main` (currently 0.6.x) is supported.

## What the connector can and cannot do

- **No sending.** There is no send tool, no SMTP code and no SMTP credentials. Drafts are composed locally (plain text only) and APPENDed to Drafts; the user sends them from their own mail client.
- **No permanent deletion.** Nothing sends a plain `EXPUNGE` or `CLOSE`. Without IMAP `MOVE` (iCloud) the only removal is `UID EXPUNGE` of exactly one message, and only after the server confirmed its copy in another folder (`COPYUID`); with `MOVE` the server's atomic command is used. Every write first checks that the message exists. "Delete" moves to Trash; nothing can be removed from Trash; moving out of Trash (restore) is allowed. `update_draft` moves the previous version to Trash. Servers without `UIDPLUS` are refused. This is pinned by protocol-level tests against a fake IMAP server.
- **Reading never marks mail as read** (EXAMINE + BODY.PEEK only).
- **Calendars read-only, no contacts.** The CalDAV client can only send `PROPFIND` and `REPORT` (pinned by a source test); calendar credentials go only to the configured origin or https hosts under its parent domain (iCloud's per-user hosts), checked on every redirect. Responses are size-capped, XML with a DOCTYPE is refused, recurrence expansion is bounded, and a calendar object's own time zone definitions never affect other objects.

## Threat model and controls

| Adversary | Controls |
|---|---|
| Internet | Reachable only through a Cloudflare Tunnel; no published ports. The hostname is a Cloudflare Access application with Managed OAuth (DCR + PKCE) and an allow-list policy. |
| Requests that bypass Access (another tunnel route, a process on the host) | The origin validates every `Cf-Access-Jwt-Assertion`: RS256 signature against the team's keys, issuer, audience (AUD tag), required and unexpired `exp`, e-mail allow-list. The request body is parsed only after that check, limited to 1 MB, no compression. |
| Anyone who can send mail to the account | All parsing is bounded: linear-time text processing, input size caps, HTML with more than 30 000 tags stripped linearly instead of parsed (the parser is quadratic in nesting and builds a full DOM), per-operation IMAP deadlines that also cancel the operation. Mail content is declared untrusted to the model (server instructions + read-tool descriptions); destructive tools carry `destructiveHint`. Drafts are text-only, so injected HTML can't make a client fetch remote URLs. |
| Supply chain | Lockfile + `npm ci --ignore-scripts`; base images pinned by digest; GitHub Actions pinned by SHA; Dependabot with a 7-day cooldown; weekly scheduled CI with `npm audit`. |
| Local host | The container runs as a dedicated unprivileged user with a read-only root filesystem, no capabilities and `no-new-privileges`; the credentials file is `600` for that user only. **Membership in the host's `docker` group is equivalent to root and therefore to reading the mail credentials** — keep that group to people and services you trust with the mailbox. |

## Handling of secrets and data

- The IMAP app-specific password lives only in `secrets/accounts.json` on the host (git-ignored). Parse errors name fields, never values.
- Logs contain no credentials, addresses, subjects or message content: auth rejections log a reason and the compose-network peer; write tools log tool, folder, UID and outcome.
