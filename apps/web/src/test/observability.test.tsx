/**
 * Observability card tests (P4-4): the row derivation (lib/observability)
 * and the card's fetch → render path. The admin gate itself is a one-liner in
 * WorkbenchPage (`user?.isAdmin === true && <ObservabilityCard />`) driven by
 * GET /api/auth/me, covered on the server side.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminObservability } from '../api/types';
import i18n from '../i18n/config';
import { ObservabilityCard } from '../components/ObservabilityCard';
import {
  formatCacheHitRate,
  formatInt,
  formatUptime,
  observabilityCardRows,
  runningSimCount,
} from '../lib/observability';

// lib/observability reads the active i18next bundle at call time; pin to en-US
// so the assertions can be exact English strings.
beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

function makeSummary(overrides: Partial<AdminObservability> = {}): AdminObservability {
  return {
    uptimeSec: 90061, // 1 天 1 小时 1 分 1 秒
    startedAt: '2026-07-22T00:00:00.000Z',
    process: { rssBytes: 317_000_000, heapUsedBytes: 100_000_000, heapTotalBytes: 200_000_000, externalBytes: 3_000_000 },
    http: { requestsTotal: 4321, byRouteClass: { auth: 10 }, byStatus: { '200': 10 }, rateLimited: 7 },
    websockets: { environment: 1, simulation: 2, subscribers: 3 },
    simulations: { total: 4, byState: { created: 1, running: 2, paused: 1, stopped: 0 } },
    simRuntime: {
      autoThrottledCount: 1,
      maxTickWallMs: 812,
      avgTickWallMs: 604,
      perSim: [],
    },
    llm: {
      tokens: { prompt: 12345, completion: 2345, total: 14690 },
      latency: { calls: 12, errors: 0, avgMs: 9000, p50Ms: 5000, p95Ms: 33000, p99Ms: 34000, maxMs: 35000 },
      queue: { active: 0, queued: 0, maxConcurrent: 3, waitCount: 23, avgWaitMs: 8187, maxWaitMs: 15030, depthHighWater: 20 },
      cache: { hits: 30, misses: 10, hitRate: 0.75, tokensSavedEstimate: 900, size: 5, maxSize: 500 },
      triage: {
        triageCalls: 12,
        triageErrors: 1,
        agreements: 9,
        disagreements: 2,
        bigModelCalls: 11,
        bigModelCallsSaved: 1,
      },
    },
    db: { sizeBytes: 1024 },
    counts: { users: 3, environments: 2, devices: 9, agents: 4 },
    recentErrors: [],
    ...overrides,
  };
}

describe('observability derivation (P4-4)', () => {
  it('formatUptime picks a human-scale unit', () => {
    expect(formatUptime(7)).toBe('7s');
    expect(formatUptime(67)).toBe('1m 7s');
    expect(formatUptime(3723)).toBe('1h 2m');
    expect(formatUptime(90061)).toBe('1d 1h');
    expect(formatUptime(-5)).toBe('0s');
  });

  it('formatInt groups thousands', () => {
    expect(formatInt(14690)).toBe('14,690');
    expect(formatInt(0)).toBe('0');
  });

  it('formatCacheHitRate is a percent, or — with no lookups', () => {
    expect(formatCacheHitRate({ hits: 30, misses: 10 })).toBe('75%');
    expect(formatCacheHitRate({ hits: 0, misses: 0 })).toBe('—');
  });

  it('runningSimCount sums running + paused only', () => {
    expect(runningSimCount(makeSummary())).toBe(3);
  });

  it('observabilityCardRows covers the five card metrics in order', () => {
    const rows = observabilityCardRows(makeSummary());
    expect(rows.map(row => row.label)).toEqual([
      'Uptime',
      'Running simulations',
      'LLM tokens (since startup)',
      'LLM cache hit rate',
      '429 responses',
    ]);
    expect(rows.map(row => row.value)).toEqual(['1d 1h', '3', '14,690', '75%', '7']);
  });
});

describe('ObservabilityCard', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(makeSummary()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the rows fetched from /api/admin/observability', async () => {
    render(<ObservabilityCard />);
    await waitFor(() => expect(screen.getByText('System')).toBeTruthy());
    expect(screen.getByText('Uptime')).toBeTruthy();
    expect(screen.getByText('1d 1h')).toBeTruthy();
    expect(screen.getByText('Running simulations')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('LLM tokens (since startup)')).toBeTruthy();
    expect(screen.getByText('14,690')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('429 responses')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/admin/observability');
  });

  it('renders nothing until the first successful poll', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    const { container } = render(<ObservabilityCard />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
