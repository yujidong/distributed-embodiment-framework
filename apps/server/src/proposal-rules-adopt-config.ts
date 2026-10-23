/**
 * adopt-config rule check (P2F §11, promote-from-fork) — extracted from
 * proposal-rules.ts (R22: the file-size ceiling guard; the agreements/
 * service-layer split pattern). Everything whitelist/blacklist/lineage/
 * evidence/artifact-validation for the adopt-config proposal kind lives
 * here; proposal-rules.ts dispatches `case 'adopt-config'` into it.
 */

import {
  securityFlagsForFlow,
  validateFlow,
  type FlowDefinition,
  type PlanIssue,
} from '@active-collaboration/core';
import { acceptedParameterNames, isCapabilityExecutable } from '@active-collaboration/simulation';

import { derivedServiceSpecs } from './db/service-store.js';
import { MAX_FLOWS_PER_ENV } from './db/flow-store.js';
import {
  parseJsonArray,
  parseJsonObject,
  parseMapData,
  type EnvironmentRow,
} from './db/environment-store.js';
import { environmentToScenario } from './environment-bridge.js';
import { ApiError } from './errors.js';
import { parseComputationSpec } from './computation-evaluator.js';
import {
  checkCapabilityBacking,
  checkCapabilityWhitelist,
  checkDecisionPolicy,
  isPlainObject,
  type RuleCheckContext,
  type RuleCheckResult,
} from './proposal-rules.js';

// ---------------------------------------------------------------------------

/**
 * §11.3 whitelist — the ONLY promotable artifact types. Everything a fork
 * could export falls into either this list (declarative configuration the
 * authoritative world re-evaluates under its own evolution) or the
 * NEVER-promotable classes (§11.3 blacklist): world-state dumps (zone
 * parameters/occupancy/device dynamics state/fault/frozen, RNG, tallies,
 * pendingEffectChecks), observation fabrication or rewrites, reputation
 * scoring, bilateral agreement states/authorizations, member/quota changes.
 */
export const ADOPT_CONFIG_ARTIFACT_TYPES = ['flow-definition', 'agent-policy', 'computation-spec'] as const;
export type AdoptConfigArtifactType = (typeof ADOPT_CONFIG_ARTIFACT_TYPES)[number];

/** One validated promotable artifact (the apply step consumes these verbatim). */
export type NormalizedAdoptArtifact =
  | {
      type: 'flow-definition';
      flow: {
        name: string;
        description: string;
        enabled: boolean;
        trigger: Record<string, unknown>;
        plan: Record<string, unknown>;
        inputs?: Array<Record<string, unknown>>;
        policy?: Record<string, unknown>;
        agentInvocable?: boolean;
      };
    }
  | {
      type: 'agent-policy';
      agentId: string;
      patch: {
        capabilities?: string[];
        decisionPolicy?: Record<string, unknown> | null;
        llm?: Record<string, unknown> | null;
        enabled?: boolean;
      };
    }
  | {
      type: 'computation-spec';
      serviceId: string;
      spec: Record<string, unknown>;
      schemaVersion: number;
      /** dataSchema fields the route would cross-check; carried for apply. */
      asNames: string[];
    };

/** Above this many artifacts in one adopt-config the proposal is high-risk. */
export const HIGH_RISK_ADOPT_ARTIFACT_THRESHOLD = 10;

/**
 * Route-level blacklist gate (§11.3 "规则检查遇到黑名单类型直接 400"): an
 * artifact type outside the whitelist is refused at SUBMISSION with the
 * whitelist AND the never-promotable classes named — promoting a fabricated
 * world state is not a proposal to negotiate, it is a category error.
 */
export function assertAdoptConfigArtifactTypes(payload: unknown): void {
  const artifacts = (payload as { artifacts?: unknown } | null)?.artifacts;
  if (!Array.isArray(artifacts)) return; // shape checked inside the rule check
  const invalid = artifacts
    .filter((artifact): artifact is Record<string, unknown> => isPlainObject(artifact))
    .map(artifact => artifact.type)
    .filter(type => !ADOPT_CONFIG_ARTIFACT_TYPES.includes(type as AdoptConfigArtifactType));
  if (invalid.length === 0) return;
  const shown = [...new Set(invalid.map(type => JSON.stringify(type)))].join(', ');
  throw new ApiError(
    400,
    'ADOPT_CONFIG_ARTIFACT_FORBIDDEN',
    `adopt-config artifacts must be one of ${ADOPT_CONFIG_ARTIFACT_TYPES.map(t => `"${t}"`).join(' | ')} — ` +
      `found ${shown}. NEVER promotable (design-living-worlds §11.3): world-state dumps (zone parameters/` +
      'occupancy/device dynamics, RNG, tallies), observation fabrication or rewrites, reputation scoring, ' +
      'bilateral agreement states/authorizations, member or quota changes — promoting them would forge a ' +
      'history that never happened; observations + command_log are the only source of truth. Re-verify in a ' +
      'fork and propose the DECLARATIVE configuration instead.',
  );
}

/**
 * §11 rule check: validate the promotable artifacts with the SAME validators
 * their native authoring uses (T-020 flow compiler pass; modify-object's
 * agent field rules; the computation spec parser) against the CURRENT
 * authoritative topology — dead references mean the env drifted since the
 * fork, and the answer is to re-fork and re-validate (§11.3 环境对齐检查).
 */
export function checkAdoptConfig(
  ctx: RuleCheckContext,
  env: EnvironmentRow,
  payload: Record<string, unknown>,
  result: RuleCheckResult,
): void {
  const issues = result.issues;

  // --- sourceFork (lineage, §11.2): REQUIRED — attribution is the point ---
  const sourceFork = payload.sourceFork;
  if (!isPlainObject(sourceFork) || typeof sourceFork.forkId !== 'string' || sourceFork.forkId.length === 0) {
    issues.push('payload.sourceFork must be an object { forkId, envId?, forkedAt?, window?, policy? } — the fork the artifacts were validated in (design-living-worlds §11.2)');
  } else if (ctx.sandboxStore === undefined) {
    issues.push('adopt-config sourceFork cannot be verified in this context (no sandbox store) — submit through the API server');
  } else {
    const fork = ctx.sandboxStore.get(sourceFork.forkId);
    if (fork === undefined) {
      issues.push(`payload.sourceFork.forkId references unknown fork "${sourceFork.forkId}" — the promotion does not need the fork ALIVE, but its row must exist for lineage (design §11.1)`);
    } else if (fork.env_id !== env.id) {
      issues.push(`payload.sourceFork.forkId belongs to environment "${fork.env_id}", not "${env.id}" — promote into the world the fork came from`);
    }
  }

  // --- evidence (§11.2): optional, but checked when present ---------------
  const evidence = payload.evidence;
  if (evidence !== undefined) {
    if (!isPlainObject(evidence)) {
      issues.push('payload.evidence must be an object { evalRunId?, replayScenarioId? }');
    } else {
      if (evidence.evalRunId !== undefined) {
        if (typeof evidence.evalRunId !== 'string' || evidence.evalRunId.length === 0) {
          issues.push('payload.evidence.evalRunId must be a non-empty string');
        } else {
          const evalRun = ctx.evalRunStore?.get(evidence.evalRunId);
          if (evalRun === undefined) {
            issues.push(`payload.evidence.evalRunId references unknown eval-run "${evidence.evalRunId}"`);
          } else if (evalRun.env_id !== env.id) {
            issues.push(`payload.evidence.evalRunId belongs to environment "${evalRun.env_id}", not "${env.id}"`);
          }
        }
      }
      if (evidence.replayScenarioId !== undefined &&
          (typeof evidence.replayScenarioId !== 'string' || evidence.replayScenarioId.length === 0)) {
        issues.push('payload.evidence.replayScenarioId must be a non-empty string');
      }
    }
  }

  // --- artifacts (the whitelist; the route already 400'd hard blacklist) --
  if (!Array.isArray(payload.artifacts) || payload.artifacts.length === 0) {
    issues.push('payload.artifacts must be a non-empty array of {type, …} entries (whitelist: ' + ADOPT_CONFIG_ARTIFACT_TYPES.map(t => `"${t}"`).join(', ') + ')');
    return;
  }
  // The shared validation scenario (CURRENT env topology — drift check).
  let scenario: ReturnType<typeof environmentToScenario> | undefined;
  try {
    scenario = environmentToScenario(env, ctx.envStore.devicesOf(env.id), ctx.envStore.agentsOf(env.id));
  } catch {
    scenario = undefined;
  }

  const artifacts: NormalizedAdoptArtifact[] = [];
  for (const [index, raw] of payload.artifacts.entries()) {
    const path = `payload.artifacts[${index}]`;
    if (!isPlainObject(raw)) {
      issues.push(`${path} must be an object`);
      continue;
    }
    const type = raw.type;
    if (typeof type !== 'string' || !ADOPT_CONFIG_ARTIFACT_TYPES.includes(type as AdoptConfigArtifactType)) {
      issues.push(`${path}.type must be one of ${ADOPT_CONFIG_ARTIFACT_TYPES.map(t => `"${t}"`).join(' | ')} (§11.3 whitelist — world-state dumps and observation fabrications are never promotable)`);
      continue;
    }
    if (type === 'flow-definition') {
      const definition = raw.definition;
      if (!isPlainObject(definition)) {
        issues.push(`${path}.definition must be an object (the FlowDefinition wire shape)`);
        continue;
      }
      const name = typeof definition.name === 'string' && definition.name.trim().length > 0
        ? definition.name.trim()
        : null;
      if (name === null) {
        issues.push(`${path}.definition.name must be a non-empty string`);
        continue;
      }
      if (!isPlainObject(definition.trigger) || !isPlainObject(definition.plan)) {
        issues.push(`${path}.definition must carry "trigger" and "plan" objects`);
        continue;
      }
      const candidate: FlowDefinition = {
        id: '(adopt)',
        name,
        ...(typeof definition.description === 'string' ? { description: definition.description } : {}),
        enabled: definition.enabled === undefined ? true : definition.enabled === true,
        trigger: definition.trigger as FlowDefinition['trigger'],
        plan: definition.plan as FlowDefinition['plan'],
        ...(Array.isArray(definition.inputs) ? { inputs: definition.inputs as never } : {}),
        ...(isPlainObject(definition.policy) ? { policy: definition.policy as never } : {}),
        ...(definition.agentInvocable === true ? { agentInvocable: true } : {}),
      };
      // SAME compiler pass the flows route uses (T-020): dead zone references
      // and UNSAT assignments are REJECTED here (a promotion must not install
      // a flow that would per-event fail), not skipped like a replay embed.
      const flowIssues: PlanIssue[] = validateFlow(candidate, scenario, {
        isExecutableCapability: isCapabilityExecutable,
        acceptedParameterNames,
        ...(scenario === undefined
          ? { knownZoneIds: parseMapData(env).zones.map(zone => zone.id) }
          : {}),
      });
      const errors = flowIssues.filter(issue => issue.level === 'error');
      for (const error of errors) {
        issues.push(`${path}.definition: ${error.message} — the environment drifted since the fork (re-fork and re-validate, §11.3)`);
      }
      for (const warning of flowIssues.filter(issue => issue.level !== 'error')) {
        result.warnings.push(`${path}.definition: ${warning.message}`);
      }
      artifacts.push({
        type: 'flow-definition',
        flow: {
          name,
          description: typeof definition.description === 'string' ? definition.description : '',
          enabled: candidate.enabled,
          trigger: definition.trigger,
          plan: definition.plan,
          ...(Array.isArray(definition.inputs)
            ? { inputs: definition.inputs as Array<Record<string, unknown>> }
            : {}),
          ...(isPlainObject(definition.policy) ? { policy: definition.policy } : {}),
          ...(definition.agentInvocable === true ? { agentInvocable: true } : {}),
        },
      });
      continue;
    }
    if (type === 'agent-policy') {
      const agentId = raw.agentId;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        issues.push(`${path}.agentId must be a non-empty string`);
        continue;
      }
      const agent = ctx.envStore.getAgent(agentId);
      if (agent === undefined || agent.env_id !== env.id) {
        issues.push(`${path}.agentId references unknown agent "${agentId}" in this environment — the topology drifted since the fork (re-fork and re-validate, §11.3)`);
        continue;
      }
      const patch: Extract<NormalizedAdoptArtifact, { type: 'agent-policy' }>['patch'] = {};
      const allowed = ['capabilities', 'decisionPolicy', 'llm', 'enabled'];
      for (const [field, value] of Object.entries(raw)) {
        if (field === 'type' || field === 'agentId') continue;
        if (!allowed.includes(field)) {
          issues.push(`${path}.${field} is not a promotable agent-policy field (allowed: ${allowed.join(', ')})`);
          continue;
        }
        if (field === 'capabilities') {
          if (!Array.isArray(value) || value.some(c => typeof c !== 'string')) {
            issues.push(`${path}.capabilities must be an array of strings`);
            continue;
          }
          checkCapabilityWhitelist(value, `${path}.capabilities`, issues);
          // T-206 parity: capabilities are checked against the agent's
          // CURRENT bound devices (rebinding cannot smuggle declarations).
          checkCapabilityBacking(
            value as string[],
            parseJsonArray<string>(agent.bound_device_ids_json)
              .map(id => ctx.envStore.getDevice(id)!)
              .filter(row => row !== undefined),
            `${path}.capabilities`,
            issues,
          );
          patch.capabilities = value as string[];
        } else if (field === 'decisionPolicy') {
          if (value !== null && !isPlainObject(value)) {
            issues.push(`${path}.decisionPolicy must be an object or null`);
            continue;
          }
          patch.decisionPolicy = checkDecisionPolicy(value, `${path}.decisionPolicy`, issues);
        } else if (field === 'llm') {
          if (value !== null && !isPlainObject(value)) {
            issues.push(`${path}.llm must be an object or null`);
            continue;
          }
          patch.llm = value as Record<string, unknown> | null;
        } else if (field === 'enabled') {
          if (typeof value !== 'boolean') {
            issues.push(`${path}.enabled must be a boolean`);
            continue;
          }
          patch.enabled = value;
        }
      }
      if (Object.keys(patch).length === 0) {
        issues.push(`${path} carries no promotable fields (at least one of ${allowed.join(', ')})`);
        continue;
      }
      artifacts.push({ type: 'agent-policy', agentId, patch });
      continue;
    }
    // computation-spec
    const serviceId = raw.serviceId;
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      issues.push(`${path}.serviceId must be a non-empty string`);
      continue;
    }
    const service = ctx.serviceStore?.getService?.(serviceId);
    if (service === undefined) {
      issues.push(`${path}.serviceId references unknown service "${serviceId}" in this environment — the topology drifted since the fork (re-fork and re-validate, §11.3)`);
      continue;
    }
    if (service.env_id !== env.id) {
      issues.push(`${path}.serviceId belongs to environment "${service.env_id}", not "${env.id}"`);
      continue;
    }
    if (service.origin === 'derived') {
      issues.push(`${path}.serviceId names a DERIVED service — computation specs belong to published data services (SERVICE_DERIVED_READONLY parity, T-065)`);
      continue;
    }
    if (!isPlainObject(raw.spec)) {
      issues.push(`${path}.spec must be an object (the computation spec wire shape)`);
      continue;
    }
    // SAME parser the services route uses; its ApiError issues become rule
    // issues (teaching, recorded on the proposal).
    let spec: ReturnType<typeof parseComputationSpec>;
    try {
      spec = parseComputationSpec(raw.spec);
    } catch (error) {
      if (error instanceof ApiError) {
        issues.push(`${path}.spec: ${error.message}`);
        continue;
      }
      throw error;
    }
    // T-065 parity: a spec declaring inputs.devices may only read the
    // provider agent's OWN bound devices.
    if (spec.spec.devices !== undefined) {
      const provider = ctx.envStore.getAgent(service.provider_agent_id);
      const bound = new Set(provider !== undefined ? parseJsonArray<string>(provider.bound_device_ids_json) : []);
      const invalid = spec.spec.devices.filter(deviceId => !bound.has(deviceId));
      if (invalid.length > 0) {
        issues.push(`${path}.spec.inputs.devices names device(s) not bound to the provider agent: ${invalid.map(id => `"${id}"`).join(', ')} — a computation may only read the provider's own bound devices (T-065)`);
      }
    }
    artifacts.push({
      type: 'computation-spec',
      serviceId,
      spec: raw.spec,
      schemaVersion: spec.schemaVersion,
      asNames: spec.asNames,
    });
  }

  if (issues.length === 0 && artifacts.length === 0) {
    issues.push('payload.artifacts produced no valid artifacts');
  }
  result.adoptArtifacts = artifacts;

  // Flow quota (Fix-44f parity): the apply creates flow rows — cap it here so
  // the proposal is rejected instead of half-applied at apply time.
  const flowCount = artifacts.filter(artifact => artifact.type === 'flow-definition').length;
  if (ctx.flowStore !== undefined && flowCount > 0 &&
      ctx.flowStore.listByEnvironment(env.id).length + flowCount > MAX_FLOWS_PER_ENV) {
    issues.push(`quota "flows_per_env" exceeded: adopting ${flowCount} flow(s) would pass the ${MAX_FLOWS_PER_ENV}-flow cap — disable or delete unused flows first`);
  }

  // --- R41-F4: same-name artifact detection — the D2/A1 explorations
  // produced DUPLICATE flows after adopting (a flow created directly in the
  // parent env while the fork carried the same candidate). Warn loudly;
  // the owner sees it at decide time.
  if (ctx.flowStore !== undefined) {
    const existingNames = new Set(
      ctx.flowStore.listByEnvironment(env.id).map(flow => flow.name),
    );
    for (const artifact of artifacts) {
      if (artifact.type === 'flow-definition' && existingNames.has(artifact.flow.name)) {
        result.warnings.push(
          `an environment flow named "${artifact.flow.name}" ALREADY EXISTS — adopting will create a duplicate; disable or rename one first (R41-F4)`,
        );
      }
    }
  }

  // --- risk (§11.3): promotion into the AUTHORITATIVE world is a one-time
  // explicit governance act (design-living-worlds §11) — D2-F9: the default
  // used to be medium with AI-allow auto-apply, so a fork-validated flow
  // entered the authoritative world with no owner decision point. Every
  // adopt-config now force-escalates; actuation policies / bulk artifacts
  // additionally raise the risk label to high.
  result.riskLevel = 'medium';
  const actuation = artifacts.some(
    artifact => artifact.type === 'agent-policy' && artifact.patch.decisionPolicy !== undefined,
  );
  if (actuation || artifacts.length > HIGH_RISK_ADOPT_ARTIFACT_THRESHOLD) {
    result.riskLevel = 'high';
  }
  result.forceEscalate = true;
  result.escalateReason = [
    actuation
      ? 'adopt-config includes an agent decisionPolicy (the actuation policy)'
      : undefined,
    artifacts.length > HIGH_RISK_ADOPT_ARTIFACT_THRESHOLD
      ? `${artifacts.length} artifacts in one adopt-config exceeds the high-risk threshold (${HIGH_RISK_ADOPT_ARTIFACT_THRESHOLD})`
      : undefined,
    // Always present (D2-F9): the promotion itself requires the owner.
    'adopt-config promotes fork-validated artifacts into the AUTHORITATIVE world — the environment owner must decide (§11, D2-F9)',
  ].filter((reason): reason is string => reason !== undefined).join('; ');

  // --- T-078 (DevLoop R23): flagged flow text force-escalates -------------
  // Flow authoring is DIRECT (the ruling: T-201 author scoping is the safety
  // model, no proposal lane), so an adopt-config promotion is the one
  // governance gate foreign flow text rides into this env. The S1
  // payload-wide injection gate already trips on raw markers, but this hook
  // names the ARTIFACT and reuses the SAME core oracle the authoring-side
  // flag uses (securityFlagsForFlow) — verdicts cannot drift. OR-composed
  // with the markers above, in the applyHumanReviewPolicy style.
  const flaggedFlows = artifacts.flatMap(artifact => {
    if (artifact.type !== 'flow-definition') return [];
    const flags = securityFlagsForFlow(artifact.flow);
    return flags.length > 0
      ? [{ name: artifact.flow.name, flags: flags.map(f => `${f.field}: [${f.marker}]`) }]
      : [];
  });
  if (flaggedFlows.length > 0) {
    const reason =
      `flow-definition artifact(s) carry prompt-injection markers (` +
      `${flaggedFlows.map(f => `"${f.name}" (${f.flags.slice(0, 3).join('; ')})`).join(', ')}) — ` +
      'flagged flow text never auto-applies; the environment owner must review (T-078)';
    const prior = result.escalateReason;
    result.riskLevel = 'high';
    result.forceEscalate = true;
    result.escalateReason = prior !== undefined ? `${prior}; ${reason}` : reason;
  }

  // --- review inputs (P2F risk note): fork validation ≠ real validation ---
  result.warnings.push(
    'fork validation is evidence, not proof: the artifacts were validated under the fork\'s conditions — ' +
      'the authoritative world re-evaluates them under its own evolution and obligations ' +
      '(design-living-worlds §11); attach eval-run evidence (payload.evidence.evalRunId) when available',
  );
  if (evidence === undefined) {
    result.warnings.push('no evidence attached — strongly recommended: an eval-run comparing fork vs authoritative behavior (§11.2)');
  }
}
