/**
 * @fileoverview Read-only MCP tools: accounts, folders, search, read and attachments.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import type {AccountRegistry} from '../config.js';
import {
  assertAllowed,
  describeGuardrails,
  type Guardrails,
} from '../guardrails.js';
import {
  getAttachment,
  listFolders,
  readMessage,
  searchMessages,
} from '../mailbox.js';
import {json, resolveOne, safe} from './common.js';

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;

export const ACCOUNT_PARAM = z
  .string()
  .optional()
  .describe(
    'Account id or email address. Omit to use the default (first) account. See list_accounts.'
  );

export function registerReadTools(
  server: McpServer,
  registry: AccountRegistry,
  guardrails: Guardrails
): void {
  server.registerTool(
    'list_accounts',
    {
      title: 'List email accounts',
      description:
        'List the email accounts this server can access (the first is the default) and the guardrails: which actions are allowed and who mail may be sent to.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    safe(async () =>
      json({
        accounts: registry.list().map((a, i) => ({
          id: a.id,
          email: a.email,
          displayName: a.displayName ?? null,
          default: i === 0,
        })),
        guardrails: describeGuardrails(guardrails),
      })
    )
  );

  server.registerTool(
    'list_folders',
    {
      title: 'List folders',
      description:
        'List mailbox folders with message and unread counts. specialUse marks Sent, Drafts, Trash, Junk, Archive.',
      inputSchema: {account: ACCOUNT_PARAM},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    safe(async ({account}) => json(await listFolders(registry.get(account))))
  );

  server.registerTool(
    'search_emails',
    {
      title: 'Search / list emails',
      description:
        'Search a folder and return the newest matching messages (summaries only; use read_email for the body). ' +
        'With no filters it lists the latest messages. Each result has an `id` used by the other tools.',
      inputSchema: {
        account: ACCOUNT_PARAM,
        folder: z
          .string()
          .default('INBOX')
          .describe('Folder path from list_folders'),
        query: z
          .string()
          .optional()
          .describe('Free text matched against subject, from, to and body'),
        from: z.string().optional().describe('Sender address or name contains'),
        to: z
          .string()
          .optional()
          .describe('Recipient address or name contains'),
        subject: z.string().optional().describe('Subject contains'),
        since: z.string().optional().describe('On or after date, YYYY-MM-DD'),
        before: z.string().optional().describe('Before date, YYYY-MM-DD'),
        unreadOnly: z.boolean().optional(),
        flaggedOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    safe(async ({account, folder, limit, ...params}) =>
      json(await searchMessages(registry.get(account), folder, params, limit))
    )
  );

  server.registerTool(
    'read_email',
    {
      title: 'Read email',
      description:
        "Read one email's headers, plain-text body and attachment list.",
      inputSchema: {
        id: z.string().describe('Message id from search_emails'),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(200_000)
          .default(20_000)
          .describe('Truncate the body after this many characters'),
        markAsRead: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async ({id, maxChars, markAsRead}) => {
      if (markAsRead) assertAllowed(guardrails, 'mark');
      const {account, ref} = resolveOne(registry, id);
      return json(
        await readMessage(account, ref.folder, ref.uid, {maxChars, markAsRead})
      );
    })
  );

  server.registerTool(
    'get_attachment',
    {
      title: 'Get attachment',
      description:
        'Download an attachment. Text files are returned as text, images as images, anything else as base64 (max 5 MB).',
      inputSchema: {
        id: z.string().describe('Message id'),
        index: z
          .number()
          .int()
          .min(0)
          .describe('Attachment index from read_email'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    safe(async ({id, index}) => {
      const {account, ref} = resolveOne(registry, id);
      const att = await getAttachment(account, ref.folder, ref.uid, index);
      if (att.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `Attachment is ${att.size} bytes; limit is ${MAX_ATTACHMENT_BYTES}`
        );
      }
      const name = att.filename ?? `attachment-${index}`;
      if (
        att.contentType.startsWith('text/') ||
        /json|xml|csv|calendar/.test(att.contentType)
      ) {
        return {
          content: [
            {
              type: 'text',
              text: `${name} (${att.contentType})\n\n${att.content.toString('utf8')}`,
            },
          ],
        };
      }
      if (att.contentType.startsWith('image/')) {
        return {
          content: [
            {
              type: 'image',
              data: att.content.toString('base64'),
              mimeType: att.contentType,
            },
          ],
        };
      }
      return json({
        filename: name,
        contentType: att.contentType,
        size: att.size,
        contentBase64: att.content.toString('base64'),
      });
    })
  );
}
