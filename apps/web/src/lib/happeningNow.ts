/**
 * Hero line (R14 P0-2) — the "happening now" headline derivation for the sim
 * console: the latest agent decision with its reasoning, falling back to the
 * newest stream event, then to a neutral idle placeholder.
 *
 * Precedence (per the R14 plan): the snapshot's `recentDecisions` ring buffer
 * (newest last) wins whenever it is non-empty — decisions are what the user
 * cannot see otherwise; the newest event-log entry is the fallback; with
 * neither, the caller renders the idle placeholder.
 *
 * R2-FEAT-10: an LLM-down degraded decision (decisionSource 'rule-llm-down')
 * classifies as the 'llm-down' kind instead of a decision headline — the
 * provider error is a deployment-environment signal, and the banner renders
 * the「LLM 离线」alert with a configuration hint rather than parroting the
 * raw 404 text as if an agent had decided something.
 *
 * Pure and i18n-aware: strings are read from the global i18next instance at
 * call time (same convention as lib/simStatus.ts / lib/llmMetrics.ts), so the
 * next render after a language switch picks up the new bundle.
 */

import type { EngineSnapshot, RuntimeCollaborationRecord, ScenarioEvent } from '../api/types';
import i18n from '../i18n/config';
import { localizedReasoning } from './decisionReasoning';
import type { EventLogEntry } from './eventLog';
import type { TriggerHint } from './episodes';

export type HeroLineKind = 'decision' | 'event' | 'idle' | 'llm-down';

export interface HeroLineInput {
  /** Live snapshot (ground truth), null before the first poll resolves. */
  snapshot: EngineSnapshot | null;
  /** Newest event-log entry (the store log is newest-first), null when empty. */
  latestEvent: EventLogEntry | null;
  /** Scenario events for decision.eventId → zoneId resolution (may be empty). */
  scenarioEvents: readonly ScenarioEvent[];
  /**
   * Client-side injection hints (store.triggerHints), keyed by eventId — the
   * zone fallback for decisions triggered by manually injected events, which
   * are absent from scenarioEvents and never echo on the bus.
   */
  triggerHints?: Readonly<Record<string, TriggerHint>>;
  /**
   * UX-06: AC collaboration rows (GET /api/simulations/:id/collaborations) —
   * lets an initiate_ac headline name the partner agent and stop showing the
   * in-progress verb once the handshake ended (cancelled/failed/completed).
   * Omitted = pre-UX-06 behavior (zone-based line, no handshake follow-up).
   */
  collaborations?: readonly RuntimeCollaborationRecord[];
}

export interface HeroLineModel {
  kind: HeroLineKind;
  /** ISO timestamp of the underlying record (drives the relative age). */
  at: string | null;
  /** decision: display name of the deciding agent (id as fallback). */
  agentName?: string;
  /** decision: localized verb (发起协作 / 独立处理 / …, raw value if unknown). */
  verb?: string;
  /** decision: raw decision string, kept for tone styling / tests. */
  decision?: string;
  /** decision: zone the triggering event targeted, when resolvable. */
  zoneLabel?: string;
  /**
   * decision (initiate_ac): display names of the partner agents of the
   * collaboration this decision spawned, when resolvable (UX-06).
   */
  partnerNames?: string[];
  /**
   * decision (initiate_ac): terminal outcome of the spawned collaboration
   * (UX-06) — present only once the handshake/session ended; the banner then
   * shows the ended state instead of the in-progress verb.
   */
  collabOutcome?: 'completed' | 'failed' | 'cancelled';
  /** decision: full reasoning text (render clamped, title carries it whole). */
  reasoning?: string;
  /** event: the event log's already-formatted one-line summary. */
  eventSummary?: string;
}

/** decision value → eventLogPanel i18n key (verbs shared with the log rows). */
const DECISION_KEY: Record<string, string> = {
  initiate_ac: 'decisionInitiateAc',
  handle_independently: 'decisionHandleIndependently',
  defer: 'decisionDefer',
  ignore: 'decisionIgnore',
};

/**
 * Localized decision verb (shared by the event-log decision rows and the hero
 * line). Unknown decision values render as-is — defensive against new engine
 * decision kinds.
 */
export function decisionLabel(decision: string): string {
  const key = DECISION_KEY[decision];
  return key ? i18n.t(`eventLogPanel:${key}`) : decision;
}

export function deriveHeroLine(input: HeroLineInput): HeroLineModel {
  const decisions = input.snapshot?.recentDecisions ?? [];
  const latest = decisions.length > 0 ? decisions[decisions.length - 1] : null;
  if (latest) {
    const agents = input.snapshot?.agents ?? [];
    const agentName = agents.find(a => a.id === latest.agentId)?.name ?? latest.agentId;
    // "对什么": the triggering event's zone, resolved to its snapshot name
    // when possible. R15-D4: the decision record's own zoneId is the
    // server-side truth (survives refresh); scenario events and the inject
    // panel's trigger hints remain the fallbacks.
    const zoneId =
      latest.zoneId ??
      input.scenarioEvents.find(e => e.id === latest.eventId)?.zoneId ??
      input.triggerHints?.[latest.eventId]?.zoneId;
    const zoneLabel = zoneId
      ? (input.snapshot?.zones.find(z => z.id === zoneId)?.name ?? zoneId)
      : undefined;
    // R2-FEAT-10: an LLM-down degraded decision (T-022 rule-fallback) is a
    // DEPLOYMENT signal, not a decision headline — pinning the raw provider
    // error ("404 …") as the top line reads like an agent decision and gives
    // no diagnostic path. Classify it as its own kind so the banner renders
    // the「部署环境 LLM 离线」alert with a configuration hint instead.
    if (latest.decisionSource === 'rule-llm-down' || latest.reasoningCode === 'rule.llm_down') {
      return {
        kind: 'llm-down',
        at: latest.at,
        agentName,
        ...(zoneLabel !== undefined ? { zoneLabel } : {}),
      };
    }
    // R15-D3: rule decisions localize from their structured code; LLM
    // reasoning passes through unchanged.
    const reasoning = localizedReasoning(latest);
    // UX-06: an initiate_ac headline follows the collaboration it spawned —
    // naming the partner agent(s) instead of the zone, and switching to the
    // ended state once the handshake/session is terminal.
    const collab =
      latest.decision === 'initiate_ac'
        ? followCollaboration(latest, input.collaborations, agents)
        : undefined;
    return {
      kind: 'decision',
      at: latest.at,
      agentName,
      verb: decisionLabel(latest.decision),
      decision: latest.decision,
      ...(zoneLabel !== undefined ? { zoneLabel } : {}),
      ...(collab?.partnerNames !== undefined ? { partnerNames: collab.partnerNames } : {}),
      ...(collab?.outcome !== undefined ? { collabOutcome: collab.outcome } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
  }
  if (input.latestEvent) {
    return { kind: 'event', at: input.latestEvent.at, eventSummary: input.latestEvent.summary };
  }
  return { kind: 'idle', at: null };
}

/** Terminal collaboration session statuses (engine session-store vocabulary:
 * a handshake timeout ends as 'cancelled' — the store has no separate
 * 'timeout'/'abandoned' status). */
const COLLAB_TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * UX-06: match an initiate_ac decision to the collaboration it spawned and
 * derive the banner's partner names + terminal outcome. The decision record
 * carries no collaborationId/partner (verified against the snapshot
 * contract), so the join is initiator + creation time: the earliest session
 * the deciding agent initiated at-or-after the decision was recorded
 * (assessment completion and session creation happen in the same delivery).
 * Returns undefined when no session matches — the caller keeps the
 * zone-based line.
 */
function followCollaboration(
  decision: { agentId: string; at: string },
  collaborations: readonly RuntimeCollaborationRecord[] | undefined,
  agents: readonly { id: string; name: string }[],
): { partnerNames?: string[]; outcome?: 'completed' | 'failed' | 'cancelled' } | undefined {
  if (collaborations === undefined) return undefined;
  const spawned = collaborations
    .filter(row => row.initiator === decision.agentId && row.createdAt >= decision.at)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  if (spawned === undefined) return undefined;
  const rows = collaborations.filter(row => row.id === spawned.id);
  const partnerIds = new Set<string>();
  for (const row of rows) {
    if (row.agentId !== decision.agentId) partnerIds.add(row.agentId);
    for (const participant of row.participants) {
      if (participant !== decision.agentId) partnerIds.add(participant);
    }
  }
  const displayName = (id: string): string => agents.find(a => a.id === id)?.name ?? id;
  // The initiator's own view is authoritative for the outcome; fall back to
  // any terminal partner row (both sides record the same terminal status).
  const terminalRow =
    (COLLAB_TERMINAL.has(spawned.status) ? spawned : undefined) ??
    rows.find(row => COLLAB_TERMINAL.has(row.status));
  return {
    ...(partnerIds.size > 0
      ? { partnerNames: [...partnerIds].map(displayName) }
      : {}),
    ...(terminalRow !== undefined
      ? { outcome: terminalRow.status as 'completed' | 'failed' | 'cancelled' }
      : {}),
  };
}

/**
 * Relative age of an ISO timestamp ('12 秒前' / '3m ago'). Returns null when
 * the timestamp is missing or unparseable (the caller then hides the readout).
 */
export function relativeAge(at: string | null, now: number): string | null {
  if (!at) return null;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return null;
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 60) return i18n.t('heroLine:ageSeconds', { count: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return i18n.t('heroLine:ageMinutes', { count: min });
  return i18n.t('heroLine:ageHours', { count: Math.floor(min / 60) });
}
