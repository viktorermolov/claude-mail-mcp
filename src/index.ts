#!/usr/bin/env node
/**
 * claude-mail-mcp — entry point.
 *
 * Boots an Express server that exposes:
 *   - GET  /health        liveness probe (no data)
 *   - POST /mcp           MCP Streamable HTTP transport, gated by a
 *                         Cloudflare Access JWT (see access-auth.ts)
 *
 * In the container it binds 0.0.0.0 on a private compose network that only
 * cloudflared shares; outside a container the default is 127.0.0.1.
 *
 * Credentials live in accounts.json, watched via fs.watch for hot reload.
 * Logs never include credentials, message content or tool arguments.
 */

import type { Server } from "node:http";
import { loadConfig } from "./config.js";
import { AccountsStore } from "./accounts.js";
import { ClientPool } from "./client-pool.js";
import { accessAuth } from "./access-auth.js";
import { createApp, Logger, VERSION, type AppState } from "./app.js";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
let minLevel: keyof typeof LEVELS = "info";

const log: Logger = (level, message, extra) => {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  console.error(JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...extra }));
};

/** Must stay below Docker's stop timeout (compose sets stop_grace_period: 20s). */
const DRAIN_MS = 15_000;

async function main(): Promise<void> {
  const config = loadConfig();
  minLevel = config.logLevel;

  const store = new AccountsStore(config.accountsFile);
  const pool = new ClientPool(store, log);
  await store.start((next, prev) => {
    log("info", "accounts.json changed", {
      previous: prev.map((a) => a.id),
      current: next.map((a) => a.id),
    });
    pool.resetAll().catch((err) =>
      log("warn", "client pool reset failed", {
        error: err instanceof Error ? err.name : "unknown",
      })
    );
  });
  log("info", "accounts loaded", { count: store.list().length, ids: store.ids(), error: store.error() ?? undefined });

  const auth = accessAuth({
    teamDomain: config.accessTeamDomain,
    audience: config.accessAudience,
    allowedEmails: config.allowedEmails,
    onReject: (reason, req) =>
      log("warn", "rejected MCP request", {
        reason,
        method: req.method,
        path: req.path,
        // Compose-network peer (cloudflared or the host), not an end-user IP.
        peer: req.socket.remoteAddress ?? null,
      }),
  });
  void auth.prefetch();

  const state: AppState = { shuttingDown: false, inflight: 0 };
  const app = createApp({ pool, store, auth, log, state });

  const server: Server = app.listen(config.port, config.host);
  server.on("listening", () => {
    log("info", "claude-mail-mcp listening", {
      host: config.host,
      port: config.port,
      version: VERSION,
      accounts: store.ids(),
    });
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    log("error", "listen failed", { code: err.code ?? "unknown", host: config.host, port: config.port });
    process.exit(1);
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    state.shuttingDown = true;
    log("info", "shutting down", { signal, inflight: state.inflight });
    server.close();
    // Let in-flight tool calls finish (moves/draft updates must not stop
    // half-way), then drop idle keep-alive connections.
    const deadline = Date.now() + DRAIN_MS;
    while (state.inflight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (state.inflight > 0) log("warn", "shutdown with requests still running", { inflight: state.inflight });
    server.closeAllConnections();
    store.stop();
    await pool.closeAll().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log("error", "fatal startup error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
