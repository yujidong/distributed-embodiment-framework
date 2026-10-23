/**
 * L5 Meta-cognition — Capability Boundary Awareness + Boundary Recognition
 * (design §7.2 capability awareness, §7.5 escalation).
 *
 * "Knowing what you cannot do is part of cognition" (§1): the boundary is
 * DERIVED, never declared twice — the declared capability surface (T-202
 * union of agent-declared + device-derived), the bound devices' live
 * capabilities/online state, and the scope-of-practice exclusions (T-036
 * cannotDeliverClasses) resolve into three lists:
 *
 *   strongAreas  — declared AND backed by ≥1 online bound device (the agent
 *                  can genuinely deliver these alone);
 *   weakAreas    — declared but with NO bound-device backing (collaborate);
 *   mustEscalate — authority-limited (scope-of-practice exclusion) or
 *                  safety-critical-and-undeliverable (human/owner territory).
 *
 * An agent that HAS deliverable safety equipment (fire-suppression devices,
 * in scope) keeps it as a strong area — it should act, not escalate.
 *
 * The module also owns §7.5's escalation function
 * `escalate = f(uncertainty × risk × authority)` — pure, exported thresholds.
 */

import { capabilityMatches } from '../utils/capabilityMatching.js';

// ============================================================================
// Capability boundary
// ============================================================================

/** What the agent can / cannot / must-not-alone do (§7.2). */
export interface CapabilityBoundary {
  /** Deliverable alone (has online devices + capabilities). */
  strongAreas: string[];
  /** Cannot handle alone (no device/capability backing) — collaborate. */
  weakAreas: string[];
  /** Safety-critical or authority-limited — escalate to the owner. */
  mustEscalate: string[];
}

/** One bound device's boundary-relevant face (live, per decision round). */
export interface BoundaryDeviceInput {
  deviceId: string;
  /** The device's declared capabilities (sensors AND actuators). */
  capabilities: readonly string[];
  /** Live online flag (offline/error devices degrade their areas, §7.2). */
  online: boolean;
}

/** The derivation input (the manager builds it per round from live state). */
export interface CapabilityBoundaryInput {
  /** T-202 capability surface (declared ∪ device-derived). */
  capabilities: readonly string[];
  /** The agent's bound devices with live capability/online faces. */
  devices: readonly BoundaryDeviceInput[];
  /** T-036 cannotDeliverClasses — capability classes this agent must NOT deliver. */
  scopeOfPractice?: readonly string[];
}

/**
 * Substrings marking a capability as safety-critical. A bounded, documented
 * list (v1) — extending it is a deliberate governance decision, not a bugfix.
 */
export const SAFETY_CRITICAL_MARKERS: readonly string[] = [
  'fire', 'smoke', 'gas', 'security', 'intrusion', 'access-control',
  'surveillance', 'emergency', 'hazard', 'toxic', 'life-safety', 'safety',
];

/** True when the capability name carries a safety-critical marker. */
export function isSafetyCriticalCapability(capability: string): boolean {
  const lower = capability.toLowerCase();
  return SAFETY_CRITICAL_MARKERS.some(marker => lower.includes(marker));
}

/** True when the agent's scope-of-practice excludes this capability (T-036). */
function isExcludedByScope(capability: string, scopeOfPractice: readonly string[]): boolean {
  return scopeOfPractice.some(excluded => capabilityMatches(excluded, capability));
}

/** True when ≥1 ONLINE bound device backs the capability (synonym-aware). */
function isDeviceBacked(capability: string, devices: readonly BoundaryDeviceInput[]): boolean {
  return devices.some(device =>
    device.online &&
    device.capabilities.some(deviceCap => capabilityMatches(deviceCap, capability)),
  );
}

/**
 * Derive the capability boundary (pure, deterministic — one truth, T-051:
 * runtime boundary derivation and any future authoring check share this).
 * Order is preserved from the declared surface; duplicates collapse.
 */
export function deriveCapabilityBoundary(input: CapabilityBoundaryInput): CapabilityBoundary {
  const scope = input.scopeOfPractice ?? [];
  const strongAreas: string[] = [];
  const weakAreas: string[] = [];
  const mustEscalate: string[] = [];

  for (const capability of [...new Set(input.capabilities)]) {
    if (typeof capability !== 'string' || capability.length === 0) continue;
    if (isExcludedByScope(capability, scope)) {
      mustEscalate.push(capability); // authority-limited — never "strong"
      continue;
    }
    if (isDeviceBacked(capability, input.devices)) {
      strongAreas.push(capability);
      continue;
    }
    if (isSafetyCriticalCapability(capability)) {
      mustEscalate.push(capability); // safety-critical AND undeliverable
      continue;
    }
    weakAreas.push(capability);
  }

  return { strongAreas, weakAreas, mustEscalate };
}

/** Compact prompt hint lines (bounded, deterministic). */
export function renderCapabilityBoundary(boundary: CapabilityBoundary): string[] {
  const lines: string[] = [];
  lines.push(
    `CAPABILITY_BOUNDARY: strong=[${boundary.strongAreas.join(',')}] ` +
    `weak=[${boundary.weakAreas.join(',')}] ` +
    `must-escalate=[${boundary.mustEscalate.join(',')}]`,
  );
  if (boundary.weakAreas.length > 0) {
    lines.push(
      `You are WEAK in ${boundary.weakAreas.join(', ')} — consider collaborating for those needs`,
    );
  }
  if (boundary.mustEscalate.length > 0) {
    lines.push(
      `You MUST ESCALATE ${boundary.mustEscalate.join(', ')} (safety-critical or outside your scope of practice)`,
    );
  }
  return lines;
}

// ============================================================================
// Boundary recognition: escalation = f(uncertainty × risk × authority) §7.5
// ============================================================================

/** The agent's authority level for the escalation function (§10 role faces). */
export type EscalationAuthority = 'full' | 'builder' | 'viewer';

/**
 * Pressure thresholds: escalate when (1 − confidence) × risk ≥ threshold.
 * Less authority → lower threshold (a viewer escalates sooner).
 */
export const ESCALATION_PRESSURE_THRESHOLDS: Record<EscalationAuthority, number> = {
  full: 0.4,
  builder: 0.3,
  viewer: 0.2,
};

/** §7.5 trigger 1: severity ≥ 4 (risk ≥ 0.8) with confidence < this → escalate. */
export const ESCALATION_SEVERE_LOW_CONFIDENCE = 0.5;

/** Viewer + risk at/above this is un-actionable alone regardless of confidence. */
export const ESCALATION_VIEWER_RISK_FLOOR = 0.6;

/**
 * The escalation decision function (§7.5 "升级 = 不确定性 × 风险 × 权限的函数").
 *
 * Inputs:
 *  - `uncertainty`: CognitiveDecision.uncertainty.overall — the model's
 *    CONFIDENCE in its read of the situation (0 = blind, 1 = certain; the
 *    same orientation as the schema's model_confidence);
 *  - `risk`: situation severity mapped to 0..1 (severity / 5);
 *  - `authority`: the agent's authority level ('full' when unknown).
 *
 * Deterministic ordered rules, each naming the design trigger it implements:
 *  1. viewer authority + risk ≥ 0.6 → escalate (cannot actuate alone);
 *  2. risk ≥ 0.8 (severity ≥ 4) AND confidence < 0.5 → escalate
 *     (§7.5 trigger 1: "看不清的紧急" — an emergency the agent cannot see
 *     clearly);
 *  3. (1 − confidence) × risk ≥ the authority's pressure threshold →
 *     escalate (the general uncertainty × risk product, authority-adjusted).
 */
export function shouldEscalate(
  uncertainty: number,
  risk: number,
  authority: EscalationAuthority,
): { escalate: boolean; reason: string } {
  const confidence = Math.min(1, Math.max(0, Number.isFinite(uncertainty) ? uncertainty : 0.5));
  const riskLevel = Math.min(1, Math.max(0, Number.isFinite(risk) ? risk : 0));

  if (authority === 'viewer' && riskLevel >= ESCALATION_VIEWER_RISK_FLOOR) {
    return {
      escalate: true,
      reason: `authority-limited: viewer cannot act on a risk=${round2(riskLevel)} situation`,
    };
  }
  if (riskLevel >= 0.8 && confidence < ESCALATION_SEVERE_LOW_CONFIDENCE) {
    return {
      escalate: true,
      reason:
        `severity≥4 emergency with confidence=${round2(confidence)}<${ESCALATION_SEVERE_LOW_CONFIDENCE} ` +
        '(§7.5 trigger 1: an emergency the agent cannot see clearly)',
    };
  }
  const pressure = (1 - confidence) * riskLevel;
  const threshold = ESCALATION_PRESSURE_THRESHOLDS[authority];
  if (pressure >= threshold) {
    return {
      escalate: true,
      reason:
        `escalation pressure=${round2(pressure)}≥${threshold} ` +
        `(confidence=${round2(confidence)}, risk=${round2(riskLevel)}, authority=${authority})`,
    };
  }
  return {
    escalate: false,
    reason:
      `pressure=${round2(pressure)}<${threshold} ` +
      `(confidence=${round2(confidence)}, risk=${round2(riskLevel)}, authority=${authority})`,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ============================================================================
// R40-A3: the decision-cycle escalation evaluation (§7.5 wiring)
// ============================================================================

/**
 * 能力边界 → 升级权限面的映射（§7.5 escalate = f(不确定性×风险×权限)）。
 * 边界是同一轮 buildContext 派生过的活面（strong/weak/must-escalate）：
 * 有 must-escalate 区（T-036 权限排除，或安全关键且不可交付）→ 'builder'
 * （该 agent 在部分领域权限受限，阈值低于 full）；其余 → 'full'。边界缺省
 * 时按 full 处理。刻意不从"无设备背书"推断 'viewer'：监控型 agent（弱区 ≠
 * 无权限）面对高危事件会恒定升级，通知噪音的代价大于漏报——保守方向是
 * 少升级而不是多升级（viewer 待真正的角色面接入后再映射）。
 */
export function escalationAuthorityOf(boundary: CapabilityBoundary | undefined): EscalationAuthority {
  if (boundary !== undefined && boundary.mustEscalate.length > 0) return 'builder';
  return 'full';
}

/**
 * R45-P0：事件的权威 severity 档（EventContextNormalizer 的归一化词表。
 * 结构性重复是刻意的——capability-boundary 不依赖 context 包）。
 */
export type EventSeverity = 'low' | 'normal' | 'medium' | 'high' | 'urgent' | 'critical';

/**
 * R45-P0：每个事件 severity 档允许的 risk 区间。事件的**真实 severity** 是
 * authoritative source——它约束 risk 输入的上下界；模型自报的
 * situation.severity 只在区间内选点（tie-breaker），不再单独决定 risk。
 *
 * 背景（docs/devloop-r45-realistic-report.md §2.3）：v5 对每条决策恒自报
 * severity 4-5、confidence 0.1-0.3，risk = 自报/5 使 trigger 1 恒成立——
 * 22/22 决策全升级，含 6/6 条 low 级恢复通知。档位设计对齐该实测：
 * low 封顶 0.2（v5 自报 5 也压回 0.2 → pressure ≤ 0.18 < 0.4 不升）；
 * critical 至少 0.6（自报 2 + 低置信也抬到 0.6 → pressure 0.42 ≥ 0.4 升）；
 * high/urgent 保持"应升"（v5 自报 4-5 + 低置信 → risk 0.7-0.9 仍越阈）。
 */
export const EVENT_SEVERITY_RISK_BANDS: Readonly<Record<EventSeverity, { min: number; max: number }>> = {
  low: { min: 0, max: 0.2 },
  normal: { min: 0, max: 0.3 },
  medium: { min: 0.1, max: 0.4 },
  high: { min: 0.3, max: 0.7 },
  urgent: { min: 0.5, max: 0.9 },
  critical: { min: 0.6, max: 1.0 },
};

/** 把模型自报 risk 收进事件 severity 档（事件侧 authoritative，模型侧 tie-breaker）。 */
function clampRiskToEventBand(modelRisk: number, eventSeverity: EventSeverity | undefined): number {
  if (eventSeverity === undefined) return modelRisk;
  const band = EVENT_SEVERITY_RISK_BANDS[eventSeverity];
  return Math.min(band.max, Math.max(band.min, modelRisk));
}

/** evaluateDecisionEscalation 的输入（ACNecessityAssessment 的结构小子集）。 */
export interface DecisionEscalationInput {
  cognitiveDecision?: {
    situation: { severity: number };
    uncertainty: { overall: number };
    actionPlan: { primary: { action: string }; escalationCondition?: string };
  };
  agentContext?: { metaCognition?: { boundary?: CapabilityBoundary } };
  llmAssessment?: { reasoning?: string };
}

/**
 * R40-A3（§7.5 升级通道）：对一条已完成的认知决策评估是否升级。
 *
 * 输入三要素（全部现成，不引入新状态）：情境严重度 risk；决策置信度 =
 * uncertainty.overall；能力边界 → escalationAuthorityOf 映射的权限面。
 * 触发 = shouldEscalate 阈值命中，或模型主行动词本身就是 'escalate'
 * （Phase 1 把该词映射成 defer 后再无下游——这里是它的消费方）。
 *
 * R45-P0（risk 的 authoritative source）：risk = 模型自报 severity / 5，但
 * 当调用方传入事件的**真实 severity**（eventSeverity，从 event 归一化）时，
 * 该档位约束 risk 的上下界（EVENT_SEVERITY_RISK_BANDS）——自报只在档内
 * 选点。修复"v5 恒自报 4-5 → 22/22 全升级（含 6 条 low 级恢复通知）"。
 * eventSeverity 缺省（不可得）时回退到纯自报（R45 前行为，向后兼容）。
 *
 * 命中时在 assessment 上标注 escalated=true + escalationCondition（模型
 * escalationCondition 优先，缺省用阈值命中 reason），并把升级说明追加进
 * llmAssessment.reasoning（audit 面：不执行的理由必须可见）。调用方
 * （DualTriggerACManager）据此跳过一切执行分支——升级 = 只通知不执行。
 */
export function evaluateDecisionEscalation(
  assessment: DecisionEscalationInput,
  eventSeverity?: EventSeverity,
): {
  escalated: boolean;
  escalationCondition?: string;
} {
  const cognitive = assessment.cognitiveDecision;
  // 无结构化决策面（preCheck/rule/triage/二元答案）不评估——那些路径没有
  // 可用的严重度/置信输入，升级函数是给"看得见自己不确定"的认知决策用的。
  if (cognitive === undefined) return { escalated: false };

  const authority = escalationAuthorityOf(assessment.agentContext?.metaCognition?.boundary);
  const modelRisk = Math.min(1, Math.max(0, cognitive.situation.severity / 5));
  const risk = clampRiskToEventBand(modelRisk, eventSeverity);
  const verdict = shouldEscalate(cognitive.uncertainty.overall, risk, authority);
  const modelAsked = cognitive.actionPlan.primary.action === 'escalate';
  if (!verdict.escalate && !modelAsked) return { escalated: false };

  const condition = cognitive.actionPlan.escalationCondition ?? verdict.reason;
  (assessment as { escalated?: boolean }).escalated = true;
  (assessment as { escalationCondition?: string }).escalationCondition = condition;
  const note = `[escalated to owner — notify-only, no device command; ${condition}]`;
  const reasoning = assessment.llmAssessment?.reasoning;
  if (assessment.llmAssessment !== undefined) {
    assessment.llmAssessment.reasoning = reasoning && reasoning.length > 0 ? `${reasoning} ${note}` : note;
  }
  return { escalated: true, escalationCondition: condition };
}
