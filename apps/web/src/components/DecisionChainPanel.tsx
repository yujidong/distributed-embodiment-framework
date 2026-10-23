/**
 * DecisionChainPanel (Wave-4b, roadmap Wave 4「协作过程并入回放」) — the
 * 协作决策链 timeline on the replay/scenario detail page.
 *
 * Pure frontend aggregation (lib/decisionChain) over the replay scenario's
 * baked sim-decision / device-state events: one card per collaboration —
 * 发起方/接受方/状态/理由 in the header, then the chain 决策 → 握手 → 设备动作
 * as a sim-time-ordered stepper. Assessments without a handshake show up as
 * 独立处理 entries. Renders nothing when the scenario carries no sim-decision
 * events (ordinary scenarios stay unchanged).
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ScenarioAgent, ScenarioEvent } from '../api/types';
import {
  aggregateDecisionChains,
  chainDecisionLabel,
  CHAIN_STATUS_LABEL,
  type DecisionChain,
  type DecisionChainStep,
} from '../lib/decisionChain';
import { localizedReasoning } from '../lib/decisionReasoning';
import type { ReplayNameMaps } from '../lib/replayEvents';

export function DecisionChainPanel({
  events,
  agents,
  names,
  replaySimSec,
}: {
  events: readonly ScenarioEvent[];
  /** Scenario agents — used to resolve agent display names. */
  agents: readonly ScenarioAgent[];
  /**
   * UX-07: id → name maps (agents/flows/events) from the replay scenario —
   * the chain header renders the trigger event's label instead of a bare
   * collaboration UUID. Omit = pre-UX-07 rendering.
   */
  names?: ReplayNameMaps;
  /**
   * UX-W5 share-page replay: chains whose start time the playback has not
   * reached yet render dimmed, and the latest started chain gets the current
   * highlight. Undefined = the static, fully-lit rendering.
   */
  replaySimSec?: number;
}) {
  const { t } = useTranslation('decisionChain');
  const chains = useMemo(() => aggregateDecisionChains(events), [events]);
  // The replay's current chain: the last one (start-sorted) already started.
  const currentChainId =
    replaySimSec === undefined
      ? undefined
      : [...chains]
          .reverse()
          .find(
            chain =>
              chain.startSimTimeSec !== undefined && chain.startSimTimeSec <= replaySimSec,
          )?.id;
  if (chains.length === 0) return null;

  const agentName = (id: string | undefined): string =>
    id === undefined ? '?' : (agents.find(agent => agent.id === id)?.name ?? id);

  return (
    <section className="live-panel decision-chain-panel">
      <h3 className="side-panel__title">{t('panelTitle', { count: chains.length })}</h3>
      <ul className="decision-chain-list">
        {chains.map(chain => (
          <ChainCard
            key={chain.id}
            chain={chain}
            agentName={agentName}
            names={names}
            replayClass={
              replaySimSec === undefined
                ? undefined
                : chain.id === currentChainId
                  ? 'decision-chain--replay-current'
                  : chain.startSimTimeSec !== undefined && chain.startSimTimeSec <= replaySimSec
                    ? 'decision-chain--replay-past'
                    : 'decision-chain--replay-future'
            }
          />
        ))}
      </ul>
    </section>
  );
}

function ChainCard({
  chain,
  agentName,
  names,
  replayClass,
}: {
  chain: DecisionChain;
  agentName: (id: string | undefined) => string;
  names?: ReplayNameMaps;
  /** UX-W5 replay highlight class (undefined = static rendering). */
  replayClass?: string;
}) {
  const { t } = useTranslation('decisionChain');
  const responders = [...new Set(chain.responses.map(step => step.agentId).filter(Boolean))] as string[];
  const eventLabel = chain.eventId !== undefined ? names?.events?.[chain.eventId] : undefined;
  return (
    <li className={`decision-chain decision-chain--${chain.status}${replayClass !== undefined ? ` ${replayClass}` : ''}`}>
      {/* UX-07: the collaboration UUID leaves the visible header — it stays
          on the title tooltip for debugging; the trigger event's label takes
          its place. */}
      <div
        className="decision-chain__header"
        title={chain.collaborationId !== undefined ? chain.collaborationId : undefined}
      >
        <span className={`badge decision-chain__status decision-chain__status--${chain.status}`}>
          {CHAIN_STATUS_LABEL[chain.status]}
        </span>
        {chain.initiatorId !== undefined && (
          <span className="decision-chain__party">
            {t('initiatorPrefix', { name: agentName(chain.initiatorId) })}
          </span>
        )}
        {responders.length > 0 && (
          <span className="decision-chain__party">
            {t('responderPrefix', { names: responders.map(agentName).join('、') })}
          </span>
        )}
        {eventLabel !== undefined && (
          <span className="decision-chain__dim">{t('eventPrefix', { label: eventLabel })}</span>
        )}
      </div>
      <ol className="decision-chain__steps">
        {chain.assessments.map((step, index) => (
          <ChainStepRow key={`a:${index}`} step={step} agentName={agentName} stage="decision" />
        ))}
        {chain.responses.map((step, index) => (
          <ChainStepRow key={`r:${index}`} step={step} agentName={agentName} stage="handshake" />
        ))}
        {chain.actions.map((action, index) => (
          <li key={`d:${index}`} className="decision-chain__step">
            <span className="decision-chain__stage">{t('stageAction')}</span>
            <span>
              {timeLabel(action.atSimTimeSec)}
              {t('deviceAction', { deviceId: action.deviceId })}
              {action.service !== undefined && (
                <span className="decision-chain__dim">
                  {t('serviceSuffix', { service: action.service })}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </li>
  );
}

function ChainStepRow({
  step,
  agentName,
  stage,
}: {
  step: DecisionChainStep;
  agentName: (id: string | undefined) => string;
  stage: 'decision' | 'handshake';
}) {
  const { t } = useTranslation('decisionChain');
  const stageLabel = stage === 'decision' ? t('stageDecision') : t('stageHandshake');
  const body = (
    <span>
      {timeLabel(step.atSimTimeSec)}
      {agentName(step.agentId)}：{chainDecisionLabel(step.decision)}
      {step.decisionSource !== undefined && (
        <span className="decision-chain__dim">
          {t('sourceSuffix', { source: step.decisionSource })}
        </span>
      )}
      {localizedReasoning(step) !== undefined && (
        <span className="decision-chain__dim"> — {localizedReasoning(step)}</span>
      )}
    </span>
  );
  return (
    <li className="decision-chain__step">
      <span className="decision-chain__stage">{stageLabel}</span>
      {step.errorMessage !== undefined ? (
        // UX-07: an llm-error step drills down into the provider message.
        <details className="decision-chain__error">
          <summary>{body}</summary>
          <pre className="decision-chain__error-message">{step.errorMessage}</pre>
        </details>
      ) : (
        body
      )}
    </li>
  );
}

function timeLabel(atSimTimeSec: number | undefined): string {
  return atSimTimeSec !== undefined ? `t=${atSimTimeSec}s ` : '';
}
