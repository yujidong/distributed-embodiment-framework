/**
 * Share view page (R15-B1) — what an anonymous visitor sees at
 * /share/:shareId.
 *
 * Demo-day surface: no login, no console chrome — a frozen replay of an
 * environment's observation window (decision chains, physics curves baked
 * from zone-sample events, the event log, and the world map). UX-W5 added a
 * client-side playback mode: a wall-clock-driven sim-time timeline lights up
 * log rows / decision chains step by step and flashes the current event's
 * zone on the 2D map. Data comes from the public GET /api/shares/:id; an
 * unknown/expired link renders a self-explaining note instead of a redirect
 * to login.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LineChart, ScrollText } from 'lucide-react';

import { getReplayShare } from '../api/client';
import type { ScenarioEvent } from '../api/types';
import { DecisionChainPanel } from '../components/DecisionChainPanel';
import { EnvSeriesPanel } from '../components/EnvSeriesPanel';
import { ShareReplayControls } from '../components/share/ShareReplayControls';
import { EmptyState } from '../components/ui/EmptyState';
import { WorldMap } from '../components/worldmap/WorldMap';
import {
  buildShareLogRows,
  replayEventCounts,
  replayEventsToTimeseries,
  replayRowErrorMessage,
  shareNameMaps,
} from '../lib/shareReplay';
import {
  activeReplayIndex,
  buildShareReplayTimeline,
  replayFlashZoneId,
  type ShareReplayState,
} from '../lib/shareReplayClock';
import { formatReplayEvent, type ReplayNameMaps } from '../lib/replayEvents';
import { queryKeys } from '../lib/queryClient';
import { worldModelFromScenario } from '../lib/worldModel';

const EVENT_LOG_CAP = 200;
const NO_HIGHLIGHT: ReadonlySet<string> = new Set<string>();

/** UX-W5: how far the replay playback has reached one event-log row. */
type ReplayRowMark = 'past' | 'current' | 'future';

export function ShareViewPage() {
  const { shareId } = useParams<{ shareId: string }>();
  const { t } = useTranslation('share');

  const share = useQuery({
    queryKey: queryKeys.shares.view(shareId ?? ''),
    queryFn: () => getReplayShare(shareId!),
    enabled: shareId !== undefined,
    retry: false, // 404 is final — an expired link must not look "flaky"
  });

  const scenario = share.data?.scenario;
  // UX-07: agent/flow/event name maps + noise-folded log rows (engine
  // execution receipts collapse into expandable groups). R2-FEAT-12: the
  // maps also carry zone display names — computed before the timeseries so
  // the curves panel labels zones by name, not bare id.
  const nameMaps = useMemo(() => (scenario ? shareNameMaps(scenario) : null), [scenario]);
  const timeseries = useMemo(
    () => (scenario ? replayEventsToTimeseries(scenario.events, nameMaps?.zones) : null),
    [scenario, nameMaps],
  );
  const counts = useMemo(() => replayEventCounts(scenario?.events ?? []), [scenario]);
  const model = useMemo(
    () => (scenario ? worldModelFromScenario(scenario) : null),
    [scenario],
  );
  // UX-W5: client-side replay — a sim-time timeline over the baked events,
  // driven by ShareReplayControls. null = the static, fully-lit view.
  const replayTimeline = useMemo(
    () => buildShareReplayTimeline(scenario?.events ?? []),
    [scenario],
  );
  const [replay, setReplay] = useState<ShareReplayState | null>(null);
  const activeIndex = replay !== null ? activeReplayIndex(replayTimeline, replay.positionSec) : -1;
  const loggedEvents = useMemo(
    () => {
      if (!scenario) return [];
      if (replay !== null && replayTimeline.items.length > 0) {
        // Replay mode: the 200-row cap window FOLLOWS the playback position
        // (50 behind / 150 ahead) — the static "last 200" window leaves the
        // first ~85% of a long replay with no visible current row at all
        // (ux-w5 probe). Newest-first display order preserved.
        const items = replayTimeline.items;
        const center = activeIndex < 0 ? 0 : activeIndex;
        const from = Math.max(0, Math.min(center - 50, items.length - EVENT_LOG_CAP));
        const to = Math.min(items.length, from + EVENT_LOG_CAP);
        return items.slice(from, to).map(item => item.event).reverse();
      }
      return scenario.events.slice(-EVENT_LOG_CAP).reverse();
    },
    [scenario, replay !== null, activeIndex, replayTimeline],
  );
  // UX-07: noise-folded log rows (engine execution receipts collapse into
  // expandable groups).
  const logRows = useMemo(() => buildShareLogRows(loggedEvents), [loggedEvents]);
  // H1: 事件日志 cap 200——总数超出时明示截断，而不是悄悄只给 200 条。
  const totalEvents = scenario?.events.length ?? 0;
  const logTruncated = totalEvents > EVENT_LOG_CAP;
  const timelineIndexByEventId = useMemo(() => {
    const map = new Map<string, number>();
    replayTimeline.items.forEach((item, index) => map.set(item.event.id, index));
    return map;
  }, [replayTimeline]);
  const rowMark = (event: ScenarioEvent): ReplayRowMark | undefined => {
    if (replay === null) return undefined;
    const index = timelineIndexByEventId.get(event.id);
    // Untimed events carry no replay position — keep them lit throughout.
    if (index === undefined) return 'past';
    if (index < activeIndex) return 'past';
    return index === activeIndex ? 'current' : 'future';
  };
  const currentEventId =
    activeIndex >= 0 ? replayTimeline.items[activeIndex]!.event.id : undefined;
  const flashZoneId = replay !== null ? replayFlashZoneId(replayTimeline, activeIndex) : undefined;
  const highlightZoneIds = useMemo(
    () => (flashZoneId !== undefined ? new Set([flashZoneId]) : NO_HIGHLIGHT),
    [flashZoneId],
  );

  // Keep the highlighted row visible while playback runs (no yanking while
  // the visitor drags the slider paused).
  useEffect(() => {
    if (replay?.playing !== true || currentEventId === undefined) return;
    document
      .querySelector('.share-event-log .decision-item--replay-current')
      ?.scrollIntoView({ block: 'nearest' });
  }, [currentEventId, replay?.playing]);

  if (share.isLoading) {
    return <p className="page-note">{t('loading')}</p>;
  }
  if (share.isError || !scenario) {
    return (
      <div className="page-note page-note--error">
        <h2>{t('notFoundTitle')}</h2>
        <p>{t('notFoundBody')}</p>
      </div>
    );
  }

  const view = share.data!;
  return (
    <div className="share-page">
      <header className="share-header share-world-card">
        <div className="share-header__meta">
          <h2>{view.name}</h2>
          <span className="share-header__env">{t('ofEnvironment', { env: view.envName })}</span>
        </div>
        {view.description && <p className="share-header__description">{view.description}</p>}
        <p className="share-header__exported">
          {t('exportedAt', { date: new Date(view.createdAt).toLocaleString() })}
        </p>
        <div className="share-header__chips">
          <span className="badge">{t('chips.events', { count: view.eventCount })}</span>
          <span className="badge">{t('chips.decisions', { count: counts['sim-decision'] ?? 0 })}</span>
          <span className="badge">{t('chips.samples', { count: counts['zone-sample'] ?? 0 })}</span>
          <span className="badge">{t('chips.deviceStates', { count: counts['device-state'] ?? 0 })}</span>
          <span className="badge share-header__expiry">{t('expiresAt', { date: new Date(view.expiresAt).toLocaleString() })}</span>
        </div>
        <ShareReplayControls timeline={replayTimeline} state={replay} onChange={setReplay} />
        <p className="share-header__readonly">{t('readOnlyNote')}</p>
        {/* H2: 匿名访客的引导 CTA——看完回放有下一步可去。 */}
        <p className="share-header__cta">
          <Link className="link-button" to="/login">
            {t('ctaJoin')}
          </Link>
        </p>
      </header>

      <DecisionChainPanel
        events={scenario.events}
        agents={scenario.agents}
        names={nameMaps ?? undefined}
        replaySimSec={replay?.positionSec}
      />

      {/* H1: 空 section 不再整块消失——保留标题 + 空态说明。 */}
      <section className="live-panel">
        <h3 className="side-panel__title">{t('curvesTitle')}</h3>
        {timeseries !== null && timeseries.zoneIds.length > 0 ? (
          <EnvSeriesPanel series={timeseries} />
        ) : (
          <EmptyState compact icon={LineChart} title={t('curvesEmpty')} />
        )}
      </section>

      <section className="live-panel">
        <h3 className="side-panel__title">
          {t('eventLogTitle', { count: loggedEvents.length })}
        </h3>
        {logTruncated && (
          <p className="page-note">{t('eventLogTruncated', { shown: EVENT_LOG_CAP, total: totalEvents })}</p>
        )}
        {logRows.length > 0 ? (
          <ul className="decision-list share-event-log">
            {logRows.map((row, index) =>
              row.kind === 'executions' ? (
                // UX-07: engine execution receipts collapse into one
                // expandable group instead of flooding the log.
                <li key={`exec:${index}`} className="decision-item share-event-log__group">
                  <details>
                    <summary>{t('executionsGroup', { count: row.events.length })}</summary>
                    <ul className="decision-list">
                      {row.events.map(event => (
                        <ShareLogLine
                          key={event.id}
                          event={event}
                          names={nameMaps ?? undefined}
                          mark={rowMark(event)}
                        />
                      ))}
                    </ul>
                  </details>
                </li>
              ) : (
                <ShareLogLine
                  key={row.event.id}
                  event={row.event}
                  names={nameMaps ?? undefined}
                  mark={rowMark(row.event)}
                />
              ),
            )}
          </ul>
        ) : (
          <EmptyState compact icon={ScrollText} title={t('eventLogEmpty')} />
        )}
      </section>

      {model !== null && (
        <section className="live-panel share-map-panel">
          <h3 className="side-panel__title">{t('mapTitle')}</h3>
          <WorldMap model={model} highlightZoneIds={highlightZoneIds} />
        </section>
      )}
    </div>
  );
}

/**
 * UX-07: one event-log line — an llm-error row (any baked row carrying an
 * errorMessage) expands into the provider message; plain rows render as-is.
 * UX-W5: `mark` carries the replay playback position (current row lights up,
 * future rows dim); undefined = the static view.
 */
function ShareLogLine({
  event,
  names,
  mark,
}: {
  event: ScenarioEvent;
  names?: ReplayNameMaps;
  mark?: ReplayRowMark;
}) {
  const line = formatReplayEvent(event, names);
  const errorMessage = replayRowErrorMessage(event);
  const markClass = mark !== undefined ? ` decision-item--replay-${mark}` : '';
  if (errorMessage === undefined) {
    return <li className={`decision-item${markClass}`}>{line}</li>;
  }
  return (
    <li className={`decision-item share-event-log__error${markClass}`}>
      <details>
        <summary>{line}</summary>
        <pre className="share-event-log__error-message">{errorMessage}</pre>
      </details>
    </li>
  );
}
