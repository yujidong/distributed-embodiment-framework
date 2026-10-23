/**
 * End-to-end suite for the eaf CLI against the REAL apps/server.
 *
 * One server (temp SQLite DB, random port) and one isolated EAF_HOME per
 * file; tests mirror the workflow an agent would follow: register → apply a
 * world → extend it imperatively → export/apply round-trip → run a
 * rule-only simulation.
 *
 * ORDER DECOUPLING CONTRACT (DevLoop R21 test-debt): the suite's shared
 * fixtures are established EXPLICITLY, not by test order —
 * - the authenticated session (EMAIL) is registered in the file-level
 *   beforeAll, so every describe is session-self-sufficient;
 * - describes that need the WORLD_NAME environment call `ensureWorld()` in
 *   their own beforeAll (apply is idempotent — a second apply is a no-op);
 * - `auth` tests use their OWN dedicated user, so they can run anywhere;
 * - WITHIN a describe, test order is semantic by design (create → extend →
 *   prune; first apply → idempotent re-apply) — that chaining is the thing
 *   under test, not incidental state.
 * No LLM backend anywhere — every simulation uses llm=none.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { run } from '../cli.js';
import { bootServer, CLI_SRC_DIR, makeCli, TSX_CLI, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let eaf: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-world-${stamp}`;
const EMAIL = `cli-${stamp}@example.com`;
const PASSWORD = 'password-123';
/** Dedicated user for the auth describe (order-independent). */
const AUTH_EMAIL = `cli-auth-${stamp}@example.com`;

beforeAll(async () => {
  server = await bootServer();
  eaf = makeCli(server.baseUrl);
  // Pinned setup (R21 test-debt): the shared session exists before ANY
  // describe runs — previously the first `auth` test created it, making
  // every later describe depend on `auth` running first.
  const registered = await eaf.cli('auth', 'register', '--email', EMAIL, '--password', PASSWORD, '--name', 'CLI Tester');
  expect(registered.code).toBe(0);
});

afterAll(async () => {
  await server?.stop();
});

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

describe('auth', () => {
  test('register + login persists, whoami resolves, token never printed', async () => {
    const registered = await eaf.cli('auth', 'register', '--email', AUTH_EMAIL, '--password', PASSWORD, '--name', 'Auth Tester');
    expect(registered.code).toBe(0);
    expect(registered.stdout).toContain('Auth Tester');
    expect(registered.stdout).not.toContain(PASSWORD);

    // Session persisted in $EAF_HOME/config.json with a token.
    const config = JSON.parse(readFileSync(join(eaf.home, 'config.json'), 'utf8')) as {
      server?: string;
      token?: string;
    };
    expect(config.token).toBeTruthy();
    expect(config.server).toBe(server.baseUrl);

    // A brand-new process (fresh run call) is still authenticated.
    const whoami = await eaf.cli('auth', 'whoami', '--json');
    expect(whoami.code).toBe(0);
    const me = whoami.json();
    expect(me.email).toBe(AUTH_EMAIL);
    expect(me.server).toBe(server.baseUrl);
    expect(JSON.stringify(me)).not.toContain(config.token as string);
  });

  test('logout clears the session; whoami then exits 3', async () => {
    expect((await eaf.cli('auth', 'logout')).code).toBe(0);
    const whoami = await eaf.cli('auth', 'whoami');
    expect(whoami.code).toBe(3);
    expect(whoami.stderr).toContain('not logged in');
    // log back in for the rest of the suite
    expect((await eaf.cli('auth', 'login', '--email', AUTH_EMAIL, '--password', PASSWORD)).code).toBe(0);
    // The suite's pinned session user must remain usable no matter what
    // this describe did to the shared EAF_HOME session.
    expect((await eaf.cli('auth', 'login', '--email', EMAIL, '--password', PASSWORD)).code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// exit codes
// ---------------------------------------------------------------------------

describe('exit codes', () => {
  test('3 on authed command while logged out', async () => {
    const anon = makeCli(server.baseUrl); // fresh EAF_HOME, no login
    const result = await anon.cli('env', 'list');
    expect(result.code).toBe(3);
  });

  test('4 on unknown environment / simulation', async () => {
    const envGet = await eaf.cli('env', 'get', 'no-such-env-xyz');
    expect(envGet.code).toBe(4);
    const simStatus = await eaf.cli('sim', 'status', 'no-such-sim-xyz');
    expect(simStatus.code).toBe(4);
  });

  test('2 on usage errors', async () => {
    const missingFlag = await eaf.cli('env', 'create'); // --name required
    expect(missingFlag.code).toBe(2);
    const unknownCommand = await eaf.cli('frobnicate');
    expect(unknownCommand.code).toBe(2);
    const unknownFlag = await eaf.cli('env', 'list', '--bogus');
    expect(unknownFlag.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// apply: create + idempotency + prune
// ---------------------------------------------------------------------------

function worldDocument(): string {
  return `version: "1.0"
environment:
  name: ${WORLD_NAME}
  description: CLI e2e test world
  visibility: private
  map:
    type: grid
    zones:
      - id: room-a
        name: Room A
        bounds: {minX: 0, maxX: 5, minY: 0, maxY: 5}
        adjacentZoneIds: [room-b]
        baseline: {temperature: 30, humidity: 60}
      - id: room-b
        name: Room B
        bounds: {minX: 5, maxX: 10, minY: 0, maxY: 5}
        adjacentZoneIds: [room-a]
        baseline: {temperature: 25}
devices:
  - name: Sensor A
    zone: room-a
    spec:
      type: temperature-sensor
      brand: TestBrand
      capabilities: [temperature-reading]
agents:
  - name: Bot
    capabilities: [temperature-monitoring]
    bind: [Sensor A]
    zones: [room-a, room-b]
events:
  - id: evt-heat
    type: temperature-spike
    zoneId: room-a
    parameter: temperature
    value: 40
    atSimTimeSec: 5
    severity: high
`;
}

/**
 * Pinned world fixture (R21 test-debt): describes that operate on WORLD_NAME
 * call this in their beforeAll — `apply` is idempotent (a second apply is
 * all-unchanged), so it safely establishes the baseline no matter which
 * describes ran before. The `apply` describe below is the creator and does
 * NOT call this (its first test asserts envAction === 'created').
 */
async function ensureWorld(): Promise<void> {
  writeFileSync(join(eaf.home, 'world.yaml'), worldDocument());
  const applied = await eaf.cli('apply', '-f', 'world.yaml', '--json');
  expect(applied.code).toBe(0);
}

describe('apply', () => {
  test('creates the environment from a world document', async () => {
    writeFileSync(join(eaf.home, 'world.yaml'), worldDocument());
    const result = await eaf.cli('apply', '-f', 'world.yaml', '--json');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const summary = result.json();
    expect(summary.ok).toBe(true);
    expect(summary.envAction).toBe('created');
    expect(summary.devices.created.map((d: any) => d.name)).toEqual(['Sensor A']);
    expect(summary.agents.created.map((a: any) => a.name)).toEqual(['Bot']);
    expect(summary.errors).toEqual([]);

    const detail = (await eaf.cli('env', 'get', WORLD_NAME, '--json')).json();
    expect(detail.zones.map((z: any) => z.id)).toEqual(['room-a', 'room-b']);
    expect(detail.events).toHaveLength(1);
    expect(detail.devices).toHaveLength(1);
    expect(detail.agents[0].boundDeviceIds).toEqual([detail.devices[0].id]);
  });

  test('is idempotent — second apply is all unchanged', async () => {
    const result = await eaf.cli('apply', '-f', 'world.yaml', '--json');
    expect(result.code).toBe(0);
    const summary = result.json();
    expect(summary.envAction).toBe('unchanged');
    expect(summary.devices.created).toHaveLength(0);
    expect(summary.devices.updated).toHaveLength(0);
    expect(summary.devices.unchanged.map((d: any) => d.name)).toEqual(['Sensor A']);
    expect(summary.agents.unchanged.map((a: any) => a.name)).toEqual(['Bot']);
  });

  test('reports every document problem at once (exit 2)', async () => {
    writeFileSync(
      join(eaf.home, 'bad.json'),
      JSON.stringify({
        version: '1.0',
        environment: { map: { type: 'grid', zones: [] } },
        devices: [
          { model: 'x', spec: { type: 't', capabilities: [] }, zone: 'z' },
          { spec: { type: 't', capabilities: ['a'] }, zone: '' },
          { model: 'm2', zone: 'z', bogus: 1 },
        ],
        agents: [{ name: 'A' }],
        events: [{ id: 'e1', type: 't', zoneId: 'z', severity: 'apocalyptic' }],
        simulation: { llm: 'hal9000' },
      }),
    );
    const result = await eaf.cli('apply', '-f', 'bad.json');
    expect(result.code).toBe(2);
    for (const expected of [
      'environment.name',
      'devices[0]',
      'devices[1].name',
      'devices[1].zone',
      'devices[2].bogus',
      'agents[0].capabilities',
      'events[0].severity',
      'simulation.llm',
    ]) {
      expect(result.stderr).toContain(expected);
    }
  });

  test('reference failure on a NEW environment leaves no garbage env behind (Fix-6)', async () => {
    writeFileSync(
      join(eaf.home, 'broken.yaml'),
      `version: "1.0"
environment:
  name: ${WORLD_NAME}-broken
  map:
    type: grid
    zones:
      - id: room-a
        bounds: {minX: 0, maxX: 5, minY: 0, maxY: 5}
devices:
  - name: Sensor X
    zone: nowhere
    spec:
      type: temperature-sensor
      capabilities: [temperature-reading]
agents:
  - name: Bot
    capabilities: [temperature-monitoring]
    bind: [Ghost Device]
    zones: [room-a]
events:
  - id: evt-bad
    type: temperature-spike
    zoneId: nowhere
    parameter: temperature
    value: 40
    severity: high
`,
    );
    const result = await eaf.cli('apply', '-f', 'broken.yaml', '--json');
    expect(result.code).toBe(1);
    const summary = result.json();
    expect(summary.ok).toBe(false);
    expect(summary.errors.join('\n')).toContain('nowhere');
    expect(summary.errors.join('\n')).toContain('Ghost Device');
    // Pre-validation aborted BEFORE creation — no empty environment remains.
    const envs = (await eaf.cli('env', 'list', '--json')).json() as Array<{ name: string }>;
    expect(envs.map(env => env.name)).not.toContain(`${WORLD_NAME}-broken`);
  });
});

// ---------------------------------------------------------------------------
// apply + simulation plans (T-029): warn about / reuse already-running sims
// ---------------------------------------------------------------------------

const SIM_WORLD = `cli-sim-world-${stamp}`;

function simWorldDocument(): string {
  return `version: "1.0"
environment:
  name: ${SIM_WORLD}
  description: T-029 apply simulation plan world
  map:
    type: grid
    zones:
      - id: room-a
        name: Room A
        bounds: {minX: 0, maxX: 5, minY: 0, maxY: 5}
devices:
  - name: Sensor S
    zone: room-a
    spec:
      type: temperature-sensor
      capabilities: [temperature-reading]
agents:
  - name: Sim Bot
    capabilities: [temperature-monitoring]
    bind: [Sensor S]
    zones: [room-a]
simulation:
  llm: none
  speed: 5
`;
}

describe('apply + running simulations (T-029)', () => {
  test('re-apply with a simulation block warns about the live sims it is stacking', async () => {
    writeFileSync(join(eaf.home, 'world-sim.yaml'), simWorldDocument());

    // First apply on a fresh environment: one sim, nothing to warn about.
    const first = await eaf.cli('apply', '-f', 'world-sim.yaml', '--json');
    expect(first.code).toBe(0);
    const firstSummary = first.json();
    expect(firstSummary.ok).toBe(true);
    expect(firstSummary.simulationId).toBeTruthy();
    expect(firstSummary.simulationReused).toBe(false);
    expect(firstSummary.warnings).toEqual([]);
    const firstSimId = firstSummary.simulationId as string;

    // Second apply of the SAME document: world unchanged, but another sim —
    // EC-F10: this used to leak a running sim per apply with no signal.
    const second = await eaf.cli('apply', '-f', 'world-sim.yaml', '--json');
    expect(second.code).toBe(0);
    const secondSummary = second.json();
    expect(secondSummary.ok).toBe(true);
    expect(secondSummary.simulationId).toBeTruthy();
    expect(secondSummary.simulationId).not.toBe(firstSimId);
    const warningText = (secondSummary.warnings as string[]).join('\n');
    expect(warningText).toContain(firstSimId);
    expect(warningText).toContain('eaf sim stop');
    expect(warningText).toContain('--reuse-sim');

    // Human mode prints the warning prominently too.
    const third = await eaf.cli('apply', '-f', 'world-sim.yaml');
    expect(third.code).toBe(0);
    expect(third.stdout).toContain('warnings:');
    expect(third.stdout).toContain('eaf sim stop');

    // Clean up: stop every live sim (the later suites share the user quota).
    const thirdSimId = /simulation (\S+) created\+started/.exec(third.stdout)?.[1];
    for (const id of [firstSimId, secondSummary.simulationId as string, thirdSimId]) {
      if (id !== undefined) await eaf.cli('sim', 'stop', id);
    }
  });

  test('--reuse-sim attaches to the newest live sim instead of creating one', async () => {
    // One live sim (nothing to reuse before that — a fresh create).
    const boot = await eaf.cli('apply', '-f', 'world-sim.yaml', '--json');
    expect(boot.code).toBe(0);
    const simId = boot.json().simulationId as string;
    expect(boot.json().simulationReused).toBe(false);

    // Reuse while RUNNING: same id, no new sim, explicit "reused" summary.
    const reuseRunning = await eaf.cli('apply', '-f', 'world-sim.yaml', '--reuse-sim', '--json');
    expect(reuseRunning.code).toBe(0);
    expect(reuseRunning.json().simulationId).toBe(simId);
    expect(reuseRunning.json().simulationReused).toBe(true);
    expect(reuseRunning.json().simulationState).toBe('running');
    expect(reuseRunning.json().warnings).toEqual([]);
    // And the running sim was genuinely untouched (still running).
    expect((await eaf.cli('sim', 'status', simId, '--json')).json().state).toBe('running');

    // Reuse while PAUSED resumes it (with the plan's speed).
    expect((await eaf.cli('sim', 'pause', simId)).code).toBe(0);
    const reusePaused = await eaf.cli('apply', '-f', 'world-sim.yaml', '--reuse-sim', '--json');
    expect(reusePaused.code).toBe(0);
    expect(reusePaused.json().simulationId).toBe(simId);
    expect(reusePaused.json().simulationReused).toBe(true);
    expect((await eaf.cli('sim', 'status', simId, '--json')).json().state).toBe('running');

    expect((await eaf.cli('sim', 'stop', simId)).code).toBe(0);
  });

  test('--reuse-sim with no live sims falls back to creating one', async () => {
    const result = await eaf.cli('apply', '-f', 'world-sim.yaml', '--reuse-sim', '--json');
    expect(result.code).toBe(0);
    const summary = result.json();
    expect(summary.simulationId).toBeTruthy();
    expect(summary.simulationReused).toBe(false);
    expect(summary.warnings).toEqual([]);
    expect((await eaf.cli('sim', 'stop', summary.simulationId)).code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// devices + agents (imperative)
// ---------------------------------------------------------------------------

let catalogModelId: string;

describe('devices and agents', () => {
  beforeAll(ensureWorld);

  test('catalog list + device add by catalog model', async () => {
    const catalog = (await eaf.cli('catalog', 'list', '--json')).json();
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThan(0);
    catalogModelId = catalog[0].id;

    const added = await eaf.cli(
      'device', 'add', '--env', WORLD_NAME, '--model', catalogModelId,
      '--zone', 'room-a', '--name', 'Catalog Gadget', '--json',
    );
    expect(added.code).toBe(0);
    const device = added.json();
    expect(device.name).toBe('Catalog Gadget');
    expect(device.zoneId).toBe('room-a');
    expect(device.type).toBe(catalog[0].deviceType);

    const list = (await eaf.cli('device', 'list', '--env', WORLD_NAME, '--json')).json();
    expect(list.map((d: any) => d.name).sort()).toEqual(['Catalog Gadget', 'Sensor A']);
  });

  test('device get reads one device back (json + human)', async () => {
    const list = (await eaf.cli('device', 'list', '--env', WORLD_NAME, '--json')).json();
    const sensor = list.find((d: any) => d.name === 'Sensor A');

    const got = await eaf.cli('device', 'get', sensor.id, '--json');
    expect(got.code).toBe(0);
    expect(got.json().id).toBe(sensor.id);
    expect(got.json().name).toBe('Sensor A');
    expect(got.json().zoneId).toBe('room-a');

    const human = await eaf.cli('device', 'get', sensor.id);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Sensor A');
    expect(human.stdout).toContain('room-a');

    expect((await eaf.cli('device', 'get', 'no-such-device')).code).toBe(4);
  });

  test('agent add by file with device-name binding', async () => {
    writeFileSync(
      join(eaf.home, 'agent.yaml'),
      [
        'name: FileBot',
        'capabilities: [temperature-monitoring]',
        'bind: [Sensor A, Catalog Gadget]',
        'zones: [room-a]',
        '',
      ].join('\n'),
    );
    const added = await eaf.cli('agent', 'add', '--env', WORLD_NAME, '--file', 'agent.yaml', '--json');
    expect(added.code).toBe(0);
    const agent = added.json();
    expect(agent.name).toBe('FileBot');
    expect(agent.boundDeviceIds).toHaveLength(2);
    expect(agent.managedZoneIds).toEqual(['room-a']);
  });

  test('agent add fails with all unresolvable binds listed', async () => {
    writeFileSync(
      join(eaf.home, 'agent-bad.yaml'),
      'name: BadBot\ncapabilities: [x]\nbind: [No Such Device, also-missing]\n',
    );
    const result = await eaf.cli('agent', 'add', '--env', WORLD_NAME, '--file', 'agent-bad.yaml');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('No Such Device');
    expect(result.stderr).toContain('also-missing');
  });

  test('apply --prune deletes objects absent from the document', async () => {
    const result = await eaf.cli('apply', '-f', 'world.yaml', '--prune', '--json');
    expect(result.code).toBe(0);
    const summary = result.json();
    expect(summary.devices.deleted.map((d: any) => d.name)).toEqual(['Catalog Gadget']);
    expect(summary.agents.deleted.map((a: any) => a.name)).toEqual(['FileBot']);
    expect(summary.devices.unchanged.map((d: any) => d.name)).toEqual(['Sensor A']);
    expect(summary.agents.unchanged.map((a: any) => a.name)).toEqual(['Bot']);

    const list = (await eaf.cli('device', 'list', '--env', WORLD_NAME, '--json')).json();
    expect(list.map((d: any) => d.name)).toEqual(['Sensor A']);
  });
});

// ---------------------------------------------------------------------------
// members (Fix-4): owner-driven membership management
// ---------------------------------------------------------------------------

describe('env members', () => {
  beforeAll(ensureWorld);

  test('owner invites / re-roles / removes; invitee sees the private env immediately', async () => {
    const second = makeCli(server.baseUrl);
    const email2 = `cli-second-${stamp}@example.com`;
    const registered = await second.cli(
      'auth', 'register', '--email', email2, '--password', PASSWORD, '--name', 'Second User',
    );
    expect(registered.code).toBe(0);

    // WORLD_NAME is private — the second user cannot see it before the invite.
    const before = (await second.cli('env', 'list', '--json')).json();
    expect(before.find((env: any) => env.name === WORLD_NAME)).toBeUndefined();

    const invited = await eaf.cli(
      'env', 'members', 'add', WORLD_NAME, '--email', email2, '--role', 'viewer', '--json',
    );
    expect(invited.code).toBe(0);
    expect(invited.json().role).toBe('viewer');
    expect(invited.json().email).toBe(email2);

    // Immediate-effect membership: the private env shows up in their list.
    const after = (await second.cli('env', 'list', '--json')).json();
    expect(after.find((env: any) => env.name === WORLD_NAME)?.myRole).toBe('viewer');

    // The owner's member list carries userId + email (full view).
    const members = (await eaf.cli('env', 'members', WORLD_NAME, '--json')).json();
    const row = members.find((member: any) => member.role === 'viewer');
    expect(row.userId).toBeTruthy();
    expect(row.email).toBe(email2);

    // Text mode renders a table with the member's display name.
    const table = await eaf.cli('env', 'members', WORLD_NAME);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain('Second User');

    // Role change by userId.
    const promoted = await eaf.cli(
      'env', 'members', 'set-role', WORLD_NAME, row.userId, '--role', 'builder', '--json',
    );
    expect(promoted.code).toBe(0);
    expect(promoted.json().role).toBe('builder');

    // Usage errors: 'owner' is not assignable, email/user-id are exclusive.
    const badRole = await eaf.cli(
      'env', 'members', 'add', WORLD_NAME, '--email', email2, '--role', 'owner',
    );
    expect(badRole.code).toBe(2);
    const bothIds = await eaf.cli(
      'env', 'members', 'add', WORLD_NAME, '--email', email2, '--user-id', row.userId, '--role', 'viewer',
    );
    expect(bothIds.code).toBe(2);

    // Remove: membership (and private-env visibility) is gone.
    const removed = await eaf.cli('env', 'members', 'remove', WORLD_NAME, row.userId);
    expect(removed.code).toBe(0);
    const finalList = (await second.cli('env', 'list', '--json')).json();
    expect(finalList.find((env: any) => env.name === WORLD_NAME)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// export → apply round-trip on the seeded Suzhou apartment
// ---------------------------------------------------------------------------

describe('export → apply round-trip', () => {
  test('suzhou-apartment round-trips under a new name', async () => {
    const publicEnvs = (await eaf.cli('env', 'list', '--public', '--json')).json();
    const suzhou = publicEnvs.find((env: any) => env.name === '苏州夏日傍晚公寓');
    expect(suzhou).toBeTruthy();

    const exported = await eaf.cli('env', 'export', suzhou.id, '--json');
    expect(exported.code).toBe(0);
    const document = exported.json();
    expect(document.version).toBe('1.0');
    const counts = {
      zones: document.environment.map.zones.length,
      devices: document.devices.length,
      agents: document.agents.length,
    };
    expect(counts).toEqual({ zones: 7, devices: 19, agents: 5 });

    const cloneName = `${WORLD_NAME}-suzhou-clone`;
    document.environment.name = cloneName;
    writeFileSync(join(eaf.home, 'suzhou-clone.json'), JSON.stringify(document, null, 2));
    const applied = await eaf.cli('apply', '-f', 'suzhou-clone.json', '--json');
    expect(applied.code).toBe(0);
    expect(applied.json().envAction).toBe('created');

    const clone = (await eaf.cli('env', 'get', cloneName, '--json')).json();
    expect(clone.zones).toHaveLength(counts.zones);
    expect(clone.devices).toHaveLength(counts.devices);
    expect(clone.agents).toHaveLength(counts.agents);
    // device names survive the round-trip (they are the upsert identity)
    expect(clone.devices.map((d: any) => d.name).sort()).toEqual(
      document.devices.map((d: any) => d.name).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// simulation lifecycle (rule-only — llm none)
// ---------------------------------------------------------------------------

describe('simulation', () => {
  let simId: string;

  beforeAll(ensureWorld);

  test('create → start → step → inject → snapshot → command → stop', async () => {
    const created = await eaf.cli('sim', 'create', '--env', WORLD_NAME, '--llm', 'none', '--json');
    expect(created.code).toBe(0);
    simId = created.json().id;
    expect(simId).toBeTruthy();
    expect(created.json().llm).toBe('rule-only'); // llmClient=none → rule-only agents

    const started = await eaf.cli('sim', 'start', simId, '--speed', '5', '--json');
    expect(started.code).toBe(0);
    expect(started.json().state).toBe('running');

    expect((await eaf.cli('sim', 'pause', simId)).code).toBe(0);
    const stepped = await eaf.cli('sim', 'step', simId, '--n', '10', '--json');
    expect(stepped.code).toBe(0);
    expect(stepped.json().simTimeSec).toBeGreaterThanOrEqual(10);

    const botId = (await eaf.cli('agent', 'list', '--env', WORLD_NAME, '--json')).json()
      .find((a: any) => a.name === 'Bot').id;
    const injected = await eaf.cli(
      'sim', 'inject', simId,
      '--type', 'co2-high', '--zone', 'room-b',
      '--parameter', 'co2', '--value', '900', '--severity', 'medium', '--json',
    );
    expect(injected.code).toBe(0);
    expect(injected.json().targetAgentIds).toContain(botId);

    // The structured face: --json stdout is the snapshot document (the human
    // face is a rendered report — the zones table below exercises it).
    const snap = await eaf.cli('sim', 'snapshot', simId, '--json');
    expect(snap.code).toBe(0);
    const snapshot = snap.json();
    expect(snapshot.zones).toHaveLength(2);
    expect(snapshot.scheduledEvents.find((e: any) => e.id === 'evt-heat').fired).toBe(true);

    const zonesTable = await eaf.cli('sim', 'snapshot', simId, '--zones');
    expect(zonesTable.code).toBe(0);
    expect(zonesTable.stdout).toContain('room-a');
    expect(zonesTable.stdout).toContain('temperature');

    // Fix-1: commands are authenticated (the CLI session is logged in) and a
    // supported command succeeds for real — unknown ones are now a 4xx.
    const devices = (await eaf.cli('device', 'list', '--env', WORLD_NAME, '--json')).json();
    const sensorId = devices.find((d: any) => d.name === 'Sensor A').id;
    const command = await eaf.cli(
      'sim', 'command', simId, '--device', sensorId, '--cmd', 'temperature-reading', '--json',
    );
    expect(command.code).toBe(0);
    expect(command.json().success).toBe(true);

    const status = await eaf.cli('sim', 'status', simId, '--json');
    expect(status.json().state).toBe('paused');

    const stopped = await eaf.cli('sim', 'stop', simId, '--json');
    expect(stopped.code).toBe(0);
    expect(stopped.json().state).toBe('stopped');
    // final snapshot stays available after stop
    expect((await eaf.cli('sim', 'status', simId)).code).toBe(0);
  });

  test('watch prints NDJSON diffs until aborted', async () => {
    const created = await eaf.cli('sim', 'create', '--env', WORLD_NAME, '--llm', 'none', '--json');
    const watchSimId = created.json().id;
    await eaf.cli('sim', 'start', watchSimId, '--speed', '5');

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 2500);
    let stdout = '';
    const code = await run(
      ['sim', 'watch', watchSimId, '--interval', '300', '--json'],
      {
        env: { EAF_HOME: eaf.home, EAF_SERVER: server.baseUrl },
        cwd: eaf.home,
        homeDir: eaf.home,
        isTTY: false,
        stdout: chunk => (stdout += chunk),
        stderr: () => {},
      },
      abort.signal,
    );
    expect(code).toBe(0);
    const lines = stdout.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0].kind).toBe('state');
    expect(lines[0].state).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// me quotas (P4-4) + env eval-run status (Wave-3a read half)
// ---------------------------------------------------------------------------

describe('me quotas and eval-run status', () => {
  beforeAll(ensureWorld);

  test('me quotas prints the limit/used table (json + human)', async () => {
    const got = await eaf.cli('me', 'quotas', '--json');
    expect(got.code).toBe(0);
    const quotas = got.json().quotas;
    expect(typeof quotas.environmentsPerUser.limit).toBe('number');
    expect(typeof quotas.environmentsPerUser.used).toBe('number');
    expect(typeof quotas.runningSimsPerUser.limit).toBe('number');

    const human = await eaf.cli('me', 'quotas');
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('environmentsPerUser');
    expect(human.stdout).toContain('devicesPerEnv');
  });

  test('eval-run --no-wait then eval-run status reads the job back', async () => {
    writeFileSync(
      join(eaf.home, 'runs.yaml'),
      ['runs:', '  - label: baseline', '    steps: 2', 'events: []', ''].join('\n'),
    );
    const submitted = await eaf.cli('env', 'eval-run', WORLD_NAME, '-f', 'runs.yaml', '--no-wait', '--json');
    expect(submitted.code).toBe(0);
    const jobId = submitted.json().id;
    expect(jobId).toBeTruthy();

    const status = await eaf.cli('env', 'eval-run', 'status', jobId, '--json');
    expect(status.code).toBe(0);
    expect(status.json().id).toBe(jobId);
    expect(['pending', 'running', 'done', 'failed']).toContain(status.json().status);

    const human = await eaf.cli('env', 'eval-run', 'status', jobId);
    expect(human.code).toBe(0);
    // pending/running → a status line naming the job; done → the comparison
    // table with the arm label.
    expect(human.stdout.length).toBeGreaterThan(0);

    expect((await eaf.cli('env', 'eval-run', 'status', 'no-such-job')).code).toBe(4);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// entry smoke: the shipped entrypoint runs as a subprocess
// ---------------------------------------------------------------------------

describe('entry', () => {
  test('tsx src/main.ts --help exits 0 with the command list', async () => {
    const home = mkdtempSync(join(tmpdir(), 'eaf-cli-smoke-'));
    const result = await new Promise<{ code: number | null; out: string }>(resolvePromise => {
      const child = spawn(process.execPath, [TSX_CLI, 'src/main.ts', '--help'], {
        cwd: CLI_SRC_DIR,
        env: { ...process.env, EAF_HOME: home },
      });
      let out = '';
      child.stdout?.on('data', chunk => (out += chunk));
      child.stderr?.on('data', chunk => (out += chunk));
      child.on('close', code => resolvePromise({ code, out }));
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('eaf — command line');
    expect(result.out).toContain('apply');
  });
});
