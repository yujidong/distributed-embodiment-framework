/**
 * Trailing `--lang` regression — `eaf env list --lang zh-CN` used to die in
 * the strict parser with "unknown option '--lang'" (exit 2): cli.ts's
 * stripGlobalFlags stripped `--server`/`--profile` but not `--lang`, and
 * args.ts's GLOBAL_FLAGS didn't list it either. Logged out, the command now
 * sails through parsing and fails at AUTH (exit 3) instead — no server
 * needed, the failure happens before any network I/O.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { run } from '../cli.js';

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), 'eaf-cli-lang-'));
  let stdout = '';
  let stderr = '';
  const code = await run(args, {
    env: { EAF_HOME: home, EAF_SERVER: 'http://127.0.0.1:1' },
    cwd: home,
    homeDir: home,
    isTTY: false,
    stdout: chunk => (stdout += chunk),
    stderr: chunk => (stderr += chunk),
  });
  return { code, stdout, stderr };
}

describe('trailing --lang (global flag)', () => {
  test('`eaf env list --lang zh-CN` parses (fails at auth, not at the parser)', async () => {
    const result = await cli('env', 'list', '--lang', 'zh-CN');
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('not logged in');
    expect(result.stderr).not.toMatch(/unknown option/i);
  });

  test('the --lang=<v> form parses too', async () => {
    const result = await cli('env', 'list', '--lang=zh-CN');
    expect(result.code).toBe(3);
    expect(result.stderr).not.toMatch(/unknown option/i);
  });

  test('a trailing --lang after the command GROUP is not mistaken for a subcommand', async () => {
    // `eaf notifications --lang zh-CN list`: the flag sits where the
    // subcommand is matched — stripping must happen before dispatch.
    const result = await cli('notifications', '--lang', 'zh-CN', 'list');
    expect(result.code).toBe(3);
    expect(result.stderr).not.toContain('unknown notifications subcommand');
  });

  test('command-specific unknown flags still error (the parser stays strict)', async () => {
    const result = await cli('env', 'list', '--bogus');
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown option/i);
  });
});
