/**
 * @vitest-environment node
 *
 * EngineRuntime private-experience persistence seam tests (R6-E-F15, no LLM,
 * no network; data/usertest-r6/track-e-capability.md §3).
 *
 * The seam serializes the agents' LEARNED cognition (meta-cognition
 * checkpoint: decision-quality ring + private partner trust) so the server
 * can persist it per (env, agent) across sim rebuilds. Covers:
 *   - honest empty state (nothing learned → the agent is omitted);
 *   - learning from COLLABORATION_COMPLETED (private partner trust);
 *   - JSON round-trip into a fresh runtime (trust + quality ring survive);
 *   - load guards (version mismatch / unknown agent → honest no-op;
 *     agents without a snapshot keep their fresh zero state — no pollution).
 *
 * Every runtime is stop()ed after each test (clean shutdown is part of the
 * contract).
 */

import { describe, it, expect, afterEach } from 'vitest';

import { EventPriority, EventType } from '../events/index.js';
import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime, type EngineRuntimeOptions } from './index.js';
import type { AgentExperienceJSON } from '../cognition/meta.js';

// ---------------------------------------------------------------------------
// Scenario + helpers (mirrors reputation.vitest.test.ts)
// ---------------------------------------------------------------------------

function twoZoneScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'experience-test', name: 'Experience Test Scenario' },
    zones: [
      { id: 'zone-a', name: 'Zone A', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', name: 'Zone B', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      {
        id: 'temp-sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
      {
        id: 'hvac-b',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'sensor-agent',
        name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
      },
      {
        id: 'actuator-agent',
        name: 'Actuator Agent',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-b'],
        boundDeviceIds: ['hvac-b'],
      },
    ],
    events: [],
  });
}

const runtimes: EngineRuntime[] = [];

function makeRuntime(options?: EngineRuntimeOptions): EngineRuntime {
  const runtime = new EngineRuntime(twoZoneScenario(), options);
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
});

/** Publish directly on the runtime's bus (in-package test seam). */
function publish(runtime: EngineRuntime, type: EventType, payload: Record<string, unknown>): void {
  const envCenter = (runtime as unknown as {
    envCenter: { eventManager: { publish: (event: unknown) => void } };
  }).envCenter;
  envCenter.eventManager.publish({
    type,
    source: 'experience-test',
    payload,
    priority: EventPriority.NORMAL,
    metadata: {},
  });
}

/** Publish a completion event shaped like the ACExecutor's. */
function publishACCompleted(
  runtime: EngineRuntime,
  overrides: Record<string, unknown> = {},
): void {
  publish(runtime, EventType.COLLABORATION_COMPLETED, {
    collaborationId: 'ac-1',
    success: true,
    participants: ['sensor-agent', 'actuator-agent'],
    requiredCapabilities: ['cooling'],
    results: {
      goals: [{ id: 'g1', achieved: true }],
      participants: ['sensor-agent', 'actuator-agent'],
    },
    ...overrides,
  });
}

/** The agent's live meta-cognition partner-trust face. */
function partnerTrustOf(runtime: EngineRuntime, agentId: string, partnerId: string) {
  return runtime.getAgent(agentId)
    ?.getDualTriggerACManager()?.getMetaCognition()
    ?.buildContext({ capabilities: [], devices: [] })
    .partnerTrust.find(p => p.partnerId === partnerId);
}

function experienceOf(runtime: EngineRuntime, agentId: string) {
  return runtime.getAgentExperienceJSON().agents.find(a => a.agentId === agentId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EngineRuntime agent-experience persistence seam (R6-E-F15)', () => {
  it('starts honest-empty: nothing learned → no snapshot entries', () => {
    const runtime = makeRuntime();
    expect(runtime.getAgentExperienceJSON()).toEqual({ version: 1, agents: [] });
  });

  it('learns private partner trust from COLLABORATION_COMPLETED', () => {
    const runtime = makeRuntime();
    publishACCompleted(runtime);

    const sensor = experienceOf(runtime, 'sensor-agent');
    const actuator = experienceOf(runtime, 'actuator-agent');
    expect(sensor).toBeDefined();
    expect(actuator).toBeDefined();
    expect(sensor!.metaCognition.trust.partners).toEqual([
      expect.objectContaining({ partnerId: 'actuator-agent', interactionCount: 1 }),
    ]);
    expect(actuator!.metaCognition.trust.partners).toEqual([
      expect.objectContaining({ partnerId: 'sensor-agent', interactionCount: 1 }),
    ]);
  });

  it('JSON round-trip: learned trust + quality ring survive into a fresh runtime', () => {
    const runtime = makeRuntime();
    publishACCompleted(runtime);
    publishACCompleted(runtime, { collaborationId: 'ac-2', success: false, results: { goals: [{ id: 'g1', achieved: false }] } });

    // The serialized snapshot crosses the wire as pure JSON (SQLite text).
    const snapshot = JSON.parse(JSON.stringify(runtime.getAgentExperienceJSON())) as AgentExperienceJSON;

    const fresh = makeRuntime();
    expect(fresh.getAgentExperienceJSON().agents).toEqual([]); // zero before load
    fresh.loadAgentExperienceJSON(snapshot);

    // Private interaction history restored — the sensor agent remembers the
    // actuator across the "sim rebuild".
    const trust = partnerTrustOf(fresh, 'sensor-agent', 'actuator-agent');
    expect(trust).toBeDefined();
    expect(trust!.interactionCount).toBe(2);
    expect(trust!.successfulCollaborations).toBe(1);
    expect(trust!.failedCollaborations).toBe(1);

    // …and the round-trip is stable (re-exporting yields the same learned face).
    const reexported = fresh.getAgentExperienceJSON();
    const sensor = reexported.agents.find(a => a.agentId === 'sensor-agent')!;
    expect(sensor.metaCognition.trust.partners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ partnerId: 'actuator-agent', interactionCount: 2 }),
      ]),
    );
  });

  it('restores the decision-quality ring (calibration data crosses sims too)', () => {
    const runtime = makeRuntime();
    runtime.loadAgentExperienceJSON({
      version: 1,
      agents: [{
        agentId: 'sensor-agent',
        metaCognition: {
          formatVersion: 1,
          agentId: 'sensor-agent',
          quality: {
            records: [
              { action: 'initiate_ac', confidence: 0.9, outcome: 'success' },
              { action: 'handle_independently', confidence: 0.4, outcome: 'failure' },
            ],
          },
          trust: { partners: [] },
        },
      }],
    });

    const sensor = experienceOf(runtime, 'sensor-agent');
    expect(sensor).toBeDefined();
    expect(sensor!.metaCognition.quality.records).toHaveLength(2);
    expect(sensor!.metaCognition.quality.records[0]).toMatchObject({
      action: 'initiate_ac',
      confidence: 0.9,
      outcome: 'success',
    });
  });

  it('load guards: version mismatch and unknown agents are honest no-ops', () => {
    const runtime = makeRuntime();

    // Container version mismatch → nothing happens.
    runtime.loadAgentExperienceJSON({
      version: 2,
      agents: [{
        agentId: 'sensor-agent',
        metaCognition: {
          formatVersion: 1,
          agentId: 'sensor-agent',
          quality: { records: [{ action: 'initiate_ac', confidence: 0.9, outcome: 'success' }] },
          trust: { partners: [] },
        },
      }],
    } as unknown as AgentExperienceJSON);
    expect(experienceOf(runtime, 'sensor-agent')).toBeUndefined();

    // Entry formatVersion mismatch → skipped; unknown agent → skipped; the
    // valid entry still lands (one bad row denies nobody).
    runtime.loadAgentExperienceJSON({
      version: 1,
      agents: [
        {
          agentId: 'sensor-agent',
          metaCognition: { formatVersion: 2, agentId: 'sensor-agent', quality: { records: [] }, trust: { partners: [] } } as never,
        },
        {
          agentId: 'ghost-agent',
          metaCognition: {
            formatVersion: 1,
            agentId: 'ghost-agent',
            quality: { records: [{ action: 'initiate_ac', confidence: 0.9, outcome: 'success' }] },
            trust: { partners: [] },
          },
        },
        {
          agentId: 'actuator-agent',
          metaCognition: {
            formatVersion: 1,
            agentId: 'actuator-agent',
            quality: { records: [] },
            trust: {
              partners: [{
                partnerId: 'sensor-agent',
                interactionCount: 3,
                successfulCollaborations: 2,
                failedCollaborations: 1,
                platformReputation: 0.7,
              }],
            },
          },
        },
      ],
    });
    expect(experienceOf(runtime, 'sensor-agent')).toBeUndefined(); // bad version skipped
    expect(experienceOf(runtime, 'ghost-agent')).toBeUndefined(); // unknown agent skipped
    expect(partnerTrustOf(runtime, 'actuator-agent', 'sensor-agent')!.interactionCount).toBe(3);
  });

  it('zero-cognition agents are not polluted by another agent\'s snapshot', () => {
    const runtime = makeRuntime();
    runtime.loadAgentExperienceJSON({
      version: 1,
      agents: [{
        agentId: 'sensor-agent',
        metaCognition: {
          formatVersion: 1,
          agentId: 'sensor-agent',
          quality: { records: [{ action: 'initiate_ac', confidence: 0.9, outcome: 'success' }] },
          trust: {
            partners: [{
              partnerId: 'actuator-agent',
              interactionCount: 5,
              successfulCollaborations: 5,
              failedCollaborations: 0,
              platformReputation: 0.8,
            }],
          },
        },
      }],
    });

    // The actuator agent had no snapshot: its private experience stays zero —
    // and the export keeps omitting it (no noise rows on the next save).
    expect(partnerTrustOf(runtime, 'actuator-agent', 'sensor-agent')).toBeUndefined();
    expect(experienceOf(runtime, 'actuator-agent')).toBeUndefined();
    // undefined/null loads are no-ops too.
    runtime.loadAgentExperienceJSON(undefined);
    runtime.loadAgentExperienceJSON(null);
    expect(partnerTrustOf(runtime, 'sensor-agent', 'actuator-agent')!.interactionCount).toBe(5);
  });
});
