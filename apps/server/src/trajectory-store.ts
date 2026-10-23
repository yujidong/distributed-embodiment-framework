/**
 * Trajectory store — read-side access to per-simulation trajectory JSONL
 *
 * The write side lives in packages/core (`TrajectoryRecorder`): since
 * Living-worlds P2 it appends to a SIZE-SEGMENTED log
 * `<dir>/<base>/segment-<n>.jsonl` (the active segment rotates at the cap);
 * a pre-P2 dir may still carry a legacy single `<base>.jsonl`. This module
 * is the read side for `GET /api/simulations/:id/trajectory` (W8) and the
 * eval-report rebuild: `readTrajectoryDirRecords` stitches the legacy file
 * + all segments of every trajectory log in the dir (behavior identical to
 * the old single-file read); `readTrajectoryRecords` remains for callers
 * holding one explicit file. Both tolerate a partial trailing line (a crash
 * mid-append leaves one unparseable tail) and keep only the latest `cap`
 * matching records in a bounded ring.
 */

import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import {
  listRawFiles,
  segmentedLogOf,
  type SegmentedLogPaths,
  type TrajectoryRecord,
} from '@active-collaboration/core';

import { SIM_TIMELINE_BASE } from './sim-timeline.js';

/** Default upper bound on records returned per query (latest win). */
export const TRAJECTORY_RECORD_CAP = 500;

export interface TrajectoryQuery {
  eventId?: string;
  agentId?: string;
  /** Max records returned (latest). Default TRAJECTORY_RECORD_CAP. */
  cap?: number;
}

/**
 * Every trajectory log living in a simulation dir: one per distinct base
 * name (`{condition}-iter{N}-{scenario}-{model}`). Bases come from BOTH the
 * legacy single files and the segment subdirs (the `sim-timeline/` subdir is
 * the timeline log, never a trajectory log); duplicates dedupe. A dir
 * normally holds exactly one base — a model change across resumes can split
 * history across two, which then stitch in name order (chronological for
 * the recorder's naming scheme). Unreadable dir → [].
 */
export function trajectoryLogsOf(dir: string): SegmentedLogPaths[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const byBase = new Map<string, SegmentedLogPaths>();
  const register = (base: string): void => {
    if (!byBase.has(base)) byBase.set(base, segmentedLogOf(dir, base));
  };
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name !== `${SIM_TIMELINE_BASE}.jsonl`) {
      register(entry.name.slice(0, -'.jsonl'.length));
    } else if (entry.isDirectory() && entry.name !== SIM_TIMELINE_BASE && hasSegmentFiles(join(dir, entry.name))) {
      register(entry.name);
    }
  }
  return [...byBase.values()].sort((a, b) => a.segmentDir.localeCompare(b.segmentDir));
}

function hasSegmentFiles(segmentDir: string): boolean {
  try {
    return readdirSync(segmentDir).some(name => /^segment-\d{6,}\.jsonl$/.test(name));
  } catch {
    return false;
  }
}

/**
 * Stream-read every trajectory log of a simulation dir (legacy files +
 * segments, stitched) and return the LATEST (≤ cap) records matching the
 * query in append (chronological) order. A missing dir / no logs is not an
 * error — it means "no records yet" and yields an empty list.
 */
export async function readTrajectoryDirRecords(
  dir: string,
  query: TrajectoryQuery = {},
): Promise<TrajectoryRecord[]> {
  return (await readTrajectoryDirRecordsCounted(dir, query)).records;
}

/**
 * R81-D2 (R44-extreme-F2): counted twin of readTrajectoryDirRecords —
 * `totalCount` is EVERY matching record on disk (uncapped), so the query
 * layer can tell "500 served of 500" from "500 served of 61k" instead of
 * silently truncating the interactive cap.
 */
export async function readTrajectoryDirRecordsCounted(
  dir: string,
  query: TrajectoryQuery = {},
): Promise<{ records: TrajectoryRecord[]; totalCount: number }> {
  const cap = query.cap ?? TRAJECTORY_RECORD_CAP;
  const ring: TrajectoryRecord[] = [];
  let totalCount = 0;
  for (const log of trajectoryLogsOf(dir)) {
    for (const filePath of listRawFiles(log)) {
      try {
        await collect(filePath, record => {
          if (query.eventId !== undefined && record.eventId !== query.eventId) return;
          if (query.agentId !== undefined && record.agentId !== query.agentId) return;
          totalCount++;
          ring.push(record);
          if (ring.length > cap) ring.shift();
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // swept mid-read
        throw error;
      }
    }
  }
  return { records: ring, totalCount };
}

/**
 * Stream-read ONE trajectory JSONL file (a single segment or a legacy file)
 * and return the LATEST (≤ cap) records matching the query, in file
 * (chronological) order. A missing file is not an error — it means "no
 * records yet" (rule-only runs record nothing) and yields an empty list.
 * Lines that fail JSON.parse (partial trailing write) are skipped.
 */
export async function readTrajectoryRecords(
  filePath: string,
  query: TrajectoryQuery = {},
): Promise<TrajectoryRecord[]> {
  return (await readTrajectoryRecordsCounted(filePath, query)).records;
}

/**
 * R81-D2 (R44-extreme-F2): counted twin of readTrajectoryRecords —
 * `totalCount` counts EVERY matching record in the file (uncapped).
 */
export async function readTrajectoryRecordsCounted(
  filePath: string,
  query: TrajectoryQuery = {},
): Promise<{ records: TrajectoryRecord[]; totalCount: number }> {
  const cap = query.cap ?? TRAJECTORY_RECORD_CAP;
  // Bounded ring of the latest matching records.
  const ring: TrajectoryRecord[] = [];
  let totalCount = 0;
  try {
    await collect(filePath, record => {
      if (query.eventId !== undefined && record.eventId !== query.eventId) return;
      if (query.agentId !== undefined && record.agentId !== query.agentId) return;
      totalCount++;
      ring.push(record);
      if (ring.length > cap) ring.shift();
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], totalCount: 0 };
    throw error;
  }
  return { records: ring, totalCount };
}

/** Stream the file line by line, invoking `onRecord` per parsed record. */
async function collect(
  filePath: string,
  onRecord: (record: TrajectoryRecord) => void,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // partial trailing write — skip
      }
      if (!isTrajectoryRecord(parsed)) continue;
      onRecord(parsed);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Minimal structural guard — the recorder owns the full shape. */
function isTrajectoryRecord(value: unknown): value is TrajectoryRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.eventId === 'string' &&
    typeof record.agentId === 'string' &&
    typeof record.decision === 'string';
}
