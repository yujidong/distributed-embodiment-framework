/**
 * T-048 web tests — agent lifecycle honesty for builders in the Agent tab:
 * a builder's delete surfaces the remove-agents PROPOSAL (no local fake
 * deletion), and the enable/disable toggle routes through a modify-object
 * proposal (the direct PATCH route is owner-only).
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentDetail, WorldAgent } from '../api/types';
import { isProposalConversion } from '../api/client';
import i18n from '../i18n/config';
import { WorldSidebar } from '../components/world/WorldSidebar';
import { useAppStore } from '../store/useAppStore';
// T-713: WorldSidebar now mounts a flows list query + router Link (业务流
// quick link) at the top level — it needs the shared providers harness.
import { renderWithProviders, answerConfirm } from './testUtils';

const BUILDER = {
  id: 'u-me',
  email: 'me@example.com',
  displayName: 'Builder A',
  createdAt: '2026-01-01T00:00:00Z',
};

function makeAgent(): WorldAgent {
  return {
    id: 'a-1',
    envId: 'env-1',
    name: 'Lamp Agent',
    capabilities: ['lighting-control'],
    boundDeviceIds: [],
    managedZoneIds: [],
    llm: null,
    enabled: true,
    owner: { id: 'u-me', displayName: 'Builder A' },
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function makeWorld(): EnvironmentDetail {
  return {
    id: 'env-1',
    name: 'Shared Lab',
    description: '',
    mapType: 'grid',
    mapCenter: null,
    mapZoom: null,
    storeyHeight: null,
    floorPlans: [],
    semanticOfferRules: [],
    capabilitySynonyms: [],
    visibility: 'private',
    owner: { id: 'u-owner', displayName: 'Owner' },
    zones: [{ id: 'zone-1', name: 'Room 1' }],
    events: [],
    devices: [],
    agents: [makeAgent()],
    services: [],
    members: [],
    governance: {
      proposalReview: 'ai-assisted-auto-apply',
      notes: '',
      supervisedZones: [],
      supervisedZoneNote: '',
      humanReview: { maxAgentsPerProposal: 0, maxEventsPerProposal: 0, maxZonesTouched: 0 },
      humanReviewNote: '',
    },
    myRole: 'builder',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type ApplyWorldMessage = ReturnType<typeof useAppStore.getState>['applyWorldMessage'];

const removeAgentsProposal = {
  id: 'prop-rm-1',
  envId: 'env-1',
  kind: 'remove-agents',
  status: 'escalated',
  payload: { agentIds: ['a-1'] },
  ruleCheck: { ok: true, issues: [], warnings: [] },
};

const modifyObjectProposal = {
  id: 'prop-mod-1',
  envId: 'env-1',
  kind: 'modify-object',
  status: 'escalated',
  payload: { targetId: 'a-1', patch: { enabled: false } },
  ruleCheck: { ok: true, issues: [], warnings: [] },
};

describe('isProposalConversion guard', () => {
  it('distinguishes the auto-submitted proposal from the object itself', () => {
    expect(isProposalConversion({ id: 'p-1', kind: 'remove-agents', status: 'escalated' })).toBe(true);
    expect(
      isProposalConversion({ id: 'a-1', name: 'Agent', owner: { id: 'u', displayName: 'U' } }),
    ).toBe(false);
    expect(isProposalConversion(null)).toBe(false);
    expect(isProposalConversion(undefined)).toBe(false);
  });
});

describe('agent lifecycle honesty (T-048, builder view)', () => {
  beforeAll(() => {
    void i18n.changeLanguage('en-US');
  });

  let applyWorldMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    applyWorldMessage = vi.fn();
    useAppStore.setState({
      user: BUILDER,
      toasts: [],
      confirmRequest: null,
      selection: { objectType: 'agent', id: 'a-1' },
      applyWorldMessage: applyWorldMessage as unknown as ApplyWorldMessage,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/agents/a-1' && method === 'DELETE') {
          return jsonResponse(removeAgentsProposal, 201);
        }
        if (url === '/api/environments/env-1/proposals' && method === 'POST') {
          return jsonResponse(modifyObjectProposal, 201);
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${method} ${url}` } }, 404);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useAppStore.setState({ user: null, selection: null });
  });

  function renderSidebar() {
    return renderWithProviders(
      <WorldSidebar world={makeWorld()} tab="agents" onTabChange={() => {}} />,
    );
  }

  it('delete surfaces the proposal and applies NO local deletion', async () => {
    renderSidebar();

    screen.getByText('Delete agent').click();
    await answerConfirm(true);
    await waitFor(() => {
      const deleteCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]) === '/api/agents/a-1' && call[1]?.method === 'DELETE');
      expect(deleteCall).toBeTruthy();
    });

    // The toast names the proposal outcome…
    await waitFor(() => {
      const toast = useAppStore.getState().toasts[0];
      expect(toast?.text).toContain('remove-agents proposal prop-rm-1 submitted (escalated)');
    });
    // …and the fake 'deleted' world message is never applied — the agent
    // stays on the map until the pipeline approves the proposal.
    expect(applyWorldMessage).not.toHaveBeenCalled();
  });

  it('the enable toggle routes through a modify-object proposal', async () => {
    renderSidebar();

    const toggle = screen.getByRole('checkbox') as HTMLInputElement;
    toggle.click();
    await waitFor(() => {
      const proposalCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]) === '/api/environments/env-1/proposals');
      expect(proposalCall).toBeTruthy();
      expect(JSON.parse(String(proposalCall?.[1]?.body))).toEqual({
        kind: 'modify-object',
        payload: { targetId: 'a-1', patch: { enabled: false } },
      });
    });

    await waitFor(() => {
      const toast = useAppStore.getState().toasts[0];
      expect(toast?.text).toContain('Enable/disable proposal prop-mod-1 submitted (escalated)');
    });
    expect(applyWorldMessage).not.toHaveBeenCalled();
  });
});
