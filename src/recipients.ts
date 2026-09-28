/**
 * @fileoverview Parses recipient strings with nodemailer's own address
 * parser, so the addresses the guardrails check are exactly the addresses
 * mail is delivered to.
 */

// nodemailer only provides default exports.
import addressparser from 'nodemailer/lib/addressparser/index.js';

export interface Recipient {
  name: string;
  address: string;
}

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+$/;

/**
 * Each entry must hold exactly one address. A comma list or group in a single
 * entry is rejected, so the recipient limit counts real addresses.
 */
export function parseRecipients(entries: readonly string[]): Recipient[] {
  return entries.map(entry => {
    const parsed = addressparser(entry, {flatten: true});
    if (parsed.length !== 1) {
      throw new Error(
        `Recipient "${entry}" must contain exactly one address; list each address separately.`
      );
    }
    const {name, address} = parsed[0];
    if (!ADDRESS.test(address)) {
      throw new Error(`Invalid recipient "${entry}"`);
    }
    return {name, address};
  });
}
