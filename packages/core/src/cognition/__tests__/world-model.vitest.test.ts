/**
 * World model (L1 Perception) — data structure + incremental store tests.
 *
 * Pins the bounded-ness invariants (§3.1) and the LEGACY-PROJECTION parity
 * of AgentWorldModelStore with the pre-cognition
 * CognitiveAgent.environmentStateSnapshot behavior (the projection the
 * Phase-2 unification must keep byte-compatible):
 *   - keyed `location:parameter`, overwrite keeps insertion position;
 *   - point query returns {value, timestamp} or {};
 *   - full query returns key → {value, location, timestamp};
 *   - boolean values survive unchanged.
 */

import { describe, expect, it } from 'vitest';
import {
  AgentWorldModelStore,
  WORLD_MODEL_EVENT_RING_CAP,
  WORLD_MODEL_PROMPT_EVENT_CAP,
} from '../world-model.js';

describe('AgentWorldModelStore — legacy parameter-face projections', () => {
  it('records a parameter and projects the legacy snapshot entry', () => {
    const store = new AgentWorldModelStore();
    const at = new Date('2026-08-26T10:00:00Z');
    store.applyEnvironmentParamChanged({
      location: 'zone-1',
      parameter: 'temperature',
      newValue: 28.5,
      timestamp: at,
    });

    const snapshot = store.projectEnvironmentSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toEqual({
      key: 'zone-1:temperature',
      value: 28.5,
      location: 'zone-1',
      timestamp: at,
    });
  });

  it('overwrites the same location:parameter key (single entry, latest value)', () => {
    const store = new AgentWorldModelStore();
    const t1 = new Date('2026-08-26T10:00:00Z');
    const t2 = new Date('2026-08-26T10:01:00Z');
    store.applyEnvironmentParamChanged({ location: 'zone-1', parameter: 'temperature', newValue: 20, timestamp: t1 });
    store.applyEnvironmentParamChanged({ location: 'zone-1', parameter: 'temperature', newValue: 22.5, timestamp: t2 });

    const snapshot = store.projectEnvironmentSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].value).toBe(22.5);
    expect(snapshot[0].timestamp).toBe(t2);
  });

  it('keeps insertion order when a key is overwritten (Map semantics parity)', () => {
    const store = new AgentWorldModelStore();
    const at = new Date();
    store.applyEnvironmentParamChanged({ location: 'zone-1', parameter: 'temperature', newValue: 26, timestamp: at });
    store.applyEnvironmentParamChanged({ location: 'zone-1', parameter: 'humidity', newValue: 65, timestamp: at });
    store.applyEnvironmentParamChanged({ location: 'zone-1', parameter: 'temperature', newValue: 27, timestamp: at });

    const keys = store.projectEnvironmentSnapshot().map(e => e.key);
    expect(keys).toEqual(['zone-1:temperature', 'zone-1:humidity']);
  });

  it('keeps boolean values unchanged', () => {
    const store = new AgentWorldModelStore();
    const at = new Date();
    store.applyEnvironmentParamChanged({ location: 'room-A', parameter: 'occupied', newValue: true, timestamp: at });

    const entry = store.projectEnvironmentSnapshot().find(e => e.key === 'room-A:occupied');
    expect(entry?.value).toBe(true);
  });

  it('ignores malformed updates (empty strings / missing fields)', () => {
    const store = new AgentWorldModelStore();
    store.applyEnvironmentParamChanged({ location: '', parameter: 'temperature', newValue: 1, timestamp: new Date() });
    store.applyEnvironmentParamChanged({ location: 'zone-1', parameter: '', newValue: 1, timestamp: new Date() });
    expect(store.projectEnvironmentSnapshot()).toHaveLength(0);
  });

  it('projectEnvironmentState point query returns {value, timestamp} or {}', () => {
    const store = new AgentWorldModelStore();
    const at = new Date();
    store.applyEnvironmentParamChanged({ location: 'zone-1', parameter: 'temperature', newValue: 26, timestamp: at });

    expect(store.projectEnvironmentState('temperature', 'zone-1')).toEqual({ value: 26, timestamp: at });
    expect(store.projectEnvironmentState('humidity', 'zone-1')).toEqual({});
  });

  it('projectEnvironmentState full query returns key → {value, location, timestamp} (legacy shape)', () => {
    const store = new AgentWorldModelStore();
    const at = new Date();
    store.applyEnvironmentParamChanged({ location: 'zone-1', parameter: 'temperature', newValue: 26, timestamp: at });

    const state = store.projectEnvironmentState();
    expect(Object.keys(state)).toEqual(['zone-1:temperature']);
    // Legacy parity: NO extra fields beyond the old Map's record shape.
    expect(state['zone-1:temperature']).toEqual({ value: 26, location: 'zone-1', timestamp: at });
  });
});

describe('AgentWorldModelStore — event ring (bounded working memory)', () => {
  it('returns the last N events in chronological order', () => {
    const store = new AgentWorldModelStore();
    for (let i = 0; i < WORLD_MODEL_PROMPT_EVENT_CAP + 3; i++) {
      store.recordEvent({ type: `evt-${i}`, simTimeSec: 100 + i });
    }
    const recent = store.recentEvents();
    expect(recent).toHaveLength(WORLD_MODEL_PROMPT_EVENT_CAP);
    expect(recent[0].type).toBe('evt-3');
    expect(recent[recent.length - 1].type).toBe(`evt-${WORLD_MODEL_PROMPT_EVENT_CAP + 2}`);
  });

  it('caps the ring at WORLD_MODEL_EVENT_RING_CAP (drop-oldest)', () => {
    const store = new AgentWorldModelStore();
    for (let i = 0; i < WORLD_MODEL_EVENT_RING_CAP + 10; i++) {
      store.recordEvent({ type: `evt-${i}`, simTimeSec: i });
    }
    // The ring never exceeds the cap even before slicing.
    expect(store.recentEvents(WORLD_MODEL_EVENT_RING_CAP + 50)).toHaveLength(WORLD_MODEL_EVENT_RING_CAP);
    expect(store.recentEvents(WORLD_MODEL_EVENT_RING_CAP + 50)[0].type)
      .toBe(`evt-${10}`);
  });

  it('stamps events with the provided simTimeSec and keeps zone/parameter/value', () => {
    const store = new AgentWorldModelStore();
    store.recordEvent({
      type: 'temperature-spike',
      zoneId: 'floor-1',
      parameter: 'temperature',
      value: 31.5,
      simTimeSec: 43210,
    });
    const [event] = store.recentEvents(1);
    expect(event).toEqual({
      type: 'temperature-spike',
      zoneId: 'floor-1',
      parameter: 'temperature',
      value: 31.5,
      simTimeSec: 43210,
    });
  });

  it('falls back to a monotonic wall-clock approximation when simTimeSec is unknown', () => {
    const store = new AgentWorldModelStore();
    store.recordEvent({ type: 'a' });
    store.recordEvent({ type: 'b' });
    const [a, b] = store.recentEvents(2);
    expect(a.simTimeSec).toBeLessThanOrEqual(b.simTimeSec);
    expect(a.simTimeSec).toBeGreaterThanOrEqual(0);
  });
});

describe('AgentWorldModelStore — zone parameter projection', () => {
  it('groups the parameter face per zone with parameter-name keys', () => {
    const store = new AgentWorldModelStore();
    const at = new Date();
    store.applyEnvironmentParamChanged({ location: 'floor-1', parameter: 'temperature', newValue: 29.3, timestamp: at });
    store.applyEnvironmentParamChanged({ location: 'floor-1', parameter: 'humidity', newValue: 60, timestamp: at });
    store.applyEnvironmentParamChanged({ location: 'floor-2', parameter: 'temperature', newValue: 25, timestamp: at });

    expect(store.zoneParameterProjection()).toEqual([
      { zoneId: 'floor-1', parameters: { temperature: 29.3, humidity: 60 } },
      { zoneId: 'floor-2', parameters: { temperature: 25 } },
    ]);
  });
});

describe('AgentWorldModelStore — clear()', () => {
  it('drops parameters and events', () => {
    const store = new AgentWorldModelStore();
    store.applyEnvironmentParamChanged({ location: 'z', parameter: 'temperature', newValue: 1, timestamp: new Date() });
    store.recordEvent({ type: 'e', simTimeSec: 1 });
    store.clear();
    expect(store.projectEnvironmentSnapshot()).toHaveLength(0);
    expect(store.recentEvents(100)).toHaveLength(0);
  });
});

describe('AgentWorldModelStore — parameter-face checkpoint (R40-C3)', () => {
  it('exports the face insertion-ordered with the capture sim-time stamp', () => {
    const store = new AgentWorldModelStore();
    const at = new Date();
    store.applyEnvironmentParamChanged({ location: 'zone-1', parameter: 'temperature', newValue: 26, timestamp: at });
    store.applyEnvironmentParamChanged({ location: 'zone-1', parameter: 'humidity', newValue: 60, timestamp: at });
    store.applyEnvironmentParamChanged({ location: 'zone-2', parameter: 'occupied', newValue: true, timestamp: at });
    // An overwrite keeps position, carries the latest value (Map parity).
    store.applyEnvironmentParamChanged({ location: 'zone-1', parameter: 'temperature', newValue: 27, timestamp: at });

    expect(store.exportParameterFace(43210)).toEqual({
      'zone-1:temperature': { value: 27, atSimTimeSec: 43210 },
      'zone-1:humidity': { value: 60, atSimTimeSec: 43210 },
      'zone-2:occupied': { value: true, atSimTimeSec: 43210 },
    });
  });

  it('restores a checkpointed face through the same write path (legacy projection survives)', () => {
    const store = new AgentWorldModelStore();
    const face = {
      'zone-1:temperature': { value: 27.5, atSimTimeSec: 40 },
      'zone-2:occupied': { value: true, atSimTimeSec: 40 },
    };
    store.restoreParameterFace(JSON.parse(JSON.stringify(face)));

    const snapshot = store.projectEnvironmentSnapshot();
    expect(snapshot.map(e => ({ key: e.key, value: e.value, location: e.location }))).toEqual([
      { key: 'zone-1:temperature', value: 27.5, location: 'zone-1' },
      { key: 'zone-2:occupied', value: true, location: 'zone-2' },
    ]);
    // The point-query projection works on restored entries too.
    expect(store.projectEnvironmentState('temperature', 'zone-1')).toEqual({ value: 27.5, timestamp: snapshot[0].timestamp });
  });

  it('restore is idempotent (a re-restore clears first, no duplicates)', () => {
    const store = new AgentWorldModelStore();
    const face = { 'zone-1:temperature': { value: 27.5, atSimTimeSec: 40 } };
    store.restoreParameterFace(face);
    store.restoreParameterFace(face);
    expect(store.projectEnvironmentSnapshot()).toHaveLength(1);
  });

  it('a missing face (pre-C3 checkpoint) is an honest no-op — the face starts empty', () => {
    const store = new AgentWorldModelStore();
    store.applyEnvironmentParamChanged({ location: 'zone-1', parameter: 'temperature', newValue: 26, timestamp: new Date() });
    // NOTE: a legacy restore on a LIVE store keeps what live observation
    // wrote; the no-op only skips the restore (fresh stores start empty).
    store.restoreParameterFace(undefined);
    expect(store.projectEnvironmentSnapshot()).toHaveLength(1);

    const fresh = new AgentWorldModelStore();
    fresh.restoreParameterFace(undefined);
    expect(fresh.projectEnvironmentSnapshot()).toHaveLength(0);
  });

  it('skips malformed checkpoint keys (no crash, honest partial restore)', () => {
    const store = new AgentWorldModelStore();
    store.restoreParameterFace({
      'zone-1:temperature': { value: 27.5, atSimTimeSec: 40 },
      'no-separator': { value: 1, atSimTimeSec: 40 },
      ':leading': { value: 2, atSimTimeSec: 40 },
      'trailing:': { value: 3, atSimTimeSec: 40 },
    } as never);
    const keys = store.projectEnvironmentSnapshot().map(e => e.key);
    expect(keys).toEqual(['zone-1:temperature']);
  });
});
