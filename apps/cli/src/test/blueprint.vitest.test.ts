/**
 * Fix-38 CLI tests — `eaf blueprint`: list / show / create / rm / install
 * (the CLI face of the application-blueprint channel, alongside the Web
 * sidebar Blueprint tab and the OpenAPI `blueprints` tag).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-blueprint-${stamp}`;
const PASSWORD = 'password-123';
const OWNER_EMAIL = `blueprint-owner-${stamp}@example.com`;

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  expect(
    (await owner.cli(
      'auth', 'register', '--email', OWNER_EMAIL, '--password', PASSWORD, '--name', 'Owner',
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
});

afterAll(async () => {
  await server?.stop();
});

describe('eaf blueprint list / show', () => {
  test('list --json prints the blueprints array with built-ins', async () => {
    const res = await owner.cli('blueprint', 'list', '--json');
    expect(res.code).toBe(0);
    const blueprints = res.json();
    expect(Array.isArray(blueprints)).toBe(true);
    const classroom = blueprints.find((bp: { id: string }) => bp.id === 'classroom-energy-saver');
    expect(classroom).toBeDefined();
    expect(classroom.isBuiltin).toBe(true);
    expect(classroom.definition.devices.length).toBeGreaterThan(0);
    expect(classroom.definition.agents.length).toBeGreaterThan(0);
  });

  test('human list prints a table with the builtin ids', async () => {
    const res = await owner.cli('blueprint', 'list');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('classroom-energy-saver');
    expect(res.stdout).toContain('builtin');
  });

  test('--builtin-only filters nothing custom in (still includes built-ins)', async () => {
    const res = await owner.cli('blueprint', 'list', '--builtin-only', '--json');
    expect(res.code).toBe(0);
    const blueprints = res.json();
    expect(blueprints.length).toBeGreaterThan(0);
    expect(blueprints.every((bp: { isBuiltin: boolean }) => bp.isBuiltin)).toBe(true);
  });

  test('show prints one blueprint definition', async () => {
    const json = await owner.cli('blueprint', 'show', 'classroom-energy-saver', '--json');
    expect(json.code).toBe(0);
    const bp = json.json();
    expect(bp.id).toBe('classroom-energy-saver');
    expect(bp.definition.flows.length).toBeGreaterThan(0);

    const human = await owner.cli('blueprint', 'show', 'classroom-energy-saver');
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('"classroom-energy-saver"');
  });

  test('show of an unknown blueprint is exit 4', async () => {
    const res = await owner.cli('blueprint', 'show', 'no-such-blueprint');
    expect(res.code).toBe(4);
    expect(res.stderr).toContain('BLUEPRINT_NOT_FOUND');
  });

  // R6-D-S3: the collaboration-pair metadata rides both output channels.
  test('list surfaces partnerSuggestion (json field + human pair column)', async () => {
    const res = await owner.cli('blueprint', 'list', '--json');
    expect(res.code).toBe(0);
    const blueprints = res.json();
    const monitor = blueprints.find((bp: { id: string }) => bp.id === 'co2-monitor');
    expect(monitor).toBeDefined();
    expect(monitor.definition.partnerSuggestion.blueprintId).toBe('fresh-air-manager');
    const manager = blueprints.find((bp: { id: string }) => bp.id === 'fresh-air-manager');
    expect(manager.definition.partnerSuggestion.blueprintId).toBe('co2-monitor');

    const human = await owner.cli('blueprint', 'list');
    expect(human.code).toBe(0);
    // The pair column prints the partner id on the card's row.
    const row = human.stdout.split('\n').find(line => line.includes('co2-monitor'));
    expect(row).toContain('fresh-air-manager');
  });
});

describe('eaf blueprint create / rm', () => {
  test('create from a definition file, then delete it', async () => {
    writeFileSync(
      join(owner.home, 'bp.yaml'),
      `devices:
  - name: Desk Lamp
    type: light
    capabilities: [lighting-control, turn-on, turn-off]
    zoneId: "\${zoneId}"
agents:
  - name: Lamp Keeper
    capabilities: [lighting-control]
    managesZoneIds: ["\${zoneId}"]
    boundDeviceIndexes: [0]
`,
    );
    const created = await owner.cli(
      'blueprint', 'create', '--name', 'Desk Lamp App', '--file', 'bp.yaml', '--json',
    );
    expect(created.code).toBe(0);
    const bp = created.json();
    expect(bp.id).toMatch(/^bp-/);
    expect(bp.isBuiltin).toBe(false);
    expect(bp.name).toBe('Desk Lamp App');

    const listed = await owner.cli('blueprint', 'list', '--json');
    const custom = listed.json().find((b: { id: string }) => b.id === bp.id);
    expect(custom).toBeDefined();
    expect(custom.isBuiltin).toBe(false);

    const humanCreate = await owner.cli(
      'blueprint', 'create', '--name', 'Temp App', '--file', 'bp.yaml',
    );
    expect(humanCreate.code).toBe(0);
    expect(humanCreate.stdout).toContain('created');
    const tempId = (await owner.cli('blueprint', 'list', '--json')).json()
      .find((b: { name: string }) => b.name === 'Temp App').id as string;

    const removed = await owner.cli('blueprint', 'rm', tempId, '--json');
    expect(removed.code).toBe(0);
    expect(removed.json().deleted).toBe(tempId);
    const after = (await owner.cli('blueprint', 'list', '--json')).json();
    expect(after.find((b: { id: string }) => b.id === tempId)).toBeUndefined();
  });

  test('rm of a built-in blueprint is refused by the server (exit 1)', async () => {
    const res = await owner.cli('blueprint', 'rm', 'classroom-energy-saver');
    expect(res.code).toBe(1);
  });

  test('create without --file is a usage error', async () => {
    const res = await owner.cli('blueprint', 'create', '--name', 'x');
    expect(res.code).toBe(2);
  });
});

describe('eaf blueprint install', () => {
  test('install a built-in blueprint into a zone (env by name)', async () => {
    const res = await owner.cli(
      'blueprint', 'install', 'classroom-energy-saver',
      '--env', WORLD_NAME, '--zone', 'room-a', '--json',
    );
    expect(res.code).toBe(0);
    const result = res.json();
    expect(result.blueprintId).toBe('classroom-energy-saver');
    expect(result.zoneId).toBe('room-a');
    expect(result.createdIds.devices).toHaveLength(2);
    expect(result.createdIds.agents).toHaveLength(1);
    expect(result.createdIds.flows).toHaveLength(1);

    // The created objects are real env members (device/agent list see them).
    const devices = (await owner.cli('device', 'list', '--env', WORLD_NAME, '--json')).json();
    expect(devices.length).toBeGreaterThanOrEqual(2);
  });

  test('human install names the created ids', async () => {
    const res = await owner.cli(
      'blueprint', 'install', 'dorm-guardian', '--env', WORLD_NAME, '--zone', 'room-a',
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('dorm-guardian');
    expect(res.stdout).toMatch(/created 2 device\(s\)/);
    expect(res.stdout).toMatch(/created 1 agent\(s\)/);
  });

  test('install into an unknown zone surfaces UNKNOWN_ZONE (exit 1)', async () => {
    const res = await owner.cli(
      'blueprint', 'install', 'dorm-guardian', '--env', WORLD_NAME, '--zone', 'no-such-zone',
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('UNKNOWN_ZONE');
  });

  test('install of an unknown blueprint is exit 4', async () => {
    const res = await owner.cli(
      'blueprint', 'install', 'no-such-blueprint', '--env', WORLD_NAME, '--zone', 'room-a',
    );
    expect(res.code).toBe(4);
  });

  test('missing --zone is a usage error', async () => {
    const res = await owner.cli('blueprint', 'install', 'dorm-guardian', '--env', WORLD_NAME);
    expect(res.code).toBe(2);
  });
});

describe('eaf blueprint uninstall', () => {
  test('uninstall removes the installed objects and is idempotent', async () => {
    const install = await owner.cli(
      'blueprint', 'install', 'corridor-smart-lighting',
      '--env', WORLD_NAME, '--zone', 'room-a', '--json',
    );
    expect(install.code).toBe(0);

    const res = await owner.cli(
      'blueprint', 'uninstall', 'corridor-smart-lighting', '--env', WORLD_NAME, '--json',
    );
    expect(res.code).toBe(0);
    const result = res.json();
    expect(result.blueprintId).toBe('corridor-smart-lighting');
    expect(result.summary).toEqual({ devices: 2, agents: 1, flows: 0 });

    // Idempotent: a repeat uninstall reports zeros.
    const again = await owner.cli(
      'blueprint', 'uninstall', 'corridor-smart-lighting', '--env', WORLD_NAME, '--json',
    );
    expect(again.code).toBe(0);
    expect(again.json().summary).toEqual({ devices: 0, agents: 0, flows: 0 });
  });

  test('human uninstall prints the removed counts', async () => {
    // sz-cbd-air-guard is used nowhere else in this file — the counts are exact.
    await owner.cli(
      'blueprint', 'install', 'sz-cbd-air-guard', '--env', WORLD_NAME, '--zone', 'room-a',
    );
    const res = await owner.cli('blueprint', 'uninstall', 'sz-cbd-air-guard', '--env', WORLD_NAME);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('sz-cbd-air-guard');
    expect(res.stdout).toMatch(/removed 2 device\(s\), 1 agent\(s\), 1 flow\(s\)/);
  });

  test('missing --env is a usage error', async () => {
    const res = await owner.cli('blueprint', 'uninstall', 'dorm-guardian');
    expect(res.code).toBe(2);
  });
});

describe('eaf blueprint dispatch', () => {
  test('unknown subcommand is a usage error (exit 2)', async () => {
    const res = await owner.cli('blueprint', 'nope');
    expect(res.code).toBe(2);
  });

  test('per-command help lists the subcommands', async () => {
    const res = await owner.cli('help', 'blueprint');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('eaf blueprint install');
    // And the general help mentions the command.
    const general = await owner.cli('help');
    expect(general.stdout).toContain('blueprint');
  });
});
