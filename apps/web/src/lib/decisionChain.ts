/**
 * Collaboration decision-chain aggregation (Wave-4b, roadmap Wave 4
 * 「协作过程并入回放」) — folds the replay scenario's baked sim-timeline
 * events (Fix-14, see apps/server/src/replay-service.ts) into per-
 * collaboration chains for the 决策链时间轴 panel:
 *
 *   事件 → 决策（initiate_ac / handle_independently / …）→
 *   握手（accept / reject / counter / defer / cancelled）→ 设备动作
 *
 * Inputs (all defensive — details payloads are informational only):
 * - `sim-decision` assessments: details { agentId, eventId, decision,
 *   decisionSource, reasoning } (kind absent or 'assessment');
 * - `sim-decision` handshake records: kind 'collaboration-response' with
 *   details { collaborationId, agentId, decision ∈ accept|reject|counter|
 *   defer|cancelled, decisionSource, reasoning } (Wave-4a added
 *   counter/defer);
 * - `device-state` records: details { deviceId, service }.
 *
 * Grouping: handshake records aggregate by `collaborationId`; assessments
 * join the handshake chain of the same `eventId` (the assessment whose
 * decision is `initiate_ac` names the 发起方). Assessments with no matching
 * handshake form standalone "独立处理" chains keyed by eventId.
 *
 * Device actions carry no collaboration/event linkage in the baked record,
 * so attribution is time-based: a device-state event belongs to the chain
 * whose [start, next chain's start) sim-time window contains it. That is
 * deterministic and covers every action exactly once; actions before the
 * first chain (or without timestamps) stay in the raw event list only.
 */

import type { ScenarioEvent } from '../api/types';
import i18n from '../i18n/config';
import { asRecord, str } from './eventLog';

export interface DecisionChainStep {
  atSimTimeSec?: number;
  agentId?: string;
  /** Raw decision string (initiate_ac / handle_independently / accept / …). */
  decision: string;
  decisionSource?: string;
  reasoning?: string;
  /** R15-D3: structured reasoning twin — panels localize from code+params. */
  reasoningCode?: string;
  reasoningParams?: Record<string, string | number>;
  /**
   * UX-07: the error behind an 'llm-failure' step (or a fallback handshake
   * answer) — the panel renders it as the step's drill-down.
   */
  errorMessage?: string;
}

export interface DecisionChainAction {
  atSimTimeSec?: number;
  deviceId: string;
  service?: string;
}

export type DecisionChainStatus =
  | 'accepted'
  | 'rejected'
  | 'countered'
  | 'deferred'
  | 'cancelled'
  | 'pending'
  | 'independent';

export interface DecisionChain {
  /** collaborationId for handshake chains, otherwise an eventId-derived key. */
  id: string;
  collaborationId?: string;
  eventId?: string;
  /** Agent whose assessment decided initiate_ac (undefined when unknown). */
  initiatorId?: string;
  /** 决策 stage: assessments, chronological. */
  assessments: DecisionChainStep[];
  /** 握手 stage: collaboration responses, chronological. */
  responses: DecisionChainStep[];
  /** 设备动作 stage: device-state records attributed by sim-time window. */
  actions: DecisionChainAction[];
  status: DecisionChainStatus;
  /** First known sim time of the chain (undefined when no step is timed). */
  startSimTimeSec?: number;
}

/** Known decision keys (Wave-4a counter/defer included). */
export const CHAIN_DECISION_KEYS = [
  'initiate_ac',
  'handle_independently',
  'accept',
  'reject',
  'counter',
  'defer',
  'cancelled',
] as const;

/** Display label for a decision in the active locale. */
export function chainDecisionLabel(decision: string): string {
  return i18n.t(`decisionChain:decision.${decision}`, { defaultValue: decision });
}

/**
 * Backward-compatible indexable record. Each property access forwards to
 * `chainDecisionLabel` so consumers using `CHAIN_DECISION_LABEL[decision]` see
 * live translations after a language change.
 */
export const CHAIN_DECISION_LABEL: Record<string, string> = new Proxy(
  {} as Record<string, string>,
  {
    get(_target, prop: string | symbol): string {
      if (typeof prop === 'string') {
        return chainDecisionLabel(prop);
      }
      return undefined as unknown as string;
    },
  },
);

export const CHAIN_STATUS_KEYS: readonly DecisionChainStatus[] = [
  'accepted',
  'rejected',
  'countered',
  'deferred',
  'cancelled',
  'pending',
  'independent',
];

/** Display label for a chain status in the active locale. */
export function chainStatusLabel(status: DecisionChainStatus): string {
  return i18n.t(`decisionChain:status.${status}`);
}

export const CHAIN_STATUS_LABEL: Record<DecisionChainStatus, string> = new Proxy(
  {} as Record<DecisionChainStatus, string>,
  {
    get(_target, prop: string | symbol): string {
      if (
        typeof prop === 'string' &&
        (CHAIN_STATUS_KEYS as readonly string[]).includes(prop)
      ) {
        return chainStatusLabel(prop as DecisionChainStatus);
      }
      return undefined as unknown as string;
    },
  },
);

/** Fold replay scenario events into collaboration decision chains. */
export function aggregateDecisionChains(events: readonly ScenarioEvent[]): DecisionChain[] {
  const chains = new Map<string, DecisionChain>();
  const actions: DecisionChainAction[] = [];

  const chainFor = (key: string): DecisionChain => {
    let chain = chains.get(key);
    if (!chain) {
      chain = { id: key, assessments: [], responses: [], actions: [], status: 'pending' };
      chains.set(key, chain);
    }
    return chain;
  };

  // Pass 1: handshake chains keyed by collaborationId (fallback: eventId).
  for (const event of events) {
    if (event.type !== 'sim-decision') continue;
    const details = asRecord(event.details);
    if (str(details.kind) !== 'collaboration-response') continue;
    const collaborationId = str(details.collaborationId);
    const eventId = str(details.eventId);
    const key = collaborationId ?? `event:${eventId ?? event.id}`;
    const chain = chainFor(key);
    if (collaborationId !== undefined) chain.collaborationId = collaborationId;
    chain.eventId ??= eventId;
    chain.responses.push(stepFrom(details, event));
  }

  // Pass 2: assessments join the handshake chain of their eventId when
  // exactly one such chain exists; otherwise they form standalone chains.
  // UX-07: 'device-execution' receipts are NOT assessments — they used to
  // flood the panel as standalone "executed (engine)" chains (or pollute a
  // joined chain's 决策 stage); the device-action stage already covers the
  // execution outcome, so they stay in the raw event log only.
  const chainIdByEventId = new Map<string, string[]>();
  for (const chain of chains.values()) {
    if (chain.eventId === undefined) continue;
    const list = chainIdByEventId.get(chain.eventId) ?? [];
    list.push(chain.id);
    chainIdByEventId.set(chain.eventId, list);
  }
  for (const event of events) {
    if (event.type !== 'sim-decision') continue;
    const details = asRecord(event.details);
    const kind = str(details.kind);
    if (kind === 'collaboration-response' || kind === 'device-execution') continue;
    const eventId = str(details.eventId);
    const siblings = eventId !== undefined ? chainIdByEventId.get(eventId) : undefined;
    const key = siblings?.length === 1 ? siblings[0]! : `event:${eventId ?? event.id}`;
    const chain = chainFor(key);
    chain.eventId ??= eventId;
    const step = stepFrom(details, event);
    chain.assessments.push(step);
    if (step.decision === 'initiate_ac' && chain.initiatorId === undefined) {
      chain.initiatorId = step.agentId;
    }
  }

  // Pass 3: device-state events, attributed by sim-time window below.
  for (const event of events) {
    if (event.type !== 'device-state') continue;
    const details = asRecord(event.details);
    const deviceId = str(details.deviceId);
    if (deviceId === undefined) continue;
    actions.push({
      ...(event.atSimTimeSec !== undefined ? { atSimTimeSec: event.atSimTimeSec } : {}),
      deviceId,
      ...(str(details.service) !== undefined ? { service: str(details.service) } : {}),
    });
  }

  // Finalize: sort steps, derive status + start time, attribute actions.
  const result = [...chains.values()];
  for (const chain of result) {
    chain.assessments.sort(compareSteps);
    chain.responses.sort(compareSteps);
    chain.status = chainStatus(chain);
    const times = [...chain.assessments, ...chain.responses]
      .map(step => step.atSimTimeSec)
      .filter((t): t is number => t !== undefined);
    if (times.length > 0) chain.startSimTimeSec = Math.min(...times);
  }
  result.sort((a, b) => (a.startSimTimeSec ?? Infinity) - (b.startSimTimeSec ?? Infinity));

  for (const action of actions) {
    if (action.atSimTimeSec === undefined) continue;
    // result is start-sorted: the LAST chain whose start <= action time owns it
    // (its window runs until the next chain's start).
    const attributed = [...result]
      .reverse()
      .find(
        chain =>
          chain.startSimTimeSec !== undefined && action.atSimTimeSec! >= chain.startSimTimeSec,
      );
    attributed?.actions.push(action);
  }

  return result;
}

/** Chains that involve an actual handshake (the panel's primary content). */
export function isHandshakeChain(chain: DecisionChain): boolean {
  return chain.collaborationId !== undefined || chain.responses.length > 0;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function stepFrom(details: Record<string, unknown>, event: ScenarioEvent): DecisionChainStep {
  return {
    ...(event.atSimTimeSec !== undefined ? { atSimTimeSec: event.atSimTimeSec } : {}),
    ...(str(details.agentId) !== undefined ? { agentId: str(details.agentId) } : {}),
    decision: str(details.decision) ?? '?',
    ...(str(details.decisionSource) !== undefined
      ? { decisionSource: str(details.decisionSource) }
      : {}),
    ...(str(details.reasoning) !== undefined ? { reasoning: str(details.reasoning) } : {}),
    // UX-07: llm-failure / fallback error message rides the step.
    ...(str(details.errorMessage) !== undefined ? { errorMessage: str(details.errorMessage) } : {}),
    // R15-D3: structured reasoning twin (baked by replay-service).
    ...(str(details.reasoningCode) !== undefined
      ? { reasoningCode: str(details.reasoningCode) }
      : {}),
    ...(details.reasoningParams !== undefined &&
        typeof details.reasoningParams === 'object' &&
        !Array.isArray(details.reasoningParams)
      ? { reasoningParams: details.reasoningParams as Record<string, string | number> }
      : {}),
  };
}

function compareSteps(a: DecisionChainStep, b: DecisionChainStep): number {
  return (a.atSimTimeSec ?? Infinity) - (b.atSimTimeSec ?? Infinity);
}

/**
 * Outcome of the handshake: any accept wins (partial acceptance still lets
 * the collaboration run); otherwise the most informative pending answer —
 * counter (Wave-4a: initiator re-evaluates, one round) beats defer, defer
 * beats reject. No responses at all → still 待响应.
 */
function chainStatus(chain: DecisionChain): DecisionChainStatus {
  if (!isHandshakeChain(chain)) return 'independent';
  const decisions = new Set(chain.responses.map(step => step.decision));
  if (decisions.has('accept')) return 'accepted';
  if (decisions.has('counter')) return 'countered';
  if (decisions.has('defer')) return 'deferred';
  if (decisions.has('reject')) return 'rejected';
  if (decisions.has('cancelled')) return 'cancelled';
  return 'pending';
}
