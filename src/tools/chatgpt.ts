/**
 * @fileoverview The search and fetch tools in the shape ChatGPT deep research expects.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import type {AccountRegistry} from '../config.js';
import {readMessage, searchMessages} from '../mailbox.js';
import {json, resolveOne, safe} from './common.js';

/**
 * `search` + `fetch` in the exact shape ChatGPT's deep research / company knowledge expects.
 * Other clients can ignore these and use search_emails / read_email.
 */
export function registerChatGptTools(
  server: McpServer,
  registry: AccountRegistry
): void {
  server.registerTool(
    'search',
    {
      title: 'Search emails (all accounts)',
      description:
        'Full-text search across the INBOX of every configured account. Returns ids for the fetch tool.',
      inputSchema: {
        query: z
          .string()
          .describe('Words to look for in subject, sender, recipients or body'),
      },
      annotations: {readOnlyHint: true, openWorldHint: true},
    },
    safe(async ({query}) => {
      const perAccount = await Promise.all(
        registry
          .list()
          .map(account =>
            searchMessages(account, 'INBOX', {query}, 10).then(r => r.messages)
          )
      );
      const results = perAccount.flat().map(m => ({
        id: m.id,
        title: `${m.subject} — ${m.from}${m.date ? ` (${m.date.slice(0, 10)})` : ''}`,
        url: `mailbox://${encodeURIComponent(m.id)}`,
      }));
      return json({results});
    })
  );

  server.registerTool(
    'fetch',
    {
      title: 'Fetch email',
      description: 'Fetch the full content of an email returned by search.',
      inputSchema: {id: z.string()},
      annotations: {readOnlyHint: true, openWorldHint: true},
    },
    safe(async ({id}) => {
      const {account, ref} = resolveOne(registry, id);
      const m = await readMessage(account, ref.folder, ref.uid, {
        maxChars: 50_000,
        markAsRead: false,
      });
      return json({
        id,
        title: m.subject,
        text: `From: ${m.from}\nTo: ${m.to}\nCc: ${m.cc}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body}`,
        url: `mailbox://${encodeURIComponent(id)}`,
        metadata: {
          account: account.email,
          folder: m.folder,
          attachments: m.attachments.map(a => a.filename).join(', '),
        },
      });
    })
  );
}
