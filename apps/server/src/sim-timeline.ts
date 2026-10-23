/**
 * Sim timeline capture (Fix-14) — 仿真侧时序落盘，供回放烘焙
 * (R5-P1-2：回放 ≠ 仿真复盘——纯仿真运行产生 observationEvents=0 的空回放)
 *
 * 写侧：env 背书仿真运行期间，把两类仿真侧时序追加到该仿真的 trajectory
 * 目录下（与 TrajectoryRecorder 的决策 JSONL 同目录，回放创建时一并扫描）：
 * - `zone-sample`：按仿真时间周期采样的全 zone 物理参数快照
 *   （temperature/co2/occupancy 等），间隔可配（EAF_ZONE_SAMPLE_SIM_SEC，
 *   默认每 60 仿真秒）。wall-clock 轮询 + sim-time 阈值触发；仿真停止后
 *   采样器自行清除。
 * - `device-state`：引擎事件总线上的 DEVICE_STATE_CHANGE（设备命令执行、
 *   设备控制回路的状态翻转）。
 *
 * 决策/协作记录（第三类回放事件 `sim-decision` 的数据源）由 core 的
 * TrajectoryRecorder 写入同目录的 trajectory JSONL，不在本模块。
 *
 * 记录同时带 wall-time（recordedAt，回放窗口过滤用）与 sim-time
 * （simTimeSec，复盘对照用）。写失败只告警，绝不阻塞仿真运行。
 *
 * 磁盘（T-011 → Living-worlds P2 分段化）：全 zone 采样每条 ~21KB，speed 30
 * 下每 2 wall-秒一条，一天可写 6.8GB。P2 起写入 SIZE-SEGMENTED 段文件
 * `<dir>/sim-timeline/segment-000001.jsonl…`（见 segmented-log.ts）：活动段
 * 达到上限即封口开新段——封口段永不重写（T-011「裁半摊薄」的零重写升级），
 * 历史不再被裁掉。段上限沿用 EAF_SIM_TIMELINE_MAX_SIZE（默认 50MB，语义从
 * 「单文件上限」变为「单段上限」；50MB 仍低于回放源的 64MB 读取上限）。
 * 段旧于回放窗口（EAF_ROLLUP_WINDOW_DAYS，默认 7 天）后由 timeline-compactor
 * 压实为分钟粒度 rollup 并删除原始段（rollup 先落盘、后删原始段的崩溃安全
 * 顺序）。目录级 GC（记录移除即删目录、启动清扫过期目录）见
 * simulation-registry.ts。P2 之前的单文件 `sim-timeline.jsonl` 被读取侧作为
 * 最旧的段透明缝合（迁移 = 结构性兼容）。
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  appendSegmentedLine,
  appendSegmentedLines,
  listRawFiles,
  segmentedLogOf,
} from '@active-collaboration/core';
import type { EngineRuntime } from '@active-collaboration/core';

/**
 * 每个仿真目录下的时间线文件名（与 trajectory JSONL 同目录）。P2 起这是
 * LEGACY 单文件名：新写入走 `<dir>/sim-timeline/segment-<n>.jsonl`，此文件
 * 仅在 P2 之前的目录里存在，读取侧作为最旧段缝合。
 */
export const SIM_TIMELINE_FILE = 'sim-timeline.jsonl';

/** 时间线分段日志的目录名（`<trajectoryDir>/sim-timeline/`）。 */
export const SIM_TIMELINE_BASE = 'sim-timeline';

/** `dir` 下时间线日志的段布局。 */
export function simTimelineLog(dir: string) {
  return segmentedLogOf(dir, SIM_TIMELINE_BASE);
}

/**
 * 单文件默认上限（T-011）：50MB。registry 从 config 线程传入实际值。
 */
export const DEFAULT_SIM_TIMELINE_MAX_BYTES = 50 * 1024 * 1024;

/** zone 参数采样的 wall-clock 轮询间隔（是否采样由 sim-time 阈值决定）。 */
const ZONE_SAMPLE_POLL_MS = 200;

export interface ZoneSampleRecord {
  kind: 'zone-sample';
  environmentId: string;
  simId: string;
  /**
   * P2F (living-worlds §10.4, 缺口二): EXPLICIT fork provenance — present on
   * records written by a sandbox sim (environmentId then carries the SOURCE
   * env, matching the trajectory records' scenario-keyed visibility so a
   * fork's timeline is visible to env-level exports, with the fork named
   * instead of implied by key coincidence).
   */
  forkId?: string;
  /** 采样时的仿真秒。 */
  simTimeSec: number;
  /** 采样时的 wall-time（ISO）——回放窗口过滤依据。 */
  recordedAt: string;
  zones: Array<{
    zoneId: string;
    parameters: Record<string, number | boolean>;
    /**
     * T-061: the zone's DECLARED baseline, when it has one — timeline
     * consumers see declared-vs-sampled side by side instead of guessing
     * what a custom quantity was authored at.
     */
    baseline?: Record<string, number | boolean>;
    occupancy?: number;
  }>;
}

export interface DeviceStateRecord {
  kind: 'device-state';
  environmentId: string;
  simId: string;
  /** P2F §10.4: explicit fork provenance (see ZoneSampleRecord.forkId). */
  forkId?: string;
  simTimeSec: number;
  recordedAt: string;
  deviceId: string;
  /** 触发本次状态变化的服务/命令名（如 'turn-on'）。 */
  service?: string;
  /**
   * T-039 (DevLoop R17, FF-F10 residue): the command's arguments — the
   * intended change (e.g. `{temperature: 20}` for set-temperature).
   * Omitted for bare commands (turn-on) and non-JSON-safe payloads.
   */
  params?: Record<string, unknown>;
  /**
   * T-039: the executed change's reported data (the device's result
   * payload), when JSON-safe and bounded. Until now device-state records
   * carried only deviceId+service — physical forensics off the timeline
   * was impossible because the CHANGED FIELDS were never recorded.
   */
  result?: unknown;
  /**
   * R17 params-purity fix (T-034×T-039 regression): who invoked the
   * command — the invocation-context actor, carried as a TOP-LEVEL field
   * (the commands route / agreement invocation path passes it alongside
   * params). `params` stays the command's pure semantic arguments (T-019
   * replay hygiene); attribution no longer pollutes it.
   */
  actor?: string;
}

/**
 * T-039: pull the data-payload fields for a device-state record out of a
 * DEVICE_STATE_CHANGE / DEVICE_OPERATION_EXECUTED event payload:
 * - `params` / `parameters` → `params` (the intended change);
 * - `result` → unwrapped when the operation-executed wrapper shape
 *   `{success, result, …}` is detected (the inner result is the data).
 *
 * Both are JSON-cloned with a size bound (params 2 KB, result 4 KB): the
 * timeline file lives under a 50 MB cap (T-011) and one bloated record
 * must not distort it — over-budget payloads are omitted, never truncated.
 */
export function deviceStateDataFields(
  payload: Record<string, unknown>,
): { params?: Record<string, unknown>; result?: unknown } {
  const fields: { params?: Record<string, unknown>; result?: unknown } = {};
  const rawParams = payload.params !== undefined ? payload.params : payload.parameters;
  if (
    typeof rawParams === 'object' && rawParams !== null && !Array.isArray(rawParams) &&
    Object.keys(rawParams).length > 0
  ) {
    const cloned = boundedJsonClone(rawParams, 2048);
    if (cloned !== undefined) fields.params = cloned as Record<string, unknown>;
  }
  const rawResult = payload.result;
  if (rawResult !== undefined && rawResult !== null) {
    const inner =
      typeof rawResult === 'object' && rawResult !== null && !Array.isArray(rawResult) &&
      'result' in rawResult && (rawResult as { success?: unknown }).success !== undefined
        ? (rawResult as { result: unknown }).result
        : rawResult;
    const cloned = boundedJsonClone(inner, 4096);
    if (cloned !== undefined) fields.result = cloned;
  }
  return fields;
}

/** Deep JSON-clone; undefined when not serializable or over the byte cap. */
function boundedJsonClone(value: unknown, maxBytes: number): unknown | undefined {
  try {
    const text = JSON.stringify(value);
    if (text === undefined || Buffer.byteLength(text, 'utf-8') > maxBytes) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export type SimTimelineRecord = ZoneSampleRecord | DeviceStateRecord;

// ---------------------------------------------------------------------------
// T-102 (DevLoop R32, F-PH24) — device-state dedupe at the recorder
// ---------------------------------------------------------------------------

/**
 * T-102: dedupe window for the device-state recorder. The same command
 * legitimately arrives on BOTH bus seams (SimulatedDevice's own
 * DEVICE_OPERATION_EXECUTED and the coordinator / EnvironmentCenter echo
 * ~2ms later — R29 measured 23/28 timeline keys duplicated); a repeated
 * record with the SAME (simTimeSec, deviceId, service) key inside this
 * wall-clock window is that echo, not a second command. Sim time advances
 * only on ticks/steps, so genuinely distinct commands carry distinct
 * simTimeSec keys the moment a tick boundary passes between them.
 */
export const DEVICE_STATE_DEDUPE_WINDOW_MS = 10_000;
/** Bound on remembered keys (the map self-prunes by wall time; this is the hard cap). */
const DEVICE_STATE_DEDUPE_MAX_KEYS = 1024;

/**
 * T-102: first-writer-wins dedupe by (simTimeSec, deviceId, service) at the
 * timeline recorder. The FIRST record wins (it is the device's own emission —
 * the richest: params + result + actor); the near-simultaneous echo from the
 * second bus seam is dropped. Entries expire after the wall-clock window and
 * the map is hard-capped (oldest first) so a long-running sim cannot grow it
 * without bound.
 */
export class DeviceStateDedupe {
  private readonly seen = new Map<string, number>(); // key -> recorded wall ms
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private now: () => number;

  constructor(options: { windowMs?: number; maxKeys?: number; now?: () => number } = {}) {
    this.windowMs = options.windowMs ?? DEVICE_STATE_DEDUPE_WINDOW_MS;
    this.maxKeys = options.maxKeys ?? DEVICE_STATE_DEDUPE_MAX_KEYS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a key's arrival. Returns true when this is the FIRST record for
   * the key inside the window (record it); false when it is a duplicate
   * echo (drop it).
   */
  admit(key: string): boolean {
    const t = this.now();
    const prior = this.seen.get(key);
    if (prior !== undefined && t - prior < this.windowMs) return false; // echo — drop
    if (this.seen.size >= this.maxKeys && !this.seen.has(key)) {
      // Hard cap: drop the OLDEST entries (Map preserves insertion order).
      const excess = this.seen.size - this.maxKeys + 1;
      let dropped = 0;
      for (const oldest of this.seen.keys()) {
        this.seen.delete(oldest);
        if (++dropped >= excess) break;
      }
    }
    this.seen.set(key, t);
    return true;
  }

  /** The dedupe key for one device-state record (fix-plan T-102 formula). */
  static keyOf(record: Pick<DeviceStateRecord, 'simTimeSec' | 'deviceId' | 'service'>): string {
    return `${record.simTimeSec}|${record.deviceId}|${record.service ?? ''}`;
  }
}

export interface SimTimelineWriteOptions {
  /**
   * 单个时间线段的大小上限（T-011 磁盘 GC 的 P2 分段语义）。活动段追加
   * 前已超限时，封口该段、开新段再写入——封口段永不重写，历史不丢。
   * `<= 0` 关闭轮转（无界单段）。缺省 DEFAULT_SIM_TIMELINE_MAX_BYTES。
   */
  maxFileBytes?: number;
  /**
   * Living-worlds P2：段轮转钩子。每次因达到上限封口旧段、开启新段后触发
   * （封口 = 该段再不会被写入）。seams.ts 用它挂 timeline-compactor 的
   * 单目录清扫——写得越快，压实越勤（旋转节奏 = 压实节奏的摊销）。钩子
   * 失败只告警，绝不影响已完成的追加。
   */
  onRotate?: (info: { segmentDir: string; sealedPath: string }) => void;
}

/**
 * 追加一条时间线记录（write-through，与 TrajectoryRecorder 同策略）。
 * P2：写入分段日志（segmented-log.ts）；轮转代替了 T-011 的裁半重写。
 * 写失败只告警——时间线是复盘增强，绝不能阻塞仿真。
 */
export function appendSimTimelineRecord(
  dir: string,
  record: SimTimelineRecord,
  options: SimTimelineWriteOptions = {},
): void {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_SIM_TIMELINE_MAX_BYTES;
  try {
    const log = simTimelineLog(dir);
    const { sealedPath } = appendSegmentedLine(log, JSON.stringify(record), maxFileBytes);
    if (sealedPath !== undefined) {
      try {
        options.onRotate?.({ segmentDir: log.segmentDir, sealedPath });
      } catch (error) {
        console.warn(`sim-timeline: rotation hook for sim ${record.simId} failed:`, error);
      }
    }
  } catch (error) {
    console.warn(`sim-timeline: append for sim ${record.simId} failed:`, error);
  }
}

// ---------------------------------------------------------------------------
// R30 Task 5 — batched timeline writes (write-through stays the default)
// ---------------------------------------------------------------------------

/** Flush thresholds: records or interval, whichever comes first. */
export const TIMELINE_BATCH_MAX_RECORDS = 100;
export const TIMELINE_BATCH_FLUSH_MS = 1000;

/**
 * R30 Task 5: buffer timeline records in memory and flush to the segmented
 * log in BATCHES — every flush is one append per segment instead of one
 * open/write/close per record (the per-record syscall was the dominant disk
 * cost at high write rates; the JSONL lane is where this platform's
 * timeline/trajectory volume actually flows — SQLite only holds the
 * governance/observation rows, which are not per-tick).
 *
 * Tradeoff, honestly stated: records buffered at crash time are lost (the
 * write-through path was crash-atomic per line; readers already tolerate
 * torn tails). The 1s/100-record bound caps the exposure; graceful
 * shutdown (registry stop paths → closeSimTimelineWriter) drains fully.
 * The T-011 discipline is unchanged: rotation is byte-driven, sealed
 * segments are never rewritten, records are never dropped by the writer.
 */
export class BatchedTimelineWriter {
  private buffer: string[] = [];
  private readonly timer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly dir: string,
    private readonly simId: string,
    private readonly options: SimTimelineWriteOptions = {},
    private readonly maxRecords: number = TIMELINE_BATCH_MAX_RECORDS,
    flushIntervalMs: number = TIMELINE_BATCH_FLUSH_MS,
  ) {
    this.timer = setInterval(() => this.flush(), flushIntervalMs);
    this.timer.unref();
  }

  /** The timeline directory this writer owns (identity check for reuse). */
  get dirOf(): string {
    return this.dir;
  }

  /** Buffer one record (serialized immediately — flush is pure I/O). */
  append(record: SimTimelineRecord): void {
    if (this.closed) {
      appendSimTimelineRecord(this.dir, record, this.options); // never drop
      return;
    }
    try {
      this.buffer.push(JSON.stringify(record));
    } catch (error) {
      console.warn(`sim-timeline: serialize for sim ${record.simId} failed:`, error);
      return;
    }
    if (this.buffer.length >= this.maxRecords) this.flush();
  }

  /** Flush the buffer now (one batched append per segment). */
  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const maxFileBytes = this.options.maxFileBytes ?? DEFAULT_SIM_TIMELINE_MAX_BYTES;
    try {
      const log = simTimelineLog(this.dir);
      const { sealedPath } = appendSegmentedLines(log, batch, maxFileBytes);
      if (sealedPath !== undefined) {
        try {
          this.options.onRotate?.({ segmentDir: log.segmentDir, sealedPath });
        } catch (error) {
          console.warn(`sim-timeline: rotation hook for sim ${this.simId} failed:`, error);
        }
      }
    } catch (error) {
      console.warn(`sim-timeline: batched flush for sim ${this.simId} failed:`, error);
    }
  }

  /** Final flush + stop the timer (idempotent; later appends degrade to write-through). */
  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
  }
}

/** Live batched writers by sim id (graceful-shutdown drain points). */
const batchedWriters = new Map<string, BatchedTimelineWriter>();

/** The (lazily created) batched writer for a sim's timeline lane. */
export function simTimelineWriterOf(
  simId: string,
  dir: string,
  options: SimTimelineWriteOptions = {},
): BatchedTimelineWriter {
  const existing = batchedWriters.get(simId);
  if (existing !== undefined && existing.dirOf === dir) return existing;
  // Same sim id re-created under a different directory (test isolation,
  // env rebuild): retire the stale writer before its dir diverges.
  existing?.close();
  const writer = new BatchedTimelineWriter(dir, simId, options);
  batchedWriters.set(simId, writer);
  return writer;
}

/** Drain + retire a sim's writer (registry stop paths). Idempotent. */
export function closeSimTimelineWriter(simId: string): void {
  // T-101: the sampler dies with the writer lane (stop paths own both).
  removeZoneSampler(simId);
  batchedWriters.get(simId)?.close();
  batchedWriters.delete(simId);
}

/** Drain every live writer (graceful shutdown / stopAll). */
export function flushAllSimTimelineWriters(): void {
  for (const writer of batchedWriters.values()) writer.flush();
}

// ---------------------------------------------------------------------------
// 读侧（T-005）—— GET /api/simulations/:id/timeline 的数据源
// ---------------------------------------------------------------------------

/** 每次查询返回的记录上限（最新优先保留），与 trajectory 读侧同量级。 */
export const SIM_TIMELINE_RECORD_CAP = 500;

/**
 * T-005（P2 段缝合适配）：流式读取 `<dir>` 下的时间线——LEGACY 单文件
 * `sim-timeline.jsonl`（若在，最旧）+ `sim-timeline/segment-<n>.jsonl` 依序
 * 缝合，返回最新 ≤ cap 条记录（追加顺序 = 时间顺序）。与 trajectory-store
 * 的读侧同策略：流式 + 有界环（总量可能远超内存，不值得整读）；rollup
 * 文件（`rollup-*`）不是原始记录，不进入本读侧（grain 感知读取见
 * timeline-compactor.ts 的读侧配对函数）；目录缺失不是错误——意为「无
 * 时间线」，返回空列表；解析失败的行（崩溃残留的半行）跳过。
 */
export async function readSimTimelineRecords(
  dir: string,
  cap: number = SIM_TIMELINE_RECORD_CAP,
): Promise<SimTimelineRecord[]> {
  const ring: SimTimelineRecord[] = [];
  await forEachSimTimelineRecord(dir, record => {
    ring.push(record);
    if (ring.length > cap) ring.shift();
  });
  return ring;
}

/**
 * 流式遍历一个仿真目录下的全部原始时间线记录（legacy 文件 + 段，按追加
 * 顺序），每条调用 `onRecord`。eval-report 等只需要扫描（有界环之外的
 * 聚合）的消费方用这个；读侧唯一的容忍策略在这里集中：半行跳过、目录
 * 缺失 = 空。返回实际读到的文件数（可作诊断）。
 */
export async function forEachSimTimelineRecord(
  dir: string,
  onRecord: (record: SimTimelineRecord) => void,
): Promise<number> {
  let files = 0;
  for (const filePath of listRawFiles(simTimelineLog(dir))) {
    files++;
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
          continue; // 半行（崩溃残留）——跳过
        }
        if (!isSimTimelineRecord(parsed)) continue;
        onRecord(parsed);
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return files;
}

/** 最小结构守卫——写侧（本模块 + registry）拥有完整形状。 */
function isSimTimelineRecord(value: unknown): value is SimTimelineRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (record.kind === 'zone-sample' || record.kind === 'device-state') &&
    typeof record.environmentId === 'string' &&
    typeof record.simId === 'string' &&
    typeof record.simTimeSec === 'number' &&
    typeof record.recordedAt === 'string';
}

export interface ZoneSamplerOptions extends SimTimelineWriteOptions {
  runtime: EngineRuntime;
  /** 该仿真的 trajectory 目录。 */
  dir: string;
  environmentId: string;
  simId: string;
  /** P2F §10.4: sandbox sims stamp their fork id on every sampled record. */
  forkId?: string;
  /** 采样间隔（仿真秒）。 */
  everySimSec: number;
  /** R30 Task 5: batched writer — when given, samples ride the batch lane. */
  writer?: BatchedTimelineWriter;
}

/**
 * T-101 (DevLoop R32, F-PH23): the zone sampler. Two drive lanes share ONE
 * cadence gate (`lastSampleSimSec`, sim-time threshold):
 *   - the wall-clock poll below (running sims — the historical behavior), and
 *   - the MANUAL lane (`sampleIfDue(true)`) called by the /step route after
 *     `runtime.step(n)` — the physics tester's pause+step workflow used to
 *     leave the timeline with device-state records and ZERO zone-samples.
 * Manual samples are allowed in 'created'/'paused' (the states /step works
 * in) and skipped when stopped.
 */
export class ZoneSampleRecorder {
  private lastSampleSimSec = Number.NEGATIVE_INFINITY; // 首轮运行立即采样（t=0 基线）
  private cleared = false;

  constructor(private readonly options: ZoneSamplerOptions) {}

  /**
   * Take a zone snapshot when the sim-time cadence allows it.
   * `manual` = the /step lane (paused sims sample too); the wall-clock lane
   * passes false (samples only while running — a paused sim's poll would
   * otherwise emit a duplicate at the frozen sim time... the threshold
   * already prevents that, but the state gate keeps lane semantics honest).
   */
  sampleIfDue(manual: boolean): boolean {
    if (this.cleared) return false;
    const { runtime, dir, environmentId, simId, forkId, everySimSec, maxFileBytes, writer } =
      this.options;
    const state = runtime.getState();
    if (state === 'stopped') {
      this.clear();
      return false;
    }
    if (!manual && state !== 'running') return false;
    const simTimeSec = runtime.getSimTimeSec();
    if (simTimeSec - this.lastSampleSimSec < everySimSec) return false;
    this.lastSampleSimSec = simTimeSec;
    const snapshot = runtime.getSnapshot();
    const record: ZoneSampleRecord = {
      kind: 'zone-sample',
      environmentId,
      simId,
      ...(forkId !== undefined ? { forkId } : {}),
      simTimeSec,
      recordedAt: new Date().toISOString(),
      zones: snapshot.zones.map(zone => ({
        zoneId: zone.id,
        parameters: zone.parameters,
        ...(zone.baseline !== undefined ? { baseline: zone.baseline } : {}),
        ...(zone.occupancy !== undefined ? { occupancy: zone.occupancy } : {}),
      })),
    };
    if (writer !== undefined) {
      writer.append(record); // R30 Task 5: batch lane
      return true;
    }
    appendSimTimelineRecord(dir, record, { maxFileBytes });
    return true;
  }

  /** Retire the recorder (runtime stopped / registry teardown). Idempotent. */
  clear(): void {
    this.cleared = true;
  }
}

/** T-101: live zone samplers by sim id (the /step route's lookup lane). */
const zoneSamplersBySim = new Map<string, ZoneSampleRecorder>();

/**
 * T-101 (F-PH23): after a manual `POST /step`, append a zone sample when the
 * cadence gate allows — the wall-clock poll cannot fire while paused, and a
 * stepped sim advanced sim time (physics moved) without any zone-sample
 * landing in the timeline. Called by the step route; a sim without a sampler
 * (legacy scenario sims, stopped runs) is a no-op.
 */
export function recordStepZoneSamples(simId: string): void {
  try {
    zoneSamplersBySim.get(simId)?.sampleIfDue(true);
  } catch (error) {
    console.warn(`sim-timeline: step zone-sample for sim ${simId} failed:`, error);
  }
}

/** Retire + forget a sim's sampler (registry stop paths drain the writer too). */
function removeZoneSampler(simId: string): void {
  zoneSamplersBySim.get(simId)?.clear();
  zoneSamplersBySim.delete(simId);
}

/**
 * 启动 zone 参数采样器：wall-clock 轮询运行中的 runtime，sim-time 每推进
 * everySimSec 采样一次全 zone 参数。runtime 停止后采样器自行清除
 * （registry 的各 stop 路径都会 stop runtime，无需额外生命周期钩子）。
 * T-101: the recorder registers itself under the sim id so the /step route
 * can drive the manual lane. 返回手动停止函数（测试用）。
 */
export function startZoneSampler(options: ZoneSamplerOptions): () => void {
  const recorder = new ZoneSampleRecorder(options);
  zoneSamplersBySim.set(options.simId, recorder);
  const timer = setInterval(() => recorder.sampleIfDue(false), ZONE_SAMPLE_POLL_MS);
  // 采样器不得阻止进程退出（server close 后等下一轮自检清除）。
  timer.unref();
  return () => {
    clearInterval(timer);
    if (zoneSamplersBySim.get(options.simId) === recorder) {
      zoneSamplersBySim.delete(options.simId);
    }
    recorder.clear();
  };
}
