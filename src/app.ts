/**
 * HTTP app: GET /health (no data) and POST /mcp (Access-JWT gated).
 *
 * Kept separate from index.ts so tests can build the app with a local key
 * set and an in-memory accounts store.
 */

import express, { RequestHandler } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { AccountsStore } from "./accounts.js";
import { ClientPool } from "./client-pool.js";
import { registerMailTools } from "./tools-mail.js";

export const VERSION = "0.5.0";

export type Logger = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
) => void;

export function buildMcpServer(pool: ClientPool, store: AccountsStore): McpServer {
  const mcp = new McpServer({ name: "claude-mail-mcp", version: VERSION });
  registerMailTools(mcp, pool, store);
  return mcp;
}

export function createApp(deps: {
  pool: ClientPool;
  store: AccountsStore;
  auth: RequestHandler;
  log: Logger;
}): express.Express {
  const { pool, store, auth, log } = deps;
  const app = express();
  app.disable("x-powered-by");
  // Only cloudflared on loopback sits in front of us.
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "5mb" }));

  // Liveness only — no account names, addresses or paths.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/mcp", auth, async (req, res) => {
    // Stateless mode: a fresh server + transport per request, so concurrent
    // requests can never share a transport.
    const mcp = buildMcpServer(pool, store);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("error", "MCP request failed", {
        error: err instanceof Error ? err.name : "unknown",
      });
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error" });
      }
    }
  });

  // GET/DELETE /mcp are only meaningful for stateful sessions.
  app.all("/mcp", auth, (_req, res) => {
    res.status(405).set("Allow", "POST").json({ error: "method_not_allowed" });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}
