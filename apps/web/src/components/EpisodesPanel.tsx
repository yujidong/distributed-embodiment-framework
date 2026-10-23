/**
 * EpisodesPanel (W8) — the narrative timeline of the simulation, shown in
 * the bottom drawer (the raw event log stays one tab away as「原始事件」).
 *
 * One row per episode, newest on top: status icon, time, trigger
 * summary, participant agent chips and the outcome one-liner (`感知员发起 →
 * 家电管家+气候管家 → 油烟机✓ 空调✓；烟雾 0.75→0.12`). Rows expand inline
 * into a vertical stepper: 触发 → 各 Agent 决策（decisionSource 标记
 * precheck/LLM）→ 协作生命周期 → 设备动作 → 结局.
 *
 * Reasoning: LLM decisions carry a「推理」expander that lazily fetches
 * `/api/simulations/:id/trajectory?eventId=…&agentId=…` (module-level cache
 * per sim+event+agent) and shows the raw model response plus token/latency
 * meta; an empty result means the decision took the rule path (precheck).
 *
 * Everything derives from buffered data (event log + replay ring buffer +
 * trigger hints), so pausing changes nothing; while replaying, the episode
 * whose [startAt, lastAt] contains the cursor is highlighted and scrolled
 * into view.
 *
 * The aggregation itself is NOT done here: the caller passes precomputed
 * `episodes` from `useSimulationEpisodes` (R14 P1-3), so the drawer-header
 * counter and these rows always share one derivation — injected scenario
 * events never echo on the bus, making any raw-event count contradict the
 * decision-driven timeline.
 *
 * All user-facing copy lives in the `episodes` i18n namespace (zh-CN source
 * of truth, en-US translation).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheckBig,
  CircleDot,
  CircleX,
  LoaderCircle,
  X,
  type LucideIcon,
} from 'lucide-react';

import * as api from '../api/client';
import type { TrajectoryRecordDto } from '../api/types';
import {
  episodeAgents,
  episodeIdAtTime,
  filterEpisodes,
  formatTrigger,
  ownedAgentIds,
  type Episode,
  type EpisodeDecision,
  type EpisodeNames,
  type EpisodeOutcomeStatus,
} from '../lib/episodes';
import { replayCursorTime } from '../lib/replay';
import { localClockTime } from '../lib/clockTime';
import { summaryView } from '../lib/reputation';
import type { WorldModel } from '../lib/worldModel';
import { useAppStore } from '../store/useAppStore';
import { ReputationChip } from './ReputationChip';
import { Icon } from './ui/Icon';

const STATUS_ICONS: Record<EpisodeOutcomeStatus, LucideIcon> = {
  success: CircleCheckBig,
  partial: CircleDot,
  failed: CircleX,
  ongoing: LoaderCircle,
};

const OUTCOME_FILTER_ORDER: readonly EpisodeOutcomeStatus[] = [
  'success',
  'partial',
  'failed',
  'ongoing',
];

export interface EpisodesPanelProps {
  /** World model of the console (names + agent ownership for filters). */
  model: WorldModel | null;
  /**
   * Precomputed episodes (useSimulationEpisodes) — shared with the drawer
   * header so the count and the rows never diverge.
   */
  episodes: Episode[];
  /** 'present': 演示模式放大变体（字号/间距放大，隐藏过滤 chips）。 */
  variant?: 'default' | 'present';
}

export function EpisodesPanel({ model, episodes, variant = 'default' }: EpisodesPanelProps) {
  const { t } = useTranslation('episodes');
  const simulationId = useAppStore(s => s.simulationId);
  const replayBuffer = useAppStore(s => s.replayBuffer);
  const replayTimes = useAppStore(s => s.replayTimes);
  const replayActive = useAppStore(s => s.replayActive);
  const replayCursor = useAppStore(s => s.replayCursor);
  const snapshot = useAppStore(s => s.snapshot);
  const user = useAppStore(s => s.user);

  // Status label lookup keyed by the runtime outcome status.
  const statusLabel = (status: EpisodeOutcomeStatus): string => t(`status.${status}`);

  const names = useMemo<EpisodeNames>(() => ({
    agentName: id =>
      model?.agents.find(a => a.id === id)?.name ??
      snapshot?.agents.find(a => a.id === id)?.name,
    deviceName: id =>
      model?.devices.find(d => d.id === id)?.name ??
      snapshot?.devices.find(d => d.id === id)?.name,
    zoneName: id =>
      model?.zones.find(z => z.id === id)?.name ??
      snapshot?.zones.find(z => z.id === id)?.name,
  }), [model, snapshot]);

  // Pause-safe: `episodes` arrives precomputed from the FULL buffers (never
  // the replay-cursor snapshot) — the cursor only highlights.

  // -------------------------------------------------------------------------
  // Filters
  // -------------------------------------------------------------------------
  const [agentFilter, setAgentFilter] = useState<ReadonlySet<string>>(new Set());
  const [zoneFilter, setZoneFilter] = useState<ReadonlySet<string>>(new Set());
  const [outcomeFilter, setOutcomeFilter] = useState<ReadonlySet<EpisodeOutcomeStatus>>(new Set());
  const [onlyMine, setOnlyMine] = useState(false);
  // R12-5c-B: agent/zone chips collapse behind one toggle — in large worlds
  // (100+ zones) the chip row otherwise pushes the timeline off-screen.
  const [filtersOpen, setFiltersOpen] = useState(false);

  const myAgentIds = useMemo(
    () => ownedAgentIds(model?.agents ?? [], user?.id),
    [model, user],
  );
  const effectiveAgentFilter = useMemo<ReadonlySet<string>>(
    () => (onlyMine ? new Set(myAgentIds) : agentFilter),
    [onlyMine, myAgentIds, agentFilter],
  );
  const visible = useMemo(
    () =>
      filterEpisodes(episodes, {
        agentIds: effectiveAgentFilter,
        zoneIds: zoneFilter,
        outcomes: outcomeFilter,
      }),
    [episodes, effectiveAgentFilter, zoneFilter, outcomeFilter],
  );

  const toggleIn = <T,>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  // -------------------------------------------------------------------------
  // Replay cursor highlight (+ auto-scroll)
  // -------------------------------------------------------------------------
  const cursorMs = replayCursorTime({ snapshot, replayBuffer, replayTimes, replayActive, replayCursor });
  const highlightId = useMemo(() => episodeIdAtTime(episodes, cursorMs), [episodes, cursorMs]);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    if (!highlightId || !replayActive) return;
    rowRefs.current.get(highlightId)?.scrollIntoView({ block: 'nearest' });
  }, [highlightId, replayActive]);

  const [expandedId, setExpandedId] = useState<string | null>(null);

  const zones = model?.zones ?? [];
  const agents = model?.agents ?? [];

  return (
    <section className={`episodes-panel${variant === 'present' ? ' episodes-panel--present' : ''}`}>
      {variant !== 'present' && (
      <>
      <div className="chip-row episodes-panel__filters">
        {user && myAgentIds.length > 0 && (
          <button
            className={`chip chip--button${onlyMine ? ' chip--active' : ''}`}
            title={t('filters.onlyMineTitle')}
            onClick={() => setOnlyMine(v => !v)}
          >
            {t('filters.onlyMine')}
          </button>
        )}
        <button
          className={`chip chip--button episodes-panel__filters-toggle${filtersOpen ? ' chip--active' : ''}`}
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(v => !v)}
        >
          {t('filters.toggle', { agents: agents.length, zones: zones.length })}
          <Icon icon={filtersOpen ? ChevronDown : ChevronRight} size={13} />
        </button>
        {agentFilter.size + zoneFilter.size > 0 && (
          <button
            className="chip chip--button chip--active"
            title={t('filters.clearTitle')}
            onClick={() => {
              setAgentFilter(new Set());
              setZoneFilter(new Set());
            }}
          >
            {t('filters.activeCount', { count: agentFilter.size + zoneFilter.size })}
            <Icon icon={X} size={13} />
          </button>
        )}
        {OUTCOME_FILTER_ORDER.map(status => (
          <button
            key={status}
            className={`chip chip--button${outcomeFilter.has(status) ? ' chip--active' : ''}`}
            title={t('filters.byOutcomeTitle', { label: statusLabel(status) })}
            onClick={() => setOutcomeFilter(current => toggleIn(current, status))}
          >
            <Icon icon={STATUS_ICONS[status]} size={13} /> {statusLabel(status)}
          </button>
        ))}
      </div>
      {filtersOpen && (
        <div className="chip-row episodes-panel__filters-detail">
          {agents.map(agent => (
            <button
              key={agent.id}
              className={`chip chip--button${effectiveAgentFilter.has(agent.id) ? ' chip--active' : ''}`}
              title={t('filters.byAgentTitle', { name: agent.name })}
              onClick={() => {
                setOnlyMine(false);
                setAgentFilter(current => toggleIn(current, agent.id));
              }}
            >
              {agent.name}
            </button>
          ))}
          {zones.map(zone => (
            <button
              key={zone.id}
              className={`chip chip--button${zoneFilter.has(zone.id) ? ' chip--active' : ''}`}
              title={t('filters.byZoneTitle', { name: zone.name ?? zone.id })}
              onClick={() => setZoneFilter(current => toggleIn(current, zone.id))}
            >
              {zone.name ?? zone.id}
            </button>
          ))}
        </div>
      )}
      </>
      )}
      {visible.length === 0 ? (
        <p className="page-note">
          {episodes.length === 0
            ? t('empty.noEpisodes')
            : t('empty.noMatch')}
        </p>
      ) : (
        <ul className="episode-list">
          {visible.map(episode => (
            <li
              key={episode.id}
              ref={el => {
                if (el) rowRefs.current.set(episode.id, el);
                else rowRefs.current.delete(episode.id);
              }}
              className={`episode-row episode-row--${episode.outcome.status}${
                episode.id === highlightId && replayActive ? ' episode-row--cursor' : ''
              }`}
            >
              <button
                className="episode-row__main"
                onClick={() => setExpandedId(current => (current === episode.id ? null : episode.id))}
              >
                <span className={`episode-row__status episode-row__status--${episode.outcome.status}`}>
                  <Icon icon={STATUS_ICONS[episode.outcome.status]} size={13} label={statusLabel(episode.outcome.status)} />
                </span>
                <span className="episode-row__time">{formatTime(episode.startAt)}</span>
                <span className="episode-row__trigger">{formatTrigger(episode.trigger, names)}</span>
                <span className="episode-row__agents">
                  {episodeAgents(episode).map(id => (
                    <span key={id} className="episode-agent-chip">
                      {names.agentName?.(id) ?? id}
                    </span>
                  ))}
                </span>
                <span className="episode-row__summary" title={episode.outcome.summary}>{episode.outcome.summary}</span>
              </button>
              {expandedId === episode.id && (
                <EpisodeDetail episode={episode} names={names} simulationId={simulationId} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Detail stepper
// ---------------------------------------------------------------------------

function EpisodeDetail({
  episode,
  names,
  simulationId,
}: {
  episode: Episode;
  names: EpisodeNames;
  simulationId: string | null;
}) {
  const { t } = useTranslation('episodes');
  const snapshot = useAppStore(s => s.snapshot);
  const agentName = (id: string) => names.agentName?.(id) ?? id;
  const deviceName = (id: string) => names.deviceName?.(id) ?? id;
  const collaboration = episode.collaboration;
  const statusLabel = (status: EpisodeOutcomeStatus): string => t(`status.${status}`);
  const collabStateLabel = (state: string): string =>
    // Unknown states (outside the fixed collabState dictionary) fall back to raw.
    t(`collabState.${state}`, { defaultValue: state });
  return (
    <ol className="episode-steps">
      <li className="episode-steps__item">
        <span className="episode-steps__label">{t('steps.trigger')}</span>
        <span>
          {formatTrigger(episode.trigger, names)}
          {episode.trigger.eventId && (
            <span className="episode-steps__dim">（{episode.trigger.eventId}）</span>
          )}
          {episode.trigger.atSimTimeSec !== undefined && (
            <span className="episode-steps__dim"> t={episode.trigger.atSimTimeSec}s</span>
          )}
        </span>
      </li>
      {episode.decisions.length > 0 && (
        <li className="episode-steps__item">
          <span className="episode-steps__label">{t('steps.decision')}</span>
          <span>
            {episode.decisions.map(decision => (
              <span key={`${decision.agentId}:${decision.at}`} className="episode-decision">
                {agentName(decision.agentId)}: {decision.decision}
                <span className="episode-steps__dim">（{decision.decisionSource}）</span>
                {simulationId && episode.trigger.eventId && (
                  <ReasoningExpander
                    simulationId={simulationId}
                    eventId={episode.trigger.eventId}
                    decision={decision}
                  />
                )}
              </span>
            ))}
          </span>
        </li>
      )}
      {collaboration && (
        <li className="episode-steps__item">
          <span className="episode-steps__label">{t('steps.collaboration')}</span>
          <span>
            {collabStateLabel(collaboration.state)}
            {collaboration.participants.length > 0 &&
              ` · ${collaboration.participants.map(agentName).join(' + ')}`}
            {/* P4-1: per-participant learned reputation (snapshot summary). */}
            {collaboration.participants.map(participantId => {
              const summary = snapshot?.agents.find(a => a.id === participantId)?.reputation;
              if (!summary) return null;
              return (
                <ReputationChip
                  key={participantId}
                  reputation={summaryView(summary)}
                />
              );
            })}
            {collaboration.description && (
              <span className="episode-steps__dim"> · {collaboration.description}</span>
            )}
          </span>
        </li>
      )}
      {episode.actions.length > 0 && (
        <li className="episode-steps__item">
          <span className="episode-steps__label">{t('steps.action')}</span>
          <span>
            {episode.actions.map((action, index) => (
              <span key={`${action.deviceId}:${action.at ?? index}`} className="episode-action">
                {deviceName(action.deviceId)} {action.commandName}{' '}
                <Icon
                  icon={action.success ? Check : X}
                  size={13}
                  label={action.success ? t('action.success') : t('action.failed')}
                />
                {action.agentId && (
                  <span className="episode-steps__dim">（{agentName(action.agentId)}）</span>
                )}
              </span>
            ))}
          </span>
        </li>
      )}
      <li className="episode-steps__item">
        <span className="episode-steps__label">{t('steps.outcome')}</span>
        <span>
          <span className={`episode-row__status episode-row__status--${episode.outcome.status}`}>
            <Icon icon={STATUS_ICONS[episode.outcome.status]} size={13} />
          </span>{' '}
          {statusLabel(episode.outcome.status)} · {episode.outcome.summary}
        </span>
      </li>
    </ol>
  );
}

// ---------------------------------------------------------------------------
// LLM reasoning expander (lazy trajectory fetch, cached per sim+event+agent)
// ---------------------------------------------------------------------------

const trajectoryCache = new Map<string, Promise<TrajectoryRecordDto[]>>();

/**
 * T-028/EA-F06: FIFO cap. Each successful entry holds the FULL parsed
 * transcript array (system+user prompt, rawResponse) for the page lifetime
 * across ALL simulations — every other long-lived buffer in the app is
 * capped (EVENT_LOG_CAP 300, TRIGGER_HINT_CAP 200, REPLAY_BUFFER_CAP 500,
 * TIMESERIES_CAP 500); this map now is too.
 */
const TRAJECTORY_CACHE_CAP = 40;

/**
 * Fetch-and-cache seam (exported for the T-028/EA-F06 cap test — the panel
 * itself only triggers it through the 推理 expander).
 */
export function loadTrajectory(
  simulationId: string,
  eventId: string,
  agentId: string,
): Promise<TrajectoryRecordDto[]> {
  const key = `${simulationId}|${eventId}|${agentId}`;
  let cached = trajectoryCache.get(key);
  if (!cached) {
    cached = api.getTrajectory(simulationId, { eventId, agentId }).catch(error => {
      // Failures are not cached forever — a retry should be possible.
      trajectoryCache.delete(key);
      throw error;
    });
    trajectoryCache.set(key, cached);
    if (trajectoryCache.size > TRAJECTORY_CACHE_CAP) {
      // Map iterates in insertion order — the first key is the oldest entry.
      const oldest = trajectoryCache.keys().next().value;
      if (oldest !== undefined && oldest !== key) trajectoryCache.delete(oldest);
    }
  }
  return cached;
}

function ReasoningExpander({
  simulationId,
  eventId,
  decision,
}: {
  simulationId: string;
  eventId: string;
  decision: EpisodeDecision;
}) {
  const { t } = useTranslation('episodes');
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<TrajectoryRecordDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || records !== null) return;
    loadTrajectory(simulationId, eventId, decision.agentId)
      .then(result => {
        if (mountedRef.current) setRecords(result);
      })
      .catch(err => {
        if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
      });
  };

  const reasoning = records?.filter(r => r.rawResponse) ?? [];

  return (
    <span className="episode-reasoning">
      <button className="link-button episode-reasoning__toggle" onClick={toggle}>
        {t('reasoning.toggle')} <Icon icon={open ? ChevronDown : ChevronRight} size={13} />
      </button>
      {open && (
        <span className="episode-reasoning__body">
          {error && <span className="page-note--error">{t('reasoning.loadFailed', { error })}</span>}
          {!error && records === null && <span className="episode-steps__dim">{t('reasoning.loading')}</span>}
          {!error && records !== null && reasoning.length === 0 && (
            <span className="episode-steps__dim">{t('reasoning.rulePath')}</span>
          )}
          {reasoning.map((record, index) => (
            <span key={index} className="episode-reasoning__record">
              <span className="episode-reasoning__meta">
                {[
                  record.model,
                  record.promptTokens !== undefined
                    ? `tokens ${record.promptTokens}${record.completionTokens !== undefined ? `+${record.completionTokens}` : ''}`
                    : undefined,
                  record.durationMs !== undefined ? `${Math.round(record.durationMs)}ms` : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <span className="episode-reasoning__text">{record.rawResponse}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  // G4: 跟随 i18n 语言（原硬编码 'zh-CN'）。
  return localClockTime(iso);
}
