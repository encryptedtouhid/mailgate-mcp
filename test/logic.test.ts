import {describe, expect, it} from 'vitest';
import {prefixSubject, quoteText, replyRecipients} from '../src/compose.js';
import {tokenMatches} from '../src/http.js';
import {decodeMessageId, encodeMessageId} from '../src/ids.js';
import {buildSearchCriteria, pickNewest} from '../src/search.js';

describe('message ids', () => {
  it('round-trips folders containing the separator', () => {
    const ref = {accountId: 'work', folder: 'Clients|2024/Acme', uid: 42};
    expect(decodeMessageId(encodeMessageId(ref))).toEqual(ref);
  });

  it('rejects malformed ids', () => {
    for (const bad of [
      '',
      'work',
      'work|INBOX',
      'work|INBOX|x',
      '|INBOX|1',
      'work||1',
    ]) {
      expect(() => decodeMessageId(bad)).toThrow();
    }
  });
});

describe('search criteria', () => {
  it('matches everything when empty', () => {
    expect(buildSearchCriteria({})).toEqual({all: true});
  });

  it('maps filters and free text', () => {
    const c = buildSearchCriteria({
      query: 'invoice',
      from: 'bob',
      since: '2026-01-01',
      unreadOnly: true,
    });
    expect(c.from).toBe('bob');
    expect(c.seen).toBe(false);
    expect(c.since).toEqual(new Date('2026-01-01'));
    expect(c.or).toHaveLength(4);
  });

  it('rejects bad dates', () => {
    expect(() => buildSearchCriteria({before: 'yesterday'})).toThrow(
      /Invalid before date/
    );
  });

  it('picks newest uids first', () => {
    expect(pickNewest([3, 10, 7, 1], 2)).toEqual([10, 7]);
  });
});

describe('reply composition', () => {
  const me = 'me@x.com';
  const original = {
    from: [{name: 'Bob', address: 'bob@y.com'}],
    replyTo: [],
    to: [{address: 'me@x.com'}, {address: 'carol@y.com'}],
    cc: [{address: 'dave@y.com'}, {address: 'bob@y.com'}],
  };

  it('replies to sender only by default', () => {
    expect(replyRecipients(original, me, false)).toEqual({
      to: ['"Bob" <bob@y.com>'],
      cc: [],
    });
  });

  it('reply-all excludes self and duplicates', () => {
    expect(replyRecipients(original, me, true).cc).toEqual([
      'carol@y.com',
      'dave@y.com',
    ]);
  });

  it('prefers Reply-To', () => {
    const r = replyRecipients(
      {...original, replyTo: [{address: 'list@y.com'}]},
      me,
      false
    );
    expect(r.to).toEqual(['list@y.com']);
  });

  it('replying to own sent mail goes to the original recipients', () => {
    const sent = {
      from: [{address: me}],
      replyTo: [],
      to: [{address: 'bob@y.com'}],
      cc: [],
    };
    expect(replyRecipients(sent, me, false).to).toEqual(['bob@y.com']);
  });

  it('prefixes subjects once', () => {
    expect(prefixSubject('Hello', 'Re')).toBe('Re: Hello');
    expect(prefixSubject('RE: Hello', 'Re')).toBe('RE: Hello');
    expect(prefixSubject('Fw: Hello', 'Fwd')).toBe('Fw: Hello');
  });

  it('quotes text', () => {
    expect(quoteText('a\nb', 'Bob', undefined)).toBe(
      'On an earlier date, Bob wrote:\n> a\n> b'
    );
  });
});

describe('auth token', () => {
  it('compares tokens safely', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abd')).toBe(false);
    expect(tokenMatches('abc', 'ab')).toBe(false);
    expect(tokenMatches('abc', undefined)).toBe(false);
  });
});
