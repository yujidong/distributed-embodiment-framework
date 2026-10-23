/**
 * Deterministic actuation planner — extracted from DualTriggerACManager
 * (R21 file-budget ratchet; the planning is PURE stateless logic over the
 * decision record + the agent's own devices, so it lives on its own).
 *
 * Translates a handle_independently decision into deterministic device
 * commands: temperature events drive the agent's climate devices in the
 * event zone toward the comfort target; non-temperature events fall back to
 * the event's explicit requiredCapabilities (T-204) and — for model
 * decisions on requirement-less events — to one representative own device
 * (T-041). The decision is always recorded; when nothing can act,
 * `skipReason` says WHY (surfaced in the decision's reasoning so a silent
 * null action is never ambiguous).
 */

import { capabilityMatches } from '../utils/capabilityMatching.js';
import { isReadOnlyCapabilityName } from '../capabilities/read-only.js';
import { SEMANTIC_OFFER_RULES, type SemanticOfferRule } from '../service/semantic-offers.js';
import type { ACNecessityAssessment } from './ACNecessityAssessor.js';

/** Device info the planner plans against (the agent's OWN bound devices). */
export interface PlannerDeviceInfo {
  deviceId: string;
  type: string;
  capabilities: string[];
  /** Zone the device sits in, when known — lets planning target the event zone. */
  zoneId?: string;
}

export interface PlannedDeviceAction {
  deviceId: string;
  commandName: string;
  params: Record<string, unknown>;
}

export interface PlannerResult {
  actions: PlannedDeviceAction[];
  skipReason?: string;
}

/**
 * Read-style capabilities (get/read/query/…, *-reading/sensing/monitoring/
 * detection and the detect-* verb prefix) describe OBSERVATION, not
 * actuation — never issued as commands by the deterministic planners.
 * Delegates to the ONE shared read-only predicate (capabilities/read-only.ts,
 * BUG-04 — the standing lesson: duplicated dispatch logic always drifts).
 */
export function isSensorStyleCapability(capability: string): boolean {
  return isReadOnlyCapabilityName(capability);
}

/** Comfort target used when the event carries no explicit threshold. */
const RULE_TARGET_TEMPERATURE_C = 24;
/** Deadband around the target within which no action is taken. */
const RULE_TEMPERATURE_DEADBAND_C = 1;

/**
 * Plan deterministic device commands for a handle_independently decision.
 * Covers temperature events (the dominant facility case): command the
 * agent's climate devices in the event zone toward the comfort target.
 * T-204: NON-temperature events fall back to the event's explicit
 * requiredCapabilities — each requirement is satisfied by an own, in-zone
 * device whose DECLARED capability matches, issued as that capability's
 * command name (the device's own vocabulary, e.g. 'set-brightness').
 */
export function planIndependentDeviceActions(
  assessment: ACNecessityAssessment,
  agentDevices: readonly PlannerDeviceInfo[],
  offerRules: readonly SemanticOfferRule[] = SEMANTIC_OFFER_RULES,
): PlannerResult {
  const finding = assessment.clusterSummary.findings[0];
  const details = (finding?.details ?? {}) as Record<string, unknown>;
  const parameter = String(details.parameter ?? '').toLowerCase();
  const eventType = String(details.eventType ?? finding?.eventType ?? '').toLowerCase();
  const isTemperature = parameter === 'temperature' || eventType.includes('temperature');
  if (!isTemperature) {
    return planCapabilityDrivenActions(assessment, details, agentDevices, offerRules);
  }

  const rawValue = details.newValue ?? details.temperature ?? details.value;
  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
    return { actions: [], skipReason: 'event carries no numeric temperature value' };
  }
  const target = typeof details.threshold === 'number' && Number.isFinite(details.threshold)
    ? details.threshold
    : RULE_TARGET_TEMPERATURE_C;
  if (Math.abs(rawValue - target) <= RULE_TEMPERATURE_DEADBAND_C) {
    return { actions: [], skipReason: `value ${rawValue}°C is within ±${RULE_TEMPERATURE_DEADBAND_C}°C of target ${target}°C` };
  }

  const eventZone = assessment.clusterSummary.region.id;
  const actions: PlannedDeviceAction[] = [];
  let climateDevices = 0;
  let outOfZoneDevices = 0;
  for (const device of agentDevices) {
    const caps = device.capabilities.map(c => c.toLowerCase());
    if (!isClimateCapableDevice(device)) continue;
    climateDevices++;
    // Zone scoping: when both the event zone and the device zone are
    // known, only actuate devices in the event zone. Devices with an
    // unknown zone cannot be ruled out and are included.
    if (eventZone && eventZone !== 'unknown' && device.zoneId !== undefined && device.zoneId !== eventZone) {
      outOfZoneDevices++;
      continue;
    }

    if (caps.includes('temperature-control')) {
      actions.push({ deviceId: device.deviceId, commandName: 'temperature-control', params: { target } });
    } else if (caps.includes('set-temperature')) {
      actions.push({ deviceId: device.deviceId, commandName: 'set-temperature', params: { target } });
    } else if (caps.includes('cooling') || caps.includes('heating')) {
      const commandName = rawValue > target ? 'cooling' : 'heating';
      if (caps.includes(commandName)) {
        actions.push({ deviceId: device.deviceId, commandName, params: { target } });
      }
    } else if (caps.includes('turn-on')) {
      actions.push({ deviceId: device.deviceId, commandName: 'turn-on', params: {} });
    }
  }
  if (actions.length === 0) {
    const skipReason = climateDevices === 0
      ? 'agent has no climate-capable device'
      : outOfZoneDevices === climateDevices
        ? `agent's ${climateDevices} climate device(s) are all outside event zone '${eventZone}'`
        : 'no climate device exposed a matching temperature/cooling/heating command';
    return { actions, skipReason };
  }
  return { actions };
}

/**
 * T-204 capability-driven fallback for non-temperature events: satisfy
 * each of the event's explicit requiredCapabilities with an OWN, in-zone
 * device whose declared capability matches (case-insensitive containment,
 * the DeviceResource matching contract). The command issued is the
 * DEVICE's own declared capability name — the device's vocabulary, not a
 * guessed generic command. BUG-01: a requirement naming an AGGREGATE
 * service type (load-management) resolves through the merged semantic-offer
 * table (built-in ∪ scenario rules — the signing/invoke gates' source) to
 * an in-zone device holding one of the rule's `actuates` commands.
 * Requirements with no matching device produce a
 * skipReason (the decision record explains the gap); read-style
 * capabilities (get/read/query/…) are sensors, not actuation — skipped.
 *
 * T-041: a custom event that declares NO requiredCapabilities no longer
 * dead-ends when the MODEL answered independent (decisionSource llm or
 * triage): that decision was made against the agent's OWN device surface
 * ("the agent knows its devices"), so the planner actuates ONE
 * representative own in-zone device — preferring a capability that names
 * the event's parameter/type — via the device's own declared command
 * vocabulary. Deterministic decisions keep the zero-command skipReason.
 * Minimal, deterministic, auditable via skipReason.
 */
function planCapabilityDrivenActions(
  assessment: ACNecessityAssessment,
  details: Record<string, unknown>,
  agentDevices: readonly PlannerDeviceInfo[],
  offerRules: readonly SemanticOfferRule[] = SEMANTIC_OFFER_RULES,
): PlannerResult {
  const required = Array.isArray(details.requiredCapabilities)
    ? (details.requiredCapabilities as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  if (required.length === 0) {
    // T-041 own-device fallback: only when the MODEL answered
    // independent (decisionSource llm/triage) on an event that declares
    // no requirements — the answer was made against the agent's own
    // device surface, so the planner drives one own device. Deterministic
    // precheck/rule decisions (Type A with inferred-empty requirements)
    // keep the honest zero-command skipReason below — nothing links them
    // to the agent's devices.
    if (assessment.decisionSource === 'llm' || assessment.decisionSource === 'triage') {
      return planOwnDeviceAction(assessment, details, agentDevices);
    }
    return { actions: [], skipReason: 'event states no requiredCapabilities and is not temperature-class — nothing deterministic to actuate' };
  }

  const eventZone = assessment.clusterSummary.region.id;
  const actions: PlannedDeviceAction[] = [];
  const unmet: string[] = [];
  for (const requirement of required) {
    if (isSensorStyleCapability(requirement)) {
      continue; // sensor-style capability — observation, not actuation
    }
    const backing = findRequirementBacking(requirement, agentDevices, eventZone, offerRules);
    if (backing === undefined || backing === 'out-of-zone') {
      unmet.push(backing === 'out-of-zone'
        ? `${requirement} (own device exists but sits outside event zone '${eventZone}')`
        : requirement);
      continue;
    }
    actions.push({
      deviceId: backing.device.deviceId,
      commandName: backing.commandName,
      params: typeof details.newValue === 'number' ? { value: details.newValue } : {},
    });
  }
  if (actions.length === 0) {
    return {
      actions,
      skipReason: `no own in-zone device satisfies the event's requiredCapabilities (unmet: ${unmet.join(', ') || 'none actuable'})`,
    };
  }
  return { actions };
}

/**
 * T-041 fallback for custom events with NO declared requiredCapabilities:
 * actuate ONE representative own in-zone device using its own declared
 * command vocabulary — preferring a capability whose name shares a word
 * with the event's parameter/type (the numeric event value rides along
 * ONLY for that related capability), else the first actuation-class
 * capability with NO value (an unrelated number from another physical
 * domain must not become a command parameter). Sensor-style capabilities
 * are never commanded. When nothing qualifies, the skipReason says so
 * honestly (the decision record stays auditable).
 */
function planOwnDeviceAction(
  assessment: ACNecessityAssessment,
  details: Record<string, unknown>,
  agentDevices: readonly PlannerDeviceInfo[],
): PlannerResult {
  const eventZone = assessment.clusterSummary.region.id;
  const parameter = String(details.parameter ?? '').toLowerCase();
  const eventType = String(details.eventType ?? assessment.clusterSummary.findings[0]?.eventType ?? '').toLowerCase();
  // The numeric event value rides along ONLY when the commanded capability
  // is actually related to the event — an unrelated fallback command must
  // not receive a number from a different physical domain (occupancy 40 is
  // not a 40°C target).
  const relatedParams = typeof details.newValue === 'number' ? { value: details.newValue } : {};

  let fallbackDevice: { deviceId: string; commandName: string } | undefined;
  for (const device of agentDevices) {
    if (eventZone && eventZone !== 'unknown' && device.zoneId !== undefined && device.zoneId !== eventZone) {
      continue; // only own IN-ZONE devices
    }
    const actuationCaps = device.capabilities.filter(c => !isSensorStyleCapability(c));
    if (actuationCaps.length === 0) continue;
    // Prefer a capability sharing a WORD with the event's parameter or
    // type (token intersection — no substring false positives like
    // 'flight-control' matching 'light').
    const eventTokens = new Set(
      `${parameter} ${eventType}`.split(/[^a-z0-9]+/).filter(t => t.length > 2),
    );
    const related = actuationCaps.find(c =>
      c.toLowerCase().split(/[^a-z0-9]+/).some(tok => eventTokens.has(tok)),
    );
    if (related !== undefined) {
      // A directly related capability is the representative action.
      return {
        actions: [{ deviceId: device.deviceId, commandName: related, params: relatedParams }],
      };
    }
    fallbackDevice ??= { deviceId: device.deviceId, commandName: actuationCaps[0] };
  }
  if (fallbackDevice !== undefined) {
    return {
      actions: [{ deviceId: fallbackDevice.deviceId, commandName: fallbackDevice.commandName, params: {} }],
    };
  }
  return {
    actions: [],
    skipReason: 'event declares no requiredCapabilities and no own in-zone device exposes an actuation-class capability — nothing deterministic to actuate',
  };
}

// ---------------------------------------------------------------------------
// BUG-01: shared actuation-backing predicates (planner + honesty gate + GT)
// ---------------------------------------------------------------------------

/** Whether the device sits in the event zone (unknown zone on either side cannot rule it out). */
function inEventZone(device: PlannerDeviceInfo, eventZone: string | undefined): boolean {
  return !(eventZone !== undefined && eventZone !== '' && eventZone !== 'unknown'
    && device.zoneId !== undefined && device.zoneId !== eventZone);
}

/**
 * Climate-device detection (extracted verbatim from the temperature branch
 * above): capability names first, device-type vocabulary as fallback.
 */
function isClimateCapableDevice(device: PlannerDeviceInfo): boolean {
  const caps = device.capabilities.map(c => c.toLowerCase());
  const type = device.type.toLowerCase();
  return caps.some(c => c.includes('temperature') || c === 'cooling' || c === 'heating' || c.includes('hvac') || c.includes('climate')) ||
    type.includes('hvac') || type.includes('thermostat') || type.includes('climate') || type === 'ac' || type.includes('air-conditioner');
}

/**
 * The command surface the temperature branch can actually ISSUE on a
 * climate-capable device (same preference list as the planner above:
 * temperature-control / set-temperature / cooling / heating / turn-on). A
 * read-temperature sensor is "climate-capable" by name but exposes no
 * command — the backing check must not count it.
 */
function hasClimateCommandSurface(device: PlannerDeviceInfo): boolean {
  const caps = device.capabilities.map(c => c.toLowerCase());
  return caps.includes('temperature-control') || caps.includes('set-temperature') ||
    caps.includes('cooling') || caps.includes('heating') || caps.includes('turn-on');
}

/**
 * Resolve one event requirement to an OWN in-zone device + the command to
 * issue (the device's own declared vocabulary). Two lanes, one contract:
 *
 *  1. DIRECT — a device whose DECLARED capability matches the requirement
 *     (the same semantic matcher the assessor and negotiator use).
 *  2. OFFER-RULE (BUG-01) — a requirement naming an AGGREGATE service type
 *     (load-management / grid-load-management) resolves through the merged
 *     semantic-offer table (built-in ∪ scenario mapData.semanticOfferRules,
 *     the same table the signing/invoke gates consult): the rule's
 *     `actuates` backing maps to an in-zone device holding one of those
 *     commands (a bound charging pile's turn-off).
 *
 * Returns 'out-of-zone' when a match exists but every matching device sits
 * outside the event zone; undefined when nothing matches at all.
 */
function findRequirementBacking(
  requirement: string,
  agentDevices: readonly PlannerDeviceInfo[],
  eventZone: string | undefined,
  offerRules: readonly SemanticOfferRule[],
): { device: PlannerDeviceInfo; commandName: string } | 'out-of-zone' | undefined {
  let sawOutOfZone = false;
  // Lane 1: direct declared-capability match.
  for (const device of agentDevices) {
    const declared = device.capabilities.find(c => capabilityMatches(c, requirement));
    if (declared === undefined) continue;
    if (!inEventZone(device, eventZone)) {
      sawOutOfZone = true;
      continue;
    }
    return { device, commandName: declared };
  }
  // Lane 2: semantic-offer rule → actuation backing → in-zone device.
  const rule = offerRules.find(r => capabilityMatches(r.semanticType, requirement));
  if (rule !== undefined) {
    for (const backingCap of rule.actuates) {
      for (const device of agentDevices) {
        const declared = device.capabilities.find(c =>
          !isSensorStyleCapability(c) && capabilityMatches(c, backingCap));
        if (declared === undefined) continue;
        if (!inEventZone(device, eventZone)) {
          sawOutOfZone = true;
          continue;
        }
        return { device, commandName: declared };
      }
    }
  }
  return sawOutOfZone ? 'out-of-zone' : undefined;
}

/** Inputs for the structural actuation-backing check (assessment-free). */
export interface ActuationBackingQuery {
  /** Event parameter (details.parameter), lowercased by the caller. */
  parameter?: string;
  /** Event type (details.eventType / event.type), lowercased by the caller. */
  eventType?: string;
  /** The event's declared requiredCapabilities. */
  requiredCapabilities: readonly string[];
  /** Zone the event sits in. */
  eventZoneId?: string;
  /** The agent's OWN bound devices. */
  devices: readonly PlannerDeviceInfo[];
  /** Merged semantic-offer table (defaults to the built-in rules). */
  offerRules?: readonly SemanticOfferRule[];
}

/**
 * BUG-01: does the agent have any DEVICE that can physically act on THIS
 * event? Structural (value-free) twin of the planner — same predicates, so
 * the honesty gate and the ground-truth derivation can never drift from the
 * planner's own matching contract:
 *  - temperature-class event → an in-zone climate-capable device;
 *  - capability-driven event → an actuation-class requirement backed by an
 *    in-zone own device (directly or through the offer-rule table).
 * An event with NO actuation-class requirements (all read-style, or none)
 * needs no backing — it is honestly a no-op, and this returns true.
 */
export function hasActuationBacking(query: ActuationBackingQuery): boolean {
  const offerRules = query.offerRules ?? SEMANTIC_OFFER_RULES;
  const isTemperature =
    query.parameter === 'temperature' || (query.eventType ?? '').includes('temperature');
  if (isTemperature) {
    return query.devices.some(d =>
      inEventZone(d, query.eventZoneId) && isClimateCapableDevice(d) && hasClimateCommandSurface(d));
  }
  const actuationReqs = query.requiredCapabilities.filter(c => !isSensorStyleCapability(c));
  if (actuationReqs.length === 0) return true; // observation-only event — nothing to back
  return actuationReqs.some(req => {
    const hit = findRequirementBacking(req, query.devices, query.eventZoneId, offerRules);
    return hit !== undefined && hit !== 'out-of-zone';
  });
}

/**
 * Assessment-shaped wrapper over hasActuationBacking (the honesty gate's
 * call site holds an ACNecessityAssessment, not a hand-built query).
 */
export function hasIndependentActuationBacking(
  assessment: ACNecessityAssessment,
  agentDevices: readonly PlannerDeviceInfo[],
  offerRules: readonly SemanticOfferRule[] = SEMANTIC_OFFER_RULES,
): boolean {
  const finding = assessment.clusterSummary.findings[0];
  const details = (finding?.details ?? {}) as Record<string, unknown>;
  const required = Array.isArray(details.requiredCapabilities)
    ? (details.requiredCapabilities as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  return hasActuationBacking({
    parameter: String(details.parameter ?? '').toLowerCase(),
    eventType: String(details.eventType ?? finding?.eventType ?? '').toLowerCase(),
    requiredCapabilities: required,
    eventZoneId: assessment.clusterSummary.region.id,
    devices: agentDevices,
    offerRules,
  });
}
