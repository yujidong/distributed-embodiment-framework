/**
 * Fix-13 tests — R5-P2 CLI surface: `auth set-name` (F-02), `env deployment`
 * (小莽 F-05), and the services count on `env list` (小观 F-03).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-fix13-${stamp}`;
const PASSWORD = 'password-123';
const OWNER_EMAIL = `fix13-owner-${stamp}@example.com`;

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  expect(
    (await owner.cli('auth', 'register', '--email', OWNER_EMAIL, '--password', PASSWORD, '--name', 'Owner')).code,
  ).toBe(0);
  writeFileSync(
    join(owner.home, 'world.yaml'),
    `version: "1.0"
environment:
  name: ${WORLD_NAME}
  visibility: private
  map:
    type: grid
    zones:
      - id: room-a
        bounds: {minX: 0, maxX: 5, minY: 0, maxY: 5}
devices:
  - name: Sensor A
    zone: room-a
    spec:
      type: temperature-sensor
      capabilities: [temperature-reading]
`,
  );
  expect((await owner.cli('apply', '-f', 'world.yaml', '--json')).code).toBe(0);
});

afterAll(async () => {
  await server?.stop();
});

describe('auth set-name (Fix-13, R5 F-02)', () => {
  test('renames the account; whoami reflects it', async () => {
    const renamed = await owner.cli('auth', 'set-name', 'New Name');
    expect(renamed.code).toBe(0);
    expect(renamed.stdout).toContain('New Name');

    const me = await owner.cli('auth', 'whoami', '--json');
    expect(me.code).toBe(0);
    expect(me.json().displayName).toBe('New Name');
  });

  test('missing name is a usage error (exit 2)', async () => {
    const res = await owner.cli('auth', 'set-name');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('displayName');
  });
});

describe('env deployment (Fix-13, R5 小莽 F-05)', () => {
  test('--json returns the raw manifest', async () => {
    const res = await owner.cli('env', 'deployment', WORLD_NAME, '--json');
    expect(res.code).toBe(0);
    const manifest = res.json();
    expect(manifest.environment.name).toBe(WORLD_NAME);
    expect(manifest.devicesToDeploy).toHaveLength(1);
    expect(manifest.devicesToDeploy[0].name).toBe('Sensor A');
    expect(Array.isArray(manifest.servicesToOffer)).toBe(true);
    expect(Array.isArray(manifest.servicesConsumed)).toBe(true);
    expect(Array.isArray(manifest.notes)).toBe(true);
  });

  test('human mode prints the procurement summary sections', async () => {
    const res = await owner.cli('env', 'deployment', WORLD_NAME);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('deployment manifest');
    expect(res.stdout).toContain('devices to procure (1)');
    expect(res.stdout).toContain('Sensor A');
    expect(res.stdout).toContain('external services to sign');
  });

  test('non-member has no deployment (exit non-zero)', async () => {
    const stranger = makeCli(server.baseUrl);
    expect(
      (
        await stranger.cli(
          'auth', 'register', '--email', `fix13-stranger-${stamp}@example.com`,
          '--password', PASSWORD, '--name', 'Stranger',
        )
      ).code,
    ).toBe(0);
    // A private env is invisible to strangers — the env itself does not resolve.
    const res = await stranger.cli('env', 'deployment', WORLD_NAME);
    expect(res.code).not.toBe(0);
  });
});

describe('env list services count (Fix-13, R5 小观 F-03)', () => {
  test('--json counts carry services; the table shows the svc column', async () => {
    const json = await owner.cli('env', 'list', '--mine', '--json');
    expect(json.code).toBe(0);
    const entry = (json.json() as Array<{ name: string; counts: Record<string, number> }>)
      .find(env => env.name === WORLD_NAME);
    expect(entry).toBeDefined();
    expect(entry!.counts.services).toBeGreaterThanOrEqual(0);

    const table = await owner.cli('env', 'list', '--mine');
    expect(table.code).toBe(0);
    expect(table.stdout).toContain('svc');
  });
});
