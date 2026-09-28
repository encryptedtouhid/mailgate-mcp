/**
 * @fileoverview Known IMAP/SMTP server settings for popular email providers.
 */

export interface ServerSettings {
  host: string;
  port: number;
  /** true = implicit TLS (993/465). false = plain connection upgraded with STARTTLS (143/587). */
  secure: boolean;
}

export interface ProviderPreset {
  label: string;
  imap: ServerSettings;
  smtp: ServerSettings;
  /** Whether the server should append sent mail to the Sent folder itself. Gmail does this on its own. */
  saveToSent: boolean;
  notes?: string;
}

function ssl(host: string, port: number): ServerSettings {
  return {host, port, secure: true};
}

function starttls(host: string, port: number): ServerSettings {
  return {host, port, secure: false};
}

export const PRESETS: Readonly<Record<string, ProviderPreset>> = {
  privateemail: {
    label: 'Namecheap PrivateEmail',
    imap: ssl('mail.privateemail.com', 993),
    smtp: ssl('mail.privateemail.com', 465),
    saveToSent: true,
  },
  zoho: {
    label: 'Zoho Mail (free / personal, US datacenter)',
    imap: ssl('imap.zoho.com', 993),
    smtp: ssl('smtp.zoho.com', 465),
    saveToSent: true,
    notes:
      'Enable IMAP in Zoho Mail settings. If you use 2FA, create an app-specific password.',
  },
  'zoho-pro': {
    label: 'Zoho Mail (paid / custom-domain organization accounts)',
    imap: ssl('imappro.zoho.com', 993),
    smtp: ssl('smtppro.zoho.com', 465),
    saveToSent: true,
  },
  'zoho-eu': {
    label: 'Zoho Mail (EU datacenter)',
    imap: ssl('imap.zoho.eu', 993),
    smtp: ssl('smtp.zoho.eu', 465),
    saveToSent: true,
  },
  'zoho-in': {
    label: 'Zoho Mail (India datacenter)',
    imap: ssl('imap.zoho.in', 993),
    smtp: ssl('smtp.zoho.in', 465),
    saveToSent: true,
  },
  gmail: {
    label: 'Gmail / Google Workspace',
    imap: ssl('imap.gmail.com', 993),
    smtp: ssl('smtp.gmail.com', 465),
    saveToSent: false,
    notes:
      'Requires 2FA and an App Password (https://myaccount.google.com/apppasswords).',
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    imap: ssl('outlook.office365.com', 993),
    smtp: starttls('smtp.office365.com', 587),
    saveToSent: false,
    notes:
      'Microsoft has disabled password (basic) auth on most accounts; this only works where it is still allowed.',
  },
  yahoo: {
    label: 'Yahoo Mail',
    imap: ssl('imap.mail.yahoo.com', 993),
    smtp: ssl('smtp.mail.yahoo.com', 465),
    saveToSent: true,
    notes: 'Requires an app password.',
  },
  icloud: {
    label: 'iCloud Mail',
    imap: ssl('imap.mail.me.com', 993),
    smtp: starttls('smtp.mail.me.com', 587),
    saveToSent: true,
    notes: 'Requires an app-specific password from appleid.apple.com.',
  },
  fastmail: {
    label: 'Fastmail',
    imap: ssl('imap.fastmail.com', 993),
    smtp: ssl('smtp.fastmail.com', 465),
    saveToSent: true,
    notes: 'Requires an app password.',
  },
  titan: {
    label: 'Titan Email',
    imap: ssl('imap.titan.email', 993),
    smtp: ssl('smtp.titan.email', 465),
    saveToSent: true,
  },
  hostinger: {
    label: 'Hostinger Email',
    imap: ssl('imap.hostinger.com', 993),
    smtp: ssl('smtp.hostinger.com', 465),
    saveToSent: true,
  },
  godaddy: {
    label: 'GoDaddy Workspace Email',
    imap: ssl('imap.secureserver.net', 993),
    smtp: ssl('smtpout.secureserver.net', 465),
    saveToSent: true,
  },
  migadu: {
    label: 'Migadu',
    imap: ssl('imap.migadu.com', 993),
    smtp: ssl('smtp.migadu.com', 465),
    saveToSent: true,
  },
};

export function getPreset(
  name: string | undefined
): ProviderPreset | undefined {
  if (!name) return undefined;
  return PRESETS[name.trim().toLowerCase()];
}
