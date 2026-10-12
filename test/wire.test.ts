// Protocol-level tests: the real ImapClient drives the real imapflow against
// a fake IMAP server that records every command. These pin the guarantees
// at the wire: the only removal is "UID EXPUNGE <one uid>" after a
// confirmed copy, no plain EXPUNGE or CLOSE is ever sent, reads use only
// EXAMINE + BODY.PEEK, and the connection recovers from failures.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain JS test helper
import { FakeImapServer, rawMsg } from "./helpers/fake-imap.mjs";
import { ImapClient, IMAP_TIMEOUTS, ImapTimeoutError } from "../src/imap-client.js";
import { buildDraftSource } from "../src/draft-composer.js";

type Fake = InstanceType<typeof FakeImapServer>;
type LogEntry = { conn: number; selected: string | null; readOnly: boolean; cmd: string; text: string };

const DEFAULT_TIMEOUTS = { ...IMAP_TIMEOUTS };
let server: Fake;
let imap: ImapClient;

async function start(opts: Record<string, unknown> = {}): Promise<void> {
  server = new FakeImapServer(opts);
  server.addBox("INBOX", "\\Inbox").addBox("Archive", "\\Archive").addBox("Drafts", "\\Drafts").addBox("Deleted Messages", "\\Trash");
  const port = await server.listen();
  imap = new ImapClient({ host: "127.0.0.1", port, user: "u", pass: "p", secure: false });
}

beforeEach(() => Object.assign(IMAP_TIMEOUTS, DEFAULT_TIMEOUTS));
afterEach(async () => {
  await imap?.close().catch(() => {});
  await server?.close().catch(() => {});
});

const log = (): LogEntry[] => server.log as LogEntry[];
const expunges = () => log().filter((e) => /EXPUNGE|^CLOSE$/.test(e.cmd));

function assertNoForbiddenCommands(): void {
  for (const e of log()) {
    assert.notEqual(e.cmd, "EXPUNGE", `plain EXPUNGE sent: ${e.text}`);
    assert.notEqual(e.cmd, "CLOSE", `CLOSE sent: ${e.text}`);
  }
  for (const e of expunges()) {
    assert.match(e.text, /^\S+ UID EXPUNGE \d+$/, `expunge must name exactly one UID: ${e.text}`);
  }
}

test("move without MOVE: UID COPY → COPYUID → \\Deleted + UID EXPUNGE of that one UID", async () => {
  await start();
  const { id } = server.addMessage("INBOX", rawMsg("hello"));
  server.addMessage("INBOX", rawMsg("other"), ["\\Deleted"]); // flagged by another client: must survive
  const r = await imap.moveMessage("INBOX", 1, "Archive");
  assert.equal(r.destination, "Archive");
  assert.deepEqual(server.find(id), [{ box: "Archive", uid: 1, flags: [] }]);
  assert.equal(server.ids("INBOX").length, 1, "the other \\Deleted message must not be expunged");
  const cmds = log().filter((e) => e.selected === "INBOX" && !e.readOnly).map((e) => e.cmd);
  // Our explicit \\Deleted STORE (checked), then imapflow's own STORE inside
  // messageDelete (idempotent), then UID EXPUNGE of the same single UID.
  assert.deepEqual(cmds.filter((c) => /COPY|STORE|EXPUNGE/.test(c)), ["UID COPY", "UID STORE", "UID STORE", "UID EXPUNGE"]);
  for (const e of log().filter((x) => x.cmd === "UID STORE")) assert.match(e.text, /UID STORE 1 \+FLAGS(\.SILENT)? \(\\Deleted\)/);
  assertNoForbiddenCommands();
});

test("trash, restore, and nothing ever removed from Trash", async () => {
  await start();
  const { id } = server.addMessage("INBOX", rawMsg("bye"));
  assert.equal(await imap.moveToTrash("INBOX", 1), "Deleted Messages");
  assert.equal(server.find(id)[0].box, "Deleted Messages");
  const trashUid = server.find(id)[0].uid;
  const before = log().length;
  await assert.rejects(imap.moveToTrash("Deleted Messages", trashUid), /already in Deleted Messages/);
  // Name variants resolve against LIST exactly and are refused before any write.
  await assert.rejects(imap.moveToTrash("deleted messages", trashUid), /does not exist/);
  await assert.rejects(imap.moveMessage("Deleted Messages", trashUid, "DELETED MESSAGES"), /does not exist/);
  assert.ok(!log().slice(before).some((e) => /COPY|STORE|EXPUNGE/.test(e.cmd)), "no write may reach the server");
  await imap.moveMessage("Deleted Messages", trashUid, "INBOX"); // restore is allowed
  assert.equal(server.find(id)[0].box, "INBOX");
  assertNoForbiddenCommands();
});

test("INBOX matches in any case; same folder is refused", async () => {
  await start();
  server.addMessage("INBOX", rawMsg("x"));
  await assert.rejects(imap.moveMessage("inbox", 1, "INBOX"), /same folder/);
  assert.ok(!log().some((e) => /COPY/.test(e.cmd)));
});

test("update_draft: new draft first, old version moved to Trash (never expunged in place)", async () => {
  await start();
  const { id: oldId } = server.addMessage("Drafts", rawMsg("draft v1"), ["\\Draft", "\\Seen"]);
  const raw = await buildDraftSource({ from: "me@example.com" }, { to: "a@example.com", subject: "draft v2", text: "new" });
  const r = await imap.replaceDraft("Drafts", 1, raw);
  assert.equal(r.oldMovedTo, "Deleted Messages");
  assert.equal(server.find(oldId)[0].box, "Deleted Messages", "old version is recoverable from Trash");
  assert.equal(server.ids("Drafts").length, 1);
  const writes = log().filter((e) => /APPEND|COPY|STORE|EXPUNGE/.test(e.cmd)).map((e) => e.cmd);
  assert.deepEqual(writes, ["APPEND", "UID COPY", "UID STORE", "UID STORE", "UID EXPUNGE"]);
  assertNoForbiddenCommands();
});

test("update_draft refuses non-drafts and changes nothing", async () => {
  await start();
  server.addMessage("Drafts", rawMsg("not a draft"), ["\\Seen"]);
  const raw = await buildDraftSource({ from: "me@example.com" }, { to: "a@example.com", subject: "s", text: "t" });
  await assert.rejects(imap.replaceDraft("Drafts", 1, raw), /not marked/);
  assert.ok(!log().some((e) => /APPEND|COPY|STORE|EXPUNGE/.test(e.cmd)));
});

test("no COPYUID → original untouched, error says a copy may exist", async () => {
  await start({ copyUidOff: true });
  const { id } = server.addMessage("INBOX", rawMsg("keep"));
  await assert.rejects(imap.moveMessage("INBOX", 1, "Archive"), /not confirmed.*may nevertheless exist/s);
  assert.ok(server.find(id).some((f: { box: string }) => f.box === "INBOX"));
  assert.ok(!log().some((e) => /STORE|EXPUNGE/.test(e.cmd)));
});

test("neither MOVE nor UIDPLUS → refused before any write", async () => {
  await start({ caps: ["IMAP4rev1", "IDLE"] });
  server.addMessage("INBOX", rawMsg("keep"));
  await assert.rejects(imap.moveMessage("INBOX", 1, "Archive"), /neither MOVE nor UIDPLUS/);
  assert.ok(!log().some((e) => /COPY|STORE|EXPUNGE/.test(e.cmd)));
});

test("a failed \\Deleted STORE is reported, not claimed as success", async () => {
  await start({
    hooks: {
      onCommand: (conn: { w: (s: string) => void }, tag: string, cmd: string) => {
        if (cmd === "UID STORE") { conn.w(`${tag} NO try again`); return "handled"; }
      },
    },
  });
  const { id } = server.addMessage("INBOX", rawMsg("x"));
  await assert.rejects(imap.moveToTrash("INBOX", 1), /could not be removed .* both folders/);
  assert.deepEqual(server.find(id).map((f: { box: string }) => f.box).sort(), ["Deleted Messages", "INBOX"]);
  assert.ok(!log().some((e) => /EXPUNGE/.test(e.cmd)), "no expunge after a failed STORE");
});

test("reads use only EXAMINE and BODY.PEEK, never mark anything read", async () => {
  await start();
  server.addMessage("INBOX", rawMsg("one", { body: "first message text" }));
  server.addMessage("INBOX", rawMsg("two", { date: "Mon, 12 Oct 2026 10:00:00 MSK" })); // unparseable zone
  const list = await imap.listMessages("INBOX", { limit: 10 });
  assert.equal(list.length, 2);
  assert.equal(list.find((m) => m.subject === "two")?.date, null, "bad Date header → null, not a crash");
  assert.equal(list.find((m) => m.subject === "one")?.preview, "first message text");
  await imap.searchMessages("INBOX", { subject: "one" }, 5);
  const msg = await imap.getMessage("INBOX", 1);
  assert.equal(msg.text, "first message text");
  for (const e of log()) {
    assert.notEqual(e.cmd, "SELECT", "reads must not SELECT read-write");
    assert.ok(!/STORE|COPY|APPEND|EXPUNGE/.test(e.cmd), `unexpected write ${e.text}`);
    if (/FETCH/.test(e.cmd)) assert.doesNotMatch(e.text, /BODY\[/i, `non-PEEK fetch: ${e.text}`);
  }
  for (const box of ["INBOX"]) for (const m of server.boxes.get(box).messages) assert.ok(!m.flags.has("\\Seen"));
});

test("a failed SEARCH is an error, not an empty result", async () => {
  await start({
    hooks: {
      onCommand: (conn: { w: (s: string) => void }, tag: string, cmd: string) => {
        if (/SEARCH/.test(cmd)) { conn.w(`${tag} NO server busy`); return "handled"; }
      },
    },
  });
  server.addMessage("INBOX", rawMsg("x"));
  await assert.rejects(imap.searchMessages("INBOX", { subject: "x" }, 5), /SEARCH failed/);
  await assert.rejects(imap.listMessages("INBOX", { unreadOnly: true }), /SEARCH failed/);
});

test("a failed connect is not cached: the next call after back-off reconnects", async () => {
  Object.assign(IMAP_TIMEOUTS, { backoffBaseMs: 50, backoffMaxMs: 50 });
  await start({ hooks: { loginFail: (n: number) => n === 1 } });
  server.addMessage("INBOX", rawMsg("x"));
  await assert.rejects(imap.listMailboxes(), /./);
  await assert.rejects(imap.listMailboxes(), /next attempt in/); // inside back-off: no hammering
  await new Promise((r) => setTimeout(r, 80));
  const folders = await imap.listMailboxes();
  assert.ok(folders.some((f) => f.path === "INBOX"));
  assert.equal(server.logins, 2);
});

test("a stalled server fails the call within the deadline and the next call reconnects", async () => {
  Object.assign(IMAP_TIMEOUTS, { operationMs: 400 });
  let stall = true;
  await start({
    hooks: {
      onCommand: (_c: unknown, _t: string, cmd: string) => {
        if (stall && /FETCH/.test(cmd)) return "handled"; // never answer
      },
    },
  });
  server.addMessage("INBOX", rawMsg("x"));
  const t0 = Date.now();
  await assert.rejects(imap.getMessage("INBOX", 1), (e: Error) => e instanceof ImapTimeoutError);
  assert.ok(Date.now() - t0 < 2000);
  stall = false;
  const msg = await imap.getMessage("INBOX", 1);
  assert.equal(msg.subject, "x");
  assert.ok(server.connSeq >= 2, "a new connection was opened");
});

test("an aborted request changes nothing", async () => {
  await start();
  server.addMessage("INBOX", rawMsg("x"));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(imap.moveToTrash("INBOX", 1, undefined, ac.signal), /cancelled before any change/);
  assert.ok(!log().some((e) => /COPY|STORE|EXPUNGE/.test(e.cmd)));
});

test("close() during use leaves no live connection behind", async () => {
  await start();
  server.addMessage("INBOX", rawMsg("x"));
  await imap.listMailboxes();
  await imap.close();
  await assert.rejects(imap.listMailboxes(), /closed/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(server.sockets.size, 0);
});
