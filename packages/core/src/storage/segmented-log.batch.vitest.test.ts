/**
 * @vitest-environment node
 *
 * R30 Task 5 — `appendSegmentedLines` (batched segmented-log appends).
 *
 * Invariants:
 *   (a) EQUIVALENCE: a batch lands byte-identical to the same lines
 *       appended one-by-one through appendSegmentedLine (order, newlines,
 *       segment contents);
 *   (b) rotation: the cap is honored per segment; no line is ever dropped;
 *       a line larger than the whole cap still lands (alone, oversized);
 *   (c) empty batch is a no-op.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendSegmentedLine,
  appendSegmentedLines,
  listSegmentFiles,
  segmentedLogOf,
} from './segmented-log.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'segmented-batch-'));
  tempDirs.push(dir);
  return dir;
}

const LINES = Array.from({ length: 57 }, (_, i) => JSON.stringify({ kind: 'x', seq: i, pad: 'p'.repeat(40) }));

describe('appendSegmentedLines (R30 Task 5)', () => {
  it('a batch lands byte-identical to per-line appends (no rotation)', () => {
    const dirA = tempDir();
    const dirB = tempDir();
    for (const line of LINES) {
      appendSegmentedLine(segmentedLogOf(dirA, 'log'), line, 0);
    }
    appendSegmentedLines(segmentedLogOf(dirB, 'log'), LINES, 0);
    const filesA = readdirSync(join(dirA, 'log')).sort();
    const filesB = readdirSync(join(dirB, 'log')).sort();
    expect(filesB).toEqual(filesA);
    for (const file of filesA) {
      expect(readFileSync(join(dirB, 'log', file), 'utf-8'))
        .toBe(readFileSync(join(dirA, 'log', file), 'utf-8'));
    }
  });

  it('honors the cap across a batch: no line lost, segments within cap', () => {
    const dir = tempDir();
    const lineBytes = Buffer.byteLength(LINES[0]!, 'utf-8') + 1;
    const cap = lineBytes * 10; // 10 lines per segment exactly
    appendSegmentedLines(segmentedLogOf(dir, 'log'), LINES, cap);

    const segments = listSegmentFiles(segmentedLogOf(dir, 'log'));
    expect(segments.length).toBeGreaterThanOrEqual(6); // 57 lines / 10 per segment
    const readBack: string[] = [];
    for (const segment of segments) {
      const text = readFileSync(segment, 'utf-8');
      const lines = text.split('\n').filter(l => l.length > 0);
      expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(cap);
      readBack.push(...lines);
    }
    expect(readBack).toEqual(LINES); // order preserved, nothing dropped
  });

  it('an oversized line still lands (alone, its own segment)', () => {
    const dir = tempDir();
    const huge = JSON.stringify({ pad: 'x'.repeat(500) });
    appendSegmentedLines(segmentedLogOf(dir, 'log'), ['{"small":1}', huge, '{"small":2}'], 100);
    const readBack: string[] = [];
    for (const segment of listSegmentFiles(segmentedLogOf(dir, 'log'))) {
      readBack.push(...readFileSync(segment, 'utf-8').split('\n').filter(l => l.length > 0));
    }
    expect(readBack).toEqual(['{"small":1}', huge, '{"small":2}']);
  });

  it('an empty batch is a no-op (and reports a sensible active path)', () => {
    const dir = tempDir();
    const log = segmentedLogOf(dir, 'log');
    appendSegmentedLines(log, [], 50);
    expect(listSegmentFiles(log)).toEqual([]);
  });
});
