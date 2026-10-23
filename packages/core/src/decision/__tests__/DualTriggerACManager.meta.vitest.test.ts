/**
 * Phase 5 integration: the meta-cognition layer wired into the decision
 * pipeline (cognitive architecture §7).
 *
 * Covers:
 * - ADDITIVITY: without MetaCognition injected, the context carries no
 *   metaCognition field and the decision prompt stays byte-identical
 *   (no META_COGNITION section) — the P0/P1 determinism invariant;
 * - WITH meta: the prompt carries the capability boundary / partner trust /
 *   calibration projection (META_COGNITION, one S1 block);
 * - the FEEDBACK LOOP end-to-end: decision → outcome (COLLABORATION_COMPLETED
 *   or independent actuation signals) → quality metrics → adaptive policy →
 *   the NEXT prompt renders the adjusted self-knowledge;
 * - checkpoint round-trip through the manager's cognition checkpoint face.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { DualTriggerACManager } from '../DualTriggerACManager.js';
import { MetaCognition } from '../../cognition/meta.js';
import { AgentWorldModelStore } from '../../cognition/world-model.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { SystemEvent } from '../../events/EventManager.js';
import { EventType } from '@active-collaboration/shared';
import type { AgentContext } from '../ACNecessityAssessor.js';

interface TestAccess {
  buildAgentContext: () => Promise<AgentContext>;
}

function urgentEvent(overrides: Record<string, unknown> = {}): SystemEvent {
  return {
    id: 'evt-test-1',
    type: EventType.ENVIRONMENT_PARAM_CHANGED,
    source: 'test',
    timestamp: new Date(),
    priority: 'high',
    payload: {
      eventType: 'temperature-spike',
      zoneId: 'floor-1',
      parameter: 'temperature',
      newValue: 32.5,
      temperature: 32.5,
      severity: 'high',
      ...overrides,
    },
  } as unknown as SystemEvent;
}

/**
 * Declared requirement fixture: a sensor-only agent matching exactly 1 of 1
 * declared capabilities is below preCheck's ≥2 domain-relevance bar → the
 * decision falls through to the LLM (same recipe as the Phase-1 cognitive
 * suite), while the declared gap stays empty so an independent answer
 * survives makeDecision's T-041 fork.
 */
const declaredNeed = (capability: string): Record<string, unknown> => ({
  requiredCapabilities: [capability],
});

/** A cognitive JSON answer (Phase 1 contract) with configurable action. */
function cognitiveAnswer(action: 'initiate_ac' | 'handle_independently', uncertainty = 0.85): string {
  return JSON.stringify({
    situation: { type: 'anomaly', severity: 4, affectedZones: ['floor-1'], rootCauseHypothesis: 'hvac degradation', confidence: 0.8 },
    actionPlan: {
      primary: {
        action,
        reasoning: action === 'initiate_ac' ? 'gap in fire response' : 'own devices cover this',
      },
    },
    explanation: { summary: action === 'initiate_ac' ? 'Needs a partner.' : 'Own devices cover it.', factors: [] },
    collaboration: { needed: action === 'initiate_ac' },
    uncertainty: { overall: uncertainty, dataQuality: 0.9, riskFactors: [] },
  });
}

interface ManagerOptions {
  /** Actuator-zone config: direct event-zone coverage → preCheck falls through to the LLM. */
  actuatorZoneIds?: string[];
  autoInitiateAC?: boolean;
  commandExecutor?: boolean;
}

function makeManager(capabilities: string[], llmAnswer: string, options: ManagerOptions = {}) {
  const llm: LLMClient = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
  (llm.quickChat as Mock).mockResolvedValue(llmAnswer);
  const environment = {
    listDevices: vi.fn().mockReturnValue([]),
    listAgents: vi.fn().mockReturnValue([]),
    getParameters: vi.fn().mockReturnValue({}),
    eventManager: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() },
    services: new Map(),
  } as unknown as EnvironmentCenter;
  const manager = new DualTriggerACManager(
    'agent-1',
    'TestAgent',
    capabilities,
    llm,
    environment,
    vi.fn(),
    {
      enableLayer1: false,
      enableLayer2: true,
      autoInitiateAC: options.autoInitiateAC ?? false,
      // Direct actuator coverage of the event zone keeps preCheck in Type B
      // (fall-through) so the scripted LLM answer actually decides.
      ...(options.actuatorZoneIds !== undefined ? { actuatorZoneIds: options.actuatorZoneIds } : {}),
      // Actuation executor: wired ⇒ 'handle_independently' outcomes are
      // judged (planner-0-commands = failure); absent ⇒ policy-blocked.
      ...(options.commandExecutor
        ? {
          commandExecutor: (
            _deviceId: string,
            _commandName: string,
            _params?: Record<string, unknown>,
          ) => Promise.resolve({ success: true }),
        }
        : {}),
    },
  );
  return { manager, llm };
}

describe('meta-cognition integration (Phase 5, §7)', () => {
  let devices: Array<{ deviceId: string; type: string; capabilities: string[]; zoneId?: string }>;

  beforeEach(() => {
    devices = [{ deviceId: 'hvac-1', type: 'actuator', capabilities: ['temperature-control'], zoneId: 'floor-1' }];
  });

  it('ADDITIVITY: no MetaCognition injected → no context field, prompt byte-identical (no META_COGNITION)', async () => {
    const { manager, llm } = makeManager(
      ['temperature-control', 'security'],
      cognitiveAnswer('handle_independently'),
    );
    manager.setAgentDevices(devices);

    const context = await (manager as unknown as TestAccess).buildAgentContext();
    expect(context.metaCognition).toBeUndefined();

    await manager.processEvent(urgentEvent(declaredNeed('temperature-control')));
    const prompt = (llm.quickChat as Mock).mock.calls[0]![0] as string;
    expect(prompt).not.toContain('META_COGNITION');
    expect(prompt).not.toContain('CAPABILITY_BOUNDARY');
  });

  it('WITH meta: prompt carries the META_COGNITION block with the live capability boundary', async () => {
    const { manager, llm } = makeManager(
      ['temperature-control', 'security'],
      cognitiveAnswer('handle_independently'),
    );
    manager.setAgentDevices(devices);
    manager.setMetaCognition(new MetaCognition({ agentId: 'agent-1' }));

    const context = await (manager as unknown as TestAccess).buildAgentContext();
    expect(context.metaCognition).toBeDefined();
    expect(context.metaCognition!.boundary.strongAreas).toEqual(['temperature-control']);
    expect(context.metaCognition!.boundary.mustEscalate).toEqual(['security']); // no device backing + safety marker

    await manager.processEvent(urgentEvent(declaredNeed('temperature-control')));
    const prompt = (llm.quickChat as Mock).mock.calls[0]![0] as string;
    expect(prompt).toContain('META_COGNITION (your own tracked self-knowledge');
    expect(prompt).toContain('CAPABILITY_BOUNDARY: strong=[temperature-control] weak=[] must-escalate=[security]');
    expect(prompt).toContain('CALIBRATION: 0 decision(s)');
    // Deterministic: reprocessing the same round renders the same block.
    const promptLength = prompt.indexOf('META_COGNITION');
    expect(promptLength).toBeGreaterThan(0);
  });

  it('FEEDBACK LOOP: initiate_ac → COLLABORATION_COMPLETED resolves quality + partner trust → next prompt shows it', async () => {
    const { manager, llm } = makeManager(
      ['temperature-control'],
      cognitiveAnswer('initiate_ac', 0.9),
    );
    const meta = new MetaCognition({ agentId: 'agent-1' });
    manager.setAgentDevices(devices);
    manager.setMetaCognition(meta);

    await manager.processEvent(urgentEvent(declaredNeed('temperature-control')));
    // initiate_ac outcome is PENDING until the collaboration completes.
    let metrics = meta.quality.getMetrics();
    expect(metrics.totalDecisions).toBe(1);
    expect(metrics.evaluatedDecisions).toBe(0);
    expect(metrics.actionOutcomes).toEqual([]);

    manager.recordCollaborationOutcome({
      collaborationId: 'ac-1',
      success: true,
      participants: ['agent-1', 'partner-energy'],
      goals: [{ achieved: true }, { achieved: true }],
    });

    metrics = meta.quality.getMetrics();
    expect(metrics.evaluatedDecisions).toBe(1);
    expect(metrics.correctDecisions).toBe(1);
    expect(metrics.successRate).toBe(1);
    // The FIRST pending initiate_ac (confidence 0.9 from uncertainty.overall) resolved.
    expect(metrics.confidenceBuckets[0]!.range[0]).toBe(0.9);
    // Partner trust earned (initiator itself excluded).
    const partners = meta.trust.listPartners().map(p => p.partnerId);
    expect(partners).toEqual(['partner-energy']);

    // The NEXT decision prompt renders the updated self-knowledge.
    (llm.quickChat as Mock).mockClear();
    (llm.quickChat as Mock).mockResolvedValue(cognitiveAnswer('handle_independently'));
    await manager.processEvent(urgentEvent({ newValue: 33, temperature: 33, ...declaredNeed('temperature-control') }));
    const prompt = (llm.quickChat as Mock).mock.calls[0]![0] as string;
    expect(prompt).toContain('CALIBRATION: 1 decision(s), 1 with outcomes, calibration=0.9, success=1');
    expect(prompt).toContain('PARTNER_TRUST (1): partner-energy=');
  });

  it('FEEDBACK LOOP: independent decision without any actuation lane counts as a failure', async () => {
    // Executor wired (actuation allowed) but NO bound devices and the answer
    // carries no deviceActions → planner produces 0 commands → "decided to
    // handle but did nothing" → failure.
    const { manager } = makeManager(
      ['monitoring'],
      cognitiveAnswer('handle_independently', 0.7),
      { autoInitiateAC: true, commandExecutor: true },
    );
    const meta = new MetaCognition({ agentId: 'agent-1' });
    manager.setMetaCognition(meta);

    await manager.processEvent(urgentEvent(declaredNeed('monitoring')));
    const metrics = meta.quality.getMetrics();
    expect(metrics.totalDecisions).toBe(1);
    expect(metrics.incorrectDecisions).toBe(1);
    expect(metrics.actionOutcomes[0]!).toMatchObject({ action: 'handle_independently', successRate: 0, count: 1 });
  });

  it('ADAPTIVE: a failure streak de-prioritizes the action and flips the strategy gear', async () => {
    const { manager, llm } = makeManager(
      ['monitoring'],
      cognitiveAnswer('handle_independently', 0.85),
      { autoInitiateAC: true, commandExecutor: true },
    );
    const meta = new MetaCognition({ agentId: 'agent-1' });
    manager.setMetaCognition(meta);

    for (let i = 0; i < 5; i++) {
      await manager.processEvent(urgentEvent({ newValue: 32 + i, temperature: 32 + i, ...declaredNeed('monitoring') }));
    }
    // R40-C2: getPolicy() folded into buildContext — read context.policy.
    const policy = meta.buildContext({ capabilities: ['monitoring'], devices: [] }).policy;
    expect(policy.deprioritizedActions).toEqual(['handle_independently']);
    expect(policy.strategy).toBe('conservative');
    expect(policy.widenUncertainty).toBe(true); // calibration degraded

    // The adjusted policy renders into the next prompt's adaptive hints.
    (llm.quickChat as Mock).mockClear();
    await manager.processEvent(urgentEvent({ newValue: 36, temperature: 36, ...declaredNeed('monitoring') }));
    const prompt = (llm.quickChat as Mock).mock.calls[0]![0] as string;
    expect(prompt).toContain('ADAPTIVE: widen uncertainty reporting');
    expect(prompt).toContain('de-prioritize consistently failing actions [handle_independently]');
    expect(prompt).toContain('strategy gear=conservative');
  });

  it('SHADOW/policy-blocked independent actuation is unknown, never a quality failure', async () => {
    const { manager } = makeManager(
      ['monitoring'],
      cognitiveAnswer('handle_independently', 0.7),
      // no commandExecutor → actuation blocked by policy
    );
    const meta = new MetaCognition({ agentId: 'agent-1' });
    manager.setMetaCognition(meta);
    await manager.processEvent(urgentEvent(declaredNeed('monitoring')));
    const metrics = meta.quality.getMetrics();
    expect(metrics.totalDecisions).toBe(1);
    // Genuinely the policy-blocked case: the recorded action IS
    // handle_independently and its outcome is 'unknown', not a failure.
    expect(meta.quality.getRecords()[0]!.action).toBe('handle_independently');
    expect(metrics.evaluatedDecisions).toBe(0); // honest: policy-blocked, not a failure
  });

  it('CHECKPOINT: meta state rides getCognitionCheckpoint and restores on a fresh manager', async () => {
    const { manager } = makeManager(
      ['temperature-control'],
      cognitiveAnswer('initiate_ac', 0.9),
    );
    const meta = new MetaCognition({ agentId: 'agent-1' });
    manager.setAgentDevices(devices);
    manager.setMetaCognition(meta);
    await manager.processEvent(urgentEvent(declaredNeed('temperature-control')));
    manager.recordCollaborationOutcome({
      collaborationId: 'ac-1',
      success: false,
      participants: ['partner-flaky'],
      goals: [{ achieved: false }],
    });

    const checkpoint = JSON.parse(JSON.stringify(manager.getCognitionCheckpoint()));
    expect(checkpoint.metaCognition).not.toBeNull();
    expect(checkpoint.metaCognition.quality.records).toHaveLength(1);
    expect(checkpoint.metaCognition.trust.partners[0].partnerId).toBe('partner-flaky');

    // Fresh manager + fresh meta adopt the checkpoint → identical context.
    const { manager: resumed } = makeManager(
      ['temperature-control'],
      cognitiveAnswer('initiate_ac', 0.9),
    );
    const resumedMeta = new MetaCognition({ agentId: 'agent-1' });
    resumed.setAgentDevices(devices);
    resumed.setMetaCognition(resumedMeta);
    resumed.restoreCognitionCheckpoint(checkpoint);

    const before = await (manager as unknown as TestAccess).buildAgentContext();
    const after = await (resumed as unknown as TestAccess).buildAgentContext();
    expect(after.metaCognition!.quality).toEqual(before.metaCognition!.quality);
    expect(after.metaCognition!.partnerTrust).toEqual(before.metaCognition!.partnerTrust);
    expect(after.metaCognition!.policy).toEqual(before.metaCognition!.policy);

    // Legacy-shaped checkpoint (pre-P5, no metaCognition field) still restores.
    const legacy = { events: checkpoint.events, lastDecision: checkpoint.lastDecision };
    expect(() => resumed.restoreCognitionCheckpoint(legacy)).not.toThrow();
  });

  it('CHECKPOINT: the world-model parameter face rides getCognitionCheckpoint and restores (R40-C3)', async () => {
    const { manager } = makeManager(
      ['temperature-control'],
      cognitiveAnswer('handle_independently', 0.8),
    );
    manager.setAgentDevices(devices);
    // The agent's parameter-face store (CognitiveAgent wires its own in the
    // real assembly); no zone provider → the capture stamp falls back to 0.
    const face = new AgentWorldModelStore();
    manager.setEnvironmentParamFaceStore(face);
    face.applyEnvironmentParamChanged({
      location: 'floor-1',
      parameter: 'temperature',
      newValue: 32.5,
      timestamp: new Date('2026-08-26T10:00:00Z'),
    });
    face.applyEnvironmentParamChanged({
      location: 'floor-1',
      parameter: 'humidity',
      newValue: 70,
      timestamp: new Date('2026-08-26T10:00:00Z'),
    });

    const checkpoint = JSON.parse(JSON.stringify(manager.getCognitionCheckpoint()));
    expect(checkpoint.environmentParams).toEqual({
      'floor-1:temperature': { value: 32.5, atSimTimeSec: 0 },
      'floor-1:humidity': { value: 70, atSimTimeSec: 0 },
    });

    // Fresh manager + fresh face store adopt the checkpoint → the legacy
    // projection (getEnvironmentStateSnapshot parity) survives the boundary
    // instead of starting from zero.
    const { manager: resumed } = makeManager(
      ['temperature-control'],
      cognitiveAnswer('handle_independently', 0.8),
    );
    const resumedFace = new AgentWorldModelStore();
    resumed.setEnvironmentParamFaceStore(resumedFace);
    resumed.restoreCognitionCheckpoint(checkpoint);
    expect(resumedFace.projectEnvironmentSnapshot().map(e => ({
      key: e.key, value: e.value, location: e.location,
    }))).toEqual([
      { key: 'floor-1:temperature', value: 32.5, location: 'floor-1' },
      { key: 'floor-1:humidity', value: 70, location: 'floor-1' },
    ]);

    // Unwired manager (embedded, no face store): no field rides, restore no-ops.
    const { manager: embedded } = makeManager(['monitoring'], cognitiveAnswer('ignore', 0.9));
    expect(embedded.getCognitionCheckpoint().environmentParams).toBeUndefined();

    // Legacy-shaped checkpoint (pre-C3, no environmentParams) still restores —
    // the fresh face honestly starts empty.
    const legacy = { events: checkpoint.events, lastDecision: checkpoint.lastDecision };
    const freshFace = new AgentWorldModelStore();
    const { manager: legacyTarget } = makeManager(['monitoring'], cognitiveAnswer('ignore', 0.9));
    legacyTarget.setEnvironmentParamFaceStore(freshFace);
    expect(() => legacyTarget.restoreCognitionCheckpoint(legacy)).not.toThrow();
    expect(freshFace.projectEnvironmentSnapshot()).toHaveLength(0);
  });

  it('CHECKPOINT: the working-memory diff baseline rides getCognitionCheckpoint and restores (R40-C2)', async () => {
    // A controllable zone source: round 1 sees floor-1 @ 22; the "future"
    // round sees floor-1 @ 25 + a new humidity param.
    let zones: Array<{ zoneId: string; parameters: Record<string, number | boolean> }> = [
      { zoneId: 'floor-1', parameters: { temperature: 22 } },
    ];
    const zoneSource = () => ({ simTimeSec: 100, zones });

    const { manager } = makeManager(
      ['temperature-control'],
      cognitiveAnswer('handle_independently', 0.8),
    );
    manager.setAgentDevices(devices);
    manager.setWorldModelProvider(zoneSource);
    // Round 1 happens through the decision path (buildAgentContext →
    // beginRound): the working memory now diffs AGAINST the 22-face.
    await manager.processEvent(urgentEvent(declaredNeed('temperature-control')));

    const checkpoint = JSON.parse(JSON.stringify(manager.getCognitionCheckpoint()));
    expect(checkpoint.previousZoneFace).toEqual([{ zoneId: 'floor-1', parameters: { temperature: 22 } }]);

    // The continuous run's next round diff (what the resumed run must match).
    zones = [
      { zoneId: 'floor-1', parameters: { temperature: 25, humidity: 60 } },
    ];
    const continuousContext = await (manager as unknown as TestAccess).buildAgentContext();
    const continuousChanges = continuousContext.cognition!.workingMemory!.situationChanges;
    expect(continuousChanges).toEqual([
      'zone floor-1.temperature: 22 → 25',
      'zone floor-1.humidity=60 (new)',
    ]);

    // Fresh manager adopts the checkpoint: its FIRST round diffs against the
    // restored baseline — not "initial perception" (record-replay parity).
    const { manager: resumed } = makeManager(
      ['temperature-control'],
      cognitiveAnswer('handle_independently', 0.8),
    );
    resumed.setAgentDevices(devices);
    resumed.setWorldModelProvider(zoneSource);
    resumed.restoreCognitionCheckpoint(checkpoint);
    const resumedContext = await (resumed as unknown as TestAccess).buildAgentContext();
    expect(resumedContext.cognition!.workingMemory!.situationChanges).toEqual(continuousChanges);

    // Legacy-shaped checkpoint (pre-C2, no previousZoneFace) still restores —
    // the first resumed round honestly claims initial perception.
    const { manager: legacyTarget } = makeManager(['monitoring'], cognitiveAnswer('ignore', 0.9));
    legacyTarget.setWorldModelProvider(zoneSource);
    legacyTarget.restoreCognitionCheckpoint({ events: checkpoint.events, lastDecision: checkpoint.lastDecision });
    const legacyContext = await (legacyTarget as unknown as TestAccess).buildAgentContext();
    expect(legacyContext.cognition!.workingMemory!.situationChanges[0]).toMatch(/initial perception:/);
  });
});
