/**
 * @vitest-environment node
 *
 * T-011 trajectory disk GC — three layers, each tested at its own seam:
 *
 * 1. per-SEGMENT cap (Living-worlds P2): appendSimTimelineRecord writes the
 *    size-segmented log `<dir>/sim-timeline/segment-<n>.jsonl` — the active
 *    segment rotates at maxFileBytes (never rewritten, so no data is dropped;
 *    the read side stitches segments transparently, equivalence pinned in
 *    sim-timeline-segments.vitest.test.ts);
 * 2. per-dir GC: a record LEAVING the registry (stopAndRemove, or
 *    pruneStoppedRecords beyond the 50-stopped cap) takes its registry-managed
 *    `<trajectoryDir>/<simId>/` dir with it — while plain stop() keeps both
 *    the record and its dir queryable, and explicit options.trajectoryDir
 *    overrides are caller-owned and survive;
 * 3. boot sweep: cleanupOldTrajectories removes sim dirs whose NEWEST file
 *    (not just the dir mtime — appends don't bump dir mtimes, and P2 moved
 *    append targets into segment SUBDIRS) is older than the retention
 *    window; buildServer runs it with EAF_TRAJECTORY_MAX_AGE_DAYS
 *    (default 7, 0 disables).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { appendSimTimelineRecord, readSimTimelineRecords, SIM_TIMELINE_FILE, simTimelineLog, type ZoneSampleRecord } from './sim-timeline.js';
import { listSegmentFiles } from '@active-collaboration/core';
import { cleanupOldTrajectories } from './simulation-registry.js';
import { buildServer } from './server.js';
import { createUserScenario, makeTestApp, type TestAppContext } from './test-utils.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Minimal zone-sample record (~165 bytes serialized). */
function zoneSample(simId: string, seq: number): ZoneSampleRecord {
  return {
    kind: 'zone-sample',
    environmentId: 'env-gc',
    simId,
    simTimeSec: seq * 60,
    recordedAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    zones: [{ zoneId: `zone-${seq % 3}`, parameters: { seq } }],
  };
}

/** Backdate a path's atime/mtime (simulates a dir left by a previous run). */
function backdate(path: string, now: number, ageMs: number): void {
  const stamp = new Date(now - ageMs);
  utimesSync(path, stamp, stamp);
}

// ---------------------------------------------------------------------------
// 1. Per-file cap (sim-timeline.ts)
// ---------------------------------------------------------------------------

describe('sim-timeline per-segment cap (T-011 → P2 rotation)', () => {
  it('rotates sealed segments at the cap without rewriting them — no record is dropped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-tl-cap-'));
    try {
      const cap = 2048; // ~12 records of ~165 bytes
      const sealedBytes: number[] = [];
      for (let i = 0; i < 60; i++) {
        appendSimTimelineRecord(dir, zoneSample('sim-cap', i), {
          maxFileBytes: cap,
          onRotate: info => { sealedBytes.push(statSync(info.sealedPath).size); },
        });
      }

      // Multiple segments exist; every sealed one is within the cap (the
      // pre-append rotation may overshoot by at most one record, never a
      // full doubling — the same bounded-overshoot rule as the old trim).
      const segments = listSegmentFiles(simTimelineLog(dir));
      expect(segments.length).toBeGreaterThan(1);
      for (const path of segments.slice(0, -1)) {
        expect(statSync(path).size).toBeLessThanOrEqual(cap + 512);
      }
      expect(sealedBytes.length).toBe(segments.length - 1);

      // Rotation never rewrites: every recorded sealed size still matches
      // the file on disk, and NOTHING was dropped — all 60 records read back
      // (the T-011 trim dropped the head; the P2 segment log keeps it).
      for (let i = 0; i < sealedBytes.length; i++) {
        expect(statSync(segments[i]!).size).toBe(sealedBytes[i]);
      }
      const records = await readSimTimelineRecords(dir, 500);
      expect(records).toHaveLength(60);
      const seqs = records.map(record => record.kind === 'zone-sample'
        ? record.zones[0]!.parameters.seq as number : -1);
      expect(seqs[0]).toBe(0);
      expect(seqs[59]).toBe(59);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps every record in a single segment while it stays under the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-tl-keep-'));
    try {
      for (let i = 0; i < 8; i++) {
        appendSimTimelineRecord(dir, zoneSample('sim-keep', i), { maxFileBytes: 1024 * 1024 });
      }
      const segments = listSegmentFiles(simTimelineLog(dir));
      expect(segments).toHaveLength(1);
      const records = await readSimTimelineRecords(dir, 500);
      expect(records).toHaveLength(8);
      const first = records[0];
      expect(first?.kind === 'zone-sample' ? first.zones[0]?.parameters.seq : undefined).toBe(0);
      // The legacy single file is never created by the P2 writer.
      expect(existsSync(join(dir, SIM_TIMELINE_FILE))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Boot sweep (simulation-registry.ts, unit)
// ---------------------------------------------------------------------------

describe('cleanupOldTrajectories (T-011 boot sweep)', () => {
  it('removes only stale sim dirs; fresh sims, non-sim entries and loose files survive', () => {
    const base = mkdtempSync(join(tmpdir(), 'traj-sweep-'));
    try {
      const now = Date.now();
      const oldSim = join(base, 'sim-orphan-old');
      mkdirSync(oldSim);
      writeFileSync(join(oldSim, SIM_TIMELINE_FILE), '{"kind":"zone-sample"}\n');
      backdate(oldSim, now, 8 * DAY_MS);
      backdate(join(oldSim, SIM_TIMELINE_FILE), now, 8 * DAY_MS);

      mkdirSync(join(base, 'sim-orphan-new')); // fresh — inside the window

      const stranger = join(base, 'not-a-sim'); // stale but not registry-managed
      mkdirSync(stranger);
      backdate(stranger, now, 30 * DAY_MS);
      writeFileSync(join(base, 'loose.txt'), 'x');
      backdate(join(base, 'loose.txt'), now, 30 * DAY_MS);

      const result = cleanupOldTrajectories(base, 7 * DAY_MS, now);
      expect(result).toEqual({ removed: 1, kept: 1 });
      expect(existsSync(oldSim)).toBe(false);
      expect(existsSync(join(base, 'sim-orphan-new'))).toBe(true);
      expect(existsSync(stranger)).toBe(true);
      expect(existsSync(join(base, 'loose.txt'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('keeps a dir whose dir-mtime is old but whose newest FILE is fresh (long-running sim)', () => {
    const base = mkdtempSync(join(tmpdir(), 'traj-sweep-mtime-'));
    try {
      const now = Date.now();
      const sim = join(base, 'sim-longrun');
      mkdirSync(sim);
      const filePath = join(sim, 'trajectory.jsonl');
      writeFileSync(filePath, '{}\n');
      backdate(sim, now, 30 * DAY_MS); // dir created a month ago…
      // …but its timeline was appended seconds before the restart.
      utimesSync(filePath, new Date(now - 1000), new Date(now - 1000));

      const result = cleanupOldTrajectories(base, 7 * DAY_MS, now);
      expect(result.removed).toBe(0);
      expect(existsSync(sim)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('treats a missing base dir as empty and never throws', () => {
    expect(cleanupOldTrajectories(join(tmpdir(), 'traj-sweep-missing-'), 7 * DAY_MS))
      .toEqual({ removed: 0, kept: 0 });
  });
});

// ---------------------------------------------------------------------------
// 2. Per-dir GC (registry) + boot-sweep wiring (server)
// ---------------------------------------------------------------------------

/** Two-zone scenario mirroring the simulation suite fixture. */
function labScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'GC Lab' },
    zones: [
      { id: 'zone-a', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      { id: 'temp-sensor-a', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: 'zone-a' },
    ],
    agents: [
      {
        id: 'sensor-agent',
        name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
      },
    ],
    events: [],
  };
}

describe('registry trajectory dir GC (T-011)', () => {
  let ctx: TestAppContext;
  let app: FastifyInstance;
  let trajectoryDir: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    app = ctx.app;
    trajectoryDir = ctx.trajectoryDir;
    const res = await createUserScenario(app, labScenario('gc-lab'));
    expect(res.statusCode).toBe(201);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createSimulation(payload: Record<string, unknown> = { scenarioId: 'gc-lab' }): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/simulations', payload });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it('stopAndRemove deletes the registry-managed trajectory dir', async () => {
    const id = await createSimulation();
    expect(existsSync(join(trajectoryDir, id))).toBe(true);
    app.simulations.stopAndRemove(id);
    expect(app.simulations.has(id)).toBe(false);
    expect(existsSync(join(trajectoryDir, id))).toBe(false);
  });

  it('stop() keeps both the record and its trajectory dir (queryable)', async () => {
    const id = await createSimulation();
    app.simulations.stop(id);
    expect(app.simulations.has(id)).toBe(true);
    expect(existsSync(join(trajectoryDir, id))).toBe(true);
  });

  it('leaves an explicit options.trajectoryDir override to its owner', async () => {
    const overrideDir = mkdtempSync(join(tmpdir(), 'traj-gc-override-'));
    try {
      const id = await createSimulation({ scenarioId: 'gc-lab', options: { trajectoryDir: overrideDir } });
      app.simulations.stopAndRemove(id);
      expect(existsSync(overrideDir)).toBe(true);
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  // 52 sequential sim creations + a full server boot: legit I/O-heavy, and the
  // vitest default 5s budget turns machine load into spurious timeouts.
  it('prunes the OLDEST stopped records beyond the cap — and their dirs follow', { timeout: 60_000 }, async () => {
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) {
      const id = await createSimulation();
      app.simulations.stop(id); // each stop prunes stopped records beyond 50
      ids.push(id);
    }
    // The two oldest records (and their dirs) are gone…
    expect(app.simulations.has(ids[0]!)).toBe(false);
    expect(app.simulations.has(ids[1]!)).toBe(false);
    expect(existsSync(join(trajectoryDir, ids[0]!))).toBe(false);
    expect(existsSync(join(trajectoryDir, ids[1]!))).toBe(false);
    // …the 50 newest stop here, records and dirs alike.
    expect(app.simulations.has(ids[2]!)).toBe(true);
    expect(existsSync(join(trajectoryDir, ids[2]!))).toBe(true);
    expect(app.simulations.has(ids[51]!)).toBe(true);
    expect(existsSync(join(trajectoryDir, ids[51]!))).toBe(true);
  });
});

describe('server boot sweeps stale trajectory dirs (T-011)', () => {
  it('buildServer ages out orphaned sim dirs beyond the retention window', { timeout: 60_000 }, async () => {
    const base = mkdtempSync(join(tmpdir(), 'traj-gc-boot-'));
    const userDir = mkdtempSync(join(tmpdir(), 'traj-gc-boot-store-'));
    const now = Date.now();

    const stale = join(base, 'sim-orphan-stale');
    mkdirSync(stale);
    writeFileSync(join(stale, SIM_TIMELINE_FILE), '{"kind":"zone-sample"}\n');
    backdate(stale, now, 9 * DAY_MS);
    backdate(join(stale, SIM_TIMELINE_FILE), now, 9 * DAY_MS);
    const fresh = join(base, 'sim-orphan-fresh');
    mkdirSync(fresh);

    const app = await buildServer({
      trajectoryDir: base,
      userDir,
      logger: false,
      databasePath: ':memory:',
      rateLimitEnabled: false,
    });
    try {
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      await app.close();
      rmSync(base, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    }
  });
});
