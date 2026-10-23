/**
 * @vitest-environment node
 *
 * Service/agent reputation tests (P4-1).
 *
 * Covers:
 *  - migration v7 (agent_reputation table shape + uniqueness);
 *  - API shape: prior view when no history (services listing, env detail,
 *    agent reputation endpoint, 404s);
 *  - the fault-based demo arc ON THE API: env-backed sim (LLM preset via an
 *    unreachable backend URL — negotiators exist, no LLM call is ever made),
 *    healthy AC runs, mid-sim fault injection (P3d) offlining partner A's
 *    hvac, two more AC runs whose device operations fail, then partner
 *    selection shifting to the healthy alternative B;
 *  - persistence: registry saves the tracker on COLLABORATION_COMPLETED and
 *    on stop, and a NEW sim of the same env loads the learned rows;
 *  - legacy scenario sims keep reputation in memory only.
 *
 * AC runs use a REAL ACExecutor against the runtime's EnvironmentCenter
 * (no LLM in the executor): goals are delivery checks ("turn on hvac-x").
 * A faulted provider records no successful device operation, so the engine
 * classifies its AC outcome 'partial' and the fault seam's device.error adds
 * a full failure per device capability — that is the reputation signal.
 *
 * NOTE: environment import regenerates instance ids, so the suite resolves
 * the real agent/device ids by NAME from the env detail after creation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACExecutor,
  EventPriority,
  EventType,
  type EngineRuntime,
} from '@active-collaboration/core';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

// ---------------------------------------------------------------------------
// Fixture: initiator in zone-a; two interchangeable 'turn-on' providers in
// zone-b (hvac-a / hvac-b). llm blocks make the registry wire Layer 2 (the
// backend URL is unreachable by design — findPartners never calls the LLM).
// ---------------------------------------------------------------------------

const LLM_BACKEND_URL = 'http://127.0.0.1:9/v1';
const LLM_BLOCK = { provider: 'openai-compatible', model: 'unreachable-mock' };

function reputationScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Reputation Lab', description: 'P4-1 test env' },
    zones: [
      { id: 'zone-a', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      {
        id: 'temp-sensor-a',
        name: 'Sensor A',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
      {
        id: 'hvac-a',
        name: 'HVAC A',
        type: 'hvac',
        capabilities: ['cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
      {
        id: 'hvac-b',
        name: 'HVAC B',
        type: 'hvac',
        capabilities: ['cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'initiator',
        name: 'Initiator',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
        llm: LLM_BLOCK,
      },
      {
        id: 'provider-a',
        name: 'Provider A',
        capabilities: ['cooling', 'turn-on'],
        managesZoneIds: ['zone-b'],
        boundDeviceIds: ['hvac-a'],
        llm: LLM_BLOCK,
      },
      {
        id: 'provider-b',
        name: 'Provider B',
        capabilities: ['cooling', 'turn-on'],
        managesZoneIds: ['zone-b'],
        boundDeviceIds: ['hvac-b'],
        llm: LLM_BLOCK,
      },
    ],
    events: [],
  };
}

/** Real instance ids of the fixture world (import regenerates them). */
interface WorldIds {
  initiator: string;
  providerA: string;
  providerB: string;
  hvacA: string;
  hvacB: string;
}

// ---------------------------------------------------------------------------
// Runtime access helpers (test seams into the engine internals)
// ---------------------------------------------------------------------------

interface RuntimeInternals {
  envCenter: {
    eventManager: { publish: (event: unknown) => void };
  };
  agents: Map<string, {
    getDualTriggerACManager: () => {
      getPartnerNegotiator: () => {
        findPartners: (assessment: unknown) => Promise<{
          selectedPartners: Array<{ agentId: string; reliability: number; matchScore: number }>;
        }>;
      } | null;
    } | undefined;
    collaborationManager: unknown;
  }>;
}

function internals(runtime: EngineRuntime): RuntimeInternals {
  return runtime as unknown as RuntimeInternals;
}

/** Run one REAL AC on the runtime: initiator asks the provider to turn on the device. */
async function runDeliveryAC(
  runtime: EngineRuntime,
  ids: WorldIds,
  acId: string,
  providerId: string,
  deviceId: string,
): Promise<void> {
  const rt = internals(runtime);
  const executor = new ACExecutor();
  await executor.executeCollaboration({
    id: acId,
    name: acId,
    description: `Turn on ${deviceId} via ${providerId}`,
    environment: rt.envCenter,
    initiatorId: ids.initiator,
    participantAgentIds: [providerId],
    collaborationManager: rt.agents.get(ids.initiator)!.collaborationManager,
    goals: [
      {
        id: `goal-${acId}`,
        description: `Turn on ${deviceId}`,
        targetDevices: [deviceId],
        targetAgents: [providerId],
        requiredCapabilities: ['turn-on'],
        successCriteria: [],
        priority: 'high',
      },
    ],
    maxDuration: 10000,
    timeout: 5000,
  } as never);
}

/** Partner selection through the initiator's REAL negotiator (tracker wired by the runtime). */
async function selectPartners(runtime: EngineRuntime, ids: WorldIds) {
  const rt = internals(runtime);
  const negotiator = rt.agents.get(ids.initiator)!
    .getDualTriggerACManager()!.getPartnerNegotiator()!;
  const assessment = {
    clusterSummary: {
      clusterId: 'c1',
      region: { id: 'r1', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
      timeWindow: 't',
      significance: 'high',
      summary: 'Need a turn-on provider',
      findings: [],
      recommendation: 'immediate_action',
    },
    agentContext: {
      agentId: ids.initiator,
      agentName: 'Initiator',
      capabilities: ['temperature-monitoring'],
      availableResources: [],
      currentWorkload: 'idle',
      recentCollaborations: [],
      currentCollaborations: 0,
    },
    llmAssessment: {
      needsCollaboration: true,
      reasoning: 'test',
      urgency: 'high',
      suggestedPartnerTypes: [],
      requiredCapabilities: ['turn-on'],
      confidence: 0.9,
      estimatedDuration: 60000,
      potentialRisks: [],
    },
    decision: 'initiate_ac',
    timestamp: new Date(),
  };
  return negotiator.findPartners(assessment);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('agent reputation (P4-1)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;
  let ids: WorldIds;

  beforeEach(async () => {
    ctx = await makeTestApp({ llmBaseUrl: LLM_BACKEND_URL, llmModel: 'unreachable-mock' });
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...reputationScenario('rep-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;

    const detail = (
      await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}` })
    ).json() as {
      agents: Array<{ id: string; name: string }>;
      devices: Array<{ id: string; name: string }>;
    };
    const agentId = (name: string) => detail.agents.find(a => a.name === name)!.id;
    const deviceId = (name: string) => detail.devices.find(d => d.name === name)!.id;
    ids = {
      initiator: agentId('Initiator'),
      providerA: agentId('Provider A'),
      providerB: agentId('Provider B'),
      hvacA: deviceId('HVAC A'),
      hvacB: deviceId('HVAC B'),
    };
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createSim(): Promise<{ id: string; runtime: EngineRuntime }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { environmentId: envId },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    return { id, runtime: ctx.app.simulations.getOrThrow(id).runtime };
  }

  it('migration v7 creates agent_reputation with the documented shape', () => {
    const columns = ctx.app.db
      .prepare(`PRAGMA table_info(agent_reputation)`)
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const byName = new Map(columns.map(c => [c.name, c]));
    for (const column of ['env_id', 'agent_id', 'capability', 'attempts', 'successes', 'failures', 'last_at']) {
      expect(byName.has(column), `missing column ${column}`).toBe(true);
    }
    expect(byName.get('attempts')!.type).toBe('REAL');
    expect(byName.get('last_at')!.type).toBe('INTEGER');

    // Uniqueness of (env_id, agent_id, capability)
    const insert = ctx.app.db.prepare(
      `INSERT INTO agent_reputation (env_id, agent_id, capability, attempts, successes, failures, last_at)
       VALUES (?, ?, 'cooling', 1, 1, 0, 0)`,
    );
    insert.run(envId, ids.providerA);
    expect(() => insert.run(envId, ids.providerA)).toThrow();

    const indexes = ctx.app.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_reputation'`)
      .all() as Array<{ name: string }>;
    expect(indexes.some(i => i.name === 'idx_agent_reputation_env')).toBe(true);
  });

  it('API exposes the prior view (0.7, zero counts) when no history exists', async () => {
    // T-208: derived services are members-visible — query as the env owner.
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    expect(listed.statusCode).toBe(200);
    const services = listed.json().services as Array<{
      semanticType: string;
      reputation: { score: number; attempts: number; successes: number; prior?: number };
    }>;
    expect(services.length).toBeGreaterThan(0);
    for (const service of services) {
      // T37 (R3): the zero-sample view names its prior explicitly.
      expect(service.reputation).toEqual({ score: 0.7, attempts: 0, successes: 0, prior: 0.7 });
    }

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}` });
    expect(detail.statusCode).toBe(200);
    for (const service of detail.json().services as Array<{ reputation: unknown }>) {
      expect(service.reputation).toEqual({ score: 0.7, attempts: 0, successes: 0, prior: 0.7 });
    }

    const agentRep = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/agents/${ids.providerA}/reputation`,
    });
    expect(agentRep.statusCode).toBe(200);
    expect(agentRep.json()).toMatchObject({
      agentId: ids.providerA,
      envId,
      overallScore: 0.7,
      totalAttempts: 0,
      capabilities: [],
    });

    const missing = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/agents/no-such-agent/reputation`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('AGENT_NOT_FOUND');
  });

  it('fault-based demo: faulted provider loses partner selection; reputation persists across sims', async () => {
    const sim = await createSim();
    const runtime = sim.runtime;
    expect(ctx.app.simulations.getOrThrow(sim.id).llm).toBe('llm');

    // BEFORE any history: both providers score the prior — selection is a tie.
    const before = await selectPartners(runtime, ids);
    const beforeA = before.selectedPartners.find(p => p.agentId === ids.providerA);
    const beforeB = before.selectedPartners.find(p => p.agentId === ids.providerB);
    expect(beforeA).toBeDefined();
    expect(beforeB).toBeDefined();
    expect(beforeA!.reliability).toBeCloseTo(0.7, 5);
    expect(beforeB!.reliability).toBeCloseTo(0.7, 5);
    expect(beforeA!.matchScore).toBeCloseTo(beforeB!.matchScore, 5);

    // Healthy baseline: one successful delivery AC for each provider.
    await runDeliveryAC(runtime, ids, 'ac-baseline-a', ids.providerA, ids.hvacA);
    await runDeliveryAC(runtime, ids, 'ac-baseline-b', ids.providerB, ids.hvacB);
    expect(runtime.getReputation(ids.providerA, 'turn-on')).toMatchObject({ attempts: 1, successes: 1 });
    expect(runtime.getReputation(ids.providerB, 'turn-on')).toMatchObject({ attempts: 1, successes: 1 });

    // The registry persisted each COLLABORATION_COMPLETED to SQLite already.
    const persisted = ctx.app.reputationStore.scoreFor(envId, ids.providerB, 'turn-on');
    expect(persisted).toBeDefined();
    expect(persisted!.attempts).toBe(1);

    // Mid-sim fault injection (P3d): partner A's hvac goes offline.
    const fault = await ctx.app.inject({
      method: 'PUT',
      url: `/api/simulations/${sim.id}/faults/${ids.hvacA}`,
      payload: { offline: true },
    });
    expect(fault.statusCode).toBe(200);

    // Two more delivery ACs against the faulted provider: operations fail at
    // the fault seam (device.error), the executor records no successful
    // device op → outcome 'partial' (0.5) + a full device failure (0) each.
    await runDeliveryAC(runtime, ids, 'ac-faulted-1', ids.providerA, ids.hvacA);
    await runDeliveryAC(runtime, ids, 'ac-faulted-2', ids.providerA, ids.hvacA);

    // a.turn-on: attempts 5 (3 AC + 2 device errors), successes 2 → (2+3.5)/10 = 0.55
    const cellA = runtime.getReputation(ids.providerA, 'turn-on');
    expect(cellA).toMatchObject({ attempts: 5, successes: 2 });
    if (!Array.isArray(cellA)) expect(cellA.score).toBeCloseTo(0.55, 5);

    // AFTER: selection shifts — the healthy provider B outranks faulted A.
    const after = await selectPartners(runtime, ids);
    const afterA = after.selectedPartners.find(p => p.agentId === ids.providerA);
    const afterB = after.selectedPartners.find(p => p.agentId === ids.providerB);
    expect(afterB!.reliability).toBeCloseTo(0.75, 5);
    expect(afterA!.reliability).toBeCloseTo(0.55, 5);
    expect(afterB!.matchScore).toBeGreaterThan(afterA!.matchScore);
    expect(after.selectedPartners[0].agentId).toBe(ids.providerB);

    // API: service-level reputation reflects the track record.
    const services = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/services`,
        headers: auth(owner.token),
      })
    ).json().services as Array<{
      name: string;
      semanticType: string;
      provider: { id: string };
      reputation: { score: number; attempts: number; successes: number };
    }>;
    const turnOnA = services.find(s => s.provider.id === ids.providerA && s.semanticType === 'turn-on');
    const turnOnB = services.find(s => s.provider.id === ids.providerB && s.semanticType === 'turn-on');
    expect(turnOnA).toBeDefined();
    expect(turnOnB).toBeDefined();
    expect(turnOnA!.reputation.attempts).toBe(5);
    expect(turnOnA!.reputation.score).toBeCloseTo(0.55, 2);
    expect(turnOnB!.reputation.score).toBeCloseTo(0.75, 2);

    // API: agent reputation endpoint — full breakdown incl. device-attributed failures.
    const agentRep = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/agents/${ids.providerA}/reputation`,
      })
    ).json();
    expect(agentRep.totalAttempts).toBe(9); // 5 turn-on + 2 cooling + 2 turn-off
    const cooling = agentRep.capabilities.find((c: { capability: string }) => c.capability === 'cooling');
    expect(cooling).toMatchObject({ attempts: 2, successes: 0, failures: 2 });

    // Stop persists; a NEW sim of the same env loads the learned reputation.
    const stopped = await ctx.app.inject({ method: 'POST', url: `/api/simulations/${sim.id}/stop` });
    expect(stopped.statusCode).toBe(200);

    const sim2 = await createSim();
    const reloaded = sim2.runtime.getReputation(ids.providerA, 'turn-on');
    expect(reloaded).toMatchObject({ attempts: 5, successes: 2 });
    if (!Array.isArray(reloaded)) expect(reloaded.score).toBeCloseTo(0.55, 5);

    // …and the second sim's selection already avoids provider A.
    const second = await selectPartners(sim2.runtime, ids);
    expect(second.selectedPartners[0].agentId).toBe(ids.providerB);

    // Snapshot exposes the per-agent reputation summary.
    const snapAgent = sim2.runtime.getSnapshot().agents.find(a => a.id === ids.providerA);
    expect(snapAgent!.reputation.totalAttempts).toBe(9);
    expect(snapAgent!.reputation.topCapabilities[0].capability).toBe('turn-on');
  }, 30000);

  it('legacy scenario sims keep reputation in memory only (no persistence)', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'cross-brand-home' },
    });
    expect(created.statusCode).toBe(201);
    const simId = created.json().id as string;
    const runtime = ctx.app.simulations.getOrThrow(simId).runtime;

    // The in-memory tracker still learns…
    internals(runtime).envCenter.eventManager.publish({
      type: EventType.COLLABORATION_COMPLETED,
      source: 'reputation-test',
      payload: {
        collaborationId: 'ac-legacy-1',
        success: true,
        participants: ['anyone'],
        requiredCapabilities: ['cooling'],
        results: { goals: [{ id: 'g', achieved: true }] },
      },
      priority: EventPriority.NORMAL,
      metadata: {},
    });
    expect(runtime.getReputation('anyone', 'cooling')).toMatchObject({ attempts: 1 });

    // …but nothing reaches the database (no environment attached).
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop` });
    const count = ctx.app.db
      .prepare('SELECT COUNT(*) AS c FROM agent_reputation')
      .get() as { c: number };
    expect(count.c).toBe(0);
  });
});
