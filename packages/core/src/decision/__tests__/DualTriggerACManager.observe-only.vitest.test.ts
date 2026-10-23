/**
 * @vitest-environment node
 *
 * FEAT-09 (dorm-life D8): audience ≠ initiation eligibility. An audience
 * member whose own capability surface (declared ∪ bound-device) has ZERO
 * intersection with the event's requirements (declared face when the author
 * declared requiredCapabilities, inferred table otherwise — the same
 * verdict face ruleOnlyVerdict / the ground-truth calculator use) is
 * observe-only: it sees the event but never enters the initiate evaluation
 * — no assessment, no decision record, one observeOnly stat. The incidents:
 * a security officer with zero power-domain capability signed grid-load
 * contracts as a consumer (职能错位), and a duty officer managing no zone
 * ran an LLM decision on every event (LLM queue pressure).
 *
 * Pins:
 *  1. zero-intersection audience → assessor never called, no decision
 *     recorded, observeOnly counted, result path 'deferred';
 *  2. intersecting audiences (declared OR bound-device surface) behave
 *     exactly as before;
 *  3. an event with NO requirements gates nobody;
 *  4. coordinator-role agents are exempt (dispatchers, not executors);
 *  5. the pure verdict (isZeroIntersectionAudience) — matching semantics.
 */

import { describe, it, expect, vi } from 'vitest';
import { DualTriggerACManager } from '../DualTriggerACManager.js';
import { isZeroIntersectionAudience } from '../assessor-passthrough.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { SystemEvent } from '../../events/EventManager.js';
import type { ACNecessityAssessment } from '../ACNecessityAssessor.js';
import type { SpatialClusterSummary } from '../../events/SpatialTemporalClusterEngine.js';

const ZONE = 'dorm-1';

function createManager(
  capabilities: string[],
  configOverrides: Record<string, unknown> = {},
): { manager: DualTriggerACManager; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn();
  const mockLLMClient = { chat, quickChat: vi.fn() } as unknown as LLMClient;
  const mockEnvironment = {
    listDevices: vi.fn().mockReturnValue([]),
    listAgents: vi.fn().mockReturnValue([]),
    getParameters: vi.fn().mockReturnValue({}),
    eventManager: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() },
    services: new Map(),
  } as unknown as EnvironmentCenter;

  const manager = new DualTriggerACManager(
    'agent-observe',
    'ObserveTestAgent',
    capabilities,
    mockLLMClient,
    mockEnvironment,
    vi.fn(),
    {
      enableLayer1: true,
      enableLayer2: true,
      autoInitiateAC: false,
      disableSpatiotemporal: true,
      ...configOverrides,
    },
  );
  return { manager, chat };
}

/** Spy on the assessor so a non-gated event yields a deterministic defer. */
function mockAssessorDefer(manager: DualTriggerACManager): ReturnType<typeof vi.fn> {
  const access = manager as unknown as {
    acNecessityAssessor: { assess: (s: unknown, c: unknown) => Promise<ACNecessityAssessment> } | null;
  };
  if (!access.acNecessityAssessor) throw new Error('Assessor not initialized — enable Layer 2');
  const deferAssessment = {
    decision: 'defer',
    decisionSource: 'llm',
    llmAssessment: {
      needsCollaboration: false,
      reasoning: 'mocked assessment',
      urgency: 'medium',
      suggestedPartnerTypes: [],
      requiredCapabilities: [],
      confidence: 0.5,
      estimatedDuration: 0,
      potentialRisks: [],
    },
  } as ACNecessityAssessment;
  const spy = vi.fn().mockResolvedValue(deferAssessment);
  access.acNecessityAssessor.assess = spy;
  return spy;
}

function createEvent(payload: Record<string, unknown>): SystemEvent {
  return {
    id: `event-${Date.now()}-${Math.random()}`,
    type: 'environment.param_changed',
    source: 'sensor-1',
    timestamp: new Date(),
    payload: { zoneId: ZONE, ...payload },
    priority: 'normal',
  };
}

describe('DualTriggerACManager — FEAT-09 observe-only audience gate', () => {
  it('zero-intersection audience: no assessment, no decision record, observeOnly counted', async () => {
    const { manager, chat } = createManager(['security-patrol', 'surveillance']);
    const assessSpy = mockAssessorDefer(manager);
    const recorded: ACNecessityAssessment[] = [];
    manager.setAssessmentCallback(assessment => { recorded.push(assessment); });

    // A declared power-domain event — the security officer has NOTHING for it.
    const result = await manager.processEvent(createEvent({
      severity: 'high',
      eventType: 'power-surge',
      parameter: 'power',
      newValue: 9000,
      requiredCapabilities: ['load-management'],
    }));

    expect(result.path).toBe('deferred');
    expect(assessSpy).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
    expect(manager.getStats().observeOnly).toBe(1);
    // Not a decision — the defer tally must NOT move.
    expect(manager.getStats().layer2DecisionDistribution.defer ?? 0).toBe(0);
  });

  it('intersecting audience (declared capability): assessment runs as before', async () => {
    const { manager } = createManager(['load-management', 'monitoring']);
    const assessSpy = mockAssessorDefer(manager);

    await manager.processEvent(createEvent({
      severity: 'high',
      eventType: 'power-surge',
      requiredCapabilities: ['load-management'],
    }));

    expect(assessSpy).toHaveBeenCalledTimes(1);
    expect(manager.getStats().observeOnly).toBe(0);
  });

  it('intersecting audience via the BOUND-DEVICE surface (declared list thin): assessment runs', async () => {
    const { manager } = createManager(['security-patrol']);
    manager.setAgentDevices([
      { deviceId: 'pile-1', type: 'actuator', capabilities: ['load-management'], zoneId: ZONE },
    ]);
    const assessSpy = mockAssessorDefer(manager);

    await manager.processEvent(createEvent({
      severity: 'high',
      eventType: 'power-surge',
      requiredCapabilities: ['load-management'],
    }));

    expect(assessSpy).toHaveBeenCalledTimes(1);
    expect(manager.getStats().observeOnly).toBe(0);
  });

  it('an event with NO requirements gates nobody', async () => {
    const { manager } = createManager(['security-patrol']);
    const assessSpy = mockAssessorDefer(manager);

    // Non-urgent custom heartbeat: nothing declared, nothing inferred.
    await manager.processEvent(createEvent({ eventType: 'custom-heartbeat' }));

    expect(assessSpy).toHaveBeenCalledTimes(1);
    expect(manager.getStats().observeOnly).toBe(0);
  });

  it('coordinator-role agents are exempt (dispatchers, not executors)', async () => {
    const { manager } = createManager(['security-patrol'], { decisionRole: 'coordinator' });
    const assessSpy = mockAssessorDefer(manager);

    await manager.processEvent(createEvent({
      severity: 'high',
      eventType: 'power-surge',
      requiredCapabilities: ['load-management'],
    }));

    expect(assessSpy).toHaveBeenCalledTimes(1);
    expect(manager.getStats().observeOnly).toBe(0);
  });

  it('exemption 2: direct actuator coverage of the event zone — the LLM lane decides (Type C / escalation stay reachable)', async () => {
    // The zone's own actuator agent lacks the declared capability
    // ('fire-suppression') — zero intersection, but gating it would silence
    // delegation AND the R40-A3 escalation channel for a high-severity
    // event in its own zone (EngineRuntime.escalation regression).
    const { manager } = createManager(['temperature-control'], { actuatorZoneIds: [ZONE] });
    manager.setAgentDevices([
      { deviceId: 'hvac-1', type: 'actuator', capabilities: ['temperature-control'], zoneId: ZONE },
    ]);
    const assessSpy = mockAssessorDefer(manager);

    await manager.processEvent(createEvent({
      severity: 'high',
      eventType: 'temperature-spike',
      parameter: 'temperature',
      newValue: 46,
      requiredCapabilities: ['fire-suppression'],
    }));

    expect(assessSpy).toHaveBeenCalledTimes(1);
    expect(manager.getStats().observeOnly).toBe(0);
  });

  it('exemption 3: a sensor-only agent on an UNDECLARED event keeps the sensor-notify pattern (STEP 0a governs)', async () => {
    // Detection IS the sensor-only agent's contribution (formal model
    // Def. 6): with nothing declared, the zero-intersection gate must not
    // silence it (ac-handshake regression). No actuator zones, no devices
    // with actuators → sensor-only.
    const { manager } = createManager(['temperature-monitoring']);
    manager.setAgentDevices([
      { deviceId: 'temp-1', type: 'sensor', capabilities: ['temperature-reading'], zoneId: ZONE },
    ]);
    const assessSpy = mockAssessorDefer(manager);

    await manager.processEvent(createEvent({
      severity: 'high',
      eventType: 'heat-wave',
      parameter: 'temperature',
      newValue: 39,
    }));

    expect(assessSpy).toHaveBeenCalledTimes(1);
    expect(manager.getStats().observeOnly).toBe(0);
  });
});

describe('isZeroIntersectionAudience (pure verdict)', () => {
  const summary = (details: Record<string, unknown>, eventType = 'custom'): SpatialClusterSummary => ({
    clusterId: 'c-1',
    region: { id: ZONE, center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
    timeWindow: new Date().toISOString(),
    significance: 'medium',
    summary: 'test',
    findings: [{ eventType, count: 1, trend: 'stable', anomaly: false, details }],
    recommendation: 'evaluate_with_llm',
  });

  it('declared requirements, zero intersection → true', () => {
    expect(isZeroIntersectionAudience(
      summary({ requiredCapabilities: ['load-management'] }),
      ['security-patrol', 'surveillance'],
    )).toBe(true);
  });

  it('declared requirements, exact match → false', () => {
    expect(isZeroIntersectionAudience(
      summary({ requiredCapabilities: ['load-management'] }),
      ['load-management'],
    )).toBe(false);
  });

  it('declared requirements, substring match → false (capabilityMatches semantics)', () => {
    expect(isZeroIntersectionAudience(
      summary({ requiredCapabilities: ['load-management'] }),
      ['grid-load-management'],
    )).toBe(false);
  });

  it('nothing declared → inferred face applies (smoke event)', () => {
    const smoke = summary({}, 'smoke-detected');
    expect(isZeroIntersectionAudience(smoke, ['security-patrol'])).toBe(true);
    expect(isZeroIntersectionAudience(smoke, ['ventilation'])).toBe(false);
  });

  it('no requirements at all → false (gates nobody)', () => {
    expect(isZeroIntersectionAudience(summary({}, 'custom-heartbeat'), ['security-patrol'])).toBe(false);
  });

  it('the declared face WINS over the inferred anomaly padding', () => {
    // An anomalous power event infers generic 'monitoring'/'emergency-response'
    // needs that would substring-match the officer's 'security-monitoring' —
    // the declared face (load-management) is the verdict, so the gate fires.
    const declaredAnomaly: SpatialClusterSummary = {
      ...summary({ requiredCapabilities: ['load-management'], eventType: 'power-surge' }, 'power-surge'),
      findings: [{ eventType: 'power-surge', count: 1, trend: 'increasing', anomaly: true, details: { requiredCapabilities: ['load-management'], eventType: 'power-surge' } }],
    };
    expect(isZeroIntersectionAudience(declaredAnomaly, ['security-monitoring'])).toBe(true);
  });
});
