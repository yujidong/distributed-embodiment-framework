/**
 * GovernanceInboxPanel tests (UX-W5 子任务 B): the sidebar 治理 group 收件箱
 * tab — one queue aggregating「需要我裁决的事项」:
 * - pending proposals (escalated + youCanDecide, the SAME react-query key as
 *   AppOverviewPanel's governance 区) with inline 批准/驳回 riding
 *   decideProposal; a successful decide invalidates the shared key and the
 *   row leaves both views;
 * - agreements awaiting my response (the canDecide gate: proposed → I'm the
 *   provider; countered → I'm the consumer) whose 去处理 jumps to the 合约
 *   tab's AgreementDetail;
 * - the EmptyState when nothing awaits, and the ?tab=governance deep-link
 *   registration (UX-03 unknown-tab discipline).
 *
 * All requests are stubbed at the fetch boundary (same pattern as
 * appOverviewGovernance.test.tsx).
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agreement, EnvironmentDetail, GovernanceProposal } from '../api/types';
import { GovernanceInboxPanel } from '../components/world/GovernanceInboxPanel';
import i18n from '../i18n/config';
import { unknownSidebarTab } from '../pages/WorldViewPage';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

const USER = {
  id: 'u-me',
  email: 'me@example.com',
  displayName: '小A',
  createdAt: '2026-01-01T00:00:00Z',
};

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
    owner: { id: 'u-me', displayName: '小A' },
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

function makeAgreement(overrides: Partial<Agreement> = {}): Agreement {
  return {
    id: 'ag-1',
    envId: 'env-1',
    serviceId: 'svc-1',
    service: { id: 'svc-1', name: '空调控制', semanticType: 'cooling' },
    backingDeviceId: 'dev-ac-1',
    callableActions: ['turn-on', 'set-temperature'],
    consumerAgentId: null,
    consumerAgentName: null,
    consumer: { id: 'u-other', displayName: '小C' },
    providerAgentId: 'agent-p',
    providerAgentName: '空调管家',
    provider: { id: 'u-me', displayName: '小A' },
    terms: {},
    termsEnforced: false,
    status: 'proposed',
    source: 'explicit',
    collaborationId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Mutable request journal: every URL+method the panel issued. */
const calls: Array<{ url: string; method: string; body?: unknown }> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface InboxStubs {
  proposals: () => GovernanceProposal[];
  providerAgreements: () => Agreement[];
  consumerAgreements: () => Agreement[];
}

function stubFetch(stubs: InboxStubs): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/environments/env-1/proposals' && method === 'GET') {
        return jsonResponse({ proposals: stubs.proposals() });
      }
      if (url.startsWith('/api/agreements?') && method === 'GET') {
        const role = new URLSearchParams(url.split('?')[1]).get('role');
        return jsonResponse({
          agreements:
            role === 'provider' ? stubs.providerAgreements() : stubs.consumerAgreements(),
        });
      }
      const decide = url.match(/^\/api\/proposals\/([\w-]+)\/decide$/);
      if (decide && method === 'POST') {
        const row = stubs.proposals().find(p => p.id === decide[1]);
        if (!row) return jsonResponse({ error: { code: 'PROPOSAL_NOT_FOUND', message: 'no such proposal' } }, 404);
        row.status = body?.decision === 'approved' ? 'applied' : 'rejected';
        return jsonResponse(row);
      }
      return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${method} ${url}` } }, 404);
    }),
  );
}

describe('GovernanceInboxPanel (UX-W5)', () => {
  beforeAll(() => {
    void i18n.changeLanguage('zh-CN');
  });

  beforeEach(() => {
    calls.length = 0;
    useAppStore.setState({ user: USER, selectedAgreementId: null });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('aggregates decidable proposals and agreements awaiting my response — nothing else', async () => {
    stubFetch({
      proposals: () => [
        makeProposal({ id: 'p-1', youCanDecide: true }),
        // Escalated but NOT mine to decide — the inbox is actionable-only.
        makeProposal({ id: 'p-2', kind: 'zone-claim', youCanDecide: false }),
      ],
      providerAgreements: () => [
        // proposed + I'm the provider → my move.
        makeAgreement({ id: 'ag-1' }),
      ],
      consumerAgreements: () => [
        // countered + I'm the consumer → the counter-offer is on my table.
        makeAgreement({
          id: 'ag-2',
          status: 'countered',
          consumer: { id: 'u-me', displayName: '小A' },
          provider: { id: 'u-other', displayName: '小C' },
          service: { id: 'svc-2', name: '照明控制', semanticType: 'lighting' },
        }),
        // proposed + I'm the consumer → waiting on the provider, not actionable.
        makeAgreement({
          id: 'ag-3',
          consumer: { id: 'u-me', displayName: '小A' },
          provider: { id: 'u-other', displayName: '小C' },
        }),
      ],
    });
    renderWithProviders(<GovernanceInboxPanel world={makeWorld('owner')} onTabChange={() => {}} />);

    expect(await screen.findByText('待决提案（1）')).toBeTruthy();
    expect(await screen.findByText('待我回应的合约（2）')).toBeTruthy();
    // The decidable proposal row (kind · author) renders; the other one doesn't.
    expect(screen.getByText('install-devices · 小李')).toBeTruthy();
    expect(screen.queryByText(/zone-claim/)).toBeNull();
    // Both actionable agreements render; the waiting one doesn't (ag-1/ag-3
    // share the 空调控制 fixture name, so exactly one such row proves the gate).
    expect(screen.getAllByText(/空调控制/)).toHaveLength(1);
    expect(screen.getByText(/照明控制/)).toBeTruthy();
  });

  it('inline 批准 calls the decide endpoint and the decided row leaves the inbox', async () => {
    const proposals = [makeProposal({ id: 'p-1', youCanDecide: true })];
    stubFetch({
      proposals: () => proposals,
      providerAgreements: () => [],
      consumerAgreements: () => [],
    });
    renderWithProviders(<GovernanceInboxPanel world={makeWorld('owner')} onTabChange={() => {}} />);

    (await screen.findByRole('button', { name: '批准' })).click();
    await waitFor(() => {
      expect(calls.some(c => c.url === '/api/proposals/p-1/decide' && c.method === 'POST')).toBe(true);
    });
    expect(calls.find(c => c.url === '/api/proposals/p-1/decide')?.body).toEqual({
      decision: 'approved',
    });
    // The invalidated list re-fetches; p-1 is now applied → the inbox empties.
    expect(await screen.findByText('没有待裁决事项')).toBeTruthy();
  });

  it('inline 驳回 rejects the proposal', async () => {
    const proposals = [makeProposal({ id: 'p-1', youCanDecide: true })];
    stubFetch({
      proposals: () => proposals,
      providerAgreements: () => [],
      consumerAgreements: () => [],
    });
    renderWithProviders(<GovernanceInboxPanel world={makeWorld('owner')} onTabChange={() => {}} />);

    (await screen.findByRole('button', { name: '驳回' })).click();
    await waitFor(() => {
      expect(calls.find(c => c.url === '/api/proposals/p-1/decide')?.body).toEqual({
        decision: 'rejected',
      });
    });
    expect(await screen.findByText('没有待裁决事项')).toBeTruthy();
  });

  it('an agreement row\'s 去处理 focuses the agreement and jumps to the 合约 tab', async () => {
    const tabChanges: string[] = [];
    stubFetch({
      proposals: () => [],
      providerAgreements: () => [makeAgreement({ id: 'ag-1' })],
      consumerAgreements: () => [],
    });
    renderWithProviders(
      <GovernanceInboxPanel world={makeWorld('owner')} onTabChange={tab => tabChanges.push(tab)} />,
    );

    (await screen.findByRole('button', { name: '去处理' })).click();
    expect(useAppStore.getState().selectedAgreementId).toBe('ag-1');
    expect(tabChanges).toEqual(['agreements']);
  });

  it('renders the EmptyState when nothing awaits a decision', async () => {
    stubFetch({
      proposals: () => [],
      providerAgreements: () => [],
      consumerAgreements: () => [],
    });
    renderWithProviders(<GovernanceInboxPanel world={makeWorld('owner')} onTabChange={() => {}} />);

    expect(await screen.findByText('没有待裁决事项')).toBeTruthy();
    expect(screen.queryByText(/待决提案/)).toBeNull();
    expect(screen.queryByText(/待我回应的合约/)).toBeNull();
  });

  it('registers the ?tab=governance deep link (UX-03 unknown-tab discipline)', () => {
    expect(unknownSidebarTab('governance')).toBeNull();
    expect(unknownSidebarTab('definitely-not-a-tab')).toBe('definitely-not-a-tab');
  });
});
