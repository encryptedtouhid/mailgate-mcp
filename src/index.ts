#!/usr/bin/env node
/**
 * @fileoverview Entry point. Runs over stdio by default, or Streamable HTTP
 * with --http / MCP_TRANSPORT=http.
 */

import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {config as loadEnv} from 'dotenv';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {AccountRegistry, loadAccounts} from './config.js';
import {describeGuardrails, loadGuardrails} from './guardrails.js';
import {startHttpServer} from './http.js';
import {closeImapConnections} from './mailbox.js';
import {createServer} from './server.js';

// Claude Desktop launches servers with cwd "/", so look for .env next to the project as well as in cwd.
loadEnv({
  path: [
    resolve(process.cwd(), '.env'),
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'),
  ],
});

function isTrue(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase());
}

function parsePort(value: string | undefined): number {
  const port = Number(value || 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT "${value}"`);
  }
  return port;
}

async function main(): Promise<void> {
  const registry = new AccountRegistry(loadAccounts());
  const guardrails = loadGuardrails(process.env);
  console.error(
    `mailgate-mcp guardrails: ${JSON.stringify(describeGuardrails(guardrails))}`
  );
  const useHttp =
    process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http';

  if (useHttp) {
    const host = process.env.HOST || '127.0.0.1';
    const authToken = process.env.MCP_AUTH_TOKEN || undefined;
    if (
      !authToken &&
      host !== '127.0.0.1' &&
      host !== 'localhost' &&
      !isTrue(process.env.MCP_ALLOW_NO_AUTH)
    ) {
      throw new Error(
        'Refusing to listen on a public interface without MCP_AUTH_TOKEN (set MCP_ALLOW_NO_AUTH=true to override).'
      );
    }
    startHttpServer(registry, {
      host,
      port: parsePort(process.env.PORT),
      authToken,
      guardrails,
    });
    return;
  }

  // stdio: stdout carries the protocol, so all logging goes to stderr.
  const server = createServer(registry, {guardrails});
  await server.connect(new StdioServerTransport());
  // The pooled IMAP connection would otherwise keep the process (and its
  // Docker container) alive until it idles out after the client has gone.
  // Give logouts a moment, but don't wait on a login the server is stalling.
  process.stdin.on('end', () => {
    const timeout = new Promise(resolve => setTimeout(resolve, 2_000));
    void Promise.race([closeImapConnections(), timeout]).finally(() =>
      process.exit(0)
    );
  });
  console.error(
    `mailgate-mcp ready (stdio) for ${registry
      .list()
      .map(a => a.email)
      .join(', ')}`
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
