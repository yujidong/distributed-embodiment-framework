/**
 * Scenario Loader — validate, normalize, and load scenario JSON files
 *
 * Two entry points:
 * - `loadScenarioFile(json: unknown)` — validate an already-parsed value
 *   against the v1.0 JSON schema (ajv), run semantic checks (unique ids,
 *   zone/device reference integrity, binding support), apply defaults
 *   (adjacency lists, bindings, device-role inference), and return a typed
 *   `ScenarioDefinition` ready for `EngineRuntime`.
 * - `loadScenarioFromFile(path)` — same, reading + parsing a file (node fs).
 *
 * All failures raise `ScenarioValidationError` with a human-readable
 * `issues` list — every message names the offending path so scenario
 * authors can fix files without a debugger.
 */

import { readFileSync } from 'node:fs';

import { createLogger, type LocalizedText } from '@active-collaboration/shared';

import { createScenarioValidator } from './scenario-schema.js';
import type { FlowDefinition } from '../flows/flow-types.js';
// Fix-44f: runtime import for embedded-flow semantic validation. flow-types
// depends on scenario-TYPES only (not this module), so no import cycle.
import { validateFlow } from '../flows/flow-types.js';
import type { FlowAssignmentOptions } from '../flows/flow-invoker.js';
import type { SemanticOfferRule } from '../service/semantic-offers.js';
import { isReadOnlyCapabilityName } from '../capabilities/read-only.js';
import { extendCapabilitySynonyms } from '../utils/capabilityMatching.js';
import type {
  DeviceRole,
  ScenarioAgent,
  ScenarioDefinition,
  ScenarioDevice,
  ScenarioEvent,
  ScenarioParameterEffect,
  ScenarioParameterPhysics,
  ScenarioWhatIfQuota,
  ScenarioZone,
} from './scenario-types.js';
import { isStandardPhysicalParameter } from './standard-parameters.js';

/** Error thrown for any schema or semantic validation failure. */
export class ScenarioValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Scenario validation failed:\n${issues.map(i => `  - ${i}`).join('\n')}`);
    this.name = 'ScenarioValidationError';
    this.issues = issues;
  }
}

/**
 * BUG-06: embedded-FLOW semantic failures, distinguished from schema/structural
 * failures so the server import lane can answer 422 FLOW_INVALID (the REST
 * flow-authoring lane's code + wording) instead of the generic 400.
 */
export class ScenarioFlowValidationError extends ScenarioValidationError {
  constructor(issues: string[]) {
    super(issues);
    this.name = 'ScenarioFlowValidationError';
  }
}

/**
 * BUG-06: optional host-injected validation oracles. Core cannot import the
 * simulation package's capability→command contract, so the server injects
 * `isCapabilityExecutable` / `acceptedParameterNames` here — the scenario
 * JSON import lane then applies the SAME T-002/R13 gates the REST flow
 * routes enforce (executable device path + param-spelling rename hints),
 * instead of validating with both oracles defaulted off.
 */
export interface ScenarioLoadOptions {
  flowValidation?: FlowAssignmentOptions;
}

const logger = createLogger('ScenarioLoader');

// ---------------------------------------------------------------------------
// Raw wire shapes (post-JSON-parse, pre-validation). Optional fields mirror
// the schema; the loader fills defaults to produce ScenarioDefinition.
// ---------------------------------------------------------------------------

interface RawZone {
  id: string;
  name?: string;
  type?: string;
  buildingId?: string;
  floor?: number;
  bounds?: { minX: number; maxX: number; minY: number; maxY: number; minZ?: number; maxZ?: number };
  /** T-058a: zone consent class (enum-validated above). */
  consentClass?: 'standard' | 'supervised' | 'restricted';
  occupancy?: number;
  occupantSchedule?: { count: number; startSimTimeSec: number; endSimTimeSec: number; repeatDaily?: boolean };
  /** FEAT-07 phase-2: temporary calendar overlay (schema-validated shape). */
  occupantScheduleOverlay?: {
    schedule: { count: number; startSimTimeSec: number; endSimTimeSec: number; repeatDaily?: boolean };
    startsAtSimSec: number;
    endsAtSimSec: number;
  };
  envelopeU?: number;
  adjacentZoneIds?: string[];
  baseline?: Record<string, number | boolean>;
  /** R82: declarative interior rooms (validated below, passthrough). */
  rooms?: Array<{ code?: string; name?: string; type?: string; hours?: string }>;
}

interface RawDevice {
  id: string;
  name?: string;
  type: string;
  role?: DeviceRole;
  capabilities: string[];
  zoneId: string;
  binding?: string;
  initialState?: Record<string, unknown>;
  ownerId?: string;
}

interface RawAgent {
  id: string;
  name: string;
  capabilities: string[];
  managesZoneIds?: string[];
  boundDeviceIds?: string[];
  // T-601: null = explicit rule-only opt-out (passes through verbatim).
  llm?: { provider: string; model: string; params?: Record<string, unknown> } | null;
  cannotDeliverClasses?: string[];
  shortLabel?: string;
  rateLimitPerMinute?: number;
  enabled?: boolean;
  /** Owning tenant (server bridge only; T-201) — see ScenarioAgent.ownerUserId. */
  ownerUserId?: string;
  /** Per-agent autonomous-decision policy (T-050) — see ScenarioAgent.decisionPolicy. */
  decisionPolicy?: {
    /** R45-P1: dispatcher role — precheck never Type-A short-circuits a coordinator. */
    role?: 'coordinator';
    autoActuateIndependent?: boolean;
    autoInitiateAC?: boolean;
    /** R43-B/lever-b: precheck Type-A pass-through ('off'|'sample'|'all'). */
    precheckPassThrough?: 'off' | 'sample' | 'all';
    /** 'sample' mode pass probability in [0,1] (default 0.3). */
    precheckPassThroughRate?: number;
  };
  /** P3: author-declared semantic services (schema-validated shape). */
  services?: SemanticOfferRule[];
}

interface RawEvent {
  id: string;
  type: string;
  zoneId: string;
  parameter?: string;
  value?: number | boolean | string;
  atSimTimeSec?: number;
  durationSec?: number;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  requiredCapabilities?: string[];
  details?: Record<string, unknown>;
  confidence?: number;
  cinematography?: {
    narrationCue?: string;
    playbackRateOverride?: number;
    highlightAgentIds?: string[];
    cameraFocusKind?: 'zone' | 'agent-pair' | 'event-source';
  };
  consentRequirements?: {
    dataFields: string[];
    recipients: string[];
    consentClass: 'routine' | 'sensitive' | 'emergency';
  };
  liabilityClass?: 'must-respond' | 'best-effort' | 'advisory';
  acRationale?: {
    partnerSetUnpredictable: boolean;
    noCentralAuthority: boolean;
    combinatorialStateSpace: boolean;
    score: string;
    verdict: 'AC-necessary' | 'AC-valuable' | 'AC-overkill';
    reasoning: string;
  };
  focusZoneId?: string;
  humanNarrative?: LocalizedText | string;
  /** T-019: recorded world state, not a stimulus — never injected. */
  observationOnly?: boolean;
}

interface RawScenarioFile {
  version: '1.0';
  meta: {
    id: string;
    name: LocalizedText | string;
    description?: LocalizedText | string;
    // Building tier physics fields
    storeyHeight?: number;
    slabAttenuation?: number;
    envelopeU?: number;
    occupancyHeatW?: number;
    occupancyCo2Rate?: number;
    environmentNoise?: boolean;
    // FEAT-03: opt-in field dynamics for custom zone parameters, and the
    // stage-2 device coupling onto them (schema-validated shape; custom-vs-
    // enum and target-declared checks run below with teaching messages).
    parameterPhysics?: Record<string, ScenarioParameterPhysics>;
    parameterEffects?: ScenarioParameterEffect[];
    // R40-B1: what-if predictor quota (schema-validated; see scenario-types).
    whatIfQuota?: ScenarioWhatIfQuota;
    // Wave 2 / Wave 8 authoring extensions — bilingual marketing copy.
    tagline?: LocalizedText;
    heroEventId?: string;
    recommendedPlaybackRate?: number;
    vendorDisclaimer?: LocalizedText | string;
  };
  zones: RawZone[];
  devices?: RawDevice[];
  agents?: RawAgent[];
  events?: RawEvent[];
  flows?: FlowDefinition[];
  /** P3: scenario-authored semantic offer rules (schema-validated shape). */
  semanticOfferRules?: SemanticOfferRule[];
  /** P3: scenario-authored capability-equivalence groups. */
  capabilitySynonyms?: string[][];
}

// ---------------------------------------------------------------------------
// Capability classification / device-role inference
// ---------------------------------------------------------------------------

/**
 * Classify a capability name using the same heuristic the experiment runner
 * uses when building simulated devices: monitoring-ish names are reads,
 * control-ish names are writes, everything else is an execution.
 *
 * BUG-01: the read verdict delegates to the ONE shared read-only predicate
 * (capabilities/read-only.ts — same source as the actuation planner's
 * isSensorStyleCapability), so verb-prefixed sensor names (read-occupancy,
 * detect-smoke, read-power) no longer classify as execute while the
 * downstream planner treats them as observation. The tracking/surveillance/
 * imaging noun forms stay as this classifier's legacy read vocabulary.
 */
export function classifyCapability(name: string): 'read' | 'write' | 'execute' {
  const lower = name.toLowerCase();
  if (
    isReadOnlyCapabilityName(name) ||
    lower.includes('tracking') ||
    lower.includes('surveillance') ||
    lower.includes('imaging')
  ) {
    return 'read';
  }
  if (
    lower.includes('control') ||
    lower.includes('adjustment') ||
    lower.includes('setting')
  ) {
    return 'write';
  }
  return 'execute';
}

/**
 * Infer a device's sensor/actuator role from its capabilities:
 * read-only → sensor; write/execute-only → actuator; mixed → hybrid.
 */
export function inferDeviceRole(capabilities: string[]): DeviceRole {
  let reads = 0;
  let writes = 0;
  for (const cap of capabilities) {
    if (classifyCapability(cap) === 'read') reads++;
    else writes++;
  }
  if (writes === 0) return 'sensor';
  return reads > 0 ? 'hybrid' : 'actuator';
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Validate a parsed JSON value as a scenario file and return the
 * runtime-facing definition with defaults applied.
 *
 * @throws ScenarioValidationError listing every violation found.
 */
export function loadScenarioFile(json: unknown, options?: ScenarioLoadOptions): ScenarioDefinition {
  const issues: string[] = [];

  const validate = createScenarioValidator();
  if (!validate(json)) {
    for (const err of validate.errors ?? []) {
      issues.push(`${formatInstancePath(err.instancePath)}: ${err.message ?? 'invalid'}`);
    }
    throw new ScenarioValidationError(issues);
  }

  const raw = json as RawScenarioFile;
  const zones = raw.zones ?? [];
  const devices = raw.devices ?? [];
  const agents = raw.agents ?? [];
  const events = raw.events ?? [];

  const zoneIds = new Set(zones.map(z => z.id));
  const deviceIds = new Set(devices.map(d => d.id));

  checkUnique('zones', zones.map(z => z.id), issues);
  checkUnique('devices', devices.map(d => d.id), issues);
  checkUnique('agents', agents.map(a => a.id), issues);
  checkUnique('events', events.map(e => e.id), issues);

  // Zone references (adjacency)
  zones.forEach((zone, i) => {
    for (const adjId of zone.adjacentZoneIds ?? []) {
      if (!zoneIds.has(adjId)) {
        issues.push(`zones[${i}] ("${zone.id}"): adjacentZoneIds references unknown zone "${adjId}"`);
      }
    }
    // T-058a (design-consent-semantics.md §3.1): the zone consent class is
    // enum-validated at the earliest boundary — a typo silently falling back
    // to 'standard' would keep auto-applying installs into a ward someone
    // MEANT to mark supervised.
    if (
      zone.consentClass !== undefined &&
      zone.consentClass !== 'standard' &&
      zone.consentClass !== 'supervised' &&
      zone.consentClass !== 'restricted'
    ) {
      issues.push(
        `zones[${i}] ("${zone.id}"): consentClass must be 'standard' | 'supervised' | 'restricted' — ` +
        `got '${String(zone.consentClass)}'`,
      );
    }
    // FEAT-07 phase-2: the calendar overlay window must be non-degenerate
    // (shape is schema-validated; the end-after-start semantics live here).
    const overlay = zone.occupantScheduleOverlay;
    if (
      overlay !== undefined &&
      typeof overlay.startsAtSimSec === 'number' &&
      typeof overlay.endsAtSimSec === 'number' &&
      !(overlay.endsAtSimSec > overlay.startsAtSimSec)
    ) {
      issues.push(
        `zones[${i}] ("${zone.id}"): occupantScheduleOverlay.endsAtSimSec must exceed startsAtSimSec — ` +
        `got [${overlay.startsAtSimSec}, ${overlay.endsAtSimSec})`,
      );
    }
    // R82: declarative rooms — structural validation only (rooms are world
    // metadata, never interpreted); shape errors fail loudly like
    // consentClass typos instead of dropping the block silently.
    if (zone.rooms !== undefined) {
      if (!Array.isArray(zone.rooms)) {
        issues.push(`zones[${i}] ("${zone.id}"): rooms must be an array`);
      } else {
        zone.rooms.forEach((room, r) => {
          if (typeof room !== 'object' || room === null || Array.isArray(room)) {
            issues.push(`zones[${i}].rooms[${r}]: must be an object`);
            return;
          }
          if (typeof room.name !== 'string' || room.name.length === 0) {
            issues.push(`zones[${i}].rooms[${r}]: name must be a non-empty string`);
          }
          if (room.code !== undefined && typeof room.code !== 'string') {
            issues.push(`zones[${i}].rooms[${r}]: code must be a string`);
          }
          if (room.type !== undefined && typeof room.type !== 'string') {
            issues.push(`zones[${i}].rooms[${r}]: type must be a string`);
          }
          if (room.hours !== undefined && typeof room.hours !== 'string') {
            issues.push(`zones[${i}].rooms[${r}]: hours must be a string`);
          }
        });
      }
    }
  });

  // Device references + bindings
  devices.forEach((device, i) => {
    if (!zoneIds.has(device.zoneId)) {
      issues.push(`devices[${i}] ("${device.id}"): zoneId references unknown zone "${device.zoneId}"`);
    }
    validateBinding(device.binding, `devices[${i}] ("${device.id}")`, issues);
  });

  // Agent references
  agents.forEach((agent, i) => {
    for (const zoneId of agent.managesZoneIds ?? []) {
      if (!zoneIds.has(zoneId)) {
        issues.push(`agents[${i}] ("${agent.id}"): managesZoneIds references unknown zone "${zoneId}"`);
      }
    }
    for (const deviceId of agent.boundDeviceIds ?? []) {
      if (!deviceIds.has(deviceId)) {
        issues.push(`agents[${i}] ("${agent.id}"): boundDeviceIds references unknown device "${deviceId}"`);
      }
    }
    // P3: declared services — one row per semanticType; a duplicate type
    // within the same agent is an authoring error, not a merge.
    checkUnique(
      `agents[${i}] ("${agent.id}").services`,
      (agent.services ?? []).map(service => service.semanticType),
      issues,
    );
  });

  // P3: scenario offer rules — duplicate semanticTypes within the custom
  // set are ambiguous (mergeOfferRules dedupes custom-over-builtin only).
  checkUnique(
    'semanticOfferRules',
    (raw.semanticOfferRules ?? []).map(rule => rule.semanticType),
    issues,
  );

  // FEAT-03: custom-parameter field dynamics + device coupling. Both checks
  // are TEACHING rejections — a standard parameter already has dedicated
  // physics (declaring it here would silently re-pin its relaxation rate),
  // and a coupling onto an undeclared custom key would silently never move
  // anything (undeclared keys are static, T-304).
  const declaredPhysicsKeys = Object.keys(raw.meta.parameterPhysics ?? {});
  for (const key of declaredPhysicsKeys) {
    if (isStandardPhysicalParameter(key)) {
      issues.push(
        `meta.parameterPhysics["${key}"]: "${key}" is a standard parameter with its own ` +
        `dedicated physics — parameterPhysics only opts CUSTOM (non-enum) zone parameters ` +
        `into field dynamics; remove the declaration (the standard physics stays)`,
      );
    }
  }
  (raw.meta.parameterEffects ?? []).forEach((effect, i) => {
    if (isStandardPhysicalParameter(effect.zoneParameter)) {
      issues.push(
        `meta.parameterEffects[${i}]: zoneParameter "${effect.zoneParameter}" is a standard ` +
        `parameter with its own dedicated physics (device effects already drive it — e.g. an ` +
        `air handler's air_flow effect ventilates co2) — parameterEffects only couples devices ` +
        `to CUSTOM zone parameters declared in meta.parameterPhysics`,
      );
    } else if (!declaredPhysicsKeys.includes(effect.zoneParameter)) {
      issues.push(
        `meta.parameterEffects[${i}]: zoneParameter "${effect.zoneParameter}" is not declared ` +
        `in meta.parameterPhysics — custom parameters are static (T-304) unless opted into ` +
        `field dynamics, so this coupling would never move anything; add ` +
        `meta.parameterPhysics["${effect.zoneParameter}"] (e.g. { relaxRatePerSec, ` +
        `relaxToBaseline: true }) or remove the effect`,
      );
    }
  });

  // Event references
  events.forEach((event, i) => {
    if (!zoneIds.has(event.zoneId)) {
      issues.push(`events[${i}] ("${event.id}"): zoneId references unknown zone "${event.zoneId}"`);
    }
    if (event.details !== undefined &&
        (typeof event.details !== 'object' || event.details === null || Array.isArray(event.details))) {
      issues.push(`events[${i}] ("${event.id}"): details must be an object`);
    }
  });

  if (issues.length > 0) {
    throw new ScenarioValidationError(issues);
  }

  // Building tier (B-A): auto-symmetrize adjacency (a declared A→B implies
  // B→A) and warn on adjacency spanning more than one storey. Warnings are
  // non-blocking — they surface through the log, never in `issues`.
  const adjacency = symmetrizeAdjacency(zones);
  warnOnFloorJumps(zones, adjacency);

  const definition: ScenarioDefinition = {
    version: '1.0',
    meta: {
      id: raw.meta.id,
      name: raw.meta.name,
      description: raw.meta.description ?? '',
      ...(raw.meta.storeyHeight !== undefined ? { storeyHeight: raw.meta.storeyHeight } : {}),
      ...(raw.meta.slabAttenuation !== undefined ? { slabAttenuation: raw.meta.slabAttenuation } : {}),
      ...(raw.meta.envelopeU !== undefined ? { envelopeU: raw.meta.envelopeU } : {}),
      ...(raw.meta.occupancyHeatW !== undefined ? { occupancyHeatW: raw.meta.occupancyHeatW } : {}),
      ...(raw.meta.occupancyCo2Rate !== undefined ? { occupancyCo2Rate: raw.meta.occupancyCo2Rate } : {}),
      ...(raw.meta.environmentNoise !== undefined ? { environmentNoise: raw.meta.environmentNoise } : {}),
      // FEAT-03: custom-parameter field dynamics + device coupling ride the
      // scenario meta verbatim (already schema- + semantically validated).
      ...(raw.meta.parameterPhysics !== undefined
        ? { parameterPhysics: Object.fromEntries(
            Object.entries(raw.meta.parameterPhysics).map(([k, v]) => [k, { ...v }]),
          ) }
        : {}),
      ...(raw.meta.parameterEffects !== undefined
        ? { parameterEffects: raw.meta.parameterEffects.map(e => ({ ...e })) }
        : {}),
      // R40-B1: the what-if lane's budget rides the scenario meta verbatim
      // (already schema-validated; the predictor reads it before any fork).
      ...(raw.meta.whatIfQuota !== undefined ? { whatIfQuota: { ...raw.meta.whatIfQuota } } : {}),
      // Wave 2 / Wave 8 authoring extensions — pass-through (UI / CLI consume).
      ...(raw.meta.tagline ? { tagline: raw.meta.tagline } : {}),
      ...(raw.meta.heroEventId ? { heroEventId: raw.meta.heroEventId } : {}),
      ...(raw.meta.recommendedPlaybackRate !== undefined ? { recommendedPlaybackRate: raw.meta.recommendedPlaybackRate } : {}),
      ...(raw.meta.vendorDisclaimer ? { vendorDisclaimer: raw.meta.vendorDisclaimer } : {}),
    },
    zones: zones.map(zone => normalizeZone(zone, adjacency.get(zone.id))),
    devices: devices.map(normalizeDevice),
    agents: agents.map(normalizeAgent),
    events: events.map(normalizeEvent),
    // Flows pass through untouched shape-wise; semantic checks run via
    // validateFlow() BELOW (Fix-44f: embedded flows get the same authoring-
    // time rejection the API path has — dead zone refs, UNSAT assignments
    // and DAG cycles fail the LOAD instead of silently failing at runtime).
    ...(raw.flows !== undefined ? { flows: raw.flows.map(f => ({ ...f })) } : {}),
    // P3: authored offer rules / synonym groups survive the load verbatim
    // (both already schema-validated above).
    ...(raw.semanticOfferRules !== undefined
      ? { semanticOfferRules: raw.semanticOfferRules.map(rule => ({ ...rule })) }
      : {}),
    ...(raw.capabilitySynonyms !== undefined
      ? { capabilitySynonyms: raw.capabilitySynonyms.map(group => [...group]) }
      : {}),
  };

  if (definition.flows !== undefined && definition.flows.length > 0) {
    const flowIssues: string[] = [];
    for (const flow of definition.flows) {
      for (const issue of validateFlow(flow, definition, options?.flowValidation)) {
        if (issue.level === 'error') {
          flowIssues.push(`flows[${flow.id}]: ${issue.message}`);
        }
      }
    }
    if (flowIssues.length > 0) {
      throw new ScenarioFlowValidationError(flowIssues);
    }
  }

  // P3: scenario capability synonyms register into the process-level
  // registry AT LOAD — every consumer of this definition (import, bridge,
  // runtime) then matches with the scenario's vocabulary. Registration is
  // deduped, so repeated loads of the same scenario stay idempotent; only
  // a SUCCESSFULLY validated scenario registers (invalid files above throw
  // before reaching this line).
  if (definition.capabilitySynonyms !== undefined) {
    extendCapabilitySynonyms(definition.capabilitySynonyms);
  }

  return definition;
}

/**
 * Read + parse + validate a scenario JSON file from disk.
 *
 * @throws ScenarioValidationError for invalid content; rethrows fs errors
 *   with the file path attached for context.
 */
export function loadScenarioFromFile(path: string): ScenarioDefinition {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read scenario file "${path}": ${(error as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ScenarioValidationError([
      `"${path}": invalid JSON — ${(error as Error).message}`,
    ]);
  }

  try {
    return loadScenarioFile(json);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      throw new ScenarioValidationError(
        error.issues.map(issue => `"${path}": ${issue}`),
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function checkUnique(kind: string, ids: string[], issues: string[]): void {
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    if (seen.has(id)) {
      issues.push(`${kind}[${i}]: duplicate id "${id}"`);
    }
    seen.add(id);
  });
}

/**
 * Convert an ajv instancePath (`/devices/0/type`) to bracket notation
 * (`devices[0].type`) so schema errors read like the semantic errors.
 */
function formatInstancePath(instancePath: string): string {
  if (!instancePath) return '(root)';
  return instancePath
    .split('/')
    .filter(segment => segment.length > 0)
    .map(segment => (/^\d+$/.test(segment) ? `[${segment}]` : `.${segment}`))
    .join('')
    .replace(/^\./, '');
}

function validateBinding(binding: string | undefined, path: string, issues: string[]): void {
  if (binding === undefined) return; // default applied later
  if (binding.startsWith('sim://')) return;
  // hass:// bindings are loadable since P3a. Resolving them to a live Home
  // Assistant entity is NOT the loader's job: without a deviceFactory the
  // runtime falls back to the sim backend, and the server registry rejects
  // hass:// scenarios with HASS_NOT_CONFIGURED when no HA connection exists.
  if (binding.startsWith('hass://')) {
    if (binding.length <= 'hass://'.length) {
      issues.push(`${path}: binding "${binding}" must name an entity after hass://`);
    }
    return;
  }
  issues.push(`${path}: binding "${binding}" must be a sim:// or hass:// URI`);
}

/**
 * Auto-symmetrize zone adjacency (B-A): a declared A→B implies B→A, so
 * scenario authors only write each connection once. Explicitly bidirectional
 * declarations are fine (sets dedupe). Reference integrity was checked
 * earlier, so every id here resolves to a known zone.
 */
function symmetrizeAdjacency(zones: RawZone[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const zone of zones) {
    if (!adjacency.has(zone.id)) adjacency.set(zone.id, new Set());
    for (const adjacentId of zone.adjacentZoneIds ?? []) {
      adjacency.get(zone.id)!.add(adjacentId);
      if (!adjacency.has(adjacentId)) adjacency.set(adjacentId, new Set());
      adjacency.get(adjacentId)!.add(zone.id);
    }
  }
  return adjacency;
}

/**
 * Warn (non-blocking) when an adjacency pair spans more than one storey:
 * legit shaft connections are one floor apart; a bigger jump usually means a
 * missing intermediate floor's shaft zone.
 */
function warnOnFloorJumps(zones: RawZone[], adjacency: Map<string, Set<string>>): void {
  const floorById = new Map(zones.map(zone => [zone.id, zone.floor]));
  const reported = new Set<string>();
  for (const [zoneId, neighbors] of adjacency) {
    const floor = floorById.get(zoneId);
    if (floor === undefined) continue;
    for (const neighborId of neighbors) {
      const neighborFloor = floorById.get(neighborId);
      if (neighborFloor === undefined) continue;
      if (Math.abs(floor - neighborFloor) <= 1) continue;
      const pairKey = [zoneId, neighborId].sort().join('::');
      if (reported.has(pairKey)) continue;
      reported.add(pairKey);
      logger.warn(
        `zones: adjacency "${pairKey.split('::')[0]}" <-> "${pairKey.split('::')[1]}" ` +
        `spans floors ${floor} and ${neighborFloor} (difference > 1) — ` +
        `declare one shaft zone per floor and chain them instead`,
      );
    }
  }
}

function normalizeZone(zone: RawZone, symmetrizedAdjacency?: Set<string>): ScenarioZone {
  return {
    id: zone.id,
    name: zone.name,
    type: zone.type,
    ...(zone.buildingId !== undefined ? { buildingId: zone.buildingId } : {}),
    ...(zone.floor !== undefined ? { floor: zone.floor } : {}),
    bounds: zone.bounds,
    ...(zone.consentClass !== undefined ? { consentClass: zone.consentClass } : {}),
    ...(zone.occupancy !== undefined ? { occupancy: zone.occupancy } : {}),
    // Fix-52a: schedule-driven occupancy survives the loader.
    ...(zone.occupantSchedule !== undefined ? { occupantSchedule: { ...zone.occupantSchedule } } : {}),
    // FEAT-07 phase-2: the calendar overlay survives the loader.
    ...(zone.occupantScheduleOverlay !== undefined
      ? {
          occupantScheduleOverlay: {
            schedule: { ...zone.occupantScheduleOverlay.schedule },
            startsAtSimSec: zone.occupantScheduleOverlay.startsAtSimSec,
            endsAtSimSec: zone.occupantScheduleOverlay.endsAtSimSec,
          },
        }
      : {}),
    ...(zone.envelopeU !== undefined ? { envelopeU: zone.envelopeU } : {}),
    // R82: declarative interior rooms survive the loader (validated above).
    ...(zone.rooms !== undefined
      ? {
          rooms: zone.rooms
            .filter((room): room is typeof room & { name: string } => typeof room.name === 'string')
            .map(room => ({ ...room })),
        }
      : {}),
    adjacentZoneIds: symmetrizedAdjacency
      ? [...symmetrizedAdjacency]
      : [...(zone.adjacentZoneIds ?? [])],
    ...(zone.baseline !== undefined ? { baseline: { ...zone.baseline } } : {}),
  };
}

function normalizeDevice(device: RawDevice): ScenarioDevice {
  return {
    id: device.id,
    name: device.name ?? device.id,
    type: device.type,
    role: device.role ?? inferDeviceRole(device.capabilities),
    capabilities: [...device.capabilities],
    zoneId: device.zoneId,
    binding: device.binding ?? `sim://${device.id}`,
    initialState: device.initialState,
    ...(device.ownerId !== undefined ? { ownerId: device.ownerId } : {}),
  };
}

function normalizeAgent(agent: RawAgent): ScenarioAgent {
  return {
    id: agent.id,
    name: agent.name,
    capabilities: [...agent.capabilities],
    managesZoneIds: agent.managesZoneIds ?? [],
    boundDeviceIds: agent.boundDeviceIds ?? [],
    llm: agent.llm,
    ...(agent.cannotDeliverClasses !== undefined ? { cannotDeliverClasses: [...agent.cannotDeliverClasses] } : {}),
    ...(agent.shortLabel !== undefined ? { shortLabel: agent.shortLabel } : {}),
    ...(agent.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: agent.rateLimitPerMinute } : {}),
    ...(agent.enabled !== undefined ? { enabled: agent.enabled } : {}),
    ...(agent.ownerUserId !== undefined ? { ownerUserId: agent.ownerUserId } : {}),
    // T-050: per-agent autonomous-decision policy (additive whitelist —
    // old scenario files load unchanged).
    ...(agent.decisionPolicy !== undefined
      ? { decisionPolicy: { ...agent.decisionPolicy } }
      : {}),
    // P3: author-declared semantic services survive the load verbatim.
    ...(agent.services !== undefined
      ? { services: agent.services.map(service => ({ ...service })) }
      : {}),
  };
}

function normalizeEvent(event: RawEvent): ScenarioEvent {
  return {
    id: event.id,
    type: event.type,
    zoneId: event.zoneId,
    parameter: event.parameter,
    value: event.value,
    atSimTimeSec: event.atSimTimeSec,
    ...(event.durationSec !== undefined ? { durationSec: event.durationSec } : {}),
    ...(event.severity !== undefined ? { severity: event.severity } : {}),
    ...(event.requiredCapabilities !== undefined
      ? { requiredCapabilities: [...event.requiredCapabilities] }
      : {}),
    ...(event.details !== undefined ? { details: { ...event.details } } : {}),
    // Wave 1 A4: sensor confidence (schema-only).
    ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
    // Wave 2 B3: cinematography block (UI auto-focus + narration cue).
    ...(event.cinematography !== undefined ? { cinematography: { ...event.cinematography } } : {}),
    // Wave 2 B6: PIPL consent requirements.
    ...(event.consentRequirements !== undefined ? { consentRequirements: { ...event.consentRequirements } } : {}),
    // Wave 2 B7: liability class.
    ...(event.liabilityClass !== undefined ? { liabilityClass: event.liabilityClass } : {}),
    // Author-facing extension fields (present in flagship scenarios).
    ...(event.acRationale !== undefined ? { acRationale: { ...event.acRationale } } : {}),
    ...(event.focusZoneId !== undefined ? { focusZoneId: event.focusZoneId } : {}),
    ...(event.humanNarrative !== undefined ? { humanNarrative: event.humanNarrative } : {}),
    // T-019: observation-only marker survives the loader so the runtime can
    // honor it (replay-baked timeline events are details, not stimuli).
    ...(event.observationOnly !== undefined ? { observationOnly: event.observationOnly } : {}),
  };
}
