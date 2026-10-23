/**
 * HeroLine — the console's「正在发生」headline (R14 P0-2): one always-visible
 * line above the map answering "what is the system doing right now".
 *
 * Content precedence (lib/happeningNow.deriveHeroLine): the latest snapshot
 * decision — "谁 对 什么 做了什么（原因）" with the agent's display name, the
 * localized decision verb, the triggering event's zone and the full reasoning
 * in a title tooltip (visually clamped) — then the newest event-log entry's
 * summary, then a neutral idle placeholder. A 1s ticker keeps the relative
 * age live between snapshot polls.
 *
 * Styling mirrors LlmStatusBar (bordered panel row, 12px). Always the LIVE
 * snapshot — replay rewinds the map, not this "now" headline.
 *
 * UX-06: when `simulationId` is provided the banner polls the collaborations
 * endpoint; an initiate_ac headline then names the partner agent(s) instead
 * of the zone, and once that handshake ends (cancelled/failed/completed —
 * the engine session-store vocabulary has no separate timeout/abandoned
 * status, a handshake timeout ends as 'cancelled') the line switches to the
 * ended state instead of hanging on the in-progress verb.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import * as api from '../api/client';
import type { EngineSnapshot, RuntimeCollaborationRecord, ScenarioEvent } from '../api/types';
import { deriveHeroLine, relativeAge } from '../lib/happeningNow';
import { useVisibleInterval } from '../hooks/useVisibleInterval';
import { useAppStore } from '../store/useAppStore';

export interface HeroLineProps {
  /** Live snapshot (ground truth); null until the first poll resolves. */
  snapshot: EngineSnapshot | null;
  /** Scenario events for decision.eventId → zone resolution. */
  scenarioEvents: readonly ScenarioEvent[];
  /**
   * UX-06: when set, the banner polls the collaborations endpoint so an
   * initiate_ac headline names the partner agent and follows the handshake
   * to its terminal state. Omit = pre-UX-06 zone-only headline.
   */
  simulationId?: string | null;
  /** T-028/EA-F07 pattern: polling stops with the sim (final table stays). */
  stopped?: boolean;
}

const COLLAB_POLL_INTERVAL_MS = 3000;

export function HeroLine({ snapshot, scenarioEvents, simulationId, stopped = false }: HeroLineProps) {
  const { t } = useTranslation('heroLine');
  // The store event log is newest-first.
  const latestEvent = useAppStore(s => s.eventLog[0] ?? null);
  const triggerHints = useAppStore(s => s.triggerHints);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  // UX-06: best-effort collaborations poll (same cadence/visibility gating as
  // CollaborationsPanel). Errors are swallowed — the banner enrichment must
  // never stamp an error over the headline; the last good rows stay.
  const [collaborations, setCollaborations] = useState<RuntimeCollaborationRecord[] | undefined>(
    undefined,
  );
  const collabInFlightRef = useRef(false);
  useVisibleInterval(
    () => {
      if (!simulationId || collabInFlightRef.current) return;
      collabInFlightRef.current = true;
      void api
        .getSimulationCollaborations(simulationId)
        .then(rows => setCollaborations(rows))
        .catch(() => {
          // 404 after retention prune on a stopped sim, transient failures —
          // keep the previous rows (or none).
        })
        .finally(() => {
          collabInFlightRef.current = false;
        });
    },
    COLLAB_POLL_INTERVAL_MS,
    simulationId != null && !stopped,
  );

  const model = deriveHeroLine({ snapshot, latestEvent, scenarioEvents, triggerHints, collaborations });
  const age = relativeAge(model.at, now);
  const partner = model.partnerNames?.join(t('partnerJoin'));

  return (
    <div className={`hero-line hero-line--${model.kind}`} data-testid="hero-line">
      <span className="hero-line__label">{t('label')}</span>
      {model.kind === 'idle' ? (
        <span className="hero-line__idle">{t('idle')}</span>
      ) : model.kind === 'llm-down' ? (
        // R2-FEAT-10: deployment alert, not a decision headline — the LLM
        // provider is unreachable and decisions degrade to the rule harness.
        // The hint points at the deployment configuration instead of leaving
        // the raw provider error as the page's top line.
        <>
          <span className="hero-line__text">{t('llmDown.text')}</span>
          <span className="hero-line__reasoning">{t('llmDown.hint')}</span>
          {age !== null && (
            <span className="hero-line__age" title={model.at ?? undefined}>
              {age}
            </span>
          )}
        </>
      ) : (
        <>
          <span className="hero-line__text">
            {model.kind === 'decision'
              ? model.collabOutcome !== undefined
                ? t('decisionCollabEnded', {
                    agent: model.agentName,
                    partner: partner ?? '?',
                    outcome: t(`collabOutcome.${model.collabOutcome}`),
                  })
                : partner !== undefined
                  ? t('decisionWithPartner', {
                      agent: model.agentName,
                      partner,
                      verb: model.verb,
                    })
                  : model.zoneLabel !== undefined
                    ? t('decisionWithZone', {
                        agent: model.agentName,
                        zone: model.zoneLabel,
                        verb: model.verb,
                      })
                    : t('decisionNoZone', { agent: model.agentName, verb: model.verb })
              : model.eventSummary}
          </span>
          {model.reasoning && (
            // 单行截断（CSS clamp），title 兜底全文 —— 同事件流 reasoning 行惯例。
            <span className="hero-line__reasoning" title={model.reasoning}>
              {t('reasonSuffix', { reason: model.reasoning })}
            </span>
          )}
          {age !== null && (
            <span className="hero-line__age" title={model.at ?? undefined}>
              {age}
            </span>
          )}
        </>
      )}
    </div>
  );
}
