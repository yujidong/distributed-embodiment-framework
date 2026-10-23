/**
 * Eval-run service — 批量评估 runner（Wave-3a，roadmap Wave 3 "AI 训练场"）
 *
 * 给定一个环境 + 一组事件剧本，串行跑 N 次仿真（每次可覆盖 LLM
 * preset/model/prompt 变体），每次结束收集与单跑 eval-report 同口径的
 * 聚合指标（eval-report.ts 的 aggregateEvalRecords），产出 per-run 结果 +
 * 跨 run 对比表，落 eval_runs 表（DB），GET 可取回。
 *
 * 典型对比：模型 A vs B（runs[].llmModel）、prompt 改前改后
 * （promptVariants + runs[].llmPromptVariant）、rule vs LLM
 * （runs[].llmClient: 'none' vs 'llm'）、Agent A/B（Wave-3b
 * runs[].agentOverrides：同世界同剧本下改某个 Agent 的能力/模型/prompt——
 * 只作用于该 run 的 scenario 副本，真实世界不动）。
 *
 * 调度：进程内串行队列——所有批量任务共享一条 promise 链，一次只跑一个
 * 仿真，避免并发把 LLM 后端打爆。每个 run 有 wall-clock 超时保护
 * （cooperative：每个 await 点检查，EAF_EVAL_RUN_TIMEOUT_MS 可配）；
 * 单个 run 失败/超时只标记该 run，不拖垮整批。仿真推进是确定性的
 * step 驱动（不开 wall-clock tick 循环）：事件按 atSimTimeSec 排序，
 * 先 step 到注入点再注入，全部注入后再 step runs[].steps 个 tick 收尾。
 */

import type { EngineRuntime, InjectEventInput, ScenarioDefinition } from '@active-collaboration/core';

import type { ChangePipeline } from './change-pipeline.js';
import type { EnvironmentStore } from './db/environment-store.js';
import type { EvalRunRow, EvalRunStore } from './db/eval-run-store.js';
import { environmentToScenario } from './environment-bridge.js';
import { ApiError } from './errors.js';
import { aggregateEvalRecords, EVAL_REPORT_MAX_RECORDS, type EvalReportMetrics } from './eval-report.js';
import type { CreateSimulationOptions, LLMPreset, SimulationRegistry } from './simulation-registry.js';
import { readTrajectoryDirRecords, readTrajectoryRecords } from './trajectory-store.js';

/** 单个批量任务最多多少个 run（防御性上限）。 */
export const EVAL_RUN_MAX_RUNS = 20;
/** 单个批量任务最多多少个事件。 */
export const EVAL_RUN_MAX_EVENTS = 500;
/** 事件全部注入后的默认收尾 tick 数（run.steps 可覆盖）。 */
export const EVAL_RUN_DEFAULT_STEPS = 60;
/** run.steps 上限（每一步还会走物理层，病态长跑靠它与超时双重兜底）。 */
export const EVAL_RUN_MAX_STEPS = 10_000;

/** 批量评估的事件剧本条目：injectEvent 输入 + 可选的仿真时间调度点。 */
export interface EvalRunSpecEvent extends InjectEventInput {
  /** 在该仿真秒注入（缺省 = 紧接上一件事之后）。 */
  atSimTimeSec?: number;
}

/**
 * Per-run 世界变体（Wave-3b Agent A/B）：run 执行前在该 run 的 scenario
 * 副本上应用（applyAgentOverrides）——不改真实世界（env 实例行不动）。
 * capabilities 直接替换 agent 的能力表（改变规则/LLM 可见的能力）；
 * llmModel/systemPrompt 写进 agent.llm（per-agent prompt 覆盖全局
 * llmPromptVariant，见 core ScenarioAgentLLM.systemPrompt）。
 */
export interface EvalRunAgentOverride {
  agentId: string;
  /** 替换该 agent 的能力表。 */
  capabilities?: string[];
  /** 写进 agent.llm.model（无 llm 配置时补 provider='openai-compatible'）。 */
  llmModel?: string;
  /** 写进 agent.llm.systemPrompt（per-agent prompt 覆盖）。 */
  systemPrompt?: string;
}

export interface EvalRunSpecRun {
  label: string;
  /** LLM preset 覆盖（'none' = rule-only 基线）。 */
  llmClient?: LLMPreset;
  /** 模型覆盖（模型 A vs B）。 */
  llmModel?: string;
  /** prompt 变体名 —— 必须在 spec.promptVariants 里有定义。 */
  llmPromptVariant?: string;
  /** Per-run 世界变体（Wave-3b）：只作用于该 run 的 scenario 副本。 */
  agentOverrides?: EvalRunAgentOverride[];
  /** 每 tick 推进的仿真秒数（默认 1）。 */
  speed?: number;
  /** 事件注入完后的收尾 tick 数（默认 EVAL_RUN_DEFAULT_STEPS）。 */
  steps?: number;
}

export interface EvalRunSpec {
  runs: EvalRunSpecRun[];
  events: EvalRunSpecEvent[];
  /** prompt 变体表：变体名 → AC 评估器 system prompt 全文。 */
  promptVariants?: Record<string, string>;
}

/** 单个 run 的结算结果。 */
export interface EvalRunResult {
  label: string;
  status: 'done' | 'failed';
  /** 本次 run 创建的仿真 id（可继续查 eval-report / trajectory）。 */
  simId?: string;
  /** 仿真实际的 LLM 接线方式。 */
  llm?: 'llm' | 'rule-only';
  llmModel?: string;
  llmPromptVariant?: string;
  /** 该 run 应用的 per-agent 覆盖（Wave-3b 回声，便于审计/复现）。 */
  agentOverrides?: EvalRunAgentOverride[];
  llmWarning?: string;
  durationMs: number;
  error?: string;
  metrics?: EvalReportMetrics;
}

/** 跨 run 对比表：数组与 labels 顺序对齐；失败的 run 对应位置为 null。 */
export interface EvalRunComparison {
  labels: string[];
  metrics: {
    decisions: Array<number | null>;
    /** LLM 决策占比（bySource 中 llm+triage / total）。 */
    llmShare: Array<number | null>;
    accuracy: Array<number | null>;
    handshakeSuccessRate: Array<number | null>;
    effectCheckPassRate: Array<number | null>;
    reputationAttempts: Array<number | null>;
    reputationSuccesses: Array<number | null>;
  };
}

export interface EvalRunResultDocument {
  envId: string;
  generatedAt: string;
  runs: EvalRunResult[];
  comparison: EvalRunComparison;
}

const LLM_PRESET_VALUES: readonly string[] = ['auto', 'llm', 'none'];
const SEVERITIES: readonly string[] = ['low', 'medium', 'high', 'critical'];

/**
 * 事件条目允许的字段 = injectEvent 输入（core InjectEventInput，与
 * POST /api/simulations/:id/events 同一形状）+ 调度点 atSimTimeSec。
 */
const EVENT_FIELDS: readonly string[] = [
  'type', 'zoneId', 'parameter', 'value', 'id', 'severity', 'requiredCapabilities',
  'humanNarrative', 'cinematography', 'focusZoneId', 'atSimTimeSec',
];

/**
 * 常见拼写错误 → 正确字段名。DevLoop T-008：eval spec 曾静默丢弃未知
 * 字段——A/B 工具里 `model` 拼错意味着两个 run 跑的是同一配置，比较结果
 * 全是噪声。与 T-001（/commands 参数）同一对策：拼错 → 带改名提示的
 * 400，而不是静默降级。
 */
const RENAME_HINTS: Record<string, Record<string, string>> = {
  body: {
    prompts: 'promptVariants',
    promptVariants2: 'promptVariants',
    runsList: 'runs',
    eventScript: 'events',
  },
  run: {
    client: 'llmClient', llm: 'llmClient', preset: 'llmClient',
    model: 'llmModel',
    promptVariant: 'llmPromptVariant', variant: 'llmPromptVariant', prompt: 'llmPromptVariant',
    step: 'steps', ticks: 'steps', stepCount: 'steps', tickCount: 'steps',
    overrides: 'agentOverrides', agents: 'agentOverrides',
  },
  override: {
    agent: 'agentId', id: 'agentId',
    caps: 'capabilities',
    system: 'systemPrompt',
  },
  event: {
    simTimeSec: 'atSimTimeSec', atSimSec: 'atSimTimeSec', timeSec: 'atSimTimeSec',
    at: 'atSimTimeSec', scheduledAt: 'atSimTimeSec', scheduleAt: 'atSimTimeSec',
    zone: 'zoneId',
  },
};

/**
 * 拒绝未知字段（DevLoop T-008，与 simulations.ts 顶层/故障档案同一约定）：
 * 报出未知字段名 + 改名提示 + 接受列表，绝不静默丢弃——eval spec 里被
 * 丢掉的字段会悄悄改变批量评估在比较什么。
 */
function rejectUnknownFields(
  input: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  hints: Record<string, string>,
): void {
  const unknown = Object.keys(input).filter(key => !allowed.includes(key));
  if (unknown.length === 0) return;
  const named = unknown
    .map(key => (hints[key] !== undefined ? `"${key}" (did you mean "${hints[key]}"?)` : `"${key}"`))
    .join(', ');
  throw new ApiError(
    400,
    'BAD_REQUEST',
    `${where}: unknown field${unknown.length > 1 ? 's' : ''} ${named}. ` +
      `Accepted: ${allowed.map(field => `"${field}"`).join(', ')}. ` +
      'Unknown fields are rejected (not silently dropped) — a dropped field here would silently change what the eval compares.',
  );
}

/** 解析 + 校验提交体；不合法抛 400 ApiError。 */
export function parseEvalRunSpec(raw: unknown): EvalRunSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body must be an object ({ runs, events, promptVariants? })');
  }
  const body = raw as Record<string, unknown>;
  rejectUnknownFields(body, ['runs', 'events', 'promptVariants'], 'Body', RENAME_HINTS.body);

  if (!Array.isArray(body.runs) || body.runs.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "runs" must be a non-empty array');
  }
  if (body.runs.length > EVAL_RUN_MAX_RUNS) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "runs" is capped at ${EVAL_RUN_MAX_RUNS} entries`);
  }
  if (!Array.isArray(body.events)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "events" must be an array (possibly empty)');
  }
  if (body.events.length > EVAL_RUN_MAX_EVENTS) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "events" is capped at ${EVAL_RUN_MAX_EVENTS} entries`);
  }

  let promptVariants: Record<string, string> | undefined;
  if (body.promptVariants !== undefined) {
    if (typeof body.promptVariants !== 'object' || body.promptVariants === null || Array.isArray(body.promptVariants)) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "promptVariants" must be an object (name → system prompt)');
    }
    promptVariants = {};
    for (const [name, prompt] of Object.entries(body.promptVariants as Record<string, unknown>)) {
      if (typeof prompt !== 'string' || prompt.length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', `promptVariants["${name}"] must be a non-empty string`);
      }
      promptVariants[name] = prompt;
    }
  }

  const labels = new Set<string>();
  const runs = body.runs.map((entry, i) => parseRunSpec(entry, i, labels, promptVariants));
  const events = body.events.map((entry, i) => parseEventSpec(entry, i));
  return {
    runs,
    events,
    ...(promptVariants !== undefined ? { promptVariants } : {}),
  };
}

function parseRunSpec(
  raw: unknown,
  index: number,
  labels: Set<string>,
  promptVariants: Record<string, string> | undefined,
): EvalRunSpecRun {
  const where = `runs[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', `${where} must be an object`);
  }
  const input = raw as Record<string, unknown>;
  rejectUnknownFields(
    input,
    ['label', 'llmClient', 'llmModel', 'llmPromptVariant', 'agentOverrides', 'speed', 'steps'],
    `${where}`,
    RENAME_HINTS.run,
  );
  if (typeof input.label !== 'string' || input.label.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `${where}.label must be a non-empty string`);
  }
  const label = input.label.trim();
  if (labels.has(label)) {
    throw new ApiError(400, 'BAD_REQUEST', `${where}.label "${label}" is duplicated — labels must be unique`);
  }
  labels.add(label);

  const run: EvalRunSpecRun = { label };
  if (input.llmClient !== undefined) {
    if (typeof input.llmClient !== 'string' || !LLM_PRESET_VALUES.includes(input.llmClient)) {
      throw new ApiError(400, 'BAD_REQUEST', `${where}.llmClient must be one of "auto" | "llm" | "none"`);
    }
    run.llmClient = input.llmClient as LLMPreset;
  }
  if (input.llmModel !== undefined) {
    if (typeof input.llmModel !== 'string' || input.llmModel.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', `${where}.llmModel must be a non-empty string`);
    }
    run.llmModel = input.llmModel;
  }
  if (input.llmPromptVariant !== undefined) {
    if (typeof input.llmPromptVariant !== 'string' || input.llmPromptVariant.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', `${where}.llmPromptVariant must be a non-empty string`);
    }
    if (promptVariants?.[input.llmPromptVariant] === undefined) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `${where}.llmPromptVariant "${input.llmPromptVariant}" is not defined in promptVariants`,
      );
    }
    run.llmPromptVariant = input.llmPromptVariant;
  }
  if (input.agentOverrides !== undefined) {
    run.agentOverrides = parseAgentOverrides(input.agentOverrides, where);
  }
  if (input.speed !== undefined) {
    if (typeof input.speed !== 'number' || !Number.isFinite(input.speed) || input.speed <= 0) {
      throw new ApiError(400, 'BAD_REQUEST', `${where}.speed must be a number > 0`);
    }
    run.speed = input.speed;
  }
  if (input.steps !== undefined) {
    if (!Number.isInteger(input.steps) || (input.steps as number) < 1 || (input.steps as number) > EVAL_RUN_MAX_STEPS) {
      throw new ApiError(400, 'BAD_REQUEST', `${where}.steps must be an integer in [1, ${EVAL_RUN_MAX_STEPS}]`);
    }
    run.steps = input.steps as number;
  }
  return run;
}

function parseAgentOverrides(raw: unknown, where: string): EvalRunAgentOverride[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', `${where}.agentOverrides must be an array`);
  }
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const at = `${where}.agentOverrides[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ApiError(400, 'BAD_REQUEST', `${at} must be an object ({agentId, capabilities?, llmModel?, systemPrompt?})`);
    }
    const input = entry as Record<string, unknown>;
    rejectUnknownFields(
      input,
      ['agentId', 'capabilities', 'llmModel', 'systemPrompt'],
      `${at}`,
      RENAME_HINTS.override,
    );
    if (typeof input.agentId !== 'string' || input.agentId.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', `${at}.agentId must be a non-empty string`);
    }
    if (seen.has(input.agentId)) {
      throw new ApiError(400, 'BAD_REQUEST', `${at}.agentId "${input.agentId}" is duplicated within the run`);
    }
    seen.add(input.agentId);
    const override: EvalRunAgentOverride = { agentId: input.agentId };
    if (input.capabilities !== undefined) {
      if (!Array.isArray(input.capabilities) || input.capabilities.some(c => typeof c !== 'string' || c.length === 0)) {
        throw new ApiError(400, 'BAD_REQUEST', `${at}.capabilities must be an array of non-empty strings`);
      }
      override.capabilities = [...input.capabilities] as string[];
    }
    for (const field of ['llmModel', 'systemPrompt'] as const) {
      if (input[field] !== undefined) {
        if (typeof input[field] !== 'string' || (input[field] as string).length === 0) {
          throw new ApiError(400, 'BAD_REQUEST', `${at}.${field} must be a non-empty string`);
        }
        override[field] = input[field] as string;
      }
    }
    return override;
  });
}

/**
 * Wave-3b Agent A/B：在该 run 的 scenario 副本上应用 per-agent 覆盖。
 * 副本由 environmentToScenario 每次新建，真实世界（env 实例行）不动。
 * 未知 agentId 抛错 —— 该 run 标记 failed，不悄悄忽略拼错的覆盖。
 */
export function applyAgentOverrides(
  scenario: ScenarioDefinition,
  overrides: EvalRunAgentOverride[],
): void {
  for (const override of overrides) {
    const agent = scenario.agents.find(a => a.id === override.agentId);
    if (!agent) {
      throw new Error(`agentOverrides: agent "${override.agentId}" not found in the environment scenario`);
    }
    if (override.capabilities !== undefined) {
      agent.capabilities = [...override.capabilities];
    }
    if (override.llmModel !== undefined || override.systemPrompt !== undefined) {
      // T-601: a null llm (explicit rule-only) starts a FRESH block here —
      // the override itself opts the agent back into an llm config.
      const llm: Record<string, unknown> = { ...(agent.llm ?? {}) };
      llm.provider ??= 'openai-compatible';
      if (override.llmModel !== undefined) llm.model = override.llmModel;
      if (override.systemPrompt !== undefined) llm.systemPrompt = override.systemPrompt;
      agent.llm = llm as unknown as ScenarioDefinition['agents'][number]['llm'];
    }
  }
}

function parseEventSpec(raw: unknown, index: number): EvalRunSpecEvent {
  const where = `events[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', `${where} must be an object (the injectEvent input)`);
  }
  const input = raw as Record<string, unknown>;
  rejectUnknownFields(input, EVENT_FIELDS, `${where}`, RENAME_HINTS.event);
  if (typeof input.type !== 'string' || input.type.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `${where}.type must be a non-empty string`);
  }
  if (typeof input.zoneId !== 'string' || input.zoneId.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `${where}.zoneId must be a non-empty string`);
  }
  if (input.severity !== undefined && !SEVERITIES.includes(input.severity as string)) {
    throw new ApiError(400, 'BAD_REQUEST', `${where}.severity must be one of "low" | "medium" | "high" | "critical"`);
  }
  if (
    input.atSimTimeSec !== undefined &&
    (typeof input.atSimTimeSec !== 'number' || !Number.isFinite(input.atSimTimeSec) || input.atSimTimeSec < 0)
  ) {
    throw new ApiError(400, 'BAD_REQUEST', `${where}.atSimTimeSec must be a number >= 0`);
  }
  return input as unknown as EvalRunSpecEvent;
}

export class EvalRunService {
  /** 进程内串行队列：所有批量任务共享一条链，一次只跑一个仿真。 */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      registry: SimulationRegistry;
      envStore: EnvironmentStore;
      evalRunStore: EvalRunStore;
      /** 创建落 command_log 审计（kind 'eval-run'）。 */
      pipeline?: ChangePipeline;
      /** 单 run 的 wall-clock 超时（ms，cooperative 检查）。 */
      perRunTimeoutMs: number;
    },
  ) {}

  /** 建档（pending）+ 审计 + 排队异步执行；立即返回行。 */
  submit(envId: string, userId: string, spec: EvalRunSpec): EvalRunRow {
    const row = this.deps.evalRunStore.create({ envId, createdBy: userId, spec });
    this.deps.pipeline?.log({
      envId,
      actorId: userId,
      kind: 'eval-run',
      payload: {
        evalRunId: row.id,
        runs: spec.runs.map(run => ({
          label: run.label,
          llmClient: run.llmClient ?? null,
          llmModel: run.llmModel ?? null,
          llmPromptVariant: run.llmPromptVariant ?? null,
          agentOverrides: run.agentOverrides?.map(override => override.agentId) ?? null,
        })),
        events: spec.events.length,
      },
    });
    // 串行调度：前一个批量跑完才轮到这一个；执行失败在 execute 内部
    // 落到行状态，绝不打断队列本身。
    this.queue = this.queue.then(() => this.execute(row.id));
    return row;
  }

  /** 测试钩子：等待队列排空（等价于所有已提交批量到达终态）。 */
  async drain(): Promise<void> {
    await this.queue;
  }

  private async execute(id: string): Promise<void> {
    const { evalRunStore, envStore } = this.deps;
    const row = evalRunStore.getOrThrow(id);
    evalRunStore.markRunning(id);
    try {
      const spec = JSON.parse(row.spec_json) as EvalRunSpec;
      const env = envStore.getEnvironment(row.env_id);
      if (!env) throw new Error(`Environment "${row.env_id}" no longer exists`);

      const runs: EvalRunResult[] = [];
      for (const run of spec.runs) {
        runs.push(await this.executeOne(row.env_id, row.created_by, spec, run));
      }
      evalRunStore.markDone(id, {
        envId: row.env_id,
        generatedAt: new Date().toISOString(),
        runs,
        comparison: buildComparison(runs),
      } satisfies EvalRunResultDocument);
    } catch (error) {
      evalRunStore.markFailed(id, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 跑一次仿真：创建（带 per-sim LLM 覆盖）→ 按剧本注入事件 → step 收尾
   * → stop（持久化 reputation）→ 收集 eval-report 同口径指标。任何异常
   * （含超时）只标记本 run 为 failed，批量继续。
   */
  private async executeOne(
    envId: string,
    createdBy: string,
    spec: EvalRunSpec,
    run: EvalRunSpecRun,
  ): Promise<EvalRunResult> {
    const startedAtMs = Date.now();
    const deadline = startedAtMs + this.deps.perRunTimeoutMs;
    const assertWithinBudget = (): void => {
      if (Date.now() > deadline) {
        throw new Error(
          `run exceeded the per-run timeout of ${this.deps.perRunTimeoutMs}ms ` +
          '(EAF_EVAL_RUN_TIMEOUT_MS)',
        );
      }
    };
    const base: Omit<EvalRunResult, 'status'> = {
      label: run.label,
      ...(run.llmModel !== undefined ? { llmModel: run.llmModel } : {}),
      ...(run.llmPromptVariant !== undefined ? { llmPromptVariant: run.llmPromptVariant } : {}),
      ...(run.agentOverrides !== undefined ? { agentOverrides: run.agentOverrides } : {}),
      durationMs: 0,
    };

    let simId: string | undefined;
    let runtime: EngineRuntime | undefined;
    try {
      const env = this.deps.envStore.getEnvironment(envId);
      if (!env) throw new Error(`Environment "${envId}" no longer exists`);
      const scenario = environmentToScenario(
        env,
        this.deps.envStore.devicesOf(env.id),
        this.deps.envStore.agentsOf(env.id),
      );
      // Wave-3b：per-run 世界变体 —— 只改该 run 的 scenario 副本
      // （environmentToScenario 每次新建），真实世界不动。
      if (run.agentOverrides !== undefined && run.agentOverrides.length > 0) {
        applyAgentOverrides(scenario, run.agentOverrides);
      }
      const options: CreateSimulationOptions = {
        ...(run.llmClient !== undefined ? { llmClient: run.llmClient } : {}),
        ...(run.llmModel !== undefined ? { llmModel: run.llmModel } : {}),
        ...(run.llmPromptVariant !== undefined
          ? { llmSystemPrompt: spec.promptVariants![run.llmPromptVariant] }
          : {}),
      };
      const record = await this.deps.registry.create(scenario, options, envId, createdBy, env.owner_id);
      simId = record.id;
      runtime = record.runtime;
      assertWithinBudget();

      // speed 只影响每个 tick 推进的仿真秒；start+pause 设置 speed 而不
      // 真的进入 wall-clock 循环（step 在 paused 下可用）。
      const speed = run.speed ?? 1;
      if (speed !== 1) {
        runtime.start(speed);
        runtime.pause();
      }

      // 按 atSimTimeSec 排序注入：先 step 推进到调度点，再注入。
      const events = [...spec.events].sort(
        (a, b) => (a.atSimTimeSec ?? 0) - (b.atSimTimeSec ?? 0),
      );
      for (const event of events) {
        const at = event.atSimTimeSec;
        if (at !== undefined && at > runtime.getSimTimeSec()) {
          await runtime.step(Math.ceil((at - runtime.getSimTimeSec()) / speed));
        }
        await runtime.injectEvent(event);
        assertWithinBudget();
      }
      await runtime.step(run.steps ?? EVAL_RUN_DEFAULT_STEPS);
      assertWithinBudget();

      // stop 持久化 env 背书的 reputation（P4-1），记录留在 registry。
      this.deps.registry.stop(simId);

      const filePath = runtime.getTrajectoryFilePath();
      // Living-worlds P2: the trajectory log is size-segmented — read the
      // whole dir (legacy file + segments); the single filePath would only
      // see the active segment.
      const records =
        filePath === null
          ? []
          : record.trajectoryDir !== undefined
            ? await readTrajectoryDirRecords(record.trajectoryDir, { cap: EVAL_REPORT_MAX_RECORDS })
            : await readTrajectoryRecords(filePath, { cap: EVAL_REPORT_MAX_RECORDS });
      return {
        ...base,
        status: 'done',
        simId,
        llm: record.llm,
        ...(record.llmWarning !== undefined ? { llmWarning: record.llmWarning } : {}),
        durationMs: Date.now() - startedAtMs,
        metrics: aggregateEvalRecords(records, runtime.getReputationJSON().records),
      };
    } catch (error) {
      // 失败的 run 也要停掉 runtime，别把 tick 循环/LLM 调用留在后台。
      if (simId !== undefined) {
        try {
          this.deps.registry.stop(simId);
        } catch {
          // 已停或半建 —— 尽力而为
        }
      }
      return {
        ...base,
        status: 'failed',
        ...(simId !== undefined ? { simId } : {}),
        durationMs: Date.now() - startedAtMs,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** 跨 run 对比表：数组与结果顺序对齐；失败的 run 对应位置为 null。 */
export function buildComparison(runs: EvalRunResult[]): EvalRunComparison {
  const metric = <T>(pick: (metrics: EvalReportMetrics) => T): Array<T | null> =>
    runs.map(run => (run.status === 'done' && run.metrics ? pick(run.metrics) : null));
  return {
    labels: runs.map(run => run.label),
    metrics: {
      decisions: metric(m => m.decisions.total),
      llmShare: metric(m =>
        m.decisions.total > 0
          ? ((m.decisions.bySource.llm ?? 0) + (m.decisions.bySource.triage ?? 0)) / m.decisions.total
          : null,
      ),
      accuracy: metric(m => m.decisions.accuracy),
      handshakeSuccessRate: metric(m => m.handshakes.successRate),
      effectCheckPassRate: metric(m => m.effectChecks.passRate),
      reputationAttempts: metric(m => m.reputation.totals.attempts),
      reputationSuccesses: metric(m => m.reputation.totals.successes),
    },
  };
}
