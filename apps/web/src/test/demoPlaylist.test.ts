/**
 * Demo playlist helpers (R15-B2): scene extraction from scenario events and
 * the playability/next-scene rules the console player follows. Pure.
 */

import { describe, expect, it } from 'vitest';

import type { ScenarioEvent } from '../api/types';
import {
  demoPlayable,
  extractDemoEvents,
  MIN_DEMO_SCENES,
  nextSceneIndex,
  planStepChunks,
  stepToInChunks,
} from '../lib/demoPlaylist';

const ev = (id: string, type: string, zoneId: string, at: number): ScenarioEvent =>
  ({ id, type, zoneId, atSimTimeSec: at }) as ScenarioEvent;

describe('extractDemoEvents', () => {
  it('prefers demo-* events and orders by sim time', () => {
    const events = [
      ev('demo-b', 'temperature-spike', 'z2', 120),
      ev('demo-a', 'occupancy', 'z1', 60),
      ev('weather', 'weather-change', 'out', 46800),
    ];
    const scenes = extractDemoEvents(events);
    expect(scenes.map(s => s.id)).toEqual(['demo-a', 'demo-b']);
    expect(scenes[0]).toEqual({ id: 'demo-a', type: 'occupancy', zoneId: 'z1', atSimTimeSec: 60 });
  });

  it('falls back to all timed events when nothing is demo-prefixed (shenzhen script)', () => {
    const events = [
      ev('beat-1', 'occupancy', 'a', 10),
      ev('beat-2', 'temperature-rise', 'b', 20),
      ev('beat-3', 'occupancy', 'c', 30),
    ];
    expect(extractDemoEvents(events).map(s => s.id)).toEqual(['beat-1', 'beat-2', 'beat-3']);
  });

  it('drops events without a sim time (cannot be scheduled scenes)', () => {
    const events = [
      ev('demo-a', 'occupancy', 'z', 5),
      { id: 'demo-x', type: 'smoke', zoneId: 'z' } as ScenarioEvent,
    ];
    expect(extractDemoEvents(events).map(s => s.id)).toEqual(['demo-a']);
  });
});

describe('demoPlayable / nextSceneIndex', () => {
  const scenes = extractDemoEvents([
    ev('demo-a', 'occupancy', 'z', 60),
    ev('demo-b', 'temperature-spike', 'z', 120),
    ev('demo-c', 'temperature-normal', 'z', 300),
  ]);

  it('needs at least MIN_DEMO_SCENES and an un-elapsed script', () => {
    expect(MIN_DEMO_SCENES).toBe(3);
    expect(demoPlayable(scenes, 0)).toBe(true);
    expect(demoPlayable(scenes, 300)).toBe(false); // last scene already reached
    expect(demoPlayable(scenes, undefined)).toBe(false);
    expect(demoPlayable(scenes.slice(0, 2), 0)).toBe(false);
  });

  it('picks the first scene still in the future', () => {
    expect(nextSceneIndex(scenes, 0)).toBe(0);
    expect(nextSceneIndex(scenes, 60)).toBe(1);
    expect(nextSceneIndex(scenes, 150)).toBe(2);
    expect(nextSceneIndex(scenes, 500)).toBe(3); // finished
  });
});

// ---------------------------------------------------------------------------
// T-114: chunked step planning
// ---------------------------------------------------------------------------

describe('planStepChunks (T-114)', () => {
  it('a target at or under the cap is a single call', () => {
    expect(planStepChunks(600, 0, 1)).toEqual([600]); // exactly at the cap
    expect(planStepChunks(599, 0, 1)).toEqual([599]);
    expect(planStepChunks(180, 0, 1)).toEqual([180]);
  });

  it('a target over the cap splits into cap-sized chunks ending on the target', () => {
    const chunks = planStepChunks(28800, 0, 1); // fresh 1× sim → 08:00
    expect(chunks).toHaveLength(48);
    expect(chunks[0]).toBe(600);
    expect(chunks[chunks.length - 1]).toBe(28800);
    let prev = 0;
    for (const chunk of chunks) {
      expect(chunk - prev).toBeLessThanOrEqual(600);
      expect(chunk).toBeGreaterThan(prev);
      prev = chunk;
    }
  });

  it('scales chunk spans with the sim speed (speed 60 covers 08:00 in one call)', () => {
    expect(planStepChunks(28800, 0, 60)).toEqual([28800]); // 480 ticks ≤ 600
    const chunks = planStepChunks(28800, 0, 10);
    expect(chunks).toHaveLength(5); // 6000s per chunk
    expect(chunks).toEqual([6000, 12000, 18000, 24000, 28800]);
  });

  it('tolerates a speed change mid-walk (re-planning from the landed time)', () => {
    // First leg at speed 1, then the operator raises the speed to 10.
    const leg1 = planStepChunks(600, 0, 1);
    const leg2 = planStepChunks(28800, leg1[leg1.length - 1]!, 10);
    expect(leg1).toEqual([600]);
    expect(leg2[0]).toBe(6600);
    expect(leg2[leg2.length - 1]).toBe(28800);
  });

  it('returns nothing when already at/past the target or inputs are unusable', () => {
    expect(planStepChunks(100, 100, 1)).toEqual([]);
    expect(planStepChunks(50, 100, 1)).toEqual([]);
    expect(planStepChunks(NaN, 0, 1)).toEqual([]);
    expect(planStepChunks(100, 0, 0)).toEqual([]);
    expect(planStepChunks(100, 0, -5)).toEqual([]);
  });
});

describe('stepToInChunks (T-114)', () => {
  it('issues one call per chunk, paced by the landed sim time (overshoot-tolerant)', async () => {
    const calls: number[] = [];
    const landed = [601, 1201, 2500]; // each call overshoots its target by 1
    await stepToInChunks(
      2500,
      0,
      1,
      async target => {
        calls.push(target);
        return landed[calls.length - 1]!;
      },
      600,
    );
    // Chunks pace off the LANDED time (601, then 1201), each ≤600s; the
    // final chunk (1801) lands the walk on the target.
    expect(calls).toEqual([600, 1201, 1801]);
  });

  it('trips the guard instead of looping forever on a non-advancing clock', async () => {
    await expect(
      stepToInChunks(2500, 0, 1, async () => 0, 600, 5),
    ).rejects.toThrow('did not converge');
  });
});
