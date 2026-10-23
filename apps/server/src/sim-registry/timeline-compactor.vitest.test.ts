/**
 * @vitest-environment node
 *
 * Living-worlds P2 — timeline compactor correctness:
 *
 * 1. ROLLUP MATH vs raw: a fixture of zone-samples (known parameters across
 *    minutes), device-states and decision records is compacted; the rollup
 *    files' aggregates are recomputed BY HAND from the fixture and compared.
 * 2. CRASH SAFETY: a sweep stopped between rollup-write and raw-delete
 *    (beforeRawDelete throws) leaves rollup + raw; the NEXT sweep heals —
 *    deletes the raw WITHOUT duplicating the rollup (manifest idempotency).
 * 3. WINDOW BOUNDARIES: a sealed-but-in-window segment stays raw; the
 *    active segment is never compacted; legacy files roll like segments.
 * 4. GRAIN READS: raw inside the window, minute rollups beyond, `grain`
 *    labeled honestly ('raw' / 'raw+rollup').
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  sweepTrajectoryDir,
  type RollupManifest,
  type ZoneSampleRollupRecord,
  type DeviceStateRollupRecord,
  type DecisionRollupRecord,
} from './timeline-compactor.js';
import { simTimelineLog } from '../sim-timeline.js';
import { segmentedLogOf } from '@active-collaboration/core';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Fixed "now" for every sweep — deterministic staleness arithmetic. */
const NOW = Date.parse('2026-08-23T12:00:00Z');
const WINDOW = 7 * DAY_MS;

/** Zone-sample record at a controlled wall minute. */
function zoneSample(simId: string, isoMin: string, temp: number, occ?: number) {
  return {
    kind: 'zone-sample',
    environmentId: 'env-comp',
    simId,
    simTimeSec: 0,
    recordedAt: isoMin,
    zones: [{
      zoneId: 'zone-a',
      parameters: { temperature: temp },
      ...(occ !== undefined ? { occupancy: occ } : {}),
    }],
  };
}

function deviceState(simId: string, isoMin: string, deviceId: string, service: string) {
  return {
    kind: 'device-state',
    environmentId: 'env-comp',
    simId,
    simTimeSec: 1,
    recordedAt: isoMin,
    deviceId,
    service,
  };
}

/** Decision trajectory record (minimal shape the compactor folds). */
function decision(isoMin: string, decisionSource: string, decision: string) {
  return {
    recordedAt: isoMin,
    scenario: 'env-comp',
    eventId: `evt-${isoMin}`,
    agentId: 'agent-1',
    decision,
    decisionSource,
  };
}

/** Write raw files into a sim dir: 2 sealed timeline segments (stale), 1
 *  active (fresh), stale trajectory segment pair + active, legacy files. */
function buildFixtureDir(): { dir: string; staleMinOld: string; staleMinNew: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lwp2-compactor-'));
  const tlLog = simTimelineLog(dir);
  const trajLog = segmentedLogOf(dir, 'engine-runtime-iter0-env-comp-rule-only');

  // Timeline: sealed segment 1 (oldest stale minute), sealed segment 2
  // (newer stale minute), active segment 3 (in-window raw).
  const staleMinOld = '2026-08-10T10:20'; // 13 days before NOW
  const staleMinNew = '2026-08-15T08:41'; // 8 days before NOW (still stale)
  const freshMin = '2026-08-23T11:30'; // 30 min before NOW (in window)

  const seg1 = [
    zoneSample('sim-comp', `${staleMinOld}:00.000Z`, 20.0),
    zoneSample('sim-comp', `${staleMinOld}:30.000Z`, 22.0),
    deviceState('sim-comp', `${staleMinOld}:10.000Z`, 'dev-1', 'turn-on'),
    deviceState('sim-comp', `${staleMinOld}:20.000Z`, 'dev-1', 'set-temperature'),
    deviceState('sim-comp', `${staleMinOld}:40.000Z`, 'dev-2', 'turn-off'),
  ];
  const seg2 = [
    zoneSample('sim-comp', `${staleMinNew}:00.000Z`, 21.5, 3),
    zoneSample('sim-comp', `${staleMinNew}:30.000Z`, 19.5, 7),
    decision(`${staleMinNew}:05.000Z`, 'rule', 'initiate-ac'),
    decision(`${staleMinNew}:25.000Z`, 'rule', 'defer'),
    decision(`${staleMinNew}:45.000Z`, 'llm', 'collaborate'),
  ];
  const seg3 = [
    zoneSample('sim-comp', `${freshMin}:00.000Z`, 25.0),
    deviceState('sim-comp', `${freshMin}:10.000Z`, 'dev-1', 'turn-on'),
  ];

  mkdirSync(tlLog.segmentDir, { recursive: true });
  writeJsonl(join(tlLog.segmentDir, 'segment-000001.jsonl'), seg1);
  writeJsonl(join(tlLog.segmentDir, 'segment-000002.jsonl'), seg2);
  writeJsonl(join(tlLog.segmentDir, 'segment-000003.jsonl'), seg3);

  // Trajectory log: one stale sealed segment + fresh active.
  mkdirSync(trajLog.segmentDir, { recursive: true });
  writeJsonl(join(trajLog.segmentDir, 'segment-000001.jsonl'), [
    decision(`${staleMinOld}:00.000Z`, 'rule', 'initiate-ac'),
    decision(`${staleMinOld}:30.000Z`, 'llm', 'collaborate'),
    decision(`${staleMinOld}:50.000Z`, 'rule', 'initiate-ac'),
  ]);
  writeJsonl(join(trajLog.segmentDir, 'segment-000002.jsonl'), [
    decision(`${freshMin}:00.000Z`, 'rule', 'defer'),
  ]);

  // Legacy files: stale top-level sim-timeline.jsonl (pre-P2 residue).
  writeJsonl(tlLog.legacyFile, [zoneSample('sim-comp', '2026-08-09T00:00:00.000Z', 18.0)]);

  // Staleness by mtime: seal-times relative to NOW.
  backdate(join(tlLog.segmentDir, 'segment-000001.jsonl'), 13 * DAY_MS);
  backdate(join(tlLog.segmentDir, 'segment-000002.jsonl'), 8 * DAY_MS);
  backdate(tlLog.legacyFile, 14 * DAY_MS);
  backdate(join(trajLog.segmentDir, 'segment-000001.jsonl'), 13 * DAY_MS);
  // Active segments: FRESH mtimes (in-window), regardless of content.
  utimesSync(
    join(tlLog.segmentDir, 'segment-000003.jsonl'),
    new Date(NOW - 30 * 60 * 1000),
    new Date(NOW - 30 * 60 * 1000),
  );
  utimesSync(
    join(trajLog.segmentDir, 'segment-000002.jsonl'),
    new Date(NOW - 30 * 60 * 1000),
    new Date(NOW - 30 * 60 * 1000),
  );
  return { dir, staleMinOld, staleMinNew };
}

function writeJsonl(path: string, records: unknown[]): void {
  writeFileSync(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

function backdate(path: string, ageMs: number): void {
  const stamp = new Date(NOW - ageMs);
  utimesSync(path, stamp, stamp);
}

function readRollups(segmentDir: string): Array<{ manifest: RollupManifest; records: unknown[] }> {
  const out: Array<{ manifest: RollupManifest; records: unknown[] }> = [];
  const names = existsSync(segmentDir) ? readdirSync(segmentDir) : [];
  for (const name of names) {
    if (!name.startsWith('rollup-') || name.endsWith('.tmp')) continue;
    const lines = readFileSync(join(segmentDir, name), 'utf-8').split('\n').filter(Boolean);
    out.push({
      manifest: JSON.parse(lines[0]!) as RollupManifest,
      records: lines.slice(1).map(line => JSON.parse(line)),
    });
  }
  return out;
}

describe('timeline compactor (LW-P2)', () => {
  it('rollup math matches the raw fixture; raw deleted only after rollup exists', () => {
    const { dir, staleMinOld, staleMinNew } = buildFixtureDir();
    try {
      const result = sweepTrajectoryDir(dir, { rollupWindowMs: WINDOW, now: () => NOW });
      // Stale sealed timeline segments (2) + legacy timeline file (1) +
      // stale trajectory segment (1) = 4 rolled; 4 raw deleted.
      expect(result.rolledSegments).toBe(4);
      expect(result.deletedRawFiles).toBe(4);
      expect(result.rawBytesDeleted).toBeGreaterThan(result.rollupBytes); // compaction pays

      const tlRollups = readRollups(simTimelineLog(dir).segmentDir);
      expect(tlRollups).toHaveLength(1);
      const zoneAggs = tlRollups[0]!.records
        .filter(r => (r as { source?: string }).source === 'zone-sample') as ZoneSampleRollupRecord[];
      // Three stale minutes (two segment minutes + the legacy file's own
      // 2026-08-09 minute), one aggregate record each.
      expect(zoneAggs).toHaveLength(3);
      const oldAgg = zoneAggs.find(r => r.minuteStart === `${staleMinOld}:00.000Z`)!;
      const newAgg = zoneAggs.find(r => r.minuteStart === `${staleMinNew}:00.000Z`)!;
      // Hand-computed: old minute has temp samples 20.0 (legacy file's 18.0
      // is a DIFFERENT minute — 2026-08-09) → single-minute fold 20,22.
      expect(oldAgg.zones[0]!.parameters.temperature).toEqual({
        min: 20, max: 22, avg: 21, last: 22, count: 2,
      });
      // New stale minute: 21.5 (occ 3) + 19.5 (occ 7).
      expect(newAgg.zones[0]!.parameters.temperature).toEqual({
        min: 19.5, max: 21.5, avg: 20.5, last: 19.5, count: 2,
      });
      expect(newAgg.zones[0]!.occupancy).toEqual({ min: 3, max: 7, avg: 5, last: 7, count: 2 });
      // The legacy file's own minute rolled too (2026-08-09T00:00).
      expect(zoneAggs.some(r => r.minuteStart === '2026-08-09T00:00:00.000Z')).toBe(true);

      const devAggs = tlRollups[0]!.records
        .filter(r => (r as { source?: string }).source === 'device-state') as DeviceStateRollupRecord[];
      const devOld = devAggs.find(r => r.minuteStart === `${staleMinOld}:00.000Z`)!;
      expect(devOld.devices).toHaveLength(2);
      const dev1 = devOld.devices.find(d => d.deviceId === 'dev-1')!;
      expect(dev1.changes).toBe(2);
      expect(dev1.last.service).toBe('set-temperature'); // LAST, not first
      const dev2 = devOld.devices.find(d => d.deviceId === 'dev-2')!;
      expect(dev2.changes).toBe(1);

      // Trajectory decision rollups: stale minute counts by source/decision.
      const trajRollups = readRollups(
        join(dir, 'engine-runtime-iter0-env-comp-rule-only'),
      );
      expect(trajRollups).toHaveLength(1);
      const decAggs = trajRollups[0]!.records as DecisionRollupRecord[];
      const oldDec = decAggs.find(r => r.minuteStart === `${staleMinOld}:00.000Z`)!;
      expect(oldDec.counts).toEqual({ 'rule/initiate-ac': 2, 'llm/collaborate': 1 });
      expect(oldDec.decisions).toBe(3);

      // Raw beyond the window is gone; raw inside the window survives —
      // the ACTIVE segments are untouched.
      expect(existsSync(join(simTimelineLog(dir).segmentDir, 'segment-000001.jsonl'))).toBe(false);
      expect(existsSync(join(simTimelineLog(dir).segmentDir, 'segment-000002.jsonl'))).toBe(false);
      expect(existsSync(simTimelineLog(dir).legacyFile)).toBe(false);
      expect(existsSync(join(simTimelineLog(dir).segmentDir, 'segment-000003.jsonl'))).toBe(true);
      expect(existsSync(join(dir, 'engine-runtime-iter0-env-comp-rule-only', 'segment-000001.jsonl'))).toBe(false);
      expect(existsSync(join(dir, 'engine-runtime-iter0-env-comp-rule-only', 'segment-000002.jsonl'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('crash between rollup-write and raw-delete: next sweep heals without duplicating', () => {
    const { dir } = buildFixtureDir();
    const tlSegDir = simTimelineLog(dir).segmentDir;
    try {
      // "Crash": the sweep throws exactly after the rollup file is durable.
      expect(() =>
        sweepTrajectoryDir(dir, {
          rollupWindowMs: WINDOW,
          now: () => NOW,
          beforeRawDelete: () => {
            throw new Error('simulated crash after rollup, before raw delete');
          },
        }),
      ).toThrow('simulated crash');

      // Crash state: rollup EXISTS, raw still on disk.
      const rollupsAtCrash = readRollups(tlSegDir);
      expect(rollupsAtCrash).toHaveLength(1);
      expect(rollupsAtCrash[0]!.manifest.sources).toContain('segment-000001.jsonl');
      expect(existsSync(join(tlSegDir, 'segment-000001.jsonl'))).toBe(true);

      // Healing sweep (normal): raw leftovers deleted, NO duplicate rollup
      // for the timeline log (the trajectory log rolls for the first time —
      // its first sweep crashed before ITS rollup was written).
      const healed = sweepTrajectoryDir(dir, { rollupWindowMs: WINDOW, now: () => NOW });
      expect(healed.deletedRawFiles).toBe(4); // 2 timeline segs + legacy + trajectory seg
      expect(healed.rollupFilesWritten).toBe(1); // the trajectory log only
      expect(readRollups(tlSegDir)).toHaveLength(1); // no timeline duplicate
      expect(existsSync(join(tlSegDir, 'segment-000001.jsonl'))).toBe(false);
      expect(existsSync(join(tlSegDir, 'segment-000002.jsonl'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an in-window sealed segment stays raw (window boundary is conservative)', () => {
    const { dir } = buildFixtureDir();
    try {
      // Tighten the window to 10 days: seg2 (8 days old) becomes IN-window.
      sweepTrajectoryDir(dir, { rollupWindowMs: 10 * DAY_MS, now: () => NOW });
      const tlSegDir = simTimelineLog(dir).segmentDir;
      expect(existsSync(join(tlSegDir, 'segment-000002.jsonl'))).toBe(true); // straddler kept raw
      expect(existsSync(join(tlSegDir, 'segment-000001.jsonl'))).toBe(false); // 13d still stale
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('window=0-sized window disables nothing silently — sweeps are no-ops when window covers everything', () => {
    const { dir } = buildFixtureDir();
    try {
      const result = sweepTrajectoryDir(dir, { rollupWindowMs: 365 * DAY_MS, now: () => NOW });
      expect(result.rolledSegments).toBe(0);
      expect(result.rollupFilesWritten).toBe(0);
      expect(result.deletedRawFiles).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('grain-aware reads (LW-P2)', () => {
  it('raw inside the window, rollups beyond, grain labeled honestly', async () => {
    const { dir, staleMinNew } = buildFixtureDir();
    try {
      sweepTrajectoryDir(dir, { rollupWindowMs: WINDOW, now: () => NOW });

      const { readSimTimelineWithRollups } = await import('./timeline-compactor.js');
      // Cap above raw count (2) → rollups top up older history.
      const topped = await readSimTimelineWithRollups(dir, 50);
      expect(topped.grain).toBe('raw+rollup');
      expect(topped.rawCount).toBe(2);
      expect(topped.rollupCount).toBeGreaterThan(0);
      // Chronological: rollup minutes precede the raw tail.
      const kinds = topped.records.map(r => (r as { kind: string }).kind);
      expect(kinds.indexOf('rollup-1m')).toBeLessThan(kinds.lastIndexOf('zone-sample'));

      // Small cap (1): fully served by raw — grain stays 'raw' (the newest
      // raw record is seg3's device-state at 11:30:10).
      const rawOnly = await readSimTimelineWithRollups(dir, 1);
      expect(rawOnly.grain).toBe('raw');
      expect(rawOnly.records).toHaveLength(1);
      expect((rawOnly.records[0] as { kind: string }).kind).toBe('device-state');

      // Trajectory read: decision rollups labeled.
      const { readTrajectoryWithRollups } = await import('./timeline-compactor.js');
      const traj = await readTrajectoryWithRollups(dir, 50);
      expect(traj.grain).toBe('raw+rollup');
      const decRollups = traj.records.filter(
        r => (r as { kind?: string }).kind === 'rollup-1m',
      ) as DecisionRollupRecord[];
      expect(decRollups.some(r => r.counts['rule/initiate-ac'] === 2)).toBe(true);
      expect(staleMinNew).toBeTruthy(); // fixture sanity
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('empty dir reads as grain "none"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwp2-empty-'));
    try {
      const { readSimTimelineWithRollups } = await import('./timeline-compactor.js');
      const read = await readSimTimelineWithRollups(dir, 10);
      expect(read.grain).toBe('none');
      expect(read.records).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
