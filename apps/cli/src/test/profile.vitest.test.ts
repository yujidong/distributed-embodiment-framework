/**
 * Profile tests (Fix-10) — `--profile` / `$EAF_PROFILE` keep several login
 * sessions side by side in one EAF_HOME (config.json + config-<name>.json).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let eaf: CliRunner;
const stamp = Date.now().toString(36);
const PASSWORD = 'password-123';
const EMAIL_DEFAULT = `prof-default-${stamp}@example.com`;
const EMAIL_WORK = `prof-work-${stamp}@example.com`;

beforeAll(async () => {
  server = await bootServer();
  eaf = makeCli(server.baseUrl);
});

afterAll(async () => {
  await server?.stop();
});

function configFile(name: string): { server?: string; token?: string } {
  return JSON.parse(readFileSync(join(eaf.home, name), 'utf8'));
}

describe('profiles', () => {
  test('default and --profile sessions live in separate files and never clobber', async () => {
    const registeredDefault = await eaf.cli(
      'auth', 'register', '--email', EMAIL_DEFAULT, '--password', PASSWORD, '--name', 'Default User', '--json',
    );
    expect(registeredDefault.code).toBe(0);
    expect(registeredDefault.json().profile).toBeNull();

    // Trailing --profile on login.
    const registeredWork = await eaf.cli(
      'auth', 'register', '--email', EMAIL_WORK, '--password', PASSWORD, '--name', 'Work User',
      '--profile', 'work', '--json',
    );
    expect(registeredWork.code).toBe(0);
    expect(registeredWork.json().profile).toBe('work');

    expect(existsSync(join(eaf.home, 'config.json'))).toBe(true);
    expect(existsSync(join(eaf.home, 'config-work.json'))).toBe(true);
    const defaultToken = configFile('config.json').token;
    const workToken = configFile('config-work.json').token;
    expect(defaultToken).toBeTruthy();
    expect(workToken).toBeTruthy();
    expect(workToken).not.toBe(defaultToken);

    // whoami resolves each profile independently (trailing flag form).
    const meDefault = (await eaf.cli('auth', 'whoami', '--json')).json();
    expect(meDefault.email).toBe(EMAIL_DEFAULT);
    expect(meDefault.profile).toBeNull();
    const meWork = (await eaf.cli('auth', 'whoami', '--profile', 'work', '--json')).json();
    expect(meWork.email).toBe(EMAIL_WORK);
    expect(meWork.profile).toBe('work');

    // Human mode names the profile — (default) when none is active.
    expect((await eaf.cli('auth', 'whoami')).stdout).toContain('(profile (default))');
    expect((await eaf.cli('auth', 'whoami', '--profile', 'work')).stdout).toContain('(profile work)');
  });

  test('leading --profile works like the trailing form', async () => {
    const me = await eaf.cli('--profile', 'work', 'auth', 'whoami', '--json');
    expect(me.code).toBe(0);
    expect(me.json().email).toBe(EMAIL_WORK);
    const meEquals = await eaf.cli('--profile=work', 'auth', 'whoami', '--json');
    expect(meEquals.json().email).toBe(EMAIL_WORK);
  });

  test('EAF_PROFILE selects the session; the flag wins over the env var', async () => {
    const envRunner = makeCli(server.baseUrl, { env: { EAF_PROFILE: 'work' }, home: eaf.home });
    const me = await envRunner.cli('auth', 'whoami', '--json');
    expect(me.code).toBe(0);
    expect(me.json().email).toBe(EMAIL_WORK);
    expect(me.json().profile).toBe('work');

    // Flag beats EAF_PROFILE: log the default user into a third profile and
    // select it explicitly while EAF_PROFILE points at "work".
    expect(
      (await eaf.cli('auth', 'login', '--email', EMAIL_DEFAULT, '--password', PASSWORD, '--profile', 'alt')).code,
    ).toBe(0);
    const flagged = await envRunner.cli('auth', 'whoami', '--profile', 'alt', '--json');
    expect(flagged.json().email).toBe(EMAIL_DEFAULT);
    expect(flagged.json().profile).toBe('alt');
  });

  test('invalid profile names are usage errors (exit 2)', async () => {
    for (const bad of ['../evil', 'bad name', 'a/b', '']) {
      const result = await eaf.cli('auth', 'whoami', `--profile=${bad}`);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('invalid profile name');
    }
    const envRunner = makeCli(server.baseUrl, { env: { EAF_PROFILE: '../evil' }, home: eaf.home });
    expect((await envRunner.cli('auth', 'whoami')).code).toBe(2);
  });

  test('logout clears only the active profile', async () => {
    const out = await eaf.cli('auth', 'logout', '--profile', 'work');
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('profile work');
    // Token gone from config-work.json, intact in config.json.
    expect(configFile('config-work.json').token).toBeUndefined();
    expect(configFile('config.json').token).toBeTruthy();
    expect((await eaf.cli('auth', 'whoami', '--profile', 'work')).code).toBe(3);
    expect((await eaf.cli('auth', 'whoami')).code).toBe(0);
    // The default profile's logout output stays profile-free.
    const defaultOut = await eaf.cli('auth', 'logout');
    expect(defaultOut.stdout).not.toContain('profile');
    expect((await eaf.cli('auth', 'login', '--email', EMAIL_DEFAULT, '--password', PASSWORD)).code).toBe(0);
  });
});
