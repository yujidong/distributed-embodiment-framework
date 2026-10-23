/**
 * T-028 idle-poll lifecycle (EA-F07):
 * - CollaborationsPanel stops polling once the sim is stopped (retention
 *   prunes stopped sims → the 3s poll would eventually stamp a permanent
 *   SIMULATION_NOT_FOUND over data that was fine);
 * - DeploymentPanel's SafetySection audit feed polls only while its step is
 *   EXPANDED (collapsed steps stay mounted — the 5s poll used to run for
 *   the lifetime of the world view once the 部署 tab had been opened).
 */

import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentDetail } from '../api/types';
import { CollaborationsPanel } from '../components/CollaborationsPanel';
import { DeploymentPanel } from '../components/world/DeploymentPanel';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

const mocks = vi.hoisted(() => ({
  getDeployment: vi.fn(async () => ({
    envId: 'env-1',
    environment: { id: 'env-1', name: '部署测试环境' },
    myAgents: [],
    devicesToDeploy: [],
    servicesToOffer: [],
    servicesConsumed: [],
    notes: [],
    generatedAt: '2026-08-23T00:00:00.000Z',
  })),
  listSimulations: vi.fn(async () => []),
  listHassAudit: vi.fn(async () => []),
  listHassPending: vi.fn(async () => []),
  listHassPolicies: vi.fn(async () => []),
  getHassEstop: vi.fn(async () => ({ engaged: false })),
  getHassStatus: vi.fn(async () => ({ configured: false, state: 'unconfigured' })),
  listHassEntities: vi.fn(async () => []),
  getSimulationCollaborations: vi.fn(async () => []),
}));

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return { ...mod, ...mocks };
});

const WORLD = {
  id: 'env-1',
  name: '部署测试环境',
  visibility: 'public',
  myRole: 'builder',
  zones: [],
  devices: [],
  agents: [],
  services: [],
  members: [],
} as unknown as EnvironmentDetail;

beforeEach(() => {
  vi.useFakeTimers();
  void i18n.changeLanguage('zh-CN');
  useAppStore.setState({ user: { id: 'u-1', email: 'u@x', displayName: 'U', createdAt: '2026-01-01T00:00:00.000Z' }, toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe('CollaborationsPanel stops polling stopped sims (T-028/EA-F07)', () => {
  it('polls while running, stops when the sim is stopped', async () => {
    const { rerender } = renderWithProviders(
      <CollaborationsPanel simulationId="sim-1" agents={[]} />,
    );
    // Initial fetch on mount.
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.getSimulationCollaborations.mock.calls.length).toBeGreaterThanOrEqual(1);
    const afterMount = mocks.getSimulationCollaborations.mock.calls.length;

    // Poll cycles tick while the sim runs.
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.getSimulationCollaborations.mock.calls.length).toBeGreaterThan(afterMount);

    // Stopped: the interval is torn down — no further calls (the final table
    // stays on screen instead of turning into a permanent 404 error line).
    const beforeStop = mocks.getSimulationCollaborations.mock.calls.length;
    rerender(<CollaborationsPanel simulationId="sim-1" agents={[]} stopped />);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.getSimulationCollaborations.mock.calls.length).toBe(beforeStop);
  });
});

describe('DeploymentPanel audit feed polls only while expanded (T-028/EA-F07)', () => {
  it('no audit poll while the safety step is collapsed; polls after expanding', async () => {
    renderWithProviders(<DeploymentPanel world={WORLD} />);
    // Let the panel settle (manifest + hass status fetches).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // The stepper suggests the first incomplete step (connect/bind), so the
    // safety step starts COLLAPSED — its audit feed must not poll.
    expect(mocks.listHassAudit).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mocks.listHassAudit).not.toHaveBeenCalled();

    // Expand the 安全闸 step (③) — the audit loads immediately and then polls.
    // ('安全闸' matches both the stepper chip and the step header.)
    fireEvent.click(screen.getAllByText('安全闸')[0]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(mocks.listHassAudit.mock.calls.length).toBeGreaterThanOrEqual(1);
    const expanded = mocks.listHassAudit.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.listHassAudit.mock.calls.length).toBeGreaterThan(expanded);
  });
});
