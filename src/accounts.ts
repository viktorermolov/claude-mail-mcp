/**
 * Accounts store — multi-account credential management.
 *
 * Accounts live in a JSON file (ACCOUNTS_FILE) that the operator writes by
 * hand. The server reads it on startup and re-reads it whenever the file
 * changes (fs.watch), so credentials can be rotated without a restart.
 *
 * This fork is IMAP-only: there are no SMTP or CalDAV credentials, so the
 * server has no way to send mail even if a tool asked it to.
 *
 * File format (version 1):
 *   {
 *     "version": 1,
 *     "accounts": [
 *       {
 *         "id": "icloud",
 *         "label": "iCloud",
 *         "default": true,
 *         "imap": { "host": "imap.mail.me.com", "port": 993, "user": "...", "pass": "...", "tls": true },
 *         "mail": { "defaultFrom": "...", "draftsFolder": "Drafts", "trashFolder": "Deleted Messages" }
 *       }
 *     ]
 *   }
 *
 * Unknown keys (e.g. a leftover "smtp" block) are ignored.
 *
 * Storage security: the file must be readable only by the service user
 * (chmod 600). No app-level encryption — filesystem perms + systemd
 * hardening are the security boundary.
 */

import { promises as fs } from "node:fs";
import { watch, FSWatcher } from "node:fs";
import path from "node:path";

export interface ImapCreds {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
}

export interface MailDefaults {
  defaultFrom: string;
  defaultFromName?: string;
  draftsFolder: string;
  /** Explicit Trash folder; when omitted the \Trash special-use folder is used. */
  trashFolder?: string;
}

export interface Account {
  id: string;
  label: string;
  default?: boolean;
  imap: ImapCreds;
  mail: MailDefaults;
}

export interface AccountsFile {
  version: 1;
  accounts: Account[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class AccountsStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountsStoreError";
  }
}

export class NoSuchAccountError extends Error {
  constructor(public readonly accountId: string, availableIds: string[]) {
    super(
      availableIds.length === 0
        ? `No mailbox accounts configured yet. The operator has to fill in accounts.json on the server.`
        : `Account "${accountId}" is not configured. Available: ${availableIds.join(", ")}.`
    );
    this.name = "NoSuchAccountError";
  }
}

export class AccountsStore {
  private accounts: Account[] = [];
  private byId: Map<string, Account> = new Map();
  private watcher: FSWatcher | null = null;
  private readonly filePath: string;
  private onChange?: (next: Account[], prev: Account[]) => void;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Initial load from disk (a missing file is a valid "first run" state),
   * then start watching the file for changes.
   */
  async start(onChange?: (next: Account[], prev: Account[]) => void): Promise<void> {
    this.onChange = onChange;
    await this.reload();
    this.watchFile();
  }

  /** Shut down the fs.watch listener. */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Re-read accounts.json from disk. Safe to call repeatedly. If the file
   * is missing the store reverts to an empty account list (not an error).
   */
  async reload(): Promise<void> {
    const prev = this.accounts;
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.accounts = [];
        this.byId = new Map();
        if (this.onChange && prev.length > 0) {
          this.onChange(this.accounts, prev);
        }
        return;
      }
      throw err;
    }

    const parsed = parseAccountsFile(raw);
    this.accounts = parsed.accounts;
    this.byId = new Map(parsed.accounts.map((a) => [a.id, a]));
    if (this.onChange) {
      this.onChange(this.accounts, prev);
    }
  }

  /** All currently-loaded accounts. */
  list(): Account[] {
    return this.accounts;
  }

  /** Just the IDs — handy for error messages. */
  ids(): string[] {
    return this.accounts.map((a) => a.id);
  }

  /**
   * Resolve an account ID to a full Account. If no ID is given, returns the
   * `default: true` account, or the first one if none is marked default.
   * Throws NoSuchAccountError if the ID is unknown or the store is empty.
   */
  resolve(accountId?: string): Account {
    if (accountId) {
      const acc = this.byId.get(accountId);
      if (!acc) throw new NoSuchAccountError(accountId, this.ids());
      return acc;
    }
    const def = this.accounts.find((a) => a.default) ?? this.accounts[0];
    if (!def) throw new NoSuchAccountError("(default)", []);
    return def;
  }

  /**
   * Public summaries for the list_accounts MCP tool — never include
   * credentials in the response.
   */
  publicSummaries(): Array<{
    id: string;
    label: string;
    default: boolean;
    address: string;
  }> {
    return this.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      default: Boolean(a.default),
      address: a.mail.defaultFrom,
    }));
  }

  private watchFile(): void {
    // fs.watch on a missing file throws; watch the parent directory and
    // filter to our basename for robustness across editor save patterns
    // (vim writes with a swap-and-rename, which fires on the directory).
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    let pending: NodeJS.Timeout | null = null;
    try {
      this.watcher = watch(dir, { persistent: false }, (_evt, filename) => {
        if (!filename || filename !== base) return;
        if (pending) clearTimeout(pending);
        // Debounce: editors can fire multiple events for a single save.
        pending = setTimeout(() => {
          this.reload().catch((err) => {
            // Don't crash the server on a malformed save; just keep the old
            // accounts in memory. The message never contains the password:
            // parse errors name the field, not its value.
            console.error(
              JSON.stringify({
                ts: new Date().toISOString(),
                level: "error",
                msg: "accounts.json reload failed",
                error: err instanceof Error ? err.message : String(err),
              })
            );
          });
        }, 150);
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          msg: "accounts.json watch failed; hot reload disabled",
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }
}

export function parseAccountsFile(raw: string): AccountsFile {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Don't echo the parser message: it can quote a fragment of the file,
    // which may include the password.
    throw new AccountsStoreError("accounts.json is not valid JSON");
  }
  if (!json || typeof json !== "object") {
    throw new AccountsStoreError("accounts.json must be a JSON object");
  }
  const obj = json as { version?: unknown; accounts?: unknown };
  if (obj.version !== 1) {
    throw new AccountsStoreError(`Unsupported accounts.json version. Expected 1.`);
  }
  if (!Array.isArray(obj.accounts)) {
    throw new AccountsStoreError("accounts.json must have an `accounts` array");
  }
  const accounts: Account[] = obj.accounts.map((a, i) => parseAccount(a, i));
  const ids = new Set<string>();
  for (const a of accounts) {
    if (ids.has(a.id)) {
      throw new AccountsStoreError(`Duplicate account id: ${a.id}`);
    }
    ids.add(a.id);
  }
  return { version: 1, accounts };
}

function parseAccount(raw: unknown, index: number): Account {
  if (!raw || typeof raw !== "object") {
    throw new AccountsStoreError(`accounts[${index}] must be an object`);
  }
  const a = raw as Record<string, unknown>;
  const id = expectStr(a.id, `accounts[${index}].id`);
  if (!ID_PATTERN.test(id)) {
    throw new AccountsStoreError(
      `accounts[${index}].id must match ${ID_PATTERN} (a-z, 0-9, _, -; 1-32 chars; start alphanumeric)`
    );
  }
  return {
    id,
    label: expectStr(a.label, `accounts[${index}].label`),
    default: a.default === true ? true : undefined,
    imap: parseImap(a.imap, `accounts[${index}].imap`),
    mail: parseMail(a.mail, `accounts[${index}].mail`),
  };
}

function parseImap(raw: unknown, where: string): ImapCreds {
  if (!raw || typeof raw !== "object") {
    throw new AccountsStoreError(`${where} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  return {
    host: expectStr(o.host, `${where}.host`),
    port: expectInt(o.port, `${where}.port`),
    user: expectStr(o.user, `${where}.user`),
    pass: expectStr(o.pass, `${where}.pass`),
    tls: typeof o.tls === "boolean" ? o.tls : true,
  };
}

function parseMail(raw: unknown, where: string): MailDefaults {
  if (!raw || typeof raw !== "object") {
    throw new AccountsStoreError(`${where} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  return {
    defaultFrom: expectStr(o.defaultFrom, `${where}.defaultFrom`),
    defaultFromName: typeof o.defaultFromName === "string" ? o.defaultFromName : undefined,
    draftsFolder: typeof o.draftsFolder === "string" && o.draftsFolder.length > 0 ? o.draftsFolder : "Drafts",
    trashFolder: typeof o.trashFolder === "string" && o.trashFolder.length > 0 ? o.trashFolder : undefined,
  };
}

function expectStr(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new AccountsStoreError(`${where} must be a non-empty string`);
  }
  return v;
}

function expectInt(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
    throw new AccountsStoreError(`${where} must be an integer 1-65535`);
  }
  return v;
}
