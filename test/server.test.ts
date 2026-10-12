import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { AccountsStore, parseAccountsFile } from "../src/accounts.js";
import { ClientPool } from "../src/client-pool.js";
import { accessAuth } from "../src/access-auth.js";
import { buildMcpServer, createApp } from "../src/app.js";
import { buildDraftSource } from "../src/draft-composer.js";
import { ImapClient } from "../src/imap-client.js";

const TEAM = "example.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const AUD = "test-aud-tag";
const OWNER = "owner@example.com";

const EXPECTED_TOOLS = [
  "create_draft",
  "get_message",
  "list_accounts",
  "list_folders",
  "list_messages",
  "mark_read",
  "move_message",
  "move_to_trash",
  "search_messages",
  "set_flagged",
  "update_draft",
];

let dir: string;
let store: AccountsStore;
let pool: ClientPool;
let server: Server;
let baseUrl: string;
let privateKey: CryptoKey;
let otherKey: CryptoKey;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mail-mcp-test-"));
  const file = path.join(dir, "accounts.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "icloud",
          label: "iCloud",
          default: true,
          imap: { host: "imap.invalid", port: 993, user: "u", pass: "SECRET-PASS", tls: true },
          smtp: { host: "smtp.invalid", port: 587, user: "u", pass: "SECRET-PASS" },
          mail: { defaultFrom: OWNER, draftsFolder: "Drafts" },
        },
      ],
    })
  );
  store = new AccountsStore(file);
  await store.start();
  pool = new ClientPool(store);

  const kp = await generateKeyPair("RS256", { extractable: true });
  privateKey = kp.privateKey as CryptoKey;
  otherKey = (await generateKeyPair("RS256")).privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" };
  const auth = accessAuth({
    teamDomain: TEAM,
    audience: AUD,
    allowedEmails: [OWNER],
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
  const app = createApp({ pool, store, auth, log: () => {} });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  store.stop();
  server.close();
  await rm(dir, { recursive: true, force: true });
});

function token(
  opts: { email?: string; aud?: string; iss?: string; exp?: string | number; key?: CryptoKey } = {}
): Promise<string> {
  const jwt = new SignJWT(opts.email === undefined ? { email: OWNER } : opts.email ? { email: opts.email } : {})
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m");
  return jwt.sign(opts.key ?? privateKey);
}

async function callMcp(headers: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

test("registered tools are exactly the allowed set — no send, no permanent delete", async () => {
  const mcp = buildMcpServer(pool, store);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, EXPECTED_TOOLS);
  for (const n of names) assert.doesNotMatch(n, /send|expunge|delete|purge|empty|calendar|event/);
  const reads = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(reads, ["get_message", "list_accounts", "list_folders", "list_messages", "search_messages"]);
  await client.close();
});

test("source has no SMTP/send code and exactly one guarded expunge site", async () => {
  const srcDir = path.join(import.meta.dirname, "..", "src");
  let deleteSites = 0;
  for (const f of await readdir(srcDir)) {
    const code = await readFile(path.join(srcDir, f), "utf8");
    for (const banned of [/createTransport/, /sendMail/, /\.expunge\(/i, /exec\(\s*["'`](UID )?EXPUNGE/i, /smtp-transport/, /tsdav/, /mailboxDelete/]) {
      assert.doesNotMatch(code, banned, `${f} matches ${banned}`);
    }
    const sites = code.match(/messageDelete\(/g)?.length ?? 0;
    if (sites) assert.equal(f, "imap-client.ts", `messageDelete used in ${f}`);
    deleteSites += sites;
  }
  assert.equal(deleteSites, 1, "messageDelete must appear exactly once (expungeOne)");
});

test("list_accounts never returns credentials", async () => {
  const s = JSON.stringify(store.publicSummaries());
  assert.doesNotMatch(s, /SECRET-PASS|imap\.invalid/);
});

test("health endpoint exposes nothing", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("no token → 401", async () => {
  const res = await callMcp({});
  assert.equal(res.status, 401);
});

test("legacy Bearer header alone is not accepted", async () => {
  const res = await callMcp({ authorization: `Bearer ${await token()}` });
  assert.equal(res.status, 401);
});

for (const [name, opts] of [
  ["wrong audience", { aud: "other-app" }],
  ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
  ["expired", { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ["signed by unknown key", { key: undefined as unknown as CryptoKey, foreign: true }],
  ["email not allowed", { email: "someone@else.com" }],
  ["service token without email", { email: "" }],
] as const) {
  test(`${name} → 401`, async () => {
    const o = { ...opts } as Record<string, unknown>;
    if (o.foreign) o.key = otherKey;
    const res = await callMcp({ "cf-access-jwt-assertion": await token(o as never) });
    assert.equal(res.status, 401);
  });
}

test("unsigned (alg=none) token → 401", async () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const forged = `${b64({ alg: "none" })}.${b64({ iss: ISS, aud: AUD, email: OWNER, exp: 9e9 })}.`;
  const res = await callMcp({ "cf-access-jwt-assertion": forged });
  assert.equal(res.status, 401);
});

test("valid Access JWT → tools/list works", async () => {
  const res = await callMcp({ "cf-access-jwt-assertion": await token({ email: OWNER.toUpperCase() }) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { tools: { name: string }[] } };
  assert.deepEqual(body.result.tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
});

test("calling a removed tool fails", async () => {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "cf-access-jwt-assertion": await token(),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "send_message", arguments: { to: "x@example.com", subject: "s", text: "t" } },
    }),
  });
  const body = JSON.stringify(await res.json());
  assert.match(body, /not found|Unknown tool|error/i);
  assert.doesNotMatch(body, /"success":\s*true/);
});

test("drafts are composed locally with Bcc kept", async () => {
  const raw = (await buildDraftSource(
    { from: OWNER },
    { to: "a@example.com", bcc: "b@example.com", subject: "Hi", text: "body" }
  )).toString();
  assert.match(raw, /^From: owner@example\.com/m);
  assert.match(raw, /^Bcc: b@example\.com/m);
  assert.match(raw, /^Subject: Hi/m);
});

test("parse errors never echo the file contents", () => {
  assert.throws(
    () => parseAccountsFile('{"version":1,"accounts":[{"imap":{"pass":"SECRET-PASS"'),
    (e: Error) => !e.message.includes("SECRET")
  );
});

// ---- IMAP write paths against a fake server -------------------------------

type Call = [string, ...unknown[]];

function fakeImap(opts: {
  caps: string[];
  copyUidMap?: Map<number, number> | null;
  deleteOk?: boolean;
  draftFlags?: string[] | null;
  appendUid?: number | null;
  trashPath?: string;
}) {
  const calls: Call[] = [];
  const client = {
    usable: true,
    capabilities: new Map(opts.caps.map((c) => [c, true])),
    getMailboxLock: async (box: string) => {
      calls.push(["lock", box]);
      return { release() {} };
    },
    messageMove: async (range: string, dest: string) => {
      calls.push(["move", range, dest]);
      return { uidMap: new Map([[Number(range), 900]]) };
    },
    messageCopy: async (range: string, dest: string) => {
      calls.push(["copy", range, dest]);
      return opts.copyUidMap === null ? { path: "x", destination: dest } : { path: "x", destination: dest, uidMap: opts.copyUidMap ?? new Map([[Number(range), 77]]) };
    },
    messageDelete: async (range: string, o: unknown) => {
      calls.push(["delete", range, o]);
      return opts.deleteOk ?? true;
    },
    fetchOne: async (range: string) => {
      calls.push(["fetchOne", range]);
      return opts.draftFlags === null ? false : { uid: Number(range), flags: new Set(opts.draftFlags ?? ["\\Draft"]) };
    },
    append: async (box: string) => {
      calls.push(["append", box]);
      return opts.appendUid === null ? { destination: box } : { destination: box, uid: opts.appendUid ?? 501 };
    },
    list: async () => [{ path: "INBOX" }, { path: opts.trashPath ?? "Deleted Messages", specialUse: "\\Trash" }],
  };
  const imap = new ImapClient({ host: "x", port: 993, user: "u", pass: "p", secure: true });
  (imap as unknown as { client: unknown }).client = client;
  return { imap, calls };
}

const ops = (calls: Call[]) => calls.map((c) => c[0]);

test("move: uses MOVE when the server has it", async () => {
  const { imap, calls } = fakeImap({ caps: ["MOVE", "UIDPLUS"] });
  await imap.moveMessage("INBOX", 5, "Archive");
  assert.deepEqual(ops(calls), ["lock", "move"]);
});

test("move without MOVE: copy, confirmed COPYUID, then UID EXPUNGE of that one UID", async () => {
  const { imap, calls } = fakeImap({ caps: ["UIDPLUS"] });
  const r = await imap.moveMessage("INBOX", 5, "Archive");
  assert.equal(r.newUid, 77);
  assert.deepEqual(ops(calls), ["lock", "copy", "delete"]);
  assert.deepEqual(calls[2], ["delete", "5", { uid: true }]);
});

test("move without MOVE: no COPYUID → original untouched", async () => {
  const { imap, calls } = fakeImap({ caps: ["UIDPLUS"], copyUidMap: null });
  await assert.rejects(imap.moveMessage("INBOX", 5, "Archive"), /not confirmed.*left untouched/);
  assert.ok(!ops(calls).includes("delete"));
});

test("move without MOVE: COPYUID for a different UID → original untouched", async () => {
  const { imap, calls } = fakeImap({ caps: ["UIDPLUS"], copyUidMap: new Map([[6, 77]]) });
  await assert.rejects(imap.moveMessage("INBOX", 5, "Archive"), /not confirmed/);
  assert.ok(!ops(calls).includes("delete"));
});

test("move: neither MOVE nor UIDPLUS → refuse before any command", async () => {
  const { imap, calls } = fakeImap({ caps: ["IMAP4rev1"] });
  await assert.rejects(imap.moveMessage("INBOX", 5, "Archive"), /neither MOVE nor UIDPLUS/);
  assert.deepEqual(calls, []);
});

test("move: failed expunge reports the message is in both folders", async () => {
  const { imap } = fakeImap({ caps: ["UIDPLUS"], deleteOk: false });
  await assert.rejects(imap.moveMessage("INBOX", 5, "Archive"), /now in both folders/);
});

test("move: invalid uid and same folder are refused", async () => {
  const { imap, calls } = fakeImap({ caps: ["UIDPLUS"] });
  await assert.rejects(imap.moveMessage("INBOX", 0, "Archive"), /positive integer/);
  await assert.rejects(imap.moveMessage("INBOX", 5, "INBOX"), /same/);
  assert.deepEqual(calls, []);
});

test("trash: moves to the \\Trash folder", async () => {
  const { imap, calls } = fakeImap({ caps: ["UIDPLUS"] });
  assert.equal(await imap.moveToTrash("INBOX", 5), "Deleted Messages");
  assert.deepEqual(calls.find((c) => c[0] === "copy"), ["copy", "5", "Deleted Messages"]);
});

test("trash: nothing is ever removed from Trash itself", async () => {
  const { imap, calls } = fakeImap({ caps: ["UIDPLUS"] });
  await assert.rejects(imap.moveToTrash("Deleted Messages", 5), /already in Deleted Messages/);
  assert.ok(!ops(calls).includes("delete"));
});

test("restore: moving out of Trash is allowed", async () => {
  const { imap, calls } = fakeImap({ caps: ["UIDPLUS"] });
  await imap.moveMessage("Deleted Messages", 5, "INBOX");
  assert.deepEqual(ops(calls), ["lock", "copy", "delete"]);
});

test("update_draft: append new, confirmed UID, then remove the old draft", async () => {
  const { imap, calls } = fakeImap({ caps: ["UIDPLUS"] });
  const newUid = await imap.replaceDraft("Drafts", 139, Buffer.from("x"));
  assert.equal(newUid, 501);
  assert.deepEqual(ops(calls), ["lock", "fetchOne", "append", "delete"]);
  assert.deepEqual(calls[0], ["lock", "Drafts"]);
  assert.deepEqual(calls[3], ["delete", "139", { uid: true }]);
});

test("update_draft: refuses messages without \\Draft", async () => {
  const { imap, calls } = fakeImap({ caps: ["UIDPLUS"], draftFlags: ["\\Seen"] });
  await assert.rejects(imap.replaceDraft("Drafts", 139, Buffer.from("x")), /not marked/);
  assert.ok(!ops(calls).includes("append") && !ops(calls).includes("delete"));
});

test("update_draft: no APPENDUID → old draft kept", async () => {
  const { imap, calls } = fakeImap({ caps: ["UIDPLUS"], appendUid: null });
  await assert.rejects(imap.replaceDraft("Drafts", 139, Buffer.from("x")), /old draft was left in place/);
  assert.ok(!ops(calls).includes("delete"));
});

test("update_draft: missing draft or no UIDPLUS → nothing changes", async () => {
  const a = fakeImap({ caps: ["UIDPLUS"], draftFlags: null });
  await assert.rejects(a.imap.replaceDraft("Drafts", 139, Buffer.from("x")), /not found/);
  assert.ok(!ops(a.calls).includes("append"));
  const b = fakeImap({ caps: ["MOVE"] });
  await assert.rejects(b.imap.replaceDraft("Drafts", 139, Buffer.from("x")), /UIDPLUS/);
  assert.deepEqual(b.calls, []);
});

test("get_message pages link-heavy bodies within max_length, text + links", async () => {
  const long = (i: number) => `https://email-link.example.com/ls/click?upn=${i}-` + "q".repeat(450);
  const paras = Array.from({ length: 100 }, (_, i) => `Paragraph ${i} says something useful about school. Click here <${long(i)}> to read.`);
  const fakeImap = {
    getMessage: async () => ({
      uid: 1, seq: 1, flags: [], date: null, subject: "s", from: null, to: null, cc: null, size: 1, preview: null,
      messageId: null, inReplyTo: null, references: [], attachments: [],
      text: paras.join("\n\n"), textSource: "html", html: "<p>x</p>",
    }),
  };
  const fakePool = { for: () => ({ imap: fakeImap }) } as unknown as ClientPool;
  const mcp = buildMcpServer(fakePool, store);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  let offset = 0;
  let rebuilt = "";
  for (let page = 0; page < 50; page++) {
    const r = await client.callTool({ name: "get_message", arguments: { mailbox: "INBOX", uid: 1, offset, max_length: 6000 } });
    const body = JSON.parse((r.content as { text: string }[])[0].text).body;
    const linkChars = Object.values(body.links as Record<string, string>).reduce((n: number, u) => n + u.length + 8, 0);
    assert.ok(body.text.length + linkChars <= 6000 || body.text.length <= 2000, `page ${page} too big`);
    for (const m of body.text.matchAll(/\[(\d+)\]/g)) assert.ok(body.links[m[1]], `link ${m[1]} unresolved`);
    rebuilt += body.text;
    if (!body.truncated) break;
    offset = body.next_offset;
  }
  assert.equal(rebuilt.replace(/ \[\d+\]/g, ""), paras.map((p) => p.replace(/ <[^>]+>/, "")).join("\n\n"));
  const noLinks = await client.callTool({ name: "get_message", arguments: { mailbox: "INBOX", uid: 1, include_links: false } });
  assert.equal(JSON.parse((noLinks.content as { text: string }[])[0].text).body.links, undefined);
  await client.close();
});
