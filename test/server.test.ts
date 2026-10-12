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
  "search_messages",
  "set_flagged",
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

test("registered tools are exactly the allowed set — no send, move or delete", async () => {
  const mcp = buildMcpServer(pool, store);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, EXPECTED_TOOLS);
  for (const n of names) assert.doesNotMatch(n, /send|expunge|delete|trash|move|calendar|event/);
  const reads = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(reads, ["get_message", "list_accounts", "list_folders", "list_messages", "search_messages"]);
  await client.close();
});

test("source contains no SMTP transport, send, move, copy or expunge calls", async () => {
  const srcDir = path.join(import.meta.dirname, "..", "src");
  for (const f of await readdir(srcDir)) {
    const code = await readFile(path.join(srcDir, f), "utf8");
    for (const banned of [/createTransport/, /sendMail/, /messageDelete/, /messageMove/, /messageCopy/, /\.expunge\(/i, /EXPUNGE"/, /smtp-transport/, /tsdav/]) {
      assert.doesNotMatch(code, banned, `${f} matches ${banned}`);
    }
  }
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
