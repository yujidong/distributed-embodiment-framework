/**
 * lib/memberRoster tests — pasted-roster parsing for the batch-import
 * dialog: newline / comma / semicolon separators, trimming, blank drops,
 * case-insensitive dedupe (the server lowercases before the email lookup).
 */

import { describe, expect, it } from 'vitest';

import { parseRosterEmails } from '../lib/memberRoster';

describe('parseRosterEmails', () => {
  it('parses one email per line (spreadsheet column paste)', () => {
    expect(parseRosterEmails('a@x.com\nb@x.com\nc@x.com')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
    ]);
  });

  it('accepts comma and semicolon separators (CSV row paste)', () => {
    expect(parseRosterEmails('a@x.com, b@x.com;c@x.com')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
    ]);
  });

  it('trims whitespace and drops blank tokens', () => {
    expect(parseRosterEmails('  a@x.com \n\n, ,\n\tb@x.com\r\n')).toEqual([
      'a@x.com',
      'b@x.com',
    ]);
  });

  it('dedupes case-insensitively, keeping the first occurrence', () => {
    expect(parseRosterEmails('A@x.com\na@x.com\nB@x.com')).toEqual(['A@x.com', 'B@x.com']);
  });

  it('returns an empty list for empty / separator-only input', () => {
    expect(parseRosterEmails('')).toEqual([]);
    expect(parseRosterEmails(' \n,;\n ')).toEqual([]);
  });
});
