/**
 * @vitest-environment node
 *
 * Living-worlds P2 — sim-timeline segmented-log equivalence (the P0-style
 * invariant): a run written with a HUGE segment cap (one segment) and the
 * SAME run written with a TINY cap (many segments) must read back
 * identically through readSimTimelineRecords — the reader stitches segments
 * transparently, the existing read API's behavior is unchanged.
 *
 * Also pins:
 * - the legacy pre-P2 single file (`sim-timeline.jsonl`) stitches in as the
 *   OLDEST segment (migration: old dirs keep reading, new appends go to
 *   segments);
 * - `maxFileBytes <= 0` disables rotation (one unbounded segment);
 * - the replay scanner (iterSimJsonlFiles) walks segment subdirs and NEVER
 *   yields rollup files (the P2 replay invariant: aggregate grain must not
 *   enter replay);
 * - torn half-lines (crash residue) are skipped in stitched reads.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appendSimTimelineRecord,
  readSimTimelineRecords,
  SIM_TIMELINE_FILE,
  simTimelineLog,
  type DeviceStateRecord,
  type ZoneSampleRecord,
} from './sim-timeline.js';
import { listSegmentFiles } from '@active-collaboration/core';
import { iterSimJsonlFiles } from './replay-service.js';

/** Minimal zone-sample record (~165 bytes serialized). */
function zoneSample(simId: string, seq: number): ZoneSampleRecord {
  return {
    kind: 'zone-sample',
    environmentId: 'env-seg',
    simId,
    simTimeSec: seq * 60,
    recordedAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    zones: [{ zoneId: `zone-${seq % 3}`, parameters: { seq, temperature: 18 + (seq % 5) } }],
  };
}

/** Minimal device-state record. */
function deviceState(simId: string, seq: number): DeviceStateRecord {
  return {
    kind: 'device-state',
    environmentId: 'env-seg',
    simId,
    simTimeSec: seq * 10,
    recordedAt: new Date(1_700_000_000_500 + seq * 1000).toISOString(),
    deviceId: `device-${seq % 2}`,
    service: seq % 2 === 0 ? 'turn-on' : 'set-temperature',
  };
}

function runRecords(simId: string): Array<ZoneSampleRecord | DeviceStateRecord> {
  const records: Array<ZoneSampleRecord | DeviceStateRecord> = [];
  for (let i = 0; i < 40; i++) {
    records.push(zoneSample(simId, i));
    records.push(deviceState(simId, i));
  }
  return records;
}

describe('sim-timeline segmented log (LW-P2)', () => {
  it('EQUIVALENCE: a segmented run reads back identically to a single-segment run', async () => {
    const singleDir = mkdtempSync(join(tmpdir(), 'sim-seg-single-'));
    const multiDir = mkdtempSync(join(tmpdir(), 'sim-seg-multi-'));
    try {
      const records = runRecords('sim-equiv');
      for (const record of records) {
        // No effective cap → one segment.
        appendSimTimelineRecord(singleDir, record, { maxFileBytes: 0 });
        // Tiny cap (~3 records/segment) → many segments.
        appendSimTimelineRecord(multiDir, record, { maxFileBytes: 600 });
      }
      expect(listSegmentFiles(simTimelineLog(singleDir))).toHaveLength(1);
      const manySegments = listSegmentFiles(simTimelineLog(multiDir));
      expect(manySegments.length).toBeGreaterThan(10);

      const fromSingle = await readSimTimelineRecords(singleDir, 500);
      const fromMulti = await readSimTimelineRecords(multiDir, 500);
      expect(fromMulti).toEqual(fromSingle);
      expect(fromMulti).toHaveLength(records.length);

      // The bounded-ring semantics (latest `cap` win) are also identical.
      const cappedSingle = await readSimTimelineRecords(singleDir, 7);
      const cappedMulti = await readSimTimelineRecords(multiDir, 7);
      expect(cappedMulti).toEqual(cappedSingle);
      expect(cappedMulti).toHaveLength(7);
    } finally {
      rmSync(singleDir, { recursive: true, force: true });
      rmSync(multiDir, { recursive: true, force: true });
    }
  });

  it('stitches the legacy single file as the OLDEST segment and appends new writes to segments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-seg-legacy-'));
    try {
      // A pre-P2 dir: the recorder used to write sim-timeline.jsonl directly.
      writeFileSync(
        join(dir, SIM_TIMELINE_FILE),
        JSON.stringify(zoneSample('sim-legacy', 0)) + '\n' +
        JSON.stringify(zoneSample('sim-legacy', 1)) + '\n',
      );
      for (let i = 2; i < 6; i++) {
        appendSimTimelineRecord(dir, zoneSample('sim-legacy', i), { maxFileBytes: 1024 * 1024 });
      }
      // New writes went to segments — the legacy file is untouched.
      expect(existsSync(join(dir, SIM_TIMELINE_FILE))).toBe(true);
      const records = await readSimTimelineRecords(dir, 500);
      const seqs = records.map(r => r.kind === 'zone-sample'
        ? r.zones[0]!.parameters.seq as number : -1);
      expect(seqs).toEqual([0, 1, 2, 3, 4, 5]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips torn half-lines (crash residue) wherever they sit in the stitch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-seg-torn-'));
    try {
      for (let i = 0; i < 4; i++) {
        appendSimTimelineRecord(dir, zoneSample('sim-torn', i), { maxFileBytes: 600 });
      }
      const segments = listSegmentFiles(simTimelineLog(dir));
      expect(segments.length).toBeGreaterThanOrEqual(2);
      // Torn tail on a sealed segment + a torn line mid-file.
      writeFileSync(segments[0]!, '{"kind":"zone-sample","zones":'); // corrupt overwrite marker
      const records = await readSimTimelineRecords(dir, 500);
      for (const record of records) {
        expect(['zone-sample', 'device-state']).toContain(record.kind);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('replay scanner walks segments, never rollups (LW-P2 invariant)', () => {
  it('yields legacy files + raw segments, excludes rollup-* files', () => {
    const base = mkdtempSync(join(tmpdir(), 'sim-seg-scan-'));
    try {
      const simDir = join(base, 'sim-scan');
      const segDir = join(simDir, 'sim-timeline');
      mkdirSync(segDir, { recursive: true });
      writeFileSync(join(simDir, 'legacy.jsonl'), '{}\n'); // top-level legacy file
      writeFileSync(join(segDir, 'segment-000001.jsonl'), '{}\n');
      writeFileSync(join(segDir, 'segment-000002.jsonl'), '{}\n');
      writeFileSync(join(segDir, 'rollup-1m-000001.jsonl'), '{}\n'); // aggregate grain
      writeFileSync(join(segDir, 'rollup-1m-000002.jsonl.tmp'), '{}\n'); // compaction residue

      const yielded = [...iterSimJsonlFiles(base)];
      // Path separators differ per-OS — assert on file names and depth.
      const names = yielded.map(p => p.split(/[\\/]/).pop()!);
      expect(names).toContain('legacy.jsonl');
      expect(names).toContain('segment-000001.jsonl');
      expect(names).toContain('segment-000002.jsonl');
      expect(names.filter(n => n.startsWith('rollup'))).toEqual([]);
      // Every yielded path lives under the sim dir (top level or one subdir deep).
      for (const path of iterSimJsonlFiles(base)) {
        const rel = path.slice(base.length + 1);
        expect(rel.split(/[\\/]/).length).toBeLessThanOrEqual(3);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('an empty or missing base dir yields nothing', () => {
    expect([...iterSimJsonlFiles(join(tmpdir(), 'sim-seg-missing-'))]).toEqual([]);
  });

  it('R2-BUG-05: the envId prefilter skips other envs\' sim dirs but keeps foreign-shaped names', () => {
    const base = mkdtempSync(join(tmpdir(), 'sim-seg-envfilter-'));
    try {
      const envA = 'aaaaaaaa-1111-2222-3333-444444444444';
      const envB = 'bbbbbbbb-1111-2222-3333-444444444444';
      for (const dirName of [
        `sim-${envA}-world-session`,
        `sim-${envA}-muk8jc1f-1`,
        `sim-${envA}-fork-muk8jc1f-2`,
        `sim-${envB}-world-session`,
        `sim-${envB}-muk8jc1f-3`,
        'sim-custom-override', // 非 sim-<uuid>-… 形状（显式 trajectoryDir 等异态）照常扫描
      ]) {
        mkdirSync(join(base, dirName), { recursive: true });
        writeFileSync(join(base, dirName, 'legacy.jsonl'), '{}\n');
      }
      const yielded = [...iterSimJsonlFiles(base, envA)].map(p => p.split(/[\\/]/).slice(-2).join('/'));
      expect(yielded.sort()).toEqual([
        `sim-${envA}-fork-muk8jc1f-2/legacy.jsonl`,
        `sim-${envA}-muk8jc1f-1/legacy.jsonl`,
        `sim-${envA}-world-session/legacy.jsonl`,
        'sim-custom-override/legacy.jsonl',
      ].sort());
      // 不传 envId = 旧行为（全量枚举）。
      expect([...iterSimJsonlFiles(base)].length).toBe(6);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
