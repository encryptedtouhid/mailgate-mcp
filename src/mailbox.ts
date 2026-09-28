/**
 * @fileoverview IMAP operations: listing, searching, reading and organizing
 * messages. Each operation uses its own short-lived connection.
 */

import {
  ImapFlow,
  type FetchMessageObject,
  type MessageAddressObject,
} from 'imapflow';
import {simpleParser, type AddressObject, type ParsedMail} from 'mailparser';
import {convert as htmlToText} from 'html-to-text';
import type {Account} from './config.js';
import {encodeMessageId} from './ids.js';
import {buildSearchCriteria, pickNewest, type SearchParams} from './search.js';

const SPECIAL_FOLDERS = [
  '\\Sent',
  '\\Drafts',
  '\\Trash',
  '\\Junk',
  '\\Archive',
] as const;

export type SpecialFolder = (typeof SPECIAL_FOLDERS)[number];

function isSpecialFolder(value: string): value is SpecialFolder {
  return SPECIAL_FOLDERS.some(folder => folder === value);
}

export interface AttachmentInfo {
  index: number;
  filename: string;
  contentType: string;
  size: number;
}

export interface MessageSummary {
  id: string;
  uid: number;
  folder: string;
  subject: string;
  from: string;
  to: string;
  date: string | null;
  unread: boolean;
  flagged: boolean;
}

export interface MessageDetail extends MessageSummary {
  cc: string;
  replyTo: string;
  messageId: string | null;
  body: string;
  bodyTruncated: boolean;
  attachments: AttachmentInfo[];
}

function createClient(account: Account): ImapFlow {
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: {user: account.imap.user, pass: account.imap.password},
    tls: {rejectUnauthorized: account.tlsRejectUnauthorized},
    logger: false,
  });
}

/** One short-lived connection per operation: simple, and immune to idle timeouts between tool calls. */
async function withImap<T>(
  account: Account,
  fn: (client: ImapFlow) => Promise<T>
): Promise<T> {
  const client = createClient(account);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function withFolder<T>(
  account: Account,
  folder: string,
  fn: (client: ImapFlow) => Promise<T>,
  readOnly = false
): Promise<T> {
  return withImap(account, async client => {
    const lock = await client.getMailboxLock(folder, {readOnly});
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  });
}

function formatAddresses(list: MessageAddressObject[] | undefined): string {
  return (list ?? [])
    .map(a => (a.name ? `${a.name} <${a.address}>` : (a.address ?? '')))
    .join(', ');
}

function asList<T>(value: T | T[] | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function parsedAddresses(
  value: AddressObject | AddressObject[] | undefined
): string {
  return asList(value)
    .map(v => v.text)
    .join(', ');
}

function toSummary(
  account: Account,
  folder: string,
  msg: FetchMessageObject
): MessageSummary {
  const flags = msg.flags ?? new Set<string>();
  const date = msg.envelope?.date ?? msg.internalDate;
  return {
    id: encodeMessageId({accountId: account.id, folder, uid: msg.uid}),
    uid: msg.uid,
    folder,
    subject: msg.envelope?.subject ?? '(no subject)',
    from: formatAddresses(msg.envelope?.from),
    to: formatAddresses(msg.envelope?.to),
    date: date ? new Date(date).toISOString() : null,
    unread: !flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
  };
}

async function findSpecialFolder(
  client: ImapFlow,
  use: SpecialFolder
): Promise<string | undefined> {
  const folders = await client.list();
  const bySpecialUse = folders.find(f => f.specialUse === use);
  if (bySpecialUse) return bySpecialUse.path;
  // Fallback for servers that don't advertise SPECIAL-USE.
  const names: Record<SpecialFolder, string[]> = {
    '\\Sent': [
      'sent',
      'sent items',
      'sent mail',
      'sent messages',
      'inbox.sent',
    ],
    '\\Drafts': ['drafts', 'draft', 'inbox.drafts'],
    '\\Trash': [
      'trash',
      'deleted items',
      'deleted messages',
      'bin',
      'inbox.trash',
    ],
    '\\Junk': ['junk', 'spam', 'junk e-mail', 'inbox.junk', 'inbox.spam'],
    '\\Archive': ['archive', 'archives', 'inbox.archive'],
  };
  return folders.find(f => names[use].includes(f.path.toLowerCase()))?.path;
}

export async function listFolders(account: Account) {
  return withImap(account, async client => {
    const folders = await client.list({
      statusQuery: {messages: true, unseen: true},
    });
    return folders
      .filter(f => !f.flags.has('\\Noselect'))
      .map(f => ({
        path: f.path,
        specialUse: f.specialUse ?? null,
        messages: f.status?.messages ?? null,
        unread: f.status?.unseen ?? null,
      }));
  });
}

export async function searchMessages(
  account: Account,
  folder: string,
  params: SearchParams,
  limit: number
): Promise<{total: number; messages: MessageSummary[]}> {
  const criteria = buildSearchCriteria(params);
  return withFolder(
    account,
    folder,
    async client => {
      const uids = (await client.search(criteria, {uid: true})) || [];
      const newest = pickNewest(uids, limit);
      if (newest.length === 0) return {total: 0, messages: []};
      const messages: MessageSummary[] = [];
      for await (const msg of client.fetch(
        newest,
        {uid: true, envelope: true, flags: true, internalDate: true},
        {uid: true}
      )) {
        messages.push(toSummary(account, folder, msg));
      }
      messages.sort((a, b) => b.uid - a.uid);
      return {total: uids.length, messages};
    },
    true
  );
}

function bodyText(parsed: ParsedMail): string {
  if (parsed.text?.trim()) return parsed.text;
  if (parsed.html) {
    return htmlToText(parsed.html, {
      wordwrap: false,
      selectors: [{selector: 'img', format: 'skip'}],
    });
  }
  return '';
}

async function fetchParsed(client: ImapFlow, uid: number) {
  const msg = await client.fetchOne(
    String(uid),
    {uid: true, source: true, flags: true, envelope: true, internalDate: true},
    {uid: true}
  );
  if (!msg || !msg.source) throw new Error(`Message UID ${uid} not found`);
  return {msg, parsed: await simpleParser(msg.source)};
}

export async function readMessage(
  account: Account,
  folder: string,
  uid: number,
  opts: {maxChars: number; markAsRead: boolean}
): Promise<MessageDetail> {
  return withFolder(
    account,
    folder,
    async client => {
      const {msg, parsed} = await fetchParsed(client, uid);
      if (opts.markAsRead) {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], {uid: true});
      }
      const full = bodyText(parsed);
      return {
        ...toSummary(account, folder, msg),
        cc: parsedAddresses(parsed.cc),
        replyTo: parsedAddresses(parsed.replyTo),
        messageId: parsed.messageId ?? null,
        body: full.slice(0, opts.maxChars),
        bodyTruncated: full.length > opts.maxChars,
        attachments: parsed.attachments.map((a, index) => ({
          index,
          filename: a.filename ?? `attachment-${index}`,
          contentType: a.contentType,
          size: a.size,
        })),
      };
    },
    !opts.markAsRead
  );
}

/** Headers and quoted text needed to compose a reply or forward. */
export async function getOriginalForReply(
  account: Account,
  folder: string,
  uid: number
) {
  return withFolder(
    account,
    folder,
    async client => {
      const {parsed} = await fetchParsed(client, uid);
      const refs = asList(parsed.references);
      return {
        subject: parsed.subject ?? '',
        from: parsed.from?.value ?? [],
        to: asList(parsed.to).flatMap(a => a.value),
        cc: asList(parsed.cc).flatMap(a => a.value),
        replyTo: parsed.replyTo?.value ?? [],
        messageId: parsed.messageId,
        references: parsed.messageId ? [...refs, parsed.messageId] : refs,
        date: parsed.date,
        fromText: parsed.from?.text ?? '',
        text: bodyText(parsed),
        attachments: parsed.attachments,
      };
    },
    true
  );
}

export async function getAttachment(
  account: Account,
  folder: string,
  uid: number,
  index: number
) {
  return withFolder(
    account,
    folder,
    async client => {
      const {parsed} = await fetchParsed(client, uid);
      const att = parsed.attachments[index];
      if (!att) {
        throw new Error(
          `Attachment #${index} not found (message has ${parsed.attachments.length})`
        );
      }
      return att;
    },
    true
  );
}

export async function updateFlags(
  account: Account,
  folder: string,
  uids: number[],
  changes: {read?: boolean; flagged?: boolean}
): Promise<void> {
  await withFolder(account, folder, async client => {
    const range = uids.join(',');
    async function apply(flag: string, on: boolean | undefined): Promise<void> {
      if (on === undefined) return;
      if (on) {
        await client.messageFlagsAdd(range, [flag], {uid: true});
      } else {
        await client.messageFlagsRemove(range, [flag], {uid: true});
      }
    }
    await apply('\\Seen', changes.read);
    await apply('\\Flagged', changes.flagged);
  });
}

export async function moveMessages(
  account: Account,
  folder: string,
  uids: number[],
  destination: string,
  opts: {allowTrash: boolean}
): Promise<string> {
  return withImap(account, async client => {
    const special = isSpecialFolder(destination)
      ? await findSpecialFolder(client, destination)
      : undefined;
    const target = special ?? destination;
    // Moving into Trash is a delete, so it needs delete permission.
    if (!opts.allowTrash) {
      const trash = await findSpecialFolder(client, '\\Trash');
      if (trash && trash.toLowerCase() === target.toLowerCase()) {
        throw new Error(
          'Blocked by guardrail: moving to Trash counts as deleting (EMAIL_ALLOW_DELETE=false).'
        );
      }
    }
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageMove(uids.join(','), target, {uid: true});
    } finally {
      lock.release();
    }
    return target;
  });
}

/**
 * Moves to Trash, or expunges permanently if already in Trash / no Trash
 * exists / permanent=true. Permanent erasure requires allowPermanent.
 */
export async function deleteMessages(
  account: Account,
  folder: string,
  uids: number[],
  opts: {permanent: boolean; allowPermanent: boolean}
) {
  return withImap(account, async client => {
    const trash = await findSpecialFolder(client, '\\Trash');
    const toTrash = !opts.permanent && trash !== undefined && trash !== folder;
    if (!toTrash && !opts.allowPermanent) {
      throw new Error(
        'Blocked by guardrail: this would erase messages permanently ' +
          `(${trash === folder ? 'they are already in Trash' : 'permanent delete requested'}), ` +
          'and EMAIL_ALLOW_PERMANENT_DELETE=false.'
      );
    }
    const lock = await client.getMailboxLock(folder);
    try {
      if (toTrash && trash) {
        await client.messageMove(uids.join(','), trash, {uid: true});
        return {movedTo: trash, permanent: false};
      }
      await client.messageDelete(uids.join(','), {uid: true});
      return {movedTo: null, permanent: true};
    } finally {
      lock.release();
    }
  });
}

export async function appendToSpecial(
  account: Account,
  use: SpecialFolder,
  raw: Buffer,
  flags: string[]
) {
  return withImap(account, async client => {
    const path = await findSpecialFolder(client, use);
    if (!path) throw new Error(`No ${use.slice(1)} folder found`);
    await client.append(path, raw, flags);
    return path;
  });
}
