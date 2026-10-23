/**
 * T-066 surface 3 tests: the data-read machinery — lib/dataRead pure
 * helpers (read-clause resolution, canReadAgreement gating, the quota meter
 * mirroring the server's counting) plus the AgreementReadPanel as mounted
 * inside AgreementDetail: POST /reads and GET /reads/latest, DataFrame
 * rendering with provenance, cached/freshness/stale states (stale must LOOK
 * stale), the quota meter, the receipts trail, and the verbatim teaching
 * error states (AGREEMENT_TERMS_VIOLATION / QUOTA_EXCEEDED / DATA_STALE /
 * ACCESS_GRANT_REVOKED) — driven by a stubbed fetch against the real API
 * client.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  Agreement,
  DataReadResult,
  EnvironmentDetail,
  SettlementReceipt,
  UsageRecord,
} from '../api/types';
import i18n from '../i18n/config';
import { AgreementDetail } from '../components/world/AgreementDetail';
import { canReadAgreement, readQuotaMeter, readTermsOf } from '../lib/dataRead';
import { useAppStore } from '../store/useAppStore';

const CONSUMER = {
  id: 'u-me',
  email: 'me@example.com',
  displayName: '小A',
  createdAt: '2026-01-01T00:00:00Z',
};

const NOW_MS = Date.parse('2026-01-02T12:00:00Z');
const READ_TERMS = { fields: ['heartRate', 'spo2'], quotaPerWindow: 60, windowSec: 3600, minFreshnessSec: 30 };

function activeReadAgreement(overrides: Partial<Agreement> = {}): Agreement {
  return {
    id: 'ag-1',
    envId: 'env-1',
    serviceId: 'svc-1',
    service: { id: 'svc-1', name: '1床生命体征', semanticType: 'vital-signs' },
    backingDeviceId: null,
    callableActions: null,
    consumerAgentId: null,
    consumerAgentName: null,
    consumer: { id: 'u-me', displayName: '小A' },
    providerAgentId: 'agent-p',
    providerAgentName: '护理站',
    provider: { id: 'u-them', displayName: '小C' },
    terms: { read: READ_TERMS },
    termsEnforced: true,
    status: 'active',
    source: 'explicit',
    collaborationId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function usageRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'u-1',
    agreementId: 'ag-1',
    envId: 'env-1',
    consumerAgentId: null,
    providerAgentId: 'agent-p',
    kind: 'read',
    action: null,
    quantity: 1,
    unit: 'reading',
    outcome: 'success',
    effectRef: null,
    startedAt: '2026-01-02T11:50:00Z',
    endedAt: '2026-01-02T11:50:00Z',
    ...overrides,
  };
}

function makeReadResult(overrides: Partial<DataReadResult> = {}): DataReadResult {
  return {
    agreementId: 'ag-1',
    simulationId: null,
    frame: {
      kind: 'data',
      agreementId: 'ag-1',
      serviceId: 'svc-1',
      schemaVersion: 2,
      data: { heartRate: 72, spo2: null },
      provenance: {
        computationKind: 'device-aggregate',
        inputsSummary: { zones: 0, devices: 1, eventsWindowed: 0 },
        providerAgentId: 'agent-p',
        registeredBy: 'u-them',
        computedAtWall: '2026-01-02T11:59:48Z',
        simTimeSec: 120,
        simulationId: null,
        cached: true,
      },
      freshnessSec: 12,
      stale: false,
    },
    applied: { fields: ['heartRate', 'spo2'], meteringUnit: 'reading', retentionSec: 86400 },
    termsEnforced: true,
    usage: usageRecord(),
    receiptId: 'r-1',
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

describe('lib/dataRead (T-066 surface 3)', () => {
  it('readTermsOf prefers the server effectiveTerms, then the countered variant', () => {
    expect(readTermsOf(activeReadAgreement())).toEqual(READ_TERMS);
    const countered = activeReadAgreement({
      status: 'countered',
      terms: {},
      counteredTerms: { read: { fields: ['heartRate'] } },
    });
    expect(readTermsOf(countered)).toEqual({ fields: ['heartRate'] });
    expect(readTermsOf(activeReadAgreement({ effectiveTerms: { read: { quotaPerWindow: 1 } } }))).toEqual(
      { quotaPerWindow: 1 },
    );
  });

  it('canReadAgreement gates on consumer + active + read clause', () => {
    expect(canReadAgreement(activeReadAgreement(), 'u-me')).toBe(true);
    expect(canReadAgreement(activeReadAgreement(), 'u-them')).toBe(false);
    expect(canReadAgreement(activeReadAgreement({ status: 'suspended' }), 'u-me')).toBe(false);
    expect(canReadAgreement(activeReadAgreement({ terms: {} }), 'u-me')).toBe(false);
  });

  it('the quota meter counts kind=read success rows in the sliding window only', () => {
    const usage = [
      usageRecord(), // in window, success
      usageRecord({ id: 'u-2', startedAt: '2026-01-02T11:30:00Z' }), // in window
      usageRecord({ id: 'u-3', outcome: 'failure' }), // failed reads burn no quota
      usageRecord({ id: 'u-4', kind: 'invoke', unit: 'action' }), // other kinds don't count
      usageRecord({ id: 'u-5', startedAt: '2026-01-02T10:00:00Z' }), // outside the 1h window
    ];
    const meter = readQuotaMeter(usage, READ_TERMS, undefined, '2026-01-01T00:00:00Z', NOW_MS);
    expect(meter).toEqual({
      used: 2,
      limit: 60,
      windowSec: 3600,
      windowStartIso: '2026-01-02T11:00:00.000Z',
    });
  });

  it('fixed windows tumble from the agreement anchor (server readWindowStartIso semantics)', () => {
    // Anchor 10:00, window 1h, now 12:00 → current window started 12:00.
    const meter = readQuotaMeter(
      [usageRecord({ startedAt: '2026-01-02T10:30:00Z' })],
      READ_TERMS,
      'fixed',
      '2026-01-02T10:00:00Z',
      NOW_MS,
    );
    expect(meter?.used).toBe(0);
    expect(meter?.windowStartIso).toBe('2026-01-02T12:00:00.000Z');
  });

  it('no quota clause → no meter (null)', () => {
    expect(readQuotaMeter([], { fields: ['heartRate'] }, undefined, '2026-01-01T00:00:00Z', NOW_MS)).toBeNull();
  });
});

describe('AgreementReadPanel (mounted via AgreementDetail)', () => {
  beforeAll(() => {
    void i18n.changeLanguage('zh-CN');
  });

  let agreement = activeReadAgreement();
  let readResult: DataReadResult | null = makeReadResult();
  let readError: { status: number; body: unknown } | null = null;
  // The sliding quota window uses the real clock — fixtures are relative to now.
  const tenMinAgoIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const usage: UsageRecord[] = [
    usageRecord({ startedAt: tenMinAgoIso, endedAt: tenMinAgoIso }),
    usageRecord({ id: 'u-2', startedAt: tenMinAgoIso, endedAt: tenMinAgoIso }),
  ];
  const receipts: SettlementReceipt[] = [
    {
      id: 'r-1',
      agreementId: 'ag-1',
      provider: 'null',
      status: 'recorded',
      usageRecordIds: ['u-1'],
      quote: null,
      createdAt: '2026-01-02T11:50:00Z',
    },
  ];

  beforeEach(() => {
    agreement = activeReadAgreement();
    readResult = makeReadResult();
    readError = null;
    useAppStore.setState({ user: CONSUMER, toasts: [], selectedAgreementId: null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/agreements/ag-1' && method === 'GET') return jsonResponse(agreement);
        if (url === '/api/agreements/ag-1/usage' && method === 'GET') return jsonResponse({ usage });
        if (url === '/api/agreements/ag-1/reads' && method === 'POST') {
          if (readError !== null) return jsonResponse(readError.body, readError.status);
          return jsonResponse(readResult);
        }
        if (url === '/api/agreements/ag-1/reads/latest' && method === 'GET') {
          if (readError !== null) return jsonResponse(readError.body, readError.status);
          return jsonResponse(readResult);
        }
        if (url === '/api/agreements/ag-1/receipts' && method === 'GET') {
          return jsonResponse({ receipts });
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ user: null, selectedAgreementId: null });
  });

  async function renderDetail(): Promise<void> {
    render(
      <AgreementDetail world={makeWorld()} agreementId="ag-1" onClose={() => {}} onChanged={() => {}} />,
    );
    (await screen.findByText('数据读取（terms.read）')).click();
  }

  it('shows the quota meter mirroring kind=read usage, then reads and renders the frame', async () => {
    await renderDetail();

    expect((await screen.findByTestId('read-quota-meter')).textContent).toContain('2 / 60');
    screen.getByTestId('read-now').click();

    await waitFor(() => {
      const readCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]) === '/api/agreements/ag-1/reads');
      expect(readCall).toBeTruthy();
      // Empty fields input → empty body (server defaults to every allowed field).
      expect(JSON.parse(String(readCall?.[1]?.body ?? '{}'))).toEqual({});
    });
    const result = await screen.findByTestId('read-result');
    expect(result.textContent).toContain('72');
    expect(result.textContent).toContain('（该输入无可用数据）');
    expect(screen.getByText('缓存帧')).toBeTruthy();
    expect(screen.getByText('帧龄 12s')).toBeTruthy();
    expect(screen.getByTestId('read-provenance').textContent).toContain('1 台设备');
    expect(screen.getByTestId('read-provenance').textContent).toContain('（无——帧来自缓存）');
  });

  it('narrows fields from the comma-separated input', async () => {
    await renderDetail();

    const input = await screen.findByTestId('read-fields-input');
    setInputValue(input, 'heartRate, spo2');
    screen.getByTestId('read-now').click();
    await waitFor(() => {
      const readCall = vi
        .mocked(fetch)
        .mock.calls.find(call => String(call[0]) === '/api/agreements/ag-1/reads');
      expect(JSON.parse(String(readCall?.[1]?.body))).toEqual({ fields: ['heartRate', 'spo2'] });
    });
  });

  it('a stale frame LOOKS stale (class + note) and carries the danger badge', async () => {
    readResult = makeReadResult({
      frame: {
        ...makeReadResult().frame,
        stale: true,
        freshnessSec: 940,
      },
    });
    await renderDetail();

    screen.getByTestId('read-now').click();
    const result = await screen.findByTestId('read-result');
    expect(result.className).toContain('read-result--stale');
    expect(screen.getByText('已过期')).toBeTruthy();
    expect(result.textContent).toContain('该帧已超过条款的 minFreshnessSec');
  });

  it('the latest-frame button hits the cheap GET lane', async () => {
    await renderDetail();

    screen.getByTestId('read-latest').click();
    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(
          call => String(call[0]) === '/api/agreements/ag-1/reads/latest' && (call[1]?.method ?? 'GET') === 'GET',
        ),
      ).toBe(true);
    });
    expect(await screen.findByTestId('read-result')).toBeTruthy();
  });

  it('renders QUOTA_EXCEEDED verbatim with teaching copy and machine fields', async () => {
    readError = {
      status: 429,
      body: {
        error: {
          code: 'QUOTA_EXCEEDED',
          message: 'Agreement "ag-1" read quota exceeded: 60/60 reads in the current 3600s window',
          quota: 'agreement_read_per_window',
          limit: 60,
          current: 60,
        },
      },
    };
    await renderDetail();

    screen.getByTestId('read-now').click();
    const error = await screen.findByTestId('read-error');
    expect(error.textContent).toContain('QUOTA_EXCEEDED');
    expect(error.textContent).toContain('read quota exceeded: 60/60');
    expect(error.textContent).toContain('本窗口的读取预算已用完');
    expect(error.textContent).toContain('"limit":60');
    expect(screen.queryByTestId('read-result')).toBeNull();
  });

  it('renders DATA_STALE with freshness machine fields and the recompute teaching', async () => {
    readError = {
      status: 409,
      body: {
        error: {
          code: 'DATA_STALE',
          message: 'cached frame is 940s old, terms.read.minFreshnessSec is 30',
          freshnessSec: 940,
          minFreshnessSec: 30,
        },
      },
    };
    await renderDetail();

    screen.getByTestId('read-latest').click();
    const error = await screen.findByTestId('read-error');
    expect(error.textContent).toContain('DATA_STALE');
    expect(error.textContent).toContain('而不是交付旧数据冒充新数据');
    expect(error.textContent).toContain('"freshnessSec":940');
  });

  it('renders AGREEMENT_TERMS_VIOLATION and ACCESS_GRANT_REVOKED verbatim with teaching copy', async () => {
    readError = {
      status: 422,
      body: {
        error: {
          code: 'AGREEMENT_TERMS_VIOLATION',
          message: 'requested fields fall outside terms.read.fields',
          allowedFields: ['heartRate', 'spo2'],
          requestedFields: ['heartRate', 'roomTemp'],
        },
      },
    };
    await renderDetail();
    screen.getByTestId('read-now').click();
    let error = await screen.findByTestId('read-error');
    expect(error.textContent).toContain('AGREEMENT_TERMS_VIOLATION');
    expect(error.textContent).toContain('只能收窄，不能放宽');

    readError = {
      status: 409,
      body: {
        error: {
          code: 'ACCESS_GRANT_REVOKED',
          message: 'the access grant for this hidden service was revoked',
        },
      },
    };
    screen.getByTestId('read-latest').click();
    await waitFor(() => {
      expect(screen.getByTestId('read-error').textContent).toContain('ACCESS_GRANT_REVOKED');
    });
    error = screen.getByTestId('read-error');
    expect(error.textContent).toContain('重新申请访问');
  });

  it('expands the receipts trail', async () => {
    await renderDetail();

    screen.getByTestId('read-receipts-toggle').click();
    const table = await screen.findByTestId('read-receipts-table');
    expect(table.textContent).toContain('r-1');
    expect(table.textContent).toContain('1 条');
  });

  it('hides the read panel for agreements without terms.read', async () => {
    agreement = activeReadAgreement({ terms: {} });
    render(
      <AgreementDetail world={makeWorld()} agreementId="ag-1" onClose={() => {}} onChanged={() => {}} />,
    );
    await screen.findByTestId('agreement-detail-name');
    expect(screen.queryByText('数据读取（terms.read）')).toBeNull();
  });
});

/** Controlled-input helper: fire a native change React picks up. */
function setInputValue(input: HTMLElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
