# Contributing

This is a personal fork of [maxx3250/claude-mail-mcp](https://github.com/maxx3250/claude-mail-mcp), cut down to a read-and-organise IMAP connector for iCloud with read-only calendars. It deliberately has **no sending, no permanent deletion, no calendar writes and no contacts** — changes that add any of these won't be accepted. See [SECURITY.md](SECURITY.md) for the exact rules.

## Before you open a PR

- For non-trivial changes, open an issue first so we can agree on scope.
- New tools should map onto a single IMAP operation. Business logic (categorising, scoring, summarising) belongs on the Claude side.
- Match the existing style (TypeScript strict, ES modules, 2-space indent). Code that handles message content runs on attacker-controlled input: keep regexes linear-time and inputs bounded.

## Local development

```bash
git clone https://github.com/viktorermolov/claude-mail-mcp.git
cd claude-mail-mcp
npm ci --ignore-scripts
npm run build
npm test
```

The tests need no mailbox: write paths are tested at the protocol level against a fake IMAP server (`test/helpers/fake-imap.mjs`), which records every command, so the removal rules (single-UID `UID EXPUNGE` after a confirmed `COPYUID`, nothing removed from Trash, no plain `EXPUNGE`/`CLOSE`) are pinned by assertions on the wire. Add a wire test for every change to a write path.

Don't try write tools against a real mailbox while iterating. If you must check something against iCloud, use read-only tools only.

## Review checklist

- [ ] No new dependencies unless really needed
- [ ] Tool inputs validated with Zod schemas
- [ ] IMAP calls hold a mailbox lock for the whole operation; reads use EXAMINE and BODY.PEEK
- [ ] Writes check that the target exists and verify the result before reporting success
- [ ] Fixtures are synthetic (no real mail, names or addresses)
- [ ] README / CHANGELOG updated if user-visible behaviour changes

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please do **not** open public issues for security problems.
