/**
 * Timeline compactor (Living-worlds P2, design-living-worlds.md §12.2) —
 * size-segmented append logs + rollup compaction + raw-window retention.
 *
 * The compactor turns SEALED segments that are older than the replay window
 * (EAF_ROLLUP_WINDOW_DAYS, default 7 — aligned with trajectory retention)
 * into MINUTE-GRAIN ROLLUPS, then deletes the raw segments — in that order
 * (crash-safe: a raw segment is only deleted AFTER its rollup file has been
 * durably renamed into place; a crash in between leaves both, and the next
 * sweep heals by recognizing the already-rolled sources from the rollup
 * manifest and deleting the raw leftovers without duplicating the rollup).
 *
 * Rollup grains (aggregate JSON lines keyed by the UTC minute of
 * `recordedAt`):
 * - zone-sample  → per zone, per numeric parameter: min/max/avg/last/count
 *                  (occupancy aggregated the same way when present);
 * - device-state → per device: change count + last (service/recordedAt/
 *                  simTimeSec);
 * - decisions (trajectory records) → counts by `${decisionSource}/${decision}`.
 * Rollup files are `rollup-1m-<seq>.jsonl` in the segment dir; line 1 is a
 * MANIFEST naming the exact source files, so re-runs are idempotent.
 *
 * What is NEVER compacted:
 * - the ACTIVE segment (highest number — still the append target; for a
 *   stopped sim it is the window edge, and the dir-level retention sweep
 *   owns its end of life);
 * - a segment whose newest byte (mtime — the T-033 per-file lesson) is
 *   inside the window: a straddling segment stays raw in full (conservative:
 *   the raw window never loses coverage at its boundary);
 * - `observations` / anything outside the trajectory dirs (not ours).
 *
 * Each sweep processes at most ROLLUP_BATCH_MAX_BYTES of stale raw per log
 * (oldest first): the on-rotation hook runs on the sim's own append path
 * and must stay bounded; leftovers go to the next sweep (boot / periodic /
 * next rotation) — the cadence knobs amortize the rest.
 *
 * Replay coupling (documented invariant): rollup files are named `rollup-*`
 * and the replay scanner EXCLUDES them by prefix — the aggregate grain
 * never enters replay; replay only ever reads raw (window-bounded) records.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  listRollupFiles,
  listSegmentFiles,
  segmentedLogOf,
  type SegmentedLogPaths,
} from '@active-collaboration/core';

import { readSimTimelineRecords, simTimelineLog } from '../sim-timeline.js';
import { readTrajectoryDirRecordsCounted, trajectoryLogsOf } from '../trajectory-store.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Rollup manifest — the FIRST line of every rollup-1m-<seq>.jsonl file. */
export interface RollupManifest {
  kind: 'rollup-manifest';
  /** Aggregate format version (bump on schema change — readers gate on it). */
  format: 1;
  /** Raw source files (names inside the segment dir / the legacy file name). */
  sources: string[];
  /** Oldest / newest minute covered (ISO minute starts). */
  fromMinute: string;
  toMinute: string;
  createdAt: string;
}

/** Minute-grain aggregate of zone-sample records. */
export interface ZoneSampleRollupRecord {
  kind: 'rollup-1m';
  source: 'zone-sample';
  environmentId: string;
  simId: string;
  /** UTC minute bucket start (ISO). */
  minuteStart: string;
  zones: Array<{
    zoneId: string;
    parameters: Record<string, { min: number; max: number; avg: number; last: number; count: number }>;
    occupancy?: { min: number; max: number; avg: number; last: number; count: number };
  }>;
  samples: number;
}

/** Minute-grain aggregate of device-state records. */
export interface DeviceStateRollupRecord {
  kind: 'rollup-1m';
  source: 'device-state';
  environmentId: string;
  simId: string;
  minuteStart: string;
  devices: Array<{
    deviceId: string;
    changes: number;
    last: { service?: string; recordedAt: string; simTimeSec: number };
  }>;
}

/** Minute-grain aggregate of decision trajectory records. */
export interface DecisionRollupRecord {
  kind: 'rollup-1m';
  source: 'decisions';
  minuteStart: string;
  /** Counts keyed `${decisionSource}/${decision}`. */
  counts: Record<string, number>;
  decisions: number;
}

export type RollupAggregateRecord =
  | ZoneSampleRollupRecord
  | DeviceStateRollupRecord
  | DecisionRollupRecord;

export interface CompactorOptions {
  /** Raw retention window (ms); segments sealed-and-older compact away. */
  rollupWindowMs: number;
  /** Injectable clock (tests). Default Date.now(). */
  now?: () => number;
  /**
   * Test seam simulating a crash between rollup write and raw delete: the
   * sweep throws from here AFTER the rollup file is durable. Never set in
   * production wiring.
   */
  beforeRawDelete?: () => void;
}

export interface SweepResult {
  /** Simulation dirs examined. */
  sweptDirs: number;
  /** Sealed segments whose bytes went into a rollup this sweep. */
  rolledSegments: number;
  /** Raw files deleted (this sweep, or healed from a prior crashed sweep). */
  deletedRawFiles: number;
  /** Rollup files written. */
  rollupFilesWritten: number;
  rollupBytes: number;
  rawBytesDeleted: number;
  /** Logs that produced at least one warning (never fatal — next sweep retries). */
  logsWithWarnings: number;
}

/**
 * Per-sweep raw byte budget per log. 128MB keeps a rotation hook in the
 * sub-second range while a 6.8GB/day hot sim still drains its backlog at
 * ~one batch per rotation + every periodic sweep.
 */
export const ROLLUP_BATCH_MAX_BYTES = 128 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

/**
 * Sweep every `sim-*` dir under a trajectory base dir: for each segmented
 * log in it (sim-timeline + every decision-trajectory log), compact sealed
 * out-of-window segments to minute rollups and delete the raw afterwards.
 * Never throws — per-dir failures count into logsWithWarnings; the next
 * sweep (boot / periodic / rotation) retries.
 */
export function sweepTrajectoryBaseDir(baseDir: string, options: CompactorOptions): SweepResult {
  const totals = emptyResult();
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return totals; // missing/unreadable base dir — nothing to do
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('sim-')) continue;
    totals.sweptDirs++;
    try {
      const perDir = sweepTrajectoryDir(join(baseDir, entry.name), options);
      mergeResult(totals, perDir);
    } catch {
      totals.logsWithWarnings++; // a broken dir never breaks the sweep
    }
  }
  return totals;
}

/**
 * Sweep ONE simulation dir — also the on-rotation hook target (sweeping a
 * single dir keeps the append path's extra I/O proportional to the sim that
 * just rotated, not to the whole base dir).
 */
export function sweepTrajectoryDir(dir: string, options: CompactorOptions): SweepResult {
  const result = emptyResult();
  const logs: SegmentedLogPaths[] = [simTimelineLog(dir), ...trajectoryLogsOf(dir)];
  for (const log of logs) {
    try {
      const perLog = compactLog(log, options);
      mergeResult(result, perLog);
    } catch (error) {
      if (error instanceof RawDeleteHookAbort) throw error.cause; // test seam — propagate
      result.logsWithWarnings++; // a broken log never breaks the sweep
    }
  }
  return result;
}

/** Compact ONE segmented log (timeline or trajectory). */
function compactLog(log: SegmentedLogPaths, options: CompactorOptions): SweepResult {
  const result = emptyResult();
  const now = options.now?.() ?? Date.now();
  const cutoff = now - options.rollupWindowMs;

  const segments = listSegmentFiles(log);
  // The newest segment is the ACTIVE append target — never compacted (for a
  // stopped sim it is the window edge; dir-level retention owns its death).
  const sealed = segments.length > 1 ? segments.slice(0, -1) : [];

  // Idempotency: sources already covered by an existing rollup manifest are
  // raw leftovers of a crashed sweep — delete them, do NOT roll again.
  const covered = rollupCoveredSources(log);
  const toDelete: string[] = [];
  const toRoll: string[] = [];
  let batchBytes = 0;

  const stalenessOf = (path: string): number | undefined => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return undefined; // vanished — nothing to do
    }
  };

  for (const path of sealed) {
    const name = fileNameOf(path);
    if (covered.has(name)) {
      toDelete.push(path); // healed on this sweep (crash residue)
      continue;
    }
    const mtimeMs = stalenessOf(path);
    if (mtimeMs === undefined || mtimeMs >= cutoff) continue; // in-window
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      continue;
    }
    if (batchBytes + bytes > ROLLUP_BATCH_MAX_BYTES) continue; // next sweep
    batchBytes += bytes;
    toRoll.push(path);
  }

  // The legacy single file (pre-P2 data, never appended to anymore) rolls
  // under the same rules — it is the oldest sealed "segment".
  if (existsSync(log.legacyFile)) {
    const legacyName = fileNameOf(log.legacyFile);
    const mtimeMs = stalenessOf(log.legacyFile);
    if (covered.has(legacyName)) {
      toDelete.push(log.legacyFile);
    } else if (mtimeMs !== undefined && mtimeMs < cutoff) {
      let bytes = 0;
      try {
        bytes = statSync(log.legacyFile).size;
      } catch {
        bytes = 0;
      }
      if (batchBytes + bytes <= ROLLUP_BATCH_MAX_BYTES) {
        batchBytes += bytes;
        toRoll.push(log.legacyFile);
      }
    }
  }

  if (toRoll.length === 0 && toDelete.length === 0) return result;

  // 1. Roll up (aggregates differ by source kind — one rollup file per batch).
  if (toRoll.length > 0) {
    const aggregates = aggregateFiles(toRoll);
    if (aggregates.records.length > 0) {
      const seq = nextRollupSeq(log);
      const rollupPath = join(log.segmentDir, rollupFileName(seq));
      const tmpPath = `${rollupPath}.tmp`;
      const manifest: RollupManifest = {
        kind: 'rollup-manifest',
        format: 1,
        sources: toRoll.map(fileNameOf),
        fromMinute: aggregates.fromMinute,
        toMinute: aggregates.toMinute,
        createdAt: new Date(now).toISOString(),
      };
      const body =
        JSON.stringify(manifest) + '\n' +
        aggregates.records.map(record => JSON.stringify(record)).join('\n') + '\n';
      writeFileSync(tmpPath, body, 'utf-8');
      renameSync(tmpPath, rollupPath); // atomic on the same volume
      result.rollupFilesWritten++;
      result.rollupBytes += Buffer.byteLength(body, 'utf-8');
      result.rolledSegments += toRoll.length;
      // The rollup now durably covers these sources — queue their deletion
      // (step 2). A crash before step 2 leaves both; the manifest makes the
      // next sweep delete the raw without re-rolling.
      toDelete.push(...toRoll);
    } else {
      // Stale segments with no compactable records (unparsable residue):
      // the raw bytes are worthless — delete without writing a rollup.
      toDelete.push(...toRoll);
    }
  }

  // 2. Delete raw AFTER the rollup is durable (crash-safe ordering). The
  // beforeRawDelete seam lets tests stop exactly here; a throw leaves both
  // the rollup and the raw in place for the next sweep to heal (and aborts
  // the sweep like a real process crash would).
  try {
    options.beforeRawDelete?.();
  } catch (error) {
    throw new RawDeleteHookAbort(error);
  }
  for (const path of toDelete) {
    try {
      result.rawBytesDeleted += statSync(path).size;
      unlinkSync(path);
      result.deletedRawFiles++;
    } catch {
      // Next sweep retries; a covered source never re-rolls.
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Aggregation (pure folding over parsed records)
// ---------------------------------------------------------------------------

interface Aggregates {
  records: RollupAggregateRecord[];
  fromMinute: string;
  toMinute: string;
}

/** UTC minute bucket start of an ISO timestamp, ISO-formatted. */
function minuteStartOf(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

type BucketMap = Map<string, Map<string, RollupAggregateRecord>>;

/** Read every raw file of the batch and fold records into minute aggregates. */
function aggregateFiles(paths: string[]): Aggregates {
  const buckets: BucketMap = new Map();
  let fromMinute: string | undefined;
  let toMinute: string | undefined;

  const noteMinute = (minute: string): void => {
    if (fromMinute === undefined || minute < fromMinute) fromMinute = minute;
    if (toMinute === undefined || minute > toMinute) toMinute = minute;
  };
  const bucketFor = (
    minute: string, key: string, make: () => RollupAggregateRecord,
  ): RollupAggregateRecord => {
    let inner = buckets.get(minute);
    if (inner === undefined) {
      inner = new Map();
      buckets.set(minute, inner);
    }
    let bucket = inner.get(key);
    if (bucket === undefined) {
      bucket = make();
      inner.set(key, bucket);
    }
    return bucket;
  };

  for (const path of paths) {
    for (const parsed of readJsonlRecords(path)) {
      const record = parsed as Record<string, unknown>;
      const minute = typeof record.recordedAt === 'string'
        ? minuteStartOf(record.recordedAt)
        : undefined;
      if (minute === undefined) continue;
      noteMinute(minute);
      if (record.kind === 'zone-sample') {
        foldZoneSample(bucketFor, minute, record);
      } else if (record.kind === 'device-state') {
        foldDeviceState(bucketFor, minute, record);
      } else if (isDecisionRecord(record)) {
        foldDecision(bucketFor, minute, record);
      }
    }
  }

  const records: RollupAggregateRecord[] = [];
  for (const minute of [...buckets.keys()].sort()) {
    for (const bucket of buckets.get(minute)!.values()) {
      records.push(bucket);
    }
  }
  return {
    records,
    fromMinute: fromMinute ?? new Date(0).toISOString(),
    toMinute: toMinute ?? new Date(0).toISOString(),
  };
}

function foldZoneSample(
  bucketFor: (minute: string, key: string, make: () => RollupAggregateRecord) => RollupAggregateRecord,
  minute: string,
  record: Record<string, unknown>,
): void {
  const environmentId = record.environmentId;
  const simId = record.simId;
  if (typeof environmentId !== 'string' || typeof simId !== 'string') return;
  const zones = record.zones;
  if (!Array.isArray(zones)) return;
  const bucket = bucketFor(minute, `zone-sample:${simId}`, () => ({
    kind: 'rollup-1m' as const,
    source: 'zone-sample' as const,
    environmentId,
    simId,
    minuteStart: minute,
    zones: [],
    samples: 0,
  })) as ZoneSampleRollupRecord;
  bucket.samples++;
  const zoneIndex = new Map(bucket.zones.map(z => [z.zoneId, z]));
  for (const zone of zones) {
    if (typeof zone !== 'object' || zone === null) continue;
    const zoneId = (zone as { zoneId?: unknown }).zoneId;
    if (typeof zoneId !== 'string') continue;
    let zoneAgg = zoneIndex.get(zoneId);
    if (zoneAgg === undefined) {
      zoneAgg = { zoneId, parameters: {} };
      bucket.zones.push(zoneAgg);
      zoneIndex.set(zoneId, zoneAgg);
    }
    const params = (zone as { parameters?: unknown }).parameters;
    if (typeof params === 'object' && params !== null) {
      for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
        if (typeof value !== 'number') continue; // booleans carry no min/max/avg
        foldStat(zoneAgg.parameters, key, value);
      }
    }
    const occupancy = (zone as { occupancy?: unknown }).occupancy;
    if (typeof occupancy === 'number') {
      zoneAgg.occupancy = zoneAgg.occupancy ??
        { min: occupancy, max: occupancy, avg: 0, last: occupancy, count: 0 };
      foldStatInto(zoneAgg.occupancy, occupancy);
    }
  }
}

function foldDeviceState(
  bucketFor: (minute: string, key: string, make: () => RollupAggregateRecord) => RollupAggregateRecord,
  minute: string,
  record: Record<string, unknown>,
): void {
  const environmentId = record.environmentId;
  const simId = record.simId;
  const deviceId = record.deviceId;
  if (typeof environmentId !== 'string' || typeof simId !== 'string' ||
    typeof deviceId !== 'string') {
    return;
  }
  const bucket = bucketFor(minute, `device-state:${simId}`, () => ({
    kind: 'rollup-1m' as const,
    source: 'device-state' as const,
    environmentId,
    simId,
    minuteStart: minute,
    devices: [],
  })) as DeviceStateRollupRecord;
  let deviceAgg = bucket.devices.find(d => d.deviceId === deviceId);
  if (deviceAgg === undefined) {
    deviceAgg = {
      deviceId,
      changes: 0,
      last: {
        recordedAt: typeof record.recordedAt === 'string' ? record.recordedAt : minute,
        simTimeSec: typeof record.simTimeSec === 'number' ? record.simTimeSec : 0,
      },
    };
    bucket.devices.push(deviceAgg);
  }
  deviceAgg.changes++;
  if (typeof record.recordedAt === 'string') deviceAgg.last.recordedAt = record.recordedAt;
  if (typeof record.simTimeSec === 'number') deviceAgg.last.simTimeSec = record.simTimeSec;
  if (typeof record.service === 'string') deviceAgg.last.service = record.service;
}

function foldDecision(
  bucketFor: (minute: string, key: string, make: () => RollupAggregateRecord) => RollupAggregateRecord,
  minute: string,
  record: Record<string, unknown>,
): void {
  const bucket = bucketFor(minute, 'decisions', () => ({
    kind: 'rollup-1m' as const,
    source: 'decisions' as const,
    minuteStart: minute,
    counts: {},
    decisions: 0,
  })) as DecisionRollupRecord;
  const source = typeof record.decisionSource === 'string' ? record.decisionSource : 'unknown';
  const decision = typeof record.decision === 'string' ? record.decision : 'unknown';
  const key = `${source}/${decision}`;
  bucket.counts[key] = (bucket.counts[key] ?? 0) + 1;
  bucket.decisions++;
}

function foldStat(
  into: Record<string, { min: number; max: number; avg: number; last: number; count: number }>,
  key: string,
  value: number,
): void {
  const stat = into[key];
  if (stat === undefined) {
    into[key] = { min: value, max: value, avg: value, last: value, count: 1 };
    return;
  }
  foldStatInto(stat, value);
}

function foldStatInto(
  stat: { min: number; max: number; avg: number; last: number; count: number },
  value: number,
): void {
  stat.min = Math.min(stat.min, value);
  stat.max = Math.max(stat.max, value);
  stat.avg = (stat.avg * stat.count + value) / (stat.count + 1);
  stat.last = value;
  stat.count++;
}

/** Minimal decision-record guard (trajectory-store owns the full shape). */
function isDecisionRecord(record: Record<string, unknown>): boolean {
  return typeof record.eventId === 'string' &&
    typeof record.agentId === 'string' &&
    typeof record.decision === 'string';
}

// ---------------------------------------------------------------------------
// Rollup file plumbing
// ---------------------------------------------------------------------------

/** Sources already covered by an existing rollup manifest (idempotency). */
function rollupCoveredSources(log: SegmentedLogPaths): Set<string> {
  const covered = new Set<string>();
  for (const rollupPath of listRollupFiles(log)) {
    try {
      const first = firstLineOf(rollupPath);
      if (first === undefined) continue;
      const manifest = JSON.parse(first) as Partial<RollupManifest>;
      if (manifest.kind !== 'rollup-manifest' || !Array.isArray(manifest.sources)) continue;
      for (const source of manifest.sources) {
        if (typeof source === 'string') covered.add(source);
      }
    } catch {
      // Unreadable rollup (tmp+rename makes this near-impossible) — its
      // sources roll into a NEW file next sweep; visible garbage, no loss.
    }
  }
  return covered;
}

function nextRollupSeq(log: SegmentedLogPaths): number {
  let highest = 0;
  for (const name of listRollupFiles(log).map(fileNameOf)) {
    const match = /^rollup-1m-(\d{6,})\.jsonl$/.exec(name);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/** Rollup file name (`rollup-1m-000001.jsonl`) — zero-padded like segments. */
function rollupFileName(n: number): string {
  return `rollup-1m-${String(n).padStart(6, '0')}.jsonl`;
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop()!;
}

// ---------------------------------------------------------------------------
// Small file utilities
// ---------------------------------------------------------------------------

/**
 * Whole-file JSONL record read (torn tails skipped). The compactor only
 * reads SEALED segments inside ROLLUP_BATCH_MAX_BYTES — bounded sync reads.
 */
function readJsonlRecords(path: string): unknown[] {
  const out: unknown[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // torn tail — skip
    }
  }
  return out;
}

function firstLineOf(path: string): string | undefined {
  const first = readFileSync(path, 'utf-8').split('\n', 1)[0];
  return first !== undefined && first.trim().length > 0 ? first : undefined;
}

/** Wraps a beforeRawDelete hook throw so sweeps can distinguish it (tests). */
class RawDeleteHookAbort extends Error {
  constructor(readonly cause: unknown) {
    super('beforeRawDelete hook aborted the sweep');
  }
}

function emptyResult(): SweepResult {
  return {
    sweptDirs: 0,
    rolledSegments: 0,
    deletedRawFiles: 0,
    rollupFilesWritten: 0,
    rollupBytes: 0,
    rawBytesDeleted: 0,
    logsWithWarnings: 0,
  };
}

function mergeResult(into: SweepResult, from: SweepResult): void {
  into.sweptDirs += from.sweptDirs;
  into.rolledSegments += from.rolledSegments;
  into.deletedRawFiles += from.deletedRawFiles;
  into.rollupFilesWritten += from.rollupFilesWritten;
  into.rollupBytes += from.rollupBytes;
  into.rawBytesDeleted += from.rawBytesDeleted;
  into.logsWithWarnings += from.logsWithWarnings;
}

// ---------------------------------------------------------------------------
// Grain-aware reads (raw within the window, rollups beyond — honest labels)
// ---------------------------------------------------------------------------

/** How the latest-≤cap records were served (the read APIs' honest label). */
export type ReadGrain = 'none' | 'raw' | 'raw+rollup' | 'rollup';

export interface GrainReadResult<R> {
  /** Latest ≤ cap records in chronological order (rollups only cover minutes
   *  older than the raw window, so they always precede the raw tail). */
  records: R[];
  grain: ReadGrain;
  rawCount: number;
  rollupCount: number;
  /** Rollup files consulted (names, for diagnostics). */
  rollupFiles: string[];
}

/** Parse one rollup file into its aggregate records (manifest line skipped). */
function readRollupAggregates<R>(path: string): R[] {
  const out: R[] = [];
  let first = true;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (first) {
      first = false; // the manifest names sources; not an aggregate
      continue;
    }
    try {
      out.push(JSON.parse(trimmed) as R);
    } catch {
      // torn tail — skip
    }
  }
  return out;
}

/**
 * Shared grain logic: raw records first (they are the newest — inside the
 * window); when they cannot fill the cap, older history comes from the
 * rollup aggregates (they only exist beyond the window). `raw` reads and
 * rollup parsing are injected so each public reader keeps its own shapes.
 */
async function readWithRollupFallback<R>(
  readRaw: () => Promise<R[]>,
  rollupFiles: string[],
  cap: number,
): Promise<GrainReadResult<R>> {
  const raw = await readRaw();
  const rollups: R[] = [];
  if (raw.length < cap) {
    for (const path of rollupFiles) {
      rollups.push(...readRollupAggregates<R>(path));
    }
  }
  const overflow = raw.length + rollups.length - cap;
  const trimmedRollups = overflow > 0 ? rollups.slice(overflow) : rollups;
  const records = [...trimmedRollups, ...raw];
  const grain: ReadGrain =
    records.length === 0 ? 'none'
      : trimmedRollups.length === 0 ? 'raw'
        : raw.length === 0 ? 'rollup'
          : 'raw+rollup';
  return {
    records,
    grain,
    rawCount: raw.length,
    rollupCount: trimmedRollups.length,
    rollupFiles: rollupFiles.map(fileNameOf),
  };
}

/**
 * The sim-side timeline read (GET /timeline's data source): raw stitched
 * records within the cap, minute-grain zone-sample / device-state rollups
 * topping up older history beyond it — with the served grain labeled.
 */
export async function readSimTimelineWithRollups(
  dir: string,
  cap: number,
): Promise<GrainReadResult<unknown>> {
  const log = simTimelineLog(dir);
  return readWithRollupFallback(
    () => readSimTimelineRecords(dir, cap),
    listRollupFiles(log),
    cap,
  );
}

/**
 * The decision-trajectory read (GET /trajectory's data source): raw stitched
 * decision records within the cap, decision-count rollups (kind
 * 'rollup-1m', source 'decisions') topping up older history — grain labeled.
 *
 * R81-D2 (R44-extreme-F2): `totalRawCount` counts EVERY raw record on disk
 * (uncapped) so the route can mark the response `truncated` when the
 * interactive cap actually dropped raw history.
 */
export async function readTrajectoryWithRollups(
  dir: string,
  cap: number,
): Promise<GrainReadResult<unknown> & { totalRawCount: number }> {
  const logs = trajectoryLogsOf(dir);
  const rollupFiles = logs.flatMap(log => listRollupFiles(log));
  let totalRawCount = 0;
  const result = await readWithRollupFallback(
    async () => {
      const counted = await readTrajectoryDirRecordsCounted(dir, { cap });
      totalRawCount = counted.totalCount;
      return counted.records;
    },
    rollupFiles,
    cap,
  );
  return { ...result, totalRawCount };
}
