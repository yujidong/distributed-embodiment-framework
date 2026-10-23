/**
 * UX-10: the 合约 tab's env-wide read-only overview (AgreementsPanel
 * 环境合约 section) — GET /api/agreements?envId=…&include=terminated renders
 * full party rows AND the T30 restricted terminated rows (agents + outcome,
 * no owner identities, no terms), with no action buttons.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agreement, EnvironmentDetail, RestrictedAgreementView } from '../api/types';
import i18n from '../i18n/config';
import { AgreementsPanel } from '../components/world/AgreementsPanel';
import { useAppStore } from '../store/useAppStore';

const USER = {
  id: 'u-me',
  email: 'me@example.com',
  displayName: '小A',
  createdAt: '2026-01-01T00:00:00Z',
};

function makeFullAgreement(): Agreement {
  return {
    id: 'ag-mine',
    envId: 'env-1',
    serviceId: 'svc-1',
    service: { id: 'svc-1', name: '空调控制', semanticType: 'cooling' },
    backingDeviceId: 'dev-ac-1',
    callableActions: ['turn-on'],
    consumerAgentId: null,
    consumerAgentName: null,
    consumer: { id: 'u-other', displayName: '小C' },
    providerAgentId: 'agent-p',
    providerAgentName: '空调管家',
    provider: { id: 'u-me', displayName: '小A' },
    terms: {},
    termsEnforced: false,
    status: 'active',
    source: 'explicit',
    collaborationId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function makeRestrictedRow(): RestrictedAgreementView {
  return {
    id: 'ag-theirs',
    envId: 'env-1',
    status: 'terminated',
    source: 'explicit',
    collaborationId: null,
    service: { id: 'svc-9', name: '照明控制' },
    consumerAgentId: 'agent-c',
    consumerAgentName: '灯光师',
    providerAgentId: 'agent-d',
    providerAgentName: '电力管家',
    outcome: 'success',
    terminatedAt: '2026-01-02T00:00:00Z',
    view: 'restricted',
  };
}

function makeWorld(): EnvironmentDetail {
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
    myRole: 'owner',
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

describe('AgreementsPanel env overview (UX-10)', () => {
  // Panel text uses the active i18next bundle; pin to en-US so the
  // assertions below stay exact.
  beforeAll(() => {
    void i18n.changeLanguage('en-US');
  });

  beforeEach(() => {
    useAppStore.setState({ user: USER, toasts: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/agreements?envId=env-1&role=provider') {
          return jsonResponse({ agreements: [] });
        }
        if (url === '/api/agreements?envId=env-1&role=consumer') {
          return jsonResponse({ agreements: [] });
        }
        if (url === '/api/agreements?envId=env-1&include=terminated') {
          return jsonResponse({ agreements: [makeFullAgreement(), makeRestrictedRow()] });
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ user: null });
  });

  it('renders full + restricted rows read-only in the env overview', async () => {
    render(<AgreementsPanel world={makeWorld()} />);

    const overview = (await screen.findByTestId('agreement-overview')) as HTMLElement;
    // Full party row: service name, status badge, counterparty, terms summary.
    expect(await screen.findByText('空调控制')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Counterparty: 小C (consumer)')).toBeTruthy();
    // Restricted terminated row: participants as AGENTS + outcome + time —
    // no owner identities, no terms summary.
    expect(screen.getByText('照明控制')).toBeTruthy();
    expect(screen.getByText('灯光师 ↔ 电力管家')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('2026-01-02T00:00:00Z')).toBeTruthy();
    // The restricted row carries no terms — the only terms summary in the
    // overview comes from the full party row.
    expect(screen.getAllByText('Unlimited (default terms)')).toHaveLength(1);
    // Read-only: no lifecycle action buttons anywhere in the overview.
    expect(overview.querySelector('button')).toBeNull();
  });

  it('degrades to a note when the overview lane fails (mailboxes unaffected)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/agreements?envId=env-1&role=provider') {
          return jsonResponse({ agreements: [makeFullAgreement()] });
        }
        if (url === '/api/agreements?envId=env-1&role=consumer') {
          return jsonResponse({ agreements: [] });
        }
        return jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'nope' } }, 401);
      }),
    );
    render(<AgreementsPanel world={makeWorld()} />);

    expect(await screen.findByText(/Failed to load the environment overview/)).toBeTruthy();
    // The mailbox lane still rendered its row.
    expect(await screen.findByText('Inbox (services I provide) (1)')).toBeTruthy();
  });
});
