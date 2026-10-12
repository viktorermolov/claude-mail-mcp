import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWK } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { AccountsStore, parseAccountsFile } from "../src/accounts.js";
import { ClientPool } from "../src/client-pool.js";
import { accessAuth } from "../src/access-auth.js";
import { buildMcpServer, createApp } from "../src/app.js";
import { buildDraftSource } from "../src/draft-composer.js";

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
let publicJwk: JWK;

async function listen(app: http.RequestListener): Promise<{ server: Server; url: string }> {
  const s = http.createServer(app);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return { server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

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
  publicJwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" };
  const auth = accessAuth({
    teamDomain: TEAM,
    audience: AUD,
    allowedEmails: [OWNER],
    keys: createLocalJWKSet({ keys: [publicJwk] }),
  });
  const app = createApp({ pool, store, auth, log: () => {} });
  ({ server, url: baseUrl } = await listen(app));
});

after(async () => {
  store.stop();
  server.close();
  await rm(dir, { recursive: true, force: true });
});

function token(
  opts: { email?: string; aud?: string; iss?: string; exp?: string | number | null; key?: CryptoKey } = {}
): Promise<string> {
  const jwt = new SignJWT(opts.email === undefined ? { email: OWNER } : opts.email ? { email: opts.email } : {})
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt();
  if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? "5m");
  return jwt.sign(opts.key ?? privateKey);
}

async function callMcp(headers: Record<string, string>, url = baseUrl, body?: string): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

async function mcpClient(p: ClientPool = pool): Promise<Client> {
  const mcp = buildMcpServer(p, store);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}

const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content[0].text);

// ---- tool surface ------------------------------------------------------------

test("registered tools are exactly the allowed set — no send, no permanent delete", async () => {
  const client = await mcpClient();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, EXPECTED_TOOLS);
  for (const n of names) assert.doesNotMatch(n, /send|expunge|delete|purge|empty|calendar|event/);
  const reads = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(reads, ["get_message", "list_accounts", "list_folders", "list_messages", "search_messages"]);
  // Anything that removes a message from a folder is marked destructive.
  const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
  assert.deepEqual(destructive, ["move_message", "move_to_trash", "update_draft"]);
  // Read tools tell the model that mail content is untrusted.
  for (const t of tools.filter((x) => ["list_messages", "search_messages", "get_message"].includes(x.name))) {
    assert.match(t.description ?? "", /untrusted third-party content/);
  }
  // Drafts are text-only: no html parameter.
  for (const t of tools.filter((x) => x.name.endsWith("_draft"))) {
    assert.equal((t.inputSchema.properties as Record<string, unknown>).html, undefined);
  }
  await client.close();
});

test("source: no SMTP/send code; exactly one messageDelete; no CLOSE/raw command paths", async () => {
  const srcDir = path.join(import.meta.dirname, "..", "src");
  let deleteSites = 0;
  for (const f of await readdir(srcDir)) {
    const code = await readFile(path.join(srcDir, f), "utf8");
    for (const banned of [
      /createTransport/, /sendMail/, /\.expunge\(/i, /\bmailboxClose\b/, /\bmailboxDelete\b/,
      /\.run\(\s*["'`]/, /\.exec\(\s*["'`]/, /["'`](UID )?EXPUNGE["'`]/, /smtp-transport/, /tsdav/,
    ]) {
      assert.doesNotMatch(code, banned, `${f} matches ${banned}`);
    }
    const sites = code.match(/\bmessageDelete\b/g)?.length ?? 0;
    if (sites) assert.equal(f, "imap-client.ts", `messageDelete used in ${f}`);
    deleteSites += sites;
  }
  assert.equal(deleteSites, 1, "messageDelete must appear exactly once (expungeOne)");
});

test("list_accounts never returns credentials", async () => {
  const s = JSON.stringify(store.publicSummaries());
  assert.doesNotMatch(s, /SECRET-PASS|imap\.invalid/);
});

// ---- HTTP + auth -------------------------------------------------------------

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
  ["no exp claim", { exp: null }],
  ["signed by unknown key", { foreign: true }],
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

test("the body is not parsed before auth; bad JSON after auth is a JSON-RPC error", async () => {
  // Without a token, malformed or oversized bodies are rejected by auth (401), not parsed.
  assert.equal((await callMcp({}, baseUrl, "{not json")).status, 401);
  assert.equal((await callMcp({}, baseUrl, JSON.stringify({ x: "y".repeat(3_000_000) }))).status, 401);
  // With a token: parse errors are JSON-RPC shaped, no stack trace.
  const t = await token();
  const bad = await callMcp({ "cf-access-jwt-assertion": t }, baseUrl, "{not json");
  assert.equal(bad.status, 400);
  const j = (await bad.json()) as { error: { code: number } };
  assert.equal(j.error.code, -32700);
  const big = await callMcp({ "cf-access-jwt-assertion": t }, baseUrl, JSON.stringify({ x: "y".repeat(2_000_000) }));
  assert.equal(big.status, 413);
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

test("key fetch failure → 503 (not 401); last good keys keep working through an outage", async () => {
  let up = true;
  const jwks = await listen((req, res) => {
    if (!up) {
      res.statusCode = 500;
      res.end("down");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  const mk = (url: string) =>
    createApp({
      pool,
      store,
      log: () => {},
      auth: accessAuth({ teamDomain: TEAM, audience: AUD, allowedEmails: [OWNER], jwksUrl: url, cacheMaxAgeMs: 1 }),
    });
  const good = await listen(mk(`${jwks.url}/certs`));
  const t = await token();
  assert.equal((await callMcp({ "cf-access-jwt-assertion": t }, good.url)).status, 200);
  up = false; // keys endpoint fails; cache is already stale (1 ms)
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await callMcp({ "cf-access-jwt-assertion": t }, good.url)).status, 200, "stale-if-error");
  // A fresh process with no cached keys answers 503, not 401.
  const cold = await listen(mk(`${jwks.url}/certs`));
  const r = await callMcp({ "cf-access-jwt-assertion": t }, cold.url);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("retry-after"), "30");
  for (const s of [jwks.server, good.server, cold.server]) s.close();
});

test("a key dropped by a successful fetch stays dropped during an outage; unknown keys then get 503", async () => {
  let mode: "both" | "k2only" | "down" = "both";
  const kp2 = await generateKeyPair("RS256", { extractable: true });
  const jwk2 = { ...(await exportJWK(kp2.publicKey)), kid: "k2", alg: "RS256" };
  const jwks = await listen((_req, res) => {
    if (mode === "down") {
      res.statusCode = 500;
      res.end("down");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: mode === "both" ? [publicJwk, jwk2] : [jwk2] }));
  });
  const app = createApp({
    pool,
    store,
    log: () => {},
    auth: accessAuth({ teamDomain: TEAM, audience: AUD, allowedEmails: [OWNER], jwksUrl: `${jwks.url}/certs`, cacheMaxAgeMs: 1 }),
  });
  const s = await listen(app);
  const sleep = () => new Promise((r) => setTimeout(r, 5));
  const t1 = await token();
  const t2 = await new SignJWT({ email: OWNER })
    .setProtectedHeader({ alg: "RS256", kid: "k2" })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(kp2.privateKey);
  assert.equal((await callMcp({ "cf-access-jwt-assertion": t1 }, s.url)).status, 200);
  mode = "k2only"; // k1 is rotated out
  await sleep();
  assert.equal((await callMcp({ "cf-access-jwt-assertion": t1 }, s.url)).status, 401);
  mode = "down";
  await sleep();
  assert.equal((await callMcp({ "cf-access-jwt-assertion": t1 }, s.url)).status, 503, "dropped key must not come back");
  assert.equal((await callMcp({ "cf-access-jwt-assertion": t2 }, s.url)).status, 200, "last fetched key still works");
  for (const x of [jwks.server, s.server]) x.close();
});

test("in-flight count covers the auth wait and returns to 0 when a client disconnects mid-call", async () => {
  const state = { shuttingDown: false, inflight: 0 };
  const slowPool = {
    for: () => ({ imap: { getMessage: () => new Promise((r) => setTimeout(r, 400)) } }),
  } as unknown as ClientPool;
  const app = createApp({
    pool: slowPool,
    store,
    log: () => {},
    state,
    auth: (_q, _r, n) => void setTimeout(n, 100),
  });
  const s = await listen(app);
  const ac = new AbortController();
  const call = fetch(`${s.url}/mcp`, {
    method: "POST",
    signal: ac.signal,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_message", arguments: { mailbox: "INBOX", uid: 1 } } }),
  }).catch(() => null);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(state.inflight, 1, "counted while still in auth");
  await new Promise((r) => setTimeout(r, 150));
  ac.abort();
  await call;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(state.inflight, 0);
  s.server.close();
});

test("shutting down → 503 for new requests", async () => {
  const state = { shuttingDown: true, inflight: 0 };
  const app = createApp({ pool, store, log: () => {}, state, auth: (_q, _r, n) => n() });
  const s = await listen(app);
  assert.equal((await callMcp({}, s.url)).status, 503);
  s.server.close();
});

// ---- tool input validation -----------------------------------------------------

test("drafts: recipients must be bare addresses; header fields can't carry line breaks", async () => {
  let appended = 0;
  const spyPool = {
    for: () => ({
      imap: { appendDraft: async () => (appended++, 7) },
      sender: { from: OWNER },
      draftsFolder: "Drafts",
    }),
  } as unknown as ClientPool;
  const client = await mcpClient(spyPool);
  const call = (args: Record<string, unknown>) =>
    client.callTool({ name: "create_draft", arguments: { to: "a@example.com", subject: "s", text: "t", ...args } });
  for (const bad of [
    { to: '"Boss, mallory@evil.example," <boss@example.com>' },
    { to: "Boss <boss@example.com>" },
    { cc: ["ok@example.com", "x@evil.example, y@evil.example"] },
    { subject: "hi\r\nBcc: spy@evil.example" },
    { in_reply_to: "<a@b>\r\nX-Evil: 1" },
  ]) {
    const r = await call(bad);
    assert.equal((r as { isError?: boolean }).isError, true, JSON.stringify(bad));
    assert.match(textOf(r), /validation/i, `rejected by the schema: ${JSON.stringify(bad)}`);
  }
  assert.equal(appended, 0, "bad input must never reach IMAP");
  const ok = await call({});
  assert.notEqual((ok as { isError?: boolean }).isError, true, textOf(ok));
  assert.equal(appended, 1, "positive control: valid input does reach IMAP");
  await client.close();
});

test("search: impossible calendar dates are rejected, not silently ignored", async () => {
  const client = await mcpClient();
  for (const since of ["2026-13-01", "2026-02-30"]) {
    const r = await client.callTool({ name: "search_messages", arguments: { mailbox: "INBOX", since } });
    assert.equal((r as { isError?: boolean }).isError, true, since);
    assert.match(textOf(r), /calendar date|Invalid/i);
  }
  await client.close();
});

// ---- get_message paging and links ------------------------------------------------

function fakePoolWithText(text: string): ClientPool {
  const fakeImap = {
    getMessage: async () => ({
      uid: 1, seq: 1, flags: [], date: null, subject: "s", from: null, to: null, cc: null, size: 1, preview: null,
      messageId: null, inReplyTo: null, references: [], attachments: [], partial: false,
      text, textSource: "html", html: "<p>x</p>",
    }),
  };
  return { for: () => ({ imap: fakeImap }) } as unknown as ClientPool;
}

test("get_message: links are omitted by default and returned only with include_links", async () => {
  const long = "https://w-mt.co/g/clickTracker?redirectTo=" + "Q".repeat(600);
  const client = await mcpClient(fakePoolWithText(`${long}\n\nOrder date: Sun\n\nView order <https://example.com/o/1>`));
  const r1 = JSON.parse(textOf(await client.callTool({ name: "get_message", arguments: { mailbox: "INBOX", uid: 1 } })));
  assert.equal(r1.body.links, undefined);
  assert.equal(r1.body.link_count, 2);
  assert.match(r1.body.text, /^\[1\]\n\nOrder date: Sun\n\nView order \[2\]$/);
  assert.doesNotMatch(r1.body.text, /https?:/);
  const r2 = JSON.parse(textOf(await client.callTool({ name: "get_message", arguments: { mailbox: "INBOX", uid: 1, include_links: true } })));
  assert.deepEqual(r2.body.links, { 1: long, 2: "https://example.com/o/1" });
  await client.close();
});

test("get_message pages link-heavy bodies within max_length (with include_links)", async () => {
  const long = (i: number) => `https://email-link.example.com/ls/click?upn=${i}-` + "q".repeat(450);
  const paras = Array.from({ length: 100 }, (_, i) => `Paragraph ${i} says something useful about school. Click here <${long(i)}> to read.`);
  const client = await mcpClient(fakePoolWithText(paras.join("\n\n")));
  let offset = 0;
  let rebuilt = "";
  for (let page = 0; page < 50; page++) {
    const r = await client.callTool({ name: "get_message", arguments: { mailbox: "INBOX", uid: 1, offset, max_length: 6000, include_links: true } });
    const body = JSON.parse(textOf(r)).body;
    const linkChars = Object.values(body.links as Record<string, string>).reduce((n: number, u) => n + u.length + 8, 0);
    assert.ok(body.text.length + linkChars <= 6000, `page ${page} too big`);
    const refs = new Set([...body.text.matchAll(/\[(\d+)\]/g)].map((m) => m[1]));
    const unresolved = [...refs].filter((n) => !body.links[n]).length;
    assert.equal(unresolved, body.links_omitted ?? 0, `page ${page}: unresolved links must be counted`);
    assert.equal(unresolved, 0, "with a 500-char text floor these links all fit");
    rebuilt += body.text;
    if (!body.truncated) break;
    offset = body.next_offset;
  }
  assert.equal(rebuilt.replace(/ \[\d+\]/g, ""), paras.map((p) => p.replace(/ <[^>]+>/, "")).join("\n\n"));
  await client.close();
});

test("get_message cuts very long URLs and never exceeds max_length because of links", async () => {
  const huge = (i: number) => `https://t.example/${i}?` + "z".repeat(5_000);
  const text = Array.from({ length: 6 }, (_, i) => `Item ${i} <${huge(i)}>`).join("\n");
  const client = await mcpClient(fakePoolWithText(text));
  const r = JSON.parse(textOf(await client.callTool({ name: "get_message", arguments: { mailbox: "INBOX", uid: 1, max_length: 3000, include_links: true } })));
  const shown = Object.values(r.body.links as Record<string, string>);
  assert.ok(shown.length >= 1);
  for (const u of shown) assert.ok(u.endsWith("…(truncated)") && u.length < 2_100, u.slice(-20));
  const total = r.body.text.length + shown.reduce((n: number, u: string) => n + u.length + 8, 0);
  assert.ok(total <= 3000, `page is ${total} chars`);
  assert.equal(shown.length + (r.body.links_omitted ?? 0), new Set([...r.body.text.matchAll(/\[(\d+)\]/g)].map((m: RegExpMatchArray) => m[1])).size);
  await client.close();
});

// ---- drafts, accounts --------------------------------------------------------------

test("drafts are composed locally as plain text with Bcc kept", async () => {
  const raw = (await buildDraftSource(
    { from: OWNER, fromName: 'Owner "Me"' },
    { to: "a@example.com", bcc: "b@example.com", subject: "Hi", text: "body" }
  )).toString();
  assert.match(raw, /^From: "Owner \\"Me\\"" <owner@example\.com>/m);
  assert.match(raw, /^Bcc: b@example\.com/m);
  assert.match(raw, /^Subject: Hi/m);
  assert.match(raw, /^Content-Type: text\/plain/m);
  assert.doesNotMatch(raw, /text\/html/);
});

test("parse errors never echo the file contents", () => {
  assert.throws(
    () => parseAccountsFile('{"version":1,"accounts":[{"imap":{"pass":"SECRET-PASS"'),
    (e: Error) => !e.message.includes("SECRET")
  );
});

test("an invalid accounts.json at startup does not crash; the reason is reported", async () => {
  const d = await mkdtemp(path.join(tmpdir(), "mail-mcp-bad-"));
  const f = path.join(d, "accounts.json");
  await writeFile(f, '{"version":1,"accounts":[{"id":"x",}]}');
  const s = new AccountsStore(f);
  await s.start();
  assert.match(s.error() ?? "", /not valid JSON/);
  assert.throws(() => s.resolve(), /could not be loaded \(accounts\.json is not valid JSON\)/);
  s.stop();
  await rm(d, { recursive: true, force: true });
});
