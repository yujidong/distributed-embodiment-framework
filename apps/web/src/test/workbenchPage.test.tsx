/**
 * WorkbenchPage render tests (UX-R2 batch 8):
 *
 * - R2-UX-12: an env card with 运行中仿真 (0) but an active world session
 *   shows the 「世界会话活跃」 badge instead of reading as "nothing alive";
 * - R2-FEAT-07: once the guide was dismissed/celebrated-away, the hint line
 *   offers 「重新显示新手引导」, which clears the persisted flags and
 *   remounts the checklist.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeOverview, MeOverviewEnv } from '../api/types';
import i18n from '../i18n/config';
import { WorkbenchPage } from '../pages/WorkbenchPage';
import { renderWithProviders } from './testUtils';

let overviewData: MeOverview | null = null;
vi.mock('../hooks/useOverview', () => ({
  useOverview: () => ({ data: overviewData, error: null, isLoading: false, refetch: vi.fn() }),
  useUnsubscribeFromWorkbench: () => ({ isPending: false, variables: null, mutate: vi.fn() }),
}));

vi.mock('../store/useAppStore', () => ({
  useAppStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ user: { id: 'u1', displayName: '小A', isAdmin: false }, openSimulationConsole: vi.fn() }),
  ),
}));

beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});
afterAll(() => {
  void i18n.changeLanguage('en-US');
});

function makeEnv(id: string, overrides: Partial<MeOverviewEnv> = {}): MeOverviewEnv {
  return {
    id,
    name: `环境${id}`,
    mapType: 'grid',
    myRole: 'owner',
    myAgents: 0,
    myDevices: 1,
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

function makeOverview(environments: MeOverviewEnv[]): MeOverview {
  return {
    user: { id: 'u1', email: 'a@b.c', displayName: '小A', createdAt: '2026-01-01T00:00:00Z' },
    environments,
    totals: {
      environments: environments.length,
      myAgents: 0,
      myDevices: environments.reduce((sum, env) => sum + env.myDevices, 0),
      myServices: 0,
      mySubscriptions: 0,
      runningSimulations: environments.reduce((sum, env) => sum + env.runningSimulations, 0),
      myRunningSimulations: 0,
      simulationCount: environments.reduce((sum, env) => sum + env.simulationCount, 0),
    },
    todos: { pendingProposals: 0, pendingAgreements: 0, unreadNotifications: 0 },
    myServices: [],
    mySubscriptions: [],
  };
}

beforeEach(() => {
  window.localStorage.clear();
  overviewData = null;
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('WorkbenchPage (UX-R2)', () => {
  it('R2-UX-12: badges 世界会话活跃 when nothing runs but the world session lives', () => {
    overviewData = makeOverview([makeEnv('env-1', { hasWorldSession: true })]);
    renderWithProviders(<WorkbenchPage />);
    expect(screen.getByText('世界会话活跃')).toBeTruthy();
    expect(screen.getByRole('button', { name: '运行中仿真 (0)' })).toBeTruthy();
  });

  it('R2-UX-12: no badge once a simulation is actually running', () => {
    overviewData = makeOverview([
      makeEnv('env-1', {
        hasWorldSession: true,
        runningSimulations: 1,
        runningSimulationIds: ['sim-1'],
        simulationCount: 1,
      }),
    ]);
    renderWithProviders(<WorkbenchPage />);
    expect(screen.queryByText('世界会话活跃')).toBeNull();
  });

  it('R2-UX-12: no badge for an env without a world session either', () => {
    overviewData = makeOverview([makeEnv('env-1')]);
    renderWithProviders(<WorkbenchPage />);
    expect(screen.queryByText('世界会话活跃')).toBeNull();
  });

  it('R2-FEAT-07: 「重新显示新手引导」appears once the guide was hidden and restores it', () => {
    overviewData = makeOverview([makeEnv('env-1')]);
    const { container } = renderWithProviders(<WorkbenchPage />);
    // Guide visible, no recovery entry yet.
    expect(screen.getByText('新手引导')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新显示新手引导' })).toBeNull();

    // Dismiss the guide → the page offers the recovery entry.
    fireEvent.click(screen.getByRole('button', { name: '不再显示' }));
    expect(screen.queryByText('新手引导')).toBeNull();
    const reshow = screen.getByRole('button', { name: '重新显示新手引导' });
    expect(reshow).toBeTruthy();

    // Click it → persisted flags cleared, checklist remounts.
    fireEvent.click(reshow);
    expect(window.localStorage.getItem('ac.onboarding.dismissed')).toBeNull();
    expect(screen.getByText('新手引导')).toBeTruthy();
    expect(container.querySelector('.onboarding')).not.toBeNull();
  });
});
