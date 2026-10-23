/**
 * @vitest-environment node
 *
 * Private-experience cross-sim persistence tests (R6-E-F15,
 * data/usertest-r6/track-e-capability.md §3).
 *
 * Covers:
 *  - migration v61 (agent_experiences table shape + uniqueness);
 *  - cross-sim survival: an env-backed sim's learned meta-cognition
 *    (private partner trust) lands in SQLite on COLLABORATION_COMPLETED and
 *    a NEW sim of the same env starts with it;
 *  - honest zero state: a fresh sim exports no snapshot entries (nothing
 *    learned → nothing written), and rows are keyed (env, agent) so one
 *    agent's experience never leaks into another's snapshot;
 *  - rehydrate discipline: resuming a hibernated sim does NOT re-load the
 *    DB rows — the checkpoint's cognition is the truth (DB tamper between
 *    hibernate and resume has no effect);
 *  - fork privacy (S2): a sandbox fork inherits experience through the
 *    copied checkpoint (one-way) but never writes back to the env's rows;
 *  - degradation: store faults only warn — the runtime is never broken;
 *  - seam wiring: attach with rehydrating skips the load.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EventPriority,
  EventType,
  type EngineRuntime,
} from '@active-collaboration/core';

import { SimulationSeams } from './sim-registry/seams.js';
import type { SimulationRecord } from './sim-registry/types.js';
import type { AgentExperienceStore } from './db/experience-store.js';
import { worldSessionSimIdOf } from './sandbox-service.js';
import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

// ---------------------------------------------------------------------------
// Fixture: initiator in zone-a; two providers in zone-b (llm blocks wire
// Layer 2 against an unreachable backend — no LLM call is ever made).
// ---------------------------------------------------------------------------

const LLM_BACKEND_URL = 'http://127.0.0.1:9/v1';
const LLM_BLOCK = { provider: 'openai-compatible', model: 'unreachable-mock' };

function experienceScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Experience Lab', description: 'R6-E-F15 test env' },
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
        id: 'bystander',
        name: 'Bystander',
        capabilities: ['cooling'],
        managesZoneIds: ['zone-b'],
        boundDeviceIds: [],
        llm: LLM_BLOCK,
      },
    ],
    events: [],
  };
}

interface WorldIds {
  initiator: string;
  providerA: string;
  bystander: string;
}

/** Publish a completion event shaped like the ACExecutor's on the sim's bus. */
function publishACCompleted(
  runtime: EngineRuntime,
  collaborationId: string,
  participants: string[],
  success = true,
): void {
  const envCenter = (runtime as unknown as {
    envCenter: { eventManager: { publish: (event: unknown) => void } };
  }).envCenter;
  envCenter.eventManager.publish({
    type: EventType.COLLABORATION_COMPLETED,
    source: 'experience-test',
    payload: {
      collaborationId,
      success,
      participants,
      requiredCapabilities: ['cooling'],
      results: {
        goals: [{ id: 'g1', achieved: success }],
        participants,
      },
    },
    priority: EventPriority.NORMAL,
    metadata: {},
  });
}

function experienceOf(runtime: EngineRuntime, agentId: string) {
  return runtime.getAgentExperienceJSON().agents.find(a => a.agentId === agentId);
}

function trustCountOf(runtime: EngineRuntime, agentId: string, partnerId: string): number | undefined {
  return experienceOf(runtime, agentId)
    ?.metaCognition.trust.partners.find(p => p.partnerId === partnerId)?.interactionCount;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('agent private-experience persistence (R6-E-F15)', () => {
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
      payload: { ...experienceScenario('experience-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;

    const detail = (
      await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}` })
    ).json() as { agents: Array<{ id: string; name: string }> };
    const agentId = (name: string) => detail.agents.find(a => a.name === name)!.id;
    ids = {
      initiator: agentId('Initiator'),
      providerA: agentId('Provider A'),
      bystander: agentId('Bystander'),
    };
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createSim(): Promise<{ id: string; runtime: EngineRuntime }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    return { id, runtime: ctx.app.simulations.getOrThrow(id).runtime };
  }

  function dbRow(agentId: string): { experience_json: string } | undefined {
    return ctx.app.db
      .prepare('SELECT experience_json FROM agent_experiences WHERE env_id = ? AND agent_id = ?')
      .get(envId, agentId) as { experience_json: string } | undefined;
  }

  function dbTrustCount(agentId: string, partnerId: string): number | undefined {
    const row = dbRow(agentId);
    if (row === undefined) return undefined;
    const snapshot = JSON.parse(row.experience_json) as {
      trust: { partners: Array<{ partnerId: string; interactionCount: number }> };
    };
    return snapshot.trust.partners.find(p => p.partnerId === partnerId)?.interactionCount;
  }

  it('migration v61 creates agent_experiences with the documented shape', () => {
    const columns = ctx.app.db
      .prepare(`PRAGMA table_info(agent_experiences)`)
      .all() as Array<{ name: string; type: string }>;
    const byName = new Map(columns.map(c => [c.name, c]));
    for (const column of ['env_id', 'agent_id', 'experience_json', 'updated_at']) {
      expect(byName.has(column), `missing column ${column}`).toBe(true);
    }
    expect(byName.get('updated_at')!.type).toBe('INTEGER');

    // Uniqueness of (env_id, agent_id)
    const insert = ctx.app.db.prepare(
      `INSERT INTO agent_experiences (env_id, agent_id, experience_json, updated_at)
       VALUES (?, ?, '{}', 0)`,
    );
    insert.run(envId, ids.initiator);
    expect(() => insert.run(envId, ids.initiator)).toThrow();

    const indexes = ctx.app.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_experiences'`)
      .all() as Array<{ name: string }>;
    expect(indexes.some(i => i.name === 'idx_agent_experiences_env')).toBe(true);
  });

  it('cross-sim survival: learned trust persists on COLLABORATION_COMPLETED/stop and a new sim starts with it', async () => {
    const sim = await createSim();

    // Honest zero state BEFORE anything happens: no snapshot entries.
    expect(sim.runtime.getAgentExperienceJSON().agents).toEqual([]);

    // Teach: initiator + provider A complete one collaboration. Every
    // agent's manager observes bus-wide completions (existing semantic):
    // participants record trust for each OTHER participant; the bystander
    // records an OBSERVED interaction with both — but its quality ring
    // stays empty (resolveOutcome is a no-op without a pending decision).
    publishACCompleted(sim.runtime, 'ac-x-1', [ids.initiator, ids.providerA]);
    expect(trustCountOf(sim.runtime, ids.initiator, ids.providerA)).toBe(1);

    // The seam persisted on the event itself — rows exist before stop.
    expect(dbTrustCount(ids.initiator, ids.providerA)).toBe(1);
    expect(dbTrustCount(ids.providerA, ids.initiator)).toBe(1);
    // Rows are keyed (env, agent): the initiator's snapshot carries ONLY
    // its own view (provider A) — never the bystander's data.
    const initiatorRow = JSON.parse(dbRow(ids.initiator)!.experience_json) as {
      trust: { partners: Array<{ partnerId: string }> };
      quality: { records: unknown[] };
    };
    expect(initiatorRow.trust.partners.map(p => p.partnerId)).toEqual([ids.providerA]);
    expect(initiatorRow.quality.records).toEqual([]);
    // The bystander's row is its OWN observation, not cross-agent leakage:
    // trust toward both participants, zero quality records.
    const bystanderRow = JSON.parse(dbRow(ids.bystander)!.experience_json) as {
      trust: { partners: Array<{ partnerId: string; interactionCount: number }> };
      quality: { records: unknown[] };
    };
    expect(bystanderRow.trust.partners).toEqual([
      expect.objectContaining({ partnerId: ids.initiator, interactionCount: 1 }),
      expect.objectContaining({ partnerId: ids.providerA, interactionCount: 1 }),
    ]);
    expect(bystanderRow.quality.records).toEqual([]);

    // Stop persists too; a NEW sim of the same env loads the experience.
    const stopped = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${sim.id}/stop`, headers: auth(owner.token), payload: {},
    });
    expect(stopped.statusCode).toBe(200);

    const sim2 = await createSim();
    expect(trustCountOf(sim2.runtime, ids.initiator, ids.providerA)).toBe(1);
    expect(trustCountOf(sim2.runtime, ids.providerA, ids.initiator)).toBe(1);
    // The bystander reloads exactly its own observed trust (keyed rows),
    // with a still-empty quality ring — no pollution from other agents.
    expect(trustCountOf(sim2.runtime, ids.bystander, ids.initiator)).toBe(1);
    expect(experienceOf(sim2.runtime, ids.bystander)!.metaCognition.quality.records).toEqual([]);

    // Learning ACCUMULATES across sims: one more collaboration in sim B → 2.
    publishACCompleted(sim2.runtime, 'ac-x-2', [ids.initiator, ids.providerA]);
    expect(trustCountOf(sim2.runtime, ids.initiator, ids.providerA)).toBe(2);
    expect(dbTrustCount(ids.initiator, ids.providerA)).toBe(2);

    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${sim2.id}/stop`, headers: auth(owner.token), payload: {},
    });
  });

  it('rehydrate discipline: resume keeps the checkpoint cognition, not the (tampered) DB rows', async () => {
    const sim = await createSim();
    publishACCompleted(sim.runtime, 'ac-h-1', [ids.initiator, ids.providerA]);
    expect(dbTrustCount(ids.initiator, ids.providerA)).toBe(1);

    // Hibernate: checkpoint carries the cognition; the stop-side persist runs too.
    const hibernated = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${sim.id}/hibernate`, headers: auth(owner.token), payload: {},
    });
    expect(hibernated.statusCode).toBe(200);

    // Tamper: if resume re-loaded the DB rows, the initiator's trust would
    // vanish (empty snapshot) — the rehydrating skip must make this a no-op.
    ctx.app.db
      .prepare(
        `UPDATE agent_experiences SET experience_json = ? WHERE env_id = ? AND agent_id = ?`,
      )
      .run(
        JSON.stringify({ formatVersion: 1, agentId: ids.initiator, quality: { records: [] }, trust: { partners: [] } }),
        envId,
        ids.initiator,
      );

    const resumed = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${sim.id}/resume`, headers: auth(owner.token), payload: {},
    });
    expect(resumed.statusCode).toBe(200);

    const runtime = ctx.app.simulations.getOrThrow(sim.id).runtime;
    // Checkpoint truth wins: the learned trust survived the tampered row.
    expect(trustCountOf(runtime, ids.initiator, ids.providerA)).toBe(1);

    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${sim.id}/stop`, headers: auth(owner.token), payload: {},
    });
  });

  it('fork privacy (S2): the fork inherits experience via the checkpoint copy but never writes back', async () => {
    // Teach the AUTHORITATIVE world session (env-backed → rows land).
    await ctx.app.worldSessions.targetFor(envId);
    const sessionSimId = worldSessionSimIdOf(envId);
    const session = ctx.app.simulations.getOrThrow(sessionSimId);
    publishACCompleted(session.runtime, 'ac-w-1', [ids.initiator, ids.providerA]);
    expect(dbTrustCount(ids.initiator, ids.providerA)).toBe(1);
    const rowBefore = dbRow(ids.initiator)!.experience_json;

    // Cheap fork of the live world (owner is an env member).
    const forked = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/sandboxes`,
      headers: auth(owner.token),
      payload: { fromCheckpoint: true },
    });
    expect(forked.statusCode).toBe(201);
    const forkSimId = forked.json().simulationId as string;
    const forkRuntime = ctx.app.simulations.getOrThrow(forkSimId).runtime;

    // One-way copy: the fork INHERITED the experience through the checkpoint.
    expect(trustCountOf(forkRuntime, ids.initiator, ids.providerA)).toBe(1);

    // The fork learns more…
    publishACCompleted(forkRuntime, 'ac-f-1', [ids.initiator, ids.providerA]);
    publishACCompleted(forkRuntime, 'ac-f-2', [ids.initiator, ids.providerA]);
    expect(trustCountOf(forkRuntime, ids.initiator, ids.providerA)).toBe(3);

    // …but the env's rows are untouched — no env backing, no write-back.
    expect(dbRow(ids.initiator)!.experience_json).toBe(rowBefore);

    // Stopping the fork changes nothing either.
    ctx.app.simulations.stop(forkSimId);
    expect(dbRow(ids.initiator)!.experience_json).toBe(rowBefore);
    expect(dbTrustCount(ids.initiator, ids.providerA)).toBe(1);
  });

  it('degradation: store faults only warn — attach, load, and persist never break the runtime', async () => {
    const sim = await createSim();
    const throwing = {
      rowsForEnv: () => { throw new Error('db gone'); },
      saveForEnv: () => { throw new Error('db gone'); },
    } as unknown as AgentExperienceStore;
    const seams = new SimulationSeams({ experienceStore: throwing });
    const record = {
      id: 'sim-degradation',
      environmentId: envId,
      runtime: sim.runtime,
      trajectoryDir: undefined,
    } as unknown as SimulationRecord;

    // Attach (load path throws inside), then drive the persist path via the
    // wired COLLABORATION_COMPLETED subscription — nothing may propagate.
    expect(() => seams.attach(record)).not.toThrow();
    expect(() => publishACCompleted(sim.runtime, 'ac-d-1', [ids.initiator, ids.providerA])).not.toThrow();
    // The runtime itself still learned (in-memory cognition is unaffected).
    expect(trustCountOf(sim.runtime, ids.initiator, ids.providerA)).toBe(1);
    expect(() => seams.persistExperiences(envId, sim.runtime)).not.toThrow();

    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${sim.id}/stop`, headers: auth(owner.token), payload: {},
    });
  });

  it('seam wiring: attach with rehydrating skips the store load', async () => {
    const sim = await createSim();
    const calls: string[] = [];
    const spy = {
      rowsForEnv: () => { calls.push('load'); return []; },
      saveForEnv: () => { calls.push('save'); },
    } as unknown as AgentExperienceStore;
    const record = {
      id: 'sim-spy',
      environmentId: envId,
      runtime: sim.runtime,
      trajectoryDir: undefined,
    } as unknown as SimulationRecord;

    new SimulationSeams({ experienceStore: spy }).attach(record, { rehydrating: true });
    expect(calls).not.toContain('load');

    new SimulationSeams({ experienceStore: spy }).attach(record);
    expect(calls).toContain('load');

    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${sim.id}/stop`, headers: auth(owner.token), payload: {},
    });
  });

  it('legacy scenario sims keep experience in memory only (no persistence)', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { scenarioId: 'cross-brand-home' },
    });
    expect(created.statusCode).toBe(201);
    const simId = created.json().id as string;
    const runtime = ctx.app.simulations.getOrThrow(simId).runtime;

    const snapshotAgents = runtime.getSnapshot().agents.map(a => a.id);
    expect(snapshotAgents.length).toBeGreaterThanOrEqual(2);
    publishACCompleted(runtime, 'ac-legacy-1', snapshotAgents.slice(0, 2));
    expect(runtime.getAgentExperienceJSON().agents.length).toBeGreaterThan(0);

    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(owner.token), payload: {},
    });
    const count = ctx.app.db
      .prepare('SELECT COUNT(*) AS c FROM agent_experiences')
      .get() as { c: number };
    expect(count.c).toBe(0);
  });
});
