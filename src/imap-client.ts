/**
 * IMAP client wrapper around imapflow.
 *
 * Holds a single long-lived connection that auto-reconnects on demand.
 * Each operation acquires a mailbox lock so concurrent tool calls don't
 * collide on the IMAP `SELECT` state.
 *
 * Read paths open the mailbox with EXAMINE (read-only), so listing or
 * reading never changes flags. Write paths are limited to flag changes
 * and APPEND (drafts) — nothing in this file moves, sets \Deleted or
 * EXPUNGEs.
 *
 * Tool handlers stay thin: they call high-level methods here, get back
 * plain JSON-shaped objects, and don't see imapflow internals.
 */

import { ImapFlow, ImapFlowOptions, FetchMessageObject } from "imapflow";
import { simpleParser, ParsedMail } from "mailparser";

export interface ImapAuth {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
}

export interface MailboxSummary {
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  specialUse?: string;
  subscribed: boolean;
  listed: boolean;
}

export interface MessageSummary {
  uid: number;
  seq: number;
  flags: string[];
  date: string | null;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  size: number | null;
  preview: string | null;
}

export interface MessageDetail extends MessageSummary {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: Array<{
    filename: string | null;
    contentType: string;
    size: number;
    contentId: string | null;
  }>;
}

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  since?: string; // YYYY-MM-DD
  before?: string; // YYYY-MM-DD
  unread?: boolean;
  flagged?: boolean;
}

export class ImapClient {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private readonly opts: ImapFlowOptions;

  constructor(auth: ImapAuth) {
    this.opts = {
      host: auth.host,
      port: auth.port,
      secure: auth.secure,
      auth: { user: auth.user, pass: auth.pass },
      logger: false,
    };
  }

  private async ensureConnected(): Promise<ImapFlow> {
    if (this.client && this.client.usable) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async (): Promise<ImapFlow> => {
      const client = new ImapFlow(this.opts);
      client.on("error", () => {
        // Mark unusable so next call reconnects.
        if (this.client === client) this.client = null;
      });
      await client.connect();
      this.client = client;
      this.connecting = null;
      return client;
    })();
    return this.connecting;
  }

  async close(): Promise<void> {
    if (this.client) {
      const c = this.client;
      this.client = null;
      try {
        await c.logout();
      } catch {
        // best effort
      }
    }
  }

  async listMailboxes(): Promise<MailboxSummary[]> {
    const client = await this.ensureConnected();
    const list = await client.list();
    return list.map((m) => ({
      path: m.path,
      name: m.name,
      delimiter: m.delimiter ?? "/",
      flags: Array.from(m.flags ?? []),
      specialUse: m.specialUse ?? undefined,
      subscribed: Boolean(m.subscribed),
      listed: Boolean(m.listed),
    }));
  }

  async listMessages(
    mailbox: string,
    opts: { limit?: number; unreadOnly?: boolean } = {}
  ): Promise<MessageSummary[]> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const status = await client.status(mailbox, { messages: true });
      const total = status.messages ?? 0;
      if (total === 0) return [];
      const limit = Math.min(opts.limit ?? 25, 200);

      let uids: number[] = [];
      if (opts.unreadOnly) {
        const found = await client.search({ seen: false }, { uid: true });
        const arr = Array.isArray(found) ? found : [];
        uids = arr.slice(-limit).reverse();
      } else {
        // Fetch the newest `limit` by sequence number.
        const from = Math.max(1, total - limit + 1);
        const messages = await this.fetchRange(client, `${from}:*`, false);
        return messages.reverse();
      }
      if (uids.length === 0) return [];
      return await this.fetchRange(client, uids.join(","), true);
    } finally {
      lock.release();
    }
  }

  async searchMessages(
    mailbox: string,
    criteria: SearchCriteria,
    limit = 25
  ): Promise<MessageSummary[]> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const query: Record<string, unknown> = {};
      if (criteria.from) query.from = criteria.from;
      if (criteria.to) query.to = criteria.to;
      if (criteria.subject) query.subject = criteria.subject;
      if (criteria.body) query.body = criteria.body;
      if (criteria.since) query.since = new Date(criteria.since);
      if (criteria.before) query.before = new Date(criteria.before);
      if (criteria.unread === true) query.seen = false;
      if (criteria.unread === false) query.seen = true;
      if (criteria.flagged === true) query.flagged = true;
      if (criteria.flagged === false) query.unflagged = true;

      const found = await client.search(query, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      if (uids.length === 0) return [];
      const slice = uids.slice(-Math.min(limit, 200)).reverse();
      return await this.fetchRange(client, slice.join(","), true);
    } finally {
      lock.release();
    }
  }

  async getMessage(mailbox: string, uid: number): Promise<MessageDetail> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const msg = await client.fetchOne(
        `${uid}`,
        { source: true, envelope: true, flags: true, internalDate: true, size: true },
        { uid: true }
      );
      if (!msg) {
        throw new Error(`Message UID ${uid} not found in ${mailbox}`);
      }
      const parsed: ParsedMail = await simpleParser(msg.source as Buffer);
      return {
        uid: msg.uid as number,
        seq: msg.seq as number,
        flags: Array.from(msg.flags ?? []),
        date:
          (msg.internalDate as Date | undefined)?.toISOString() ?? null,
        subject: parsed.subject ?? null,
        from: parsed.from?.text ?? null,
        to: Array.isArray(parsed.to)
          ? parsed.to.map((a) => a.text).join(", ")
          : parsed.to?.text ?? null,
        cc: Array.isArray(parsed.cc)
          ? parsed.cc.map((a) => a.text).join(", ")
          : parsed.cc?.text ?? null,
        size: (msg.size as number | undefined) ?? null,
        preview: parsed.text ? parsed.text.slice(0, 200) : null,
        messageId: parsed.messageId ?? null,
        inReplyTo: parsed.inReplyTo ?? null,
        references: Array.isArray(parsed.references)
          ? parsed.references
          : parsed.references
            ? [parsed.references]
            : [],
        bodyText: parsed.text ?? null,
        bodyHtml: typeof parsed.html === "string" ? parsed.html : null,
        attachments: (parsed.attachments ?? []).map((a) => ({
          filename: a.filename ?? null,
          contentType: a.contentType,
          size: a.size,
          contentId: a.cid ?? null,
        })),
      };
    } finally {
      lock.release();
    }
  }

  async markRead(
    mailbox: string,
    uid: number,
    read: boolean
  ): Promise<void> {
    await this.setFlag(mailbox, uid, "\\Seen", read);
  }

  async markFlagged(
    mailbox: string,
    uid: number,
    flagged: boolean
  ): Promise<void> {
    await this.setFlag(mailbox, uid, "\\Flagged", flagged);
  }

  private async setFlag(
    mailbox: string,
    uid: number,
    flag: string,
    on: boolean
  ): Promise<void> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      if (on) {
        await client.messageFlagsAdd(`${uid}`, [flag], { uid: true });
      } else {
        await client.messageFlagsRemove(`${uid}`, [flag], { uid: true });
      }
    } finally {
      lock.release();
    }
  }

  /**
   * Append a raw RFC 822 message to a folder — used for drafts only.
   */
  async append(
    mailbox: string,
    raw: string | Buffer,
    flags: string[]
  ): Promise<void> {
    const client = await this.ensureConnected();
    await client.append(mailbox, raw, flags);
  }

  private async fetchRange(
    client: ImapFlow,
    range: string,
    byUid: boolean
  ): Promise<MessageSummary[]> {
    const out: MessageSummary[] = [];
    const fetchOpts = {
      envelope: true,
      flags: true,
      internalDate: true,
      size: true,
      bodyParts: ["1"],
    };
    for await (const msg of client.fetch(range, fetchOpts, { uid: byUid })) {
      out.push(summarize(msg));
    }
    return out;
  }
}

function addrText(
  addr:
    | { name?: string; address?: string }[]
    | { name?: string; address?: string }
    | undefined
): string | null {
  if (!addr) return null;
  const list = Array.isArray(addr) ? addr : [addr];
  return (
    list
      .map((a) => {
        const name = a?.name?.trim();
        const email = a?.address?.trim();
        if (name && email) return `${name} <${email}>`;
        return email ?? name ?? null;
      })
      .filter((v): v is string => Boolean(v))
      .join(", ") || null
  );
}

function summarize(msg: FetchMessageObject): MessageSummary {
  const env = msg.envelope;
  // Try to grab a short text preview from bodyParts if present.
  let preview: string | null = null;
  const bodyParts = msg.bodyParts;
  if (bodyParts && bodyParts.size > 0) {
    const part = bodyParts.values().next().value;
    if (part) {
      const text = Buffer.isBuffer(part) ? part.toString("utf8") : String(part);
      preview = text.replace(/\s+/g, " ").slice(0, 200);
    }
  }
  return {
    uid: msg.uid as number,
    seq: msg.seq as number,
    flags: Array.from(msg.flags ?? []),
    date: env?.date ? new Date(env.date).toISOString() : null,
    subject: env?.subject ?? null,
    from: addrText(env?.from),
    to: addrText(env?.to),
    cc: addrText(env?.cc),
    size: (msg.size as number | undefined) ?? null,
    preview,
  };
}
