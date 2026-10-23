/**
 * Flow assignment resolution + node invoker (user-orchestrated flows).
 *
 * Two seams:
 *
 *   resolveFlowAssignments(flow, scenario)
 *     Statically maps every plan node to an agent — the same role the plan
 *     validator's assignment pass plays for LLM-synthesized plans. A node
 *     with an explicit assigneeAgentId is checked (agent exists AND a bound
 *     device provides the capability); a node without one is auto-matched
 *     among agents whose bound devices provide it. T-201: eligibility is
 *     author-scoped (flow.authorUserId vs ScenarioAgent.ownerUserId) and
 *     device ambiguity (several bound devices qualify, no node.deviceId
 *     pin) is an ERROR naming the devices — was: warning + arbitrary pick.
 *     DevLoop: the executable contract (device-backed) is enforced at
 *     validation time — validation used to accept agent-DECLARED
 *     capabilities, so flows passed authoring and failed mid-run.
 *
 *   createFlowNodeInvoker(agents)
 *     The runtime mediation seam handed to PlanExecutor. Deliberately
 *     narrower than ACExecutor's path: a flow node ONLY actuates the
 *     assignee agent's OWN devices (own-resources path), via the agent's
 *     DeviceResource capability→command mapping (agent.executeDeviceCapability
 *     — the same mapping ACExecutor.executeDeviceCapability ends up in, but
 *     with NO collaboration/AC context). Cross-agent service requests are
 *     not part of flows v1. Never throws: every failure is reported as
 *     `{ success: false, error }`.
 */

import type { CognitiveAgent } from '../agent/CognitiveAgent.js';
import type { ScenarioDefinition, ScenarioDevice } from '../scenario/scenario-types.js';
import type { PlanIssue, PlanNode } from '../workflow/plan-schema.js';
import type { PlanNodeInvocation, PlanNodeInvoker, PlanNodeInvokeContext } from '../workflow/plan-executor.js';
import {
  multiCommandNamesForDeviceType,
  semanticCommandForDeviceType,
} from '../resource/DeviceResource.js';
import { capabilityMatches } from '../utils/capabilityMatching.js';
import type { FlowDefinition } from './flow-types.js';

// ============================================================================
// Assignment resolution
// ============================================================================

export interface FlowAssignmentResult {
  /** nodeId → agentId for every satisfiable node. */
  assignments: Map<string, string>;
  issues: PlanIssue[];
}

/**
 * Options for assignment resolution / flow validation (T-002).
 *
 * Core cannot depend on the simulation package that owns the live command
 * handler registry (the dependency direction is simulation → core), so the
 * host app INJECTS the executability oracle: simulation's
 * `isCapabilityExecutable` (true when a capability name dispatches to a
 * registered command handler or is a read/query capability). Without it, a
 * declared capability is assumed executable — the legacy core-only
 * behavior, kept so core consumers without a device runtime still validate.
 */
export interface FlowAssignmentOptions {
  isExecutableCapability?: (capabilityName: string) => boolean;
  /**
   * R13 (CB-F01): injected param-shape oracle — the parameter spellings a
   * command's runtime handler accepts (simulation's
   * `acceptedParameterNames`), or undefined for commands without a known
   * hint entry. When provided and a node's `params` is a non-empty object
   * whose keys match NONE of the accepted spellings, validation fails with
   * a rename-teaching issue: unrecognized params are dropped at run time,
   * so the node would execute with no effect (the round-13 clinic flow's
   * `set-fan-speed {fanSpeed}` died exactly there). Commands without an
   * entry are never flagged — hints are not the executability contract.
   */
  acceptedParameterNames?: (commandName: string) => readonly string[] | undefined;
  /**
   * T-305 (DevLoop R12): fallback zone list for the Fix-44k trigger-zone
   * existence check when no scenario is available (the REST authoring path
   * on an env whose world fails — or has nothing — to bridge). The zone
   * check must be unconditional for REST create/PATCH; file/scenario
   * consumers pass a real scenario and never need this.
   */
  knownZoneIds?: readonly string[];
}

/**
 * Device-capability match mirroring the runtime invoker's resource matching
 * (createFlowNodeInvoker): the shared synonym-aware `capabilityMatches` —
 * exact name first, then case-insensitive containment, then the platform
 * synonym table. Validation and execution MUST agree on this contract,
 * otherwise flows validate but die mid-run (DevLoop: the
 * "validation checks agent-level, execution needs device-level" gap).
 *
 * T-206: exported so agent-authoring validation (proposal rules, owner
 * direct create, modify-object patches) checks declared capabilities with
 * the SAME matcher the flow runtime dispatches through — one pure shared
 * function, never a duplicated dispatch heuristic.
 *
 * R21-W3 (R11 P2 #6, finally applied): this used to be a SECOND matcher —
 * exact + containment only, no synonyms — while the authorization side
 * (proposal-rules, partner selection, plan validation) matched through
 * capabilityMatches. A capability authorized by synonym (e.g. 'cooling' on
 * a 'temperature-control' device) then had no runtime dispatch path.
 * deviceProvides now delegates to the ONE matcher; authorization and
 * dispatch cannot disagree on what a device provides.
 */
export function deviceProvides(deviceCapabilities: readonly string[], capability: string): boolean {
  return deviceCapabilities.some(declared => capabilityMatches(declared, capability));
}

/** Human-facing device label for error messages (name preferred, id fallback). */
function deviceDisplayName(device: ScenarioDevice): string {
  return device.name ?? device.id;
}

/** The bound devices of an agent in scenario order. */
function boundDevicesOf(scenario: ScenarioDefinition, agentId: string): ScenarioDevice[] {
  const agent = scenario.agents.find(a => a.id === agentId);
  if (!agent) return [];
  const bound = new Set(agent.boundDeviceIds);
  return scenario.devices.filter(d => bound.has(d.id));
}

/**
 * The actual COMMAND NAMES a capability dispatches to on this device, or null
 * when there is no executable path (T-043/T-056: ONE shared surface contract
 * — the boolean oracle below is a thin wrapper, and the server's derived
 * service labeling consumes the same route decision, so "executable" and
 * "what actually runs" can never drift apart). Mirrors every DeviceResource
 * dispatch route:
 *
 *   1. the capability name itself is a command → [capability]
 *   2. a containment-matching DECLARED capability is a command → [declared]
 *   3. the semantic mapping maps it to a standard command for the device
 *      type → [mapped] ('environment' → 'turn-on' on actuators)
 *   4. the device type expands it into a multi-command sequence →
 *      [expanded names] ('lighting-control' on a light → turn-on +
 *      set-brightness)
 *
 * hass://-bound devices are real Home Assistant hardware — the simulation
 * registry cannot speak for them, so a declaration is enough ([capability]).
 */
export function executableCommandPath(
  device: ScenarioDevice,
  capability: string,
  isExecutable?: (capabilityName: string) => boolean,
): readonly string[] | null {
  if (!deviceProvides(device.capabilities, capability)) return null;
  if (device.binding?.startsWith('hass://')) return [capability];
  if (isExecutable === undefined) return [capability]; // no oracle → declared = executable (legacy)
  if (isExecutable(capability)) return [capability];
  for (const declared of device.capabilities) {
    // R21-W3: same ONE matcher — a synonym-declared executable capability
    // is a dispatch route (the authorization side already counted it).
    if (capabilityMatches(declared, capability) && isExecutable(declared)) return [declared];
  }
  const mapped = semanticCommandForDeviceType(capability, device.type);
  if (mapped.toLowerCase() !== capability.toLowerCase() && isExecutable(mapped)) return [mapped];
  const expansion = multiCommandNamesForDeviceType(capability, device.type);
  if (expansion !== null && expansion.every(isExecutable)) return expansion;
  return null;
}

/**
 * True when the device offers an EXECUTABLE path for the capability
 * (T-002): declaration alone is not enough — at run time the flow invoker
 * dispatches through DeviceResource, so the capability must land on a
 * registered command handler or a read/query name. Mirrors every
 * DeviceResource dispatch route so working flows are never false-rejected
 * (see `executableCommandPath` — this is its boolean form).
 */
export function deviceProvidesExecutablePath(
  device: ScenarioDevice,
  capability: string,
  isExecutable?: (capabilityName: string) => boolean,
): boolean {
  return executableCommandPath(device, capability, isExecutable) !== null;
}

/**
 * R33 (DevLoop, Smart F3): the concrete command names a device can EXECUTE
 * — every declared capability expanded through the SAME dispatch routes the
 * runtime uses (literal → containment → semantic → multi). This is the
 * actionable vocabulary the budget-gate error teaches with, so an author
 * whose 'set-temperature' budget command failed against a 'cooling'-only
 * device sees exactly which names WOULD pass instead of a loop of
 * capability-patch → re-author → fail.
 */
function executableCommandsOf(
  device: ScenarioDevice,
  isExecutable?: (capabilityName: string) => boolean,
): string[] {
  if (isExecutable === undefined || device.binding?.startsWith('hass://')) {
    return [...device.capabilities];
  }
  const names = new Set<string>();
  for (const capability of device.capabilities) {
    const path = executableCommandPath(device, capability, isExecutable);
    if (path !== null) for (const name of path) names.add(name);
  }
  return [...names];
}

/** True when the agent's bound devices include one providing the capability. */
function agentDeviceProvides(
  scenario: ScenarioDefinition,
  agentId: string,
  capability: string,
  isExecutable?: (capabilityName: string) => boolean,
): boolean {
  return boundDevicesOf(scenario, agentId)
    .some(d => deviceProvidesExecutablePath(d, capability, isExecutable));
}

/**
 * True when the agent has a bound device that BOTH provides the capability
 * and sits in the given zone — the exact precondition the zone-scoped
 * runtime invoker enforces before actuating.
 */
function agentDeviceProvidesInZone(
  scenario: ScenarioDefinition,
  agentId: string,
  capability: string,
  zoneId: string,
  isExecutable?: (capabilityName: string) => boolean,
): boolean {
  return boundDevicesOf(scenario, agentId)
    .some(d => deviceProvidesExecutablePath(d, capability, isExecutable) && d.zoneId === zoneId);
}

/**
 * True when the agent can deliver the capability through a bound device.
 * Flows v1 actuate DEVICES exclusively (the invoker has no direct-delivery
 * path), so a capability the agent merely DECLARES is not executable —
 * DevLoop: agentCanDeliver used to accept declared capabilities, letting
 * flows pass validation and fail at run time with "no device providing
 * capability". T-002: with an executability oracle injected, DECLARING the
 * capability on the device is still not enough — the runtime dispatches
 * through command handlers, so only an executable path counts.
 */
function agentCanDeliver(
  scenario: ScenarioDefinition,
  agentId: string,
  capability: string,
  isExecutable?: (capabilityName: string) => boolean,
): boolean {
  return agentDeviceProvides(scenario, agentId, capability, isExecutable);
}

/**
 * Teaching hint appended to executability errors (T-002): the capabilities
 * the author CAN write instead, scoped to `devices` (the assignee's bound
 * devices when known, else scenario-wide). Falls back to the well-known
 * executable vocabulary when even the scenario offers none.
 */
function executableCapabilityHint(
  devices: readonly ScenarioDevice[],
  isExecutable: (capabilityName: string) => boolean,
): string {
  const names = new Set<string>();
  for (const device of devices) {
    for (const declared of device.capabilities) {
      if (isExecutable(declared)) names.add(declared);
    }
  }
  if (names.size === 0) {
    return ' — valid executable capabilities include: turn-on, turn-off, toggle, set-power, set-temperature, set-brightness, cooling, heating, set-mode, open, close';
  }
  const sorted = [...names].sort();
  const shown = sorted.slice(0, 10).join(', ') + (sorted.length > 10 ? ', …' : '');
  return ` — valid executable capabilities include: ${shown}`;
}

/**
 * True when the agent operates in the zone: it manages the zone or has a
 * bound device placed there. Used to prefer zone-local candidates for
 * zone-triggered flows — without it the first capable agent in scenario
 * order wins and the flow actuates a device in an arbitrary OTHER zone
 * (campus pilot: a "101 教室过热" flow cooled 108 教室's AC).
 */
function agentServesZone(scenario: ScenarioDefinition, agentId: string, zoneId: string): boolean {
  const agent = scenario.agents.find(a => a.id === agentId);
  if (!agent) return false;
  if (agent.managesZoneIds.includes(zoneId)) return true;
  const bound = new Set(agent.boundDeviceIds);
  return scenario.devices.some(d => bound.has(d.id) && d.zoneId === zoneId);
}

/** The zone a zone-scoped trigger fires for (condition/event; else undefined). */
function flowTriggerZoneId(flow: FlowDefinition): string | undefined {
  return flow.trigger.kind === 'condition' || flow.trigger.kind === 'event'
    ? flow.trigger.zoneId
    : undefined;
}

/**
 * R13 (CB-F01): authoring-time param-shape check. The runtime drops param
 * keys the command handler does not recognize, so an ALL-unrecognized
 * params object is a guaranteed no-effect node — teach it at authoring with
 * a rename hint instead of letting the flow die mid-run. Only fires for
 * commands with a KNOWN accepted-spelling list (injected by the host app);
 * empty/absent params are legal (values may be injected at run time).
 */
function checkNodeParamShape(
  node: PlanNode,
  acceptedParameterNames: ((commandName: string) => readonly string[] | undefined) | undefined,
  issues: PlanIssue[],
): void {
  if (acceptedParameterNames === undefined) return;
  const params = node.params;
  if (params === undefined || typeof params !== 'object' || Array.isArray(params)) return;
  const sentKeys = Object.keys(params);
  if (sentKeys.length === 0) return;
  const accepted = acceptedParameterNames(node.capability);
  if (accepted === undefined || accepted.length === 0) return;
  const acceptedLower = accepted.map(name => name.toLowerCase());
  const matched = sentKeys.filter(key => acceptedLower.includes(key.toLowerCase()));
  if (matched.length > 0) return;
  // Rename hint: a sent key that case-insensitively CONTAINS an accepted
  // key (or vice versa) is almost certainly the author's spelling of it.
  const nearMisses = sentKeys
    .map(key => {
      const sent = key.toLowerCase();
      const target = accepted.find(name => {
        const acc = name.toLowerCase();
        return sent.includes(acc) || acc.includes(sent);
      });
      return target !== undefined ? `${key} → ${target}` : undefined;
    })
    .filter((hint): hint is string => hint !== undefined);
  const renameHint = nearMisses.length > 0
    ? `; rename the param key(s): ${nearMisses.join(', ')}`
    : '';
  issues.push({
    level: 'error',
    nodeId: node.id,
    message:
      `node '${node.id}': command '${node.capability}' accepts params (${accepted.join(', ')}) but the node ` +
      `carries {${sentKeys.join(', ')}}${renameHint} — unrecognized params are dropped at run time, ` +
      'so this node would execute with no effect',
  });
}

/**
 * T-201 author scoping: a flow authored by tenant X may only actuate agents
 * owned by X. Agents WITHOUT owner attribution (file-based scenarios, legacy
 * rows) stay eligible for everyone — core-only consumers keep today's
 * semantics. Flows without `authorUserId` (env-owner-authored, file flows)
 * are unrestricted.
 */
function agentEligibleForAuthor(
  agent: { ownerUserId?: string },
  authorUserId: string | undefined,
): boolean {
  if (authorUserId === undefined) return true;
  return agent.ownerUserId === undefined || agent.ownerUserId === authorUserId;
}

/**
 * Mechanism D: the SAME T-201 eligibility rule, keyed by owner ids (the
 * server's flow-service publish path holds AgentInstanceRow/FlowRow, not
 * scenario objects). Exported so "which agents may front a flow authored by
 * user X" can never drift from "which agents may execute that flow's nodes"
 * — the publish gate and the runtime assignment pass share ONE oracle.
 */
export function ownerEligibleForFlowAuthor(
  agentOwnerUserId: string | undefined,
  flowAuthorUserId: string | undefined,
): boolean {
  return agentEligibleForAuthor({ ownerUserId: agentOwnerUserId }, flowAuthorUserId);
}

/** The T-201 governance message for cross-tenant actuation attempts. */
function crossTenantMessage(nodeId: string, agentId: string): string {
  return (
    `node '${nodeId}': assignee '${agentId}' is owned by another tenant — ` +
    'flow nodes actuate the flow author\'s own agents/devices; cross-tenant ' +
    'actuation runs through an agreement invocation (provider-executed, metered)'
  );
}

/**
 * T1 (R2, u3-F1): authoring-time capability-drift warning. Flow execution
 * runs on the assignee's DEVICE capabilities (the own-devices-only invoker
 * never consults the declaration), so an assignee whose DECLARED capability
 * set no longer covers node.capability still executes the node — but
 * governance (partner selection, service discovery, the agent's own offer
 * face) reads declarations, and the run is "succeeding on borrowed
 * authority". WARNING-level on purpose (never a 422): the device truth is
 * the executable contract and existing flows must keep validating, while the
 * receipt teaches the gap. The same check annotates runs at runtime
 * (computeCapabilityDrift in flow-engine.ts).
 */
function warnDeclarationDrift(
  node: PlanNode,
  scenario: ScenarioDefinition,
  agentId: string,
  issues: PlanIssue[],
): void {
  const agent = scenario.agents.find(a => a.id === agentId);
  if (!agent) return;
  if (agent.capabilities.some(declared => capabilityMatches(declared, node.capability))) return;
  issues.push({
    level: 'warning',
    nodeId: node.id,
    message:
      `node '${node.id}': assignee '${agentId}' does not declare capability '${node.capability}' ` +
      `(declares: ${agent.capabilities.join(', ') || 'nothing'}) — the node still executes through ` +
      "the assignee's bound device, which provides it, but the agent's DECLARED offer surface does not list " +
      `'${node.capability}': catalog/agreement rows stay consumable yet are marked ` +
      "'declaredByProvider:false' until the capability is re-declared; re-declare the capability or repoint the node",
  });
}

/**
 * R6-B-F03: the sentinel assignment for SERVICE nodes. A service node has
 * no assignee agent — execution is mediated by the flow author's ACTIVE
 * AGREEMENT with the service's provider (the server's service-invocation
 * lane), so assignment resolution maps the node to this marker purely to
 * satisfy the PlanExecutor's "every node has an assignment" contract. The
 * FlowEngine's dispatch intercepts service nodes BEFORE the own-devices
 * invoker ever sees the marker.
 */
export const FLOW_SERVICE_NODE_ASSIGNEE = ':service-agreement:';

/**
 * FEAT-05/06: the sentinel assignee for engine-dispatched nodes (notify /
 * wait). Like FLOW_SERVICE_NODE_ASSIGNEE it exists purely to satisfy the
 * PlanExecutor's "every node has an assignment" contract — the FlowEngine's
 * dispatch intercepts these node kinds BEFORE the own-devices invoker ever
 * sees the marker (notify → the host's notification lane; wait → the
 * engine's sim clock).
 */
export const FLOW_BUILTIN_NODE_ASSIGNEE = ':flow-builtin:';

/**
 * Validate a node's pinned device (T-201): it must exist in the world
 * snapshot, be bound to the assignee, provide the capability through an
 * executable path, and sit in the trigger zone when the flow is zoned.
 * Pushes teaching errors; never throws.
 */
function checkPinnedDevice(
  node: PlanNode,
  scenario: ScenarioDefinition,
  agentId: string,
  triggerZoneId: string | undefined,
  isExecutable: ((capabilityName: string) => boolean) | undefined,
  issues: PlanIssue[],
): void {
  const pinned = scenario.devices.find(d => d.id === node.deviceId);
  if (!pinned) {
    const known = scenario.devices.slice(0, 5).map(d => d.id).join(', ');
    issues.push({
      level: 'error',
      nodeId: node.id,
      message:
        `deviceId '${node.deviceId}' does not exist in this simulation's world snapshot ` +
        `(known devices: ${known}${scenario.devices.length > 5 ? ', …' : ''})`,
    });
    return;
  }
  if (!boundDevicesOf(scenario, agentId).some(d => d.id === pinned.id)) {
    const holder = scenario.agents.find(a => a.boundDeviceIds.includes(pinned.id));
    const holderNote = holder
      ? `it is bound to agent '${holder.id}'`
      : 'it is not bound to any agent';
    issues.push({
      level: 'error',
      nodeId: node.id,
      message:
        `deviceId '${pinned.id}' (${deviceDisplayName(pinned)}) is not bound to assignee '${agentId}' ` +
        `— ${holderNote}; flow nodes actuate the assignee's own bound devices only`,
    });
    return;
  }
  if (!deviceProvidesExecutablePath(pinned, node.capability, isExecutable)) {
    // T-312 (EO-F04): distinguish DECLARED-but-unexecutable (the device
    // declares the capability but no registered command handler executes it)
    // from genuine non-declaration — the old single message contradicted
    // itself ("does not provide capability 'emergency-call' (it provides:
    // emergency-call)").
    const declared = deviceProvides(pinned.capabilities, node.capability);
    if (declared) {
      const hint = isExecutable !== undefined
        ? executableCapabilityHint([pinned], isExecutable)
        : '';
      issues.push({
        level: 'error',
        nodeId: node.id,
        message:
          `capability '${node.capability}' is declared by pinned device '${deviceDisplayName(pinned)}' ` +
          'but no registered command handler executes it' + hint +
          ' — flow nodes actuate devices through registered command handlers',
      });
    } else {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message:
          `pinned device '${deviceDisplayName(pinned)}' does not provide capability '${node.capability}' ` +
          `(it provides: ${pinned.capabilities.join(', ') || 'nothing'})`,
      });
    }
    return;
  }
  // R1 (B1-8 / P-17): the zone gate is the ONE check authoring and runtime
  // share for declared trigger zones — and `crossZone: true` is the explicit
  // declaration that the pin intentionally reaches outside it (fire-evacuation
  // broadcast), honored identically on both sides.
  if (triggerZoneId !== undefined && node.crossZone !== true && pinned.zoneId !== triggerZoneId) {
    issues.push({
      level: 'error',
      nodeId: node.id,
      message:
        `pinned device '${deviceDisplayName(pinned)}' sits in zone '${pinned.zoneId}' but the trigger ` +
        `zone is '${triggerZoneId}' — a zone-triggered flow refuses to actuate another zone's device; ` +
        'pin a device in the trigger zone, or declare `crossZone: true` on the node for intentional ' +
        'cross-zone actuation (e.g. fire-evacuation broadcast)',
    });
  }
}

/**
 * T-201 device ambiguity: after the assignee is resolved, the bound devices
 * providing the capability (executable path, zone-filtered for zoned runs)
 * must be exactly ONE — or the node must pin one with `deviceId`. Multiple
 * qualifying devices used to actuate an arbitrary one (SF-F01: "success 2/2"
 * while turn-off AND turn-on both hit the siren, gate untouched).
 */
function checkDeviceAmbiguity(
  node: PlanNode,
  scenario: ScenarioDefinition,
  agentId: string,
  triggerZoneId: string | undefined,
  isExecutable: ((capabilityName: string) => boolean) | undefined,
  issues: PlanIssue[],
): void {
  let devices = boundDevicesOf(scenario, agentId)
    .filter(d => deviceProvidesExecutablePath(d, node.capability, isExecutable));
  if (triggerZoneId !== undefined) {
    devices = devices.filter(d => d.zoneId === triggerZoneId);
  }
  if (devices.length > 1) {
    const names = devices.map(deviceDisplayName).join(', ');
    const zoneNote = triggerZoneId !== undefined ? ` in zone '${triggerZoneId}'` : '';
    issues.push({
      level: 'error',
      nodeId: node.id,
      message:
        `capability '${node.capability}' is ambiguous for agent '${agentId}'${zoneNote} — ` +
        `${devices.length} devices provide it (${names}); ` +
        'pin one with node.deviceId or split into per-device nodes',
    });
  }
}

/**
 * Mechanism A (mixed-initiative flows): resolve a DELEGATE node's assignee
 * and — for actuating delegates — validate its execution budget. Runs inside
 * resolveFlowAssignments so AUTHORING validation (validateFlow → 422) and
 * the RUNTIME refusal pass share ONE oracle (T-051: duplicated verdicts
 * drift).
 *
 * Assignee resolution mirrors action-node semantics minus the capability
 * signal (the judgment IS the deliverable):
 *   - explicit assignee: must exist, be author-scoped (T-201) and enabled;
 *   - no assignee: auto-match among author-eligible enabled agents; for
 *     actuating delegates only agents bound to EVERY budget device qualify.
 *     Several candidates → warning + first in scenario order (deterministic,
 *     same rule as action-node capability auto-match); none → teaching error.
 *
 * Budget validation (actuating only; the ratified trade-off #1 applies):
 *   - every budget device exists in the world snapshot;
 *   - every budget device is bound to the assignee (own-devices-only path);
 *   - every allowedCommand has an EXECUTABLE path on EVERY budget device
 *     (executableCommandPath — the same oracle action nodes use);
 *   - on zone-scoped triggers (event/condition) every budget device sits
 *     INSIDE the trigger zone — a zone-X flow never touches zone-Y devices,
 *     judgment-driven actuations included. Cross-zone needs per-zone
 *     delegation or the agreement path.
 */
function resolveDelegateAssignment(
  node: PlanNode,
  flow: FlowDefinition,
  scenario: ScenarioDefinition,
  triggerZoneId: string | undefined,
  isExecutable: ((capabilityName: string) => boolean) | undefined,
  assignments: Map<string, string>,
  issues: PlanIssue[],
): void {
  const spec = node.delegate!;
  const budget = spec.mode === 'actuating' ? spec.budget : undefined;
  let agentId: string | undefined;

  if (node.assigneeAgentId !== undefined) {
    agentId = node.assigneeAgentId;
    const agent = scenario.agents.find(a => a.id === agentId);
    if (!agent) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message:
          `assigneeAgentId '${agentId}' does not exist in this simulation's world snapshot ` +
          `(scenario '${scenario.meta.id}')`,
      });
      return;
    }
    if (!agentEligibleForAuthor(agent, flow.authorUserId)) {
      issues.push({ level: 'error', nodeId: node.id, message: crossTenantMessage(node.id, agentId) });
      return;
    }
    if (agent.enabled === false) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message:
          `delegate node '${node.id}': assignee '${agentId}' is disabled — delegates honor the agent master ` +
          'switch; re-enable the agent or pick another assignee',
      });
      return;
    }
  } else {
    // Auto-match: author-eligible + enabled; actuating delegates additionally
    // require the agent to be bound to EVERY budget device (the actuation
    // path is own-devices-only, so an unbound budget device could never run).
    const candidates = scenario.agents.filter(a => {
      if (!agentEligibleForAuthor(a, flow.authorUserId) || a.enabled === false) return false;
      if (budget === undefined) return true;
      return budget.deviceIds.every(id => a.boundDeviceIds.includes(id));
    });
    if (candidates.length === 0) {
      const eligible = scenario.agents.filter(
        a => agentEligibleForAuthor(a, flow.authorUserId) && a.enabled !== false,
      );
      issues.push({
        level: 'error',
        nodeId: node.id,
        message:
          `delegate node '${node.id}' has no eligible assignee — ` +
          (budget !== undefined
            ? `no enabled agent owned by the flow author is bound to every budget device ` +
              `(${budget.deviceIds.join(', ')})`
            : eligible.length === 0
              ? 'the scenario has no enabled agents eligible for this flow author'
              : `eligible agents: ${eligible.map(a => `'${a.id}'`).join(', ')} — pin one with assigneeAgentId`) +
          '; delegates run the assignee\'s own LLM judgment and (for actuating mode) its own devices only',
      });
      return;
    }
    if (candidates.length > 1) {
      issues.push({
        level: 'warning',
        nodeId: node.id,
        message:
          `delegate assignee is ambiguous — ${candidates.length} candidates ` +
          `(${candidates.map(a => a.id).join(', ')}); assigned to '${candidates[0].id}'`,
      });
    }
    agentId = candidates[0].id;
  }

  // Budget validation (actuating only — advice has none by construction).
  if (budget !== undefined) {
    let valid = checkDelegateBudget(node, budget, scenario, agentId, triggerZoneId, isExecutable, issues);
    if (!valid) return;
  }

  assignments.set(node.id, agentId);
}

/**
 * Validate an actuating delegate's budget devices (existence, binding,
 * trigger-zone containment, per-command UNION executability). Pushes teaching
 * errors and returns false when any check fails; never throws.
 *
 * T-605 (R26, HO26-F02): per-command validation is against the budget UNION
 * — the runtime contract (flow-delegate dispatch) is (deviceId ∈ deviceIds)
 * ∧ (command ∈ allowedCommands) with honest per-pair execution at dispatch,
 * so a command needs an executable path on AT LEAST ONE budget device. The
 * old intersection demand (every command on EVERY device) made heterogeneous
 * budgets ("play-alert on PA + show-message on display") inexpressible.
 * Heterogeneous commands get a warning naming the devices that run them
 * (teaches the pairing); per-device command mappings stay expressible via
 * multiple delegate nodes.
 */
function checkDelegateBudget(
  node: PlanNode,
  budget: NonNullable<PlanNode['delegate']>['budget'] & object,
  scenario: ScenarioDefinition,
  agentId: string,
  triggerZoneId: string | undefined,
  isExecutable: ((capabilityName: string) => boolean) | undefined,
  issues: PlanIssue[],
): boolean {
  let valid = true;
  const devices: ScenarioDevice[] = [];
  for (const deviceId of budget.deviceIds) {
    const device = scenario.devices.find(d => d.id === deviceId);
    if (!device) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message:
          `budget deviceId '${deviceId}' does not exist in this simulation's world snapshot ` +
          `(known devices: ${scenario.devices.slice(0, 5).map(d => d.id).join(', ')}${scenario.devices.length > 5 ? ', …' : ''})`,
      });
      valid = false;
      continue;
    }
    if (!boundDevicesOf(scenario, agentId).some(d => d.id === device.id)) {
      const holder = scenario.agents.find(a => a.boundDeviceIds.includes(device.id));
      const holderNote = holder
        ? `it is bound to agent '${holder.id}'`
        : 'it is not bound to any agent';
      issues.push({
        level: 'error',
        nodeId: node.id,
        message:
          `budget deviceId '${device.id}' (${deviceDisplayName(device)}) is not bound to assignee '${agentId}' ` +
          `— ${holderNote}; delegate actuations run on the assignee's own bound devices only`,
      });
      valid = false;
      continue;
    }
    // Ratified trade-off #1: actuating budgets stay INSIDE the trigger zone.
    if (triggerZoneId !== undefined && device.zoneId !== triggerZoneId) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message:
          `budget device '${deviceDisplayName(device)}' sits in zone '${device.zoneId}' but the trigger zone is ` +
          `'${triggerZoneId}' — a zone-triggered flow's delegate budget must stay inside the trigger zone ` +
          '(a zone-X flow never touches zone-Y devices, judgment-driven actuations included); ' +
          'use per-zone delegation or an agreement invocation for cross-zone actuation',
      });
      valid = false;
      continue;
    }
    devices.push(device);
  }
  // T-605: per-command UNION over the surviving (valid, bound, in-zone)
  // budget devices — mirrors the runtime's own gate. Skipped when no device
  // survived (their errors already said why).
  if (devices.length > 0) {
    for (const command of budget.allowedCommands) {
      const capable = devices.filter(
        device => executableCommandPath(device, command, isExecutable) !== null,
      );
      if (capable.length === 0) {
        // R33 (DevLoop, Smart F3): break the circular authoring loop — the
        // old message listed DECLARED capabilities while the gate demands
        // EXECUTABLE command names, so "provides: cooling" looked provided
        // while 'set-temperature' kept failing, and the only exits (use the
        // declared name, or widen the device's capabilities) were invisible.
        // The surface below expands every declared capability through the
        // SAME dispatch routes the runtime uses, so the author sees exactly
        // which names WOULD pass.
        const surfacePerDevice = devices.map(device => {
          const execList = executableCommandsOf(device, isExecutable);
          const execJoined = execList.join(', ') || 'nothing';
          const declared = device.capabilities.join(', ') || 'nothing';
          return {
            execList,
            text: `${device.id} executes: ${execJoined}` +
              (execJoined !== declared ? ` (declared: ${declared})` : ''),
          };
        });
        const reachableViaSemantics =
          surfacePerDevice.some(entry => entry.execList.includes(command));
        const commandRegistered = isExecutable === undefined || isExecutable(command);
        const fixLane = reachableViaSemantics
          ? `'${command}' IS reachable on a budget device through a declared semantic capability (see the ` +
            `expansion above), but the budget gate matches LITERAL declarations — use the DECLARED capability ` +
            `name as the allowedCommand, or declare '${command}' literally on the device's capabilities`
          : commandRegistered
            ? `'${command}' IS a registered platform command — declare it LITERALLY on at least one budget ` +
              `device's capabilities (semantic names like 'cooling' do not satisfy the budget gate)`
            : `'${command}' is not a registered command on this platform — use one of the executable names above`;
        issues.push({
          level: 'error',
          nodeId: node.id,
          message:
            `budget command '${command}' has no executable path on ANY budget device — ` +
            `what the budget devices CAN execute: ${surfacePerDevice.map(entry => entry.text).join('; ')}. ` +
            `${fixLane}` +
            (commandRegistered
              ? ` (device capabilities widen via a modify-object proposal when direct device edits are owner-locked)`
              : ''),
        });
        valid = false;
      } else if (capable.length < devices.length) {
        const capableIds = capable.map(d => d.id).join(', ');
        const incapable = devices
          .filter(d => !capable.includes(d))
          .map(d => `${d.id} provides: ${d.capabilities.join(', ') || 'nothing'}`)
          .join('; ');
        issues.push({
          level: 'warning',
          nodeId: node.id,
          message:
            `budget command '${command}' executes on ${capable.length} of ${devices.length} budget devices ` +
            `(${capableIds}; ${incapable}) — the runtime pairs each model-proposed actuation with a device ` +
            'that executes its command, and out-of-pair proposals fail honestly at dispatch; ' +
            'split per-device command sets across multiple delegate nodes when you need strict pairing',
        });
      }
    }
  }
  return valid;
}

/**
 * Resolve every plan node to an assignee agent. Explicit assignees are
 * validated; unassigned nodes are auto-matched among the author's eligible
 * agents (capability-offering, zone-local first, scenario order otherwise).
 * Never throws.
 *
 * T-002: with `options.isExecutableCapability` injected, "providing" means
 * EXECUTABLE-providing — a bound device must land the capability on a
 * registered command handler (see deviceProvidesExecutablePath), because
 * that is what the runtime invoker dispatches through. A declared-but-
 * unexecutable capability (e.g. 'switch') used to pass here and fail at run
 * time with "no handler / no effect for command switch"; now it is an
 * upfront error naming the executable alternatives.
 *
 * T-201: (a) author scoping — when `flow.authorUserId` is set, only agents
 * with a matching `ownerUserId` (or no owner attribution) are eligible, for
 * auto-match AND explicit assignees; cross-tenant nodes are authoring-time
 * errors and runtime refusals. (b) device pinning + ambiguity — a node may
 * pin `deviceId`; without a pin, MORE than one qualifying device is an
 * ERROR naming the devices (was: silent arbitrary pick).
 */
export function resolveFlowAssignments(
  flow: FlowDefinition,
  scenario: ScenarioDefinition,
  options?: FlowAssignmentOptions,
): FlowAssignmentResult {
  const isExecutable = options?.isExecutableCapability;
  const acceptedParameterNames = options?.acceptedParameterNames;
  const assignments = new Map<string, string>();
  const issues: PlanIssue[] = [];
  const triggerZoneId = flowTriggerZoneId(flow);

  for (const node of flow.plan.nodes) {
    // R6-B-F03: service nodes resolve no assignee — the agreement lane is
    // the execution vehicle (quota/terms/metering live there, not in the
    // assignment pass). Shape/ref checks ran in validateFlow's teaching
    // pre-check + validateServiceNodes; the DEPENDENCY hint (does the author
    // hold an active agreement?) is the server authoring pass's job — core
    // has no contract state, and the dependency may be signed later.
    if (node.service !== undefined) {
      assignments.set(node.id, FLOW_SERVICE_NODE_ASSIGNEE);
      continue;
    }
    // FEAT-05/06: notify and wait nodes resolve no assignee either — the
    // execution vehicles are the host's notification lane and the engine's
    // sim clock respectively (no device, no agent authority). Same marker
    // contract as service nodes: the FlowEngine's dispatch intercepts them
    // BEFORE the own-devices invoker ever sees the marker.
    if (node.notify !== undefined || node.wait !== undefined) {
      assignments.set(node.id, FLOW_BUILTIN_NODE_ASSIGNEE);
      continue;
    }
    // Mechanism A: delegate nodes resolve an assignee WITHOUT a capability
    // signal (the judgment is the deliverable) but under the SAME governance
    // oracle as action nodes: author scoping (T-201), existence, enabled
    // flag, and — for actuating delegates — full budget validation (device
    // existence/binding/executability + zone containment).
    if (node.delegate !== undefined) {
      resolveDelegateAssignment(node, flow, scenario, triggerZoneId, isExecutable, assignments, issues);
      continue;
    }
    // R13 (CB-F01): param-shape teaching runs for every node regardless of
    // assignment outcome — an all-unrecognized params object is a dead node
    // even when the capability itself is executable (set-fan-speed IS
    // handled; {fanSpeed} was not a spelling it accepted, pre-fix).
    checkNodeParamShape(node, acceptedParameterNames, issues);
    if (node.assigneeAgentId !== undefined) {
      const agentId = node.assigneeAgentId;
      const agent = scenario.agents.find(a => a.id === agentId);
      if (!agent) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message:
            `assigneeAgentId '${agentId}' does not exist in this simulation's world snapshot ` +
            `(scenario '${scenario.meta.id}')`,
        });
        continue;
      }
      if (!agentEligibleForAuthor(agent, flow.authorUserId)) {
        issues.push({ level: 'error', nodeId: node.id, message: crossTenantMessage(node.id, agentId) });
        continue;
      }
      if (node.deviceId !== undefined) {
        // T-201: a pinned node's diagnostics come from the pin itself —
        // binding + provision + zone are all checked there, and its
        // "device X does not provide capability Y" is more specific than
        // the generic cannot-deliver message.
        checkPinnedDevice(node, scenario, agentId, triggerZoneId, isExecutable, issues);
        warnDeclarationDrift(node, scenario, agentId, issues);
        assignments.set(node.id, agentId);
        continue;
      }
      if (!agentCanDeliver(scenario, agentId, node.capability, isExecutable)) {
        // T-002: distinguish "nothing declares/provides it" from "declared
        // but not executable" — the latter must teach the author which
        // capability names actually dispatch at run time.
        const bound = boundDevicesOf(scenario, agentId);
        const declaredNotExecutable = isExecutable !== undefined &&
          bound.some(d => deviceProvides(d.capabilities, node.capability));
        const hint = isExecutable !== undefined
          ? executableCapabilityHint(
              bound.some(d => d.capabilities.some(isExecutable)) ? bound : scenario.devices,
              isExecutable,
            )
          : '';
        issues.push({
          level: 'error',
          nodeId: node.id,
          message: declaredNotExecutable
            ? `node '${node.id}': capability '${node.capability}' is declared by agent '${agentId}' ` +
              'but no bound device provides an executable command for it' + hint +
              ' — flow nodes actuate devices through registered command handlers'
            : `assignee '${agentId}' cannot deliver capability '${node.capability}' ` +
              "(none of its bound devices provides it — flow nodes actuate devices; " +
              'bind a device with that capability)',
        });
        continue;
      }
      checkDeviceAmbiguity(node, scenario, agentId, triggerZoneId, isExecutable, issues);
      warnDeclarationDrift(node, scenario, agentId, issues);
      assignments.set(node.id, agentId);
      continue;
    }

    // Auto-match: only EXECUTABLE candidates count — agents with a bound
    // device providing the capability (the invoker's own-devices-only
    // actuation path). Declared-but-deviceless capabilities used to pass
    // here and die mid-run; now they are an upfront error naming the fix.
    // T-201: eligibility is author-scoped first.
    const candidates = scenario.agents.filter(a =>
      agentEligibleForAuthor(a, flow.authorUserId) &&
      agentDeviceProvides(scenario, a.id, node.capability, isExecutable));

    if (candidates.length === 0) {
      const declaredOnly = scenario.agents.filter(a => a.capabilities.includes(node.capability));
      // T-201: a capable agent exists but belongs to another tenant — the
      // governance boundary, not satisfiability, is the blocker.
      const foreignProviders = scenario.agents.filter(a =>
        !agentEligibleForAuthor(a, flow.authorUserId) &&
        agentDeviceProvides(scenario, a.id, node.capability, isExecutable));
      if (flow.authorUserId !== undefined && foreignProviders.length > 0) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message:
            `no agent owned by the flow author can deliver capability '${node.capability}' — ` +
            `${foreignProviders.map(a => `'${a.id}'`).join(', ')} provide(s) it but ` +
            'belong(s) to another tenant; flow nodes actuate the flow author\'s own ' +
            'agents/devices; cross-tenant actuation runs through an agreement invocation ' +
            '(provider-executed, metered)',
        });
        continue;
      }
      // T-002: some agent's bound device DECLARES the capability, but the
      // executability oracle says nothing can dispatch it — surface that
      // (with alternatives) instead of a bare UNSAT.
      const deviceDeclared = isExecutable !== undefined && scenario.agents.some(a =>
        boundDevicesOf(scenario, a.id)
          .some(d => deviceProvides(d.capabilities, node.capability)));
      let message: string;
      if (deviceDeclared && isExecutable !== undefined) {
        // Most specific diagnosis first: a device DOES declare the
        // capability; what is missing is an executable command for it.
        message = `no agent can EXECUTE capability '${node.capability}': a bound device declares it ` +
          'but no registered command handler executes it' +
          executableCapabilityHint(
            scenario.devices.some(d => d.capabilities.some(isExecutable)) ? scenario.devices : [],
            isExecutable,
          ) +
          ' — use one of the executable capabilities instead';
      } else if (declaredOnly.length > 0) {
        message = `no agent can EXECUTE capability '${node.capability}': ${declaredOnly.map(a => `'${a.id}'`).join(', ')} declare(s) it ` +
          'but none of their bound devices provides it — flow nodes actuate devices; bind a device with that capability';
      } else {
        message = `no agent can deliver capability '${node.capability}' (UNSAT)`;
      }
      issues.push({ level: 'error', nodeId: node.id, message });
      continue;
    }

    // T-201: a pinned device makes auto-match deterministic — only agents
    // bound to that device qualify.
    let ordered = candidates;
    if (node.deviceId !== undefined) {
      ordered = candidates.filter(a => a.boundDeviceIds.includes(node.deviceId!));
      if (ordered.length === 0) {
        const holder = scenario.agents.find(a => a.boundDeviceIds.includes(node.deviceId!));
        const device = scenario.devices.find(d => d.id === node.deviceId);
        if (holder !== undefined && !agentEligibleForAuthor(holder, flow.authorUserId)) {
          issues.push({ level: 'error', nodeId: node.id, message: crossTenantMessage(node.id, holder.id) });
        } else if (device === undefined) {
          issues.push({
            level: 'error',
            nodeId: node.id,
            message:
              `deviceId '${node.deviceId}' does not exist in this simulation's world snapshot ` +
              `(known devices: ${scenario.devices.slice(0, 5).map(d => d.id).join(', ')}${scenario.devices.length > 5 ? ', …' : ''})`,
          });
        } else if (holder !== undefined) {
          issues.push({
            level: 'error',
            nodeId: node.id,
            message:
              `agent '${holder.id}' is bound to pinned device '${deviceDisplayName(device)}' but cannot ` +
              `deliver capability '${node.capability}' through it`,
          });
        } else {
          issues.push({
            level: 'error',
            nodeId: node.id,
            message:
              `pinned deviceId '${node.deviceId}' (${deviceDisplayName(device)}) is not bound to ` +
              'any agent eligible for this flow',
          });
        }
        continue;
      }
    } else {
      // Zone-triggered flows prefer a candidate operating IN the trigger zone;
      // the first-zone-local candidate wins, others keep scenario order.
      ordered = triggerZoneId === undefined
        ? candidates
        : [
            ...candidates.filter(a => agentServesZone(scenario, a.id, triggerZoneId)),
            ...candidates.filter(a => !agentServesZone(scenario, a.id, triggerZoneId)),
          ];
      // Mirror the runtime's zone-scoped refusal at validation time: when no
      // capability-providing device sits in the trigger zone, the run would
      // fail with "refusing to actuate a device in another zone" — say so
      // when the flow is authored, not after it fires.
      if (triggerZoneId !== undefined &&
          !ordered.some(a => agentDeviceProvidesInZone(scenario, a.id, node.capability, triggerZoneId, isExecutable))) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message:
            `no device providing capability '${node.capability}' sits in trigger zone '${triggerZoneId}' — ` +
            'a zone-triggered flow refuses to actuate another zone\'s device; bind the capability in that zone',
        });
        continue;
      }
      if (candidates.length > 1) {
        issues.push({
          level: 'warning',
          nodeId: node.id,
          message:
            `capability '${node.capability}' is ambiguous — ${candidates.length} candidates ` +
            `(${candidates.map(a => a.id).join(', ')}); assigned to '${ordered[0].id}'`,
        });
      }
    }
    if (node.deviceId !== undefined) {
      checkPinnedDevice(node, scenario, ordered[0].id, triggerZoneId, isExecutable, issues);
    } else {
      checkDeviceAmbiguity(node, scenario, ordered[0].id, triggerZoneId, isExecutable, issues);
    }
    warnDeclarationDrift(node, scenario, ordered[0].id, issues);
    assignments.set(node.id, ordered[0].id);
  }

  return { assignments, issues };
}

// ============================================================================
// Node invoker (own-devices-only actuation path)
// ============================================================================

/**
 * Build the PlanNodeInvoker for flow execution. The invoker looks up the
 * assignee agent's own device resources for one providing node.capability
 * and executes it through the agent's DeviceResource capability→command
 * mapping (agent.executeDeviceCapability) — the mapping logic of
 * ACExecutor.executeDeviceCapability without the AC context. The agent's
 * declared capabilities are honored too: an agent may deliver a capability
 * through any of its devices whose resources expose it.
 *
 * Fix-44e: pass `isEnabledAgent` (EngineRuntime.isAgentEnabled) so the
 * master enable switch gates the flow path too — disabling a misbehaving
 * agent must stop its flows, not only its event routing.
 *
 * Zone scoping: pass `deviceZoneId` (device id → zone id) so a run carrying
 * a trigger zone (invocation context `zoneId`) actuates a device IN that
 * zone. Without it the first capability-matching resource won regardless of
 * location — in the campus pilot the "101 教室 >30°C" flow repeatedly
 * actuated 108 教室's AC while 101 kept heating (the run still recorded
 * 'success'). When a zoned run finds capability matches but none in the
 * trigger zone, the node FAILS with an explicit error instead of silently
 * actuating another zone's device.
 *
 * Never throws; every failure path returns `{ success: false, error }`.
 */
export function createFlowNodeInvoker(
  agents: ReadonlyMap<string, CognitiveAgent>,
  isEnabledAgent?: (agentId: string) => boolean,
  deviceZoneId?: (deviceId: string) => string | undefined,
): PlanNodeInvoker {
  return async (node: PlanNode, agentId: string, context?: PlanNodeInvokeContext): Promise<PlanNodeInvocation> => {
    try {
      const agent = agents.get(agentId);
      if (!agent) {
        return { success: false, error: `flow node '${node.id}': assignee agent '${agentId}' not found in runtime` };
      }
      if (isEnabledAgent !== undefined && !isEnabledAgent(agentId)) {
        return {
          success: false,
          error: `flow node '${node.id}': assignee agent '${agentId}' is disabled — flows honor the agent master switch`,
        };
      }

      // Find one of the agent's own device resources exposing the capability.
      // Matching mirrors DeviceResource's own check: exact name first, then
      // case-insensitive containment (semantic names like 'cooling' map onto
      // device capabilities like 'temperature-control').
      const resources = agent.resourceManager.getAllResources();
      const needle = node.capability.toLowerCase();
      const exact = resources.filter(r => r.getCapabilities().some(c => c.name === node.capability));
      const candidates = exact.length > 0
        ? exact
        : resources.filter(r => r.getCapabilities().some(c =>
            c.name.toLowerCase().includes(needle) || needle.includes(c.name.toLowerCase()),
          ));
      const providesCapability = (resourceId: string): boolean =>
        candidates.some(r => r.id === resourceId);

      // T-201: a pinned deviceId actuates exactly that device. The pin must
      // name one of the assignee's own bound resources AND provide the
      // capability — anything else is a teaching error, never a fallback to
      // an arbitrary device.
      if (node.deviceId !== undefined) {
        const pinned = resources.find(r => r.id === node.deviceId);
        if (!pinned) {
          return {
            success: false,
            error:
              `flow node '${node.id}': pinned deviceId '${node.deviceId}' is not one of assignee ` +
              `'${agentId}'s bound devices — flow nodes actuate the assignee's own devices only`,
          };
        }
        if (!providesCapability(pinned.id)) {
          return {
            success: false,
            deviceId: pinned.id,
            error:
              `flow node '${node.id}': pinned device '${pinned.id}' does not provide capability ` +
              `'${node.capability}' for agent '${agentId}'`,
          };
        }
        const zoneId = context?.zoneId;
        // R1 (B1-8): `crossZone: true` declares the pin intentionally
        // reaches outside the trigger zone — the same declaration the
        // authoring check honors, so the run does not refuse it.
        if (zoneId !== undefined && node.crossZone !== true && deviceZoneId !== undefined && deviceZoneId(pinned.id) !== zoneId) {
          return {
            success: false,
            deviceId: pinned.id,
            error:
              `flow node '${node.id}': pinned device '${pinned.id}' sits in zone ` +
              `'${deviceZoneId(pinned.id)}' but the trigger zone is '${zoneId}' — refusing to ` +
              'actuate a device in another zone; declare `crossZone: true` for intentional cross-zone actuation',
          };
        }
        // T-608: the actor label rides as the optional invocation context
        // (4th arg only when present — the legacy 3-arg shape is preserved).
        const result = await agent.executeDeviceCapability(pinned.id, node.capability, {
          ...(node.params ?? {}),
          agentId,
          timestamp: new Date(),
        }, ...(context?.actor !== undefined ? [{ actor: context.actor }] : []));
        return result.success
          ? { success: true, deviceId: pinned.id, result: result.result }
          : {
              success: false,
              deviceId: pinned.id,
              error: result.error ?? `capability '${node.capability}' failed on device '${pinned.id}'`,
            };
      }

      // Zone scoping: a zoned run prefers resources in the trigger zone and
      // refuses to actuate another zone's device when none match locally —
      // unless the node DECLARES cross-zone actuation (R1 B1-8), in which
      // case the out-of-zone resource is the author's explicit choice.
      const zoneId = context?.zoneId;
      let resource: (typeof candidates)[number] | undefined = candidates[0];
      if (zoneId !== undefined && deviceZoneId !== undefined && candidates.length > 0) {
        resource = candidates.find(r => deviceZoneId(r.id) === zoneId)
          ?? (node.crossZone === true ? candidates[0] : undefined);
        if (!resource) {
          return {
            success: false,
            error:
              `flow node '${node.id}': agent '${agentId}' has no device providing capability ` +
              `'${node.capability}' in trigger zone '${zoneId}' — refusing to actuate a device in another zone`,
          };
        }
      }
      if (!resource) {
        return {
          success: false,
          error: `flow node '${node.id}': agent '${agentId}' has no device providing capability '${node.capability}'`,
        };
      }

      // T-608: same actor threading as the pinned-dispatch branch above.
      const result = await agent.executeDeviceCapability(resource.id, node.capability, {
        ...(node.params ?? {}),
        agentId,
        timestamp: new Date(),
      }, ...(context?.actor !== undefined ? [{ actor: context.actor }] : []));
      return result.success
        ? { success: true, deviceId: resource.id, result: result.result }
        : {
            success: false,
            deviceId: resource.id,
            error: result.error ?? `capability '${node.capability}' failed on device '${resource.id}'`,
          };
    } catch (error) {
      // Invokers must not throw; defend anyway.
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}
