/**
 * Training data export (Fix-22, roadmap "训练数据导出") — 训练场数据出口
 *
 * 平台愿景（docs/vision.md「平台视角的目标」）的落地入口：把一个环境的
 * 仿真决策记录（trajectory JSONL：决策 + 理由 + 双方握手）、仿真侧时序
 * （sim-timeline.jsonl：zone 参数采样 + 设备状态变化，Fix-14）、服务消费
 * 计量（usage_records，Fix-11）与 Agent 声誉（agent_reputation，P4-1）
 * 打包成训练友好的 NDJSON 流。
 *
 * 统一信封：`{kind, simId, simTimeSec, recordedAt, agentId?, payload}`。
 * kind ∈ manifest | decision | collaboration | zone-sample | device-state |
 * usage | reputation-snapshot。第一行恒为 manifest（环境元信息 +
 * zones/devices/agents/services 快照 + 记录计数 + 时间窗），之后按源追加：
 * - decision / collaboration：trajectory 记录（kind 'collaboration-response'
 *   的握手记录归为 collaboration，其余评估记录归为 decision）；simTimeSec
 *   为 null（trajectory 只记 wall-time）。
 * - zone-sample / device-state：sim-timeline 记录，自带 simTimeSec。
 * - usage：usage_records 行（started_at 作为 recordedAt）；simId/simTimeSec
 *   为 null（消费计量不关联单次仿真）。
 * - reputation-snapshot：导出时刻的 (agent, capability) 声誉记分（含
 *   衰减后的 score）——当前状态快照，不参与 from/to 窗口过滤。
 *
 * Wave-3b 训练视图（query.format）：缺省为上述原始信封流；format=sft 时
 * 数据行改为 {instruction, response, meta} 指令对（只收 decisionSource
 * ='llm' 且上下文可用的 decision 记录），format=dpo 时改为 {prompt,
 * chosen, rejected, meta} 偏好对（效果标注 + 简单透明配对，规则见
 * manifest.payload.pairing 与文件下方 buildSftExport/buildDpoExport）。
 * 两种格式仍为 NDJSON，manifest 首行带 format 与字段说明。
 *
 * 窗口语义与 replay-service 一致：from 含、to 不含，按记录的 recordedAt
 * （usage 按 started_at）过滤。读盘容忍策略同 Fix-14：目录缺失、半行
 * 写入静默跳过；单文件超过 64 MB 防御性跳过（trajectory 行带完整 prompt）。
 */

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import { computeReputationScore, isReadOnlyCapabilityName, untrustedBlock, untrustedJsonBlock, type TrajectoryRecord } from '@active-collaboration/core';

import type { AgreementStore, UsageRecordRow } from './db/agreement-store.js';
import type { EnvironmentRow, EnvironmentStore } from './db/environment-store.js';
import { parseJsonArray, type AgentInstanceRow, type DeviceInstanceRow } from './db/environment-store.js';
import type { ReputationStore } from './db/reputation-store.js';
import type { SandboxRow } from './db/sandbox-store.js';
import type { ServiceStore } from './db/service-store.js';
import { environmentToScenario } from './environment-bridge.js';
import { forkLineageOf, type ForkLineage } from './fork-lineage.js';
import type { DeviceStateRecord, ZoneSampleRecord } from './sim-timeline.js';

export const TRAINING_EXPORT_KINDS = [
  'manifest',
  'decision',
  'collaboration',
  'zone-sample',
  'device-state',
  'usage',
  'reputation-snapshot',
] as const;

export type TrainingExportKind = (typeof TRAINING_EXPORT_KINDS)[number];

export const TRAINING_EXPORT_FORMATS = ['sft', 'dpo', 'structured'] as const;

/**
 * 训练视图格式（Wave-3b + Phase 1）：缺省导出保持 Fix-22 的原始信封流；指定
 * format 后数据行改为训练格式（仍为 NDJSON，首行 manifest 带 format 与字段说明）：
 * - sft：decision 记录 → {instruction, response, meta}。只收
 *   decisionSource='llm' 的记录；instruction 优先取 LLM 实见的
 *   prompt.userPrompt（事件、zone 状态、可用能力/伙伴都在里面），缺失时
 *   退化为 trajectory context 摘要；两者皆无则跳过并计数。response =
 *   决策 + 理由。
 * - dpo：decision 记录 → {prompt, chosen, rejected, meta} 偏好对。效果
 *   标注（goalAchieved 优先，回退 groundTruth 正确性——与效果回检/
 *   reputation 的成败信号同源）+ 简单透明配对（同 agentId + 同事件类型
 *   + DPO_PAIR_WINDOW_MS 时间窗内最近配对）；配不上对的成功记录单独输出
 *   chosen（rejected=null），配不上对的失败记录丢弃并计数。配对规则写进
 *   manifest.payload.pairing。
 * - structured（Phase 1 认知架构 §11.4）：decision 记录 →
 *   {instruction, response, meta}，但 response 是完整 CognitiveDecision
 *   对象（situation/goals/actionPlan/explanation/collaboration/
 *   uncertainty 多字段标签）——scaling roadmap 需要的结构化目标分布。
 *   只收 decisionSource='llm' 且 trajectory 携带 cognitiveDecision 的
 *   记录（Phase 1 之前/解析降级的记录跳过并计数 skippedNoCognitive）。
 *   meta 携带派生 legacy 决策 + ground truth，label-consistency gate
 *   可直接消费（R35 §6 step 4 的 schema 级升级）。
 *   v5.2 lever-1（training loop §8.4a）：decisionSource='precheck' 且
 *   reasoningCode='precheck.independent'（Type-A 全覆盖无缺口短路）的
 *   handle_independently 记录**模板化**导出——instruction 由 trajectory
 *   context + 环境面（agent 名/绑定设备）重建最小认知上下文，response
 *   为模板生成的六区块对（meta.templated=true、meta.source=
 *   'templated-precheck'；重建说明写进 explanation.summary）。动机：
 *   precheck 把所有 GT-handle 情形在进 LLM 前短路，LLM lane 结构性供不出
 *   handle 监督（v5/v5.1 handle 命中 0/43 的定因，§8.4）——handle 语义的
 *   最大存量就在这些被短路的正确决策里。
 */
export type TrainingExportFormat = (typeof TRAINING_EXPORT_FORMATS)[number];

/** DPO 配对时间窗（wall-clock ms）：同组内成败记录相距超过该窗不配对。 */
export const DPO_PAIR_WINDOW_MS = 60 * 60 * 1000;

/** 单个 JSONL 源文件的读取上限（与 replay-service 一致的防御）。 */
const EXPORT_SOURCE_FILE_MAX_BYTES = 64 * 1024 * 1024;

export interface TrainingExportQuery {
  /** 只导出该仿真的记录（按目录名匹配 sim id）。 */
  simId?: string;
  /** ISO wall-time，含。 */
  from?: string;
  /** ISO wall-time，不含。 */
  to?: string;
  /** 训练视图格式（Wave-3b）；缺省 = 原始信封流。 */
  format?: TrainingExportFormat;
}

export interface TrainingExportDeps {
  envStore: EnvironmentStore;
  agreementStore: AgreementStore;
  reputationStore: ReputationStore;
  serviceStore: ServiceStore;
  /**
   * Per-simulation trajectory base dir（W8/Fix-14）。未配置时导出只含
   * DB 侧数据（usage + reputation-snapshot）。
   */
  trajectoryBaseDir?: string;
  /**
   * P2F (living-worlds §10.4): fork-row lookup for export lineage — the
   * manifest's `forks` block resolves which contributing sims were sandboxes.
   * Duck-typed; absent → no lineage block (honest: resolution off).
   */
  sandboxStore?: {
    get(forkId: string): SandboxRow | undefined;
    findBySimulationId(simulationId: string): SandboxRow | undefined;
  };
}

export interface TrainingExportResult {
  /** NDJSON 行（已序列化）；第一行是 manifest。 */
  lines: string[];
  /**
   * 各 kind 的记录数（不含 manifest 行本身）。原始导出按信封 kind 计数；
   * 训练视图（format=sft|dpo）按训练语义计数（samples/pairs/skipped 等，
   * 见 manifest.payload.counts）。
   */
  counts: Record<string, number>;
  /** 数据记录总数（不含 manifest）。 */
  total: number;
}

interface Envelope {
  kind: TrainingExportKind;
  simId: string | null;
  simTimeSec: number | null;
  recordedAt: string;
  agentId?: string;
  /** P2F §10.4: explicit fork provenance on fork-derived records. */
  forkId?: string;
  payload: unknown;
}

export function buildTrainingExport(
  deps: TrainingExportDeps,
  env: EnvironmentRow,
  query: TrainingExportQuery = {},
): TrainingExportResult {
  const fromMs = query.from !== undefined ? Date.parse(query.from) : undefined;
  const toMs = query.to !== undefined ? Date.parse(query.to) : undefined;
  const inWindow = (recordedAt: unknown): recordedAt is string => {
    if (typeof recordedAt !== 'string') return false;
    const atMs = Date.parse(recordedAt);
    if (Number.isNaN(atMs)) return false;
    if (fromMs !== undefined && atMs < fromMs) return false;
    if (toMs !== undefined && atMs >= toMs) return false;
    return true;
  };

  const envelopes: Envelope[] = [];
  /** simId 过滤是否命中过至少一个仿真目录（0 = 多半是拼错 id）。 */
  let simIdFilterMatched = false;
  /** P2F §10.4: contributing fork ids (record-stamped + sim-dir-resolved). */
  const contributingForkIds = new Set<string>();

  // --- 仿真侧记录（读盘）：trajectory 决策/握手 + sim-timeline 采样/状态 ----
  if (deps.trajectoryBaseDir !== undefined) {
    for (const { simId, filePath } of iterSimJsonlFiles(deps.trajectoryBaseDir, query.simId)) {
      simIdFilterMatched = true;
      // Decision/collaboration records carry no forkId — their sim directory
      // resolves through the sandbox rows once per file (lineage by simId).
      const forkRowOfSim = deps.sandboxStore?.findBySimulationId(simId);
      if (forkRowOfSim !== undefined) contributingForkIds.add(forkRowOfSim.id);
      for (const line of readJsonlLines(filePath)) {
        if (isTrajectoryRecord(line) && line.scenario === env.id) {
          if (!inWindow(line.recordedAt)) continue;
          envelopes.push({
            kind: line.kind === 'collaboration-response' ? 'collaboration' : 'decision',
            simId,
            simTimeSec: null,
            recordedAt: line.recordedAt,
            agentId: line.agentId,
            ...(forkRowOfSim !== undefined ? { forkId: forkRowOfSim.id } : {}),
            payload: line,
          });
        } else if (isZoneSampleRecord(line) && line.environmentId === env.id) {
          if (!inWindow(line.recordedAt)) continue;
          if (line.forkId !== undefined) contributingForkIds.add(line.forkId);
          envelopes.push({
            kind: 'zone-sample',
            simId: line.simId,
            simTimeSec: line.simTimeSec,
            recordedAt: line.recordedAt,
            ...(line.forkId !== undefined ? { forkId: line.forkId } : {}),
            payload: line,
          });
        } else if (isDeviceStateRecord(line) && line.environmentId === env.id) {
          if (!inWindow(line.recordedAt)) continue;
          if (line.forkId !== undefined) contributingForkIds.add(line.forkId);
          envelopes.push({
            kind: 'device-state',
            simId: line.simId,
            simTimeSec: line.simTimeSec,
            recordedAt: line.recordedAt,
            ...(line.forkId !== undefined ? { forkId: line.forkId } : {}),
            payload: line,
          });
        }
      }
    }
  }

  // --- 服务消费计量（DB，append-only） --------------------------------------
  for (const row of deps.agreementStore.usageOfEnv(env.id)) {
    if (!inWindow(row.started_at)) continue;
    envelopes.push(usageEnvelope(row));
  }

  // --- 声誉快照（DB；当前状态，不参与窗口过滤） ------------------------------
  const nowMs = Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  for (const row of deps.reputationStore.rowsForEnv(env.id)) {
    envelopes.push({
      kind: 'reputation-snapshot',
      simId: null,
      simTimeSec: null,
      recordedAt: generatedAt,
      agentId: row.agent_id,
      payload: {
        capability: row.capability,
        attempts: row.attempts,
        successes: row.successes,
        failures: row.failures,
        lastAt: row.last_at,
        score: computeReputationScore(
          { attempts: row.attempts, successes: row.successes, lastAt: row.last_at },
          nowMs,
        ),
      },
    });
  }

  // 环境快照走 scenario 转换（训练侧最友好的形状）；空世界（无 zone）
  // 过不了 scenario 校验，退化为空快照——manifest 只是元信息，不应因此
  // 让整个导出 500。
  let snapshot: { zones: unknown[]; devices: unknown[]; agents: unknown[] } = {
    zones: [],
    devices: [],
    agents: [],
  };
  try {
    const scenario = environmentToScenario(
      env,
      deps.envStore.devicesOf(env.id),
      deps.envStore.agentsOf(env.id),
    );
    snapshot = { zones: scenario.zones, devices: scenario.devices, agents: scenario.agents };
  } catch {
    // 空世界/残缺世界：快照留空，DB 与仿真时序记录照导
  }

  // manifest 的公共部分（原始流与训练视图共享环境元信息 + 快照 + 窗口）。
  // DevLoop T-008：simId 过滤一个不存在的仿真目录曾导出"manifest +
  // 空"——与"该仿真还没有记录"不可区分。manifest.notes 如实说明命中 0
  // 个目录，教用户检查 id（而不是静默空导出）。
  const notes: string[] = [];
  if (query.simId !== undefined && !simIdFilterMatched) {
    notes.push(
      `simId "${query.simId}" matched no simulation directory under the trajectory store — ` +
        'this export contains only DB-side records (usage / reputation-snapshot). ' +
        'Double-check the simulation id; it must equal the per-sim directory name (e.g. from GET /api/simulations or an eval-run result run.simId).',
    );
  }
  const baseManifestPayload = {
    environment: {
      id: env.id,
      name: env.name,
      description: env.description,
      visibility: env.visibility,
      ownerId: env.owner_id,
      createdAt: env.created_at,
      updatedAt: env.updated_at,
    },
    snapshot: {
      ...snapshot,
      services: deps.serviceStore.servicesOf(env.id).map(service => ({
        id: service.id,
        name: service.name,
        semanticType: service.semantic_type,
        providerAgentId: service.provider_agent_id,
        visibility: service.visibility,
      })),
    },
    window: {
      simId: query.simId ?? null,
      // P2F §10.4: when the export is scoped to one sim and that sim is a
      // fork, the fork id rides the window itself (machine-checkable without
      // a sandbox-row lookup).
      ...(deps.sandboxStore !== undefined && query.simId !== undefined
        ? (() => {
          const fork = deps.sandboxStore!.findBySimulationId(query.simId!);
          return fork !== undefined ? { forkId: fork.id } : {};
        })()
        : {}),
      from: query.from ?? null,
      to: query.to ?? null,
    },
    // P2F §10.4: lineage of every fork whose records are in this export —
    // the training-data provenance requirement (回放式学习的溯源).
    ...(contributingForkIds.size > 0
      ? {
        forks: [...contributingForkIds].map(forkId =>
          forkLineageOf(
            deps.sandboxStore?.get(forkId),
            { from: query.from ?? null, to: query.to ?? null },
            forkId,
          ),
        ) as ForkLineage[],
      }
      : {}),
    generatedAt,
    ...(notes.length > 0 ? { notes } : {}),
  };

  // Wave-3b：训练视图（format=sft|dpo）——数据行改训练格式，manifest 首行
  // 带 format 与字段说明。Phase 1 追加 format=structured（完整
  // CognitiveDecision 多字段标签对；v5.2 起含 precheck-A 模板化对）。
  if (query.format === 'sft') return buildSftExport(envelopes, baseManifestPayload);
  if (query.format === 'dpo') return buildDpoExport(envelopes, baseManifestPayload);
  if (query.format === 'structured') {
    // 环境面（v5.2 templated 上下文重建）：设备/agent 快照复用 manifest
    // 快照同一读库结果，避免二次查库。
    let worldFace: ExportWorldFace = { agentNameOf: () => undefined, ownDevicesOf: () => [] };
    try {
      worldFace = buildExportWorldFace(
        deps.envStore.devicesOf(env.id),
        deps.envStore.agentsOf(env.id),
      );
    } catch {
      // 读不了环境面就退化为纯轨迹上下文重建（设备/名字缺省）
    }
    return buildStructuredExport(envelopes, baseManifestPayload, worldFace);
  }

  const counts: Record<string, number> = {};
  for (const envelope of envelopes) {
    counts[envelope.kind] = (counts[envelope.kind] ?? 0) + 1;
  }
  const manifest: Envelope = {
    kind: 'manifest',
    simId: null,
    simTimeSec: null,
    recordedAt: generatedAt,
    payload: {
      ...baseManifestPayload,
      counts,
      total: envelopes.length,
    },
  };

  return {
    lines: [manifest, ...envelopes].map(envelope => JSON.stringify(envelope)),
    counts,
    total: envelopes.length,
  };
}

// ---------------------------------------------------------------------------
// Wave-3b 训练视图：decision 记录 → SFT 指令对 / DPO 偏好对
// ---------------------------------------------------------------------------

interface DecisionEntry {
  simId: string | null;
  recordedAt: string;
  /** P2F §10.4: fork provenance when the decision came out of a sandbox. */
  forkId?: string;
  record: TrajectoryRecord;
}

/** 训练视图的公共件：manifest 之外的行就是训练记录本身（无信封）。 */
interface BaseManifestPayload {
  environment: unknown;
  snapshot: unknown;
  window: { simId: string | null; from: string | null; to: string | null };
  generatedAt: string;
}

function decisionEntries(envelopes: Envelope[]): DecisionEntry[] {
  return envelopes
    .filter(envelope => envelope.kind === 'decision')
    .map(envelope => ({
      simId: envelope.simId,
      recordedAt: envelope.recordedAt,
      forkId: envelope.forkId,
      record: envelope.payload as TrajectoryRecord,
    }));
}

/**
 * SFT 指令 / DPO prompt：该决策的输入上下文——trajectory 里有什么用什么。
 * 优先 LLM 实见的 prompt.userPrompt（事件、zone 状态、可用能力/伙伴都在
 * 其中）；缺 prompt（LLM 调用没配上）时退化为 record.context 的结构化
 * 摘要；两者皆无返回 null（调用方跳过并计数，不臆造上下文）。
 */
function buildInstruction(record: TrajectoryRecord): string | null {
  const userPrompt = record.prompt?.userPrompt;
  if (typeof userPrompt === 'string' && userPrompt.trim().length > 0) return userPrompt;
  const context = record.context as Partial<TrajectoryRecord['context']> | undefined;
  if (typeof context !== 'object' || context === null) return null;
  return JSON.stringify({
    eventId: record.eventId,
    capabilities: context.capabilities ?? [],
    ...(context.managedZoneIds !== undefined ? { managedZoneIds: context.managedZoneIds } : {}),
    ...(context.actuatorZoneIds !== undefined ? { actuatorZoneIds: context.actuatorZoneIds } : {}),
    partnerServices: context.partnerServices ?? [],
  });
}

/** SFT response / DPO chosen|rejected：决策 + 理由（理由缺失时仅决策）。 */
function buildResponse(record: TrajectoryRecord): string {
  const reasoning = typeof record.reasoning === 'string' && record.reasoning.trim().length > 0
    ? record.reasoning
    : null;
  return reasoning === null
    ? `Decision: ${record.decision}`
    : `Decision: ${record.decision}\nReasoning: ${reasoning}`;
}

function buildSftExport(envelopes: Envelope[], base: BaseManifestPayload): TrainingExportResult {
  const samples: unknown[] = [];
  let skippedNoContext = 0;
  let filteredNonLlm = 0;
  for (const { simId, recordedAt, forkId, record } of decisionEntries(envelopes)) {
    // SFT 只学 LLM 决策——rule/precheck 是确定性规则产物，不是策略样本。
    if (record.decisionSource !== 'llm') {
      filteredNonLlm++;
      continue;
    }
    const instruction = buildInstruction(record);
    if (instruction === null) {
      skippedNoContext++;
      continue;
    }
    samples.push({
      instruction,
      response: buildResponse(record),
      meta: {
        simId,
        agentId: record.agentId,
        eventId: record.eventId,
        recordedAt,
        decisionSource: record.decisionSource,
        ...(forkId !== undefined ? { forkId } : {}),
        ...(typeof record.model === 'string' ? { model: record.model } : {}),
      },
    });
  }
  const counts = { samples: samples.length, skippedNoContext, filteredNonLlm };
  const manifest = {
    kind: 'manifest',
    simId: null,
    simTimeSec: null,
    recordedAt: base.generatedAt,
    payload: {
      ...base,
      format: 'sft',
      fields: {
        instruction:
          '决策的输入上下文：LLM 实见的 userPrompt（含事件、zone 状态、可用能力/伙伴）；' +
          '缺 prompt 时退化为 trajectory context 摘要（eventId/capabilities/zones/partnerServices）',
        response: '"Decision: <决策>" + 可选 "\\nReasoning: <理由>"',
        meta: '溯源信息（simId/agentId/eventId/recordedAt/decisionSource/model?），不参与训练',
      },
      counts,
      total: samples.length,
    },
  };
  return {
    lines: [manifest, ...samples].map(line => JSON.stringify(line)),
    counts,
    total: samples.length,
  };
}

/** DPO 效果标注：有效果（chosen 候选）vs 无效果/失败（rejected 候选）。 */
type DpoOutcome = 'success' | 'failure' | 'unknown';

/**
 * Phase 1（认知架构 §11.4）format=structured：instruction → 完整
 * CognitiveDecision 对象的多字段标签对。相比 sft 的
 * "Decision: <词>\nReasoning: <文本>"，这里的目标分布携带情势评估、
 * 目标栈、行动方案（含 deviceActions / collaboration / flowId）、解释
 * 因子与不确定性——同一批轨迹教出的监督密度高一个层级（R35 的
 * scaling roadmap 直接消费端）。只收 decisionSource='llm' 且解析成功
 * 携带 cognitiveDecision 的记录；二元时代/降级解析的记录跳过并计数。
 *
 * v5.2 lever-1（training loop §8.4a）：precheck Type-A 短路的
 * handle_independently 记录模板化导出（templated pair）——instruction 用
 * 同一决策时系统提示下的认知上下文投影重建（trajectory context +
 * 环境面的 agent 名/绑定设备），response 是模板六区块对。重建的部分
 * （事件参数/severity、伙伴相关性排序不在轨迹里）如实说明在
 * explanation.summary 与 meta（source='templated-precheck'）。
 */
/** v5.2 templated pair 的目标分布类型（TrajectoryRecord 携带的 CognitiveDecision 投影）。 */
type TemplatedCognitiveDecision = NonNullable<TrajectoryRecord['cognitiveDecision']>;
type TemplatedDeviceAction = NonNullable<NonNullable<TemplatedCognitiveDecision['actionPlan']['primary']['deviceActions']>>[number];

export interface ExportOwnDevice {
  deviceId: string;
  type: string;
  zoneId?: string;
  commands: string[];
}

/**
 * 导出时刻的环境面（v5.2 templated 上下文重建用）：agent 名与该 agent
 * 绑定的可执行设备（actuation commands，sensor-style 能力剔除——与
 * ACNecessityAssessor.buildOwnDevicesInventory / bridge 同一判定口径）。
 * 设备是导出时刻的绑定快照，不是决策时刻状态——summary 里如实说明。
 */
export interface ExportWorldFace {
  agentNameOf(agentId: string): string | undefined;
  ownDevicesOf(agentId: string): ExportOwnDevice[];
}

/** Read-style 能力不是 actuation 命令（core 共享只读谓词同口径，BUG-04 起从根导出）。 */
const isSensorStyleCapability = isReadOnlyCapabilityName;

/** 一次读库构建环境面：agents（名字/绑定设备 id）× devices（zone/能力）。 */
export function buildExportWorldFace(
  devices: DeviceInstanceRow[],
  agents: AgentInstanceRow[],
): ExportWorldFace {
  const deviceById = new Map<string, DeviceInstanceRow>(devices.map(d => [d.id, d]));
  const nameByAgent = new Map<string, string>(agents.map(a => [a.id, a.name]));
  const devicesByAgent = new Map<string, ExportOwnDevice[]>();
  for (const agent of agents) {
    const boundIds = parseJsonArray<string>(agent.bound_device_ids_json);
    const ownDevices: ExportOwnDevice[] = [];
    for (const deviceId of boundIds) {
      const row = deviceById.get(deviceId);
      if (row === undefined) continue;
      const commands = [...new Set(
        parseJsonArray<string>(row.capabilities_json)
          .map(cap => typeof cap === 'string' ? cap.toLowerCase() : '')
          .filter(cap => cap.length > 0 && !isSensorStyleCapability(cap)),
      )];
      if (commands.length === 0) continue; // 纯传感设备——无可执行命令
      ownDevices.push({
        deviceId: row.id,
        type: row.type,
        ...(row.zone_id !== null && row.zone_id.length > 0 ? { zoneId: row.zone_id } : {}),
        commands,
      });
    }
    devicesByAgent.set(agent.id, ownDevices);
  }
  return {
    agentNameOf: agentId => nameByAgent.get(agentId),
    ownDevicesOf: agentId => devicesByAgent.get(agentId) ?? [],
  };
}

/** precheck Type-A 短路记录（Coverage=1 × Gap=∅ → handle_independently）。 */
function isPrecheckIndependent(record: TrajectoryRecord): boolean {
  return record.decisionSource === 'precheck' &&
    record.decision === 'handle_independently' &&
    record.reasoningCode === 'precheck.independent';
}

/** reasoningParams.required（逗号串，''=无声明）→ 规范化需求列表。 */
function precheckRequiredCapabilities(record: TrajectoryRecord): string[] {
  const raw = record.reasoningParams?.required;
  return typeof raw === 'string'
    ? raw.split(',').map(part => part.trim()).filter(part => part.length > 0)
    : [];
}

/**
 * templated instruction：按 ACNecessityAssessor.buildPrompt 的分段格式重建
 * 最小认知上下文（AGENT/EVENT/EVENT_NEEDS/ACTUATORS/COVERAGE/MY_DEVICES/
 * AVAILABLE_PARTNERS）——轨迹里有什么用什么（capabilities/zones/partner
 * services + reasoningParams 的事件 zone/需求 + 环境面的设备清单），缺的
 * 部件（事件参数/severity、伙伴相关性排序）不臆造。context 整体缺失时
 * 返回 null（调用方跳过并计数，与 LLM 分支同策略）。
 */
function buildTemplatedInstruction(record: TrajectoryRecord, world: ExportWorldFace): string | null {
  const context = record.context as Partial<TrajectoryRecord['context']> | undefined;
  if (typeof context !== 'object' || context === null) return null;

  const zone = typeof record.reasoningParams?.zone === 'string' ? record.reasoningParams.zone : '';
  const required = precheckRequiredCapabilities(record);
  const caps = Array.isArray(context.capabilities) ? context.capabilities : [];
  const managedCount = context.managedZoneIds?.length ?? 0;
  const actuatorCount = context.actuatorZoneIds?.length ?? 0;

  const zonesInfo = managedCount > 0 ? ` | Zones=${managedCount}` : '';
  const actuatorZonesInfo = actuatorCount > 0
    ? `\nACTUATORS: ${actuatorCount} zone(s) where you can physically act`
    : '';
  // precheck.independent 的语义就是 direct actuator coverage——如实渲染。
  const coverageInfo = zone.length > 0
    ? '\nCOVERAGE: DIRECT — You have actuators in this zone.'
    : '';
  const needsInfo = required.length > 0
    ? `\nEVENT_NEEDS: ${untrustedBlock('event-needs', required.join(', '))} — compare with your Caps above`
    : '\nEVENT_NEEDS: none declared (the event states no capability requirements — treat your Caps as complete)';
  // 事件参数/新值/severity 不在轨迹里——只渲染已知段（Zone + 事件 id），
  // 不写"未捕获"类标记词（该词会成为 templated 对的伪特征，学不到真实
  // 提示上；诚实说明归 meta 与 explanation.summary）。
  const eventInfo = untrustedBlock(
    'event-summary',
    `Zone=${zone} | Event ${record.eventId} from engine-runtime`,
  );

  const inventory = world.ownDevicesOf(record.agentId).slice(0, 10);
  const devicesInfo = inventory.length > 0
    ? '\nMY_DEVICES (your OWN bound devices — for handle_independently, deviceActions may ONLY name these ' +
      `exact deviceIds and 'commands' values):\n` +
      untrustedJsonBlock('own-devices', inventory.map(device => ({
        deviceId: device.deviceId,
        type: device.type,
        ...(device.zoneId !== undefined ? { zone: device.zoneId } : {}),
        commands: device.commands,
      })))
    : '';

  const partners = Array.isArray(context.partnerServices) ? context.partnerServices : [];
  const partnerTotal = typeof context.partnerServicesTotal === 'number' && context.partnerServicesTotal > 0
    ? context.partnerServicesTotal
    : partners.length;
  const servicesInfo = partners.length > 0
    ? `AVAILABLE_PARTNERS: ${partners.length} of ${partnerTotal} (other agents' services, NOT yours): ` +
      untrustedBlock('partner-services', partners.slice(0, 3).map(p => p.serviceName).join(', '))
    : 'AVAILABLE_PARTNERS: 0 (no other agents available)';

  const agentName = world.agentNameOf(record.agentId) ?? `agent-${record.agentId}`;
  return `AGENT: ${agentName} | Caps=[${caps.join(',')}]${zonesInfo}
EVENT: ${eventInfo}${needsInfo}
${actuatorZonesInfo}${coverageInfo}${devicesInfo}
${servicesInfo}
Should this agent initiate collaboration?
DECISION:`;
}

/**
 * templated deviceActions：该事件 zone 内该 agent 绑定的可执行设备
 * （每台一个动作）——命令优先取声明需求命中的设备命令，否则首个可执行
 * 命令；不臆造 params（不知道期望参数值）。zone 内无可用设备时省略
 * deviceActions（诚实：模板不虚构动作面）。
 */
function buildTemplatedDeviceActions(
  record: TrajectoryRecord,
  world: ExportWorldFace,
): TemplatedDeviceAction[] {
  const zone = typeof record.reasoningParams?.zone === 'string' ? record.reasoningParams.zone : '';
  if (zone.length === 0) return [];
  const requiredLower = precheckRequiredCapabilities(record).map(cap => cap.toLowerCase());
  const actions: TemplatedDeviceAction[] = [];
  for (const device of world.ownDevicesOf(record.agentId)) {
    if (device.zoneId !== zone) continue;
    const command = requiredLower
      .map(need => device.commands.find(cmd => cmd === need))
      .find(cmd => cmd !== undefined) ?? device.commands[0];
    actions.push({ deviceId: device.deviceId, command });
    if (actions.length >= 4) break; // 聚焦事件 zone 的动作面，不铺满 8 上限
  }
  return actions;
}

/**
 * templated 六区块目标分布。situation 的 type/severity 是模板常数
 * （轨迹不记事件 severity/type——如实的缺省，与 parseCognitiveDecision
 * 的降级缺省同值：anomaly/3）；uncertainty 低 overall（判定本身是确定性
 * 规则的输出）但 dataQuality 打折（上下文是重建的）；重建说明落在
 * explanation.summary 与 riskFactors。
 */
function templatePrecheckCognitiveDecision(
  record: TrajectoryRecord,
  deviceActions: TemplatedDeviceAction[],
): TemplatedCognitiveDecision {
  const zone = typeof record.reasoningParams?.zone === 'string' ? record.reasoningParams.zone : 'unknown-zone';
  const required = precheckRequiredCapabilities(record);
  const requiredText = required.length > 0 ? required.join(', ') : 'none required';
  const primaryReasoning = typeof record.reasoning === 'string' && record.reasoning.trim().length > 0
    ? record.reasoning.trim()
    : `Direct actuator coverage in ${zone}; no capability gap.`;
  return {
    situation: {
      type: 'anomaly',
      severity: 3,
      affectedZones: [zone],
      rootCauseHypothesis: `event ${record.eventId} in ${zone}`,
      confidence: 0.6,
    },
    goals: [{ goal: `handle event ${record.eventId} in ${zone} with own actuation`, priority: 2 }],
    actionPlan: {
      primary: {
        action: 'handle_independently',
        reasoning: primaryReasoning,
        ...(deviceActions.length > 0 ? { deviceActions } : {}),
      },
    },
    explanation: {
      summary:
        `Direct actuator coverage in ${zone} with all required capabilities (${requiredText}) — ` +
        'handled independently without collaboration. [templated-precheck: target reconstructed from ' +
        'the deterministic Type-A short-circuit; context rebuilt from trajectory + environment face]',
      factors: [
        { name: 'coverage_direct', weight: 0.9 },
        { name: required.length > 0 ? 'required_capabilities_met' : 'no_requirements_declared', weight: 0.8 },
      ],
    },
    collaboration: {
      needed: false,
      reasoning: 'Own actuators cover the event zone and no required capability is missing — no partner needed.',
    },
    uncertainty: {
      overall: 0.2,
      dataQuality: 0.6,
      riskFactors: ['precheck-context-reconstructed'],
    },
  };
}

function buildStructuredExport(
  envelopes: Envelope[],
  base: BaseManifestPayload,
  world: ExportWorldFace,
): TrainingExportResult {
  const samples: unknown[] = [];
  let skippedNoContext = 0;
  let filteredNonLlm = 0;
  let skippedNoCognitive = 0;
  let templatedPrecheck = 0;
  for (const { simId, recordedAt, forkId, record } of decisionEntries(envelopes)) {
    // v5.2 lever-1：precheck Type-A 短路的 handle_independently 记录 →
    // 模板化六区块对（handle 监督的最大存量；见文件头注释）。
    if (isPrecheckIndependent(record)) {
      const instruction = buildTemplatedInstruction(record, world);
      if (instruction === null) {
        skippedNoContext++;
        continue;
      }
      templatedPrecheck++;
      samples.push({
        instruction,
        response: templatePrecheckCognitiveDecision(
          record,
          buildTemplatedDeviceActions(record, world),
        ),
        meta: {
          simId,
          agentId: record.agentId,
          eventId: record.eventId,
          recordedAt,
          decisionSource: record.decisionSource,
          templated: true,
          source: 'templated-precheck',
          legacyDecision: record.decision,
          ...(record.groundTruth.correctDecision !== 'unknown'
            ? { groundTruth: record.groundTruth, correct: record.correct }
            : {}),
          ...(forkId !== undefined ? { forkId } : {}),
        },
      });
      continue;
    }
    // 结构化监督只学 LLM 决策——rule/precheck（非 Type-A）是确定性规则产物。
    if (record.decisionSource !== 'llm') {
      filteredNonLlm++;
      continue;
    }
    // Phase 1 之前的轨迹 / 解析降级（llm-fsm、binary JSON）没有完整
    // schema——跳过并计数，不臆造字段（R35：学不会的标签宁可不导）。
    if (record.cognitiveDecision === undefined) {
      skippedNoCognitive++;
      continue;
    }
    const instruction = buildInstruction(record);
    if (instruction === null) {
      skippedNoContext++;
      continue;
    }
    samples.push({
      instruction,
      // 目标分布 = 完整 CognitiveDecision 对象（NDJSON 行内嵌套对象）。
      response: record.cognitiveDecision,
      meta: {
        simId,
        agentId: record.agentId,
        eventId: record.eventId,
        recordedAt,
        decisionSource: record.decisionSource,
        // 派生 legacy 决策（deriveLegacyDecision 的落账结果）——供
        // label-consistency gate 与既有二元评测直接对账。
        legacyDecision: record.decision,
        ...(record.groundTruth.correctDecision !== 'unknown'
          ? { groundTruth: record.groundTruth, correct: record.correct }
          : {}),
        ...(forkId !== undefined ? { forkId } : {}),
        ...(typeof record.model === 'string' ? { model: record.model } : {}),
      },
    });
  }
  const counts = { samples: samples.length, templatedPrecheck, skippedNoContext, filteredNonLlm, skippedNoCognitive };
  const manifest = {
    kind: 'manifest',
    simId: null,
    simTimeSec: null,
    recordedAt: base.generatedAt,
    payload: {
      ...base,
      format: 'structured',
      fields: {
        instruction:
          '决策的输入上下文（同 sft：LLM 实见 userPrompt 优先，退化取 trajectory context 摘要）；' +
          'templated-precheck 记录按决策时提示格式重建最小上下文（AGENT/EVENT/EVENT_NEEDS/COVERAGE/MY_DEVICES）',
        response:
          '完整 CognitiveDecision 对象（situation/goals/actionPlan/explanation/collaboration/uncertainty）' +
          '——认知架构 Phase 1 的结构化目标分布；actionPlan.primary.action 为六词动作词表',
        meta:
          '溯源 + 对账信息（legacyDecision=派生二元决策、groundTruth?/correct?、simId/agentId/eventId/recordedAt/model?、' +
          'templated?/source?=templated-precheck），不参与训练',
      },
      templating: {
        rule:
          "decisionSource='precheck' 且 reasoningCode='precheck.independent'（Type-A 全覆盖无缺口短路）的 " +
          'handle_independently 记录模板化为六区块对：instruction 由 trajectory context + 环境面' +
          '（agent 名/绑定设备）重建，response 为模板生成（situation.type/severity 为诚实缺省，事件 ' +
          'severity 不在轨迹里）；deviceActions 取该事件 zone 内该 agent 绑定的可执行设备（命令优先' +
          "命中声明需求）；meta.templated=true + meta.source='templated-precheck'。其余 precheck/rule " +
          '记录仍过滤（filteredNonLlm）',
      },
      counts,
      total: samples.length,
    },
  };
  return {
    lines: [manifest, ...samples].map(line => JSON.stringify(line)),
    counts,
    total: samples.length,
  };
}

/**
 * 单条决策的效果信号（与效果回检/reputation 的成败记录同源）：
 * 1. goalAchieved（仿真/runner 结算的目标达成位）优先；
 * 2. 缺省时回退 groundTruth 正确性（correctDecision 已知——'unknown'
 *    以外的取值——时用 correct）；
 * 3. 两者皆无 → 'unknown'（不参与配对，跳过并计数）。
 */
function outcomeOf(record: TrajectoryRecord): DpoOutcome {
  if (record.goalAchieved === true) return 'success';
  if (record.goalAchieved === false) return 'failure';
  const correctDecision = record.groundTruth?.correctDecision;
  if (typeof correctDecision === 'string' && correctDecision.length > 0 && correctDecision !== 'unknown') {
    return record.correct === true ? 'success' : 'failure';
  }
  return 'unknown';
}

/** 配对分组的事件类型键：interactionType 未知时归入 'unknown' 桶。 */
function eventTypeOf(record: TrajectoryRecord): string {
  const interactionType = record.groundTruth?.interactionType;
  return typeof interactionType === 'string' && interactionType.length > 0 && interactionType !== 'unknown'
    ? interactionType
    : 'unknown';
}

interface LabeledDecision {
  entry: DecisionEntry;
  instruction: string;
  outcome: 'success' | 'failure';
  atMs: number;
}

function buildDpoExport(envelopes: Envelope[], base: BaseManifestPayload): TrainingExportResult {
  let skippedNoContext = 0;
  let skippedNoOutcome = 0;
  // 配对规则（简单透明，写进 manifest）：同 agentId + 同事件类型分组。
  const groups = new Map<string, LabeledDecision[]>();
  for (const entry of decisionEntries(envelopes)) {
    const instruction = buildInstruction(entry.record);
    if (instruction === null) {
      skippedNoContext++;
      continue;
    }
    const outcome = outcomeOf(entry.record);
    if (outcome === 'unknown') {
      skippedNoOutcome++;
      continue;
    }
    const key = `${entry.record.agentId} ${eventTypeOf(entry.record)}`;
    const group = groups.get(key) ?? [];
    group.push({ entry, instruction, outcome, atMs: Date.parse(entry.recordedAt) });
    groups.set(key, group);
  }

  const records: unknown[] = [];
  let pairs = 0;
  let chosenOnly = 0;
  let unpairedRejected = 0;
  for (const group of groups.values()) {
    group.sort((a, b) => a.atMs - b.atMs);
    const failures = group.filter(item => item.outcome === 'failure');
    for (const success of group.filter(item => item.outcome === 'success')) {
      // 贪心：与窗内时间上最近的未配对失败记录配对。
      let best = -1;
      for (const [i, failure] of failures.entries()) {
        if (Math.abs(failure.atMs - success.atMs) > DPO_PAIR_WINDOW_MS) continue;
        if (best === -1 || Math.abs(failure.atMs - success.atMs) < Math.abs(failures[best].atMs - success.atMs)) {
          best = i;
        }
      }
      const meta = {
        agentId: success.entry.record.agentId,
        eventType: eventTypeOf(success.entry.record),
        chosenEventId: success.entry.record.eventId,
        chosenRecordedAt: success.entry.recordedAt,
        // P2F §10.4: fork provenance on preference pairs (training data
        // sourced from a sandbox must be attributable to it).
        ...(success.entry.simId !== null ? { simId: success.entry.simId } : {}),
        ...(success.entry.forkId !== undefined ? { forkId: success.entry.forkId } : {}),
      };
      if (best === -1) {
        // 配不上对的成功记录：单独输出 chosen（rejected=null）。
        chosenOnly++;
        records.push({
          prompt: success.instruction,
          chosen: buildResponse(success.entry.record),
          rejected: null,
          meta,
        });
      } else {
        const [failure] = failures.splice(best, 1);
        pairs++;
        records.push({
          prompt: success.instruction,
          chosen: buildResponse(success.entry.record),
          rejected: buildResponse(failure.entry.record),
          meta: {
            ...meta,
            rejectedEventId: failure.entry.record.eventId,
            rejectedRecordedAt: failure.entry.recordedAt,
          },
        });
      }
    }
    unpairedRejected += failures.length;
  }

  const counts = { pairs, chosenOnly, unpairedRejected, skippedNoOutcome, skippedNoContext };
  const manifest = {
    kind: 'manifest',
    simId: null,
    simTimeSec: null,
    recordedAt: base.generatedAt,
    payload: {
      ...base,
      format: 'dpo',
      fields: {
        prompt: 'chosen 记录的输入上下文（同组为同类事件；rejected 的上下文按 meta.rejectedRecordedAt 在原始导出中回溯）',
        chosen: '有效果决策的 "Decision: <决策>" + 可选 "\\nReasoning: <理由>"',
        rejected: '无效果/失败决策的同格式文本；配不上对时为 null（chosen-only 样本）',
        meta: '溯源信息（agentId/eventType/双方 eventId 与 recordedAt），不参与训练',
      },
      pairing: {
        rule:
          '同 agentId + 同事件类型（groundTruth.interactionType，unknown 归一桶）分组；组内按 recordedAt 排序，' +
          '每条成功决策与时间窗内最近的未配对失败决策配对；配不上对的成功记录单独输出 chosen（rejected=null），' +
          '配不上对的失败记录丢弃并计入 unpairedRejected',
        windowMs: DPO_PAIR_WINDOW_MS,
        outcome:
          '效果标注：goalAchieved（效果回检/仿真结算的成败信号，与 reputation 成败同源）优先；' +
          '缺省回退 groundTruth.correctDecision 已知时的 correct；两者皆无记 unknown 并跳过（skippedNoOutcome）',
      },
      counts,
      total: records.length,
    },
  };
  return {
    lines: [manifest, ...records].map(line => JSON.stringify(line)),
    counts,
    total: records.length,
  };
}

function usageEnvelope(row: UsageRecordRow): Envelope {
  return {
    kind: 'usage',
    simId: null,
    simTimeSec: null,
    recordedAt: row.started_at,
    ...(row.consumer_agent_id !== null ? { agentId: row.consumer_agent_id } : {}),
    payload: {
      id: row.id,
      agreementId: row.agreement_id,
      consumerAgentId: row.consumer_agent_id,
      providerAgentId: row.provider_agent_id,
      usageKind: row.kind,
      action: row.action,
      quantity: row.quantity,
      unit: row.unit,
      outcome: row.outcome,
      effectRef: row.effect_ref,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    },
  };
}

// ---------------------------------------------------------------------------
// 仿真时序源：trajectory 目录扫描与记录分类（与 replay-service Fix-14 同策略）
// ---------------------------------------------------------------------------

/**
 * 枚举 trajectoryBaseDir 下仿真目录的 JSONL 文件；simIdFilter 给定后只扫
 * 该仿真目录（目录名即 sim id，见 SimulationRegistry.create）。Living-worlds
 * P2：分段日志住在一级子目录（`sim-timeline/`、`<trajectory-base>/`）里，
 * 逐段枚举——rollup-* 聚合文件被排除（与 replay-service iterSimJsonlFiles
 * 同一不变量：聚合粒度不进导出/回放）。目录不可读时静默产出空迭代——
 * DB 侧数据仍可导出。
 */
function* iterSimJsonlFiles(
  baseDir: string,
  simIdFilter?: string,
): Generator<{ simId: string; filePath: string }> {
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('sim-')) continue;
    if (simIdFilter !== undefined && entry.name !== simIdFilter) continue;
    const dir = join(baseDir, entry.name);
    let top: Dirent[];
    try {
      top = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of top) {
      if (file.isFile() && file.name.endsWith('.jsonl')) {
        yield { simId: entry.name, filePath: join(dir, file.name) };
      }
    }
    // P2 分段子目录（sim-timeline/、<trajectory-base>/）：raw 段 only。
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
        if (file.name.startsWith('rollup-')) continue; // 聚合不进导出
        yield { simId: entry.name, filePath: join(dir, sub.name, file.name) };
      }
    }
  }
}

/** 读取一个 JSONL 源文件的已解析行；超限/不可读/半行写入均静默跳过。 */
function readJsonlLines(filePath: string): unknown[] {
  try {
    if (statSync(filePath).size > EXPORT_SOURCE_FILE_MAX_BYTES) return [];
    const parsed: unknown[] = [];
    for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        parsed.push(JSON.parse(trimmed));
      } catch {
        // 崩溃残留的半行 —— 与 trajectory-store 的容忍策略一致
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

/** 与 replay-service / trajectory-store 一致的最小结构守卫。 */
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
