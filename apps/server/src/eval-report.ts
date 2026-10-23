/**
 * Eval report — Fix-22 决策质量聚合 + Wave-3a 重启可评估（扫盘 fallback）
 *
 * 聚合是纯函数：trajectory JSONL 记录 + reputation 记录 → 指标
 * （事件/决策按 decisionSource 分布、AC 握手成功率与失败归因（R2 T5 /
 * B1-4：failures.byCause，只用已落账记录）、P5 服务 origin 漏斗、
 * 温度类效果回检通过率、F3-2 轨迹级小节——链路完整率/结构化输出合规率/
 * LLM 失败账本、reputation 汇总）。两个调用方：
 *
 * 1. `GET /api/simulations/:id/eval-report`（routes/simulations.ts）——
 *    registry 命中时从 runtime 取 trajectory 路径与 reputation tracker
 *    （source 'registry'）；registry 未命中（server 重启后内存记录丢失）
 *    时退到 `loadDiskEvalReport`，按 simId 扫
 *    `<trajectoryBaseDir>/<simId>/` 重建指标（source 'disk'）：trajectory
 *    与 sim-timeline 都在盘上，reputation 取 DB 中该环境的持久化行。
 *    registry 独有的状态（运行状态、精确 sim 时间）如实缺省并在 notes
 *    标注。
 * 2. eval-runs 批量评估（eval-run-service.ts）——每次 run 结束后对刚停的
 *    runtime 跑同一聚合，保证单跑与批跑口径一致。
 *
 * Fix-22 起聚合读全量 trajectory 文件（不受交互查询 500 条上限约束），
 * 对病态长跑用一个防御性上限截断。
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { TrajectoryRecord } from '@active-collaboration/core';
import { capabilityMatches, integerizeReputationEvents } from '@active-collaboration/core';

import type { ReputationStore } from './db/reputation-store.js';
import { forEachSimTimelineRecord } from './sim-timeline.js';
import { readTrajectoryDirRecords } from './trajectory-store.js';

/** 聚合读取的 trajectory 记录数防御性上限（病态长跑截断）。 */
export const EVAL_REPORT_MAX_RECORDS = 100_000;

/**
 * BUG-07: the BASE AC handshake window in wall ms (CollaborationCoordinator
 * .DEFAULT_HANDSHAKE_TIMEOUT_MS = 120s; the T123 high-rate floor can only
 * EXTEND the window, never shrink it). A handshake with no conclusion
 * record whose initiation is younger than one window at sampling time is
 * reported as pendingAtSampling — undecided, not silently dead.
 */
export const EVAL_HANDSHAKE_WINDOW_MS = 120_000;

/**
 * R100 (chen-10): the report's self-describing methodology — every metric's
 * inclusion/exclusion rule, so a reviewer can recompute every number from
 * the trajectory alone (the eval↔trajectory reconciliation contract).
 */
export const EVAL_METHODOLOGY: readonly string[] = [
  'decisions: 仅统计 kind 缺省的决策记录；FEAT-09 起事件 requiredCapabilities 与自身声明∪设备面零交集的受众默认 observe-only（进观测不进 initiate 评估、不落决策记录，决策总数相应下降）；groundTruth.correctDecision="unknown" 记 unlabeled 且不入 accuracy 分母（accuracy 全 unlabeled 时为 null）；collaboration-response / nl-interaction / device-execution 不进 decisions（条数见 recordKinds）。',
  'handshakes: initiated = trajectory 中 initiate_ac 决策记录数（老数据无 initiate 记录时退回握手组数，取两者较大值）；succeeded = 握手组内任一 accept；succeededUnmetered（FEAT-04）= 成功握手组内全部可判定 accept（record 同时带 requestedCapabilities 与非空 myServices 面）与请求能力零交集——server ac-agreement-bridge 无匹配报价跳过落账（unmetered skip）的 trajectory 侧口径，⊆ succeeded（发起方通知同形态标 accepted-unmetered）；桥侧真实判定还读报价 interface action 面（trajectory 只带 semanticType），零交集组理论上仍可能经 action 名匹配落账，故此计数为其近似上界；context 不全的 legacy accept 不可判定即不入桶；cancelled = 组内出现 cancelled 且无 accept（取消如实单列）；failed = initiated − succeeded（R5-F05 口径：全员拒绝后的取消属于协商失败，不是执行失败）；cancelledByCoordinator = 发起去重的机制性取消（不入 negotiationSuccessRate 分母）。窗口含倍率门控墙钟下限（T123）。',
  'effectChecks: reputation 温度类效果回检 ∪ device-execution 真实设备调用回执（executed/failed 计入 attempts/successes/failures；切片见 deviceExecutions）。T71（R8 u1-F3）起全部计数为整数事件桶：partial 事件单列在 partial、不计入 successes（passRate = successes/attempts）；v64 之前的 legacy 行从权重和整数化还原（整数权重和精确还原，半整数 partial 近似，绝不显示小数计数）。failureBreakdown（UX-02）失败下钻：byKind/byCause 为全量计数——device-execution 失败回执按 error 文本分桶、goal-unachieved = goalAchieved 结算为 false 的决策记录（温度回检失败的 trajectory 侧痕迹；与 reputation 事件桶不同源，数目不要求对账）；records 列出可定位的失败痕迹（device-execution 带 eventId/agentId/deviceId/command/error，goal-unachieved 带 eventId/agentId/decision），防御性截断 100 条（计数不受截断影响）。',
  'trajectory.chain: actionable = decision ∈ handle_independently/initiate_ac；withFeedback = goalAchieved 已结算 或 同（eventId, agentId）存在 decision 触发的 device-execution 回执（R101 挂接；R102 起 AC 执行道把协作 triggerEventId 穿进命令上下文——履约执行的回执带决策 eventId，inflight 窗口关闭后不再落 unattributed；回执只闭合"决策→执行"半链，不冒充目标达成）。',
  'responders: collaboration-response（accept/reject）应答评估质量块——total/accepts/rejects/bySource + labeled accuracy；GT 口径（R102）：记录自带显式 groundTruth 优先，否则按可交付匹配判定——accept 全部请求能力有支撑=correct、accept 有无支撑请求=incorrect（超承）、reject 全无可交付=correct、reject 有可交付=incorrect（漏接）；cancelled/defer/counter 与无 context 记录保持 unlabeled（不静默 null）。',
  'metaAgents（registry 面）＝跨仿真全历史口径（DecisionQualityTracker 持久化经验快照，R6-E-F15）——T29 裁定：不再被本报告窗口的决策整行覆盖（R101/R102 的行级 reconcile 已撤销）；本窗口决策数单列在 windowDecisionCount，行带 window 标注（registry 行 = all-history；trajectory 有决策而 registry 无条目的 agent 仍合成行，但显式标注 report-window＝本窗口，不与全历史行混排）；evaluatedDecisions < 3 的行带 smallSample=true（样本量小，百分比不作证据）。decisions 面板＝本报告窗口——两侧不同源不可相加（与 reputation vs handshakes 同一口径纪律）。',
  'trajectory.llmFailures: llm-failure 账本记录 + 带 errorMessage 的 collaboration-response / nl-interaction（评估/解析降级不低估）。',
  'reputation: (agent × capability) 计量累计账（runtime tracker / DB 持久化行），跨仿真全历史口径——与 handshakes/decisions 的本报告 trajectory 窗口不同源，两者并排时不可直接相加或互推（u1-F6：同一时刻 reputation.successes 可以大于 handshakes.succeeded，前者含此前所有仿真与效果回检，后者只数本窗口内有一次 accept 的握手组）。T71（R8 u1-F3）：报告面的 attempts/successes/partial/failures 是整数事件桶（加拢恒等式 ok+partial+failed=attempts）；分数公式仍用权重和（success=1、partial=0.5、failure=0）——计数是事件，分数是权重，两者不可混读。',
  'handshakes.failures（R2 T5，B1-4）: 每个未成功发起（initiate_ac 记录）归入且只归入一类，byCause 合计恒等于 failed（= initiated − succeeded）。no-partner = 发起时可发现伙伴服务为空（context.partnerServicesTotal=0）；all-rejected = 该握手组内有 reject 应答且无 accept；timeout = 组内 cancelled 记录带 decisionSource=\'timeout\'（协调器超时取消的落账信号）；abandoned-before-response = 有握手组但无任何 accept/reject 结论即取消/消亡——含只有 counter/defer 的僵死谈判与无超时标记的 rule 取消（取消落账 = 有结论的消亡，不做窗口判定）；组内完全无结论记录时还要求采样时握手窗（基础 120s，T123 高倍速下限只会延长）已闭合，窗未闭合的归 pendingAtSampling；aborted = 握手随 runtime 重建/停止/休眠被显式取消（BUG-07 起 cancelled 记录带 decisionSource=\'aborted\'，reason 注明 runtime-rebuild / runtime-stopped）——世界会话 T-037 重建的握手消亡不再隐式；pendingAtSampling = 采样时（报告窗口内最大记录时间戳）无任何结论记录且发起距今未超过基础握手窗——未决而非消亡，下轮采样重判；superseded = 同事件已被别的握手 accept 接住后的发起去重（机制性失败，与 cancelledByCoordinator 同源）。归因只用已落账 trajectory 记录，不含协调器日志；timeout 仅在取消记录显式带超时标记时计数（否则诚实落入 abandoned-before-response）。T134（R20-F u1-F1）abandoned 主导归因从句：abandoned 主导（为失败主因时）= 伙伴应答落地慢于发起方窗口收口——采样/收口时握手仍未结论（非伙伴无意愿，collaboration-response 落账可证伙伴确有响应）：高倍速（名义倍率 ≥ EAF_AC_RESPONSE_FLOOR_MIN_RATE，默认 ×60）下应答侧每事件握手评估与全 runtime 的 LLM 调用共用一条并发受限请求队列（LLM_MAX_CONCURRENT，默认 3），事件洪峰下排队积压是已知负载形态（评估墙钟预算成批超时后走能力兜底，应答落地滞后）；运维缓释可用 EAF_AC_HANDSHAKE_FAST_LANE=1（默认关；开启只改握手评估请求的队列准入，评估语义与基线不变）。',
] as const;
/** reputation 聚合输入（runtime tracker 与 DB 行都归一到这个形状）。 */
export interface EvalReputationRecord {
  agentId: string;
  capability: string;
  attempts: number;
  successes: number;
  failures: number;
  /**
   * T71 (R8, u1-F3): integer event buckets when the source carries them
   * (tracker v2 records / v64+ DB rows). Absent on legacy rows — the
   * aggregation integerizes from the weight sums.
   */
  successEvents?: number;
  partialEvents?: number;
  failureEvents?: number;
}

/**
 * T71 (R8, u1-F3): ONE normalization from a reputation row to integer event
 * buckets — counts are events, never weights. Rows carrying buckets use them
 * (the ok+partial+failed=attempts invariant is enforced by folding any drift
 * into `failed`); legacy rows are integerized from the weight sums (exact
 * for integer sums, approximated for half-integer partials — the eval
 * methodology declares this; fractional counts are never displayed).
 */
function reputationEventBuckets(r: EvalReputationRecord): {
  attempts: number;
  ok: number;
  partial: number;
  failed: number;
} {
  const attempts = Math.max(0, Math.round(r.attempts));
  if (
    typeof r.successEvents === 'number' && Number.isFinite(r.successEvents) &&
    typeof r.partialEvents === 'number' && Number.isFinite(r.partialEvents) &&
    typeof r.failureEvents === 'number' && Number.isFinite(r.failureEvents)
  ) {
    const ok = Math.max(0, Math.round(r.successEvents));
    const partial = Math.max(0, Math.round(r.partialEvents));
    const failedRaw = Math.max(0, Math.round(r.failureEvents));
    // Enforce the stated invariant: any column drift (MAX-merged legacy
    // columns) folds into `failed`, never below zero.
    const drift = attempts - (ok + partial + failedRaw);
    return { attempts, ok, partial, failed: Math.max(0, failedRaw + drift) };
  }
  const derived = integerizeReputationEvents({ attempts: r.attempts, successes: r.successes, failures: r.failures });
  return { attempts, ok: derived.successEvents, partial: derived.partialEvents, failed: derived.failureEvents };
}

export interface EvalReportMetrics {
  /** 产生过评估决策的 distinct 事件数。 */
  events: number;
  decisions: {
    total: number;
    correct: number;
    /**
     * Fix-44i: ground-truth-less decisions (correctDecision undefined or
     * 'unknown') — excluded from the accuracy denominator. accuracy is null
     * when every decision is unlabeled, instead of a misleading 0.
     */
    unlabeled: number;
    accuracy: number | null;
    /** 按 decisionSource（precheck|rule|llm|triage）的决策数分布。 */
    bySource: Record<string, number>;
    /**
     * R101 (chen-14): per-agent breakdown from the SAME records — the
     * eval-report route reconciles metaAgents' decisionCount/successRate
     * against this block so the two panels can never tell two stories
     * about one batch of decisions again.
     */
    perAgent: Array<{
      agentId: string;
      total: number;
      correct: number;
      unlabeled: number;
      accuracy: number | null;
    }>;
  };
  /**
   * R101 (chen-14): the RESPONDER side of collaborations — accept/reject
   * evaluations are decisions too, and were invisible everywhere. Counted
   * in their own block (they stay out of `decisions` — initiator-side
   * records — so the R100/44i initiator 口径 is unchanged); labeled
   * accuracy follows the same 44i rule (unknown verdicts are unlabeled).
   */
  responders: {
    total: number;
    accepts: number;
    rejects: number;
    correct: number;
    unlabeled: number;
    accuracy: number | null;
    bySource: Record<string, number>;
  };
  handshakes: {
    initiated: number;
    succeeded: number;
    /**
     * FEAT-04 (pm-dev-backlog): accepted handshakes the ac-agreement bridge
     * could NOT meter — every judgeable accept in the group (context carries
     * both requestedCapabilities and a non-empty myServices face) has ZERO
     * capability intersection with the responder's own services, which is
     * exactly the bridge's P5 no-matching-offer skip shape. Subset of
     * `succeeded`; the initiator's notification says 'accepted-unmetered'
     * for the same shape. Trajectory-side口径: the bridge's real matcher
     * also reads the offers' interface action surface (the trajectory only
     * carries semanticType), so a zero-intersection group here can rarely
     * still have metered via an action-name match — documented in
     * methodology; unjudgeable accepts (legacy/no-context records) keep the
     * group out of this bucket honestly.
     */
    succeededUnmetered: number;
    failed: number;
    /**
     * R100 (chen-10): 组内出现 cancelled 且无 accept 的握手数（全员拒绝后
     * 发起方取消 / 协调器去重取消都在内）——取消如实单列可见。注意与
     * failed 的关系是 R5-F05 的既定口径：无赢家接住的取消仍计协商失败
     * （failed 语义是"协商失败"不是"执行失败"），本字段让取消本身可账。
     */
    cancelled: number;
    successRate: number | null;
    /**
     * R5-F05: 发起去重取消数——多个 Agent 管理同一 zone、对同一事件各自
     * initiate_ac 时，InitiatorCoordinator 只留一个赢家，其余握手以
     * cancelled 收场。机制性取消不是协商失败：一个失败握手当其起源事件
     * 已被另一个有 accept 的握手接住时计入此列。
     */
    cancelledByCoordinator: number;
    /**
     * R5-F05: 真实协商成功率 succeeded / (initiated −
     * cancelledByCoordinator)（发起去重取消不计入分母）；无有效发起时
     * 诚实 null。legacy successRate（分母含机制性取消）保持不变。
     */
    negotiationSuccessRate: number | null;
    /**
     * R2 T5 (u1-F4 / B1-4): 失败归因 MVP——每个未成功发起归入且只归入一类，
     * byCause 合计恒等于 failed（succeeded + failed = initiated 的等式之下的
     * 分解账）。归因只用已落账 trajectory 记录（initiate_ac 的伙伴面、
     * collaboration-response 的 reject/取消与 decisionSource='timeout' 标记），
     * 不改协调器运行时行为。口径见 methodology 的 handshakes.failures 行。
     */
    failures: {
      total: number;
      byCause: {
        'no-partner': number;
        'abandoned-before-response': number;
        'all-rejected': number;
        timeout: number;
        superseded: number;
        /**
         * BUG-07: handshake explicitly cancelled because its runtime went
         * away (world-session rebuild / hibernate / stop — the cancelled
         * record carries decisionSource 'aborted', the reason names
         * 'runtime-rebuild' / 'runtime-stopped'). An explained death, never
         * conflated with a silent one.
         */
        aborted: number;
        /**
         * BUG-07: no conclusion record AND the base handshake window
         * (EVAL_HANDSHAKE_WINDOW_MS) had not closed at sampling time — the
         * handshake was still undecided when the report was pulled, not
         * dead. Re-judged at the next sampling.
         */
        pendingAtSampling: number;
      };
    };
  };
  /**
   * P5 闭环漏斗：协作命中语义服务（origin=aggregate/published）的占比。
   * 口径：按握手组（collaborationId，缺失退回 eventId）归组；组内任一
   * accept 应答的服务面（context.myServices，P5 起带 origin）里存在
   * origin ∈ {aggregate, published} 且 semanticType 与请求能力匹配
   * （共享 capabilityMatches；应答未带 requestedCapabilities 时只看
   * origin）的服务，记为一次语义服务协作。rate 分母为已发起协作数；
   * 无协作时诚实 null。
   */
  services: {
    semanticCollaborations: number;
    rate: number | null;
  };
  effectChecks: {
    attempts: number;
    successes: number;
    /**
     * T71 (R8, u1-F3): partial 事件单列桶——权重 0.5 的 partial 协作不再把
     * 0.5 泄进 successes/failures（计数是事件，分数才是权重）；不计入
     * passRate 分子。
     */
    partial: number;
    failures: number;
    passRate: number | null;
    /**
     * R100 (chen-10): 其中的 device-execution 真实设备调用回执切片
     * （attempts/successes/failures 已并入上面的总计——效果回检与真实
     * 设备调用同属"执行面账"）。
     */
    deviceExecutions: { attempts: number; successes: number; failures: number };
    /**
     * UX-02 (pm-dev-backlog, campus-events F6): the failures drill-down —
     * the totals above used to be a bare count with no way to locate WHICH
     * checks failed. byKind/byCause are full-count buckets; records lists
     * the trajectory-pointable failure traces (device-execution receipts
     * with their error; assessment records whose goalAchieved settled
     * false — the temperature-recheck lane's trajectory-side trace),
     * defensively capped (the buckets stay exact). The reputation-lane
     * counts are aggregate event buckets, so byKind need not sum to
     * `failures` (different-source口径, methodology says so).
     */
    failureBreakdown: {
      byKind: { 'device-execution': number; 'goal-unachieved': number };
      byCause: Record<string, number>;
      records: Array<
        | {
            kind: 'device-execution';
            eventId: string;
            agentId: string;
            deviceId: string;
            command: string;
            error?: string;
            recordedAt: string;
          }
        | {
            kind: 'goal-unachieved';
            eventId: string;
            agentId: string;
            decision: string;
            recordedAt: string;
          }
      >;
    };
  };
  /**
   * R100 (chen-10): trajectory 全量记录按 kind 的覆盖账——每类记录多少条
   * 一目了然（decisions 口径只含 kind 缺省的决策记录；collaboration-
   * response / nl-interaction / device-execution 不进 decisions，但在此
   * 全部可见，不再是无影黑洞）。kind 缺省记为 'decision'。
   */
  recordKinds: Record<string, number>;
  /**
   * R100 (chen-10): 口径说明——每类指标统计什么、不统计什么，报告自带
   * 可复核依据（eval-gates 引用的指标须能据此从 trajectory 重算）。
   */
  methodology: readonly string[];
  /**
   * F3-2（plan-r84）轨迹级小节：决策→执行→世界反馈链路健康度。数据全部来自
   * trajectory 已有字段（kind / decision / decisionSource / decisionSubSource /
   * goalAchieved），不引入新埋点。
   */
  trajectory: {
    /** T-105 写入的 LLM 调用失败记录数（kind 'llm-failure'）。 */
    llmFailures: number;
    /** LLM 决策的结构化输出合规率（T-024-part3 的 decisionSubSource 口径）。 */
    structuredOutput: {
      llm: number;
      json: number;
      fsm: number;
      jsonRate: number | null;
    };
    /**
     * 链路完整率：actionable 决策（decision ∈ handle_independently /
     * initiate_ac —— 决策落到了执行路径）中带世界反馈标注
     * （goalAchieved 已结算，Fix-12 效果回检/仿真结算写入）的比例。
     * actionable 为 0 时 completeness 为 null（诚实空态）。
     */
    chain: {
      actionable: number;
      withFeedback: number;
      completeness: number | null;
      /**
       * R103 (chen-21): device executions OUTSIDE the decision chain
       * (eventId 'unattributed' — user-driven NL commands, flow runs).
       * Counted so completeness can't be silently depressed by them; the
       * methodology names what stays unattributed by design.
       */
      unattributedExecutions: number;
    };
  };
  reputation: {
    totals: { attempts: number; successes: number; partial: number; failures: number };
    agents: Array<{ agentId: string; attempts: number; successes: number; partial: number; failures: number }>;
  };
}

/**
 * P5 漏斗判定：一条 accept 应答是否命中语义服务——应答方服务面里存在
 * origin ∈ {aggregate, published} 的服务，且其 semanticType 与请求能力
 * 匹配（共享 capabilityMatches）；应答未带 requestedCapabilities 时只看
 * origin（老记录无该字段，漏斗按弱口径计入）。
 */
function isSemanticServiceHit(record: TrajectoryRecord): boolean {
  const services = record.context?.myServices ?? [];
  const requested = record.context?.requestedCapabilities ?? [];
  return services.some(service => {
    if (service.origin !== 'aggregate' && service.origin !== 'published') return false;
    if (requested.length === 0) return true;
    return requested.some(capability => capabilityMatches(service.semanticType, capability));
  });
}

/**
 * 纯聚合：trajectory 记录 + reputation 记录 → 评估指标。
 * 握手口径：collaboration-response 记录按 collaborationId（缺失退回
 * eventId）归组，至少一方 accept 记成功。
 */
export function aggregateEvalRecords(
  records: TrajectoryRecord[],
  reputationRecords: EvalReputationRecord[],
): EvalReportMetrics {
  // nl-interaction 记录（NL 意图道可观测账本）与握手记录一样不进决策口径：
  // 用户驱动道、无 ground truth、无 decisionSubSource，计入会稀释 accuracy
  // 与 structuredOutput 口径。R6-E-F10: device-execution 回执同理——它是
  // 执行半链的账本（无 ground truth、decision 是 executed/failed 而非决策词），
  // 计入会稀释决策口径。
  const assessments = records.filter(r =>
    r.kind !== 'collaboration-response' && r.kind !== 'nl-interaction' && r.kind !== 'device-execution');
  const responses = records.filter(r => r.kind === 'collaboration-response');

  const bySource: Record<string, number> = {};
  let correct = 0;
  // Fix-44i: decisions whose ground truth is 'unknown' are UNLABELED — they
  // carry no verdict and must not enter the accuracy denominator. Pre-fix a
  // fresh rule-only run exported every decision as correct:false with
  // groundTruth 'unknown', reporting a misleading 0% accuracy.
  let unlabeled = 0;
  // R101: per-agent breakdown over the SAME records (metaAgents 对账源).
  const perAgentMap = new Map<string, { total: number; correct: number; unlabeled: number }>();
  for (const r of assessments) {
    bySource[r.decisionSource] = (bySource[r.decisionSource] ?? 0) + 1;
    const bucket = perAgentMap.get(r.agentId) ?? { total: 0, correct: 0, unlabeled: 0 };
    bucket.total++;
    // Only an EXPLICIT 'unknown' verdict is unlabeled; records without a
    // groundTruth block keep their `correct` flag (legacy/hand-written).
    if (r.groundTruth?.correctDecision === 'unknown') {
      unlabeled++;
      bucket.unlabeled++;
    } else if (r.correct) {
      correct++;
      bucket.correct++;
    }
    perAgentMap.set(r.agentId, bucket);
  }
  const labeled = assessments.length - unlabeled;

  // R101 (chen-14): the responder side — collaboration-response accept/reject
  // evaluations get their own quality block (accepts/rejects + bySource +
  // labeled accuracy, 44i rule). They still stay out of `decisions`.
  // R102 (chen-17): responder GT — the records used to be ALL unlabeled
  // (accept 质量无从评估). The verdict is the deliverability match: the
  // responder's OWN services vs the requested capabilities (shared
  // capabilityMatches) — accept fully backed = correct, accept
  // overcommitted = incorrect (超承), reject with nothing deliverable =
  // correct, reject of a backed ask = missed (incorrect). An explicit
  // groundTruth verdict on the record wins; context-less records stay
  // unlabeled (never a silent null — the口径 rides the methodology).
  const responders = {
    total: 0,
    accepts: 0,
    rejects: 0,
    correct: 0,
    unlabeled: 0,
    bySource: {} as Record<string, number>,
  };
  for (const r of responses) {
    responders.total++;
    if (r.decision === 'accept') responders.accepts++;
    if (r.decision === 'reject') responders.rejects++;
    responders.bySource[r.decisionSource] = (responders.bySource[r.decisionSource] ?? 0) + 1;
    const explicitKnown =
      r.groundTruth !== undefined && r.groundTruth.correctDecision !== 'unknown';
    if (explicitKnown) {
      if (r.correct) responders.correct++;
      continue;
    }
    const verdict = responderDeliverabilityVerdict(r);
    if (verdict === null) {
      responders.unlabeled++;
    } else if (verdict) {
      responders.correct++;
    }
  }
  const responderLabeled = responders.total - responders.unlabeled;

  const handshakes = new Map<
    string,
    {
      accepted: boolean;
      cancelled: boolean;
      semantic: boolean;
      eventIds: Set<string>;
      // T5 (R2 u1-F4): failure-attribution inputs — how many partners answered
      // reject, and whether the cancel carried the coordinator's timeout marker
      // (collaboration.ts records ac-cancelled with decisionSource 'timeout').
      rejects: number;
      timeoutCancel: boolean;
      // BUG-07: the cancel carried the runtime-teardown marker (decisionSource
      // 'aborted') — an explained death (rebuild/hibernate/stop).
      abortedCancel: boolean;
      // BUG-07: earliest response-record time of the group — the handshake
      // start proxy when no initiate_ac record pins it (window judgment).
      firstSeenMs: number;
      // FEAT-04: accept-side backing judgment for succeededUnmetered —
      // judgeable = the record carries BOTH requestedCapabilities and a
      // non-empty myServices face; backed = ≥1 requested capability matches
      // a responder service (semanticType口径, capabilityMatches).
      judgeableAccepts: number;
      backedAccepts: number;
    }
  >();
  for (const r of responses) {
    const key = r.collaborationId ?? r.eventId;
    const group = handshakes.get(key) ?? {
      accepted: false,
      cancelled: false,
      semantic: false,
      eventIds: new Set<string>(),
      rejects: 0,
      timeoutCancel: false,
      abortedCancel: false,
      firstSeenMs: Number.POSITIVE_INFINITY,
      judgeableAccepts: 0,
      backedAccepts: 0,
    };
    group.eventIds.add(r.eventId);
    const recordedMs = Date.parse(r.recordedAt);
    if (Number.isFinite(recordedMs) && recordedMs < group.firstSeenMs) {
      group.firstSeenMs = recordedMs;
    }
    if (r.decision === 'accept') {
      group.accepted = true;
      if (isSemanticServiceHit(r)) group.semantic = true;
      const requested = r.context?.requestedCapabilities ?? [];
      const services = r.context?.myServices ?? [];
      if (requested.length > 0 && services.length > 0) {
        group.judgeableAccepts++;
        if (requested.some(capability =>
          services.some(service => capabilityMatches(service.semanticType, capability)))) {
          group.backedAccepts++;
        }
      }
    }
    if (r.decision === 'reject') group.rejects++;
    if (r.decision === 'cancelled') {
      group.cancelled = true;
      if (r.decisionSource === 'timeout') group.timeoutCancel = true;
      if (r.decisionSource === 'aborted') group.abortedCancel = true;
    }
    handshakes.set(key, group);
  }
  const initiatedGroups = handshakes.size;
  const groups = [...handshakes.values()];
  const succeeded = groups.filter(g => g.accepted).length;
  // FEAT-04: an accepted group whose JUDGEABLE accepts are all zero-backing
  // is the bridge's unmetered-skip shape (see the metrics doc). Groups with
  // only unjudgeable accepts (legacy records without the context faces) stay
  // out — never an invented count.
  const succeededUnmetered = groups.filter(
    g => g.accepted && g.judgeableAccepts > 0 && g.backedAccepts === 0,
  ).length;
  const semanticCollaborations = groups.filter(g => g.semantic).length;
  // R100 (chen-10): initiated counts the trajectory's initiate_ac DECISION
  // records — one per handshake initiation. Response-grouping keys on
  // collaborationId/eventId and MERGES same-event initiations (the R5-F05
  // coordinator dedup keeps one winner per event), so group count
  // undercounts initiations (2 initiations on ev-night-smoke reported as
  // 1). Legacy data without initiate records falls back to the group count
  // (Math.max keeps succeeded ≤ initiated in mixed data).
  const initiatedDecisions = assessments.filter(r => r.decision === 'initiate_ac').length;
  const initiated = Math.max(initiatedDecisions, initiatedGroups);
  // R100: cancelled handshakes (cancelled record, no accept) count visibly —
  // an all-partners-rejected cancel is如实 listed here. R5-F05's failed
  // semantics is unchanged: such a cancel IS a negotiation failure (not an
  // execution failure) and stays in `failed`; the new counter makes the
  // cancel itself auditable instead of hiding inside one number.
  const cancelled = groups.filter(g => !g.accepted && g.cancelled).length;
  // R5-F05: 发起方去重（InitiatorCoordinator）的机制性取消不是协商失败——
  // 同一事件已被另一个有 accept 的握手接住时，这个 cancelled 握手计入
  // cancelledByCoordinator，从真实协商成功率的分母中剔除。
  const acceptedEventIds = new Set<string>();
  for (const group of groups) {
    if (group.accepted) {
      for (const eventId of group.eventIds) acceptedEventIds.add(eventId);
    }
  }
  const cancelledByCoordinatorGroups = groups.filter(
    g => !g.accepted && g.cancelled && [...g.eventIds].some(eventId => acceptedEventIds.has(eventId)),
  ).length;
  // R100 (chen-10): the coordinator-deduped INITIATIONS join the mechanism
  // cancel count — same-event initiations beyond the one initiation the
  // InitiatorCoordinator kept (each event with ≥1 response group keeps one).
  // Without this the deduped initiation was invisible in every counter
  // (chen-10: 2 initiations on ev-night-smoke, cancelledByCoordinator 0).
  const initiatesByEvent = new Map<string, number>();
  for (const r of assessments) {
    if (r.decision !== 'initiate_ac') continue;
    initiatesByEvent.set(r.eventId, (initiatesByEvent.get(r.eventId) ?? 0) + 1);
  }
  const groupsByEvent = new Map<string, number>();
  for (const group of groups) {
    for (const eventId of group.eventIds) {
      groupsByEvent.set(eventId, (groupsByEvent.get(eventId) ?? 0) + 1);
    }
  }
  let dedupInitiations = 0;
  for (const [eventId, count] of initiatesByEvent) {
    const groupCount = groupsByEvent.get(eventId) ?? 0;
    if (groupCount > 0 && count > groupCount) dedupInitiations += count - groupCount;
  }
  const cancelledByCoordinator = cancelledByCoordinatorGroups + dedupInitiations;
  const negotiationAttempts = initiated - cancelledByCoordinator;

  // T5 (R2 u1-F4 / B1-4): failure attribution — every failed initiation lands
  // in EXACTLY one cause bucket, so byCause sums to `failed` (the identity the
  // methodology promises). Records only: the initiate_ac record's partner face
  // (no-partner), the group's reject/timeout-cancel records, and the R100
  // dedup count (superseded). Timeout is only counted when the coordinator's
  // cancel record explicitly carries decisionSource 'timeout' — anything else
  // honestly lands in abandoned-before-response.
  const failuresByCause: EvalReportMetrics['handshakes']['failures']['byCause'] = {
    'no-partner': 0,
    'abandoned-before-response': 0,
    'all-rejected': 0,
    timeout: 0,
    superseded: 0,
    aborted: 0,
    pendingAtSampling: 0,
  };
  const initiationRecords = assessments.filter(r => r.decision === 'initiate_ac');
  const shortlistEmpty = (r: TrajectoryRecord): boolean =>
    (r.context?.partnerServicesTotal ?? 0) === 0 && (r.context?.partnerServices?.length ?? 0) === 0;
  const groupKeyOf = (r: TrajectoryRecord): string => r.collaborationId ?? r.eventId;
  // BUG-07: the window judgment needs (a) the sampling time — the newest
  // record in this report window (a live world session's tail ≈ now) — and
  // (b) each handshake's start — its initiate_ac record when present, else
  // the group's earliest response record.
  let samplingMs = 0;
  for (const r of records) {
    const ms = Date.parse(r.recordedAt);
    if (Number.isFinite(ms) && ms > samplingMs) samplingMs = ms;
  }
  const initiationMsByKey = new Map<string, number>();
  for (const r of initiationRecords) {
    const ms = Date.parse(r.recordedAt);
    if (!Number.isFinite(ms)) continue;
    const key = groupKeyOf(r);
    initiationMsByKey.set(key, Math.min(initiationMsByKey.get(key) ?? ms, ms));
  }
  const windowOpenAt = (startMs: number | undefined): boolean =>
    startMs !== undefined && samplingMs > 0 && samplingMs - startMs < EVAL_HANDSHAKE_WINDOW_MS;
  // Per-group cause: the initiate record(s) feeding this group name the root
  // cause when the shortlist was empty; otherwise the group's own answers do.
  const causeOfGroup = (
    key: string,
    group: { rejects: number; cancelled: boolean; timeoutCancel: boolean; abortedCancel: boolean; firstSeenMs: number },
  ): keyof EvalReportMetrics['handshakes']['failures']['byCause'] => {
    if (initiationRecords.some(record => groupKeyOf(record) === key && shortlistEmpty(record))) {
      return 'no-partner';
    }
    if (group.rejects > 0) return 'all-rejected';
    if (group.timeoutCancel) return 'timeout';
    // BUG-07: a runtime-teardown cancel is an explained death — never abandoned.
    if (group.abortedCancel) return 'aborted';
    // A plain (rule) cancel DID land — the handshake concluded; without a
    // timeout marker it honestly stays abandoned (cancel ≠ silent death).
    if (group.cancelled) return 'abandoned-before-response';
    // BUG-07: no conclusion record at all and the window had not closed at
    // sampling — honestly pending (a world session never stops, so early
    // sampling used to report every in-flight handshake as abandoned).
    return windowOpenAt(
      initiationMsByKey.get(key) ?? (Number.isFinite(group.firstSeenMs) ? group.firstSeenMs : undefined),
    )
      ? 'pendingAtSampling'
      : 'abandoned-before-response';
  };
  for (const [key, group] of handshakes) {
    if (group.accepted) continue;
    failuresByCause[causeOfGroup(key, group)]++;
  }
  // Initiations beyond one group per event (the R100 dedup shape) never formed
  // a group of their own: with a winner on the event they are 'superseded'
  // (mechanism cancel); otherwise they died with the event's failed
  // negotiation — attributed to that group's cause. Events with NO group at
  // all attribute each initiation record individually (no-partner when the
  // shortlist was empty; BUG-07: window-open no-conclusion initiations count
  // as pendingAtSampling, else abandoned-before-response).
  const eventGroupKeys = new Map<string, string[]>();
  for (const [key, group] of handshakes) {
    for (const eventId of group.eventIds) {
      eventGroupKeys.set(eventId, [...(eventGroupKeys.get(eventId) ?? []), key]);
    }
  }
  for (const [eventId, count] of initiatesByEvent) {
    const keys = eventGroupKeys.get(eventId) ?? [];
    const extras = Math.max(0, count - keys.length);
    if (extras === 0) continue;
    if (acceptedEventIds.has(eventId)) {
      failuresByCause.superseded += extras;
      continue;
    }
    const failedKey = keys.find(key => !handshakes.get(key)!.accepted);
    if (failedKey !== undefined) {
      const cause = causeOfGroup(failedKey, handshakes.get(failedKey)!);
      failuresByCause[cause] += extras;
    } else {
      for (const record of initiationRecords) {
        if (record.eventId !== eventId) continue;
        if (shortlistEmpty(record)) {
          failuresByCause['no-partner']++;
          continue;
        }
        const ms = Date.parse(record.recordedAt);
        failuresByCause[windowOpenAt(Number.isFinite(ms) ? ms : undefined) ? 'pendingAtSampling' : 'abandoned-before-response']++;
      }
    }
  }
  const failuresTotal = Object.values(failuresByCause).reduce((sum, n) => sum + n, 0);

  // Reputation：per-agent 汇总 + 温度类（Fix-12 效果回检写入的
  // cool/heat/temperature capability）切片，passRate = successes/attempts。
  // T71 (R8, u1-F3): the COUNT faces are integer EVENT buckets (partial
  // events own their bucket, never a 0.5 leaking into ok/failed); the score
  // formula keeps consuming the weight sums — counts and scores never mix.
  const agentTotals = new Map<string, { attempts: number; successes: number; partial: number; failures: number }>();
  const effect = { attempts: 0, successes: 0, partial: 0, failures: 0 };
  for (const r of reputationRecords) {
    const ev = reputationEventBuckets(r);
    const total = agentTotals.get(r.agentId) ?? { attempts: 0, successes: 0, partial: 0, failures: 0 };
    total.attempts += ev.attempts;
    total.successes += ev.ok;
    total.partial += ev.partial;
    total.failures += ev.failed;
    agentTotals.set(r.agentId, total);
    if (/(cool|heat|temperature)/i.test(r.capability)) {
      effect.attempts += ev.attempts;
      effect.successes += ev.ok;
      effect.partial += ev.partial;
      effect.failures += ev.failed;
    }
  }
  const totals = { attempts: 0, successes: 0, partial: 0, failures: 0 };
  for (const total of agentTotals.values()) {
    totals.attempts += total.attempts;
    totals.successes += total.successes;
    totals.partial += total.partial;
    totals.failures += total.failures;
  }

  // R100 (chen-10): device-execution 回执是真实设备调用账（含失败）——
  // 并入 effectChecks 总计并单列切片。reputation 温度类回检口径不变。
  // Device receipts are binary (no partial), so they only feed ok/failed.
  const deviceExecutions = { attempts: 0, successes: 0, failures: 0 };
  // UX-02: the failure drill-down — full-count buckets plus the capped,
  // trajectory-pointable failure traces (see the metrics doc).
  const failureBreakdown: EvalReportMetrics['effectChecks']['failureBreakdown'] = {
    byKind: { 'device-execution': 0, 'goal-unachieved': 0 },
    byCause: {},
    records: [],
  };
  const FAILURE_BREAKDOWN_MAX_RECORDS = 100;
  const bumpCause = (cause: string): void => {
    failureBreakdown.byCause[cause] = (failureBreakdown.byCause[cause] ?? 0) + 1;
  };
  for (const r of records) {
    if (r.kind !== 'device-execution') continue;
    deviceExecutions.attempts++;
    effect.attempts++;
    const ok = r.deviceExecution?.success === true || r.decision === 'executed';
    if (ok) {
      deviceExecutions.successes++;
      effect.successes++;
    } else {
      deviceExecutions.failures++;
      effect.failures++;
      failureBreakdown.byKind['device-execution']++;
      const error = r.deviceExecution?.error ?? r.errorMessage;
      bumpCause(error !== undefined && error.length > 0 ? error : 'device-execution failed (no error recorded)');
      if (failureBreakdown.records.length < FAILURE_BREAKDOWN_MAX_RECORDS) {
        failureBreakdown.records.push({
          kind: 'device-execution',
          eventId: r.eventId,
          agentId: r.agentId,
          deviceId: r.deviceExecution?.deviceId ?? '(unknown device)',
          command: r.deviceExecution?.command ?? '(unknown command)',
          ...(error !== undefined && error.length > 0 ? { error } : {}),
          recordedAt: r.recordedAt,
        });
      }
    }
  }
  // UX-02: the temperature-recheck lane's trajectory-side trace — the
  // decision records whose world-feedback verdict settled FALSE. The
  // reputation event buckets above are the aggregate count face; these
  // records are how a reader LOCATES the failed rechecks (the two faces are
  // different sources — the counts need not reconcile row-for-row).
  for (const r of assessments) {
    if (r.goalAchieved !== false) continue;
    failureBreakdown.byKind['goal-unachieved']++;
    bumpCause('goal not achieved (world-feedback recheck settled false)');
    if (failureBreakdown.records.length < FAILURE_BREAKDOWN_MAX_RECORDS) {
      failureBreakdown.records.push({
        kind: 'goal-unachieved',
        eventId: r.eventId,
        agentId: r.agentId,
        decision: r.decision,
        recordedAt: r.recordedAt,
      });
    }
  }

  // R100: 全量记录的覆盖账（kind 缺省 = 决策记录）。
  const recordKinds: Record<string, number> = {};
  for (const r of records) {
    const kind = r.kind ?? 'decision';
    recordKinds[kind] = (recordKinds[kind] ?? 0) + 1;
  }

  // F3-2 轨迹级小节（已有字段聚合，无新埋点）：
  // - llm-failure 记录是写通过的失败账本（T-105），单独计数；
  // - structuredOutput 只统计 decisionSource 'llm' 的决策记录；
  // - chain 的 actionable 口径 = 落到执行路径的决策（handle_independently /
  //   initiate_ac），分母不含 wait/defer/escalate 这类「有意不执行」。
  let llmFailures = 0;
  const structured = { llm: 0, json: 0, fsm: 0 };
  const chain = { actionable: 0, withFeedback: 0 };
  // R101 (chen-14): decision-triggered device-execution receipts by
  // (eventId, agentId) — the live path rarely settles goalAchieved (Fix-12
  // covers the temperature effect lane only), so chain completeness read 0
  // even with 9 real executions on record. A receipt never INVENTS a goal
  // achievement (target achievement stays the goalAchieved/metaAgents
  // lens); the join only closes the "决策→执行" half of the chain.
  // Manual/NL receipts carry no eventId and can never credit a decision.
  // R103 (chen-21): the unattributed remainder is COUNTED and named — the
  // report says how many executions sit outside the decision chain by
  // design (user-driven NL commands / flow runs) instead of silently
  // depressing completeness.
  let unattributedExecutions = 0;
  const executionKeys = new Set<string>();
  for (const r of records) {
    if (r.kind !== 'device-execution') continue;
    if (typeof r.eventId === 'string' && r.eventId.length > 0 && r.eventId !== 'unattributed') {
      executionKeys.add(`${r.eventId}${r.agentId}`);
    } else {
      unattributedExecutions++;
    }
  }
  for (const r of records) {
    if (r.kind === 'llm-failure') {
      llmFailures++;
      continue;
    }
    // R5-F14: a collaboration response carrying an evaluation error means
    // the LLM evaluation was attempted but unusable (unparseable output,
    // timeout abort) — that is a degraded LLM call even though the
    // transport-level call succeeded, so it counts here too.
    if (r.kind === 'collaboration-response') {
      if (typeof r.errorMessage === 'string' && r.errorMessage.length > 0) {
        llmFailures++;
      }
      continue;
    }
    // NL 交互记录：可观测账本（prompt/rawResponse 已随记录落盘），不进
    // structuredOutput / chain 口径（无 decisionSubSource、无效果标注）。
    // R6-C-F04: an NL intent record tagged with errorMessage means the LLM
    // parse was attempted but degraded to rules (rules-llm-down with a
    // transport-successful but unusable answer) — same "degraded LLM call"
    // semantics as R5-F14, counted here so llmFailures covers the NL lane.
    if (r.kind === 'nl-interaction') {
      if (typeof r.errorMessage === 'string' && r.errorMessage.length > 0) {
        llmFailures++;
      }
      continue;
    }
    // R6-E-F10: 设备执行回执是执行半链账本（decision 是 executed/failed），
    // 不进 structuredOutput / chain 的决策口径——goalAchieved 的结算语义是
    // "世界反馈验证目标达成"，执行成功 ≠ 目标达成，不能冒充 withFeedback。
    if (r.kind === 'device-execution') continue;
    if (r.decisionSource === 'llm') {
      structured.llm++;
      if (r.decisionSubSource === 'llm-json') structured.json++;
      else if (r.decisionSubSource === 'llm-fsm') structured.fsm++;
    }
    if (r.decision === 'handle_independently' || r.decision === 'initiate_ac') {
      chain.actionable++;
      if (
        r.goalAchieved !== undefined ||
        executionKeys.has(`${r.eventId}${r.agentId}`)
      ) {
        chain.withFeedback++;
      }
    }
  }

  return {
    events: new Set(assessments.map(r => r.eventId)).size,
    decisions: {
      total: assessments.length,
      correct,
      unlabeled,
      accuracy: labeled > 0 ? correct / labeled : null,
      bySource,
      perAgent: [...perAgentMap.entries()]
        .map(([agentId, bucket]) => {
          const agentLabeled = bucket.total - bucket.unlabeled;
          return {
            agentId,
            ...bucket,
            accuracy: agentLabeled > 0 ? bucket.correct / agentLabeled : null,
          };
        })
        .sort((a, b) => b.total - a.total || a.agentId.localeCompare(b.agentId)),
    },
    responders: {
      ...responders,
      accuracy: responderLabeled > 0 ? responders.correct / responderLabeled : null,
    },
    handshakes: {
      initiated,
      succeeded,
      succeededUnmetered,
      failed: initiated - succeeded,
      cancelled,
      successRate: initiated > 0 ? succeeded / initiated : null,
      cancelledByCoordinator,
      negotiationSuccessRate: negotiationAttempts > 0 ? succeeded / negotiationAttempts : null,
      failures: { total: failuresTotal, byCause: failuresByCause },
    },
    services: {
      semanticCollaborations,
      rate: initiated > 0 ? semanticCollaborations / initiated : null,
    },
    effectChecks: {
      ...effect,
      passRate: effect.attempts > 0 ? effect.successes / effect.attempts : null,
      deviceExecutions,
      failureBreakdown,
    },
    recordKinds,
    methodology: EVAL_METHODOLOGY,
    trajectory: {
      llmFailures,
      structuredOutput: {
        ...structured,
        jsonRate: structured.llm > 0 ? structured.json / structured.llm : null,
      },
      chain: {
        ...chain,
        completeness: chain.actionable > 0 ? chain.withFeedback / chain.actionable : null,
        // R103: executions outside the decision chain (user/NL/flow lanes),
        // counted so completeness can't be silently depressed by them.
        unattributedExecutions,
      },
    },
    reputation: {
      totals,
      agents: [...agentTotals.entries()]
        .map(([agentId, total]) => ({ agentId, ...total }))
        .sort((a, b) => b.attempts - a.attempts || a.agentId.localeCompare(b.agentId)),
    },
  };
}

/**
 * R102 (chen-17): the responder-side deliverability verdict — calibrated
 * against chen-17's real data (a broad wishlist ask + deliver-what-you-can
 * accepts that DID deliver): accept with AT LEAST ONE requested capability
 * covered = correct (partial fulfillment is a legitimate accept), accept
 * with ZERO backing = incorrect (空承 — the R3 安防专员 shape: accepted
 * while lacking every requested capability); reject with zero deliverable
 * = correct (诚实拒绝), reject with EVERYTHING deliverable = missed
 * (incorrect); partial-backing rejects are unjudgeable. An explicit
 * groundTruth verdict on the record wins; records lacking the context to
 * judge (empty requestedCapabilities OR empty myServices — no way to know
 * the responder's surface) stay unlabeled, never a silent zero-accuracy.
 */
function responderDeliverabilityVerdict(r: TrajectoryRecord): boolean | null {
  if (r.decision !== 'accept' && r.decision !== 'reject') return null;
  const requested = r.context?.requestedCapabilities ?? [];
  const services = r.context?.myServices ?? [];
  if (requested.length === 0 || services.length === 0) return null;
  const covered = (capability: string): boolean =>
    services.some(service => capabilityMatches(service.semanticType, capability));
  const backed = requested.filter(covered).length;
  if (r.decision === 'accept') return backed > 0;
  return backed === requested.length ? false : backed === 0 ? true : null;
}

/**
 * R101 (chen-14) → T29 (R3 u4-F2/u1-F9/u3-F5, PM ruling): the metaAgents
 * face is FIXED to the ALL-HISTORY window — the DecisionQualityTracker's
 * persisted experience IS the cross-simulation truth (R6-E-F15), so a
 * registry row is never overwritten by this report's window values anymore
 * (the old reconcile mixed two windows row-by-row in one table: agents with
 * window decisions showed window numbers while others showed history).
 * The report window stays visible as a SEPARATE field (windowDecisionCount),
 * and every row declares its window:
 *
 * - registry (tracker) rows → `window: 'all-history'` (+ windowDecisionCount
 *   = this report's trajectory decision count, 0 when the agent made none);
 * - agents present in the trajectory but MISSING from the registry face →
 *   synthesized with the window aggregation and `window: 'report-window'`
 *   (a decisions-panel entry must always have a metaAgents counterpart —
 *   R102 — but the reader must see that the row is NOT full history).
 *
 * `smallSample: true` rides rows with fewer than 3 evaluated decisions
 * (u3-F5: the demo panel must not silently present 0-3 sample rates).
 * The decisions panel itself stays on the report window — the two panels
 * are different sources by design and must never be added up (same
 * discipline as reputation vs handshakes).
 */
export interface ReconciledMetaAgent {
  window: 'all-history' | 'report-window';
  /** This REPORT WINDOW's decision count (separate from the row's own counts). */
  windowDecisionCount?: number;
  /** Fewer than 3 evaluated decisions — a percentage here is not evidence. */
  smallSample?: true;
}

export function reconcileMetaAgents<
  T extends {
    agentId: string;
    agentName?: string;
    decisionCount: number;
    evaluatedDecisions: number;
    successRate: number | null;
  },
>(
  metaAgents: readonly T[],
  perAgent: EvalReportMetrics['decisions']['perAgent'],
  /** R103: resolve an agent's display name (deleted agents → undefined). */
  agentNameOf?: (agentId: string) => string | undefined,
): Array<T & ReconciledMetaAgent> {
  const byAgent = new Map(perAgent.map(row => [row.agentId, row]));
  const annotate = (row: T & ReconciledMetaAgent): T & ReconciledMetaAgent => ({
    ...row,
    ...(row.evaluatedDecisions < 3 ? { smallSample: true as const } : {}),
  });
  const reconciled = metaAgents.map(row => {
    const truth = byAgent.get(row.agentId);
    // T29: the tracker row keeps its FULL-HISTORY values untouched — the
    // window count rides its own field instead of overwriting the row.
    return annotate({
      ...row,
      window: 'all-history' as const,
      windowDecisionCount: truth?.total ?? 0,
    });
  });
  // R102: an agent PRESENT in the trajectory but MISSING from the registry
  // face (e.g. the smoke collaboration's initiator installed after the
  // session's agent map was built) must still appear — synthesized from the
  // trajectory aggregation, explicitly labeled as REPORT-WINDOW data (T29:
  // never silently mixed into the all-history rows). R103: the row names
  // the agent readably (env row name; a DELETED agent is marked, never a
  // bare UUID).
  const present = new Set(metaAgents.map(row => row.agentId));
  const synthesized = perAgent
    .filter(row => !present.has(row.agentId))
    .map(row => {
      const name = agentNameOf?.(row.agentId);
      return annotate({
        agentId: row.agentId,
        agentName: name ?? `已删除 Agent（${row.agentId.slice(0, 8)}…）`,
        calibrationScore: null,
        decisionCount: row.total,
        evaluatedDecisions: row.total - row.unlabeled,
        successRate: row.accuracy,
        topUncalibratedActions: [],
        capabilityBoundary: { strongAreas: [], weakAreas: [], mustEscalate: [] },
        trustPartners: [],
        note: 'no meta-cognition row from the runtime — synthesized from THIS REPORT WINDOW\'s trajectory aggregation (R102; T29: 本窗口口径，非全历史)',
        window: 'report-window' as const,
      } as unknown as T & ReconciledMetaAgent);
    });
  return [...reconciled, ...synthesized];
}

/** 扫盘重建的评估报告（registry 未命中时的 fallback）。 */
export interface DiskEvalReport extends EvalReportMetrics {
  simId: string;
  /** 取自第一条 trajectory 记录的 scenario 字段；无记录时为 null。 */
  scenarioId: string | null;
  environmentId?: string;
  source: 'disk';
  /** registry 独有的运行状态重启后不可恢复，恒为 null（见 notes）。 */
  state: null;
  /** sim-timeline 里见过的最大 simTimeSec；无时间线时为 null。 */
  simTimeSec: number | null;
  /** 如实列出降级点。 */
  notes: string[];
}

/**
 * Wave-3a 重启可评估：registry 没有该 simId 时，按
 * `<trajectoryBaseDir>/<simId>/` 扫盘重建评估指标。目录不存在（或 simId
 * 不是本服务默认目录布局下的仿真 id）时返回 undefined（调用方映射 404）。
 *
 * 数据来口：决策/握手来自目录下的 trajectory JSONL（排除
 * sim-timeline.jsonl）；environmentId 与 sim 时间来自 sim-timeline 记录；
 * reputation 来自 DB 该环境的持久化行——那是该环境跨仿真的累计值，不是
 * 本仿真结束时刻的快照（notes 如实标注）。
 */
export async function loadDiskEvalReport(
  deps: { trajectoryBaseDir: string; reputationStore?: ReputationStore },
  simId: string,
): Promise<DiskEvalReport | undefined> {
  // simId 直接拼路径——拒绝任何带路径分隔符的 id，扫盘不出 baseDir。
  if (simId.length === 0 || simId.includes('/') || simId.includes('\\') || simId.includes('..')) {
    return undefined;
  }
  const dir = join(deps.trajectoryBaseDir, simId);
  try {
    readdirSync(dir);
  } catch {
    return undefined; // 目录不存在 = 这个 simId 没有盘上记录
  }

  // 一个仿真目录的决策 trajectory（P2 起为分段日志
  // `engine-runtime-iter0-*/segment-*.jsonl`，P2 前为单文件）；sim-timeline
  // 是时序增强，不是决策记录——readTrajectoryDirRecords 拥有布局发现。
  const records = await readTrajectoryDirRecords(dir, { cap: EVAL_REPORT_MAX_RECORDS });

  const notes: string[] = [
    'rebuilt from on-disk trajectory after server restart (simulation is no longer in the live registry)',
    'runtime state is unavailable post-restart — reported as null',
  ];
  const scenarioId = records.find(r => typeof r.scenario === 'string')?.scenario ?? null;
  if (scenarioId === null) {
    notes.push('no trajectory records on disk — scenarioId unknown');
  }

  // sim-timeline：恢复 environmentId（reputation 查 DB 用）与最后的 sim 时间。
  // Living-worlds P2：legacy 单文件 + 分段日志缝合扫描（每文件仍有读上限）。
  let environmentId: string | undefined;
  let simTimeSec: number | null = null;
  await forEachSimTimelineRecord(dir, record => {
    if (typeof record.environmentId === 'string') environmentId = record.environmentId;
    if (typeof record.simTimeSec === 'number') {
      simTimeSec = Math.max(simTimeSec ?? record.simTimeSec, record.simTimeSec);
    }
  });
  if (simTimeSec === null) {
    notes.push('no sim-timeline on disk — simTimeSec unknown');
  }

  let reputationRecords: EvalReputationRecord[] = [];
  if (environmentId !== undefined && deps.reputationStore) {
    reputationRecords = deps.reputationStore.rowsForEnv(environmentId).map(row => ({
      agentId: row.agent_id,
      capability: row.capability,
      attempts: row.attempts,
      successes: row.successes,
      failures: row.failures,
      // T71: v64+ rows carry the integer event buckets; legacy rows omit
      // them and the aggregation integerizes from the weight sums.
      ...(row.success_events !== null && row.partial_events !== null && row.failure_events !== null
        ? {
            successEvents: row.success_events,
            partialEvents: row.partial_events,
            failureEvents: row.failure_events,
          }
        : {}),
    }));
    notes.push(
      'reputation read from the environment\'s persisted DB rows — cumulative across all of its ' +
      'simulations, not a snapshot at this simulation\'s end',
    );
  } else {
    notes.push('reputation unavailable (environment unknown or no reputation store) — reported as zero');
  }

  return {
    simId,
    scenarioId,
    ...(environmentId !== undefined ? { environmentId } : {}),
    source: 'disk',
    state: null,
    simTimeSec,
    notes,
    ...aggregateEvalRecords(records, reputationRecords),
  };
}
