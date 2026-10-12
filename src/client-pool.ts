/**
 * Per-account client pool.
 *
 * Holds one ImapClient per account, lazy-initialized on first use. When
 * accounts.json changes the entire pool is dropped and rebuilt on next
 * request — simpler than diffing per-field credential changes, and IMAP
 * reconnects are cheap (~one TLS handshake).
 */

import { ImapClient, type ImapLogger } from "./imap-client.js";
import { Account, AccountsStore, type CalDavCreds } from "./accounts.js";
import { DraftSender } from "./draft-composer.js";
import { CalDavClient } from "./caldav-client.js";

interface AccountClients {
  imap: ImapClient;
  sender: DraftSender;
  draftsFolder: string;
  trashFolder?: string;
  /** Read-only calendar client, or null when calendars aren't configured for this account. */
  calendar: CalDavClient | null;
}

export interface PoolOptions {
  log?: ImapLogger;
  /** CALENDAR_ICLOUD=on: read iCloud calendars with the account's IMAP app-specific password. */
  icloudCalendar?: boolean;
}

const ICLOUD_IMAP_HOST = "imap.mail.me.com";
const ICLOUD_CALDAV_URL = "https://caldav.icloud.com";

export class ClientPool {
  private readonly store: AccountsStore;
  private readonly log?: ImapLogger;
  private readonly icloudCalendar: boolean;
  private pool: Map<string, AccountClients> = new Map();

  constructor(store: AccountsStore, opts: PoolOptions = {}) {
    this.store = store;
    this.log = opts.log;
    this.icloudCalendar = opts.icloudCalendar === true;
  }

  /**
   * Resolve the requested account ID (or default if omitted) and return its
   * clients. Lazy-initializes the underlying connection on first use.
   */
  for(accountId?: string): AccountClients {
    const account = this.store.resolve(accountId);
    const existing = this.pool.get(account.id);
    if (existing) return existing;
    const clients = this.build(account);
    this.pool.set(account.id, clients);
    return clients;
  }

  /**
   * Drop and close all cached clients — call this when accounts.json
   * changes so the next request rebuilds with the new credentials.
   */
  async resetAll(): Promise<void> {
    const old = Array.from(this.pool.values());
    this.pool.clear();
    await Promise.all(old.map((c) => c.imap.close().catch(() => {})));
  }

  /** Shutdown: close every IMAP connection. */
  async closeAll(): Promise<void> {
    await this.resetAll();
  }

  private build(account: Account): AccountClients {
    const imap = new ImapClient(
      {
        host: account.imap.host,
        port: account.imap.port,
        user: account.imap.user,
        pass: account.imap.pass,
        secure: account.imap.tls,
      },
      { log: this.log, accountId: account.id }
    );
    return {
      imap,
      sender: {
        from: account.mail.defaultFrom,
        fromName: account.mail.defaultFromName || undefined,
      },
      draftsFolder: account.mail.draftsFolder,
      trashFolder: account.mail.trashFolder,
      calendar: (() => {
        const creds = this.calendarCreds(account);
        return creds ? new CalDavClient(creds) : null;
      })(),
    };
  }

  private calendarCreds(account: Account): CalDavCreds | null {
    if (account.caldav) return account.caldav;
    if (this.icloudCalendar && account.imap.host.toLowerCase() === ICLOUD_IMAP_HOST) {
      return { url: ICLOUD_CALDAV_URL, user: account.imap.user, pass: account.imap.pass };
    }
    return null;
  }
}
