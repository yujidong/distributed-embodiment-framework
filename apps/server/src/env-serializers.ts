/**
 * Environment JSON serializers — database rows → API wire shapes
 *
 * Snake_case row columns become camelCase API fields; JSON columns are
 * parsed; owner foreign keys are expanded to `{id, displayName}`.
 */

import type { FlowRow, FlowRunRow } from './db/flow-store.js';
import type { PublicUser, UserRow } from './db/user-store.js';
import type { ReputationScoreView } from './db/reputation-store.js';
import type {
  AggregateBackingMissingView,
  AggregateRuleBackingView,
  ServiceInstanceRow,
} from './db/service-store.js';
import {
  parseJsonArray,
  parseJsonObject,
  parseMapData,
  type AgentInstanceRow,
  type DeviceInstanceRow,
  type EnvironmentRow,
  type EnvMemberRow,
  type EnvRole,
  type EnvZone,
} from './db/environment-store.js';
import { deviceExecutableCommandNames } from '@active-collaboration/simulation';
import { securityFlagsForFlow } from '@active-collaboration/core';

import type { HumanReviewThresholds } from './proposal-human-review-policy.js';
import { resolveHumanReviewThresholds } from './proposal-human-review-policy.js';

export interface OwnerRef {
  id: string;
  displayName: string;
}

/**
 * T-072 (D-1 decide half): one ACTIVE decision delegation in wire shape —
 * who may decide a class of governance proposals in the owner's stead.
 */
export interface EnvDelegationJson {
  scope: string;
  delegate: OwnerRef;
  /** 'all' or the specific zone ids the delegation covers. */
  zones: string[] | 'all';
  grantedBy: OwnerRef;
  grantedAt: string;
}

/**
 * T-309 (DevLoop R12, FR-F05) → T-058a (R14, design-consent-semantics.md
 * §3.3): the environment's governance policy, surfaced read-only on the env
 * detail so a family member installing hardware into someone else's
 * facility can see WHO consents BEFORE they rely on it. Derived from the
 * env's map data: zones the owner marked consentClass='supervised' always
 * escalate to the owner — the block now describes a gated mechanism, not
 * just an honest account of auto-apply.
 *
 * T-072 adds `decisionDelegations`: the owner's active zone-claim decide
 * delegations (who besides the owner may decide what, per env).
 */
export function envGovernancePolicy(
  env: EnvironmentRow,
  deploymentThresholds?: HumanReviewThresholds,
  delegations: EnvDelegationJson[] = [],
): {
  proposalReview: string;
  notes: string;
  supervisedZones: Array<{ zoneId: string; consentClass: 'supervised' }>;
  supervisedZoneNote: string;
  /**
   * S1 (Task 3): the EFFECTIVE human-review breadth thresholds (per-env
   * owner override over deployment defaults; every 0 = class disarmed).
   * Read-only derived surface — the owner authors the override via
   * PATCH mapData governance.humanReview.
   */
  humanReview: HumanReviewThresholds;
  humanReviewNote: string;
  /** T-072: active decision delegations (v1 scope: 'zone-claims'). */
  decisionDelegations: EnvDelegationJson[];
  decisionDelegationNote: string;
  /**
   * C3 (R42-B): the world's ownership plan ('members' = builder members
   * may claim UNASSIGNED agents/devices via ownership-transfer proposals;
   * 'importer' = everything stays with the importer until they hand it
   * over). Authored at import (body.ownershipPlan) or via PATCH mapData.
   */
  ownershipPlan: 'importer' | 'members';
  ownershipPlanNote: string;
} {
  const supervisedZones = parseMapData(env).zones
    .filter(zone => zone.consentClass === 'supervised')
    .map(zone => ({ zoneId: zone.id, consentClass: 'supervised' as const }));
  const ownershipPlan = parseMapData(env).governance?.ownershipPlan === 'members' ? 'members' : 'importer';
  return {
    proposalReview: 'ai-assisted-auto-apply',
    notes:
      'low-risk proposals are auto-applied after AI review; the environment owner is notified on every auto-apply (revertable)',
    supervisedZones,
    supervisedZoneNote:
      'proposals touching these zones always escalate to the environment owner — ' +
      'AI review never auto-applies there (it runs as advisor; the owner decides)',
    humanReview: resolveHumanReviewThresholds(env, deploymentThresholds),
    humanReviewNote:
      'breadth thresholds forcing owner review (0 = disarmed): agent-fleet installs, ' +
      'scheduled-event overlays, cross-zone footprints; payloads carrying prompt-injection ' +
      'markers ALWAYS escalate regardless of these thresholds',
    decisionDelegations: delegations,
    decisionDelegationNote:
      delegations.length === 0
        ? 'deciding proposals stays owner-only; the owner may delegate zone-claim decisions to one member via POST /api/environments/{id}/delegations'
        : 'besides the owner, the listed delegate may decide escalated zone-claim proposals within their zone scope ' +
          '(one delegate per scope at a time; supervised-zone consent itself stays owner-only)',
    ownershipPlan,
    ownershipPlanNote:
      ownershipPlan === 'members'
        ? 'members-plan world: builder members may CLAIM unassigned agents/devices (still owned by the ' +
          'environment owner) via ownership-transfer proposals naming themselves as toUser — every claim ' +
          'still escalates to the owner'
        : 'everything stays with the importer until handed over — the owner (or a current holder) initiates ' +
          'ownership-transfer proposals',
  };
}

export function ownerRef(user: PublicUser | undefined, fallbackId: string): OwnerRef {
  return user
    ? { id: user.id, displayName: user.displayName }
    : { id: fallbackId, displayName: fallbackId };
}

/**
 * Member JSON, perspective-aware (Fix-4, RC-4 / P1-6; Fix-13, R5 F-04): the
 * SINGLE place that turns a membership row into wire shape. Owners and
 * builders see the full view (userId + email — coordination needs them);
 * viewers, non-members and anonymous visitors of a public environment see a
 * redacted view — displayName + role only, with no stable identifiers
 * (userId/email absent, never null).
 */
export interface EnvMemberJson {
  role: EnvRole;
  displayName: string;
  userId?: string;
  email?: string | null;
}

export function memberToJson(
  member: EnvMemberRow,
  user: UserRow | undefined,
  viewerSeesContacts: boolean,
): EnvMemberJson {
  if (!viewerSeesContacts) {
    // Redacted: no id to fall back to — a missing user row stays anonymous.
    return { role: member.role, displayName: user?.display_name ?? 'member' };
  }
  return {
    userId: member.user_id,
    role: member.role,
    displayName: user?.display_name ?? member.user_id,
    email: user?.email ?? null,
  };
}

export function deviceToJson(row: DeviceInstanceRow, owner: OwnerRef) {
  const capabilities = parseJsonArray<string>(row.capabilities_json);
  return {
    id: row.id,
    envId: row.env_id,
    name: row.name,
    type: row.type,
    brand: row.brand,
    capabilities,
    // T-074 (R22, NW-F05): the HONEST executability surface — the concrete
    // command names the platform dispatch executes for the declared
    // capabilities (the SAME oracle that backs flow validation and invoke
    // gates: executableCommandPath + isCapabilityExecutable, incl. the
    // device-type semantic mappings and multi-command expansions). The old
    // capability∩handler filter answered [] for devices flows happily
    // execute ('lighting-control' on a smart-light) — a misleading
    // pre-flight surface.
    commands: deviceExecutableCommandNames(capabilities, row.type, row.binding),
    zoneId: row.zone_id,
    position: parseJsonObject(row.position_json),
    initialState: parseJsonObject(row.initial_state_json),
    // T-021: explicit sensor/actuator/hybrid classification (absent = the
    // scenario loader infers from capabilities).
    ...(row.role != null ? { role: row.role } : {}),
    // P3b: the deployment binding; mirrors the scenario loader's default.
    binding: row.binding ?? `sim://${row.id}`,
    owner,
    createdAt: row.created_at,
  };
}

/**
 * R5-F12 (fault-injection drill visibility): the model the agent's requests
 * will ACTUALLY be sent as after deployment model normalization
 * (AGENTS.md 部署模型归一化）. When the deployment pins LLM_MODEL it wins
 * over any declared llm.model (the client rewrites mismatching request
 * models at request time); unset, a declared llm.model is used as-is.
 * Undefined when the agent is rule-only (explicit llm:null, T-601) or no
 * model can be determined per-agent (shared default without LLM_MODEL).
 */
function effectiveAgentModel(llmJson: string | null, deployedLlmModel: string | undefined): string | undefined {
  if (llmJson === 'null') return undefined;
  const deployed = deployedLlmModel?.trim();
  if (deployed !== undefined && deployed.length > 0) return deployed;
  const declared = parseJsonObject(llmJson)?.model;
  return typeof declared === 'string' && declared.trim().length > 0 ? declared.trim() : undefined;
}

export function agentToJson(row: AgentInstanceRow, owner: OwnerRef, deployedLlmModel?: string) {
  const effectiveModel = effectiveAgentModel(row.llm_json, deployedLlmModel);
  return {
    id: row.id,
    envId: row.env_id,
    name: row.name,
    capabilities: parseJsonArray<string>(row.capabilities_json),
    boundDeviceIds: parseJsonArray<string>(row.bound_device_ids_json),
    managedZoneIds: parseJsonArray<string>(row.managed_zone_ids_json),
    llm: parseJsonObject(row.llm_json),
    // R5-F12: 归一化后的实际请求模型（缺省不出现——rule-only 或无法按
    // Agent 确定时）。演练者在 API 面当场看到归一化结果。
    ...(effectiveModel !== undefined ? { effectiveModel } : {}),
    // T-021 (EC-F07): scope-of-practice blocklist — capability classes this
    // agent must NOT be selected to deliver (absent = no restriction).
    ...(row.cannot_deliver_classes_json !== null
      ? { cannotDeliverClasses: parseJsonArray<string>(row.cannot_deliver_classes_json) }
      : {}),
    // T-051: per-agent autonomous-decision policy (absent = runtime-wide
    // defaults) — bridged into ScenarioAgent.decisionPolicy at sim creation.
    ...(row.decision_policy_json !== null
      ? { decisionPolicy: parseJsonObject(row.decision_policy_json) ?? undefined }
      : {}),
    // R15 (FR15-F02): default visibility for FUTURE derived services
    // (absent = the T-208 'members' default).
    ...(row.derived_service_visibility !== null
      ? { derivedServiceVisibility: row.derived_service_visibility as 'members' | 'hidden' }
      : {}),
    // Master enable switch (migration v21): false = agent stopped (no
    // injected events, excluded from partner selection).
    enabled: row.enabled === 1,
    owner,
    createdAt: row.created_at,
  };
}

export interface ServiceProviderRef {
  id: string;
  name: string;
  owner: OwnerRef;
}

/**
 * Service instance → API wire shape (W3). `provider` carries the offering
 * agent (with its owner, for the cross-owner visibility story); `unbacked`
 * flags services whose semantic type is not discoverable from the provider's
 * bound devices (see service-store.ts). `reputation` (P4-1) is the learned
 * track record of (provider agent × semantic type): decayed Bayesian score
 * plus raw use counts; services without history carry the prior view.
 *
 * T-310 (DevLoop R12, EN-F11/FR-F04): `consumable` is the consumer-facing
 * reading of `unbacked` — the market must not display undeliverable offers
 * as invokable products. Unbacked rows carry `consumable: false` plus a
 * one-line reason naming the subscribe-instead path.
 *
 * R14 Wave-A (design-data-services.md §8): `computation` — the provider's
 * registered ComputationSpec summary — flips an unbacked service consumable
 * (`consumable = !unbacked || computation registered`): the consumableNote
 * disappears and the read/push lanes deliver evaluation frames. Callers
 * without a serviceStore at hand may omit it (backed-only surfaces).
 */
export interface ServiceComputationSummary {
  kind: string;
  refreshSec: number;
  schemaVersion: number;
  registeredAt: string;
  /** D4 (R28, T-081): true when the spec is the platform's auto-mint (overridable by explicit registration). */
  autoMinted?: boolean;
}

export function serviceToJson(
  row: ServiceInstanceRow,
  provider: ServiceProviderRef,
  unbacked: boolean,
  reputation: ReputationScoreView,
  computation?: ServiceComputationSummary | null,
  /**
   * R80-FW1: resolve a derived row's source-device zone (the market's
   * spatial filter needs one zoneId on every spatially-anchored row).
   * Optional — callers without a store pass nothing and derived rows stay
   * zone-less (same as before this parameter existed).
   */
  deviceZoneOf?: (deviceId: string) => string | undefined,
  /**
   * R101 (trust-visibility ②): the service's verifiable履约摘要 (rolling
   * window, aggregate-only — stranger-safe). Optional so non-market
   * serializers omit it.
   */
  usageSummary?: {
    windowDays: number;
    invocations: number;
    succeeded: number;
    failed: number;
    /** R102: AC 协作的部分达成行（outcome='partial'）。 */
    partial: number;
    /** R102: invocations − succeeded − failed − partial（历史/其他口径行，差额有名有姓）。 */
    other: number;
    successRate: number | null;
  },
  /**
   * T31 (R3 u2-F-04): the AGGREGATE offer's rule-lane backing face — the
   * SAME judgment as the signing gates (assertAggregateDeliverable) and the
   * invoke lane. `backing` is the rule view (kind/rule/actuates/devices/
   * callableActions — the same shape the agreement detail carries); when
   * genuinely unbacked, `missing` carries the diagnosis (missing rule, or
   * required actuation capabilities + bound devices + the shared remedy)
   * and the consumableNote speaks the aggregate remedy instead of the
   * data-service one.
   */
  aggregateBacking?: {
    backing: AggregateRuleBackingView | null;
    missing?: AggregateBackingMissingView;
  },
  /**
   * T28 (R3 u3-F1): DECLARATION drift on a capability-minted row (derived /
   * aggregate / — since T53 (R6 u2-F-1-1) — published) — the provider
   * agent's declared capabilities no longer cover the row's semantic
   * capability (flow rows are exempt: backed by the flow, not the agent's
   * declaration). When true the JSON carries `declaredByProvider: false`;
   * the field is ABSENT when the declaration covers the capability
   * (re-declare → the marker disappears).
   */
  declarationDrift?: boolean,
) {
  const consumable = !unbacked || computation !== undefined && computation !== null;
  // T31: the aggregate unbacked note names WHAT is missing (the rule's
  // actuation capabilities / the bound-device list) and the SAME remedy the
  // 409 SERVICE_NOT_BACKED signing gate teaches.
  const consumableNote = !consumable
    ? aggregateBacking?.missing !== undefined
      ? aggregateBacking.missing.ruleResolved
        ? `no actuation backing — no bound device of the provider agent ` +
          (aggregateBacking.missing.boundDevices.length > 0
            ? `(${aggregateBacking.missing.boundDevices.map(device => `"${device.name}"`).join(', ')})`
            : '(none bound)') +
          ` holds any of the offer rule's actuation capabilities ` +
          `(${aggregateBacking.missing.actuates.join(', ')}) — the offer was likely minted from ` +
          `DECLARED capabilities alone. ${aggregateBacking.missing.remedy}`
        : `matches no semantic offer rule (the semantic type "${row.semantic_type}" is neither a ` +
          `built-in rule nor one of this world's scenario-authored mapData.semanticOfferRules) — ` +
          `the offer is stale. The provider must re-declare the rule (or withdraw the offer)`
      : 'no backing device — nothing can be delivered through invoke/stream yet; subscribe to follow it, or (provider) register a computation to make it readable: POST /api/services/:id/computation'
    : undefined;
  return {
    id: row.id,
    envId: row.env_id,
    name: row.name,
    semanticType: row.semantic_type,
    description: row.description,
    interface: parseJsonObject(row.interface_json) ?? {},
    origin: row.origin,
    sourceDeviceId: row.source_device_id,
    // Mechanism D: the published flow backing an origin='flow' row.
    ...(row.source_flow_id !== null ? { sourceFlowId: row.source_flow_id } : {}),
    // D2 (T-079): the DECLARED zone of a published/flow offer (governance-
    // visible; the standing-ask matcher honors it like a derived service's
    // source-device zone). Absent = zone-less / derived (derived rows derive
    // their zone from sourceDeviceId at read time).
    // R80-FW1: derived rows ALSO resolve their source device's zone here —
    // the market's spatial filter needs one zoneId on every spatially-anchored
    // row, regardless of origin.
    ...(row.zone_id !== null ? { zoneId: row.zone_id } : {}),
    ...(row.zone_id === null && row.source_device_id !== null && deviceZoneOf?.(row.source_device_id) !== undefined
      ? { zoneId: deviceZoneOf(row.source_device_id) }
      : {}),
    visibility: row.visibility,
    unbacked,
    consumable,
    ...(consumableNote !== undefined ? { consumableNote } : {}),
    // T31: the aggregate rule-lane backing (backed) / diagnosis (unbacked).
    ...(aggregateBacking?.backing ? { backing: aggregateBacking.backing } : {}),
    ...(aggregateBacking?.missing ? { backingMissing: aggregateBacking.missing } : {}),
    // T28: declaration drift — the offer stays consumable (the device still
    // executes) but the provider's declared offer surface no longer lists it.
    ...(declarationDrift === true ? { declaredByProvider: false as const } : {}),
    ...(computation !== undefined && computation !== null
      ? { computation }
      : {}),
    provider,
    reputation,
    // R101 (trust-visibility ③): cold-start honesty — a service with zero
    //履约记录 is explicitly marked, never visually identical to a proven
    // one ('none' = 暂无履约记录 / 'established' = 有履约历史).
    trackRecord: reputation.attempts > 0 ? ('established' as const) : ('none' as const),
    // T64 (R6, u2-F-2-4/u4-F14): the口径 note when "暂无履约记录" sits beside
    // a non-empty usage summary — reputation only meters INVOKE outcomes, so
    // a read-type data service can serve hundreds of frames and still read
    // 'none'. Without the note the two faces read as a contradiction.
    ...(reputation.attempts === 0 && (usageSummary?.invocations ?? 0) > 0
      ? {
          trackRecordNote:
            'track record meters INVOKE outcomes only — read-type deliveries (data frames) do not score ' +
            'reputation. This offer has served requests: see usageSummary for its verifiable call volume',
        }
      : {}),
    // T121 (R10-u4): the two ledgers on one card carry their口径 — the
    // reputation row is the provider's ALL-HISTORY invoke ledger (score
    // time-decayed), usageSummary counts the rolling window only. Without
    // the note a reader reconciles `attempts 12` against `usage (last 30d):
    // 5 invocations` and sees a contradiction that is actually a window
    // difference. Present whenever the summary rides the card (the market
    // faces); the non-market serializers that omit usageSummary omit it too.
    ...(usageSummary !== undefined && usageSummary !== null
      ? {
          methodologyNote:
            'methodology: reputation (score/attempts/succeeded) is the provider agent\'s ALL-HISTORY ' +
            'invoke ledger (score time-decayed, per semantic type); usageSummary counts the rolling ' +
            `last-${usageSummary.windowDays}-days window of THIS service only — the two numbers have ` +
            'different denominators and are not expected to reconcile',
        }
      : {}),
    ...(usageSummary !== undefined ? { usageSummary } : {}),
    createdAt: row.created_at,
  };
}

export interface EnvironmentSummaryCounts {
  devices: number;
  agents: number;
  members: number;
  /** Offers visible to the caller (Fix-13, R5 F-03 — marketplace scale). */
  services: number;
  /** T-063(c): zone count — the empty-world signal starts with zones=0. */
  zones: number;
}

export function environmentSummary(
  row: EnvironmentRow,
  owner: OwnerRef,
  counts: EnvironmentSummaryCounts,
  myRole: EnvRole | null,
  /** T-063(c): localized hint when the world is empty (0 zones/devices/agents). */
  emptyWorldHint?: string,
) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mapType: row.map_type,
    visibility: row.visibility,
    owner,
    counts,
    ...(emptyWorldHint !== undefined ? { emptyWorldHint } : {}),
    myRole,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function zonesOf(row: EnvironmentRow): EnvZone[] {
  return parseMapData(row).zones;
}

/**
 * Flow row → API wire shape (user-orchestrated business flows). The trigger
 * and plan columns round-trip the core wire shapes verbatim.
 */
export function flowToJson(row: FlowRow) {
  // T-078 (DevLoop R23): derived prompt-injection flags over the flow's
  // text surface (name/description/plan.goal/delegate questions) — the
  // fields that can reach other viewers' LLM prompts. ABSENT = clean (the
  // common case stays byte-identical); present = flagged, never a
  // rejection (flows are direct-authored by design; see the ruling in
  // docs/flow-authoring.md 治理 section). Derived per read so pattern-table
  // extensions re-flag existing flows automatically.
  const securityFlags = securityFlagsForFlow({
    name: row.name,
    ...(row.description !== '' ? { description: row.description } : {}),
    plan: JSON.parse(row.plan_json) as unknown,
  });
  return {
    id: row.id,
    envId: row.environment_id,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    trigger: JSON.parse(row.trigger_json) as unknown,
    // Mechanism D: the declared input-parameter surface (absent = pre-D flow
    // with no surface).
    ...(row.inputs_json !== null ? { inputs: JSON.parse(row.inputs_json) as unknown } : {}),
    // Mechanism C: the per-flow policy envelope (absent = pre-C flow with no
    // envelope).
    ...(row.policy_json !== null && row.policy_json !== undefined
      ? { policy: JSON.parse(row.policy_json) as unknown }
      : {}),
    // Mechanism B: agent-invocation opt-in (absent = off, the default).
    ...(row.agent_invocable === 1 ? { agentInvocable: true } : {}),
    plan: JSON.parse(row.plan_json) as unknown,
    ...(securityFlags.length > 0 ? { securityFlags } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Flow run ledger row → API wire shape (newest first from FlowStore). */
export function flowRunToJson(row: FlowRunRow) {
  const triggerEvaluation = row.trigger_evaluation_json !== null && row.trigger_evaluation_json !== undefined
    ? JSON.parse(row.trigger_evaluation_json) as { simTimeSec?: number }
    : undefined;
  return {
    id: row.id,
    flowId: row.flow_id,
    simulationId: row.simulation_id,
    triggerKind: row.trigger_kind,
    // UX-14: the trigger's sim time hoisted to the top level — collection
    // scripts read the trigger moment without unwrapping triggerEvaluation.
    // schedule/condition evaluations always carry it; event triggers may
    // not know it, and manual runs / pre-v30 rows have no evaluation at all
    // — null, never absent (R102: the same shape on every row).
    triggerSimTimeSec: triggerEvaluation?.simTimeSec ?? null,
    status: row.status,
    summary: row.summary,
    nodeResults: JSON.parse(row.node_results_json) as unknown,
    // T-061: trigger evaluation detail (path + evaluatedValue + threshold per
    // condition, matched event). Absent on pre-v30 rows.
    ...(triggerEvaluation !== undefined ? { triggerEvaluation } : {}),
    // Mechanism D: the run's effective params (caller values after defaults).
    ...(row.inputs_json !== null && row.inputs_json !== undefined
      ? { inputs: JSON.parse(row.inputs_json) as unknown }
      : {}),
    // Mechanism C: exhaustion escalations ('escalate' mode only; the
    // counterpart of the owner notification).
    ...(row.policy_escalations_json !== null && row.policy_escalations_json !== undefined
      ? { policyEscalations: JSON.parse(row.policy_escalations_json) as unknown }
      : {}),
    // Mechanism B: agent-decision attribution (triggerKind 'agent' runs;
    // (agentId, eventId) joins the run ledger to the decision records).
    ...(row.invoked_by_agent_id !== null && row.invoked_by_agent_id !== undefined
      ? {
          invokedBy: {
            agentId: row.invoked_by_agent_id,
            ...(row.invoked_by_event_id !== null && row.invoked_by_event_id !== undefined
              ? { eventId: row.invoked_by_event_id }
              : {}),
          },
        }
      : {}),
    // T1 (R2, u3-F1): capability-drift annotations — nodes that executed on a
    // capability the assignee no longer DECLARES. Absent on clean runs and
    // pre-v62 rows.
    ...(row.capability_drift_json !== null && row.capability_drift_json !== undefined
      ? { capabilityDrift: JSON.parse(row.capability_drift_json) as unknown }
      : {}),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
