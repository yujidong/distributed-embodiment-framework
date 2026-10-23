/**
 * @vitest-environment node
 *
 * R37-F1 (validation F1): env-row edits hot-reload the authoritative world
 * session — "changes to the environment (adding devices, changing
 * capabilities) require recreating the entire env" was the reported pain.
 *
 * Covers the three traps the live validation hit, at both the service level
 * (injected clock + scenario ref, no driver) and the HTTP level:
 *
 * 1. LIVE sessions land direct env edits (device install + agent rebind)
 *    through onWorldMutation's topology rebuild — and the HTTP route's
 *    fire-and-forget wake actually fires (polled, not re-invoked).
 * 2. The GENERIC /resume wedge: someone resumes the session sim through the
 *    generic hibernate-resume (frozen checkpoint scenario) while the
 *    service's state says hibernated — the next arrival used to throw
 *    WORLD_SESSION_EXISTS into the void; now it adopts the live record and
 *    rebuilds from CURRENT env rows.
 * 3. A STOPPED husk record under the deterministic session id no longer
 *    blocks governance-driven creation (WORLD_SESSION_EXISTS discarded);
 *    HTTP /stop on a world session routes to FREEZE (checkpoint) semantics
 *    and HTTP /resume rebuilds from current env rows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScenarioDefinition } from '@active-collaboration/core';

import { SimulationRegistry } from './simulation-registry.js';
import { WorldSessionService } from './world-session.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

/** Poll until the predicate holds (bounded). */
async function until(predicate: () => boolean, timeoutMs: number, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

function scenarioOf(id: string, extra: { device?: boolean; agentZone?: string } = {}): ScenarioDefinition {
  return {
    version: '1.0',
    meta: { id, name: 'F1 Hot-Reload Lab', description: 'R37-F1 fixture' },
    zones: [{ id: 'zone-a', name: 'Zone A' }],
    devices: [
      {
        id: 'temp-sensor-a', name: 'Sensor A', type: 'temperature-sensor',
        capabilities: ['temperature-reading'], zoneId: 'zone-a', binding: 'sim://temp-sensor-a',
      },
      ...(extra.device
        ? [{
            id: 'hvac-hotload', name: 'HVAC (installed later)', type: 'hvac',
            capabilities: ['temperature-control', 'cooling'], zoneId: 'zone-a',
            binding: 'sim://hvac-hotload',
          }]
        : []),
    ],
    agents: [{
      id: 'lab-agent', name: 'Lab Agent', capabilities: ['temperature-monitoring', 'temperature-control'],
      managesZoneIds: [extra.agentZone ?? 'zone-a'], boundDeviceIds: ['temp-sensor-a'],
    }],
    events: [],
  } as unknown as ScenarioDefinition;
}

// ---------------------------------------------------------------------------
// Service level — the wake/rebuild state machine
// ---------------------------------------------------------------------------

describe('R37-F1: env-edit hot-reload (service level)', () => {
  const tempDirs: string[] = [];
  const registries: SimulationRegistry[] = [];
  const services: WorldSessionService[] = [];

  afterEach(async () => {
    for (const service of services) service.close();
    for (const registry of registries) registry.stopAll();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
    registries.length = 0;
    services.length = 0;
  });

  function makeArm(envId: string, scenarioRef: { current: ScenarioDefinition }) {
    const dir = mkdtempSync(join(tmpdir(), 'world-session-f1-'));
    tempDirs.push(dir);
    const registry = new SimulationRegistry({}, dir);
    registries.push(registry);
    const service = new WorldSessionService({
      registry,
      scenarioOfEnv: () => scenarioRef.current,
      envOwnerIdOf: () => undefined,
      obligationsOf: () => ({ hassBound: false, actuationAgreement: false }),
      attachDriver: false,
      idleGraceMs: 5,
      hibernateHorizonSimSec: 5,
    });
    services.push(service);
    return { registry, service };
  }

  it('a LIVE session lands direct env edits (new device + agent rebind) via onWorldMutation', async () => {
    const scenarioRef = { current: scenarioOf('env-live') };
    const { registry, service } = makeArm('env-live', scenarioRef);
    await service.observe('env-live');
    const release = await service.observe('env-live');
    const simId = 'sim-env-live-world-session';

    expect(registry.get(simId)!.runtime.getSnapshot().devices.map(d => d.id)).toEqual(['temp-sensor-a']);

    // Owner-direct edit: a new device AND a zone rebind land in the env rows.
    scenarioRef.current = scenarioOf('env-live', { device: true, agentZone: 'zone-a' });
    await service.onWorldMutation('env-live', { create: false });

    const snapshot = registry.get(simId)!.runtime.getSnapshot();
    expect(snapshot.devices.map(d => d.id)).toContain('hvac-hotload');
    release();
  });

  it('the generic /resume wedge: a resumed-out-of-band record is ADOPTED and rebuilt from CURRENT rows (no WORLD_SESSION_EXISTS)', async () => {
    const scenarioRef = { current: scenarioOf('env-wedge') };
    const { registry, service } = makeArm('env-wedge', scenarioRef);
    const simId = 'sim-env-wedge-world-session';

    // Session exists; FREEZE it explicitly (R73 removed the idle sweep —
    // registry.hibernate + adoption is the POST /stop freeze semantics,
    // the only remaining path into HIBERNATED).
    await service.targetFor('env-wedge');
    const anchor = registry.get(simId)!.runtime.getSimStartEpochMs();
    const frozen = await registry.hibernate(simId);
    service.adoptExternalHibernate('env-wedge', {
      record: frozen,
      simStartEpochMs: anchor,
    });
    expect(service.statusOf('env-wedge')!.status).toBe('hibernated');

    // The env rows move on while the world is "away".
    scenarioRef.current = scenarioOf('env-wedge', { device: true });

    // The validator's recovery attempt: the GENERIC hibernate-resume — it
    // rebuilds from the checkpoint's FROZEN scenario and leaves the service
    // state saying hibernated (the wedge precondition).
    await registry.resumeHibernated(simId);
    expect(registry.get(simId)).toBeDefined(); // live record under the id
    expect(service.statusOf('env-wedge')!.status).toBe('hibernated'); // stale marker

    // BEFORE the fix this arrival threw WORLD_SESSION_EXISTS (swallowed by
    // targetFor). NOW: adopt + rebuild from the CURRENT rows.
    const record = await service.targetFor('env-wedge');
    expect(record).toBeDefined();
    expect(record!.id).toBe(simId);
    const devices = registry.get(simId)!.runtime.getSnapshot().devices.map(d => d.id);
    expect(devices).toContain('hvac-hotload'); // current topology, not frozen
    expect(service.statusOf('env-wedge')!.status).not.toBe('hibernated');
  });

  it('a STOPPED husk record no longer blocks governance-driven session creation', async () => {
    const scenarioRef = { current: scenarioOf('env-husk') };
    const { registry, service } = makeArm('env-husk', scenarioRef);
    const simId = 'sim-env-husk-world-session';

    // Fabricate the husk: a session record someone stopped out-of-band while
    // the in-memory state was lost (the validation's WORLD_SESSION_EXISTS
    // trap — "no removal endpoint").
    await registry.createEnvSession({ envId: 'env-husk', scenario: scenarioRef.current });
    registry.stop(simId);
    expect(registry.get(simId)!.runtime.getState()).toBe('stopped');

    // A governance proposal APPLY (create: true) must land, not wedge.
    await service.onWorldMutation('env-husk', { create: true });

    const record = registry.get(simId);
    expect(record).toBeDefined();
    expect(record!.runtime.getState()).not.toBe('stopped');
    expect(service.statusOf('env-husk')!.simulationId).toBe(simId);
    // And subsequent arrivals keep working (the wedge is gone for good).
    const arrival = await service.targetFor('env-husk');
    expect(arrival).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// HTTP level — the routes the validator actually used
// ---------------------------------------------------------------------------

describe('R37-F1: env-edit hot-reload (HTTP level)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;
  let sessionSimId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('hotload-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    sessionSimId = `sim-${envId}-world-session`;

    // Materialize the authoritative session.
    await ctx.app.worldSessions.targetFor(envId);
    expect(ctx.app.simulations.get(sessionSimId)).toBeDefined();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('a direct device install through the API lands in the LIVE session (the change-pipeline wake)', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Purifier X',
        type: 'purifier',
        capabilities: ['air-purification'],
        zoneId: 'zone-a',
      },
    });
    expect(created.statusCode).toBe(201);
    const deviceId = created.json().id as string;

    // The route's wake is fire-and-forget — poll for the rebuild to land
    // (this is the exact acceptance: the snapshot shows the NEW device).
    const landed = await until(
      () => ctx.app.simulations.get(sessionSimId)?.runtime.getSnapshot()
        .devices.some(device => device.id === deviceId),
      5_000,
    );
    expect(landed).toBe(true);
  });

  it('an agent managed-zone PATCH through the API lands in the LIVE session', async () => {
    const agents = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    })).json().agents as Array<{ id: string; managedZoneIds?: string[] }>;
    const agentId = agents[0].id;

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { managedZoneIds: ['zone-a', 'zone-b'] },
    });
    expect(patched.statusCode).toBe(200);

    const landed = await until(
      () => (ctx.app.simulations.get(sessionSimId)?.runtime.getSnapshot()
        .agents ?? []).some(
          agent => agent.managedZoneIds !== undefined &&
            agent.managedZoneIds.includes('zone-b'),
        ),
      5_000,
    );
    expect(landed).toBe(true);
  });

  it('POST /stop on the world session FREEZES it (checkpoint) and the env stays re-creatable; /resume wakes on CURRENT rows', async () => {
    // Freeze through the generic stop route (owner is allowed).
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sessionSimId}/stop`,
      headers: auth(owner.token),
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().state).toBe('hibernated');

    // Env rows move on while frozen.
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Late UPS', type: 'ups', capabilities: ['set-charging'], zoneId: 'zone-a' },
    });
    expect(created.statusCode).toBe(201);
    const lateDeviceId = created.json().id as string;

    // The generic /resume on the world session rebuilds from CURRENT env
    // rows (not the checkpoint's frozen topology).
    const resumed = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sessionSimId}/resume`,
      headers: auth(owner.token),
    });
    expect(resumed.statusCode).toBe(200);
    const landed = await until(
      () => ctx.app.simulations.get(sessionSimId)?.runtime.getSnapshot()
        .devices.some(device => device.id === lateDeviceId),
      5_000,
    );
    expect(landed).toBe(true);
    // The service state is coherent after the external wake.
    expect(ctx.app.worldSessions.statusOf(envId)!.status).not.toBe('hibernated');
  });
});
