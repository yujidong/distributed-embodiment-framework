/**
 * Collaboration graph derivation — turn the engine event stream into a set
 * of directed agent→agent edges, rendered as a layer on the map canvases
 * (W7: agents already live there; the standalone circle graph is retired
 * from the console layout).
 *
 * Pure and defensive: payload field names differ across emitters
 * (`initiatorId` vs `initiator`, `participantIds` vs `participants`, …) and
 * AC_STATE_CHANGED events carry only a collaborationId, so membership is
 * reconstructed from earlier started/proposal events in the same buffer.
 *
 * Edge lifecycle (wall-clock, driven by `now`):
 * - proposal / message / started / AC→initializing|forming → 'forming' (dashed, animated)
 * - AC→ready|running|completing                          → 'running' (solid accent)
 * - COLLABORATION_COMPLETED (success) / AC→completed     → 'completed' (green, ~10s fade)
 * - COLLABORATION_COMPLETED (failure) / AC→failed|terminated → 'failed' (red, ~10s fade)
 *
 * Transitions are rank-guarded: a stale lower-rank event never downgrades an
 * edge (e.g. a late proposal must not turn a running edge back to forming,
 * and nothing resurrects a terminal edge). Active (non-terminal) edges not
 * refreshed within ACTIVE_KEEP_MS are dropped — the AC ended without a
 * terminal event and we don't want stale dashed edges forever.
 *
 * Display helpers for the map layers: `dedupeCollabEdges` collapses the
 * A→B/B→A pair to one edge per agent pair, `capCollabEdges` bounds the
 * concurrent overlay (oldest terminal edges drop first).
 */

import type { SystemEventDto } from '../api/types';
import { asRecord, str, strArr } from './eventLog';

export type CollabEdgeStatus = 'forming' | 'running' | 'completed' | 'failed';

export interface CollabEdge {
  key: string;
  source: string;
  target: string;
  status: CollabEdgeStatus;
  /** Short human description from the proposal/started payload, when known. */
  description?: string;
  /** Wall ms of the last event that touched this edge. */
  updatedAt: number;
}

export const TERMINAL_KEEP_MS = 10_000;
export const ACTIVE_KEEP_MS = 30_000;
/** Max concurrent on-map edges; overflow drops the oldest completed first. */
export const COLLAB_EDGE_CAP = 12;
/**
 * Default map display window (R14 P0-3): the console shows only edges with
 * activity inside the last 60s unless the user turns on「显示全部协作边」.
 */
export const COLLAB_RECENT_WINDOW_MS = 60_000;

const AC_FORMING_STATES = new Set(['initializing', 'forming']);
const AC_RUNNING_STATES = new Set(['ready', 'running', 'completing']);
const AC_COMPLETED_STATES = new Set(['completed']);
const AC_FAILED_STATES = new Set(['failed', 'terminated']);

/** Transition rank: a newer event may only keep or raise the rank. */
const STATUS_RANK: Record<CollabEdgeStatus, number> = {
  forming: 0,
  running: 1,
  completed: 2,
  failed: 2,
};

interface LinkEvent {
  collaborationId?: string;
  from?: string;
  targets: string[];
  /** Undefined when the event only contributes membership information. */
  status?: CollabEdgeStatus;
  description?: string;
}

/** Derive the current edge set from a chronological (oldest-first) event list. */
export function deriveCollabEdges(events: SystemEventDto[], now: number): CollabEdge[] {
  const members = new Map<string, Set<string>>();
  const edges = new Map<string, CollabEdge>();

  const remember = (collaborationId: string | undefined, agentIds: Iterable<string>) => {
    if (!collaborationId) return;
    const set = members.get(collaborationId) ?? new Set<string>();
    for (const id of agentIds) set.add(id);
    members.set(collaborationId, set);
  };

  const apply = (
    source: string,
    target: string,
    status: CollabEdgeStatus,
    at: number,
    description?: string,
  ) => {
    if (!source || !target || source === target) return;
    const key = `${source}->${target}`;
    const existing = edges.get(key);
    // Rank guard: stale events never downgrade (terminal edges are sticky).
    if (
      existing &&
      STATUS_RANK[status] < STATUS_RANK[existing.status] &&
      existing.updatedAt >= at
    ) {
      return;
    }
    edges.set(key, {
      key,
      source,
      target,
      status,
      description: description ?? existing?.description,
      updatedAt: Math.max(at, existing?.updatedAt ?? 0),
    });
  };

  for (const event of events) {
    const at = Date.parse(event.timestamp ?? '') || now;
    const link = extractLink(event);
    if (!link) continue;
    remember(link.collaborationId, [link.from, ...link.targets].filter((v): v is string => !!v));

    // AC lifecycle events reference only a collaborationId — expand it to
    // the member pairs reconstructed so far.
    if (link.targets.length === 0 && link.from === undefined && link.collaborationId && link.status) {
      const ids = [...(members.get(link.collaborationId) ?? [])];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          apply(ids[i], ids[j], link.status, at);
          apply(ids[j], ids[i], link.status, at);
        }
      }
      continue;
    }
    if (link.from && link.status) {
      for (const target of link.targets) apply(link.from, target, link.status, at, link.description);
    }
  }

  return [...edges.values()].filter(edge => {
    const age = now - edge.updatedAt;
    return isTerminal(edge.status) ? age <= TERMINAL_KEEP_MS : age <= ACTIVE_KEEP_MS;
  });
}

export function isTerminal(status: CollabEdgeStatus): boolean {
  return status === 'completed' || status === 'failed';
}

/**
 * Collapse bidirectional pairs: AC lifecycle expansion creates both A→B and
 * B→A; the map layer draws one edge per agent pair (the freshest wins).
 */
export function dedupeCollabEdges(edges: readonly CollabEdge[]): CollabEdge[] {
  const byPair = new Map<string, CollabEdge>();
  for (const edge of edges) {
    const pairKey = [edge.source, edge.target].sort().join('::');
    const existing = byPair.get(pairKey);
    if (!existing || edge.updatedAt >= existing.updatedAt) byPair.set(pairKey, edge);
  }
  return [...byPair.values()];
}

/**
 * Bound the concurrent overlay: when over `cap`, drop the oldest terminal
 * edges first, then the oldest forming edges (running edges are the most
 * informative and go last).
 */
export function capCollabEdges(
  edges: readonly CollabEdge[],
  cap: number = COLLAB_EDGE_CAP,
): CollabEdge[] {
  if (edges.length <= cap) return [...edges];
  const dropPriority = (edge: CollabEdge): number =>
    isTerminal(edge.status) ? 0 : edge.status === 'forming' ? 1 : 2;
  const kept = [...edges].sort((a, b) => {
    const rankDiff = dropPriority(b) - dropPriority(a);
    if (rankDiff !== 0) return rankDiff;
    return b.updatedAt - a.updatedAt;
  });
  return kept.slice(0, cap);
}

/**
 * Default-on declutter for the map layer (R14 P0-3): keep only edges whose
 * last activity (`updatedAt`, wall ms) falls inside the recent window. The
 * console's「显示全部协作边」toggle bypasses this filter and shows the full
 * derived set (the derivation keep windows still apply there).
 */
export function filterRecentCollabEdges(
  edges: readonly CollabEdge[],
  now: number,
  windowMs: number = COLLAB_RECENT_WINDOW_MS,
): CollabEdge[] {
  return edges.filter(edge => now - edge.updatedAt <= windowMs);
}

/**
 * Content equality for two derived edge sets (R31 F3): same edges, same
 * order, same status/updatedAt/description. The console's 1s wall-clock
 * ticker re-derives with a fresh `now` and skips its state update while
 * this holds — seconds with zero collab movement cost no re-render.
 *
 * Note the derived set is already bounded by ACTIVE_KEEP_MS (30s), which is
 * shorter than filterRecentCollabEdges' 60s window — comparing the DERIVED
 * sets before the recent-window filter is therefore sufficient.
 */
export function collabEdgesEqual(a: readonly CollabEdge[], b: readonly CollabEdge[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ea = a[i]!;
    const eb = b[i]!;
    if (
      ea.key !== eb.key ||
      ea.source !== eb.source ||
      ea.target !== eb.target ||
      ea.status !== eb.status ||
      ea.updatedAt !== eb.updatedAt ||
      ea.description !== eb.description
    ) {
      return false;
    }
  }
  return true;
}

/** Extract collaboration membership/transition info from one event. */
function extractLink(event: SystemEventDto): LinkEvent | null {
  const p = asRecord(event.payload);
  switch (event.type) {
    case 'collaboration.started':
      return {
        collaborationId: str(p.acId) ?? str(p.collaborationId) ?? str(p.sessionId),
        from: str(p.initiatorId) ?? str(p.initiator),
        targets: firstStrArr(p.participantIds, p.participants),
        status: 'forming',
        description: str(p.acName) ?? str(p.purpose) ?? str(p.triggerReason),
      };
    case 'collaboration.message': {
      const to = str(p.toAgent) ?? str(p.targetAgentId);
      return {
        collaborationId: str(p.collaborationId) ?? str(p.acId),
        from: str(p.fromAgent) ?? str(p.initiatorId),
        targets: to ? [to] : [],
        status: 'forming',
        description: str(p.description) ?? str(p.content),
      };
    }
    case 'collaboration.proposal': {
      const proposal = asRecord(p.proposal);
      return {
        collaborationId: str(p.collaborationId) ?? str(proposal.id),
        from: str(proposal.initiatorId) ?? str(proposal.initiator) ?? str(p.initiatorId),
        targets: firstStrArr(proposal.participantIds, proposal.participants, p.participantIds),
        status: 'forming',
        description: str(proposal.purpose) ?? str(proposal.description) ?? str(p.purpose),
      };
    }
    case 'collaboration.completed': {
      const failed = p.success === false;
      return {
        collaborationId: str(p.collaborationId) ?? str(p.sessionId),
        from: undefined,
        targets: [],
        status: failed ? 'failed' : 'completed',
      };
    }
    case 'custom': {
      if (str(p.customType) !== 'AC_STATE_CHANGED') return null;
      // Emitters differ: `to` (engine) vs `state` (AC layer), case varies.
      const to = (str(p.to) ?? str(p.state) ?? '').toLowerCase();
      const status: CollabEdgeStatus = AC_FORMING_STATES.has(to)
        ? 'forming'
        : AC_RUNNING_STATES.has(to)
          ? 'running'
          : AC_COMPLETED_STATES.has(to)
            ? 'completed'
            : AC_FAILED_STATES.has(to)
              ? 'failed'
              : 'forming';
      return {
        collaborationId: str(p.collaborationId) ?? str(p.acId),
        from: undefined,
        targets: [],
        status,
      };
    }
    default:
      return null;
  }
}

function firstStrArr(...values: unknown[]): string[] {
  for (const value of values) {
    const arr = strArr(value);
    if (arr.length > 0) return arr;
  }
  return [];
}
