/**
 * @fileoverview Stable message ids in the form "<accountId>|<folder>|<uid>".
 * Folder names may contain any character, so decoding splits on the first
 * and last separator only.
 */

export interface MessageRef {
  accountId: string;
  folder: string;
  uid: number;
}

const SEP = '|';

export function encodeMessageId(ref: MessageRef): string {
  return `${ref.accountId}${SEP}${ref.folder}${SEP}${ref.uid}`;
}

export function decodeMessageId(id: string): MessageRef {
  const first = id.indexOf(SEP);
  const last = id.lastIndexOf(SEP);
  if (first <= 0 || last === first) {
    throw new Error(`Invalid message id "${id}"`);
  }
  const uid = Number(id.slice(last + 1));
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error(`Invalid message id "${id}"`);
  }
  const folder = id.slice(first + 1, last);
  if (!folder) throw new Error(`Invalid message id "${id}"`);
  return {accountId: id.slice(0, first), folder, uid};
}
