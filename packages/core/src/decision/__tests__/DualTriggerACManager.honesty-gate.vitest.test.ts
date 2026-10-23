/**
 * @vitest-environment node
 *
 * BUG-01 honesty gate — a precheck Type-A short-circuit
 * (reasoningCode 'precheck.independent') whose planner produces ZERO device
 * commands AND whose agent has NO device backing for the event is a FALSE
 * positive (misclassified read-only device role, or a declared-but-unbacked
 * capability). The gate converts it to a Type-E initiate_ac BEFORE the
 * decision is recorded/counted, so a zero-command "independent" decision
 * no longer enters the handledIndependently success tally and no longer
 * suppresses the collaboration that could actually act. Legitimate
 * zero-command cases (deadband, backed requirements) are untouched.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { DualTriggerACManager } from '../DualTriggerACManager.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { SystemEvent } from '../../events/EventManager.js';
import type { ACNecessityAssessment } from '../ACNecessityAssessor.js';
import type { PlannerDeviceInfo } from '../rule-actuation-planner.js';

const ZONE = 'test-region';

/** A precheck Type-A assessment (the short-circuit shape the gate inspects). */
function precheckTypeAAssessment(details: Record<string, unknown>): ACNecessityAssessment {
  return {
    clusterSummary: {
      clusterId: 'test-cluster',
      region: { id: ZONE, center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
      timeWindow: new Date().toISOString(),
      significance: 'medium',
      summary: 'Test cluster summary',
      findings: [
        {
          eventType: String(details.eventType ?? 'custom'),
          count: 1,
          trend: 'stable',
          anomaly: true,
          details,
        },
      ],
      recommendation: 'evaluate_with_llm',
    },
    agentContext: {
      agentId: 'test-agent',
      agentName: 'TestAgent',
      capabilities: ['security-patrol'],
      availableResources: [],
      currentWorkload: 'idle',
      recentCollaborations: [],
      currentCollaborations: 0,
    },
    llmAssessment: {
      needsCollaboration: false,
      reasoning: `Agent has direct actuator coverage in ${ZONE} and all required capabilities.`,
      reasoningCode: 'precheck.independent',
      reasoningParams: { zone: ZONE },
      urgency: 'medium',
      suggestedPartnerTypes: [],
      requiredCapabilities: [],
      confidence: 0.9,
      estimatedDuration: 1000,
      potentialRisks: [],
    },
    decision: 'handle_independently',
    decisionSource: 'precheck',
    timestamp: new Date(),
  } as ACNecessityAssessment;
}

function createManager(configOverrides: Record<string, unknown> = {}): {
  manager: DualTriggerACManager;
  mockEnvironment: EnvironmentCenter;
  commandExecutor: Mock;
} {
  const mockLLMClient = {
    chat: vi.fn(),
    quickChat: vi.fn(),
  } as unknown as LLMClient;

  const mockEnvironment = {
    listDevices: vi.fn().mockReturnValue([]),
    listAgents: vi.fn().mockReturnValue([]),
    getParameters: vi.fn().mockReturnValue({}),
    discoverAgents: vi.fn().mockResolvedValue([]),
    eventManager: {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      publish: vi.fn(),
    },
    services: new Map(),
  } as unknown as EnvironmentCenter;

  const commandExecutor = vi.fn().mockResolvedValue({ success: true });

  const manager = new DualTriggerACManager(
    'test-agent-gate',
    'GateTestAgent',
    ['security-patrol'],
    mockLLMClient,
    mockEnvironment,
    vi.fn(),
    {
      enableLayer1: true,
      enableLayer2: true,
      // Actuation must be POSSIBLE for the gate to run (autoInitiateAC +
      // a wired executor); decision-only eval runs keep the note instead.
      autoInitiateAC: true,
      disableSpatiotemporal: true,
      commandExecutor,
      ...configOverrides,
    }
  );
  return { manager, mockEnvironment, commandExecutor };
}

/** Point the assessor stub at a fixed assessment; return the assessment for later inspection. */
function mockAssessor(manager: DualTriggerACManager, assessment: ACNecessityAssessment): void {
  const access = manager as unknown as {
    acNecessityAssessor: { assess: (s: unknown, c: unknown) => Promise<ACNecessityAssessment> } | null;
  };
  if (!access.acNecessityAssessor) throw new Error('Assessor not initialized — enable Layer 2');
  vi.spyOn(access.acNecessityAssessor, 'assess').mockResolvedValue(assessment);
}

function createEvent(): SystemEvent {
  return {
    id: `event-${Date.now()}-${Math.random()}`,
    type: 'generic.event',
    source: 'device-1',
    timestamp: new Date(),
    payload: {},
    priority: 'normal',
  };
}

describe('DualTriggerACManager — BUG-01 precheck honesty gate', () => {
  it('false Type-A (0 commands, sensor-only devices) converts to Type-E initiate_ac and is NOT counted as handled independently', async () => {
    const { manager } = createManager();
    const camera: PlannerDeviceInfo = {
      deviceId: 'cam-1',
      type: 'camera',
      capabilities: ['read-occupancy', 'detect-smoke'],
      zoneId: ZONE,
    };
    manager.setAgentDevices([camera]);
    const assessment = precheckTypeAAssessment({
      eventType: 'security-patrol',
      requiredCapabilities: ['security-patrol'],
    });
    mockAssessor(manager, assessment);

    await manager.processEvent(createEvent());

    expect(assessment.decision).toBe('initiate_ac');
    expect(assessment.llmAssessment.reasoningCode).toBe('precheck.no_actuation_delegate');
    expect(assessment.llmAssessment.reasoning).toContain('[honesty-gate:');
    const stats = manager.getStats();
    expect(stats.handledIndependently).toBe(0);
    expect(stats.layer2DecisionDistribution.initiate_ac).toBe(1);
    expect(stats.layer2DecisionDistribution.handle_independently ?? 0).toBe(0);
  });

  it('legitimate zero-command Type-A (temperature deadband with a backed climate device) stays handle_independently', async () => {
    const { manager } = createManager();
    const hvac: PlannerDeviceInfo = {
      deviceId: 'hvac-1',
      type: 'hvac',
      capabilities: ['temperature-control'],
      zoneId: ZONE,
    };
    manager.setAgentDevices([hvac]);
    const assessment = precheckTypeAAssessment({
      eventType: 'temperature-anomaly',
      parameter: 'temperature',
      newValue: 24.3, // within ±1°C of the 24°C target — honest no-op
      requiredCapabilities: [],
    });
    mockAssessor(manager, assessment);

    await manager.processEvent(createEvent());

    expect(assessment.decision).toBe('handle_independently');
    const stats = manager.getStats();
    expect(stats.handledIndependently).toBe(1);
    expect(assessment.llmAssessment.reasoning).toContain('[actuation: none');
  });

  it('a backed requirement (own in-zone device matches) stays handle_independently and actuates', async () => {
    const { manager, commandExecutor } = createManager();
    const pile: PlannerDeviceInfo = {
      deviceId: 'pile-1',
      type: 'charging-pile',
      capabilities: ['turn-off', 'read-power'],
      zoneId: ZONE,
    };
    manager.setAgentDevices([pile]);
    const assessment = precheckTypeAAssessment({
      eventType: 'grid-peak',
      requiredCapabilities: ['load-management'], // resolved via the built-in offer rule → turn-off
    });
    mockAssessor(manager, assessment);

    await manager.processEvent(createEvent());

    expect(assessment.decision).toBe('handle_independently');
    expect(manager.getStats().handledIndependently).toBe(1);
    expect(commandExecutor).toHaveBeenCalledWith('pile-1', 'turn-off', expect.anything());
  });

  it('LLM-sourced independent decisions are untouched by the gate', async () => {
    const { manager } = createManager();
    manager.setAgentDevices([]);
    const assessment = precheckTypeAAssessment({
      eventType: 'security-patrol',
      requiredCapabilities: ['security-patrol'],
    });
    assessment.decisionSource = 'llm';
    assessment.llmAssessment.reasoningCode = undefined;
    mockAssessor(manager, assessment);

    await manager.processEvent(createEvent());

    expect(assessment.decision).toBe('handle_independently');
    expect(manager.getStats().handledIndependently).toBe(1);
  });

  it('decision-only runs (no command executor) keep the [actuation: none] note instead of converting', async () => {
    const { manager } = createManager({ commandExecutor: undefined });
    const camera: PlannerDeviceInfo = {
      deviceId: 'cam-1',
      type: 'camera',
      capabilities: ['read-occupancy'],
      zoneId: ZONE,
    };
    manager.setAgentDevices([camera]);
    const assessment = precheckTypeAAssessment({
      eventType: 'security-patrol',
      requiredCapabilities: ['security-patrol'],
    });
    mockAssessor(manager, assessment);

    await manager.processEvent(createEvent());

    expect(assessment.decision).toBe('handle_independently');
    expect(assessment.llmAssessment.reasoning).toContain('[actuation: none');
    expect(manager.getStats().handledIndependently).toBe(1);
  });
});
