/**
 * `eaf agent command` / `eaf agent ask` — the NL interface CLI lane
 * (cognitive architecture Phase 3).
 *
 * Boots the real server, applies a world with an actuator-bound agent,
 * starts a simulation, and drives the plain-language round trip end to end:
 * the agent parses the text, decides by rules (LLM off in tests), executes
 * the validated device command, and answers in plain language.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

let server: TestServer;
let owner: CliRunner;
const stamp = Date.now().toString(36);
const WORLD_NAME = `cli-nl-${stamp}`;

beforeAll(async () => {
  server = await bootServer();
  owner = makeCli(server.baseUrl);
  expect(
    (await owner.cli(
      'auth', 'register', '--email', `nl-${stamp}@example.com`,
      '--password', 'password-123', '--name', 'Owner',
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
        baseline: {temperature: 24}
devices:
  - name: HVAC A
    zone: room-a
    spec:
      type: hvac
      capabilities: [set-temperature, turn-on, turn-off]
agents:
  - name: ThermalOps
    capabilities: [set-temperature, turn-on, turn-off]
    bind: [HVAC A]
    zones: [room-a]
`,
  );
  expect((await owner.cli('apply', '-f', 'world.yaml', '--json')).code).toBe(0);
});

afterAll(async () => {
  await server?.stop();
});

describe('eaf agent command / ask', () => {
  let agentId: string;
  let simId: string;

  beforeAll(async () => {
    const agents = await owner.cli('agent', 'list', '--env', WORLD_NAME, '--json');
    expect(agents.code).toBe(0);
    agentId = agents.json()[0].id;
    expect(typeof agentId).toBe('string');

    const sim = await owner.cli('sim', 'create', '--env', WORLD_NAME, '--json');
    expect(sim.code).toBe(0);
    simId = sim.json().id;
    expect(typeof simId).toBe('string');
  });

  test('command round trip: text → intent → decision → executed device action → NL answer', async () => {
    const res = await owner.cli(
      'agent', 'command', agentId, 'set', 'the', 'room-a', 'temperature', 'to', '22',
      '--sim', simId, '--json',
    );
    expect(res.code).toBe(0);
    const body = res.json();
    expect(body.intent.action).toBe('set_parameter');
    expect(body.intent.targetParameters).toEqual({ temperature: 22 });
    expect(body.cognitiveDecision.actionPlan.primary.action).toBe('handle_independently');
    expect(body.executionResult.actions).toHaveLength(1);
    expect(body.executionResult.actions[0].success).toBe(true);
    expect(body.naturalLanguageResponse).toContain('22');
  });

  test('human output prints the NL answer plus per-action lines', async () => {
    const res = await owner.cli(
      'agent', 'command', agentId, 'set', 'the', 'room-a', 'temperature', 'to', '21',
      '--sim', simId,
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('21');
    expect(res.stdout).toMatch(/[✓✗] .+ set-temperature/);
  });

  test('emergency commands escalate without device actions', async () => {
    const res = await owner.cli(
      'agent', 'command', agentId, 'fire!', '--sim', simId, '--json',
    );
    expect(res.code).toBe(0);
    expect(res.json().decisionSource).toBe('emergency');
    expect(res.json().executionResult.actions).toHaveLength(0);
  });

  test('ask is read-only and answers from live zone data', async () => {
    const res = await owner.cli(
      'agent', 'ask', agentId, 'what', 'is', 'the', 'status', '--sim', simId, '--json',
    );
    expect(res.code).toBe(0);
    const body = res.json();
    expect(body.intent.action).toBe('get_status');
    expect(body.data.zones?.some((z: { zoneId: string }) => z.zoneId === 'room-a')).toBe(true);
    expect(typeof body.naturalLanguageResponse).toBe('string');
  });

  test('a wrong sim is a teaching 404, not a silent miss', async () => {
    const res = await owner.cli(
      'agent', 'command', agentId, 'status', '--sim', 'sim-nope', '--json',
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toContain('SIMULATION_NOT_FOUND');
  });

  // ---------------------------------------------------------------------
  // R40-B1: the what-if lane (predict, don't act) + verify-before-act surfacing
  // ---------------------------------------------------------------------

  test('what-if --json returns the full prediction payload', async () => {
    const res = await owner.cli(
      'agent', 'what-if', agentId,
      '--text', 'what if I turn off HVAC A for 10 minutes?',
      '--sim', simId, '--json',
    );
    expect(res.code).toBe(0);
    const body = res.json();
    expect(body.agentId).toBe(agentId);
    expect(body.simulationId).toBe(simId);
    expect(['improvement', 'degradation', 'neutral', 'inconclusive']).toContain(body.result.verdict);
    expect(typeof body.result.confidence).toBe('number');
    expect(body.result.scenario.durationSec).toBe(600); // "10 minutes"
    expect(body.result.scenario.intervention.type).toBe('device_command');
    expect(typeof body.result.delta).toBe('object');
    expect(body.result.explanation.length).toBeGreaterThan(0);
  });

  test('R101 (zhao-16): the DEFAULT human what-if output carries the disambiguation block; own AC wins; meeting-202 stays out', async () => {
    // A dedicated world: three ACs across two zones; the agent binds ONLY
    // 赵-101空调. 「101 的空调」 type-matches all hvacs — the requester's
    // bound one must win, and the meeting-202 unit must stay out of the
    // candidate set (location-token scoping).
    const worldName = `cli-whatif-r101-${stamp}`;
    writeFileSync(
      join(owner.home, 'world-r101.yaml'),
      `version: "1.0"
environment:
  name: ${worldName}
  visibility: private
  map:
    type: grid
    zones:
      - id: lab-101
        bounds: {minX: 0, maxX: 5, minY: 0, maxY: 5}
        baseline: {temperature: 32}
      - id: meeting-202
        bounds: {minX: 6, maxX: 11, minY: 0, maxY: 5}
        baseline: {temperature: 26}
devices:
  - name: 赵-101空调
    zone: lab-101
    spec:
      type: hvac
      capabilities: [turn-on, turn-off, set-temperature]
  - name: lab-101 格力空调
    zone: lab-101
    spec:
      type: hvac
      capabilities: [turn-on, turn-off, set-temperature]
  - name: meeting-202 格力空调
    zone: meeting-202
    spec:
      type: hvac
      capabilities: [turn-on, turn-off, set-temperature]
agents:
  - name: 赵家楼宇管家
    capabilities: []
    bind: [赵-101空调]
    zones: [lab-101]
`,
    );
    expect((await owner.cli('apply', '-f', 'world-r101.yaml', '--json')).code).toBe(0);
    const agents = await owner.cli('agent', 'list', '--env', worldName, '--json');
    expect(agents.code).toBe(0);
    const zhaoAgentId = agents.json()[0].id as string;
    const sim = await owner.cli('sim', 'create', '--env', worldName, '--json');
    expect(sim.code).toBe(0);
    const zhaoSimId = sim.json().id as string;

    // The DEFAULT output (NO --json) — the channel ordinary users read.
    const human = await owner.cli(
      'agent', 'what-if', zhaoAgentId,
      '--text', '如果把 101 的空调关掉 30 分钟会怎样？',
      '--sim', zhaoSimId,
    );
    expect(human.code).toBe(0);
    // Candidates + choice basis + the correction path are PRINTED (the two
    // earlier rounds delivered them only behind --json).
    expect(human.stdout).toContain('ambiguous target');
    expect(human.stdout).toContain('赵-101空调');
    expect(human.stdout).toContain('lab-101 格力空调');
    expect(human.stdout).not.toContain('meeting-202 格力空调');
    expect(human.stdout).toContain("requester's own bound device");
    // The simulated device is NAMED in the explanation — the requester's own.
    expect(human.stdout).toContain('赵-101空调 (');

    // Same content over the --json channel (two channels, one truth).
    const json = await owner.cli(
      'agent', 'what-if', zhaoAgentId,
      '--text', '如果把 101 的空调关掉 30 分钟会怎样？',
      '--sim', zhaoSimId, '--json',
    );
    expect(json.code).toBe(0);
    const result = json.json().result;
    expect(result.explanation).toContain('赵-101空调');
    expect(result.notes.some((n: string) => n.includes('ambiguous target') && n.includes('赵-101空调'))).toBe(true);
  }, 60_000);

  test('non-what-if text is a teaching error (this lane only answers hypotheses)', async () => {
    // T131: the teaching locale is PINNED per request. T125 gave the CLI a
    // default `--lang en-US` that rides Accept-Language on every request, so
    // an unpinned request now (correctly) gets the EN teaching — the zh
    // sentence below is the server's zh branch (agent-nl.ts), reached only
    // when the caller asks for zh.
    const res = await owner.cli(
      'agent', 'what-if', agentId, '--text', 'turn off HVAC A', '--sim', simId,
      '--lang', 'zh-CN',
    );
    expect(res.code).not.toBe(0);
    // R102: the teaching rides in the (zh) explanation — cause + usable
    // sentence patterns, not the bare English sentence (agent-nl.ts).
    expect(res.stderr + res.stdout).toContain('不是 what-if 问题');
  });

  test('T131: the same non-what-if input teaches in EN under the en-US default locale', async () => {
    // The en-US counterpart of the pinned-zh case above — the server's EN
    // branch, anchored verbatim on agent-nl.ts's EN teaching sentence.
    const res = await owner.cli(
      'agent', 'what-if', agentId, '--text', 'turn off HVAC A', '--sim', simId,
      '--lang', 'en-US',
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toContain('The text is not a what-if question');
  });

  test('command output shows the verification verdict (non-degradation executes)', async () => {
    const res = await owner.cli(
      'agent', 'command', agentId, 'set', 'the', 'room-a', 'temperature', 'to', '21',
      '--sim', simId,
    );
    expect(res.code).toBe(0);
    // R98: a command that changes nothing vs baseline (setpoint already 21)
    // reads inconclusive — an honest low-signal note, still not a block.
    expect(res.stdout).toMatch(/verification: (improvement|neutral|degradation|inconclusive)/);
    expect(res.stdout).not.toContain('BLOCKED');
  });

  test('degradation: what-if predicts it up front; /command is blocked with the reason', async () => {
    // what-if (human): verdict + confidence + the delta summary table. Setting
    // 35 in the 24°C room heats it outside the comfort band — the fork sees it.
    const prediction = await owner.cli(
      'agent', 'what-if', agentId,
      'what', 'if', 'the', 'temperature', 'is', 'set', 'to', '35', 'in', 'room-a', 'for', '30', 'minutes?',
      '--sim', simId,
    );
    expect(prediction.code).toBe(0);
    expect(prediction.stdout).toContain('what-if: degradation');
    expect(prediction.stdout).toMatch(/confidence 0\.\d+/);
    expect(prediction.stdout).toMatch(/temperature_room-a\s+\+/); // warmed vs baseline

    // The SAME hypothesis through /command is BLOCKED before any device write
    // and the human output says so with the verification verdict + reason.
    const blocked = await owner.cli(
      'agent', 'command', agentId, 'set', 'the', 'room-a', 'temperature', 'to', '35',
      '--sim', simId,
    );
    expect(blocked.code).toBe(0);
    expect(blocked.stdout).toContain('⚠ verification: degradation');
    expect(blocked.stdout).toContain('BLOCKED');
    expect(blocked.stdout).not.toMatch(/✓ .+ set-temperature/); // nothing executed
  });
});
