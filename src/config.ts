/**
 * @fileoverview Loads email accounts from environment variables or a JSON
 * file and resolves provider presets into concrete server settings.
 */

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {z} from 'zod';
import {getPreset, PRESETS, type ServerSettings} from './presets.js';

export interface Account {
  id: string;
  email: string;
  displayName?: string;
  imap: ServerSettings & {user: string; password: string};
  smtp: ServerSettings & {user: string; password: string};
  saveToSent: boolean;
  /** Set false only for self-signed servers (e.g. Proton Bridge on localhost). */
  tlsRejectUnauthorized: boolean;
}

const SERVER_SCHEMA = z
  .object({
    host: z.string().min(1).optional(),
    port: z.coerce.number().int().positive().optional(),
    secure: z.boolean().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
  })
  .optional();

const RAW_ACCOUNT_SCHEMA = z.object({
  id: z.string().min(1).optional(),
  provider: z.string().optional(),
  email: z.string().email(),
  displayName: z.string().optional(),
  user: z.string().optional(),
  password: z.string().min(1),
  imap: SERVER_SCHEMA,
  smtp: SERVER_SCHEMA,
  saveToSent: z.boolean().optional(),
  tlsRejectUnauthorized: z.boolean().optional(),
});

export type RawAccount = z.infer<typeof RAW_ACCOUNT_SCHEMA>;
type Env = Record<string, string | undefined>;

/** Values like "env:ZOHO_PASSWORD" are read from the environment so secrets can stay out of accounts.json. */
function resolveSecret(value: string, env: Env): string {
  if (!value.startsWith('env:')) return value;
  const name = value.slice(4);
  const resolved = env[name];
  if (!resolved) {
    throw new Error(
      `Environment variable ${name} referenced in account config is not set`
    );
  }
  return resolved;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function slug(email: string): string {
  return email
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function normalizeAccount(raw: RawAccount, env: Env = {}): Account {
  const preset = getPreset(raw.provider);
  if (raw.provider && !preset && raw.provider.toLowerCase() !== 'custom') {
    throw new Error(
      `Unknown provider "${raw.provider}" for ${raw.email}. Use one of: ${Object.keys(PRESETS).join(', ')}, custom`
    );
  }
  const password = resolveSecret(raw.password, env);
  const user = raw.user ?? raw.email;

  function build(kind: 'imap' | 'smtp') {
    const override = raw[kind] ?? {};
    const base = preset?.[kind];
    const host = override.host ?? base?.host;
    if (!host) {
      throw new Error(
        `${kind.toUpperCase()} host missing for ${raw.email}: set "provider" or "${kind}.host"`
      );
    }
    const defaultPort = kind === 'imap' ? 993 : 465;
    const port = override.port ?? base?.port ?? defaultPort;
    const secure =
      override.secure ?? base?.secure ?? (port === 993 || port === 465);
    return {
      host,
      port,
      secure,
      user: override.user ?? user,
      password: override.password
        ? resolveSecret(override.password, env)
        : password,
    };
  }

  return {
    id: raw.id ?? slug(raw.email),
    email: raw.email,
    displayName: raw.displayName,
    imap: build('imap'),
    smtp: build('smtp'),
    saveToSent: raw.saveToSent ?? preset?.saveToSent ?? true,
    tlsRejectUnauthorized: raw.tlsRejectUnauthorized ?? true,
  };
}

function accountFromEnv(env: Env): RawAccount | undefined {
  // Blank lines like `IMAP_HOST=` in .env mean "not set".
  function value(key: string): string | undefined {
    const trimmed = env[key]?.trim();
    return trimmed ? trimmed : undefined;
  }
  function port(key: string): number | undefined {
    const raw = value(key);
    return raw ? Number(raw) : undefined;
  }
  const email = value('EMAIL_ADDRESS');
  if (!email) return undefined;
  return RAW_ACCOUNT_SCHEMA.parse({
    id: value('EMAIL_ACCOUNT_ID'),
    provider: value('EMAIL_PROVIDER'),
    email,
    displayName: value('EMAIL_DISPLAY_NAME'),
    user: value('EMAIL_USERNAME'),
    password: env.EMAIL_PASSWORD,
    imap: {
      host: value('IMAP_HOST'),
      port: port('IMAP_PORT'),
      secure: parseBool(value('IMAP_SECURE')),
    },
    smtp: {
      host: value('SMTP_HOST'),
      port: port('SMTP_PORT'),
      secure: parseBool(value('SMTP_SECURE')),
    },
    saveToSent: parseBool(value('EMAIL_SAVE_TO_SENT')),
    tlsRejectUnauthorized: parseBool(value('EMAIL_TLS_REJECT_UNAUTHORIZED')),
  });
}

export function loadAccounts(
  env: Env = process.env,
  readFile = (p: string) => readFileSync(p, 'utf8')
): Account[] {
  const raws: RawAccount[] = [];

  const json =
    env.EMAIL_ACCOUNTS ??
    (env.EMAIL_ACCOUNTS_FILE
      ? readFile(resolve(env.EMAIL_ACCOUNTS_FILE))
      : undefined);
  if (json) {
    const parsed = z.array(RAW_ACCOUNT_SCHEMA).safeParse(JSON.parse(json));
    if (!parsed.success) {
      throw new Error(`Invalid accounts config: ${parsed.error.message}`);
    }
    raws.push(...parsed.data);
  }

  const fromEnv = accountFromEnv(env);
  if (fromEnv) raws.push(fromEnv);

  if (raws.length === 0) {
    throw new Error(
      'No email account configured. Set EMAIL_ADDRESS/EMAIL_PASSWORD/EMAIL_PROVIDER, or EMAIL_ACCOUNTS_FILE. See README.md.'
    );
  }

  const accounts = raws.map(r => normalizeAccount(r, env));
  const ids = new Set<string>();
  for (const a of accounts) {
    if (ids.has(a.id)) throw new Error(`Duplicate account id "${a.id}"`);
    ids.add(a.id);
  }
  return accounts;
}

export class AccountRegistry {
  constructor(private readonly accounts: readonly Account[]) {}

  list(): readonly Account[] {
    return this.accounts;
  }

  /** Resolve by id or email; defaults to the first account. */
  get(idOrEmail?: string): Account {
    if (!idOrEmail) return this.accounts[0];
    const key = idOrEmail.toLowerCase();
    const found = this.accounts.find(
      a => a.id.toLowerCase() === key || a.email.toLowerCase() === key
    );
    if (!found) {
      throw new Error(
        `Unknown account "${idOrEmail}". Available: ${this.accounts.map(a => a.id).join(', ')}`
      );
    }
    return found;
  }
}
