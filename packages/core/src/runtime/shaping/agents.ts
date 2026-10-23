/**
 * Agent config — dual-trigger assembly — pure shaping (L2), see docs/architecture-runtime.md
 *
 * Deterministic, no engine state, no I/O. Types come from ../contract.js.
 */

import type { LLMClient, LLMCacheStats } from '@active-collaboration/llm-integration';import type { DualTriggerConfig } from '../../decision/DualTriggerACManager.js';import type { AssessorConfig } from '../../decision/ACNecessityAssessor.js';import type { ScenarioAgent, ScenarioDefinition, ScenarioDevice } from '../../scenario/index.js';import { capabilityMatches } from '../../utils/capabilityMatching.js';import { mergeOfferRules, type SemanticOfferRule } from '../../service/semantic-offers.js';import type {  EngineSnapshot, EventRouteLevel,} from '../contract.js';/** Inputs to the agent dual-trigger config assembly. */
export interface AgentConfigInput {
  agentDef: ScenarioAgent;
  managedDevices: ScenarioDevice[];
  zones: ReadonlyArray<{ id: string; adjacentZoneIds?: string[] }>;
  autoInitiateAC: boolean;
  /**
   * T-050: actuate own devices on handle_independently (the runtime has
   * already resolved option > per-agent decisionPolicy > default-true).
   */
  autoActuateIndependent: boolean;
  acMode?: 'enabled' | 'disabled' | 'shadow';
  llmEnabled: boolean;
  assessorSystemPrompt?: string;
  triage?: {
    enabled: boolean;
    client?: LLMClient;
    mode?: 'shadow' | 'enforce';
    trustIndependent?: boolean;
  };
  /**
   * T-022 (DevLoop R17): bounded degradation policy for LLM-backed AC
   * necessity decisions (transient-only bounded retry, then rule fallback
   * or drop). Threaded into the assessor config for every LLM-backed agent.
   */
  llmFailure?: {
    retryAttempts?: number;
    retryBackoffMs?: number;
    policy?: 'rule-fallback' | 'drop';
  };
  /**
   * BUG-01: semantic-offer rule sources for the deterministic actuation
   * planner (scenario-authored rules, then operator option rules — merged
   * over the built-in table exactly like the aggregate-offer sync, so an
   * event requirement naming an aggregate service type resolves through
   * the SAME actuation backing the signing/invoke gates consult). Both
   * absent → the planner's built-in table applies.
   */
  scenarioOfferRules?: readonly SemanticOfferRule[];
  optionOfferRules?: readonly SemanticOfferRule[];
}/**
 * Assemble one agent's dual-trigger config (runner construction pattern):
 * actuator/adjacent zone sets from the agent's devices, rule-only when no
 * LLM, triage + system-prompt assessor overrides. Pure.
 */
export function buildAgentDualTriggerConfig(
  input: AgentConfigInput,
): { dualTriggerConfig: Partial<DualTriggerConfig>; actuatorZoneIds: string[] } {
  // Actuator zones: zones where the agent has actuator/hybrid devices.
  // Adjacent zones are computed from ACTUATOR zones only (runner semantics).
  const actuatorZoneIds = new Set<string>();
  for (const device of input.managedDevices) {
    if (device.role === 'actuator' || device.role === 'hybrid') {
      actuatorZoneIds.add(device.zoneId);
    }
  }
  const adjacentZoneIds = new Set<string>();
  for (const zoneId of actuatorZoneIds) {
    const zone = input.zones.find(z => z.id === zoneId);
    for (const adjId of zone?.adjacentZoneIds ?? []) {
      adjacentZoneIds.add(adjId);
    }
  }

  const dualTriggerConfig: Partial<DualTriggerConfig> = {
    maxConcurrentACs: 50,
    autoInitiateAC: input.autoInitiateAC,
    autoActuateIndependent: input.autoActuateIndependent,
    ...(input.acMode !== undefined ? { acMode: input.acMode } : {}),
    adjacentZoneIds: [...adjacentZoneIds],
    actuatorZoneIds: [...actuatorZoneIds],
    disableSpatiotemporal: true,
    // BUG-01: the merged offer table reaches the actuation planner (an
    // event requirement naming an aggregate service type resolves through
    // the rule's actuation backing to an own in-zone device).
    ...(input.scenarioOfferRules !== undefined || input.optionOfferRules !== undefined
      ? { semanticOfferRules: mergeOfferRules([...(input.scenarioOfferRules ?? []), ...(input.optionOfferRules ?? [])]) }
      : {}),
    ...(input.llmEnabled ? {} : { ruleOnly: true }),
    // R43-B/lever-b: precheck Type-A pass-through (agent-level author
    // config). Absent/'off' keeps the field undefined → current behavior.
    ...resolvePrecheckPassThrough(input.agentDef),
    // R45-P1: dispatcher role (agent-level author config). Absent keeps the
    // field undefined → executor, current behavior.
    ...(input.agentDef.decisionPolicy?.role !== undefined
      ? { decisionRole: input.agentDef.decisionPolicy.role }
      : {}),
  };

  // Assessor overrides: the P4-2 small-model triage (LLM-backed agents with
  // a triage client; mode defaults to 'shadow') and the system-prompt
  // override for prompt A/B runs — the per-agent scenario hint
  // (agent.llm.systemPrompt, Wave-3b) wins over the runtime-wide option.
  const assessorOverrides: Partial<AssessorConfig> = {};
  const systemPrompt = input.agentDef.llm?.systemPrompt ?? input.assessorSystemPrompt;
  if (systemPrompt !== undefined) {
    assessorOverrides.systemPrompt = systemPrompt;
  }
  if (input.llmEnabled && input.triage?.enabled && input.triage.client) {
    assessorOverrides.triage = {
      enabled: true,
      client: input.triage.client,
      mode: input.triage.mode ?? 'shadow',
      trustIndependent: input.triage.trustIndependent ?? true,
    };
  }
  // T-022: the LLM failure policy applies only where the LLM path can run.
  if (input.llmEnabled && input.llmFailure !== undefined) {
    if (input.llmFailure.retryAttempts !== undefined) {
      assessorOverrides.maxRetries = input.llmFailure.retryAttempts;
    }
    if (input.llmFailure.retryBackoffMs !== undefined) {
      assessorOverrides.llmRetryBackoffMs = input.llmFailure.retryBackoffMs;
    }
    if (input.llmFailure.policy !== undefined) {
      assessorOverrides.llmFailurePolicy = input.llmFailure.policy;
    }
  }
  if (Object.keys(assessorOverrides).length > 0) {
    dualTriggerConfig.layer2 = {
      assessor: assessorOverrides,
      negotiator: {},
      goalEngine: {},
    };
  }

  return { dualTriggerConfig, actuatorZoneIds: [...actuatorZoneIds] };
}

/**
 * R43-B/lever-b: resolve the precheck Type-A pass-through from the agent's
 * scenario decisionPolicy. Absent or 'off' → undefined (the assessor treats
 * absence as off — default equivalence); 'sample' carries the configured
 * rate (validated to [0,1]; default applied downstream in the assessor).
 */
function resolvePrecheckPassThrough(
  agentDef: ScenarioAgent,
): { precheckPassThrough?: { mode: 'off' | 'sample' | 'all'; rate?: number } } {
  const policy = agentDef.decisionPolicy;
  if (policy === undefined) return {};
  const mode = policy.precheckPassThrough;
  if (mode === undefined || mode === 'off') return {};
  if (mode === 'sample' && policy.precheckPassThroughRate !== undefined) {
    return { precheckPassThrough: { mode, rate: policy.precheckPassThroughRate } };
  }
  return { precheckPassThrough: { mode } };
}
/**
 * R30 extraction (from EngineRuntime.resolveManagingAgents — identical
 * selection): the agents that should receive an event originating in a
 * zone. Direct managers first; when none exist, agents managing adjacent
 * zones (runner fallback semantics). The enabled filter applies to the
 * FINAL list only — a disabled direct manager must not make the event
 * spill over to adjacent-zone agents that would never have received it.
 */
export function resolveManagingAgentIds(
  agents: ReadonlyArray<{ id: string }>,
  zoneOf: (zoneId: string) => { adjacentZoneIds?: string[] } | undefined,
  managedZonesOf: (agentId: string) => string[] | undefined,
  isEnabled: (agentId: string) => boolean,
  zoneId: string,
): string[] {
  return resolveEventAudience(agents, zoneOf, managedZonesOf, () => [], () => [], isEnabled, zoneId).agentIds;
}

/**
 * R103 (chen-20, PM-ruled fallback chain): the audience of an event
 * originating in a zone. Levels, first non-empty wins:
 *
 *   1. device-presence — agents with a BOUND DEVICE in the zone (physical
 *      presence beats a bare jurisdiction declaration: the lab-101 stewards
 *      declared lab-102 management but could not act there);
 *   2. capability-match — agents whose capabilities cover the event's
 *      dispatch needs (the inference table, e.g. smoke → smoke-monitoring/
 *      ventilation) — this is how the security specialists receive a smoke
 *      event after the zone's own sensor agent is gone;
 *   3. managed-zone — the legacy direct managers (declared ∪ bound-device
 *      zones union, runner semantics);
 *   4. adjacent-zone — agents managing zones adjacent to the event zone
 *      (legacy fallback).
 *
 * Level 2 only engages when an event type is known AND the inference table
 * maps it to needs (unknown types stay honest — level 3/4 answer as
 * before). The enabled filter applies to the FINAL list only. The `level`
 * rides the route audit so "投给了谁、按哪一级" is answerable.
 */
export function resolveEventAudience(
  agents: ReadonlyArray<{ id: string }>,
  zoneOf: (zoneId: string) => { adjacentZoneIds?: string[] } | undefined,
  managedZonesOf: (agentId: string) => string[] | undefined,
  /** R103: zones of the agent's BOUND devices (physical presence). */
  boundDeviceZonesOf: (agentId: string) => string[],
  /** R103: the agent's capability names (for the capability-match level). */
  capabilitiesOf: (agentId: string) => string[],
  isEnabled: (agentId: string) => boolean,
  zoneId: string,
  /** R103: the event's dispatch needs (inference table) — level 2. */
  eventNeeds?: readonly string[],
): { agentIds: string[]; level: EventRouteLevel } {
  // Level 1: physical presence (a bound device in the event zone).
  // The enabled filter applies to the FINAL list only — a disabled presence
  // agent must not spill the event to lower levels (legacy discipline).
  const present = agents
    .filter(a => boundDeviceZonesOf(a.id).includes(zoneId))
    .map(a => a.id);
  if (present.length > 0) return { agentIds: present.filter(isEnabled), level: 'device-presence' };

  // Level 2: capability match against the event's dispatch needs (the
  // SAME semantic matcher the request face and partner ranking read).
  if (eventNeeds !== undefined && eventNeeds.length > 0) {
    const capable = agents
      .filter(a => capabilitiesOf(a.id).some(cap =>
        eventNeeds.some(need => capabilityMatches(cap, need)),
      ))
      .map(a => a.id);
    if (capable.length > 0) return { agentIds: capable.filter(isEnabled), level: 'capability-match' };
  }

  // Level 3: legacy direct managers (declared ∪ bound-device zones).
  const direct = agents
    .filter(a => managedZonesOf(a.id)?.includes(zoneId))
    .map(a => a.id);
  if (direct.length > 0) return { agentIds: direct.filter(isEnabled), level: 'managed-zone' };

  // Level 4: adjacent-zone agents (legacy fallback).
  const adjacent = zoneOf(zoneId)?.adjacentZoneIds ?? [];
  if (adjacent.length > 0) {
    const adjacentAgents = agents
      .filter(a => {
        const managed = managedZonesOf(a.id) ?? [];
        return managed.some(zid => adjacent.includes(zid));
      })
      .map(a => a.id);
    return { agentIds: adjacentAgents.filter(isEnabled), level: 'adjacent-zone' };
  }
  return { agentIds: [], level: 'none' };
}

/**
 * R103: the assembled event-audience resolver — EngineRuntime wires its
 * scenario + runtime maps ONCE; each injection resolves through the
 * PM-ruled chain (resolveEventAudience). `eventNeedsOf` is the
 * inference-table seam (kept caller-injected so shaping stays free of
 * decision-layer imports).
 */
export function eventAudienceResolver(args: {
  agents: ReadonlyArray<{ id: string; capabilities?: string[] }>;
  zones: ReadonlyArray<{ id: string; adjacentZoneIds?: string[] }>;
  devices: ReadonlyArray<{ id: string; zoneId?: string }>;
  agentInfo: ReadonlyMap<string, { managedZoneIds: string[]; boundDeviceIds: string[]; enabled?: boolean }>;
  eventNeedsOf: (eventType: string) => string[];
}): (zoneId: string, eventType?: string) => { agentIds: string[]; level: EventRouteLevel } {
  return (zoneId, eventType) => resolveEventAudience(
    args.agents,
    zid => args.zones.find(z => z.id === zid),
    id => args.agentInfo.get(id)?.managedZoneIds,
    id => (args.agentInfo.get(id)?.boundDeviceIds ?? [])
      .map(d => args.devices.find(x => x.id === d)?.zoneId)
      .filter((z): z is string => z !== undefined),
    id => args.agents.find(a => a.id === id)?.capabilities ?? [],
    id => args.agentInfo.get(id)?.enabled !== false,
    zoneId,
    eventType !== undefined ? args.eventNeedsOf(eventType) : undefined,
  );
}

/**
 * R46-P0: id → display name for an agent's managed zones, from the scenario
 * zone defs. Stamped into agent metadata so the NL lane can rebuild a
 * jurisdiction zone VIEW (id + display name) even when a bounded caller
 * window cut the zone out — colloquial zh references ("盐田观测点")
 * text-match against the display name, never a bare latin id. Pure.
 */
export function managedZoneNamesOf(
  zoneDefs: ReadonlyArray<{ id: string; name?: string }>,
  managedZoneIds: readonly string[],
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const zoneId of managedZoneIds) {
    const name = zoneDefs.find(z => z.id === zoneId)?.name;
    if (typeof name === 'string' && name.length > 0) names[zoneId] = name;
  }
  return names;
}

/**
 * Devices managed by an agent: the explicit boundDeviceIds (mirrors the
 * runner's managesDeviceIds). managesZoneIds governs event routing only —
 * it does NOT auto-assign zone devices, so agents share zones not devices.
 * (Extracted from EngineRuntime, R46-P0 file-budget.)
 */
export function agentBoundDevices<T extends { id: string }>(
  devices: readonly T[],
  agentDef: { boundDeviceIds: readonly string[] },
): T[] {
  const ids = new Set<string>(agentDef.boundDeviceIds);
  return devices.filter(d => ids.has(d.id));
}

/** Zones an agent is responsible for: managed zones plus zones of its devices. */
export function agentManagedZoneIds(
  agentDef: { managesZoneIds: readonly string[] },
  managedDevices: ReadonlyArray<{ zoneId: string }>,
): string[] {
  const zoneIds = new Set<string>(agentDef.managesZoneIds);
  for (const device of managedDevices) {
    zoneIds.add(device.zoneId);
  }
  return [...zoneIds];
}

/**
 * R40-A2（信任校准平台声誉桥，认知架构 §7.3）：把 ReputationTracker 的
 * 平台声誉按 agent 喂给各 CognitiveAgent 的 MetaCognition——
 * setPlatformReputation 落进 TrustCalibrationStore 后，buildContext 的
 * partner trust 即按贝叶斯收缩混合（平台声誉 × 私有经历）计算。
 *
 * 刷新时机（选"协作完成后 + 装配/持久载入后"，理由）：
 *  - 声誉 cell 只在两处变异：COLLABORATION_COMPLETED 的结果记账与设备
 *    失败归因。协作完成是"市场结算了一笔交易"的语义时刻——结果落账后
 *    立即刷新，让每个 agent 在下一个决策轮看到的伙伴信任分已含最新
 *    平台信号；
 *  - 设备失败归因刻意不做刷新点：事故进行中高频变异，逐次推开会造成
 *    信任输入在事件处理中途抖动；这些变化会被下一次协作完成时的刷新
 *    捡起（最终一致）；
 *  - 成本 O(agents²) 次 O(1) 写（agentScore 内部扫描该 agent 的 cell），
 *    场景级 agent 数（几十）下可忽略，无需节流。
 *
 * 诚实性约定：只推"平台有信号"的伙伴（getAgentReputation 非空）——无
 * 历史的 agent 不物化进信任表，保持 §7.3 的"无信号 = 中性 0.5"语义
 * （tracker 的 prior 0.7 是"未知但体面"的平台读数，仅在有证据的聚合里
 * 生效）。`enabled=false`（reputationEnabled ablation）时完全不推。
 */
/** pushPlatformReputation 的 agent 结构子面（CognitiveAgent 的最小依赖倒置）。 */
interface ReputationBridgeAgent {
  id: string;
  getDualTriggerACManager?: () => {
    getMetaCognition?: () => {
      setPlatformReputation: (partnerId: string, reputation: number) => void;
    } | undefined;
  } | undefined;
}

export function pushPlatformReputation(
  agents: Iterable<ReputationBridgeAgent>,
  reputation: {
    getAgentReputation: (agentId: string) => unknown[];
    agentScore: (agentId: string) => number;
  },
  enabled: boolean,
): void {
  if (!enabled) return;
  const faces = [...agents].map(agent => ({
    id: agent.id,
    meta: agent.getDualTriggerACManager?.()?.getMetaCognition?.(),
  }));
  for (const { id, meta } of faces) {
    if (meta === undefined) continue;
    for (const partner of faces) {
      if (partner.id === id) continue;
      // 无任何 (agentId, capability) 记录 → 平台无信号，不推。
      if (reputation.getAgentReputation(partner.id).length === 0) continue;
      meta.setPlatformReputation(partner.id, reputation.agentScore(partner.id));
    }
  }
}
