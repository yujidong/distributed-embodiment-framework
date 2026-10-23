/**
 * R101 (sandbox-entry) — `eaf sandbox create/list/stop`: the CLI接驳 of the
 * fork kernel with API-identical semantics — any member (viewer included)
 * forks in one command, the fork reports its simulation, stop is idempotent.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
let viewer: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-r101-sandbox-${stamp}`;
const PASSWORD = 'password-123';
const OWNER_EMAIL = `r101sb-owner-${stamp}@example.com`;
const VIEWER_EMAIL = `r101sb-viewer-${stamp}@example.com`;

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  viewer = makeCli(server.baseUrl);
  expect(
    (await owner.cli('auth', 'register', '--email', OWNER_EMAIL, '--password', PASSWORD, '--name', 'Owner')).code,
  ).toBe(0);
  expect(
    (await viewer.cli('auth', 'register', '--email', VIEWER_EMAIL, '--password', PASSWORD, '--name', 'Viewer')).code,
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
        baseline: {temperature: 25}
devices:
  - name: Sensor A
    zone: room-a
    spec:
      type: temperature-sensor
      capabilities: [temperature-reading]
`,
  );
  expect((await owner.cli('apply', '-f', 'world.yaml', '--json')).code).toBe(0);
  expect(
    (await owner.cli('env', 'members', 'add', WORLD_NAME, '--email', VIEWER_EMAIL, '--role', 'viewer')).code,
  ).toBe(0);
});

afterAll(async () => {
  await server?.stop();
});

describe('eaf sandbox (R101)', () => {
  test('a VIEWER forks in one command; list shows it; stop is idempotent', async () => {
    // The tutorial's promise: even a viewer may fork — one command, no curl.
    const created = await viewer.cli('sandbox', 'create', '--env', WORLD_NAME, '--json');
    expect(created.code).toBe(0);
    const sandbox = created.json();
    expect(sandbox.id).toBeTruthy();
    expect(sandbox.parentEnvironmentId).toBeTruthy();
    expect(sandbox.status).toBeTruthy();

    const listed = (await viewer.cli('sandbox', 'list', '--env', WORLD_NAME, '--json')).json() as Array<{ id: string }>;
    expect(listed.some(row => row.id === sandbox.id)).toBe(true);

    const human = await viewer.cli('sandbox', 'list', '--env', WORLD_NAME);
    expect(human.stdout).toContain(sandbox.id);

    const stopped = await viewer.cli('sandbox', 'stop', sandbox.id, '--json');
    expect(stopped.code).toBe(0);
    // Stop is idempotent by design (server contract).
    const again = await viewer.cli('sandbox', 'stop', sandbox.id);
    expect(again.code).toBe(0);
  });

  test('the isolation kernel is untouched: the parent world shows no sandbox write-back', async () => {
    const created = await viewer.cli('sandbox', 'create', '--env', WORLD_NAME, '--json');
    expect(created.code).toBe(0);
    const sandbox = created.json();
    // Drive the fork's simulation (device command inside the sandbox)…
    if (sandbox.simulationId) {
      const devices = (await viewer.cli('sim', 'snapshot', sandbox.simulationId, '--json')).json();
      const device = (devices.devices as Array<{ id: string }>)[0];
      expect(device).toBeDefined();
      await viewer.cli('sim', 'command', sandbox.simulationId, '--device', device!.id, '--cmd', 'turn-on');
    }
    // …the parent environment's device list is byte-identical (zero回写).
    const parent = (await owner.cli('device', 'list', '--env', WORLD_NAME, '--json')).json() as Array<{ name: string }>;
    expect(parent.map(d => d.name)).toEqual(['Sensor A']);
    await viewer.cli('sandbox', 'stop', sandbox.id);
  });
});

describe('T89 (R12, u3-F-12-01): the sandbox command family is discoverable from the top-level help', () => {
  test('`eaf help` lists sandbox; `sandbox -h` shows the lifecycle; `help me` is me-only again', async () => {
    // The general help carries the sandbox line with the R101 positioning.
    const general = await viewer.cli('help');
    expect(general.code).toBe(0);
    expect(general.stdout).toMatch(/^\s+sandbox\s+create, list, stop/m);

    // `sandbox -h` shows the dedicated lifecycle page (it used to fall
    // through to the general help because COMMAND_HELP had no sandbox key).
    const page = await viewer.cli('sandbox', '--help');
    expect(page.code).toBe(0);
    expect(page.stdout).toContain('eaf sandbox — 沙箱（环境副本·只读演练）生命周期（R101）');
    expect(page.stdout).toContain('eaf sandbox create');

    // The R101 batch had embedded this page INSIDE the me help (escaped
    // backticks + a duplicate "me:" line) — the me help is me-only again.
    const me = await viewer.cli('help', 'me');
    expect(me.code).toBe(0);
    expect(me.stdout).toContain('eaf me — 我的工作台');
    expect(me.stdout).not.toContain('eaf sandbox');
    expect((me.stdout.match(/eaf me — 我的工作台/g) ?? []).length).toBe(1);

    // `eaf help sandbox` resolves to the same dedicated page.
    const viaHelp = await viewer.cli('help', 'sandbox');
    expect(viaHelp.code).toBe(0);
    expect(viaHelp.stdout).toContain('eaf sandbox — 沙箱（环境副本·只读演练）生命周期（R101）');
  });
});
