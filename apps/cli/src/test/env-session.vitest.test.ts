/**
 * `eaf env session status` (living-worlds P1W) — the CLI surface of the
 * authoritative world session: read-only views of the env detail's
 * worldSession block, before and after a session materializes.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-world-session-${stamp}`;

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  expect(
    (await owner.cli('auth', 'register', '--email', `own-${stamp}@example.com`, '--password', 'password-123', '--name', 'Session Owner')).code,
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
  const envId = applied.json().envId as string;
  (globalThis as { __envId?: string }).__envId = envId;

  // Materialize the session over raw HTTP: an auto-targeted data read (the
  // world-needing lane with no explicit simulationId). Same setup shape as
  // the data-services CLI suite: service + computation + agreement + read.
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `own-${stamp}@example.com`, password: 'password-123' }),
  });
  const token = ((await login.json()) as { token: string }).token;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const detail = (await (await fetch(`${server.baseUrl}/api/environments/${envId}`, { headers })).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  const agentId = detail.agents.find(agent => agent.name === 'Care Bot')!.id;
  const service = await (await fetch(`${server.baseUrl}/api/environments/${envId}/agents/${agentId}/services`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'zone-temp', semanticType: 'care-status-aggregate' }),
  })).json() as { id: string };
  expect(
    (await fetch(`${server.baseUrl}/api/services/${service.id}/computation`, {
      method: 'POST', headers,
      body: JSON.stringify({
        kind: 'zone-query',
        refreshSec: 60,
        inputs: {
          zones: ['room-a'],
          metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }],
        },
        interface: { dataSchema: { fields: [{ name: 'avgTemperature', type: 'number', unit: '°C' }] } },
      }),
    })).status,
  ).toBe(201);
  const agreement = await (await fetch(`${server.baseUrl}/api/services/${service.id}/agreements`, {
    method: 'POST', headers,
    body: JSON.stringify({ terms: { read: { fields: ['avgTemperature'] } } }),
  })).json() as { id: string };
  expect(
    (await fetch(`${server.baseUrl}/api/agreements/${agreement.id}/decide`, {
      method: 'POST', headers, body: JSON.stringify({ decision: 'accept' }),
    })).status,
  ).toBe(200);
  const read = await fetch(`${server.baseUrl}/api/agreements/${agreement.id}/reads`, {
    method: 'POST', headers, body: JSON.stringify({}),
  });
  expect(read.status).toBe(200);
  expect(((await read.json()) as { simulationId: string }).simulationId)
    .toBe(`sim-${envId}-world-session`);
});

afterAll(async () => {
  await server.stop();
});

describe('eaf env session status (living-worlds P1W)', () => {
  test('read-only: prints the materialized session (table + json)', async () => {
    const envId = (globalThis as { __envId?: string }).__envId!;
    const tabled = await owner.cli('env', 'session', 'status', envId);
    expect(tabled.code).toBe(0);
    expect(tabled.stdout).toContain(`sim-${envId}-world-session`);
    // (status itself is asserted via --json below — the table renders the
    // 'hibernatedAt' column header even when absent, so the plain-text
    // surface is not a reliable status oracle.)

    const json = await owner.cli('env', 'session', 'status', envId, '--json');
    expect(json.code).toBe(0);
    const session = json.json() as {
      status: string; simulationId: string; simTimeSec: number;
      simStartEpochMs?: number;
      state?: string;
    };
    expect(session.simulationId).toBe(`sim-${envId}-world-session`);
    expect(['active', 'idle']).toContain(session.status);
    // T82 (R9, u3-F1): the runtime state rides the status view — the same
    // word the sim roster and AGENT_AMBIGUOUS candidates speak.
    expect(session.state).toBe('running');
    // ...and the human face explains the two words (state vs status) instead
    // of letting idle read as "not running" next to a running roster row.
    expect(tabled.stdout).toContain('state=running');
    expect(tabled.stdout).toContain('关注生命周期');
    expect(typeof session.simTimeSec).toBe('number');
    // T-410 (R19): the wall anchor rides the status (the table also prints
    // it — assert the epoch arithmetic is sane: anchor ≤ now).
    expect(typeof session.simStartEpochMs).toBe('number');
    expect(session.simStartEpochMs!).toBeLessThanOrEqual(Date.now());
  });

  test('usage errors teach (unknown session subcommand / extra positionals)', async () => {
    const envId = (globalThis as { __envId?: string }).__envId!;
    const bad = await owner.cli('env', 'session', 'wake', envId);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('unknown session subcommand "wake"');
    const extra = await owner.cli('env', 'session', 'status', envId, 'extra');
    expect(extra.code).not.toBe(0);
    expect(extra.stderr).toContain('unexpected extra arguments: extra');
  });

  test('a session-less environment answers honestly (and never materializes one)', async () => {
    // A fresh empty env: reading its session status must not create a world.
    const created = await owner.cli('env', 'create', '--name', `empty-${stamp}`, '--json');
    expect(created.code).toBe(0);
    const emptyId = created.json().id as string;
    const res = await owner.cli('env', 'session', 'status', emptyId, '--json');
    expect(res.code).toBe(0);
    expect(res.json()).toBeNull();
    const tabled = await owner.cli('env', 'session', 'status', emptyId);
    expect(tabled.stdout).toContain('no world session yet');
  });
});
