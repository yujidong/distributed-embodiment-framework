/**
 * Observability card derivation (P4-4) — pure view-model for the workbench
 * 系统 card, so the component stays a dumb renderer and the formatting rules
 * are unit-testable.
 *
 * NB on semantics: the server's counters are process-lifetime (they reset on
 * restart), so "LLM tokens" is labeled 自启动, not 今日.
 */

import type { AdminObservability } from '../api/types';
import i18n from '../i18n/config';

export interface ObservabilityCardRow {
  label: string;
  value: string;
  /** Extra detail shown on hover. */
  title?: string;
}

/** Coarse, human-scale uptime ("1d 1h" / "1h 2m" / "6m 7s" in en-US). */
export function formatUptime(totalSec: number): string {
  const t = i18n.getFixedT(i18n.language, 'observability');
  const sec = Math.max(0, Math.floor(totalSec));
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  if (days > 0) return t('uptime.daysHours', { days, hours });
  if (hours > 0) return t('uptime.hoursMinutes', { hours, minutes });
  if (minutes > 0) return t('uptime.minutesSeconds', { minutes, seconds });
  return t('uptime.seconds', { seconds });
}

/** Grouped thousands (12,345) for token-scale numbers. */
export function formatInt(n: number): string {
  return Math.floor(n).toLocaleString('en-US');
}

/** Percent string, or '—' when the cache has seen no lookups yet. */
export function formatCacheHitRate(cache: { hits: number; misses: number }): string {
  const total = cache.hits + cache.misses;
  if (total === 0) return '—';
  return `${Math.round((cache.hits / total) * 100)}%`;
}

/** Simulations counted as 运行中: running + paused (mirrors the server quota). */
export function runningSimCount(summary: AdminObservability): number {
  return (summary.simulations.byState['running'] ?? 0) + (summary.simulations.byState['paused'] ?? 0);
}

/** The card's rows, top to bottom. */
export function observabilityCardRows(summary: AdminObservability): ObservabilityCardRow[] {
  const t = i18n.getFixedT(i18n.language, 'observability');
  const states = summary.simulations.byState;
  const stateBreakdown = (['created', 'running', 'paused', 'stopped'] as const)
    .map(state => `${state} ${states[state] ?? 0}`)
    .join(' · ');
  return [
    { label: t('card.uptime'), value: formatUptime(summary.uptimeSec), title: t('cardTitle.uptime', { startedAt: summary.startedAt }) },
    {
      label: t('card.runningSims'),
      value: String(runningSimCount(summary)),
      title: t('cardTitle.runningSims', { total: summary.simulations.total, breakdown: stateBreakdown }),
    },
    {
      label: t('card.llmTokens'),
      value: formatInt(summary.llm.tokens.total),
      title: t('cardTitle.llmTokens', { prompt: formatInt(summary.llm.tokens.prompt), completion: formatInt(summary.llm.tokens.completion) }),
    },
    {
      label: t('card.llmCacheHitRate'),
      value: formatCacheHitRate(summary.llm.cache),
      title: t('cardTitle.llmCacheHitRate', { hits: formatInt(summary.llm.cache.hits), misses: formatInt(summary.llm.cache.misses) }),
    },
    {
      label: t('card.rateLimited'),
      value: formatInt(summary.http.rateLimited),
      title: t('cardTitle.rateLimited', { total: formatInt(summary.http.requestsTotal) }),
    },
  ];
}
