/**
 * Output discipline — the core of the machine-readable contract:
 *
 * - `--json` mode: `data()` writes pretty JSON to stdout; EVERYTHING else
 *   (progress, warnings, errors) goes to stderr, so stdout is always
 *   parseable (`eaf env list --json | jq …`).
 * - human mode: `data()` falls back to a compact JSON line; commands
 *   normally print one-liners and tables instead.
 * - T72 (R8): explanation of the payload is part of the human face —
 *   `explain()` puts it on stdout in human mode (stderr under --json,
 *   keeping stdout pipeable). Genuine operation logs stay on stderr in
 *   every mode (`warn()`); the two vocabulary entries are distinct on
 *   purpose: 【日志】vs【人读输出的组成部分】.
 */

import type { IO } from './io.js';

export class Output {
  constructor(
    private readonly io: IO,
    readonly json: boolean,
  ) {}

  /** Primary payload. JSON mode: pretty JSON on stdout. Human mode: one compact JSON line. */
  data(payload: unknown): void {
    if (this.json) {
      this.io.stdout(JSON.stringify(payload, null, 2) + '\n');
    } else {
      this.io.stdout(JSON.stringify(payload) + '\n');
    }
  }

  /** Human-oriented result line — stdout in human mode, suppressed in JSON mode. */
  line(message = ''): void {
    if (!this.json) this.io.stdout(message + '\n');
  }

  /** Progress/diagnostics — stderr in JSON mode, stdout in human mode. */
  info(message: string): void {
    if (this.json) this.io.stderr(message + '\n');
    else this.io.stdout(message + '\n');
  }

  /** Always stderr (warnings, errors). */
  warn(message: string): void {
    this.io.stderr(message + '\n');
  }

  /**
   * T72 (R8, u2-F1/F2 + u3-P2-F1 + u4-P1-2): explanatory content ABOUT the
   * payload this command just showed — drift markers, signability verdicts,
   * empty-window notes, throttling causes. This is part of the human OUTPUT
   * (R102: human ≥ json, on the stream the user actually reads and
   * captures), not a log: two rounds of "the human line is missing" were
   * really these lines riding stderr past every stdout capture. Human mode
   * → stdout; --json mode → stderr (stdout stays byte-pure for `| jq`).
   * Operational diagnostics (network retries, a skipped env in --all scans,
   * transient watch poll errors) are NOT payload explanation — those stay
   * on warn()/info().
   */
  explain(message: string): void {
    if (this.json) this.io.stderr(message + '\n');
    else this.io.stdout(message + '\n');
  }

  /** Compact aligned table (human mode only; callers use data() in JSON mode). */
  table(rows: Record<string, unknown>[], columns?: string[]): void {
    if (this.json) return;
    if (rows.length === 0) {
      this.io.stdout('(none)\n');
      return;
    }
    const cols = columns ?? [...new Set(rows.flatMap(row => Object.keys(row)))];
    const cells = rows.map(row => cols.map(col => stringifyCell(row[col])));
    const widths = cols.map((col, i) =>
      Math.max(col.length, ...cells.map(row => row[i].length)),
    );
    const render = (values: string[]): string =>
      values.map((value, i) => value.padEnd(widths[i])).join('  ').trimEnd();
    this.io.stdout(render(cols) + '\n');
    for (const row of cells) this.io.stdout(render(row) + '\n');
  }
}

function stringifyCell(value: unknown): string {
  if (value === undefined || value === null) return '-';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
