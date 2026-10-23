/**
 * Member roster parsing (member management UI) — turns a pasted roster
 * (one email per line, or a CSV-ish paste with commas/semicolons) into the
 * `emails` array accepted by POST /api/environments/:id/members:batch.
 *
 * Pure functions so the parsing is vitest-coverable without rendering.
 */

/**
 * Split a pasted roster into email tokens: newlines, commas and semicolons
 * are all separators (an Excel/Sheets column paste is newline-separated, a
 * CSV row paste is comma-separated). Tokens are trimmed, blanks dropped,
 * duplicates removed (first occurrence wins, case-insensitive — the server
 * lowercases before lookup).
 */
export function parseRosterEmails(text: string): string[] {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const token of text.split(/[\n,;]+/)) {
    const email = token.trim();
    if (email.length === 0) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }
  return emails;
}
