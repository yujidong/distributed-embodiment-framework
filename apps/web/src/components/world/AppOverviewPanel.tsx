/**
 * AppOverviewPanel (R14 P0-1) — the sidebar's「应用」tab: one screen that
 * answers「我的系统由什么组成、缺什么」.
 *
 * Three blocks, all derived client-side (no new endpoints):
 * 1. 系统组成 — device/agent/service/flow/zone counts (flows come from the
 *    react-query-cached list endpoint; the world detail does not carry them);
 * 2. 健康度检查 — the pure computeAppHealth aggregation (lib/appHealth.ts);
 * 3. 关系总览 — per-agent groups of 绑定设备 → 支撑的服务 → 发布的服务, plus
 *    a「未纳入管理的设备」group. Rows jump to the matching sidebar tab via
 *    selectObject/selectService + onTabChange (zone picks ride the existing
 *    WorldViewPage effect that opens the devices tab's zone detail).
 * T-072 adds 待决提案 — the pending governance decisions with the caller's
 * decidable-by-me mark (youCanDecide from the proposal list endpoint).
 * R40-A1 closes the loop HERE: decidable rows get one-click 批准/驳回
 * buttons (decide endpoint), the author gets the rate-limited 催办 nudge
 * (remind), and the recently-decided tail shows results with a 回滚 entry
 * for applied proposals (author/owner, behind the UX-W1 ConfirmDialog — the
 * same pattern ZonePanel uses). Failures surface as teaching toasts; every
 * success refreshes the proposals query.
 *
 * Read surface stays ungated (anonymous visitors and viewers see the same
 * overview); the R40-A1 action buttons appear ONLY on rows the API marks as
 * yours (youCanDecide / author-of / owner-or-author revert) — the server
 * remains the permission authority, refusals teach via toasts.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Network } from 'lucide-react';

import * as api from '../../api/client';
import { ApiClientError } from '../../api/client';
import type { EnvironmentDetail, GovernanceProposal } from '../../api/types';
import { computeAppHealth, unboundDevices, type HealthIssue, type HealthIssueKind } from '../../lib/appHealth';
import { queryKeys } from '../../lib/queryClient';
import { servicesBackedByDevice, servicesOfAgent } from '../../lib/services';
import { useAppStore } from '../../store/useAppStore';
import { useConfirm } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { DetailSection } from './DetailSection';
import type { SidebarTab } from './WorldSidebar';

const HEALTH_KINDS: readonly HealthIssueKind[] = [
  'agentNoDevices',
  'zoneUnmanaged',
  'flowDisabled',
  'agentNoServices',
  'flowZoneNoActuator',
];

export function AppOverviewPanel({
  world,
  onTabChange,
}: {
  world: EnvironmentDetail;
  onTabChange: (tab: SidebarTab) => void;
}) {
  const { t } = useTranslation('world');
  const selectObject = useAppStore(s => s.selectObject);
  const selectService = useAppStore(s => s.selectService);
  const user = useAppStore(s => s.user);
  const pushToast = useAppStore(s => s.pushToast);
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const flowsQuery = useQuery({
    queryKey: queryKeys.flows.list(world.id),
    queryFn: () => api.listFlows(world.id),
  });
  // null while loading/failed — flow health checks are skipped, the count
  // renders as '—', and everything else stays accurate.
  const flows = flowsQuery.data ?? null;

  // T-072 (D-1 decide half): the member's proposal list — pending decisions
  // with the decidable-by-me mark. Read-only (anonymous visitors get the
  // author-scoped view; the panel simply reflects what the endpoint says).
  const proposalsQuery = useQuery({
    queryKey: queryKeys.environments.proposals(world.id),
    queryFn: () => api.listEnvProposals(world.id),
  });
  const pendingProposals = (proposalsQuery.data ?? []).filter(
    proposal => proposal.status === 'escalated',
  );
  // R40-A1: the recently decided tail (newest first, capped) — decided
  // results stay visible and APPLIED rows keep their revert entry.
  const decidedProposals = (proposalsQuery.data ?? [])
    .filter(proposal => proposal.status === 'applied' || proposal.status === 'rejected' || proposal.status === 'reverted')
    .slice(0, 3);

  // R40-A1: the action-in-flight marker (`<proposalId>:<action>`) — disables
  // that row's buttons only, teaching failures land as toasts.
  const [proposalAction, setProposalAction] = useState<string | null>(null);

  const errorText = (error: unknown): string =>
    error instanceof ApiClientError ? `${error.code}: ${error.message}` : String(error);

  const refreshProposals = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.environments.proposals(world.id) });
  };

  const decide = async (proposal: GovernanceProposal, decision: 'approved' | 'rejected') => {
    const action = `${proposal.id}:${decision}`;
    setProposalAction(action);
    try {
      const decided = await api.decideProposal(proposal.id, decision);
      pushToast(
        decided.status === 'applied'
          ? t('appOverview.decideApprovedToast')
          : t('appOverview.decideRejectedToast'),
      );
      refreshProposals();
    } catch (error) {
      pushToast(t('appOverview.decideFailed', { error: errorText(error) }));
    } finally {
      setProposalAction(null);
    }
  };

  const remind = async (proposal: GovernanceProposal) => {
    const action = `${proposal.id}:remind`;
    setProposalAction(action);
    try {
      const result = await api.remindProposal(proposal.id);
      pushToast(
        result.reminded
          ? t('appOverview.remindToast')
          : t('appOverview.remindDroppedToast', { note: result.note ?? '' }),
      );
    } catch (error) {
      pushToast(t('appOverview.remindFailed', { error: errorText(error) }));
    } finally {
      setProposalAction(null);
    }
  };

  const revert = async (proposal: GovernanceProposal) => {
    if (
      !(await confirm({
        body: t('appOverview.revertConfirm', { kind: proposal.kind, author: proposal.author.displayName }),
        tone: 'warn',
      }))
    ) {
      return;
    }
    const action = `${proposal.id}:revert`;
    setProposalAction(action);
    try {
      await api.revertProposal(proposal.id);
      pushToast(t('appOverview.revertToast'));
      refreshProposals();
    } catch (error) {
      pushToast(t('appOverview.revertFailed', { error: errorText(error) }));
    } finally {
      setProposalAction(null);
    }
  };


  const health = computeAppHealth({
    devices: world.devices,
    agents: world.agents,
    services: world.services,
    zones: world.zones,
    flows,
  });

  const openAgent = (id: string) => {
    selectObject({ objectType: 'agent', id });
    onTabChange('agents');
  };
  const openDevice = (id: string) => {
    selectObject({ objectType: 'device', id });
    onTabChange('devices');
  };
  const openZone = (id: string) => {
    // WorldViewPage's zone-selection effect opens the devices tab (which
    // renders the zone detail), so no onTabChange call is needed here.
    selectObject({ objectType: 'zone', id });
  };
  const openService = (id: string) => {
    selectService(id);
    onTabChange('services');
  };

  const openHealthIssue = (issue: HealthIssue) => {
    if (issue.kind === 'agentNoDevices' || issue.kind === 'agentNoServices') openAgent(issue.id);
    else if (issue.kind === 'zoneUnmanaged') openZone(issue.id);
    // flowDisabled / flowZoneNoActuator: flows live on the separate Flows
    // page — no jump target.
  };

  const healthByKind = new Map<HealthIssueKind, HealthIssue[]>();
  for (const issue of health) {
    const group = healthByKind.get(issue.kind);
    if (group) group.push(issue);
    else healthByKind.set(issue.kind, [issue]);
  }

  const leftover = unboundDevices(world.devices, world.agents);

  return (
    <div className="object-list">
      <h5 className="agent-owner-group__title">{t('appOverview.summaryTitle')}</h5>
      <div className="chip-row">
        <button className="chip chip--button" onClick={() => onTabChange('devices')}>
          {t('appOverview.countDevices', { count: world.devices.length })}
        </button>
        <button className="chip chip--button" onClick={() => onTabChange('agents')}>
          {t('appOverview.countAgents', { count: world.agents.length })}
        </button>
        <button className="chip chip--button" onClick={() => onTabChange('services')}>
          {t('appOverview.countServices', { count: world.services.length })}
        </button>
        <span className="chip">
          {flows === null
            ? t('appOverview.countFlowsUnknown')
            : t('appOverview.countFlows', { count: flows.length })}
        </span>
        <span className="chip">{t('appOverview.countZones', { count: world.zones.length })}</span>
      </div>

      {/* T-072: 待决提案 — pending governance decisions, rows the CALLER may
          decide marked 可由我裁决 (the owner sees every escalation; the
          zone-claims delegate sees their in-scope claims). R40-A1: decidable
          rows carry one-click 批准/驳回 (the closed governance loop — no more
          curl-teaching), the author gets the rate-limited 催办 nudge, and the
          decided tail below keeps results + the revert entry (author/owner,
          behind a confirm). */}
      {(pendingProposals.length > 0 || decidedProposals.length > 0) && (
        <>
          {pendingProposals.length > 0 && (
            <>
              <h5 className="agent-owner-group__title">
                {t('appOverview.proposalsTitle', { count: pendingProposals.length })}
              </h5>
              {pendingProposals.map(proposal => {
                const busy = proposalAction !== null && proposalAction.startsWith(`${proposal.id}:`);
                return (
                  <div key={proposal.id} className="object-detail__row">
                    {proposal.youCanDecide === true && (
                      <span className="badge">{t('appOverview.proposalDecidable')}</span>
                    )}
                    <span>
                      {proposal.kind}
                      {' · '}
                      {proposal.author.displayName}
                    </span>
                    {proposal.youCanDecide === true && (
                      <>
                        <button
                          className="primary-button"
                          disabled={busy}
                          onClick={() => void decide(proposal, 'approved')}
                        >
                          {t('appOverview.proposalApprove')}
                        </button>
                        <button
                          className="danger-button"
                          disabled={busy}
                          onClick={() => void decide(proposal, 'rejected')}
                        >
                          {t('appOverview.proposalReject')}
                        </button>
                      </>
                    )}
                    {user !== null && user.id === proposal.author.id && (
                      <button
                        className="link-button"
                        disabled={busy}
                        onClick={() => void remind(proposal)}
                      >
                        {t('appOverview.proposalRemind')}
                      </button>
                    )}
                  </div>
                );
              })}
              <p className="page-note">{t('appOverview.proposalsHint')}</p>
            </>
          )}
          {decidedProposals.length > 0 && (
            <>
              <h5 className="agent-owner-group__title">
                {t('appOverview.decidedTitle', { count: decidedProposals.length })}
              </h5>
              {decidedProposals.map(proposal => {
                const busy = proposalAction !== null && proposalAction.startsWith(`${proposal.id}:`);
                const canRevert =
                  proposal.status === 'applied' &&
                  (world.myRole === 'owner' || (user !== null && user.id === proposal.author.id));
                return (
                  <div key={proposal.id} className="object-detail__row">
                    <span className="badge">
                      {t(`appOverview.proposalStatus.${proposal.status}`)}
                    </span>
                    <span>
                      {proposal.kind}
                      {' · '}
                      {proposal.author.displayName}
                    </span>
                    {canRevert && (
                      <button
                        className="danger-button"
                        disabled={busy}
                        onClick={() => void revert(proposal)}
                      >
                        {t('appOverview.proposalRevert')}
                      </button>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </>
      )}

      <h5 className="agent-owner-group__title">{t('appOverview.healthTitle')}</h5>
      {health.length === 0 ? (
        <p className="page-note">{t('appOverview.healthOk')}</p>
      ) : (
        HEALTH_KINDS.map(kind => {
          const issues = healthByKind.get(kind);
          if (!issues) return null;
          return (
            <div key={kind} className="object-detail__section">
              <span className="object-detail__label">
                {t(`appOverview.health.${kind}`)}（{issues.length}）
              </span>
              {issues.map(issue =>
                kind === 'flowDisabled' || kind === 'flowZoneNoActuator' ? (
                  <span key={issue.id} className="object-detail__row">{issue.name}</span>
                ) : (
                  <button
                    key={issue.id}
                    className="link-button object-detail__link"
                    onClick={() => openHealthIssue(issue)}
                  >
                    {issue.name}
                  </button>
                ),
              )}
            </div>
          );
        })
      )}

      <h5 className="agent-owner-group__title">{t('appOverview.relationsTitle')}</h5>
      {world.agents.length === 0 && leftover.length === 0 && (
        <EmptyState compact icon={Network} title={t('appOverview.emptyNone')} />
      )}
      {world.agents.map(agent => {
        const bound = agent.boundDeviceIds
          .map(id => world.devices.find(device => device.id === id))
          .filter((device): device is NonNullable<typeof device> => device !== undefined);
        const backed = [
          ...new Map(
            bound.flatMap(device => servicesBackedByDevice(world.services, device.id)).map(service => [service.id, service]),
          ).values(),
        ];
        const published = servicesOfAgent(world.services, agent.id);
        return (
          <DetailSection key={agent.id} title={t('appOverview.agentGroup', { name: agent.name })}>
            <span className="object-detail__label">{t('appOverview.boundDevices')}</span>
            {bound.length === 0 && <span className="page-note">{t('appOverview.listEmpty')}</span>}
            {bound.map(device => (
              <button
                key={device.id}
                className="link-button object-detail__link"
                onClick={() => openDevice(device.id)}
              >
                {device.name}
              </button>
            ))}
            <span className="object-detail__label">{t('appOverview.backedServices')}</span>
            {backed.length === 0 && <span className="page-note">{t('appOverview.listEmpty')}</span>}
            {backed.map(service => (
              <button
                key={service.id}
                className="link-button object-detail__link"
                onClick={() => openService(service.id)}
              >
                {service.name}
              </button>
            ))}
            <span className="object-detail__label">{t('appOverview.publishedServices')}</span>
            {published.length === 0 && <span className="page-note">{t('appOverview.listEmpty')}</span>}
            {published.map(service => (
              <button
                key={service.id}
                className="link-button object-detail__link"
                onClick={() => openService(service.id)}
              >
                {service.name}
              </button>
            ))}
          </DetailSection>
        );
      })}
      {leftover.length > 0 && (
        <DetailSection title={t('appOverview.unboundDevices', { count: leftover.length })}>
          {leftover.map(device => (
            <button
              key={device.id}
              className="link-button object-detail__link"
              onClick={() => openDevice(device.id)}
            >
              {device.name}
            </button>
          ))}
        </DetailSection>
      )}
    </div>
  );
}
