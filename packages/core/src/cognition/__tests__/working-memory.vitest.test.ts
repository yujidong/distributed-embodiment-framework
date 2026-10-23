/**
 * Working memory (§3.4) — per-round lifecycle, bounded-ness, previous
 * decision carry-over, and the deterministic world-model diff.
 */

import { describe, expect, it } from 'vitest';
import {
  WORKING_MEMORY_CHANGES_CAP,
  WorkingMemoryStore,
  diffWorldModels,
} from '../working-memory.js';
import { buildAgentWorldModel } from '../world-model-builder.js';
import type { AgentWorldModel } from '../world-model.js';

function model(overrides: Partial<Parameters<typeof buildAgentWorldModel>[0]> = {}): AgentWorldModel {
  return buildAgentWorldModel({
    agentId: 'a1',
    capabilities: ['temperature-control'],
    devices: [],
    zones: [],
    events: [],
    simTimeSec: 100,
    ...overrides,
  });
}

describe('WorkingMemoryStore — round lifecycle', () => {
  it('first round has no previous decision and reports initial perception', () => {
    const store = new WorkingMemoryStore();
    const wm = store.beginRound(model({ zones: [{ zoneId: 'z1', parameters: { temperature: 22 }, adjacentZoneIds: [] }] }));

    expect(wm.previousDecision).toBeUndefined();
    expect(wm.situationChanges).toEqual(['initial perception: 1 zone(s), 0 recent event(s)']);
    expect(wm.simTimeSec).toBe(100);
    expect(store.current()).toBe(wm);
  });

  it('records a decision and surfaces it as the NEXT round\'s PREVIOUS_DECISION', () => {
    const store = new WorkingMemoryStore();
    store.beginRound(model());
    store.recordDecision({ action: 'handle_independently', outcome: 'acted', atSimTimeSec: 100 });

    const round2 = store.beginRound(model({ simTimeSec: 200 }));
    expect(round2.previousDecision).toEqual({
      action: 'handle_independently',
      outcome: 'acted',
      atSimTimeSec: 100,
    });
    expect(round2.simTimeSec).toBe(200);
  });

  it('only the open round is kept current — no history accumulation', () => {
    const store = new WorkingMemoryStore();
    for (let i = 0; i < 10; i++) {
      store.beginRound(model({ simTimeSec: i }));
    }
    expect(store.current()?.simTimeSec).toBe(9);
  });

  it('clear() drops round state', () => {
    const store = new WorkingMemoryStore();
    store.beginRound(model());
    store.recordDecision({ action: 'defer', outcome: 'deferred' });
    store.clear();
    expect(store.current()).toBeUndefined();
    const next = store.beginRound(model());
    expect(next.previousDecision).toBeUndefined();
    expect(next.situationChanges).toEqual([]); // no prior model → initial with 0 zones/events
  });
});

describe('WorkingMemoryStore — diff-baseline checkpoint (R40-C2 record-replay parity)', () => {
  it('peekPreviousZoneFace is undefined before any round and carries the last round\'s zones', () => {
    const store = new WorkingMemoryStore();
    expect(store.peekPreviousZoneFace()).toBeUndefined();
    store.beginRound(model({
      zones: [
        { zoneId: 'z1', parameters: { temperature: 22 }, adjacentZoneIds: [] },
        { zoneId: 'z2', parameters: { humidity: 50 }, adjacentZoneIds: [] },
      ],
    }));
    expect(store.peekPreviousZoneFace()).toEqual([
      { zoneId: 'z1', parameters: { temperature: 22 } },
      { zoneId: 'z2', parameters: { humidity: 50 } },
    ]);
  });

  it('restorePreviousZoneFace makes a resumed store diff like the continuous run (JSON round-trip)', () => {
    // Continuous run: round 1 sees z1.temp=22; round 2 sees z1.temp=25.
    const continuous = new WorkingMemoryStore();
    continuous.beginRound(model({ zones: [{ zoneId: 'z1', parameters: { temperature: 22 }, adjacentZoneIds: [] }] }));
    const checkpointed = continuous.peekPreviousZoneFace();
    const round2Model = model({
      simTimeSec: 200,
      zones: [{ zoneId: 'z1', parameters: { temperature: 25 }, adjacentZoneIds: [] }],
    });
    const continuousChanges = continuous.beginRound(round2Model).situationChanges;
    expect(continuousChanges).toEqual(['zone z1.temperature: 22 → 25']);

    // Resumed run (fresh store, checkpoint through JSON): the first round
    // diffs against the RESTORED baseline, not "initial perception".
    const resumed = new WorkingMemoryStore();
    resumed.restorePreviousZoneFace(
      JSON.parse(JSON.stringify(checkpointed)) as typeof checkpointed,
    );
    expect(resumed.beginRound(round2Model).situationChanges).toEqual(continuousChanges);
  });

  it('restorePreviousZoneFace(null) clears the baseline (pre-C2 checkpoint: honest initial perception)', () => {
    const store = new WorkingMemoryStore();
    store.beginRound(model({ zones: [{ zoneId: 'z1', parameters: { temperature: 22 }, adjacentZoneIds: [] }] }));
    store.restorePreviousZoneFace(null);
    expect(store.peekPreviousZoneFace()).toBeUndefined();
    const round = store.beginRound(model({
      zones: [{ zoneId: 'z1', parameters: { temperature: 30 }, adjacentZoneIds: [] }],
    }));
    expect(round.situationChanges).toEqual(['initial perception: 1 zone(s), 0 recent event(s)']);
  });
});

describe('diffWorldModels', () => {
  it('reports parameter changes, additions and removals per zone', () => {
    const prev = model({ zones: [{ zoneId: 'z1', parameters: { temperature: 22, humidity: 50 }, adjacentZoneIds: [] }] });
    const next = model({
      simTimeSec: 101,
      zones: [{ zoneId: 'z1', parameters: { temperature: 24, co2: 700 }, adjacentZoneIds: [] }],
    });
    expect(diffWorldModels(prev, next)).toEqual([
      'zone z1.temperature: 22 → 24',
      'zone z1.co2=700 (new)',
      'zone z1.humidity: no longer reported',
    ]);
  });

  it('reports newly visible zones', () => {
    const prev = model({ zones: [] });
    const next = model({ zones: [{ zoneId: 'z2', parameters: {}, adjacentZoneIds: [] }] });
    expect(diffWorldModels(prev, next)).toEqual(['zone z2: now visible']);
  });

  it('returns an empty diff for identical models', () => {
    const a = model({ zones: [{ zoneId: 'z1', parameters: { temperature: 22 }, adjacentZoneIds: [] }] });
    const b = model({ zones: [{ zoneId: 'z1', parameters: { temperature: 22 }, adjacentZoneIds: [] }] });
    expect(diffWorldModels(a, b)).toEqual([]);
  });

  it('caps the diff at WORKING_MEMORY_CHANGES_CAP with an honest truncation marker', () => {
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    for (let i = 0; i < WORKING_MEMORY_CHANGES_CAP + 5; i++) {
      before[`p${i}`] = i;
      after[`p${i}`] = i + 100;
    }
    const prev = model({ zones: [{ zoneId: 'z1', parameters: before, adjacentZoneIds: [] }] });
    const next = model({ zones: [{ zoneId: 'z1', parameters: after, adjacentZoneIds: [] }] });
    const diff = diffWorldModels(prev, next);
    expect(diff).toHaveLength(WORKING_MEMORY_CHANGES_CAP + 1);
    expect(diff[diff.length - 1]).toMatch(/truncated/);
  });
});
