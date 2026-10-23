/**
 * EvalRunsPanel (T-016) — the world sidebar's 批量评估 tab: the environment's
 * batch-eval job history (GET /api/environments/:id/eval-runs, newest first)
 * with summary rows (status / created / arms / metrics digest). Selecting a
 * row opens the by-id report view (GET /api/eval-runs/:id) inline — per-arm
 * results and the cross-run comparison live there, not in the summary.
 *
 * The list refreshes every 5s while any job is still pending/running so the
 * author can watch an A/B batch settle; settled histories ride the normal
 * 30s staleness. Member-gated like the route (the tab itself is hidden for
 * anonymous visitors — see WorldSidebar).
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, FlaskConical } from 'lucide-react';

import * as api from '../../api/client';
import type {
  EnvironmentDetail,
  EvalRunJob,
  EvalRunStatus,
  EvalRunSummary,
} from '../../api/types';
import { queryKeys } from '../../lib/queryClient';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/EmptyState';

const ACTIVE_POLL_MS = 5000;

function formatPct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusClass(status: EvalRunStatus): string {
  return `badge badge--eval-${status}`;
}

export function EvalRunsPanel({ world }: { world: EnvironmentDetail }) {
  const { t } = useTranslation('evalRuns');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: queryKeys.environments.evalRuns(world.id),
    queryFn: () => api.listEvalRuns(world.id),
    refetchInterval: query =>
      (query.state.data ?? []).some(run => run.status === 'pending' || run.status === 'running')
        ? ACTIVE_POLL_MS
        : false,
  });

  // The by-id report view for the selected row (the same document the
  // polling API contract documents for job status/result).
  const detail = useQuery({
    queryKey: queryKeys.environments.evalRunDetail(selectedId ?? ''),
    queryFn: () => api.getEvalRun(selectedId!),
    enabled: selectedId !== null,
    refetchInterval: query =>
      query.state.data !== undefined &&
      (query.state.data.status === 'pending' || query.state.data.status === 'running')
        ? ACTIVE_POLL_MS
        : false,
  });

  if (runs.isPending) {
    return <p className="page-note">{t('loading')}</p>;
  }
  if (runs.isError) {
    return (
      <p className="page-note page-note--error">
        {t('loadFailed', { error: errorMessage(runs.error) })}
      </p>
    );
  }
  if (!runs.data || runs.data.length === 0) {
    return (
      <div className="eval-runs-panel">
        <h3 className="side-panel__title">{t('title')}</h3>
        <EmptyState compact icon={FlaskConical} title={t('empty')} />
      </div>
    );
  }

  return (
    <div className="eval-runs-panel" data-testid="eval-runs-panel">
      <h3 className="side-panel__title">{t('title')}</h3>
      {runs.data.map(run => (
        <div key={run.id} className="eval-runs-panel__row">
          <button
            type="button"
            className="eval-runs-panel__head"
            aria-expanded={selectedId === run.id}
            onClick={() => setSelectedId(selectedId === run.id ? null : run.id)}
          >
            <Icon icon={selectedId === run.id ? ChevronDown : ChevronRight} size={13} />
            <span className={statusClass(run.status)}>{t(`status.${run.status}`)}</span>
            <span className="eval-runs-panel__meta">{t('arms', { count: run.arms })}</span>
            <span className="eval-runs-panel__time">{formatTime(run.createdAt)}</span>
          </button>
          <div className="eval-runs-panel__digest">
            {t('digest', {
              accuracy: formatPct(run.metricsDigest.decisionAccuracy),
              handshake: formatPct(run.metricsDigest.handshakeSuccessRate),
              effect: formatPct(run.metricsDigest.effectCheckPassRate),
            })}
          </div>
          {selectedId === run.id && (
            <EvalRunDetailRow
              summary={run}
              detailState={
                detail.isError
                  ? { kind: 'error', message: errorMessage(detail.error) }
                  : detail.data === undefined
                    ? { kind: 'loading' }
                    : { kind: 'job', job: detail.data }
              }
            />
          )}
        </div>
      ))}
    </div>
  );
}

type EvalRunDetailState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'job'; job: EvalRunJob };

function EvalRunDetailRow({
  summary,
  detailState,
}: {
  summary: EvalRunSummary;
  detailState: EvalRunDetailState;
}) {
  const { t } = useTranslation('evalRuns');
  return (
    <div className="eval-runs-panel__detail" data-testid="eval-run-detail">
      <div className="eval-runs-panel__id" title={summary.id}>{summary.id}</div>
      {detailState.kind === 'loading' && <p className="page-note">{t('detailLoading')}</p>}
      {detailState.kind === 'error' && (
        <p className="page-note page-note--error">{t('detailFailed', { error: detailState.message })}</p>
      )}
      {detailState.kind === 'job' && detailState.job.error !== undefined && (
        <p className="page-note page-note--error">{detailState.job.error}</p>
      )}
      {detailState.kind === 'job' && detailState.job.result !== undefined && (
        <ul className="eval-runs-panel__arms">
          {(detailState.job.result.runs ?? []).map(arm => (
            <li key={arm.label} className="eval-runs-panel__arm">
              <span className={arm.status === 'done' ? 'badge' : 'badge badge--fault'}>
                {arm.status === 'done' ? t('armDone') : t('armFailed')}
              </span>
              <span className="eval-runs-panel__arm-label" title={arm.label}>{arm.label}</span>
              <span className="eval-runs-panel__arm-metrics">
                {arm.status === 'done' && arm.metrics
                  ? t('armMetrics', {
                      accuracy: formatPct(arm.metrics.decisions.accuracy),
                      handshake: formatPct(arm.metrics.handshakes.successRate),
                    })
                  : arm.error ?? t('armNoMetrics')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
