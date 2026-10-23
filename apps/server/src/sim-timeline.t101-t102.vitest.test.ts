/**
 * @vitest-environment node
 *
 * DevLoop R32 Lane B tests — T-101 + T-102 timeline correctness.
 *
 * T-101 (F-PH23): the wall-clock zone sampler cannot fire while a sim is
 * paused; after a manual POST /step the sim advanced (physics moved) with NO
 * zone-sample landing in the timeline. The manual lane
 * (`recordStepZoneSamples` → `ZoneSampleRecorder.sampleIfDue(true)`) must
 * sample paused/created sims, respect the sim-time cadence gate (no
 * duplicates at a frozen sim time), and skip stopped sims.
 *
 * T-102 (F-PH24): one command legitimately arrives on BOTH bus seams
 * (DEVICE_STATE_CHANGE and DEVICE_OPERATION_EXECUTED, ~2ms apart — R29
 * measured 23/28 timeline keys duplicated). The recorder-level
 * `DeviceStateDedupe` must keep the FIRST record and drop the echo; at the
 * SEAMS level, emitting the same command on both event types must land
 * exactly ONE device-state record.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventType, type EngineRuntime } from '@active-collaboration/core';

import {
  DeviceStateDedupe,
  DEVICE_STATE_DEDUPE_WINDOW_MS,
  ZoneSampleRecorder,
  closeSimTimelineWriter,
  flushAllSimTimelineWriters,
  forEachSimTimelineRecord,
  recordStepZoneSamples,
  startZoneSampler,
  type SimTimelineRecord,
} from './sim-timeline.js';
import { SimulationSeams } from './sim-registry/seams.js';
import type { SimulationRecord } from './sim-registry/types.js';

/** Minimal EngineRuntime stub — only the surface the timeline seams touch. */
function stubRuntime(overrides: Partial<{
  state: 'created' | 'running' | 'paused' | 'stopped';
  simTimeSec: number;
  zones: Array<{ id: string; parameters: Record<string, number> }>;
}> = {}): EngineRuntime & { emit: (type: EventType, payload: unknown) => void } {
  const subscribers: Array<{ fn: (event: { type: EventType; payload: unknown }) => void; types?: EventType[] }> = [];
  const state = () => overrides.state ?? 'paused';
  return {
    subscribe: ((fn: never, types?: EventType[]) => {
      subscribers.push({ fn, types });
    }) as never,
    emit(type: EventType, payload: unknown) {
      for (const s of subscribers) {
        if (s.types === undefined || s.types.includes(type)) {
          (s.fn as (e: { type: EventType; payload: unknown }) => void)({ type, payload });
        }
      }
    },
    getState: state as never,
    getSimTimeSec: () => overrides.simTimeSec ?? 0,
    getSnapshot: () => ({
      zones: overrides.zones ?? [{ id: 'zone-1', parameters: { temperature: 25 } }],
    }) as never,
    onFlowRun: vi.fn(),
  } as unknown as EngineRuntime & { emit: (type: EventType, payload: unknown) => void };
}

describe('T-102: DeviceStateDedupe (recorder-level)', () => {
  it('admits the first record and drops the near-simultaneous echo', () => {
    const d = new DeviceStateDedupe({ now: () => 1000 });
    const key = DeviceStateDedupe.keyOf({ simTimeSec: 42, deviceId: 'dev-1', service: 'turn-on' });
    expect(d.admit(key)).toBe(true);   // device's own emission
    expect(d.admit(key)).toBe(false);  // coordinator echo ~2ms later
    expect(d.admit(key)).toBe(false);  // and any further echo in the window
  });

  it('re-admits after the window expires (a later, genuinely distinct record)', () => {
    let t = 1000;
    const d = new DeviceStateDedupe({ now: () => t });
    const key = DeviceStateDedupe.keyOf({ simTimeSec: 42, deviceId: 'dev-1', service: 'turn-on' });
    expect(d.admit(key)).toBe(true);
    t += DEVICE_STATE_DEDUPE_WINDOW_MS + 1;
    expect(d.admit(key)).toBe(true);
  });

  it('distinguishes keys by (simTimeSec, deviceId, service)', () => {
    const d = new DeviceStateDedupe({ now: () => 1000 });
    expect(d.admit(DeviceStateDedupe.keyOf({ simTimeSec: 42, deviceId: 'dev-1', service: 'turn-on' }))).toBe(true);
    // same device+time, different service → distinct command
    expect(d.admit(DeviceStateDedupe.keyOf({ simTimeSec: 42, deviceId: 'dev-1', service: 'set-mode' }))).toBe(true);
    // same service+device, next sim tick → distinct command
    expect(d.admit(DeviceStateDedupe.keyOf({ simTimeSec: 43, deviceId: 'dev-1', service: 'turn-on' }))).toBe(true);
    // same time+service, other device → distinct command
    expect(d.admit(DeviceStateDedupe.keyOf({ simTimeSec: 42, deviceId: 'dev-2', service: 'turn-on' }))).toBe(true);
    // undefined service keys consistently (empty string component)
    expect(d.admit(DeviceStateDedupe.keyOf({ simTimeSec: 42, deviceId: 'dev-3' }))).toBe(true);
    expect(d.admit(DeviceStateDedupe.keyOf({ simTimeSec: 42, deviceId: 'dev-3' }))).toBe(false);
  });

  it('hard-caps remembered keys (oldest evicted, never grows unbounded)', () => {
    let t = 0;
    const d = new DeviceStateDedupe({ now: () => t, maxKeys: 3 });
    for (let i = 0; i < 3; i++) {
      expect(d.admit(`k${i}`)).toBe(true);
    }
    // Inserting a 4th key evicts k0 (oldest) — k0 becomes admissible again.
    expect(d.admit('k3')).toBe(true);
    expect(d.admit('k0')).toBe(true);
  });
});

describe('T-101 + T-102: seams-level timeline behavior', () => {
  let dir: string;
  const SIM = 'sim-t101-test';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eaf-t101-'));
  });

  afterEach(() => {
    closeSimTimelineWriter(SIM); // drains the batch lane before we read
    rmSync(dir, { recursive: true, force: true });
  });

  function seamsWith(runtime: EngineRuntime): void {
    const seams = new SimulationSeams({
      zoneSampleEverySimSec: 60,
      simTimelineMaxBytes: 1024 * 1024,
      rollupWindowMs: 0, // compaction off for the test
    });
    const record = {
      id: SIM,
      runtime,
      environmentId: 'env-1',
      trajectoryDir: dir,
    } as unknown as SimulationRecord;
    seams.attach(record);
  }

  async function records(): Promise<SimTimelineRecord[]> {
    // Drain the batch lane WITHOUT retiring it — closeSimTimelineWriter also
    // removes the zone sampler (the sampler dies with the writer lane), which
    // would silently turn later manual /step samples into no-ops.
    flushAllSimTimelineWriters();
    const out: SimTimelineRecord[] = [];
    await forEachSimTimelineRecord(dir, r => out.push(r));
    return out;
  }

  it('T-102: one command on BOTH bus seams lands exactly ONE device-state record', async () => {
    const runtime = stubRuntime({ simTimeSec: 120 });
    seamsWith(runtime);

    // The same command, as the two bus seams deliver it ~2ms apart.
    const command = { deviceId: 'hvac-1', service: 'set-temperature', params: { temperature: 20 }, actor: 'user:alice' };
    runtime.emit(EventType.DEVICE_STATE_CHANGE, command);
    runtime.emit(EventType.DEVICE_OPERATION_EXECUTED, { ...command, result: { success: true } });

    // A DIFFERENT command at the same sim time still lands (distinct service).
    runtime.emit(EventType.DEVICE_STATE_CHANGE, { deviceId: 'hvac-1', service: 'set-mode', params: { mode: 'cooling' } });

    const recs = await records();
    const deviceStates = recs.filter(r => r.kind === 'device-state');
    expect(deviceStates).toHaveLength(2);
    expect(deviceStates.filter(r => r.service === 'set-temperature')).toHaveLength(1);
    expect(deviceStates.filter(r => r.service === 'set-mode')).toHaveLength(1);
  });

  it('T-102: failed operations are not state changes (no record)', async () => {
    const runtime = stubRuntime({ simTimeSec: 120 });
    seamsWith(runtime);
    runtime.emit(EventType.DEVICE_OPERATION_EXECUTED, {
      deviceId: 'hvac-1', service: 'set-temperature', success: false, error: 'param out of range',
    });
    const recs = await records();
    expect(recs.filter(r => r.kind === 'device-state')).toHaveLength(0);
  });

  it('T-101: a stepped (paused) sim gets its zone sample via the manual lane', async () => {
    let simTime = 0;
    const runtime = stubRuntime({
      state: 'paused',
      simTimeSec: 0,
      zones: [{ id: 'zone-1', parameters: { temperature: 24.5 } }],
    });
    // startZoneSampler is what the registry lane uses; it registers the
    // manual-lane recorder under the sim id.
    const stop = startZoneSampler({
      runtime, dir, environmentId: 'env-1', simId: SIM, everySimSec: 60,
    });
    try {
      // /step advanced sim time 0 → 65 (past the 60s cadence gate); the sim
      // stays paused so the wall-clock lane will NEVER fire.
      simTime = 65;
      vi.spyOn(runtime, 'getSimTimeSec').mockImplementation(() => simTime);
      recordStepZoneSamples(SIM);

      const recs = await records();
      const samples = recs.filter(r => r.kind === 'zone-sample');
      expect(samples).toHaveLength(1);
      expect(samples[0]!.simTimeSec).toBe(65);
      expect(samples[0]!.zones[0]!.parameters.temperature).toBe(24.5);

      // Second /step within the cadence window (65 → 100 < next 120 gate):
      // NO duplicate at the same frozen gate.
      simTime = 100;
      recordStepZoneSamples(SIM);
      const recs2 = await records();
      expect(recs2.filter(r => r.kind === 'zone-sample')).toHaveLength(1);

      // Past the next cadence gate (120): the manual lane samples again.
      simTime = 125;
      recordStepZoneSamples(SIM);
      const fs = await import('node:fs');
      // eslint-disable-next-line no-console

      const recs3 = await records();
      expect(recs3.filter(r => r.kind === 'zone-sample')).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it('T-101: unknown sim is a no-op; stopped sim never samples', async () => {
    expect(() => recordStepZoneSamples('no-such-sim')).not.toThrow();
    expect(await records()).toHaveLength(0);

    const runtime = stubRuntime({ state: 'stopped', simTimeSec: 500 });
    const recorder = new ZoneSampleRecorder({
      runtime, dir, environmentId: 'env-1', simId: SIM, everySimSec: 60,
    });
    expect(recorder.sampleIfDue(true)).toBe(false);
    expect(await records()).toHaveLength(0);
  });

  it('T-101: the wall-clock lane (manual=false) does not sample a paused sim', () => {
    const runtime = stubRuntime({ state: 'paused', simTimeSec: 0 });
    const recorder = new ZoneSampleRecorder({
      runtime, dir, environmentId: 'env-1', simId: SIM, everySimSec: 60,
    });
    expect(recorder.sampleIfDue(false)).toBe(false);
  });
});
