/**
 * Mail tool registry.
 *
 * v0.2: every tool accepts an optional `account` parameter selecting which
 * configured mailbox to act on. Omitted = the default account. The pool
 * lazy-instantiates IMAP/SMTP clients per account.
 *
 * This fork has no send tool and no SMTP code: the connector can read,
 * search, flag and write drafts (IMAP APPEND). Nothing here can send,
 * move or delete a message.
 *
 * Every tool carries MCP annotations so clients can auto-approve reads.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ClientPool } from "./client-pool.js";
import { AccountsStore } from "./accounts.js";
import { buildDraftSource } from "./draft-composer.js";

function asJson(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

const recipientSchema = z.union([z.string(), z.array(z.string()).min(1)]);

const accountSchema = z
  .string()
  .optional()
  .describe(
    "Account ID (from list_accounts) to act on. Omit to use the default account."
  );

export function registerMailTools(
  server: McpServer,
  pool: ClientPool,
  store: AccountsStore
): void {
  server.registerTool(
    "list_accounts",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "List all configured mailbox accounts on this connector. Returns id, label, default flag and address — never credentials. Use the `id` value as the `account` parameter on other tools.",
      inputSchema: {},
    },
    async () => {
      const summaries = store.publicSummaries();
      return asJson({
        count: summaries.length,
        accounts: summaries,
        note:
          summaries.length === 0
            ? "No accounts configured yet. The operator has to fill in accounts.json on the server."
            : undefined,
      });
    }
  );

  server.registerTool(
    "list_folders",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "List all IMAP mailboxes (folders) on the configured account. Returns path, name, flags and special-use attribute (e.g. \\Sent, \\Drafts, \\Trash) — useful for picking the right `mailbox` parameter for other tools.",
      inputSchema: {
        account: accountSchema,
      },
    },
    async ({ account }) => {
      const { imap } = pool.for(account);
      return asJson(await imap.listMailboxes());
    }
  );

  server.registerTool(
    "list_messages",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "List the newest messages in a mailbox (newest first). Returns headers + a short preview, NOT the full body — use get_message for the body.",
      inputSchema: {
        mailbox: z
          .string()
          .describe("IMAP folder path (e.g. 'INBOX', 'Sent', 'Archive/2026')"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max messages to return (default 25)"),
        unread_only: z
          .boolean()
          .optional()
          .describe("Return only unread messages"),
        account: accountSchema,
      },
    },
    async ({ mailbox, limit, unread_only, account }) => {
      const { imap } = pool.for(account);
      const list = await imap.listMessages(mailbox, {
        limit,
        unreadOnly: unread_only,
      });
      return asJson({ mailbox, account: account ?? "(default)", count: list.length, messages: list });
    }
  );

  server.registerTool(
    "search_messages",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Server-side IMAP SEARCH across one mailbox. Combine any criteria (AND-style). Dates must be ISO YYYY-MM-DD. Returns headers + short preview — use get_message for the body.",
      inputSchema: {
        mailbox: z.string().describe("IMAP folder path to search in"),
        from: z.string().optional().describe("Substring match in From: header"),
        to: z.string().optional().describe("Substring match in To: header"),
        subject: z.string().optional().describe("Substring match in Subject:"),
        body: z
          .string()
          .optional()
          .describe("Substring match in the message body"),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Match messages on/after this date (YYYY-MM-DD)"),
        before: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Match messages strictly before this date (YYYY-MM-DD)"),
        unread: z
          .boolean()
          .optional()
          .describe("true = unread only, false = read only"),
        flagged: z
          .boolean()
          .optional()
          .describe("true = flagged only, false = unflagged only"),
        limit: z.number().int().min(1).max(200).optional(),
        account: accountSchema,
      },
    },
    async ({ mailbox, limit, account, ...criteria }) => {
      const { imap } = pool.for(account);
      const list = await imap.searchMessages(mailbox, criteria, limit ?? 25);
      return asJson({ mailbox, account: account ?? "(default)", count: list.length, messages: list });
    }
  );

  server.registerTool(
    "get_message",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Fetch one message by UID. Returns headers, full text+HTML body, attachment metadata (filenames + content types, NOT raw bytes), and threading IDs (Message-ID, In-Reply-To, References) for replies.",
      inputSchema: {
        mailbox: z.string().describe("IMAP folder the message lives in"),
        uid: z
          .number()
          .int()
          .positive()
          .describe("Message UID as returned by list_messages/search_messages"),
        account: accountSchema,
      },
    },
    async ({ mailbox, uid, account }) => {
      const { imap } = pool.for(account);
      return asJson(await imap.getMessage(mailbox, uid));
    }
  );

  server.registerTool(
    "create_draft",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Build an RFC-822 message and APPEND it to the Drafts folder. This connector cannot send mail — the user reviews and sends the draft from their own mail client. For replies, pass in_reply_to + references from the original get_message result.",
      inputSchema: {
        to: recipientSchema,
        subject: z.string().min(1),
        text: z.string().optional(),
        html: z.string().optional(),
        cc: recipientSchema.optional(),
        bcc: recipientSchema.optional(),
        in_reply_to: z.string().optional(),
        references: z.array(z.string()).optional(),
        account: accountSchema,
      },
    },
    async (args) => {
      if (!args.text && !args.html) {
        throw new Error("Provide at least one of `text` or `html`.");
      }
      const { imap, sender, draftsFolder } = pool.for(args.account);
      const raw = await buildDraftSource(sender, {
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        text: args.text,
        html: args.html,
        inReplyTo: args.in_reply_to,
        references: args.references,
      });
      await imap.append(draftsFolder, raw, ["\\Draft", "\\Seen"]);
      return asJson({
        success: true,
        folder: draftsFolder,
        bytes: raw.length,
      });
    }
  );

  server.registerTool(
    "mark_read",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Set or clear the \\Seen flag on a message. WRITE OPERATION but easily reversible.",
      inputSchema: {
        mailbox: z.string(),
        uid: z.number().int().positive(),
        read: z.boolean().describe("true = mark as read, false = mark unread"),
        account: accountSchema,
      },
    },
    async ({ mailbox, uid, read, account }) => {
      const { imap } = pool.for(account);
      await imap.markRead(mailbox, uid, read);
      return asJson({ success: true, mailbox, uid, read });
    }
  );

  server.registerTool(
    "set_flagged",
    {
      description:
        "Set or clear the \\Flagged flag (the flag/star in Mail) on a message. WRITE OPERATION but easily reversible.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        mailbox: z.string(),
        uid: z.number().int().positive(),
        flagged: z.boolean().describe("true = flag, false = unflag"),
        account: accountSchema,
      },
    },
    async ({ mailbox, uid, flagged, account }) => {
      const { imap } = pool.for(account);
      await imap.markFlagged(mailbox, uid, flagged);
      return asJson({ success: true, mailbox, uid, flagged });
    }
  );

}
