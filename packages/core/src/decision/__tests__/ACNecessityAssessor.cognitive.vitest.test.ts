/**
 * Phase 1 integration: the assessor's LLM path with the CognitiveDecision
 * contract (cognitive architecture §14.1).
 *
 * Covers the full decision path with a scripted LLM:
 * - a full cognitive JSON answer → CognitiveDecision rides the assessment,
 *   legacy fields (llmDecision / needsCollaboration / reasoning) DERIVED,
 *   decisionSubSource 'llm-json';
 * - escalation ladder intact: legacy binary JSON answers still parse
 *   (backward compat), prose falls back to the FSM scanner;
 * - Mechanism B: invoke_flow actions surface invokeFlow;
 * - R35 label-alignment: EVENT_NEEDS renders the DECLARED
 *   requiredCapabilities (never the inferred table); "none declared" is
 *   explicit when the event states no requirements;
 * - the big-model call pins temperature 0 and the schema cap.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ACNecessityAssessor } from '../ACNecessityAssessor.js';
import { bridgeCognitiveDeviceActions } from '../../flows/delegate-recommendation-bridge.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { SpatialClusterSummary, AgentContext } from '../ACNecessityAssessor.js';

function clusterForLLM(overrides: Partial<SpatialClusterSummary> = {}): SpatialClusterSummary {
  return {
    clusterId: 'cluster-1',
    region: { id: 'region-1', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
    timeWindow: '2024-03-15T10:00:00Z - 2024-03-15T10:05:00Z',
    significance: 'medium',
    summary: 'Generic event requiring LLM evaluation for decision making',
    findings: [{
      eventType: 'odd-event',
      count: 1,
      trend: 'stable',
      anomaly: false,
      details: { requiredCapabilities: ['cooling'] }, // declared → gap → LLM path
    }],
    recommendation: 'evaluate_with_llm',
    ...overrides,
  };
}

function agentCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    agentId: 'agent-1',
    agentName: 'AgentOne',
    capabilities: ['monitoring'], // lacks 'cooling' → Type A preCheck does not fire
    availableResources: [],
    currentWorkload: 'idle',
    recentCollaborations: [],
    currentCollaborations: 0,
    actuatorZoneIds: ['region-1'],
    ...overrides,
  };
}

/**
 * Reaches the LLM with the DECLARED requirement ('cooling') SATISFIED, so an
 * independent answer survives makeDecision's T-041 declared-gap fork: the
 * agent is sensor-only (empty actuator zones) but only 1-of-1 capability
 * match → below the ≥2 domain-relevance bar → the sensor-only preCheck falls
 * through to the LLM.
 */
function satisfiedCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return agentCtx({ capabilities: ['cooling', 'monitoring'], actuatorZoneIds: [], ...overrides });
}

const cognitiveAnswer = JSON.stringify({
  situation: {
    type: 'anomaly',
    severity: 3,
    affectedZones: ['region-1'],
    rootCauseHypothesis: 'afternoon sun load',
    confidence: 0.8,
  },
  goals: [{ goal: 'maintain_comfort', priority: 1 }],
  actionPlan: {
    primary: {
      action: 'handle_independently',
      reasoning: 'own devices cover this',
      deviceActions: [{ deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 24 } }],
    },
  },
  explanation: {
    summary: 'Own HVAC covers the zone; no partner needed.',
    factors: [{ name: 'comfort', weight: 0.8 }],
  },
  collaboration: { needed: false },
  uncertainty: { overall: 0.2, dataQuality: 0.9, riskFactors: [] },
});

describe('ACNecessityAssessor — cognitive decision path (Phase 1)', () => {
  let assessor: ACNecessityAssessor;
  let mockLLMClient: LLMClient;

  beforeEach(() => {
    mockLLMClient = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
    assessor = new ACNecessityAssessor({}, mockLLMClient);
  });

  it('a full cognitive JSON answer produces the CognitiveDecision + derived legacy fields', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveAnswer);

    const result = await assessor.assess(clusterForLLM(), satisfiedCtx());

    expect(result.decisionSource).toBe('llm');
    expect(result.llmAssessment.decisionSubSource).toBe('llm-json');
    // The full structured decision rides the assessment.
    expect(result.cognitiveDecision).toBeDefined();
    expect(result.cognitiveDecision!.situation.type).toBe('anomaly');
    expect(result.cognitiveDecision!.situation.severity).toBe(3);
    expect(result.cognitiveDecision!.actionPlan.primary.action).toBe('handle_independently');
    expect(result.cognitiveDecision!.actionPlan.primary.deviceActions).toEqual([
      { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 24 } },
    ]);
    expect(result.cognitiveDecision!.explanation.summary).toBe('Own HVAC covers the zone; no partner needed.');
    expect(result.cognitiveDecision!.collaboration.needed).toBe(false);
    expect(result.cognitiveDecision!.uncertainty.overall).toBe(0.2);
    // Legacy fields are the DERIVED view (deriveLegacyDecision semantics).
    expect(result.llmAssessment.llmDecision).toBe('handle_independently');
    expect(result.llmAssessment.needsCollaboration).toBe(false);
    expect(result.llmAssessment.reasoning).toBe('Own HVAC covers the zone; no partner needed.');
    expect(result.decision).toBe('handle_independently');
  });

  it('an initiate_ac cognitive answer derives initiate_ac end-to-end', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
      situation: { type: 'emergency', severity: 4, confidence: 0.9 },
      actionPlan: { primary: {
        action: 'initiate_ac',
        reasoning: 'no ventilation capability',
        collaboration: { partnerCapabilities: ['ventilation'] },
      } },
      uncertainty: { overall: 0.4 },
    }));

    const result = await assessor.assess(clusterForLLM(), agentCtx());

    expect(result.decision).toBe('initiate_ac');
    expect(result.cognitiveDecision!.collaboration.needed).toBe(true);
    expect(result.llmAssessment.needsCollaboration).toBe(true);
  });

  it('an escalate cognitive answer maps onto the legacy defer (Phase-1 mapping)', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
      // decision-v1 (F0-2): situation/actionPlan/uncertainty are the required
      // blocks — guided decoding always emits them, so lane fixtures must too.
      situation: { type: 'anomaly', severity: 3, confidence: 0.6 },
      actionPlan: { primary: { action: 'escalate', reasoning: 'beyond my scope' } },
      uncertainty: { overall: 0.5 },
    }));

    const result = await assessor.assess(clusterForLLM(), agentCtx());

    expect(result.llmAssessment.llmDecision).toBe('defer');
    expect(result.decision).toBe('defer');
    expect(result.cognitiveDecision!.actionPlan.primary.action).toBe('escalate');
  });

  it('an invoke_flow action surfaces invokeFlow (Mechanism B rides the actionPlan)', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
      // decision-v1 (F0-2): required blocks present, as guided decoding guarantees.
      situation: { type: 'anomaly', severity: 3, confidence: 0.8 },
      actionPlan: { primary: {
        action: 'invoke_flow',
        reasoning: 'standard cool-down procedure fits',
        flowId: 'flow-cool-down',
        flowParams: { targetTemp: 22 },
      } },
      uncertainty: { overall: 0.3 },
    }));

    const result = await assessor.assess(clusterForLLM(), satisfiedCtx());

    expect(result.invokeFlow).toEqual({ flowId: 'flow-cool-down', params: { targetTemp: 22 } });
    expect(result.decision).toBe('handle_independently');
  });

  it('BACKWARD COMPAT: legacy binary JSON answers still parse (llmDecision preserved)', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(
      JSON.stringify({ decision: 'collaborate', reasoning: 'need a partner' }),
    );

    const result = await assessor.assess(clusterForLLM(), agentCtx());

    expect(result.decision).toBe('initiate_ac');
    expect(result.llmAssessment.llmDecision).toBe('initiate_ac');
    expect(result.llmAssessment.decisionSubSource).toBe('llm-json');
    expect(result.cognitiveDecision).toBeUndefined(); // binary answers carry no schema
  });

  it('BACKWARD COMPAT: prose answers fall back to the FSM scanner', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue('DECISION: independent\nMy devices cover it.');

    const result = await assessor.assess(clusterForLLM(), agentCtx());

    expect(result.llmAssessment.decisionSubSource).toBe('llm-fsm');
    expect(result.llmAssessment.llmDecision).toBe('handle_independently');
    expect(result.cognitiveDecision).toBeUndefined();
  });

  it('unparseable answers keep the safety-first default (initiate_ac)', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue('Hmm, lovely weather today.');

    const result = await assessor.assess(clusterForLLM(), agentCtx());

    expect(result.decision).toBe('initiate_ac');
    expect(result.llmAssessment.decisionSubSource).toBe('llm-fsm');
  });

  it('R35: EVENT_NEEDS renders the DECLARED requiredCapabilities, not the inferred table', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveAnswer);
    const declared = clusterForLLM({
      findings: [{
        eventType: 'smoke-detected',
        count: 1,
        trend: 'increasing',
        anomaly: true,
        // declared face: air-purification (the inferred table would instead
        // demand emergency-response/monitoring for any anomalous non-temp event)
        details: { requiredCapabilities: ['air-purification'], parameter: 'pm25', newValue: 180 },
      }],
      summary: 'Event smoke-detected, parameter=pm25, newValue=180',
    });

    await assessor.assess(declared, agentCtx());

    const prompt = (mockLLMClient.quickChat as Mock).mock.calls[0]![0] as string;
    // The EVENT_NEEDS section spans the multi-line untrusted block.
    const start = prompt.indexOf('EVENT_NEEDS:');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = prompt.indexOf('</untrusted>', start);
    const needsSection = prompt.slice(start, end >= 0 ? end + '</untrusted>'.length : undefined);
    expect(needsSection).toContain('air-purification');
    // The inferred table's keyword demands must NOT leak into the requirement line.
    expect(needsSection).not.toContain('emergency-response');
    expect(needsSection).not.toContain('monitoring');
  });

  it('R35: events declaring nothing render an explicit "none declared" (Gap=∅, label-aligned)', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveAnswer);
    const undeclared = clusterForLLM({
      findings: [{
        eventType: 'footfall-spike',
        count: 1,
        trend: 'increasing',
        anomaly: true,
        details: { parameter: 'motion-count', newValue: 180 }, // NO requiredCapabilities
      }],
      summary: 'Event footfall-spike from engine-runtime:evt-42, parameter=motion-count, newValue=180',
    });

    await assessor.assess(undeclared, agentCtx());

    const prompt = (mockLLMClient.quickChat as Mock).mock.calls[0]![0] as string;
    const needsLine = prompt.split('\n').find(line => line.startsWith('EVENT_NEEDS'))!;
    expect(needsLine).toContain('none declared');
  });

  it('pins temperature 0 and the cognitive maxTokens on the big-model call', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveAnswer);
    await assessor.assess(clusterForLLM(), agentCtx());

    const call = (mockLLMClient.quickChat as Mock).mock.calls[0]!;
    // Qwen3 thinking suppression rides the decision-lane options (guided
    // JSON output — the think draft is pure latency).
    expect(call[4]).toEqual({
      maxTokens: 1024,
      temperature: 0,
      chatTemplateKwargs: { enable_thinking: false },
    });
  });

  it('the system prompt asks for the cognitive schema (not the binary shape)', async () => {
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveAnswer);
    await assessor.assess(clusterForLLM(), agentCtx());

    const systemPrompt = (mockLLMClient.quickChat as Mock).mock.calls[0]![1] as string;
    expect(systemPrompt).toContain('"actionPlan"');
    expect(systemPrompt).toContain('"situation"');
    expect(systemPrompt).not.toContain('"decision": "collaborate"');
  });

  // =========================================================================
  // R37-F2: the own-device inventory (MY_DEVICES) — the fix that makes the
  // structured deviceActions lane answerable. Before F2 the prompt never
  // listed the agent's bound devices, so the model could not name a
  // bridge-valid deviceId (6/6 live LLM decisions emitted no deviceActions).
  // =========================================================================
  describe('R37-F2: own-device inventory (MY_DEVICES)', () => {
    it('lists bound actuation devices with exact ids, type, zone, key state and commands', async () => {
      (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveAnswer);
      const ctx = satisfiedCtx({
        availableResources: [
          {
            deviceId: 'hvac-1',
            type: 'hvac',
            capabilities: ['set-temperature', 'set-mode', 'temperature-reading'],
            currentState: { temperature: 26.5, power: 60, on: true, history: [1, 2, 3] },
            location: 'zone-server',
            isOnline: true,
          },
        ],
      });

      await assessor.assess(clusterForLLM(), ctx);

      const prompt = (mockLLMClient.quickChat as Mock).mock.calls[0]![0] as string;
      const start = prompt.indexOf('MY_DEVICES');
      expect(start).toBeGreaterThanOrEqual(0);
      const end = prompt.indexOf('</untrusted>', start);
      const section = prompt.slice(start, end + '</untrusted>'.length);
      // The inventory rides the S1 sanitizer like every other data block.
      expect(section).toContain('<untrusted name="own-devices"');
      // Exact device id (what the bridge validates by), type and zone.
      expect(section).toContain('"deviceId": "hvac-1"');
      expect(section).toContain('"type": "hvac"');
      expect(section).toContain('"zone": "zone-server"');
      // Key current state: primitives only (history arrays dropped).
      expect(section).toContain('"temperature": 26.5');
      expect(section).toContain('"on": true');
      expect(section).not.toContain('history');
      // Commands = the actuation surface (sensor-style caps excluded).
      expect(section).toContain('"commands"');
      expect(section).toContain('set-temperature');
      expect(section).toContain('set-mode');
      expect(section).not.toContain('temperature-reading');
    });

    it('marks offline devices and derives zone from structured locations', async () => {
      (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveAnswer);
      const ctx = satisfiedCtx({
        availableResources: [
          {
            deviceId: 'ups-1',
            type: 'ups',
            capabilities: ['set-charging'],
            currentState: { charge: 0.8 },
            location: { path: 'zone-warehouse' },
            isOnline: false,
          },
        ],
      });

      await assessor.assess(clusterForLLM(), ctx);

      const prompt = (mockLLMClient.quickChat as Mock).mock.calls[0]![0] as string;
      const section = prompt.slice(
        prompt.indexOf('MY_DEVICES'),
        prompt.indexOf('</untrusted>', prompt.indexOf('MY_DEVICES')) + '</untrusted>'.length,
      );
      expect(section).toContain('"zone": "zone-warehouse"');
      expect(section).toContain('"offline": true');
      expect(section).toContain('set-charging');
    });

    it('emits NO inventory block when the agent has no actuation-capable devices (prompt unchanged)', async () => {
      (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveAnswer);
      // Sensor-only surface: read-style capabilities only → no commands → no block.
      const ctx = satisfiedCtx({
        availableResources: [
          { deviceId: 'thermo-1', type: 'sensor', capabilities: ['temperature-reading'], currentState: { temperature: 26 } },
        ],
      });

      await assessor.assess(clusterForLLM(), ctx);

      const prompt = (mockLLMClient.quickChat as Mock).mock.calls[0]![0] as string;
      expect(prompt).not.toContain('MY_DEVICES');
      // And the empty-resources fixture stays byte-compatible (no stray line).
      await assessor.assess(clusterForLLM(), satisfiedCtx());
      const emptyPrompt = (mockLLMClient.quickChat as Mock).mock.calls[1]![0] as string;
      expect(emptyPrompt).not.toContain('MY_DEVICES');
      expect(emptyPrompt).not.toContain('own-devices');
    });

    // BUG-04: detect-* is read-only in the shared predicate now, so a smoke
    // detector's declared capability must never reach the LLM as an
    // actuation command (it used to — then died "no handler / no effect").
    it('never lists detect-smoke as an executable command (BUG-04)', async () => {
      (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveAnswer);
      const ctx = satisfiedCtx({
        availableResources: [
          {
            deviceId: 'panel-1',
            type: 'control-panel',
            capabilities: ['detect-smoke', 'emergency-broadcast', 'turn-off'],
            currentState: { on: true },
            location: 'region-1',
          },
        ],
      });

      await assessor.assess(clusterForLLM(), ctx);

      const prompt = (mockLLMClient.quickChat as Mock).mock.calls[0]![0] as string;
      const start = prompt.indexOf('MY_DEVICES');
      expect(start).toBeGreaterThanOrEqual(0);
      const section = prompt.slice(start, prompt.indexOf('</untrusted>', start));
      expect(section).toContain('emergency-broadcast');
      expect(section).toContain('turn-off');
      expect(section).not.toContain('detect-smoke');
    });

    it('a pure detect-* sensor device drops out of MY_DEVICES entirely (nothing to command)', async () => {
      (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveAnswer);
      const ctx = satisfiedCtx({
        availableResources: [
          { deviceId: 'smoke-1', type: 'smoke-detector', capabilities: ['detect-smoke'], currentState: { smoke: false } },
        ],
      });

      await assessor.assess(clusterForLLM(), ctx);

      const prompt = (mockLLMClient.quickChat as Mock).mock.calls[0]![0] as string;
      expect(prompt).not.toContain('MY_DEVICES');
    });

    it('the inventory ids are the ids the cognitive deviceActions bridge accepts', async () => {
      // End-to-end contract of F2: a deviceActions answer naming the
      // inventory's REAL device id + command parses, rides the assessment,
      // and passes bridgeCognitiveDeviceActions against the same budget the
      // DualTriggerACManager builds (own devices / their capabilities).
      (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveAnswer);
      const ctx = satisfiedCtx({
        availableResources: [
          {
            deviceId: 'hvac-1',
            type: 'hvac',
            capabilities: ['set-temperature'],
            currentState: { targetTemperature: 22 },
            location: 'zone-server',
          },
        ],
      });

      const result = await assessor.assess(clusterForLLM(), ctx);

      const modelActions = result.cognitiveDecision!.actionPlan.primary.deviceActions!;
      expect(modelActions).toEqual([
        { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 24 } },
      ]);
      // The bridge budget mirrors DualTriggerACManager.executeCognitiveDeviceActions.
      const bridged = bridgeCognitiveDeviceActions({
        deviceActions: modelActions,
        budget: {
          maxCommands: 8,
          deviceIds: ctx.availableResources.map(d => d.deviceId),
          allowedCommands: [...new Set(ctx.availableResources.flatMap(d => d.capabilities.map(c => c.toLowerCase())))],
        },
      });
      expect(bridged.proposals).toEqual([
        { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 24 } },
      ]);
      expect(bridged.rejected).toEqual([]);
    });
  });
});
