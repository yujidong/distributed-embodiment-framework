/**
 * Segmented append-only log (Living-worlds P2, design-living-worlds.md §12.2)
 * — the shared layout primitive behind sim-timeline and trajectory capture.
 *
 * T-011 formalized: the old "single file + trim-to-half when over cap"
 * becomes "size-segmented files, active segment rotates at the cap".
 * A sealed segment is NEVER rewritten, so the trim-to-half amortization
 * lesson (one rewrite per doubling) upgrades to zero rewrites — each byte
 * is written exactly once. The cap itself keeps its T-011 discipline:
 * - the SAME knob now bounds ONE SEGMENT (segment max = the old file cap),
 *   and must stay below downstream READ caps (replay silently skips source
 *   files over 64MB — 50MB segments stay replayable);
 * - `cap <= 0` disables rotation (unbounded single segment), like the old
 *   `maxFileBytes <= 0` guard.
 *
 * Layout (baseName = e.g. 'sim-timeline' or a trajectory file base):
 *
 *   <dir>/<baseName>.jsonl            LEGACY pre-P2 single file — read-only,
 *                                     stitched as the OLDEST segment
 *   <dir>/<baseName>/segment-000001.jsonl   sealed raw segment (≤ cap)
 *   <dir>/<baseName>/segment-000002.jsonl   ACTIVE segment (append target)
 *   <dir>/<baseName>/rollup-1m-000001.jsonl minute rollups (compactor output;
 *                                     NEVER a replay source — the rollup-
 *                                     prefix exclusion is the invariant)
 *
 * Migration is structural: an old single file is simply read first; new
 * writes always go to segments. Crash-safety of the append path is
 * unchanged (appendFileSync one line at a time; a torn tail line is skipped
 * by readers exactly like before).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

/** Segment file prefix inside a segment dir. */
export const SEGMENT_PREFIX = 'segment-';
/** Rollup file prefix inside a segment dir — excluded from raw readers. */
export const ROLLUP_PREFIX = 'rollup-';

/** Zero-padded segment file name (`segment-000001.jsonl`). */
export function segmentFileName(n: number): string {
  return `${SEGMENT_PREFIX}${String(n).padStart(6, '0')}.jsonl`;
}

/** Segment number parsed from a `segment-<n>.jsonl` name, else undefined. */
export function parseSegmentNumber(name: string): number | undefined {
  const match = /^segment-(\d{6,})\.jsonl$/.exec(name);
  return match === null ? undefined : Number(match[1]);
}

/** True for rollup file names (`rollup-…`) — the raw-read exclusion rule. */
export function isRollupFileName(name: string): boolean {
  return name.startsWith(ROLLUP_PREFIX);
}

/** The two locations one logical log lives at (segment dir + legacy file). */
export interface SegmentedLogPaths {
  /** Directory holding `segment-<n>.jsonl` (+ rollup files). */
  segmentDir: string;
  /** Pre-P2 single-file path — read as the oldest segment when present. */
  legacyFile: string;
}

/** Layout of the log `baseName` inside `dir`. */
export function segmentedLogOf(dir: string, baseName: string): SegmentedLogPaths {
  return { segmentDir: join(dir, baseName), legacyFile: join(dir, `${baseName}.jsonl`) };
}

/** Segment files in the segment dir, ordered by segment number. */
export function listSegmentFiles(log: SegmentedLogPaths): string[] {
  let entries: string[];
  try {
    entries = readdirSync(log.segmentDir);
  } catch {
    return [];
  }
  return entries
    .map(name => {
      const n = parseSegmentNumber(name);
      return n === undefined ? undefined : { n, path: join(log.segmentDir, name) };
    })
    .filter((entry): entry is { n: number; path: string } => entry !== undefined)
    .sort((a, b) => a.n - b.n)
    .map(entry => entry.path);
}

/** Rollup files in the segment dir, ordered by name (== sequence). */
export function listRollupFiles(log: SegmentedLogPaths): string[] {
  let entries: string[];
  try {
    entries = readdirSync(log.segmentDir);
  } catch {
    return [];
  }
  return entries.filter(isRollupFileName).sort().map(name => join(log.segmentDir, name));
}

/**
 * ALL raw source files of the log in chronological append order: the legacy
 * single file (pre-P2 data — necessarily older than any segment), then the
 * numbered segments. Readers stitch exactly this list.
 */
export function listRawFiles(log: SegmentedLogPaths): string[] {
  const files: string[] = [];
  if (existsSync(log.legacyFile)) files.push(log.legacyFile);
  files.push(...listSegmentFiles(log));
  return files;
}

/** The NEWEST segment file (the active append target), if any exists. */
export function activeSegmentFile(log: SegmentedLogPaths): string | undefined {
  const segments = listSegmentFiles(log);
  return segments[segments.length - 1];
}

/**
 * Append one line (WITHOUT trailing newline) to the log, rotating the active
 * segment first when it is at the cap. Rotation is the only cost: sealed
 * segments are never rewritten, and an incoming line larger than the whole
 * cap still lands (its own segment may exceed the cap — records are never
 * dropped, the standing T-011 write-path rule).
 *
 * `maxSegmentBytes <= 0` disables rotation entirely.
 */
export function appendSegmentedLine(
  log: SegmentedLogPaths,
  line: string,
  maxSegmentBytes: number,
): { activePath: string; rotated: boolean; sealedPath?: string } {
  mkdirSync(log.segmentDir, { recursive: true });
  const lineBytes = Buffer.byteLength(line, 'utf-8') + 1;

  let active = activeSegmentFile(log);
  let rotated = false;
  let sealedPath: string | undefined;
  if (maxSegmentBytes > 0) {
    let activeBytes = 0;
    if (active !== undefined) {
      try {
        activeBytes = statSync(active).size;
      } catch {
        activeBytes = 0; // vanished mid-flight — start a fresh segment
      }
    }
    if (active === undefined || activeBytes + lineBytes > maxSegmentBytes) {
      const next = (active === undefined ? 0 : highestSegmentNumber(log)) + 1;
      if (active !== undefined) sealedPath = active;
      active = join(log.segmentDir, segmentFileName(next));
      rotated = true;
    }
  } else if (active === undefined) {
    active = join(log.segmentDir, segmentFileName(1));
    rotated = true;
  }

  appendFileSync(active!, line + '\n', 'utf-8');
  return { activePath: active!, rotated, ...(sealedPath !== undefined ? { sealedPath } : {}) };
}

/**
 * R30 Task 5 (write batching): append MANY lines (each without trailing
 * newline) with minimal syscalls — the batch is chunked at segment-cap
 * boundaries and each chunk lands as ONE appendFileSync instead of one
 * open/write/close per record. Rotation semantics identical to
 * appendSegmentedLine: the active segment is sealed when the NEXT line
 * would not fit (a line larger than the whole cap still lands, alone, in
 * its own segment — records are never dropped, the standing T-011 rule).
 * Returns the rotation info of the LAST chunk (callers that need every
 * rotation use appendSegmentedLine per line).
 */
export function appendSegmentedLines(
  log: SegmentedLogPaths,
  lines: ReadonlyArray<string>,
  maxSegmentBytes: number,
): { activePath: string; rotated: boolean; sealedPath?: string } {
  const fallback = { activePath: join(log.segmentDir, segmentFileName(1)), rotated: false };
  if (lines.length === 0) {
    const active = activeSegmentFile(log);
    return active === undefined ? fallback : { activePath: active, rotated: false };
  }
  mkdirSync(log.segmentDir, { recursive: true });

  let active = activeSegmentFile(log);
  let activeNumber = active === undefined
    ? highestSegmentNumber(log)
    : parseSegmentNumber(active.split(/[\\/]/).pop() ?? '') ?? highestSegmentNumber(log);
  let rotated = false;
  let sealedPath: string | undefined;
  /** Bytes still available in `active` under the cap (Infinity = no cap). */
  let remaining: number = Number.POSITIVE_INFINITY;
  const startNewSegment = (): void => {
    // The number is tracked in memory: batched chunks only hit the disk at
    // the END, so a directory scan here would not see the sealed segments.
    activeNumber += 1;
    if (active !== undefined) sealedPath = active;
    active = join(log.segmentDir, segmentFileName(activeNumber));
    rotated = true;
    remaining = maxSegmentBytes > 0 ? maxSegmentBytes : Number.POSITIVE_INFINITY;
  };
  if (maxSegmentBytes > 0) {
    if (active === undefined) {
      startNewSegment();
    } else {
      try {
        remaining = Math.max(0, maxSegmentBytes - statSync(active).size);
      } catch {
        remaining = 0; // vanished mid-flight — start a fresh segment
      }
    }
  }

  const chunks: Array<{ path: string; text: string }> = [];
  let current: string[] = [];
  let currentBytes = 0;
  const flushChunk = (): void => {
    if (current.length === 0) return;
    if (active === undefined || remaining <= 0) startNewSegment();
    chunks.push({ path: active!, text: current.join('\n') + '\n' });
    remaining -= currentBytes;
    current = [];
    currentBytes = 0;
  };

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf-8') + 1;
    // Seal the pending chunk when adding this line would overflow.
    if (current.length > 0 && currentBytes + lineBytes > remaining) flushChunk();
    // A line that alone does not fit starts a new segment (single-line rule).
    if (current.length === 0 && lineBytes > remaining) startNewSegment();
    current.push(line);
    currentBytes += lineBytes;
    if (currentBytes >= remaining) flushChunk();
  }
  flushChunk();
  for (const chunk of chunks) appendFileSync(chunk.path, chunk.text, 'utf-8');
  return { activePath: active!, rotated, ...(sealedPath !== undefined ? { sealedPath } : {}) };
}

function highestSegmentNumber(log: SegmentedLogPaths): number {
  let highest = 0;
  for (const path of listSegmentFiles(log)) {
    const n = parseSegmentNumber(path.split(/[\\/]/).pop() ?? '');
    if (n !== undefined && n > highest) highest = n;
  }
  return highest;
}

/**
 * The path the NEXT append would land on — the newest existing segment, or
 * `segment-000001.jsonl` when the log is empty (WITHOUT creating it — a
 * freshly constructed recorder that never records leaves no empty file
 * behind; readers treat a missing file as "no records").
 */
export function appendTargetPath(log: SegmentedLogPaths): string {
  const active = activeSegmentFile(log);
  return active !== undefined ? active : join(log.segmentDir, segmentFileName(1));
}
