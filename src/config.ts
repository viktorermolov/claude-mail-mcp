/**
 * Environment configuration loader.
 *
 * Only transport-level settings live here (bind address, Cloudflare Access
 * parameters, accounts file path, log level). Mailbox credentials live in
 * accounts.json — see src/accounts.ts and README.md.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }
  return parsed;
}

function list(name: string): string[] {
  return required(name)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export const config = {
  port: int("PORT", 3220),
  /**
   * Interface to bind. Keep the default 127.0.0.1: the only way in is the
   * local cloudflared connector.
   */
  host: optional("HOST", "127.0.0.1"),
  logLevel: optional("LOG_LEVEL", "info") as
    | "debug"
    | "info"
    | "warn"
    | "error",

  /** Path to the accounts file (chmod 600, owned by the service user). */
  accountsFile: required("ACCOUNTS_FILE"),

  /** Cloudflare Zero Trust team domain, e.g. "myteam.cloudflareaccess.com". */
  accessTeamDomain: required("CF_ACCESS_TEAM_DOMAIN"),
  /** Application Audience (AUD) tag of the Access application. */
  accessAudience: required("CF_ACCESS_AUD"),
  /** Comma-separated e-mail addresses allowed to use the connector. */
  allowedEmails: list("ALLOWED_EMAILS"),
} as const;

export type Config = typeof config;
