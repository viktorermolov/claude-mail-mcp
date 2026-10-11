#!/usr/bin/env node
/**
 * claude-mail-mcp — entry point.
 *
 * Boots an Express server on loopback that exposes:
 *   - GET  /health        liveness probe (no data)
 *   - POST /mcp           MCP Streamable HTTP transport, gated by a
 *                         Cloudflare Access JWT (see access-auth.ts)
 *
 * Credentials live in accounts.json, watched via fs.watch for hot reload.
 * Logs never include credentials, message content or tool arguments.
 */

import { config } from "./config.js";
import { AccountsStore } from "./accounts.js";
import { ClientPool } from "./client-pool.js";
import { accessAuth } from "./access-auth.js";
import { createApp, Logger, VERSION } from "./app.js";

const log: Logger = (level, message, extra) => {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  if (order[level] < order[config.logLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...extra,
  };
  console.error(JSON.stringify(line));
};

async function main(): Promise<void> {
  const store = new AccountsStore(config.accountsFile);
  const pool = new ClientPool(store);
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
  log("info", "accounts loaded", { count: store.list().length, ids: store.ids() });

  const auth = accessAuth({
    teamDomain: config.accessTeamDomain,
    audience: config.accessAudience,
    allowedEmails: config.allowedEmails,
    onReject: (reason, req) =>
      log("warn", "rejected MCP request", { reason, method: req.method, path: req.path }),
  });

  const app = createApp({ pool, store, auth, log });

  app.listen(config.port, config.host, () => {
    log("info", "claude-mail-mcp listening", {
      host: config.host,
      port: config.port,
      version: VERSION,
      accounts: store.ids(),
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    log("info", "shutting down", { signal });
    store.stop();
    await pool.closeAll().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "fatal startup error",
      error: err instanceof Error ? err.message : String(err),
    })
  );
  process.exit(1);
});
