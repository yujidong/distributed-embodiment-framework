/**
 * `eaf agreement` tests (Fix-11) — the full consumption chain against the
 * real server with two profiles: a provider who applies the world (its
 * agent's device binding derives the service offer) and a consumer who
 * proposes, invokes and audits. Lifecycle: propose → list → decide →
 * (sim create + start) → invoke → usage → terminate.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { run } from '../cli.js';
import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';


/**
 * Poll until the streaming CLI's captured stdout contains `needle`
 * (DevLoop R21 test-debt: replaces fixed 800/1200ms sleeps — under
 * parallel load the socket/subscribed/observation timing shifts).
 */
async function untilStdout(has: () => string, needle: string, timeoutMs = 15_000, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (has().includes(needle)) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return has().includes(needle);
}

let server: TestServer;
let provider: CliRunner;
let consumer: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-agreements-${stamp}`;

beforeAll(async () => {
  server = await bootServer();
  provider = makeCli(server.baseUrl);
  consumer = makeCli(server.baseUrl);
  expect(
    (await provider.cli('auth', 'register', '--email', `prov-${stamp}@example.com`, '--password', 'password-123', '--name', 'Provider')).code,
  ).toBe(0);
  expect(
    (await consumer.cli('auth', 'register', '--email', `cons-${stamp}@example.com`, '--password', 'password-123', '--name', 'Consumer')).code,
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
  - name: HVAC A
    zone: room-a
    spec:
      type: hvac
      capabilities: [turn-on, turn-off]
agents:
  - name: Climate Bot
    capabilities: [turn-on, turn-off]
    bind: [HVAC A]
    zones: [room-a]
`,
  );
  const applied = await provider.cli('apply', '-f', 'world.yaml', '--json');
  expect(applied.code).toBe(0);
  // T-208: derived offers default to members visibility — the consumer
  // joins the public world to discover (and propose on) them.
  expect((await consumer.cli('env', 'join', WORLD_NAME)).code).toBe(0);
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

let serviceId: string;
let agreementId: string;
let simId: string;

describe('agreement lifecycle over the CLI', () => {
  test('consumer finds the derived offer and proposes an agreement', async () => {
    const services = (await consumer.cli('service', 'list', '--env', WORLD_NAME, '--json')).json() as Array<Record<string, any>>;
    const derived = services.find(service => service.origin === 'derived' && service.semanticType === 'turn-on');
    expect(derived).toBeTruthy();
    serviceId = derived!.id;

    const proposed = await consumer.cli(
      'agreement', 'propose', serviceId,
      '--terms', JSON.stringify({ notes: '组合应用' }),
      '--json',
    );
    expect(proposed.code).toBe(0);
    expect(proposed.json().status).toBe('proposed');
    expect(proposed.json().terms).toEqual({ notes: '组合应用' });
    expect(proposed.json().provider.displayName).toBe('Provider');
    agreementId = proposed.json().id;

    const human = await consumer.cli('agreement', 'propose', serviceId);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('proposed');
  });

  test('list filters by role/status; the provider sees the proposal', async () => {
    const asConsumer = (await consumer.cli('agreement', 'list', '--env', WORLD_NAME, '--json')).json() as Array<{ id: string }>;
    expect(asConsumer.map(a => a.id)).toContain(agreementId);

    const proposedOnly = (await consumer.cli('agreement', 'list', '--env', WORLD_NAME, '--status', 'proposed', '--json')).json() as Array<{ id: string }>;
    expect(proposedOnly.map(a => a.id)).toContain(agreementId);

    const asProvider = (await provider.cli('agreement', 'list', '--env', WORLD_NAME, '--role', 'provider', '--json')).json() as Array<{ id: string }>;
    expect(asProvider.map(a => a.id)).toContain(agreementId);

    // Human mode renders a table; bad flag values are usage errors.
    const table = await consumer.cli('agreement', 'list', '--env', WORLD_NAME);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain('proposed');
    expect((await consumer.cli('agreement', 'list', '--env', WORLD_NAME, '--role', 'bogus')).code).toBe(2);
  });

  test('only the provider can decide; accept lands the agreement active', async () => {
    // The consumer deciding their own proposal is forbidden (server 403 → exit 1).
    expect((await consumer.cli('agreement', 'decide', agreementId, 'accept')).code).toBe(1);

    const decided = await provider.cli('agreement', 'decide', agreementId, 'accept', '--json');
    expect(decided.code).toBe(0);
    expect(decided.json().status).toBe('active');

    const human = await provider.cli('agreement', 'decide', agreementId, 'reject');
    expect(human.code).toBe(1); // no longer proposed — server 409
    expect((await provider.cli('agreement', 'decide', agreementId, 'maybe')).code).toBe(2);
  });

  test('invoke targets the authoritative world session by default (T-501); --sim pins a private sim', async () => {
    // No private sim yet → the invoke STILL executes: the env's
    // authoritative world session materializes on demand (T-501/CB24-F01 —
    // the old 409 SIMULATION_NOT_RUNNING is the session-unavailable
    // fallback only).
    const worldInvoked = await consumer.cli('agreement', 'invoke', agreementId, '--action', 'turn-on', '--json');
    expect(worldInvoked.code).toBe(0);
    expect(worldInvoked.json().success).toBe(true);
    expect(String(worldInvoked.json().simulationId)).toMatch(/-world-session$/);
    expect(worldInvoked.json().usage.outcome).toBe('success');
    expect(worldInvoked.json().usage.effectRef).not.toBeNull();

    // The provider (not a consumer) may not invoke.
    expect((await provider.cli('agreement', 'invoke', agreementId, '--action', 'turn-on')).code).toBe(1);

    const sim = await consumer.cli('sim', 'create', '--env', WORLD_NAME, '--json');
    expect(sim.code).toBe(0);
    simId = sim.json().id;
    expect((await consumer.cli('sim', 'start', simId)).code).toBe(0);

    // An explicit --sim pins THAT private simulation.
    const invoked = await consumer.cli('agreement', 'invoke', agreementId, '--action', 'turn-on', '--sim', simId, '--json');
    expect(invoked.code).toBe(0);
    expect(invoked.json().success).toBe(true);
    expect(invoked.json().simulationId).toBe(simId);
    expect(invoked.json().usage.outcome).toBe('success');
    expect(invoked.json().usage.effectRef).not.toBeNull();

    // T-303: a vocabulary probe (unknown action) is refused by the device
    // gate with a teaching 422 → exit 1, still METERED as a failure row
    // (audit completeness; quota counts only outcome='success' rows).
    const failed = await consumer.cli('agreement', 'invoke', agreementId, '--action', 'no-such-command', '--json');
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('DEVICE_COMMAND_NOT_EXECUTABLE');

    const human = await consumer.cli('agreement', 'invoke', agreementId, '--action', 'turn-off');
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('invoke ok');
  });

  test('usage lists the append-only metering to both parties', async () => {
    // T38.3 (R3): the --json face passes the REST envelope { usage, view } through.
    const asConsumer = (await consumer.cli('agreement', 'usage', agreementId, '--json')).json().usage as Array<{ outcome: string }>;
    // world-session turn-on (success) + private-sim turn-on (success) +
    // turn-off (success). The no-such-command probe is NOT in the ledger:
    // R103 (zhao-23, landed in 45f0d919) re-ruled the T-303 consumer-side
    // refusal as a consumer error — never metered, never scored against the
    // provider. (The old expectation here still counted a failure row; the
    // CLI test had not synced with the R103 semantic — Batch 3 leftover.)
    expect(asConsumer.map(u => u.outcome)).toEqual(['success', 'success', 'success']);

    const asProvider = (await provider.cli('agreement', 'usage', agreementId, '--json')).json().usage as Array<unknown>;
    expect(asProvider).toHaveLength(3);

    const table = await consumer.cli('agreement', 'usage', agreementId);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain('turn-on');
    expect(table.stdout).toContain('success');
  });

  test('get prints one agreement\'s detail; receipts lists the settlement archive', async () => {
    const got = await consumer.cli('agreement', 'get', agreementId, '--json');
    expect(got.code).toBe(0);
    expect(got.json().id).toBe(agreementId);
    expect(got.json().status).toBe('active');
    expect(got.json().effectiveTerms).toEqual({ notes: '组合应用' });

    const human = await provider.cli('agreement', 'get', agreementId);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(agreementId);
    expect(human.stdout).toContain('active');

    // Every successful invoke above was settled — the Null provider archived
    // one status=recorded receipt per batch.
    const receipts = await consumer.cli('agreement', 'receipts', agreementId, '--json');
    expect(receipts.code).toBe(0);
    const rows = receipts.json() as Array<{ id: string; status: string; usageRecordIds: string[] }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.status === 'recorded')).toBe(true);

    const table = await consumer.cli('agreement', 'receipts', agreementId);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain('recorded');

    expect((await consumer.cli('agreement', 'get', 'no-such-agreement')).code).toBe(4);
    expect((await consumer.cli('agreement', 'receipts', 'no-such-agreement')).code).toBe(4);
  });

  test('stream follows device observations over WebSocket (NDJSON under --json)', async () => {
    const abort = new AbortController();
    let stdout = '';
    const done = run(
      ['agreement', 'stream', agreementId, '--json'],
      {
        env: { EAF_HOME: consumer.home, EAF_SERVER: server.baseUrl },
        cwd: consumer.home,
        homeDir: consumer.home,
        isTTY: false,
        stdout: chunk => (stdout += chunk),
        stderr: () => {},
      },
      abort.signal,
    );
    // Wait for the subscribed frame ON the stream, then change the backing
    // device's state via an invoke, then wait for an observation frame.
    expect(await untilStdout(() => stdout, '"kind":"subscribed"')).toBe(true);
    // T-501: pin the stream's sim (the consumer's private one — the omitted
    // --sim default is the authoritative world session now).
    expect((await consumer.cli('agreement', 'invoke', agreementId, '--action', 'turn-off', '--sim', simId, '--json')).code).toBe(0);
    expect(await untilStdout(() => stdout, '"kind":"observation"')).toBe(true);
    abort.abort();
    expect(await done).toBe(0);

    const frames = stdout.split('\n').filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as { kind: string });
    expect(frames[0].kind).toBe('subscribed');
    expect(frames.some(frame => frame.kind === 'observation')).toBe(true);

    // The closed session was metered as one kind=stream usage record — but
    // the server-side metering write lands AFTER the client sees the stream
    // end, and under CI load that lag exceeds zero (2026-10-03 push CI:
    // one-shot read returned []). Poll briefly instead of asserting on the
    // first read.
    let streamUsage: Array<{ kind: string }> = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const usage = (await consumer.cli('agreement', 'usage', agreementId, '--json')).json().usage as Array<{ kind: string }>;
      streamUsage = usage.filter(record => record.kind === 'stream');
      if (streamUsage.length === 1) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    expect(streamUsage).toHaveLength(1);

    // An unknown agreement rejects before the upgrade (404 → exit 4).
    expect((await consumer.cli('agreement', 'stream', 'no-such-agreement')).code).toBe(4);
  }, 30_000);

  test('stream --params passes the parameter filter through to the server (Fix-20)', async () => {
    const abort = new AbortController();
    let stdout = '';
    const done = run(
      ['agreement', 'stream', agreementId, '--params', 'no-such-param', '--json'],
      {
        env: { EAF_HOME: consumer.home, EAF_SERVER: server.baseUrl },
        cwd: consumer.home,
        homeDir: consumer.home,
        isTTY: false,
        stdout: chunk => (stdout += chunk),
        stderr: () => {},
      },
      abort.signal,
    );
    expect(await untilStdout(() => stdout, '"kind":"subscribed"')).toBe(true);
    // The filter echoes in the subscribed frame and suppresses observations
    // whose changed parameters are not listed. The invoke completes, then a
    // generous NEGATIVE window (R21 test-debt): no positive signal exists
    // for "the filtered frame never arrives" — a leaking filter would push
    // an observation within this window. T-501: --sim pins the stream's
    // sim (the omitted default is the authoritative world session).
    expect((await consumer.cli('agreement', 'invoke', agreementId, '--action', 'turn-on', '--sim', simId, '--json')).code).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 1200));
    abort.abort();
    expect(await done).toBe(0);

    const frames = stdout.split('\n').filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as { kind: string; params?: string[] });
    expect(frames[0].kind).toBe('subscribed');
    expect(frames[0].params).toEqual(['no-such-param']);
    expect(frames.some(frame => frame.kind === 'observation')).toBe(false);
  }, 30_000);

  test('hold (consumer, D3) suspends invokes; resume restores them', async () => {
    // The hold is the consumer's circuit breaker — the provider cannot hold.
    expect((await provider.cli('agreement', 'hold', agreementId, '--duration', '60')).code).toBe(1);

    const held = await consumer.cli('agreement', 'hold', agreementId, '--duration', '600', '--json');
    expect(held.code).toBe(0);
    expect(held.json().status).toBe('held');
    expect(typeof held.json().holdExpiresAt).toBe('string');

    // Held agreements refuse manual invokes.
    expect((await consumer.cli('agreement', 'invoke', agreementId, '--action', 'turn-on')).code).toBe(1);

    const resumed = await consumer.cli('agreement', 'resume', agreementId, '--json');
    expect(resumed.code).toBe(0);
    expect(resumed.json().status).toBe('active');

    // Not held anymore — a second resume is an honest failure.
    expect((await consumer.cli('agreement', 'resume', agreementId)).code).toBe(1);
  });

  test('suspend (provider) then terminate (consumer)', async () => {
    expect((await consumer.cli('agreement', 'suspend', agreementId)).code).toBe(1);
    const suspended = await provider.cli('agreement', 'suspend', agreementId, '--json');
    expect(suspended.code).toBe(0);
    expect(suspended.json().status).toBe('suspended');

    // Suspended agreements refuse invocations.
    expect((await consumer.cli('agreement', 'invoke', agreementId, '--action', 'turn-on')).code).toBe(1);

    const terminated = await consumer.cli('agreement', 'terminate', agreementId, '--json');
    expect(terminated.code).toBe(0);
    expect(terminated.json().status).toBe('terminated');

    // Terminated is terminal.
    expect((await provider.cli('agreement', 'terminate', agreementId)).code).toBe(1);
  });

  test('unknown ids and unknown subcommands map to the standard exit codes', async () => {
    expect((await consumer.cli('agreement', 'usage', 'no-such-agreement')).code).toBe(4);
    expect((await consumer.cli('agreement', 'bogus')).code).toBe(2);
    expect((await consumer.cli('agreement', 'propose', 'no-such-service')).code).toBe(4);
  });
});
