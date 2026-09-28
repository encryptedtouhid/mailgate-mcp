import {describe, expect, it} from 'vitest';
import {replyRecipients} from '../src/compose.js';
import {checkRecipients, loadGuardrails} from '../src/guardrails.js';
import {parseRecipients} from '../src/recipients.js';

describe('parseRecipients', () => {
  it('parses bare and display-name forms', () => {
    expect(parseRecipients(['a@x.com', 'Jane Doe <jane@y.com>'])).toEqual([
      {name: '', address: 'a@x.com'},
      {name: 'Jane Doe', address: 'jane@y.com'},
    ]);
  });

  it('resolves a quoted display name to the real delivery address', () => {
    expect(
      parseRecipients(['"<boss@allowed.com>" <attacker@evil.com>'])
    ).toEqual([{name: '<boss@allowed.com>', address: 'attacker@evil.com'}]);
  });

  it('rejects an entry that holds more than one address', () => {
    expect(() => parseRecipients(['<boss@allowed.com>, x@evil.com'])).toThrow(
      /exactly one address/
    );
    expect(() => parseRecipients(['team: a@x.com, b@x.com;'])).toThrow(
      /exactly one address/
    );
  });

  it('rejects entries that are not addresses', () => {
    for (const bad of ['', 'not an address', 'Jane <>', 'a@']) {
      expect(() => parseRecipients([bad])).toThrow();
    }
  });
});

describe('checkRecipients with parser-confusing input', () => {
  const g = loadGuardrails({EMAIL_ALLOWED_RECIPIENTS: 'allowed.com'});

  it('checks the address mail is actually delivered to', () => {
    expect(() =>
      checkRecipients(
        g,
        parseRecipients(['"<boss@allowed.com>" <attacker@evil.com>'])
      )
    ).toThrow(/attacker@evil.com/);
  });

  it('blocks a spoofed Reply-To on replies', () => {
    const {to} = replyRecipients(
      {
        from: [{address: 'mallory@evil.com'}],
        replyTo: [{name: '<ceo@allowed.com>', address: 'attacker@evil.com'}],
        to: [{address: 'me@allowed.com'}],
        cc: [],
      },
      'me@allowed.com',
      false
    );
    expect(() => checkRecipients(g, parseRecipients(to))).toThrow(
      /attacker@evil.com/
    );
  });

  it('keeps the address when a display name ends in a backslash', () => {
    const {to} = replyRecipients(
      {
        from: [{name: 'Bob\\', address: 'bob@allowed.com'}],
        replyTo: [],
        to: [],
        cc: [],
      },
      'me@allowed.com',
      false
    );
    expect(parseRecipients(to).map(r => r.address)).toEqual([
      'bob@allowed.com',
    ]);
  });
});
