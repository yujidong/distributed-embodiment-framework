/**
 * `eaf flow` + `eaf agent update` + `eaf sim run-flow` tests — business flow
 * CRUD/validation relay, agent patching (enabled / llm-file with
 * systemPrompt), and manual flow triggering against the real server.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let eaf: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-flows-${stamp}`;
const EMAIL = `flow-${stamp}@example.com`;
const PASSWORD = 'password-123';

const FLOW_YAML = `name: Lamp on
description: turn the lamp on
trigger:
  kind: event
  eventType: test-event
plan:
  goal: turn the lamp on
  nodes:
    - id: n1
      capability: turn-on
`;

beforeAll(async () => {
  server = await bootServer();
  eaf = makeCli(server.baseUrl);
  expect(
    (await eaf.cli('auth', 'register', '--email', EMAIL, '--password', PASSWORD, '--name', 'Flow User')).code,
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
devices:
  - name: Lamp
    zone: room-a
    spec:
      type: light
      capabilities: [turn-on, turn-off]
  - name: Patrol Bot
    zone: room-a
    spec:
      type: security-robot
      capabilities: [patrol]
agents:
  - name: Lamp Agent
    capabilities: [turn-on, turn-off]
    bind: [Lamp, Patrol Bot]
    zones: [room-a]
`,
  );
  writeFileSync(join(eaf.home, 'flow.yaml'), FLOW_YAML);
  const applied = await eaf.cli('apply', '-f', 'world.yaml', '--json');
  expect(applied.code).toBe(0);
});

afterAll(async () => {
  await server?.stop();
});

let flowId: string;
let agentId: string;

describe('flow add / list / get', () => {
  test('add from a YAML file; list and get show it', async () => {
    const added = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'flow.yaml', '--json');
    expect(added.code).toBe(0);
    const flow = added.json();
    expect(flow.id).toBeTruthy();
    expect(flow.envId).toBeTruthy();
    expect(flow.name).toBe('Lamp on');
    expect(flow.enabled).toBe(true);
    expect(flow.trigger.kind).toBe('event');
    expect(flow.plan.nodes).toHaveLength(1);
    flowId = flow.id;

    const listed = await eaf.cli('flow', 'list', '--env', WORLD_NAME, '--json');
    expect(listed.code).toBe(0);
    expect((listed.json() as Array<{ id: string }>).map(f => f.id)).toContain(flowId);

    const human = await eaf.cli('flow', 'list', '--env', WORLD_NAME);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Lamp on');
    expect(human.stdout).toContain('event');

    const got = await eaf.cli('flow', 'get', flowId, '--json');
    expect(got.code).toBe(0);
    expect(got.json().id).toBe(flowId);
    expect(got.json().plan.goal).toBe('turn the lamp on');

    const humanGet = await eaf.cli('flow', 'get', flowId);
    expect(humanGet.code).toBe(0);
    expect(humanGet.stdout).toContain(flowId);
    expect(humanGet.stdout).toContain('trigger:');

    // --env is required; unknown flow ids are exit 4.
    expect((await eaf.cli('flow', 'list')).code).toBe(2);
    expect((await eaf.cli('flow', 'get', 'no-such-flow')).code).toBe(4);
  });

  test('FEAT-01: the three time-semantics forms add and render round-trip', async () => {
    // 23:30 就寝 — daily time-of-day anchor (84600).
    writeFileSync(
      join(eaf.home, 'flow-tod.yaml'),
      `name: Bedtime 23:30
trigger:
  kind: schedule
  atTimeOfDaySec: 84600
plan:
  goal: lights out
  nodes:
    - id: n1
      capability: turn-off
`,
    );
    const tod = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'flow-tod.yaml', '--json');
    expect(tod.code).toBe(0);
    expect(tod.json().trigger.atTimeOfDaySec).toBe(84600);

    // 22:00–06:00 时间窗 — condition active window (crossing midnight).
    writeFileSync(
      join(eaf.home, 'flow-window.yaml'),
      `name: Night watch
trigger:
  kind: condition
  zoneId: room-a
  conditions:
    - { path: motion, op: "==", value: true }
  activeWindowSimSec: [79200, 21600]
plan:
  goal: alert on night motion
  nodes:
    - id: n1
      capability: turn-on
`,
    );
    const night = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'flow-window.yaml', '--json');
    expect(night.code).toBe(0);
    expect(night.json().trigger.activeWindowSimSec).toEqual([79200, 21600]);

    // 到馆前 30 分钟预冷 — occupancy-relative anchor (unpinned: warns here
    // because room-a declares no occupantSchedule — honest, never silent).
    writeFileSync(
      join(eaf.home, 'flow-rel.yaml'),
      `name: Precool before arrival
trigger:
  kind: schedule
  relativeToOccupancy: { before: arrive, offsetSec: 1800 }
plan:
  goal: precool
  nodes:
    - id: n1
      capability: turn-on
`,
    );
    const rel = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'flow-rel.yaml', '--json');
    expect(rel.code).toBe(0);
    expect(rel.json().trigger.relativeToOccupancy).toEqual({ before: 'arrive', offsetSec: 1800 });

    // The human get face prints the full trigger JSON (R102: never thinner).
    const humanGet = await eaf.cli('flow', 'get', tod.json().id);
    expect(humanGet.code).toBe(0);
    expect(humanGet.stdout).toContain('atTimeOfDaySec');
    expect(humanGet.stdout).toContain('84600');

    // An empty window 422s with the teaching issue on stderr.
    writeFileSync(
      join(eaf.home, 'flow-empty-window.yaml'),
      `name: Empty window
trigger:
  kind: condition
  zoneId: room-a
  conditions:
    - { path: motion, op: "==", value: true }
  activeWindowSimSec: [12000, 12000]
plan:
  goal: never fires
  nodes:
    - id: n1
      capability: turn-on
`,
    );
    const empty = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'flow-empty-window.yaml');
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain('FLOW_INVALID');
    expect(empty.stderr).toContain('activeWindowSimSec');
  });

  test('add relays 422 FLOW_INVALID issues to stderr and exits non-zero', async () => {
    writeFileSync(
      join(eaf.home, 'bad-flow.yaml'),
      `name: Broken
trigger:
  kind: event
  eventType: test-event
plan:
  goal: nothing
  nodes: []
`,
    );
    const result = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'bad-flow.yaml');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('FLOW_INVALID');
    // Issues are PlanIssue objects — formatted as readable lines, not "[object Object]".
    expect(result.stderr).toMatch(/- error/);
    expect(result.stderr).not.toContain('[object Object]');
  });

  test('add rejects a malformed file as a usage error (exit 2)', async () => {
    writeFileSync(join(eaf.home, 'shapeless.yaml'), `name: No plan here\n`);
    const result = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'shapeless.yaml');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('plan');
  });
});

describe('flow update / enable / disable / rm', () => {
  test('update --name and enable/disable round-trip', async () => {
    const renamed = await eaf.cli('flow', 'update', flowId, '--name', 'Lamp on v2', '--json');
    expect(renamed.code).toBe(0);
    expect(renamed.json().name).toBe('Lamp on v2');

    const disabled = await eaf.cli('flow', 'disable', flowId, '--json');
    expect(disabled.code).toBe(0);
    expect(disabled.json().enabled).toBe(false);

    const enabled = await eaf.cli('flow', 'enable', flowId, '--json');
    expect(enabled.code).toBe(0);
    expect(enabled.json().enabled).toBe(true);

    const human = await eaf.cli('flow', 'disable', flowId);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('disabled');
    await eaf.cli('flow', 'enable', flowId);

    // --enable and --disable are mutually exclusive; no-change is a usage error.
    expect((await eaf.cli('flow', 'update', flowId, '--enable', '--disable')).code).toBe(2);
    expect((await eaf.cli('flow', 'update', flowId)).code).toBe(2);
  });

  test('update --file replaces trigger/plan (revalidated server-side)', async () => {
    writeFileSync(
      join(eaf.home, 'flow-v3.yaml'),
      `name: Lamp on v3
trigger:
  kind: schedule
  everySimSec: 60
plan:
  goal: turn the lamp on periodically
  nodes:
    - id: n1
      capability: turn-on
`,
    );
    const updated = await eaf.cli('flow', 'update', flowId, '--file', 'flow-v3.yaml', '--json');
    expect(updated.code).toBe(0);
    expect(updated.json().name).toBe('Lamp on v3');
    expect(updated.json().trigger.kind).toBe('schedule');

    const invalid = await eaf.cli('flow', 'update', flowId, '--file', 'bad-flow.yaml');
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('FLOW_INVALID');
  });
});

describe('flow runs + sim run-flow', () => {
  test('run-flow errors: foreign flow → 4, disabled flow → non-zero with FLOW_NOT_RUNNABLE', async () => {
    const sim = await eaf.cli('sim', 'create', '--env', WORLD_NAME, '--json');
    expect(sim.code).toBe(0);
    const simId = sim.json().id;

    expect((await eaf.cli('sim', 'run-flow', simId, 'no-such-flow')).code).toBe(4);

    await eaf.cli('flow', 'disable', flowId);
    const disabled = await eaf.cli('sim', 'run-flow', simId, flowId);
    expect(disabled.code).toBe(1);
    expect(disabled.stderr).toContain('FLOW_NOT_RUNNABLE');

    // Enable → the manual run goes through and lands in the ledger.
    await eaf.cli('flow', 'enable', flowId);
    const ran = await eaf.cli('sim', 'run-flow', simId, flowId, '--json');
    expect(ran.code).toBe(0);
    const body = ran.json();
    expect(body.flowId).toBe(flowId);
    expect(body.run.triggerKind).toBe('manual');
    expect(body.run.simulationId).toBe(simId);
    expect(['success', 'partial', 'failed']).toContain(body.run.status);

    const runs = await eaf.cli('flow', 'runs', flowId, '--json');
    expect(runs.code).toBe(0);
    expect((runs.json() as Array<{ id: string }>).map(r => r.id)).toContain(body.run.id);

    const human = await eaf.cli('flow', 'runs', flowId, '--limit', '5');
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('manual');
    expect(human.stdout).toContain(body.run.status);

    // A human-mode list shows the last run in its column.
    const list = await eaf.cli('flow', 'list', '--env', WORLD_NAME);
    expect(list.stdout).toContain(body.run.status);

    // --limit is validated client-side.
    expect((await eaf.cli('flow', 'runs', flowId, '--limit', '0')).code).toBe(2);
  });
});

describe('flow add — delegate nodes (Mechanism A)', () => {
  test('accepts an advice delegate node from YAML; relays budget 422s with teaching', async () => {
    writeFileSync(
      join(eaf.home, 'delegate-flow.yaml'),
      `name: Ask the lamp agent
trigger:
  kind: event
  eventType: delegate-event
plan:
  goal: delegate the judgment
  nodes:
    - id: ask
      delegate:
        question: Is now a good time to turn the lamp on?
        mode: advice
        outputs: [verdict]
        timeoutMs: 15000
        fallback: { policy: none }
`,
    );
    const added = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'delegate-flow.yaml', '--json');
    expect(added.code).toBe(0);
    expect(added.json().plan.nodes[0].delegate).toMatchObject({ mode: 'advice', outputs: ['verdict'] });

    // An actuating delegate whose budget names a nonexistent device → the
    // server's 422 teaching issues relay to stderr (never "[object Object]").
    writeFileSync(
      join(eaf.home, 'delegate-bad.yaml'),
      `name: Broken delegate
trigger:
  kind: event
  eventType: delegate-event
plan:
  goal: act
  nodes:
    - id: act
      delegate:
        question: q
        mode: actuating
        budget:
          maxCommands: 1
          deviceIds: [ghost-device]
          allowedCommands: [turn-on]
`,
    );
    const bad = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'delegate-bad.yaml');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('FLOW_INVALID');
    expect(bad.stderr).toMatch(/ghost-device|eligible assignee/);
  });
});

describe('flow policy envelope (Mechanism C)', () => {
  test('policy rides the YAML file through add and update; bad envelopes relay 422 teaching', async () => {
    writeFileSync(
      join(eaf.home, 'envelope-flow.yaml'),
      `name: Guarded judgments
trigger:
  kind: event
  eventType: envelope-event
policy:
  maxDelegationsPerRun: 1
  minConfidenceToActuate: 0.6
  onBudgetExhausted: escalate
  escalate: { channel: notification, toRole: owner }
plan:
  goal: two bounded judgments
  nodes:
    - id: d1
      delegate:
        question: q1
        mode: advice
    - id: d2
      delegate:
        question: q2
        mode: advice
`,
    );
    const added = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'envelope-flow.yaml', '--json');
    expect(added.code).toBe(0);
    expect(added.json().policy).toEqual({
      maxDelegationsPerRun: 1,
      minConfidenceToActuate: 0.6,
      onBudgetExhausted: 'escalate',
      escalate: { channel: 'notification', toRole: 'owner' },
    });
    const envelopeFlowId = added.json().id;

    // Human `flow get` prints the envelope.
    const humanGet = await eaf.cli('flow', 'get', envelopeFlowId);
    expect(humanGet.code).toBe(0);
    expect(humanGet.stdout).toContain('policy:');

    // A file WITHOUT the policy key leaves the envelope untouched on update
    // (same semantics as the MI-D inputs surface).
    writeFileSync(
      join(eaf.home, 'envelope-edit.yaml'),
      `name: Guarded judgments v2
trigger:
  kind: event
  eventType: envelope-event
plan:
  goal: still guarded
  nodes:
    - id: d1
      delegate:
        question: q1
        mode: advice
    - id: d2
      delegate:
        question: q2
        mode: advice
`,
    );
    const updated = await eaf.cli('flow', 'update', envelopeFlowId, '--file', 'envelope-edit.yaml', '--json');
    expect(updated.code).toBe(0);
    expect(updated.json().name).toBe('Guarded judgments v2');
    expect(updated.json().policy).toMatchObject({ maxDelegationsPerRun: 1 });

    // Dead escalate config (escalate without onBudgetExhausted: escalate)
    // relays the server's teaching 422.
    writeFileSync(
      join(eaf.home, 'envelope-bad.yaml'),
      `name: Dead escalate
trigger:
  kind: event
  eventType: envelope-event
policy:
  maxDelegationsPerRun: 1
  escalate: { channel: notification, toRole: owner }
plan:
  goal: g
  nodes:
    - id: n1
      capability: turn-on
`,
    );
    const bad = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'envelope-bad.yaml');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('FLOW_INVALID');
    expect(bad.stderr).toContain("'escalate' is declared but onBudgetExhausted");

    // Removing the envelope: PATCH policy null (no file key can express
    // null in YAML — the API shape is available for scripts; verified in the
    // server suite).
    expect(envelopeFlowId).toBeTruthy();
  });
});

describe('flow agent-invocable flag (Mechanism B)', () => {
  test('agentInvocable rides the YAML file; absent key preserves; false toggles off; human get prints it', async () => {
    writeFileSync(
      join(eaf.home, 'invocable-flow.yaml'),
      `name: Agent playbook
trigger:
  kind: event
  eventType: playbook-event
agentInvocable: true
plan:
  goal: the standard procedure
  nodes:
    - id: n1
      capability: turn-on
`,
    );
    const added = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'invocable-flow.yaml', '--json');
    expect(added.code).toBe(0);
    expect(added.json().agentInvocable).toBe(true);
    const invocableFlowId = added.json().id;

    // Human `flow get` names the lane.
    const humanGet = await eaf.cli('flow', 'get', invocableFlowId);
    expect(humanGet.code).toBe(0);
    expect(humanGet.stdout).toContain('agent-invocable: true');

    // A file WITHOUT the key leaves the flag untouched on update.
    writeFileSync(
      join(eaf.home, 'invocable-flow-rename.yaml'),
      `name: Agent playbook v2
trigger:
  kind: event
  eventType: playbook-event
plan:
  goal: the standard procedure
  nodes:
    - id: n1
      capability: turn-on
`,
    );
    const renamed = await eaf.cli('flow', 'update', invocableFlowId, '--file', 'invocable-flow-rename.yaml', '--json');
    expect(renamed.code).toBe(0);
    expect(renamed.json().agentInvocable).toBe(true); // preserved

    // An explicit false toggles the opt-in off (back to pre-B semantics).
    writeFileSync(
      join(eaf.home, 'invocable-flow-off.yaml'),
      `name: Agent playbook v2
trigger:
  kind: event
  eventType: playbook-event
agentInvocable: false
plan:
  goal: the standard procedure
  nodes:
    - id: n1
      capability: turn-on
`,
    );
    const off = await eaf.cli('flow', 'update', invocableFlowId, '--file', 'invocable-flow-off.yaml', '--json');
    expect(off.code).toBe(0);
    expect(off.json().agentInvocable).toBeUndefined();

    // Non-boolean values are caught at parse time (the standing trap).
    writeFileSync(
      join(eaf.home, 'invocable-flow-bad.yaml'),
      `name: bad
trigger:
  kind: event
  eventType: playbook-event
agentInvocable: yes-please
plan:
  goal: g
  nodes:
    - id: n1
      capability: turn-on
`,
    );
    const bad = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'invocable-flow-bad.yaml', '--json');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('agentInvocable');
    expect(invocableFlowId).toBeTruthy();
  });
});

describe('flow rm', () => {
  test('rm deletes; get afterwards is exit 4', async () => {
    const removed = await eaf.cli('flow', 'rm', flowId, '--json');
    expect(removed.code).toBe(0);
    expect(removed.json()).toEqual({ deleted: flowId });
    expect((await eaf.cli('flow', 'get', flowId)).code).toBe(4);
  });
});

describe('agent update', () => {
  test('name / capabilities / enable-disable / llm-file (with systemPrompt)', async () => {
    const agents = (await eaf.cli('agent', 'list', '--env', WORLD_NAME, '--json')).json() as Array<{
      id: string;
      name: string;
    }>;
    agentId = agents.find(a => a.name === 'Lamp Agent')!.id;

    writeFileSync(
      join(eaf.home, 'llm.yaml'),
      `provider: openai-compatible
model: qwen3:8b
systemPrompt: "You are the lamp keeper."
params:
  temperature: 0.2
`,
    );
    const updated = await eaf.cli(
      'agent', 'update', agentId,
      '--name', 'Lamp Keeper',
      '--capabilities', 'turn-on,turn-off,patrol',
      '--disable',
      '--llm-file', 'llm.yaml',
      '--json',
    );
    expect(updated.code).toBe(0);
    const agent = updated.json();
    expect(agent.name).toBe('Lamp Keeper');
    expect(agent.capabilities).toEqual(['turn-on', 'turn-off', 'patrol']);
    expect(agent.enabled).toBe(false);
    expect(agent.llm.provider).toBe('openai-compatible');
    expect(agent.llm.model).toBe('qwen3:8b');
    expect(agent.llm.systemPrompt).toBe('You are the lamp keeper.');
    expect(agent.llm.params).toEqual({ temperature: 0.2 });

    const reenabled = await eaf.cli('agent', 'update', agentId, '--enable', '--json');
    expect(reenabled.code).toBe(0);
    expect(reenabled.json().enabled).toBe(true);

    const human = await eaf.cli('agent', 'update', agentId, '--name', 'Lamp Agent');
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('updated');

    // Usage errors: no change flags, contradictory toggles, bad llm file.
    expect((await eaf.cli('agent', 'update', agentId)).code).toBe(2);
    expect((await eaf.cli('agent', 'update', agentId, '--enable', '--disable')).code).toBe(2);
    writeFileSync(join(eaf.home, 'bad-llm.yaml'), `model: no-provider\n`);
    expect((await eaf.cli('agent', 'update', agentId, '--llm-file', 'bad-llm.yaml')).code).toBe(2);

    // Unknown agent id → exit 4.
    expect((await eaf.cli('agent', 'update', 'no-such-agent', '--name', 'x')).code).toBe(4);
  });
});

describe('flow inputs + flow-service (Mechanism D)', () => {
  test('inputs surface: add from YAML, run with --params, out-of-bounds 422 relay', async () => {
    writeFileSync(
      join(eaf.home, 'inputs-flow.yaml'),
      `name: Night setback
trigger:
  kind: event
  eventType: grid-peak
inputs:
  - name: setpoint
    type: number
    required: true
    min: 16
    max: 26
  - name: mode
    type: string
    enum: [eco, comfort]
    default: comfort
plan:
  goal: setback to the setpoint
  nodes:
    - id: n1
      capability: turn-on
      params:
        level: '\${input:setpoint}'
        profile: 'mode-\${input:mode}'
`,
    );
    const added = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'inputs-flow.yaml', '--json');
    expect(added.code).toBe(0);
    const inputsFlowId = added.json().id;
    expect(added.json().inputs).toHaveLength(2);

    const sim = await eaf.cli('sim', 'create', '--env', WORLD_NAME, '--json');
    expect(sim.code).toBe(0);
    const simId = sim.json().id;

    // Out-of-bounds params → the server's teaching 422 relays to stderr.
    const bad = await eaf.cli('sim', 'run-flow', simId, inputsFlowId, '--params', '{"setpoint":40}');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('FLOW_PARAMS_INVALID');

    // Valid params run; the ledger carries the EFFECTIVE inputs (defaults applied).
    const ran = await eaf.cli(
      'sim', 'run-flow', simId, inputsFlowId, '--params', '{"setpoint":20}', '--json',
    );
    expect(ran.code).toBe(0);
    expect(ran.json().run.inputs).toEqual({ setpoint: 20, mode: 'comfort' });
  });

  test('service publish --flow + agreement invoke --action run (the CLI lane of D)', async () => {
    // A flow with a zero-required surface so terms params are not needed.
    writeFileSync(
      join(eaf.home, 'service-flow.yaml'),
      `name: Night setback service
trigger:
  kind: event
  eventType: grid-peak
inputs:
  - name: setpoint
    type: number
    required: true
    min: 16
    max: 26
plan:
  goal: setback to the setpoint
  nodes:
    - id: n1
      capability: turn-on
      params:
        level: '\${input:setpoint}'
`,
    );
    const added = await eaf.cli('flow', 'add', '--env', WORLD_NAME, '--file', 'service-flow.yaml', '--json');
    expect(added.code).toBe(0);
    const serviceFlowId = added.json().id;

    // The provider agent (Lamp Agent from the world) fronts the service.
    const agents = await eaf.cli('agent', 'list', '--env', WORLD_NAME, '--json');
    const lampAgent = (agents.json() as Array<{ id: string; name: string }>).find(a => a.name === 'Lamp Agent');
    expect(lampAgent).toBeDefined();

    const published = await eaf.cli(
      'service', 'publish', '--env', WORLD_NAME, '--agent', lampAgent!.id,
      '--name', '夜间节能回退', '--type', 'energy-setback', '--flow', serviceFlowId, '--json',
    );
    expect(published.code).toBe(0);
    const service = published.json();
    expect(service.origin).toBe('flow');
    expect(service.sourceFlowId).toBe(serviceFlowId);
    expect(service.interface.kind).toBe('flow');
    expect(service.interface.actions[0].name).toBe('run');

    // Human-mode detail names the run surface.
    const detail = await eaf.cli('service', 'get', service.id);
    expect(detail.code).toBe(0);
    expect(detail.stdout).toContain('run params');

    // Negotiate: propose (terms must be run) → accept → invoke with params.
    const proposed = await eaf.cli(
      'agreement', 'propose', service.id,
      '--terms', '{"action":{"command":"run","params":{"setpoint":20}},"quotaPerWindow":5,"windowSec":3600}',
      '--json',
    );
    expect(proposed.code).toBe(0);
    const agreementId = proposed.json().id;
    const decided = await eaf.cli('agreement', 'decide', agreementId, 'accept', '--json');
    expect(decided.code).toBe(0);

    const sim = await eaf.cli('sim', 'create', '--env', WORLD_NAME, '--json');
    const simId = sim.json().id;
    await eaf.cli('sim', 'start', simId, '--json');
    const invoked = await eaf.cli(
      'agreement', 'invoke', agreementId, '--action', 'run',
      '--params', '{"setpoint":22}', '--sim', simId, '--json',
    );
    expect(invoked.code).toBe(0);
    const result = invoked.json();
    expect(result.success).toBe(true);
    // T-205 merge-override: terms setpoint (20) wins over the caller's 22.
    expect(result.applied.params).toEqual({ setpoint: 20 });
    expect(result.applied.flow.triggerKind).toBe('service');
    expect(result.usage.unit).toBe('flow-run');
    expect(result.usage.effectRef).toBe(result.applied.flow.runId);
  });
});

describe('T1 flow capability drift rendering (R2 u3-F1)', () => {
  test('authoring warning on add + degraded runs in human mode', async () => {
    // A world whose agent declares NOTHING while its device still provides
    // turn-on — the u3 shape (declaration narrower than the device surface).
    const driftWorld = `cli-drift-${stamp}`;
    writeFileSync(
      join(eaf.home, 'drift-world.yaml'),
      `version: "1.0"
environment:
  name: ${driftWorld}
  visibility: public
  map:
    type: grid
    zones:
      - id: room-d
        bounds: {minX: 0, maxX: 5, minY: 0, maxY: 5}
devices:
  - name: Drift Fan
    zone: room-d
    spec:
      type: fan
      capabilities: [turn-on]
agents:
  - name: Drift Guard
    capabilities: []
    bind: [Drift Fan]
    zones: [room-d]
events:
  - id: evt-fire-drill
    type: fire-alarm
    zoneId: room-d
`,
    );
    writeFileSync(
      join(eaf.home, 'drift-flow.yaml'),
      `name: Drift smoke
trigger:
  kind: event
  eventType: fire-alarm
plan:
  goal: run the fan
  nodes:
    - id: n1
      capability: turn-on
`,
    );
    const applied = await eaf.cli('apply', '-f', 'drift-world.yaml', '--json');
    expect(applied.code).toBe(0);

    // --json face carries validationWarnings; human face prints the warning
    // line and still exits 0 (warning-level, never a 422).
    const jsonAdd = await eaf.cli('flow', 'add', '--env', driftWorld, '--file', 'drift-flow.yaml', '--json');
    expect(jsonAdd.code).toBe(0);
    const warnings = jsonAdd.json().validationWarnings as string[] | undefined;
    expect(warnings).toHaveLength(1);
    expect(warnings![0]).toContain('does not declare capability');
    const driftFlowId = jsonAdd.json().id as string;

    const humanAdd = await eaf.cli('flow', 'add', '--env', driftWorld, '--file', 'drift-flow.yaml');
    expect(humanAdd.code).toBe(0);
    // R102 output discipline: the warning is part of the human-readable
    // OUTPUT — out.explain rides human stdout (stderr only under --json, so
    // the json channel's stdout stays pipeable).
    expect(humanAdd.stdout).toContain('warning:');
    expect(humanAdd.stdout).toContain('does not declare capability');

    // The list face annotates the stored flow against the live world.
    const humanList = await eaf.cli('flow', 'list', '--env', driftWorld);
    expect(humanList.stdout).toContain('not declared by');

    // A drifted run keeps status success but renders the degraded note.
    const sim = await eaf.cli('sim', 'create', '--env', driftWorld, '--json');
    expect(sim.code).toBe(0);
    const simId = sim.json().id;
    const ran = await eaf.cli('sim', 'run-flow', simId, driftFlowId, '--json');
    expect(ran.code).toBe(0);
    expect(ran.json().run.status).toBe('success');
    expect(ran.json().run.capabilityDrift).toHaveLength(1);

    const runsHuman = await eaf.cli('flow', 'runs', driftFlowId, '--limit', '3');
    expect(runsHuman.code).toBe(0);
    expect(runsHuman.stdout).toContain('(degraded: capability');
    expect(runsHuman.stdout).toContain('not declared by');

    const runsJson = await eaf.cli('flow', 'runs', driftFlowId, '--limit', '3', '--json');
    expect((runsJson.json() as Array<{ capabilityDrift?: unknown[] }>)[0].capabilityDrift).toHaveLength(1);
  });
});
