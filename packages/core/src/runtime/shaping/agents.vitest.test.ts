/**
 * @vitest-environment node
 *
 * T-050 (R11 corrective) — dual-trigger config assembly for the actuation
 * toggles. Pure shaping: what buildAgentDualTriggerConfig stamps from the
 * resolved inputs (EngineRuntime resolves option > scenario decisionPolicy
 * > default before calling).
 */

import { describe, it, expect, vi } from 'vitest';
import { buildAgentDualTriggerConfig } from './agents.js';
import { inferDeviceRole } from '../../scenario/index.js';
import type { ScenarioAgent, ScenarioDevice } from '../../scenario/index.js';
import { ACNecessityAssessor } from '../../decision/ACNecessityAssessor.js';
import type { LLMClient } from '@active-collaboration/llm-integration';

const agentDef: ScenarioAgent = {
  id: 'manager',
  name: 'Manager',
  capabilities: ['temperature-control'],
  managesZoneIds: ['zone-a'],
  boundDeviceIds: ['hvac-a'],
};

const devices: ScenarioDevice[] = [
  {
    id: 'hvac-a',
    name: 'HVAC A',
    type: 'hvac',
    role: 'actuator',
    capabilities: ['temperature-control'],
    zoneId: 'zone-a',
    binding: 'sim://hvac-a',
  },
];

const zones = [{ id: 'zone-a', adjacentZoneIds: [] }];

function makeInput(overrides: Partial<Parameters<typeof buildAgentDualTriggerConfig>[0]> = {}) {
  return {
    agentDef,
    managedDevices: devices,
    zones,
    autoInitiateAC: true,
    autoActuateIndependent: true,
    llmEnabled: false,
    ...overrides,
  };
}

describe('buildAgentDualTriggerConfig — actuation toggles (T-050)', () => {
  it('defaults stamp autoActuateIndependent=true (current behavior)', () => {
    const { dualTriggerConfig } = buildAgentDualTriggerConfig(makeInput());
    expect(dualTriggerConfig.autoActuateIndependent).toBe(true);
    expect(dualTriggerConfig.autoInitiateAC).toBe(true);
    // rule-only when no LLM
    expect(dualTriggerConfig.ruleOnly).toBe(true);
  });

  it('stamps a resolved false (scenario decisionPolicy or sim option)', () => {
    const { dualTriggerConfig } = buildAgentDualTriggerConfig(
      makeInput({ autoActuateIndependent: false }),
    );
    expect(dualTriggerConfig.autoActuateIndependent).toBe(false);
  });

  it('actuator zones derive from actuator/hybrid devices regardless of toggles', () => {
    const { actuatorZoneIds } = buildAgentDualTriggerConfig(makeInput());
    expect(actuatorZoneIds).toEqual(['zone-a']);
  });
});

describe('buildAgentDualTriggerConfig — precheck Type-A pass-through (R43-B/lever-b)', () => {
  it('default (no decisionPolicy): precheckPassThrough stays undefined (behavior equivalence)', () => {
    const { dualTriggerConfig } = buildAgentDualTriggerConfig(makeInput({ llmEnabled: true }));
    expect(dualTriggerConfig.precheckPassThrough).toBeUndefined();
  });

  it("decisionPolicy.precheckPassThrough 'off' → undefined (explicit off is the same as absent)", () => {
    const { dualTriggerConfig } = buildAgentDualTriggerConfig(makeInput({
      llmEnabled: true,
      agentDef: { ...agentDef, decisionPolicy: { precheckPassThrough: 'off' } },
    }));
    expect(dualTriggerConfig.precheckPassThrough).toBeUndefined();
  });

  it("decisionPolicy.precheckPassThrough 'sample' carries the configured rate", () => {
    const { dualTriggerConfig } = buildAgentDualTriggerConfig(makeInput({
      llmEnabled: true,
      agentDef: {
        ...agentDef,
        decisionPolicy: { precheckPassThrough: 'sample', precheckPassThroughRate: 0.6 },
      },
    }));
    expect(dualTriggerConfig.precheckPassThrough).toEqual({ mode: 'sample', rate: 0.6 });
  });

  it("decisionPolicy.precheckPassThrough 'all' (rate-less) → { mode: 'all' }", () => {
    const { dualTriggerConfig } = buildAgentDualTriggerConfig(makeInput({
      llmEnabled: true,
      agentDef: { ...agentDef, decisionPolicy: { precheckPassThrough: 'all' } },
    }));
    expect(dualTriggerConfig.precheckPassThrough).toEqual({ mode: 'all' });
  });
});

describe('buildAgentDualTriggerConfig — coordinator role (R45-P1)', () => {
  it('default (no decisionPolicy.role): decisionRole stays undefined (executor, behavior equivalence)', () => {
    const { dualTriggerConfig } = buildAgentDualTriggerConfig(makeInput({ llmEnabled: true }));
    expect(dualTriggerConfig.decisionRole).toBeUndefined();
  });

  it("decisionPolicy.role 'coordinator' → decisionRole 'coordinator' (precheck never Type-A short-circuits)", () => {
    const { dualTriggerConfig } = buildAgentDualTriggerConfig(makeInput({
      llmEnabled: true,
      agentDef: { ...agentDef, decisionPolicy: { role: 'coordinator' } },
    }));
    expect(dualTriggerConfig.decisionRole).toBe('coordinator');
  });
});

// ---------------------------------------------------------------------------
// BUG-01 — verb-prefixed read-only devices no longer grant actuator zones,
// and the merged semantic-offer table reaches the actuation planner.
// ---------------------------------------------------------------------------

describe('buildAgentDualTriggerConfig — BUG-01 read-only role + offer rules', () => {
  const sensorDevices: ScenarioDevice[] = [
    {
      id: 'cam-1',
      name: 'Camera 1',
      type: 'camera',
      // The post-BUG-01 loader inference: verb-prefixed read-only names
      // (read-occupancy / detect-smoke) classify as reads → sensor.
      role: inferDeviceRole(['read-occupancy', 'detect-smoke']),
      capabilities: ['read-occupancy', 'detect-smoke'],
      zoneId: 'zone-a',
      binding: 'sim://cam-1',
    },
  ];

  it('verb-prefixed read-only devices infer role sensor and grant NO actuator zone', () => {
    expect(inferDeviceRole(['read-occupancy', 'detect-smoke'])).toBe('sensor');
    const { actuatorZoneIds } = buildAgentDualTriggerConfig(makeInput({
      managedDevices: sensorDevices,
    }));
    expect(actuatorZoneIds).toEqual([]);
  });

  it('acceptance: sensor-only security officer gets precheck.sensor_notify initiate_ac (not handle_independently)', async () => {
    // The full chain this bug broke: misclassified roles put zone-a in
    // actuatorZoneIds, the Type-A precheck short-circuited to
    // handle_independently, and the planner then produced 0 commands.
    // With the corrected role the assessor sees a sensor-only agent and
    // delegates (domain relevance: both required capabilities match).
    const { actuatorZoneIds } = buildAgentDualTriggerConfig(makeInput({
      managedDevices: sensorDevices,
    }));
    const assessor = new ACNecessityAssessor({}, {
      chat: vi.fn(),
      quickChat: vi.fn(),
    } as unknown as LLMClient);
    const clusterSummary = {
      clusterId: 'cluster-sec',
      region: { id: 'zone-a', center: { x: 0, y: 0 }, radius: 10, type: 'zone' as const },
      timeWindow: '2024-03-15T10:00:00Z - 2024-03-15T10:05:00Z',
      significance: 'medium' as const,
      summary: 'Security patrol required in zone-a',
      findings: [{
        eventType: 'security-patrol',
        count: 1,
        trend: 'stable',
        anomaly: true,
        details: { requiredCapabilities: ['security-patrol', 'surveillance'] },
      }],
      recommendation: 'evaluate_with_llm' as const,
    };
    const result = await assessor.assess(clusterSummary, {
      agentId: 'security-officer',
      agentName: 'SecurityOfficer',
      capabilities: ['security-patrol', 'surveillance', 'read-occupancy'],
      availableResources: [],
      currentWorkload: 'idle',
      recentCollaborations: [],
      currentCollaborations: 0,
      actuatorZoneIds,
    });
    expect(result.decision).toBe('initiate_ac');
    expect(result.llmAssessment.reasoningCode).toBe('precheck.sensor_notify');
  });

  it('scenario + option offer rules merge into the dual-trigger config (planner table)', () => {
    const custom = {
      semanticType: 'exam-week-quiet',
      label: '考试周静音保障',
      description: 'custom scenario rule',
      requires: ['noise-monitoring'],
      actuates: ['set-volume'],
    };
    const { dualTriggerConfig } = buildAgentDualTriggerConfig(makeInput({
      scenarioOfferRules: [custom],
    }));
    expect(dualTriggerConfig.semanticOfferRules?.some(r => r.semanticType === 'exam-week-quiet')).toBe(true);
    // Built-ins ride along (merged table, not a replacement).
    expect(dualTriggerConfig.semanticOfferRules?.some(r => r.semanticType === 'grid-load-management')).toBe(true);
  });

  it('no rule sources → semanticOfferRules stays unset (planner built-in default)', () => {
    const { dualTriggerConfig } = buildAgentDualTriggerConfig(makeInput());
    expect(dualTriggerConfig.semanticOfferRules).toBeUndefined();
  });
});
