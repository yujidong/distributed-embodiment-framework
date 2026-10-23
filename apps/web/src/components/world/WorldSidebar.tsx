/**
 * WorldSidebar — the world view's right-hand tabbed panel:
 * 应用 (system overview: composition counts + health checks + per-agent
 * relation groups — R14 P0-1, see AppOverviewPanel), 成就 (the completed-
 * collaboration timeline from the arrival digest — R6-D-F01, gamification
 * S2, see AchievementTimeline), 设备 (device list + selected-device detail + ad-hoc create/edit form and
 * 区域管理 zone panel — W6-2), Agent (list + detail +
 * creation/edit wizard — W6), 服务 (the service marketplace, see
 * ServicesPanel — W3, plus publish/edit forms — W6),
 * 名录 (catalog, see CatalogPanel), 蓝图 (one-click blueprint install, see
 * BlueprintsPanel — Fix-38; logged-in users only), 部署 (the caller's deployment manifest,
 * see DeploymentPanel — W5; logged-in users only), 批量评估 (batch-eval job
 * history, see EvalRunsPanel — T-016; members only), 评分报告 (owner-only
 * grading export, see RosterReportPanel — Fix-37), 收件箱 (the governance
 * inbox — pending proposals + agreements awaiting my decision, UX-W5, see
 * GovernanceInboxPanel; logged-in users only), 成员 (member legend with
 * ownership colors and per-member object counts, plus roster management for
 * owner/builder — batch import, role change, removal).
 *
 * Write affordances follow the viewer's role: builder+ may create devices
 * and agents and delete/mutate their own, the env owner may mutate any and
 * manages zones; viewers and anonymous visitors see everything read-only.
 */

import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';

import * as api from '../../api/client';
import type { EnvironmentDetail, EnvMember, WorldAgent, WorldDevice } from '../../api/types';
import { groupAgentsByOwner } from '../../lib/agentWizard';
import { queryKeys } from '../../lib/queryClient';
import { colorForUserId } from '../../lib/memberColors';
import { fullDeviceState } from '../../lib/format';
import { agentBrief, deviceBrief } from '../../lib/rowBrief';
import { servicesBackedByDevice, servicesOfAgent } from '../../lib/services';
import { occupantOverlayStatus, simAbsDayClock, simDayClock } from '../../lib/zoneForm';
import { formatReputationPercent, perCapabilityReputation, reputationTier } from '../../lib/reputation';
import i18n from '../../i18n/config';
import { useAppStore } from '../../store/useAppStore';
import { useMyQuotas } from '../../hooks/useEnvironments';
import { quotaState } from '../../lib/quota';
import { useRoleLabel } from '../../i18n/index';
import { useTranslation } from 'react-i18next';
import { ReputationChip } from '../ReputationChip';
import { ZoneFloorPlan } from './ZoneFloorPlan';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { Icon } from '../ui/Icon';
import { Loading } from '../ui/Loading';
import { AppOverviewPanel } from './AppOverviewPanel';
import { DetailSection } from './DetailSection';
import { DeviceForm } from './DeviceForm';
import { RowBrief } from './RowBrief';
import { ZoneBaselineEditor, ZoneScheduleEditor } from './ZoneScenarioEditor';

// Tab-level code splitting: every sidebar tab panel renders only for its own
// tab, so each loads on first activation — the world view's initial chunk no
// longer carries DeploymentPanel/EvalRunsPanel/AgreementsPanel(+detail)/
// Catalog/Blueprints/… (~3.5k lines combined). Panels export named
// components, hence the `.then(m => ({ default: m.X }))` shape.
const AgentWizard = lazy(() => import('./AgentWizard').then(m => ({ default: m.AgentWizard })));
const AchievementTimeline = lazy(() =>
  import('./AchievementTimeline').then(m => ({ default: m.AchievementTimeline })),
);
const AgreementsPanel = lazy(() => import('./AgreementsPanel').then(m => ({ default: m.AgreementsPanel })));
const BlueprintsPanel = lazy(() => import('./BlueprintsPanel').then(m => ({ default: m.BlueprintsPanel })));
const QuestsPanel = lazy(() => import('./QuestsPanel').then(m => ({ default: m.QuestsPanel })));
const CatalogPanel = lazy(() => import('./CatalogPanel').then(m => ({ default: m.CatalogPanel })));
const DeploymentPanel = lazy(() => import('./DeploymentPanel').then(m => ({ default: m.DeploymentPanel })));
const EvalRunsPanel = lazy(() => import('./EvalRunsPanel').then(m => ({ default: m.EvalRunsPanel })));
const GovernanceInboxPanel = lazy(() =>
  import('./GovernanceInboxPanel').then(m => ({ default: m.GovernanceInboxPanel })),
);
const MemberImportDialog = lazy(() =>
  import('./MemberImportDialog').then(m => ({ default: m.MemberImportDialog })),
);
const RosterReportPanel = lazy(() => import('./RosterReportPanel').then(m => ({ default: m.RosterReportPanel })));
const SandboxPanel = lazy(() => import('./SandboxPanel').then(m => ({ default: m.SandboxPanel })));
const ExternalChannelPanel = lazy(() => import('./ExternalChannelPanel').then(m => ({ default: m.ExternalChannelPanel })));
const ReplaySharePanel = lazy(() => import('./ReplaySharePanel').then(m => ({ default: m.ReplaySharePanel })));
const ServicesPanel = lazy(() => import('./ServicesPanel').then(m => ({ default: m.ServicesPanel })));
const ZonePanel = lazy(() => import('./ZonePanel').then(m => ({ default: m.ZonePanel })));

export type SidebarTab =
  | 'appOverview'
  | 'achievements'
  | 'quests'
  | 'devices'
  | 'agents'
  | 'services'
  | 'agreements'
  | 'governance'
  | 'catalog'
  | 'blueprints'
  | 'deployment'
  | 'replayShare'
  | 'evalRuns'
  | 'rosterReport'
  | 'sandboxes'
  | 'externalChannel'
  | 'members';

/** T10 分组导航的组 id。 */
export type SidebarGroup = 'overview' | 'build' | 'run' | 'govern';

/** Tab → 组映射：构建（设备/Agent/蓝图/名录）、运行（服务/沙盒/部署/
 *  对外通道）、治理（收件箱/合约/成员/评估/评分/分享——UX-10 起合约归治理组：
 *  「我环境里签了哪些合约」是治理视角；UX-W5 起收件箱聚合「需要我裁决的
 *  事项」为治理组首 tab）；应用概览单列一组。 */
const GROUP_OF_TAB: Record<SidebarTab, SidebarGroup> = {
  appOverview: 'overview',
  achievements: 'overview',
  quests: 'overview',
  devices: 'build',
  agents: 'build',
  blueprints: 'build',
  catalog: 'build',
  services: 'run',
  agreements: 'govern',
  governance: 'govern',
  sandboxes: 'run',
  deployment: 'run',
  externalChannel: 'run',
  members: 'govern',
  evalRuns: 'govern',
  rosterReport: 'govern',
  replayShare: 'govern',
};

const GROUP_ORDER: readonly SidebarGroup[] = ['overview', 'build', 'run', 'govern'];

export interface WorldSidebarProps {
  world: EnvironmentDetail;
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
}

export function WorldSidebar({ world, tab, onTabChange }: WorldSidebarProps) {
  const selectObject = useAppStore(s => s.selectObject);
  const selectService = useAppStore(s => s.selectService);
  const user = useAppStore(s => s.user);
  const { t } = useTranslation('world');
  // T-713 (R29, orchestrator): flows live on their own page and the sidebar
  // had no trace of them (tabs count devices/agents/services/members only).
  // The cached list query (same key as AppOverviewPanel — one fetch, two
  // views) feeds a 业务流 quick link with a count badge + per-author split.
  const flowsQuery = useQuery({
    queryKey: queryKeys.flows.list(world.id),
    queryFn: () => api.listFlows(world.id),
    enabled: user !== null,
  });
  const flows = flowsQuery.data ?? null;
  const flowAuthorSplit = useMemo(() => {
    if (flows === null) return '';
    const counts = new Map<string, number>();
    for (const flow of flows) {
      const author = flow.createdBy ?? 'unknown';
      counts.set(author, (counts.get(author) ?? 0) + 1);
    }
    const nameById = new Map(
      world.members
        .filter(member => member.userId !== undefined)
        .map(member => [member.userId as string, member.displayName]),
    );
    return [...counts.entries()]
      .map(([authorId, count]) => `${nameById.get(authorId) ?? authorId} ${count}`)
      .join(' + ');
  }, [flows, world.members]);
  // T10 分组导航：14 个 tab 平铺会截断且无语义分组。按 概览/构建/运行/治理
  // 四组收敛为二级导航——组行 + 组内 tab 行；深链 (?tab=) 仍直达具体 tab，
  // 所在组自动展开。
  const tabs: Array<[SidebarTab, string, number?]> = [
    // 应用 (R14 P0-1): the system overview — visible to everyone, no count badge.
    ['appOverview', t('sidebar.tabAppOverview')],
    // 成就 (R6-D-F01, gamification S2): the world's completed collaborations
    // timeline — read-gated like the digest route (every env reader).
    ['achievements', t('sidebar.tabAchievements')],
    // 关卡 (R6-D-M1, gamification M1): the L1-L6 quest backbone — same read
    // gate as the quest-state route (every env reader).
    ['quests', t('sidebar.tabQuests')],
    ['devices', t('sidebar.tabDevices'), world.devices.length],
    ['agents', t('sidebar.tabAgents'), world.agents.length],
    ['services', t('sidebar.tabServices'), world.services.length],
    // 收件箱 (UX-W5): the governance inbox —「需要我裁决的事项」的统一入口；
    // personal like 合约 (both feeds require auth), first tab of the govern group.
    ...(user !== null ? ([[ 'governance', t('sidebar.tabGovernance') ]] as Array<[SidebarTab, string, number?]>) : []),
    // 合约 (Fix-11/17) is personal — hidden for anonymous visitors.
    ...(user !== null ? ([[ 'agreements', t('sidebar.tabAgreements') ]] as Array<[SidebarTab, string, number?]>) : []),
    ['catalog', t('sidebar.tabCatalog')],
    // 蓝图 (Fix-38) is personal — hidden for anonymous visitors (the list endpoint requires auth).
    ...(user !== null ? ([[ 'blueprints', t('sidebar.tabBlueprints') ]] as Array<[SidebarTab, string, number?]>) : []),
    // 部署 (W5) is personal — hidden for anonymous visitors.
    ...(user !== null ? ([[ 'deployment', t('sidebar.tabDeployment') ]] as Array<[SidebarTab, string, number?]>) : []),
    // 分享 (R15-B1) creates member-grade links — hidden for anonymous visitors.
    ...(user !== null ? ([[ 'replayShare', t('sidebar.tabReplayShare') ]] as Array<[SidebarTab, string, number?]>) : []),
    // 批量评估 (T-016) reads the member-gated eval-run history — hidden for
    // anonymous visitors (the route 401s).
    ...(user !== null ? ([[ 'evalRuns', t('sidebar.tabEvalRuns') ]] as Array<[SidebarTab, string, number?]>) : []),
    // 评分报告 (Fix-37) is owner-only — same gate as the roster-report route.
    ...(world.myRole === 'owner' ? ([[ 'rosterReport', t('sidebar.tabRosterReport') ]] as Array<[SidebarTab, string, number?]>) : []),
    // 沙盒 (R40-B3) — living-world forks; the route requires auth (own+joined
    // forks; the env owner sees all).
    ...(user !== null ? ([[ 'sandboxes', t('sidebar.tabSandboxes') ]] as Array<[SidebarTab, string, number?]>) : []),
    // 对外通道 (R59) — API keys + event sources; both routes require auth.
    ...(user !== null ? ([[ 'externalChannel', t('sidebar.tabExternalChannel') ]] as Array<[SidebarTab, string, number?]>) : []),
    ['members', t('sidebar.tabMembers'), world.members.length],
  ];
  const groups = GROUP_ORDER.map(group => ({
    group,
    tabs: tabs.filter(([key]) => GROUP_OF_TAB[key] === group),
  })).filter(entry => entry.tabs.length > 0);
  // The open group follows the active tab (deep links included); clicking a
  // group header only reveals its tabs without leaving the current tab.
  const [openGroup, setOpenGroup] = useState<SidebarGroup>(() => GROUP_OF_TAB[tab]);
  useEffect(() => {
    setOpenGroup(GROUP_OF_TAB[tab]);
  }, [tab]);
  const openTabs = groups.find(entry => entry.group === openGroup)?.tabs ?? [];
  return (
    <aside className="world-sidebar">
      <div className="world-sidebar__groups">
        {groups.map(entry => (
          <button
            key={entry.group}
            className={
              openGroup === entry.group ? 'world-group world-group--active' : 'world-group'
            }
            onClick={() => {
              const wasOpen = openGroup === entry.group;
              setOpenGroup(entry.group);
              // R92 新手测试：展开新分组时自动选中其第一个 tab（内容跟随
              // 分组点击）；重复点击已展开分组只收拢，不抢当前 tab
              if (!wasOpen) {
                const first = entry.tabs[0]?.[0];
                if (first !== undefined && first !== tab) onTabChange(first);
              }
            }}
          >
            {t(`sidebar.group_${entry.group}`)}
          </button>
        ))}
      </div>
      <div className="world-sidebar__tabs">
        {openTabs.map(([key, label, count]) => (
          <button
            key={key}
            className={tab === key ? 'world-tab world-tab--active' : 'world-tab'}
            title={label}
            onClick={() => {
              // R80: leaving the services tab clears a stuck detail
              // selection — otherwise returning to the tab lands on the
              // old ServiceDetail instead of the marketplace (the state
              // leak R79's probes kept tripping over; humans hit it too).
              if (tab === 'services' && key !== 'services') selectService(null);
              onTabChange(key);
            }}
          >
            {label}
            {count !== undefined && <span className="world-tab__count">{count}</span>}
          </button>
        ))}
        {/* T-713: 业务流 quick link with the env's flow count (badge) and a
            per-author breakdown (tooltip). Login-gated like the header link
            and the flows page itself; a failed/absent list renders no badge. */}
        {user !== null && (
          <Link
            className="world-tab world-tab--link"
            to={`/environments/${world.id}/flows`}
            title={
              flows === null
                ? undefined
                : flowAuthorSplit.length > 0
                  ? t('sidebar.flowsTooltip', { count: flows.length, split: flowAuthorSplit })
                  : t('sidebar.flowsTooltipEmpty')
            }
          >
            {t('flowEditorLink')}
            {flows !== null && flows.length > 0 && (
              <span className="world-tab__count">{flows.length}</span>
            )}
          </Link>
        )}
      </div>
      <div className="world-sidebar__body">
        <Suspense fallback={<Loading className="world-sidebar__panel-fallback" />}>
          {tab === 'appOverview' && <AppOverviewPanel world={world} onTabChange={onTabChange} />}
          {tab === 'achievements' && <AchievementTimeline world={world} />}
          {tab === 'quests' && <QuestsPanel world={world} onTabChange={onTabChange} />}
          {tab === 'devices' && <DeviceTab world={world} onShowServices={serviceId => { selectService(serviceId); onTabChange('services'); }} />}
          {tab === 'agents' && <AgentTab world={world} onTabChange={onTabChange} />}
          {tab === 'services' && (
            <ServicesPanel
              world={world}
              onShowDevice={deviceId => {
                selectObject({ objectType: 'device', id: deviceId });
                onTabChange('devices');
              }}
            />
          )}
          {tab === 'agreements' && <AgreementsPanel world={world} />}
          {tab === 'governance' && <GovernanceInboxPanel world={world} onTabChange={onTabChange} />}
          {tab === 'catalog' && <CatalogPanel world={world} />}
          {tab === 'blueprints' && <BlueprintsPanel world={world} onTabChange={onTabChange} />}
          {tab === 'deployment' && <DeploymentPanel world={world} />}
          {tab === 'replayShare' && <ReplaySharePanel world={world} />}
          {tab === 'evalRuns' && <EvalRunsPanel world={world} />}
          {tab === 'rosterReport' && world.myRole === 'owner' && <RosterReportPanel world={world} />}
      {tab === 'sandboxes' && <SandboxPanel world={world} />}
          {tab === 'externalChannel' && <ExternalChannelPanel world={world} />}
          {tab === 'members' && <MembersTab world={world} />}
        </Suspense>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function usePermissions(world: EnvironmentDetail) {
  const user = useAppStore(s => s.user);
  const myRole = world.myRole;
  const canBuild = myRole === 'owner' || myRole === 'builder';
  const isEnvOwner = myRole === 'owner';
  const canMutateObject = (ownerId: string) =>
    canBuild && user !== null && (user.id === ownerId || isEnvOwner);
  return { user, canBuild, isEnvOwner, canMutateObject };
}

function OwnerLine({ owner }: { owner: { id: string; displayName: string } }) {
  const { t } = useTranslation('worldSidebarLib');
  return (
    <div className="object-detail__row">
      <span className="object-detail__label">{t('owner')}</span>
      <span className="owner-swatch" style={{ background: colorForUserId(owner.id) }} />
      {owner.displayName}
    </div>
  );
}

function stateLines(state: Record<string, unknown> | null | undefined): string {
  if (!state || Object.keys(state).length === 0) return i18n.t('worldSidebarLib:stateEmpty');
  return fullDeviceState(state);
}

/**
 * S2 (device privacy): non-owner viewers read the server's COARSE device
 * view — no initialState, but an honest on/off/present status. Render that
 * honestly (a privacy note naming the owner-only channel) instead of the
 * misleading "（无）" empty-state text.
 */
function coarseStatusWord(status: string | undefined): string {
  if (status === 'on') return i18n.t('world:device.statusOn');
  if (status === 'off') return i18n.t('world:device.statusOff');
  return i18n.t('world:device.statusPresent');
}

/** T-051: one policy field → 默认/开/关 (undefined keeps the runtime default). */
function policyWord(value: boolean | undefined, words: { on: string; off: string; unset: string }): string {
  if (value === true) return words.on;
  if (value === false) return words.off;
  return words.unset;
}

// ---------------------------------------------------------------------------
// Devices tab
// ---------------------------------------------------------------------------

function DeviceTab({
  world,
  onShowServices,
}: {
  world: EnvironmentDetail;
  /** Open a service in the 服务 marketplace tab (W3 "支撑的服务"). */
  onShowServices: (serviceId: string) => void;
}) {
  const selection = useAppStore(s => s.selection);
  const selectObject = useAppStore(s => s.selectObject);
  const applyWorldMessage = useAppStore(s => s.applyWorldMessage);
  const pushToast = useAppStore(s => s.pushToast);
  const confirm = useConfirm();
  const { canBuild, isEnvOwner, canMutateObject } = usePermissions(world);
  const { t } = useTranslation('world');
  const { t: tw } = useTranslation('workbench');

  /** W6-2: the embedded ad-hoc device form (null device = create mode). */
  const [form, setForm] = useState<{ device: WorldDevice | null } | null>(null);
  /** W6-2: the env owner's zone management view. */
  const [zonesOpen, setZonesOpen] = useState(false);

  const selected =
    selection?.objectType === 'device'
      ? (world.devices.find(d => d.id === selection.id) ?? null)
      : null;
  /** W4: zone picked on the map → read-only zone detail in this tab. */
  const selectedZone =
    selection?.objectType === 'zone'
      ? (world.zones.find(z => z.id === selection.id) ?? null)
      : null;

  const remove = async (device: WorldDevice) => {
    // R100 (li-10): the confirm dialog must state the cascade BEFORE the
    // user commits — the agent(s) this device is bound to and the derived
    // services it backs (the rule check REJECTS deleting a bound device).
    const boundAgents = world.agents.filter(agent => agent.boundDeviceIds.includes(device.id));
    const backedServices = servicesBackedByDevice(world.services, device.id);
    const confirmed = await confirm({
      body:
        boundAgents.length > 0 || backedServices.length > 0
          ? t('device.deleteConfirmCascade', {
              name: device.name,
              agents: boundAgents.map(agent => agent.name).join('、') || '—',
              serviceCount: backedServices.length,
            })
          : t('device.deleteConfirm', { name: device.name }),
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      const response = await api.deleteDevice(device.id);
      // R100: a builder's delete converts into a remove-devices PROPOSAL —
      // the device STAYS until the pipeline approves. Never render a
      // deletion that has not happened (the old optimistic applyWorldMessage
      // 'deleted' was the "假删除" bug: rule-rejected proposals left the UI
      // showing a deleted device that was in fact still running).
      if (api.isProposalConversion(response)) {
        if (response.status === 'rejected') {
          // The rule check refused — say WHY, in the page body, and keep
          // the device exactly as it is.
          pushToast(
            t('device.deleteRejected', {
              issues: response.ruleCheck?.issues?.join('；') ?? response.status,
            }),
          );
          return;
        }
        if (response.status === 'applied') {
          selectObject(null);
          applyWorldMessage({
            kind: 'world',
            action: 'deleted',
            objectType: 'device',
            object: { id: device.id },
          });
          pushToast(t('device.deleteProposalApplied', { id: response.id }));
          return;
        }
        // Submitted/pending — the device leaves the world only on approval.
        pushToast(t('device.deleteProposed', { id: response.id, status: response.status }));
        return;
      }
      selectObject(null);
      // The env owner's direct delete: the world stream broadcasts the same
      // delete; the reducer dedupes.
      applyWorldMessage({
        kind: 'world',
        action: 'deleted',
        objectType: 'device',
        object: { id: device.id },
      });
    } catch (error) {
      pushToast(t('device.deleteFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  if (zonesOpen) {
    return (
      <Suspense fallback={<Loading className="world-sidebar__panel-fallback" />}>
        <ZonePanel world={world} onClose={() => setZonesOpen(false)} />
      </Suspense>
    );
  }

  if (form) {
    return (
      <DeviceForm
        key={form.device?.id ?? 'create'}
        world={world}
        device={form.device}
        onClose={() => setForm(null)}
      />
    );
  }

  if (selectedZone) {
    const zoneDevices = world.devices.filter(device => device.zoneId === selectedZone.id);
    return (
      <div className="object-detail">
        <button className="link-button" onClick={() => selectObject(null)}>
          <Icon icon={ArrowLeft} size={14} /> {t('device.backToList')}
        </button>
        <h4 className="object-detail__name">{selectedZone.name ?? selectedZone.id}</h4>
        {selectedZone.type && (
          <div className="object-detail__row">
            <span className="object-detail__label">{t('device.type')}</span>
            {selectedZone.type}
          </div>
        )}
        {selectedZone.buildingId && (
          <div className="object-detail__row">
            <span className="object-detail__label">{t('zoneDetail.building')}</span>
            {selectedZone.buildingId}
          </div>
        )}
        {selectedZone.floor !== undefined && (
          <div className="object-detail__row">
            <span className="object-detail__label">{t('zoneDetail.floor')}</span>
            {selectedZone.floor < 0 ? `B${-selectedZone.floor}` : `${selectedZone.floor + 1}F`}
          </div>
        )}
        {/* FEAT-07: the zone's occupantSchedule (read-only) — window
            boundaries drive setZoneOccupancy in the runtime. */}
        {selectedZone.occupantSchedule && (
          <div className="object-detail__row">
            <span className="object-detail__label">{t('zoneDetail.occupantSchedule')}</span>
            {t('zoneDetail.occupantScheduleValue', {
              count: selectedZone.occupantSchedule.count,
              start: simDayClock(selectedZone.occupantSchedule.startSimTimeSec),
              end: simDayClock(selectedZone.occupantSchedule.endSimTimeSec),
              cadence: t(
                selectedZone.occupantSchedule.repeatDaily === false
                  ? 'zoneDetail.occupantScheduleOneShot'
                  : 'zoneDetail.occupantScheduleDaily',
              ),
            })}
          </div>
        )}
        {/* FEAT-07 phase-2: the temporary calendar overlay (read-only) —
            replaces the base schedule inside its absolute sim-time window;
            the status rides the world session's clock (no live session →
            the window renders without a status claim). */}
        {selectedZone.occupantScheduleOverlay && (
          <div className="object-detail__row">
            <span className="object-detail__label">{t('zoneDetail.occupantScheduleOverlay')}</span>
            {t('zoneDetail.occupantScheduleOverlayValue', {
              count: selectedZone.occupantScheduleOverlay.schedule.count,
              start: simDayClock(selectedZone.occupantScheduleOverlay.schedule.startSimTimeSec),
              end: simDayClock(selectedZone.occupantScheduleOverlay.schedule.endSimTimeSec),
              cadence: t(
                selectedZone.occupantScheduleOverlay.schedule.repeatDaily === false
                  ? 'zoneDetail.occupantScheduleOneShot'
                  : 'zoneDetail.occupantScheduleDaily',
              ),
              window: (() => {
                const overlay = selectedZone.occupantScheduleOverlay!;
                const windowText = `${simAbsDayClock(overlay.startsAtSimSec)} → ${simAbsDayClock(overlay.endsAtSimSec)}`;
                const status = occupantOverlayStatus(overlay, world.worldSession?.simTimeSec);
                return status === undefined
                  ? windowText
                  : `${windowText} · ${t(`zoneDetail.occupantOverlay${status === 'active' ? 'Active' : status === 'pending' ? 'Pending' : 'Expired'}`)}`;
              })(),
            })}
          </div>
        )}
        {/* R82: declarative interior rooms (campus-guide semantics) — hidden
            when the world does not carry any, rendered as read-only rows. */}
        {(selectedZone.rooms?.length ?? 0) > 0 && (
          <DetailSection title={t('zoneDetail.rooms', { count: selectedZone.rooms!.length })}>
            {selectedZone.rooms!.map((room, index) => (
              <div key={`${room.code ?? 'room'}-${index}`} className="object-detail__row">
                <span className="object-detail__label">{room.code ?? room.type ?? '·'}</span>
                <span>
                  {room.name}
                  {room.hours ? ` · ${room.hours}` : ''}
                </span>
              </div>
            ))}
          </DetailSection>
        )}
        {/* R82: floor mini-map — footprint outline + one dot per positioned
            room (pos), only when the world carries plan positions. */}
        {(selectedZone.polygon || selectedZone.bounds) && <ZoneFloorPlan zone={selectedZone} />}
        <DetailSection title={t('zoneDetail.devices', { count: zoneDevices.length })}>
          {zoneDevices.map(device => (
            <button
              key={device.id}
              className="link-button object-detail__link"
              onClick={() => selectObject({ objectType: 'device', id: device.id })}
            >
              {device.name}
            </button>
          ))}
          {zoneDevices.length === 0 && (
            <div className="page-note">{t('zoneDetail.devicesEmpty')}</div>
          )}
        </DetailSection>
        {/* UX-10: baseline editing + scheduled events (事件剧本) straight
            from the zone detail — no scenario-JSON round-trip; owner-only
            writes, read-only display otherwise. */}
        <ZoneBaselineEditor world={world} zone={selectedZone} />
        <ZoneScheduleEditor world={world} zone={selectedZone} />
      </div>
    );
  }

  if (selected) {
    return (
      <div className="object-detail">
        <button className="link-button" onClick={() => selectObject(null)}>
          <Icon icon={ArrowLeft} size={14} /> {t('device.backToList')}
        </button>
        <h4 className="object-detail__name">{selected.name}</h4>
        <div className="object-detail__row">
          <span className="object-detail__label">{t('device.type')}</span>
          {selected.type}
          {selected.brand ? ` · ${selected.brand}` : ''}
        </div>
        <OwnerLine owner={selected.owner} />
        <div className="object-detail__row">
          <span className="object-detail__label">{t('device.zone')}</span>
          {world.zones.find(z => z.id === selected.zoneId)?.name ?? selected.zoneId}
        </div>
        <DetailSection title={t('device.capabilities', { count: selected.capabilities.length })}>
          <div className="chip-row">
            {selected.capabilities.map(capability => (
              <span key={capability} className="chip">
                {capability}
              </span>
            ))}
          </div>
        </DetailSection>
        <DetailSection title={t('device.initialState')}>
          {selected.stateVisibility === 'coarse' ? (
            <div className="object-detail__state">
              {t('device.stateCoarse', { status: coarseStatusWord(selected.status) })}
            </div>
          ) : (
            <div className="object-detail__state">{stateLines(selected.initialState)}</div>
          )}
        </DetailSection>
        <DetailSection
          title={t('device.backedServices', { count: servicesBackedByDevice(world.services, selected.id).length })}
        >
          {servicesBackedByDevice(world.services, selected.id).map(service => (
            <button
              key={service.id}
              className="link-button object-detail__link"
              onClick={() => onShowServices(service.id)}
            >
              {service.name}（{service.origin === 'derived' ? tw('originDerived') : tw('originPublished')}）
            </button>
          ))}
          {servicesBackedByDevice(world.services, selected.id).length === 0 && (
            <div className="page-note">{t('device.backedServicesEmpty')}</div>
          )}
        </DetailSection>
        {canMutateObject(selected.owner.id) && (
          <div className="object-detail__actions">
            <button onClick={() => setForm({ device: selected })}>{t('device.edit')}</button>
            <button className="danger-button" onClick={() => void remove(selected)}>
              {t('device.deleteDevice')}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="object-list">
      {canBuild && (
        <button
          className="primary-button world-sidebar__create"
          disabled={world.zones.length === 0}
          title={world.zones.length === 0 ? t('device.createZoneFirst') : undefined}
          onClick={() => setForm({ device: null })}
        >
          {t('device.newDevice')}
        </button>
      )}
      {isEnvOwner && (
        <button className="world-sidebar__create" onClick={() => setZonesOpen(true)}>
          {t('device.zoneManagement')}
        </button>
      )}
      {world.devices.length === 0 && (
        <p className="page-note">
          {t('device.empty')}
          {canBuild && world.zones.length > 0
            ? t('device.emptyCanBuild')
            : t('device.emptyNoBuild')}
          {isEnvOwner && world.zones.length === 0 ? t('device.emptyNoZones') : ''}
        </p>
      )}
      {world.devices.map(device => (
        <DeviceRow
          key={device.id}
          device={device}
          zoneName={world.zones.find(z => z.id === device.zoneId)?.name ?? device.zoneId}
        />
      ))}
    </div>
  );
}

/**
 * Track F 信息分级: the row shows only the owner swatch + name (+chevron);
 * clicking it expands an inline brief (type · zone · capability count) whose
 * 「查看完整详情」 button opens the detail view — the row no longer jumps
 * straight into the detail.
 */
function DeviceRow({ device, zoneName }: { device: WorldDevice; zoneName: string }) {
  const selectObject = useAppStore(s => s.selectObject);
  const [open, setOpen] = useState(false);
  const { t } = useTranslation('world');
  const brief = deviceBrief(device, zoneName);
  return (
    <div className="object-list__row">
      <button
        className="object-list__item"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span
          className="owner-swatch"
          style={{ background: colorForUserId(device.owner.id) }}
          title={device.owner.displayName}
        />
        <span className="object-list__name" title={device.name}>{device.name}</span>
        <Icon
          icon={open ? ChevronDown : ChevronRight}
          size={13}
          className="object-list__chevron"
        />
      </button>
      {open && (
        <RowBrief onOpenDetail={() => selectObject({ objectType: 'device', id: device.id })}>
          <span className="object-list__brief-row">
            {brief.type} · {brief.zoneName} · {t('device.capabilities', { count: brief.capabilityCount })}
          </span>
        </RowBrief>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agents tab
// ---------------------------------------------------------------------------

function AgentTab({
  world,
  onTabChange,
}: {
  world: EnvironmentDetail;
  onTabChange: (tab: SidebarTab) => void;
}) {
  // R78-B: quota badge + up-front gate on the create button (R77 F4).
  const quotasQuery = useMyQuotas();
  const agentQuota = quotaState(
    'Agent',
    world.agents.length,
    quotasQuery.data?.quotas.agentsPerEnv.limit,
  );
  // R80-FW2: the claim lane — hooks ABOVE the selected-agent early return
  // (hook-count safety; the misplaced copy broke rowBrief's render path).
  const membersPlan = world.governance?.ownershipPlan === 'members';
  const [claimBusy, setClaimBusy] = useState<string | null>(null);
  const claim = async (agentId: string) => {
    if (user === null || claimBusy !== null) return;
    setClaimBusy(agentId);
    try {
      const proposal = await api.submitClaimProposal(world.id, [
        { kind: 'agent', id: agentId, toUser: user.id },
      ]);
      pushToast(
        proposal.status === 'applied'
          ? t('agent.claimApplied')
          : t('agent.claimProposed', { id: proposal.id, status: proposal.status }),
      );
    } catch (error) {
      pushToast(t('agent.claimFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setClaimBusy(null);
    }
  };
  const selection = useAppStore(s => s.selection);
  const selectObject = useAppStore(s => s.selectObject);
  const selectService = useAppStore(s => s.selectService);
  const applyWorldMessage = useAppStore(s => s.applyWorldMessage);
  const pushToast = useAppStore(s => s.pushToast);
  const confirm = useConfirm();
  const { user, canBuild, isEnvOwner, canMutateObject } = usePermissions(world);
  const { t } = useTranslation('world');
  const { t: tw } = useTranslation('workbench');

  /** W6: the embedded creation/edit wizard (null agent = create mode). */
  const [wizard, setWizard] = useState<{ agent: WorldAgent | null } | null>(null);

  const selected =
    selection?.objectType === 'agent'
      ? (world.agents.find(a => a.id === selection.id) ?? null)
      : null;

  const remove = async (agent: WorldAgent) => {
    const serviceCount = servicesOfAgent(world.services, agent.id).length;
    if (
      !(await confirm({
        body: t('agent.deleteConfirm', { name: agent.name, count: serviceCount }),
        tone: 'danger',
      }))
    ) {
      return;
    }
    try {
      const response = await api.deleteAgent(agent.id);
      // T-048: a builder's delete converts into a remove-agents PROPOSAL
      // (201 + body) — the agent STAYS until approval, so no local deletion.
      if (api.isProposalConversion(response)) {
        selectObject(null);
        pushToast(
          response.status === 'applied'
            ? t('agent.deleteProposalApplied', { id: response.id })
            : t('agent.deleteProposed', { id: response.id, status: response.status }),
        );
        return;
      }
      selectObject(null);
      applyWorldMessage({
        kind: 'world',
        action: 'deleted',
        objectType: 'agent',
        object: { id: agent.id },
      });
    } catch (error) {
      pushToast(t('agent.deleteFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  /**
   * 启停开关：env owner PATCHes directly（响应乐观应用，world stream 按 id
   * 去重）；a builder routes through a modify-object proposal (T-048 — the
   * direct PATCH route is owner-only, and `enabled` is a proposal field now).
   */
  const toggleEnabled = async (agent: WorldAgent, enabled: boolean) => {
    try {
      if (isEnvOwner) {
        const updated = await api.patchAgent(agent.id, { enabled });
        applyWorldMessage({ kind: 'world', action: 'updated', objectType: 'agent', object: updated });
        pushToast(enabled ? t('agent.enabledToast', { name: agent.name }) : t('agent.disabledToast', { name: agent.name }));
        return;
      }
      const proposal = await api.submitModifyObjectProposal(world.id, agent.id, { enabled });
      pushToast(
        proposal.status === 'applied'
          ? t('agent.toggleProposalApplied', { name: agent.name })
          : t('agent.toggleProposed', { id: proposal.id, status: proposal.status }),
      );
    } catch (error) {
      pushToast(t('agent.toggleFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  if (wizard) {
    return (
      <Suspense fallback={<Loading className="world-sidebar__panel-fallback" />}>
        <AgentWizard
          key={wizard.agent?.id ?? 'create'}
          world={world}
          agent={wizard.agent}
          onClose={() => setWizard(null)}
        />
      </Suspense>
    );
  }

  if (selected) {
    return (
      <div className="object-detail">
        <button className="link-button" onClick={() => selectObject(null)}>
          <Icon icon={ArrowLeft} size={14} /> {t('agent.backToList')}
        </button>
        <h4 className="object-detail__name">{selected.name}</h4>
        <OwnerLine owner={selected.owner} />
        <div className="object-detail__row">
          <span className="object-detail__label">{t('agent.status')}</span>
          {selected.enabled ? t('agent.enabled') : t('agent.disabled')}
          {canMutateObject(selected.owner.id) && (
            <label className="check-list__item" title={t('agent.enabledHint')}>
              <input
                type="checkbox"
                checked={selected.enabled}
                onChange={event => void toggleEnabled(selected, event.target.checked)}
              />
              {t('agent.enableToggle')}
            </label>
          )}
        </div>
        <div className="object-detail__row" data-testid="agent-llm-summary">
          <span className="object-detail__label">{t('agent.llm')}</span>
          {selected.llm ? `${selected.llm.provider}/${selected.llm.model}` : t('agent.llmNone')}
        </div>
        {/* T-051: the author's actuation defaults (absent = runtime default). */}
        {selected.decisionPolicy !== undefined && (
          <div className="object-detail__row" data-testid="agent-decision-policy">
            <span className="object-detail__label">{t('agent.policy')}</span>
            {t('agent.policyLine', {
              actuate: policyWord(selected.decisionPolicy.autoActuateIndependent, {
                on: t('agent.policyOn'),
                off: t('agent.policyOff'),
                unset: t('agent.policyDefault'),
              }),
              initiate: policyWord(selected.decisionPolicy.autoInitiateAC, {
                on: t('agent.policyOn'),
                off: t('agent.policyOff'),
                unset: t('agent.policyDefault'),
              }),
            })}
          </div>
        )}
        <DetailSection title={t('agent.capabilitiesCount', { count: selected.capabilities.length })}>
          <div className="chip-row">
            {selected.capabilities.map(capability => (
              <span key={capability} className="chip">
                {capability}
              </span>
            ))}
          </div>
        </DetailSection>
        {(() => {
          const trackRecord = perCapabilityReputation(world.services, selected.id);
          if (trackRecord.length === 0) return null;
          return (
            <DetailSection title={t('agent.reputation')}>
              <div data-testid="agent-reputation">
                {trackRecord.map(rep => (
                  <div key={rep.capability} className="reputation-bar">
                    <span className="reputation-bar__capability" title={rep.capability}>{rep.capability}</span>
                    <span className={`track-record__bar track-record__bar--${reputationTier(rep)}`}>
                      <span
                        className="track-record__fill"
                        style={{ width: formatReputationPercent(rep.score) }}
                      />
                    </span>
                    <span className="reputation-bar__value">
                      {formatReputationPercent(rep.score)}
                    </span>
                    <ReputationChip reputation={rep} />
                  </div>
                ))}
              </div>
            </DetailSection>
          );
        })()}
        {selected.llm && (
          <DetailSection title={t('agent.llmConfig')}>
            <div className="object-detail__row">
              <span className="object-detail__label">{t('agent.llmProvider')}</span>
              {selected.llm.provider}
            </div>
            <div className="object-detail__row">
              <span className="object-detail__label">{t('agent.llmModel')}</span>
              {selected.llm.model}
            </div>
          </DetailSection>
        )}
        <DetailSection title={t('agent.boundDevices', { count: selected.boundDeviceIds.length })}>
          {selected.boundDeviceIds.map(id => {
            const device = world.devices.find(d => d.id === id);
            return (
              <button
                key={id}
                className="link-button object-detail__link"
                onClick={() => {
                  selectObject({ objectType: 'device', id });
                  onTabChange('devices');
                }}
              >
                {device?.name ?? id}（{t('agent.boundDevicesHint')}）
              </button>
            );
          })}
          {selected.boundDeviceIds.length === 0 && <div className="page-note">{t('agent.boundDevicesEmpty')}</div>}
        </DetailSection>
        <DetailSection title={t('agent.managedZones', { count: selected.managedZoneIds.length })}>
          {selected.managedZoneIds.map(id => (
            <div key={id} className="agent-card__item">
              {world.zones.find(z => z.id === id)?.name ?? id}
            </div>
          ))}
        </DetailSection>
        <DetailSection
          title={t('agent.publishedServices', { count: servicesOfAgent(world.services, selected.id).length })}
        >
          {servicesOfAgent(world.services, selected.id).map(service => (
            <button
              key={service.id}
              className="link-button object-detail__link"
              onClick={() => {
                selectService(service.id);
                onTabChange('services');
              }}
            >
              {service.name}（{service.origin === 'derived' ? tw('originDerived') : tw('originPublished')}）
              {service.unbacked && <Icon icon={TriangleAlert} size={13} label={t('agent.unbackedService')} />}
            </button>
          ))}
          {servicesOfAgent(world.services, selected.id).length === 0 && (
            <div className="page-note">{t('agent.publishedServicesEmpty')}</div>
          )}
        </DetailSection>
        {canMutateObject(selected.owner.id) && (
          <div className="object-detail__actions">
            <button onClick={() => setWizard({ agent: selected })}>{t('agent.edit')}</button>
            <button className="danger-button" onClick={() => void remove(selected)}>
              {t('agent.deleteAgent')}
            </button>
          </div>
        )}
      </div>
    );
  }

  const { mine, others } = groupAgentsByOwner(world.agents, user?.id ?? null);

  return (
    <div className="object-list">
      {canBuild && (
        <button
          className="primary-button world-sidebar__create"
          disabled={agentQuota.exhausted}
          title={agentQuota.title ?? undefined}
          onClick={() => setWizard({ agent: null })}
        >
          {t('agent.newAgent')}
          <span
            className={`quota-badge${agentQuota.nearLimit ? ' quota-badge--warn' : ''}${agentQuota.exhausted ? ' quota-badge--full' : ''}`}
          >
            {agentQuota.label}
          </span>
        </button>
      )}
      {world.agents.length === 0 && (
        <p className="page-note">
          {t('agent.empty')}
          {canBuild ? t('agent.emptyCanBuild') : ''}
        </p>
      )}
      {mine.length > 0 && (
        <section className="agent-owner-group">
          {others.length > 0 && <h5 className="agent-owner-group__title">{t('agent.groupMine')}</h5>}
          {mine.map(agent => <AgentRow key={agent.id} agent={agent} world={world} />)}
        </section>
      )}
      {others.map(group => (
        <section key={group.owner.id} className="agent-owner-group">
          <h5 className="agent-owner-group__title">
            <span
              className="owner-swatch"
              style={{ background: colorForUserId(group.owner.id) }}
            />
            {t('agent.groupOthers', { name: group.owner.displayName })}
          </h5>
          {group.agents.map(agent => (
            <div key={agent.id}>
              <AgentRow agent={agent} world={world} />
              {membersPlan && group.owner.id === world.owner.id && user !== null && (
                <button
                  className="link-button"
                  disabled={claimBusy !== null}
                  onClick={() => void claim(agent.id)}
                >
                  {claimBusy === agent.id ? t('agent.claimBusy') : t('agent.claim')}
                </button>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/**
 * Track F 信息分级 (same contract as DeviceRow): the row shows only the
 * initial badge + name; the inline brief carries the 设备/区域 counts, the
 * LLM status and the aggregate reputation, and its 「查看完整详情」 button
 * opens the detail view.
 */
function AgentRow({ agent, world }: { agent: WorldAgent; world: EnvironmentDetail }) {  const selectObject = useAppStore(s => s.selectObject);
  const [open, setOpen] = useState(false);
  const { t } = useTranslation('world');
  const brief = agentBrief(agent, world.services);
  return (
    <div className="object-list__row">
      <button
        className="object-list__item"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className="agent-list-initial">{(agent.name.trim()[0] ?? 'A').toUpperCase()}</span>
        <span className="object-list__name" title={agent.name}>{agent.name}</span>
        <Icon
          icon={open ? ChevronDown : ChevronRight}
          size={13}
          className="object-list__chevron"
        />
      </button>
      {open && (
        <RowBrief onOpenDetail={() => selectObject({ objectType: 'agent', id: agent.id })}>
          <span className="object-list__brief-row">
            {t('agent.row', { devices: brief.deviceCount, zones: brief.zoneCount })}
          </span>
          <span className="object-list__brief-row">
            {t('agent.llm')} · {brief.llm ?? t('agent.llmNone')}
          </span>
          {brief.reputation && (
            <span className="object-list__brief-row">
              <ReputationChip reputation={brief.reputation} />
            </span>
          )}
        </RowBrief>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Members tab
// ---------------------------------------------------------------------------

function MembersTab({ world }: { world: EnvironmentDetail }) {
  const roleLabel = useRoleLabel();
  const { t } = useTranslation('world');
  const onlineUsers = useAppStore(s => s.onlineUsers);
  const onlineAnonymousCount = useAppStore(s => s.onlineAnonymousCount);
  const reloadWorld = useAppStore(s => s.reloadWorld);
  const pushToast = useAppStore(s => s.pushToast);
  const confirm = useConfirm();
  const { user, canBuild, isEnvOwner } = usePermissions(world);
  const queryClient = useQueryClient();
  const onlineIds = new Set(onlineUsers.map(user => user.id));

  /** Roster management (owner/builder): batch import dialog open state. */
  const [importOpen, setImportOpen] = useState(false);

  // R15-D10: pending invites (owner-only view) — emails imported before the
  // student registered; they join automatically on registration.
  const invites = useQuery({
    queryKey: ['environments', 'invites', world.id],
    queryFn: () => api.listEnvInvites(world.id),
    enabled: isEnvOwner,
  });
  const revokeInvite = async (inviteId: string, email: string) => {
    try {
      await api.revokeEnvInvite(world.id, inviteId);
      void queryClient.invalidateQueries({ queryKey: ['environments', 'invites', world.id] });
    } catch (error) {
      pushToast(t('memberManage.revokeFailed', {
        email,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  // The member list lives in the world store slice (refilled by reloadWorld);
  // the environments list query caches member counts — drop both.
  const refreshMembers = () => {
    void reloadWorld();
    void queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
  };

  const remove = async (member: EnvMember) => {
    if (member.userId === undefined) return;
    if (!(await confirm({ body: t('memberManage.removeConfirm', { name: member.displayName }), tone: 'danger' }))) return;
    try {
      await api.removeMember(world.id, member.userId);
      refreshMembers();
    } catch (error) {
      pushToast(t('memberManage.removeFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const changeRole = async (member: EnvMember, role: 'builder' | 'viewer') => {
    if (member.userId === undefined) return;
    try {
      await api.updateMemberRole(world.id, member.userId, role);
      refreshMembers();
    } catch (error) {
      pushToast(t('memberManage.roleFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const counts = new Map<string, { devices: number; agents: number }>();
  for (const device of world.devices) {
    const entry = counts.get(device.owner.id) ?? { devices: 0, agents: 0 };
    entry.devices += 1;
    counts.set(device.owner.id, entry);
  }
  for (const agent of world.agents) {
    const entry = counts.get(agent.owner.id) ?? { devices: 0, agents: 0 };
    entry.agents += 1;
    counts.set(agent.owner.id, entry);
  }

  return (
    <div className="member-list">
      <p className="member-list__online">
        {t('member.onlineCount', { count: onlineUsers.length })}
        {onlineAnonymousCount > 0 ? t('member.onlineAnonymousSuffix', { count: onlineAnonymousCount }) : ''}
      </p>
      <p className="page-note member-list__hint">{t('member.colorHint')}</p>
      {canBuild && (
        <Button variant="primary" className="world-sidebar__create" onClick={() => setImportOpen(true)}>
          {t('memberManage.importButton')}
        </Button>
      )}
      {isEnvOwner && (invites.data ?? []).length > 0 && (
        <div className="member-invites">
          <h4 className="member-invites__title">{t('memberManage.invitesTitle', { count: invites.data!.length })}</h4>
          <ul className="member-invites__list">
            {invites.data!.map(invite => (
              <li key={invite.id} className="member-invites__row">
                <span className="member-invites__email" title={invite.email}>{invite.email}</span>
                <span className="badge">{invite.role === 'viewer' ? t('memberManage.roleViewer') : t('memberManage.roleBuilder')}</span>
                <button
                  className="link-button"
                  onClick={() => void revokeInvite(invite.id, invite.email)}
                >
                  {t('memberManage.revoke')}
                </button>
              </li>
            ))}
          </ul>
          <p className="page-note member-invites__hint">{t('memberManage.invitesHint')}</p>
        </div>
      )}
      {/* T-072 (D-1 decide half): the governance block's delegation, shown
          where member governance lives — everyone who can read the world
          sees WHO besides the owner may decide zone-claims (it is governance
          fact, same visibility as the members list). */}
      {(world.governance?.decisionDelegations ?? []).length > 0 && (
        <DetailSection title={t('memberManage.delegationsTitle')}>
          <div className="object-detail">
            {world.governance!.decisionDelegations!.map(delegation => (
              <div key={delegation.scope} className="object-detail__row">
                <span className="object-detail__label">{t('memberManage.delegationScope', { scope: delegation.scope })}</span>
                <span>
                  <span className="owner-swatch" style={{ background: colorForUserId(delegation.delegate.id) }} />
                  {delegation.delegate.displayName}
                  {' '}
                  <span className="badge">
                    {delegation.zones === 'all'
                      ? t('memberManage.delegationAllZones')
                      : t('memberManage.delegationZones', { zones: delegation.zones.join(', ') })}
                  </span>
                </span>
              </div>
            ))}
            <p className="page-note">{t('memberManage.delegationHint')}</p>
          </div>
        </DetailSection>
      )}
      {world.members.map((member, index) => {
        // userId is redacted for non-member viewers (Fix-4): fall back to a
        // displayName key and skip the per-id lookups for those entries.
        const entry = member.userId !== undefined
          ? counts.get(member.userId) ?? { devices: 0, agents: 0 }
          : { devices: 0, agents: 0 };
        const online = member.userId !== undefined && onlineIds.has(member.userId);
        // Server-side rules mirrored on the controls: the owner role is
        // immutable / not removable; role changes are owner-only; the owner
        // may remove anyone, a member may remove themselves (leave).
        const canEditRole = canBuild && isEnvOwner && member.role !== 'owner' && member.userId !== undefined;
        const canRemove =
          canBuild &&
          member.role !== 'owner' &&
          member.userId !== undefined &&
          (isEnvOwner || member.userId === user?.id);
        return (
          <div key={member.userId ?? `${member.role}-${index}`} className="member-list__item">
            <span
              className={online ? 'presence-dot presence-dot--online' : 'presence-dot'}
              title={online ? t('member.online') : t('member.offline')}
            />
            <span
              className="owner-swatch"
              style={{ background: colorForUserId(member.userId ?? member.displayName) }}
            />
            <span className="member-list__name">
              {member.displayName}
              {member.role === 'owner' ? t('memberList.ownerSuffix') : ''}
            </span>
            {canEditRole ? (
              <select
                className="member-list__role"
                value={member.role}
                onChange={event => void changeRole(member, event.target.value as 'builder' | 'viewer')}
              >
                <option value="builder">{roleLabel('builder')}</option>
                <option value="viewer">{roleLabel('viewer')}</option>
              </select>
            ) : (
              <span className="badge">{roleLabel(member.role)}</span>
            )}
            <span className="member-list__counts">
              {t('member.counts', { devices: entry.devices, agents: entry.agents })}
            </span>
            {canRemove && (
              <Button
                variant="danger"
                size="sm"
                className="member-list__remove"
                title={t('memberManage.remove')}
                onClick={() => void remove(member)}
              >
                {t('memberManage.remove')}
              </Button>
            )}
          </div>
        );
      })}
      {importOpen && (
        <Suspense fallback={null}>
          <MemberImportDialog
            envId={world.id}
            onClose={() => setImportOpen(false)}
            onImported={refreshMembers}
          />
        </Suspense>
      )}
    </div>
  );
}
