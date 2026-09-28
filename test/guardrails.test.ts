import {describe, expect, it} from 'vitest';
import {
  assertAllowed,
  checkRecipients,
  describeGuardrails,
  loadGuardrails,
} from '../src/guardrails.js';

describe('loadGuardrails', () => {
  it('allows everything except permanent delete by default', () => {
    const g = loadGuardrails({});
    expect(g).toEqual({
      allowSend: true,
      allowForward: true,
      allowDrafts: true,
      allowMark: true,
      allowMove: true,
      allowDelete: true,
      allowPermanentDelete: false,
      allowedRecipients: [],
      maxRecipients: 20,
    });
  });

  it('reads individual flags and treats blank as default', () => {
    const g = loadGuardrails({
      EMAIL_ALLOW_SEND: 'false',
      EMAIL_ALLOW_MARK: 'no',
      EMAIL_ALLOW_PERMANENT_DELETE: 'true',
      EMAIL_ALLOW_MOVE: '',
      EMAIL_ALLOWED_RECIPIENTS: ' navo.health , Bob@X.com ,',
      EMAIL_MAX_RECIPIENTS: '5',
    });
    expect(g.allowSend).toBe(false);
    expect(g.allowMark).toBe(false);
    expect(g.allowPermanentDelete).toBe(true);
    expect(g.allowMove).toBe(true);
    expect(g.allowedRecipients).toEqual(['navo.health', 'bob@x.com']);
    expect(g.maxRecipients).toBe(5);
  });

  it('forward and permanent delete depend on send and delete', () => {
    const g = loadGuardrails({
      EMAIL_ALLOW_SEND: 'false',
      EMAIL_ALLOW_DELETE: 'false',
      EMAIL_ALLOW_PERMANENT_DELETE: 'true',
    });
    expect(g.allowForward).toBe(false);
    expect(g.allowPermanentDelete).toBe(false);
  });

  it('EMAIL_READ_ONLY turns every write permission off', () => {
    const g = loadGuardrails({
      EMAIL_READ_ONLY: 'true',
      EMAIL_ALLOW_SEND: 'true',
      EMAIL_ALLOW_PERMANENT_DELETE: 'true',
    });
    expect(Object.values(describeGuardrails(g).permissions)).not.toContain(
      true
    );
  });

  it('rejects invalid values instead of guessing', () => {
    expect(() => loadGuardrails({EMAIL_ALLOW_SEND: 'maybe'})).toThrow(
      /EMAIL_ALLOW_SEND/
    );
    expect(() => loadGuardrails({EMAIL_MAX_RECIPIENTS: 'lots'})).toThrow(
      /EMAIL_MAX_RECIPIENTS/
    );
  });
});

describe('assertAllowed', () => {
  it('names the env flag in the error', () => {
    const g = loadGuardrails({EMAIL_ALLOW_MOVE: 'false'});
    expect(() => assertAllowed(g, 'move')).toThrow(/EMAIL_ALLOW_MOVE/);
    expect(() => assertAllowed(g, 'send')).not.toThrow();
  });
});

describe('checkRecipients', () => {
  it('allows anyone when the allowlist is empty', () => {
    const g = loadGuardrails({});
    expect(() => checkRecipients(g, ['a@anywhere.com'])).not.toThrow();
  });

  it('matches domains and exact addresses, including display-name form', () => {
    const g = loadGuardrails({
      EMAIL_ALLOWED_RECIPIENTS: '@navo.health,partner@x.com',
    });
    expect(() =>
      checkRecipients(g, ['Momini <momini.vl@NAVO.health>', 'partner@x.com'])
    ).not.toThrow();
    expect(() => checkRecipients(g, ['other@x.com'])).toThrow(/other@x.com/);
    expect(() => checkRecipients(g, ['a@evilnavo.health'])).toThrow();
  });

  it('enforces the recipient limit', () => {
    const g = loadGuardrails({EMAIL_MAX_RECIPIENTS: '2'});
    expect(() => checkRecipients(g, ['a@x.com', 'b@x.com', 'c@x.com'])).toThrow(
      /3 recipients/
    );
  });

  it('rejects unparseable addresses when an allowlist is set', () => {
    const g = loadGuardrails({EMAIL_ALLOWED_RECIPIENTS: 'x.com'});
    expect(() => checkRecipients(g, ['not an address'])).toThrow();
  });
});
