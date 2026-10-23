/**
 * EvalReportPanel — the simulation console's bottom-drawer 评估 tab (B5):
 * read-only metric cards from GET /api/simulations/:id/eval-report (Fix-22 /
 * Wave-3a aggregation: decision accuracy by source, AC handshake success
 * rate, temperature-class effect-check pass rate, reputation totals; F3-2
 * trajectory health: chain completeness, structured-output rate, LLM
 * failures).
 *
 * plan-r81 B3: the meta row also carries the training-data export entry — a
 * plain anchor to GET /api/environments/:id/training-export?simId=<this sim>
 * (cookie download, no in-page parsing), rendered only when the report knows
 * its environmentId (legacy scenario sims have none to export from).
 *
 * This is one-shot GET data, so it rides TanStack Query (the project's
 * convention for server list/report state) rather than the zustand slices
 * the live console uses. Loading / error / empty (nothing to evaluate yet)
 * states render inline in the drawer.
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardCheck } from 'lucide-react';

import * as api from '../api/client';
import { queryKeys } from '../lib/queryClient';
import { EmptyState } from './ui/EmptyState';

function formatPct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function EvalReportPanel({ simulationId }: { simulationId: string }) {
  const { t } = useTranslation('simView');
  const report = useQuery({
    queryKey: queryKeys.simulations.evalReport(simulationId),
    queryFn: () => api.getEvalReport(simulationId),
  });

  if (report.isPending) {
    return <p className="page-note">{t('eval.loading')}</p>;
  }
  if (report.isError) {
    return (
      <p className="page-note page-note--error">
        {t('eval.loadFailed', { error: errorMessage(report.error) })}
      </p>
    );
  }

  const data = report.data;
  const labeled = data.decisions.total - data.decisions.unlabeled;
  const nothingToEvaluate =
    data.decisions.total === 0 &&
    data.handshakes.initiated === 0 &&
    data.effectChecks.attempts === 0;
  if (nothingToEvaluate) {
    return <EmptyState compact icon={ClipboardCheck} title={t('eval.empty')} />;
  }

  return (
    <div className="eval-report">
      <div className="eval-report__meta">
        <span className="badge">
          {data.source === 'disk' ? t('eval.sourceDisk') : t('eval.sourceRegistry')}
        </span>
        {data.state !== null && <span className="badge">{data.state}</span>}
        {data.simTimeSec !== null && (
          <span className="page-note">{t('eval.simTime', { sec: data.simTimeSec })}</span>
        )}
        {data.environmentId !== undefined && (
          <>
            <a
              className="primary-button eval-report__export"
              href={api.trainingExportUrl(data.environmentId, { simId: simulationId })}
              download={`training-export-${simulationId}.ndjson`}
            >
              {t('eval.exportTraining')}
            </a>
            <span className="page-note">{t('eval.exportTrainingHint')}</span>
          </>
        )}
      </div>
      <div className="eval-report__grid">
        <div className="eval-report__card">
          <div className="eval-report__value">{formatPct(data.decisions.accuracy)}</div>
          <div className="eval-report__label">{t('eval.accuracy')}</div>
          <div className="eval-report__sub">
            {t('eval.labeledOf', { correct: data.decisions.correct, labeled })}
          </div>
        </div>
        <div className="eval-report__card">
          <div className="eval-report__value">{data.decisions.total}</div>
          <div className="eval-report__label">{t('eval.decisions')}</div>
          <div className="eval-report__sub">{t('eval.events', { count: data.events })}</div>
        </div>
        <div className="eval-report__card">
          <div className="eval-report__value">{formatPct(data.handshakes.successRate)}</div>
          <div className="eval-report__label">{t('eval.handshakeRate')}</div>
          <div className="eval-report__sub">
            {t('eval.ratio', { success: data.handshakes.succeeded, total: data.handshakes.initiated })}
          </div>
        </div>
        <div className="eval-report__card">
          <div className="eval-report__value">{formatPct(data.effectChecks.passRate)}</div>
          <div className="eval-report__label">{t('eval.effectPassRate')}</div>
          <div className="eval-report__sub">
            {t('eval.ratio', { success: data.effectChecks.successes, total: data.effectChecks.attempts })}
          </div>
        </div>
        <div className="eval-report__card">
          <div className="eval-report__value">
            {t('eval.ratio', {
              success: data.reputation.totals.successes,
              total: data.reputation.totals.attempts,
            })}
          </div>
          <div className="eval-report__label">{t('eval.reputation')}</div>
          <div className="eval-report__sub">
            {t('eval.reputationAgents', { count: data.reputation.agents.length })}
          </div>
        </div>
        {data.trajectory !== undefined && (
          <>
            <div className="eval-report__card" title={t('eval.chainCompletenessHint')}>
              <div className="eval-report__value">{formatPct(data.trajectory.chain.completeness)}</div>
              <div className="eval-report__label">{t('eval.chainCompleteness')}</div>
              <div className="eval-report__sub">
                {t('eval.ratio', {
                  success: data.trajectory.chain.withFeedback,
                  total: data.trajectory.chain.actionable,
                })}
              </div>
            </div>
            <div className="eval-report__card" title={t('eval.structuredOutputHint')}>
              <div className="eval-report__value">{formatPct(data.trajectory.structuredOutput.jsonRate)}</div>
              <div className="eval-report__label">{t('eval.structuredOutputRate')}</div>
              <div className="eval-report__sub">
                {t('eval.structuredOutputSub', {
                  json: data.trajectory.structuredOutput.json,
                  llm: data.trajectory.structuredOutput.llm,
                  fsm: data.trajectory.structuredOutput.fsm,
                })}
              </div>
            </div>
            <div className="eval-report__card" title={t('eval.llmFailuresHint')}>
              <div className="eval-report__value">{data.trajectory.llmFailures}</div>
              <div className="eval-report__label">{t('eval.llmFailures')}</div>
              <div className="eval-report__sub">
                {t('eval.llmDecisions', { count: data.trajectory.structuredOutput.llm })}
              </div>
            </div>
          </>
        )}
      </div>
      {(data.metaAgents ?? []).length > 0 && (
        <div className="eval-meta-agents">
          <div className="eval-report__label">{t('eval.metaTitle')}</div>
          {(data.metaAgents ?? []).map(agent => (
            <div key={agent.agentId} className="eval-meta-agent">
              <div className="eval-meta-agent__head">
                <span className="eval-meta-agent__name">{agent.agentName}</span>
                <span className="badge" title={t('eval.calibrationHint')}>
                  {t('eval.calibration')} {agent.calibrationScore === null ? '—' : formatPct(agent.calibrationScore)}
                </span>
                <span className="badge">
                  {t('eval.successRate')} {formatPct(agent.successRate)}
                </span>
                <span className="page-note">
                  {t('eval.evaluatedOf', { evaluated: agent.evaluatedDecisions, total: agent.decisionCount })}
                </span>
              </div>
              <div className="eval-meta-agent__boundary">
                <span className="eval-report__label">{t('eval.boundary')}</span>
                {(agent.capabilityBoundary?.strong ?? []).length > 0 && (
                  <span className="badge badge--ok">{t('eval.strong')}: {agent.capabilityBoundary.strong.join(', ')}</span>
                )}
                {(agent.capabilityBoundary?.weak ?? []).length > 0 && (
                  <span className="badge">{t('eval.weak')}: {agent.capabilityBoundary.weak.join(', ')}</span>
                )}
                {(agent.capabilityBoundary?.mustEscalate ?? []).length > 0 && (
                  <span className="badge badge--danger">{t('eval.mustEscalate')}: {agent.capabilityBoundary.mustEscalate.join(', ')}</span>
                )}
              </div>
              {agent.topUncalibratedActions.length > 0 && (
                <div className="eval-meta-agent__uncalibrated">
                  <span className="eval-report__label">{t('eval.uncalibrated')}</span>
                  {agent.topUncalibratedActions.map(row => (
                    <span key={row.action} className="badge" title={t('eval.gapHint', { gap: Math.round(row.gap * 100) / 100 })}>
                      {row.action} ×{row.count}
                    </span>
                  ))}
                </div>
              )}
              {agent.trustPartners.length > 0 && (
                <div className="eval-meta-agent__trust">
                  <span className="eval-report__label">{t('eval.trust')}</span>
                  {agent.trustPartners.map(partner => (
                    <span key={partner.partnerId} className="badge" title={t('eval.trustHint', { count: partner.interactions })}>
                      {partner.partnerId.slice(0, 8)} {partner.trust.toFixed(2)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {Object.keys(data.decisions.bySource).length > 0 && (
        <div className="eval-report__sources">
          <span className="eval-report__label">{t('eval.bySource')}</span>
          {Object.entries(data.decisions.bySource).map(([source, count]) => (
            <span key={source} className="badge">
              {source} × {count}
            </span>
          ))}
        </div>
      )}
      {data.notes && data.notes.length > 0 && (
        <ul className="eval-report__notes">
          {data.notes.map(note => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
