/**
 * NL orchestrator tests (cognitive architecture Phase 3).
 *
 * Covers the four-stage pipeline against a fake seam: the emergency bypass,
 * help/status lanes, the LLM decision lane (cognitive contract), the rule
 * lane (LLM down / rule-only), device-action validation through the
 * recommendation bridge, and the ask lane's read-only guarantee.
 */

import { describe, expect, it } from 'vitest';

import type { ChatParams } from '@active-collaboration/llm-integration';

import type { CognitiveDecision } from '../decision/cognitive-decision.js';
import { validateDecisionV1 } from '../decision/decision-schema.js';
import { buildErrorFallbackDecision, runNLAsk, runNLCommand, NLDeviceGateError } from './nl-orchestrator.js';
import type { WhatIfIntervention, WhatIfResult } from '../cognition/predictor.js';
import type { NLDeviceView, NLSeam, NLZoneView } from './types.js';

const ZONES: NLZoneView[] = [
  { zoneId: 'lobby', name: 'Lobby', parameters: { temperature: 29.3, occupancy: 18 } },
  { zoneId: 'office-a', parameters: { temperature: 24 } },
];

const DEVICES: NLDeviceView[] = [
  {
    deviceId: 'hvac-1',
    name: 'Lobby HVAC',
    type: 'hvac',
    zoneId: 'lobby',
    online: true,
    commands: ['set-temperature', 'set-mode', 'turn-on', 'turn-off'],
    state: { targetTemperature: 26 },
  },
  {
    deviceId: 'light-1',
    name: 'Lobby Light',
    type: 'light',
    zoneId: 'lobby',
    online: true,
    commands: ['set-brightness', 'turn-on', 'turn-off'],
  },
];

interface SeamLog {
  executed: Array<{ deviceId: string; command: string; params?: Record<string, unknown>; actor: string }>;
  llmPrompts: string[];
}

function makeSeam(options: {
  llmAnswer?: (prompts: string[]) => string | Error;
  executeResult?: (deviceId: string) => { success: boolean; error?: string };
  actor?: string;
  zones?: NLZoneView[];
  devices?: NLDeviceView[];
} = {}): { seam: NLSeam; log: SeamLog } {
  const log: SeamLog = { executed: [], llmPrompts: [] };
  const seam: NLSeam = {
    agent: { agentId: 'thermal-ops-1', agentName: 'ThermalOps', capabilities: ['temperature-control'], status: 'idle' },
    devices: options.devices ?? DEVICES,
    zones: options.zones ?? ZONES,
    ...(options.llmAnswer !== undefined
      ? {
          llmChat: async (params: ChatParams): Promise<string> => {
            const prompt = params.messages.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n');
            log.llmPrompts.push(prompt);
            const answer = options.llmAnswer!(log.llmPrompts);
            if (answer instanceof Error) throw answer;
            return answer;
          },
        }
      : {}),
    executeDeviceCommand: async (deviceId, command, params, execOptions) => {
      log.executed.push({ deviceId, command, ...(params !== undefined ? { params } : {}), actor: execOptions.actor });
      const result = options.executeResult?.(deviceId);
      return result !== undefined ? result : { success: true, result: { ok: true } };
    },
  };
  return { seam, log };
}

/** A well-formed CognitiveDecision JSON answer (Phase 1 contract). */
function cognitiveAnswer(action: string, deviceActions: unknown[] = []): string {
  const decision = {
    situation: { type: 'anomaly', severity: 3, affectedZones: ['lobby'], rootCauseHypothesis: 'heat wave', confidence: 0.8 },
    goals: [],
    actionPlan: {
      primary: {
        action,
        reasoning: 'cool the lobby for the operator',
        ...(deviceActions.length > 0 ? { deviceActions } : {}),
      },
      escalationCondition: 'temperature exceeds 35C for more than 10 minutes',
    },
    explanation: { summary: 'Cooled the lobby per the operator request.', factors: [{ name: 'comfort', weight: 0.7 }] },
    collaboration: { needed: false },
    uncertainty: { overall: 0.75 },
  } as unknown as CognitiveDecision;
  return JSON.stringify(decision);
}

describe('D2-F2 honesty — the machine channel names the no-op decision', () => {
  it('a decision with no executable device actions reports the chosen action word', async () => {
    // Escalate-only decision: nothing to execute; the message must say so.
    const { seam } = makeSeam({ llmAnswer: () => cognitiveAnswer('escalate') });
    const result = await runNLCommand(
      seam,
      'do something drastic',
    );
    expect(result.executionResult.actions).toHaveLength(0);
    expect(result.executionResult.message).toContain("decided 'escalate'");
  });
});

describe('runNLCommand — emergency lane', () => {
  it('bypasses decision-making: no LLM call, no device commands, escalates', async () => {
    const { seam, log } = makeSeam({
      llmAnswer: () => cognitiveAnswer('handle_independently', [{ deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 18 } }]),
    });
    const result = await runNLCommand(seam, 'fire in the lobby!');
    expect(result.intent.action).toBe('emergency');
    expect(result.decisionSource).toBe('emergency');
    expect(result.cognitiveDecision.actionPlan.primary.action).toBe('escalate');
    expect(result.executionResult.actions).toEqual([]);
    expect(result.naturalLanguageResponse).toContain('EMERGENCY');
    expect(log.llmPrompts).toHaveLength(0);
    expect(log.executed).toHaveLength(0);
  });
});

describe('runNLCommand — help and status lanes', () => {
  it('help renders the capability surface without LLM or execution', async () => {
    const { seam, log } = makeSeam({ llmAnswer: () => cognitiveAnswer('wait') });
    const result = await runNLCommand(seam, 'help');
    expect(result.intent.action).toBe('help');
    expect(result.naturalLanguageResponse).toContain('ThermalOps');
    expect(log.llmPrompts).toHaveLength(0);
    expect(log.executed).toHaveLength(0);
  });

  it('status answers read-only from the live zone view', async () => {
    const { seam, log } = makeSeam({ llmAnswer: () => cognitiveAnswer('wait') });
    const result = await runNLCommand(seam, "what's the status of the lobby?");
    expect(result.intent.action).toBe('get_status');
    expect(result.naturalLanguageResponse).toContain('29.3');
    expect(log.llmPrompts).toHaveLength(0);
    expect(log.executed).toHaveLength(0);
  });
});

describe('runNLCommand — LLM decision lane', () => {
  it('parses the cognitive answer, validates deviceActions, executes with actor attribution', async () => {
    const { seam, log } = makeSeam({
      llmAnswer: () => cognitiveAnswer('handle_independently', [
        { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 18 } },
      ]),
    });
    const result = await runNLCommand(seam, 'make the lobby cooler', { actor: 'user:42' });
    expect(result.decisionSource).toBe('llm');
    expect(result.executionResult.success).toBe(true);
    expect(log.executed.length).toBeGreaterThanOrEqual(1);
    expect(log.executed[0].actor).toBe('user:42');
    // The LLM prompt carries the MY_DEVICES inventory and the sanitized NL command.
    const prompt = log.llmPrompts.join('\n');
    expect(prompt).toContain('MY_DEVICES');
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain('hvac-1');
  });

  it('rejects deviceActions naming devices the agent does NOT own', async () => {
    const { seam, log } = makeSeam({
      llmAnswer: () => cognitiveAnswer('handle_independently', [
        { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 22 } },
        { deviceId: 'foreign-hvac', command: 'set-temperature', params: { targetTemperature: 22 } },
      ]),
    });
    const result = await runNLCommand(seam, 'cool everything');
    expect(result.executionResult.rejected?.some(r => r.reason.includes('foreign-hvac'))).toBe(true);
    expect(log.executed.every(e => e.deviceId !== 'foreign-hvac')).toBe(true);
  });

  it('rejects commands outside the device surface', async () => {
    const { seam } = makeSeam({
      llmAnswer: () => cognitiveAnswer('handle_independently', [
        { deviceId: 'light-1', command: 'set-temperature', params: { targetTemperature: 22 } },
      ]),
    });
    const result = await runNLCommand(seam, 'cool the lights');
    expect(result.executionResult.actions).toHaveLength(0);
    expect(result.executionResult.rejected?.some(r => r.reason.includes('set-temperature'))).toBe(true);
  });

  it('degrades to the rule lane when the LLM answer is unparseable', async () => {
    const { seam, log } = makeSeam({ llmAnswer: () => 'not json at all' });
    const result = await runNLCommand(seam, 'set the lobby temperature to 22 degrees');
    expect(result.decisionSource).toBe('rules');
    // The rule lane maps the intent onto own devices (or the prose bridge
    // recovers the command from the text) — the command EXECUTES anyway.
    expect(log.executed.length).toBeGreaterThanOrEqual(1);
    expect(log.executed[0].deviceId).toBe('hvac-1');
    expect(log.executed[0].command).toBe('set-temperature');
    expect(String(log.executed[0].params?.targetTemperature)).toBe('22');
  });

  it('rule-only agents (no LLM seam) still execute mapped commands', async () => {
    const { seam, log } = makeSeam();
    const result = await runNLCommand(seam, 'set the lobby temperature to 23');
    expect(result.decisionSource).toBe('rules');
    expect(log.executed[0].deviceId).toBe('hvac-1');
    expect(String(log.executed[0].params?.targetTemperature)).toBe('23');
  });

  it('execution failures surface honestly in the response', async () => {
    const { seam } = makeSeam({
      llmAnswer: () => cognitiveAnswer('handle_independently', [
        { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 22 } },
      ]),
      executeResult: () => ({ success: false, error: 'device offline' }),
    });
    const result = await runNLCommand(seam, 'make it cooler');
    expect(result.executionResult.success).toBe(false);
    expect(result.naturalLanguageResponse).toContain('offline');
  });

  it('non-actuating decisions (defer/escalate/wait) execute nothing', async () => {
    const { seam, log } = makeSeam({ llmAnswer: () => cognitiveAnswer('defer') });
    const result = await runNLCommand(seam, 'figure out the lobby');
    expect(result.executionResult.actions).toEqual([]);
    expect(log.executed).toHaveLength(0);
  });
});

describe('T70 (R8, u1-F2) — command-lane honesty: ONE equivalence judgment + the zone-clue hard constraint', () => {
  /** The R8 real-world shape: capability-named faces, devices in two zones. */
  const T70_DEVICES: NLDeviceView[] = [
    {
      deviceId: 'hvac-a',
      name: 'Lab A Unit',
      type: 'hvac',
      zoneId: 'lab-a',
      online: true,
      commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
      state: { targetTemperature: 26 },
    },
    {
      deviceId: 'vent-b',
      name: 'Lab B Ventilator',
      type: 'ventilator',
      zoneId: 'lab-b',
      online: true,
      commands: ['turn-on', 'turn-off'],
    },
  ];
  const T70_ZONES: NLZoneView[] = [
    { zoneId: 'lab-a', name: 'Lab A', parameters: { temperature: 24 } },
    { zoneId: 'lab-b', name: 'Lab B', parameters: { temperature: 24 } },
  ];

  it('a canonical ask the face serves under another spelling is REWRITTEN onto the face (never "not exposed" then executed)', async () => {
    const { seam, log } = makeSeam({
      devices: T70_DEVICES,
      zones: T70_ZONES,
      llmAnswer: () => cognitiveAnswer('handle_independently', [
        { deviceId: 'hvac-a', command: 'set-temperature', params: { targetTemperature: 22 } },
      ]),
    });
    const result = await runNLCommand(seam, 'set the AC temperature to 22 in Lab A');
    expect(result.executionResult.success).toBe(true);
    // The RESOLVED name is what dispatches — the face's own spelling.
    expect(log.executed).toHaveLength(1);
    expect(log.executed[0]).toMatchObject({ deviceId: 'hvac-a', command: 'temperature-control' });
    // The rewrite is SPOKEN (never a silent vocabulary swap).
    expect(result.executionResult.clamped?.join(' ')).toContain('temperature-control');
  });

  it('a STRUCTURED ask the face cannot serve is rejected with the DEVICE face list (never the union, never executed)', async () => {
    const { seam, log } = makeSeam({
      devices: T70_DEVICES,
      zones: T70_ZONES,
      llmAnswer: () => cognitiveAnswer('handle_independently', [
        { deviceId: 'vent-b', command: 'set-temperature', params: { targetTemperature: 22 } },
      ]),
    });
    const result = await runNLCommand(seam, 'set the ventilator temperature to 22');
    expect(result.executionResult.actions).toHaveLength(0);
    expect(result.executionResult.success).toBe(false);
    expect(log.executed).toHaveLength(0);
    const rejection = result.executionResult.rejected?.find(r => r.command === 'set-temperature');
    expect(rejection).toBeDefined();
    // The teaching names the DEVICE's own surface — not the world-wide union
    // (the R8 confusion: three faces listed three different vocabularies).
    expect(rejection?.reason).toContain('vent-b');
    expect(rejection?.reason).toContain('turn-on');
    expect(rejection?.reason).toContain('use one of those commands');
  });

  it('a prose ask the face vocabulary cannot serve is honestly refused — never executed, never remapped onto an unrelated device', async () => {
    const { seam, log } = makeSeam({
      devices: T70_DEVICES,
      zones: T70_ZONES,
      // The decision names NOTHING — the prose-bridge assist re-derives the
      // ask from the raw text (the R8 shape: a temperature ask in a world
      // whose faces speak capability names, one of which has no setter).
      llmAnswer: () => cognitiveAnswer('handle_independently'),
    });
    const result = await runNLCommand(seam, 'set the ventilator temperature to 22');
    expect(result.executionResult.actions).toHaveLength(0);
    expect(result.executionResult.success).toBe(false);
    expect(log.executed).toHaveLength(0);
    // The refusal SAYS what went wrong (R102 teaching) instead of a silent no-op.
    expect(result.executionResult.rejected?.some(r => r.reason.includes('could not map'))).toBe(true);
  });

  it('a zone clue is a HARD constraint: the ask names Lab B, the device sits in lab-a → honest rejection, no cross-floor substitution', async () => {
    const { seam, log } = makeSeam({
      devices: T70_DEVICES,
      zones: T70_ZONES,
      llmAnswer: () => cognitiveAnswer('handle_independently', [
        { deviceId: 'hvac-a', command: 'turn-on' },
      ]),
    });
    const result = await runNLCommand(seam, 'turn on the AC in Lab B');
    expect(result.executionResult.actions).toHaveLength(0);
    expect(log.executed).toHaveLength(0);
    const rejection = result.executionResult.rejected?.find(r => r.deviceId === 'hvac-a');
    expect(rejection).toBeDefined();
    expect(rejection?.reason).toContain('Lab B');
    expect(rejection?.reason).toContain('lab-a');
    expect(rejection?.reason).toContain('no silent cross-floor substitution');
  });

  it('an explicitly named device overrides the zone clue (the operator said which device to drive)', async () => {
    const { seam, log } = makeSeam({
      devices: T70_DEVICES,
      zones: T70_ZONES,
      llmAnswer: () => cognitiveAnswer('handle_independently', [
        { deviceId: 'hvac-a', command: 'turn-on' },
      ]),
    });
    const result = await runNLCommand(seam, 'turn on hvac-a in Lab B');
    expect(result.executionResult.success).toBe(true);
    expect(log.executed).toHaveLength(1);
    expect(log.executed[0]).toMatchObject({ deviceId: 'hvac-a', command: 'turn-on' });
  });
});

describe('runNLAsk — read-only guarantee', () => {
  it('status questions answer from the view and never execute', async () => {
    const { seam, log } = makeSeam({ llmAnswer: () => cognitiveAnswer('handle_independently', []) });
    const result = await runNLAsk(seam, "what's the temperature in the lobby?");
    expect(result.data.zones?.[0].parameters.temperature).toBe(29.3);
    expect(result.naturalLanguageResponse).toContain('29.3');
    expect(log.executed).toHaveLength(0);
  });

  it('explanatory questions get a read-only assessment, not execution', async () => {
    const { seam, log } = makeSeam({ llmAnswer: () => cognitiveAnswer('handle_independently', [
      { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 22 } },
    ]) });
    const result = await runNLAsk(seam, 'why would you turn on the HVAC?');
    expect(result.data.assessment?.situation.type).toBe('anomaly');
    // Even though the assessment carries an action plan, NOTHING executed.
    expect(log.executed).toHaveLength(0);
    // The prompt tells the model this is read-only.
    expect(log.llmPrompts.join('\n')).toContain('READ-ONLY');
  });

  it('falls back to status data when no LLM is available', async () => {
    const { seam, log } = makeSeam();
    const result = await runNLAsk(seam, 'why is it hot?');
    expect(result.data.zones?.length).toBeGreaterThan(0);
    expect(log.llmPrompts).toHaveLength(0);
    expect(log.executed).toHaveLength(0);
  });
});

// ============================================================================
// R99 (zhao-08): conversational zone context — 「lab-101 温度多少？」→「那
// 湿度呢？」 must stay on lab-101 and FOCUS the asked parameter, not dump
// every zone's full parameter list.
// ============================================================================

describe('runNLAsk — R99 follow-up zone context + answer focus (zhao-08)', () => {
  const R99_ZONES: NLZoneView[] = [
    { zoneId: 'lab-101', name: '实验室101', parameters: { temperature: 30, humidity: 65, co2: 420, motion: 0 } },
    { zoneId: 'corridor-f1', name: '一层走廊', parameters: { temperature: 30, humidity: 65, co2: 480, motion: 0 } },
  ];

  it('a zone-less follow-up inherits the context zone and the answer leads with the asked parameter', async () => {
    const { seam } = makeSeam({ zones: R99_ZONES });
    const result = await runNLAsk(seam, '那湿度呢？', { contextZoneId: 'lab-101' });
    // Only lab-101 — NOT the whole jurisdiction.
    expect(result.data.zones?.map(z => z.zoneId)).toEqual(['lab-101']);
    expect(result.naturalLanguageResponse).toContain('lab-101');
    expect(result.naturalLanguageResponse).not.toContain('corridor-f1');
    // Focus: humidity leads; the remaining params collapse into one short
    // trailing clause (no full-parameter dump).
    expect(result.naturalLanguageResponse).toContain('humidity 65');
    expect(result.naturalLanguageResponse).toContain('其余');
  });

  it('an explicit zone mention overrides the context', async () => {
    const { seam } = makeSeam({ zones: R99_ZONES });
    const result = await runNLAsk(seam, 'corridor-f1 的湿度呢？', { contextZoneId: 'lab-101' });
    expect(result.data.zones?.map(z => z.zoneId)).toEqual(['corridor-f1']);
    expect(result.naturalLanguageResponse).toContain('humidity 65');
  });

  it('whole-scope phrasing (全部) deliberately skips the inheritance', async () => {
    const { seam } = makeSeam({ zones: R99_ZONES });
    const result = await runNLAsk(seam, '全部区域的湿度怎么样？', { contextZoneId: 'lab-101' });
    expect(result.data.zones?.map(z => z.zoneId)).toEqual(['lab-101', 'corridor-f1']);
  });

  it('without context a zone-less question keeps the legacy full-jurisdiction read', async () => {
    const { seam } = makeSeam({ zones: R99_ZONES });
    const result = await runNLAsk(seam, '那湿度呢？');
    expect(result.data.zones?.map(z => z.zoneId)).toEqual(['lab-101', 'corridor-f1']);
  });

  it('a stale/unknown context zone degrades to the full jurisdiction', async () => {
    const { seam } = makeSeam({ zones: R99_ZONES });
    const result = await runNLAsk(seam, '那湿度呢？', { contextZoneId: 'demolished-zone' });
    expect(result.data.zones?.map(z => z.zoneId)).toEqual(['lab-101', 'corridor-f1']);
  });
});

describe('runNLAsk — R100 zone context lands on intent.targetZones (zhao-11)', () => {
  const R100_ZONES: NLZoneView[] = [
    { zoneId: 'lab-101', name: '实验室101', parameters: { temperature: 30, humidity: 65, co2: 420 } },
    { zoneId: 'corridor-f1', name: '一层走廊', parameters: { temperature: 30, humidity: 65, co2: 480 } },
  ];

  it('the parser\'s full-jurisdiction GUESS does not defeat inheritance — intent.targetZones is rewritten', async () => {
    // The live R3 failure: the LLM intent parse fills targetZones with ALL
    // managed zones when the question names none (「那湿度呢？」) — under R99
    // that guess won over the conversation context.
    const { seam } = makeSeam({
      zones: R100_ZONES,
      llmAnswer: () => JSON.stringify({
        action: 'get_status',
        targetZones: ['lab-101', 'corridor-f1'],
        targetParameters: { humidity: 1 },
      }),
    });
    const result = await runNLAsk(seam, '那湿度呢？', { contextZoneId: 'lab-101' });
    // The acceptance pins the FIELD, not the prose.
    expect(result.intent.targetZones).toEqual(['lab-101']);
    expect(result.intent.notes?.some(note => note.includes('zone context'))).toBe(true);
    expect(result.data.zones?.map(z => z.zoneId)).toEqual(['lab-101']);
    expect(result.naturalLanguageResponse).toContain('humidity 65');
    expect(result.naturalLanguageResponse).not.toContain('corridor-f1');
  });

  it('an explicit zone mention beats BOTH the context and the parser guess', async () => {
    const { seam } = makeSeam({
      zones: R100_ZONES,
      llmAnswer: () => JSON.stringify({ action: 'get_status', targetZones: ['lab-101'] }),
    });
    const result = await runNLAsk(seam, 'corridor-f1 的湿度呢？', { contextZoneId: 'lab-101' });
    expect(result.intent.targetZones).toEqual(['corridor-f1']);
    expect(result.data.zones?.map(z => z.zoneId)).toEqual(['corridor-f1']);
  });

  // T105/T106 (R17): with a world-wide mention surface, the resolution OUTCOME
  // rides intent.worldMentions — possibly EMPTY — even when the LLM parse lane
  // guesses jurisdiction zones. The server's jurisdiction disclosure consumes
  // exactly this: foreign mentions → the out-of-jurisdiction note; empty + a
  // zone noun in the raw text → the 「未能定位」 note (the parse guess must not
  // mask a failed resolution); empty + no zone noun → silent normal path.
  it('the world-surface outcome rides intent.worldMentions even when the parse guess masks it', async () => {
    const { seam } = makeSeam({
      zones: R100_ZONES,
      llmAnswer: () => JSON.stringify({ action: 'get_status', targetZones: ['lab-101'] }),
    });
    // Unresolvable mention (「Z栋」): worldMentions = [] while the guess stands.
    const unresolved = await runNLAsk(seam, 'Z栋现在温度多少', {
      mentionZones: R100_ZONES,
    });
    expect(unresolved.intent.worldMentions).toEqual([]);
    expect(unresolved.intent.targetZones).toEqual(['lab-101']); // the parse guess stands
    // Foreign mention: the world-resolved foreign zones ARE the intent's zones.
    const foreign = await runNLAsk(seam, 'corridor-f1 的湿度呢？', {
      mentionZones: [...R100_ZONES, { zoneId: 'wing-9', name: '九号楼', parameters: { temperature: 30 } }],
    });
    expect(foreign.intent.worldMentions).toEqual(['corridor-f1']);
    expect(foreign.intent.targetZones).toEqual(['corridor-f1']);
  });
});

// ============================================================================
// VERIFY-BEFORE-ACT (cognitive architecture Phase 4, §4.4 + §5.6): the LLM
// (or rule lane) proposes, the simulation verifies on a private fork.
// ============================================================================


function fakeVerification(verdict: WhatIfResult['verdict'], explanation = `simulated ${verdict}`): WhatIfResult {
  return {
    scenario: {
      intervention: { type: 'device_command', target: 'hvac-1', action: 'set-temperature' },
      metrics: [{ name: 'temperature', zoneId: 'lobby' }],
      durationSec: 600,
    },
    baseline: { temperature_lobby: [29.3] },
    intervention: { temperature_lobby: [28.1] },
    delta: { temperature_lobby: -1.2 },
    verdict,
    confidence: 0.9,
    explanation,
    contributions: [],
    notes: [],
    forkedAtSimTimeSec: 0,
  };
}

describe('runNLCommand — verify-before-act', () => {
  it('a DEGRADATION prediction blocks the batch before any device command runs', async () => {
    const { seam, log } = makeSeam();
    const asked: WhatIfIntervention[] = [];
    seam.verifyWhatIf = async intervention => {
      asked.push(intervention);
      return fakeVerification('degradation', 'lobby temperature would breach the safety band');
    };
    const result = await runNLCommand(seam, 'set the lobby temperature to 30');

    // The primary command was verified BEFORE execution…
    expect(asked).toEqual([
      { type: 'device_command', target: 'hvac-1', action: 'set-temperature', value: 30 },
    ]);
    // …and blocked: nothing reached the device lane.
    expect(log.executed).toHaveLength(0);
    expect(result.executionResult.success).toBe(false);
    expect(result.executionResult.actions).toEqual([]);
    expect(result.executionResult.verification).toMatchObject({ verdict: 'degradation' });
    expect(result.executionResult.rejected?.[0].reason).toContain('what-if verification');
    expect(result.naturalLanguageResponse).toContain('degradation');
  });

  it('an IMPROVEMENT prediction lets the command through (and is reported)', async () => {
    const { seam, log } = makeSeam();
    seam.verifyWhatIf = async () => fakeVerification('improvement');
    const result = await runNLCommand(seam, 'set the lobby temperature to 22');
    expect(log.executed).toHaveLength(1);
    expect(log.executed[0]).toMatchObject({ deviceId: 'hvac-1', command: 'set-temperature' });
    expect(result.executionResult.success).toBe(true);
    expect(result.executionResult.verification?.verdict).toBe('improvement');
  });

  it('a verification-lane FAILURE degrades to executed-UNVERIFIED (never blocks, never silent)', async () => {
    const { seam, log } = makeSeam();
    seam.verifyWhatIf = async () => {
      throw new Error('fork budget exhausted');
    };
    const result = await runNLCommand(seam, 'set the lobby temperature to 22');
    expect(log.executed).toHaveLength(1);
    expect(result.executionResult.success).toBe(true);
    expect(result.executionResult.verification).toMatchObject({ verdict: 'unverified' });
    expect(result.executionResult.verification?.explanation).toContain('fork budget exhausted');
  });

  it('a null verification (lane declined) behaves exactly like no seam', async () => {
    const { seam, log } = makeSeam();
    seam.verifyWhatIf = async () => null;
    const result = await runNLCommand(seam, 'set the lobby temperature to 22');
    expect(log.executed).toHaveLength(1);
    expect(result.executionResult.success).toBe(true);
    expect(result.executionResult.verification).toBeUndefined();
  });

  it('read-only lanes (help/status) never invoke the verification seam', async () => {
    const { seam } = makeSeam();
    let calls = 0;
    seam.verifyWhatIf = async () => {
      calls += 1;
      return fakeVerification('degradation');
    };
    await runNLCommand(seam, 'help');
    await runNLCommand(seam, "what's the status of the lobby?");
    expect(calls).toBe(0);
  });
});

// ============================================================================
// R46-P0 — zero-execution fixes: zh set_parameter device actions, the
// conservative wait/defer override, and execution honesty (a no-op is never
// a success). Devices/zones mirror the shenzhen multi-district family.
// ============================================================================

const CITY_ZONES: NLZoneView[] = [
  { zoneId: 'bao-pump', name: '宝安工业带·雨水泵站', parameters: { waterLevel: 0.4 } },
  { zoneId: 'bao-shelter', name: '宝安工业带·应急避难所', parameters: { temperature: 30 } },
  { zoneId: 'fu-shelter', name: '福田CBD·应急避难所', parameters: { temperature: 31 } },
];

const VALVES: NLDeviceView[] = [
  { deviceId: 'bao-pump-v1', name: '排涝智能阀 1', type: 'smart-valve', zoneId: 'bao-pump', online: true, commands: ['valve-control', 'turn-on', 'turn-off', 'open'] },
  { deviceId: 'bao-pump-v2', name: '排涝智能阀 2', type: 'smart-valve', zoneId: 'bao-pump', online: true, commands: ['valve-control', 'turn-on', 'turn-off', 'open'] },
];

const SHELTER_HVACS: NLDeviceView[] = [
  { deviceId: 'fu-shelter-h1', name: '避难所空调 1', type: 'hvac', zoneId: 'fu-shelter', online: true, commands: ['temperature-control', 'cooling', 'heating', 'turn-on', 'turn-off'], state: { targetTemperature: 24 } },
  { deviceId: 'fu-shelter-h2', name: '避难所空调 2', type: 'hvac', zoneId: 'fu-shelter', online: true, commands: ['temperature-control', 'cooling', 'heating', 'turn-on', 'turn-off'], state: { targetTemperature: 24 } },
];

function makeCitySeam(input: {
  devices: NLDeviceView[];
  managedZoneIds: string[];
  intentAnswer?: string;
  decisionAnswer?: string;
}): { seam: NLSeam; executed: Array<{ deviceId: string; command: string; params?: Record<string, unknown> }> } {
  const executed: Array<{ deviceId: string; command: string; params?: Record<string, unknown> }> = [];
  const seam: NLSeam = {
    agent: {
      agentId: 'city-keeper',
      agentName: 'CityKeeper',
      capabilities: [],
      status: 'idle',
      managedZoneIds: input.managedZoneIds,
    },
    devices: input.devices,
    zones: CITY_ZONES,
    ...(input.intentAnswer !== undefined || input.decisionAnswer !== undefined
      ? {
          llmChat: async (params: ChatParams): Promise<string> => {
            const prompt = params.messages.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n');
            const isIntentCall = prompt.includes('structured intent JSON');
            if (isIntentCall && input.intentAnswer !== undefined) return input.intentAnswer;
            return input.decisionAnswer ?? cognitiveAnswer('wait');
          },
        }
      : {}),
    executeDeviceCommand: async (deviceId, command, params) => {
      executed.push({ deviceId, command, ...(params !== undefined ? { params } : {}) });
      return { success: true, result: { ok: true } };
    },
  };
  return { seam, executed };
}

describe('R46-P0 — zh set_parameter deviceActions execute (rule lane)', () => {
  it('"把宝安泵站的阀门全部打开" opens both valves (non-emergency, actions non-empty)', async () => {
    const { seam, executed } = makeCitySeam({ devices: VALVES, managedZoneIds: ['bao-pump'] });
    const result = await runNLCommand(seam, '把宝安泵站的阀门全部打开');
    expect(result.intent.action).toBe('set_parameter');
    expect(result.intent.targetZones).toEqual(['bao-pump']);
    expect(result.executionResult.actions.length).toBe(2);
    expect(executed).toEqual([
      { deviceId: 'bao-pump-v1', command: 'open' },
      { deviceId: 'bao-pump-v2', command: 'open' },
    ]);
    expect(result.executionResult.success).toBe(true);
    expect(result.executionResult.executedNothing).toBeUndefined();
  });

  it('"把福田避难所的温度调到 26 度" drives the shelter HVACs with target 26', async () => {
    const { seam, executed } = makeCitySeam({ devices: SHELTER_HVACS, managedZoneIds: ['fu-shelter'] });
    const result = await runNLCommand(seam, '把福田避难所的温度调到 26 度');
    expect(result.intent.action).toBe('set_parameter');
    expect(result.intent.targetZones).toEqual(['fu-shelter']);
    expect(result.intent.targetParameters).toEqual({ temperature: 26 });
    expect(result.executionResult.actions.length).toBe(2);
    expect(executed[0]).toEqual({ deviceId: 'fu-shelter-h1', command: 'temperature-control', params: { target: 26 } });
    expect(executed[1]).toEqual({ deviceId: 'fu-shelter-h2', command: 'temperature-control', params: { target: 26 } });
    expect(result.executionResult.success).toBe(true);
  });
});

describe('R46-P0 — conservative LLM decisions no longer zero-execute', () => {
  it('a "wait" decision is overridden when rules map the command onto own devices', async () => {
    const { seam, executed } = makeCitySeam({
      devices: SHELTER_HVACS,
      managedZoneIds: ['fu-shelter'],
      intentAnswer: JSON.stringify({ action: 'set_parameter', targetZones: ['fu-shelter'], targetParameters: { temperature: 26 } }),
      decisionAnswer: cognitiveAnswer('wait'),
    });
    const result = await runNLCommand(seam, '把福田避难所的温度调到 26 度');
    expect(result.decisionSource).toBe('llm');
    expect(result.cognitiveDecision.actionPlan.primary.action).toBe('handle_independently');
    expect(result.cognitiveDecision.actionPlan.primary.reasoning).toContain('deterministic override');
    expect(executed.length).toBe(2);
    expect(result.executionResult.success).toBe(true);
  });

  it('"南山变电站刚才跳闸了" is still a genuine emergency (immediate escalation lane)', async () => {
    const { seam, executed } = makeCitySeam({
      devices: SHELTER_HVACS,
      managedZoneIds: ['fu-shelter'],
      decisionAnswer: cognitiveAnswer('handle_independently'),
    });
    const result = await runNLCommand(seam, '南山变电站刚才跳闸了');
    expect(result.intent.action).toBe('emergency');
    expect(result.decisionSource).toBe('emergency');
    expect(result.cognitiveDecision.actionPlan.primary.action).toBe('escalate');
    expect(executed).toHaveLength(0);
  });
});

describe('R46-P0 — execution honesty (a no-op is never a success)', () => {
  it('a defer decision with nothing mapped reports success:false + executedNothing', async () => {
    const { seam } = makeSeam({ llmAnswer: () => cognitiveAnswer('defer') });
    const result = await runNLCommand(seam, 'figure out the lobby');
    expect(result.executionResult.actions).toEqual([]);
    expect(result.executionResult.success).toBe(false);
    expect(result.executionResult.executedNothing).toBe(true);
    expect(result.executionResult.message).toContain("decided 'defer'");
  });

  it('a handle_independently decision that maps to ZERO commands is also a no-op', async () => {
    const { seam } = makeSeam({
      llmAnswer: () => cognitiveAnswer('handle_independently'),
    });
    const result = await runNLCommand(seam, 'set the office temperature to 22');
    expect(result.executionResult.actions).toEqual([]);
    expect(result.executionResult.success).toBe(false);
    expect(result.executionResult.executedNothing).toBe(true);
  });
});

// ============================================================================
// R46C-P0-A — the device-ownership gate at the EXECUTION layer: the NL
// channel must not bypass the direct command channel's org boundary.
// ============================================================================

describe('R46C-P0-A — seam device-ownership gate', () => {
  it('a denial propagates as NLDeviceGateError carrying the ORIGINAL error; nothing executes', async () => {
    const { seam, log } = makeSeam();
    const denial = new Error('403 FORBIDDEN — cross-org device');
    seam.assertDeviceCommand = deviceId => {
      if (deviceId === 'hvac-1') throw denial;
    };
    const caught = await runNLCommand(seam, 'set the lobby temperature to 22').catch(e => e);
    expect(caught).toBeInstanceOf(NLDeviceGateError);
    expect((caught as NLDeviceGateError).denial).toBe(denial);
    expect(log.executed).toHaveLength(0);
  });

  it('the gate sees every FINAL target (decision deviceActions and rule-mapped alike); passing gates execute', async () => {
    const { seam, log } = makeSeam();
    const gated: string[] = [];
    seam.assertDeviceCommand = deviceId => {
      gated.push(deviceId);
    };
    const result = await runNLCommand(seam, 'set the lobby temperature to 22');
    expect(gated).toContain('hvac-1');
    expect(result.executionResult.success).toBe(true);
    expect(log.executed.length).toBeGreaterThanOrEqual(1);
  });

  it('the gate runs BEFORE the verification fork — a denied command wastes no prediction', async () => {
    const { seam } = makeSeam();
    let verifications = 0;
    seam.verifyWhatIf = async () => {
      verifications += 1;
      return null;
    };
    seam.assertDeviceCommand = () => {
      throw new Error('denied');
    };
    await expect(runNLCommand(seam, 'set the lobby temperature to 22')).rejects.toThrow('denied');
    expect(verifications).toBe(0);
  });

  it('no gate injected (rule-only lane / tests) behaves exactly as before', async () => {
    const { seam, log } = makeSeam();
    const result = await runNLCommand(seam, 'set the lobby temperature to 22');
    expect(result.executionResult.success).toBe(true);
    expect(log.executed).toHaveLength(1);
  });
});

// ============================================================================
// R46C-P0-B — situation sync on emergency downgrade: the intent layer's
// emergency veto (R46-P0-4a) must not leave a hallucinated emergency
// narrative standing in the cognitive decision.
// ============================================================================

/** A decision answer whose situation still claims the emergency narrative. */
function hallucinatedEmergencyAnswer(action: string, deviceActions: unknown[] = []): string {
  const decision = {
    situation: {
      type: 'emergency',
      severity: 3,
      affectedZones: ['bao-pump'],
      rootCauseHypothesis: '台风过境后的火灾残余风险',
      confidence: 0.7,
    },
    goals: [{ goal: 'ensure_safety', priority: 1 }],
    actionPlan: {
      primary: {
        action,
        reasoning: 'ambient typhoon narrative suggests residual fire risk',
        ...(deviceActions.length > 0 ? { deviceActions } : {}),
      },
    },
    explanation: { summary: 'Emergency conditions detected.', factors: [{ name: 'safety', weight: 1 }] },
    collaboration: { needed: false },
    uncertainty: { overall: 0.8 },
  } as unknown as CognitiveDecision;
  return JSON.stringify(decision);
}

describe('R46C-P0-B — hallucinated emergency situations sync down with the intent veto', () => {
  it('"把宝安泵站的阀门全部打开": vetoed intent + emergency decision → situation synced, command executes', async () => {
    const { seam, executed } = makeCitySeam({
      devices: VALVES,
      managedZoneIds: ['bao-pump'],
      // The intent LLM over-classifies emergency → vetoed to set_parameter
      // (R46-P0-4a)…
      intentAnswer: JSON.stringify({ action: 'emergency' }),
      // …but the decision lane still hallucinates the emergency narrative
      // and wants to escalate.
      decisionAnswer: hallucinatedEmergencyAnswer('escalate'),
    });
    const result = await runNLCommand(seam, '把宝安泵站的阀门全部打开');
    expect(result.intent.action).toBe('set_parameter');
    expect(result.intent.notes?.some(n => n.includes('R46-P0-4a'))).toBe(true);
    // The situation no longer claims emergency…
    expect(result.cognitiveDecision.situation.type).toBe('normal');
    expect(result.cognitiveDecision.situation.severity).toBeLessThanOrEqual(2);
    expect(result.cognitiveDecision.situation.rootCauseHypothesis).toContain('把宝安泵站的阀门全部打开');
    expect(result.cognitiveDecision.situation.rootCauseHypothesis).not.toContain('火灾');
    // …the command still ran (conservative override + clean narrative)…
    expect(result.cognitiveDecision.actionPlan.primary.action).toBe('handle_independently');
    expect(executed.length).toBe(2);
    // …and the NL reply does not open with the emergency template.
    expect(result.naturalLanguageResponse).not.toContain('紧急');
    expect(result.naturalLanguageResponse).not.toContain('EMERGENCY');
  });

  it('a handle_independently decision with a hallucinated emergency situation is synced too (no override needed)', async () => {
    const { seam, log } = makeSeam({
      llmAnswer: () => hallucinatedEmergencyAnswer('handle_independently', [
        { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 22 } },
      ]),
    });
    const result = await runNLCommand(seam, 'set the lobby temperature to 22');
    expect(result.decisionSource).toBe('llm');
    expect(result.cognitiveDecision.situation.type).toBe('normal');
    expect(result.cognitiveDecision.situation.severity).toBeLessThanOrEqual(2);
    expect(log.executed).toHaveLength(1);
    expect(result.naturalLanguageResponse).not.toContain('EMERGENCY');
  });

  it('non-emergency situations (anomaly etc.) pass through untouched', async () => {
    const { seam } = makeSeam({
      llmAnswer: () => cognitiveAnswer('handle_independently', [
        { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 22 } },
      ]),
    });
    const result = await runNLCommand(seam, 'set the lobby temperature to 22');
    expect(result.cognitiveDecision.situation.type).toBe('anomaly');
    expect(result.cognitiveDecision.situation.severity).toBe(3);
  });

  it('a GENUINE emergency (跳闸) keeps its emergency situation — the emergency lane is unaffected', async () => {
    const { seam, executed } = makeCitySeam({
      devices: VALVES,
      managedZoneIds: ['bao-pump'],
      decisionAnswer: hallucinatedEmergencyAnswer('handle_independently'),
    });
    const result = await runNLCommand(seam, '南山变电站刚才跳闸了');
    expect(result.intent.action).toBe('emergency');
    expect(result.decisionSource).toBe('emergency');
    expect(result.cognitiveDecision.situation.type).toBe('emergency');
    expect(result.cognitiveDecision.situation.severity).toBe(5);
    expect(result.cognitiveDecision.actionPlan.primary.action).toBe('escalate');
    expect(executed).toHaveLength(0);
  });
});

// ============================================================================
// F0-2 — every lane's decision output satisfies the versioned decision-v1
// schema (rule fallback included): downstream consumers ALWAYS see a legal
// shape, and a schema-violating LLM answer under guided JSON is rejected onto
// the rule lane instead of silently repaired.
// ============================================================================

describe('F0-2 — decision-v1 schema holds on every NL lane', () => {
  const expectValidDecision = (decision: CognitiveDecision, lane: string): void => {
    const validation = validateDecisionV1(decision);
    expect(validation.errors, `${lane} lane decision must satisfy decision-v1`).toEqual([]);
  };

  it('rule lane (rule-only agent, no LLM seam): the deterministic decision validates', async () => {
    const { seam } = makeSeam();
    const result = await runNLCommand(seam, 'set the lobby temperature to 23');
    expect(result.decisionSource).toBe('rules');
    expectValidDecision(result.cognitiveDecision, 'rule');
  });

  it('rule lane via LLM-down degradation validates', async () => {
    const { seam } = makeSeam({ llmAnswer: () => new Error('connect ECONNREFUSED 127.0.0.1:1') });
    const result = await runNLCommand(seam, 'set the lobby temperature to 22 degrees');
    expect(result.decisionSource).toBe('rules');
    expectValidDecision(result.cognitiveDecision, 'rule-llm-down');
  });

  it('emergency lane decision validates', async () => {
    const { seam } = makeSeam();
    const result = await runNLCommand(seam, 'fire in the lobby!');
    expect(result.decisionSource).toBe('emergency');
    expectValidDecision(result.cognitiveDecision, 'emergency');
  });

  it('help and status lanes validate', async () => {
    const { seam } = makeSeam();
    const help = await runNLCommand(seam, 'help');
    expect(help.intent.action).toBe('help');
    expectValidDecision(help.cognitiveDecision, 'help');
    const status = await runNLCommand(seam, "what's the status of the lobby?");
    expect(status.intent.action).toBe('get_status');
    expectValidDecision(status.cognitiveDecision, 'status');
  });

  it('the exported error-fallback decision validates', () => {
    expectValidDecision(buildErrorFallbackDecision('boom'), 'error-fallback');
  });

  it('LLM lane: a schema-violating answer under guided JSON degrades to the rule lane (never silently repaired)', async () => {
    delete process.env.LLM_GUIDED_JSON; // default: guided JSON ON → checked parse
    const { seam } = makeSeam({
      // decision-v1 violation: the required `situation` block is missing.
      llmAnswer: () => JSON.stringify({
        actionPlan: { primary: { action: 'wait', reasoning: 'unsure' } },
        uncertainty: { overall: 0.6 },
      }),
    });
    const result = await runNLCommand(seam, 'set the lobby temperature to 22 degrees');
    expect(result.decisionSource).toBe('rules'); // rejected → deterministic fallback
    expectValidDecision(result.cognitiveDecision, 'rule-after-schema-reject');
  });
});

// ============================================================================
// F2-2 — the verb branch is no longer gated on "zero parameters": when the
// intent LLM invents an in-range parameter a toggle-only device cannot
// consume (bare "打开智能窗帘" → brightness:100), rules must STILL map the
// verb onto the device's toggle surface so the R46-P0-4b override fires
// (same-name-diagnosis.md).
// ============================================================================

const CURTAIN: NLDeviceView[] = [
  { deviceId: 'curtain-1', name: '智能窗帘', type: 'curtain', zoneId: 'fu-shelter', online: true, commands: ['turn-on', 'turn-off'] },
];

describe('F2-2 — invented parameters no longer suppress the verb branch', () => {
  it('toggle-only device + invented brightness param + "打开" ⇒ rules produce turn-on, initiate_ac is overridden', async () => {
    const { seam, executed } = makeCitySeam({
      devices: CURTAIN,
      managedZoneIds: ['fu-shelter'],
      // The intent LLM names the curtain precisely but invents an in-range
      // brightness parameter the curtain's surface cannot consume.
      intentAnswer: JSON.stringify({
        action: 'set_parameter',
        targetDevices: ['curtain-1'],
        targetParameters: { brightness: 100 },
      }),
      // The decision LLM hallucinates a collaboration ask — the deterministic
      // override must rewrite it once rules have a concrete action.
      decisionAnswer: cognitiveAnswer('initiate_ac'),
    });
    const result = await runNLCommand(seam, '打开智能窗帘');
    expect(result.cognitiveDecision.actionPlan.primary.action).toBe('handle_independently');
    expect(result.cognitiveDecision.actionPlan.primary.reasoning).toContain('deterministic override');
    expect(executed).toEqual([{ deviceId: 'curtain-1', command: 'turn-on' }]);
    expect(result.executionResult.success).toBe(true);
  });

  it('rule-only lane (no LLM): invented param + "打开" still turns the toggle-only device on', async () => {
    const executed: Array<{ deviceId: string; command: string }> = [];
    const seam: NLSeam = {
      agent: { agentId: 'curtain-keeper', agentName: 'CurtainKeeper', capabilities: [], status: 'idle' },
      devices: CURTAIN,
      zones: CITY_ZONES,
      executeDeviceCommand: async (deviceId, command) => {
        executed.push({ deviceId, command });
        return { success: true, result: { ok: true } };
      },
    };
    // No llm seam: the deterministic parser invents no parameter for a bare
    // "打开" ask, so this pins the verb path itself; the LLM-intent variant
    // above pins the invented-parameter regression.
    const result = await runNLCommand(seam, '打开智能窗帘');
    expect(result.decisionSource).toBe('rules');
    expect(executed).toEqual([{ deviceId: 'curtain-1', command: 'turn-on' }]);
  });

  it('a parameter-CONSUMING device does not get a duplicate verb toggle', async () => {
    const { seam, executed } = makeCitySeam({
      devices: SHELTER_HVACS,
      managedZoneIds: ['fu-shelter'],
      intentAnswer: JSON.stringify({
        action: 'set_parameter',
        targetZones: ['fu-shelter'],
        targetParameters: { temperature: 26 },
      }),
      decisionAnswer: cognitiveAnswer('wait'),
    });
    const result = await runNLCommand(seam, '打开福田避难所的空调并把温度调到26度');
    expect(result.cognitiveDecision.actionPlan.primary.action).toBe('handle_independently');
    // Each HVAC gets exactly ONE action (temperature-control); no turn-on
    // supplement for devices the parameter branch already mapped.
    expect(executed).toEqual([
      { deviceId: 'fu-shelter-h1', command: 'temperature-control', params: { target: 26 } },
      { deviceId: 'fu-shelter-h2', command: 'temperature-control', params: { target: 26 } },
    ]);
    expect(executed.every(e => e.command !== 'turn-on')).toBe(true);
  });

  it('pure parameter command (no verb) is unchanged — no verb supplement appears', async () => {
    const { seam, executed } = makeCitySeam({
      devices: SHELTER_HVACS,
      managedZoneIds: ['fu-shelter'],
      intentAnswer: JSON.stringify({
        action: 'set_parameter',
        targetZones: ['fu-shelter'],
        targetParameters: { temperature: 26 },
      }),
      decisionAnswer: cognitiveAnswer('wait'),
    });
    const result = await runNLCommand(seam, '把福田避难所的温度调到26度');
    expect(result.cognitiveDecision.actionPlan.primary.action).toBe('handle_independently');
    expect(executed).toEqual([
      { deviceId: 'fu-shelter-h1', command: 'temperature-control', params: { target: 26 } },
      { deviceId: 'fu-shelter-h2', command: 'temperature-control', params: { target: 26 } },
    ]);
  });
});

// ============================================================================
// R84 (R44-F2 residual) — collective/set targets: 「把我区全部排水阀打开」
// expands deterministically (zone scope ∩ capability-kind filter over the
// OWN surface); zero kind matches is a teaching answer, never a silent no-op.
// ============================================================================

/** A district keeper's surface: valves + a light in ITS zone, a valve across the border. */
const DISTRICT_DEVICES: NLDeviceView[] = [
  { deviceId: 'fu-valve-1', name: '排涝智能阀 1', type: 'smart-valve', zoneId: 'fu-shelter', online: true, commands: ['open', 'close'] },
  { deviceId: 'fu-valve-2', name: '排涝智能阀 2', type: 'smart-valve', zoneId: 'fu-shelter', online: true, commands: ['open', 'close'] },
  { deviceId: 'fu-light-1', name: '应急照明 1', type: 'light', zoneId: 'fu-shelter', online: true, commands: ['turn-on', 'turn-off'] },
  { deviceId: 'bao-valve-1', name: '排涝智能阀 3', type: 'smart-valve', zoneId: 'bao-pump', online: true, commands: ['open', 'close'] },
];

describe('R84 (R44-F2) — collective targets expand by zone ∩ capability-kind', () => {
  it('「把我区全部排水阀打开」 opens the managed-zone valves only (name-fragment-blind kind word)', async () => {
    const { seam, executed } = makeCitySeam({ devices: DISTRICT_DEVICES, managedZoneIds: ['fu-shelter'] });
    const result = await runNLCommand(seam, '把我区全部排水阀打开');
    expect(result.intent.action).toBe('set_parameter');
    expect(result.intent.collective).toEqual({ word: '排水阀/阀门', matched: 2 });
    expect(result.intent.targetZones).toEqual(['fu-shelter']);
    // 排水阀 ∩ 排涝智能阀 shares no 2-char run — only the kind table sees these.
    expect(result.intent.targetDevices).toEqual(['fu-valve-1', 'fu-valve-2']);
    // The zone's LIGHT is not re-widened into the batch; the foreign valve stays untouched.
    expect(executed).toEqual([
      { deviceId: 'fu-valve-1', command: 'open' },
      { deviceId: 'fu-valve-2', command: 'open' },
    ]);
    expect(result.executionResult.success).toBe(true);
  });

  it('「把福田避难所全部照明打开」 scopes the kind expansion to the named zone', async () => {
    const { seam, executed } = makeCitySeam({ devices: DISTRICT_DEVICES, managedZoneIds: ['fu-shelter'] });
    const result = await runNLCommand(seam, '把福田避难所全部照明打开');
    expect(result.intent.collective).toEqual({ word: '照明', matched: 1 });
    expect(executed).toEqual([{ deviceId: 'fu-light-1', command: 'turn-on' }]);
  });

  it('「open all the valves」 without a zone scope covers the whole own surface', async () => {
    const { seam, executed } = makeCitySeam({ devices: DISTRICT_DEVICES, managedZoneIds: ['fu-shelter'] });
    const result = await runNLCommand(seam, 'open all the valves');
    expect(result.intent.collective?.matched).toBe(3);
    expect(executed).toEqual([
      { deviceId: 'fu-valve-1', command: 'open' },
      { deviceId: 'fu-valve-2', command: 'open' },
      { deviceId: 'bao-valve-1', command: 'open' },
    ]);
  });

  it('zero kind matches → teaching names what the agent CAN operate in scope (no silent no-op)', async () => {
    const { seam, executed } = makeCitySeam({ devices: DISTRICT_DEVICES, managedZoneIds: ['fu-shelter'] });
    const result = await runNLCommand(seam, '把我区全部摄像头打开');
    expect(result.intent.collective).toEqual({ word: '摄像头', matched: 0 });
    expect(executed).toEqual([]);
    expect(result.executionResult.success).toBe(false);
    const reasons = (result.executionResult.rejected ?? []).map(r => r.reason).join(' | ');
    expect(reasons).toContain('摄像头');
    expect(reasons).toContain('排涝智能阀 1'); // the available surface, by NAME
    // The teaching is spoken in the operator's language through the refused line.
    expect(result.naturalLanguageResponse).toContain('摄像头');
    expect(result.naturalLanguageResponse).toContain('排涝智能阀 1');
  });

  it('LLM lane: a conservative escalate on a collective ask is overridden by the rule expansion', async () => {
    const { seam, executed } = makeCitySeam({
      devices: DISTRICT_DEVICES,
      managedZoneIds: ['fu-shelter'],
      intentAnswer: JSON.stringify({ action: 'set_parameter', targetZones: ['fu-shelter'] }),
      decisionAnswer: cognitiveAnswer('escalate'),
    });
    const result = await runNLCommand(seam, '把我区全部排水阀打开');
    expect(result.cognitiveDecision.actionPlan.primary.action).toBe('handle_independently');
    expect(result.cognitiveDecision.actionPlan.primary.reasoning).toContain('deterministic override');
    expect(executed).toEqual([
      { deviceId: 'fu-valve-1', command: 'open' },
      { deviceId: 'fu-valve-2', command: 'open' },
    ]);
  });

  it('non-collective commands are untouched: 「把温度调到22度」 still widens zone-less to all candidates', async () => {
    const { seam, executed } = makeCitySeam({ devices: SHELTER_HVACS, managedZoneIds: ['fu-shelter'] });
    const result = await runNLCommand(seam, '把温度调到22度');
    expect(result.intent.collective).toBeUndefined();
    expect(executed).toHaveLength(2);
  });
});

// ============================================================================
// R6-E-F09 — NL lane flow honesty: the invocable-flows listing rides the
// decision prompt (same source/gates as the decision lane), a hallucinated
// flowId is REFUSED with the real listing spelled out, and a legitimate
// invoke_flow decision executes through the governed runAsAgent lane.
// ============================================================================

const FLOW_OFFERINGS = [
  { flowId: 'flow-post-class', name: '课后自动关空调节能' },
  { flowId: 'flow-morning-prep', name: 'morning-prep', description: 'pre-cool before occupancy' },
];

/** A well-formed invoke_flow CognitiveDecision JSON answer. */
function flowDecisionAnswer(flowId: string | undefined, flowParams?: Record<string, unknown>): string {
  const decision = {
    situation: { type: 'normal', severity: 1, affectedZones: [], rootCauseHypothesis: '', confidence: 0.8 },
    goals: [],
    actionPlan: {
      primary: {
        action: 'invoke_flow',
        reasoning: 'the operator asked to run the flow',
        ...(flowId !== undefined ? { flowId } : {}),
        ...(flowParams !== undefined ? { flowParams } : {}),
      },
    },
    explanation: { summary: 'Running the requested flow.', factors: [{ name: 'comfort', weight: 0.7 }] },
    collaboration: { needed: false },
    uncertainty: { overall: 0.7 },
  };
  return JSON.stringify(decision);
}

function makeFlowSeam(input: {
  decisionAnswer: string;
  offerings?: Array<{ flowId: string; name: string; description?: string }>;
  invokeOutcome?: import('../flows/index.js').AgentFlowInvocationOutcome;
}): {
  seam: NLSeam;
  prompts: string[];
  invoked: Array<{ flowId: string; params?: Record<string, unknown> }>;
} {
  const prompts: string[] = [];
  const invoked: Array<{ flowId: string; params?: Record<string, unknown> }> = [];
  const seam: NLSeam = {
    agent: { agentId: 'facility-mgr', agentName: 'FacilityMgr', capabilities: [], status: 'idle' },
    devices: DEVICES,
    zones: ZONES,
    llmChat: async (params: ChatParams): Promise<string> => {
      const prompt = params.messages.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n');
      prompts.push(prompt);
      if (prompt.includes('structured intent JSON')) {
        return JSON.stringify({ action: 'run_flow' });
      }
      return input.decisionAnswer;
    },
    executeDeviceCommand: async () => ({ success: true, result: { ok: true } }),
    ...(input.offerings !== undefined ? { invocableFlows: () => input.offerings! } : {}),
    ...(input.invokeOutcome !== undefined
      ? {
          invokeFlow: async (flowId: string, params?: Record<string, unknown>) => {
            invoked.push({ flowId, ...(params !== undefined ? { params } : {}) });
            return input.invokeOutcome!;
          },
        }
      : {}),
  };
  return { seam, prompts, invoked };
}

describe('R6-E-F09 — NL lane invocable-flows listing (prompt honesty)', () => {
  it('the decision prompt carries INVOCABLE_FLOWS from the seam listing', async () => {
    const { seam, prompts } = makeFlowSeam({
      decisionAnswer: cognitiveAnswer('wait'),
      offerings: FLOW_OFFERINGS,
    });
    await runNLCommand(seam, 'run the post-class shutdown flow');
    const decisionPrompt = prompts.find(p => p.includes('PARSED_INTENT')) ?? '';
    expect(decisionPrompt).toContain('INVOCABLE_FLOWS (your owner');
    expect(decisionPrompt).toContain('flow-post-class');
    expect(decisionPrompt).toContain('课后自动关空调节能');
    expect(decisionPrompt).toContain('flow-morning-prep');
    expect(decisionPrompt).toContain('Never invent a flowId');
  });

  it('an empty listing renders NO flow section (decision-lane parity)', async () => {
    const { seam, prompts } = makeFlowSeam({
      decisionAnswer: cognitiveAnswer('wait'),
      offerings: [],
    });
    await runNLCommand(seam, 'run the post-class shutdown flow');
    const decisionPrompt = prompts.find(p => p.includes('PARSED_INTENT')) ?? '';
    // The section marker, not the word — the system instruction's contract
    // text ("flowId only from INVOCABLE_FLOWS") always carries the bare word.
    expect(decisionPrompt).not.toContain('INVOCABLE_FLOWS (your owner');
  });

  it('no listing seam at all → no flow section', async () => {
    const { seam, prompts } = makeFlowSeam({ decisionAnswer: cognitiveAnswer('wait') });
    await runNLCommand(seam, 'run the post-class shutdown flow');
    const decisionPrompt = prompts.find(p => p.includes('PARSED_INTENT')) ?? '';
    expect(decisionPrompt).not.toContain('INVOCABLE_FLOWS (your owner');
  });
});

describe('R6-E-F09 — hallucinated flowId is refused honestly (never a fake match)', () => {
  it('a flowId NOT in the listing is refused with the real listing spelled out; invokeFlow never fires', async () => {
    const { seam, invoked } = makeFlowSeam({
      // The exact V2 reproduction: the model invents `post-class-ac-shutdown`
      // and claims it "matches INVOCABLE_FLOWS".
      decisionAnswer: flowDecisionAnswer('post-class-ac-shutdown'),
      offerings: FLOW_OFFERINGS,
      invokeOutcome: { status: 'invoked', run: {
        runId: 'run-x', flowId: 'post-class-ac-shutdown', triggerKind: 'agent',
        status: 'success', summary: '', nodeResults: {},
        startedAt: '2026-09-13T00:00:00Z', finishedAt: '2026-09-13T00:00:01Z',
      } },
    });
    const result = await runNLCommand(seam, '请调用「课后自动关空调节能」这个 flow');
    expect(invoked).toEqual([]); // the gate rejected BEFORE any invocation
    expect(result.executionResult.success).toBe(false);
    expect(result.executionResult.executedNothing).toBe(true);
    expect(result.executionResult.flowInvocation).toMatchObject({
      flowId: 'post-class-ac-shutdown',
      status: 'refused',
    });
    expect(result.executionResult.flowInvocation?.reason).toContain('does not exist or you are not allowed');
    // The honest reply names the refusal and the real invocable flows.
    expect(result.executionResult.message).toContain('flow-post-class');
    expect(result.naturalLanguageResponse).toContain('post-class-ac-shutdown');
  });

  it('a decision with NO flowId is refused without touching the lane', async () => {
    const { seam, invoked } = makeFlowSeam({
      decisionAnswer: flowDecisionAnswer(undefined),
      offerings: FLOW_OFFERINGS,
      invokeOutcome: { status: 'refused', reason: 'should never reach the lane' },
    });
    const result = await runNLCommand(seam, 'run a flow please');
    expect(invoked).toEqual([]);
    expect(result.executionResult.flowInvocation).toMatchObject({ flowId: 'unknown', status: 'refused' });
    expect(result.executionResult.success).toBe(false);
  });

  it('no invocation lane wired → honest refusal (never a fake start)', async () => {
    const { seam } = makeFlowSeam({
      decisionAnswer: flowDecisionAnswer('flow-post-class'),
      offerings: FLOW_OFFERINGS,
      // invokeFlow absent — the runtime has no lane.
    });
    const result = await runNLCommand(seam, '请调用「课后自动关空调节能」这个 flow');
    expect(result.executionResult.flowInvocation).toMatchObject({
      flowId: 'flow-post-class',
      status: 'refused',
    });
    expect(result.executionResult.flowInvocation?.reason).toContain('no flow-invocation lane');
    expect(result.executionResult.success).toBe(false);
  });
});

describe('R6-E-F09 — a legitimate flowId executes through the governed lane', () => {
  it('a listed flowId invokes runAsAgent with the decision params; the run receipt rides the result', async () => {
    const { seam, invoked } = makeFlowSeam({
      decisionAnswer: flowDecisionAnswer('flow-post-class', { zone: 'classroom-101' }),
      offerings: FLOW_OFFERINGS,
      invokeOutcome: { status: 'invoked', run: {
        runId: 'run-42', flowId: 'flow-post-class', triggerKind: 'agent',
        status: 'success', summary: 'all nodes done', nodeResults: {},
        startedAt: '2026-09-13T00:00:00Z', finishedAt: '2026-09-13T00:00:01Z',
      } },
    });
    const result = await runNLCommand(seam, '请调用「课后自动关空调节能」这个 flow');
    // runAsAgent's four gates live inside the lane — the orchestrator calls it
    // with exactly the decision's flowId/params.
    expect(invoked).toEqual([{ flowId: 'flow-post-class', params: { zone: 'classroom-101' } }]);
    expect(result.executionResult.flowInvocation).toEqual({
      flowId: 'flow-post-class',
      status: 'invoked',
      runId: 'run-42',
      runStatus: 'success',
    });
    expect(result.executionResult.success).toBe(true);
    expect(result.executionResult.message).toContain('run-42');
    expect(result.naturalLanguageResponse).toContain('flow-post-class');
  });

  it('a gate refusal from the lane (flag off / T-201) is carried honestly, not executed', async () => {
    const { seam, invoked } = makeFlowSeam({
      decisionAnswer: flowDecisionAnswer('flow-post-class'),
      offerings: FLOW_OFFERINGS,
      invokeOutcome: {
        status: 'refused',
        reason: "flow 'flow-post-class' is not agent-invocable — set agentInvocable: true on the flow",
      },
    });
    const result = await runNLCommand(seam, '请调用「课后自动关空调节能」这个 flow');
    expect(invoked).toEqual([{ flowId: 'flow-post-class' }]); // the gate decides, not the orchestrator
    expect(result.executionResult.flowInvocation).toMatchObject({
      flowId: 'flow-post-class',
      status: 'refused',
      reason: "flow 'flow-post-class' is not agent-invocable — set agentInvocable: true on the flow",
    });
    expect(result.executionResult.success).toBe(false);
    expect(result.executionResult.executedNothing).toBe(true);
    expect(result.naturalLanguageResponse).toContain('agent-invocable');
  });

  it('a FAILED run is still an invocation (status carried, success false)', async () => {
    const { seam } = makeFlowSeam({
      decisionAnswer: flowDecisionAnswer('flow-post-class'),
      offerings: FLOW_OFFERINGS,
      invokeOutcome: { status: 'invoked', run: {
        runId: 'run-43', flowId: 'flow-post-class', triggerKind: 'agent',
        status: 'failed', summary: 'node 2 refused', nodeResults: {},
        startedAt: '2026-09-13T00:00:00Z', finishedAt: '2026-09-13T00:00:01Z',
      } },
    });
    const result = await runNLCommand(seam, '请调用「课后自动关空调节能」这个 flow');
    expect(result.executionResult.flowInvocation).toEqual({
      flowId: 'flow-post-class',
      status: 'invoked',
      runId: 'run-43',
      runStatus: 'failed',
    });
    expect(result.executionResult.success).toBe(false);
  });
});
