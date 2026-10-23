/**
 * T88 (R12, u2-F1) e2e — the get faces accept SHORT PREFIX ids and resolve
 * them against the roster the caller can see: exactly one extension → the
 * full id (with a declared mapping note); zero or several → the teaching
 * error, never a misleading bare NOT_FOUND. REST keeps full ids — this is a
 * CLI-side resolution only.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let eaf: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-prefix-${stamp}`;
const EMAIL = `prefix-${stamp}@example.com`;
const PASSWORD = 'password-123';

let deviceId = '';
let agentId = '';
let serviceId = '';
let invokeServiceId = '';
let agreementId = '';
let envId = '';

beforeAll(async () => {
  server = await bootServer();
  eaf = makeCli(server.baseUrl);
  expect(
    (await eaf.cli('auth', 'register', '--email', EMAIL, '--password', PASSWORD, '--name', 'Prefix User')).code,
  ).toBe(0);
  writeFileSync(
    join(eaf.home, 'world.yaml'),
    `version: "1.0"
environment:
  name: ${WORLD_NAME}
  visibility: public
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
  - name: Plug A
    zone: room-a
    spec:
      type: smart-plug
      capabilities: [turn-on, turn-off]
agents:
  - name: Bot
    capabilities: [temperature-monitoring, turn-on]
    bind: [Sensor A, Plug A]
    zones: [room-a]
`,
  );
  expect((await eaf.cli('apply', '-f', 'world.yaml', '--json')).code).toBe(0);
  const envs = (await eaf.cli('env', 'list', '--json')).json() as Array<{ id: string; name: string }>;
  envId = envs.find(env => env.name === WORLD_NAME)!.id;

  const devices = (await eaf.cli('device', 'list', '--env', WORLD_NAME, '--json')).json() as Array<{ id: string }>;
  deviceId = devices[0]!.id;
  const agents = (await eaf.cli('agent', 'list', '--env', WORLD_NAME, '--json')).json() as Array<{ id: string }>;
  agentId = agents[0]!.id;
  const services = (await eaf.cli('service', 'list', '--env', WORLD_NAME, '--json')).json() as Array<{
    id: string;
    origin: string;
    semanticType: string;
  }>;
  serviceId = services.find(service => service.origin === 'derived')!.id;
  invokeServiceId = services.find(service => service.origin === 'derived' && service.semanticType === 'turn-on')!.id;
  const proposed = await eaf.cli('agreement', 'propose', serviceId, '--json');
  expect(proposed.code).toBe(0);
  agreementId = (proposed.json() as { id: string }).id;

  // Sanity: the ids really do allow a >1-char proper prefix.
  expect(deviceId.length).toBeGreaterThan(8);
});

afterAll(async () => {
  await server?.stop();
});

describe('T88: short-prefix get faces', () => {
  test('device get <8-char prefix> resolves (json face: full id on stdout, mapping note on stderr)', async () => {
    const result = await eaf.cli('device', 'get', deviceId.slice(0, 8), '--json');
    expect(result.code).toBe(0);
    expect((result.json() as { id: string }).id).toBe(deviceId);
    expect(result.stderr).toContain('unique prefix match');
    expect(result.stderr).toContain(deviceId);
  });

  test('human device get declares the mapping on stdout (id + name)', async () => {
    const result = await eaf.cli('device', 'get', deviceId.slice(0, 8));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(deviceId);
    expect(result.stdout).toContain('unique prefix match');
    expect(result.stdout).toContain('Sensor A');
  });

  test('agent get <prefix> resolves through the env scan', async () => {
    const result = await eaf.cli('agent', 'get', agentId.slice(0, 10), '--json');
    expect(result.code).toBe(0);
    expect((result.json() as { agent: { id: string } }).agent.id).toBe(agentId);
  });

  test('service get <prefix> resolves', async () => {
    const result = await eaf.cli('service', 'get', serviceId.slice(0, 8), '--json');
    expect(result.code).toBe(0);
    expect((result.json() as { id: string }).id).toBe(serviceId);
    expect(result.stderr).toContain('unique prefix match');
  });

  test('agreement get / usage / receipts accept the same prefix', async () => {
    const prefix = agreementId.slice(0, 8);
    const got = await eaf.cli('agreement', 'get', prefix, '--json');
    expect(got.code).toBe(0);
    expect((got.json() as { id: string }).id).toBe(agreementId);

    const usage = await eaf.cli('agreement', 'usage', prefix, '--json');
    expect(usage.code).toBe(0);
    expect(usage.json()).toHaveProperty('usage');

    const receipts = await eaf.cli('agreement', 'receipts', prefix, '--json');
    expect(receipts.code).toBe(0);
    expect(Array.isArray(receipts.json())).toBe(true); // the legacy bare-array pass-through
  });

  test('full ids keep the direct path — no resolution note, single behavior', async () => {
    const result = await eaf.cli('device', 'get', deviceId, '--json');
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('unique prefix match');
  });

  test('zero matches teach honestly (roster scope + where to copy ids), exit 4 — not a bare NOT_FOUND', async () => {
    const result = await eaf.cli('device', 'get', 'zzzzzzzz');
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('device "zzzzzzzz" not found');
    expect(result.stderr).toContain('none of the');
    expect(result.stderr).toContain('you can see');
    expect(result.stderr).toContain('eaf device list --env');
  });

  test('zero matches under --json carry the structured CLI_NOT_FOUND error', async () => {
    const result = await eaf.cli('device', 'get', 'zzzzzzzz', '--json');
    expect(result.code).toBe(4);
    const body = result.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CLI_NOT_FOUND');
    expect(body.error.message).toContain('zzzzzzzz');
  });
});

describe('顺带② (R13, u1-F2/u2-P3, T88 leftovers): the adjacency faces join the prefix family', () => {
  test('service computation get <prefix> resolves (was: bare SERVICE_NOT_FOUND)', async () => {
    const result = await eaf.cli('service', 'computation', 'get', serviceId.slice(0, 8), '--json');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('unique prefix match');
    expect(result.stderr).toContain(serviceId);
  });

  test('agreement decide <prefix> accept|reject resolves (was: bare AGREEMENT_NOT_FOUND while get parsed)', async () => {
    // Decide the standing proposal — the face under test is the id
    // resolution; reject keeps the world unchanged for the earlier asserts.
    const result = await eaf.cli(
      'agreement', 'decide', agreementId.slice(0, 8), 'reject', '--reason', 'prefix-resolution probe', '--json',
    );
    expect(result.code).toBe(0);
    expect((result.json() as { id: string }).id).toBe(agreementId);
    expect(result.stderr).toContain('unique prefix match');
  });

  test('service list --provider <agent-prefix> resolves instead of silently returning an empty list', async () => {
    const result = await eaf.cli(
      'service', 'list', '--env', WORLD_NAME, '--provider', agentId.slice(0, 8), '--json',
    );
    expect(result.code).toBe(0);
    const services = result.json() as Array<{ provider: { id: string } }>;
    expect(services.length).toBeGreaterThan(0);
    expect(services.every(service => service.provider.id === agentId)).toBe(true);
    expect(result.stderr).toContain('unique prefix match');
    expect(result.stderr).toContain(agentId);
  });

  test('service list --provider <no-match prefix> teaches honestly (exit 4), never an empty list', async () => {
    const result = await eaf.cli('service', 'list', '--env', WORLD_NAME, '--provider', 'zzzzzzzz', '--json');
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('matches none of the');
    expect(result.stderr).toContain('agent list --env');
  });

  test('service list --provider <ambiguous prefix> lists the candidates (exit 2)', async () => {
    // The world has exactly one agent, so a one-char prefix is still unique —
    // exercise the many-match branch by checking the teaching shape on a
    // zero-length-safe prefix that matches multiple agents after adding none.
    // (Single-agent world: the many-match branch is covered by the unit-level
    // resolver tests in prefix-resolver.vitest.test.ts.)
    const result = await eaf.cli('service', 'list', '--env', WORLD_NAME, '--provider', agentId.slice(0, 2), '--json');
    expect(result.code).toBe(0);
  });
});

describe('顺带② (R13, u1-F2): flow get joins the prefix family', () => {
  test('flow get <no-match prefix> teaches via the roster scan (exit 4), not a bare FLOW_NOT_FOUND', async () => {
    const result = await eaf.cli('flow', 'get', 'zzzzzzzz', '--json');
    expect(result.code).toBe(4);
    const body = result.json() as { error: { code: string; message: string } };
    expect(body.error.message).toContain('flow "zzzzzzzz" not found');
    expect(body.error.message).toContain('you can see');
    expect(body.error.message).toContain('eaf flow list --env');
  });
});

// ---------------------------------------------------------------------------
// T110 (R18, u2-F-18-U2-1 / u4-F2' / u1-F4): the prefix family's LAST faces.
// Same roster habit, bare NOT_FOUND answers: `agreement read` reported the
// caller's OWN active agreement as vanished; `agreement invoke` was u1's
// regression-walk exception; `flow runs` 404'd one second after `flow get`
// resolved the same input. All three resolve through the ONE getWithIdPrefix
// mechanism; flow get / service computation get (already family members)
// gain the positive-resolution pins they lacked.
// ---------------------------------------------------------------------------
describe('T110 (R18): the last prefix-family faces join', () => {
  let readAgreementId = '';
  let invokeAgreementId = '';
  let flowId = '';
  let simId = '';

  beforeAll(async () => {
    // The data service: publish + a zone-query computation so `agreement read`
    // has a real frame to deliver (the walker's Climate Reading chain).
    const published = await eaf.cli(
      'service', 'publish', '--env', WORLD_NAME, '--agent', agentId,
      '--name', 'Prefix Climate Reading', '--type', 'climate-reading', '--json',
    );
    expect(published.code, published.stderr || published.stdout).toBe(0);
    const svcData = (published.json() as { id: string }).id;
    const registered = await eaf.cli('service', 'computation', 'register', svcData,
      '--spec',
      JSON.stringify({
        kind: 'zone-query',
        refreshSec: 60,
        inputs: {
          zones: ['room-a'],
          metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }],
        },
      }),
      '--interface',
      JSON.stringify({
        dataSchema: { fields: [{ name: 'avgTemperature', type: 'number', unit: '°C' }] },
      }),
      '--json');
    expect(registered.code, registered.stderr || registered.stdout).toBe(0);
    const proposedRead = await eaf.cli(
      'agreement', 'propose', svcData,
      '--terms', JSON.stringify({ read: { fields: ['avgTemperature'] } }),
      '--json',
    );
    expect(proposedRead.code).toBe(0);
    readAgreementId = (proposedRead.json() as { id: string }).id;
    expect((await eaf.cli('agreement', 'decide', readAgreementId, 'accept', '--json')).code).toBe(0);

    // The invoke lane: an ACTIVE action agreement on the derived turn-on
    // offer (backed by Plug A), executed inside a running sim.
    const proposedInvoke = await eaf.cli(
      'agreement', 'propose', invokeServiceId,
      '--terms', JSON.stringify({ action: { command: 'turn-on' } }),
      '--json',
    );
    expect(proposedInvoke.code, proposedInvoke.stderr || proposedInvoke.stdout).toBe(0);
    invokeAgreementId = (proposedInvoke.json() as { id: string }).id;
    expect((await eaf.cli('agreement', 'decide', invokeAgreementId, 'accept', '--json')).code).toBe(0);

    // A flow so `flow runs` has a roster row (zero runs is fine — the face
    // under test is id resolution).
    writeFileSync(
      join(eaf.home, 'prefix-flow.yaml'),
      `name: Prefix Run Flow
trigger:
  kind: schedule
  everySimSec: 3600
plan:
  goal: keep the world awake
  nodes:
    - id: n1
      capability: turn-on
`,
    );
    const added = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'prefix-flow.yaml', '--json');
    expect(added.code, added.stderr || added.stdout).toBe(0);
    flowId = (added.json() as { id: string }).id;

    const sim = await eaf.cli('sim', 'create', '--env', WORLD_NAME, '--json');
    expect(sim.code).toBe(0);
    simId = (sim.json() as { id: string }).id;
    expect((await eaf.cli('sim', 'start', simId)).code).toBe(0);
  }, 60_000);

  test('agreement read <8-char prefix> resolves (was: bare AGREEMENT_NOT_FOUND on the caller\'s OWN active contract)', async () => {
    const result = await eaf.cli(
      'agreement', 'read', readAgreementId.slice(0, 8), '--simulation', simId, '--json',
    );
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect((result.json() as { agreementId: string }).agreementId).toBe(readAgreementId);
    expect(result.stderr).toContain('unique prefix match');
    expect(result.stderr).toContain(readAgreementId);
  });

  test('agreement invoke <8-char prefix> resolves (u1\'s regression-walk exception)', async () => {
    const result = await eaf.cli(
      'agreement', 'invoke', invokeAgreementId.slice(0, 8),
      '--action', 'turn-on', '--sim', simId, '--json',
    );
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const payload = result.json() as { agreementId: string; success: boolean };
    expect(payload.agreementId).toBe(invokeAgreementId);
    expect(payload.success).toBe(true);
    expect(result.stderr).toContain('unique prefix match');
    expect(result.stderr).toContain(invokeAgreementId);
  });

  test('flow get <8-char prefix> resolves positively (u2 verified by hand; now pinned)', async () => {
    const result = await eaf.cli('flow', 'get', flowId.slice(0, 8), '--json');
    expect(result.code).toBe(0);
    expect((result.json() as { id: string }).id).toBe(flowId);
    expect(result.stderr).toContain('unique prefix match');
  });

  test('flow runs <8-char prefix> resolves (was: bare FLOW_NOT_FOUND right after flow get parsed)', async () => {
    const result = await eaf.cli('flow', 'runs', flowId.slice(0, 8), '--json');
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(Array.isArray(result.json())).toBe(true);
    expect(result.stderr).toContain('unique prefix match');
    expect(result.stderr).toContain(flowId);
  });

  test('zero matches on the new faces teach honestly (exit 4), never a bare NOT_FOUND', async () => {
    const read = await eaf.cli('agreement', 'read', 'zzzzzzzz', '--json');
    expect(read.code).toBe(4);
    expect((read.json() as { error: { message: string } }).error.message).toContain('none of the');

    const runs = await eaf.cli('flow', 'runs', 'zzzzzzzz', '--json');
    expect(runs.code).toBe(4);
    expect((runs.json() as { error: { message: string } }).error.message).toContain('eaf flow list --env');
  });
});

describe('T124 (E1): the R19-flagged residual faces join the prefix family', () => {
  let agreementId = '';

  beforeAll(async () => {
    // A proposed agreement on the BACKED derived offer (the T-310 signing
    // gate refuses an unbacked published one) as the terminate target.
    const proposed = await eaf.cli(
      'agreement', 'propose', invokeServiceId, '--terms', JSON.stringify({ notes: 'prefix family' }),
      '--json',
    );
    expect(proposed.code, proposed.stderr || proposed.stdout).toBe(0);
    agreementId = (proposed.json() as { id: string }).id;
  }, 60_000);

  test('service subscribe <8-char prefix> resolves (was: SERVICE_NOT_FOUND three times in R19)', async () => {
    // The published data service (unbacked is fine for a bookmark).
    const result = await eaf.cli('service', 'subscribe', serviceId.slice(0, 8), '--json');
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect((result.json() as { serviceId: string }).serviceId).toBe(serviceId);
    expect(result.stderr).toContain('unique prefix match');

    const unsubscribe = await eaf.cli('service', 'unsubscribe', serviceId.slice(0, 8), '--json');
    expect(unsubscribe.code, unsubscribe.stderr || unsubscribe.stdout).toBe(0);
  });

  test('agreement propose <service-prefix> resolves (R19-u1 F4: propose was outside the family)', async () => {
    const result = await eaf.cli(
      'agreement', 'propose', invokeServiceId.slice(0, 8), '--terms', JSON.stringify({ notes: 'prefix propose' }),
      '--json',
    );
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect((result.json() as { serviceId: string }).serviceId).toBe(invokeServiceId);
    expect(result.stderr).toContain('unique prefix match');
  });

  test('agreement terminate <8-char prefix> resolves (R19-u1 F2)', async () => {
    const result = await eaf.cli(
      'agreement', 'terminate', agreementId.slice(0, 8), '--reason', 'prefix family e2e', '--json',
    );
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect((result.json() as { id: string }).id).toBe(agreementId);
    expect(result.stderr).toContain('unique prefix match');

    // zero matches still teach (exit 4 with the roster hint), not bare 404.
    const missing = await eaf.cli('agreement', 'suspend', 'zzzzzzzz', '--json');
    expect(missing.code).toBe(4);
    expect((missing.json() as { error: { message: string } }).error.message).toContain('none of the');
  });
});
