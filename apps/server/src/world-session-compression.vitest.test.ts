/**
 * @vitest-environment node
 *
 * T-073 (DevLoop R22, FM expectation gap) — the authoritative world
 * session's time-compression knob.
 *
 * The design reserved `simPerWallSec` (test-injected via BuildServerOptions;
 * R19's overnight dues at wall-rate 1:1 compressed "overnight" into real wall
 * hours). It is now a PRODUCTION config knob:
 * EAF_WORLD_SESSION_SIM_PER_WALL_SEC — validated at boot (positive finite
 * float), threaded through buildServer into WorldSessionService, and
 * OBSERVABLE on the worldSession status view in every state. These tests pin
 * (1) config parsing/validation and (2) that the knob deterministically
 * changes the session's advance rate through the wall-mapped catch-up.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScenarioDefinition } from '@active-collaboration/core';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { SimulationRegistry } from './simulation-registry.js';
import { WorldSessionService } from './world-session.js';

describe('config: EAF_WORLD_SESSION_SIM_PER_WALL_SEC (T-073)', () => {
  it('parses a positive finite float and defaults to unset (wall-rate 1)', () => {
    expect(loadConfig({}).worldSessionSimPerWallSec).toBeUndefined();
    expect(loadConfig({ EAF_WORLD_SESSION_SIM_PER_WALL_SEC: '30' }).worldSessionSimPerWallSec).toBe(30);
    expect(loadConfig({ EAF_WORLD_SESSION_SIM_PER_WALL_SEC: '2.5' }).worldSessionSimPerWallSec).toBe(2.5);
  });

  it('invalid values fail the boot with a teaching issue (R15-A4 discipline)', () => {
    for (const bad of ['0', '-3', 'abc', 'Infinity']) {
      expect(() => loadConfig({ EAF_WORLD_SESSION_SIM_PER_WALL_SEC: bad }))
        .toThrow(/EAF_WORLD_SESSION_SIM_PER_WALL_SEC.*is not a positive finite number/);
    }
  });
});

describe('world session: the knob changes the advance rate deterministically (T-073)', () => {
  const tempDirs: string[] = [];
  const registries: SimulationRegistry[] = [];
  const services: WorldSessionService[] = [];

  afterEach(() => {
    for (const service of services.splice(0)) service.close();
    for (const registry of registries.splice(0)) registry.stopAll();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeService(rate: number, nowRef: { now: number }): WorldSessionService {
    const dir = mkdtempSync(join(tmpdir(), 'world-session-rate-'));
    tempDirs.push(dir);
    const registry = new SimulationRegistry({}, dir);
    registries.push(registry);
    const scenario: ScenarioDefinition = {
      version: '1.0',
      meta: { id: 'rate-lab', name: 'Rate Lab', description: 'T-073 fixture' },
      zones: [{ id: 'zone-a', name: 'Zone A', bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 }, baseline: { temperature: 22 } }],
      devices: [],
      agents: [],
      events: [],
    } as unknown as ScenarioDefinition;
    const service = new WorldSessionService({
      registry,
      scenarioOfEnv: () => scenario,
      envOwnerIdOf: () => undefined,
      obligationsOf: () => ({ hassBound: false, actuationAgreement: false }),
      nowMs: () => nowRef.now,
      simPerWallSec: rate,
      attachDriver: false,
      idleGraceMs: 60_000,
    });
    services.push(service);
    return service;
  }

  async function simTimeAfterWallMs(rate: number, wallMs: number): Promise<{
    simTime: number;
    viewRate: number | undefined;
  }> {
    const nowRef = { now: 0 };
    const service = makeService(rate, nowRef);
    await service.observe('env-rate');
    const registry = registries[registries.length - 1]!;
    const record = registry.get('sim-env-rate-world-session')!;
    const anchor = record.runtime.getSimStartEpochMs();
    nowRef.now = anchor + wallMs;
    await service.targetFor('env-rate');
    return {
      simTime: record.runtime.getSimTimeSec(),
      viewRate: service.statusOf('env-rate')?.simPerWallSec,
    };
  }

  it('the same wall window advances proportionally to the knob', async () => {
    const one = await simTimeAfterWallMs(1, 2_000);
    expect(one.simTime).toBe(2);
    expect(one.viewRate).toBe(1);

    const sixty = await simTimeAfterWallMs(60, 2_000);
    expect(sixty.simTime).toBe(120);
    expect(sixty.viewRate).toBe(60);
  }, 30_000);

  it('fractional rates are legitimate (the config accepts 2.5)', async () => {
    const result = await simTimeAfterWallMs(2.5, 4_000);
    expect(result.simTime).toBe(10);
    expect(result.viewRate).toBe(2.5);
  }, 30_000);
});
