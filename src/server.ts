/**
 * @fileoverview Builds the MCP server and registers its tools.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {AccountRegistry} from './config.js';
import type {Guardrails} from './guardrails.js';
import {registerChatGptTools} from './tools/chatgpt.js';
import {registerReadTools} from './tools/read.js';
import {registerWriteTools} from './tools/write.js';

export interface ServerOptions {
  /** Which write actions are enabled, from the EMAIL_ALLOW_* flags. */
  guardrails: Guardrails;
}

export function createServer(
  registry: AccountRegistry,
  options: ServerOptions
): McpServer {
  const server = new McpServer(
    {name: 'mailgate-mcp', version: '1.0.0'},
    {
      instructions:
        "Access to the user's email over IMAP/SMTP. Use search_emails to find messages, read_email to open one. " +
        'Always confirm recipients and content with the user before calling send_email, reply_to_email or forward_email. ' +
        'The server enforces guardrails (see list_accounts); if an action is blocked, tell the user instead of working around it.',
    }
  );
  registerReadTools(server, registry, options.guardrails);
  registerChatGptTools(server, registry);
  registerWriteTools(server, registry, options.guardrails);
  return server;
}
