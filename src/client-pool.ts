/**
 * Per-account client pool.
 *
 * Holds one ImapClient per account, lazy-initialized on first use. When
 * accounts.json changes the entire pool is dropped and rebuilt on next
 * request — simpler than diffing per-field credential changes, and IMAP
 * reconnects are cheap (~one TLS handshake).
 */

import { ImapClient } from "./imap-client.js";
import { Account, AccountsStore } from "./accounts.js";
import { DraftSender } from "./draft-composer.js";

interface AccountClients {
  imap: ImapClient;
  sender: DraftSender;
  draftsFolder: string;
  trashFolder?: string;
}

export class ClientPool {
  private readonly store: AccountsStore;
  private pool: Map<string, AccountClients> = new Map();

  constructor(store: AccountsStore) {
    this.store = store;
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
    const imap = new ImapClient({
      host: account.imap.host,
      port: account.imap.port,
      user: account.imap.user,
      pass: account.imap.pass,
      secure: account.imap.tls,
    });
    return {
      imap,
      sender: {
        from: account.mail.defaultFrom,
        fromName: account.mail.defaultFromName || undefined,
      },
      draftsFolder: account.mail.draftsFolder,
      trashFolder: account.mail.trashFolder,
    };
  }
}
