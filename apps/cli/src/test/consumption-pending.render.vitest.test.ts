/**
 * T129 (R21-F1) — the consumption-lane pending-503 render faces.
 *
 * The server answers a stalled world-session targeting with 503
 * CONSUMPTION_TARGET_PENDING (invoke lane) / READ_TARGETING_PENDING
 * (read lane) + retryAfterSec + teaching. The CLI surfaces the server
 * envelope VERBATIM (`--json` stdout) with the human line on stderr —
 * R102: the human face must carry the failure reason AND the pointer,
 * never less than --json. These fixtures drive the exported `reportError`
 * pure function with the exact shapes the server serializes
 * (errorBody(code, message, undefined, { retryAfterSec })) and pin both
 * faces, so a CLI-side regression (a human line losing the reason or the
 * pointer) goes red here.
 */

import { describe, expect, test } from 'vitest';

import { reportError } from '../cli.js';
import { CliError, EXIT } from '../errors.js';
import type { IO } from '../io.js';

function captureIO(): { io: IO; chunks: { stdout: string; stderr: string } } {
  const chunks = { stdout: '', stderr: '' };
  return {
    io: {
      env: {},
      cwd: '.',
      homeDir: '.',
      isTTY: false,
      stdout: (chunk: string) => (chunks.stdout += chunk),
      stderr: (chunk: string) => (chunks.stderr += chunk),
    },
    chunks,
  };
}

/** A server 503 as the client layer wraps it (apiBody = the raw body). */
function api503(code: string, message: string): CliError {
  return new CliError(
    `${message} [${code}]`,
    EXIT.ERROR,
    undefined,
    { error: { code, message, retryAfterSec: 30 } },
  );
}

const INVOKE_TARGETING_503 = api503(
  'CONSUMPTION_TARGET_PENDING',
  "The invocation's world targeting is still pending — the environment's authoritative world session " +
    'is being woken / caught up to wall-now … The invocation KEEPS RUNNING server-side: its usage row ' +
    'and receipt land when targeting and execution complete — check `eaf agreement usage <id>` … ' +
    '本次调用的世界定向仍在进行……不要重复 invoke（会重复执行动作）。',
);

const READ_TARGETING_503 = api503(
  'READ_TARGETING_PENDING',
  "This read's world targeting is still pending … Nothing was metered (reads only meter a delivered " +
    'frame) and a read is safe to retry in a moment — it never double-executes; if it keeps pending, ' +
    'inspect the world session with `eaf env session status <envId>` … ' +
    '本次读取的世界定向仍在进行……本次未计量；读取稍后重试即可（读不会重复执行）……',
);

describe('T129 render contract: the consumption pending-503s on the CLI faces', () => {
  test('invoke targeting 503: human stderr carries the reason + the usage pointer; --json carries code + retryAfterSec', () => {
    const human = captureIO();
    const code = reportError(human.io, INVOKE_TARGETING_503, false);
    expect(code).toBe(EXIT.ERROR);
    expect(human.chunks.stderr).toContain('CONSUMPTION_TARGET_PENDING');
    expect(human.chunks.stderr).toContain('world targeting is still pending'); // the reason
    expect(human.chunks.stderr).toContain('agreement usage'); // the pointer
    expect(human.chunks.stderr).toContain('不要重复 invoke'); // the zh teaching (R102 zh-first)
    expect(human.chunks.stdout).toBe(''); // human mode: no JSON on stdout

    const json = captureIO();
    const jsonCode = reportError(json.io, INVOKE_TARGETING_503, true);
    expect(jsonCode).toBe(EXIT.ERROR);
    const body = JSON.parse(json.chunks.stdout) as { error: { code: string; retryAfterSec: number } };
    expect(body.error.code).toBe('CONSUMPTION_TARGET_PENDING');
    expect(body.error.retryAfterSec).toBe(30);
  });

  test('read targeting 503: human stderr carries the reason + the not-metered/retry teaching; --json verbatim', () => {
    const human = captureIO();
    const code = reportError(human.io, READ_TARGETING_503, false);
    expect(code).toBe(EXIT.ERROR);
    expect(human.chunks.stderr).toContain('READ_TARGETING_PENDING');
    expect(human.chunks.stderr).toContain('world targeting is still pending');
    expect(human.chunks.stderr).toContain('Nothing was metered');
    expect(human.chunks.stderr).toContain('eaf env session status');
    expect(human.chunks.stderr).toContain('读不会重复执行');
    expect(human.chunks.stdout).toBe('');

    const json = captureIO();
    reportError(json.io, READ_TARGETING_503, true);
    const body = JSON.parse(json.chunks.stdout) as { error: { code: string; retryAfterSec: number } };
    expect(body.error.code).toBe('READ_TARGETING_PENDING');
    expect(body.error.retryAfterSec).toBe(30);
  });
});
