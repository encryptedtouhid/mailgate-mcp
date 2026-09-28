/**
 * @fileoverview Guardrails from environment flags: which write actions the
 * MCP may perform, and who it may send mail to.
 */

import type {Recipient} from './recipients.js';

type Env = Record<string, string | undefined>;

export interface Guardrails {
  allowSend: boolean;
  allowForward: boolean;
  allowDrafts: boolean;
  allowMark: boolean;
  allowMove: boolean;
  allowDelete: boolean;
  allowPermanentDelete: boolean;
  /** Lowercased addresses or domains; empty means anyone. */
  allowedRecipients: string[];
  maxRecipients: number;
}

export type GuardedAction =
  | 'send'
  | 'forward'
  | 'drafts'
  | 'mark'
  | 'move'
  | 'delete'
  | 'permanentDelete';

interface ActionSpec {
  field: keyof Guardrails;
  envVar: string;
}

const ACTIONS: Readonly<Record<GuardedAction, ActionSpec>> = {
  send: {field: 'allowSend', envVar: 'EMAIL_ALLOW_SEND'},
  forward: {field: 'allowForward', envVar: 'EMAIL_ALLOW_FORWARD'},
  drafts: {field: 'allowDrafts', envVar: 'EMAIL_ALLOW_DRAFTS'},
  mark: {field: 'allowMark', envVar: 'EMAIL_ALLOW_MARK'},
  move: {field: 'allowMove', envVar: 'EMAIL_ALLOW_MOVE'},
  delete: {field: 'allowDelete', envVar: 'EMAIL_ALLOW_DELETE'},
  permanentDelete: {
    field: 'allowPermanentDelete',
    envVar: 'EMAIL_ALLOW_PERMANENT_DELETE',
  },
};

const DEFAULT_MAX_RECIPIENTS = 20;
const TRUE_VALUES = ['1', 'true', 'yes', 'on'];
const FALSE_VALUES = ['0', 'false', 'no', 'off'];

/** Reads a boolean flag; blank means `fallback`, anything unrecognized is an error. */
function flag(env: Env, key: string, fallback: boolean): boolean {
  const value = env[key]?.trim().toLowerCase();
  if (!value) return fallback;
  if (TRUE_VALUES.includes(value)) return true;
  if (FALSE_VALUES.includes(value)) return false;
  throw new Error(`${key} must be true or false, got "${env[key]}"`);
}

function maxRecipients(env: Env): number {
  const raw = env.EMAIL_MAX_RECIPIENTS?.trim();
  if (!raw) return DEFAULT_MAX_RECIPIENTS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `EMAIL_MAX_RECIPIENTS must be a positive whole number, got "${raw}"`
    );
  }
  return value;
}

export function loadGuardrails(env: Env): Guardrails {
  const readOnly = flag(env, 'EMAIL_READ_ONLY', false);
  function allow(key: string, fallback: boolean): boolean {
    return !readOnly && flag(env, key, fallback);
  }
  const allowSend = allow('EMAIL_ALLOW_SEND', true);
  const allowDelete = allow('EMAIL_ALLOW_DELETE', true);
  return {
    allowSend,
    allowForward: allowSend && allow('EMAIL_ALLOW_FORWARD', true),
    allowDrafts: allow('EMAIL_ALLOW_DRAFTS', true),
    allowMark: allow('EMAIL_ALLOW_MARK', true),
    allowMove: allow('EMAIL_ALLOW_MOVE', true),
    allowDelete,
    allowPermanentDelete:
      allowDelete && allow('EMAIL_ALLOW_PERMANENT_DELETE', false),
    allowedRecipients: (env.EMAIL_ALLOWED_RECIPIENTS ?? '')
      .split(',')
      .map(entry => entry.trim().toLowerCase())
      .filter(Boolean),
    maxRecipients: maxRecipients(env),
  };
}

export function isAllowed(g: Guardrails, action: GuardedAction): boolean {
  return g[ACTIONS[action].field] === true;
}

export function assertAllowed(g: Guardrails, action: GuardedAction): void {
  if (isAllowed(g, action)) return;
  throw new Error(
    `Blocked by guardrail: ${action} is disabled on this server ` +
      `(${ACTIONS[action].envVar}=false or EMAIL_READ_ONLY=true). ` +
      'Tell the user; only they can change it.'
  );
}

function recipientAllowed(address: string, allowlist: string[]): boolean {
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return allowlist.some(entry => {
    if (entry === '*') return true;
    if (entry.startsWith('@')) return domain === entry.slice(1);
    if (entry.includes('@')) return address === entry;
    return domain === entry;
  });
}

/** Checks parsed recipients (see parseRecipients), which are exactly what gets delivered. */
export function checkRecipients(
  g: Guardrails,
  recipients: readonly Recipient[]
): void {
  if (recipients.length > g.maxRecipients) {
    throw new Error(
      `Blocked by guardrail: ${recipients.length} recipients exceeds ` +
        `EMAIL_MAX_RECIPIENTS=${g.maxRecipients}.`
    );
  }
  if (g.allowedRecipients.length === 0) return;
  const blocked = recipients
    .map(r => r.address.toLowerCase())
    .filter(address => !recipientAllowed(address, g.allowedRecipients));
  if (blocked.length > 0) {
    throw new Error(
      `Blocked by guardrail: ${blocked.join(', ')} not in ` +
        `EMAIL_ALLOWED_RECIPIENTS (${g.allowedRecipients.join(', ')}).`
    );
  }
}

/** Summary shown to the model via list_accounts so it knows its limits up front. */
export function describeGuardrails(g: Guardrails) {
  const permissions: Record<string, boolean> = {};
  for (const action of Object.keys(ACTIONS) as GuardedAction[]) {
    permissions[action] = isAllowed(g, action);
  }
  return {
    permissions,
    allowedRecipients:
      g.allowedRecipients.length > 0 ? g.allowedRecipients : 'anyone',
    maxRecipients: g.maxRecipients,
  };
}
