/**
 * @vitest-environment node
 *
 * Snapshot shaping tests — T-012 size caps.
 *
 * Full-state snapshots are re-serialized to every WebSocket subscriber at
 * the snapshot cadence; the two sections that grow over a run are
 * recentDecisions (ring buffer fills to 50, each record carries full
 * reasoning) and scheduledEvents (large env-bridged scenarios). The caps
 * bound the payload; consumers only read the newest decisions and the next
 * upcoming events.
 */

import { describe, it, expect } from 'vitest';

import { EngineRuntime } from '../EngineRuntime.js';
import { loadScenarioFile } from '../../scenario/index.js';
import {
  buildEngineSnapshot,
  buildZoneEnvSnapshot,
  MAX_SNAPSHOT_RECENT_DECISIONS,
  MAX_SNAPSHOT_SCHEDULED_EVENTS,
  type SnapshotInput,
} from './snapshot.js';

function makeInput(overrides: {
  recentDecisions?: SnapshotInput['recentDecisions'];
  firedEventIds?: Set<string>;
  eventCount?: number;
}): SnapshotInput {
  const eventCount = overrides.eventCount ?? 0;
  const scenario = loadScenarioFile({
    version: '1.0',
    meta: { id: 'shaping-test', name: 'Shaping Test Scenario' },
    zones: [{ id: 'zone-a', name: 'Zone A' }],
    devices: [],
    agents: [],
    events: Array.from({ length: eventCount }, (_, i) => ({
      id: `evt-${i}`,
      type: 'temperature-spike',
      zoneId: 'zone-a',
      parameter: 'temperature',
      value: 30 + (i % 5),
      atSimTimeSec: i * 10,
    })),
  });
  return {
    runtimeId: 'rt-test',
    scenario,
    state: 'running',
    simTimeSec: 1234,
    simTimeIso: '2026-08-22T00:00:00.000Z',
    speed: 30,
    tickCount: 100,
    lastTickWallMs: 0,
    autoThrottled: false,
    tickMs: 10,
    getParameterValue: () => undefined,
    zoneOccupancy: new Map(),
    devicesById: new Map(),
    getDeviceFault: () => null,
    agents: new Map(),
    agentRuntimeInfo: new Map(),
    reputationSummarize: () => ({ overallScore: 0, totalAttempts: 0, topCapabilities: [] }),
    recentDecisions: overrides.recentDecisions ?? [],
    firedEventIds: overrides.firedEventIds ?? new Set<string>(),
    serviceRegistrations: [],
    llmCache: null,
    llmErrors: 0,
    triage: null,
  };
}

function decision(i: number) {
  return {
    agentId: 'agent-a',
    eventId: `event-${i}`,
    eventType: 'temperature-spike',
    decision: 'collaborate',
    decisionSource: 'rule',
    reasoning: `reasoning ${i}`,
    at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
  };
}

describe('buildEngineSnapshot size caps (T-012)', () => {
  it('keeps only the newest recentDecisions (ring holds 50, snapshot caps at 20)', () => {
    const input = makeInput({
      recentDecisions: Array.from({ length: 50 }, (_, i) => decision(i)),
    });
    const snapshot = buildEngineSnapshot(input);

    expect(snapshot.recentDecisions).toHaveLength(MAX_SNAPSHOT_RECENT_DECISIONS);
    // Newest win: the last 20 of the ring, chronological order preserved.
    expect(snapshot.recentDecisions.map(d => d.eventId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `event-${30 + i}`),
    );
  });

  it('leaves a short recentDecisions list untouched', () => {
    const input = makeInput({
      recentDecisions: [decision(0), decision(1), decision(2)],
    });
    expect(buildEngineSnapshot(input).recentDecisions).toHaveLength(3);
  });

  it('passes scheduledEvents through untouched at or below the cap (declaration order)', () => {
    const snapshot = buildEngineSnapshot(makeInput({ eventCount: 10 }));
    expect(snapshot.scheduledEvents.map(e => e.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `evt-${i}`),
    );
  });

  it('caps scheduledEvents to the next 50 upcoming, soonest first', () => {
    // 60 unfired events at sim times 0..590 — the 50 soonest survive.
    const snapshot = buildEngineSnapshot(makeInput({ eventCount: 60 }));
    expect(snapshot.scheduledEvents).toHaveLength(MAX_SNAPSHOT_SCHEDULED_EVENTS);
    expect(snapshot.scheduledEvents.map(e => e.atSimTimeSec)).toEqual(
      Array.from({ length: 50 }, (_, i) => i * 10),
    );
    expect(snapshot.scheduledEvents.every(e => !e.fired)).toBe(true);
  });

  it('fills leftover scheduledEvents slots with the most recently fired events', () => {
    // Events 0..49 have fired, 50..59 are upcoming — all 10 upcoming plus
    // the 40 most recently fired (highest atSimTimeSec) stay within 50.
    const fired = new Set(Array.from({ length: 50 }, (_, i) => `evt-${i}`));
    const snapshot = buildEngineSnapshot(makeInput({ eventCount: 60, firedEventIds: fired }));

    expect(snapshot.scheduledEvents).toHaveLength(MAX_SNAPSHOT_SCHEDULED_EVENTS);
    const ids = snapshot.scheduledEvents.map(e => e.id);
    // Upcoming first (soonest first), then fired filler (latest first).
    expect(ids.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `evt-${50 + i}`));
    expect(ids.slice(10)).toEqual(
      Array.from({ length: 40 }, (_, i) => `evt-${49 - i}`),
    );
  });
});

describe('buildLlmSnapshot llmErrors (T-105)', () => {
  it('exposes failed LLM decision calls in the llm section', () => {
    const input = { ...makeInput({}), llmErrors: 3 };
    const snapshot = buildEngineSnapshot(input);

    expect(snapshot.llm?.llmErrors).toBe(3);
  });

  it('omits the llm section when nothing LLM-related is active and no calls failed', () => {
    expect(buildEngineSnapshot(makeInput({})).llm).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T43 (R4) — the window speed face (Batch 3 T32's server half): the snapshot
// emits `effectiveSpeedWindowPerSec`/`effectiveSpeedWindowSec` beside the
// instantaneous estimate, ONLY while running AND once the sampler has data —
// the CLI renders "instant / window avg" and was previously fed nothing.
// ---------------------------------------------------------------------------

describe('buildEngineSnapshot window speed face (T43)', () => {
  it('emits both window fields when running with sampler stats', () => {
    const snapshot = buildEngineSnapshot({
      ...makeInput({}),
      lastTickWallMs: 40,
      speedWindow: { perSec: 28.4, windowSec: 60 },
    });

    expect(snapshot.effectiveSpeedPerSec).toBeDefined(); // instantaneous face unchanged
    expect(snapshot.effectiveSpeedWindowPerSec).toBeCloseTo(28.4, 10);
    expect(snapshot.effectiveSpeedWindowSec).toBe(60);
  });

  it('omits the window fields when the sampler has no stats (<2 intervals)', () => {
    const snapshot = buildEngineSnapshot({
      ...makeInput({}),
      lastTickWallMs: 40,
    });

    expect(snapshot.effectiveSpeedPerSec).toBeDefined();
    expect(snapshot.effectiveSpeedWindowPerSec).toBeUndefined();
    expect(snapshot.effectiveSpeedWindowSec).toBeUndefined();
  });

  it('omits both speed faces when paused (honest "—" over a fake 0)', () => {
    const snapshot = buildEngineSnapshot({
      ...makeInput({}),
      state: 'paused',
      lastTickWallMs: 40,
      speedWindow: { perSec: 28.4, windowSec: 60 },
    });

    expect(snapshot.effectiveSpeedPerSec).toBeUndefined();
    expect(snapshot.effectiveSpeedWindowPerSec).toBeUndefined();
    expect(snapshot.effectiveSpeedWindowSec).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T-304 (DevLoop R12, EN-F05) — custom baseline parameters in the zone snapshot
// ---------------------------------------------------------------------------

describe('buildZoneEnvSnapshot custom baseline parameters (T-304)', () => {
  const reader = (parameter: string, zoneId: string): number | boolean | undefined => {
    const seeded: Record<string, Record<string, number | boolean>> = {
      'roof': { temperature: 25, powerW: 38000, pvOutputW: 8000 },
      'room': { temperature: 22 },
    };
    return seeded[zoneId]?.[parameter];
  };

  it('exposes declared baseline keys alongside the standard parameters', () => {
    const snapshot = buildZoneEnvSnapshot(
      [
        { id: 'roof', baseline: { temperature: 25, powerW: 38000, pvOutputW: 8000 } },
        { id: 'room', baseline: { temperature: 22 } },
      ],
      { getParameterValue: reader, zoneOccupancy: new Map() },
    );
    const roof = snapshot.roof as Record<string, number | boolean>;
    expect(roof.powerW).toBe(38000);
    expect(roof.pvOutputW).toBe(8000);
    expect(roof.temperature).toBe(25);
    // A zone WITHOUT the custom baseline does not carry it.
    const room = snapshot.room as Record<string, number | boolean>;
    expect(room.powerW).toBeUndefined();
    expect(room.pvOutputW).toBeUndefined();
  });

  it('zones without custom baselines carry exactly the standard parameter set (size unaffected)', () => {
    const snapshot = buildZoneEnvSnapshot(
      [{ id: 'room' }, { id: 'lab' }],
      { getParameterValue: () => undefined, zoneOccupancy: new Map() },
    );
    expect(Object.keys(snapshot.room)).toEqual([]);
    expect(Object.keys(snapshot.lab)).toEqual([]);
  });
});

// ============================================================================
// T3 (R2, B1-11): the real-advancement face — tickMs + effectiveSpeedPerSec
// ============================================================================

describe('T3: snapshot carries the real-advancement fields (R2 B1-11)', () => {
  it('tickMs rides the snapshot; effectiveSpeedPerSec divides by the SCHEDULER formula', () => {
    const input = makeInput({});
    const snap = buildEngineSnapshot(input);
    expect(snap.tickMs).toBe(10);
    // No completed tick yet → honestly absent, never a fake 100% estimate.
    expect(snap.effectiveSpeedPerSec).toBeUndefined();

    // A throttled tick (100ms wall vs 10ms budget): the effective rate must
    // use the EXACT delay formula the tick loop schedules with
    // (EngineRuntime.nextTickDelay = max(tickMs, ceil(wall×1.2)+1)).
    const throttled = buildEngineSnapshot({ ...input, lastTickWallMs: 100, autoThrottled: true });
    const expectedDelaySec = EngineRuntime.nextTickDelay(10, 100) / 1000;
    expect(throttled.autoThrottled).toBe(true);
    expect(throttled.effectiveSpeedPerSec).toBeCloseTo(input.speed / expectedDelaySec, 10);
  });

  it('effectiveSpeedPerSec is absent when not running (pause shows "—", not 0)', () => {
    const snap = buildEngineSnapshot({ ...makeInput({}), state: 'paused', lastTickWallMs: 100 });
    expect(snap.effectiveSpeedPerSec).toBeUndefined();
    expect(snap.tickMs).toBe(10);
  });
});
