/**
 * `eaf service computation` + `eaf agreement read` (R14 Wave-A) — the CLI
 * surface of the data-service consumption model, end to end against the real
 * server: the provider publishes an unbacked aggregate offer and registers a
 * computation; the consumer contracts it with terms.read, reads (pull +
 * latest) and audits the metering.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let provider: CliRunner;
let consumer: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-data-services-${stamp}`;

const SPEC = {
  kind: 'zone-query',
  refreshSec: 60,
  inputs: {
    zones: ['room-a'],
    metrics: [
      { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
      { source: 'device', capability: 'fall-detection', fn: 'countActive', as: 'activeFallAlerts' },
    ],
  },
};
const IFACE = {
  dataSchema: {
    fields: [
      { name: 'avgTemperature', type: 'number', unit: '°C' },
      { name: 'activeFallAlerts', type: 'integer' },
    ],
  },
};

let serviceId: string;
let agreementId: string;

beforeAll(async () => {
  server = await bootServer();
  provider = makeCli(server.baseUrl);
  consumer = makeCli(server.baseUrl);
  expect(
    (await provider.cli('auth', 'register', '--email', `prov-${stamp}@example.com`, '--password', 'password-123', '--name', 'ElderCare')).code,
  ).toBe(0);
  expect(
    (await consumer.cli('auth', 'register', '--email', `cons-${stamp}@example.com`, '--password', 'password-123', '--name', 'Contractor')).code,
  ).toBe(0);

  writeFileSync(
    join(provider.home, 'world.yaml'),
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
  - name: Fall Sensor 1
    zone: room-a
    spec:
      type: sensor
      capabilities: [fall-detection]
    initialState: {active: false}
  - name: HVAC A
    zone: room-a
    spec:
      type: hvac
      capabilities: [turn-on, turn-off]
agents:
  - name: Care Bot
    capabilities: [fall-detection]
    bind: [Fall Sensor 1, HVAC A]
    zones: [room-a]
`,
  );
  const applied = await provider.cli('apply', '-f', 'world.yaml', '--json');
  expect(applied.code).toBe(0);
  expect((await consumer.cli('env', 'join', WORLD_NAME)).code).toBe(0);

  // The CLI has no `service publish` yet — publish the unbacked offer over
  // raw HTTP with the provider's own session (the CLI drives everything after).
  const envId = applied.json().envId as string;
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `prov-${stamp}@example.com`, password: 'password-123' }),
  });
  const providerToken = (await login.json() as { token: string }).token;
  const envDetail = await (await fetch(`${server.baseUrl}/api/environments/${envId}`, {
    headers: { authorization: `Bearer ${providerToken}` },
  })).json() as { id: string; agents: Array<{ id: string; name: string }> };
  const careBot = envDetail.agents.find(agent => agent.name === 'Care Bot')!;
  const published = await fetch(
    `${server.baseUrl}/api/environments/${envId}/agents/${careBot.id}/services`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${providerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'care-status-aggregate', semanticType: 'care-status-aggregate' }),
    },
  );
  if (published.status !== 201) {
    throw new Error(`service publish failed: ${published.status} ${await published.text()}`);
  }
  serviceId = ((await published.json()) as { id: string }).id;
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

describe('data services over the CLI', () => {
  test('the unbacked offer is consumable:false until a computation registers (T-310 + flip)', async () => {
    const before = (await consumer.cli('service', 'get', serviceId, '--json')).json();
    expect(before.consumable).toBe(false);
    expect(before.consumableNote).toContain('computation');

    const registered = await provider.cli(
      'service', 'computation', 'register', serviceId,
      '--spec', JSON.stringify(SPEC),
      '--interface', JSON.stringify(IFACE),
      '--json',
    );
    expect(registered.code).toBe(0);
    expect(registered.json().consumable).toBe(true);
    expect(registered.json().computation.kind).toBe('zone-query');

    const human = await provider.cli('service', 'get', serviceId);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('computation: zone-query');
    expect(human.stdout).toContain('dataSchema: avgTemperature, activeFallAlerts');

    const got = await provider.cli('service', 'computation', 'get', serviceId, '--json');
    expect(got.code).toBe(0);
    expect(got.json().spec.metrics).toHaveLength(2);
  });

  test('consumer contracts the data service with terms.read and reads it (metered)', async () => {
    // Proposing WITHOUT a read clause works but warns (legacy compatibility).
    const plain = await consumer.cli('agreement', 'propose', serviceId, '--json');
    expect(plain.code).toBe(0);
    await provider.cli('agreement', 'terminate', plain.json().id, '--json');

    const proposed = await consumer.cli(
      'agreement', 'propose', serviceId,
      '--terms', JSON.stringify({ read: { fields: ['avgTemperature', 'activeFallAlerts'] } }),
      '--json',
    );
    expect(proposed.code).toBe(0);
    expect(proposed.json().termsEnforced).toBe(true);
    agreementId = proposed.json().id as string;
    expect((await provider.cli('agreement', 'decide', agreementId, 'accept', '--json')).code).toBe(0);

    // Living-worlds P1W: with no running USER sim the read materializes the
    // env's authoritative world session on demand — the old
    // SIMULATION_NOT_RUNNING 409 is superseded for bridged envs (the
    // authoritative frame serves by default; explicit simulationId keeps
    // the legacy lanes).
    const noSim = await consumer.cli('agreement', 'read', agreementId, '--json');
    expect(noSim.code).toBe(0);
    expect(String(noSim.json().simulationId)).toContain('world-session');

    const sim = await consumer.cli('sim', 'create', '--env', WORLD_NAME, '--json');
    expect(sim.code).toBe(0);
    expect((await consumer.cli('sim', 'start', sim.json().id)).code).toBe(0);

    const read = await consumer.cli('agreement', 'read', agreementId, '--json');
    expect(read.code).toBe(0);
    expect(read.json().frame.provenance.cached).toBe(false);
    expect(read.json().usage.kind).toBe('read');
    expect(read.json().usage.unit).toBe('reading');
    expect(read.json().receiptId).not.toBeNull();

    // Field narrowing via --fields (within the clause) and the latest path.
    const narrowed = await consumer.cli('agreement', 'read', agreementId, '--fields', 'avgTemperature', '--json');
    expect(narrowed.code).toBe(0);
    expect(narrowed.json().applied.fields).toEqual(['avgTemperature']);

    const latest = await consumer.cli('agreement', 'read', agreementId, '--latest', '--json');
    expect(latest.code).toBe(0);
    expect(latest.json().frame.provenance.cached).toBe(true);

    // Widening past the clause is a 422 with the teaching body.
    const wide = await consumer.cli('agreement', 'read', agreementId, '--fields', 'no-such-field', '--json');
    expect(wide.code).toBe(1);
    expect(wide.stderr).toContain('AGREEMENT_TERMS_VIOLATION');

    // Human mode renders the frame readably.
    const human = await consumer.cli('agreement', 'read', agreementId);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('avgTemperature=');
    expect(human.stdout).toContain('receipt');

    // The metering audit shows the read rows (P1W: the former no-sim 409
    // arm is now a metered authoritative-session success — one extra
    // 'success' at the head).
    // T38.3 (R3): the --json face passes the REST envelope { usage, view } through.
    const usage = (await consumer.cli('agreement', 'usage', agreementId, '--json')).json().usage as Array<{ kind: string; outcome: string }>;
    expect(usage.filter(record => record.kind === 'read').map(record => record.outcome))
      .toEqual(['success', 'success', 'success', 'success', 'failure', 'success']);
  });

  test('revoking returns the offer to bookmark-only; the CLI names the boundary', async () => {
    const revoked = await provider.cli('service', 'computation', 'revoke', serviceId, '--json');
    expect(revoked.code).toBe(0);
    expect(revoked.json().consumable).toBe(false);

    // Reads turn 409 COMPUTATION_UNREGISTERED (exit 1, teaching message).
    const refused = await consumer.cli('agreement', 'read', agreementId, '--json');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('COMPUTATION_UNREGISTERED');
  });

  test('unknown subcommands map to usage errors', async () => {
    expect((await consumer.cli('service', 'computation', 'bogus', serviceId)).code).toBe(2);
    expect((await consumer.cli('agreement', 'bogus')).code).toBe(2);
  });
});
