/**
 * R76-F1: half-logged-in Agent wizard — when the boot session restore failed
 * (store user === null), viewerId collapses to '' → zero bindable devices →
 * every capability chip reads unbacked and Next is silently disabled. The
 * wizard must SAY the session is unavailable (a page-note--error teaching
 * hint) instead of failing quietly.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentDetail, PublicUser } from '../api/types';
import { AgentWizard } from '../components/world/AgentWizard';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

// The wizard loads the capability catalog on mount — stub it empty.
vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, listCatalog: vi.fn(async () => []) };
});

const USER: PublicUser = {
  id: 'user-a',
  email: 'a@example.com',
  displayName: '小A',
  createdAt: '2026-01-01T00:00:00Z',
};

/** One device owned by someone else: with user=null nothing is bindable. */
function makeWorld(): EnvironmentDetail {
  return {
    id: 'env-1',
    name: '测试环境',
    description: '',
    mapType: 'grid',
    visibility: 'public',
    myRole: 'builder',
    owner: { id: 'owner-1', displayName: 'Owner' },
    zones: [],
    devices: [
      {
        id: 'dev-1',
        envId: 'env-1',
        name: '温度计',
        type: 'meter',
        brand: null,
        capabilities: ['energy-monitoring'],
        zoneId: 'zone-1',
        position: null,
        initialState: null,
        binding: 'sim://dev-1',
        owner: { id: 'user-b', displayName: '小B' },
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    agents: [],
    services: [],
    events: [],
    members: [],
  } as unknown as EnvironmentDetail;
}

describe('AgentWizard session-lost hint (R76-F1)', () => {
  beforeEach(() => {
    void i18n.changeLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ user: null });
  });

  it('shows the session hint when the boot restore left user null', () => {
    useAppStore.setState({ user: null });
    renderWithProviders(<AgentWizard world={makeWorld()} agent={null} onClose={() => {}} />);
    expect(
      screen.getByText(/sign-in session is unavailable/i),
    ).toBeTruthy();
  });

  it('renders no hint for a signed-in user', () => {
    useAppStore.setState({ user: USER });
    renderWithProviders(<AgentWizard world={makeWorld()} agent={null} onClose={() => {}} />);
    expect(screen.queryByText(/sign-in session is unavailable/i)).toBeNull();
  });
});
