/**
 * agentActivity (UX-W4) — 决策信号 → campus-3d avatar 迁移目标的纯函数测试。
 * 组件与 Babylon 层只消费这里的映射（tsc 覆盖），判定全部在此直测。
 */

import { describe, expect, it } from 'vitest';

import type { EnvZone, RuntimeDecisionRecord } from '../api/types';
import {
  AGENT_ACTIVITY_TTL_MS,
  activityAnchorForZone,
  agentActivityTargets,
} from '../lib/agentActivity';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');

function decision(partial: {
  agentId: string;
  at: string;
  zoneId?: string;
  decision?: string;
}): RuntimeDecisionRecord {
  return {
    agentId: partial.agentId,
    eventId: `evt-${partial.agentId}-${partial.at}`,
    eventType: 'smoke',
    decision: partial.decision ?? 'handle_independently',
    decisionSource: 'llm',
    at: partial.at,
    ...(partial.zoneId !== undefined ? { zoneId: partial.zoneId } : {}),
  };
}

function zone(partial: Partial<EnvZone> & { id: string }): EnvZone {
  return { ...partial };
}

describe('agentActivityTargets', () => {
  it('maps the latest zoned decision per agent (ring order = time order)', () => {
    const targets = agentActivityTargets(
      [
        decision({ agentId: 'a1', zoneId: 'z-old', at: '2026-10-03T11:59:50.000Z' }),
        decision({ agentId: 'a1', zoneId: 'z-new', at: '2026-10-03T11:59:58.000Z' }),
        decision({ agentId: 'a2', zoneId: 'z-a2', at: '2026-10-03T11:59:55.000Z' }),
      ],
      NOW,
    );
    expect(targets.get('a1')?.zoneId).toBe('z-new');
    expect(targets.get('a2')?.zoneId).toBe('z-a2');
  });

  it('expires decisions past the TTL (agent drifts home on the caller side)', () => {
    const staleAt = new Date(NOW - AGENT_ACTIVITY_TTL_MS - 1000).toISOString();
    const targets = agentActivityTargets(
      [decision({ agentId: 'a1', zoneId: 'z1', at: staleAt })],
      NOW,
    );
    expect(targets.size).toBe(0);
  });

  it('keeps a decision exactly at the TTL edge', () => {
    const edgeAt = new Date(NOW - AGENT_ACTIVITY_TTL_MS).toISOString();
    const targets = agentActivityTargets(
      [decision({ agentId: 'a1', zoneId: 'z1', at: edgeAt })],
      NOW,
    );
    expect(targets.get('a1')?.zoneId).toBe('z1');
  });

  it('ignores decisions without a zoneId and records with unparseable timestamps', () => {
    const targets = agentActivityTargets(
      [
        decision({ agentId: 'a1', at: '2026-10-03T11:59:58.000Z' }),
        decision({ agentId: 'a2', zoneId: 'z1', at: 'not-a-date' }),
      ],
      NOW,
    );
    expect(targets.size).toBe(0);
  });

  it('a fresh zone-less decision does NOT shadow an older zoned one (latest ZONED wins)', () => {
    const targets = agentActivityTargets(
      [
        decision({ agentId: 'a1', zoneId: 'z1', at: '2026-10-03T11:59:50.000Z' }),
        decision({ agentId: 'a1', at: '2026-10-03T11:59:58.000Z' }),
      ],
      NOW,
    );
    expect(targets.get('a1')?.zoneId).toBe('z1');
  });
});

describe('activityAnchorForZone', () => {
  it('anchors at the zone centroid, mid-storey height (agentPlacements geometry)', () => {
    const target = zone({
      id: 'z1',
      floor: 2,
      bounds: { minX: 10, maxX: 20, minY: 30, maxY: 40 },
    });
    const anchor = activityAnchorForZone(target, { storeyHeight: 3.5 });
    expect(anchor).not.toBeNull();
    expect(anchor!.x).toBeCloseTo(15, 10);
    expect(anchor!.z).toBeCloseTo(35, 10);
    // floor 2 → 2 × 3.5 + 3.5/2 = 8.75（层中，与辖区锚点同一套几何）。
    expect(anchor!.y).toBeCloseTo(8.75, 10);
  });

  it('returns null for a zone without any geometry (honest no-move)', () => {
    expect(activityAnchorForZone(zone({ id: 'z-nogeo' }), { storeyHeight: 3.5 })).toBeNull();
    expect(activityAnchorForZone(undefined, { storeyHeight: 3.5 })).toBeNull();
  });
});
