/**
 * T-016 EvalRunsPanel (world sidebar 批量评估 tab): summary rows render from
 * a stubbed GET /api/environments/:id/eval-runs (status/arms/digest, newest
 * first as served), selecting a row loads the by-id report view
 * (GET /api/eval-runs/:id) inline, plus the empty and error states.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { EvalRunsPanel } from '../components/world/EvalRunsPanel';
import type { EnvironmentDetail } from '../api/types';
import i18n from '../i18n/config';
import { renderWithProviders } from './testUtils';

// Assertions use the zh-CN bundle; pin it like the other panel tests.
beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});
afterAll(() => {
  void i18n.changeLanguage('en-US');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const RUNS = [
  {
    id: 'evalrun-b',
    envId: 'env-1',
    createdBy: 'u-1',
    status: 'done',
    arms: 2,
    metricsDigest: {
      decisionAccuracy: 0.75,
      handshakeSuccessRate: 0.5,
      effectCheckPassRate: null,
    },
    createdAt: '2026-08-23T10:00:00.000Z',
    startedAt: '2026-08-23T10:00:01.000Z',
    finishedAt: '2026-08-23T10:01:00.000Z',
  },
  {
    id: 'evalrun-a',
    envId: 'env-1',
    createdBy: 'u-1',
    status: 'running',
    arms: 3,
    metricsDigest: {
      decisionAccuracy: null,
      handshakeSuccessRate: null,
      effectCheckPassRate: null,
    },
    createdAt: '2026-08-23T09:00:00.000Z',
    startedAt: '2026-08-23T09:00:01.000Z',
    finishedAt: null,
  },
];

const DETAIL = {
  id: 'evalrun-b',
  envId: 'env-1',
  createdBy: 'u-1',
  status: 'done',
  spec: { runs: [{ label: 'rule-a' }, { label: 'rule-b' }], events: [] },
  result: {
    envId: 'env-1',
    generatedAt: '2026-08-23T10:01:00.000Z',
    runs: [
      {
        label: 'rule-a',
        status: 'done',
        simId: 'sim-a',
        llm: 'rule-only',
        durationMs: 4000,
        metrics: {
          decisions: { accuracy: 1 },
          handshakes: { successRate: 1 },
          effectChecks: { passRate: null },
        },
      },
      {
        label: 'rule-b',
        status: 'failed',
        durationMs: 10,
        error: 'agent ghost not found',
      },
    ],
    comparison: {
      labels: ['rule-a', 'rule-b'],
      metrics: { accuracy: [1, null] },
    },
  },
  createdAt: '2026-08-23T10:00:00.000Z',
  startedAt: '2026-08-23T10:00:01.000Z',
  finishedAt: '2026-08-23T10:01:00.000Z',
};

const WORLD = { id: 'env-1' } as unknown as EnvironmentDetail;

function stubEvalRuns(listBody: unknown, detailBody: unknown = DETAIL, listStatus = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/environments/env-1/eval-runs') return jsonResponse(listBody, listStatus);
      if (url === '/api/eval-runs/evalrun-b') return jsonResponse(detailBody);
      return jsonResponse({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }, 404);
    }),
  );
}

describe('EvalRunsPanel (T-016)', () => {
  it('renders one summary row per run with status, arms and the digest', async () => {
    stubEvalRuns({ runs: RUNS });
    renderWithProviders(<EvalRunsPanel world={WORLD} />);

    expect(await screen.findByTestId('eval-runs-panel')).toBeTruthy();
    // Newest-first as served: the done batch's digest renders its means.
    expect((await screen.findAllByText('已完成'))).toHaveLength(1);
    expect(screen.getByText('运行中')).toBeTruthy();
    expect(screen.getByText('2 组')).toBeTruthy();
    expect(screen.getByText('3 组')).toBeTruthy();
    expect(screen.getByText('决策 75% · 握手 50% · 生效 —')).toBeTruthy();
    // Pending/running digest renders the all-null line.
    expect(screen.getByText('决策 — · 握手 — · 生效 —')).toBeTruthy();

    const urls = vi.mocked(fetch).mock.calls.map(call => String(call[0]));
    expect(urls[0]).toBe('/api/environments/env-1/eval-runs');
    // No detail fetch before a row is selected.
    expect(urls).toHaveLength(1);
  });

  it('opens the by-id report view inline when a row is selected', async () => {
    stubEvalRuns({ runs: RUNS });
    renderWithProviders(<EvalRunsPanel world={WORLD} />);

    await screen.findByTestId('eval-runs-panel');
    fireEvent.click(screen.getByText('已完成'));

    const detail = await screen.findByTestId('eval-run-detail');
    expect(detail).toBeTruthy();
    // Per-arm lines from the by-id document.
    expect(await screen.findByText('rule-a')).toBeTruthy();
    expect(screen.getByText('决策 100% · 握手 100%')).toBeTruthy();
    expect(await screen.findByText('rule-b')).toBeTruthy();
    expect(screen.getByText('agent ghost not found')).toBeTruthy();
    expect(screen.getByText('evalrun-b')).toBeTruthy();

    const urls = vi.mocked(fetch).mock.calls.map(call => String(call[0]));
    expect(urls).toContain('/api/eval-runs/evalrun-b');
  });

  it('shows the empty state for an environment without history', async () => {
    stubEvalRuns({ runs: [] });
    renderWithProviders(<EvalRunsPanel world={WORLD} />);

    expect(await screen.findByText(/还没有批量评估任务/)).toBeTruthy();
  });

  it('shows the error state when the list request fails', async () => {
    stubEvalRuns(
      { error: { code: 'FORBIDDEN', message: 'not a member' } },
      DETAIL,
      403,
    );
    renderWithProviders(<EvalRunsPanel world={WORLD} />);

    expect(await screen.findByText(/加载失败/)).toBeTruthy();
  });
});
