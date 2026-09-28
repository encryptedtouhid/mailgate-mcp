/**
 * @fileoverview Shared helpers for tool handlers: JSON results, readable
 * errors and message-id resolution.
 */

import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import type {Account, AccountRegistry} from '../config.js';
import {decodeMessageId, type MessageRef} from '../ids.js';
import {isTemporaryAuthFailure} from '../imap-pool.js';

/** Extra fields imapflow and nodemailer attach to their errors. */
interface MailError extends Error {
  authenticationFailed?: boolean;
  responseText?: string;
  code?: string;
  response?: string;
}

export function json(value: unknown): CallToolResult {
  return {content: [{type: 'text', text: JSON.stringify(value, null, 2)}]};
}

export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // Safe: every MailError field is optional, so any Error satisfies the shape.
  const e: MailError = err;
  if (isTemporaryAuthFailure(err)) {
    return `The mail server is temporarily refusing logins (${e.responseText ?? e.response ?? e.message}). This usually means too many logins in a short time; wait a minute and try again.`;
  }
  if (e.authenticationFailed || e.code === 'EAUTH') {
    return `Authentication failed: ${e.responseText ?? e.response ?? e.message}. Check the username/password (many providers require an app password).`;
  }
  const detail = e.responseText ?? e.response;
  return detail ? `${e.message}: ${detail}` : e.message;
}

/** Wrap a handler so IMAP/SMTP failures reach the model as readable tool errors instead of protocol errors. */
export function safe<A>(
  fn: (args: A) => Promise<CallToolResult>
): (args: A) => Promise<CallToolResult> {
  return async args => {
    try {
      return await fn(args);
    } catch (err: unknown) {
      return {
        isError: true,
        content: [{type: 'text', text: describeError(err)}],
      };
    }
  };
}

interface ResolvedGroup {
  account: Account;
  folder: string;
  uids: number[];
}

/** Resolve a single message id to its account. */
export function resolveOne(
  registry: AccountRegistry,
  id: string
): {account: Account; ref: MessageRef} {
  const ref = decodeMessageId(id);
  return {account: registry.get(ref.accountId), ref};
}

/** Group message ids by account+folder so batch operations use one IMAP command per folder. */
export function groupIds(
  registry: AccountRegistry,
  ids: readonly string[]
): ResolvedGroup[] {
  const groups = new Map<string, ResolvedGroup>();
  for (const id of ids) {
    const {account, ref} = resolveOne(registry, id);
    const key = `${account.id}\u0000${ref.folder}`;
    const group = groups.get(key) ?? {account, folder: ref.folder, uids: []};
    group.uids.push(ref.uid);
    groups.set(key, group);
  }
  return [...groups.values()];
}
