/**
 * P4-2 status-header line: triage agreement / saved big-model calls / cache
 * hit rate, derived from the snapshot's `llm` block.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../i18n/config';
import type { EngineSnapshot, SnapshotLlmMetrics } from '../api/types';
import { deriveLlmLine } from '../lib/llmMetrics';

// deriveLlmLine reads the active i18next bundle; pin to en-US so assertions
// are exact strings.
beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

function snapshotWith(llm?: SnapshotLlmMetrics): EngineSnapshot {
  return {
    runtimeId: 'runtime-x',
    scenarioId: 'x',
    scenarioName: 'X',
    state: 'running',
    simTimeSec: 10,
    simTime: new Date(0).toISOString(),
    speed: 1,
    tickCount: 10,
    zones: [],
    devices: [],
    agents: [],
    recentDecisions: [],
    scheduledEvents: [],
    ...(llm !== undefined ? { llm } : {}),
  };
}

const triageMetrics = (overrides: Partial<NonNullable<SnapshotLlmMetrics['triage']>> = {}) => ({
  mode: 'shadow' as const,
  model: 'ac-decision-15b-v2',
  triageCalls: 10,
  triageErrors: 0,
  agreements: 8,
  disagreements: 2,
  agreementRate: 0.8,
  bigModelCalls: 10,
  bigModelCallsSaved: 3,
  bigModelCallSaveRate: 0.3,
  avgTriageLatencyMs: 1500,
  avgBigModelLatencyMs: 9000,
  latencyDeltaMs: 7500,
  ...overrides,
});

describe('deriveLlmLine (P4-2)', () => {
  it('null when the snapshot has no llm block', () => {
    expect(deriveLlmLine(null)).toBeNull();
    expect(deriveLlmLine(snapshotWith())).toBeNull();
  });

  it('triage + cache: full compact line', () => {
    const line = deriveLlmLine(snapshotWith({
      triage: triageMetrics(),
      cache: { hits: 3, misses: 1, hitRate: 0.75, tokensSavedEstimate: 300, size: 4, maxSize: 500 },
    }));
    expect(line).toBe(
      'Triage: Agreement rate 80% · Saved 3 big-model calls · Big-model avg 9.0s · Triage avg 1.5s · Cache hit 75%',
    );
  });

  it('triage without any big-model comparison yet shows —', () => {
    const line = deriveLlmLine(snapshotWith({ triage: triageMetrics({ agreementRate: null, agreements: 0, disagreements: 0 }) }));
    expect(line).toBe('Triage: Agreement rate — · Saved 3 big-model calls · Big-model avg 9.0s · Triage avg 1.5s');
  });

  it('latency parts hidden until the corresponding model has answered', () => {
    const line = deriveLlmLine(snapshotWith({
      triage: triageMetrics({ avgBigModelLatencyMs: null, avgTriageLatencyMs: null, latencyDeltaMs: null }),
    }));
    expect(line).toBe('Triage: Agreement rate 80% · Saved 3 big-model calls');
  });

  it('sub-second latency stays in ms', () => {
    const line = deriveLlmLine(snapshotWith({
      triage: triageMetrics({ avgBigModelLatencyMs: 850, avgTriageLatencyMs: null, latencyDeltaMs: null }),
    }));
    expect(line).toBe('Triage: Agreement rate 80% · Saved 3 big-model calls · Big-model avg 850ms');
  });

  it('cache part hidden until the cache has seen a lookup', () => {
    const line = deriveLlmLine(snapshotWith({
      triage: triageMetrics(),
      cache: { hits: 0, misses: 0, hitRate: 0, tokensSavedEstimate: 0, size: 0, maxSize: 500 },
    }));
    expect(line).toBe(
      'Triage: Agreement rate 80% · Saved 3 big-model calls · Big-model avg 9.0s · Triage avg 1.5s',
    );
  });

  it('cache-only (no triage) drops the Triage prefix', () => {
    const line = deriveLlmLine(snapshotWith({
      cache: { hits: 1, misses: 3, hitRate: 0.25, tokensSavedEstimate: 100, size: 4, maxSize: 500 },
    }));
    expect(line).toBe('Cache hit 25%');
  });

  it('enforce mode reflects saved calls verbatim', () => {
    const line = deriveLlmLine(snapshotWith({
      triage: triageMetrics({ mode: 'enforce', bigModelCallsSaved: 7, agreementRate: 1 }),
    }));
    expect(line).toBe(
      'Triage: Agreement rate 100% · Saved 7 big-model calls · Big-model avg 9.0s · Triage avg 1.5s',
    );
  });
});
