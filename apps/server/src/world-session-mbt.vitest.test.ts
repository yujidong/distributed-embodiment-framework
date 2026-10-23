/**
 * @vitest-environment node
 *
 * R84 / Wave F1-2: model-based testing of the world-session lifecycle state
 * machine (docs/lifecycles/world-session.md). fast-check generates random
 * command sequences — create / mutation(create=true|false) / observe /
 * release / freeze / wake / restart-simulate / close / fault injection
 * (flipping the env between 0-zone unsimulatable and 1-zone simulatable) —
 * and drives the REAL WorldSessionService against a real SimulationRegistry.
 *
 * Invariants asserted after EVERY command (the F1-2 pins):
 *   a. R82-F1 regression: after any world mutation, if the env is
 *      simulatable (has zones) and the service is not closed, the session
 *      must not stay absent.
 *   b. Shutdown semantics: after close() no operation creates a session.
 *   c. Session id stability: one env ever sees exactly one session id
 *      (`sim-<envId>-world-session`); rebuilds/self-heals never fork a
 *      second id.
 *   d. Transition ⇒ broadcast: every observable status transition comes
 *      with an onStatusChange frame whose final status matches (the F0
 *      frame-contract sister pin).
 *   e. Wall-anchor continuity: freeze → wake round-trips keep
 *      simStartEpochMs.
 * Plus the model/real agreement check: the service's observable status
 * always equals the model's.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { AsyncCommand } from 'fast-check';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScenarioDefinition } from '@active-collaboration/core';

import { ApiError } from './errors.js';
import { SimulationRegistry } from './simulation-registry.js';
import { WorldSessionService } from './world-session.js';
import type { WorldSessionDeps } from './world-session.js';

type ModelStatus = 'absent' | 'idle' | 'active' | 'hibernated' | 'closed';

interface SessionModel {
  status: ModelStatus;
  observers: number;
  /** The fault knob: 0 zones = scenarioOfEnv throws ENVIRONMENT_INVALID. */
  zoneCount: number;
}

interface Frame {
  envId: string;
  status: string;
  simulationId: string;
  simStartEpochMs?: number;
}

interface Real {
  envId: string;
  env: { zoneCount: number };
  registry: SimulationRegistry;
  service: WorldSessionService;
  /** Deps factory so restart-simulate can rebuild the "process" service. */
  deps: () => WorldSessionDeps;
  broadcasts: Frame[];
  releases: Array<() => void>;
  dir: string;
  /** First session id ever observed (invariant c). */
  simId?: string;
  /** Wall anchor captured when the session entered hibernated (invariant e). */
  anchorHibernatedMs?: number;
}

function zonedScenario(): ScenarioDefinition {
  return {
    version: '1.0',
    meta: { id: 'mbt-lab', name: 'MBT Lab', description: 'world-session lifecycle MBT fixture' },
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

function makeHarness(envId: string): Real {
  const dir = mkdtempSync(join(tmpdir(), 'world-session-mbt-'));
  const registry = new SimulationRegistry({}, dir);
  const env = { zoneCount: 0 };
  const broadcasts: Frame[] = [];
  const deps = (): WorldSessionDeps => ({
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
    // Fixed clock: catchUp never advances, the world stays at sim-time 0.
    nowMs: () => 0,
    onStatusChange: (changedEnvId, view) => {
      broadcasts.push({
        envId: changedEnvId,
        status: view.status,
        simulationId: view.simulationId,
        ...(view.simStartEpochMs !== undefined ? { simStartEpochMs: view.simStartEpochMs } : {}),
      });
    },
  });
  return {
    envId,
    env,
    registry,
    service: new WorldSessionService(deps()),
    deps,
    broadcasts,
    releases: [],
    dir,
  };
}

function realStatusOf(r: Real): ModelStatus {
  const view = r.service.statusOf(r.envId);
  return view === undefined ? 'absent' : view.status;
}

interface Before {
  realStatus: ModelStatus;
  broadcastCount: number;
}

/** The post-command invariant battery (a–e + model/real agreement). */
function assertInvariants(m: SessionModel, r: Real, before: Before): void {
  const after = realStatusOf(r);
  if (m.status === 'closed') {
    // (b) shutdown semantics: nothing observable, nothing broadcast.
    expect(after, 'closed service must stay absent').toBe('absent');
    expect(r.broadcasts.length, 'closed service must not broadcast').toBe(before.broadcastCount);
    return;
  }
  // Model/real agreement.
  expect(after, `model/real status mismatch (model=${m.status})`).toBe(m.status);
  // (d) transition ⇒ broadcast, final frame matches.
  if (after !== before.realStatus) {
    expect(
      r.broadcasts.length,
      `transition ${before.realStatus} → ${after} must broadcast`,
    ).toBeGreaterThan(before.broadcastCount);
    const last = r.broadcasts[r.broadcasts.length - 1]!;
    expect(last.envId).toBe(r.envId);
    expect(last.status, 'last broadcast frame must carry the new status').toBe(after);
  }
  if (after === 'absent') return;
  const view = r.service.statusOf(r.envId)!;
  // (c) session id stability.
  if (r.simId === undefined) r.simId = view.simulationId;
  expect(view.simulationId, 'session id must be stable per env').toBe(r.simId);
  // No second world-session record under another id.
  const worldRecords = r.registry.list().filter(s => s.id.endsWith('-world-session'));
  expect(worldRecords.length, 'registry must hold at most one world-session record').toBeLessThanOrEqual(1);
  if (after === 'active') {
    expect(view.observers, 'observer pin count must match the model').toBe(m.observers);
  }
  // (e) wall-anchor continuity across the hibernate boundary.
  if (after === 'hibernated' || before.realStatus === 'hibernated') {
    expect(view.simStartEpochMs, 'wall anchor must survive freeze/wake').toBe(r.anchorHibernatedMs);
  }
}

/** R82-F1 pin (a): a mutation on a simulatable env never leaves absent. */
function assertMutationHeals(m: SessionModel, r: Real): void {
  if (m.zoneCount > 0 && m.status !== 'closed') {
    expect(
      r.service.statusOf(r.envId),
      'R82-F1: mutation on a simulatable env must heal a session-less world',
    ).toBeDefined();
  }
}

abstract class SessionCommand implements AsyncCommand<SessionModel, Real> {
  abstract doRun(m: SessionModel, r: Real): Promise<void>;
  abstract updateModel(m: SessionModel, r: Real): void;
  check(_m: SessionModel): boolean {
    return true;
  }
  async run(m: SessionModel, r: Real): Promise<void> {
    const before: Before = { realStatus: realStatusOf(r), broadcastCount: r.broadcasts.length };
    await this.doRun(m, r);
    this.updateModel(m, r);
    assertInvariants(m, r, before);
  }
}

/** The create/mutation model rule shared by birth wake, mutation and wake. */
function applyEnsureLike(m: SessionModel): void {
  if (m.status === 'closed') return;
  if (m.status === 'absent' && m.zoneCount > 0) m.status = 'idle';
  else if (m.status === 'hibernated' && m.zoneCount > 0) m.status = 'idle';
  // absent+0-zone stays absent (creation fails warn-only); hibernated+0-zone
  // stays hibernated (the wake fails warn-only and retries next arrival).
}

class BirthWakeCommand extends SessionCommand {
  async doRun(_m: SessionModel, r: Real): Promise<void> {
    await r.service.onWorldMutation(r.envId, { create: true });
    assertMutationHeals(_m, r);
  }
  updateModel(m: SessionModel): void {
    applyEnsureLike(m);
  }
  toString(): string {
    return 'birth-wake(mutation create=true)';
  }
}

class MutationCommand extends SessionCommand {
  constructor(readonly create: boolean) {
    super();
  }
  async doRun(m: SessionModel, r: Real): Promise<void> {
    await r.service.onWorldMutation(r.envId, { create: this.create });
    assertMutationHeals(m, r);
  }
  updateModel(m: SessionModel): void {
    applyEnsureLike(m);
  }
  toString(): string {
    return `mutation(create=${this.create})`;
  }
}

class ObserveCommand extends SessionCommand {
  check(m: SessionModel): boolean {
    // observe() propagates creation/wake failures (unlike targetFor), so it
    // is only a legal arrival when the env can actually simulate.
    if (m.status === 'closed') return false;
    if (m.zoneCount === 0 && (m.status === 'absent' || m.status === 'hibernated')) return false;
    return true;
  }
  async doRun(_m: SessionModel, r: Real): Promise<void> {
    const release = await r.service.observe(r.envId);
    r.releases.push(release);
  }
  updateModel(m: SessionModel): void {
    m.status = 'active';
    m.observers += 1;
  }
  toString(): string {
    return 'observe()';
  }
}

/**
 * The env world stream's pin (crash-recovery semantics): pins an existing
 * session; lazily RE-MATERIALIZES a session absent after a hard restart;
 * warn-only no-op for unsimulatable envs / a closed service (the stream
 * keeps serving governance frames). Unlike observe() it never propagates.
 */
class StreamObserveCommand extends SessionCommand {
  async doRun(m: SessionModel, r: Real): Promise<void> {
    const release = await r.service.observeOrMaterialize(r.envId);
    if (this.pins(m)) r.releases.push(release);
  }
  /** Whether the call acquires a real pin (vs the warn-only no-op). */
  private pins(m: SessionModel): boolean {
    if (m.status === 'closed') return false;
    if (m.status === 'idle' || m.status === 'active') return true;
    // absent/hibernated: the materialize/wake lands only on simulatable envs.
    return m.zoneCount > 0;
  }
  updateModel(m: SessionModel): void {
    if (!this.pins(m)) return; // warn-only no-op: nothing observable changes
    m.status = 'active';
    m.observers += 1;
  }
  toString(): string {
    return 'stream-observe(observeOrMaterialize)';
  }
}

class ReleaseCommand extends SessionCommand {
  check(m: SessionModel): boolean {
    return m.observers > 0;
  }
  async doRun(_m: SessionModel, r: Real): Promise<void> {
    const release = r.releases.shift()!;
    release();
  }
  updateModel(m: SessionModel): void {
    m.observers -= 1;
    if (m.observers === 0 && m.status === 'active') m.status = 'idle';
  }
  toString(): string {
    return 'release()';
  }
}

class FreezeCommand extends SessionCommand {
  check(m: SessionModel): boolean {
    return m.status === 'idle' || m.status === 'active';
  }
  async doRun(_m: SessionModel, r: Real): Promise<void> {
    // The POST /stop freeze semantics (routes/simulations-world-session.ts):
    // registry.hibernate checkpoints + releases the runtime, then the route
    // hands the hibernated record back via adoptExternalHibernate.
    const simId = `sim-${r.envId}-world-session`;
    const record = r.registry.get(simId);
    expect(record, 'freeze requires a live session record').toBeDefined();
    const anchorMs = record!.runtime.getSimStartEpochMs();
    const frozen = await r.registry.hibernate(simId);
    r.service.adoptExternalHibernate(r.envId, { record: frozen, simStartEpochMs: anchorMs });
    r.anchorHibernatedMs = anchorMs;
    r.releases = []; // outstanding pins are stale across the freeze
  }
  updateModel(m: SessionModel): void {
    m.status = 'hibernated';
    m.observers = 0;
  }
  toString(): string {
    return 'freeze(POST stop)';
  }
}

class WakeCommand extends SessionCommand {
  check(m: SessionModel): boolean {
    return m.status !== 'closed';
  }
  async doRun(_m: SessionModel, r: Real): Promise<void> {
    await r.service.targetFor(r.envId);
  }
  updateModel(m: SessionModel): void {
    applyEnsureLike(m);
  }
  toString(): string {
    return 'wake(targetFor)';
  }
}

class RestartSimulateCommand extends SessionCommand {
  check(m: SessionModel): boolean {
    return m.status === 'hibernated';
  }
  async doRun(_m: SessionModel, r: Real): Promise<void> {
    // Boot adoption (server.ts startup scan): the "old process" service is
    // gone; a fresh service adopts the hibernated checkpoint record.
    const simId = `sim-${r.envId}-world-session`;
    const hibernated = r.registry.getHibernated(simId);
    expect(hibernated, 'restart requires an on-registry checkpoint').toBeDefined();
    r.service.close();
    r.service = new WorldSessionService(r.deps());
    const view = r.service.adoptHibernated(r.envId, {
      record: hibernated!,
      simStartEpochMs: r.anchorHibernatedMs!,
    });
    expect(view?.status, 'boot adoption surfaces the hibernated view').toBe('hibernated');
  }
  updateModel(_m: SessionModel): void {
    // hibernated → hibernated
  }
  toString(): string {
    return 'restart-simulate(adoptHibernated)';
  }
}

class CloseCommand extends SessionCommand {
  check(m: SessionModel): boolean {
    return m.status !== 'closed';
  }
  async doRun(_m: SessionModel, r: Real): Promise<void> {
    r.service.close();
    r.releases = [];
  }
  updateModel(m: SessionModel): void {
    m.status = 'closed';
    m.observers = 0;
  }
  toString(): string {
    return 'close()';
  }
}

/** Fault action: flip the env between 0-zone (creation必失败) and zoned. */
class SetZonesCommand extends SessionCommand {
  constructor(readonly zoneCount: number) {
    super();
  }
  async doRun(_m: SessionModel, r: Real): Promise<void> {
    r.env.zoneCount = this.zoneCount;
  }
  updateModel(m: SessionModel): void {
    m.zoneCount = this.zoneCount;
  }
  toString(): string {
    return `fault:setZones(${this.zoneCount})`;
  }
}

function commandArbitraries(): Array<fc.Arbitrary<AsyncCommand<SessionModel, Real>>> {
  const mutation = fc.boolean().map(create => new MutationCommand(create));
  // Zone flips bias toward SIMULATABLE (1) so sequences spend most of their
  // length with a live session — the 0-zone fault is the spice, not the base.
  const setZones = fc.constantFrom(1, 1, 0).map(zoneCount => new SetZonesCommand(zoneCount));
  // Duplicates = weights. Mutations and zone flips stay common so the R82
  // self-heal window (absent + zoned + mutation) is hit in most sequences;
  // observe/freeze/restart are weighted up because their check() gates keep
  // them rare in a mostly-absent stream; close stays rare (it ends the game).
  return [
    fc.constant(new BirthWakeCommand()),
    mutation, mutation, mutation,
    fc.constant(new ObserveCommand()), fc.constant(new ObserveCommand()), fc.constant(new ObserveCommand()),
    fc.constant(new StreamObserveCommand()), fc.constant(new StreamObserveCommand()),
    fc.constant(new ReleaseCommand()), fc.constant(new ReleaseCommand()),
    fc.constant(new FreezeCommand()), fc.constant(new FreezeCommand()), fc.constant(new FreezeCommand()),
    fc.constant(new WakeCommand()),
    fc.constant(new RestartSimulateCommand()), fc.constant(new RestartSimulateCommand()),
    setZones, setZones,
    fc.constant(new CloseCommand()),
  ];
}

describe('F1-2 MBT: world-session lifecycle state machine', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'random command sequences keep the lifecycle invariants (incl. the R82-F1 heal pin)',
    { timeout: 180_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.commands(commandArbitraries(), { maxCommands: 32, size: 'max' }), async (commands) => {
          const real = makeHarness('env-mbt');
          tempDirs.push(real.dir);
          const model: SessionModel = { status: 'absent', observers: 0, zoneCount: 0 };
          try {
            await fc.asyncModelRun(() => ({ model, real }), commands);
          } finally {
            real.service.close();
            real.registry.stopAll();
          }
        }),
        { numRuns: 60 },
      );
    },
  );
});
