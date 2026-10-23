/**
 * EventLogPanel — scrolling live event feed (newest first, capped by the
 * store at EVENT_LOG_CAP), with family filter chips. Every row is rendered
 * from the defensive `eventLog.ts` formatter, so unknown payload shapes show
 * a truncated JSON summary instead of breaking the panel.
 *
 * W7: the panel lives in the console's bottom drawer and also receives the
 * snapshot's decision records — they merge into the same newest-first list
 * under the Agent family (a decision is an agent event for filtering).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollText } from 'lucide-react';

import type { RuntimeDecisionRecord } from '../api/types';
import { localizedReasoning } from '../lib/decisionReasoning';
import { EVENT_FAMILIES, FAMILY_LABELS, type EventFamily } from '../lib/eventLog';
import { decisionLabel } from '../lib/happeningNow';
import { localClockTime } from '../lib/clockTime';
import { useAppStore } from '../store/useAppStore';
import { EmptyState } from './ui/EmptyState';

type FamilyFilter = EventFamily | 'all';

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  // G4: 跟随 i18n 语言（原硬编码 'zh-CN'）。
  return localClockTime(iso);
}

interface DecisionRow {
  key: string;
  at: string;
  agentId: string;
  decision: string;
  decisionSource: string;
  reasoning?: string;
}

export interface EventLogPanelProps {
  /** Snapshot decision records, merged into the feed (W7 bottom drawer). */
  decisions?: readonly RuntimeDecisionRecord[];
}

export function EventLogPanel({ decisions = [] }: EventLogPanelProps) {
  const eventLog = useAppStore(s => s.eventLog);
  const [filter, setFilter] = useState<FamilyFilter>('all');
  const { t } = useTranslation('eventLogPanel');

  const visibleEvents = filter === 'all' ? eventLog : eventLog.filter(e => e.family === filter);
  const showDecisions = filter === 'all' || filter === 'agent';
  const decisionRows: DecisionRow[] = showDecisions
    ? decisions.map((decision, index) => ({
        key: `decision-${decision.eventId}-${decision.agentId}-${index}`,
        at: decision.at,
        agentId: decision.agentId,
        decision: decision.decision,
        decisionSource: decision.decisionSource,
        // R15-D3: localize rule reasoning from its structured code.
        ...(localizedReasoning(decision) !== undefined
          ? { reasoning: localizedReasoning(decision) }
          : {}),
      }))
    : [];

  // Merge events + decisions into one newest-first list (parse failures
  // sort oldest — defensive against non-ISO payloads).
  const merged = [
    ...visibleEvents.map(entry => ({
      kind: 'event' as const,
      at: Date.parse(entry.at) || 0,
      entry,
    })),
    ...decisionRows.map(row => ({ kind: 'decision' as const, at: Date.parse(row.at) || 0, row })),
  ].sort((a, b) => b.at - a.at);

  return (
    <section className="live-panel event-log-panel">
      <h3 className="side-panel__title">{t('title', { count: merged.length })}</h3>
      <div className="chip-row event-log-panel__filters">
        <button
          className={`chip chip--button${filter === 'all' ? ' chip--active' : ''}`}
          onClick={() => setFilter('all')}
        >
          {t('filterAll')}
        </button>
        {EVENT_FAMILIES.map(family => (
          <button
            key={family}
            className={`chip chip--button${filter === family ? ' chip--active' : ''}`}
            onClick={() => setFilter(family)}
          >
            {FAMILY_LABELS[family]}
          </button>
        ))}
      </div>
      {merged.length === 0 ? (
        <EmptyState compact icon={ScrollText} title={t('empty')} />
      ) : (
        <ul className="event-log">
          {merged.map(item =>
            item.kind === 'event' ? (
              <li key={`${item.entry.id}-${item.entry.at}`} className="event-log__item">
                <span className="event-log__time">{formatEventTime(item.entry.at)}</span>
                <span className={`event-dot event-dot--${item.entry.family}`} title={item.entry.type} />
                <span className="event-log__summary">{item.entry.summary}</span>
              </li>
            ) : (
              <li key={item.row.key} className="event-log__item">
                <span className="event-log__time">{formatEventTime(item.row.at)}</span>
                <span className={`event-dot event-dot--agent event-dot--decision-${item.row.decision}`} title={t('decisionTooltip')} />
                <span className="event-log__summary">
                  <span className={`event-log__decision event-log__decision--${item.row.decision}`}>
                    {decisionLabel(item.row.decision)}
                  </span>
                  <span className="event-log__agent">{item.row.agentId}</span>
                  <span className="event-log__decision-source">{t('decisionSourceSuffix', { source: item.row.decisionSource })}</span>
                  {item.row.reasoning && (
                    <span className="event-log__reasoning" title={item.row.reasoning}>
                      {item.row.reasoning}
                    </span>
                  )}
                </span>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
