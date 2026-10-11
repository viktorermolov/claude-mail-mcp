/**
 * Builds RFC 5322 message source for drafts.
 *
 * Uses nodemailer's MailComposer only — no transport is ever created, so
 * nothing here can talk to an SMTP server. The result is APPENDed to the
 * Drafts folder over IMAP and the user sends it from their own mail client.
 */

import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";

export interface DraftSender {
  from: string;
  fromName?: string;
}

export interface DraftMessage {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
}

export async function buildDraftSource(
  sender: DraftSender,
  msg: DraftMessage
): Promise<Buffer> {
  const from = sender.fromName
    ? `"${sender.fromName.replace(/"/g, '\\"')}" <${sender.from}>`
    : sender.from;
  const opts: Mail.Options = {
    from,
    to: msg.to,
    subject: msg.subject,
    // Never resolve remote resources while composing.
    disableUrlAccess: true,
    disableFileAccess: true,
  };
  if (msg.cc) opts.cc = msg.cc;
  // MailComposer drops Bcc from the headers by default; keep it so the
  // recipients survive in the draft (the mail client strips it on send).
  if (msg.bcc) opts.bcc = msg.bcc;
  if (msg.text) opts.text = msg.text;
  if (msg.html) opts.html = msg.html;
  if (msg.inReplyTo) opts.inReplyTo = msg.inReplyTo;
  if (msg.references) opts.references = msg.references;

  const node = new MailComposer(opts).compile();
  node.keepBcc = true;
  return await new Promise<Buffer>((resolve, reject) => {
    node.build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}
