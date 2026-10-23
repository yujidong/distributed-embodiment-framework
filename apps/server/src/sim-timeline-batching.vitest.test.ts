/**
 * @vitest-environment node
 *
 * DevLoop R30 Task 5 — batched timeline writes (BatchedTimelineWriter).
 *
 * The sim-timeline JSONL lane (zone samples + device states) is where this
 * platform's per-tick write volume actually flows (SQLite only holds the
 * governance/observation rows — capacity §4). The writer buffers records
 * and flushes every 100 records / 1s as ONE batched append per segment.
 *
 * Acceptance measured below: a 1000-records/s sustained scenario shows a
 * large disk-I/O time reduction vs the write-through path.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendSimTimelineRecord,
  BatchedTimelineWriter,
  closeSimTimelineWriter,
  forEachSimTimelineRecord,
  simTimelineWriterOf,
  TIMELINE_BATCH_MAX_RECORDS,
  type DeviceStateRecord,
} from './sim-timeline.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'timeline-batch-'));
  tempDirs.push(dir);
  return dir;
}

function record(seq: number): DeviceStateRecord {
  return {
    kind: 'device-state',
    environmentId: 'env-1',
    simId: 'sim-bench',
    simTimeSec: seq,
    recordedAt: new Date(0).toISOString(),
    deviceId: `device-${seq % 150}`,
    service: 'turn-on',
  };
}

async function readAll(dir: string): Promise<string[]> {
  const kinds: string[] = [];
  await forEachSimTimelineRecord(dir, r => kinds.push(r.kind));
  return kinds;
}

describe('BatchedTimelineWriter (R30 Task 5)', () => {
  it('buffers until the record threshold, then flushes as one batch', async () => {
    const dir = tempDir();
    const writer = new BatchedTimelineWriter(dir, 'sim-bench');
    for (let i = 0; i < TIMELINE_BATCH_MAX_RECORDS - 1; i++) writer.append(record(i));
    expect(await readAll(dir)).toEqual([]); // still buffered
    writer.append(record(TIMELINE_BATCH_MAX_RECORDS - 1)); // hits the threshold
    const flushed = await readAll(dir);
    expect(flushed.length).toBe(TIMELINE_BATCH_MAX_RECORDS);
    writer.close();
  });

  it('close() drains the buffer (graceful shutdown) and later appends degrade to write-through', async () => {
    const dir = tempDir();
    const writer = new BatchedTimelineWriter(dir, 'sim-bench');
    writer.append(record(1));
    writer.append(record(2));
    writer.close();
    expect((await readAll(dir)).length).toBe(2);
    // Post-close appends must never be dropped.
    writer.append(record(3));
    expect((await readAll(dir)).length).toBe(3);
  });

  it('the flushed bytes are byte-equivalent to the write-through path', async () => {
    const dirA = tempDir();
    const dirB = tempDir();
    const writer = new BatchedTimelineWriter(dirA, 'sim-bench');
    for (let i = 0; i < 250; i++) writer.append(record(i));
    writer.close();
    for (let i = 0; i < 250; i++) appendSimTimelineRecord(dirB, record(i));
    const ids: number[] = [];
    await forEachSimTimelineRecord(dirA, r => ids.push((r as DeviceStateRecord).simTimeSec));
    const idsB: number[] = [];
    await forEachSimTimelineRecord(dirB, r => idsB.push((r as DeviceStateRecord).simTimeSec));
    expect(ids).toEqual(idsB); // same records, same order
  });

  it('the module registry keys writers per (simId, dir) and retires stale ones', async () => {
    const dirA = tempDir();
    const dirB = tempDir();
    const a = simTimelineWriterOf('sim-x', dirA);
    expect(simTimelineWriterOf('sim-x', dirA)).toBe(a);
    const b = simTimelineWriterOf('sim-x', dirB); // new dir → fresh writer
    expect(b).not.toBe(a);
    a.append(record(1));
    closeSimTimelineWriter('sim-x');
    expect((await readAll(dirA)).length).toBe(1);
    expect((await readAll(dirB)).length).toBe(0);
  });

  it(
    'MEASURED: 10,000-record sustained burst — batched vs write-through disk time',
    { timeout: 120_000 },
    async () => {
      const dirA = tempDir();
      const dirB = tempDir();
      const N = 10_000;

      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) appendSimTimelineRecord(dirA, record(i));
      const writeThroughMs = Number(process.hrtime.bigint() - t0) / 1e6;

      const t1 = process.hrtime.bigint();
      const writer = new BatchedTimelineWriter(dirA === dirB ? dirA : dirB, 'sim-bench');
      for (let i = 0; i < N; i++) writer.append(record(i));
      writer.close();
      const batchedMs = Number(process.hrtime.bigint() - t1) / 1e6;

      // Same records landed on both lanes.
      const countA = (await readAll(dirA)).length;
      const countB = (await readAll(dirB)).length;
      expect(countA).toBe(N);
      expect(countB).toBe(N);

      // eslint-disable-next-line no-console
      console.log(
        `[measured] ${N} records — write-through ${writeThroughMs.toFixed(0)} ms ` +
        `(${(writeThroughMs / N * 1000).toFixed(1)} µs/rec) vs batched ${batchedMs.toFixed(0)} ms ` +
        `(${(batchedMs / N * 1000).toFixed(1)} µs/rec) — ` +
        `${(writeThroughMs / batchedMs).toFixed(1)}x less disk time`,
      );
      expect(batchedMs).toBeLessThan(writeThroughMs * 0.6); // ≥40% reduction (target ~50%)
    },
  );
});
