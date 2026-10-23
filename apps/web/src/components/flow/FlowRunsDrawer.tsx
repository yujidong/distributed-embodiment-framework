/**
 * FlowRunsDrawer — the run-history drawer of the flow editor: the flow's
 * execution ledger (GET /api/flows/:id/runs), each run expandable into the
 * per-node trace (nodeResults: status / attempts / error / note).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { History } from 'lucide-react';

import { runFlowManually } from '../../api/client';
import type { FlowRun } from '../../api/types';
import { useFlowRuns } from '../../hooks/useFlows';
import { queryKeys } from '../../lib/queryClient';
import { useAppStore } from '../../store/useAppStore';
import { EmptyState } from '../ui/EmptyState';
import i18n from '../../i18n/config';

const STATUS_KEYS = ['success', 'partial', 'failed', 'waiting'] as const satisfies readonly FlowRun['status'][];
// MI-D: 'service' = a flow-service agreement invocation (metered, effectRef
// chains here); MI-B: 'agent' = a governed agent-decision invocation
// (invokedBy attributes the deciding agent). Label falls back for future kinds.
const TRIGGER_KIND_KEYS = ['event', 'condition', 'schedule', 'manual', 'service', 'agent'] as const satisfies readonly FlowRun['triggerKind'][];

function formatTime(iso: string): string {
  const date = new Date(iso);
  // G4: 跟随 i18n 语言（原硬编码 'zh-CN'）。
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(i18n.language, { hour12: false });
}

export function FlowRunsDrawer(
  { flowId, onClose, simId }: { flowId: string; onClose: () => void; simId?: string },
): JSX.Element {
  const { t } = useTranslation('flows');
  const runsQuery = useFlowRuns(flowId, true);
  const runs = runsQuery.data ?? [];
  const queryClient = useQueryClient();
  const pushToast = useAppStore(state => state.pushToast);
  const [running, setRunning] = useState(false);

  // R41-C1: manual trigger (mirrors `eaf sim run-flow`) — only against an
  // attachable sim of THIS environment; without one the button teaches.
  const triggerManually = async (): Promise<void> => {
    if (simId === undefined) return;
    setRunning(true);
    try {
      const result = await runFlowManually(simId, flowId);
      pushToast(
        result.run !== null
          ? t('manualRunDone', { status: t(`runStatus.${result.run.status}`) })
          : t('manualRunNoRecord'),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.flows.runs(flowId) });
    } catch (error) {
      pushToast(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  const statusLabel = (status: FlowRun['status']) =>
    STATUS_KEYS.includes(status) ? t(`runStatus.${status}`) : status;
  const triggerKindLabel = (kind: FlowRun['triggerKind']) =>
    TRIGGER_KIND_KEYS.includes(kind) ? t(`triggerKind.${kind}`) : kind;

  return (
    <aside className="flow-runs-drawer" data-testid="flow-runs-drawer">
      <div className="flow-runs-drawer__header">
        <h4>{t('runsTitle')}</h4>
        <button
          className="link-button"
          disabled={running || simId === undefined}
          title={simId === undefined ? t('manualRunNoSim') : t('manualRunTitle')}
          onClick={() => void triggerManually()}
        >
          {t('manualRun')}
        </button>
        <button className="link-button" onClick={onClose}>
          {t('runsCollapse')}
        </button>
      </div>
      {runsQuery.isLoading && <p className="page-note">{t('runsLoading')}</p>}
      {runsQuery.isError && (
        <p className="page-note page-note--error">{t('runsLoadFailed')}</p>
      )}
      {runsQuery.isSuccess && runs.length === 0 && (
        <EmptyState compact icon={History} title={t('runsEmpty')} />
      )}
      {runs.map(run => (
        <details key={run.id} className="flow-run">
          <summary>
            <span className={`flow-dot flow-dot--${run.status}`} />
            {statusLabel(run.status) ?? run.status} · {triggerKindLabel(run.triggerKind)} ·{' '}
            {formatTime(run.startedAt)}
            {/* T-714 (R29, F8): flows are environment-level — every sim of the
                env runs them. The row names WHICH sim executed this run. */}
            {run.simulationId && (
              <span className="flow-run__sim" title={t('runSimTitle')}>
                {t('runSimLabel', { simId: run.simulationId })}
              </span>
            )}
          </summary>
          {run.summary && <p className="flow-run__summary">{run.summary}</p>}
          <ul className="flow-run__nodes">
            {Object.entries(run.nodeResults ?? {}).map(([nodeId, result]) => (
              <li key={nodeId}>
                <span className="flow-run__node-id">{nodeId}</span>
                <span className={`flow-dot flow-dot--${result.status}`} />
                {result.status}
                {result.attempts > 1 && t('runAttempts', { count: result.attempts })}
                {result.error && <span className="flow-run__error"> — {result.error}</span>}
                {result.note && <span className="flow-run__note"> — {result.note}</span>}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </aside>
  );
}
