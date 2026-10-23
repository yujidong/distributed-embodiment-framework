/**
 * OnboardingChecklist render tests (R2-FEAT-07, R3-T22 render discipline —
 * the celebration card is a new payload-form branch of the workbench guide
 * face):
 *
 * - a starter-home import overview keeps the checklist resident with only
 *   ① checked (the pre-fix bug hid the whole card at that moment);
 * - reaching allDone renders the one-time all-checked CELEBRATION instead of
 *   vanishing; closing it persists and the card hides from then on;
 * - 不再显示 persists too, and resetOnboardingPrefs() (the workbench's
 *   「重新显示新手引导」entry) brings the card back.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { MeOverview, MeOverviewEnv } from '../api/types';
import {
  OnboardingChecklist,
  onboardingWasHidden,
  resetOnboardingPrefs,
} from '../components/OnboardingChecklist';
import i18n from '../i18n/config';
import { renderWithProviders } from './testUtils';

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

function makeOverview(environments: MeOverviewEnv[]): MeOverview {
  return {
    user: { id: 'u1', email: 'a@b.c', displayName: '小A', createdAt: '2026-01-01T00:00:00Z' },
    environments,
    totals: {
      environments: environments.length,
      myAgents: environments.reduce((sum, env) => sum + env.myAgents, 0),
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

/** starter-home 导入后的 overview：①天然完成，②③必须未完成。 */
const IMPORTED = makeOverview([
  makeEnv('env-1', { myDevices: 4, myAgents: 2, hasWorldSession: true }),
]);

const ALL_DONE = makeOverview([
  makeEnv('env-1', { myDevices: 2, myBlueprintInstalls: 2, simulationCount: 1 }),
]);

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('OnboardingChecklist (R2-FEAT-07)', () => {
  it('stays resident after a starter-home import: ① checked, ②③ actionable', () => {
    renderWithProviders(<OnboardingChecklist overview={IMPORTED} />);
    expect(screen.getByText('新手引导')).toBeTruthy();
    expect(screen.getByText('创建你的第一个环境')).toBeTruthy();
    // ②③ keep their action buttons — the card no longer vanishes on import.
    expect(screen.getByRole('button', { name: '去装蓝图' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入环境' })).toBeTruthy();
  });

  it('renders the one-time celebration on allDone, then hides after closing it', () => {
    const hidden: string[] = [];
    const { container, rerender } = renderWithProviders(
      <OnboardingChecklist overview={ALL_DONE} onHidden={() => hidden.push('hidden')} />,
    );
    // Celebration: all three steps checked, congratulatory copy, close button.
    expect(screen.getByText('入门三步全部完成！')).toBeTruthy();
    expect(container.querySelectorAll('.onboarding-step--done').length).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(hidden).toEqual(['hidden']);
    expect(container.querySelector('.onboarding')).toBeNull();
    // A remount (next workbench visit) keeps the card hidden.
    rerender(<OnboardingChecklist overview={ALL_DONE} />);
    expect(screen.queryByText('入门三步全部完成！')).toBeNull();
    expect(onboardingWasHidden()).toBe(true);
  });

  it('「不再显示」persists, and resetOnboardingPrefs() brings the guide back', () => {
    const { container } = renderWithProviders(<OnboardingChecklist overview={IMPORTED} />);
    fireEvent.click(screen.getByRole('button', { name: '不再显示' }));
    expect(container.querySelector('.onboarding')).toBeNull();
    expect(onboardingWasHidden()).toBe(true);

    cleanup();
    renderWithProviders(<OnboardingChecklist overview={IMPORTED} />);
    expect(screen.queryByText('新手引导')).toBeNull();

    resetOnboardingPrefs();
    cleanup();
    renderWithProviders(<OnboardingChecklist overview={IMPORTED} />);
    expect(screen.getByText('新手引导')).toBeTruthy();
    expect(onboardingWasHidden()).toBe(false);
  });

  it('re-arms the celebration when steps become undone again', () => {
    const { container } = renderWithProviders(<OnboardingChecklist overview={ALL_DONE} />);
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(container.querySelector('.onboarding')).toBeNull();
    // Env deleted → steps undone → celebration flag clears, the working
    // checklist renders again on the next visit.
    cleanup();
    renderWithProviders(<OnboardingChecklist overview={IMPORTED} />);
    expect(screen.getByText('新手引导')).toBeTruthy();
    expect(window.localStorage.getItem('ac.onboarding.celebrated')).toBeNull();
  });
});
