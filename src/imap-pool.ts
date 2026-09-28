/**
 * @fileoverview Keeps one IMAP connection per account and runs operations on
 * it one at a time, so a burst of tool calls costs one login instead of one
 * login each. Providers such as PrivateEmail refuse logins for a while when
 * too many arrive close together.
 */

import type {ImapFlow} from 'imapflow';
import type {Account} from './config.js';

export interface PoolOptions {
  /** Log out after this long without calls. */
  idleMs: number;
  /** Wait before each retry of a temporarily refused login; its length is the retry count. */
  retryDelaysMs: readonly number[];
  /**
   * Only retry refusals that came back faster than this. A slow refusal means
   * the server is deliberately delaying logins (tarpitting), and each retry
   * would add to the penalty and keep the user waiting.
   */
  fastFailureMs: number;
}

interface Entry {
  client?: ImapFlow;
  /** Tail of this account's queue. Never rejects, so one failure can't block later calls. */
  queue: Promise<unknown>;
  idleTimer?: NodeJS.Timeout;
}

/** Fields imapflow sets on login errors. */
interface LoginError extends Error {
  authenticationFailed?: boolean;
  serverResponseCode?: string;
  response?: string;
}

/** A login refused for now (throttling, auth backend busy), as opposed to wrong credentials. */
export function isTemporaryAuthFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Safe: every LoginError field is optional, so any Error satisfies the shape.
  const e: LoginError = err;
  if (!e.authenticationFailed) return false;
  return (
    e.serverResponseCode === 'UNAVAILABLE' || /temporar/i.test(e.response ?? '')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ImapPool {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly create: (account: Account) => ImapFlow,
    private readonly options: PoolOptions
  ) {}

  /** Runs `fn` on the account's connection once earlier calls for that account finish. */
  run<T>(account: Account, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const entry = this.entry(account.id);
    const task = entry.queue.then(() => this.exec(account, entry, fn));
    entry.queue = task.catch(() => undefined);
    return task;
  }

  /** Waits for queued calls, then logs out of every connection. */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(async entry => {
        await entry.queue;
        await this.release(entry);
      })
    );
  }

  private entry(accountId: string): Entry {
    let entry = this.entries.get(accountId);
    if (!entry) {
      entry = {queue: Promise.resolve()};
      this.entries.set(accountId, entry);
    }
    return entry;
  }

  private async exec<T>(
    account: Account,
    entry: Entry,
    fn: (client: ImapFlow) => Promise<T>
  ): Promise<T> {
    clearTimeout(entry.idleTimer);
    try {
      return await fn(await this.connection(account, entry));
    } finally {
      entry.idleTimer = setTimeout(
        () => void this.release(entry),
        this.options.idleMs
      );
      entry.idleTimer.unref();
    }
  }

  private async connection(account: Account, entry: Entry): Promise<ImapFlow> {
    if (entry.client?.usable) return entry.client;
    entry.client = undefined;
    for (let attempt = 0; ; attempt++) {
      const client = this.create(account);
      const started = Date.now();
      try {
        await client.connect();
      } catch (err) {
        // A failed login leaves the socket open, which would keep the process
        // (and its Docker container) alive after the client goes away.
        client.close();
        const delay = this.options.retryDelaysMs[attempt];
        const fast = Date.now() - started < this.options.fastFailureMs;
        if (delay === undefined || !fast || !isTemporaryAuthFailure(err)) {
          throw err;
        }
        await sleep(delay);
        continue;
      }
      client.on('close', () => {
        if (entry.client === client) entry.client = undefined;
      });
      // A long-lived connection can hit socket errors between calls; without a
      // listener the 'error' event would crash the process. The 'close' that
      // follows drops the connection, and the next call reconnects.
      client.on('error', () => {});
      entry.client = client;
      return client;
    }
  }

  private async release(entry: Entry): Promise<void> {
    clearTimeout(entry.idleTimer);
    const client = entry.client;
    entry.client = undefined;
    if (client) await client.logout().catch(() => client.close());
  }
}
