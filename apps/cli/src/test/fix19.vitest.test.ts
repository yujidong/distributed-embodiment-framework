/**
 * Fix-19 CLI tests — `eaf env guide` / `eaf env set-guide` / `eaf env activity`
 * plus the viewer-only `viewerNotice` on `env get`.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
let viewer: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-fix19-${stamp}`;
const PASSWORD = 'password-123';
const OWNER_EMAIL = `fix19-owner-${stamp}@example.com`;
const VIEWER_EMAIL = `fix19-viewer-${stamp}@example.com`;

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
  visibility: public
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
agents:
  - name: Bot
    capabilities: [temperature-monitoring]
    bind: [Sensor A]
    zones: [room-a]
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

describe('eaf env guide / set-guide (Fix-19)', () => {
  test('a fresh world has no guide', async () => {
    const res = await owner.cli('env', 'guide', WORLD_NAME, '--json');
    expect(res.code).toBe(0);
    expect(res.json()).toBeNull();
  });

  test('the owner sets the guide with flags; env get surfaces it', async () => {
    const set = await owner.cli(
      'env', 'set-guide', WORLD_NAME,
      '--purpose', '能耗优化试验场',
      '--role-viewer', '只读浏览，可 fork 沙箱',
      '--json',
    );
    expect(set.code).toBe(0);
    expect(set.json().purpose).toBe('能耗优化试验场');
    expect(set.json().roleGuide.viewer).toBe('只读浏览，可 fork 沙箱');

    const shown = await viewer.cli('env', 'guide', WORLD_NAME, '--json');
    expect(shown.code).toBe(0);
    expect(shown.json().purpose).toBe('能耗优化试验场');

    const detail = await viewer.cli('env', 'get', WORLD_NAME, '--json');
    expect(detail.code).toBe(0);
    expect(detail.json().guide.purpose).toBe('能耗优化试验场');
  });

  test('set-guide from a JSON file replaces the guide; --clear removes it', async () => {
    writeFileSync(
      join(owner.home, 'guide.json'),
      JSON.stringify({ purpose: '来自文件', serviceMap: '无服务' }),
    );
    const set = await owner.cli('env', 'set-guide', WORLD_NAME, '-f', 'guide.json', '--json');
    expect(set.code).toBe(0);
    expect(set.json().purpose).toBe('来自文件');
    expect(set.json().serviceMap).toBe('无服务');

    const cleared = await owner.cli('env', 'set-guide', WORLD_NAME, '--clear', '--json');
    expect(cleared.code).toBe(0);
    expect(cleared.json()).toBeNull();
  });

  test('a non-owner cannot set the guide', async () => {
    const res = await viewer.cli('env', 'set-guide', WORLD_NAME, '--purpose', 'nope');
    expect(res.code).not.toBe(0);
  });
});

describe('viewerNotice + activity (Fix-19)', () => {
  test('viewerNotice appears only in the viewer perspective', async () => {
    const viewerGet = await viewer.cli('env', 'get', WORLD_NAME, '--json');
    expect(viewerGet.code).toBe(0);
    expect(viewerGet.json().myRole).toBe('viewer');
    expect(typeof viewerGet.json().viewerNotice).toBe('string');

    const ownerGet = await owner.cli('env', 'get', WORLD_NAME, '--json');
    expect(ownerGet.code).toBe(0);
    expect(ownerGet.json().viewerNotice).toBeUndefined();
  });

  test('env activity aggregates the feed, newest first', async () => {
    // One world change to have at least a command entry (the guide set
    // above already logged some; ordering is what matters).
    await owner.cli('env', 'set-guide', WORLD_NAME, '--purpose', '导读回来了');

    const res = await viewer.cli('env', 'activity', WORLD_NAME, '--json');
    expect(res.code).toBe(0);
    const entries = res.json() as Array<{
      time: string;
      kind: string;
      action: string;
      summary: string;
      actor: { displayName: string } | null;
    }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some(entry => entry.kind === 'command')).toBe(true);
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i - 1].time >= entries[i].time).toBe(true);
    }

    const limited = await viewer.cli('env', 'activity', WORLD_NAME, '--limit', '1', '--json');
    expect(limited.code).toBe(0);
    expect(limited.json()).toHaveLength(1);
  });
});

describe('Wave-1a 最后一公里（guide 速查 / join 指引）', () => {
  test('human guide appends the generated 服务速查 with service ids (R8 serviceMap)', async () => {
    const services = (await viewer.cli('service', 'list', '--env', WORLD_NAME, '--json')).json() as Array<{
      id: string;
      name: string;
    }>;
    const derived = services.find(service => service.name === 'Sensor A: 温度读数');
    expect(derived).toBeTruthy();

    const shown = await viewer.cli('env', 'guide', WORLD_NAME);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('Service quick-look');
    expect(shown.stdout).toContain(derived!.id);
    expect(shown.stdout).toContain('Sensor A: 温度读数');
    expect(shown.stdout).toContain('Bot');
  });

  test('env join prints the next-step hint (R8 F-04)', async () => {
    const newcomer = makeCli(server.baseUrl);
    expect(
      (await newcomer.cli(
        'auth', 'register',
        '--email', `fix19-new-${stamp}@example.com`,
        '--password', PASSWORD,
        '--name', 'Newcomer',
      )).code,
    ).toBe(0);
    const joined = await newcomer.cli('env', 'join', WORLD_NAME);
    expect(joined.code).toBe(0);
    expect(joined.stdout).toContain('Next:');
    expect(joined.stdout).toContain('eaf env guide');
    expect(joined.stdout).toContain('eaf service list --env');
  });
});
