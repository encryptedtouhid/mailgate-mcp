import {describe, expect, it} from 'vitest';
import {
  AccountRegistry,
  loadAccounts,
  normalizeAccount,
} from '../src/config.js';

describe('normalizeAccount', () => {
  it('applies provider presets', () => {
    const a = normalizeAccount({
      provider: 'privateemail',
      email: 'me@mydomain.com',
      password: 'pw',
    });
    expect(a.id).toBe('me-mydomain-com');
    expect(a.imap).toMatchObject({
      host: 'mail.privateemail.com',
      port: 993,
      secure: true,
      user: 'me@mydomain.com',
      password: 'pw',
    });
    expect(a.smtp).toMatchObject({
      host: 'mail.privateemail.com',
      port: 465,
      secure: true,
    });
    expect(a.saveToSent).toBe(true);
  });

  it('lets explicit settings override the preset', () => {
    const a = normalizeAccount({
      provider: 'zoho',
      email: 'a@b.com',
      password: 'pw',
      smtp: {port: 587, secure: false},
    });
    expect(a.smtp).toMatchObject({
      host: 'smtp.zoho.com',
      port: 587,
      secure: false,
    });
  });

  it('supports fully custom servers and infers TLS from port', () => {
    const a = normalizeAccount({
      email: 'a@b.com',
      password: 'pw',
      imap: {host: 'imap.b.com'},
      smtp: {host: 'smtp.b.com', port: 587},
    });
    expect(a.imap).toMatchObject({host: 'imap.b.com', port: 993, secure: true});
    expect(a.smtp).toMatchObject({
      host: 'smtp.b.com',
      port: 587,
      secure: false,
    });
  });

  it('resolves env: password references', () => {
    const a = normalizeAccount(
      {provider: 'gmail', email: 'a@gmail.com', password: 'env:GMAIL_PW'},
      {GMAIL_PW: 'secret'}
    );
    expect(a.imap.password).toBe('secret');
    expect(a.saveToSent).toBe(false);
  });

  it('rejects unknown providers and missing hosts', () => {
    expect(() =>
      normalizeAccount({provider: 'nope', email: 'a@b.com', password: 'pw'})
    ).toThrow(/Unknown provider/);
    expect(() => normalizeAccount({email: 'a@b.com', password: 'pw'})).toThrow(
      /IMAP host missing/
    );
  });
});

describe('loadAccounts', () => {
  it('reads a single account from env vars', () => {
    const [a] = loadAccounts({
      EMAIL_ADDRESS: 'me@x.com',
      EMAIL_PASSWORD: 'pw',
      EMAIL_PROVIDER: 'zoho-pro',
      SMTP_PORT: '587',
    });
    expect(a.imap.host).toBe('imappro.zoho.com');
    expect(a.smtp.port).toBe(587);
  });

  it('treats blank env values as unset', () => {
    const [a] = loadAccounts({
      EMAIL_ADDRESS: 'me@x.com',
      EMAIL_PASSWORD: 'pw',
      EMAIL_PROVIDER: 'privateemail',
      EMAIL_USERNAME: '',
      IMAP_HOST: '',
      IMAP_PORT: '',
      SMTP_SECURE: ' ',
    });
    expect(a.imap).toMatchObject({
      host: 'mail.privateemail.com',
      port: 993,
      user: 'me@x.com',
    });
    expect(a.smtp.secure).toBe(true);
  });

  it('reads multiple accounts from a JSON file', () => {
    const file = JSON.stringify([
      {
        id: 'work',
        provider: 'privateemail',
        email: 'me@work.com',
        password: 'env:W',
      },
      {id: 'home', provider: 'zoho', email: 'me@home.com', password: 'p2'},
    ]);
    const accounts = loadAccounts(
      {EMAIL_ACCOUNTS_FILE: 'accounts.json', W: 'p1'},
      () => file
    );
    const registry = new AccountRegistry(accounts);
    expect(registry.get().id).toBe('work');
    expect(registry.get('ME@HOME.COM').id).toBe('home');
    expect(() => registry.get('other')).toThrow(/Unknown account/);
  });

  it('fails clearly when nothing is configured', () => {
    expect(() => loadAccounts({})).toThrow(/No email account configured/);
  });
});
