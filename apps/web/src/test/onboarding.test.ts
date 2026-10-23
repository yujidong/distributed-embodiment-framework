/**
 * W1b onboarding derivation tests: GET /api/me/overview → the 新手引导
 * checklist step states (lib/onboarding.ts). Completion rules see the lib
 * header — R2-FEAT-07 made ② require blueprint lineage (`myBlueprintInstalls`)
 * and stopped crediting the auto-started world session for ③, so a
 * starter-home import no longer completes the whole checklist in one shot.
 */

import { describe, expect, it } from 'vitest';

import type { MeOverview, MeOverviewEnv } from '../api/types';
import { deriveOnboarding } from '../lib/onboarding';

function makeEnv(id: string, overrides: Partial<MeOverviewEnv> = {}): MeOverviewEnv {
  return {
    id,
    name: `环境${id}`,
    mapType: 'grid',
    myRole: 'owner',
    myAgents: 0,
    myDevices: 0,
    myServices: 0,
    mySubscriptions: 0,
    runningSimulations: 0,
    runningSimulationIds: [],
    myRunningSimulations: 0,
    simulationCount: 0,
    myBlueprintInstalls: 0,
    ...overrides,
  };
}

function makeOverview(overrides: Partial<MeOverview> = {}): MeOverview {
  const environments = overrides.environments ?? [];
  return {
    user: { id: 'u1', email: 'a@b.c', displayName: '小A', createdAt: '2026-01-01T00:00:00Z' },
    environments,
    totals: {
      environments: environments.length,
      myAgents: environments.reduce((sum, env) => sum + env.myAgents, 0),
      myDevices: environments.reduce((sum, env) => sum + env.myDevices, 0),
      myServices: environments.reduce((sum, env) => sum + env.myServices, 0),
      mySubscriptions: environments.reduce((sum, env) => sum + env.mySubscriptions, 0),
      runningSimulations: environments.reduce((sum, env) => sum + env.runningSimulations, 0),
      myRunningSimulations: environments.reduce((sum, env) => sum + (env.myRunningSimulations ?? 0), 0),
      simulationCount: environments.reduce((sum, env) => sum + env.simulationCount, 0),
    },
    todos: { pendingProposals: 0, pendingAgreements: 0, unreadNotifications: 0 },
    myServices: [],
    mySubscriptions: [],
    ...overrides,
  };
}

function stepDone(state: ReturnType<typeof deriveOnboarding>, id: string): boolean {
  return state.steps.find(step => step.id === id)?.done === true;
}

describe('deriveOnboarding', () => {
  it('starts with all three steps undone and no env target when the user has nothing', () => {
    const state = deriveOnboarding(makeOverview());
    expect(state.steps.map(step => step.id)).toEqual([
      'createEnvironment',
      'installBlueprint',
      'runSimulation',
    ]);
    expect(state.allDone).toBe(false);
    expect(state.firstEnvId).toBeNull();
    expect(state.steps.every(step => !step.done)).toBe(true);
  });

  it('completes ① once any environment exists, exposing it as the deep-link target', () => {
    const state = deriveOnboarding(makeOverview({ environments: [makeEnv('env-1')] }));
    expect(stepDone(state, 'createEnvironment')).toBe(true);
    expect(stepDone(state, 'installBlueprint')).toBe(false);
    expect(stepDone(state, 'runSimulation')).toBe(false);
    expect(state.firstEnvId).toBe('env-1');
    expect(state.allDone).toBe(false);
  });

  it('R2-FEAT-07: a starter-home import (devices+agents credited, world session auto-started) completes ① ONLY', () => {
    // The pre-fix bug: myDevices>0 + hasWorldSession + hasEnvironment made
    // allDone true the instant the import landed — the checklist vanished
    // exactly when the newbie needed steps ②③.
    const state = deriveOnboarding(
      makeOverview({
        environments: [
          makeEnv('env-1', { myDevices: 4, myAgents: 2, hasWorldSession: true }),
        ],
      }),
    );
    expect(stepDone(state, 'createEnvironment')).toBe(true);
    expect(stepDone(state, 'installBlueprint')).toBe(false);
    expect(stepDone(state, 'runSimulation')).toBe(false);
    expect(state.allDone).toBe(false);
  });

  it('completes ② only on blueprint lineage (myBlueprintInstalls > 0)', () => {
    const state = deriveOnboarding(
      makeOverview({ environments: [makeEnv('env-1', { myBlueprintInstalls: 3 })] }),
    );
    expect(stepDone(state, 'installBlueprint')).toBe(true);
  });

  it('falls back to the old ownership rule when the server predates myBlueprintInstalls', () => {
    // Legacy server: the field is absent on EVERY env — keep the old
    // "myDevices/myAgents > 0" approximation rather than stranding users.
    const legacyEnv = makeEnv('env-1', { myDevices: 2 }) as Partial<MeOverviewEnv>;
    delete legacyEnv.myBlueprintInstalls;
    const state = deriveOnboarding(
      makeOverview({ environments: [legacyEnv as MeOverviewEnv] }),
    );
    expect(stepDone(state, 'installBlueprint')).toBe(true);
  });

  it('completes ③ when a simulation was EVER created, even after it stopped (simulationCount)', () => {
    const byTotals = deriveOnboarding(
      makeOverview({ totals: { ...makeOverview().totals, simulationCount: 1 } }),
    );
    expect(stepDone(byTotals, 'runSimulation')).toBe(true);
    const byEnv = deriveOnboarding(
      makeOverview({ environments: [makeEnv('env-1', { simulationCount: 2 })] }),
    );
    expect(stepDone(byEnv, 'runSimulation')).toBe(true);
  });

  it('R2-FEAT-07: the auto-started world session alone does NOT complete ③', () => {
    // R73 starts a world session on every create path with zero user action;
    // crediting it (the old R6-D-F02 branch) hid step ③ forever.
    const state = deriveOnboarding(
      makeOverview({ environments: [makeEnv('env-1', { hasWorldSession: true })] }),
    );
    expect(stepDone(state, 'runSimulation')).toBe(false);
  });

  it('falls back to live sims for pre-simulationCount servers (own creations preferred)', () => {
    const legacyEnv = makeEnv('env-1', {
      runningSimulations: 1,
      runningSimulationIds: ['sim-1'],
      myRunningSimulations: 1,
    }) as Partial<MeOverviewEnv>;
    delete legacyEnv.simulationCount;
    const legacy = makeOverview({ environments: [legacyEnv as MeOverviewEnv] });
    (legacy.totals as { simulationCount?: number }).simulationCount = undefined;
    expect(stepDone(deriveOnboarding(legacy), 'runSimulation')).toBe(true);
  });

  it('reports allDone once every step is genuinely complete', () => {
    const state = deriveOnboarding(
      makeOverview({
        environments: [
          makeEnv('env-1', {
            myDevices: 2,
            myBlueprintInstalls: 2,
            simulationCount: 1,
          }),
        ],
      }),
    );
    expect(state.allDone).toBe(true);
  });
});
