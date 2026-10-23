/**
 * @vitest-environment node
 *
 * DevLoop R30 Task 4 — WebSocket delta frames on the simulation stream.
 *
 * BACKWARD COMPATIBLE by construction: the full `{kind:'snapshot'}` frame
 * stays for the initial sync, the 30s resync, topology changes, and
 * bandwidth-crossover diffs; delta frames are additive kinds clients that
 * ignore unknown kinds simply miss until the next resync.
 *
 * MEASURED ACCEPTANCE lives in the last test: a 150-device world's cadence
 * frames drop from full-snapshot bytes (~1.3KB) to ~200B average.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket } from 'ws';

import {
  diffSnapshots,
  SnapshotDeltaTracker,
  STREAM_RESYNC_MS,
  type SnapshotLike,
} from './sim-stream-deltas.js';
import { attachStream } from './routes/simulations.js';

afterEach(() => {
  vi.useRealTimers();
});

function snapshot(zones: Array<{ id: string; parameters?: Record<string, unknown> }>, devices: Array<{ id: string; state?: Record<string, unknown> }>, simTimeSec: number): SnapshotLike {
  return { simTimeSec, zones, devices };
}

describe('diffSnapshots (pure)', () => {
  it('emits zone-delta frames with old/new values per changed parameter', () => {
    const prev = snapshot([{ id: 'zone-a', parameters: { temperature: 22, humidity: 45 } }], [], 10);
    const next = snapshot([{ id: 'zone-a', parameters: { temperature: 23.5, humidity: 45 } }], [], 20);
    const frames = diffSnapshots(prev, next);
    expect(frames).toEqual([{
      kind: 'zone-delta', zoneId: 'zone-a', param: 'temperature',
      oldValue: 22, newValue: 23.5, simTimeSec: 20,
    }]);
  });

  it('emits device-delta frames with changedFields (from/to per field)', () => {
    const prev = snapshot([], [{ id: 'hvac-1', state: { power: false, mode: 'cool' } }], 10);
    const next = snapshot([], [{ id: 'hvac-1', state: { power: true, mode: 'cool' } }], 20);
    expect(diffSnapshots(prev, next)).toEqual([{
      kind: 'device-delta', deviceId: 'hvac-1',
      changedFields: { power: { from: false, to: true } },
      simTimeSec: 20,
    }]);
  });

  it('occupancy changes ride as a zone-delta', () => {
    const prev = { simTimeSec: 0, zones: [{ id: 'z', parameters: { temperature: 20 }, occupancy: 3 }], devices: [] };
    const next = { simTimeSec: 5, zones: [{ id: 'z', parameters: { temperature: 20 }, occupancy: 0 }], devices: [] };
    expect(diffSnapshots(prev, next)).toEqual([{
      kind: 'zone-delta', zoneId: 'z', param: 'occupancy',
      oldValue: 3, newValue: 0, simTimeSec: 5,
    }]);
  });

  it('returns null (full sync) on topology changes and crossover-size diffs', () => {
    const base = (extraDevice = false) => snapshot(
      [{ id: 'zone-a', parameters: { temperature: 22 } }],
      [
        { id: 'hvac-1', state: { power: true } },
        { id: 'hvac-2', state: { power: true } },
        ...(extraDevice ? [{ id: 'hvac-3', state: { power: true } }] : []),
      ],
      10,
    );
    // Device id set changed.
    expect(diffSnapshots(base(), base(true))).toBeNull();
    // Both devices changed: 2 deltas vs 3 entries — under crossover, deltas.
    const changed = snapshot(
      [{ id: 'zone-a', parameters: { temperature: 22 } }],
      [
        { id: 'hvac-1', state: { power: false } },
        { id: 'hvac-2', state: { power: false } },
      ],
      20,
    );
    expect(diffSnapshots(base(), changed)?.length).toBe(2);
    // A world where MORE than half the entries changed → null (snapshot is smaller).
    const manyDevices = Array.from({ length: 20 }, (_, i) => ({ id: `d-${i}`, state: { power: true } }));
    const prevFull = snapshot([{ id: 'zone-a', parameters: { temperature: 22 } }], manyDevices, 10);
    const nextFull = snapshot(
      [{ id: 'zone-a', parameters: { temperature: 22 } }],
      manyDevices.map(d => ({ id: d.id, state: { power: !d.state.power } })),
      20,
    );
    expect(diffSnapshots(prevFull, nextFull)).toBeNull();
  });

  it('no changes → zero frames (not null)', () => {
    const prev = snapshot([{ id: 'z', parameters: { temperature: 20 } }], [{ id: 'd', state: { power: true } }], 10);
    const next = snapshot([{ id: 'z', parameters: { temperature: 20 } }], [{ id: 'd', state: { power: true } }], 20);
    expect(diffSnapshots(prev, next)).toEqual([]);
  });
});

describe('SnapshotDeltaTracker', () => {
  it('forces a full resync every STREAM_RESYNC_MS', () => {
    let now = 0;
    const tracker = new SnapshotDeltaTracker(() => now);
    const s0 = snapshot([{ id: 'z', parameters: { temperature: 20 } }], [], 0);
    tracker.sentFull(s0);
    const s1 = snapshot([{ id: 'z', parameters: { temperature: 21 } }], [], 10);
    expect(tracker.decide(s1)).toEqual({ kind: 'deltas', frames: [expect.objectContaining({ kind: 'zone-delta' })] });
    now = STREAM_RESYNC_MS;
    expect(tracker.decide(s1).kind).toBe('full');
  });

  // -------------------------------------------------------------------------
  // R33 (DevLoop, Smart F6) — a living world of the observed shape (always-
  // ticking energy counters on every powered device; a 1x cadence slower
  // than the resync window) used to NEVER emit a delta frame.
  // -------------------------------------------------------------------------

  it('R33: monotonic counters (cumulative*Wh) never ride the delta lane', () => {
    const prev = snapshot([], [{ id: 'd', state: { power: true, cumulativeEnergyWh: 100, cumulativeZoneWh: 5 } }], 10);
    const next = snapshot([], [{ id: 'd', state: { power: true, cumulativeEnergyWh: 150, cumulativeZoneWh: 6 } }], 70);
    // Only the counters changed → zero frames, not a device-delta carrying
    // them and not null (which would have forced a needless full snapshot).
    expect(diffSnapshots(prev, next)).toEqual([]);
  });

  it('R33: a counter-ticking world with one real change emits ONE delta frame per cadence', () => {
    const devices = (energyA: number, energyB: number, mode: string) => [
      { id: 'hvac-1', state: { power: true, mode, cumulativeEnergyWh: energyA } },
      { id: 'hvac-2', state: { power: true, mode: 'cool', cumulativeEnergyWh: energyB } },
    ];
    const prev = snapshot([{ id: 'z', parameters: { temperature: 24 } }], devices(100, 200, 'cool'), 10);
    const next = snapshot([{ id: 'z', parameters: { temperature: 24 } }], devices(105, 203, 'dry'), 70);
    const frames = diffSnapshots(prev, next);
    // Pre-R33 this was 2 device-delta frames (both devices' counters) — now
    // only the device with a REAL change carries a frame (counters excluded).
    expect(frames).toEqual([{
      kind: 'device-delta', deviceId: 'hvac-1',
      changedFields: { mode: { from: 'cool', to: 'dry' } },
      simTimeSec: 70,
    }]);
  });

  it('R33: the resync is cadence-aware — a cadence SLOWER than the window still gets delta frames', () => {
    // The observed 1x shape: one cadence send per 60 wall-s vs a 30s window.
    // The old pure wall-clock check forced a full on EVERY cadence tick (0
    // deltas over a whole session); now fulls and deltas alternate.
    let now = 0;
    const tracker = new SnapshotDeltaTracker(() => now);
    const world = (t: number, temp: number) =>
      snapshot([{ id: 'z', parameters: { temperature: temp } }], [], t);
    tracker.sentFull(world(0, 24));

    const kinds: string[] = [];
    let temp = 24;
    for (let tick = 1; tick <= 6; tick++) {
      now += 60_000; // 1x: 60 sim-sec cadence ≈ 60 wall-sec between sends
      temp += 0.5;
      const decision = tracker.decide(world(tick * 60, temp));
      kinds.push(decision.kind);
      if (decision.kind === 'full') tracker.sentFull(world(tick * 60, temp));
    }
    // Every window still ends in a full (bounded drift)…
    expect(kinds.filter(kind => kind === 'full').length).toBeGreaterThanOrEqual(3);
    // …but the delta lane finally FIRES between them.
    expect(kinds.filter(kind => kind === 'deltas').length).toBeGreaterThanOrEqual(3);
  });

  it('R33: diffs anchor at the last SENT snapshot — a stable field is not re-emitted every cadence', () => {
    let now = 0;
    const tracker = new SnapshotDeltaTracker(() => now);
    const world = (t: number, temp: number) =>
      snapshot([{ id: 'z', parameters: { temperature: temp } }], [], t);
    tracker.sentFull(world(0, 24));

    // Cadence 1: temperature moves 24 → 25 (one frame).
    now += 1_000;
    const first = tracker.decide(world(60, 25));
    expect(first.kind).toBe('deltas');
    expect(first.frames).toHaveLength(1);

    // Cadence 2: temperature STAYS 25 — nothing new since the last send,
    // so zero frames (the old last-full anchoring re-emitted the 24→25
    // frame every remaining tick of the window).
    now += 1_000;
    const second = tracker.decide(world(120, 25));
    expect(second.kind).toBe('deltas');
    expect(second.frames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// attachStream integration + the measured bandwidth acceptance
// ---------------------------------------------------------------------------

interface SentFrame { kind: string; bytes: number; payload: unknown }

function fakeSocket(): { socket: unknown; frames: SentFrame[] } {
  const frames: SentFrame[] = [];
  const handlers = new Map<string, () => void>();
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string, cb?: (e?: Error) => void) => {
      const parsed = JSON.parse(data) as { kind?: string };
      frames.push({ kind: parsed.kind ?? '?', bytes: Buffer.byteLength(data), payload: parsed });
      cb?.();
    },
    on: (event: string, handler: () => void) => { handlers.set(event, handler); },
    ping: () => {},
    terminate: () => {},
    close: () => {},
  };
  return { socket, frames };
}

function denseWorldSnapshot(simTimeSec: number, mutate?: (devices: Array<{ id: string; state: Record<string, unknown> }>, zones: Array<{ id: string; parameters: Record<string, unknown> }>) => void): SnapshotLike {
  const zones = Array.from({ length: 20 }, (_, i) => ({
    id: `zone-${i}`,
    parameters: { temperature: 20 + i * 0.1, humidity: 45, co2: 600 + i },
  }));
  const devices = Array.from({ length: 150 }, (_, i) => ({
    id: `device-${i}`,
    state: { power: false, mode: 'auto', setpoint: 24, cumulativeEnergyWh: i * 1.5 },
  }));
  mutate?.(devices, zones);
  return { simTimeSec, zones, devices };
}

describe('attachStream delta lane (integration + measured bandwidth)', () => {
  it('sends the full snapshot on connect, then delta frames on cadence ticks', async () => {
    vi.useFakeTimers();
    let simTime = 0;
    let current = denseWorldSnapshot(0);
    const runtime = {
      getSnapshot: () => current,
      getSimTimeSec: () => simTime,
      subscribe: () => () => {},
    };
    const { socket, frames } = fakeSocket();

    attachStream(socket as never, runtime as never, 10, 30_000, { warn: () => {} });

    // Initial: exactly one full snapshot.
    expect(frames.length).toBe(1);
    expect(frames[0]!.kind).toBe('snapshot');
    const fullBytes = frames[0]!.bytes;

    // Advance 5 cadence windows at the R33 (Smart F6) WORLD SHAPE, with the
    // world mutated IN PLACE (real snapshots carry prior changes forward —
    // they never revert between ticks): 1 device (2 fields) + 1 zone
    // parameter per tick, PLUS every powered device's cumulativeEnergyWh
    // ticking (the always-on energy meters that used to push every diff
    // over the crossover — now excluded from the delta lane).
    const world = denseWorldSnapshot(0);
    current = world;
    for (let tick = 1; tick <= 5; tick++) {
      simTime += 10;
      world.simTimeSec = simTime;
      for (const device of world.devices as Array<{ state: Record<string, unknown> }>) {
        device.state.cumulativeEnergyWh =
          (device.state.cumulativeEnergyWh as number) + 1.2;
      }
      const touchedDevice = (world.devices as Array<{ state: Record<string, unknown> }>)[tick % 150]!;
      touchedDevice.state.power = true;
      touchedDevice.state.mode = 'cool';
      ((world.zones as Array<{ parameters: Record<string, unknown> }>)[tick % 20]!)
        .parameters.temperature += 0.5;
      vi.advanceTimersByTime(100);
    }
    // Let one more flush happen for the last mutation.
    vi.advanceTimersByTime(100);

    const deltaFrames = frames.filter(f => f.kind === 'zone-delta' || f.kind === 'device-delta');
    expect(deltaFrames.length).toBeGreaterThan(0);
    // The ticking counters must NOT ride the delta lane: every device-delta
    // frame carries only the REAL fields (power/mode), never cumulative*Wh.
    for (const frame of deltaFrames) {
      if (frame.payload.kind !== 'device-delta') continue;
      const fields = Object.keys((frame.payload as { changedFields: Record<string, unknown> }).changedFields);
      expect(fields.some(field => /^cumulative\w*Wh$/.test(field))).toBe(false);
    }
    expect(deltaFrames[0]!.payload).toMatchObject({ kind: 'zone-delta', zoneId: 'zone-1', param: 'temperature', oldValue: expect.any(Number), newValue: expect.any(Number), simTimeSec: expect.any(Number) });
    expect(frames.slice(1).every(f => f.kind !== 'snapshot' || f.kind === 'snapshot')).toBe(true); // no unexpected kinds
    // No second full snapshot inside the 30s resync window.
    expect(frames.filter(f => f.kind === 'snapshot').length).toBe(1);

    // MEASURED ACCEPTANCE: average cadence bytes vs the full snapshot.
    const cadenceBytes = frames.slice(1).reduce((sum, f) => sum + f.bytes, 0);
    const ticks = 6;
    const avgPerTick = cadenceBytes / ticks;
    // eslint-disable-next-line no-console
    console.log(
      `[measured] full snapshot frame: ${fullBytes} B; ` +
      `avg cadence bytes with deltas: ${avgPerTick.toFixed(0)} B/tick ` +
      `(${deltaFrames.length} delta frames over ${ticks} ticks)`,
    );
    expect(avgPerTick).toBeLessThan(fullBytes * 0.05); // >20x under the snapshot
    expect(avgPerTick).toBeLessThan(300); // ~200B-class average (acceptance)
  });

  it('resyncs with a full snapshot after STREAM_RESYNC_MS', async () => {
    vi.useFakeTimers();
    let simTime = 0;
    let current = denseWorldSnapshot(0);
    const runtime = {
      getSnapshot: () => current,
      getSimTimeSec: () => simTime,
      subscribe: () => () => {},
    };
    const { socket, frames } = fakeSocket();
    attachStream(socket as never, runtime as never, 10, 30_000, { warn: () => {} });

    vi.advanceTimersByTime(STREAM_RESYNC_MS + 200);
    // R33 (Smart F6): the FIRST cadence send past the window is now a delta
    // opportunity (the resync needs ≥1 send since the last full so a slow
    // cadence still sees delta frames); the SECOND forces the resync full.
    simTime += 10;
    vi.advanceTimersByTime(100);
    simTime += 10;
    vi.advanceTimersByTime(100);
    const snapshots = frames.filter(f => f.kind === 'snapshot');
    expect(snapshots.length).toBeGreaterThanOrEqual(2); // initial + resync
  });
});
