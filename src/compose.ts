/**
 * @fileoverview Pure helpers for building replies and forwards: subjects,
 * recipient lists and quoted text.
 */

export interface Addr {
  name?: string;
  address?: string;
}

export function prefixSubject(subject: string, prefix: 'Re' | 'Fwd'): string {
  const pattern = prefix === 'Re' ? /^\s*re\s*:/i : /^\s*(fwd?|fw)\s*:/i;
  return pattern.test(subject) ? subject : `${prefix}: ${subject}`;
}

function format(a: Addr): string {
  return a.name
    ? `"${a.name.replace(/\\/g, '').replace(/"/g, "'")}" <${a.address}>`
    : (a.address ?? '');
}

function uniqueExcluding(
  addrs: readonly Addr[],
  exclude: Set<string>
): string[] {
  const out: string[] = [];
  for (const a of addrs) {
    const key = a.address?.toLowerCase();
    if (!key || exclude.has(key)) continue;
    exclude.add(key);
    out.push(format(a));
  }
  return out;
}

/** Work out reply recipients the way mail clients do: Reply-To (or From), plus everyone else for reply-all, minus yourself. */
export function replyRecipients(
  original: {from: Addr[]; replyTo: Addr[]; to: Addr[]; cc: Addr[]},
  ownAddress: string,
  replyAll: boolean
): {to: string[]; cc: string[]} {
  const own = ownAddress.toLowerCase();
  const primary =
    original.replyTo.length > 0 ? original.replyTo : original.from;
  const fromSelf = primary.every(a => a.address?.toLowerCase() === own);
  // Replying to your own sent message should go back to its recipients.
  const seen = new Set<string>(fromSelf ? [] : [own]);
  const to = uniqueExcluding(fromSelf ? original.to : primary, seen);
  seen.add(own);
  const cc = replyAll
    ? uniqueExcluding([...original.to, ...original.cc], seen)
    : [];
  return {to, cc};
}

export function quoteText(
  text: string,
  fromText: string,
  date: Date | undefined
): string {
  const header = `On ${date ? date.toUTCString() : 'an earlier date'}, ${fromText} wrote:`;
  const quoted = text
    .trimEnd()
    .split(/\r?\n/)
    .map(line => `> ${line}`)
    .join('\n');
  return `${header}\n${quoted}`;
}

export function forwardBlock(o: {
  fromText: string;
  date?: Date;
  subject: string;
  toText: string;
  text: string;
}): string {
  return [
    '---------- Forwarded message ----------',
    `From: ${o.fromText}`,
    `Date: ${o.date ? o.date.toUTCString() : ''}`,
    `Subject: ${o.subject}`,
    `To: ${o.toText}`,
    '',
    o.text,
  ].join('\n');
}
