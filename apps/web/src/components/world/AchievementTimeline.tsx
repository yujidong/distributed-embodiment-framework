/**
 * AchievementTimeline (R6-D-F01, gamification-design.md 机制四 S2) — the
 * world sidebar's「成就」tab: the world's completed collaborations rendered
 * as a timeline from GET /api/environments/:id/digest (the arrival
 * digest's completedCollaborations — participants as AGENT names, the
 * terminatedAgreementOutcome 口径, anonymized server-side; NOT window-bound,
 * so a collaboration from before today still shows). The env owner's
 * providerUnavailableAgreements work queue (v60, R6-E-F08) renders as a
 * warning section when non-empty — the server keeps it empty for every
 * other viewer, so visibility here follows the data. No points/badges by
 * design (§7 非目标): every row is a real platform event.
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { TriangleAlert, Trophy } from 'lucide-react';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import type {
  CompletedCollaborationEntry,
  EnvironmentDetail,
  ProviderUnavailableAgreementEntry,
} from '../../api/types';
import { queryKeys } from '../../lib/queryClient';
import { formatRelativeTime } from '../../lib/relativeTime';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/EmptyState';
import { Loading } from '../ui/Loading';

/** Digest category order (matches the server's DigestCategoryKey). */
const CATEGORY_ORDER = ['proposals', 'agreements', 'devices', 'world'] as const;

/** Honest outcome presentation — a cancelled collaboration is not a success. */
const OUTCOME_BADGE: Record<string, string> = {
  completed: 'badge--ok',
  success: 'badge--ok',
  partial: 'badge--warn',
  cancelled: 'badge--warn',
  failure: 'badge--danger',
};

const KNOWN_OUTCOMES = new Set(Object.keys(OUTCOME_BADGE));

export function AchievementTimeline({ world }: { world: EnvironmentDetail }) {
  const { t } = useTranslation('achievements');
  const digestQuery = useQuery({
    queryKey: queryKeys.environments.digest(world.id),
    queryFn: () => api.getEnvironmentDigest(world.id),
  });

  if (digestQuery.isPending) {
    return <Loading className="world-sidebar__panel-fallback" />;
  }
  if (digestQuery.isError) {
    const error = digestQuery.error;
    const message =
      error instanceof ApiClientError ? `${error.code}: ${error.message}` : String(error);
    return <p className="page-note page-note--error">{t('loadFailed', { error: message })}</p>;
  }

  const digest = digestQuery.data;
  // 防御旧 API/版本偏移：providerUnavailableAgreements 是 v60 字段，
  // 旧后端不返回 —— 缺省空数组（QuestsPanel 的优雅降级范式）
  const collaborations = digest?.completedCollaborations ?? [];
  const unavailable = digest?.providerUnavailableAgreements ?? [];

  return (
    <div className="achievement-timeline" data-testid="achievement-timeline">
      {(digest?.total ?? 0) > 0 && (
        <div className="object-list__meta" data-testid="achievement-categories">
          {CATEGORY_ORDER.map(
            key => `${digest.categories[key]?.label ?? key} ${digest.categories[key]?.count ?? 0}`,
          ).join(' · ')}
        </div>
      )}
      {collaborations.length === 0 && <EmptyState compact icon={Trophy} title={t('empty')} />}
      {collaborations.map(entry => (
        <CollaborationRow key={entry.agreementId} entry={entry} />
      ))}
      {unavailable.length > 0 && (
        <section
          className="achievement-timeline__unavailable"
          data-testid="provider-unavailable-section"
        >
          <p className="service-detail__warning">
            <Icon icon={TriangleAlert} size={14} /> {t('unavailableTitle')}
          </p>
          <p className="page-note">{t('unavailableNote')}</p>
          {unavailable.map(entry => (
            <UnavailableRow key={entry.agreementId} entry={entry} />
          ))}
        </section>
      )}
    </div>
  );
}

function CollaborationRow({ entry }: { entry: CompletedCollaborationEntry }) {
  const { t } = useTranslation('achievements');
  const consumer = entry.consumer.agentName ?? t('unknownAgent');
  const provider = entry.provider.agentName ?? t('unknownAgent');
  const service = entry.service.name ?? t('unknownService');
  const outcomeLabel = KNOWN_OUTCOMES.has(entry.outcome)
    ? t(`outcome.${entry.outcome}`)
    : entry.outcome;
  return (
    <div className="achievement-entry" data-testid="achievement-entry">
      <span className="achievement-entry__line">
        {t('entryLine', { consumer, provider, service })}
      </span>
      <span className={`badge ${OUTCOME_BADGE[entry.outcome] ?? ''}`.trim()}>{outcomeLabel}</span>
      <span className="object-list__meta">{formatRelativeTime(entry.terminatedAt)}</span>
    </div>
  );
}

function UnavailableRow({ entry }: { entry: ProviderUnavailableAgreementEntry }) {
  const { t } = useTranslation('achievements');
  const consumer = entry.consumer.agentName ?? t('unknownAgent');
  const service = entry.service.name ?? t('unknownService');
  return (
    <div className="achievement-entry" data-testid="provider-unavailable-entry">
      <span className="achievement-entry__line">
        {t('unavailableLine', { consumer, service })}
      </span>
      <span className="object-list__meta">{formatRelativeTime(entry.suspendedAt)}</span>
    </div>
  );
}
