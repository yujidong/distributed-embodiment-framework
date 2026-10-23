/**
 * Proposal rule checker — the deterministic first approval tier
 * (multi-user-simulation-design.md §5.1)
 *
 * Pure validation, no writes: given a proposal kind + payload and the
 * current environment, produce a structured verdict. Rejections carry every
 * issue found (authors fix and resubmit); high-risk proposals are not
 * rejected but FORCE-escalated to the environment owner regardless of what
 * the AI reviewer says (§5.2: 高危一律 escalate).
 *
 * Checks implemented here:
 * - schema / reference integrity — `inject-scenario` fragments are validated
 *   by the core scenario loader (ajv schema + zone/event references) against
 *   a synthetic scenario whose zones are the environment's existing zones;
 *   `install-devices` entries get the same zone and catalog-model checks.
 * - spatial conflicts — devices carrying grid bounds must sit inside their
 *   zone's bounds and must not overlap existing (or sibling proposed)
 *   device bounds.
 * - quotas — the shared devices_per_env budget (quotas.ts), checked as a
 *   rule issue instead of a 429 so the rejection is recorded on the proposal.
 * - capability whitelist — `controls-real-actuator` is never grantable by
 *   proposal; any `hass://` binding marks the proposal high-risk → escalate.
 * - supervised-zone consent gate (T-058a, design-consent-semantics.md §3.2)
 *   — proposals whose zone consent footprint (proposalConsentFootprint)
 *   intersects a consentClass='supervised' zone force-escalate to the env
 *   owner; AI review runs as advisor there (escalateWithAiAdvisory).
 * - prompt-injection gate (S1/Task 2b) — payloads whose strings (values or
 *   keys) trip the canonical core detector (the same pattern table the
 *   prompt sanitizer uses) are high-risk and force-escalate BEFORE any LLM
 *   verdict; no auto-apply path can fire past them.
 */

import {
  capabilityMatches,
  detectPromptInjection,
  loadScenarioFile,
  multiCommandNamesForDeviceType,
  ScenarioValidationError,
  validateFlow,
  type FlowDefinition,
  type PlanIssue,
  type PromptInjectionMarker,
} from '@active-collaboration/core';
import { acceptedParameterNames, isCapabilityExecutable } from '@active-collaboration/simulation';

import type { CatalogStore } from './db/catalog-store.js';
import { derivedServiceSpecs } from './db/service-store.js';
import { MAX_FLOWS_PER_ENV } from './db/flow-store.js';
import {
  parseJsonArray,
  parseJsonObject,
  parseMapData,
  ZONE_CONSENT_CLASSES,
  type AgentInstanceRow,
  type DeviceInstanceRow,
  type EnvironmentRow,
  type EnvironmentStore,
  type EnvZone,
  type ZoneConsentClass,
} from './db/environment-store.js';
import type { SandboxRow } from './db/sandbox-store.js';
import type { ProposalKind, ProposalRiskLevel } from './db/proposal-store.js';
import { environmentToScenario } from './environment-bridge.js';
import { ApiError } from './errors.js';
import { checkAdoptConfig } from './proposal-rules-adopt-config.js';
import type { NormalizedAdoptArtifact } from './proposal-rules-adopt-config.js';
// C3 (R42-B): the ownership-transfer surface (same split pattern).
import { checkOwnershipTransfer } from './proposal-rules-ownership-transfer.js';
import type { NormalizedOwnershipTransfer } from './proposal-rules-ownership-transfer.js';
// R22 P2F split: the adopt-config surface re-exports from its module (route/proposal-service imports stay stable).
export {
  ADOPT_CONFIG_ARTIFACT_TYPES,
  HIGH_RISK_ADOPT_ARTIFACT_THRESHOLD,
  assertAdoptConfigArtifactTypes,
} from './proposal-rules-adopt-config.js';
export type { AdoptConfigArtifactType } from './proposal-rules-adopt-config.js';
import { validateDevicePositionForEnv } from './geo.js';
import { parseComputationSpec } from './computation-evaluator.js';
import {
  applyHumanReviewPolicy,
  resolveHumanReviewThresholds,
  type HumanReviewThresholds,
} from './proposal-human-review-policy.js';
import type { QuotaConfig } from './quotas.js';

/** Capabilities a proposal may never declare (real-actuation class, §5.1). */
export const FORBIDDEN_CAPABILITIES: readonly string[] = ['controls-real-actuator'];

/** Above this many devices in one proposal the change is high-risk (§5.2). */
export const HIGH_RISK_DEVICE_THRESHOLD = 10;

/** Above this many zones in one proposal the change is high-risk (T-055). */
export const HIGH_RISK_ZONE_THRESHOLD = 20;

/** T-077: the zone-claim rationale length bound (it renders in decide surfaces). */
export const ZONE_CLAIM_RATIONALE_MAX_CHARS = 2000;

/**
 * S1 (Task 2b): at most this many injection-marker evidences are named in
 * the escalate reason (the list stays readable; the count stays honest).
 */
export const INJECTION_MARKER_EVIDENCE_LIMIT = 5;

export interface RuleCheckContext {
  envStore: EnvironmentStore;
  catalogStore: CatalogStore;
  quotas: QuotaConfig;
  /**
   * S1 (Task 3): deployment-level human-review breadth thresholds
   * (PROPOSAL_HUMAN_REVIEW_* env vars; default all-zero = classes disarmed).
   * A per-env owner override (mapData.governance.humanReview) wins field by
   * field — resolved inside checkProposalRules against the env at hand.
   */
  humanReviewThresholds?: HumanReviewThresholds;
  /**
   * T-209: optional cascade-warning sources for remove-agents (bound flows).
   * Duck-typed structural deps — absent in minimal contexts (tests), the
   * warnings degrade to "unknown" instead of blocking.
   */
  flowStore?: {
    listByEnvironment(envId: string): Array<{
      id: string; name: string; plan_json: string; trigger_json: string; created_by: string | null;
    }>;
  };
  /**
   * T-049: cascade-warning sources for remove-agents (agreements +
   * subscriptions destroyed by the FK cascade). Duck-typed like flowStore —
   * absent in minimal contexts, the warnings degrade instead of blocking.
   * T-403 (R19) adds the fields the modify-object derivation-cascade warning
   * reads (all optional so minimal fakes keep compiling).
   */
  agreementStore?: {
    agreementsOfProviderAgent(agentId: string): Array<{
      id: string; status: string; consumer_owner_id: string; consumer_agent_id: string | null;
      service_id?: string | null;
    }>;
  };
  serviceStore?: {
    servicesOfAgent(agentId: string): Array<{
      id: string;
      name?: string;
      origin?: string;
      source_device_id?: string | null;
      semantic_type?: string;
    }>;
    countSubscriptionsOfService(serviceId: string): number;
    /**
     * P2F §11.3 (adopt-config computation-spec artifacts): the service row +
     * its current computation, for environment-alignment checks. Optional so
     * minimal fakes keep compiling — absent → computation artifacts cannot
     * resolve their target and are rejected with teaching.
     */
    getService?(serviceId: string):
      | {
          id: string;
          env_id: string;
          provider_agent_id: string;
          origin: string;
          interface_json: string;
        }
      | undefined;
    computationOf?(serviceId: string):
      | { service_id: string; kind: string; spec_json: string; schema_version: number }
      | undefined;
  };
  /**
   * P2F (living-worlds §11, adopt-config): fork-row lookup for the
   * sourceFork lineage verification (the fork must belong to THIS env).
   * Absent in minimal contexts → adopt-config sourceFork checks degrade to
   * shape-only (submitting through a context without it is a harness smell).
   */
  sandboxStore?: {
    get(forkId: string): Pick<SandboxRow, 'id' | 'env_id' | 'created_at' | 'fork_base_json' | 'owner_id' | 'status'> | undefined;
  };
  /**
   * P2F §11.2: evidence validation — the eval-run row an adopt-config cites
   * must exist and belong to this env. Optional duck-type.
   */
  evalRunStore?: {
    get(id: string): { env_id: string; status: string } | undefined;
  };
  /**
   * C3 (R42-B, ownership-transfer): toUser resolution (userId | email) and
   * existence. Optional duck-type — absent (minimal test contexts) means a
   * transfer proposal cannot resolve its recipient and is rejected with
   * teaching, the adopt-config sandboxStore precedent.
   */
  userStore?: {
    findById(id: string): { id: string } | undefined;
    findByEmail(email: string): { id: string } | undefined;
  };
}

/** A proposed device after normalization (model defaults resolved). */
export interface NormalizedProposedDevice {
  name: string;
  type: string;
  brand: string | null;
  capabilities: string[];
  zoneId: string;
  position: Record<string, unknown> | null;
  initialState: Record<string, unknown> | null;
  /** Explicit binding from the payload; null = the sim:// default. */
  binding: string | null;
}

/** A proposed agent after normalization (Fix-7 install-agents). */
export interface NormalizedProposedAgent {
  name: string;
  capabilities: string[];
  boundDeviceIds: string[];
  managedZoneIds: string[];
  /**
   * T-601 (R26): undefined = not authored (shared-client fall-through),
   * null = explicit rule-only opt-out, object = per-agent llm block.
   */
  llm: Record<string, unknown> | null | undefined;
  /**
   * T-604 (R26, HO26-F01): scope-of-practice blocklist at install —
   * undefined = absent, null/[] = explicitly clear, else the class list.
   */
  cannotDeliverClasses: string[] | null | undefined;
  /**
   * T-051: per-agent autonomous-decision policy
   * ({ autoActuateIndependent?, autoInitiateAC? }); null keeps defaults.
   */
  decisionPolicy: Record<string, unknown> | null;
  /**
   * R15 (FR15-F02): default visibility for the agent's FUTURE derived
   * services ('members' | 'hidden'; null = the T-208 'members' default) —
   * declared at install so sensitive derivations are born hidden.
   */
  derivedServiceVisibility: 'members' | 'hidden' | null;
  /**
   * Zone footprint (§5.3 autonomy): managed zones + the zones of the bound
   * devices. Empty = no determinable footprint → never autonomy-eligible.
   */
  zoneIds: string[];
}

/** A proposed zone after validation (T-055 install-zones). */
export interface NormalizedProposedZone {
  id: string;
  name?: string;
  type?: string;
  /**
   * R15 (CP-F01/DB-F01/FR15-F01): ONLY settable through the owner-direct
   * zone-create route (validateProposedZones `{allowConsentClass:true}`) —
   * a proposal never arms consent classes (owner-authored governance
   * metadata, design-consent-semantics.md §3.1).
   */
  consentClass?: ZoneConsentClass;
  /** Grid maps: rectangular world footprint (validated like PATCH mapData). */
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
  /** Geo maps: [lat, lng] ring. */
  polygon?: [number, number][];
  adjacentZoneIds?: string[];
  baseline?: Record<string, number | boolean>;
}

/** A validated modify-object target + normalized patch (Fix-7 real apply). */
export interface ModifyTarget {
  objectType: 'device' | 'agent';
  id: string;
  /** Only validated, supported fields — applied verbatim via the store. */
  patch: Record<string, unknown>;
  /**
   * T-058a: the target's zone footprint AFTER the patch — the device's
   * current zone + patch.zoneId when it moves; an agent's (patched) managed
   * zones + the zones of its (patched) bound devices. Computed here (the
   * envStore is at hand) so `proposalConsentFootprint` stays a pure read of
   * already-resolved structures.
   */
  zoneIds: string[];
}

export interface RuleCheckResult {
  ok: boolean;
  issues: string[];
  /** T-209: NON-blocking cascade notes (surfaced on the proposal, never gate it). */
  warnings: string[];
  riskLevel: ProposalRiskLevel;
  /** True when a rule demands owner review regardless of the AI verdict. */
  forceEscalate: boolean;
  escalateReason?: string;
  /**
   * T-058a (design-consent-semantics.md §3.2): true when the escalation is a
   * SUPERVISED-ZONE consent gate — AI review still runs as ADVISOR (its
   * verdict lands on aiReview for the deciding owner) instead of being
   * skipped like the §5.2 hard high-risk markers (hass://, oversized
   * batches). "AI 是建议者" as mechanism: the review runs, but its verdict
   * can neither auto-apply nor veto — the environment owner decides.
   */
  escalateWithAiAdvisory?: boolean;
  /** Devices normalized during checking; the apply step reuses them. */
  devices: NormalizedProposedDevice[];
  /** Agents normalized during checking (install-agents only). */
  agents: NormalizedProposedAgent[];
  /** Zones normalized during checking (T-055 install-zones only). */
  zones: NormalizedProposedZone[];
  /** Device rows validated for removal (remove-devices only). */
  removedDevices: DeviceInstanceRow[];
  /** Agent rows validated for removal (T-209 remove-agents only). */
  removedAgents: AgentInstanceRow[];
  /** Validated modify-object target (modify-object only). */
  modifyTarget: ModifyTarget | null;
  /** Scenario events validated during checking (inject-scenario only). */
  events: Record<string, unknown>[];
  /** Overlay expiry parsed from payload.effectiveUntil (inject-scenario). */
  expiresAt: string | null;
  /**
   * P2F §11 (adopt-config): the validated promotable artifacts — the apply
   * step reuses them verbatim (same normalization discipline as devices/
   * agents/zones). Empty for every other kind.
   */
  adoptArtifacts: NormalizedAdoptArtifact[];
  /**
   * C3 (R42-B, ownership-transfer): the validated transfers — the apply
   * step consumes them verbatim. Empty for every other kind.
   */
  ownershipTransfers: NormalizedOwnershipTransfer[];
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Run every deterministic rule for a proposal. Never throws on bad input. */
export function checkProposalRules(
  ctx: RuleCheckContext,
  env: EnvironmentRow,
  kind: ProposalKind,
  payload: unknown,
  authorId: string,
): RuleCheckResult {
  const issues: string[] = [];
  const result: RuleCheckResult = {
    ok: false,
    issues,
    warnings: [],
    riskLevel: 'low',
    forceEscalate: false,
    devices: [],
    agents: [],
    zones: [],
    removedDevices: [],
    removedAgents: [],
    modifyTarget: null,
    events: [],
    expiresAt: null,
    adoptArtifacts: [],
    ownershipTransfers: [],
  };
  if (!isPlainObject(payload)) {
    issues.push('payload must be an object');
    return result;
  }

  switch (kind) {
    case 'install-devices':
      checkInstallDevices(ctx, env, payload, result);
      break;
    case 'install-agents':
      checkInstallAgents(ctx, env, authorId, payload, result);
      break;
    case 'install-zones':
      checkInstallZones(ctx, env, payload, result);
      break;
    case 'remove-agents':
      checkRemoveAgents(ctx, env, authorId, payload, result);
      break;
    case 'remove-devices':
      checkRemoveDevices(ctx, env, authorId, payload, result);
      break;
    case 'inject-scenario':
      checkInjectScenario(ctx, env, payload, result);
      break;
    case 'modify-object':
      checkModifyObject(ctx, env, authorId, payload, result);
      break;
    case 'zone-claim':
      checkZoneClaim(env, payload, issues, result);
      break;
    case 'adopt-config':
      checkAdoptConfig(ctx, env, payload, result);
      break;
    // C3 (R42-B): ownership-transfer — same split-module pattern as
    // adopt-config (proposal-rules-ownership-transfer.ts).
    case 'ownership-transfer':
      checkOwnershipTransfer(ctx, env, authorId, payload, result);
      break;
  }

  // T-058a: the supervised-zone consent gate runs after the kind checks (and
  // only over otherwise-valid proposals — a rejected proposal never needs a
  // consent verdict). OR-composed with the pre-existing forceEscalate
  // markers; each rule names itself in escalateReason (T-302 lesson).
  if (issues.length === 0) {
    checkZoneConsent(env, kind, payload, result);
  }

  // S1 (Task 2b): the prompt-injection gate — payloads whose strings trip
  // the canonical detector (same pattern table the prompt sanitizer uses)
  // force-escalate BEFORE any LLM verdict: the review model is the attack
  // TARGET, so it is never asked to judge its own injection. No auto-apply
  // path can fire past a forceEscalate proposal.
  if (issues.length === 0) {
    checkPayloadInjection(payload, result);
  }

  // S1 (Task 3): the owner-tunable human-review breadth classes (agent
  // fleets, event overlays, cross-zone footprints). Per-env owner override
  // (mapData.governance.humanReview) over the deployment defaults; default
  // = all classes disarmed (current behavior preserved).
  if (issues.length === 0) {
    const thresholds = resolveHumanReviewThresholds(env, ctx.humanReviewThresholds);
    applyHumanReviewPolicy(kind, payload, result, thresholds);
  }

  result.ok = issues.length === 0;
  return result;
}

/**
 * S1: deep-walk a proposal payload (values AND keys) through the canonical
 * core detector. Collects markers with capped evidence for the escalate
 * reason. Never throws; never blocks on non-string leaves.
 */
export function collectPayloadInjectionMarkers(value: unknown): PromptInjectionMarker[] {
  const acc: PromptInjectionMarker[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const marker of detectPromptInjection(node)) acc.push(marker);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        for (const marker of detectPromptInjection(key)) acc.push(marker);
        walk(val);
      }
    }
  };
  walk(value);
  return acc;
}

/**
 * S1: the injection-marker gate — any marker in the payload forces
 * riskLevel high + owner escalation (hard, not AI-advisory: the AI is the
 * attack target). OR-composed with earlier markers; names itself.
 */
export function checkPayloadInjection(
  payload: Record<string, unknown>,
  result: RuleCheckResult,
): void {
  const markers = collectPayloadInjectionMarkers(payload);
  if (markers.length === 0) return;
  const shown = markers
    .slice(0, INJECTION_MARKER_EVIDENCE_LIMIT)
    .map(marker => `${marker.id}: ${marker.evidence}`)
    .join('; ');
  const more = markers.length > INJECTION_MARKER_EVIDENCE_LIMIT
    ? ` (+${markers.length - INJECTION_MARKER_EVIDENCE_LIMIT} more)`
    : '';
  const reason =
    `payload carries prompt-injection markers (${shown}${more}) — ` +
    'never auto-applied; the environment owner must review';
  const prior = result.escalateReason;
  result.riskLevel = 'high';
  result.forceEscalate = true;
  result.escalateReason = prior !== undefined ? `${prior}; ${reason}` : reason;
}

// ---------------------------------------------------------------------------
// install-devices
// ---------------------------------------------------------------------------

/**
 * T-610 (R26, RT26-F02): NON-blocking executability warnings for proposed
 * devices. A device whose declared capabilities include NO executable
 * command path lands with `commands: []` — a dead-end visible only by
 * inspecting the row (the flow lane already 422s "capability has no
 * handler"; the device lane was silent). Telemetry-only declarations are
 * legitimate for sensors (derived services read them), so this is a
 * WARNING, never an issue; hass://-bound devices are real hardware
 * (exempt). A device with at least one executable capability carries no
 * warning — it can do something.
 */
function deviceExecutabilityWarnings(devices: NormalizedProposedDevice[]): string[] {
  const warnings: string[] = [];
  for (const device of devices) {
    if (device.binding !== null && device.binding.startsWith('hass://')) continue;
    if (device.capabilities.some(capability => isCapabilityExecutable(capability))) continue;
    if (device.capabilities.length === 0) {
      warnings.push(
        `device "${device.name}" declares no capabilities — it will land with commands: [] and cannot ` +
        'actuate or feed derived services; add capabilities (telemetry for sensors, handler-backed for actuation)',
      );
      continue;
    }
    warnings.push(
      `device "${device.name}": none of its declared capabilities (${device.capabilities.join(', ')}) ` +
      'has an executable command path — the device will land with commands: [] and cannot actuate. ' +
      'Telemetry/derived-service semantics are legitimate for sensors, but flow actuation and ' +
      'command-driven agreements need handler-backed capabilities. Common executable spellings: ' +
      'turn-on, turn-off, toggle, set-power, set-temperature, set-brightness, set-mode, cooling, ' +
      'heating, open, close, lock, unlock',
    );
  }
  return warnings;
}

/**
 * C2 (R25-NF3, DevLoop R28): the derived-service agent-binding hint. A
 * device install alone publishes NOTHING — derived services mint from the
 * agent side (agent capabilities ∩ bound devices), and a freshly installed
 * device is bound to no agent by construction (bindings reference existing
 * device ids; install-devices payloads cannot carry them). R25's provider
 * story died exactly here: device applied → no service → no hint. The hint
 * rides the T-610 warnings pattern (non-blocking, on the rule-check result
 * and every surface that serializes it) and the direct owner-create
 * response (env-objects).
 */
export function deviceAgentBindingHint(deviceName: string): string {
  return (
    `device "${deviceName}" has no bound agent — installing it does not publish its derived service: ` +
    'the service mints when an agent BINDS it (agent capabilities ∩ bound devices). Bind it via ' +
    'POST /api/environments/:id/agents {boundDeviceIds:[...]}, an install-agents proposal, or ' +
    `modify-object on an existing agent (${JSON.stringify({ targetId: '<agentId>', patch: { boundDeviceIds: ['<thisDevice>'] } })})`
  );
}

/**
 * C2 wrapper for install-devices: one hint per device that could ever mint
 * (has capabilities). Zero-capability devices get the T-610 no-capabilities
 * teaching instead — a device with nothing to derive needs no binding hint.
 */
function deviceAgentBindingHints(devices: NormalizedProposedDevice[]): string[] {
  return devices
    .filter(device => device.capabilities.length > 0)
    .map(device => deviceAgentBindingHint(device.name));
}

function checkInstallDevices(
  ctx: RuleCheckContext,
  env: EnvironmentRow,
  payload: Record<string, unknown>,
  result: RuleCheckResult,
): void {
  const rawDevices = requireDeviceArray(payload.devices, 'payload.devices', result.issues);
  if (rawDevices === null || rawDevices.length === 0) {
    if (rawDevices !== null) result.issues.push('payload.devices must not be empty');
    return;
  }
  result.devices = normalizeDevices(ctx, env, rawDevices, result.issues);
  checkSpatial(env, result.devices, ctx.envStore, result.issues);
  checkDeviceQuota(ctx, env, result.devices.length, result.issues);
  applyRiskRules(result);
  // T-610: rides the rule-check result (and every surface that serializes
  // it — the proposal JSON and the applied response).
  result.warnings.push(...deviceExecutabilityWarnings(result.devices));
  // C2 (R25-NF3): the derived-service binding hint — a device lands with no
  // agent bound, and unbound devices publish nothing.
  result.warnings.push(...deviceAgentBindingHints(result.devices));
}

// ---------------------------------------------------------------------------
// install-agents (Fix-7)
// ---------------------------------------------------------------------------

function checkInstallAgents(
  ctx: RuleCheckContext,
  env: EnvironmentRow,
  authorId: string,
  payload: Record<string, unknown>,
  result: RuleCheckResult,
): void {
  const issues = result.issues;
  if (!Array.isArray(payload.agents)) {
    issues.push('payload.agents must be an array');
    return;
  }
  if (payload.agents.length === 0) {
    issues.push('payload.agents must not be empty');
    return;
  }
  const zones = parseMapData(env).zones;
  payload.agents.forEach((raw, index) => {
    const path = `agents[${index}]`;
    if (!isPlainObject(raw)) {
      issues.push(`${path} must be an object`);
      return;
    }
    if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
      issues.push(`${path}.name must be a non-empty string`);
    }
    let capabilities: string[] = [];
    if (!Array.isArray(raw.capabilities) || raw.capabilities.some(c => typeof c !== 'string')) {
      issues.push(`${path}.capabilities must be an array of strings`);
    } else {
      capabilities = raw.capabilities as string[];
      checkCapabilityWhitelist(capabilities, path, issues);
    }

    // 设备私有原则: an agent may only bind devices OWNED BY THE AUTHOR —
    // binding someone else's device would leak its capabilities into the
    // author's derived services.
    const boundDeviceIds: string[] = [];
    const deviceZoneIds: string[] = [];
    if (raw.boundDeviceIds !== undefined) {
      if (!Array.isArray(raw.boundDeviceIds) || raw.boundDeviceIds.some(id => typeof id !== 'string')) {
        issues.push(`${path}.boundDeviceIds must be an array of strings`);
      } else {
        for (const deviceId of raw.boundDeviceIds as string[]) {
          const device = ctx.envStore.getDevice(deviceId);
          if (!device || device.env_id !== env.id) {
            issues.push(`${path}.boundDeviceIds references unknown device "${deviceId}" in this environment`);
          } else if (device.owner_id !== authorId) {
            issues.push(
              `${path}.boundDeviceIds: device "${device.name}" (${deviceId}) is owned by another user — ` +
              'agents may only bind their author\'s own devices',
            );
          } else {
            if (!boundDeviceIds.includes(deviceId)) boundDeviceIds.push(deviceId);
            deviceZoneIds.push(device.zone_id);
          }
        }
      }
    }

    const managedZoneIds: string[] = [];
    if (raw.managedZoneIds !== undefined) {
      if (!Array.isArray(raw.managedZoneIds) || raw.managedZoneIds.some(id => typeof id !== 'string')) {
        issues.push(`${path}.managedZoneIds must be an array of strings`);
      } else {
        for (const zoneId of raw.managedZoneIds as string[]) {
          if (!zones.some(zone => zone.id === zoneId)) {
            issues.push(`${path}.managedZoneIds references unknown zone "${zoneId}"`);
          } else if (!managedZoneIds.includes(zoneId)) {
            managedZoneIds.push(zoneId);
          }
        }
      }
    }

    // T-601 (R26): absent stays undefined (legacy shared-client fall-through
    // at runtime); an explicit null is the rule-only opt-out and persists as
    // such; an object is a per-agent llm block.
    let llm: Record<string, unknown> | null | undefined = undefined;
    if (raw.llm !== undefined) {
      if (raw.llm === null) {
        llm = null;
      } else if (!isPlainObject(raw.llm)) {
        issues.push(`${path}.llm must be an object or null`);
      } else {
        llm = raw.llm;
      }
    }

    // T-051: optional per-agent decision policy (closed boolean shape —
    // same fields the core scenario loader whitelists).
    const decisionPolicy = checkDecisionPolicy(raw.decisionPolicy, `${path}.decisionPolicy`, issues);

    // T-604 (R26, HO26-F01): scope-of-practice blocklist accepted at
    // install — the pharmacy-agent persona (T-021) needs it at birth, not
    // only via the owner PATCH lane. null/[] clears (no restriction);
    // classes are free-form by T-021 design (no vocabulary gate).
    let cannotDeliverClasses: string[] | null | undefined = undefined;
    if (raw.cannotDeliverClasses !== undefined) {
      if (raw.cannotDeliverClasses === null) {
        cannotDeliverClasses = null;
      } else if (
        !Array.isArray(raw.cannotDeliverClasses) ||
        raw.cannotDeliverClasses.some(c => typeof c !== 'string' || c.trim().length === 0)
      ) {
        issues.push(`${path}.cannotDeliverClasses must be an array of non-empty strings (or null to clear)`);
      } else {
        cannotDeliverClasses = raw.cannotDeliverClasses as string[];
      }
    }

    // R15 (FR15-F02): optional default visibility for the agent's FUTURE
    // derived services — closed enum, silently-dropped typos would reopen
    // the leak window the field exists to close.
    let derivedServiceVisibility: 'members' | 'hidden' | null = null;
    if (raw.derivedServiceVisibility !== undefined) {
      if (
        raw.derivedServiceVisibility !== 'members' &&
        raw.derivedServiceVisibility !== 'hidden'
      ) {
        issues.push(
          `${path}.derivedServiceVisibility must be one of "members" | "hidden" — got ` +
            `${JSON.stringify(raw.derivedServiceVisibility)} ('hidden' derives future services ` +
          'hidden from the first moment; absent keeps the members default, and per-service ' +
          'PATCH visibility still overrides on surviving rows)',
        );
      } else {
        derivedServiceVisibility = raw.derivedServiceVisibility;
      }
    }

    // T-206: declared capabilities must be backed by the (validated, author-
    // owned) bound devices — same matcher as the flow runtime.
    checkCapabilityBacking(
      capabilities,
      boundDeviceIds.map(id => ctx.envStore.getDevice(id)!).filter(row => row !== undefined),
      `${path}.capabilities`,
      issues,
    );

    result.agents.push({
      name: typeof raw.name === 'string' ? raw.name.trim() : '',
      capabilities,
      boundDeviceIds,
      managedZoneIds,
      llm,
      cannotDeliverClasses,
      decisionPolicy,
      derivedServiceVisibility,
      zoneIds: [...new Set([...managedZoneIds, ...deviceZoneIds])],
    });
  });
  checkAgentQuota(ctx, env, result.agents.length, issues);
}

// ---------------------------------------------------------------------------
// remove-devices (Fix-7)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// install-zones (T-055)
// ---------------------------------------------------------------------------

/**
 * Governed zone creation: `{ zones: [{ id, name?, type?, bounds?, polygon?,
 * adjacentZoneIds?, baseline? }] }`. Validation mirrors the owner-only
 * PATCH mapData path (bounds completeness + degeneracy, unique ids,
 * adjacency references) plus the shared zones-per-env quota; apply merges
 * the zones into mapData, revert removes them while still empty.
 */
function checkInstallZones(
  ctx: RuleCheckContext,
  env: EnvironmentRow,
  payload: Record<string, unknown>,
  result: RuleCheckResult,
): void {
  const issues = result.issues;
  if (!Array.isArray(payload.zones)) {
    issues.push('payload.zones must be an array');
    return;
  }
  if (payload.zones.length === 0) {
    issues.push('payload.zones must not be empty');
    return;
  }
  const verdict = validateProposedZones(env, payload.zones, ctx.quotas.maxZonesPerEnv);
  issues.push(...verdict.issues);
  if (issues.length > 0) return;

  const zones = verdict.zones;
  result.zones = zones;
  if (zones.length >= HIGH_RISK_ZONE_THRESHOLD) {
    result.riskLevel = 'high';
    result.forceEscalate = true;
    result.escalateReason =
      `proposal creates ${zones.length} zones at once (>= ${HIGH_RISK_ZONE_THRESHOLD}) - the environment owner must decide`;
  }
}

/**
 * T-055: the zone-validation core shared by the proposal rule check and the
 * OWNER-direct create route (POST /api/environments/:id/zones) — one
 * validator, two approval tiers, no drift. Pure: returns normalized zones
 * plus every issue found instead of throwing.
 *
 * R15 (CP-F01): `opts.allowConsentClass` (owner-direct route only) accepts
 * and validates `consentClass`; the default (proposal path) REJECTS it —
 * consent classes are owner-authored governance metadata, never proposable.
 */
export function validateProposedZones(
  env: EnvironmentRow,
  rawZones: unknown[],
  maxZones: number,
  opts: { allowConsentClass?: boolean } = {},
): { zones: NormalizedProposedZone[]; issues: string[] } {
  const issues: string[] = [];
  const existing = parseMapData(env).zones;
  const existingIds = new Set(existing.map(zone => zone.id));
  const proposedIds = new Set<string>();
  const zones: NormalizedProposedZone[] = [];

  rawZones.forEach((raw, index) => {
    const path = `zones[${index}]`;
    if (!isPlainObject(raw)) {
      issues.push(`${path} must be an object`);
      return;
    }
    if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
      issues.push(`${path}.id must be a non-empty string`);
      return;
    }
    const id = raw.id.trim();
    if (existingIds.has(id)) {
      issues.push(`${path}.id "${id}" already exists in this environment`);
      return;
    }
    if (proposedIds.has(id)) {
      issues.push(`${path}.id "${id}" is duplicated inside payload.zones`);
      return;
    }
    proposedIds.add(id);

    const zone: NormalizedProposedZone = { id };
    if (raw.name !== undefined) {
      if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
        issues.push(`${path}.name must be a non-empty string when provided`);
      } else {
        zone.name = raw.name.trim();
      }
    }
    if (raw.type !== undefined) {
      if (typeof raw.type !== 'string' || raw.type.trim().length === 0) {
        issues.push(`${path}.type must be a non-empty string when provided`);
      } else {
        zone.type = raw.type.trim();
      }
    }
    // R15 (CP-F01): consentClass is owner-authored governance metadata —
    // a proposal (any author) may not arm it; the owner-direct route opts
    // in via {allowConsentClass:true} with the same enum validation as the
    // mapData PATCH path (one truth, no drift).
    if (raw.consentClass !== undefined) {
      if (opts.allowConsentClass !== true) {
        issues.push(
          `${path}.consentClass ("${String(raw.consentClass)}") cannot ride a proposal — ` +
          'zone consent classes are owner-authored governance metadata (design-consent-semantics.md §3.1); ' +
          'submit the zone without it and ask the environment owner to arm it afterwards via ' +
          'PATCH /api/environments/{id} (mapData) — or the owner can create the zone directly with ' +
          'consentClass on POST /api/environments/{id}/zones',
        );
      } else if (
        typeof raw.consentClass !== 'string' ||
        !(ZONE_CONSENT_CLASSES as readonly string[]).includes(raw.consentClass)
      ) {
        issues.push(
          `${path}.consentClass must be one of ` +
            `${ZONE_CONSENT_CLASSES.map(c => `"${c}"`).join(' | ')} — got "${String(raw.consentClass)}" ` +
          "('supervised' zones always escalate proposals touching them to the environment owner; " +
          "'restricted' is reserved for future multi-person consent)",
        );
      } else {
        zone.consentClass = raw.consentClass as ZoneConsentClass;
      }
    }
    // Bounds: same rules as the owner-only PATCH mapData path
    // (environments.ts parseMapDataInput) - complete + non-degenerate.
    if (raw.bounds !== undefined) {
      const b = raw.bounds as Record<string, unknown>;
      const required = ['minX', 'maxX', 'minY', 'maxY'];
      const missing = required.filter(key => typeof b[key] !== 'number' || !Number.isFinite(b[key] as number));
      if (missing.length > 0) {
        issues.push(
          `${path}.bounds is incomplete - missing: ${missing.map(f => `"${f}"`).join(', ')}. ` +
          'Bounds require all four numeric fields: minX, maxX, minY, maxY',
        );
      } else if ((b.minX as number) >= (b.maxX as number) || (b.minY as number) >= (b.maxY as number)) {
        issues.push(`${path}.bounds is degenerate - minX must be < maxX and minY < maxY`);
      } else {
        zone.bounds = { minX: b.minX as number, maxX: b.maxX as number, minY: b.minY as number, maxY: b.maxY as number };
      }
    }
    // Geo tier: polygon ring (>= 3 [lat, lng] points).
    if (raw.polygon !== undefined) {
      if (
        !Array.isArray(raw.polygon) || raw.polygon.length < 3 ||
        raw.polygon.some(point => !Array.isArray(point) || point.length !== 2 ||
          typeof point[0] !== 'number' || typeof point[1] !== 'number' ||
          !Number.isFinite(point[0]) || !Number.isFinite(point[1]))
      ) {
        issues.push(`${path}.polygon must be an array of at least 3 [lat, lng] number pairs`);
      } else {
        zone.polygon = raw.polygon as [number, number][];
      }
    }
    if (raw.adjacentZoneIds !== undefined) {
      if (!Array.isArray(raw.adjacentZoneIds) || raw.adjacentZoneIds.some(zid => typeof zid !== 'string')) {
        issues.push(`${path}.adjacentZoneIds must be an array of strings`);
      } else {
        const adjacency: string[] = [];
        for (const zoneId of raw.adjacentZoneIds as string[]) {
          if (!existingIds.has(zoneId) && !proposedIds.has(zoneId)) {
            issues.push(
              `${path}.adjacentZoneIds references unknown zone "${zoneId}" ` +
              '(only existing zones or zones proposed in the same payload are adjacency candidates)',
            );
          } else if (!adjacency.includes(zoneId)) {
            adjacency.push(zoneId);
          }
        }
        if (adjacency.length > 0) zone.adjacentZoneIds = adjacency;
      }
    }
    if (raw.baseline !== undefined) {
      if (!isPlainObject(raw.baseline) ||
          Object.values(raw.baseline).some(value => typeof value !== 'number' && typeof value !== 'boolean')) {
        issues.push(`${path}.baseline must be an object of number|boolean values`);
      } else {
        zone.baseline = raw.baseline as Record<string, number | boolean>;
      }
    }
    zones.push(zone);
  });

  if (issues.length > 0) return { zones: [], issues };

  // Quota: the shared zones-per-env budget, as a rule issue (recorded on
  // the proposal) instead of a 429.
  if (existing.length + zones.length > maxZones) {
    issues.push(
      `quota exceeded: this environment has ${existing.length} zone(s); adding ${zones.length} more ` +
      `would exceed the ${maxZones}-zone budget (QUOTA_MAX_ZONES_PER_ENV)`,
    );
    return { zones: [], issues };
  }
  return { zones, issues };
}

function checkRemoveDevices(
  ctx: RuleCheckContext,
  env: EnvironmentRow,
  authorId: string,
  payload: Record<string, unknown>,
  result: RuleCheckResult,
): void {
  const issues = result.issues;
  if (!Array.isArray(payload.deviceIds)) {
    issues.push('payload.deviceIds must be an array');
    return;
  }
  if (payload.deviceIds.length === 0) {
    issues.push('payload.deviceIds must not be empty');
    return;
  }
  const agents = ctx.envStore.agentsOf(env.id);
  payload.deviceIds.forEach((raw, index) => {
    const path = `deviceIds[${index}]`;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      issues.push(`${path} must be a non-empty string`);
      return;
    }
    const device = ctx.envStore.getDevice(raw);
    if (!device || device.env_id !== env.id) {
      issues.push(`${path} references unknown device "${raw}" in this environment`);
      return;
    }
    if (device.owner_id !== authorId) {
      issues.push(`${path} ("${device.name}") is owned by another user — only the device owner may remove it`);
      return;
    }
    // Removal REFUSES bound devices instead of silently unbinding: the
    // binding (and its derived services) is another world object whose loss
    // must be an explicit, separately-governed change (modify-object).
    const boundAgent = agents.find(agent =>
      parseJsonArray<string>(agent.bound_device_ids_json).includes(device.id),
    );
    if (boundAgent) {
      issues.push(
        `${path} ("${device.name}") is bound to agent "${boundAgent.name}" — ` +
        'unbind it first (modify-object on the agent) before removing the device',
      );
      return;
    }
    result.removedDevices.push(device);
  });
}

// ---------------------------------------------------------------------------
// remove-agents (T-209)
// ---------------------------------------------------------------------------

/**
 * T-209: builders may propose removal of agents THEY own — neutered stub
 * agents used to linger forever (HF-F08/RF-F05: DELETE 403 "even for agents
 * you own", no lifecycle path). Author-ownership is a hard rule; cascade
 * effects (bound flows failing their next re-arm with T-201's governance
 * message, derived/published services disappearing) are NON-blocking
 * warnings on the proposal.
 */
function checkRemoveAgents(
  ctx: RuleCheckContext,
  env: EnvironmentRow,
  authorId: string,
  payload: Record<string, unknown>,
  result: RuleCheckResult,
): void {
  const issues = result.issues;
  if (!Array.isArray(payload.agentIds)) {
    issues.push('payload.agentIds must be an array');
    return;
  }
  if (payload.agentIds.length === 0) {
    issues.push('payload.agentIds must not be empty');
    return;
  }
  payload.agentIds.forEach((raw, index) => {
    const path = `agentIds[${index}]`;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      issues.push(`${path} must be a non-empty string`);
      return;
    }
    const agent = ctx.envStore.getAgent(raw);
    if (!agent || agent.env_id !== env.id) {
      issues.push(`${path} references unknown agent "${raw}" in this environment`);
      return;
    }
    if (agent.owner_id !== authorId) {
      issues.push(`${path} ("${agent.name}") is owned by another user — only the agent owner may remove it`);
      return;
    }
    result.removedAgents.push(agent);
  });

  // Non-blocking cascade warnings: flows whose plan references the agent
  // will fail their next re-arm (T-201 messages cover that loudly); bound
  // devices lose their derived/published services.
  if (result.removedAgents.length > 0) {
    const removing = new Set(result.removedAgents.map(agent => agent.id));
    if (ctx.flowStore !== undefined) {
      try {
        for (const flow of ctx.flowStore.listByEnvironment(env.id)) {
          const nodes = (JSON.parse(flow.plan_json) as { nodes?: Array<{ assigneeAgentId?: string }> }).nodes ?? [];
          const referenced = nodes.some(node => node.assigneeAgentId !== undefined && removing.has(node.assigneeAgentId));
          if (referenced) {
            result.warnings.push(
              `flow "${flow.name}" (${flow.id}) references a removed agent — it will fail validation loudly on its next re-arm; update or delete the flow`,
            );
          }
        }
      } catch {
        // Warning source unavailable — never block on it.
      }
    }
    for (const agent of result.removedAgents) {
      const boundDevices = parseJsonArray<string>(agent.bound_device_ids_json);
      if (boundDevices.length > 0) {
        result.warnings.push(
          `agent "${agent.name}": ${boundDevices.length} bound device(s) lose their derived services (they cascade with the agent); the devices stay`,
        );
      }
    }
    // T-049 + v60 (R6-E-F08): removing the agent RETIRES its agreements
    // (live rows suspend/reject/terminate with reason 'provider-unavailable';
    // the ledger — usage records, receipts, terminated history — survives,
    // subscriptions to the doomed services still cascade) — name the counts
    // BEFORE the proposal lands so the approver sees the blast radius.
    if (ctx.agreementStore !== undefined) {
      try {
        for (const agent of result.removedAgents) {
          const agreements = ctx.agreementStore.agreementsOfProviderAgent(agent.id);
          if (agreements.length === 0) continue;
          const live = agreements.filter(row => row.status !== 'rejected' && row.status !== 'terminated');
          result.warnings.push(
            `agent "${agent.name}": removing it RETIRES ${agreements.length} service agreement(s)` +
              ` (${live.length} still live — active/held suspend, pending offers reject, ` +
              'ephemeral AC terminate, all marked provider-unavailable); the ledger and ' +
              'terminated history survive; revert re-links the rows (status stays retired)',
          );
        }
      } catch {
        // Warning source unavailable — never block on it.
      }
    }
    if (ctx.serviceStore !== undefined) {
      try {
        for (const agent of result.removedAgents) {
          const subscriptions = ctx.serviceStore
            .servicesOfAgent(agent.id)
            .reduce((sum, service) => sum + ctx.serviceStore!.countSubscriptionsOfService(service.id), 0);
          if (subscriptions > 0) {
            result.warnings.push(
              `agent "${agent.name}": ${subscriptions} marketplace subscription(s) to its services will be removed with them`,
            );
          }
        }
      } catch {
        // Warning source unavailable — never block on it.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// inject-scenario
// ---------------------------------------------------------------------------

function checkInjectScenario(
  ctx: RuleCheckContext,
  env: EnvironmentRow,
  payload: Record<string, unknown>,
  result: RuleCheckResult,
): void {
  const issues = result.issues;
  let rawDevices: unknown[] = [];
  if (payload.devices !== undefined) {
    const parsed = requireDeviceArray(payload.devices, 'payload.devices', issues);
    rawDevices = parsed ?? [];
  }
  let rawEvents: unknown[] = [];
  if (payload.events !== undefined) {
    if (!Array.isArray(payload.events)) {
      issues.push('payload.events must be an array');
    } else {
      rawEvents = payload.events;
    }
  }
  if (rawDevices.length === 0 && rawEvents.length === 0) {
    issues.push('payload must contain at least one device or event');
    return;
  }

  result.devices = normalizeDevices(ctx, env, rawDevices, issues);
  checkSpatial(env, result.devices, ctx.envStore, issues);
  checkDeviceQuota(ctx, env, result.devices.length, issues);
  result.expiresAt = parseEffectiveWindow(payload, issues);

  // Schema + reference integrity via the core scenario loader: the fragment
  // is checked as a scenario whose zones are the environment's own zones,
  // so device/event zoneId references resolve against the real world.
  const zones = parseMapData(env).zones;
  const candidate = {
    version: '1.0',
    meta: { id: `proposal-fragment`, name: 'Proposal scenario fragment' },
    zones: zones.map(zone => ({ id: zone.id })),
    devices: result.devices.map((device, index) => ({
      id: `dev-${index}`,
      name: device.name,
      type: device.type,
      capabilities: device.capabilities,
      zoneId: device.zoneId,
      ...(device.binding !== null ? { binding: device.binding } : {}),
      ...(device.initialState !== null ? { initialState: device.initialState } : {}),
    })),
    agents: [],
    events: rawEvents,
  };
  try {
    loadScenarioFile(candidate);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      issues.push(...error.issues);
    } else {
      throw error;
    }
  }
  if (issues.length === 0) {
    result.events = rawEvents as Record<string, unknown>[];
  }
  for (const [index, event] of rawEvents.entries()) {
    if (!isPlainObject(event)) continue;
    checkCapabilityWhitelist(event.requiredCapabilities, `payload.events[${index}]`, issues);
  }
  applyRiskRules(result);
}

// ---------------------------------------------------------------------------
// modify-object / zone-claim
// ---------------------------------------------------------------------------

/** Patch fields a modify-object proposal supports, per target type. */
const DEVICE_PATCH_FIELDS = [
  'name', 'type', 'brand', 'capabilities', 'zoneId', 'position', 'initialState', 'binding',
] as const;
const AGENT_PATCH_FIELDS = [
  'name', 'capabilities', 'boundDeviceIds', 'managedZoneIds', 'llm', 'enabled', 'decisionPolicy',
  // T-604 (R26, HO26-F01): scope-of-practice blocklist joins the governed
  // patch surface — the owner PATCH lane already had it (T-021).
  'cannotDeliverClasses',
] as const;

/** T-051: the per-agent decision policy fields (core loader whitelist). */
export const DECISION_POLICY_KEYS: readonly string[] = [
  'autoActuateIndependent',
  'autoInitiateAC',
  // R43-B/lever-b: precheck Type-A pass-through pair (same semantics as the
  // owner PATCH lane — parseAgentDecisionPolicy).
  'precheckPassThrough',
  'precheckPassThroughRate',
];

/**
 * T-051: validate an optional decisionPolicy value — closed shape
 * (booleans + the R43-B pass-through pair), at least one key (an empty
 * policy carries no meaning). Collects issues; returns null when
 * absent/invalid.
 */
/** R22 P2F split: shared with proposal-rules-adopt-config.ts. */
export function checkDecisionPolicy(
  value: unknown,
  path: string,
  issues: string[],
): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    issues.push(`${path} must be an object { autoActuateIndependent?, autoInitiateAC?, precheckPassThrough?, precheckPassThroughRate? } (or null to clear)`);
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!DECISION_POLICY_KEYS.includes(key)) {
      issues.push(`${path}.${key} is not a known policy field (allowed: ${DECISION_POLICY_KEYS.join(', ')})`);
    } else if (key === 'precheckPassThrough') {
      if (value[key] !== 'off' && value[key] !== 'sample' && value[key] !== 'all') {
        issues.push(`${path}.${key} must be one of "off" | "sample" | "all"`);
      }
    } else if (key === 'precheckPassThroughRate') {
      const rate = value[key];
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
        issues.push(`${path}.${key} must be a number in [0, 1]`);
      }
    } else if (typeof value[key] !== 'boolean') {
      issues.push(`${path}.${key} must be a boolean`);
    }
  }
  if (Object.keys(value).length === 0) {
    issues.push(`${path} must carry at least one of ${DECISION_POLICY_KEYS.join(', ')}`);
  }
  return value;
}

/**
 * Fix-7: modify-object is a REAL change now — the check validates the patch
 * field-by-field with the same semantics as the owner-only PATCH routes and
 * normalizes it for the apply step. Unknown targets and unsupported patch
 * fields are hard rule-check rejections (no more applied-but-noop).
 * Fix-9: `boundDeviceIds` additionally enforces 设备私有 (same rule as
 * install-agents) — a proposal may only bind the AUTHOR's own devices; the
 * owner-direct PATCH route is unaffected.
 * T-402 (R19): the TARGET itself must be owned by the author (parity with
 * remove-devices/remove-agents) — the proposal lane never patches another
 * user's object; the env owner's path is the owner-direct PATCH route.
 */
function checkModifyObject(
  ctx: RuleCheckContext,
  env: EnvironmentRow,
  authorId: string,
  payload: Record<string, unknown>,
  result: RuleCheckResult,
): void {
  const issues = result.issues;
  const targetId = payload.targetId;
  if (typeof targetId !== 'string' || targetId.trim().length === 0) {
    issues.push('payload.targetId must be a non-empty string');
    return;
  }
  const device = ctx.envStore.getDevice(targetId);
  const agent = device === undefined ? ctx.envStore.getAgent(targetId) : undefined;
  const target = device ?? agent;
  if (!target || target.env_id !== env.id) {
    issues.push(`payload.targetId references unknown device/agent "${targetId}" in this environment`);
    return;
  }
  if (!isPlainObject(payload.patch)) {
    issues.push('payload.patch must be an object');
    return;
  }
  if (Object.keys(payload.patch).length === 0) {
    issues.push('payload.patch must not be empty');
    return;
  }

  const objectType = device !== undefined ? 'device' : 'agent';
  // T-402 (DevLoop R19, CC-F02): target-ownership hard rejection — exact
  // parity with remove-devices / remove-agents. The proposal apply path is
  // live-world-effectful (rebuildLiveSession lands it immediately), so a
  // foreign `brand`/`capabilities` patch is the same cross-tenant write the
  // raw /commands lane now rejects (T-401). Agent patches carry
  // capabilities/decisionPolicy/binding — equally effectful, same rule. NO
  // env-owner exception in the proposal lane: the owner-direct PATCH route
  // is the sanctioned escape hatch (and is already owner-gated).
  if (target.owner_id !== authorId) {
    const ownerRoute =
      objectType === 'device' ? 'PATCH /api/devices/:id' : 'PATCH /api/agents/:id';
    issues.push(
      `payload.targetId ("${target.name}") is owned by another user — only the owner may modify it via proposal ` +
      `(the environment owner can edit any object through the owner-direct route: ${ownerRoute})`,
    );
    return;
  }
  const allowed: readonly string[] = objectType === 'device' ? DEVICE_PATCH_FIELDS : AGENT_PATCH_FIELDS;
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(payload.patch)) {
    const path = `payload.patch.${field}`;
    if (!allowed.includes(field)) {
      issues.push(`${path} is not a supported ${objectType} field (supported: ${allowed.join(', ')})`);
      continue;
    }
    switch (field) {
      case 'name':
      case 'type': {
        if (typeof value !== 'string' || value.trim().length === 0) {
          issues.push(`${path} must be a non-empty string`);
        } else {
          patch[field] = value.trim();
        }
        break;
      }
      case 'brand': {
        if (value !== null && typeof value !== 'string') {
          issues.push(`${path} must be a string or null`);
        } else {
          patch.brand = value;
        }
        break;
      }
      case 'capabilities': {
        if (!Array.isArray(value) || value.some(c => typeof c !== 'string')) {
          issues.push(`${path} must be an array of strings`);
        } else {
          patch.capabilities = value;
          checkCapabilityWhitelist(value, path, issues);
        }
        break;
      }
      case 'zoneId': {
        if (typeof value !== 'string' || value.trim().length === 0) {
          issues.push(`${path} must be a non-empty string`);
        } else if (!parseMapData(env).zones.some(zone => zone.id === value)) {
          issues.push(`${path} references unknown zone "${value}"`);
        } else {
          patch.zoneId = value;
        }
        break;
      }
      case 'position':
      case 'initialState':
      case 'llm': {
        if (value !== null && !isPlainObject(value)) {
          issues.push(`${path} must be an object or null`);
          break;
        }
        if (field === 'position' && value !== null) {
          try {
            validateDevicePositionForEnv(env.map_type, value as Record<string, unknown>);
          } catch (error) {
            issues.push(`${path}: ${(error as Error).message}`);
            break;
          }
        }
        patch[field] = value;
        break;
      }
      case 'binding': {
        if (value !== null && (typeof value !== 'string' || !/^(sim|hass):\/\/\S+$/.test(value))) {
          issues.push(`${path} must be a sim:// or hass:// URI (or null to reset to sim)`);
        } else {
          patch.binding = value;
          // Same real-actuation gate as install-devices (§5.2).
          if (typeof value === 'string' && value.startsWith('hass://')) {
            result.riskLevel = 'high';
            result.forceEscalate = true;
            result.escalateReason = `hass:// binding on "${target.name}" touches a real actuator`;
          }
        }
        break;
      }
      case 'enabled': {
        // T-209: the agent master switch joins the patchable fields —
        // runtime already honors ScenarioAgent.enabled (bridge + v21).
        if (typeof value !== 'boolean') {
          issues.push(`${path} must be a boolean`);
        } else {
          patch.enabled = value;
        }
        break;
      }
      case 'cannotDeliverClasses': {
        // T-604 (R26): same semantics as the owner PATCH route (T-021) —
        // array of non-empty strings, null/[] clears to no restriction, no
        // vocabulary gate (classes are free-form by design).
        if (value === null) {
          patch.cannotDeliverClasses = null;
        } else if (
          !Array.isArray(value) ||
          value.some(c => typeof c !== 'string' || c.trim().length === 0)
        ) {
          issues.push(`${path} must be an array of non-empty strings (or null to clear)`);
        } else {
          patch.cannotDeliverClasses = value;
        }
        break;
      }
      case 'decisionPolicy': {
        // T-051: per-agent actuation policy joins the patchable fields
        // (null clears to the runtime-wide defaults).
        if (value !== null && !isPlainObject(value)) {
          issues.push(`${path} must be an object or null`);
          break;
        }
        const policy = checkDecisionPolicy(value, path, issues);
        patch.decisionPolicy = policy;
        break;
      }
      case 'boundDeviceIds':
      case 'managedZoneIds': {
        if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) {
          issues.push(`${path} must be an array of strings`);
          break;
        }
        if (field === 'boundDeviceIds') {
          const missing = (value as string[]).filter(id => {
            const row = ctx.envStore.getDevice(id);
            return !row || row.env_id !== env.id;
          });
          if (missing.length > 0) {
            issues.push(`${path} references unknown device(s) in this environment: ${missing.join(', ')}`);
            break;
          }
          // 设备私有 (Fix-9, symmetric with install-agents): the patch may
          // only bind devices OWNED BY THE AUTHOR — binding someone else's
          // device would leak its capabilities into the author's derived
          // services.
          const foreign = (value as string[])
            .map(id => ctx.envStore.getDevice(id)!)
            .filter(row => row.owner_id !== authorId);
          if (foreign.length > 0) {
            issues.push(
              `${path}: device(s) ${foreign.map(row => `"${row.name}" (${row.id})`).join(', ')} ` +
              'are owned by another user — agents may only bind their author\'s own devices',
            );
            break;
          }
        } else {
          const zones = parseMapData(env).zones;
          const missing = (value as string[]).filter(id => !zones.some(zone => zone.id === id));
          if (missing.length > 0) {
            issues.push(`${path} references unknown zone(s): ${missing.join(', ')}`);
            break;
          }
        }
        patch[field] = value;
        break;
      }
    }
  }
  // T-058a: the modify-object zone footprint (the FR-F05 shape — "rebind an
  // agent onto a ward device" is exactly this kind). Devices: current zone +
  // patch.zoneId when the patch moves it. Agents: the resulting managed
  // zones + the resulting bound devices' zones (patch values win — a rebind
  // toward a supervised ward's device is a supervised-zone touch even though
  // the agent itself never carried a zone).
  const footprint: string[] = [];
  if (objectType === 'device') {
    footprint.push(device!.zone_id);
    if (typeof patch.zoneId === 'string') footprint.push(patch.zoneId);
  } else if (agent !== undefined) {
    const managed = patch.managedZoneIds !== undefined
      ? (patch.managedZoneIds as string[])
      : parseJsonArray<string>(agent.managed_zone_ids_json);
    footprint.push(...managed);
    const boundIds = patch.boundDeviceIds !== undefined
      ? (patch.boundDeviceIds as string[])
      : parseJsonArray<string>(agent.bound_device_ids_json);
    for (const deviceId of boundIds) {
      const bound = ctx.envStore.getDevice(deviceId);
      if (bound) footprint.push(bound.zone_id);
    }
  }
  result.modifyTarget = { objectType, id: target.id, patch, zoneIds: [...new Set(footprint)] };

  // T-403 (DevLoop R19, NW-F03): a capability patch on a device REGENERATES
  // its derived services — rows whose (device, semanticType) key leaves the
  // expected set are deleted and the FK cascade destroys every agreement
  // riding them (the consumer's next read 404s with zero trace). Warn
  // BEFORE the proposal lands; cross-party ACTIVE agreements force-escalate
  // (the owner reviews harm to another user's contract).
  if (objectType === 'device' && patch.capabilities !== undefined) {
    warnDerivedAgreementCascade(
      ctx, env, device!, patch.capabilities as string[], authorId, result,
    );
  }

  // T-206: agent capability patches are checked against the RESULTING bound
  // set — patch.boundDeviceIds when the patch rebinds, else the agent's
  // current bindings. Rebinding cannot smuggle in unbacked declarations,
  // and a capability patch on an unbacked agent is rejected like a fresh
  // install would be.
  if (objectType === 'agent' &&
      (patch.capabilities !== undefined || patch.boundDeviceIds !== undefined) &&
      agent !== undefined) {
    const nextCapabilities = patch.capabilities !== undefined
      ? (patch.capabilities as string[])
      : parseJsonArray<string>(agent.capabilities_json);
    const nextBoundIds = patch.boundDeviceIds !== undefined
      ? (patch.boundDeviceIds as string[])
      : parseJsonArray<string>(agent.bound_device_ids_json);
    checkCapabilityBacking(
      nextCapabilities,
      nextBoundIds.map(id => ctx.envStore.getDevice(id)!).filter(row => row !== undefined),
      'payload.patch.capabilities',
      issues,
    );
  }
}

/**
 * T-403: non-blocking cascade warnings for a device capability patch that
 * would delete derived service rows (and with them, via the FK cascade, the
 * agreements riding those rows). Cross-party ACTIVE agreements set
 * forceEscalate — the env owner reviews harm to another user's contract;
 * self-party agreements (author == consumer) stay on the normal funnel with
 * the warning + the apply-time consumer notification.
 *
 * The doomed rows are approximated with `derivedServiceSpecs` on the
 * PATCHED device (no catalog universes here — the warning may over/under-
 * report on exotic type metadata; it never blocks).
 */
function warnDerivedAgreementCascade(
  ctx: RuleCheckContext,
  env: EnvironmentRow,
  device: DeviceInstanceRow,
  nextCapabilities: string[],
  authorId: string,
  result: RuleCheckResult,
): void {
  if (ctx.serviceStore === undefined || ctx.agreementStore === undefined) return;
  try {
    const patched: DeviceInstanceRow = {
      ...device,
      capabilities_json: JSON.stringify(nextCapabilities),
    };
    const expected = new Set(derivedServiceSpecs(patched).map(spec => spec.semanticType));
    const boundAgents = ctx.envStore
      .agentsOf(env.id)
      .filter(agent => parseJsonArray<string>(agent.bound_device_ids_json).includes(device.id));
    let crossParty = false;
    for (const agent of boundAgents) {
      const doomed = ctx
        .serviceStore!.servicesOfAgent(agent.id)
        .filter(service =>
          service.origin === 'derived' &&
          service.source_device_id === device.id &&
          service.semantic_type !== undefined &&
          !expected.has(service.semantic_type));
      if (doomed.length === 0) continue;
      const agreements = ctx.agreementStore!.agreementsOfProviderAgent(agent.id);
      for (const service of doomed) {
        const riding = agreements.filter(
          agreement =>
            agreement.service_id === service.id &&
            agreement.status !== 'rejected' &&
            agreement.status !== 'terminated',
        );
        if (riding.length === 0) continue;
        result.warnings.push(
          `device "${device.name}": this capability change deletes its derived service ` +
          `"${service.name ?? service.id}" (semantic type "${service.semantic_type}") and with it ` +
          `${riding.length} active agreement(s) (${riding.map(row => row.id).join(', ')}) — the ` +
          'consumer\'s next read 404s; on apply each consumer is notified with successor semantic ' +
          'types (revert restores the rows)',
        );
        if (riding.some(row => row.consumer_owner_id !== authorId)) crossParty = true;
      }
    }
    if (crossParty) {
      result.forceEscalate = true;
      result.escalateReason = [
        result.escalateReason,
        `capability change on "${device.name}" destroys ACTIVE cross-party service agreement(s) — ` +
        'owner review required (consumers are notified with successor hints; revert restores)',
      ]
        .filter(reason => reason !== undefined)
        .join('; ');
    }
  } catch {
    // Warning source unavailable — never block on it.
  }
}

function checkZoneClaim(
  env: EnvironmentRow,
  payload: Record<string, unknown>,
  issues: string[],
  result: RuleCheckResult,
): void {
  const zoneId = payload.zoneId;
  if (typeof zoneId !== 'string' || zoneId.trim().length === 0) {
    issues.push('payload.zoneId must be a non-empty string');
    return;
  }
  if (!parseMapData(env).zones.some(zone => zone.id === zoneId)) {
    issues.push(`payload.zoneId references unknown zone "${zoneId}"`);
    return;
  }
  // T-077 (NW-F07): the optional "why" — overnight HVAC setback vs an energy
  // policy — travels to the deciding owner. Optional string, length-bounded
  // (it renders in decide surfaces; a wall of text is not a rationale).
  if (
    payload.rationale !== undefined &&
    (typeof payload.rationale !== 'string' || payload.rationale.length > ZONE_CLAIM_RATIONALE_MAX_CHARS)
  ) {
    issues.push(`payload.rationale must be a string of at most ${ZONE_CLAIM_RATIONALE_MAX_CHARS} characters`);
    return;
  }
  // §5.3: a claim hands governance power to the grantee, so it ALWAYS goes
  // to the environment owner — the AI reviewer (P-B) may never auto-approve
  // one, however low-risk the change looks.
  result.forceEscalate = true;
  result.escalateReason = 'zone claims always require environment-owner approval (§5.3)';
}

/**
 * The zone ids a proposal touches (P-B zone autonomy, §5.3): install-devices
 * from its devices, inject-scenario from devices AND events, install-agents
 * from managed zones + bound devices' zones. Returns null when the footprint
 * cannot be determined (other kinds, malformed event zoneIds, empty
 * footprints, an agent with no zone at all) — such proposals are never
 * autonomy-eligible.
 */
export function proposalZoneIds(kind: ProposalKind, check: RuleCheckResult): string[] | null {
  if (kind === 'install-agents') {
    const zoneIds = new Set<string>();
    for (const agent of check.agents) {
      if (agent.zoneIds.length === 0) return null;
      for (const zoneId of agent.zoneIds) zoneIds.add(zoneId);
    }
    return zoneIds.size > 0 ? [...zoneIds] : null;
  }
  if (kind !== 'install-devices' && kind !== 'inject-scenario') return null;
  const zoneIds = new Set<string>();
  for (const device of check.devices) {
    zoneIds.add(device.zoneId);
  }
  if (kind === 'inject-scenario') {
    for (const event of check.events) {
      const zoneId = (event as { zoneId?: unknown }).zoneId;
      if (typeof zoneId !== 'string' || zoneId.length === 0) return null;
      zoneIds.add(zoneId);
    }
  }
  return zoneIds.size > 0 ? [...zoneIds] : null;
}

/**
 * T-058a (design-consent-semantics.md §3.2): the zone CONSENT footprint of a
 * proposal — the zones whose consent class its changes touch. This corrects
 * `proposalZoneIds`'s coverage for the consent gate: that function answers
 * the §5.3 autonomy question (whole-footprint determinable?) and returns
 * null for modify-object / zone-claim; the consent gate must see MORE:
 *
 * - install-devices / inject-scenario / install-agents — same sources as
 *   proposalZoneIds (null-tolerance dropped: a partially determinable
 *   footprint still contributes the zones it CAN see);
 * - modify-object — the target's post-patch footprint (modifyTarget.zoneIds,
 *   resolved during the check: device zone + patch.zoneId; agent managed +
 *   bound-device zones, patch values winning);
 * - zone-claim — payload.zoneId (the claimed zone itself).
 *
 * Pure over already-resolved structures; empty when nothing determinable.
 */
export function proposalConsentFootprint(
  kind: ProposalKind,
  check: RuleCheckResult,
  payload: Record<string, unknown> | undefined,
): string[] {
  if (kind === 'modify-object') {
    return check.modifyTarget !== null ? [...check.modifyTarget.zoneIds] : [];
  }
  if (kind === 'zone-claim') {
    const zoneId = payload?.zoneId;
    return typeof zoneId === 'string' && zoneId.length > 0 ? [zoneId] : [];
  }
  const zoneIds = proposalZoneIds(kind, check);
  return zoneIds ?? [];
}

/**
 * T-058a: the supervised-zone consent gate — any proposal whose consent
 * footprint intersects the env's supervised zones force-escalates to the
 * environment owner (AI review runs as ADVISOR via escalateWithAiAdvisory;
 * its verdict is recorded but cannot auto-apply or veto). OR-composed with
 * earlier forceEscalate markers; the reason names itself.
 */
export function checkZoneConsent(
  env: EnvironmentRow,
  kind: ProposalKind,
  payload: Record<string, unknown> | undefined,
  result: RuleCheckResult,
): void {
  const footprint = proposalConsentFootprint(kind, result, payload);
  if (footprint.length === 0) return;
  const supervised = parseMapData(env).zones.filter(
    zone => zone.consentClass === 'supervised' && footprint.includes(zone.id),
  );
  if (supervised.length === 0) return;
  const list = supervised.map(zone => `'${zone.id}'`).join(', ');
  const reason =
    `zone${supervised.length > 1 ? 's' : ''} ${list} ${supervised.length === 1 ? 'is' : 'are'} ` +
    "supervised (consentClass='supervised') — proposals touching " +
    (supervised.length === 1 ? 'it' : 'them') +
    " require the environment owner's explicit consent; AI review ran and its " +
    'reason is attached, but it cannot auto-apply here';
  const prior = result.escalateReason;
  result.forceEscalate = true;
  result.escalateReason = prior !== undefined ? `${prior}; ${reason}` : reason;
  result.escalateWithAiAdvisory = true;
}

// ---------------------------------------------------------------------------
// Device normalization + shared checks
// ---------------------------------------------------------------------------

function requireDeviceArray(value: unknown, path: string, issues: string[]): unknown[] | null {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return null;
  }
  return value;
}

/**
 * Normalize raw device entries: shape checks, zone existence, catalog-model
 * defaults (modelId resolves type/brand/capabilities from an ACTIVE model),
 * binding syntax, capability whitelist. Issues are collected, not thrown.
 */
function normalizeDevices(
  ctx: RuleCheckContext,
  env: EnvironmentRow,
  rawDevices: unknown[],
  issues: string[],
): NormalizedProposedDevice[] {
  const zones = parseMapData(env).zones;
  const devices: NormalizedProposedDevice[] = [];
  rawDevices.forEach((raw, index) => {
    const path = `devices[${index}]`;
    if (!isPlainObject(raw)) {
      issues.push(`${path} must be an object`);
      return;
    }
    const zoneId = typeof raw.zoneId === 'string' ? raw.zoneId.trim() : '';
    if (zoneId.length === 0) {
      issues.push(`${path}.zoneId must be a non-empty string`);
    } else if (!zones.some(zone => zone.id === zoneId)) {
      issues.push(`${path}.zoneId references unknown zone "${zoneId}"`);
    }

    // Catalog reference integrity: modelId must name an active model and
    // supplies the type/brand/capabilities defaults (mirrors instantiate).
    let model: {
      name: string;
      device_type: string;
      vendor: string;
      capabilities: string[];
      /** T-702: catalog physics/specs — merged into initialState below. */
      physics: Record<string, unknown>;
      specs: Record<string, unknown>;
    } | null = null;
    if (raw.modelId !== undefined) {
      if (typeof raw.modelId !== 'string' || raw.modelId.trim().length === 0) {
        issues.push(`${path}.modelId must be a non-empty string`);
      } else {
        const row = ctx.catalogStore.get(raw.modelId);
        if (!row || row.status !== 'active') {
          issues.push(`${path}.modelId references unknown catalog model "${raw.modelId}"`);
        } else {
          model = {
            name: row.name,
            device_type: row.device_type,
            vendor: row.vendor,
            capabilities: parseJsonArray<string>(row.capabilities_json),
            physics: parseJsonObject(row.physics_json) ?? {},
            specs: parseJsonObject(row.specs_json) ?? {},
          };
        }
      }
    }

    const type = raw.type !== undefined ? raw.type : model?.device_type;
    if (typeof type !== 'string' || (type as string).trim().length === 0) {
      issues.push(`${path}.type must be a non-empty string (or come from modelId)`);
    }
    const name = raw.name !== undefined ? raw.name : (model?.name ?? type);
    if (typeof name !== 'string' || (name as string).trim().length === 0) {
      issues.push(`${path}.name must be a non-empty string`);
    }
    let capabilities: string[] = model?.capabilities ?? [];
    if (raw.capabilities !== undefined) {
      if (!Array.isArray(raw.capabilities) || raw.capabilities.some(c => typeof c !== 'string')) {
        issues.push(`${path}.capabilities must be an array of strings`);
      } else {
        capabilities = raw.capabilities as string[];
      }
    } else if (model === null) {
      issues.push(`${path}.capabilities must be an array of strings (or come from modelId)`);
    }
    checkCapabilityWhitelist(capabilities, path, issues);

    let binding: string | null = null;
    if (raw.binding !== undefined) {
      if (typeof raw.binding !== 'string' || !/^(sim|hass):\/\/\S+$/.test(raw.binding)) {
        issues.push(`${path}.binding must be a sim:// or hass:// URI`);
      } else {
        binding = raw.binding;
      }
    }

    let position: Record<string, unknown> | null = null;
    if (raw.position !== undefined) {
      if (!isPlainObject(raw.position)) {
        issues.push(`${path}.position must be an object`);
      } else {
        position = raw.position;
        try {
          validateDevicePositionForEnv(env.map_type, position);
        } catch (error) {
          issues.push(`${path}.position: ${(error as Error).message}`);
        }
      }
    }
    let initialState: Record<string, unknown> | null = null;
    if (raw.initialState !== undefined) {
      if (!isPlainObject(raw.initialState)) {
        issues.push(`${path}.initialState must be an object`);
      } else {
        initialState = raw.initialState;
      }
    }
    // T-702 (DevLoop R29): catalog physics → device state (see
    // catalogPhysicsInitialState).
    initialState = catalogPhysicsInitialState(model, initialState);

    devices.push({
      name: typeof name === 'string' ? name.trim() : String(name ?? ''),
      type: typeof type === 'string' ? type.trim() : String(type ?? ''),
      brand: model?.vendor ?? (typeof raw.brand === 'string' ? raw.brand : null),
      capabilities,
      zoneId,
      position,
      initialState,
      binding,
    });
  });
  return devices;
}

/**
 * T-702 (DevLoop R29): merge catalog physics/specs into a device's
 * initialState. The catalog carries rated thermal/electrical watts
 * (specs.coolingCapacityW, specs.heatingCapacityW, specs.ratedPowerW,
 * specs.powerW, physics.powerW, specs.cop); pre-fix they never reached
 * initial_state_json, so every HVAC fell back to the hardcoded 3 kW class
 * default and metered 3000/COP W regardless of model. Merged as:
 *   coolingPowerW ← specs.coolingCapacityW
 *   heatingPowerW ← specs.heatingCapacityW
 *   ratedPowerW   ← specs.ratedPowerW ?? specs.powerW ?? physics.powerW
 *   cop           ← specs.cop ?? physics.cop
 * An explicit author initialState key always wins over the catalog. Shared
 * by the proposal install path (normalizeDevices) and the owner-direct
 * catalog instantiate route.
 */
export function catalogPhysicsInitialState(
  model: { physics: Record<string, unknown>; specs: Record<string, unknown> } | null,
  authorInitialState?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (model === null) return authorInitialState ?? null;
  const catalogPhysics: Record<string, number> = {};
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  const cooling = num(model.specs.coolingCapacityW);
  const heating = num(model.specs.heatingCapacityW);
  const rated =
    num(model.specs.ratedPowerW) ?? num(model.specs.powerW) ?? num(model.physics.powerW);
  const cop = num(model.specs.cop) ?? num(model.physics.cop);
  if (cooling !== undefined) catalogPhysics.coolingPowerW = cooling;
  if (heating !== undefined) catalogPhysics.heatingPowerW = heating;
  if (rated !== undefined) catalogPhysics.ratedPowerW = rated;
  if (cop !== undefined) catalogPhysics.cop = cop;
  if (Object.keys(catalogPhysics).length === 0) return authorInitialState ?? null;
  return { ...catalogPhysics, ...(authorInitialState ?? {}) };
}

/** R22 P2F split: shared with proposal-rules-adopt-config.ts. */
export function checkCapabilityWhitelist(
  capabilities: unknown,
  path: string,
  issues: string[],
): void {
  if (!Array.isArray(capabilities)) return;
  for (const capability of capabilities) {
    if (typeof capability === 'string' && FORBIDDEN_CAPABILITIES.includes(capability)) {
      issues.push(`${path}: capability "${capability}" is not grantable by proposal`);
    }
  }
}

/**
 * T-206 capability honesty: every capability an agent DECLARES must be
 * provided (the shared `capabilityMatches` matcher — bidirectional
 * containment + CAPABILITY_SYNONYMS, the one matcher the assessor,
 * negotiator and flow validation agree on) by at least one of its bound
 * devices — OR be deliverable through the device TYPE's executable
 * expansion (BUG-08 ③: `multiCommandNamesForDeviceType`, the type-gated
 * expansion the flow executability oracle's `executableCommandPath` route 4
 * accepts — e.g. 'ventilation' on an exhaust-fan dispatches to turn-on at
 * run time, so the endorsement oracle must not reject what the executor
 * would run). Route 3 (`semanticCommandForDeviceType`) is deliberately NOT
 * an endorsement route: its sensor/generic patterns are not type-gated
 * ('fire-monitoring' → 'get-status' on ANY device), and accepting them here
 * would reopen the exact HF-F02/B1-8 hole this check exists to close.
 * hass://-bound devices are exempt (real hardware — the registry cannot
 * speak for them, established precedent). An agent with NO bound devices
 * may declare NO capabilities. Rejections teach what the devices DO provide
 * (mirror of T-002's error UX) — an unbacked declaration used to pollute
 * discovery and service derivation ("hvac-control" bound to an air-quality
 * station, HF-F02/RF-F04).
 */
export function checkCapabilityBacking(
  capabilities: readonly string[],
  boundDeviceRows: DeviceInstanceRow[],
  path: string,
  issues: string[],
): void {
  if (capabilities.length === 0) return;
  // hass://-bound devices are real hardware: the registry cannot speak for
  // their commands, so a hass binding TRUSTS the declaration (established
  // precedent) — an agent bound to hass hardware is exempt from the check.
  if (boundDeviceRows.some(row => row.binding?.startsWith('hass://'))) return;
  const provided = new Set<string>();
  for (const device of boundDeviceRows) {
    for (const declared of parseJsonArray<string>(device.capabilities_json)) {
      provided.add(declared);
    }
  }
  // One bound device backs the capability when it DECLARES a match, or when
  // its TYPE expands the capability into an all-executable command sequence
  // (the type-gated expansion of core executableCommandPath route 4 —
  // declaration is not the only dispatch route at run time).
  const deviceBacks = (device: DeviceInstanceRow, capability: string): boolean => {
    if (parseJsonArray<string>(device.capabilities_json).some(declared => capabilityMatches(declared, capability))) {
      return true;
    }
    const expansion = multiCommandNamesForDeviceType(capability, device.type);
    return expansion !== null && expansion.every(isCapabilityExecutable);
  };
  const unbacked = capabilities.filter(capability =>
    !boundDeviceRows.some(device => deviceBacks(device, capability)),
  );
  if (unbacked.length > 0) {
    const providedList = [...provided].sort().join(', ');
    issues.push(
      `${path}: ${unbacked.map(cap => `"${cap}"`).join(', ')} ${unbacked.length === 1 ? 'is' : 'are'} ` +
      'not provided by any bound device' +
      (boundDeviceRows.length === 0
        ? ' (the agent has no bound devices — an agent with no devices may declare no capabilities)'
        : ` (bound devices provide: ${providedList || 'nothing'})`) +
      ' — declare capabilities your devices deliver or bind a device that provides them; ' +
      'hass://-bound devices are exempt (real hardware)。' +
      '修改建议：把能力先声明到一台设备上（新建设备时填 capabilities），再让 Agent 绑定该设备后声明同样的能力；' +
      '或者从 Agent 的能力列表里移除以上未被设备支撑的项（无设备 Agent 可创建，但能力列表必须为空，' +
      '之后仍可直接「发布服务」——无支撑服务会带 ⚠无支撑 标记，代表对世界的承诺）',
    );
  }
}

// ---------------------------------------------------------------------------
// Spatial conflicts (grid bounds; positions without bounds are exempt)
// ---------------------------------------------------------------------------

function checkSpatial(
  env: EnvironmentRow,
  devices: NormalizedProposedDevice[],
  envStore: EnvironmentStore,
  issues: string[],
): void {
  const zones = new Map<string, EnvZone>(parseMapData(env).zones.map(zone => [zone.id, zone]));
  const existingBounds: { label: string; bounds: Bounds }[] = [];
  for (const row of envStore.devicesOf(env.id)) {
    const bounds = extractBounds(parseJsonObject(row.position_json));
    if (bounds) existingBounds.push({ label: `existing device "${row.name}"`, bounds });
  }

  const proposed: { label: string; bounds: Bounds }[] = [];
  devices.forEach((device, index) => {
    const bounds = extractBounds(device.position);
    if (!bounds) return;
    const label = `devices[${index}] ("${device.name}")`;
    const zoneBounds = zones.get(device.zoneId)?.bounds;
    if (zoneBounds && !containsBounds(zoneBounds, bounds)) {
      issues.push(`${label}: bounds stick out of zone "${device.zoneId}" bounds`);
    }
    for (const other of [...existingBounds, ...proposed]) {
      if (boundsOverlap(bounds, other.bounds)) {
        issues.push(`${label}: bounds overlap ${other.label}`);
      }
    }
    proposed.push({ label, bounds });
  });
}

/** A position carries bounds either at top level or under `.bounds`. */
function extractBounds(position: Record<string, unknown> | null): Bounds | null {
  if (!position) return null;
  const raw = isPlainObject(position.bounds) ? position.bounds : position;
  const { minX, maxX, minY, maxY } = raw as Record<string, unknown>;
  if (
    typeof minX === 'number' && typeof maxX === 'number' &&
    typeof minY === 'number' && typeof maxY === 'number' &&
    minX < maxX && minY < maxY
  ) {
    return { minX, maxX, minY, maxY };
  }
  return null;
}

function containsBounds(outer: Bounds, inner: Bounds): boolean {
  return (
    inner.minX >= outer.minX && inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY && inner.maxY <= outer.maxY
  );
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

// ---------------------------------------------------------------------------
// Quota + risk
// ---------------------------------------------------------------------------

function checkDeviceQuota(
  ctx: RuleCheckContext,
  env: EnvironmentRow,
  newDevices: number,
  issues: string[],
): void {
  if (newDevices === 0) return;
  const current = ctx.envStore.countDevicesIn(env.id);
  const limit = ctx.quotas.maxDevicesPerEnv;
  if (current + newDevices > limit) {
    issues.push(
      `quota "devices_per_env" exceeded: ${current} existing + ${newDevices} proposed > ${limit}`,
    );
  }
}

function checkAgentQuota(
  ctx: RuleCheckContext,
  env: EnvironmentRow,
  newAgents: number,
  issues: string[],
): void {
  if (newAgents === 0) return;
  const current = ctx.envStore.countAgentsIn(env.id);
  const limit = ctx.quotas.maxAgentsPerEnv;
  if (current + newAgents > limit) {
    issues.push(
      `quota "agents_per_env" exceeded: ${current} existing + ${newAgents} proposed > ${limit}`,
    );
  }
}

/** High-risk markers: hass:// bindings and oversized device batches (§5.2). */
function applyRiskRules(result: RuleCheckResult): void {
  const hassBindings = result.devices.filter(
    device => device.binding !== null && device.binding.startsWith('hass://'),
  );
  if (hassBindings.length > 0) {
    result.riskLevel = 'high';
    result.forceEscalate = true;
    result.escalateReason =
      `hass:// binding on ${hassBindings.map(d => `"${d.name}"`).join(', ')} touches a real actuator`;
    return;
  }
  if (result.devices.length > HIGH_RISK_DEVICE_THRESHOLD) {
    result.riskLevel = 'high';
    result.forceEscalate = true;
    result.escalateReason =
      `${result.devices.length} devices in one proposal exceeds the high-risk threshold (${HIGH_RISK_DEVICE_THRESHOLD})`;
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Validate the overlay window; returns expiresAt (effectiveUntil) or null. */
function parseEffectiveWindow(payload: Record<string, unknown>, issues: string[]): string | null {
  const from = payload.effectiveFrom;
  const until = payload.effectiveUntil;
  let fromMs: number | null = null;
  let untilMs: number | null = null;
  if (from !== undefined) {
    if (typeof from !== 'string' || Number.isNaN(Date.parse(from))) {
      issues.push('payload.effectiveFrom must be an ISO timestamp');
    } else {
      fromMs = Date.parse(from);
    }
  }
  if (until !== undefined) {
    if (typeof until !== 'string' || Number.isNaN(Date.parse(until))) {
      issues.push('payload.effectiveUntil must be an ISO timestamp');
    } else {
      untilMs = Date.parse(until);
    }
  }
  if (fromMs !== null && untilMs !== null && untilMs <= fromMs) {
    issues.push('payload.effectiveUntil must be after payload.effectiveFrom');
  }
  return untilMs !== null ? (until as string) : null;
}

/** R22 P2F split: shared with proposal-rules-adopt-config.ts. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
