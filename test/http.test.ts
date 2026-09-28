import {request, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterEach, describe, expect, it} from 'vitest';
import {AccountRegistry, normalizeAccount} from '../src/config.js';
import {loadGuardrails} from '../src/guardrails.js';
import {createHttpApp} from '../src/http.js';

const REGISTRY = new AccountRegistry([
  normalizeAccount({
    provider: 'privateemail',
    email: 'me@navo.health',
    password: 'unused',
  }),
]);

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function listen(authToken?: string): Promise<number> {
  const app = createHttpApp(REGISTRY, {
    host: '127.0.0.1',
    port: 0,
    authToken,
    guardrails: loadGuardrails({}),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server!.once('listening', resolve));
  return (server!.address() as AddressInfo).port;
}

/** Sends a request with an explicit Host header, as a DNS-rebound page would. */
function statusFor(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {host: '127.0.0.1', port, path: '/health', headers: {Host: host}},
      res => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP host validation', () => {
  it('rejects foreign Host headers when no token is set', async () => {
    const port = await listen();
    expect(await statusFor(port, 'rebind.attacker.com')).toBe(403);
    expect(await statusFor(port, `localhost:${port}`)).toBe(200);
    expect(await statusFor(port, `127.0.0.1:${port}`)).toBe(200);
  });

  it('accepts any Host when a token is set, so tunnels keep working', async () => {
    const port = await listen('secret');
    expect(await statusFor(port, 'abc.trycloudflare.com')).toBe(200);
  });
});
