/**
 * @fileoverview Composes outgoing messages, sends them over SMTP and stores
 * copies in the Sent or Drafts folder.
 */

// nodemailer only provides default exports.
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import type {Account} from './config.js';
import {appendToSpecial} from './mailbox.js';
import type {Recipient} from './recipients.js';

export interface OutgoingAttachment {
  filename: string;
  contentBase64: string;
  contentType?: string;
}

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: OutgoingAttachment[];
  /** Pre-parsed attachments (e.g. carried over when forwarding). */
  rawAttachments?: Mail.Attachment[];
}

/** A message whose recipients were parsed and checked by the guardrails; only these are delivered to. */
export interface SendableMessage extends Omit<
  OutgoingMessage,
  'to' | 'cc' | 'bcc'
> {
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
}

type AnyMessage = OutgoingMessage | SendableMessage;

function fromHeader(account: Account): Mail.Address | string {
  return account.displayName
    ? {name: account.displayName, address: account.email}
    : account.email;
}

function toMailOptions(account: Account, msg: AnyMessage): Mail.Options {
  return {
    from: fromHeader(account),
    to: msg.to,
    cc: msg.cc,
    bcc: msg.bcc,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    inReplyTo: msg.inReplyTo,
    references: msg.references,
    attachments: [
      ...(msg.attachments ?? []).map(a => ({
        filename: a.filename,
        content: Buffer.from(a.contentBase64, 'base64'),
        contentType: a.contentType,
      })),
      ...(msg.rawAttachments ?? []),
    ],
  };
}

/** Build the RFC 822 message once so the exact same bytes are sent and saved to Sent/Drafts. */
export async function buildRawMessage(
  account: Account,
  msg: AnyMessage
): Promise<Buffer> {
  const options = toMailOptions(account, msg);
  // Keep Bcc in the stored copy so the sender can see who was bcc'd; SMTP envelope controls delivery.
  // MimeNode supports `keepBcc` at runtime but @types/nodemailer does not declare it.
  const composer = new MailComposer(options);
  const node = composer.compile() as ReturnType<MailComposer['compile']> & {
    keepBcc?: boolean;
  };
  node.keepBcc = true;
  return node.build();
}

export async function sendMessage(account: Account, msg: SendableMessage) {
  const recipients = [...msg.to, ...msg.cc, ...msg.bcc].map(r => r.address);
  if (recipients.length === 0) {
    throw new Error('At least one recipient is required');
  }
  if (!msg.text && !msg.html) throw new Error('Provide a text or html body');

  const transporter = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    requireTLS: !account.smtp.secure,
    auth: {user: account.smtp.user, pass: account.smtp.password},
    tls: {rejectUnauthorized: account.tlsRejectUnauthorized},
  });

  const raw = await buildRawMessage(account, msg);
  let info;
  try {
    info = await transporter.sendMail({
      envelope: {from: account.email, to: recipients},
      raw,
    });
  } finally {
    transporter.close();
  }

  let savedTo: string | null = null;
  let saveError: string | null = null;
  if (account.saveToSent) {
    try {
      savedTo = await appendToSpecial(account, '\\Sent', raw, ['\\Seen']);
    } catch (err: unknown) {
      saveError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    savedTo,
    saveError,
  };
}

export async function saveDraft(account: Account, msg: OutgoingMessage) {
  const raw = await buildRawMessage(account, msg);
  const folder = await appendToSpecial(account, '\\Drafts', raw, [
    '\\Draft',
    '\\Seen',
  ]);
  return {folder};
}
