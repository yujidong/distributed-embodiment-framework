/**
 * LivePanels — per-agent status, recent decisions, and a collapsible
 * per-device state table, all rendered defensively from the latest snapshot.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Brain } from 'lucide-react';

import type { EngineSnapshot, SnapshotAgent } from '../api/types';
import { formatEnergyWh, fullDeviceState } from '../lib/format';
import { decisionLabel } from '../lib/happeningNow';
import { localClockTime } from '../lib/clockTime';
import type { EnvTimeseries } from '../lib/timeseries';
import { useAppStore } from '../store/useAppStore';
import { EnvSeriesPanel } from './EnvSeriesPanel';
import { EmptyState } from './ui/EmptyState';
import { EnergyPanel } from './EnergyPanel';
import { Icon } from './ui/Icon';

function AgentStatusCard({ agent }: { agent: SnapshotAgent }) {
  const { t } = useTranslation('livePanels');
  return (
    <div className="agent-card">
      <div className="agent-card__name">
        {agent.name}
        <span className={`badge ${agent.llmEnabled ? 'badge--llm' : 'badge--rule'}`}>
          {agent.llmEnabled ? t('llmBadge') : t('ruleOnlyBadge')}
        </span>
      </div>
      <div className="agent-card__id">{agent.id}</div>
      <div className="agent-card__stats">
        <span>{t('eventsProcessed', { count: agent.eventsProcessed })}</span>
        <span>{t('activeAC', { count: agent.activeACCount })}</span>
      </div>
      {agent.activeCollaborations.length > 0 && (
        <div className="agent-card__section">
          <span className="agent-card__label">{t('activeCollaborations')}</span>
          {agent.activeCollaborations.map(ac => (
            <div key={ac.id} className="agent-card__item">
              {ac.name} · {ac.status}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDecisionTime(iso: string): string {
  // G4: 跟随 i18n 语言（原硬编码 'zh-CN'）；无效输入由 helper 原样返回。
  return localClockTime(iso);
}

/** Cumulative energy (Wh) reported in the device state, or null when absent. */
function deviceEnergyWh(state: Record<string, unknown> | undefined): number | null {
  const value = state?.cumulativeEnergyWh;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface LivePanelsProps {
  snapshot: EngineSnapshot;
  /** 环境时序缓冲（live snapshot 流累积，回放不污染）。 */
  envSeries: EnvTimeseries;
  /** W4: zone picked on the console map — the 环境曲线 default follows it. */
  mapSelectedZoneId?: string | null;
  /**
   * R15-D8: the LIVE store snapshot (not the replay cursor's) — the energy
   * curves accumulate from it, exactly like envSeries does.
   */
  liveSnapshot?: EngineSnapshot | null;
}

export function LivePanels({
  snapshot, envSeries, mapSelectedZoneId = null, liveSnapshot = null,
}: LivePanelsProps) {
  const [devicesOpen, setDevicesOpen] = useState(true);
  const selectedAgentId = useAppStore(s => s.selectedAgentId);
  const { t } = useTranslation('livePanels');

  // recentDecisions is a ring buffer, newest last — show newest first.
  const decisions = [...snapshot.recentDecisions].reverse().slice(0, 20);
  // S6: 决策列表显示 Agent 名字而不是裸 id；decisionSource 走 i18n 映射。
  const agentNameById = new Map(snapshot.agents.map(agent => [agent.id, agent.name]));
  const decisionSourceLabel = (source: string): string => {
    const key = `source_${source}`;
    const label = t(key);
    return label === key ? source : label;
  };
  // 环境曲线默认 zone：地图上点选的 zone 优先，其次是当前聚焦 agent 的第
  // 一个管辖 zone。
  const preferredZoneId =
    mapSelectedZoneId ??
    (selectedAgentId
      ? (snapshot.agents.find(a => a.id === selectedAgentId)?.managedZoneIds[0] ?? null)
      : null);

  return (
    <div className="live-panels">
      <EnvSeriesPanel series={envSeries} preferredZoneId={preferredZoneId} />
      {/* R15-D8: 设备能耗曲线（live 流累积；zone 名复用渲染快照的 zones）。 */}
      <EnergyPanel
        snapshot={liveSnapshot}
        zoneNames={Object.fromEntries(snapshot.zones.map(zone => [zone.id, zone.name ?? zone.id]))}
      />

      <section className="live-panel">
        <h3 className="side-panel__title">{t('agentsTitle')}</h3>
        {snapshot.agents.map(agent => (
          <AgentStatusCard key={agent.id} agent={agent} />
        ))}
      </section>

      <section className="live-panel">
        <h3 className="side-panel__title">{t('recentDecisionsTitle', { count: snapshot.recentDecisions.length })}</h3>
        {decisions.length === 0 ? (
          <EmptyState compact icon={Brain} title={t('noDecisions')} />
        ) : (
          <ul className="decision-list">
            {decisions.map((decision, index) => (
              <li key={`${decision.eventId}-${decision.agentId}-${index}`} className="decision-item">
                <span className="decision-item__time">{formatDecisionTime(decision.at)}</span>
                <span className="decision-item__agent" title={decision.agentId}>
                  {agentNameById.get(decision.agentId) ?? decision.agentId}
                </span>
                {/* 本地化决策动词（与事件流/hero line 共用 decisionLabel）。 */}
                <span className="decision-item__decision">{decisionLabel(decision.decision)}</span>
                {/* R40-A3（§7.5 升级通道）：升级标记——该决策只通知未执行， */}
                {/* 悬浮展示升级条件（模型 escalationCondition 或阈值命中 reason）。 */}
                {decision.escalated && (
                  <span
                    className="decision-item__escalated"
                    title={decision.escalationCondition ?? t('escalatedBadge')}
                  >
                    ⚠ {t('escalatedBadge')}
                  </span>
                )}
                <span className="decision-item__source" title={decision.decisionSource}>
                  {decisionSourceLabel(decision.decisionSource)}
                </span>
                {decision.eventType && (
                  <span className="decision-item__event">{decision.eventType}</span>
                )}
                {decision.situation && (
                  // R40-A6（认知六区块 → Web 通道）：情境徽章 + 不确定性，
                  // 仅结构化 LLM 决策携带；规则路径决策优雅降级为只看 reasoning。
                  <span
                    className={`decision-item__situation decision-item__situation--${decision.situation.type ?? 'anomaly'}`}
                    title={t('situationSeverity', { severity: decision.situation.severity ?? 3 })}
                  >
                    {t(`situationType_${decision.situation.type ?? 'anomaly'}`)}·{decision.situation.severity ?? 3}
                  </span>
                )}
                {decision.uncertainty && typeof decision.uncertainty.overall === 'number' && (
                  <span
                    className="decision-item__uncertainty"
                    title={t('uncertaintyTooltip', {
                      overall: Math.round(decision.uncertainty.overall * 100),
                      quality: Math.round((decision.uncertainty.dataQuality ?? 0) * 100),
                    })}
                  >
                    ?{Math.round(decision.uncertainty.overall * 100)}%
                  </span>
                )}
                {decision.reasoning && (
                  // defer/失败原因直接可见（可用性修复）：rule-only 下
                  // "缺少必需能力… Deferring" 这类理由不再只埋在服务端日志里。
                  <span className="decision-item__reasoning" title={decision.reasoning}>
                    {decision.reasoning}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="live-panel live-panel--devices">
        <button className="link-button" onClick={() => setDevicesOpen(open => !open)}>
          <Icon icon={devicesOpen ? ChevronDown : ChevronRight} size={14} /> {t('devicesTitle', { count: snapshot.devices.length })}
        </button>
        <span className="live-panel__energy-total">
          {t('totalEnergy', {
            value: formatEnergyWh(
              snapshot.devices.reduce((sum, device) => sum + (deviceEnergyWh(device.state) ?? 0), 0),
            ),
          })}
        </span>
        {devicesOpen && (
          <table className="device-table">
            <thead>
              <tr>
                <th>{t('deviceCol')}</th>
                <th>{t('typeCol')}</th>
                <th>{t('zoneCol')}</th>
                <th>{t('energyCol')}</th>
                <th>{t('stateCol')}</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.devices.map(device => (
                <tr key={device.id}>
                  <td>{device.name}</td>
                  <td>
                    {device.type} · {device.role}
                  </td>
                  <td>{device.zoneId}</td>
                  <td className="device-table__energy">
                    {formatEnergyWh(deviceEnergyWh(device.state))}
                  </td>
                  <td className="device-table__state">{fullDeviceState(device.state)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
