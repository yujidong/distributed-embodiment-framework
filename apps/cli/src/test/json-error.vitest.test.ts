/**
 * T58 (R6, u2-F-2-3) — the `--json` error carrier.
 *
 * Before: a failing command under --json wrote NOTHING to stdout (the error
 * lived only on stderr as human text), so scripts could not programmatically
 * distinguish error codes — the machine-readable half of the three-channel
 * contract was broken on the failure path. Now stdout carries the structured
 * error (server body verbatim for API failures, stable CLI_* codes for
 * CLI-local ones) while stderr keeps the human line, and human mode is
 * byte-for-byte unchanged.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { run } from '../cli.js';
import { bootServer, type TestServer } from './helpers.js';

let server: TestServer;
let home: string;
const EMAIL = `json-err-${Date.now().toString(36)}@example.com`;
const PASSWORD = `pw-${Date.now().toString(36)}`;

beforeAll(async () => {
  server = await bootServer();
  home = mkdtempSync(join(tmpdir(), 'eaf-cli-jsonerr-'));
  const { io } = ioFor(home);
  const code = await run(
    ['auth', 'register', '--email', EMAIL, '--password', PASSWORD, '--display-name', 'JSON Err'],
    io,
  );
  expect(code).toBe(0);
});

afterAll(async () => {
  await server.stop();
});

function ioFor(homeDir: string) {
  const chunks = { stdout: '', stderr: '' };
  return {
    io: {
      env: { EAF_HOME: homeDir, EAF_SERVER: server.baseUrl },
      cwd: homeDir,
      homeDir: homeDir,
      isTTY: false,
      stdout: (chunk: string) => (chunks.stdout += chunk),
      stderr: (chunk: string) => (chunks.stderr += chunk),
    },
    chunks,
  };
}

async function cli(args: string[]) {
  const { io, chunks } = ioFor(home);
  const code = await run(args, io);
  return {
    code,
    stdout: chunks.stdout,
    stderr: chunks.stderr,
    json: () => JSON.parse(chunks.stdout),
  };
}

describe('T58: --json failures carry a structured error on stdout', () => {
  // T110 note: `agreement read` joined the T88 short-prefix family in R18 —
  // a not-found SHORT ref there resolves through the CLI roster and answers
  // the CLI_NOT_FOUND teaching (covered in prefix-get.vitest.test.ts).
  // T131: the verbatim server-error passthrough is probed on a FULL-LENGTH
  // UUID ref — T88's probe-then-roster used to rewrite those into
  // CLI_NOT_FOUND too; ctx.ts's canonical-UUID guard now rethrows the
  // server's own 404 (T58 verbatim), and the SHORT form keeps the teaching
  // (the two-state对拍 test below pins both).
  const MISSING_FULL_ID = '00000000-0000-4000-8000-000000000000';
  test('an API 404 passes the server error body through VERBATIM (code matches the REST face)', async () => {
    const res = await cli(['--json', 'agreement', 'counter', MISSING_FULL_ID, '--terms', '{}']);
    expect(res.code).toBe(4);
    const body = res.json(); // throws if stdout is not parseable JSON
    expect(body.error.code).toBe('AGREEMENT_NOT_FOUND');
    expect(typeof body.error.message).toBe('string');
    // stderr keeps the human line alongside (both faces coexist).
    expect(res.stderr).toContain('error:');
  });

  test('a CLI-local usage failure synthesizes the stable CLI_USAGE code', async () => {
    const res = await cli(['--json', 'sim', 'list']);
    expect(res.code).toBe(2);
    const body = res.json();
    expect(body.error.code).toBe('CLI_USAGE');
    expect(body.error.message).toContain('--env');
  });

  test('human mode output is unchanged: no JSON on stdout, the error on stderr', async () => {
    const res = await cli(['agreement', 'counter', MISSING_FULL_ID, '--terms', '{}']);
    expect(res.code).toBe(4);
    expect(() => res.json()).toThrow(); // stdout carries no JSON
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('AGREEMENT_NOT_FOUND');
  });

  test('T131 two-state对拍: a SHORT not-found ref keeps the CLI_NOT_FOUND roster teaching', async () => {
    const res = await cli(['--json', 'agreement', 'counter', 'agt-no-such-agreement', '--terms', '{}']);
    expect(res.code).toBe(4);
    const body = res.json();
    expect(body.error.code).toBe('CLI_NOT_FOUND');
    expect(body.error.message).toContain('none of the');
  });

  test('unreachable server under --json yields a parseable CLI_ERROR carrier', async () => {
    const { io, chunks } = ioFor(home); // logged-in session; the server is dead below
    // Point --server at a dead port; fetch fails fast with ECONNREFUSED.
    const code = await run(
      ['--json', '--server', 'http://127.0.0.1:1', 'env', 'list'],
      io,
    );
    expect(code).toBe(1);
    const body = JSON.parse(chunks.stdout);
    expect(body.error.code).toBe('CLI_ERROR');
    expect(body.error.message).toContain('server unreachable');
  });
});
