/**
 * Episode aggregation (W8) — the simulation NARRATIVE layer.
 *
 * Raw event streams are incomprehensible under concurrency: decisions,
 * collaboration lifecycle frames and device operations from DIFFERENT
 * incidents interleave with no shared correlation id on the wire. This
 * module folds everything the client already buffers (WS event frames, the
 * snapshot ring buffer's `recentDecisions` + zone parameters, and the
 * trigger hints recorded at injection time) into Episodes:
 *
 *   触发 trigger → 各 Agent 决策 decisions → 协作 collaboration → 设备动作
 *   actions → 结局 outcome
 *
 * Anchoring (what the wire ACTUALLY carries — see deviations in the W8
 * notes):
 * - Decisions anchor an episode: every Layer-2 assessment lands in
 *   `recentDecisions` with `{agentId, eventId, eventType, …}`, so each
 *   distinct `eventId` seeds one episode. Injected events do NOT echo on the
 *   bus (EngineRuntime delivers them straight to agents), so the trigger's
 *   zone/parameter is reconstructed from (a) `triggerHints` recorded by the
 *   inject panel, (b) `scheduledEvents` in snapshots (scenario events fire
 *   with their scenario id as eventId), or (c) `environment.param_changed`
 *   bus frames carrying `metadata.eventId` / `payload.eventId`.
 * - Collaboration frames (`collaboration.started/message/proposal/completed`
 *   + CUSTOM `AC_STATE_CHANGED`) carry only an acId, never an eventId. An AC
 *   attaches to the temporally-reachable episode whose agents overlap the AC
 *   participants, ranked by: the AC initiator decided in that episode →
 *   overlap size → latest start (see findAcTarget). An AC that matches
 *   nothing becomes its own AC-anchored episode — this is also what keeps
 *   rule-only sims (no Layer-2 decisions at all) narratable.
 * - `device.operation_executed` carries `{agentId, deviceId, commandName,
 *   result | error+success:false}` — NO eventId (the mission's assumed
 *   `params.eventId` is honoured when present but is not emitted today).
 *   An op attaches to the episode where the agent participates in an AC
 *   covering the op's time (ops are how ACs execute), else the
 *   latest-starting episode involving that agent within
 *   ACTION_ATTACH_WINDOW_MS; ops that match nothing merge into per-agent
 *   action-only episodes (OP_EPISODE_MERGE_MS).
 *
 * Outcome heuristic (documented contract):
 * - ≥1 action: all succeeded → 'success'; some failed → 'partial'; all
 *   failed → 'failed'.
 * - 0 actions: AC failed → 'failed'; AC completed → 'success' (pure
 *   coordination episode); every decision is ignore/defer → 'success'
 *   (handled, no action needed); otherwise (AC still forming/running, or
 *   actions may still arrive) → 'ongoing'.
 *
 * Physical-change annotation: when the trigger carries parameter+zoneId, the
 * zone parameter value near the episode start is compared against the latest
 * buffered snapshot and appended to the summary (`烟雾 0.75→0.12`).
 *
 * Everything is pure and defensive (payload field names vary per emitter —
 * the same convention as lib/eventLog + lib/collabGraph).
 */

import type {
  EngineSnapshot,
  RuntimeDecisionRecord,
  SystemEventDto,
} from '../api/types';
import i18n from '../i18n/config';
import { asRecord, str, strArr } from './eventLog';
import { replayEventLabel } from './replayEvents';

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

export type EpisodeOutcomeStatus = 'success' | 'partial' | 'failed' | 'ongoing';

export interface EpisodeTrigger {
  /** The injected/scheduled event id, when the episode is event-anchored. */
  eventId?: string;
  /** Event type (e.g. 'smoke-detected'); 'collaboration' / 'device-operation' for derived episodes. */
  type: string;
  zoneId?: string;
  parameter?: string;
  value?: number | boolean;
  atSimTimeSec?: number;
}

export interface EpisodeDecision {
  agentId: string;
  agentName?: string;
  decision: string;
  /** Decision path marker ('precheck' | 'llm' | …), rendered verbatim. */
  decisionSource: string;
  at: string;
}

export type EpisodeCollabState = 'forming' | 'running' | 'completed' | 'failed';

export interface EpisodeCollaboration {
  acId: string;
  state: EpisodeCollabState;
  initiator?: string;
  participants: string[];
  description?: string;
}

export interface EpisodeAction {
  deviceId: string;
  deviceName?: string;
  commandName: string;
  success: boolean;
  agentId?: string;
  at?: string;
}

export interface EpisodeOutcome {
  status: EpisodeOutcomeStatus;
  summary: string;
}

export interface Episode {
  id: string;
  trigger: EpisodeTrigger;
  decisions: EpisodeDecision[];
  collaboration?: EpisodeCollaboration;
  actions: EpisodeAction[];
  outcome: EpisodeOutcome;
  /** ISO wall-clock of the first known episode activity. */
  startAt: string;
  /** ISO wall-clock of the latest known episode activity. */
  lastAt: string;
}

/** Client-side record of a manual injection (written by the inject panel). */
export interface TriggerHint {
  type: string;
  zoneId?: string;
  parameter?: string;
  value?: number | boolean;
  at?: string;
}

/** Display-name resolvers; missing names fall back to ids. */
export interface EpisodeNames {
  agentName?: (id: string) => string | undefined;
  deviceName?: (id: string) => string | undefined;
  zoneName?: (id: string) => string | undefined;
}

export interface AggregateEpisodesInput {
  /** WS event frames, any order (sorted internally by timestamp). */
  events?: readonly SystemEventDto[];
  /** Buffered snapshots (decisions, scheduled events, zone parameters). */
  snapshots?: readonly EngineSnapshot[];
  /** Extra decision records (e.g. the live snapshot's), merged + deduped. */
  decisions?: readonly RuntimeDecisionRecord[];
  /** Injection hints recorded client-side, keyed by eventId. */
  triggerHints?: Readonly<Record<string, TriggerHint>>;
  names?: EpisodeNames;
}

/** AC ↔ episode attach window (wall ms). */
export const AC_ATTACH_WINDOW_MS = 120_000;
/** Device-op ↔ episode attach window (wall ms). */
export const ACTION_ATTACH_WINDOW_MS = 120_000;
/** Unlinked ops by one agent within this window merge into one episode. */
export const OP_EPISODE_MERGE_MS = 60_000;
/** Tolerance for wall-clock skew between emitters. */
const CLOCK_SKEW_MS = 2_000;

/** Decision labels that end an episode with no action by definition. */
const NO_ACTION_DECISIONS = new Set(['ignore', 'defer', 'no_action', 'no-action']);

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregateEpisodes(input: AggregateEpisodesInput): Episode[] {
  const names = input.names ?? {};
  const snapshots = input.snapshots ?? [];
  const hints = input.triggerHints ?? {};

  // 1. Decisions: merged across every buffered snapshot (the server ring
  //    buffer is only 50 deep and can scroll past between polls), deduped.
  const decisions = mergeDecisions(snapshots, input.decisions ?? []);

  // 2. Event frames, chronological.
  const events = [...(input.events ?? [])].sort(
    (a, b) => eventMs(a) - eventMs(b),
  );

  // 3. Seed event-anchored episodes from decisions.
  const episodes = new Map<string, EpisodeBuilder>();
  for (const decision of decisions) {
    const builder = episodes.get(decision.eventId) ??
      seedEventEpisode(decision, snapshots, hints, events);
    builder.decisions.push(decision);
    builder.touch(Date.parse(decision.at));
    episodes.set(decision.eventId, builder);
  }

  // 4. Collaboration frames → AC lifecycle groups → attach or anchor.
  const acs = collectCollaborations(events);
  for (const ac of acs.values()) {
    const target = (ac.eventId && episodes.get(ac.eventId)) ||
      findAcTarget(episodes.values(), ac);
    if (target) {
      target.collaboration = ac;
      target.touch(ac.firstAt);
      target.touch(ac.lastAt);
    } else {
      const builder = anchorCollaborationEpisode(ac);
      episodes.set(builder.key, builder);
    }
  }

  // 5. Device operations → attach or merge into action-only episodes.
  let opSeq = 0;
  const openOpEpisodes = new Map<string, EpisodeBuilder>(); // per agent
  for (const op of collectDeviceOps(events)) {
    const byEvent = op.eventId ? episodes.get(op.eventId) : undefined;
    const target = byEvent ?? findOpTarget(episodes.values(), op);
    if (target) {
      target.actions.push(op);
      target.touch(op.at);
      continue;
    }
    // Standalone action episode, merged per agent within OP_EPISODE_MERGE_MS.
    const mergeKey = op.agentId ?? op.deviceId;
    const open = openOpEpisodes.get(mergeKey);
    if (open && op.at - open.lastAtMs <= OP_EPISODE_MERGE_MS) {
      open.actions.push(op);
      open.touch(op.at);
      continue;
    }
    const builder = anchorActionEpisode(op, ++opSeq);
    episodes.set(builder.key, builder);
    openOpEpisodes.set(mergeKey, builder);
  }

  // 6. Finalize: names, outcome heuristic, narrative summary, physical delta.
  const finalized = [...episodes.values()].map(builder => finalize(builder, snapshots, names));
  finalized.sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt) || Date.parse(b.lastAt) - Date.parse(a.lastAt));
  return finalized;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

interface EpisodeBuilder {
  key: string;
  trigger: EpisodeTrigger;
  decisions: RuntimeDecisionRecord[];
  collaboration?: EpisodeCollaboration & { firstAt: number; lastAt: number };
  /** Raw parsed ops (wall-ms `at`); mapped to EpisodeAction in finalize. */
  actions: DeviceOp[];
  startAtMs: number;
  lastAtMs: number;
  touch(at: number): void;
}

function makeBuilder(key: string, trigger: EpisodeTrigger): EpisodeBuilder {
  const builder: EpisodeBuilder = {
    key,
    trigger,
    decisions: [],
    actions: [],
    startAtMs: Number.POSITIVE_INFINITY,
    lastAtMs: Number.NEGATIVE_INFINITY,
    touch(at: number) {
      if (Number.isNaN(at)) return;
      if (at < builder.startAtMs) builder.startAtMs = at;
      if (at > builder.lastAtMs) builder.lastAtMs = at;
    },
  };
  return builder;
}

function seedEventEpisode(
  first: RuntimeDecisionRecord,
  snapshots: readonly EngineSnapshot[],
  hints: Readonly<Record<string, TriggerHint>>,
  events: readonly SystemEventDto[],
): EpisodeBuilder {
  const hint = hints[first.eventId];
  const scheduled = findScheduledEvent(snapshots, first.eventId);
  const paramEvent = events.find(event => {
    if (event.type !== 'environment.param_changed') return false;
    const p = asRecord(event.payload);
    return str(p.eventId) === first.eventId || str(asRecord(event.metadata).eventId) === first.eventId;
  });
  const paramPayload = paramEvent ? asRecord(paramEvent.payload) : undefined;
  const trigger: EpisodeTrigger = {
    eventId: first.eventId,
    type: hint?.type ?? scheduled?.type ?? first.eventType,
    ...(hint?.zoneId ?? scheduled?.zoneId ?? str(paramPayload?.zoneId) ?? str(paramPayload?.location)
      ? { zoneId: hint?.zoneId ?? scheduled?.zoneId ?? str(paramPayload?.zoneId) ?? str(paramPayload?.location) }
      : {}),
    ...(hint?.parameter ?? str(paramPayload?.parameter)
      ? { parameter: hint?.parameter ?? str(paramPayload?.parameter) }
      : {}),
    ...(hint?.value !== undefined
      ? { value: hint.value }
      : typeof paramPayload?.newValue === 'number' || typeof paramPayload?.newValue === 'boolean'
        ? { value: paramPayload.newValue }
        : {}),
    ...(scheduled?.atSimTimeSec !== undefined ? { atSimTimeSec: scheduled.atSimTimeSec } : {}),
  };
  const builder = makeBuilder(first.eventId, trigger);
  if (hint?.at) builder.touch(Date.parse(hint.at));
  return builder;
}

function anchorCollaborationEpisode(ac: CollaborationInfo): EpisodeBuilder {
  const builder = makeBuilder(`ac:${ac.acId}`, {
    type: 'collaboration',
  });
  builder.collaboration = ac;
  builder.touch(ac.firstAt);
  builder.touch(ac.lastAt);
  return builder;
}

function anchorActionEpisode(op: DeviceOp, seq: number): EpisodeBuilder {
  const builder = makeBuilder(`ops:${op.agentId ?? op.deviceId}:${seq}`, {
    type: 'device-operation',
  });
  builder.actions.push(op);
  builder.touch(op.at);
  return builder;
}

/**
 * AC → episode attach (heuristic — the wire carries no eventId on AC
 * frames). Candidates overlap the AC's participants and are temporally
 * reachable; ranked by: the AC initiator DECIDED in this episode (an agent
 * initiates an AC because of an event it handled) → participant overlap
 * count → latest start.
 */
function findAcTarget(
  candidates: Iterable<EpisodeBuilder>,
  ac: CollaborationInfo,
): EpisodeBuilder | undefined {
  let best: EpisodeBuilder | undefined;
  let bestKey: [number, number, number] | undefined;
  for (const episode of candidates) {
    if (ac.firstAt < episode.startAtMs - CLOCK_SKEW_MS) continue;
    if (ac.firstAt > episode.lastAtMs + AC_ATTACH_WINDOW_MS) continue;
    const episodeAgentIds = new Set(builderAgents(episode));
    const overlap = ac.participants.filter(id => episodeAgentIds.has(id)).length;
    if (overlap === 0) continue;
    const initiatorDecides =
      ac.initiator !== undefined && episode.decisions.some(d => d.agentId === ac.initiator) ? 1 : 0;
    const key: [number, number, number] = [initiatorDecides, overlap, episode.startAtMs];
    if (!bestKey || compareRank(key, bestKey) > 0) {
      best = episode;
      bestKey = key;
    }
  }
  return best;
}

/**
 * Device-op → episode attach (heuristic — `params.eventId` is honoured
 * upstream when present, but today's emitter omits it). Ranked by: the op
 * falls inside the window of an AC the agent participates in (ops are how
 * ACs execute) → latest episode start.
 */
function findOpTarget(
  candidates: Iterable<EpisodeBuilder>,
  op: DeviceOp,
): EpisodeBuilder | undefined {
  if (!op.agentId) return undefined;
  let best: EpisodeBuilder | undefined;
  let bestKey: [number, number] | undefined;
  for (const episode of candidates) {
    if (op.at < episode.startAtMs - CLOCK_SKEW_MS) continue;
    if (op.at > episode.lastAtMs + ACTION_ATTACH_WINDOW_MS) continue;
    if (!builderAgents(episode).includes(op.agentId)) continue;
    const collab = episode.collaboration;
    const withinAc = collab &&
      collab.participants.includes(op.agentId) &&
      op.at >= collab.firstAt - CLOCK_SKEW_MS &&
      op.at <= collab.lastAt + ACTION_ATTACH_WINDOW_MS
      ? 1
      : 0;
    const key: [number, number] = [withinAc, episode.startAtMs];
    if (!bestKey || compareRank(key, bestKey) > 0) {
      best = episode;
      bestKey = key;
    }
  }
  return best;
}

/** Lexicographic compare for attach-rank tuples (higher wins). */
function compareRank(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

function builderAgents(episode: EpisodeBuilder): string[] {
  const ids = new Set<string>();
  for (const d of episode.decisions) ids.add(d.agentId);
  for (const id of episode.collaboration?.participants ?? []) ids.add(id);
  for (const action of episode.actions) {
    if (action.agentId) ids.add(action.agentId);
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

interface CollaborationInfo {
  acId: string;
  state: EpisodeCollabState;
  initiator?: string;
  participants: string[];
  description?: string;
  /** Present only when an emitter actually carries an eventId (future). */
  eventId?: string;
  firstAt: number;
  lastAt: number;
}

interface DeviceOp {
  deviceId: string;
  commandName: string;
  success: boolean;
  agentId?: string;
  eventId?: string;
  at: number;
}

const AC_FORMING = new Set(['created', 'initializing', 'forming']);
const AC_RUNNING = new Set(['ready', 'running', 'completing']);
const AC_COMPLETED = new Set(['completed']);
const AC_FAILED = new Set(['failed', 'terminated']);

const COLLAB_RANK: Record<EpisodeCollabState, number> = {
  forming: 0,
  running: 1,
  completed: 2,
  failed: 2,
};

function collectCollaborations(events: readonly SystemEventDto[]): Map<string, CollaborationInfo> {
  const acs = new Map<string, CollaborationInfo>();
  for (const event of events) {
    const link = extractCollaboration(event);
    if (!link) continue;
    const at = eventMs(event);
    const existing = acs.get(link.acId);
    const participants = new Set(existing?.participants ?? []);
    if (link.from) participants.add(link.from);
    for (const id of link.targets) participants.add(id);
    const state: EpisodeCollabState = !existing
      ? link.state
      : COLLAB_RANK[link.state] >= COLLAB_RANK[existing.state]
        ? link.state
        : existing.state;
    acs.set(link.acId, {
      acId: link.acId,
      state,
      ...(link.initiator ?? existing?.initiator ? { initiator: link.initiator ?? existing?.initiator } : {}),
      participants: [...participants],
      ...(link.description ?? existing?.description
        ? { description: link.description ?? existing?.description }
        : {}),
      ...(link.eventId ?? existing?.eventId ? { eventId: link.eventId ?? existing?.eventId } : {}),
      firstAt: Math.min(at, existing?.firstAt ?? at),
      lastAt: Math.max(at, existing?.lastAt ?? at),
    });
  }
  return acs;
}

interface CollabLink {
  acId: string;
  from?: string;
  initiator?: string;
  targets: string[];
  state: EpisodeCollabState;
  description?: string;
  eventId?: string;
}

/** AC-centric parse of collaboration frames (field names vary per emitter). */
function extractCollaboration(event: SystemEventDto): CollabLink | null {
  const p = asRecord(event.payload);
  const metaEventId = str(asRecord(event.metadata).eventId) ?? str(p.eventId);
  switch (event.type) {
    case 'collaboration.started': {
      const acId = str(p.acId) ?? str(p.collaborationId) ?? str(p.sessionId);
      if (!acId) return null;
      const initiator = str(p.initiatorId) ?? str(p.initiator);
      return {
        acId,
        ...(initiator ? { from: initiator, initiator } : {}),
        targets: firstStrArr(p.participantIds, p.participants),
        state: 'running',
        ...(str(p.acName) ?? str(p.purpose) ?? str(p.triggerReason)
          ? { description: str(p.acName) ?? str(p.purpose) ?? str(p.triggerReason) }
          : {}),
        ...(metaEventId ? { eventId: metaEventId } : {}),
      };
    }
    case 'collaboration.message': {
      const acId = str(p.collaborationId) ?? str(p.acId);
      if (!acId) return null;
      const to = str(p.toAgent) ?? str(p.targetAgentId);
      const from = str(p.fromAgent) ?? str(p.initiatorId);
      return {
        acId,
        ...(from ? { from } : {}),
        targets: to ? [to] : [],
        state: 'running',
        ...(metaEventId ? { eventId: metaEventId } : {}),
      };
    }
    case 'collaboration.proposal': {
      const proposal = asRecord(p.proposal);
      const acId = str(p.collaborationId) ?? str(proposal.id);
      if (!acId) return null;
      const initiator = str(proposal.initiatorId) ?? str(proposal.initiator) ?? str(p.initiatorId);
      return {
        acId,
        ...(initiator ? { from: initiator, initiator } : {}),
        targets: firstStrArr(proposal.participantIds, proposal.participants, p.participantIds),
        state: 'forming',
        ...(str(proposal.purpose) ?? str(proposal.description) ?? str(p.purpose)
          ? { description: str(proposal.purpose) ?? str(proposal.description) ?? str(p.purpose) }
          : {}),
        ...(metaEventId ? { eventId: metaEventId } : {}),
      };
    }
    case 'collaboration.completed': {
      const acId = str(p.collaborationId) ?? str(p.sessionId) ?? str(p.acId);
      if (!acId) return null;
      return {
        acId,
        targets: [],
        state: p.success === false ? 'failed' : 'completed',
        ...(metaEventId ? { eventId: metaEventId } : {}),
      };
    }
    case 'custom': {
      if (str(p.customType) !== 'AC_STATE_CHANGED') return null;
      const acId = str(p.collaborationId) ?? str(p.acId);
      if (!acId) return null;
      const to = (str(p.to) ?? str(p.state) ?? '').toLowerCase();
      const state: EpisodeCollabState = AC_FORMING.has(to)
        ? 'forming'
        : AC_RUNNING.has(to)
          ? 'running'
          : AC_COMPLETED.has(to)
            ? 'completed'
            : AC_FAILED.has(to)
              ? 'failed'
              : 'forming';
      return { acId, targets: [], state, ...(metaEventId ? { eventId: metaEventId } : {}) };
    }
    default:
      return null;
  }
}

function collectDeviceOps(events: readonly SystemEventDto[]): DeviceOp[] {
  const ops: DeviceOp[] = [];
  for (const event of events) {
    if (event.type !== 'device.operation_executed') continue;
    const p = asRecord(event.payload);
    const deviceId = str(p.deviceId);
    if (!deviceId) continue;
    const params = asRecord(p.params);
    ops.push({
      deviceId,
      commandName: str(p.commandName) ?? 'command',
      success: opSuccess(p),
      ...(str(p.agentId) ? { agentId: str(p.agentId) } : {}),
      ...(str(params.eventId) ?? str(asRecord(event.metadata).eventId)
        ? { eventId: str(params.eventId) ?? str(asRecord(event.metadata).eventId) }
        : {}),
      at: eventMs(event),
    });
  }
  return ops;
}

function opSuccess(p: Record<string, unknown>): boolean {
  if (typeof p.success === 'boolean') return p.success;
  if (typeof p.error === 'string' && p.error.length > 0) return false;
  const result = asRecord(p.result);
  if (typeof result.success === 'boolean') return result.success;
  return true;
}

// ---------------------------------------------------------------------------
// Finalize: names, outcome, summary, physical delta
// ---------------------------------------------------------------------------

function finalize(
  builder: EpisodeBuilder,
  snapshots: readonly EngineSnapshot[],
  names: EpisodeNames,
): Episode {
  const agentName = (id: string): string => names.agentName?.(id) ?? id;
  const deviceName = (id: string): string => names.deviceName?.(id) ?? id;

  const decisions: EpisodeDecision[] = builder.decisions.map(d => ({
    agentId: d.agentId,
    ...(names.agentName?.(d.agentId) ? { agentName: names.agentName(d.agentId) } : {}),
    decision: d.decision,
    decisionSource: d.decisionSource,
    at: d.at,
  }));
  const actions: EpisodeAction[] = builder.actions.map(op => ({
    deviceId: op.deviceId,
    ...(names.deviceName?.(op.deviceId) ? { deviceName: names.deviceName(op.deviceId) } : {}),
    commandName: op.commandName,
    success: op.success,
    ...(op.agentId ? { agentId: op.agentId } : {}),
    ...(Number.isFinite(op.at) ? { at: new Date(op.at).toISOString() } : {}),
  }));
  const collaboration: EpisodeCollaboration | undefined = builder.collaboration
    ? {
        acId: builder.collaboration.acId,
        state: builder.collaboration.state,
        ...(builder.collaboration.initiator ? { initiator: builder.collaboration.initiator } : {}),
        participants: builder.collaboration.participants,
        ...(builder.collaboration.description ? { description: builder.collaboration.description } : {}),
      }
    : undefined;

  const status = outcomeStatus(actions, collaboration, builder.decisions);
  const now = Date.now();
  const startAtMs = Number.isFinite(builder.startAtMs) ? builder.startAtMs : now;
  const lastAtMs = Number.isFinite(builder.lastAtMs) ? builder.lastAtMs : startAtMs;

  const episode: Episode = {
    id: builder.key,
    trigger: builder.trigger,
    decisions,
    ...(collaboration ? { collaboration } : {}),
    actions,
    outcome: { status, summary: '' },
    startAt: new Date(startAtMs).toISOString(),
    lastAt: new Date(lastAtMs).toISOString(),
  };
  episode.outcome.summary = buildSummary(episode, agentName, deviceName) + physicalDelta(builder.trigger, snapshots);
  return episode;
}

/** The documented outcome heuristic (see module header). */
function outcomeStatus(
  actions: readonly EpisodeAction[],
  collaboration: EpisodeCollaboration | undefined,
  decisions: readonly RuntimeDecisionRecord[],
): EpisodeOutcomeStatus {
  if (actions.length > 0) {
    const failed = actions.filter(a => !a.success).length;
    if (failed === 0) return 'success';
    if (failed === actions.length) return 'failed';
    return 'partial';
  }
  if (collaboration?.state === 'failed') return 'failed';
  if (collaboration?.state === 'completed') return 'success';
  if (
    decisions.length > 0 &&
    decisions.every(d => NO_ACTION_DECISIONS.has(d.decision))
  ) {
    return 'success';
  }
  return 'ongoing';
}

/**
 * Narrative one-liner: `感知员发起 → 家电管家+气候管家 → 油烟机✓ 空调✓`
 * (zh-CN) — the leading-agent label and joiners are read from i18n so the
 * summary tracks the active UI language. Without a collaboration the deciding
 * agents speak for themselves.
 */
function buildSummary(
  episode: Episode,
  agentName: (id: string) => string,
  deviceName: (id: string) => string,
): string {
  const t = i18n.getFixedT(i18n.language, 'episodesLib');
  const segments: string[] = [];
  const collaboration = episode.collaboration;
  if (collaboration) {
    const initiator = collaboration.initiator ?? episode.decisions[0]?.agentId;
    const others = collaboration.participants.filter(id => id !== initiator);
    if (initiator) segments.push(`${agentName(initiator)}${t('summaryInitiatorSuffix')}`);
    if (others.length > 0) segments.push(others.map(agentName).join('+'));
  } else if (episode.decisions.length > 0) {
    const agents = [...new Set(episode.decisions.map(d => d.agentId))];
    const labels = [...new Set(episode.decisions.map(d => d.decision))];
    segments.push(`${agents.map(agentName).join('+')}: ${labels.join(', ')}`);
  }
  if (episode.actions.length > 0) {
    const labels = episode.actions.map(a => `${deviceName(a.deviceId)}${a.success ? '✓' : '✗'}`);
    segments.push([...new Set(labels)].join(' '));
  }
  if (segments.length === 0) return t('summaryEmpty');
  return segments.join(' → ');
}

/** `；烟雾 0.75→0.12` (zh-CN) when the trigger parameter moved in the buffer. */
function physicalDelta(
  trigger: EpisodeTrigger,
  snapshots: readonly EngineSnapshot[],
): string {
  if (!trigger.parameter || !trigger.zoneId || snapshots.length === 0) return '';
  const t = i18n.getFixedT(i18n.language, 'episodesLib');
  const param = trigger.parameter;
  const zoneId = trigger.zoneId;
  const valueIn = (snapshot: EngineSnapshot): number | boolean | undefined =>
    snapshot.zones.find(z => z.id === zoneId)?.parameters[param];

  // Start value: the first snapshot that observes this episode's decisions
  // (≈ episode start); fall back to the injected value, then the first
  // snapshot carrying the parameter at all.
  let startValue: number | boolean | undefined;
  if (trigger.eventId) {
    const atStart = snapshots.find(s => s.recentDecisions.some(d => d.eventId === trigger.eventId));
    startValue = atStart ? valueIn(atStart) : undefined;
  }
  if (startValue === undefined) startValue = trigger.value;
  if (startValue === undefined) {
    for (const snapshot of snapshots) {
      const value = valueIn(snapshot);
      if (value !== undefined) { startValue = value; break; }
    }
  }
  let latestValue: number | boolean | undefined;
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const value = valueIn(snapshots[i]);
    if (value !== undefined) { latestValue = value; break; }
  }
  if (typeof startValue !== 'number' || typeof latestValue !== 'number') return '';
  if (startValue === latestValue) return '';
  return `${t('physicalDeltaJoin')}${parameterLabel(param)} ${formatNumber(startValue)}→${formatNumber(latestValue)}`;
}

// ---------------------------------------------------------------------------
// Filters / derivation helpers
// ---------------------------------------------------------------------------

export interface EpisodeFilter {
  /** Episode must involve at least one of these agents. */
  agentIds?: ReadonlySet<string>;
  /** Episode trigger zone must be one of these. */
  zoneIds?: ReadonlySet<string>;
  /** Episode outcome must be one of these. */
  outcomes?: ReadonlySet<EpisodeOutcomeStatus>;
}

export function filterEpisodes(
  episodes: readonly Episode[],
  filter: EpisodeFilter,
): Episode[] {
  const { agentIds, zoneIds, outcomes } = filter;
  return episodes.filter(episode => {
    if (outcomes && outcomes.size > 0 && !outcomes.has(episode.outcome.status)) return false;
    if (zoneIds && zoneIds.size > 0) {
      if (!episode.trigger.zoneId || !zoneIds.has(episode.trigger.zoneId)) return false;
    }
    if (agentIds && agentIds.size > 0) {
      if (!episodeAgents(episode).some(id => agentIds.has(id))) return false;
    }
    return true;
  });
}

/** Every agent involved in an episode (decisions, AC, actions). */
export function episodeAgents(episode: Episode): string[] {
  const ids = new Set<string>();
  for (const d of episode.decisions) ids.add(d.agentId);
  for (const id of episode.collaboration?.participants ?? []) ids.add(id);
  if (episode.collaboration?.initiator) ids.add(episode.collaboration.initiator);
  for (const action of episode.actions) {
    if (action.agentId) ids.add(action.agentId);
  }
  return [...ids];
}

/** Ids of agents owned by a user — the「只看我参与的」quick filter. */
export function ownedAgentIds(
  agents: readonly { id: string; ownerId?: string | null }[],
  userId: string | null | undefined,
): string[] {
  if (!userId) return [];
  return agents.filter(a => a.ownerId === userId).map(a => a.id);
}

/**
 * The episode whose [startAt, lastAt] contains the given wall time (replay
 * cursor). Latest-starting wins when episodes overlap.
 */
export function episodeIdAtTime(
  episodes: readonly Episode[],
  atMs: number | null,
): string | null {
  if (atMs === null || !Number.isFinite(atMs)) return null;
  let best: Episode | null = null;
  for (const episode of episodes) {
    const start = Date.parse(episode.startAt);
    const last = Date.parse(episode.lastAt);
    if (Number.isNaN(start) || Number.isNaN(last)) continue;
    if (atMs < start || atMs > last) continue;
    if (!best || start >= Date.parse(best.startAt)) best = episode;
  }
  return best?.id ?? null;
}

/** Short trigger line for the row header (`厨房 烟雾 = 0.9`). */
export function formatTrigger(
  trigger: EpisodeTrigger,
  names?: EpisodeNames,
): string {
  const t = i18n.getFixedT(i18n.language, 'episodesLib');
  const zone = trigger.zoneId ? (names?.zoneName?.(trigger.zoneId) ?? trigger.zoneId) : '';
  if (trigger.type === 'collaboration') return t('triggerCollaboration');
  if (trigger.type === 'device-operation') return t('triggerDeviceOperation');
  // Fix-14 replay event kinds get a readable label instead of the raw type.
  const param = trigger.parameter
    ? parameterLabel(trigger.parameter)
    : replayEventLabel(trigger.type);
  const value = trigger.value !== undefined ? ` = ${formatValue(trigger.value)}` : '';
  return `${zone}${zone ? ' ' : ''}${param}${value}`;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * Display label for a known trigger/baseline parameter in the active locale.
 * Unknown parameters fall back to the raw key.
 */
export function parameterLabel(parameter: string): string {
  return i18n.t(`episodesLib:parameter.${parameter}`, { defaultValue: parameter });
}

function mergeDecisions(
  snapshots: readonly EngineSnapshot[],
  extra: readonly RuntimeDecisionRecord[],
): RuntimeDecisionRecord[] {
  const seen = new Set<string>();
  const merged: RuntimeDecisionRecord[] = [];
  for (const list of [...snapshots.map(s => s.recentDecisions), extra]) {
    for (const decision of list) {
      const key = `${decision.agentId}|${decision.eventId}|${decision.at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(decision);
    }
  }
  merged.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return merged;
}

function findScheduledEvent(
  snapshots: readonly EngineSnapshot[],
  eventId: string,
): { type: string; zoneId: string; atSimTimeSec?: number } | undefined {
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const found = snapshots[i].scheduledEvents.find(e => e.id === eventId);
    if (found) {
      return {
        type: found.type,
        zoneId: found.zoneId,
        ...(found.atSimTimeSec !== undefined ? { atSimTimeSec: found.atSimTimeSec } : {}),
      };
    }
  }
  return undefined;
}

function eventMs(event: SystemEventDto): number {
  const parsed = Date.parse(event.timestamp ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

function firstStrArr(...values: unknown[]): string[] {
  for (const value of values) {
    const arr = strArr(value);
    if (arr.length > 0) return arr;
  }
  return [];
}

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function formatValue(value: number | boolean): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return formatNumber(value);
}
