/**
 * Collaborations panel tests (Fix-8 / Fix-17): the sim console's
 * /collaborations list renders one row per (collaboration, agent view) with
 * role / status / participants resolved against the snapshot agents.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import i18n from '../i18n/config';
import type { RuntimeCollaborationRecord, SnapshotAgent } from '../api/types';
import { CollaborationsPanel } from '../components/CollaborationsPanel';

// useTranslation reads the active i18next bundle; pin to en-US so the English
// assertions below stay exact regardless of test-order language leakage.
beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});

const COLLABORATIONS: RuntimeCollaborationRecord[] = [
  {
    id: 'ac-1',
    agentId: 'agent-1',
    role: 'initiator',
    status: 'in_progress',
    type: 'ac',
    initiator: 'agent-1',
    participants: ['agent-1', 'agent-2'],
    description: '联动降温：烟雾事件需要空调配合',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:01:00Z',
    history: false,
  },
  {
    id: 'ac-1',
    agentId: 'agent-2',
    role: 'participant',
    status: 'in_progress',
    type: 'ac',
    initiator: 'agent-1',
    participants: ['agent-1', 'agent-2'],
    description: '联动降温：烟雾事件需要空调配合',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:01:00Z',
    history: false,
  },
  {
    id: 'ac-0',
    agentId: 'agent-1',
    role: 'initiator',
    status: 'completed',
    type: 'ac',
    initiator: 'agent-1',
    participants: ['agent-1'],
    description: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:02:00Z',
    history: true,
  },
];

const AGENTS: SnapshotAgent[] = [
  {
    id: 'agent-1',
    name: '感知员',
    capabilities: [],
    managedZoneIds: [],
    boundDeviceIds: [],
    llmEnabled: false,
    activeACCount: 1,
    eventsProcessed: 3,
    activeCollaborations: [],
    reputation: { overallScore: 0.7, totalAttempts: 0, topCapabilities: [] },
  },
  {
    id: 'agent-2',
    name: '气候管家',
    capabilities: [],
    managedZoneIds: [],
    boundDeviceIds: [],
    llmEnabled: false,
    activeACCount: 1,
    eventsProcessed: 2,
    activeCollaborations: [],
    reputation: { overallScore: 0.7, totalAttempts: 0, topCapabilities: [] },
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CollaborationsPanel', () => {
  it('renders both sides of a collaboration with role and status labels', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ collaborations: COLLABORATIONS })),
    );

    render(<CollaborationsPanel simulationId="sim-1" agents={AGENTS} />);

    expect(await screen.findByText('Collaborations (3)')).toBeTruthy();
    // Agent names resolved from the snapshot, both perspectives present.
    expect(screen.getAllByText('感知员').length).toBeGreaterThan(0);
    expect(screen.getByText('气候管家')).toBeTruthy();
    expect(screen.getAllByText('Initiator').length).toBe(2);
    expect(screen.getByText('Participant')).toBeTruthy();
    expect(screen.getAllByText('In progress').length).toBe(2);
    expect(screen.getByText('Completed')).toBeTruthy();
    // 理由 (description) + resolved participant names.
    expect(screen.getAllByText(/联动降温/).length).toBe(2);
    expect(screen.getAllByText(/participants: 感知员, 气候管家/).length).toBe(2);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/simulations/sim-1/collaborations');
  });

  it('shows the empty-state note when there are no collaborations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ collaborations: [] })));

    render(<CollaborationsPanel simulationId="sim-1" agents={AGENTS} />);

    expect(await screen.findByText(/No collaborations yet/)).toBeTruthy();
  });

  it('surfaces a load error without crashing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'SIMULATION_NOT_FOUND', message: 'gone' } }, 404)));

    render(<CollaborationsPanel simulationId="sim-gone" agents={AGENTS} />);

    await waitFor(() =>
      expect(screen.getByText(/Collaborations failed to load/).textContent).toContain('gone'),
    );
  });
});
