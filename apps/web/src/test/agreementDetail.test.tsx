/**
 * T-066 surface 2 tests: the negotiation gates in lib/agreements (decide
 * right by state, counter, remind, terms diff) plus the AgreementDetail
 * view — countered status, termsEnforced badge, original vs countered vs
 * effective terms with the readable diff, per-state+role actions, the
 * rate-limited remind (429 retryAfterSec), and the panel-level
 * agreementTransparency count — driven by a stubbed fetch against the real
 * API client.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agreement, EnvironmentDetail } from '../api/types';
import i18n from '../i18n/config';
import { AgreementDetail } from '../components/world/AgreementDetail';
import { AgreementsPanel } from '../components/world/AgreementsPanel';
import {
  canCounter,
  canDecide,
  canRemind,
  deciderSide,
  effectiveTermsOf,
  termsDiffLines,
} from '../lib/agreements';
import { useAppStore } from '../store/useAppStore';

const PROVIDER = { id: 'u-me', email: 'me@example.com', displayName: '小A', createdAt: '2026-01-01T00:00:00Z' };
const CONSUMER = { id: 'u-them', email: 'them@example.com', displayName: '小C', createdAt: '2026-01-01T00:00:00Z' };

function makeAgreement(overrides: Partial<Agreement> = {}): Agreement {
  return {
    id: 'ag-1',
    envId: 'env-1',
    serviceId: 'svc-1',
    service: { id: 'svc-1', name: '逐床心率数据', semanticType: 'vital-signs' },
    backingDeviceId: null,
    callableActions: null,
    consumerAgentId: null,
    consumerAgentName: null,
    consumer: { id: 'u-them', displayName: '小C' },
    providerAgentId: 'agent-p',
    providerAgentName: '护理站',
    provider: { id: 'u-me', displayName: '小A' },
    terms: { quotaPerWindow: 10, windowSec: 3600 },
    termsEnforced: true,
    status: 'proposed',
    source: 'explicit',
    collaborationId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function counteredAgreement(): Agreement {
  return makeAgreement({
    status: 'countered',
    terms: { quotaPerWindow: 10, windowSec: 3600, notes: '仅工作日' },
    counteredTerms: { quotaPerWindow: 5, windowSec: 1800, read: { fields: ['heartRate'], quotaPerWindow: 60, windowSec: 3600 } },
    effectiveTerms: { quotaPerWindow: 5, windowSec: 1800, read: { fields: ['heartRate'], quotaPerWindow: 60, windowSec: 3600 } },
    termsEnforced: true,
  });
}

function makeWorld(overrides: Partial<EnvironmentDetail> = {}): EnvironmentDetail {
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
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('negotiation gates (lib/agreements, T-066)', () => {
  it('the decide right follows the state: provider on proposed, consumer on countered', () => {
    const proposed = makeAgreement();
    expect(deciderSide(proposed)).toBe('provider');
    expect(canDecide(proposed, 'u-me')).toBe(true);
    expect(canDecide(proposed, 'u-them')).toBe(false);

    const countered = counteredAgreement();
    expect(deciderSide(countered)).toBe('consumer');
    expect(canDecide(countered, 'u-them')).toBe(true);
    expect(canDecide(countered, 'u-me')).toBe(false);
    expect(canDecide(makeAgreement({ status: 'active' }), 'u-me')).toBe(false);
  });

  it('counter is provider-only on proposed agreements', () => {
    expect(canCounter(makeAgreement(), 'u-me')).toBe(true);
    expect(canCounter(makeAgreement(), 'u-them')).toBe(false);
    expect(canCounter(counteredAgreement(), 'u-me')).toBe(false);
    expect(canCounter(makeAgreement({ status: 'active' }), 'u-me')).toBe(false);
  });

  it('remind belongs to the WAITING side: consumer on proposed, provider on countered', () => {
    expect(canRemind(makeAgreement(), 'u-them')).toBe(true);
    expect(canRemind(makeAgreement(), 'u-me')).toBe(false);
    expect(canRemind(counteredAgreement(), 'u-me')).toBe(true);
    expect(canRemind(counteredAgreement(), 'u-them')).toBe(false);
    expect(canRemind(makeAgreement({ status: 'active' }), 'u-me')).toBe(false);
  });

  it('termsDiffLines reports added/removed/changed clauses', () => {
    const diff = termsDiffLines(
      { quotaPerWindow: 10, windowSec: 3600, notes: '仅工作日' },
      { quotaPerWindow: 5, windowSec: 3600, read: { fields: ['heartRate'] } },
    );
    expect(diff).toEqual([
      { key: 'quotaPerWindow', change: 'changed', before: '10', after: '5' },
      { key: 'notes', change: 'removed', before: '"仅工作日"' },
      { key: 'read', change: 'added', after: '{"fields":["heartRate"]}' },
    ]);
  });

  it('effectiveTermsOf prefers the server field, then computes from status', () => {
    expect(effectiveTermsOf(counteredAgreement()).quotaPerWindow).toBe(5);
    const withoutServerField = counteredAgreement();
    delete (withoutServerField as { effectiveTerms?: unknown }).effectiveTerms;
    expect(effectiveTermsOf(withoutServerField).quotaPerWindow).toBe(5);
    expect(effectiveTermsOf(makeAgreement()).quotaPerWindow).toBe(10);
  });
});

describe('AgreementDetail (T-066 surface 2)', () => {
  // Panel text uses the active i18next bundle; pin to zh-CN so the Chinese
  // assertions below stay exact.
  beforeAll(() => {
    void i18n.changeLanguage('zh-CN');
  });

  let detail = makeAgreement();

  beforeEach(() => {
    detail = makeAgreement();
    useAppStore.setState({ user: PROVIDER, toasts: [], selectedAgreementId: null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/agreements/ag-1' && method === 'GET') return jsonResponse(detail);
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ user: null, selectedAgreementId: null });
  });

  /** DetailSections collapse by default — open one by its toggle text. */
  async function openSection(title: string): Promise<void> {
    (await screen.findByText(title)).click();
  }

  it('renders status, termsEnforced badge, and the effective terms', async () => {
    render(<AgreementDetail world={makeWorld()} agreementId="ag-1" onClose={() => {}} onChanged={() => {}} />);

    expect((await screen.findByTestId('agreement-detail-name')).textContent).toContain('逐床心率数据');
    expect(screen.getByText('待审批')).toBeTruthy();
    expect(screen.getByTestId('agreement-terms-enforced').textContent).toContain('受结构化条款约束');
    await openSection('当前生效条款');
    expect(screen.getByText('配额 10 / 3600s')).toBeTruthy();
  });

  it('renders the countered status, both terms versions, and the readable diff', async () => {
    detail = counteredAgreement();
    render(<AgreementDetail world={makeWorld()} agreementId="ag-1" onClose={() => {}} onChanged={() => {}} />);

    expect(await screen.findByText('还价待决定')).toBeTruthy();
    expect(screen.getByTestId('agreement-decider-note').textContent).toContain('决定权在消费方');
    await openSection('还价条款（提供方）');
    const diff = screen.getByTestId('agreement-terms-diff');
    expect(diff.textContent).toContain('变更 quotaPerWindow：10 → 5');
    expect(diff.textContent).toContain('变更 windowSec：3600 → 1800');
    expect(diff.textContent).toContain('移除 notes');
    expect(diff.textContent).toContain('新增 read');
  });

  it('decides from the consumer side on a countered agreement (POST decide)', async () => {
    detail = counteredAgreement();
    useAppStore.setState({ user: CONSUMER });
    render(<AgreementDetail world={makeWorld()} agreementId="ag-1" onClose={() => {}} onChanged={() => {}} />);

    (await screen.findByText('接受')).click();
    await waitFor(() => {
      const decideCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]) === '/api/agreements/ag-1/decide');
      expect(decideCall).toBeTruthy();
      expect(JSON.parse(String(decideCall?.[1]?.body))).toEqual({ decision: 'accept' });
    });
  });

  it('counters a proposed agreement with a complete terms object', async () => {
    render(<AgreementDetail world={makeWorld()} agreementId="ag-1" onClose={() => {}} onChanged={() => {}} />);

    await openSection('还价（提供方）');
    (await screen.findByTestId('agreement-counter-toggle')).click();
    const textarea = await screen.findByTestId('agreement-counter-terms');
    setTextAreaValue(textarea, '{"quotaPerWindow":5,"windowSec":3600}');
    screen.getByText('提交还价').click();
    await waitFor(() => {
      const counterCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]) === '/api/agreements/ag-1/counter');
      expect(counterCall).toBeTruthy();
      expect(JSON.parse(String(counterCall?.[1]?.body))).toEqual({
        terms: { quotaPerWindow: 5, windowSec: 3600 },
      });
    });
  });

  it('renders remind retryAfterSec verbatim on the 429 rate limit', async () => {
    detail = counteredAgreement(); // provider waits on the consumer → provider may remind
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/agreements/ag-1' && method === 'GET') return jsonResponse(detail);
        if (url === '/api/agreements/ag-1/remind' && method === 'POST') {
          return jsonResponse(
            {
              error: {
                code: 'REMIND_RATE_LIMITED',
                message: 'a reminder was already sent recently — retry in ~540s',
                retryAfterSec: 540,
              },
            },
            429,
          );
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );
    render(<AgreementDetail world={makeWorld()} agreementId="ag-1" onClose={() => {}} onChanged={() => { }} />);

    (await screen.findByText('提醒对方')).click();
    const note = await screen.findByTestId('agreement-remind-note');
    expect(note.textContent).toContain('540');
    expect(note.textContent).toContain('秒后可再次提醒');
  });

  it('hides remind from the decider side (proposed → provider decides, provider sees no remind)', async () => {
    render(<AgreementDetail world={makeWorld()} agreementId="ag-1" onClose={() => {}} onChanged={() => {}} />);
    await screen.findByTestId('agreement-detail-name');
    expect(screen.queryByTestId('agreement-remind')).toBeNull();
    // The provider CAN decide the proposal.
    expect(screen.getByText('接受')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();
  });
});

describe('AgreementsPanel integration (T-066 surface 2)', () => {
  beforeAll(() => {
    void i18n.changeLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ user: null, selectedAgreementId: null });
  });

  it('surfaces the non-attributed agreementTransparency.activeCount', async () => {
    useAppStore.setState({ user: PROVIDER, toasts: [] });
    const world = makeWorld({ agreementTransparency: { activeCount: 7, note: 'server note' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/agreements?envId=env-1&role=provider') return jsonResponse({ agreements: [] });
        if (url === '/api/agreements?envId=env-1&role=consumer') return jsonResponse({ agreements: [] });
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );
    render(<AgreementsPanel world={world} />);

    expect((await screen.findByTestId('agreement-transparency')).textContent).toContain('7 个生效协议');
  });

  it('a row 详情 button and the replyHint deep-link (selectedAgreementId) both open the detail', async () => {
    useAppStore.setState({ user: PROVIDER, toasts: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/agreements?envId=env-1&role=provider') return jsonResponse({ agreements: [makeAgreement()] });
        if (url === '/api/agreements?envId=env-1&role=consumer') return jsonResponse({ agreements: [] });
        if (url === '/api/agreements/ag-1' && method === 'GET') return jsonResponse(makeAgreement());
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );

    // 1) Row button opens the detail (panel refetches the single agreement).
    const { unmount } = render(<AgreementsPanel world={makeWorld()} />);
    (await screen.findAllByTestId('agreement-detail-open'))[0].click();
    expect(await screen.findByTestId('agreement-detail-name')).toBeTruthy();
    unmount();

    // 2) The notification replyHint affordance preselects the id — the panel
    //    opens straight into the detail (surface 1 → surface 2 hand-off).
    useAppStore.setState({ selectedAgreementId: 'ag-1' });
    render(<AgreementsPanel world={makeWorld()} />);
    expect(await screen.findByTestId('agreement-detail-name')).toBeTruthy();
  });
});

/** Controlled-textarea helper: fire a native change React picks up. */
function setTextAreaValue(node: HTMLElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
}
