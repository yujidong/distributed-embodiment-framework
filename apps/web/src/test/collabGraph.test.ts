/**
 * Collaboration edge state machine (W7): forming → running → completed /
 * failed transitions with a rank guard, terminal/active keep windows, the
 * pair dedupe for the map layer, and the concurrent-edge cap (oldest
 * completed drop first).
 */

import { describe, expect, it } from 'vitest';

import type { SystemEventDto } from '../api/types';
import {
  ACTIVE_KEEP_MS,
  capCollabEdges,
  collabEdgesEqual,
  COLLAB_RECENT_WINDOW_MS,
  dedupeCollabEdges,
  deriveCollabEdges,
  filterRecentCollabEdges,
  TERMINAL_KEEP_MS,
  type CollabEdge,
} from '../lib/collabGraph';

const T0 = 1_000_000_000;

function event(
  type: string,
  payload: Record<string, unknown>,
  offsetMs = 0,
): SystemEventDto {
  return {
    id: `ev-${type}-${offsetMs}`,
    type,
    source: 'test',
    timestamp: new Date(T0 + offsetMs).toISOString(),
    payload,
  };
}

const started = (offsetMs = 0) =>
  event(
    'collaboration.started',
    { acId: 'ac-1', initiatorId: 'agent-a', participantIds: ['agent-b', 'agent-c'], acName: '联合巡检' },
    offsetMs,
  );

const acState = (to: string, offsetMs: number) =>
  event('custom', { customType: 'AC_STATE_CHANGED', collaborationId: 'ac-1', from: 'x', to }, offsetMs);

describe('deriveCollabEdges lifecycle', () => {
  it('collaboration.started creates forming edges with the description', () => {
    const edges = deriveCollabEdges([started()], T0);
    expect(edges).toHaveLength(2);
    expect(edges.map(e => `${e.source}->${e.target}:${e.status}`).sort()).toEqual([
      'agent-a->agent-b:forming',
      'agent-a->agent-c:forming',
    ]);
    expect(edges[0].description).toBe('联合巡检');
  });

  it('AC_STATE_CHANGED running upgrades every member pair, both directions', () => {
    const edges = deriveCollabEdges([started(), acState('running', 1000)], T0 + 1000);
    // 3 members → 3 unordered pairs × 2 directions.
    expect(edges).toHaveLength(6);
    expect(edges.every(e => e.status === 'running')).toBe(true);
  });

  it('completed marks the pairs completed and keeps them ~10s', () => {
    const events = [started(), acState('running', 1000), acState('completed', 2000)];
    const during = deriveCollabEdges(events, T0 + 2000 + TERMINAL_KEEP_MS - 1);
    expect(during.length).toBeGreaterThan(0);
    expect(during.every(e => e.status === 'completed')).toBe(true);
    const after = deriveCollabEdges(events, T0 + 2000 + TERMINAL_KEEP_MS + 1);
    expect(after).toHaveLength(0);
  });

  it('collaboration.completed with success:false fails the pairs', () => {
    const edges = deriveCollabEdges(
      [started(), event('collaboration.completed', { collaborationId: 'ac-1', success: false }, 1500)],
      T0 + 1500,
    );
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every(e => e.status === 'failed')).toBe(true);
  });

  it('a stale forming event never downgrades a running edge (rank guard)', () => {
    // The proposal rides an OLD timestamp but arrives after the running event.
    const proposalLate = event(
      'collaboration.message',
      { collaborationId: 'ac-1', fromAgent: 'agent-a', targetAgentId: 'agent-b', type: 'ac-proposal' },
      500, // older than the running transition at +1000
    );
    const edges = deriveCollabEdges([started(), acState('running', 1000), proposalLate], T0 + 1000);
    const ab = edges.find(e => e.source === 'agent-a' && e.target === 'agent-b');
    expect(ab?.status).toBe('running');
  });

  it('a terminal edge is never resurrected by a later stale active event', () => {
    const staleProposal = event(
      'collaboration.message',
      { collaborationId: 'ac-1', fromAgent: 'agent-a', targetAgentId: 'agent-b' },
      1500, // before completed at +2000
    );
    const edges = deriveCollabEdges(
      [started(), acState('completed', 2000), staleProposal],
      T0 + 2000,
    );
    const ab = edges.find(e => e.source === 'agent-a' && e.target === 'agent-b');
    expect(ab?.status).toBe('completed');
  });

  it('active edges not refreshed within ACTIVE_KEEP_MS are dropped', () => {
    const edges = deriveCollabEdges([started()], T0 + ACTIVE_KEEP_MS + 1);
    expect(edges).toHaveLength(0);
  });

  it('AC_STATE_CHANGED with an `acId`/`state` payload shape also resolves', () => {
    const edges = deriveCollabEdges(
      [started(), event('custom', { customType: 'AC_STATE_CHANGED', acId: 'ac-1', state: 'RUNNING' }, 800)],
      T0 + 800,
    );
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every(e => e.status === 'running')).toBe(true);
  });
});

describe('dedupeCollabEdges', () => {
  it('collapses A→B/B→A pairs to one edge (freshest wins)', () => {
    const edges = deriveCollabEdges([started(), acState('running', 1000)], T0 + 1000);
    const deduped = dedupeCollabEdges(edges);
    expect(deduped).toHaveLength(3); // 3 unordered pairs
    const keys = deduped.map(e => [e.source, e.target].sort().join('::')).sort();
    expect(keys).toEqual(['agent-a::agent-b', 'agent-a::agent-c', 'agent-b::agent-c']);
  });
});

function makeEdge(
  key: string,
  status: CollabEdge['status'],
  updatedAt: number,
  description?: string,
): CollabEdge {
  const [source, target] = key.split('->');
  return { key, source, target, status, updatedAt, ...(description !== undefined ? { description } : {}) };
}

describe('capCollabEdges', () => {
  it('returns all edges when at/under the cap', () => {
    const edges = [makeEdge('a->b', 'running', 1), makeEdge('a->c', 'forming', 2)];
    expect(capCollabEdges(edges, 12)).toHaveLength(2);
  });

  it('drops the oldest completed edges first when over the cap', () => {
    const edges: CollabEdge[] = [
      makeEdge('old->done', 'completed', 1),
      makeEdge('new->done', 'completed', 2),
      ...Array.from({ length: 11 }, (_, i) => makeEdge(`r${i}->x`, 'running', 10 + i)),
    ];
    const kept = capCollabEdges(edges, 12);
    expect(kept).toHaveLength(12);
    expect(kept.some(e => e.key === 'old->done')).toBe(false);
    expect(kept.some(e => e.key === 'new->done')).toBe(true);
    expect(kept.filter(e => e.status === 'running')).toHaveLength(11);
  });

  it('then drops oldest forming edges before touching running ones', () => {
    const edges: CollabEdge[] = [
      makeEdge('old->forming', 'forming', 1),
      ...Array.from({ length: 12 }, (_, i) => makeEdge(`r${i}->x`, 'running', 10 + i)),
    ];
    const kept = capCollabEdges(edges, 12);
    expect(kept).toHaveLength(12);
    expect(kept.every(e => e.status === 'running')).toBe(true);
  });
});

describe('filterRecentCollabEdges (R14 P0-3 default declutter)', () => {
  it('keeps only edges touched within the recent window', () => {
    const now = T0 + 100_000;
    const edges: CollabEdge[] = [
      makeEdge('fresh->a', 'running', now - COLLAB_RECENT_WINDOW_MS + 1),
      makeEdge('edge->of-window', 'running', now - COLLAB_RECENT_WINDOW_MS),
      makeEdge('stale->b', 'running', now - COLLAB_RECENT_WINDOW_MS - 1),
    ];
    const kept = filterRecentCollabEdges(edges, now);
    expect(kept.map(e => e.key)).toEqual(['fresh->a', 'edge->of-window']);
  });

  it('defaults to the 60s window and honors a custom one', () => {
    const now = T0;
    const edges: CollabEdge[] = [
      makeEdge('a->b', 'forming', now - 5_000),
      makeEdge('c->d', 'running', now - 90_000),
    ];
    expect(filterRecentCollabEdges(edges, now).map(e => e.key)).toEqual(['a->b']);
    expect(filterRecentCollabEdges(edges, now, 120_000).map(e => e.key)).toEqual([
      'a->b',
      'c->d',
    ]);
  });
});

describe('collabEdgesEqual (R31 F3 ticker gate)', () => {
  it('same reference is equal', () => {
    const edges = [makeEdge('a->b', 'running', T0)];
    expect(collabEdgesEqual(edges, edges)).toBe(true);
  });

  it('same content in the same order is equal across fresh derivations', () => {
    const a = [makeEdge('a->b', 'running', T0), makeEdge('c->d', 'forming', T0 - 5)];
    const b = [makeEdge('a->b', 'running', T0), makeEdge('c->d', 'forming', T0 - 5)];
    expect(a).not.toBe(b);
    expect(collabEdgesEqual(a, b)).toBe(true);
  });

  it('length, key, status, updatedAt, description and endpoint changes break equality', () => {
    const base = [makeEdge('a->b', 'running', T0, 'desc')];
    expect(collabEdgesEqual(base, [])).toBe(false);
    expect(collabEdgesEqual(base, [makeEdge('a->b', 'completed', T0, 'desc')])).toBe(false);
    expect(collabEdgesEqual(base, [makeEdge('a->b', 'running', T0 - 1, 'desc')])).toBe(false);
    expect(collabEdgesEqual(base, [makeEdge('a->b', 'running', T0, 'other')])).toBe(false);
    expect(collabEdgesEqual(base, [makeEdge('x->b', 'running', T0, 'desc')])).toBe(false);
    expect(collabEdgesEqual(base, [makeEdge('a->x', 'running', T0, 'desc')])).toBe(false);
  });

  it('order matters: same edges in a different order are NOT equal', () => {
    const a = [makeEdge('a->b', 'running', T0), makeEdge('c->d', 'running', T0)];
    const b = [makeEdge('c->d', 'running', T0), makeEdge('a->b', 'running', T0)];
    expect(collabEdgesEqual(a, b)).toBe(false);
  });
});
