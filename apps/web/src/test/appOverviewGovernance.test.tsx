/**
 * AppOverviewPanel governance actions (R40-A1): the 待决提案 list grows the
 * missing decide/remind/revert entries —
 * - decidable rows (youCanDecide) show one-click 批准/驳回 and a successful
 *   decide refreshes the list so the buttons disappear with the new status;
 * - non-deciders see no decide buttons (the API mark, not client guessing);
 * - the decided tail shows results, applied rows keep the 回滚 entry
 *   (behind the UX-W1 ConfirmDialog) for the owner, and the author gets 催办.
 *
 * All requests are stubbed at the fetch boundary (same pattern as
 * rosterReportPanel.test.tsx).
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentDetail, GovernanceProposal } from '../api/types';
import { AppOverviewPanel } from '../components/world/AppOverviewPanel';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders, answerConfirm } from './testUtils';

function makeWorld(myRole: 'owner' | 'builder' | 'viewer' = 'owner'): EnvironmentDetail {
  return {
    id: 'env-1',
    name: '测试环境',
    description: '',
    mapType: 'grid',
    mapCenter: null,
    mapZoom: null,
    storeyHeight: null,
    floorPlans: [],
    semanticOfferRules: [],
    capabilitySynonyms: [],
    visibility: 'private',
    owner: { id: 'u-owner', displayName: '王老师' },
    zones: [],
    events: [],
    devices: [],
    agents: [],
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
    myRole,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function makeProposal(overrides: Partial<GovernanceProposal>): GovernanceProposal {
  return {
    id: 'p-1',
    envId: 'env-1',
    kind: 'install-devices',
    payload: {},
    riskLevel: 'low',
    status: 'escalated',
    ruleCheck: null,
    aiReview: null,
    author: { id: 'u-xiaoli', displayName: '小李' },
    createdAt: '2026-08-28T00:00:00Z',
    ...overrides,
  } as GovernanceProposal;
}

/** Mutable request journal: every URL+method the panel issued. */
const calls: Array<{ url: string; method: string; body?: unknown }> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AppOverviewPanel governance actions (R40-A1)', () => {
  beforeAll(() => {
    void i18n.changeLanguage('zh-CN');
  });

  beforeEach(() => {
    calls.length = 0;
    useAppStore.setState({ user: null });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch(proposals: () => GovernanceProposal[]): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body });
        if (url === '/api/environments/env-1/flows' && method === 'GET') {
          return jsonResponse({ flows: [] });
        }
        if (url === '/api/environments/env-1/proposals' && method === 'GET') {
          return jsonResponse({ proposals: proposals() });
        }
        const action = url.match(/^\/api\/proposals\/([\w-]+)\/(decide|remind|revert)$/);
        if (action && method === 'POST') {
          const [, id, verb] = action;
          const row = proposals().find(p => p.id === id);
          if (!row) return jsonResponse({ error: { code: 'PROPOSAL_NOT_FOUND', message: 'no such proposal' } }, 404);
          if (verb === 'decide') {
            row.status = body?.decision === 'approved' ? 'applied' : 'rejected';
            return jsonResponse(row);
          }
          if (verb === 'revert') {
            row.status = 'reverted';
            return jsonResponse(row);
          }
          return jsonResponse({ proposalId: id, status: row.status, reminded: true });
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${method} ${url}` } }, 404);
      }),
    );
  }

  it('shows approve/reject on decidable rows; a successful decide refreshes the list so the buttons disappear', async () => {
    const rows = [
      makeProposal({ id: 'p-1', youCanDecide: true }),
      makeProposal({ id: 'p-2', kind: 'zone-claim', youCanDecide: false, author: { id: 'u-xiaowang', displayName: '小王' } }),
    ];
    stubFetch(() => rows);
    renderWithProviders(<AppOverviewPanel world={makeWorld('owner')} onTabChange={() => {}} />);

    // Both pending rows render; only the decidable one gets the buttons.
    expect(await screen.findByText('install-devices · 小李')).toBeTruthy();
    expect(screen.getByText('zone-claim · 小王')).toBeTruthy();
    expect(screen.getByText('可由我裁决')).toBeTruthy();
    const approve = screen.getByRole('button', { name: '批准' });
    expect(screen.getByRole('button', { name: '驳回' })).toBeTruthy();

    approve.click();
    await waitFor(() => {
      expect(calls.some(c => c.url === '/api/proposals/p-1/decide' && c.method === 'POST')).toBe(true);
    });
    const decideCall = calls.find(c => c.url === '/api/proposals/p-1/decide');
    expect(decideCall?.body).toEqual({ decision: 'approved' });
    // The invalidated list re-fetches and p-1 now renders as decided — no
    // decide buttons anywhere, the applied result badge instead.
    expect(await screen.findByText('已生效')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
      expect(screen.queryByRole('button', { name: '驳回' })).toBeNull();
    });
    expect(screen.queryByText('可由我裁决')).toBeNull();
  });

  it('hides the decide buttons from non-deciders (youCanDecide=false everywhere)', async () => {
    stubFetch(() => [makeProposal({ id: 'p-1', youCanDecide: false })]);
    renderWithProviders(<AppOverviewPanel world={makeWorld('builder')} onTabChange={() => {}} />);

    expect(await screen.findByText('install-devices · 小李')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
    expect(screen.queryByRole('button', { name: '驳回' })).toBeNull();
    expect(screen.queryByText('可由我裁决')).toBeNull();
  });

  it('shows the revert entry on applied rows for the owner, behind a confirm', async () => {
    const rows = [makeProposal({ id: 'p-3', status: 'applied' })];
    stubFetch(() => rows);
    renderWithProviders(<AppOverviewPanel world={makeWorld('owner')} onTabChange={() => {}} />);

    const revert = await screen.findByRole('button', { name: '回滚' });
    revert.click();
    await answerConfirm(true);
    await waitFor(() => {
      expect(calls.some(c => c.url === '/api/proposals/p-3/revert' && c.method === 'POST')).toBe(true);
    });
    // After the refresh the row is reverted — result badge, no revert button.
    expect(await screen.findByText('已回滚')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '回滚' })).toBeNull();
  });

  it('keeps revert away from non-owner non-authors and offers remind only to the author', async () => {
    stubFetch(() => [
      makeProposal({ id: 'p-1', youCanDecide: false }),
      makeProposal({ id: 'p-4', status: 'applied' }),
    ]);
    renderWithProviders(<AppOverviewPanel world={makeWorld('viewer')} onTabChange={() => {}} />);

    // A viewer sees the results but neither decide nor revert entries.
    expect(await screen.findByText('已生效')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
    expect(screen.queryByRole('button', { name: '回滚' })).toBeNull();
    expect(screen.queryByRole('button', { name: '催办' })).toBeNull();

    // Signed in as the author of p-1: the remind nudge appears (escalated,
    // authored by me), still no revert (p-4 was authored by someone else).
    useAppStore.setState({
      user: { id: 'u-xiaoli', email: 'xiaoli@example.edu', displayName: '小李', createdAt: '2026-01-01T00:00:00Z' },
    });
    cleanup();
    calls.length = 0;
    stubFetch(() => [
      makeProposal({ id: 'p-1', youCanDecide: false }),
      makeProposal({ id: 'p-4', status: 'applied', author: { id: 'u-xiaowang', displayName: '小王' } }),
    ]);
    renderWithProviders(<AppOverviewPanel world={makeWorld('builder')} onTabChange={() => {}} />);
    (await screen.findByRole('button', { name: '催办' })).click();
    await waitFor(() => {
      expect(calls.some(c => c.url === '/api/proposals/p-1/remind' && c.method === 'POST')).toBe(true);
    });
    expect(screen.queryByRole('button', { name: '回滚' })).toBeNull();
  });
});
