/**
 * T126 (R20-u1 F1): `eaf env set-default-sim <id|name> <simId|--clear>` —
 * the CLI WRITE lane of the T122 default-simulation binding.
 *
 * The r20 finding: the documented two-positional shape never parsed —
 * `requirePositional` demanded exactly one positional, so every binding
 * write died on "unexpected extra arguments: <simId>" and only `--clear`
 * worked (REST PATCH was fine — the three-channel write parity broke).
 * These e2e pins: a real binding write lands, `env get` follows it, a bad
 * simId is the server's teaching 404 (not a parse refusal), and `--clear`
 * still clears. Semantics stay T122's: bind now, start later (running is
 * NOT required at bind time).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-default-sim-${stamp}`;

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  expect(
    (await owner.cli('auth', 'register', '--email', `own-${stamp}@example.com`, '--password', 'password-123', '--name', 'Binding Owner')).code,
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
  - name: Temp Sensor
    zone: room-a
    spec:
      type: sensor
      capabilities: [temperature-reading]
    initialState: {active: false}
agents:
  - name: Care Bot
    capabilities: [temperature-monitoring]
    bind: [Temp Sensor]
    zones: [room-a]
`,
  );
  const applied = await owner.cli('apply', '-f', 'world.yaml', '--json');
  expect(applied.code).toBe(0);
});

afterAll(async () => {
  await server.stop();
});

describe('eaf env set-default-sim (T126: the CLI write lane parses and lands)', () => {
  test('binds a sim by the documented two-positional shape, and env get follows', async () => {
    const sim = await owner.cli('sim', 'create', '--env', WORLD_NAME, '--json');
    expect(sim.code).toBe(0);
    const simId = sim.json().id as string;
    expect((await owner.cli('sim', 'start', simId)).code).toBe(0);

    // THE r20 break: the second positional was rejected before this fix.
    const bound = await owner.cli('env', 'set-default-sim', WORLD_NAME, simId, '--json');
    expect(bound.code).toBe(0);
    expect(bound.json().defaultSimulationId).toBe(simId);

    // The binding is visible on the read face (the human line names it too).
    const detail = await owner.cli('env', 'get', WORLD_NAME, '--json');
    expect(detail.code).toBe(0);
    expect(detail.json().defaultSimulationId).toBe(simId);
    const human = await owner.cli('env', 'get', WORLD_NAME);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(simId);

    // Rebinding to another sim follows (the r20 repair loop: bind → rebind).
    const sim2 = await owner.cli('sim', 'create', '--env', WORLD_NAME, '--json');
    expect(sim2.code).toBe(0);
    const sim2Id = sim2.json().id as string;
    const rebound = await owner.cli('env', 'set-default-sim', WORLD_NAME, sim2Id, '--json');
    expect(rebound.code).toBe(0);
    expect(rebound.json().defaultSimulationId).toBe(sim2Id);
  });

  test('an unknown simId is the server\'s teaching 404 (exit 4), not a parse refusal', async () => {
    const res = await owner.cli('env', 'set-default-sim', WORLD_NAME, 'sim-does-not-exist');
    expect(res.code).toBe(4);
    expect(res.stderr + res.stdout).toContain('SIMULATION_NOT_FOUND');
    // The teaching points at the roster (the same message REST serves).
    expect(res.stderr + res.stdout).toContain('sim list');
  });

  test('--clear still clears (the branch that worked before the fix keeps working)', async () => {
    const cleared = await owner.cli('env', 'set-default-sim', WORLD_NAME, '--clear', '--json');
    expect(cleared.code).toBe(0);
    expect(cleared.json().defaultSimulationId).toBeNull();
    const detail = await owner.cli('env', 'get', WORLD_NAME, '--json');
    expect(detail.json().defaultSimulationId).toBeNull();
  });

  test('the usage shape is taught when args are missing entirely', async () => {
    const res = await owner.cli('env', 'set-default-sim');
    expect(res.code).toBe(2);
    expect(res.stderr + res.stdout).toContain('set-default-sim');
  });
});
