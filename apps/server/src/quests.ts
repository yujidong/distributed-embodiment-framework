/**
 * Quest levels (R6-D-M1, gamification-design.md §2) — the L1-L6 quest
 * backbone: 安家 → 武装 → 有人值守 → 世界活了 → 第一份合约 → 组合应用.
 *
 * `deriveQuests` is a PURE function (no I/O, unit-testable in the onboarding.ts
 * pattern): the route handler gathers the facts from the same store queries
 * the digest / eval-report use, and this module maps them to per-quest
 * achieved/locked + the current quest's guidance hint. Hints are stable
 * machine tokens — the web panel maps them to localized copy + a sidebar-tab
 * jump target (server stays copy-free).
 *
 * 判定口径（gamification-design.md §1 表）:
 * - L1 安家: zones ≥ 1（导入建筑模型即过关）
 * - L2 武装: devices ≥ 1（蓝图安装或提案安装）
 * - L3 有人值守: ≥1 绑定设备的 agent 且世界会话 trajectory 里有它的 ≥1 条
 *   认知决策
 * - L4 世界活了: ≥1 次真实协作握手成功 —— store 口径为存在 activated_at
 *   非空的 agreement（AC 合约握手成功即 born active；eval-report 的
 *   handshakes.succeeded 同一事实的评测侧投影）
 * - L5 第一份合约: ≥1 条 terminated agreement 且 outcome=completed
 *   （terminatedAgreementOutcome 唯一口径，与 digest completedCollaborations
 *   一致）
 * - L6 组合应用: ≥1 条 enabled Flow 有成功运行（flow_runs status='success'）
 *   或服务消费计量 usage ≥ 1
 */

export type QuestId = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';

/** Guidance tokens the web panel maps to localized copy + a jump target. */
export type QuestHint =
  | 'import-building'
  | 'install-blueprint'
  | 'bind-agent'
  | 'install-collab-pair'
  | 'complete-agreement'
  | 'compose-flow';

export interface QuestFacts {
  /** Zones in the environment's map data. */
  zones: number;
  /** Installed device count. */
  devices: number;
  /** Agents bound to ≥1 device. */
  boundAgents: number;
  /** Cognitive decisions recorded for a bound agent (world-session trajectory). */
  cognitiveDecisions: number;
  /** Agreements that ever reached active (activated_at NOT NULL). */
  handshakesSucceeded: number;
  /** Terminated agreements whose outcome is 'completed' (terminatedAgreementOutcome). */
  completedAgreements: number;
  /** Enabled flows. */
  enabledFlows: number;
  /** Successful runs (status 'success') of enabled flows. */
  successfulFlowRuns: number;
  /** Metered service-consumption rows (usage_records). */
  usageRecords: number;
}

export interface QuestStatus {
  id: QuestId;
  achieved: boolean;
  /** Locked = an earlier quest is not yet achieved (sequential gating). */
  locked: boolean;
  /** What to do next when this is the current quest. */
  hint: QuestHint;
}

export interface QuestState {
  quests: QuestStatus[];
  /** The first unachieved quest (necessarily unlocked); null when all six clear. */
  current: QuestId | null;
}

const QUEST_DEFS: ReadonlyArray<{
  id: QuestId;
  hint: QuestHint;
  achieved: (facts: QuestFacts) => boolean;
}> = [
  { id: 'L1', hint: 'import-building', achieved: f => f.zones >= 1 },
  { id: 'L2', hint: 'install-blueprint', achieved: f => f.devices >= 1 },
  {
    id: 'L3',
    hint: 'bind-agent',
    achieved: f => f.boundAgents >= 1 && f.cognitiveDecisions >= 1,
  },
  { id: 'L4', hint: 'install-collab-pair', achieved: f => f.handshakesSucceeded >= 1 },
  { id: 'L5', hint: 'complete-agreement', achieved: f => f.completedAgreements >= 1 },
  {
    id: 'L6',
    hint: 'compose-flow',
    achieved: f => (f.enabledFlows >= 1 && f.successfulFlowRuns >= 1) || f.usageRecords >= 1,
  },
];

export function deriveQuests(facts: QuestFacts): QuestState {
  let earlierMissing = false;
  let current: QuestId | null = null;
  const quests = QUEST_DEFS.map(def => {
    const achieved = def.achieved(facts);
    const locked = earlierMissing;
    if (!achieved) {
      earlierMissing = true;
      if (current === null) current = def.id;
    }
    return { id: def.id, achieved, locked, hint: def.hint };
  });
  return { quests, current };
}
