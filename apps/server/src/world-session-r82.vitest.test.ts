/**
 * @vitest-environment node
 *
 * R82 regression: an env whose birth-time world-session creation FAILED
 * (R73 wakes a blank 0-zone world at creation — ENVIRONMENT_INVALID "no
 * zones yet" is correct teaching) must heal on the NEXT world mutation.
 * Before the fix, onWorldMutation with create=false on a session-less env
 * returned early ("no session, create=false — returning"), so the guided
 * "create the first zone" flow (owner direct edits → env-direct-edit →
 * create:false) never recreated the session: the world stayed dead forever.
 *
 * The hook only fires on world-mutating change-pipeline kinds, so each
 * invocation IS the topology-change signal worth one creation retry;
 * failures stay on the warn-only path (a world edit never fails because
 * the world cannot yet simulate).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScenarioDefinition } from '@active-collaboration/core';

import { ApiError } from './errors.js';
import { SimulationRegistry } from './simulation-registry.js';
import { WorldSessionService } from './world-session.js';

/** Minimal valid world once the first zone exists. */
function zonedScenario(): ScenarioDefinition {
  return {
    version: '1.0',
    meta: { id: 'r82-lab', name: 'R82 Lab', description: 'heal-after-blank-birth fixture' },
    zones: [
      {
        id: 'zone-a', name: 'Zone A',
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
        baseline: { temperature: 22 },
      },
    ],
    devices: [],
    agents: [],
    events: [],
  } as unknown as ScenarioDefinition;
}

describe('R82: a session-less env retries world-session creation on world mutations', () => {
  const tempDirs: string[] = [];
  const registries: SimulationRegistry[] = [];
  const services: WorldSessionService[] = [];

  afterEach(() => {
    for (const service of services.splice(0)) service.close();
    for (const registry of registries.splice(0)) registry.stopAll();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The env starts blank: scenarioOfEnv throws the same ENVIRONMENT_INVALID
   * the environment bridge raises for a 0-zone world until the test "creates
   * the first zone" by flipping zoneCount.
   */
  function makeService(envId: string, env: { zoneCount: number }) {
    const dir = mkdtempSync(join(tmpdir(), 'world-session-r82-'));
    tempDirs.push(dir);
    const registry = new SimulationRegistry({}, dir);
    registries.push(registry);
    // server.ts wires this dep to worldSync.publishWorldSession — collecting
    // the calls here asserts the creation path BROADCASTS the frame (the web
    // client now depends on it to surface the session without a reload).
    const broadcasts: Array<{ envId: string; status: string; simulationId: string }> = [];
    const service = new WorldSessionService({
      registry,
      scenarioOfEnv: () => {
        if (env.zoneCount === 0) {
          throw new ApiError(
            400,
            'ENVIRONMENT_INVALID',
            `Environment "${envId}" cannot be simulated — the environment has no zones yet.`,
          );
        }
        return zonedScenario();
      },
      envOwnerIdOf: () => undefined,
      obligationsOf: () => ({ hassBound: false, actuationAgreement: false }),
      attachDriver: false,
      onStatusChange: (changedEnvId, view) => {
        broadcasts.push({ envId: changedEnvId, status: view.status, simulationId: view.simulationId });
      },
    });
    services.push(service);
    return { registry, service, broadcasts };
  }

  it('blank env (0 zones) → birth wake fails → first zone lands via create:false → session materializes', async () => {
    const env = { zoneCount: 0 };
    const { registry, service, broadcasts } = makeService('env-r82', env);

    // R73 birth wake (create:true) on the blank env: fails by design, and
    // the failure is warn-only — no session, no throw, no frame.
    await service.onWorldMutation('env-r82', { create: true });
    expect(service.statusOf('env-r82')).toBeUndefined();
    expect(broadcasts).toHaveLength(0);

    // Direct edits while the world is still zoneless: each one retries the
    // creation once, fails the same deterministic way, never throws.
    await service.onWorldMutation('env-r82', { create: false });
    expect(service.statusOf('env-r82')).toBeUndefined();

    // The guided "create the first zone" flow lands an env-direct-edit
    // (create:false) — the world is simulatable now, so the session heals.
    env.zoneCount = 1;
    await service.onWorldMutation('env-r82', { create: false });
    expect(service.statusOf('env-r82')).toBeDefined();
    expect(registry.get('sim-env-r82-world-session')).toBeDefined();

    // The self-heal CREATION broadcasts a world-session frame on the env
    // stream (wired in server.ts → worldSync.publishWorldSession), so pages
    // already open on the env learn the simulationId without a reload.
    expect(
      broadcasts.some(
        frame =>
          frame.envId === 'env-r82' &&
          frame.status === 'idle' &&
          frame.simulationId === 'sim-env-r82-world-session',
      ),
    ).toBe(true);

    // The next mutation takes the existing-session refresh path — no
    // duplicate create, the session id is stable.
    await service.onWorldMutation('env-r82', { create: false });
    expect(service.statusOf('env-r82')?.simulationId).toBe('sim-env-r82-world-session');
  });

  it('a closed service still returns without creating (shutdown semantics unchanged)', async () => {
    const env = { zoneCount: 1 };
    const { registry, service } = makeService('env-r82-closed', env);
    service.close();
    await service.onWorldMutation('env-r82-closed', { create: false });
    expect(service.statusOf('env-r82-closed')).toBeUndefined();
    expect(registry.get('sim-env-r82-closed-world-session')).toBeUndefined();
  });
});
