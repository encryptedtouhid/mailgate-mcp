import {describe, expect, it} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {AccountRegistry, normalizeAccount} from '../src/config.js';
import {loadGuardrails} from '../src/guardrails.js';
import {createServer} from '../src/server.js';

const REGISTRY = new AccountRegistry([
  normalizeAccount({
    provider: 'privateemail',
    email: 'me@navo.health',
    password: 'unused',
  }),
]);

async function connect(env: Record<string, string>): Promise<Client> {
  const server = createServer(REGISTRY, {guardrails: loadGuardrails(env)});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({name: 'test', version: '1.0.0'});
  await client.connect(clientSide);
  return client;
}

async function toolNames(env: Record<string, string>): Promise<string[]> {
  const client = await connect(env);
  const {tools} = await client.listTools();
  return tools.map(t => t.name);
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{type: string; text?: string}>;
  return content.map(c => c.text ?? '').join('\n');
}

describe('tool registration follows guardrails', () => {
  it('registers every tool by default', async () => {
    expect(await toolNames({})).toEqual(
      expect.arrayContaining([
        'send_email',
        'reply_to_email',
        'forward_email',
        'save_draft',
        'mark_emails',
        'move_emails',
        'delete_emails',
      ])
    );
  });

  it('read-only mode leaves only read tools', async () => {
    const names = await toolNames({EMAIL_READ_ONLY: 'true'});
    expect(names.sort()).toEqual(
      [
        'fetch',
        'get_attachment',
        'list_accounts',
        'list_folders',
        'read_email',
        'search',
        'search_emails',
      ].sort()
    );
  });

  it('hides only the disabled actions', async () => {
    const names = await toolNames({
      EMAIL_ALLOW_SEND: 'false',
      EMAIL_ALLOW_DELETE: 'false',
    });
    expect(names).not.toContain('send_email');
    expect(names).not.toContain('forward_email');
    expect(names).not.toContain('delete_emails');
    // Replies can still be saved as drafts.
    expect(names).toContain('reply_to_email');
    expect(names).toContain('save_draft');
    expect(names).toContain('move_emails');
  });
});

describe('guardrails are enforced on calls', () => {
  it('blocks recipients outside the allowlist before connecting', async () => {
    const client = await connect({EMAIL_ALLOWED_RECIPIENTS: 'navo.health'});
    const result = await client.callTool({
      name: 'send_email',
      arguments: {to: ['stranger@gmail.com'], subject: 'x', text: 'y'},
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(
      /stranger@gmail.com.*EMAIL_ALLOWED_RECIPIENTS/
    );
  });

  it('blocks mark-as-read when marking is disabled', async () => {
    const client = await connect({EMAIL_ALLOW_MARK: 'false'});
    const result = await client.callTool({
      name: 'read_email',
      arguments: {id: 'me-navo-health|INBOX|1', markAsRead: true},
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/EMAIL_ALLOW_MARK/);
  });

  it('reports guardrails in list_accounts', async () => {
    const client = await connect({EMAIL_ALLOW_DELETE: 'false'});
    const result = await client.callTool({
      name: 'list_accounts',
      arguments: {},
    });
    const body = JSON.parse(text(result));
    expect(body.accounts[0].email).toBe('me@navo.health');
    expect(body.guardrails.permissions).toMatchObject({
      send: true,
      delete: false,
      permanentDelete: false,
    });
  });
});
