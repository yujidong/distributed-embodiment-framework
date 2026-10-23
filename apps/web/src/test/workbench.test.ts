/**
 * Workbench derivation tests (W5): GET /api/me/overview → the 工作台 cards,
 * empty-state detection, and the optimistic unsubscribe recomputation.
 */

import { describe, expect, it } from 'vitest';

import type { MeOverview, MeOverviewEnv } from '../api/types';
import { isWorkbenchEmpty, unsubscribeFromOverview, workbenchCards } from '../lib/workbench';

function makeEnv(id: string, overrides: Partial<MeOverviewEnv> = {}): MeOverviewEnv {
  return {
    id,
    name: `环境${id}`,
    mapType: 'grid',
    myRole: 'owner',
    myAgents: 1,
    myDevices: 2,
    myServices: 1,
    mySubscriptions: 0,
    runningSimulations: 0,
    runningSimulationIds: [],
    simulationCount: 0,
    ...overrides,
  };
}

function makeOverview(overrides: Partial<MeOverview> = {}): MeOverview {
  const environments = overrides.environments ?? [makeEnv('env-1')];
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
      simulationCount: environments.reduce((sum, env) => sum + env.simulationCount, 0),
    },
    todos: { pendingProposals: 0, pendingAgreements: 0, unreadNotifications: 0 },
    myServices: [],
    mySubscriptions: [],
    ...overrides,
  };
}

describe('workbenchCards', () => {
  it('passes envs through in order and exposes the first attachable sim', () => {
    const overview = makeOverview({
      environments: [
        makeEnv('env-1'),
        makeEnv('env-2', { runningSimulations: 2, runningSimulationIds: ['sim-a', 'sim-b'] }),
      ],
    });
    const cards = workbenchCards(overview);
    expect(cards.map(card => card.id)).toEqual(['env-1', 'env-2']);
    expect(cards[0]!.attachableSimulationId).toBeNull();
    expect(cards[1]!.attachableSimulationId).toBe('sim-a');
    expect(cards[1]!.runningSimulations).toBe(2);
  });
});

describe('isWorkbenchEmpty', () => {
  it('is true when the caller owns/uses nothing anywhere', () => {
    const overview = makeOverview({
      environments: [makeEnv('env-1', { myAgents: 0, myDevices: 0, myServices: 0 })],
    });
    expect(isWorkbenchEmpty(overview)).toBe(true);
  });

  it('is false once anything exists (device, service or subscription)', () => {
    expect(isWorkbenchEmpty(makeOverview())).toBe(false);
    const onlySubscription = makeOverview({
      environments: [
        makeEnv('env-1', { myAgents: 0, myDevices: 0, myServices: 0, mySubscriptions: 1 }),
      ],
    });
    expect(isWorkbenchEmpty(onlySubscription)).toBe(false);
  });
});

describe('unsubscribeFromOverview', () => {
  it('drops the flat entry and decrements the env + totals counters', () => {
    const overview = makeOverview({
      environments: [
        makeEnv('env-1', { mySubscriptions: 2 }),
        makeEnv('env-2', { mySubscriptions: 1 }),
      ],
      mySubscriptions: [
        {
          id: 's1',
          envId: 'env-1',
          envName: '环境env-1',
          name: '服务s1',
          semanticType: 'energy',
          provider: { agentId: 'a1', agentName: 'A1', ownerName: '小B' },
        },
        {
          id: 's2',
          envId: 'env-2',
          envName: '环境env-2',
          name: '服务s2',
          semanticType: 'energy',
          provider: { agentId: 'a2', agentName: 'A2', ownerName: '小C' },
        },
      ],
    });
    overview.totals.mySubscriptions = 3;

    const next = unsubscribeFromOverview(overview, 's1');
    expect(next.mySubscriptions.map(service => service.id)).toEqual(['s2']);
    expect(next.environments.find(env => env.id === 'env-1')!.mySubscriptions).toBe(1);
    expect(next.environments.find(env => env.id === 'env-2')!.mySubscriptions).toBe(1);
    expect(next.totals.mySubscriptions).toBe(2);
  });

  it('is a no-op for an unknown service id', () => {
    const overview = makeOverview();
    expect(unsubscribeFromOverview(overview, 'nope')).toBe(overview);
  });
});
