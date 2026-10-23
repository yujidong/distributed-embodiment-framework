/**
 * GovernanceInboxPanel (UX-W5 子任务 B) — the sidebar 治理 group's 收件箱
 * tab: one unified view of「需要我裁决的事项」.
 *
 * Two sources, both derived client-side from existing endpoints:
 * 1. 待决提案 — GET /api/environments/:id/proposals (the SAME react-query key
 *    AppOverviewPanel uses: one cache, two views; a decide here invalidates
 *    the shared key so the overview's governance 区 stays consistent);
 * 2. 待我回应的合约 — GET /api/agreements?envId=&role=provider|consumer,
 *    filtered by the lib/agreements canDecide gate (proposed → the provider
 *    decides; countered → the consumer decides the counter-offer — T-059).
 *
 * Row actions: proposals get inline 批准/驳回 (the same decideProposal lane
 * as AppOverviewPanel); agreements jump to the 合约 tab's AgreementDetail
 * (selectAgreement + onTabChange) where accept/counter/reject live — the
 * negotiation view stays the single place terms are inspected.
 *
 * There is no member-approval request concept in the platform (membership is
 * invite-outbound), so the inbox has no third category.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Inbox } from 'lucide-react';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import type { Agreement, EnvironmentDetail, GovernanceProposal } from '../../api/types';
import {
  canDecide,
  counterpartyLabel,
  dedupeAgreementsById,
  shortAgreementId,
  sortAgreementsForInbox,
  summarizeTerms,
} from '../../lib/agreements';
import { queryKeys } from '../../lib/queryClient';
import { formatRelativeTime } from '../../lib/relativeTime';
import { useAppStore } from '../../store/useAppStore';
import { EmptyState } from '../ui/EmptyState';
import type { SidebarTab } from './WorldSidebar';

export function GovernanceInboxPanel({
  world,
  onTabChange,
}: {
  world: EnvironmentDetail;
  onTabChange: (tab: SidebarTab) => void;
}) {
  const { t } = useTranslation('world');
  const { t: ta } = useTranslation('agreements');
  const user = useAppStore(s => s.user);
  const pushToast = useAppStore(s => s.pushToast);
  const selectAgreement = useAppStore(s => s.selectAgreement);
  const queryClient = useQueryClient();

  // 待决提案: shared cache key with AppOverviewPanel — deciding in either
  // view invalidates the same key, so both stay consistent.
  const proposalsQuery = useQuery({
    queryKey: queryKeys.environments.proposals(world.id),
    queryFn: () => api.listEnvProposals(world.id),
  });
  const pendingProposals = (proposalsQuery.data ?? [])
    .filter(proposal => proposal.status === 'escalated' && proposal.youCanDecide === true)
    // R2-FEAT-03 统一口径：待裁决事项时间倒序（最新置顶）。
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // 待我回应的合约: both mailboxes through the canDecide gate. R2-FEAT-03:
  // the two mailboxes OVERLAP when I'm both parties — dedupe by id (no more
  // double rows / duplicate keys), and the merged queue rides the unified
  // 待裁决置顶 + 时间倒序 ordering (sortAgreementsForInbox).
  const providerQuery = useQuery({
    queryKey: queryKeys.agreements.mailbox(world.id, 'provider'),
    queryFn: () => api.listAgreements(world.id, { role: 'provider' }),
    enabled: user !== null,
  });
  const consumerQuery = useQuery({
    queryKey: queryKeys.agreements.mailbox(world.id, 'consumer'),
    queryFn: () => api.listAgreements(world.id, { role: 'consumer' }),
    enabled: user !== null,
  });
  const awaitingAgreements = sortAgreementsForInbox(
    dedupeAgreementsById([
      ...((providerQuery.data ?? []) as Agreement[]),
      ...((consumerQuery.data ?? []) as Agreement[]),
    ]),
    user?.id ?? null,
  ).filter(agreement => canDecide(agreement, user?.id ?? null));

  const [deciding, setDeciding] = useState<string | null>(null);

  const errorText = (error: unknown): string =>
    error instanceof ApiClientError ? `${error.code}: ${error.message}` : String(error);

  const decide = async (proposal: GovernanceProposal, decision: 'approved' | 'rejected') => {
    setDeciding(proposal.id);
    try {
      const decided = await api.decideProposal(proposal.id, decision);
      pushToast(
        decided.status === 'applied'
          ? t('appOverview.decideApprovedToast')
          : t('appOverview.decideRejectedToast'),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.environments.proposals(world.id) });
    } catch (error) {
      pushToast(t('appOverview.decideFailed', { error: errorText(error) }));
    } finally {
      setDeciding(null);
    }
  };

  const openAgreement = (agreement: Agreement) => {
    selectAgreement(agreement.id);
    onTabChange('agreements');
  };

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.environments.proposals(world.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.agreements.all });
  };

  const loading =
    proposalsQuery.isLoading ||
    (user !== null && (providerQuery.isLoading || consumerQuery.isLoading));
  const loadError =
    proposalsQuery.error ?? providerQuery.error ?? consumerQuery.error ?? null;
  const empty =
    !loading && loadError === null && pendingProposals.length === 0 && awaitingAgreements.length === 0;

  return (
    <div className="object-list governance-inbox">
      <button className="world-sidebar__create" onClick={refresh}>
        {t('governanceInbox.refresh')}
      </button>
      {loading && <p className="page-note">{t('governanceInbox.loading')}</p>}
      {loadError !== null && (
        <p className="page-note page-note--error">
          {t('governanceInbox.loadFailed', { error: errorText(loadError) })}
        </p>
      )}
      {empty && <EmptyState compact icon={Inbox} title={t('governanceInbox.empty')} />}
      {pendingProposals.length > 0 && (
        <>
          <h5 className="agent-owner-group__title">
            {t('governanceInbox.proposalsSection', { count: pendingProposals.length })}
          </h5>
          {pendingProposals.map(proposal => (
            <div key={proposal.id} className="object-detail__row governance-inbox__row">
              <span className="badge">{t('governanceInbox.kindProposal')}</span>
              <span className="governance-inbox__summary">
                {proposal.kind}
                {' · '}
                {proposal.author.displayName}
              </span>
              <span className="object-list__meta" title={proposal.createdAt}>
                {formatRelativeTime(proposal.createdAt)}
              </span>
              <button
                className="primary-button"
                disabled={deciding !== null}
                onClick={() => void decide(proposal, 'approved')}
              >
                {t('governanceInbox.approve')}
              </button>
              <button
                className="danger-button"
                disabled={deciding !== null}
                onClick={() => void decide(proposal, 'rejected')}
              >
                {t('governanceInbox.reject')}
              </button>
            </div>
          ))}
        </>
      )}
      {awaitingAgreements.length > 0 && (
        <>
          <h5 className="agent-owner-group__title">
            {t('governanceInbox.agreementsSection', { count: awaitingAgreements.length })}
          </h5>
          {awaitingAgreements.map(agreement => (
            <div key={agreement.id} className="object-detail__row governance-inbox__row">
              <span className="badge">{t('governanceInbox.kindAgreement')}</span>
              <span className="governance-inbox__summary">
                {agreement.service?.name ?? agreement.serviceId}
                {' · '}
                {ta('counterparty', { name: counterpartyLabel(agreement, user?.id ?? null) })}
                {' · '}
                {ta(`status${agreement.status[0].toUpperCase()}${agreement.status.slice(1)}`)}
                {' · '}
                {summarizeTerms(agreement.terms)}
              </span>
              {/* R2-FEAT-03: 与合约 tab 同一行尾签名——重复 propose 的
                  克隆条目靠相对时间 + 短 id 可区分。 */}
              <span className="object-list__meta" title={agreement.createdAt}>
                {formatRelativeTime(agreement.createdAt)}
              </span>
              <span className="object-list__meta agreement-row__id" title={agreement.id}>
                {shortAgreementId(agreement.id)}
              </span>
              <button className="primary-button" onClick={() => openAgreement(agreement)}>
                {t('governanceInbox.open')}
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
