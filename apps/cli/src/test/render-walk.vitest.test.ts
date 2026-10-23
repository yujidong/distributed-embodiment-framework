/**
 * T79 (R8) — the RENDER WALKER: executes render-walk.manifest.ts against a
 * REAL server through run(), capturing stdout and stderr separately.
 *
 * Why a server: R8's pathology ("绿的是纯函数，红的是流、接线与部署件")
 * only exists at the execution layer. This suite is the execution layer —
 * the pure-function layer stays in render-contract (fast lane), this file
 * rides the full lane (ci.yml's PR gate runs `npm test`) next to the other
 * server-booting CLI e2e suites.
 *
 * Also carries the T72/T77 NAMED regressions (u2-F1/F2, u3-P2-F1, u4-P1-2):
 * every explanatory line must be取证-able on STDOUT alone — merged-stream
 * (2>&1) and stdout are asserted SEPARATELY, the R8 test-method lesson.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliResult, type CliRunner, type TestServer } from './helpers.js';
import {
  COMMAND_SURFACE,
  EXEMPT_COMMANDS,
  VOCAB_VERSION,
  WALK_FACES,
  WALK_GHOST_FLOW_YAML,
  WALK_MIXED_IFACE,
  WALK_MIXED_SPEC,
  WALK_READ_IFACE,
  WALK_READ_SPEC,
  WALK_RUN_FLOW_YAML,
  WALK_SCRATCH_FLOW_YAML,
  WALK_WORLD_YAML,
  commandKeyOf,
  isInterpretiveKey,
  type WalkFace,
} from './render-walk.manifest.js';

let server: TestServer;
let provider: CliRunner;
let consumer: CliRunner;
const stamp = Date.now().toString(36);

/** Resolved seed ids — faces reference {placeholders} that this map fills. */
const ids: Record<string, string> = {};

function resolveArgv(argv: string[]): string[] {
  return argv.map(arg => arg.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = ids[key];
    if (value === undefined) throw new Error(`unknown seed placeholder {${key}} — the seed must register it`);
    return value;
  }));
}

beforeAll(async () => {
  // T119: the `admin users list` walk face needs an ADMIN session. The
  // harness boots the server with `...process.env`, so the walker opens the
  // ADMIN_EMAILS gate for ITS OWN provider address just for the boot (the
  // spawn inherits the value; the parent env is restored immediately —
  // nothing leaks to other suites).
  const previousAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = `walk-p-${stamp}@example.com`;
  server = await bootServer();
  process.env.ADMIN_EMAILS = previousAdminEmails;
  provider = makeCli(server.baseUrl);
  consumer = makeCli(server.baseUrl);

  expect(
    (await provider.cli('auth', 'register', '--email', `walk-p-${stamp}@example.com`, '--password', 'password-123', '--name', 'Walk Provider')).code,
  ).toBe(0);
  expect(
    (await consumer.cli('auth', 'register', '--email', `walk-c-${stamp}@example.com`, '--password', 'password-123', '--name', 'Walk Consumer')).code,
  ).toBe(0);

  writeFileSync(join(provider.home, 'world.yaml'), WALK_WORLD_YAML);
  const applied = await provider.cli('apply', '-f', 'world.yaml', '--json');
  expect(applied.code, `world apply failed: ${applied.stderr || applied.stdout}`).toBe(0);
  const envId = applied.json().envId as string;
  ids.envId = envId;

  expect(
    (await consumer.cli('env', 'join', 'r8-walk-lab')).code,
    'consumer env join failed',
  ).toBe(0);

  // Read back the seeded topology through the API (provider session).
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `walk-p-${stamp}@example.com`, password: 'password-123' }),
  });
  const token = ((await login.json()) as { token: string }).token;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const detail = (await (await fetch(`${server.baseUrl}/api/environments/${envId}`, { headers: auth })).json()) as {
    id: string;
    devices: Array<{ id: string; name: string }>;
    agents: Array<{ id: string; name: string }>;
  };
  ids.hvacA = detail.devices.find(device => device.name === 'HVAC A')!.id;
  ids.fallSensorB = detail.devices.find(device => device.name === 'Fall Sensor B')!.id;
  ids.steward = detail.agents.find(agent => agent.name === 'Campus Steward')!.id;

  // Publish the two judgment faces through the real API (T68 lesson: no
  // hand-written payloads):
  // - 'turn-on' resolves to TWO bound devices → signability ambiguous.
  // - 'curtain-control' resolves to none → signability unbacked.
  const publish = async (name: string, semanticType: string, visibility?: string): Promise<string> => {
    const response = await fetch(
      `${server.baseUrl}/api/environments/${envId}/agents/${ids.steward}/services`,
      { method: 'POST', headers: auth, body: JSON.stringify({ name, semanticType, ...(visibility !== undefined ? { visibility } : {}) }) },
    );
    if (response.status !== 201) {
      throw new Error(`publish ${name} failed: ${response.status} ${await response.text()}`);
    }
    return ((await response.json()) as { id: string }).id;
  };
  ids.svcAmbiguous = await publish('Campus Turn-on (published)', 'turn-on');
  ids.svcUnbacked = await publish('Curtain Control', 'curtain-control');

  // Capability-minted derived rows: temperature-monitoring stays declared
  // (the backed face), hvac-control is about to be withdrawn (the drift face).
  const listed = (await provider.cli('service', 'list', '--env', 'r8-walk-lab', '--json')).json() as Array<{
    id: string;
    semanticType: string;
    origin: string;
    signability?: { verdict: string };
  }>;
  ids.svcBacked = listed.find(row => row.origin === 'derived' && row.semanticType === 'temperature-monitoring')!.id;
  ids.svcDrift = listed.find(row => row.origin === 'derived' && row.semanticType === 'hvac-control')!.id;
  // T84 (R10, u1-F3): the auto-minted read lane on the never-written sensor
  // placeholder (temperature-sensing × initialState {temperature: 24.5}).
  ids.svcUnwritten = listed.find(row => row.origin === 'derived' && row.semanticType === 'temperature-sensing')!.id;

  // The data service: publish + register the event-counting computation +
  // contract it with terms.read (the T77 empty-window face needs a real read).
  ids.svcData = await publish('Climate Reading', 'climate-reading');
  expect(
    (await provider.cli('service', 'computation', 'register', ids.svcData,
      '--spec', JSON.stringify(WALK_READ_SPEC), '--interface', JSON.stringify(WALK_READ_IFACE), '--json')).code,
  ).toBe(0);
  const proposed = await consumer.cli(
    'agreement', 'propose', ids.svcData,
    '--terms', JSON.stringify({ read: { fields: ['avgTemperature', 'activeFallAlerts'] } }),
    '--json',
  );
  expect(proposed.code).toBe(0);
  ids.agreementId = proposed.json().id as string;
  expect((await provider.cli('agreement', 'decide', ids.agreementId, 'accept', '--json')).code).toBe(0);

  // T85 (R10, u4-F1): a MIXED ghost+declared event spec with two accepted
  // agreements — one per field — so both empty-window classification faces
  // walk against a real service (ghost copy for meteor-strike; the T57a
  // plain-window advice for the declared fall-detected sibling).
  ids.svcMixed = await publish('Mixed Event Reading', 'mixed-event-reading');
  expect(
    (await provider.cli('service', 'computation', 'register', ids.svcMixed,
      '--spec', JSON.stringify(WALK_MIXED_SPEC), '--interface', JSON.stringify(WALK_MIXED_IFACE), '--json')).code,
  ).toBe(0);
  for (const [fields, key] of [
    [['ghostAlerts'], 'agreementGhostField'],
    [['fallAlerts'], 'agreementDeclaredField'],
  ] as const) {
    const proposedMixed = await consumer.cli(
      'agreement', 'propose', ids.svcMixed,
      '--terms', JSON.stringify({ read: { fields } }),
      '--json',
    );
    expect(proposedMixed.code, proposedMixed.stderr || proposedMixed.stdout).toBe(0);
    ids[key] = proposedMixed.json().id as string;
    expect((await provider.cli('agreement', 'decide', ids[key], 'accept', '--json')).code).toBe(0);
  }

  // A live sim so status/snapshot/eval have a world to read.
  const sim = await consumer.cli('sim', 'create', '--env', 'r8-walk-lab', '--json');
  expect(sim.code).toBe(0);
  ids.simId = sim.json().id as string;
  expect((await consumer.cli('sim', 'start', ids.simId)).code).toBe(0);

  // ---------------------------------------------------------------------
  // T119 (C1, G5) seed additions — 只增不减. Everything below is additive:
  // one unique-capability offer (Info Board / `activate`) so the invoke +
  // lifecycle family has a signable single-device service; three scratch
  // agreements (lifecycle / counter / remind); three flows; one standing
  // ask; one access request + grant.
  // ---------------------------------------------------------------------
  ids.svcActivate = await publish('Board Activate', 'activate');

  // The lifecycle agreement: propose → accept → the walk drives
  // invoke → hold → resume → suspend → terminate on it (in that order).
  const proposedLifecycle = await consumer.cli(
    'agreement', 'propose', ids.svcActivate,
    '--terms', JSON.stringify({ action: { command: 'activate' } }),
    '--json',
  );
  expect(proposedLifecycle.code, proposedLifecycle.stderr || proposedLifecycle.stdout).toBe(0);
  ids.agreementLifecycle = proposedLifecycle.json().id as string;
  expect((await provider.cli('agreement', 'decide', ids.agreementLifecycle, 'accept', '--json')).code).toBe(0);

  // The counter chain: propose → (the named T119 block counters, then the
  // consumer decides reject — single runs, no walker double-run).
  const proposedCounter = await consumer.cli(
    'agreement', 'propose', ids.svcActivate,
    '--terms', JSON.stringify({ action: { command: 'activate' } }),
    '--json',
  );
  expect(proposedCounter.code).toBe(0);
  ids.agreementCounter = proposedCounter.json().id as string;

  // The remind target: a proposal that stays `proposed` — the named block
  // pins the honest T-309 rate-limit refusal (earliest remind = creation
  // + 10 min) instead of waiting out the wall clock.
  const proposedRemind = await consumer.cli(
    'agreement', 'propose', ids.svcActivate,
    '--terms', JSON.stringify({ action: { command: 'activate' } }),
    '--json',
  );
  expect(proposedRemind.code).toBe(0);
  ids.agreementRemind = proposedRemind.json().id as string;

  // The suspend/terminate target: a second ACTIVE agreement the named block
  // drives to its terminal states (the lifecycle agreement above must still
  // be ACTIVE when the walker's invoke face runs later).
  const proposedSuspend = await consumer.cli(
    'agreement', 'propose', ids.svcActivate,
    '--terms', JSON.stringify({ action: { command: 'activate' } }),
    '--json',
  );
  expect(proposedSuspend.code).toBe(0);
  ids.agreementSuspend = proposedSuspend.json().id as string;
  expect((await provider.cli('agreement', 'decide', ids.agreementSuspend, 'accept', '--json')).code).toBe(0);

  // The flow family: ghost-trigger (T78 warning face), clean run flow
  // (sim run-flow + flow runs), scratch (update/disable/enable/rm chain).
  writeFileSync(join(provider.home, 'walk-ghost-flow.yaml'), WALK_GHOST_FLOW_YAML);
  writeFileSync(join(provider.home, 'walk-run-flow.yaml'), WALK_RUN_FLOW_YAML);
  writeFileSync(join(provider.home, 'walk-scratch-flow.yaml'), WALK_SCRATCH_FLOW_YAML);
  const addFlow = async (file: string): Promise<string> => {
    const added = await provider.cli('flow', 'add', '--env', 'r8-walk-lab', '--file', file, '--json');
    expect(added.code, added.stderr || added.stdout).toBe(0);
    return added.json().id as string;
  };
  ids.flowGhost = await addFlow('walk-ghost-flow.yaml');
  ids.flowRun = await addFlow('walk-run-flow.yaml');
  ids.flowScratch = await addFlow('walk-scratch-flow.yaml');
  // A second expendable scratch for the named block's single-run `flow rm`.
  writeFileSync(
    join(provider.home, 'walk-scratch2-flow.yaml'),
    WALK_SCRATCH_FLOW_YAML.replace('Walk Scratch Flow', 'Walk Scratch Flow II'),
  );
  ids.flowScratch2 = await addFlow('walk-scratch2-flow.yaml');

  // The standing ask (open board row for the asks face; nothing publishes
  // air-quality-monitoring, so it stays open deterministically).
  expect(
    (await consumer.cli('env', 'asks', 'create', 'r8-walk-lab', '--type', 'air-quality-monitoring',
      '--note', 'want lobby air-quality readings', '--json')).code,
  ).toBe(0);

  // The consent pair: access requests exist ONLY for HIDDEN services (a
  // public offer is already visible — SERVICE_NOT_HIDDEN), so the seed
  // publishes a hidden offer for the consumer to request and the provider
  // to grant with a recorded basis — the two consent rosters walk with
  // real rows.
  ids.svcHidden = await publish('Hidden Archive', 'archive-reading', 'hidden');
  const accessRequest = await consumer.cli(
    'service', 'access', 'request', ids.svcHidden, '--purpose', 'walk-lab data audit', '--json',
  );
  expect(accessRequest.code, accessRequest.stderr || accessRequest.stdout).toBe(0);
  const accessRequestId = (accessRequest.json() as { id: string }).id;
  expect(
    (await provider.cli('service', 'access', 'grant', ids.svcHidden,
      '--request', accessRequestId,
      '--expires', new Date(Date.now() + 7 * 86_400_000).toISOString(),
      '--basis', 'walk-lab consent', '--json')).code,
  ).toBe(0);

  // Read faces for the batch B placeholders: catalog model, scenario
  // template, builtin blueprint — all fetched through the real faces.
  const catalog = await consumer.cli('catalog', 'list', '--json');
  expect(catalog.code).toBe(0);
  ids.catalogModel = (catalog.json() as Array<{ id: string }>)[0].id;
  const templates = await consumer.cli('scenario-templates', 'list', '--json');
  expect(templates.code, templates.stderr || templates.stdout).toBe(0);
  ids.scenarioTemplate = (templates.json() as { templates: Array<{ id: string }> }).templates[0].id;
  const blueprints = await consumer.cli('blueprint', 'list', '--json');
  expect(blueprints.code, blueprints.stderr || blueprints.stdout).toBe(0);
  ids.blueprint = (blueprints.json() as Array<{ id: string }>)[0].id;

  // Drift LAST (after the backed face's payload was read): withdraw
  // hvac-control from the steward's declarations — the derived row survives
  // with declaredByProvider:false (identity stability). `activate`/
  // `deactivate` STAY declared: the invoke/lifecycle faces need the offer
  // backed and drift-free.
  const driftUpdate = await provider.cli(
    'agent', 'update', ids.steward, '--capabilities', 'fall-monitoring,temperature-monitoring,temperature-sensing,activate,deactivate',
  );
  expect(driftUpdate.code, `agent update (drift) failed: ${driftUpdate.stderr || driftUpdate.stdout}`).toBe(0);
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

// ---------------------------------------------------------------------------
// T72/T77 named regressions — merged-stream (2>&1) AND stdout asserted
// separately, the R8 test-method lesson. A regression back to warn()/stderr
// turns BOTH assertions red (stdout misses the anchor).
// ---------------------------------------------------------------------------

describe('T72 (R8): explanatory service-get lines ride STDOUT in human mode', () => {
  test('declaration drift ⚠: stdout carries it, stderr does not, merged stream matches stdout', async () => {
    const human = await consumer.cli('service', 'get', ids.svcDrift!);
    expect(human.code).toBe(0);
    const merged = human.stdout + human.stderr;
    // stdout 取证 (the assertion that was missing for two rounds):
    expect(human.stdout).toContain('⚠ provider 未声明');
    expect(human.stdout).toContain('declaredByProvider:false');
    // merged-stream 取证 (the R9 acceptance protocol):
    expect(merged).toContain('⚠ provider 未声明');
    expect(human.stderr).not.toContain('provider 未声明');
  });

  test('signability ambiguous + gate reason: stdout carries verdict, candidates, and the reason', async () => {
    const human = await consumer.cli('service', 'get', ids.svcAmbiguous!);
    expect(human.code).toBe(0);
    const merged = human.stdout + human.stderr;
    for (const anchor of ['signability: ambiguous', 'SERVICE_BACKING_AMBIGUOUS', 'signability reason:']) {
      expect(human.stdout).toContain(anchor);
      expect(merged).toContain(anchor);
    }
    expect(human.stdout).toContain('HVAC A');
    expect(human.stdout).toContain('HVAC B');
    expect(human.stderr).not.toContain('signability');
  });

  test('signability unbacked + reason: stdout carries the refusal teaching', async () => {
    const human = await consumer.cli('service', 'get', ids.svcUnbacked!);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('signability: unbacked');
    expect(human.stdout).toContain('SERVICE_NOT_BACKED');
    expect(human.stdout).toContain('signability reason: no bound device');
    expect(human.stderr).not.toContain('SERVICE_NOT_BACKED');
  });

  test('--json stdout stays pure (parseable, payload carries the same facts), stderr carries no human face', async () => {
    const json = await consumer.cli('service', 'get', ids.svcAmbiguous!, '--json');
    expect(json.code).toBe(0);
    const payload = json.json() as { signability?: { verdict: string; reason?: string }; declaredByProvider?: boolean };
    expect(payload.signability?.verdict).toBe('ambiguous');
    expect(payload.signability?.reason).toContain('SERVICE_BACKING_AMBIGUOUS');
    // The json face never renders the human lines (stdout is data-only).
    expect(json.stderr).not.toContain('signability:');
  });
});

describe('T77 (R8): the agreement-read empty-window ⚠ rides STDOUT (fresh path)', () => {
  test('the seeded read is deterministically empty-windowed (event-count metric, zero events)', async () => {
    const json = await consumer.cli('agreement', 'read', ids.agreementId!, '--json');
    expect(json.code).toBe(0);
    expect((json.json() as { frame: { emptyEventWindow: boolean } }).frame.emptyEventWindow).toBe(true);
  });

  test('human mode: stdout carries the ⚠ + the honest-0 teaching; stderr does not', async () => {
    const human = await consumer.cli('agreement', 'read', ids.agreementId!);
    expect(human.code).toBe(0);
    const merged = human.stdout + human.stderr;
    for (const anchor of ['⚠ 事件窗为空', '不是真实读数']) {
      expect(human.stdout).toContain(anchor);
      expect(merged).toContain(anchor);
    }
    expect(human.stderr).not.toContain('事件窗为空');
  });

  test('cached path (--latest): the ⚠ still reaches stdout', async () => {
    const latest = await consumer.cli('agreement', 'read', ids.agreementId!, '--latest');
    expect(latest.code).toBe(0);
    expect(latest.stdout).toContain('事件窗为空');
    expect(latest.stderr).not.toContain('事件窗为空');
  });
});

// ---------------------------------------------------------------------------
// T94 (R14, u4-P1): `env activity` — the human face must render DATA rows,
// never a bare header. The manifest face walked with empty anchors, which is
// exactly why the u4 regression (JSON had rows, human printed only the
// header vocabulary) could ship invisibly; the face now declares anchors
// (manifest) and this named regression pins the row + count-line contract
// against the real seeded feed.
// ---------------------------------------------------------------------------

describe('T94 (R14, u4-P1): env activity human face carries data rows and the count line', () => {
  test('rows on stdout (header + entries + count), stderr clean in human mode', async () => {
    const human = await provider.cli('env', 'activity', 'r8-walk-lab', '--limit', '10');
    expect(human.code).toBe(0);
    const lines = human.stdout.split('\n').filter(line => line.trim().length > 0);
    // The header vocabulary is the first line…
    expect(lines[0]).toContain('time');
    expect(lines[0]).toContain('summary');
    // …and DATA rows follow it (the u4 regression: header with zero rows).
    expect(lines.length).toBeGreaterThan(1);
    expect(human.stdout).toContain('command');
    // The count line makes the payload self-evidencing (R102: human ≥ json) —
    // language-agnostic (the CLI is en-first; zh patches ride --lang zh-CN).
    expect(human.stdout).toMatch(/共 \d+ 条动态|(\d+) recent entries/);
    // stdout 取证 vs merged-stream 取证 (the R8 two-capture protocol).
    const merged = human.stdout + human.stderr;
    expect(merged).toContain('command');
    expect(human.stderr).not.toMatch(/条动态|recent entries/);
  });

  test('--json stays the row-count oracle: the human row count matches the payload', async () => {
    const json = await provider.cli('env', 'activity', 'r8-walk-lab', '--limit', '10', '--json');
    expect(json.code).toBe(0);
    const payload = json.json() as Array<Record<string, unknown>>;
    expect(payload.length).toBeGreaterThan(0);
    const human = await provider.cli('env', 'activity', 'r8-walk-lab', '--limit', '10');
    const dataRows = human.stdout
      .split('\n')
      .filter(line => /^\d{4}-\d{2}-\d{2}T/.test(line));
    expect(dataRows.length).toBe(payload.length);
  });
});

// ---------------------------------------------------------------------------
// T119 (C1, G5) named regression — `flow get` R102 fix. The GET payload has
// carried `validationWarnings` since T78 (the ghost-trigger annotation rides
// every read face server-side), but the human detail face rendered only the
// drift line: a flow that can never fire read as silently healthy. The walk
// face's anchors are the regression (red before the fix); this block pins
// the stream discipline on top — the warning rides STDOUT in human mode and
// the merged stream matches (the R8 two-capture protocol).
// ---------------------------------------------------------------------------

describe('T119 (C1): flow get renders the stored validationWarnings on the human face', () => {
  test('ghost-trigger flow: stdout carries the warning; stderr stays clean; merged matches', async () => {
    const human = await provider.cli('flow', 'get', ids.flowGhost!);
    expect(human.code).toBe(0);
    const merged = human.stdout + human.stderr;
    for (const anchor of ['warning: ', 'alien-invasion', 'this world declares: fall-detected']) {
      expect(human.stdout, `human stdout missing "${anchor}"`).toContain(anchor);
      expect(merged, `merged stream missing "${anchor}"`).toContain(anchor);
    }
    expect(human.stderr).not.toContain('alien-invasion');
  });

  test('--json face unchanged: the payload still carries the structured warning', async () => {
    const json = await provider.cli('flow', 'get', ids.flowGhost!, '--json');
    expect(json.code).toBe(0);
    const warnings = (json.json() as { validationWarnings?: string[] }).validationWarnings;
    expect(warnings?.join(' ')).toContain('alien-invasion');
  });
});

// ---------------------------------------------------------------------------
// T85 (R8): AC termination notifications branch on the collaboration OUTCOME
// (partial must not announce "已完成"). Unit-level: the funnel's title logic
// exercised through the real bridge class is integration-heavy; the
// notification SUITE covers the loop end-to-end — here the title table is
// pinned so a revert to the two-cause wording fails fast.
// ---------------------------------------------------------------------------

describe('T85 (R8): termination-notification title table (outcome-branched)', () => {
  test('the bridge source branches three ways on outcome, not two ways on cause', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'server', 'src', 'ac-agreement-bridge.ts'),
      'utf8',
    );
    expect(source).toContain("outcome === 'partial'");
    expect(source).toContain('协作部分达成，其临时合约已终止');
    expect(source).toContain('协作未达成，其临时合约已终止');
    expect(source).toContain('协作已完成，其临时合约已终止');
    expect(source).toContain("'ac-completed', outcome)");
  });
});

// ---------------------------------------------------------------------------
// T80 (R9, u2-F1): the sim command lane's honest refusal — a command that is
// lexically near but NOT on the device's executable face is a 400
// UNKNOWN_COMMAND with the surface named, never a fake success wearing the
// sensor reading as a control result. The 400 face cannot ride WALK_FACES
// (the walker requires exit 0), so it is pinned here against the same real
// server — stdout and merged-stream asserted SEPARATELY (the R9 protocol).
// ---------------------------------------------------------------------------

describe('T80 (R9): sim command refuses unsupported commands honestly', () => {
  test('--json: stdout carries the structured UNKNOWN_COMMAND error; the refusal names the surface', async () => {
    const jsonRun = await consumer.cli(
      'sim', 'command', ids.simId!, '--device', ids.fallSensorB!, '--cmd', 'temperature-control', '--json',
    );
    expect(jsonRun.code).not.toBe(0);
    const payload = jsonRun.json() as { error?: { code?: string; message?: string } };
    expect(payload.error?.code).toBe('UNKNOWN_COMMAND');
    expect(payload.error?.message).toContain('temperature-control');
    expect(payload.error?.message).toContain('fall-monitoring'); // the device's face, taught
    expect(jsonRun.stdout).not.toContain('"success": true');
  });

  test('human: the merged stream carries the error; neither stream says "command ok"', async () => {
    const human = await consumer.cli(
      'sim', 'command', ids.simId!, '--device', ids.fallSensorB!, '--cmd', 'temperature-control',
    );
    expect(human.code).not.toBe(0);
    const merged = human.stdout + human.stderr;
    expect(merged).toContain('UNKNOWN_COMMAND');
    expect(merged).toContain('fall-monitoring');
    expect(merged).not.toContain('command ok');
    expect(human.stdout).not.toContain('command ok');
  });
});

// ---------------------------------------------------------------------------
// The walker: completeness, vocabulary anchors, stream discipline, hygiene.
// ---------------------------------------------------------------------------

/** Walk a JSON payload tree, collecting interpretive-key paths (basename-matched). */
export function collectInterpretivePaths(payload: unknown, prefix = ''): string[] {
  const hits: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach(item => walk(item, path));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const childPath = `${path}${path.length > 0 ? '.' : ''}${key}`;
        if (isInterpretiveKey(key)) hits.push(childPath);
        walk(child, childPath);
      }
    }
  };
  walk(payload, prefix);
  return hits;
}

// Hygiene rules (triage-r8.md §T79): zero per-face cost, face allowlists for
// the faces whose payload IS an id (e.g. `service get`'s first line).
const BARE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_HEX_RUN = /\b[0-9a-f]{16,}\b/i;
const RAW_FLOAT = /(^|[^0-9a-zA-Z_.-])[-+]?\d+\.\d{3,}($|[^0-9])/;
// Scientific notation with hex-run exclusion: a real exponent (1e-65, 6.6e-24)
// must not be confused with hex id fragments like the "0e3e" inside
// 59fa0e3e-… — hence the non-hex guards around mantissa and exponent.
const SCIENTIFIC = /(^|[^0-9a-fA-F.])\d+(?:\.\d+)?[eE][+-]?\d+($|[^0-9a-fA-F])/;
const TEMPLATE_RESIDUE = /\$\{/;
/** ISO timestamps are machine fields, not display-precision measurements —
 *  they are stripped before the numeric hygiene sweeps look at a face. */
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})/g;
/** Id-shaped hex tokens (UUIDs, dashed or bare) — stripped for the NUMERIC
 *  sweeps so their fragments ("49e0" inside a uuid, "0e3e") cannot pose as
 *  float noise; the bare-id RULE above still reads the raw stdout. */
const HEX_ID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{12,}\b/gi;

function firstMatch(re: RegExp, text: string): string {
  const m = re.exec(text);
  return m === null ? '(no match)' : JSON.stringify(m[0]);
}

function hygieneViolations(face: WalkFace, rawStdout: string): string[] {
  const violations: string[] = [];
  if (!face.hygiene?.bareIdOk && (BARE_UUID.test(rawStdout) || LONG_HEX_RUN.test(rawStdout))) {
    violations.push(
      `bare UUID/long-hex id on the human face (name it or register bareIdOk): ${firstMatch(BARE_UUID, rawStdout)}`,
    );
  }
  // Numeric sweeps run on the stdout WITHOUT timestamps/id-hex tokens.
  const stdout = rawStdout.replace(ISO_TIMESTAMP, '<ts>').replace(HEX_ID_TOKEN, '<id>');
  if (!face.hygiene?.bareFloatOk && RAW_FLOAT.test(stdout)) {
    violations.push(
      `raw >2-decimal float on the human face (round to the display convention): ${firstMatch(RAW_FLOAT, stdout)}`,
    );
  }
  if (SCIENTIFIC.test(stdout)) violations.push(`scientific notation on the human face: ${firstMatch(SCIENTIFIC, stdout)}`);
  // templateOk (T119): a face whose PAYLOAD legitimately carries the
  // platform's own `${…}` slot syntax (blueprint install slots) declares it;
  // the residue rule stays armed for every other face.
  if (!face.hygiene?.templateOk && TEMPLATE_RESIDUE.test(stdout)) {
    violations.push(`template residue (${firstMatch(TEMPLATE_RESIDUE, stdout)}…) on the human face`);
  }
  for (const line of stdout.split('\n')) {
    const backticks = (line.match(/`/g) ?? []).length;
    if (backticks % 2 === 1) violations.push(`unbalanced backtick (template residue): ${line.slice(0, 80)}`);
  }
  return violations;
}

describe('T79 walker: manifest faces over the real server', () => {
  test('the vocabulary is versioned and the manifest is non-empty', () => {
    expect(VOCAB_VERSION).toMatch(/^r8-v\d+$/);
    expect(WALK_FACES.length).toBeGreaterThanOrEqual(30);
  });

  test('completeness: every command face is walked OR exempted with a written reason', () => {
    const walked = new Set<string>();
    for (const face of WALK_FACES) {
      const key = commandKeyOf(face.argv);
      expect(key, `face "${face.face}" must map onto the command surface`).not.toBe('');
      walked.add(key);
    }
    const unknown = [...walked].filter(key => !COMMAND_SURFACE.includes(key));
    expect(unknown, 'manifest faces must name real commands (typo guard)').toEqual([]);
    const uncovered = COMMAND_SURFACE.filter(command => !walked.has(command) && EXEMPT_COMMANDS[command] === undefined);
    expect(
      uncovered,
      'every new command must register a walk face or an exemption with a written reason (T79 gate)',
    ).toEqual([]);
    for (const [command, exemption] of Object.entries(EXEMPT_COMMANDS)) {
      expect(exemption.reason.length, `exemption for ${command} needs a real reason`).toBeGreaterThan(10);
      // T119 (C1, G5): placeholder exemptions are how the table rotted —
      // "increment batch" (14 entries by T119's audit) says WHEN, never WHY,
      // and the stale "Lane B rides…" reasons outlived the lanes they named.
      expect(
        /increment batch/i.test(exemption.reason),
        `exemption for ${command} is a placeholder ("increment batch") — write the semantic reason ` +
          '(who watches this face, why the walker does not) or walk it (T119 ruling)',
      ).toBe(false);
    }
    // T119 (C1, G5) D1: the ledger must ADD UP, explicitly. The walked set is
    // folded through commandKeyOf (multi-face commands collapse — `service
    // get` ×5 faces is one key), so the identity is walked-keys + exempt ==
    // the whole surface, and every number on the printed line is DERIVED
    // (COMMAND_SURFACE.length is the only literal; the line follows the
    // command table when it grows).
    expect(walked.size + Object.keys(EXEMPT_COMMANDS).length).toBe(COMMAND_SURFACE.length);
    console.log(
      `command surfaces: ${COMMAND_SURFACE.length}, walked: ${walked.size}, ` +
        `exempt: ${Object.keys(EXEMPT_COMMANDS).length}, walked+exempt=${COMMAND_SURFACE.length}`,
    );
  });

  for (const face of WALK_FACES) {
    test(`walk: ${face.face}`, async () => {
      const argv = resolveArgv(face.argv);
      // T81 (R9): provider-owned write faces run their own session.
      const runner = face.actor === 'provider' ? provider : consumer;
      const jsonRun = await runner.cli(...argv, '--json');
      expect(jsonRun.code, `--json run failed for ${face.face}: ${jsonRun.stderr}`).toBe(0);
      const payload = jsonRun.json();

      const human = await runner.cli(...argv);
      expect(human.code, `human run failed for ${face.face}: ${human.stderr}`).toBe(0);
      const merged = human.stdout + human.stderr;

      // 1. Stream discipline (T72 encoded): every declared anchor must be
      // findable on STDOUT alone — a line that only the merged stream sees
      // is the warn()-to-stderr regression, verbatim.
      for (const [field, anchors] of Object.entries(face.anchors)) {
        for (const anchor of anchors) {
          expect(
            human.stdout.includes(anchor),
            `[${face.face}] anchor "${anchor}" (field ${field}) missing from human STDOUT — ` +
              'it rode stderr (T72 regression) or the face lost the line',
          ).toBe(true);
          expect(merged.includes(anchor), `[${face.face}] anchor "${anchor}" missing from the merged stream`).toBe(true);
        }
      }

      // 2. R102 vocabulary walk: every interpretive key in the --json payload
      // must have declared anchors (with the anchors present) or an exemption.
      // ALL gaps are collected and reported together — one run reveals every
      // missing anchor on a face (the increment path lands one run, not N).
      const hits = collectInterpretivePaths(payload);
      const exemptKeys = new Set((face.exempt ?? []).map(entry => entry.key));
      const gaps: string[] = [];
      for (const path of hits) {
        const basename = path.split('.').pop()!;
        const declared = face.anchors[path] ?? face.anchors[basename];
        if (declared === undefined && !exemptKeys.has(path) && !exemptKeys.has(basename)) {
          const rendered = JSON.stringify(payload);
          const preview = rendered.slice(Math.max(0, rendered.indexOf(basename) - 40), rendered.indexOf(basename) + 80);
          gaps.push(
            `"${path}" has NO human anchors and NO exemption (vocabulary ${VOCAB_VERSION}) — payload vicinity: …${preview}…`,
          );
          continue;
        }
        for (const anchor of declared ?? []) {
          expect(
            human.stdout.includes(anchor),
            `[${face.face}] anchor "${anchor}" for ${path} missing from human stdout`,
          ).toBe(true);
        }
      }
      expect(
        gaps,
        `[${face.face}] interpretive json fields without a human face (R102: human ≥ json — declare anchors in the ` +
          `manifest or register an exemption with a written reason):\n${gaps.join('\n')}`,
      ).toEqual([]);

      // 3. Hygiene sweep on the human stdout.
      const violations = hygieneViolations(face, human.stdout);
      expect(violations, `[${face.face}] hygiene violations:\n${violations.join('\n')}`).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// T119 (C1): the negotiation + lifecycle WRITE faces — one-shot transitions
// pinned SINGLE-RUN. The walker executes every face twice (--json then
// human), so a state transition would fail its own second run (T119 gap
// report evidence: flow rm → FLOW_NOT_FOUND, counter →
// AGREEMENT_NOT_PROPOSED); `agreement remind` is rate-limited to
// proposal-creation + 10 min (REMIND_RATE_LIMITED) and cannot run in any
// batch harness at all. These blocks are the faces' R102 anchoring: stdout
// and merged-stream asserted separately (the R8 protocol).
// ---------------------------------------------------------------------------

describe('T119 (C1): negotiation write faces (counter / decide / remind refusal)', () => {
  test('counter: the T-059 echo names the consumer as decider; payload flips to countered', async () => {
    const human = await provider.cli('agreement', 'counter', ids.agreementCounter!,
      '--terms', JSON.stringify({ action: { command: 'deactivate' } }));
    expect(human.code).toBe(0);
    const merged = human.stdout + human.stderr;
    expect(human.stdout).toContain('countered');
    expect(human.stdout).toContain('the consumer decides');
    expect(merged).toContain('the consumer decides');
    const json = await provider.cli('agreement', 'get', ids.agreementCounter!, '--json');
    expect((json.json() as { status: string }).status).toBe('countered');
  });

  test('decide reject: the consumer ends the countered proposal; echo carries the decision', async () => {
    const human = await consumer.cli('agreement', 'decide', ids.agreementCounter!, 'reject');
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('→ rejected (reject)');
    expect(human.stdout + human.stderr).toContain('→ rejected (reject)');
  });

  test('remind on a fresh proposal: the honest T-309 rate-limit refusal (no wall-clock wait)', async () => {
    const json = await consumer.cli('agreement', 'remind', ids.agreementRemind!, '--json');
    expect(json.code).not.toBe(0);
    const payload = json.json() as { error?: { code?: string; message?: string } };
    expect(payload.error?.code).toBe('REMIND_RATE_LIMITED');
    expect(payload.error?.message).toContain('10 min');
    const human = await consumer.cli('agreement', 'remind', ids.agreementRemind!);
    expect(human.code).not.toBe(0);
    expect(human.stdout + human.stderr).toContain('REMIND_RATE_LIMITED');
  });
});

describe('T119 (C1): lifecycle write faces (hold / resume / suspend / terminate)', () => {
  /** A fresh ACTIVE agreement per echo — each one-shot gets its own single run. */
  const freshActive = async (): Promise<string> => {
    const proposed = await consumer.cli('agreement', 'propose', ids.svcActivate!,
      '--terms', JSON.stringify({ action: { command: 'activate' } }), '--json');
    expect(proposed.code, proposed.stderr || proposed.stdout).toBe(0);
    const id = proposed.json().id as string;
    expect((await provider.cli('agreement', 'decide', id, 'accept', '--json')).code).toBe(0);
    return id;
  };

  test('hold: held echo carries holdExpiresAt on stdout; payload records it (D3/T-080)', async () => {
    const jsonTarget = await freshActive();
    const json = await consumer.cli('agreement', 'hold', jsonTarget, '--duration', '600', '--json');
    expect(json.code).toBe(0);
    expect(typeof (json.json() as { holdExpiresAt?: string }).holdExpiresAt).toBe('string');
    const humanTarget = await freshActive();
    const human = await consumer.cli('agreement', 'hold', humanTarget, '--duration', '600');
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('→ held (until ');
    expect(human.stdout + human.stderr).toContain('→ held (until ');
  });

  test('resume: the held agreement returns to active', async () => {
    const id = await freshActive();
    expect((await consumer.cli('agreement', 'hold', id, '--duration', '600')).code).toBe(0);
    const human = await consumer.cli('agreement', 'resume', id);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('→ active');
  });

  test('suspend: v60 statusReason recorded and rendered on the detail face', async () => {
    const json = await provider.cli('agreement', 'suspend', ids.agreementSuspend!,
      '--reason', 'walk-lab suspend drill', '--json');
    expect(json.code).toBe(0);
    expect((json.json() as { statusReason?: string }).statusReason).toBe('walk-lab suspend drill');
    const human = await provider.cli('agreement', 'get', ids.agreementSuspend!);
    expect(human.stdout).toContain('reason: walk-lab suspend drill');
  });

  test('suspend echo: the R99 irreversibility teaching rides stdout (fresh agreement, single run)', async () => {
    const id = await freshActive();
    const human = await provider.cli('agreement', 'suspend', id, '--reason', 'walk-lab suspend drill');
    expect(human.code).toBe(0);
    const merged = human.stdout + human.stderr;
    expect(human.stdout).toContain('(reason: walk-lab suspend drill)');
    expect(human.stdout).toContain('⚠ suspend 不可恢复');
    expect(merged).toContain('⚠ suspend 不可恢复');
    expect(human.stderr).not.toContain('不可恢复');
  });

  test('terminate: terminal echo with the recorded statusReason; the state is final', async () => {
    // ids.agreementSuspend is suspended by the test above — terminate it.
    const human = await provider.cli('agreement', 'terminate', ids.agreementSuspend!, '--reason', 'walk-lab end');
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('→ terminated');
    expect(human.stdout).toContain('(reason: walk-lab end)');
    const json = await provider.cli('agreement', 'get', ids.agreementSuspend!, '--json');
    const payload = json.json() as { status: string; statusReason?: string };
    expect(payload.status).toBe('terminated');
    expect(payload.statusReason).toBe('walk-lab end');
  });
});

describe('T119 (C1): flow rm deletion echo (single-run; the walker double-run would 404)', () => {
  test('rm: deletion echo on stdout, audit row survives', async () => {
    const human = await provider.cli('flow', 'rm', ids.flowScratch2!);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('deleted flow');
    expect(human.stdout + human.stderr).toContain('deleted flow');
    const gone = await provider.cli('flow', 'get', ids.flowScratch2!, '--json');
    expect(gone.code).toBe(4); // FLOW_NOT_FOUND
  });
});

// Keep the CliResult import honest (used by future per-face deep assertions).
export type { CliResult };
