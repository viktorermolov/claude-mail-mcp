/**
 * IMAP client wrapper around imapflow.
 *
 * Holds a single long-lived connection that auto-reconnects on demand.
 * Each operation acquires a mailbox lock so concurrent tool calls don't
 * collide on the IMAP `SELECT` state.
 *
 * Read paths open the mailbox with EXAMINE (read-only), so listing or
 * reading never changes flags. Write paths are flag changes (\Seen,
 * \Flagged), APPEND (drafts) and moves. The only removal is expungeOne():
 * "UID EXPUNGE" of a single message after its copy (or its replacing
 * draft) has been confirmed. There is no plain EXPUNGE and no way to
 * remove a message from Trash.
 *
 * Tool handlers stay thin: they call high-level methods here, get back
 * plain JSON-shaped objects, and don't see imapflow internals.
 */

import { ImapFlow, ImapFlowOptions, FetchMessageObject } from "imapflow";
import { simpleParser, ParsedMail } from "mailparser";
import {
  readableBody,
  previewOf,
  stripLinks,
  looksLikeHtmlJunk,
  htmlToPlain,
  cleanJunkPlain,
  type BodySource,
} from "./body-text.js";

import libqp from "libqp";

/** Byte caps for the raw text part fetched to build a preview. */
const PREVIEW_PLAIN_BYTES = 8 * 1024;
const PREVIEW_HTML_BYTES = 48 * 1024;

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
  /** Readable plain text (see body-text.ts), untruncated. */
  text: string;
  /** Which MIME part the text came from. */
  textSource: BodySource;
  /** Raw HTML part, if any. */
  html: string | null;
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
      const body = readableBody(parsed);
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
        preview: previewOf(stripLinks(body.text)),
        messageId: parsed.messageId ?? null,
        inReplyTo: parsed.inReplyTo ?? null,
        references: Array.isArray(parsed.references)
          ? parsed.references
          : parsed.references
            ? [parsed.references]
            : [],
        text: body.text,
        textSource: body.source,
        html: typeof parsed.html === "string" ? parsed.html : null,
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
   * Returns the new message's UID when the server reports it (APPENDUID).
   */
  async append(
    mailbox: string,
    raw: string | Buffer,
    flags: string[]
  ): Promise<number | undefined> {
    const client = await this.ensureConnected();
    const res = await client.append(mailbox, raw, flags);
    return res && typeof res.uid === "number" ? res.uid : undefined;
  }

  /**
   * Move one message to another folder.
   *
   * With IMAP MOVE (RFC 6851) this is one atomic command. iCloud has no
   * MOVE, so otherwise we run the sequence RFC 6851 §3.3 defines MOVE to be
   * equivalent to — UID COPY, then \Deleted + UID EXPUNGE on the original —
   * with these guards:
   *   - UIDPLUS is required (otherwise refuse before touching anything);
   *   - the original is touched only after the server confirms the copy
   *     with a COPYUID response naming the new UID;
   *   - the expunge is "UID EXPUNGE <that uid>" via expungeOne().
   * Moving out of Trash (restoring) is allowed; see moveToTrash() for the
   * rule that nothing is ever removed from Trash itself.
   */
  async moveMessage(
    sourceMailbox: string,
    uid: number,
    destinationMailbox: string
  ): Promise<{ newUid?: number }> {
    assertUid(uid);
    if (sourceMailbox === destinationMailbox) {
      throw new Error("Source and destination mailbox are the same.");
    }
    const client = await this.ensureConnected();
    const hasMove = client.capabilities.has("MOVE");
    if (!hasMove && !client.capabilities.has("UIDPLUS")) {
      throw new Error(
        "IMAP server supports neither MOVE nor UIDPLUS; refusing to move."
      );
    }
    const lock = await client.getMailboxLock(sourceMailbox);
    try {
      if (hasMove) {
        const res = await client.messageMove(`${uid}`, destinationMailbox, {
          uid: true,
        });
        if (!res) {
          throw new Error(`Message UID ${uid} not found in ${sourceMailbox}`);
        }
        return { newUid: res.uidMap?.get(uid) };
      }

      const copy = await client.messageCopy(`${uid}`, destinationMailbox, {
        uid: true,
      });
      const newUid = copy && copy.uidMap ? copy.uidMap.get(uid) : undefined;
      if (!newUid) {
        throw new Error(
          `Copy of UID ${uid} to ${destinationMailbox} was not confirmed by the server; the original was left untouched.`
        );
      }
      await this.expungeOne(client, uid, () =>
        `Message was copied to ${destinationMailbox} (UID ${newUid}) but the original could not be removed from ${sourceMailbox}; it is now in both folders.`
      );
      return { newUid };
    } finally {
      lock.release();
    }
  }

  /**
   * "Delete" = move to Trash. Refuses for messages already in Trash:
   * nothing is ever removed from Trash itself.
   */
  async moveToTrash(
    mailbox: string,
    uid: number,
    trashFolder?: string
  ): Promise<string> {
    const trash = trashFolder ?? (await this.findTrashFolder());
    if (mailbox === trash) {
      throw new Error(
        `Message is already in ${trash}. Removing messages from Trash is not supported by this connector.`
      );
    }
    await this.moveMessage(mailbox, uid, trash);
    return trash;
  }

  async findTrashFolder(): Promise<string> {
    const client = await this.ensureConnected();
    const list = await client.list();
    const trash = list.find((m) => m.specialUse === "\\Trash");
    if (!trash) {
      throw new Error("No \\Trash folder found. Set mail.trashFolder in accounts.json.");
    }
    return trash.path;
  }

  /**
   * Replace a draft: APPEND the new version, then remove the old one.
   * The old message must live in the Drafts folder and carry \Draft, and
   * it is removed only after the server confirms the new draft's UID.
   */
  async replaceDraft(
    draftsFolder: string,
    oldUid: number,
    raw: Buffer
  ): Promise<number> {
    assertUid(oldUid);
    const client = await this.ensureConnected();
    if (!client.capabilities.has("UIDPLUS")) {
      throw new Error("IMAP server lacks UIDPLUS; refusing to replace drafts.");
    }
    const lock = await client.getMailboxLock(draftsFolder);
    try {
      const old = await client.fetchOne(`${oldUid}`, { flags: true }, { uid: true });
      if (!old) {
        throw new Error(`Draft UID ${oldUid} not found in ${draftsFolder}.`);
      }
      if (!old.flags || !old.flags.has("\\Draft")) {
        throw new Error(`UID ${oldUid} in ${draftsFolder} is not marked \\Draft; refusing to replace it.`);
      }
      const res = await client.append(draftsFolder, raw, ["\\Draft", "\\Seen"]);
      const newUid = res && typeof res.uid === "number" ? res.uid : undefined;
      if (!newUid) {
        throw new Error(
          "The new draft was saved but the server did not confirm its UID; the old draft was left in place."
        );
      }
      await this.expungeOne(client, oldUid, () =>
        `New draft saved (UID ${newUid}) but the old draft UID ${oldUid} could not be removed; both versions are in ${draftsFolder}.`
      );
      return newUid;
    } finally {
      lock.release();
    }
  }

  /**
   * The only place this connector removes a message from a folder:
   * \Deleted + "UID EXPUNGE <uid>" for exactly one UID, in the currently
   * selected (locked) mailbox. Callers invoke it only after the message
   * exists elsewhere (confirmed COPYUID) or has been superseded by a
   * confirmed newer draft. A plain EXPUNGE would also purge other \Deleted
   * messages, so without UIDPLUS this refuses.
   */
  private async expungeOne(
    client: ImapFlow,
    uid: number,
    failure: () => string
  ): Promise<void> {
    assertUid(uid);
    if (!client.capabilities.has("UIDPLUS")) {
      throw new Error("UIDPLUS missing; refusing to expunge.");
    }
    // With UIDPLUS and uid:true, imapflow sends "UID EXPUNGE <uid>".
    const removed = await client.messageDelete(`${uid}`, { uid: true });
    if (!removed) throw new Error(failure());
  }

  private async fetchRange(
    client: ImapFlow,
    range: string,
    byUid: boolean
  ): Promise<MessageSummary[]> {
    const fetched: FetchMessageObject[] = [];
    const fetchOpts = {
      envelope: true,
      flags: true,
      internalDate: true,
      size: true,
      bodyStructure: true,
    };
    for await (const msg of client.fetch(range, fetchOpts, { uid: byUid })) {
      fetched.push(msg);
    }
    const previews = await this.previewsFor(client, fetched);
    return fetched.map((msg) => ({ ...summarize(msg), preview: previews.get(msg.uid) ?? null }));
  }

  /**
   * Previews from each message's own text part. Commands can't be issued
   * while a FETCH is streaming, so this runs after the envelope fetch and
   * batches by part number: one FETCH for all messages whose text/plain
   * is part "1", one for part "1.1", and so on — a few round trips per
   * listing instead of one per message. Only the first few KB of each part
   * are fetched (BODY.PEEK, so nothing is marked read) and decoded here.
   * text/html is used when the plain part is missing or full of HTML
   * leftovers.
   */
  private async previewsFor(
    client: ImapFlow,
    messages: FetchMessageObject[]
  ): Promise<Map<number, string | null>> {
    const out = new Map<number, string | null>();
    const parts = new Map(messages.map((m) => [m.uid, textPartNodes(m.bodyStructure)]));
    try {
      const plain = await this.fetchParts(client, messages, (uid) => parts.get(uid)?.plain, PREVIEW_PLAIN_BYTES);
      const needHtml: FetchMessageObject[] = [];
      for (const m of messages) {
        const text = plain.get(m.uid);
        if (text !== undefined && text.trim() && !looksLikeHtmlJunk(text)) {
          out.set(m.uid, previewOf(stripLinks(text)));
        } else if (parts.get(m.uid)?.html) {
          needHtml.push(m);
        } else if (text !== undefined) {
          out.set(m.uid, previewOf(stripLinks(cleanJunkPlain(text))));
        }
      }
      const html = await this.fetchParts(client, needHtml, (uid) => parts.get(uid)?.html, PREVIEW_HTML_BYTES);
      for (const [uid, h] of html) out.set(uid, previewOf(stripLinks(htmlToPlain(h))));
    } catch {
      // Previews are best effort; the listing itself must not fail.
    }
    return out;
  }

  private async fetchParts(
    client: ImapFlow,
    messages: FetchMessageObject[],
    pick: (uid: number) => PartInfo | undefined,
    maxBytes: number
  ): Promise<Map<number, string>> {
    const groups = new Map<string, { info: Map<number, PartInfo>; uids: number[] }>();
    for (const m of messages) {
      const info = pick(m.uid);
      if (!info) continue;
      const g = groups.get(info.part) ?? { info: new Map<number, PartInfo>(), uids: [] as number[] };
      g.info.set(m.uid, info);
      g.uids.push(m.uid);
      groups.set(info.part, g);
    }
    const out = new Map<number, string>();
    for (const [part, g] of groups) {
      const query = { bodyParts: [{ key: part, start: 0, maxLength: maxBytes }] };
      for await (const msg of client.fetch(g.uids.join(","), query, { uid: true })) {
        const raw = partBuffer(msg.bodyParts, part);
        const info = g.info.get(msg.uid);
        if (raw && info) out.set(msg.uid, decodePart(raw, info));
      }
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
    preview: null,
  };
}

type StructureNode = NonNullable<FetchMessageObject["bodyStructure"]>;

export interface PartInfo {
  part: string;
  encoding: string;
  charset: string;
}

/** Part numbers of the first inline text/plain and text/html parts. */
export function textParts(root: StructureNode | undefined): { plain?: string; html?: string } {
  const n = textPartNodes(root);
  const out: { plain?: string; html?: string } = {};
  if (n.plain) out.plain = n.plain.part;
  if (n.html) out.html = n.html.part;
  return out;
}

/**
 * First inline text/plain and text/html parts with their transfer encoding
 * and charset, skipping attachments and attached messages. A single-part
 * message is part "1".
 */
export function textPartNodes(root: StructureNode | undefined): { plain?: PartInfo; html?: PartInfo } {
  const found: { plain?: PartInfo; html?: PartInfo } = {};
  const visit = (node: StructureNode, inMessage: boolean): void => {
    const type = (node.type || "").toLowerCase();
    if (node.childNodes && node.childNodes.length) {
      if (type === "message/rfc822") return;
      for (const child of node.childNodes) visit(child, inMessage);
      return;
    }
    if (inMessage || (node.disposition || "").toLowerCase() === "attachment") return;
    const info: PartInfo = {
      part: node.part || "1",
      encoding: (node.encoding || "7bit").toLowerCase(),
      charset: (node.parameters?.charset || "utf-8").toLowerCase(),
    };
    if (type === "text/plain" && !found.plain) found.plain = info;
    if (type === "text/html" && !found.html) found.html = info;
  };
  if (root) visit(root, false);
  return found;
}

function assertUid(uid: number): void {
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new Error("uid must be a positive integer");
  }
}

/** imapflow keys partial parts like "1]<0>"; find the buffer for `part`. */
function partBuffer(parts: Map<string, Buffer> | undefined, part: string): Buffer | undefined {
  if (!parts) return undefined;
  const want = part.toLowerCase();
  for (const [key, value] of parts) {
    if (key.toLowerCase().replace(/\].*$/, "") === want) return value;
  }
  return undefined;
}

/**
 * Decode a (possibly truncated) raw MIME part: transfer encoding, then
 * charset. Incomplete trailing sequences from the byte cap are dropped.
 */
export function decodePart(raw: Buffer, info: Pick<PartInfo, "encoding" | "charset">): string {
  let bytes: Buffer;
  if (info.encoding === "base64") {
    const b64 = raw.toString("latin1").replace(/[^A-Za-z0-9+/]/g, "");
    bytes = Buffer.from(b64.slice(0, b64.length - (b64.length % 4)), "base64");
  } else if (info.encoding === "quoted-printable") {
    bytes = libqp.decode(raw.toString("latin1").replace(/=[0-9A-F]?$/i, ""));
  } else {
    bytes = raw;
  }
  try {
    return new TextDecoder(info.charset || "utf-8").decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}
