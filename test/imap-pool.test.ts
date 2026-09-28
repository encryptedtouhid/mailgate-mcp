import {EventEmitter} from 'node:events';
import type {ImapFlow} from 'imapflow';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {normalizeAccount} from '../src/config.js';
import {ImapPool, isTemporaryAuthFailure} from '../src/imap-pool.js';
import {describeError} from '../src/tools/common.js';

const ACCOUNT = normalizeAccount({
  provider: 'privateemail',
  email: 'me@navo.health',
  password: 'unused',
});

function authError(code: string, text: string): Error {
  return Object.assign(new Error('Command failed'), {
    authenticationFailed: true,
    serverResponseCode: code,
    response: text,
  });
}

const TEMPORARY = () =>
  authError('UNAVAILABLE', 'Temporary authentication failure.');
const WRONG_PASSWORD = () =>
  authError('AUTHENTICATIONFAILED', 'Invalid credentials');

/** Stands in for ImapFlow: records calls, and fails connect() on request. */
class FakeClient extends EventEmitter {
  usable = false;
  loggedOut = false;
  closed = false;
  constructor(
    private readonly failWith?: Error,
    private readonly delayMs = 0
  ) {
    super();
  }
  async connect(): Promise<void> {
    if (this.delayMs) {
      await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }
    if (this.failWith) throw this.failWith;
    this.usable = true;
  }
  async logout(): Promise<void> {
    this.loggedOut = true;
    this.drop();
  }
  close(): void {
    this.closed = true;
    this.drop();
  }
  /** Simulates the server or network dropping the connection. */
  drop(): void {
    this.usable = false;
    this.emit('close');
  }
}

function fakeFactory(failures: Array<Error | undefined> = [], delayMs = 0) {
  const clients: FakeClient[] = [];
  const create = () => {
    const client = new FakeClient(failures[clients.length], delayMs);
    clients.push(client);
    return client as unknown as ImapFlow;
  };
  return {clients, create};
}

function pool(
  create: () => ImapFlow,
  options: Partial<ConstructorParameters<typeof ImapPool>[1]> = {}
) {
  return new ImapPool(create, {
    idleMs: 60_000,
    retryDelaysMs: [0, 0],
    fastFailureMs: 5_000,
    ...options,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ImapPool', () => {
  it('reuses one login across calls', async () => {
    const {clients, create} = fakeFactory();
    const p = pool(create);
    await p.run(ACCOUNT, async () => 'a');
    await p.run(ACCOUNT, async () => 'b');
    expect(clients).toHaveLength(1);
    await p.closeAll();
  });

  it('runs parallel calls one at a time on the same connection', async () => {
    const {clients, create} = fakeFactory();
    const p = pool(create);
    let active = 0;
    let maxActive = 0;
    const task = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
    };
    await Promise.all([
      p.run(ACCOUNT, task),
      p.run(ACCOUNT, task),
      p.run(ACCOUNT, task),
    ]);
    expect(maxActive).toBe(1);
    expect(clients).toHaveLength(1);
    await p.closeAll();
  });

  it('keeps later calls running after one fails', async () => {
    const {create} = fakeFactory();
    const p = pool(create);
    await expect(
      p.run(ACCOUNT, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(p.run(ACCOUNT, async () => 'ok')).resolves.toBe('ok');
    await p.closeAll();
  });

  it('logs out after being idle, and logs in again when needed', async () => {
    vi.useFakeTimers();
    const {clients, create} = fakeFactory();
    const p = pool(create, {idleMs: 1000});
    await p.run(ACCOUNT, async () => undefined);
    await vi.advanceTimersByTimeAsync(999);
    expect(clients[0].loggedOut).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(clients[0].loggedOut).toBe(true);
    await p.run(ACCOUNT, async () => undefined);
    expect(clients).toHaveLength(2);
    await p.closeAll();
  });

  it('reconnects when the connection was dropped', async () => {
    const {clients, create} = fakeFactory();
    const p = pool(create);
    await p.run(ACCOUNT, async () => undefined);
    clients[0].drop();
    await p.run(ACCOUNT, async () => undefined);
    expect(clients).toHaveLength(2);
    await p.closeAll();
  });

  it('retries a temporary login failure and closes the failed connection', async () => {
    const {clients, create} = fakeFactory([TEMPORARY()]);
    const p = pool(create);
    await expect(p.run(ACCOUNT, async () => 'ok')).resolves.toBe('ok');
    expect(clients).toHaveLength(2);
    expect(clients[0].closed).toBe(true);
    await p.closeAll();
  });

  it('gives up after the configured retries', async () => {
    const {clients, create} = fakeFactory([
      TEMPORARY(),
      TEMPORARY(),
      TEMPORARY(),
    ]);
    const p = pool(create, {retryDelaysMs: [0, 0]});
    await expect(p.run(ACCOUNT, async () => 'ok')).rejects.toMatchObject({
      serverResponseCode: 'UNAVAILABLE',
    });
    expect(clients).toHaveLength(3);
    expect(clients.every(c => c.closed)).toBe(true);
  });

  it('does not retry when the server was slow to refuse (tarpitting)', async () => {
    vi.useFakeTimers();
    const {clients, create} = fakeFactory([TEMPORARY(), TEMPORARY()], 42_000);
    const p = pool(create);
    const result = expect(
      p.run(ACCOUNT, async () => 'ok')
    ).rejects.toMatchObject({serverResponseCode: 'UNAVAILABLE'});
    await vi.advanceTimersByTimeAsync(42_000);
    await result;
    expect(clients).toHaveLength(1);
    expect(clients[0].closed).toBe(true);
  });

  it('does not retry a wrong password', async () => {
    const {clients, create} = fakeFactory([WRONG_PASSWORD()]);
    const p = pool(create);
    await expect(p.run(ACCOUNT, async () => 'ok')).rejects.toMatchObject({
      serverResponseCode: 'AUTHENTICATIONFAILED',
    });
    expect(clients).toHaveLength(1);
    expect(clients[0].closed).toBe(true);
  });

  it('closeAll logs out open connections', async () => {
    const {clients, create} = fakeFactory();
    const p = pool(create);
    await p.run(ACCOUNT, async () => undefined);
    await p.closeAll();
    expect(clients[0].loggedOut).toBe(true);
  });
});

describe('temporary login failures', () => {
  it('are recognised by response code or text', () => {
    expect(isTemporaryAuthFailure(TEMPORARY())).toBe(true);
    expect(
      isTemporaryAuthFailure(
        authError('', 'Temporary authentication failure. [host:2026-09-28]')
      )
    ).toBe(true);
    expect(isTemporaryAuthFailure(WRONG_PASSWORD())).toBe(false);
    expect(isTemporaryAuthFailure(new Error('timeout'))).toBe(false);
  });

  it('are explained without blaming the password', () => {
    const text = describeError(TEMPORARY());
    expect(text).toMatch(/temporarily refusing logins/);
    expect(text).not.toMatch(/username\/password/);
    expect(describeError(WRONG_PASSWORD())).toMatch(/username\/password/);
  });
});
