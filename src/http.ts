/**
 * @fileoverview Streamable HTTP transport with token auth, for remote clients.
 */

import {timingSafeEqual} from 'node:crypto';
import express, {type NextFunction, type Request, type Response} from 'express';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {AccountRegistry} from './config.js';
import {createServer, type ServerOptions} from './server.js';

export interface HttpOptions extends ServerOptions {
  host: string;
  port: number;
  /** Secret required on every request, either as `Authorization: Bearer <token>` or in the URL: /mcp/<token>. */
  authToken?: string;
}

export function tokenMatches(
  expected: string,
  provided: string | undefined
): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireToken(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!token) return next();
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (tokenMatches(token, req.params.token) || tokenMatches(token, bearer)) {
      return next();
    }
    res.status(401).json({
      jsonrpc: '2.0',
      error: {code: -32001, message: 'Unauthorized'},
      id: null,
    });
  };
}

export function startHttpServer(
  registry: AccountRegistry,
  options: HttpOptions
) {
  const app = express();
  app.use(express.json({limit: '30mb'}));

  app.get('/health', (_req, res) => {
    res.json({ok: true});
  });

  // Stateless Streamable HTTP: a fresh MCP server per request, so any number of clients can connect.
  async function handle(req: Request, res: Response): Promise<void> {
    const server = createServer(registry, options);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {code: -32603, message: 'Internal server error'},
          id: null,
        });
      }
    }
  }

  function notAllowed(_req: Request, res: Response): void {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {code: -32000, message: 'Method not allowed'},
      id: null,
    });
  }

  const auth = requireToken(options.authToken);
  for (const path of ['/mcp', '/mcp/:token']) {
    app.post(path, auth, handle);
    app.get(path, auth, notAllowed);
    app.delete(path, auth, notAllowed);
  }

  return app.listen(options.port, options.host, () => {
    console.error(
      `mailgate-mcp listening on http://${options.host}:${options.port}/mcp`
    );
    if (!options.authToken) {
      console.error(
        'WARNING: MCP_AUTH_TOKEN is not set — anyone who can reach this port can read and send your email.'
      );
    }
  });
}
