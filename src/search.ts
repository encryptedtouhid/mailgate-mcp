/**
 * @fileoverview Translates friendly search parameters into IMAP SEARCH
 * criteria.
 */

import type {SearchObject} from 'imapflow';

export interface SearchParams {
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  before?: string;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
}

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${field} date "${value}". Use YYYY-MM-DD.`);
  }
  return date;
}

/** Translate friendly search params into an IMAP SEARCH object. Empty params match everything. */
export function buildSearchCriteria(params: SearchParams): SearchObject {
  const criteria: SearchObject = {};
  if (params.from) criteria.from = params.from;
  if (params.to) criteria.to = params.to;
  if (params.subject) criteria.subject = params.subject;
  if (params.since) criteria.since = parseDate(params.since, 'since');
  if (params.before) criteria.before = parseDate(params.before, 'before');
  if (params.unreadOnly) criteria.seen = false;
  if (params.flaggedOnly) criteria.flagged = true;
  if (params.query) {
    const q = params.query;
    criteria.or = [{subject: q}, {from: q}, {to: q}, {body: q}];
  }
  if (Object.keys(criteria).length === 0) criteria.all = true;
  return criteria;
}

/** Newest first, capped at limit. UIDs grow monotonically within a folder, so higher UID = newer arrival. */
export function pickNewest(uids: readonly number[], limit: number): number[] {
  return [...uids].sort((a, b) => b - a).slice(0, Math.max(0, limit));
}
