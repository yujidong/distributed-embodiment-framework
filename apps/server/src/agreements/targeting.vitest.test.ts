/**
 * @vitest-environment node
 *
 * T91 (R13, u2-F1): the read-source probe's target-selection table — the
 * pure contract shared by the READ default lane (readDefaultWorldChoiceOf)
 * and the catalog probe (readSourceProbeTargetOf, consumed by server.ts'
 * readSourceWritabilityJudgeOf).
 *
 * The r13 replay: after the T86 observer-perspective refactor the probe went
 * silent for EVERY non-own-sim viewer shape (own-sim AMBIGUOUS returned
 * "no world to judge" instead of following the read lane's fallback), so the
 * layered never-written ⚠ — the only pre-signing read expectation the
 * market face gives — vanished exactly where help promised it. These tests
 * pin the shared table: own-sim exact-one probes it; absent AND ambiguous
 * fall through to the LIVE world session; a GET never creates/wakes one
 * (absent/hibernated/stopped = honest unknown, no verdict from thin air).
 */

import { describe, expect, it } from 'vitest';

import { defaultSimNoteOf, readDefaultWorldChoiceOf, readSourceProbeTargetOf } from './targeting.js';
import type { SimulationRecord } from '../simulation-registry.js';

function fakeRecord(overrides: {
  id: string;
  createdBy?: string;
  envSession?: boolean;
  state?: string;
  environmentId?: string;
}): SimulationRecord {
  const state = overrides.state ?? 'running';
  return {
    id: overrides.id,
    scenarioId: 'scenario',
    createdBy: overrides.createdBy,
    ...(overrides.environmentId !== undefined ? { environmentId: overrides.environmentId } : {}),
    ...(overrides.envSession !== undefined ? { envSession: overrides.envSession } : {}),
    runtime: { getState: () => state } as unknown as SimulationRecord['runtime'],
  } as unknown as SimulationRecord;
}

function deps(options: {
  envOwnerId?: string;
  running: SimulationRecord[];
  session?: { state?: string; simulationId: string } | undefined;
  /** T122: the env's default-simulation binding (raw column value). */
  defaultSimulationId?: string | null;
}) {
  return {
    envStore: {
      getEnvironment: (_id: string) =>
        options.envOwnerId !== undefined || options.defaultSimulationId !== undefined
          ? {
              owner_id: options.envOwnerId ?? 'user-env-owner',
              ...(options.defaultSimulationId !== undefined
                ? { default_simulation_id: options.defaultSimulationId }
                : {}),
            }
          : undefined,
    },
    registry: {
      runningAllForEnvironment: (_id: string) => options.running,
      get: (simId: string) => options.running.find(record => record.id === simId),
    },
    ...(options.session !== undefined ? { worldSessions: { statusOf: (_id: string) => options.session } } : {}),
  };
}

const ENV = 'env-1';
const VIEWER = 'user-member';

describe('readDefaultWorldChoiceOf (the shared read-lane adjudication)', () => {
  it('exactly one targetable own sim → own-sim; several → ambiguous; none → world-session', () => {
    const mine = fakeRecord({ id: 'sim-mine', createdBy: VIEWER });
    expect(readDefaultWorldChoiceOf(deps({ running: [mine] }), ENV, VIEWER)).toEqual({
      kind: 'own-sim',
      record: mine,
    });
    const mine2 = fakeRecord({ id: 'sim-mine-2', createdBy: VIEWER });
    const ambiguous = readDefaultWorldChoiceOf(deps({ running: [mine, mine2] }), ENV, VIEWER);
    expect(ambiguous.kind).toBe('ambiguous');
    // platform (envSession) rows never count as the viewer's own sim
    const session = fakeRecord({ id: 'sim-env-session', envSession: true, state: 'running' });
    expect(
      readDefaultWorldChoiceOf(deps({ running: [mine, mine2, session] }), ENV, VIEWER).kind,
    ).toBe('ambiguous');
    expect(readDefaultWorldChoiceOf(deps({ running: [session] }), ENV, VIEWER)).toEqual({
      kind: 'world-session',
    });
  });

  it('T96 (R14, u4-P2): the ENV OWNER\'s running sim is NOT a member\'s default candidate', () => {
    // The r14 shape: a member with no sims reads her meter while the owner
    // runs exactly one sim — the default read used to silently land on the
    // OWNER's sim (data source drifting with other testers' sim churn). The
    // owner is "another member" for the default lane: fall through to the
    // authoritative world session.
    const ownerSim = fakeRecord({ id: 'sim-owner', createdBy: 'user-env-owner' });
    expect(
      readDefaultWorldChoiceOf(
        deps({ running: [ownerSim], envOwnerId: 'user-env-owner' }),
        ENV,
        VIEWER,
      ),
    ).toEqual({ kind: 'world-session' });
    // ...and the owner HERSELF still gets her own sim (it IS hers).
    expect(
      readDefaultWorldChoiceOf(
        deps({ running: [ownerSim], envOwnerId: 'user-env-owner' }),
        ENV,
        'user-env-owner',
      ),
    ).toEqual({ kind: 'own-sim', record: ownerSim });
    // a member's own sim WINS over a simultaneously running foreign sim —
    // no spurious ambiguity, the help's promise ("YOUR running sim") holds.
    const mine = fakeRecord({ id: 'sim-mine', createdBy: VIEWER });
    expect(
      readDefaultWorldChoiceOf(
        deps({ running: [mine, ownerSim], envOwnerId: 'user-env-owner' }),
        ENV,
        VIEWER,
      ),
    ).toEqual({ kind: 'own-sim', record: mine });
  });

  it('T96: platform rows (createdBy undefined) stay default-targetable; anonymous viewers too', () => {
    const platformSim = fakeRecord({ id: 'sim-platform', createdBy: undefined });
    expect(
      readDefaultWorldChoiceOf(deps({ running: [platformSim] }), ENV, VIEWER),
    ).toEqual({ kind: 'own-sim', record: platformSim });
    expect(
      readDefaultWorldChoiceOf(deps({ running: [platformSim] }), ENV, undefined),
    ).toEqual({ kind: 'own-sim', record: platformSim });
    // a member's sim is NOT the anonymous viewer's own
    const mine = fakeRecord({ id: 'sim-mine', createdBy: VIEWER });
    expect(readDefaultWorldChoiceOf(deps({ running: [mine] }), ENV, undefined)).toEqual({
      kind: 'world-session',
    });
  });
});

describe('T122 (R17-u3/R19-u4): the env default-simulation binding — the highest-priority leg', () => {
  it('a LIVE binding wins over own-sim / ambiguous / session — for any caller', () => {
    const bound = fakeRecord({ id: 'sim-bound', createdBy: 'user-env-owner', environmentId: ENV });
    const mine = fakeRecord({ id: 'sim-mine', createdBy: VIEWER, environmentId: ENV });
    // one member's own sim would normally win — the binding outranks it
    expect(
      readDefaultWorldChoiceOf(deps({ running: [bound, mine], defaultSimulationId: 'sim-bound' }), ENV, VIEWER),
    ).toEqual({ kind: 'default-binding', record: bound });
    // two own sims would normally be ambiguous — the binding disambiguates
    const mine2 = fakeRecord({ id: 'sim-mine-2', createdBy: VIEWER, environmentId: ENV });
    expect(
      readDefaultWorldChoiceOf(deps({ running: [bound, mine, mine2], defaultSimulationId: 'sim-bound' }), ENV, VIEWER).kind,
    ).toBe('default-binding');
    // no own sims at all → the binding (not the session) answers
    expect(
      readDefaultWorldChoiceOf(deps({ running: [bound], defaultSimulationId: 'sim-bound' }), ENV, VIEWER),
    ).toEqual({ kind: 'default-binding', record: bound });
    // ...and the disclosure names it
    const choice = readDefaultWorldChoiceOf(
      deps({ running: [bound], defaultSimulationId: 'sim-bound' }), ENV, VIEWER,
    );
    expect(defaultSimNoteOf(choice)).toContain('使用环境默认仿真 sim-bound');
  });

  it('a STALE binding is inert: the adjudication falls through with the honest annotation', () => {
    const mine = fakeRecord({ id: 'sim-mine', createdBy: VIEWER, environmentId: ENV });
    const mine2 = fakeRecord({ id: 'sim-mine-2', createdBy: VIEWER, environmentId: ENV });
    // STOPPED bound sim: `registry.get` keeps non-running rows, the judge
    // reads the state → falls to ambiguous (the pre-T122 answer) + stale note
    const stopped = fakeRecord({ id: 'sim-stopped', state: 'stopped', environmentId: ENV });
    const ambiguous = readDefaultWorldChoiceOf(
      deps({ running: [mine, mine2, stopped], defaultSimulationId: 'sim-stopped' }),
      ENV, VIEWER,
    );
    expect(ambiguous).toMatchObject({ kind: 'ambiguous', staleBinding: { simulationId: 'sim-stopped', reason: 'not-running' } });
    const ambiguousNote = defaultSimNoteOf(ambiguous)!;
    expect(ambiguousNote).toContain('已停止运行');
    expect(ambiguousNote).toContain('set-default-sim');
    // DELETED bound sim (server restart): `registry.get` misses → same story
    const missing = readDefaultWorldChoiceOf(
      deps({ running: [mine, mine2], defaultSimulationId: 'sim-gone' }),
      ENV, VIEWER,
    );
    expect(missing).toMatchObject({ kind: 'ambiguous', staleBinding: { simulationId: 'sim-gone', reason: 'missing' } });
    // with NO own sims, a stale binding falls to the session leg (annotated)
    const worldSession = readDefaultWorldChoiceOf(
      deps({ running: [], defaultSimulationId: 'sim-gone' }),
      ENV, VIEWER,
    );
    expect(worldSession).toMatchObject({ kind: 'world-session', staleBinding: { reason: 'missing' } });
    expect(defaultSimNoteOf(worldSession)).toContain('已不存在');
  });

  it('T127 (R20-u2 F2): a stale binding falling through to the caller\'s single own sim DISCLOSES the fall-back', () => {
    // The r20 shape: the owner's bound sim stopped; the reader's single own
    // sim answered instead — the world switched SILENTLY (provenance honest,
    // human face mute). The own-sim leg now carries the stale annotation and
    // the note names the dead binding, the world that answered, and the fix.
    const mine = fakeRecord({ id: 'sim-mine', createdBy: VIEWER, environmentId: ENV });
    const stopped = fakeRecord({ id: 'sim-stopped', createdBy: 'user-env-owner', state: 'stopped', environmentId: ENV });
    const choice = readDefaultWorldChoiceOf(
      deps({ running: [mine, stopped], defaultSimulationId: 'sim-stopped' }),
      ENV, VIEWER,
    );
    expect(choice).toMatchObject({
      kind: 'own-sim',
      record: mine,
      staleBinding: { simulationId: 'sim-stopped', reason: 'not-running' },
    });
    const note = defaultSimNoteOf(choice)!;
    expect(note).toContain('sim-stopped');
    expect(note).toContain('已停止运行');
    expect(note).toContain('sim-mine'); // the world that actually answered
    expect(note).toContain('set-default-sim');
    // The DELETED-binding variant (server restart) discloses the same way.
    const deleted = readDefaultWorldChoiceOf(
      deps({ running: [mine], defaultSimulationId: 'sim-gone' }),
      ENV, VIEWER,
    );
    expect(deleted).toMatchObject({ kind: 'own-sim', record: mine, staleBinding: { simulationId: 'sim-gone', reason: 'missing' } });
    expect(defaultSimNoteOf(deleted)).toContain('已不存在');
    // A LIVE binding on the own-sim shape still wins outright — the note
    // stays the plain disclosure (default-binding leg), no stale annotation.
    const bound = fakeRecord({ id: 'sim-bound', createdBy: 'user-env-owner', environmentId: ENV });
    const live = readDefaultWorldChoiceOf(
      deps({ running: [bound, mine], defaultSimulationId: 'sim-bound' }),
      ENV, VIEWER,
    );
    expect(live).toEqual({ kind: 'default-binding', record: bound });
  });

  it('no binding (null/absent) → the legacy adjudication, byte-identical semantics and no note', () => {
    const mine = fakeRecord({ id: 'sim-mine', createdBy: VIEWER, environmentId: ENV });
    expect(
      readDefaultWorldChoiceOf(deps({ running: [mine], defaultSimulationId: null }), ENV, VIEWER),
    ).toEqual({ kind: 'own-sim', record: mine });
    const worldSession = readDefaultWorldChoiceOf(deps({ running: [], defaultSimulationId: null }), ENV, VIEWER);
    expect(worldSession).toEqual({ kind: 'world-session' });
    expect(defaultSimNoteOf(worldSession)).toBeUndefined();
  });

  it('the probe consumer treats a default-binding sim as the own-sim probe lane (T122 × T91)', () => {
    const bound = fakeRecord({ id: 'sim-bound', createdBy: 'user-env-owner', environmentId: ENV });
    const target = readSourceProbeTargetOf(
      deps({ running: [bound], defaultSimulationId: 'sim-bound' }),
      ENV,
      VIEWER,
    );
    expect(target).toEqual({ record: bound, probedLane: 'own-sim' });
  });
});

describe('readSourceProbeTargetOf (the probe consumer — T91)', () => {
  it('exactly one own sim → the probe judges it on the own-sim lane (even when a session is also live)', () => {
    const mine = fakeRecord({ id: 'sim-mine', createdBy: VIEWER });
    const target = readSourceProbeTargetOf(
      deps({
        running: [mine],
        session: { state: 'running', simulationId: 'sim-env-session' },
      }),
      ENV,
      VIEWER,
    );
    expect(target).toEqual({ record: mine, probedLane: 'own-sim' });
  });

  it('own-sim ABSENT + LIVE session → the probe follows the read lane\'s fallback onto the session (world-session lane)', () => {
    const sessionRecord = fakeRecord({ id: 'sim-env-session', envSession: true });
    const target = readSourceProbeTargetOf(
      deps({
        running: [sessionRecord],
        session: { state: 'running', simulationId: 'sim-env-session' },
      }),
      ENV,
      VIEWER,
    );
    expect(target).toEqual({ record: sessionRecord, probedLane: 'world-session' });
  });

  it('own-sim AMBIGUOUS + LIVE session → the probe follows the fallback too (the r13 silence is the bug)', () => {
    const mine = fakeRecord({ id: 'sim-mine', createdBy: VIEWER });
    const mine2 = fakeRecord({ id: 'sim-mine-2', createdBy: VIEWER });
    const sessionRecord = fakeRecord({ id: 'sim-env-session', envSession: true });
    const target = readSourceProbeTargetOf(
      deps({
        running: [mine, mine2, sessionRecord],
        session: { state: 'running', simulationId: 'sim-env-session' },
      }),
      ENV,
      VIEWER,
    );
    expect(target).toEqual({ record: sessionRecord, probedLane: 'world-session' });
  });

  it('a GET never creates/wakes a session: absent, hibernated, or stopped → honest unknown (undefined)', () => {
    const mine = fakeRecord({ id: 'sim-mine', createdBy: VIEWER });
    const mine2 = fakeRecord({ id: 'sim-mine-2', createdBy: VIEWER });
    // no session service answer at all
    expect(readSourceProbeTargetOf(deps({ running: [mine, mine2] }), ENV, VIEWER)).toBeUndefined();
    // hibernated: the runtime is released — the read would WAKE it, the probe stays silent
    expect(
      readSourceProbeTargetOf(
        deps({
          running: [mine, mine2],
          session: { state: 'hibernated', simulationId: 'sim-env-session' },
        }),
        ENV,
        VIEWER,
      ),
    ).toBeUndefined();
    // session view live but the runtime stopped out-of-band → nothing judgeable
    expect(
      readSourceProbeTargetOf(
        deps({
          running: [mine, mine2],
          session: { state: 'running', simulationId: 'sim-env-session' },
        }),
        ENV,
        VIEWER,
      ),
    ).toBeUndefined();
  });

  it('the probe never mints a verdict from ANOTHER member\'s sim (T86 boundary held on every shape)', () => {
    const foreign = fakeRecord({ id: 'sim-foreign', createdBy: 'user-someone-else' });
    // absent own sims + foreign sim running + no session → the only live
    // world is one the viewer's reads could only 403 — honest unknown.
    expect(readSourceProbeTargetOf(deps({ running: [foreign] }), ENV, VIEWER)).toBeUndefined();
    // ambiguous own roster + foreign sim → the fallback is still the SESSION, never the foreign sim
    const mine = fakeRecord({ id: 'sim-mine', createdBy: VIEWER });
    const mine2 = fakeRecord({ id: 'sim-mine-2', createdBy: VIEWER });
    expect(
      readSourceProbeTargetOf(deps({ running: [mine, mine2, foreign] }), ENV, VIEWER),
    ).toBeUndefined();
  });
});
