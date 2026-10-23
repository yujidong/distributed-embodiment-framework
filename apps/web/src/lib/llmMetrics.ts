/**
 * LLM cost-reduction readout (P4-2) — pure derivation for the sim console
 * status header. Mirrors the snapshot's `llm` block into one compact line:
 *
 *   分流: 协议一致率 x% · 节省 y 次大模型调用 · 大模型均延 9.0s · 分流均延 1.5s · 缓存命中 z%
 *
 * - Triage parts appear only when triage ran (snapshot.llm.triage present);
 *   the agreement rate shows '—' until the big model has answered at least
 *   once after a triage decision (nothing to compare yet).
 * - Latency parts (R14) appear per-model once that model has answered at
 *   least once (the snapshot reports null averages before then).
 * - The cache part appears only once the cache has seen at least one lookup;
 *   with triage it joins the same line, without triage the line is cache-only.
 */

import type { EngineSnapshot } from '../api/types';
import i18n from '../i18n/config';

/** Compact latency readout: sub-second values stay in ms, longer ones in s. */
export function formatLatencyMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function deriveLlmLine(snapshot: EngineSnapshot | null): string | null {
  const llm = snapshot?.llm;
  if (!llm) return null;

  const parts: string[] = [];

  if (llm.triage) {
    const triage = llm.triage;
    const agreement =
      triage.agreementRate === null ? '—' : `${Math.round(triage.agreementRate * 100)}%`;
    parts.push(
      i18n.t('llmMetricsLib:agreementRate', { value: agreement }),
      i18n.t('llmMetricsLib:savedCalls', { count: triage.bigModelCallsSaved }),
    );
    // R14: latency visibility — averages are null until the corresponding
    // model has answered at least once; show only what has data.
    if (triage.avgBigModelLatencyMs !== null) {
      parts.push(
        i18n.t('llmMetricsLib:bigModelLatency', {
          value: formatLatencyMs(triage.avgBigModelLatencyMs),
        }),
      );
    }
    if (triage.avgTriageLatencyMs !== null) {
      parts.push(
        i18n.t('llmMetricsLib:triageLatency', {
          value: formatLatencyMs(triage.avgTriageLatencyMs),
        }),
      );
    }
  }

  if (llm.cache && llm.cache.hits + llm.cache.misses > 0) {
    parts.push(i18n.t('llmMetricsLib:cacheHit', { percent: Math.round(llm.cache.hitRate * 100) }));
  }

  if (parts.length === 0) return null;
  const sep = i18n.t('llmMetricsLib:separator');
  return llm.triage ? `${i18n.t('llmMetricsLib:triagePrefix')}${parts.join(sep)}` : parts.join(sep);
}
