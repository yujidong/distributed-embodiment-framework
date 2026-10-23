/**
 * Fix-18 CLI tests (R7 deployment-hardening batch) —
 * - F-17: global flags trailing a command GROUP (`eaf notifications
 *   --profile chen list`) are stripped before subcommand matching;
 * - F-04: `auth register --display-name` aliases the API field displayName
 *   (--name stays compatible);
 * - F-01: `device add --binding hass://…` rides the proposal pipeline and
 *   the CLI says owner approval is required;
 * - F-05: `env deployment` shows each device's binding/deploymentStatus and
 *   the twin-sync summary.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
let builder: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-fix18-${stamp}`;
const PASSWORD = `pw-${Date.now().toString(36)}`;
const OWNER_EMAIL = `fix18-owner-${stamp}@example.com`;
const BUILDER_EMAIL = `fix18-builder-${stamp}@example.com`;

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  builder = makeCli(server.baseUrl);
  // F-04: --display-name maps to the API field displayName.
  const registered = await owner.cli(
    'auth', 'register', '--email', OWNER_EMAIL, '--password', PASSWORD, '--display-name', 'Owner Display',
  );
  expect(registered.code).toBe(0);
  expect(registered.stdout).toContain('Owner Display');
  expect(
    (await builder.cli(
      'auth', 'register', '--email', BUILDER_EMAIL, '--password', PASSWORD, '--display-name', 'Builder Display',
    )).code,
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
`,
  );
  expect((await owner.cli('apply', '-f', 'world.yaml', '--json')).code).toBe(0);
  expect(
    (await owner.cli('env', 'members', 'add', WORLD_NAME, '--email', BUILDER_EMAIL, '--role', 'builder')).code,
  ).toBe(0);
});

afterAll(async () => {
  await server?.stop();
});

describe('F-04: auth register --display-name', () => {
  test('--display-name sets the API displayName; --name stays a working alias', async () => {
    const me = await owner.cli('auth', 'whoami', '--json');
    expect(me.code).toBe(0);
    expect(me.json().displayName).toBe('Owner Display');

    const legacy = await owner.cli(
      'auth', 'register', '--email', `fix18-legacy-${stamp}@example.com`,
      '--password', PASSWORD, '--name', 'Legacy Name', '--profile', 'legacy', '--json',
    );
    expect(legacy.code).toBe(0);
    expect(legacy.json().displayName).toBe('Legacy Name');
  });
});

describe('F-17: global flags trailing a command group', () => {
  test('notifications --profile <p> list is NOT mistaken for a subcommand', async () => {
    // A second session in its own profile.
    expect(
      (await owner.cli(
        'auth', 'login', '--email', OWNER_EMAIL, '--password', PASSWORD, '--profile', 'work',
      )).code,
    ).toBe(0);

    const listed = await owner.cli('notifications', '--profile', 'work', 'list', '--json');
    expect(listed.code).toBe(0);
    expect(listed.json().unreadCount).toBeGreaterThanOrEqual(0);

    // The --flag=value form and other groups behave the same.
    const envs = await owner.cli('env', '--profile=work', 'list', '--mine', '--json');
    expect(envs.code).toBe(0);
    expect(envs.json().some((env: { name: string }) => env.name === WORLD_NAME)).toBe(true);

    const whoami = await owner.cli('auth', '--profile', 'work', 'whoami', '--json');
    expect(whoami.code).toBe(0);
    expect(whoami.json().profile).toBe('work');
  });
});

describe('F-01: device add --binding', () => {
  test('a builder\'s hass:// create escalates and the CLI says owner approval is required', async () => {
    const added = await builder.cli(
      'device', 'add', '--env', WORLD_NAME, '--zone', 'room-a',
      '--type', 'light', '--capabilities', 'lighting-control,turn-on,turn-off,set-brightness',
      '--name', 'Living Room Light', '--binding', 'hass://light.living_room',
    );
    expect(added.code).toBe(0);
    expect(added.stdout).toContain('escalated');
    expect(added.stdout).toContain('owner approves the proposal');

    // The binding survived the trip — it is on the proposal payload.
    const asJson = await builder.cli(
      'device', 'add', '--env', WORLD_NAME, '--zone', 'room-a',
      '--type', 'light', '--capabilities', 'turn-on', '--name', 'Second Light',
      '--binding', 'hass://light.second', '--json',
    );
    expect(asJson.code).toBe(0);
    const proposal = asJson.json();
    expect(proposal.proposal).toBe(true);
    expect(proposal.status).toBe('escalated');
    expect(proposal.payload.devices[0].binding).toBe('hass://light.second');
  });
});

describe('F-05: env deployment binding columns', () => {
  test('devices carry binding + deploymentStatus; sync-bindings summarized', async () => {
    // The owner's direct create binds immediately (no proposal detour).
    const added = await owner.cli(
      'device', 'add', '--env', WORLD_NAME, '--zone', 'room-a',
      '--type', 'light', '--capabilities', 'lighting-control,turn-on,turn-off',
      '--name', 'Porch Light', '--binding', 'hass://light.porch',
    );
    expect(added.code).toBe(0);

    // T131: the summary-note locale is PINNED. T125 gave the CLI a default
    // `--lang en-US` that rides Accept-Language, and the manifest notes are
    // server-localized (i18n chrome.manifest.bridgedDevices) — an unpinned
    // request now (correctly) gets the EN sentence. The zh sentence below is
    // still the exact production copy under the zh locale (messages.ts).
    const manifest = (await owner.cli('env', 'deployment', WORLD_NAME, '--lang', 'zh-CN', '--json')).json();
    const porch = manifest.devicesToDeploy.find((d: { name: string }) => d.name === 'Porch Light');
    expect(porch.binding).toBe('hass://light.porch');
    expect(porch.deploymentStatus).toBe('bridged');
    expect(manifest.syncBindings).toEqual([]);
    expect(manifest.notes).toContain('1 台设备已桥接真实硬件（hass:// 绑定），其余为纯仿真设备');

    // T131: the en-US counterpart — the localized EN sentence, anchored on
    // the server's messages.ts EN branch (not hand-written).
    const manifestEn = (await owner.cli('env', 'deployment', WORLD_NAME, '--lang', 'en-US', '--json')).json();
    expect(manifestEn.notes.join('\n')).toContain('already bridged to real hardware (hass:// binding)');

    // Human mode shows the status/binding columns.
    const human = await owner.cli('env', 'deployment', WORLD_NAME);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('bridged');
    expect(human.stdout).toContain('hass://light.porch');
  });
});
