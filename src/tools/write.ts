/**
 * @fileoverview MCP tools that change mail: send, reply, forward, drafts, flags, move, delete.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import type {Account, AccountRegistry} from '../config.js';
import {
  assertAllowed,
  checkRecipients,
  isAllowed,
  type Guardrails,
} from '../guardrails.js';
import {
  forwardBlock,
  prefixSubject,
  quoteText,
  replyRecipients,
} from '../compose.js';
import {
  deleteMessages,
  getOriginalForReply,
  moveMessages,
  updateFlags,
} from '../mailbox.js';
import {parseRecipients} from '../recipients.js';
import {saveDraft, sendMessage, type OutgoingMessage} from '../sender.js';
import {groupIds, json, resolveOne, safe} from './common.js';
import {ACCOUNT_PARAM} from './read.js';

const ADDRESS_LIST = z
  .array(z.string())
  .describe(
    'One address per entry, e.g. "jane@example.com" or "Jane Doe <jane@example.com>"'
  );
const ATTACHMENTS = z
  .array(
    z.object({
      filename: z.string(),
      contentBase64: z.string(),
      contentType: z.string().optional(),
    })
  )
  .optional()
  .describe('Files to attach, base64-encoded');
const MESSAGE_IDS = z
  .array(z.string())
  .min(1)
  .describe('Message ids from search_emails');
const COMPOSE_FIELDS = {
  account: ACCOUNT_PARAM,
  to: ADDRESS_LIST,
  cc: ADDRESS_LIST.optional(),
  bcc: ADDRESS_LIST.optional(),
  subject: z.string(),
  text: z.string().optional().describe('Plain-text body'),
  html: z.string().optional().describe('Optional HTML body'),
  attachments: ATTACHMENTS,
};

async function buildReply(
  registry: AccountRegistry,
  a: {id: string; text: string; html?: string; replyAll: boolean; cc?: string[]}
) {
  const {account, ref} = resolveOne(registry, a.id);
  const o = await getOriginalForReply(account, ref.folder, ref.uid);
  const recipients = replyRecipients(o, account.email, a.replyAll);
  const message: OutgoingMessage = {
    to: recipients.to,
    cc: [...recipients.cc, ...(a.cc ?? [])],
    subject: prefixSubject(o.subject, 'Re'),
    text: `${a.text}\n\n${quoteText(o.text, o.fromText, o.date)}`,
    html: a.html,
    inReplyTo: o.messageId,
    references: o.references,
  };
  return {account, message};
}

export function registerWriteTools(
  server: McpServer,
  registry: AccountRegistry,
  guardrails: Guardrails
): void {
  // Tools for disabled actions are not registered at all, so the model never
  // sees them. Every handler still re-checks in case of a direct call.
  // Recipients are parsed once and the parsed addresses are what gets sent,
  // so the guardrails check exactly the addresses mail is delivered to.
  function checkedRecipients(m: Pick<OutgoingMessage, 'to' | 'cc' | 'bcc'>) {
    const to = parseRecipients(m.to);
    const cc = parseRecipients(m.cc ?? []);
    const bcc = parseRecipients(m.bcc ?? []);
    checkRecipients(guardrails, [...to, ...cc, ...bcc]);
    return {to, cc, bcc};
  }

  function send(account: Account, message: OutgoingMessage) {
    assertAllowed(guardrails, 'send');
    return sendMessage(account, {...message, ...checkedRecipients(message)});
  }

  function draft(account: Account, message: OutgoingMessage) {
    assertAllowed(guardrails, 'drafts');
    return saveDraft(account, message);
  }

  if (isAllowed(guardrails, 'send')) {
    server.registerTool(
      'send_email',
      {
        title: 'Send email',
        description:
          "Send a new email via SMTP. A copy is saved to the Sent folder when the provider doesn't do it automatically.",
        inputSchema: COMPOSE_FIELDS,
        annotations: {destructiveHint: true, openWorldHint: true},
      },
      safe(async ({account, ...msg}) =>
        json(await send(registry.get(account), msg))
      )
    );
  }

  if (isAllowed(guardrails, 'send') || isAllowed(guardrails, 'drafts')) {
    server.registerTool(
      'reply_to_email',
      {
        title: 'Reply to email',
        description:
          'Reply to a message, keeping it in the same thread and quoting the original.',
        inputSchema: {
          id: z.string().describe('Message id to reply to'),
          text: z
            .string()
            .describe(
              'Your reply (plain text); the original is quoted below it'
            ),
          html: z.string().optional(),
          replyAll: z.boolean().default(false),
          cc: ADDRESS_LIST.optional().describe('Extra Cc recipients'),
          draftOnly: z
            .boolean()
            .default(false)
            .describe('Save to Drafts instead of sending'),
        },
        annotations: {destructiveHint: true, openWorldHint: true},
      },
      safe(async ({draftOnly, ...args}) => {
        const {account, message} = await buildReply(registry, args);
        const result = draftOnly
          ? await draft(account, message)
          : await send(account, message);
        return json({
          to: message.to,
          cc: message.cc,
          subject: message.subject,
          ...result,
        });
      })
    );
  }

  if (isAllowed(guardrails, 'forward')) {
    server.registerTool(
      'forward_email',
      {
        title: 'Forward email',
        description:
          'Forward a message (with its attachments) to new recipients.',
        inputSchema: {
          id: z.string(),
          to: ADDRESS_LIST,
          cc: ADDRESS_LIST.optional(),
          text: z
            .string()
            .default('')
            .describe('Note to add above the forwarded message'),
          includeAttachments: z.boolean().default(true),
        },
        annotations: {destructiveHint: true, openWorldHint: true},
      },
      safe(async ({id, to, cc, text, includeAttachments}) => {
        assertAllowed(guardrails, 'forward');
        // Fail fast before downloading the original and its attachments.
        checkedRecipients({to, cc});
        const {account, ref} = resolveOne(registry, id);
        const o = await getOriginalForReply(account, ref.folder, ref.uid);
        const toText = o.to.map(a => a.address).join(', ');
        const result = await send(account, {
          to,
          cc,
          subject: prefixSubject(o.subject, 'Fwd'),
          text: `${text}\n\n${forwardBlock({...o, toText})}`.trimStart(),
          rawAttachments: includeAttachments
            ? o.attachments.map(a => ({
                filename: a.filename,
                content: a.content,
                contentType: a.contentType,
              }))
            : [],
        });
        return json(result);
      })
    );
  }

  if (isAllowed(guardrails, 'drafts')) {
    server.registerTool(
      'save_draft',
      {
        title: 'Save draft',
        description: 'Save a message to the Drafts folder without sending it.',
        inputSchema: {
          ...COMPOSE_FIELDS,
          to: ADDRESS_LIST.default([]),
          subject: z.string().default(''),
        },
        annotations: {destructiveHint: false, openWorldHint: false},
      },
      safe(async ({account, ...msg}) =>
        json(await draft(registry.get(account), msg))
      )
    );
  }

  if (isAllowed(guardrails, 'mark')) {
    server.registerTool(
      'mark_emails',
      {
        title: 'Mark read/unread or flagged',
        description:
          'Set the read and/or flagged (starred) state of one or more messages.',
        inputSchema: {
          ids: MESSAGE_IDS,
          read: z.boolean().optional(),
          flagged: z.boolean().optional(),
        },
        annotations: {idempotentHint: true, destructiveHint: false},
      },
      safe(async ({ids, read, flagged}) => {
        assertAllowed(guardrails, 'mark');
        for (const g of groupIds(registry, ids)) {
          await updateFlags(g.account, g.folder, g.uids, {read, flagged});
        }
        return json({updated: ids.length});
      })
    );
  }

  if (isAllowed(guardrails, 'move')) {
    server.registerTool(
      'move_emails',
      {
        title: 'Move emails',
        description:
          'Move messages to another folder. Use a folder path, or "\\Archive", "\\Junk", "\\Trash" to target the special folder.',
        inputSchema: {ids: MESSAGE_IDS, destination: z.string()},
        annotations: {destructiveHint: false},
      },
      safe(async ({ids, destination}) => {
        assertAllowed(guardrails, 'move');
        const allowTrash = isAllowed(guardrails, 'delete');
        const moved = [];
        for (const g of groupIds(registry, ids)) {
          moved.push({
            account: g.account.id,
            from: g.folder,
            to: await moveMessages(g.account, g.folder, g.uids, destination, {
              allowTrash,
            }),
            count: g.uids.length,
          });
        }
        return json({
          moved,
          note: 'Message ids change after a move; search the destination folder to get new ids.',
        });
      })
    );
  }

  if (isAllowed(guardrails, 'delete')) {
    server.registerTool(
      'delete_emails',
      {
        title: 'Delete emails',
        description: isAllowed(guardrails, 'permanentDelete')
          ? 'Move messages to Trash. With permanent=true (or when already in Trash) they are erased permanently.'
          : 'Move messages to Trash. Permanent deletion is disabled on this server.',
        inputSchema: {ids: MESSAGE_IDS, permanent: z.boolean().default(false)},
        annotations: {destructiveHint: true},
      },
      safe(async ({ids, permanent}) => {
        assertAllowed(guardrails, 'delete');
        const allowPermanent = isAllowed(guardrails, 'permanentDelete');
        const results = [];
        for (const g of groupIds(registry, ids)) {
          results.push({
            account: g.account.id,
            folder: g.folder,
            count: g.uids.length,
            ...(await deleteMessages(g.account, g.folder, g.uids, {
              permanent,
              allowPermanent,
            })),
          });
        }
        return json(results);
      })
    );
  }
}
