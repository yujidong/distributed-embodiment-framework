/**
 * Replay service — P-E 时间窗 → scenario JSON 转换
 * (multi-user-simulation-design.md §7, §11 P-E)
 *
 * "重现上周三暴雨那晚"：把一个 wall-clock 时间窗内的 observations 时序 +
 * command_log 记录折叠成一份 scenario JSON v1.0 的事件序列，以环境当前
 * 快照（environment bridge）为底。v1 只做离线转换，不做在线 time-travel。
 *
 * 映射语义：
 * - 窗口语义与 ObservationStore.query 一致：from 含、to 不含；
 *   atSimTimeSec = (记录 wall_time − from) / 1000（窗口起点 = 0 秒，
 *   毫秒精度）。仿真里 1 秒 = 现实 1 秒的"重放"。
 * - 初始状态：同一 (entity_id, key) 取窗口起点前的最后一次观测，合并进
 *   解析出的设备实例 initialState（与 twin-sync 把观测写回设备行的语义
 *   一致）——回放从窗口起点的真实状态开始，而不是从"现在"的状态开始。
 * - 窗内观测：只有相对上一已知值（初始状态或前一条窗内观测）发生变化
 *   的才生成事件；无变化计入报告的 unchanged。
 * - entity → 设备解析：entity_id 直接命中设备实例 id（twin-sync 的写法）
 *   优先；否则按 sync_bindings 反查（source == entity_id 且
 *   attribute_key == key，覆盖 hass:xxx 源标识的写法）。解析不出的观测
 *   跳过并计入 skipped。
 * - command_log：kind 为 `device-command` 的设备控制记录，payload 形如
 *   `{ deviceId | deviceInstanceId, commandName, params?, before, after }`。
 *   T-019：after 是命令后的设备全量状态（非差量），回放事件只携带命令的
 *   参数面 —— commandName + params 的每个数值/布尔参数一个事件；无可注入
 *   参数的命令（如裸 turn-on）发一个 `parameter=commandName, value=true`
 *   的语义标记事件；字符串/对象参数随 details.params 原样保留。无
 *   commandName 的 legacy 记录退回 before/after 差量。
 * - 事件落在设备所在 zone（scenario 事件是 zone 级物理参数注入），
 *   type 为 observation-replay / device-command-replay，parameter 为
 *   观测/控制键，value 为标量值。
 *
 * 仿真侧时序（Fix-14，R5-P1-2"回放 ≠ 仿真复盘"）：构造时传入
 * trajectoryBaseDir 后，还会扫描 `<trajectoryBaseDir>/<simId>/` 下的
 * JSONL（Living-worlds P2：顶层 legacy 文件 + 分段子目录里的
 * `segment-*.jsonl`；rollup 聚合文件被排除——见 iterSimJsonlFiles 的
 * 回放不变量），把窗口内属于本环境的仿真记录一并烘焙。烘焙事件带
 * `observationOnly: true`（T-019）——它们是记录的世界状态而非刺激，
 * 引擎对 observationOnly 事件不做物理注入、不做 agent 扇出（详情放
 * 事件的 details 字段供回放消费方阅读）：
 * - trajectory JSONL 的决策/协作记录 → `sim-decision` 事件（agentId、
 *   decision、decisionSource、reasoning、collaborationId 等）；
 * - sim-timeline.jsonl 的 zone 参数采样 → `zone-sample` 事件
 *   （parameters 全量 + occupancy）；
 * - sim-timeline.jsonl 的设备状态变化 → `device-state` 事件。
 * 环境过滤依据记录自带的 scenario/environmentId 字段，因此显式
 * options.trajectoryDir 覆盖目录的仿真不在扫描范围内。
 *
 * 生成的完整场景（快照 + 回放事件）再过一遍 loadScenarioFile 的
 * schema + 语义校验，保证产物可被 scenario API / 沙箱 fork 直接消费。
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, type Dirent, promises as fsp } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  loadScenarioFile,
  type FlowDefinition,
  type ScenarioDefinition,
  type ScenarioDevice,
  type ScenarioZone,
  type TrajectoryRecord,
} from '@active-collaboration/core';

import { environmentToScenario } from './environment-bridge.js';
import { demoToScenarioMeta, mapMetaToScenarioMeta } from './env-map-conversion.js';
import { ApiError } from './errors.js';
import { flowRowToDefinition, type FlowStore } from './db/flow-store.js';
import { parseJsonObject, parseMapData } from './db/environment-store.js';
import type {
  DeviceInstanceRow,
  EnvFloorPlan,
  EnvGeoCenter,
  EnvironmentRow,
  EnvironmentStore,
  EnvZone,
} from './db/environment-store.js';
import type { CommandLogStore } from './db/proposal-store.js';
import type { SandboxRow } from './db/sandbox-store.js';
import type {
  ObservationStore,
  SyncBindingStore,
} from './db/sync-store.js';
import type { DeviceStateRecord, ZoneSampleRecord } from './sim-timeline.js';
import { forkLineageOf, type ForkLineage } from './fork-lineage.js';

/** Replay 识别的设备控制类 command_log kind（§4.3 预留格式）。 */
export const DEVICE_COMMAND_KIND = 'device-command';

/** 窗口查询的记录上限（防御性；与 observations 路由的 max limit 一致）。 */
const REPLAY_WINDOW_LIMIT = 5000;

/** 仿真时序烘焙的事件上限（防御性；超出计入 skipped）。 */
const REPLAY_SIM_EVENT_LIMIT = 5000;

/** 单个 JSONL 源文件的读取上限（防御性；LLM trajectory 行带完整 prompt）。 */
const REPLAY_SOURCE_FILE_MAX_BYTES = 64 * 1024 * 1024;

type Scalar = number | boolean | string;

export interface ReplayWindowInput {
  /** ISO wall-time，含。 */
  from: string;
  /** ISO wall-time，不含。 */
  to: string;
  name?: string;
  description?: string;
}

export interface ReplayReport {
  envId: string;
  window: { from: string; to: string };
  /** 生成的回放事件总数（各类事件之和）。 */
  eventCount: number;
  observationEvents: number;
  commandEvents: number;
  /** 仿真侧时序（Fix-14）：trajectory 决策/协作记录烘焙的事件数。 */
  decisionEvents: number;
  /** 仿真侧时序（Fix-14）：zone 参数采样烘焙的事件数。 */
  zoneSampleEvents: number;
  /** 仿真侧时序（Fix-14）：设备状态变化烘焙的事件数。 */
  deviceStateEvents: number;
  /**
   * S2 (device privacy): events OMITTED because they carry another tenant's
   * device telemetry and the exporting viewer is not the env/device owner
   * (0 = full-tier export — env owner, device owners see their own).
   */
  redactedDeviceEvents: number;
  /**
   * T-020: 环境的 flow 行随导出嵌入 scenario.flows 的条数（含禁用的）。
   */
  flowsEmbedded: number;
  /**
   * T-020: 因 flow 校验失败（环境漂移：死 zone 引用/UNSAT 指派）被丢弃
   * 的 flow 条数及其校验问题（空数组 = 全部嵌入）—— 回放本身不受阻，
   * 但报告如实说明。
   */
  flowsSkipped: number;
  flowIssues: string[];
  /** 合并进设备 initialState 的窗口前观测条数。 */
  initialStateCount: number;
  /** 无法解析到设备（或负载非法）而跳过的记录数。 */
  skipped: number;
  /** 值未变化而未生成事件的窗内观测条数。 */
  unchanged: number;
  /**
   * P2F (living-worlds §10.4): the machine-checkable lineage of every FORK
   * whose records were baked into this replay (decision / zone-sample /
   * device-state events) — forkId/envId/forkedAt/policy/checkpoint id /
   * scenario fingerprint, window = THIS replay's window. Empty when no fork
   * contributed (the replay is purely authoritative-world history).
   */
  forks: ForkLineage[];
}

export interface ReplayResult {
  definition: ExportableScenarioDefinition;
  report: ReplayReport;
}

/**
 * S2 (device privacy): who is exporting the replay window. Undefined = the
 * legacy full-trust caller (owner-tier); a userId that is neither the env
 * owner nor the device owner exports COARSE replays — foreign devices'
 * observation/command/device-state events are omitted (counted in
 * report.redactedDeviceEvents) and their snapshot initialState is stripped:
 * a replay export is a READ surface of device telemetry, and telemetry only
 * travels through the service layer (agreements / access grants). Anonymous
 * share links mint by a non-owner therefore carry no foreign readings.
 */
export interface ReplayViewer {
  userId: string | null;
}

/**
 * T-101: the exported replay scenario is the validated definition PLUS the
 * sidecar fields the core loader drops on the way OUT — the top-level `map`
 * block, per-zone `polygon`, device `brand`/`position` — mirroring exactly
 * what the import path (environment-import.ts) recovers from a raw body, so
 * a replayed world re-imports at its original map tier instead of collapsing
 * to a plain grid.
 */
export interface ExportableScenarioDefinition extends ScenarioDefinition {
  map?: {
    type: string;
    center?: EnvGeoCenter;
    zoom?: number;
    floorPlans?: EnvFloorPlan[];
  };
  zones: Array<ScenarioZone & { polygon?: EnvZone['polygon'] }>;
  devices: Array<ScenarioDevice & {
    brand?: string;
    position?: Record<string, unknown>;
  }>;
}

export interface ReplayServiceDeps {
  envStore: EnvironmentStore;
  observationStore: ObservationStore;
  commandLogStore: CommandLogStore;
  syncBindingStore: SyncBindingStore;
  /**
   * Per-simulation trajectory base dir (W8/Fix-14). When set, replays also
   * bake the sim-side timeline (trajectory decisions + sim-timeline.jsonl)
   * of this environment's simulations; unset → observations/command_log only.
   */
  trajectoryBaseDir?: string;
  /**
   * T-020 (DevLoop R17): when provided, the environment's flow rows are
   * embedded in the replay scenario's `flows` array (all rows, enabled and
   * disabled) — the export hop of the four-channel flow promise. Unset →
   * flows-free replays (legacy callers).
   */
  flowStore?: FlowStore;
  /**
   * P2F (living-worlds §10.4): fork-row lookup for replay lineage — resolves
   * which baked records came out of a sandbox (report.forks). Duck-typed so
   * degenerate harnesses keep compiling; absent → forks: [] (honest: lineage
   * resolution off, not fabricated).
   */
  sandboxStore?: {
    get(forkId: string): SandboxRow | undefined;
    findBySimulationId(simulationId: string): SandboxRow | undefined;
  };
}

export class ReplayService {
  constructor(private readonly deps: ReplayServiceDeps) {}

  /**
   * 烘焙仿真侧时序（Fix-14）：扫描 trajectoryBaseDir 下本环境各仿真目录的
   * JSONL（core TrajectoryRecorder 的决策记录 + sim-timeline.jsonl 的
   * 采样/状态记录），把窗口内属于本环境的记录转成回放事件。环境归属按记录
   * 自带的 scenario / environmentId 字段判定（目录名/mtime 只是性能预筛，
   * 见 iterSimJsonlFiles 与 readJsonlTextAsync）；zone 解析不到或超出上限
   * 的记录计入 skipped。读盘失败（目录不存在、半行写入等）静默跳过——
   * 仿真时序是回放增强，不是硬依赖。
   *
   * R2-BUG-05：异步化——文件 I/O 走 fs.promises、每 JSONL_LINE_YIELD_INTERVAL
   * 行让出一次事件循环；烘焙曾是部署级全量同步扫描（55s+ 阻塞整个进程，
   * 与窗口大小无关），现在只读本环境目录 + mtime 不早于窗口起点的段。
   */
  private async bakeSimTimeline(
    env: EnvironmentRow,
    input: ReplayWindowInput,
    fromMs: number,
    deviceById: Map<string, DeviceInstanceRow>,
    snapshot: ScenarioDefinition,
    events: Array<Record<string, unknown>>,
    nextSeq: () => number,
    tierOf: (device: DeviceInstanceRow | undefined) => 'full' | 'coarse' = () => 'full',
  ): Promise<{ decisionEvents: number; zoneSampleEvents: number; deviceStateEvents: number; skipped: number; redactedDeviceEvents: number; forkIds: Set<string> }> {
    const counts = { decisionEvents: 0, zoneSampleEvents: 0, deviceStateEvents: 0, skipped: 0, redactedDeviceEvents: 0, forkIds: new Set<string>() };
    const baseDir = this.deps.trajectoryBaseDir;
    if (baseDir === undefined) return counts;

    const zoneIds = new Set(snapshot.zones.map(zone => zone.id));
    const fallbackZoneId = snapshot.zones[0]?.id;
    if (fallbackZoneId === undefined) return counts; // 无 zone 的世界落不了事件
    // agent → 其管理的第一个有效 zone（决策事件挂到 agent 的责任区）。
    const agentZoneById = new Map<string, string>();
    for (const agent of snapshot.agents) {
      const zoneId = agent.managesZoneIds.find(id => zoneIds.has(id));
      if (zoneId !== undefined) agentZoneById.set(agent.id, zoneId);
    }

    let baked = 0;
    const pushEvent = (
      kind: 'decisionEvents' | 'zoneSampleEvents' | 'deviceStateEvents',
      event: Record<string, unknown>,
    ): void => {
      if (baked >= REPLAY_SIM_EVENT_LIMIT) {
        counts.skipped++;
        return;
      }
      events.push(event);
      baked++;
      counts[kind]++;
    };

    const toMs = Date.parse(input.to);
    // 归一化窗口界为 toISOString 格式，供 recordedAtFastPath 字典序比较。
    const fromIso = new Date(fromMs).toISOString();
    const toIso = new Date(toMs).toISOString();
    const inWindow = (recordedAt: unknown): recordedAt is string => {
      if (typeof recordedAt !== 'string') return false;
      const atMs = Date.parse(recordedAt);
      return !Number.isNaN(atMs) && atMs >= fromMs && atMs < toMs;
    };

    let linesSinceYield = 0;
    for (const filePath of iterSimJsonlFiles(baseDir, env.id)) {
      // P2F §10.4: fork attribution — timeline records carry an explicit
      // forkId; trajectory decision records do not, so their FILE's sim dir
      // is resolved through the sandbox rows once per file (memoized).
      const simId = relative(baseDir, filePath).split(sep)[0]!;
      let forkIdOfSim: string | null | undefined;
      const forkIdOfFile = (): string | undefined => {
        if (forkIdOfSim === undefined) {
          const fork = this.deps.sandboxStore?.findBySimulationId(simId);
          forkIdOfSim = fork !== undefined ? fork.id : null;
        }
        return forkIdOfSim ?? undefined;
      };
      const text = await readJsonlTextAsync(filePath, fromMs);
      if (text === undefined) continue;
      for (const rawLine of text.split('\n')) {
        // R2-BUG-05: yield periodically — a 52MB segment parses ~10k+ lines;
        // without this the bake still starves every concurrent request.
        if (++linesSinceYield >= JSONL_LINE_YIELD_INTERVAL) {
          linesSinceYield = 0;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        const trimmed = rawLine.trim();
        if (trimmed.length === 0) continue;
        // R2-BUG-05: skip out-of-window lines without paying the JSON.parse.
        const fastTs = recordedAtFastPath(trimmed);
        if (fastTs !== undefined && (fastTs < fromIso || fastTs >= toIso)) continue;
        let line: unknown;
        try {
          line = JSON.parse(trimmed);
        } catch {
          continue; // 崩溃残留的半行 —— 与 trajectory-store 的容忍策略一致
        }
        if (isZoneSampleRecord(line) && line.environmentId === env.id) {
          if (!inWindow(line.recordedAt)) continue;
          if (line.forkId !== undefined) counts.forkIds.add(line.forkId);
          for (const zone of line.zones) {
            if (!zoneIds.has(zone.zoneId)) {
              counts.skipped++;
              continue;
            }
            pushEvent('zoneSampleEvents', {
              id: `replay:zone:${nextSeq()}`,
              type: 'zone-sample',
              zoneId: zone.zoneId,
              atSimTimeSec: toSimSec(line.recordedAt, fromMs),
              observationOnly: true,
              details: {
                simTimeSec: line.simTimeSec,
                parameters: zone.parameters,
                ...(zone.occupancy !== undefined ? { occupancy: zone.occupancy } : {}),
              },
            });
          }
        } else if (isDeviceStateRecord(line) && line.environmentId === env.id) {
          if (!inWindow(line.recordedAt)) continue;
          if (line.forkId !== undefined) counts.forkIds.add(line.forkId);
          const device = deviceById.get(line.deviceId);
          if (device === undefined) {
            counts.skipped++;
            continue;
          }
          // S2 (device privacy): a foreign device's state-change record
          // carries its params/result — omitted for coarse-tier exporters
          // (counted, never baked).
          if (tierOf(device) === 'coarse') {
            counts.redactedDeviceEvents++;
            continue;
          }
          pushEvent('deviceStateEvents', {
            id: `replay:dev:${nextSeq()}`,
            type: 'device-state',
            zoneId: device.zone_id,
            atSimTimeSec: toSimSec(line.recordedAt, fromMs),
            observationOnly: true,
            details: {
              deviceId: line.deviceId,
              ...(line.service !== undefined ? { service: line.service } : {}),
              // T-039: the changed fields ride the baked replay event too.
              ...(line.params !== undefined ? { params: line.params } : {}),
              ...(line.result !== undefined ? { result: line.result } : {}),
              simTimeSec: line.simTimeSec,
            },
          });
        } else if (isTrajectoryRecord(line) && line.scenario === env.id) {
          if (!inWindow(line.recordedAt)) continue;
          const forkId = forkIdOfFile();
          if (forkId !== undefined) counts.forkIds.add(forkId);
          pushEvent('decisionEvents', {
            id: `replay:dec:${nextSeq()}`,
            type: 'sim-decision',
            zoneId: agentZoneById.get(line.agentId) ?? fallbackZoneId,
            atSimTimeSec: toSimSec(line.recordedAt, fromMs),
            observationOnly: true,
            details: {
              agentId: line.agentId,
              eventId: line.eventId,
              decision: line.decision,
              decisionSource: line.decisionSource,
              ...(line.kind !== undefined ? { kind: line.kind } : {}),
              ...(line.collaborationId !== undefined
                ? { collaborationId: line.collaborationId }
                : {}),
              ...(line.reasoning !== undefined ? { reasoning: line.reasoning } : {}),
              // R15-D3: structured reasoning rides into replays so shared
              // links can localize rule decisions too.
              ...(line.reasoningCode !== undefined ? { reasoningCode: line.reasoningCode } : {}),
              ...(line.reasoningParams !== undefined ? { reasoningParams: line.reasoningParams } : {}),
              // UX-07: the llm-failure drill-down — without the message a
              // shared "error (llm-error)" row says THAT, never WHY.
              ...(line.errorMessage !== undefined ? { errorMessage: line.errorMessage } : {}),
              // UX-07: execution receipts carry their device/command so the
              // collapsed "executed (engine)" group stays informative.
              ...(line.deviceExecution !== undefined
                ? {
                    deviceExecution: {
                      deviceId: line.deviceExecution.deviceId,
                      ...(line.deviceExecution.deviceName !== undefined
                        ? { deviceName: line.deviceExecution.deviceName }
                        : {}),
                      command: line.deviceExecution.command,
                      success: line.deviceExecution.success,
                      ...(line.deviceExecution.error !== undefined
                        ? { error: line.deviceExecution.error }
                        : {}),
                    },
                  }
                : {}),
            },
          });
        }
      }
    }
    return counts;
  }

  /**
   * 把环境在 [from, to) 窗口内的历史折叠为一份校验通过的 scenario。
   * @throws ApiError 400 当 from >= to。
   *
   * R2-BUG-05: async — the sim-timeline bake yields the event loop between
   * line batches and only reads this env's segments newer than the window
   * start (a share/replay request no longer blocks the whole process).
   */
  async buildReplay(
    env: EnvironmentRow,
    input: ReplayWindowInput,
    viewer?: ReplayViewer,
  ): Promise<ReplayResult> {
    const fromMs = Date.parse(input.from);
    const toMs = Date.parse(input.to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      throw new ApiError(400, 'BAD_REQUEST', '"from" and "to" must be ISO timestamps');
    }
    if (fromMs >= toMs) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Replay window is empty or inverted: "from" (${input.from}) must be before "to" (${input.to})`,
      );
    }

    const devices = this.deps.envStore.devicesOf(env.id);
    const deviceById = new Map(devices.map(device => [device.id, device]));
    // S2 (device privacy): the export tier — the env owner exports the full
    // replay; anyone else (incl. anonymous share minters) exports coarse for
    // devices they do not own (telemetry events omitted + counted, snapshot
    // initialState stripped for foreign devices).
    const viewerUserId = viewer?.userId ?? env.owner_id;
    const tierOf = (device: DeviceInstanceRow | undefined): 'full' | 'coarse' =>
      device === undefined || viewerUserId === env.owner_id || device.owner_id === viewerUserId
        ? 'full'
        : 'coarse';
    let redactedDeviceEvents = 0;
    // entity 解析表：'hass:<entity>' 等源标识 → 设备实例 id（按属性键区分）。
    const deviceBySourceKey = new Map<string, string>();
    for (const binding of this.deps.syncBindingStore.listForEnv(env.id)) {
      deviceBySourceKey.set(
        `${binding.source} ${binding.attribute_key}`,
        binding.device_instance_id,
      );
    }
    const resolveDevice = (entityId: string, key: string): DeviceInstanceRow | undefined =>
      deviceById.get(entityId) ??
      deviceById.get(deviceBySourceKey.get(`${entityId} ${key}`) ?? '');

    let skipped = 0;
    let unchanged = 0;
    let observationEvents = 0;
    let commandEvents = 0;

    // --- 初始状态：窗口前每个 (entity, key) 的最后一次观测 ----------------
    const initialStateByDevice = new Map<string, Record<string, Scalar>>();
    const lastKnown = new Map<string, Scalar>(); // `${deviceId} ${key}` → 窗口起点值
    let initialStateCount = 0;
    for (const row of this.deps.observationStore.latestBefore(env.id, input.from)) {
      const device = resolveDevice(row.entity_id, row.key);
      if (device === undefined) {
        skipped++;
        continue;
      }
      if (tierOf(device) === 'coarse') {
        redactedDeviceEvents++; // foreign telemetry — omitted, not baked
        continue;
      }
      const value = JSON.parse(row.value_json) as Scalar;
      const state = initialStateByDevice.get(device.id) ?? {};
      state[row.key] = value;
      initialStateByDevice.set(device.id, state);
      lastKnown.set(`${device.id} ${row.key}`, value);
      initialStateCount++;
    }

    // --- 窗内观测：值变化 → 事件 ------------------------------------------
    const events: Array<Record<string, unknown>> = [];
    let seq = 0;
    const windowObservations = this.deps.observationStore.query(env.id, {
      from: input.from,
      to: input.to,
      limit: REPLAY_WINDOW_LIMIT,
    });
    for (const row of windowObservations) {
      const device = resolveDevice(row.entity_id, row.key);
      if (device === undefined) {
        skipped++;
        continue;
      }
      if (tierOf(device) === 'coarse') {
        redactedDeviceEvents++;
        continue;
      }
      const value = JSON.parse(row.value_json) as Scalar;
      const knownKey = `${device.id} ${row.key}`;
      if (lastKnown.get(knownKey) === value) {
        unchanged++;
        continue;
      }
      lastKnown.set(knownKey, value);
      events.push({
        id: `replay:obs:${++seq}`,
        type: 'observation-replay',
        zoneId: device.zone_id,
        parameter: row.key,
        value,
        atSimTimeSec: toSimSec(row.wall_time, fromMs),
      });
      observationEvents++;
    }

    // --- 窗内设备控制命令：命令语义（commandName + 实际参数）→ 事件 ----------
    // T-019 (EC-F05): `after` is the device's FULL post-command runtime
    // state (zoneId, cumulativeEnergyWh, …) — the pre-fix generator emitted
    // one event per state key, dumping noise parameters into replayed runs.
    // A command event now carries ONLY the command's parameter surface:
    // one event per scalar (number|boolean) command argument, or — when the
    // command has no injectable arguments (e.g. a bare `turn-on`) — a
    // single semantic marker event (`parameter` = commandName, value true).
    // Non-injectable argument values (strings/objects — physical parameters
    // accept numbers/booleans only) ride `details.params` verbatim.
    // Legacy records without a commandName fall back to the §4.3 design's
    // intended DELTA (after keys that actually changed vs before).
    for (const row of this.deps.commandLogStore.queryInWindow(env.id, input.from, input.to)) {
      if (row.kind !== DEVICE_COMMAND_KIND) continue;
      const payload = parseCommandPayload(row.payload_json);
      const device = payload === null ? undefined : deviceById.get(payload.deviceId);
      if (payload === null || device === undefined) {
        skipped++;
        continue;
      }
      if (tierOf(device) === 'coarse') {
        redactedDeviceEvents++;
        continue;
      }
      const details: Record<string, unknown> = {
        deviceId: device.id,
        ...(payload.commandName !== undefined ? { commandName: payload.commandName } : {}),
        ...(payload.params !== undefined ? { params: payload.params } : {}),
      };
      const emitted: Array<{ parameter: string; value: Scalar }> = [];
      if (payload.commandName !== undefined) {
        const injectable = Object.entries(payload.params ?? {})
          .filter((entry): entry is [string, number | boolean] =>
            typeof entry[1] === 'number' || typeof entry[1] === 'boolean');
        if (injectable.length > 0) {
          for (const [key, value] of injectable) emitted.push({ parameter: key, value });
        } else {
          // No injectable arguments: the command's occurrence IS the event.
          emitted.push({ parameter: payload.commandName, value: true });
        }
      } else {
        for (const [key, value] of Object.entries(payload.after)) {
          if (payload.before[key] !== value) emitted.push({ parameter: key, value });
        }
      }
      for (const { parameter, value } of emitted) {
        events.push({
          id: `replay:cmd:${++seq}`,
          type: 'device-command-replay',
          zoneId: device.zone_id,
          parameter,
          value,
          atSimTimeSec: toSimSec(row.wall_time, fromMs),
          details,
        });
        commandEvents++;
      }
    }

    // --- 合成场景：环境快照为底 + 回放事件 ----------------------------------
    // T-020 (EC-F03): the env's flow rows ride the export — environmentToScenario
    // embeds them as scenario.flows (loader-validated, authorUserId/deviceId
    // pins intact via flowRowToDefinition). Drift tolerance: a flow that no
    // longer validates against the CURRENT world (dead zone ref after agent
    // deletion, UNSAT assignment) must not make the env unreplayable — on a
    // flow-ONLY validation failure the flows are dropped and the report says
    // so honestly (flowsSkipped + flowIssues); any other failure still throws.
    const devicesWithReplayState = devices.map(device => {
      // S2 (device privacy): foreign devices export WITHOUT their authored
      // initialState too — the device entry stays (world structure), its
      // telemetry payload does not (the scenario loader defaults its physics).
      if (tierOf(device) === 'coarse') {
        return device.initial_state_json === null ? device : { ...device, initial_state_json: null };
      }
      const replayState = initialStateByDevice.get(device.id);
      if (replayState === undefined) return device;
      const base = parseJsonObject(device.initial_state_json) ?? {};
      return {
        ...device,
        initial_state_json: JSON.stringify({ ...base, ...replayState }),
      };
    });
    const buildSnapshot = (flows?: FlowDefinition[]) =>
      environmentToScenario(
        env,
        devicesWithReplayState,
        this.deps.envStore.agentsOf(env.id),
        flows !== undefined ? { flows } : undefined,
      );

    const flowRows = this.deps.flowStore?.listByEnvironment(env.id) ?? [];
    const envFlows =
      flowRows.length > 0
        ? flowRows.map(row => flowRowToDefinition(row, env.owner_id))
        : undefined;

    let flowsEmbedded = 0;
    let flowsSkipped = 0;
    let flowIssues: string[] = [];
    let snapshot: ReturnType<typeof environmentToScenario>;
    if (envFlows === undefined) {
      snapshot = buildSnapshot();
    } else {
      try {
        snapshot = buildSnapshot(envFlows);
        flowsEmbedded = envFlows.length;
      } catch (error) {
        const issues = error instanceof ApiError ? (error.issues ?? []) : undefined;
        const isFlowOnly = error instanceof ApiError &&
          error.code === 'ENVIRONMENT_INVALID' &&
          issues !== undefined && issues.length > 0 &&
          issues.every(issue => issue.startsWith('flows['));
        if (!isFlowOnly) throw error;
        flowsSkipped = envFlows.length;
        flowIssues = issues;
        snapshot = buildSnapshot();
      }
    }

    // --- 仿真侧时序：trajectory 决策 + sim-timeline 采样（Fix-14） -----------
    const sim = await this.bakeSimTimeline(
      env,
      input,
      fromMs,
      deviceById,
      snapshot,
      events,
      () => ++seq,
      tierOf,
    );
    skipped += sim.skipped;
    redactedDeviceEvents += sim.redactedDeviceEvents;

    // 按仿真时间排序（注入按 atSimTimeSec 调度，顺序不影响语义，只为可读性）。
    events.sort(
      (a, b) => (a.atSimTimeSec as number) - (b.atSimTimeSec as number),
    );

    // T-101: world-tier fidelity — map-level metadata rides the canonical
    // meta fields (storeyHeight et al.), and the export carries the same
    // sidecar fields the import path recovers from a raw body (map block,
    // per-zone polygon, device brand/position), pulled from the env's
    // map_data + device rows. The core loader drops those sidecars, so they
    // are re-attached AFTER validation.
    const mapData = parseMapData(env);
    const polygonByZoneId = new Map(
      mapData.zones.flatMap(zone =>
        zone.polygon !== undefined ? [[zone.id, zone.polygon] as const] : [],
      ),
    );
    const mapBlock =
      env.map_type === 'geo'
        ? {
          type: 'geo',
          center: mapData.center,
          ...(mapData.zoom !== undefined ? { zoom: mapData.zoom } : {}),
        }
        : mapData.floorPlans !== undefined
          ? { type: env.map_type, floorPlans: mapData.floorPlans }
          : undefined;

    const definition = loadScenarioFile({
      version: '1.0',
      meta: {
        id: `replay-${env.id}-${randomUUID().slice(0, 8)}`,
        name: input.name ?? `回放：${env.name}（${input.from} ~ ${input.to}）`,
        description:
          input.description ??
          `P-E 回放：环境 "${env.name}" 在 wall-clock 窗口 [${input.from}, ${input.to}) 内的 ` +
            `观测、设备控制与仿真时序（决策/zone 采样/设备状态）记录转换而来` +
            `（窗口起点 = atSimTimeSec 0）。`,
        ...mapMetaToScenarioMeta(mapData),
        // T-032: demo metadata rides the replay export — the demo player
        // works on re-imported replays, not just fresh template imports.
        ...demoToScenarioMeta(mapData.demo),
      },
      zones: snapshot.zones,
      devices: snapshot.devices,
      agents: snapshot.agents,
      events: [...snapshot.events, ...events],
      // T-020: flows ride the replay product (re-validated here — they
      // passed the bridge already, so this is the same verdict twice).
      ...(snapshot.flows !== undefined && snapshot.flows.length > 0
        ? { flows: snapshot.flows }
        : {}),
    });

    const exported: ExportableScenarioDefinition = {
      ...definition,
      ...(mapBlock !== undefined ? { map: mapBlock } : {}),
      zones: definition.zones.map(zone => {
        const polygon = polygonByZoneId.get(zone.id);
        return polygon !== undefined ? { ...zone, polygon } : zone;
      }),
      devices: definition.devices.map(device => {
        const row = deviceById.get(device.id);
        if (row === undefined) return device;
        const position = parseJsonObject(row.position_json);
        return {
          ...device,
          ...(row.brand != null ? { brand: row.brand } : {}),
          ...(position !== null ? { position } : {}),
        };
      }),
    };

    // P2F §10.4: replay lineage — every fork whose records were baked,
    // machine-checkable (fork/env ids, fork moment, policy, checkpoint id,
    // scenario fingerprint) with THIS replay's window attached.
    const forks: ForkLineage[] = [];
    for (const forkId of sim.forkIds) {
      const row = this.deps.sandboxStore?.get(forkId);
      forks.push(forkLineageOf(row, { from: input.from, to: input.to }, forkId));
    }

    return {
      definition: exported,
      report: {
        envId: env.id,
        window: { from: input.from, to: input.to },
        eventCount:
          observationEvents + commandEvents +
          sim.decisionEvents + sim.zoneSampleEvents + sim.deviceStateEvents,
        observationEvents,
        commandEvents,
        decisionEvents: sim.decisionEvents,
        zoneSampleEvents: sim.zoneSampleEvents,
        deviceStateEvents: sim.deviceStateEvents,
        redactedDeviceEvents,
        flowsEmbedded,
        flowsSkipped,
        flowIssues,
        initialStateCount,
        skipped,
        unchanged,
        forks,
      },
    };
  }
}

/** wall_time → 相对窗口起点的仿真秒（毫秒精度，避免浮点噪声）。 */
function toSimSec(wallTime: string, fromMs: number): number {
  return Math.round((Date.parse(wallTime) - fromMs)) / 1000;
}

/**
 * 解析 device-command 记录的消费格式
 * `{ deviceId|deviceInstanceId, commandName?, params?, before?, after? }`；
 * T-019 之后以 commandName + params（命令的实际参数面）为准；无 commandName
 * 的 legacy 记录退回 before/after 差量。after/before 只保留标量键值。非法
 * 负载返回 null（计入 skipped）。
 */
function parseCommandPayload(payloadJson: string): {
  deviceId: string;
  commandName?: string;
  params?: Record<string, unknown>;
  before: Record<string, Scalar>;
  after: Record<string, Scalar>;
} | null {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const deviceId = record.deviceId ?? record.deviceInstanceId;
  if (typeof deviceId !== 'string' || deviceId.length === 0) return null;
  const scalars = (value: unknown): Record<string, Scalar> => {
    const out: Record<string, Scalar> = {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'number' || typeof entry === 'boolean' || typeof entry === 'string') {
        out[key] = entry;
      }
    }
    return out;
  };
  const commandName = typeof record.commandName === 'string' && record.commandName.length > 0
    ? record.commandName
    : undefined;
  const params = typeof record.params === 'object' && record.params !== null && !Array.isArray(record.params)
    ? record.params as Record<string, unknown>
    : undefined;
  return {
    deviceId,
    ...(commandName !== undefined ? { commandName } : {}),
    ...(params !== undefined ? { params } : {}),
    before: scalars(record.before),
    after: scalars(record.after),
  };
}

// ---------------------------------------------------------------------------
// 仿真侧时序源（Fix-14）：trajectory 目录扫描与记录分类
// ---------------------------------------------------------------------------

/**
 * 枚举 trajectoryBaseDir 下所有仿真目录的原始 JSONL 文件：目录顶层的
 * `.jsonl`（legacy 单文件）+ 每个子目录里的 `segment-*.jsonl`（Living-worlds
 * P2 分段日志）。默认目录按 sim id 命名（`sim-<scenarioId>-…`，见
 * SimulationRegistry.create）；目录不可读时静默产出空迭代（仿真时序是
 * 回放增强，不是硬依赖）。
 *
 * **回放不变量（P2 保留期耦合）**：rollup 文件（`rollup-*` 名，分段目录里
 * compactor 的分钟聚合产物）被本函数显式排除——回放只消费窗口内的
 * RAW 记录（recordedAt 过滤 + 每文件 64MB 读限 + REPLAY_SIM_EVENT_LIMIT），
 * 聚合粒度绝不进入回放。窗口外的原始段已被 compactor 删除（rollup 先行
 * 落盘的崩溃安全顺序），所以 raw 集合 ⊆ 回放窗口邻域是结构保证而非巧合。
 *
 * R2-BUG-05（env 预筛）：传入 `envId` 时，形如 `sim-<其它环境UUID>-…` 的
 * 目录被整体跳过——回放是环境级操作，而 registry 的 sim id 以
 * scenario.meta.id 开头、env 背书的场景 meta.id === env.id
 * （environment-bridge.ts），所以其它环境的仿真目录不可能含有本环境的
 * 记录（记录级 environmentId/scenario 过滤仍是语义判定，目录名只是
 * 性能预筛）。名字不符合 `sim-<uuid>-…` 形状的目录（显式
 * options.trajectoryDir 覆盖等异态）照常扫描，语义不变。
 */
export function* iterSimJsonlFiles(baseDir: string, envId?: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('sim-')) continue;
    if (envId !== undefined && isOtherEnvSimDir(entry.name, envId)) continue;
    const dir = join(baseDir, entry.name);
    let top: Dirent[];
    try {
      top = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of top) {
      if (!file.isFile()) continue;
      if (file.name.endsWith('.jsonl')) yield join(dir, file.name);
    }
    // Living-worlds P2 segment subdirs (sim-timeline/, <trajectory-base>/):
    // raw segments only — rollup-* is the excluded aggregate grain.
    for (const sub of top) {
      if (!sub.isDirectory()) continue;
      let segments: Dirent[];
      try {
        segments = readdirSync(join(dir, sub.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of segments) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        if (file.name.startsWith('rollup-')) continue; // 回放不变量：聚合不进回放
        yield join(dir, sub.name, file.name);
      }
    }
  }
}

/** `sim-<uuid>-…` 目录且 uuid ≠ envId（R2-BUG-05 env 预筛，见 iterSimJsonlFiles）。 */
const SIM_DIR_ENV_ID_RE = /^sim-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-/;
function isOtherEnvSimDir(name: string, envId: string): boolean {
  const match = SIM_DIR_ENV_ID_RE.exec(name);
  return match !== null && match[1] !== envId;
}

/**
 * R2-BUG-05：异步读 JSONL 源文件（不再 readFileSync 阻塞事件循环）；
 * 超限/不可读返回 undefined。append-only 段的 mtime ≥ 段内每条记录的
 * recordedAt —— mtime 早于窗口起点（fromMs）即整段不可能含窗内记录，
 * 跳过读盘（纯性能预筛；记录级 inWindow 判定不变，语义不受影响）。
 */
async function readJsonlTextAsync(filePath: string, fromMs: number): Promise<string | undefined> {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size > REPLAY_SOURCE_FILE_MAX_BYTES) return undefined;
    if (stat.mtimeMs < fromMs) return undefined;
    return await fsp.readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

/** R2-BUG-05：每解析这么多行让出一次事件循环（大段烘焙不再饿死其它请求）。 */
const JSONL_LINE_YIELD_INTERVAL = 2000;

/**
 * R2-BUG-05：recordedAt 快速预筛——记录行的 recordedAt 是 `new Date().toISOString()`
 * 产出的固定格式 ISO-UTC 字符串（24 字符、Z 结尾），字典序即时间序；落在窗口
 * 外的行不做 JSON.parse 直接跳过（记录级 inWindow 仍是解析后的语义判定）。
 * 返回 undefined = 未命中快速路径（无该字段/格式不符），调用方照常解析。
 */
function recordedAtFastPath(rawLine: string): string | undefined {
  const marker = '"recordedAt":"';
  const at = rawLine.indexOf(marker);
  if (at < 0) return undefined;
  const ts = rawLine.slice(at + marker.length, at + marker.length + 24);
  return ts.length === 24 && ts.endsWith('Z') ? ts : undefined;
}

/** 与 trajectory-store.ts 一致的最小结构守卫（recorder 拥有完整形状）。 */
function isTrajectoryRecord(value: unknown): value is TrajectoryRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.eventId === 'string' &&
    typeof record.agentId === 'string' &&
    typeof record.decision === 'string' &&
    typeof record.scenario === 'string';
}

function isZoneSampleRecord(value: unknown): value is ZoneSampleRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'zone-sample' &&
    typeof record.environmentId === 'string' &&
    Array.isArray(record.zones);
}

function isDeviceStateRecord(value: unknown): value is DeviceStateRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'device-state' &&
    typeof record.environmentId === 'string' &&
    typeof record.deviceId === 'string';
}
