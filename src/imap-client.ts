/**
 * IMAP client wrapper around imapflow.
 *
 * Holds a single long-lived connection that reconnects on demand. Each
 * operation acquires a mailbox lock so concurrent tool calls don't collide
 * on the IMAP `SELECT` state, and runs under a deadline: a stalled server
 * fails the call (and drops the connection) instead of blocking every
 * other tool for minutes.
 *
 * Read paths open the mailbox with EXAMINE (read-only) and fetch with
 * BODY.PEEK, so listing or reading never changes flags. Write paths are
 * flag changes (\Seen, \Flagged), APPEND (drafts) and moves. The only
 * removal is expungeOne(): UID EXPUNGE of a single message after its
 * copy in another folder has been confirmed by COPYUID. There is no plain
 * EXPUNGE, no CLOSE, and no way to remove a message from Trash.
 *
 * Tool handlers stay thin: they call high-level methods here, get back
 * plain JSON-shaped objects, and don't see imapflow internals.
 */

import { ImapFlow, ImapFlowOptions, FetchMessageObject, ListResponse } from "imapflow";
import { simpleParser, ParsedMail, AddressObject } from "mailparser";
import libqp from "libqp";
import {
  readableBody,
  previewOf,
  stripLinks,
  looksLikeHtmlJunk,
  htmlToPlain,
  cleanJunkPlain,
  PREVIEW_HTML_TAGS,
  type BodySource,
} from "./body-text.js";

/** Byte caps for the raw text part fetched to build a preview. */
const PREVIEW_PLAIN_BYTES = 8 * 1024;
const PREVIEW_HTML_BYTES = 96 * 1024;
/** Messages larger than this are read part by part instead of whole. */
const FULL_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
/** Per text part cap for large messages. */
const LARGE_TEXT_PART_BYTES = 2 * 1024 * 1024;

/**
 * Deadlines. Every public operation must finish well inside Cloudflare's
 * ~100 s edge timeout; a stalled connection is dropped so queued calls
 * fail fast and the next call reconnects.
 */
export const IMAP_TIMEOUTS = {
  operationMs: 60_000,
  lockMs: 30_000,
  socketMs: 60_000,
  connectMs: 30_000,
  /** Reconnect back-off after a failed connect: base, doubling, capped. */
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
};

export type ImapLogger = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
) => void;

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
  /** True when the message was too large to read whole, or its text was longer than the input cap. */
  partial: boolean;
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
  since?: string; // YYYY-MM-DD, validated by the tool schema
  before?: string; // YYYY-MM-DD
  unread?: boolean;
  flagged?: boolean;
}

/** A write was refused or failed before anything changed on the server. */
export class NothingChangedError extends Error {}

export class ImapTimeoutError extends Error {
  constructor(operation: string, ms: number, started: boolean) {
    super(
      started
        ? `IMAP ${operation} did not finish within ${Math.round(ms / 1000)} s; the connection was reset. ` +
            `For writes the outcome is unknown — check the folders before retrying.`
        : `IMAP ${operation} could not start within ${Math.round(ms / 1000)} s (the mail server did not answer in time); nothing was changed.`
    );
    this.name = "ImapTimeoutError";
  }
}

/** Operations still running on any client, including ones past their deadline (for the shutdown drain). */
let runningOperations = 0;
export function runningImapOperations(): number {
  return runningOperations;
}

export class ImapClient {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private closed = false;
  private active = 0;
  private failures = 0;
  private retryAt = 0;
  private lastConnectError = "";
  private readonly opts: ImapFlowOptions;
  private readonly log: ImapLogger;
  private readonly accountId: string;

  constructor(auth: ImapAuth, opts: { log?: ImapLogger; accountId?: string } = {}) {
    this.opts = {
      host: auth.host,
      port: auth.port,
      secure: auth.secure,
      auth: { user: auth.user, pass: auth.pass },
      logger: false,
      socketTimeout: IMAP_TIMEOUTS.socketMs,
      connectionTimeout: IMAP_TIMEOUTS.connectMs,
    };
    this.log = opts.log ?? (() => {});
    this.accountId = opts.accountId ?? "default";
  }

  /**
   * Return a usable connection, connecting if needed. A failed attempt is
   * never cached: the next call after a short back-off opens a new one.
   */
  private ensureConnected(): Promise<ImapFlow> {
    if (this.closed) return Promise.reject(new Error("IMAP client was closed (account settings changed); retry the call."));
    if (this.client && this.client.usable) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    const wait = this.retryAt - Date.now();
    if (wait > 0) {
      return Promise.reject(
        new Error(`Cannot reach the mail server (${this.lastConnectError}); next attempt in ${Math.ceil(wait / 1000)} s.`)
      );
    }

    const attempt = (async (): Promise<ImapFlow> => {
      const client = new ImapFlow(this.opts);
      const drop = (): void => {
        if (this.client === client) this.client = null;
      };
      client.on("error", (err: Error) => {
        drop();
        const code = errorCode(err);
        // The socket timeout also fires on an idle connection with no
        // mailbox selected; that is routine, not a failure.
        const idle = code === "ETIMEOUT" && this.active === 0;
        this.log(idle ? "debug" : "warn", idle ? "idle imap connection closed" : "imap connection error", {
          account: this.accountId,
          code,
        });
      });
      client.on("close", drop);
      try {
        await client.connect();
      } catch (err) {
        try {
          client.close();
        } catch {
          // already closed
        }
        throw err;
      }
      if (this.closed) {
        await client.logout().catch(() => client.close());
        throw new Error("IMAP client was closed while connecting; retry the call.");
      }
      this.client = client;
      return client;
    })();

    this.connecting = attempt;
    attempt.then(
      () => {
        if (this.failures > 0) this.log("info", "imap reconnected", { account: this.accountId });
        this.failures = 0;
        this.retryAt = 0;
      },
      (err: unknown) => {
        this.failures++;
        this.lastConnectError = errorCode(err);
        const delay = Math.min(
          IMAP_TIMEOUTS.backoffMaxMs,
          IMAP_TIMEOUTS.backoffBaseMs * 2 ** (this.failures - 1)
        );
        this.retryAt = Date.now() + delay;
        this.log("warn", "imap connect failed", {
          account: this.accountId,
          code: this.lastConnectError,
          failures: this.failures,
          retry_in_ms: delay,
        });
      }
    );
    attempt.finally(() => {
      if (this.connecting === attempt) this.connecting = null;
    }).catch(() => {});
    return attempt;
  }

  /** Close for good (pool reset or shutdown). Never issues CLOSE/EXPUNGE. */
  async close(): Promise<void> {
    this.closed = true;
    const pending = this.connecting;
    if (pending) await pending.catch(() => {});
    const c = this.client;
    this.client = null;
    if (c) {
      try {
        await c.logout();
      } catch {
        c.close();
      }
    }
  }

  /** Drop the current connection without LOGOUT (used on deadline expiry). */
  private dropConnection(): void {
    const c = this.client;
    this.client = null;
    if (c) {
      try {
        c.close();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Run `fn` with a connection under the operation deadline. On expiry the
   * `expired` signal is aborted and the connection is dropped: imapflow
   * rejects everything still queued on it, a call still waiting for the
   * connection never starts, and write paths check the signal before their
   * first change. Write paths are safe to interrupt at any point — the
   * original is only touched after its copy is confirmed.
   */
  private async withConnection<T>(
    operation: string,
    fn: (client: ImapFlow, expired: AbortSignal) => Promise<T>
  ): Promise<T> {
    const ms = IMAP_TIMEOUTS.operationMs;
    const expiry = new AbortController();
    let started = false;
    let timer: NodeJS.Timeout | undefined;
    this.active++;
    runningOperations++;
    const work = (async () => {
      const client = await this.ensureConnected();
      if (expiry.signal.aborted) throw new ImapTimeoutError(operation, ms, false);
      started = true;
      return fn(client, expiry.signal);
    })();
    void work
      .catch(() => {})
      .finally(() => {
        this.active--;
        runningOperations--;
      });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expiry.abort();
        this.log("warn", "imap operation timed out", { account: this.accountId, operation, ms, started });
        if (started) this.dropConnection();
        reject(new ImapTimeoutError(operation, ms, started));
      }, ms);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private lock(client: ImapFlow, path: string, readOnly: boolean) {
    return client.getMailboxLock(path, { readOnly, acquireTimeout: IMAP_TIMEOUTS.lockMs });
  }

  async listMailboxes(): Promise<MailboxSummary[]> {
    return this.withConnection("LIST", async (client) => {
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
    });
  }

  async listMessages(
    mailbox: string,
    opts: { limit?: number; unreadOnly?: boolean } = {}
  ): Promise<MessageSummary[]> {
    return this.withConnection("list", async (client) => {
      const lock = await this.lock(client, mailbox, true);
      try {
        const box = client.mailbox;
        const total = box && typeof box === "object" ? box.exists : 0;
        if (!total) return [];
        const limit = Math.min(opts.limit ?? 25, 200);
        if (opts.unreadOnly) {
          const found = await client.search({ seen: false }, { uid: true });
          if (!Array.isArray(found)) throw new Error(`IMAP SEARCH failed in ${mailbox}.`);
          const uids = found.slice(-limit).reverse();
          if (uids.length === 0) return [];
          return sortNewestFirst(await this.fetchRange(client, uids.join(","), true));
        }
        // Newest `limit` by sequence number.
        const from = Math.max(1, total - limit + 1);
        return sortNewestFirst(await this.fetchRange(client, `${from}:*`, false));
      } finally {
        lock.release();
      }
    });
  }

  async searchMessages(
    mailbox: string,
    criteria: SearchCriteria,
    limit = 25
  ): Promise<MessageSummary[]> {
    return this.withConnection("search", async (client) => {
      const lock = await this.lock(client, mailbox, true);
      try {
        const query: Record<string, unknown> = {};
        if (criteria.from) query.from = criteria.from;
        if (criteria.to) query.to = criteria.to;
        if (criteria.subject) query.subject = criteria.subject;
        if (criteria.body) query.body = criteria.body;
        if (criteria.since) query.since = strictDate(criteria.since);
        if (criteria.before) query.before = strictDate(criteria.before);
        if (criteria.unread === true) query.seen = false;
        if (criteria.unread === false) query.seen = true;
        if (criteria.flagged === true) query.flagged = true;
        if (criteria.flagged === false) query.unflagged = true;

        const found = await client.search(query, { uid: true });
        // imapflow returns false when the server answers NO/BAD; that is an
        // error, not "no messages".
        if (!Array.isArray(found)) throw new Error(`IMAP SEARCH failed in ${mailbox}.`);
        if (found.length === 0) return [];
        const slice = found.slice(-Math.min(limit, 200)).reverse();
        return sortNewestFirst(await this.fetchRange(client, slice.join(","), true));
      } finally {
        lock.release();
      }
    });
  }

  async getMessage(mailbox: string, uid: number): Promise<MessageDetail> {
    assertUid(uid);
    return this.withConnection("fetch", async (client) => {
      const lock = await this.lock(client, mailbox, true);
      try {
        const head = await client.fetchOne(
          `${uid}`,
          { envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true },
          { uid: true }
        );
        if (!head) throw new Error(`Message UID ${uid} not found in ${mailbox}`);
        const size = (head.size as number | undefined) ?? 0;
        if (size <= FULL_SOURCE_MAX_BYTES) {
          const msg = await client.fetchOne(`${uid}`, { source: true }, { uid: true });
          if (!msg || !msg.source) throw new Error(`Message UID ${uid} not found in ${mailbox}`);
          const parsed: ParsedMail = await simpleParser(msg.source as Buffer, {
            // We convert HTML ourselves (bounded); mailparser's own
            // conversion has no depth limit and inlines cid images.
            skipHtmlToText: true,
            skipTextToHtml: true,
            skipImageLinks: true,
            keepCidLinks: true,
          });
          return detailFromParsed(head, parsed, false);
        }
        return await this.largeMessageDetail(client, head);
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Messages above FULL_SOURCE_MAX_BYTES (usually big attachments): read
   * only the text parts, capped, and list attachments from BODYSTRUCTURE,
   * so a 30 MB mail can't exhaust the container's memory.
   */
  private async largeMessageDetail(client: ImapFlow, head: FetchMessageObject): Promise<MessageDetail> {
    const parts = textPartNodes(head.bodyStructure);
    const text = await this.fetchParts(client, [head], () => parts.plain, LARGE_TEXT_PART_BYTES);
    const html = await this.fetchParts(client, [head], () => parts.html, LARGE_TEXT_PART_BYTES);
    const refs = await client.fetchOne(`${head.uid}`, { headers: ["references"] }, { uid: true });
    const refHeader = refs && refs.headers ? refs.headers.toString("utf8").replace(/^references:\s*/i, "") : "";
    const body = readableBody({ text: text.get(head.uid) ?? null, html: html.get(head.uid) ?? null });
    const env = head.envelope;
    return {
      ...summarize(head),
      date: (head.internalDate as Date | undefined)?.toISOString() ?? safeIsoDate(env?.date),
      preview: previewOf(stripLinks(body.text)),
      messageId: env?.messageId ?? null,
      inReplyTo: env?.inReplyTo ?? null,
      references: refHeader.match(/<[^<>\s]+>/g) ?? [],
      text: body.text,
      textSource: body.source,
      html: html.get(head.uid) ?? null,
      partial: true,
      attachments: attachmentsFromStructure(head.bodyStructure),
    };
  }

  async markRead(mailbox: string, uid: number, read: boolean, signal?: AbortSignal): Promise<void> {
    await this.setFlag(mailbox, uid, "\\Seen", read, signal);
  }

  async markFlagged(mailbox: string, uid: number, flagged: boolean, signal?: AbortSignal): Promise<void> {
    await this.setFlag(mailbox, uid, "\\Flagged", flagged, signal);
  }

  private async setFlag(
    mailbox: string,
    uid: number,
    flag: "\\Seen" | "\\Flagged",
    on: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    assertUid(uid);
    await this.withConnection("STORE", async (client, expired) => {
      const lock = await this.lock(client, mailbox, false);
      try {
        // STORE on a missing UID is still "OK" on the wire.
        const msg = await client.fetchOne(`${uid}`, { flags: true }, { uid: true });
        if (!msg) throw new NothingChangedError(`Message UID ${uid} not found in ${mailbox}.`);
        checkNotAborted(signal, expired);
        const ok = on
          ? await client.messageFlagsAdd(`${uid}`, [flag], { uid: true })
          : await client.messageFlagsRemove(`${uid}`, [flag], { uid: true });
        if (!ok) throw new Error(`Could not update ${flag} on UID ${uid} in ${mailbox}.`);
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Append a raw RFC 822 message to the Drafts folder. Returns the new
   * message's UID when the server reports it (APPENDUID).
   */
  async appendDraft(draftsFolder: string, raw: Buffer, signal?: AbortSignal): Promise<number | undefined> {
    return this.withConnection("APPEND", async (client, expired) => {
      const folders = await this.folders(client);
      const drafts = resolveMailbox(folders, draftsFolder);
      // imapflow keeps only the APPEND flags the *selected* mailbox lists in
      // PERMANENTFLAGS; after a read that is an EXAMINEd folder answering
      // "PERMANENTFLAGS ()", which would drop \Draft and \Seen. Selecting
      // Drafts read-write first makes them stick.
      const lock = await this.lock(client, drafts, false);
      try {
        checkNotAborted(signal, expired);
        const res = await client.append(drafts, raw, ["\\Draft", "\\Seen"]);
        if (!res) throw new Error(`Saving the draft to ${drafts} failed.`);
        return typeof res.uid === "number" ? res.uid : undefined;
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Move one message to another folder.
   *
   * With IMAP MOVE (RFC 6851) this is one atomic command. iCloud has no
   * MOVE, so otherwise we run the sequence RFC 6851 §3.3 defines MOVE to be
   * equivalent to — UID COPY, then \Deleted + UID EXPUNGE on the original —
   * with these guards:
   *   - both folder names must match the server's LIST exactly (INBOX in
   *     any case), so name variants can't slip past the guards below;
   *   - UIDPLUS is required (otherwise refuse before touching anything);
   *   - the original is touched only after the server confirms the copy
   *     with a COPYUID response naming the new UID;
   *   - the removal is "UID EXPUNGE <that uid>" via expungeOne().
   * Moving out of Trash (restoring) is allowed; see moveToTrash() for the
   * rule that nothing is ever removed from Trash itself.
   */
  async moveMessage(
    sourceMailbox: string,
    uid: number,
    destinationMailbox: string,
    signal?: AbortSignal
  ): Promise<{ newUid?: number; destination: string }> {
    assertUid(uid);
    return this.withConnection("move", async (client, expired) => {
      const folders = await this.folders(client);
      const source = resolveMailbox(folders, sourceMailbox);
      const destination = resolveMailbox(folders, destinationMailbox);
      if (source === destination) {
        throw new NothingChangedError(`Source and destination are the same folder (${source}).`);
      }
      const newUid = await this.moveLocked(client, source, uid, destination, anySignal(signal, expired));
      return { newUid, destination };
    });
  }

  /**
   * "Delete" = move to Trash. Refuses for messages already in Trash:
   * nothing is ever removed from Trash itself.
   */
  async moveToTrash(
    mailbox: string,
    uid: number,
    trashFolder?: string,
    signal?: AbortSignal
  ): Promise<string> {
    assertUid(uid);
    return this.withConnection("trash", async (client, expired) => {
      const folders = await this.folders(client);
      const source = resolveMailbox(folders, mailbox);
      const trash = trashPath(folders, trashFolder);
      if (source === trash) {
        throw new NothingChangedError(
          `Message is already in ${trash}. Removing messages from Trash is not supported by this connector.`
        );
      }
      await this.moveLocked(client, source, uid, trash, anySignal(signal, expired));
      return trash;
    });
  }

  async findTrashFolder(trashFolder?: string): Promise<string> {
    return this.withConnection("LIST", async (client) => trashPath(await this.folders(client), trashFolder));
  }

  /**
   * Replace a draft: APPEND the new version to Drafts, then move the old
   * version to Trash (so every edit stays recoverable). The old message
   * must be in Drafts and carry \Draft. Nothing happens to the old version
   * unless the server confirmed the new draft's UID (APPENDUID) and then
   * the old version's copy in Trash (COPYUID).
   */
  async replaceDraft(
    draftsFolder: string,
    oldUid: number,
    raw: Buffer,
    trashFolder?: string,
    signal?: AbortSignal
  ): Promise<{ newUid: number; oldMovedTo: string }> {
    assertUid(oldUid);
    return this.withConnection("update draft", async (client, expired) => {
      if (!client.capabilities.has("UIDPLUS")) {
        throw new NothingChangedError("IMAP server lacks UIDPLUS; refusing to replace drafts.");
      }
      const folders = await this.folders(client);
      const drafts = resolveMailbox(folders, draftsFolder);
      const trash = trashPath(folders, trashFolder);
      if (drafts === trash) {
        throw new NothingChangedError(`Drafts and Trash are the same folder (${drafts}); refusing to replace drafts.`);
      }
      const lock = await this.lock(client, drafts, false);
      try {
        const old = await client.fetchOne(`${oldUid}`, { flags: true }, { uid: true });
        if (!old) throw new NothingChangedError(`Draft UID ${oldUid} not found in ${drafts}.`);
        if (!old.flags || !old.flags.has("\\Draft")) {
          throw new NothingChangedError(`UID ${oldUid} in ${drafts} is not marked \\Draft; refusing to replace it.`);
        }
        checkNotAborted(signal, expired);
        const res = await client.append(drafts, raw, ["\\Draft", "\\Seen"]);
        const newUid = res && typeof res.uid === "number" ? res.uid : undefined;
        if (!newUid) {
          throw new Error(
            "The new draft may have been saved but the server did not confirm its UID; the old draft was left in place."
          );
        }
        await this.copyThenRemove(client, drafts, oldUid, trash, (stage, copyUid) =>
          stage === "copy"
            ? `New draft saved (UID ${newUid}), but moving the old version (UID ${oldUid}) to ${trash} was not confirmed; it was left in ${drafts}.`
            : `New draft saved (UID ${newUid}) and the old version copied to ${trash} (UID ${copyUid}), but it could not be removed from ${drafts}; both versions are there.`
        );
        return { newUid, oldMovedTo: trash };
      } finally {
        lock.release();
      }
    });
  }

  /** Move inside an existing run(): lock the source and move one UID. */
  private async moveLocked(
    client: ImapFlow,
    source: string,
    uid: number,
    destination: string,
    signal?: AbortSignal
  ): Promise<number | undefined> {
    const hasMove = client.capabilities.has("MOVE");
    if (!hasMove && !client.capabilities.has("UIDPLUS")) {
      throw new NothingChangedError("IMAP server supports neither MOVE nor UIDPLUS; refusing to move.");
    }
    const lock = await this.lock(client, source, false);
    try {
      // COPY/MOVE/STORE of a missing UID still answer "OK"; check first.
      const msg = await client.fetchOne(`${uid}`, { flags: true }, { uid: true });
      if (!msg) throw new NothingChangedError(`Message UID ${uid} not found in ${source}.`);
      checkNotAborted(signal);
      if (hasMove) {
        // MOVE is atomic on the server: the message is in exactly one
        // folder whatever happens. Report success only once it is gone
        // from the source.
        const res = await client.messageMove(`${uid}`, destination, { uid: true });
        const still = await client.fetchOne(`${uid}`, { flags: true }, { uid: true });
        if (!res || still) throw new Error(`Moving UID ${uid} from ${source} to ${destination} was not confirmed; check both folders.`);
        return res.uidMap?.get(uid);
      }
      return await this.copyThenRemove(client, source, uid, destination, (stage, copyUid) =>
        stage === "copy"
          ? `Copy of UID ${uid} to ${destination} was not confirmed by the server. The original was left in ${source}; a copy may nevertheless exist in ${destination} — check before retrying.`
          : `Message was copied to ${destination} (UID ${copyUid}) but the original could not be removed from ${source}; it is now in both folders.`
      );
    } finally {
      lock.release();
    }
  }

  /**
   * UID COPY to `destination`, require COPYUID for this UID, then remove
   * the original with expungeOne(). The source mailbox must be locked
   * (selected read-write) by the caller.
   */
  private async copyThenRemove(
    client: ImapFlow,
    source: string,
    uid: number,
    destination: string,
    failure: (stage: "copy" | "remove", copyUid?: number) => string
  ): Promise<number> {
    // Callers check this before changing anything; reaching it means a bug,
    // and something may already have changed, so it is not "nothing changed".
    if (source === destination) throw new Error("Source and destination are the same folder.");
    const copy = await client.messageCopy(`${uid}`, destination, { uid: true });
    const copyUid = copy && copy.uidMap ? copy.uidMap.get(uid) : undefined;
    if (!copyUid) throw new Error(failure("copy"));
    await this.expungeOne(client, uid, () => failure("remove", copyUid));
    return copyUid;
  }

  /**
   * The only place this connector removes a message from a folder:
   * \Deleted + "UID EXPUNGE <uid>" for exactly one UID, in the currently
   * selected (locked) mailbox, called only after the message's copy in
   * another folder was confirmed. A plain EXPUNGE would also purge other
   * \Deleted messages, so without UIDPLUS this refuses. Success is
   * reported only after the UID is verifiably gone.
   */
  private async expungeOne(client: ImapFlow, uid: number, failure: () => string): Promise<void> {
    assertUid(uid);
    if (!client.capabilities.has("UIDPLUS")) {
      throw new Error("UIDPLUS missing; refusing to expunge.");
    }
    const flagged = await client.messageFlagsAdd(`${uid}`, ["\\Deleted"], { uid: true });
    if (!flagged) throw new Error(failure());
    // With UIDPLUS and uid:true, imapflow sends "UID EXPUNGE <uid>".
    const removed = await client.messageDelete(`${uid}`, { uid: true });
    if (!removed) throw new Error(failure());
    const still = await client.fetchOne(`${uid}`, { flags: true }, { uid: true });
    if (still) throw new Error(failure());
  }

  /** LIST, used to resolve folder names exactly. */
  private async folders(client: ImapFlow): Promise<ListResponse[]> {
    return client.list();
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
   * leftovers. One bad message never blanks the others.
   */
  private async previewsFor(
    client: ImapFlow,
    messages: FetchMessageObject[]
  ): Promise<Map<number, string | null>> {
    const out = new Map<number, string | null>();
    const parts = new Map(messages.map((m) => [m.uid, textPartNodes(m.bodyStructure)]));
    const safe = (uid: number, fn: () => string | null): void => {
      try {
        out.set(uid, fn());
      } catch {
        out.set(uid, null);
      }
    };
    let plain = new Map<number, string>();
    try {
      plain = await this.fetchParts(client, messages, (uid) => parts.get(uid)?.plain, PREVIEW_PLAIN_BYTES);
    } catch {
      // previews are best effort
    }
    const needHtml: FetchMessageObject[] = [];
    for (const m of messages) {
      const text = plain.get(m.uid);
      if (text !== undefined && text.trim() && !looksLikeHtmlJunk(text)) {
        safe(m.uid, () => previewOf(stripLinks(text)));
      } else if (parts.get(m.uid)?.html) {
        needHtml.push(m);
      } else if (text !== undefined) {
        safe(m.uid, () => previewOf(stripLinks(cleanJunkPlain(text))));
      }
    }
    let html = new Map<number, string>();
    try {
      html = await this.fetchParts(client, needHtml, (uid) => parts.get(uid)?.html, PREVIEW_HTML_BYTES);
    } catch {
      // previews are best effort
    }
    for (const [uid, h] of html) {
      safe(uid, () => previewOf(stripLinks(htmlToPlain(h, { maxTags: PREVIEW_HTML_TAGS }))));
      // Let other requests run between conversions of large HTML previews.
      await new Promise<void>((resolve) => setImmediate(resolve));
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

// ---- helpers ----------------------------------------------------------------

function errorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; authenticationFailed?: unknown; serverResponseCode?: unknown; name?: unknown };
    if (e.authenticationFailed) return "AUTHENTICATIONFAILED";
    if (typeof e.serverResponseCode === "string") return e.serverResponseCode;
    if (typeof e.code === "string") return e.code;
    if (typeof e.name === "string") return e.name;
  }
  return "unknown";
}

function checkNotAborted(...signals: Array<AbortSignal | undefined>): void {
  if (signals.some((s) => s?.aborted)) {
    throw new NothingChangedError("The request was cancelled or ran out of time before any change was made.");
  }
}

function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
}

/** Exact match against LIST (INBOX in any case). Refuses unknown or \Noselect names. */
export function resolveMailbox(folders: ListResponse[], name: string): string {
  if (name.toUpperCase() === "INBOX") {
    const inbox = folders.find((f) => f.path.toUpperCase() === "INBOX");
    if (inbox) return inbox.path;
  }
  const hit = folders.find((f) => f.path === name);
  if (!hit) {
    throw new NothingChangedError(`Folder "${name}" does not exist. Use list_folders for the exact names (they are case-sensitive).`);
  }
  if (hit.flags && hit.flags.has("\\Noselect")) {
    throw new NothingChangedError(`Folder "${name}" cannot hold messages.`);
  }
  return hit.path;
}

/** The Trash folder: configured name (must exist exactly) or the \Trash special-use folder. */
export function trashPath(folders: ListResponse[], configured?: string): string {
  if (configured) return resolveMailbox(folders, configured);
  const trash = folders.find((m) => m.specialUse === "\\Trash");
  if (!trash) throw new NothingChangedError("No \\Trash folder found. Set mail.trashFolder in accounts.json.");
  return trash.path;
}

function sortNewestFirst(list: MessageSummary[]): MessageSummary[] {
  return list.sort((a, b) => b.uid - a.uid);
}

/** YYYY-MM-DD that must round-trip exactly (the schema validates too). */
function strictDate(s: string): Date {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new Error(`Invalid date: ${s}`);
  }
  return d;
}

/** imapflow passes unparseable Date headers through as strings. */
export function safeIsoDate(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * RFC 5322 mailbox: display names are always quoted (with \ and " escaped),
 * so a name like `Boss, x@evil.example,` can't read as extra recipients.
 */
export function formatAddress(name: string | undefined | null, address: string | undefined | null): string | null {
  const n = (name ?? "").replace(/[\r\n]+/g, " ").trim();
  const a = (address ?? "").trim();
  if (n && a) return `"${n.replace(/[\\"]/g, "\\$&")}" <${a}>`;
  if (a) return a;
  if (n) return `"${n.replace(/[\\"]/g, "\\$&")}"`;
  return null;
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
      .map((a) => formatAddress(a?.name, a?.address))
      .filter((v): v is string => Boolean(v))
      .join(", ") || null
  );
}

function parsedAddresses(field: AddressObject | AddressObject[] | undefined): string | null {
  if (!field) return null;
  const objs = Array.isArray(field) ? field : [field];
  const flat: { name?: string; address?: string }[] = [];
  const walk = (v: { name?: string; address?: string; group?: unknown[] }): void => {
    if (Array.isArray(v.group)) v.group.forEach((g) => walk(g as typeof v));
    else flat.push(v);
  };
  objs.forEach((o) => o.value.forEach((v) => walk(v)));
  return addrText(flat);
}

function summarize(msg: FetchMessageObject): MessageSummary {
  const env = msg.envelope;
  return {
    uid: msg.uid as number,
    seq: msg.seq as number,
    flags: Array.from(msg.flags ?? []),
    date: safeIsoDate(env?.date),
    subject: env?.subject ?? null,
    from: addrText(env?.from),
    to: addrText(env?.to),
    cc: addrText(env?.cc),
    size: (msg.size as number | undefined) ?? null,
    preview: null,
  };
}

function detailFromParsed(head: FetchMessageObject, parsed: ParsedMail, partial: boolean): MessageDetail {
  const body = readableBody(parsed);
  return {
    uid: head.uid as number,
    seq: head.seq as number,
    flags: Array.from(head.flags ?? []),
    date: (head.internalDate as Date | undefined)?.toISOString() ?? null,
    subject: parsed.subject ?? null,
    from: parsedAddresses(parsed.from),
    to: parsedAddresses(parsed.to),
    cc: parsedAddresses(parsed.cc),
    size: (head.size as number | undefined) ?? null,
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
    partial: partial || body.capped,
    attachments: (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? null,
      contentType: a.contentType,
      size: a.size,
      contentId: a.cid ?? null,
    })),
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
  const visit = (node: StructureNode, depth: number): void => {
    if (depth > 32) return;
    const type = (node.type || "").toLowerCase();
    if (node.childNodes && node.childNodes.length) {
      if (type === "message/rfc822") return;
      for (const child of node.childNodes) visit(child, depth + 1);
      return;
    }
    if ((node.disposition || "").toLowerCase() === "attachment") return;
    const info: PartInfo = {
      part: node.part || "1",
      encoding: (node.encoding || "7bit").toLowerCase(),
      charset: (node.parameters?.charset || "utf-8").toLowerCase(),
    };
    if (type === "text/plain" && !found.plain) found.plain = info;
    if (type === "text/html" && !found.html) found.html = info;
  };
  if (root) visit(root, 0);
  return found;
}

function attachmentsFromStructure(root: StructureNode | undefined): MessageDetail["attachments"] {
  const out: MessageDetail["attachments"] = [];
  const visit = (node: StructureNode, depth: number): void => {
    if (depth > 32) return;
    const type = (node.type || "").toLowerCase();
    if (node.childNodes && node.childNodes.length && type !== "message/rfc822") {
      node.childNodes.forEach((c) => visit(c, depth + 1));
      return;
    }
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
    const isText = type === "text/plain" || type === "text/html";
    if ((node.disposition || "").toLowerCase() === "attachment" || filename || !isText) {
      out.push({ filename, contentType: type, size: node.size ?? 0, contentId: node.id ?? null });
    }
  };
  if (root) visit(root, 0);
  return out;
}

function assertUid(uid: number): void {
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new NothingChangedError("uid must be a positive integer");
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
    // Keep "=" padding so a complete part decodes fully; a part cut by the
    // byte cap loses only its incomplete last quantum.
    const b64 = raw.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, "");
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
