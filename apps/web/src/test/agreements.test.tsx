/**
 * Agreement UI tests (Fix-11 / Fix-17): the action gates in lib/agreements
 * plus the 合约 sidebar tab (AgreementsPanel) — inbox decide, outbox invoke,
 * and the usage ledger — driven by a stubbed fetch against the real API
 * client.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agreement, EnvironmentDetail, UsageRecord } from '../api/types';
import i18n from '../i18n/config';
import { AgreementsPanel } from '../components/world/AgreementsPanel';
import {
  canDecide,
  canInvoke,
  canSuspend,
  canTerminate,
  dedupeAgreementsById,
  shortAgreementId,
  sortAgreementsForInbox,
  summarizeTerms,
} from '../lib/agreements';
import { useAppStore } from '../store/useAppStore';

const USER = {
  id: 'u-me',
  email: 'me@example.com',
  displayName: '小A',
  createdAt: '2026-01-01T00:00:00Z',
};

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

describe('agreement action gates (lib/agreements)', () => {
  // summarizeTerms reads the active i18next bundle; pin to zh-CN so the
  // assertions stay exact.
  beforeAll(() => {
    void i18n.changeLanguage('zh-CN');
  });

  it('decide/suspend are provider-only and status-scoped', () => {
    const proposed = makeAgreement();
    expect(canDecide(proposed, 'u-me')).toBe(true);
    expect(canDecide(proposed, 'u-other')).toBe(false);
    expect(canDecide(makeAgreement({ status: 'active' }), 'u-me')).toBe(false);
    expect(canSuspend(makeAgreement({ status: 'active' }), 'u-me')).toBe(true);
    expect(canSuspend(proposed, 'u-me')).toBe(false);
  });

  it('T-059: on a countered agreement the CONSUMER decides (decide right follows state)', () => {
    const countered = makeAgreement({
      status: 'countered',
      counteredTerms: { quotaPerWindow: 5 },
      consumer: { id: 'u-other', displayName: '小C' },
    });
    expect(canDecide(countered, 'u-other')).toBe(true);
    expect(canDecide(countered, 'u-me')).toBe(false);
  });

  it('terminate is open to both parties until a terminal status', () => {
    expect(canTerminate(makeAgreement(), 'u-me')).toBe(true);
    expect(canTerminate(makeAgreement(), 'u-other')).toBe(true);
    expect(canTerminate(makeAgreement(), 'u-third')).toBe(false);
    expect(canTerminate(makeAgreement({ status: 'terminated' }), 'u-me')).toBe(false);
    expect(canTerminate(makeAgreement({ status: 'rejected' }), 'u-me')).toBe(false);
  });

  it('invoke is consumer-only on active agreements', () => {
    const active = makeAgreement({ status: 'active', consumer: { id: 'u-other', displayName: '小C' } });
    expect(canInvoke(active, 'u-other')).toBe(true);
    expect(canInvoke(active, 'u-me')).toBe(false);
    expect(canInvoke(makeAgreement({ status: 'suspended' }), 'u-other')).toBe(false);
  });

  it('summarizeTerms renders quota/price/notes and the empty default', () => {
    expect(summarizeTerms({})).toBe('不限（默认条款）');
    expect(summarizeTerms({ quotaPerWindow: 10, windowSec: 60, meteringUnit: 'action' })).toBe(
      '配额 10 action / 60s',
    );
    expect(summarizeTerms({ notes: '仅工作日' })).toBe('仅工作日');
  });

  it('R2-FEAT-03: sortAgreementsForInbox — 待裁决置顶，两组内各按时间倒序', () => {
    // proposed + provider=u-me → 我能裁决；active → 不可裁决。
    const decideOld = makeAgreement({ id: 'ag-a', createdAt: '2026-01-01T00:00:00Z' });
    const waiting = makeAgreement({
      id: 'ag-c',
      status: 'active',
      createdAt: '2026-01-02T00:00:00Z',
    });
    const decideNew = makeAgreement({ id: 'ag-b', createdAt: '2026-01-03T00:00:00Z' });

    const sorted = sortAgreementsForInbox([decideOld, waiting, decideNew], 'u-me');

    expect(sorted.map(a => a.id)).toEqual(['ag-b', 'ag-a', 'ag-c']);
    // 未登录视角无可裁决行——纯时间倒序。
    expect(
      sortAgreementsForInbox([decideOld, waiting, decideNew], null).map(a => a.id),
    ).toEqual(['ag-b', 'ag-c', 'ag-a']);
  });

  it('R2-FEAT-03: dedupeAgreementsById 合并双信箱重复行；shortAgreementId 给可区分签名', () => {
    const dup = makeAgreement({ id: 'ag-dup-0001' });
    expect(dedupeAgreementsById([dup, dup, makeAgreement({ id: 'ag-x' })]).map(a => a.id)).toEqual(
      ['ag-dup-0001', 'ag-x'],
    );
    expect(shortAgreementId('ag-dup-0001')).toBe('#ag-dup-0');
  });
});

describe('AgreementsPanel', () => {
  // Panel text uses the active i18next bundle; pin to en-US so the English
  // assertions below stay exact.
  beforeAll(() => {
    void i18n.changeLanguage('en-US');
  });

  const inbox = [makeAgreement()];
  const outbox = [
    makeAgreement({
      id: 'ag-2',
      status: 'active',
      consumer: { id: 'u-me', displayName: '小A' },
      provider: { id: 'u-other', displayName: '小C' },
      service: { id: 'svc-2', name: '照明控制', semanticType: 'lighting' },
    }),
  ];
  const usage: UsageRecord[] = [
    {
      id: '1',
      agreementId: 'ag-2',
      envId: 'env-1',
      consumerAgentId: null,
      providerAgentId: 'agent-p',
      kind: 'invoke',
      action: 'turn-on',
      quantity: 1,
      unit: 'action',
      outcome: 'success',
      effectRef: '9',
      startedAt: '2026-01-01T01:00:00Z',
      endedAt: '2026-01-01T01:00:01Z',
    },
  ];

  beforeEach(() => {
    useAppStore.setState({ user: USER, toasts: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/agreements?envId=env-1&role=provider') {
          return jsonResponse({ agreements: inbox });
        }
        if (url === '/api/agreements?envId=env-1&role=consumer') {
          return jsonResponse({ agreements: outbox });
        }
        if (url === '/api/agreements/ag-1/decide' && method === 'POST') {
          return jsonResponse(makeAgreement({ status: 'active' }));
        }
        if (url === '/api/agreements/ag-2/invocations' && method === 'POST') {
          return jsonResponse({
            agreementId: 'ag-2',
            simulationId: 'sim-1',
            deviceId: 'dev-1',
            action: 'turn-on',
            success: true,
            usage: usage[0],
            receiptId: 'r-1',
          });
        }
        if (url === '/api/agreements/ag-2/usage') return jsonResponse({ usage });
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ user: null });
  });

  it('renders inbox + outbox and decides a proposed agreement', async () => {
    render(<AgreementsPanel world={makeWorld()} />);

    expect(await screen.findByText('Inbox (services I provide) (1)')).toBeTruthy();
    expect(screen.getByText('Outbox (agreements I consume) (1)')).toBeTruthy();
    // Inbox proposed row: provider-side decide buttons.
    expect(screen.getByText('Pending review')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    // R2-FEAT-03: rows carry the distinguishing signature (short id) so
    // duplicate proposals of the same service stay tellable apart.
    expect(screen.getByText('#ag-1')).toBeTruthy();

    screen.getByText('Accept').click();
    await waitFor(() => {
      const decideCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]) === '/api/agreements/ag-1/decide');
      expect(decideCall).toBeTruthy();
      expect(JSON.parse(String(decideCall?.[1]?.body))).toEqual({ decision: 'accept' });
    });
  });

  it('invokes an active outbox agreement with action + JSON params', async () => {
    render(<AgreementsPanel world={makeWorld()} />);

    (await screen.findByText('Invoke')).click();
    const actionInput = await screen.findByPlaceholderText('e.g. turn-on');
    const paramsInput = screen.getByPlaceholderText('{"brightness": 80}');
    setInputValue(actionInput, 'turn-on');
    setInputValue(paramsInput, '{"level": 3}');
    screen.getByText('Run invocation').click();

    await waitFor(() => {
      const invokeCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]) === '/api/agreements/ag-2/invocations');
      expect(invokeCall).toBeTruthy();
      expect(JSON.parse(String(invokeCall?.[1]?.body))).toEqual({
        action: 'turn-on',
        params: { level: 3 },
      });
    });
    expect(await screen.findByText(/Invocation succeeded/)).toBeTruthy();
  });

  it('expands the usage ledger of an agreement', async () => {
    render(<AgreementsPanel world={makeWorld()} />);

    (await screen.findAllByText('Usage ledger'))[1].click();
    expect(await screen.findByText('turn-on')).toBeTruthy();
    expect(screen.getByText('1 action')).toBeTruthy();
    expect(screen.getByText('success')).toBeTruthy();
  });
});

/** Controlled-input helper: fire a native change React picks up. */
function setInputValue(input: HTMLElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ServiceDetail 发起合约 (Fix-11/17)', () => {
  // Panel text uses the active i18next bundle; pin to en-US so the English
  // assertions below stay exact.
  beforeAll(() => {
    void i18n.changeLanguage('en-US');
  });

  it('posts a proposal from the service detail form', async () => {
    const { ServicesPanel } = await import('../components/world/ServicesPanel');
    const world: EnvironmentDetail = {
      ...makeWorld(),
      agents: [
        {
          id: 'agent-c',
          envId: 'env-1',
          name: '我的消费 Agent',
          capabilities: [],
          boundDeviceIds: [],
          managedZoneIds: [],
          llm: null,
          enabled: true,
          owner: { id: 'u-me', displayName: '小A' },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      services: [
        {
          id: 'svc-1',
          envId: 'env-1',
          name: '空调控制',
          semanticType: 'cooling',
          description: '',
          interface: {},
          origin: 'derived',
          sourceDeviceId: null,
          visibility: 'public',
          unbacked: false,
          consumable: true,
          provider: {
            id: 'agent-p',
            name: '空调管家',
            owner: { id: 'u-other', displayName: '小C' },
          },
          reputation: { score: 0.7, attempts: 0, successes: 0 },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    };
    useAppStore.setState({
      user: USER,
      toasts: [],
      selectedServiceId: 'svc-1',
      myServiceSubscriptions: [],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/services/svc-1/agreements' && init?.method === 'POST') {
          return jsonResponse(makeAgreement({ consumer: { id: 'u-me', displayName: '小A' } }), 201);
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );

    render(<ServicesPanel world={world} onShowDevice={() => {}} />);

    (await screen.findByText('Propose agreement')).click();
    // The consumer-agent select lists MY agents only.
    const select = await screen.findByText('我的消费 Agent');
    expect(select).toBeTruthy();
    // R80-FW4: the form PRE-SELECTS the first consumer agent (the empty
    // required combo was the R79 silent failure) — submit carries it.
    screen.getByText('Submit proposal').click();

    await waitFor(() => {
      const proposeCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]) === '/api/services/svc-1/agreements');
      expect(proposeCall).toBeTruthy();
      expect(JSON.parse(String(proposeCall?.[1]?.body))).toEqual({ consumerAgentId: 'agent-c' });
    });
    useAppStore.setState({ selectedServiceId: null });
  });
});
