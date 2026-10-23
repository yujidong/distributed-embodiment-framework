/**
 * L2 Cognition — Predictive what-if modeling (§4.4, Phase 4 of the agent
 * cognitive architecture: "the simulation engine AS the world model").
 *
 * Agents can answer "what would happen if …" by running a hypothetical
 * intervention through the REAL physics engine on PRIVATE FORKS of the
 * current world — never on the authoritative world itself (the no-reflow
 * red line, design-living-worlds §1).
 *
 * Mechanism (dual-fork, approach A of the task brief):
 *
 *   1. snapshot the live world once (`EngineRuntime.exportWorldState`);
 *   2. build TWO fresh headless runtimes from the same scenario and restore
 *      the SAME export into both — an exact, deterministic fork pair;
 *   3. disable every agent in both forks (no LLM, no AC, no autonomous
 *      actuation — the physics IS the executable world model, and the
 *      prediction must be fast and deterministic);
 *   4. apply the intervention to one arm only;
 *   5. step both arms the same number of ticks, sampling metrics;
 *   6. compare (delta, verdict, confidence, template explanation).
 *
 * R44-F3 radius pruning: on large worlds (≥ WHAT_IF_RADIUS_PRUNE_MIN_DEVICES
 * devices) both forks are pruned — BEFORE construction — to the affected
 * zone neighborhood (target zone + one-hop adjacentZoneIds): remote devices
 * and their checkpoint state are dropped so construction, restore, stepping
 * and sampling all scale with the radius instead of the whole world. Both
 * arms ALWAYS fork the identical subworld (see the radius section below).
 *
 * Determinism guarantees: the fault-injection RNG state rides the world
 * export (both arms restart from the identical seed+draws), the sim clock
 * anchor rides it too (diurnal value models cannot drift between arms), and
 * agents are disabled so no stochastic decision lane participates. A noisy
 * world (scenario `meta.environmentNoise: true`) is the documented opt-in
 * exception — each fork draws its own noise.
 *
 * Metrics:
 * - any zone parameter by name (`temperature`, `humidity`, …) — zone-scoped
 *   or averaged across zones that expose it;
 * - `energy` — the sum of device `cumulativeEnergyWh` meters (zone-scoped
 *   when `zoneId` is given), i.e. the fork's own T-703/T-710 accounting;
 * - `comfort` — a documented PROXY: normalized distance of the zone
 *   temperature outside the SAME comfort ranges the situation assessor uses
 *   (DEFAULT_PARAMETER_RANGES — single oracle; 0.0 = inside the band, 1.0 =
 *   one band-width outside). Lower is better. (The full ASHRAE PMV model
 *   lives in the simulation package — duplicating it here would drift.)
 *
 * Verdict semantics: per-metric "goodness" contributions (positive = worse)
 * summed into improvement | degradation | neutral. Energy: more Wh = worse.
 * Comfort/parameter metrics: moving AWAY from the comfort band = worse.
 * A metric `threshold` counts a worse-direction breach that the baseline
 * did not have as an extra degradation unit (and a repaired breach as an
 * improvement).
 *
 * Contribution weights mirror the design's multi-objective hierarchy (§5.2:
 * safety > comfort > energy > cost): comfort-band/parameter metrics weigh
 * 2.0, energy 0.5 — a kWh saved must NOT cancel a comfort degradation at
 * par (the spec's worked example: saving 0.8 kW while raising a zone 3.2°C
 * is a DEGRADATION). The tension stays VISIBLE (§4.2: visible tension beats
 * hidden tension) — the explanation carries both sentences verbatim.
 *
 * This module is the cognition-layer core of the platform-run what-if lane
 * (the agent PROPOSES the hypothesis; the PLATFORM runs the forks — §13.2).
 */

import type { ScenarioDefinition } from '../scenario/index.js';
import type { EngineWorldStateExport } from '../runtime/contract.js';
import { EngineRuntime } from '../runtime/EngineRuntime.js';
import { DEFAULT_PARAMETER_RANGES, type ParameterRange } from './situation-assessment.js';
import { resolveCommandEquivalence, temperatureCommandRank } from '../flows/command-equivalence.js';
import {
  bridgeRecommendationsToActuations,
  clauseLocationSegments,
  isFoldingSubsequence,
  scopeTypeCandidatesByLocation,
  typeSynonymHits,
  typeSynonymsOf,
} from '../flows/delegate-recommendation-bridge.js';

// ============================================================================
// Types (the task-brief contract)
// ============================================================================

/** The hypothetical change to test on a fork of the current world. */
export interface WhatIfIntervention {
  type: 'device_command' | 'parameter_change' | 'event_injection' | 'device_disable';
  /** deviceId (device lanes) or zoneId (parameter/event lanes). */
  target?: string;
  /** command name, or parameter name for parameter/event lanes. */
  action?: string;
  /** command/parameter value. */
  value?: number;
}

/** One thing to measure while the two arms run forward. */
export interface WhatIfMetric {
  /** 'temperature' | 'energy' | 'comfort' | any zone parameter name. */
  name: string;
  zoneId?: string;
  /** alert if the value crosses this in the worse direction. */
  threshold?: number;
}

export interface WhatIfScenario {
  intervention: WhatIfIntervention;
  metrics: WhatIfMetric[];
  /** lookahead window in simulated seconds (1..WHAT_IF_MAX_DURATION_SEC). */
  durationSec: number;
}

export type WhatIfVerdict = 'improvement' | 'degradation' | 'neutral' | 'inconclusive';

/** Per-metric judgement (audit trail for the verdict). */
export interface WhatIfContribution {
  key: string;
  /** + = the intervention made this metric WORSE; − = better. */
  contribution: number;
  sentence: string;
}

export interface WhatIfResult {
  scenario: WhatIfScenario;
  /** metric key → time series WITHOUT the intervention (t0..tEnd). */
  baseline: Record<string, number[]>;
  /** metric key → time series WITH the intervention (t0..tEnd). */
  intervention: Record<string, number[]>;
  /** metric key → final intervention − final baseline. */
  delta: Record<string, number>;
  verdict: WhatIfVerdict;
  confidence: number;
  /** deterministic template summary (Phase-3 rendering discipline). */
  explanation: string;
  /** per-metric audit trail: why the verdict is what it is. */
  contributions: WhatIfContribution[];
  /** honest accounting: metrics that could not be sampled, notes. */
  notes: string[];
  /** the sim-time anchor the prediction forked from. */
  forkedAtSimTimeSec: number;
}

/** The live world a prediction forks from. */
export interface WhatIfWorldSource {
  scenario: ScenarioDefinition;
  worldState: EngineWorldStateExport;
}

export interface WhatIfRunOptions {
  /**
   * Physics LOD tier for BOTH arms (default 'idle' — the coarse 10s substep;
   * R30: same attractor, ~10× cheaper. Both arms share the tier so the
   * comparison is fair; determinism holds for either choice).
   */
  lodTier?: 'observed' | 'idle';
  /** Max samples per metric series (default 60; t0 inclusive). */
  sampleCap?: number;
  /**
   * R44-F3 radius pruning — fork only the AFFECTED zone neighborhood
   * (target zone + adjacentZoneIds), not the whole world:
   * - `true`: always prune (explicit opt-in / tests);
   * - `false`: never prune (legacy full-world forks);
   * - undefined (default): AUTO — prune when the world carries at least
   *   WHAT_IF_RADIUS_PRUNE_MIN_DEVICES devices and the radius covers a
   *   strict subset of zones. Small worlds fork in full, unchanged.
   *
   * The pruning decision is made ONCE per runWhatIf call and applied to
   * BOTH arms identically — the hard fairness constraint: two differently
   * pruned arms would make the delta meaningless.
   */
  radiusPruning?: boolean;
}

/** Teaching-grade validation error (the route maps it to 400). */
export class WhatIfValidationError extends Error {}

// ============================================================================
// Budgets
// ============================================================================

/** Longest lookahead (1 simulated hour). */
export const WHAT_IF_MAX_DURATION_SEC = 3600;
/**
 * R40-B1: the ABSOLUTE ceiling a scenario's `meta.whatIfQuota.maxDurationSec`
 * may grant (2 simulated hours). Scenarios may tighten or extend within
 * [1, this]; nothing may exceed it.
 */
export const WHAT_IF_ABSOLUTE_MAX_DURATION_SEC = 7200;
/** Default lookahead when neither the body nor the text carries one. */
export const WHAT_IF_DEFAULT_DURATION_SEC = 600;
/** Max distinct metrics per scenario. */
export const WHAT_IF_MAX_METRICS = 8;
/** Metric names with engine-backed accounting (not zone parameters). */
const ENERGY_METRIC_NAMES = new Set(['energy', 'energy_wh', 'power']);
const COMFORT_METRIC_NAMES = new Set(['comfort', 'discomfort']);
/**
 * §5.2 objective hierarchy as contribution weights: comfort/parameter
 * metrics weigh 2.0, energy 0.5 (safety-first order; see module header).
 */
const OBJECTIVE_WEIGHTS = { comfort: 2.0, energy: 0.5 } as const;

/**
 * R40-B1: the effective what-if lookahead cap for a scenario — the world's
 * own `meta.whatIfQuota.maxDurationSec` when declared (schema-capped at
 * WHAT_IF_ABSOLUTE_MAX_DURATION_SEC), else the platform default
 * WHAT_IF_MAX_DURATION_SEC. Single oracle for the endpoint's pre-checks and
 * the text parser's clamping, so a quota breach teaches the SAME number the
 * predictor would enforce.
 */
export function whatIfMaxDurationSecOf(
  scenario: Pick<ScenarioDefinition, 'meta'>,
): number {
  const quota = scenario.meta.whatIfQuota?.maxDurationSec;
  if (quota === undefined || !Number.isFinite(quota)) return WHAT_IF_MAX_DURATION_SEC;
  return Math.min(Math.max(1, Math.floor(quota)), WHAT_IF_ABSOLUTE_MAX_DURATION_SEC);
}

// ============================================================================
// R44-F3 — radius pruning (fork only the affected zone neighborhood)
// ============================================================================
//
// Measured on the dense city world (722 devices / 6 zones): what-if latency
// grew ×5.5 for a ×2 world while a single intervention touches 1-2 devices in
// ONE zone. ~95% of a fork's physics wall time is `device.onPhysicsTick` over
// EVERY device — most of it spent on zones the intervention cannot reach
// within the lookahead window.
//
// Radius semantics: the physical propagation range of an intervention is its
// target zone plus the one-hop `adjacentZoneIds` neighborhood. The fork keeps
// those zones whole; zones outside the radius are PHYSICALLY ISOLATED:
// their devices are excluded from the fork (no control loops, no physics
// effects, no energy accrual) and their checkpoint state is dropped, while
// the zones themselves (their baselines, field locations, occupancy sources
// and ambient relaxation) stay in the world so the boundary around the
// radius keeps evolving realistically. Zone-level writes (scenario events,
// occupancy schedules, environment drives) are unchanged — they are
// deterministic in both arms.
//
// Pruning happens BEFORE fork construction (the fork runtime is built from a
// pruned scenario + a pruned world export), so construction, restore, physics
// stepping AND metric sampling all shrink with the radius. It is derived
// purely from (scenario, intervention) — never from arm identity — and is
// computed once per runWhatIf call so both arms fork the same subworld.

/**
 * Worlds at or above this device count auto-prune what-if forks to the
 * affected radius. Below it, forks keep the full world (identical to the
 * legacy behavior — every existing test fixture and mid-size scenario).
 * The threshold sits between the campus tiers (156 devices) and the city
 * tiers (362/722): only worlds whose what-if cost is device-dominated prune.
 */
export const WHAT_IF_RADIUS_PRUNE_MIN_DEVICES = 256;

/**
 * The affected radius of an intervention: the target zone (the device's zone
 * for device lanes, the zone itself for parameter/event lanes) plus its
 * one-hop `adjacentZoneIds` neighborhood. Returns null when the target does
 * not resolve (unknown device/zone) — the caller then forks the full world
 * and `applyIntervention` raises the same teaching error as before.
 */
export function whatIfAffectedZoneIds(
  scenario: Pick<ScenarioDefinition, 'zones' | 'devices'>,
  intervention: WhatIfIntervention,
): ReadonlySet<string> | null {
  const targetZone =
    intervention.type === 'parameter_change' || intervention.type === 'event_injection'
      ? intervention.target
      : scenario.devices.find(device => device.id === intervention.target)?.zoneId;
  if (targetZone === undefined) return null;
  const zone = scenario.zones.find(z => z.id === targetZone);
  if (zone === undefined) return null;
  const scope = new Set<string>([zone.id]);
  for (const adjacent of zone.adjacentZoneIds ?? []) {
    // Tolerate dangling adjacency (the loader validates, programmatic
    // scenarios may not) — unknown neighbors simply drop out of the radius.
    if (adjacent !== zone.id && scenario.zones.some(z => z.id === adjacent)) {
      scope.add(adjacent);
    }
  }
  return scope;
}

/**
 * Prune a fork source to the affected radius. Deterministic and pure: same
 * (source, zoneScope) → same subworld. Zones, events and flows are kept
 * verbatim (the global value models, zone baselines and field topology must
 * reconstruct exactly as in the full world, or the radius physics would
 * change); only remote DEVICES (and agents whose managed zones + bound
 * devices are all remote) are dropped from the scenario, and their state,
 * faults, cognition checkpoints and physics effects from the export.
 * Occupancy survives by construction — it rides the ZONE state (exports
 * exclude occupancy virtual sources; restore re-derives them), keeping the
 * radius's ambient boundary realistic. The `occupancy:` guard on effects is
 * defensive for programmatic sources that carry them inline.
 */
export function pruneWhatIfSource(
  source: WhatIfWorldSource,
  zoneScope: ReadonlySet<string>,
): WhatIfWorldSource {
  const devices = source.scenario.devices.filter(device => zoneScope.has(device.zoneId));
  const deviceIds = new Set(devices.map(device => device.id));
  const agents = source.scenario.agents.filter(agent =>
    agent.boundDeviceIds.some(id => deviceIds.has(id)) ||
    agent.managesZoneIds.some(id => zoneScope.has(id)),
  );
  const agentIds = new Set(agents.map(agent => agent.id));

  const worldDevices: typeof source.worldState.devices = {};
  for (const [id, state] of Object.entries(source.worldState.devices)) {
    if (deviceIds.has(id)) worldDevices[id] = state;
  }
  const worldAgents: typeof source.worldState.agents = {};
  for (const [id, state] of Object.entries(source.worldState.agents)) {
    if (agentIds.has(id)) worldAgents[id] = state;
  }

  return {
    scenario: { ...source.scenario, devices, agents },
    worldState: {
      ...source.worldState,
      devices: worldDevices,
      agents: worldAgents,
      deviceEffects: source.worldState.deviceEffects.filter(
        effect => deviceIds.has(effect.deviceId) || effect.deviceId.startsWith('occupancy:'),
      ),
    },
  };
}

/** R44-F3: resolve the effective fork source + sampling scope for a run. */
function resolveForkSource(
  source: WhatIfWorldSource,
  intervention: WhatIfIntervention,
  options: WhatIfRunOptions,
): { forkSource: WhatIfWorldSource; sampleScope?: ReadonlySet<string>; pruned: boolean } {
  const zoneScope = whatIfAffectedZoneIds(source.scenario, intervention);
  if (zoneScope === null) return { forkSource: source, pruned: false };
  const totalDevices = source.scenario.devices.length;
  const keptDevices = source.scenario.devices.filter(device => zoneScope.has(device.zoneId)).length;
  const auto = totalDevices >= WHAT_IF_RADIUS_PRUNE_MIN_DEVICES && keptDevices < totalDevices;
  if (options.radiusPruning === false) return { forkSource: source, pruned: false };
  if (options.radiusPruning === true || auto) {
    return { forkSource: pruneWhatIfSource(source, zoneScope), sampleScope: zoneScope, pruned: true };
  }
  return { forkSource: source, pruned: false };
}

// ============================================================================
// Pure helpers
// ============================================================================

/** Series key: `name` (averaged) or `name_zoneId` (scoped). */
export function metricKeyOf(metric: WhatIfMetric): string {
  return metric.zoneId === undefined ? metric.name : `${metric.name}_${metric.zoneId}`;
}

/** Deterministic number rendering for series/deltas (3 decimals). */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function last(series: number[] | undefined): number | undefined {
  return series !== undefined && series.length > 0 ? series[series.length - 1] : undefined;
}

/**
 * Normalized distance of `value` outside a range: 0 inside, 1.0 = one
 * band-width beyond an edge. The comfort PROXY's single math face.
 */
export function normalizedDistanceOutsideRange(value: number, range: ParameterRange): number {
  const width = range.max - range.min;
  if (width <= 0) return 0;
  const outside = value > range.max ? value - range.max : value < range.min ? range.min - value : 0;
  return outside / width;
}

/** WORSE direction for a threshold relative to the comfort-band center. */
function thresholdWorseDirection(threshold: number, center: number): 'up' | 'down' {
  return threshold >= center ? 'up' : 'down';
}

/** One-line description of an intervention (explanation + audit face). */
export function describeIntervention(
  intervention: WhatIfIntervention,
  deviceName?: (deviceId: string) => string | undefined,
): string {
  // T55 (R6): a device reference in the NL face is its readable NAME —
  // never a bare UUID (R76-F4/T45 platform invariant: the human-readable NL
  // surface carries no raw UUIDs; MR1b/MR3b own-first regressed when the
  // R98 "(name (id))" precision format leaked into the verification
  // narrative). R98's readability诉求 (name first) is preserved; R98's
  // precision诉求 is carried by the structured `intervention`/explanation
  // fields in --json, not by the prose. Unresolvable ids still fall back to
  // the id itself (honest absence of a name, not a placeholder).
  const deviceLabel = (id: string | undefined): string => {
    if (id === undefined) return '?';
    const name = deviceName?.(id);
    return name !== undefined && name.length > 0 ? name : id;
  };
  switch (intervention.type) {
    case 'device_command':
      return `command "${intervention.action ?? '?'}" on device "${deviceLabel(intervention.target)}"${
        intervention.value !== undefined ? ` (value ${intervention.value})` : ''
      }`;
    case 'device_disable':
      return `device "${deviceLabel(intervention.target)}" taken offline`;
    case 'parameter_change':
      return `zone "${intervention.target ?? '?'}" parameter ${intervention.action ?? '?'} set to ${
        intervention.value ?? '?'
      }`;
    case 'event_injection':
      return `${intervention.action ?? 'event'} = ${intervention.value ?? '?'} injected into zone "${
        intervention.target ?? '?'
      }"`;
  }
}

// ============================================================================
// Validation + normalization (pure; teaching errors, never silent drops)
// ============================================================================

const INTERVENTION_TYPES = ['device_command', 'parameter_change', 'event_injection', 'device_disable'] as const;

/** Fields each intervention type actually consumes (others would be dropped). */
const INTERVENTION_FIELDS: Record<WhatIfIntervention['type'], string[]> = {
  device_command: ['type', 'target', 'action', 'value'],
  parameter_change: ['type', 'target', 'action', 'value'],
  event_injection: ['type', 'target', 'action', 'value', 'severity'],
  device_disable: ['type', 'target'],
};

/**
 * Validate + normalize a structured what-if scenario. Throws
 * WhatIfValidationError with a teaching message on any bad input — a
 * silently-dropped field here would change what the prediction tests.
 *
 * R40-B1: `options.maxDurationSec` carries the scenario's what-if quota
 * (see whatIfMaxDurationSecOf). When omitted, the platform default
 * WHAT_IF_MAX_DURATION_SEC applies — the standalone/normalize contract is
 * unchanged.
 */
export function normalizeWhatIfScenario(
  input: WhatIfScenario,
  options: { maxDurationSec?: number } = {},
): WhatIfScenario {
  const { intervention } = input;
  if (intervention === null || typeof intervention !== 'object') {
    throw new WhatIfValidationError('intervention must be an object ({ type, target?, action?, value? })');
  }
  if (!INTERVENTION_TYPES.includes(intervention.type as (typeof INTERVENTION_TYPES)[number])) {
    throw new WhatIfValidationError(
      `intervention.type must be one of ${INTERVENTION_TYPES.map(t => `"${t}"`).join(' | ')} ` +
        `(got ${JSON.stringify(intervention.type)})`,
    );
  }
  const known = INTERVENTION_FIELDS[intervention.type];
  const unknown = Object.keys(intervention).filter(key => !known.includes(key));
  if (unknown.length > 0) {
    throw new WhatIfValidationError(
      `intervention.${intervention.type} does not consume ${unknown.map(k => `"${k}"`).join(', ')} ` +
        `— accepted fields: ${known.map(f => `"${f}"`).join(', ')}`,
    );
  }

  const requiresTarget: WhatIfIntervention['type'][] = ['device_command', 'parameter_change', 'event_injection', 'device_disable'];
  if (requiresTarget.includes(intervention.type)) {
    if (typeof intervention.target !== 'string' || intervention.target.length === 0) {
      throw new WhatIfValidationError(
        `intervention.target must be a non-empty string — the ${
          intervention.type === 'parameter_change' || intervention.type === 'event_injection' ? 'zoneId' : 'deviceId'
        } the hypothetical acts on`,
      );
    }
  }
  if (intervention.type !== 'device_disable' && (intervention.action === undefined || typeof intervention.action !== 'string' || intervention.action.length === 0)) {
    throw new WhatIfValidationError(
      `intervention.action must be a non-empty string — the ${intervention.type === 'parameter_change' || intervention.type === 'event_injection' ? 'parameter name' : 'command name'}`,
    );
  }
  if (intervention.value !== undefined && typeof intervention.value !== 'number') {
    throw new WhatIfValidationError('intervention.value must be a number when provided');
  }
  if (
    (intervention.type === 'parameter_change' || intervention.type === 'event_injection') &&
    intervention.value === undefined
  ) {
    throw new WhatIfValidationError(`intervention.value is required for ${intervention.type} (the hypothetical parameter value)`);
  }

  if (!Array.isArray(input.metrics) || input.metrics.length === 0) {
    throw new WhatIfValidationError('metrics must be a non-empty array ({ name, zoneId?, threshold? })');
  }
  if (input.metrics.length > WHAT_IF_MAX_METRICS) {
    throw new WhatIfValidationError(`metrics is capped at ${WHAT_IF_MAX_METRICS} entries`);
  }
  const metrics = input.metrics.map((metric, i) => {
    if (metric === null || typeof metric !== 'object') {
      throw new WhatIfValidationError(`metrics[${i}] must be an object ({ name, zoneId?, threshold? })`);
    }
    if (typeof metric.name !== 'string' || metric.name.length === 0) {
      throw new WhatIfValidationError(`metrics[${i}].name must be a non-empty string`);
    }
    if (metric.zoneId !== undefined && (typeof metric.zoneId !== 'string' || metric.zoneId.length === 0)) {
      throw new WhatIfValidationError(`metrics[${i}].zoneId must be a non-empty string when provided`);
    }
    if (metric.threshold !== undefined && (typeof metric.threshold !== 'number' || !Number.isFinite(metric.threshold))) {
      throw new WhatIfValidationError(`metrics[${i}].threshold must be a finite number when provided`);
    }
    return {
      name: metric.name,
      ...(metric.zoneId !== undefined ? { zoneId: metric.zoneId } : {}),
      ...(metric.threshold !== undefined ? { threshold: metric.threshold } : {}),
    } satisfies WhatIfMetric;
  });

  const maxDurationSec = Math.min(
    Math.max(1, Math.floor(options.maxDurationSec ?? WHAT_IF_MAX_DURATION_SEC)),
    WHAT_IF_ABSOLUTE_MAX_DURATION_SEC,
  );
  const durationSec = input.durationSec;
  if (
    typeof durationSec !== 'number' ||
    !Number.isInteger(durationSec) ||
    durationSec < 1 ||
    durationSec > maxDurationSec
  ) {
    throw new WhatIfValidationError(
      `durationSec must be an integer in [1, ${maxDurationSec}] (simulated seconds of lookahead)` +
        (options.maxDurationSec !== undefined && maxDurationSec !== WHAT_IF_MAX_DURATION_SEC
          ? ` — capped by this scenario's meta.whatIfQuota.maxDurationSec (${maxDurationSec})`
          : ''),
    );
  }

  return { intervention: { ...intervention }, metrics, durationSec };
}

// ============================================================================
// Text parsing ("what if I turn off HVAC-1 for 30 minutes?")
// ============================================================================

/** The agent-view device shape the text parser matches against. */
export interface WhatIfDeviceView {
  deviceId: string;
  name: string;
  type: string;
  zoneId?: string;
  commands: readonly string[];
  /**
   * T2 (R2, u1-F1): the device's LITERAL dispatch face (the runtime
   * snapshot's own command list) when the caller has it. The parsed
   * `commands` may be EXPANDED through the semantic mappings
   * (temperature-control → set-temperature), which is the right vocabulary
   * for prose matching but the WRONG gate for equivalence downgrades — the
   * fork validates against the literal face, so a foreign command that only
   * exists on a sibling device must be mapped ONTO this face. Absent =
   * `commands` is the face.
   */
  rawCommands?: readonly string[];
  /**
   * T2 (R2, u1-F1): the device's current control-loop state when the caller
   * has it (the runtime snapshot does) — the relative-temperature lane
   * ("raise the setpoint by 2 degrees" / 「调高 2 度」) offsets THIS, and
   * without it a relative ask honestly rejects teaching the absolute form.
   */
  state?: Record<string, unknown>;
}

export interface WhatIfTextParse {
  intervention: WhatIfIntervention;
  durationSec: number;
  notes: string[];
}

/**
 * Line-INITIAL openers. T25 (R3, u1-F2): `what[\s-]+if` folds the hyphen
 * spelling ("what-if …") into the same opener — the dash is punctuation,
 * not a different intent.
 */
const WHAT_IF_OPENERS =
  /^\s*(?:what\s+(?:would|will)\s+happen\s+if|what\s+happens\s+if|what[\s-]+if|suppose\s+that|suppose|hypothetically[, ]+if|假设|假如|要是|如果)/i;

/**
 * T25 (R3, u1-F2): zh sentence-FINAL question forms — the most natural zh
 * what-if puts the interrogative at the END (「…空调调高 2 度会怎样」).
 * Fired ONLY when the text also carries an intervention cue
 * (whatIfTailQuestionIsInterventional below) so plain curiosities
 * (「今天天气会怎样」) are never swallowed into the what-if lane — they walk
 * to the ask/intent lanes as before (honest boundary: rather refuse than
 * misroute).
 */
const WHAT_IF_TAIL_QUESTION = /(?:会怎样|会怎么样|会如何|会咋样|会怎么样子?)\s*[?？!！。]?\s*$/;

/** EN tail form ("…, what happens?") — rare; kept for symmetry. */
const WHAT_IF_EN_TAIL_QUESTION = /,?\s*what\s+(?:would\s+)?happen\s*[?？]?\s*$/i;

/** Intervention-cue vocabulary for the tail-question gate: action verbs
 * (zh + en) that the downstream lanes actually parse. */
const WHAT_IF_INTERVENTION_CUE =
  /关闭|关掉|停用|打开|开启|启动|停止|断开|调高|调低|调到|调至|调成|设定|设置|改成|调整为?|升高|降低|提高|减少|增加|下降|上升|关掉|故障|宕机|坏了|断电|turn[\s-]*on|turn[\s-]*off|shut\s+down|switch|set\s+to|adjust|raise|lower|increase|decrease|reduce|disable|fail|offline|power\s+off/i;

/**
 * Whether a tail-question text carries a mappable intervention cue: an
 * explicit action/failure verb, or a reference resolvable against the
 * world's devices (id/name literal, or a type word of an existing device —
 * the ONE bridge vocabulary).
 */
function whatIfTailQuestionIsInterventional(
  text: string,
  devices: ReadonlyArray<WhatIfDeviceView>,
): boolean {
  if (WHAT_IF_INTERVENTION_CUE.test(text)) return true;
  const haystack = foldToken(text);
  const lower = text.toLowerCase();
  for (const device of devices) {
    const id = foldToken(device.deviceId);
    const name = foldToken(device.name);
    if (id.length > 1 && haystack.includes(id)) return true;
    if (name.length > 1 && haystack.includes(name)) return true;
    if (typeSynonymsOf(device.type).some(s => s.length > 1 && lower.includes(s.toLowerCase()))) return true;
  }
  return false;
}

const DURATION_PHRASE =
  /\b(?:for|over|next|在)?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|秒|分钟|分|小时)(?![a-z0-9])/gi;

const DISABLE_PHRASE = /\b(?:disable[sd]?|takes?\s+offline|goes?\s+offline|break(s|down|s\s+down)?|fail(s|ed|ure)?s?|dies?|kill(s|ed)?)\b|宕机|坏了|故障/i;

/** Normalize an id/name for substring matching (case/dash/underscore
 * insensitive, CJK preserved — stripping CJK collapsed Chinese device
 * names to their digits, so 「排涝智能阀 1」 matched any *1 device). */
function foldToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

/**
 * Device mentions (id or folded-name substring), disambiguated:
 * - an exact id mention beats any name mention;
 * - among name mentions, a candidate whose folded name is a strict PREFIX
 *   of another candidate's folded name is dropped — 「排涝智能阀 1」 must
 *   not steal matches meant for 「排涝智能阀 11」 (and when both match,
 *   the longer mention wins);
 * - when several devices share the SAME name (city-scale scenarios name
 *   each facility's devices alike), the asking agent's own scope wins and
 *   the alternatives ride the notes.
 */
export function resolveDeviceMentions(
  text: string,
  devices: ReadonlyArray<WhatIfDeviceView>,
  scope?: ReadonlySet<string>,
): { picks: WhatIfDeviceView[]; notes: string[] } {
  const notes: string[] = [];
  const haystack = foldToken(text);
  if (haystack.length === 0) return { picks: [], notes };

  const byId: WhatIfDeviceView[] = [];
  const byName: WhatIfDeviceView[] = [];
  for (const device of devices) {
    const foldedId = foldToken(device.deviceId);
    const foldedName = foldToken(device.name);
    if (foldedId.length > 0 && haystack.includes(foldedId)) byId.push(device);
    else if (foldedName.length > 1 && haystack.includes(foldedName)) byName.push(device);
  }
  if (byId.length > 0) {
    if (byId.length > 1) notes.push(`multiple devices mentioned by id (${byId.map(d => d.deviceId).join(', ')}) — using the first`);
    return { picks: byId, notes };
  }
  if (byName.length === 0) return { picks: [], notes };

  // Drop prefix-shadowed candidates (阀 1 vs 阀 11 — see the doc comment).
  const folds = new Map(byName.map(d => [d.deviceId, foldToken(d.name)]));
  const surviving = byName.filter(
    d => !byName.some(other => other.deviceId !== d.deviceId
      && (folds.get(other.deviceId) ?? '').startsWith(folds.get(d.deviceId) ?? '')
      && (folds.get(other.deviceId) ?? '').length > (folds.get(d.deviceId) ?? '').length),
  );

  // Same-name siblings: prefer the asking agent's own devices.
  let picks = surviving;
  if (scope !== undefined && surviving.length > 1) {
    const own = surviving.filter(d => scope.has(d.deviceId));
    if (own.length > 0 && own.length < surviving.length) {
      notes.push(`ambiguous device name (matches ${surviving.map(d => `${d.name}@${d.zoneId ?? '?'}`).join(', ')}) — using one from this agent's own devices`);
      picks = own;
    }
  }
  if (picks.length > 1) {
    notes.push(`multiple devices share this name (${picks.map(d => `${d.name}@${d.zoneId ?? '?'}`).join(', ')}) — using the first`);
  }
  return { picks, notes };
}

/**
 * Rank a command as a temperature setter for the zone-temperature lane
 * (lower = preferred; -1 = not one). Env-imported devices carry CAPABILITY
 * names ('temperature-control', 'cooling') where file scenarios carry
 * 'set-temperature' — both are the same ask.
 *
 * T67 (R6): exported as THE shared temperature-equivalence vocabulary —
 * the signing gate (assertActionExecutable) consumes it so propose agrees
 * with what the parse lane's T2/T48 equivalence actually maps (one matcher,
 * never a second one).
 *
 * T70 (R8, u1-F2): the definition moved to flows/command-equivalence.ts (the
 * ONE command-equivalence judgment module, shared with the NL execution
 * filter and the verification fork); this re-export keeps the public core
 * API path stable.
 */
export { temperatureCommandRank } from '../flows/command-equivalence.js';

/**
 * T2 (R2, u1-F1): the current setpoint from a device state object — the
 * delta base for relative temperature asks. Same key family the bridge's
 * currentSetpointOf reads (one vocabulary, never a second one).
 */
function currentSetpointOfState(state: Record<string, unknown> | undefined): number | undefined {
  if (state === undefined) return undefined;
  for (const key of ['targetTemperature', 'setpoint', 'temperature']) {
    const value = state[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * The zone's own temperature-capable device (the asker's OWN devices win
 * ties — R49 scope discipline), or undefined when the zone has none (the
 * caller then falls back to a zone parameter_change).
 */
function pickTemperatureDevice(
  devices: ReadonlyArray<WhatIfDeviceView>,
  zoneId: string,
  ownScope?: ReadonlySet<string>,
): { device: WhatIfDeviceView; command: string } | undefined {
  let best: { device: WhatIfDeviceView; command: string; rank: number; own: boolean } | undefined;
  for (const device of devices) {
    if (device.zoneId !== zoneId) continue;
    for (const command of device.commands) {
      const rank = temperatureCommandRank(command);
      if (rank < 0) continue;
      const own = ownScope?.has(device.deviceId) === true;
      if (best === undefined || (own && !best.own) || (own === best.own && rank < best.rank)) {
        best = { device, command, rank, own };
      }
    }
  }
  return best;
}

/**
 * T42 (R4, u1-F2): ONE device's best temperature-setter command for the
 * absolute no-noun lane (5d). Ranks against the device's LITERAL face
 * (rawCommands when the state overlay supplied it — the face the fork's
 * validation enforces), mirroring the T2 equivalence gate; the expanded
 * vocabulary backs the choice only when no literal face exists. Undefined
 * when the device cannot set temperature at all (the caller falls through
 * or teaches — never a guessed command).
 */
function bestTemperatureCommandOf(
  device: WhatIfDeviceView,
): { device: WhatIfDeviceView; command: string } | undefined {
  const literal = device.rawCommands ?? device.commands;
  const best = literal
    .map(command => ({ command, rank: temperatureCommandRank(command) }))
    .filter(entry => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank)[0];
  return best !== undefined ? { device, command: best.command } : undefined;
}

/**
 * Resolve a zone mention ("客厅", "living room") to zoneIds by folded name
 * or id (R83). Containment tolerated — 「客厅空调温度」's zone fragment 客厅
 * lives inside the mention; the longest matching name wins.
 *
 * T48 (R5, u1-F2): a FOLDING-SUBSEQUENCE last resort joins the resolver —
 * the campus names zones with interleaved official words
 * (「D栋·AI与先进计算·物联网学院·图书馆 1F」), so a question's place phrase
 * 「D栋图书馆」/「图书馆」 is a subsequence of the name, not a substring.
 * Matching is CLASSED (exact id > exact name > containment > subsequence)
 * and every match of the best class is returned — the clue consumers treat
 * the result as a SET, the single-target lanes take the first (longest
 * name wins, then original order).
 */
export function resolveZoneMentionCandidates(
  mention: string,
  zones?: ReadonlyArray<{ zoneId: string; name?: string }>,
): string[] {
  if (zones === undefined || zones.length === 0) return [];
  const needle = foldToken(mention);
  if (needle.length === 0) return [];
  const byId = zones.find(z => foldToken(z.zoneId) === needle);
  if (byId !== undefined) return [byId.zoneId];
  const named = zones.filter(z => z.name !== undefined && foldToken(z.name!).length > 0);
  const exact = named.filter(z => foldToken(z.name!) === needle);
  if (exact.length > 0) return exact.map(z => z.zoneId);
  const contained = named
    .filter(z => needle.includes(foldToken(z.name!)) || foldToken(z.name!).includes(needle))
    .sort((a, b) => foldToken(b.name!).length - foldToken(a.name!).length);
  if (contained.length > 0) return contained.map(z => z.zoneId);
  // T48: subsequence containment (the interleaved-official-words zone names).
  const subsequence = named
    .filter(z => isFoldingSubsequence(needle, foldToken(z.name!)))
    .sort((a, b) => foldToken(b.name!).length - foldToken(a.name!).length);
  return subsequence.map(z => z.zoneId);
}

/** Single-target zone resolution — the first (best-classed) candidate. */
function resolveZoneMention(
  mention: string,
  zones?: ReadonlyArray<{ zoneId: string; name?: string }>,
): string | undefined {
  return resolveZoneMentionCandidates(mention, zones)[0];
}

/**
 * T26 (R3, u1-F3): the zone clues a question carries — WHERE the natural
 * reference aims. Two shapes:
 * - zh/named place phrases via the R83 resolver over the clause's location
 *   segments (the SAME path the unmapped ranking uses — one segmentation);
 * - building tokens, zh 「D栋」 and EN "building D" alike, folded into the
 *   world's zone ids/names (「D栋」→ d → bldg-d-*). Deliberately a CLUE set:
 *   it narrows type-word candidates, and only a single survivor may be
 *   auto-selected — ambiguity still goes to the teaching faces.
 */
function questionZoneClues(
  text: string,
  devices: ReadonlyArray<WhatIfDeviceView>,
  zones?: ReadonlyArray<{ zoneId: string; name?: string }>,
): ReadonlySet<string> {
  const found = new Set<string>();
  if (zones === undefined || zones.length === 0) return found;
  const typeWords = [...new Set(devices.flatMap(d => typeSynonymsOf(d.type)))];
  for (const segment of clauseLocationSegments(text, typeWords)) {
    // T48: every candidate of the best match class joins the clue set (the
    // 「图书馆」 phrase hits all of a building's floors; the type-word lane
    // narrows to the one that carries the device).
    for (const zoneId of resolveZoneMentionCandidates(segment, zones)) {
      found.add(zoneId);
    }
  }
  // 「D栋」 / 「3栋」 — the char(s) before 栋 fold into zone ids/names.
  // Matching is PART-exact on the zone id (「D栋」→ 'd' matches the 'd'
  // segment of bldg-d-f1, NOT the 'd' inside every 'bldg' prefix) or a
  // prefix of the folded zone name (「D栋…」→ 'd…').
  const tokenMatchesZone = (token: string, zone: { zoneId: string; name?: string }): boolean => {
    if (token.length === 0) return false;
    const idParts = zone.zoneId.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(p => p.length > 0);
    if (idParts.some(part => part === token)) return true;
    if (zone.name !== undefined && foldToken(zone.name).startsWith(token)) return true;
    return false;
  };
  for (const match of text.matchAll(/([a-z0-9]{1,4})\s*栋/gi)) {
    const token = foldToken(match[1]);
    for (const zone of zones) {
      if (tokenMatchesZone(token, zone)) found.add(zone.zoneId);
    }
  }
  // "building D" / "bldg d" / "block 3" — same folding.
  for (const match of text.matchAll(/\b(?:building|bldg|block|tower)\s+([a-z0-9]{1,4})\b/gi)) {
    const token = foldToken(match[1]);
    for (const zone of zones) {
      if (tokenMatchesZone(token, zone)) found.add(zone.zoneId);
    }
  }
  return found;
}

/**
 * R83: the unmapped-question teaching error, localized via the request
 * locale (the i18n plugin's zh-CN default is the product's source-of-truth
 * locale). Unknown/absent locales keep the English original — the core
 * module's standalone contract is unchanged.
 *
 * R1 (B1-3, u1 F3): on LARGE surfaces the message used to dump EVERY device
 * (115 entries on the taicang campus, one unreadable line). Policy now:
 *   - ≤5 devices → the exhaustive 已知设备/Known devices list (the small
 *     world's teaching contract is unchanged);
 *   - larger → at most FIVE candidates ranked by relevance to the
 *     question's location/type words (the ranking shares the bridge's zh/EN
 *     type-word vocabulary — one table, never a second matcher), labeled
 *     最相关的候选设备/Closest candidates;
 *   - nothing ranks → NO device list at all (a flood is not a fallback);
 *   - always: an actionable next step.
 */
/**
 * T42 (R4, u1-F2): the OFFICIAL example sentences the error teaches — ONE
 * data table that the message builders, the CLI help paragraph, and the
 * copy-consistency test all consume (T48, R5: 收编 — the help no longer
 * keeps a second copy of the examples). Every entry here carries a hard
 * promise: `parseWhatIfText` MUST map it (the placeholder
 * <device>/<设备>/<分区> substitutes a real device/zone reference) — against
 * an HONEST world where devices carry their literal capability face and NO
 * known setpoint. Teaching a form the parser rejects is an R102 violation —
 * the consistency test turns that promise into a gate.
 *
 * T48 (R5, u1-F1): the RELATIVE setpoint shapes (「调高 2 度」/"raises its
 * setpoint by 2 degrees") LEFT the table. They parse only when the target
 * device's live state exposes a setpoint to offset (the T2 lane); the
 * campus's HVAC face carries none, so every taught relative ask 400'd and
 * the error's own suggestion became a dead loop. The relative lane still
 * WORKS for setpoint-exposing devices — it is just no longer PROMISED
 * unconditionally. Absolute shapes (调到/设为, "set … to N degrees") joined
 * instead, including the verb-less-的连写 form (「<分区>图书馆空调调到…」)
 * the T48 segment/zone resolution fixed.
 */
export const UNMAPPED_WHAT_IF_EXAMPLES = {
  en: [
    'what if I turn off <device> for 30 minutes',
    'what if <device> fails',
    'what if I set the AC in building D to 26 degrees',
  ],
  zh: [
    '如果把 <设备> 关掉 30 分钟会怎样',
    '<设备> 调到 26 度会怎样',
    '<分区> 的空调调到 26 度会怎样',
    '把 <分区>图书馆空调调到 26 度会怎样',
  ],
} as const;

const UNMAPPED_WHAT_IF_ERROR = {
  en: (candidates: readonly string[], exhaustive: boolean) =>
    `I understood the what-if question but could not map it onto an intervention.` +
    (candidates.length > 0
      ? ` ${exhaustive ? 'Known devices' : 'Closest candidates'}: ${candidates.join('; ')}.`
      : '') +
    // T65a (R6, u1-F2): the teaching names only commands that EXIST — the
    // CLI's device list has no --zone flag; --env is the real filter.
    ` Retry with the device's full name or id (see "device list --env <envId>"), ` +
    `try ${UNMAPPED_WHAT_IF_EXAMPLES.en.map(example => `"${example}"`).join(', ')} — ` +
    `or POST the structured { intervention: { type, target, action, value? } } form.`,
  zh: (candidates: readonly string[], exhaustive: boolean) =>
    `我理解了这个 what-if 问题，但没能把它映射成一次干预。` +
    (candidates.length > 0
      ? (exhaustive ? `已知设备：` : `最相关的候选设备：`) + candidates.join('；') + `。`
      : '') +
    `请改用设备全名或 id 重试（可先用 device list --env <环境> 查看），` +
    `或试试「${UNMAPPED_WHAT_IF_EXAMPLES.zh.join('」「')}」` +
    `（句尾问式「……会怎样」可以直接用），或直接 POST 结构化的 ` +
    `{ intervention: { type, target, action, value? } } 形式。`,
} as const;

/** How many candidates the unmapped-question error may name. */
const UNMAPPED_MAX_CANDIDATES = 5;

/**
 * The honest type/zone disambiguation refusal (the T69 wording family, one
 * voice for every lane that narrowed to SEVERAL clue-hit devices the asking
 * agent does not own — T87 unified the zh/en twins on it).
 */
function typeZoneDisambiguationError(
  candidates: ReadonlyArray<WhatIfDeviceView>,
  locale: string | undefined,
): string {
  const zh = typeof locale === 'string' && locale.toLowerCase().startsWith('zh');
  const label = (device: WhatIfDeviceView): string =>
    `${device.name.length > 0 ? device.name : device.deviceId} (${device.deviceId})@${device.zoneId ?? '?'}`;
  const who = candidates.map(label).join(zh ? '、' : ', ');
  return zh
    ? `这个问题里的类型/分区词命中了 ${candidates.length} 台设备：${who}。` +
      `请指名其中一台（用设备名或编号）再问——这里不给单边结论。`
    : `The type/zone words in your question match ${candidates.length} devices: ` +
      `${who}. Name one of them (by device name or id) and ask again — ` +
      `no single-sided guess is made.`;
}

/**
 * The unmapped-error candidate face: exhaustive on small surfaces, ranked
 * by relevance on large ones. Ranking: location-word hits (the clause's
 * segmented place phrases, subsequence-matched like the bridge; a segment
 * that RESOLVES to a zone ranks that zone's devices) outrank type-word hits
 * (空调 → hvac …). An unrankable large surface yields an EMPTY list.
 */
function unmappedCandidateFace(
  text: string,
  devices: ReadonlyArray<WhatIfDeviceView>,
  zones?: ReadonlyArray<{ zoneId: string; name?: string }>,
): { list: readonly string[]; exhaustive: boolean; singleVocabulary?: readonly string[] } {
  const label = (device: WhatIfDeviceView): string =>
    `${device.name.length > 0 ? device.name : device.deviceId}@${device.zoneId ?? '?'}` +
    `(${device.commands.slice(0, 3).join('/')}${device.commands.length > 3 ? '/…' : ''})`;
  if (devices.length <= UNMAPPED_MAX_CANDIDATES) {
    return {
      list: devices.map(label),
      exhaustive: true,
      // T65c (R6, u3-P3-2): a SINGLE candidate face declares its FULL action
      // vocabulary (the label truncates at three) — the message then teaches
      // what the device can actually do, not just what it is called.
      ...(devices.length === 1 && devices[0] !== undefined
        ? { singleVocabulary: devices[0].commands }
        : {}),
    };
  }
  const segments = clauseLocationSegments(
    text,
    [...new Set(devices.flatMap(d => typeSynonymsOf(d.type)))],
  );
  const mentionedZones = new Set<string>();
  if (zones !== undefined) {
    for (const segment of segments) {
      for (const zoneId of resolveZoneMentionCandidates(segment, zones)) {
        mentionedZones.add(zoneId);
      }
    }
  }
  const lowerText = text.toLowerCase();
  const ranked = devices
    .map(device => {
      const nameFold = foldToken(device.name);
      const idFold = foldToken(device.deviceId);
      const zoneFold = device.zoneId !== undefined ? foldToken(device.zoneId) : '';
      let score = 0;
      if (
        segments.some(seg => [nameFold, idFold, zoneFold].some(hay => hay.length > 0 && isFoldingSubsequence(seg, hay)))
      ) score += 2;
      if (device.zoneId !== undefined && mentionedZones.has(device.zoneId)) score += 2;
      if (typeSynonymsOf(device.type).some(s => s.length > 0 && lowerText.includes(s.toLowerCase()))) score += 1;
      return { device, score };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return { list: ranked.slice(0, UNMAPPED_MAX_CANDIDATES).map(({ device }) => label(device)), exhaustive: false };
}

/**
 * Parse a natural-language what-if question into a structured scenario.
 * Deterministic rules only (zero LLM): what-if opener → duration phrase →
 * device-disable pattern → the proven prose recommendation bridge for
 * device commands → R83 zone-temperature prose (「把客厅温度调到 35 度」) →
 * "set <param> to <n> in <zone>" fallback. Returns null when the text is
 * not a what-if question at all (the caller may then treat it as a
 * different intent), or { error } when it IS one but nothing mapped.
 */
export function parseWhatIfText(
  text: string,
  devices: ReadonlyArray<WhatIfDeviceView>,
  defaults: { durationSec?: number; maxDurationSec?: number; locale?: string } = {},
  /** R49: the asking agent's own device ids — breaks same-name ties in
   * city-scale scenarios where every district owns a 「排涝智能阀 1」.
   * R83: `zones` (id + name) let zone-NAMED prose (「客厅温度调到 35 度」)
   * resolve its target — the device-name bridge cannot see zone mentions. */
  scope?: { deviceIds: ReadonlySet<string>; zones?: ReadonlyArray<{ zoneId: string; name?: string }> },
): WhatIfTextParse | { error: string } | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  // T25 (R3, u1-F2): line-initial opener OR a sentence-final zh question
  // form — the tail form gates on an intervention cue so non-interventional
  // curiosities never enter this lane (they stay null for the caller).
  const trimmed = text.trim();
  const isWhatIfOpen = WHAT_IF_OPENERS.test(text);
  const tailQuestion =
    (WHAT_IF_TAIL_QUESTION.test(trimmed) || WHAT_IF_EN_TAIL_QUESTION.test(trimmed)) &&
    whatIfTailQuestionIsInterventional(trimmed, devices);
  if (!isWhatIfOpen && !tailQuestion) return null;

  const notes: string[] = [];
  let durationSec = defaults.durationSec ?? WHAT_IF_DEFAULT_DURATION_SEC;
  // R40-B1: duration phrases clamp to the scenario's what-if quota when the
  // caller resolved one (the endpoint does) — same number the predictor
  // enforces, so the note teaches the effective budget.
  const maxDurationSec = Math.min(
    Math.max(1, Math.floor(defaults.maxDurationSec ?? WHAT_IF_MAX_DURATION_SEC)),
    WHAT_IF_ABSOLUTE_MAX_DURATION_SEC,
  );

  // 1. Duration phrase ("for 30 minutes", "for 2 hours").
  DURATION_PHRASE.lastIndex = 0;
  let durationMatch: RegExpExecArray | null;
  let sawDuration = false;
  while ((durationMatch = DURATION_PHRASE.exec(text)) !== null) {
    const amount = Number(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();
    let seconds: number;
    if (/小时/.test(unit) || unit.startsWith('h')) {
      seconds = amount * 3600;
    } else if (/分钟/.test(unit) || /^分/.test(unit) || unit.startsWith('min') || unit === 'm') {
      seconds = amount * 60;
    } else {
      seconds = amount; // seconds family: s, sec, secs, second(s), 秒
    }
    durationSec = Math.max(1, Math.min(maxDurationSec, Math.round(seconds)));
    sawDuration = true;
    notes.push(`duration phrase "${durationMatch[0].trim()}" → ${durationSec}s`);
  }
  if (!sawDuration) {
    notes.push(`no duration phrase → default ${durationSec}s`);
  }

  // 2. Strip the opener (+ trailing "I"/"we") so the bridge sees the command.
  // T25: the tail-question form has no line-initial opener — strip the
  // SENTENCE-FINAL interrogative instead, same goal (the bridge sees the
  // intervention clause only).
  let command = isWhatIfOpen
    ? text.replace(WHAT_IF_OPENERS, '').replace(/^\s*(?:i|we)\s+/i, '').trim()
    : text
        .replace(WHAT_IF_TAIL_QUESTION, '')
        .replace(WHAT_IF_EN_TAIL_QUESTION, '')
        .trim();
  // Remove the duration phrase from the command text (it is not a clause).
  DURATION_PHRASE.lastIndex = 0;
  command = command.replace(DURATION_PHRASE, ' ').replace(/\s{2,}/g, ' ').replace(/[?,，。！]+$/g, '').trim();
  // Normalize zh actuation verbs into the bridge's English command vocabulary
  // (the bridge is the single prose→actuation oracle; this is translation,
  // not a second matcher) + passive "is set to" → imperative "set to".
  command = command
    .replace(/关闭|关掉|停用/g, 'turn off')
    // R1 (u1 F3 replay): the post-noun bare 关 — 「把…空调关 30 分钟」 — is
    // the same turn-off ask, but the curated table only knew 关闭/关掉/停用,
    // so the clause fell through unmapped. 关机/关了/关上 fold in too;
    // 相/开 lookbehind guards 相关 and 开关, the no-CJK-suffix lookahead
    // guards 关键/关注-type words.
    .replace(/(?<![相开])关(?:了|机|上)?(?![\u4e00-\u9fff])/g, ' turn off ')
    .replace(/打开|开启/g, 'turn on')
    .replace(/\bis\s+(?:set|changed|made)\s+to\b/gi, 'set to');

  // 3. Device mentions (id or folded-name substring) — resolve the target.
  // R49: the disambiguating resolver (CJK-safe folding, prefix-shadow
  // drop, asking-agent scope) replaces the raw substring filter that
  // matched wrong-numbered siblings and wrong-district namesakes.
  const resolved = resolveDeviceMentions(text, devices, scope?.deviceIds);
  notes.push(...resolved.notes);
  const mentioned = resolved.picks;

  // 3b. T26 (R3, u1-F3): natural type-word references — "the AC unit in
  // building D" / "raise AC setpoint by 2 degrees" carries NO literal
  // device name (u1's campus device names are zh), so id/name matching
  // found nothing and the question died in the unmapped teaching despite
  // the type-word and zone vocabularies already existing. Converge:
  // type-word hit (AC → the bridge's hvac synonym family — ONE vocabulary,
  // typeSynonymsOf/typeSynonymHits) ∩ question zone clue (「D栋」/"building
  // D" → bldg-d-*). A single survivor (after the asking agent's own-scope
  // preference, the R49 discipline) IS the target and the parse notes
  // DECLARE the basis; the bridge budget then narrows to it so its delta /
  // command machinery parses the clause against exactly that device.
  // Several survivors → the existing disambiguation faces (the bridge's
  // own scope rules, else the unmapped teaching with ranked candidates);
  // none → the unmapped teaching unchanged. Pure on/off devices hit the
  // same gate later (the T2 equivalence error names the device's face).
  let typeZonePick: WhatIfDeviceView | undefined;
  // T69 (R8, u1-F1): adjudication bookkeeping — when the type/zone lane
  // NARROWED by zone clues but could not converge to ONE device, the clue
  // must survive into the bridge budget (below): `clueCandidates` carries the
  // clue-hit devices (the budget narrows to them — never back to the whole
  // world where the bridge's first-match collapsed onto another building);
  // `clueMissZones` carries a zone clue that hit NO device of the type (an
  // honest miss — the budget stays inside the clue zones so the bridge
  // cannot first-match across buildings either, the R1 lesson closed on the
  // bridge side too).
  let clueCandidates: WhatIfDeviceView[] | undefined;
  let clueMissZones: ReadonlySet<string> | undefined;
  if (mentioned.length === 0) {
    const lowerText = text.toLowerCase();
    const typeHits = devices.filter(device =>
      typeSynonymsOf(device.type).some(s => typeSynonymHits(lowerText, s)),
    );
    if (typeHits.length > 0) {
      // The same location scoping the bridge's own type matches use (「101」,
      // zone-id tokens, zh place phrases) — one matcher, T26.
      const locationScoped = scopeTypeCandidatesByLocation(text, typeHits);
      const zoneClues = questionZoneClues(text, devices, scope?.zones);
      const base = locationScoped.length > 0 ? locationScoped : [...typeHits];
      const clueFiltered = zoneClues.size > 0
        ? base.filter(device => device.zoneId !== undefined && zoneClues.has(device.zoneId))
        : [];
      // Precedence: the question's zone clue (building D) narrows hardest;
      // the R101 location scoping next. A named place with NO such device is
      // an honest miss — never fall back to unscoped world-wide type
      // matching (the R1 cross-building-collapse lesson).
      const candidates =
        clueFiltered.length > 0 ? clueFiltered
        : zoneClues.size > 0 ? []
        : base;
      let pick: WhatIfDeviceView | undefined;
      let viaOwnScope = false;
      // T69: an own-scope tie (>1 of the candidates are the requester's own)
      // is a DECLARED declaration-order preference, not a silent drop — the
      // real D-building butler binds two Gree ACs, and dropping the zone
      // clue there let the bridge first-match another building's unit.
      let ownTieCount = 0;
      if (candidates.length === 1) {
        pick = candidates[0];
      } else if (candidates.length > 1) {
        if (scope !== undefined) {
          const own = candidates.filter(d => scope.deviceIds.has(d.deviceId));
          if (own.length === 1) {
            pick = own[0];
            viaOwnScope = true;
          } else if (own.length > 1) {
            pick = own[0];
            viaOwnScope = true;
            ownTieCount = own.length;
          }
        }
        if (pick === undefined && zoneClues.size > 0) {
          clueCandidates = candidates;
        }
      }
      if (pick === undefined && clueCandidates === undefined && zoneClues.size > 0) {
        // Zone clue present, zero type devices inside it → honest miss; the
        // bridge budget stays inside the clue zones (no cross-building pick).
        clueMissZones = zoneClues;
      }
      if (pick !== undefined) {
        typeZonePick = pick;
        // The R98/R99 declaring note: the full candidate list rides even
        // when one device wins — a mapping the answer cannot see is a
        // mapping that cannot be checked. Labels mirror the bridge's
        // `name (deviceId)@zone` format (one candidate vocabulary).
        const label = (d: WhatIfDeviceView): string =>
          `${d.name.length > 0 ? d.name : d.deviceId} (${d.deviceId})@${d.zoneId ?? '?'}`;
        notes.push(
          candidates.length > 1
            ? `ambiguous target: type/zone words match ${candidates.map(label).join(', ')}` +
              (ownTieCount > 1
                ? ` — using the requester's own bound devices (first of ${ownTieCount})`
                : ` — using the requester's own bound device`) +
              ` (no literal name in the question; type "${pick.type}" ∪ zone clues [${[...zoneClues].join(', ') || 'none'}])`
            : `no literal device name in the question — resolved by type/zone words: type "${pick.type}" ∪ zone clues [${[...zoneClues].join(', ') || 'none'}] → ` +
              `selected ${label(pick)}` +
              (viaOwnScope ? " (the requester's own bound device)" : ''),
        );
      } else if (candidates.length > 1) {
        notes.push(
          `type/zone words match ${candidates.length} devices ` +
            `(${candidates.map(d => `${d.name.length > 0 ? d.name : d.deviceId} (${d.deviceId})@${d.zoneId ?? '?'}`).join(', ')}) — name one to disambiguate`,
        );
      }
    }
  }
  // 3c. T87 (R11, u1-F3): the honest disambiguation the type/zone lanes
  // already speak — UNIFIED across locales. When 3b narrowed to SEVERAL
  // clue-hit devices and the asking agent binds NONE of them, the parse
  // refuses HERE (naming every clue-hit candidate) instead of letting a
  // later lane single-side a device the notes just disowned: the zh
  // place-phrase twin of the EN building-D ask used to land on the first
  // clue-zone device for an outsider (a verdict about someone else's unit
  // after "name one to disambiguate" — the T69 ruling violated by lane
  // order, not by intent), and the zh type/zone twin fell through to the
  // unmapped teaching that PROMISED the very shapes that did not resolve.
  // Own convergence (1+ own candidate) and a single location-scoped
  // survivor (the R1 contract) never reach this guard: 3b already picked.
  if (typeZonePick === undefined && clueCandidates !== undefined) {
    return { error: typeZoneDisambiguationError(clueCandidates, defaults.locale) };
  }
  const parseTarget = typeZonePick !== undefined ? [typeZonePick] : mentioned;

  // 4. Disable semantics: a mentioned device + a failure/offline phrase.
  // T26: the type-word/zone pick counts as a mention — "what if the AC in
  // building D fails" must reach device_disable like a literal name does.
  if (DISABLE_PHRASE.test(text) && parseTarget.length > 0) {
    const target = parseTarget[0];
    if (parseTarget.length > 1) notes.push(`multiple devices mentioned (${parseTarget.map(d => d.deviceId).join(', ')}) — using the first`);
    return { intervention: { type: 'device_disable', target: target.deviceId }, durationSec, notes };
  }

  // 4b. State semantics: "hvac-1 stays off for 2 hours" / "hvac-1 remains on"
  //     — the intervention is the STATE, not a verb phrase the bridge knows.
  const stays = /\b(?:stays?|remains?|keep(?:s)?|is\s+left)\s+(off|on)\b/i.exec(command);
  if (stays !== null && parseTarget.length > 0) {
    return {
      intervention: {
        type: 'device_command',
        target: parseTarget[0].deviceId,
        action: stays[1].toLowerCase() === 'off' ? 'turn-off' : 'turn-on',
      },
      durationSec,
      notes,
    };
  }

  // 5. Device commands via the proven prose bridge (same matching as the
  //    delegate + NL lanes — one truth for prose → actuation). T26: when the
  //    type-word/zone lane resolved ONE target, the bridge budget narrows to
  //    it — its delta parsing then runs against exactly that device. The
  //    allowedCommands stay the WORLD-WIDE union: the prose names vocabulary
  //    ("set-temperature"), the T2 equivalence gate then maps the proposal
  //    onto the target's own face.
  //    T69 (R8, u1-F1): the budget NEVER widens back past a zone clue that
  //    the candidate stage already hit — an unresolved multi-candidate pick
  //    narrows to the clue-hit devices, and a clue that missed the type
  //    entirely keeps the budget inside the clue zones. The old fallback to
  //    the whole-world device list is how "the AC in building D" collapsed
  //    onto the M-building unit (first match across 7 devices).
  const clueZoneDeviceIds = clueMissZones === undefined
    ? undefined
    : devices.filter(d => d.zoneId !== undefined && clueMissZones.has(d.zoneId)).map(d => d.deviceId);
  const budget = {
    maxCommands: 4,
    deviceIds:
      typeZonePick !== undefined ? [typeZonePick.deviceId]
      : clueCandidates !== undefined ? clueCandidates.map(d => d.deviceId)
      : clueZoneDeviceIds !== undefined ? clueZoneDeviceIds
      : devices.map(d => d.deviceId),
    // T48 (R5, u1-F1): the canonical temperature vocabulary rides the union
    // even when NO device literally carries it — the campus faces speak
    // capability names (temperature-control), so a RELATIVE ask (「调高 2
    // 度」) had no command keyword to hit and the T2 lane below (delta →
    // setpoint offset → equivalence mapping onto the target's own face)
    // never ran. The T2 gate stays the honesty boundary: a target without
    // any temperature command still teaches its literal face.
    allowedCommands: [...new Set([...devices.flatMap(d => [...d.commands]), 'set-temperature'])],
    ...(scope !== undefined ? { scopeDeviceIds: scope.deviceIds } : {}),
  };
  const bridged = bridgeRecommendationsToActuations({
    text: command,
    budget,
    budgetDeviceOf: deviceId => {
      const device = devices.find(d => d.deviceId === deviceId);
      return device === undefined
        ? undefined
        : {
            deviceId: device.deviceId,
            name: device.name,
            type: device.type,
            // R101: zone rides the location-token scoping (「101 的空调」).
            ...(device.zoneId !== undefined ? { zoneId: device.zoneId } : {}),
            // T2 (R2, u1-F1): the current control state rides so RELATIVE
            // temperature asks ("raise the setpoint by 2 degrees" /
            // 「调高 2 度」) resolve against the device's actual setpoint
            // instead of a teaching rejection with no way forward.
            ...(device.state !== undefined ? { state: device.state } : {}),
          };
    },
  });
  if (bridged.proposals.length > 0) {
    const proposal = bridged.proposals[0];
    // T69 (R8, u1-F1): honest disambiguation at the parse face — when the
    // type/zone lane narrowed to SEVERAL clue-hit devices and the bridge
    // still matched more than one of them generically, the parse refuses to
    // single one out (a what-if verdict about device A is silently false
    // when the question named the pair). Name the candidates and teach the
    // disambiguating form; never a single-sided pick, never cross-building.
    if (typeZonePick === undefined && clueCandidates !== undefined &&
        new Set(bridged.proposals.map(p => p.deviceId)).size > 1) {
      const matched = bridged.proposals
        .map(p => clueCandidates.find(c => c.deviceId === p.deviceId))
        .filter((d): d is WhatIfDeviceView => d !== undefined);
      return { error: typeZoneDisambiguationError(matched, defaults.locale) };
    }
    // R99 (zhao-07): the bridge's disambiguation notes (full candidate list
    // + choice basis) ride the parse notes — the answer DECLARES its
    // mapping, including when the requester's bound device won the tie.
    notes.push(...bridged.notes);
    // T2 (R2, u1-F1): intersect the proposal's command with the TARGET
    // device's actual command surface. The parse budget is the WORLD-WIDE
    // command union, so prose naming a temperature ask ("setpoint +2") could
    // land `set-temperature` — a command only SOME devices carry — on a
    // device whose face speaks capability names (temperature-control /
    // cooling), and the fork's validation then 400s with internal vocabulary.
    // Fix: map the ask onto the device's own temperature-setter command
    // (temperatureCommandRank ordering — the same equivalence the
    // zone-temperature lane uses); when the device has NO equivalent, reject
    // with a teaching error that names the device's actual face (never the
    // bare internal command name as the whole answer).
    const targetView = devices.find(d => d.deviceId === proposal.deviceId);
    let action = proposal.command;
    // T2: the equivalence gate runs against the LITERAL face (rawCommands)
    // — the expanded `commands` vocabulary legitimately contains mapped
    // names the literal face would reject at fork validation.
    const face = targetView?.rawCommands ?? targetView?.commands;
    if (targetView !== undefined && face !== undefined && !face.includes(action)) {
      const equivalent = [...face]
        .map(c => ({ c, rank: temperatureCommandRank(c) }))
        .filter(e => e.rank >= 0)
        .sort((a, b) => a.rank - b.rank)[0]?.c;
      if (equivalent !== undefined) {
        notes.push(
          `device "${targetView.name.length > 0 ? targetView.name : targetView.deviceId}" does not expose ` +
            `"${proposal.command}" — mapped to its "${equivalent}" command (same temperature ask; ` +
            `its surface: ${face.join(', ')})`,
        );
        action = equivalent;
      } else {
        const who = targetView.name.length > 0 ? `${targetView.name} (${targetView.deviceId})` : targetView.deviceId;
        const zh = typeof defaults.locale === 'string' && defaults.locale.toLowerCase().startsWith('zh');
        return {
          error: zh
            ? `该设备不支持温度设定：${who}——它的命令面：${face.join('、')}。` +
              `可用的等价干预：从上述命令中选择一个，或把调温诉求指向命令面带温度命令的设备。`
            : `This device has no temperature control: ${who} — its commands: ` +
              `${face.join(', ')}. Equivalent interventions: use one of those commands, ` +
              `or aim the temperature ask at a device whose surface carries a temperature command.`,
        };
      }
    }
    const params = proposal.params as Record<string, unknown> | undefined;
    const value = params === undefined
      ? undefined
      : typeof params.targetTemperature === 'number'
        ? params.targetTemperature
        : typeof params.level === 'number'
          ? params.level
          : typeof params.value === 'number'
            ? params.value
            : undefined;
    return {
      intervention: {
        type: 'device_command',
        target: proposal.deviceId,
        action,
        ...(value !== undefined ? { value } : {}),
      },
      durationSec,
      notes,
    };
  }

  // 5c. R83 zone-temperature prose: 「把客厅温度调到 35 度」 names a ZONE
  //     (客厅), not a device — the device-name bridge above cannot see it,
  //     and env-imported devices carry CAPABILITY names
  //     (temperature-control/cooling) the bridge's keyword table does not
  //     know. Resolve the zone by name, then prefer the zone's own
  //     temperature-capable device: driving its control loop
  //     (set-temperature/temperature-control) beats a raw zone-baseline
  //     write, exactly like the English "temperature is set to 35" lane.
  //     T2 (R2, u1-F1): the RELATIVE shapes (「调高 2 度」/「降低 3 度」)
  //     join the SAME delta resolution — the zone's temperature device's
  //     current setpoint (when its state is known) offsets the delta; with
  //     no known setpoint the ask honestly falls through to the teaching
  //     error (a guessed base would fabricate a number the user never said).
  // T108 (R17, u2-F1): the subject class matches lane 5d's — display-name
  // punctuation (「·（）.」) rides, so 「<显示名> 的温度调到 26 度」 no longer
  // dies in the noun-bearing lane either.
  const zhTempSet =
    /(?:把|将)?\s*([\w一-鿿·（）.]{1,24}?)\s*的?\s*(?:温度|室温)\s*(?:(?:调|设|升|降|改)?\s*(?:到|至|为|成)\s*(-?\d+(?:\.\d+)?)\s*(?:度|℃|°)?|(调高|升高|提高|增加|调低|降低|下降|减少)\s*(-?\d+(?:\.\d+)?)\s*(?:度|℃|°)?)/
      .exec(command);
  if (zhTempSet !== null) {
    const absoluteRaw = zhTempSet[2];
    const deltaVerb = zhTempSet[3];
    const deltaAmount = zhTempSet[4] !== undefined ? Number(zhTempSet[4]) : undefined;
    const zoneId = resolveZoneMention(zhTempSet[1], scope?.zones) ?? mentioned[0]?.zoneId;
    if (zoneId !== undefined) {
      const target = pickTemperatureDevice(devices, zoneId, scope?.deviceIds);
      if (target !== undefined) {
        let value: number | undefined;
        if (absoluteRaw !== undefined) {
          value = Number(absoluteRaw);
          notes.push(
            `zone-temperature phrase "${zhTempSet[0].trim()}" → ${target.device.name} ${target.command} ${value}`,
          );
        } else if (deltaVerb !== undefined && deltaAmount !== undefined) {
          const down = /调低|降低|下降|减少/.test(deltaVerb);
          const base = currentSetpointOfState(target.device.state);
          if (base !== undefined) {
            value = down ? base - deltaAmount : base + deltaAmount;
            notes.push(
              `relative zone-temperature phrase "${zhTempSet[0].trim()}" → ${target.device.name} ` +
                `${target.command} ${value} (setpoint ${base} ${down ? '−' : '+'} ${deltaAmount})`,
            );
          } else {
            // T65b (R6, u1-F1): the refusal NAMES the root cause — the
            // relative shape parsed fine; what is missing is the device's
            // CURRENT setpoint, and the way out is the absolute form. This
            // used to fall through to the generic unmapped error, which read
            // as "the device name did not match" and sent users in circles.
            const who = target.device.name.length > 0 ? target.device.name : target.device.deviceId;
            const zh = typeof defaults.locale === 'string' && defaults.locale.toLowerCase().startsWith('zh');
            return {
              error: zh
                ? `设备「${who}」未暴露当前设定点，相对调法（${deltaVerb} ${deltaAmount} 度）无法解析——` +
                  `请改用绝对句式：调到 N 度（例如「把${zhTempSet[1]}温度调到 24 度会怎样」）。`
                : `Device "${who}" does not expose its current setpoint, so the relative ask ` +
                  `("${deltaVerb} ${deltaAmount} degrees") cannot be resolved — use the absolute form ` +
                  `instead: set to N degrees (e.g. "调到 24 度会怎样").`,
            };
          }
        }
        if (value !== undefined) {
          return {
            intervention: { type: 'device_command', target: target.device.deviceId, action: target.command, value },
            durationSec,
            notes,
          };
        }
      } else if (absoluteRaw !== undefined) {
        const value = Number(absoluteRaw);
        notes.push(`zone-temperature phrase parsed but zone "${zoneId}" has no temperature-capable device — writing the zone baseline`);
        return {
          intervention: { type: 'parameter_change', target: zoneId, action: 'temperature', value },
          durationSec,
          notes,
        };
      } else {
        notes.push(`relative zone-temperature phrase parsed but zone "${zoneId}" has no temperature-capable device to offset`);
      }
    } else {
      notes.push(`zone-temperature phrase parsed (value ${absoluteRaw ?? `${deltaVerb} ${deltaAmount}度`}) but zone "${zhTempSet[1]}" did not resolve`);
    }
  }

  // 5d. T42 (R4, u1-F2): ABSOLUTE setpoints WITHOUT the 温度 noun —
  // 「空调机组 调到 26 度」「D栋 的空调调到 26 度」「把客厅调到 26 度」.
  // The noun-bearing lane (5c) ran first and kept its behavior; this lane
  // fires when the subject is a DEVICE / TYPE / ZONE mention instead. One
  // temperature vocabulary (temperatureCommandRank, shared with 5c and the
  // T2 equivalence gate), the existing resolvers, notes declaring the
  // mapping basis — no second matcher. The error copy's suggested sentence
  // 「<分区> 的空调调到 26 度会怎样」 (UNMAPPED_WHAT_IF_EXAMPLES) parses
  // HERE: the teaching only ever promises what the parser accepts. This is
  // the LAST lane before the unmapped teaching — it can only rescue, never
  // hijack, an earlier lane's match.
  //
  // T48 (R5): the EN absolute shape joins the lane — "set the AC in
  // building D to 26 degrees". The honest device face speaks capability
  // names (temperature-control), so the bridge's set-temperature keyword
  // never sits in the allowed-command union and the EN ask used to die
  // unmapped while its zh twin sailed through 5d. Same subject resolution,
  // same degree-unit requirement (a bare "set X to 26" stays with lane 6).
  //
  // T108 (R17, u2-F1): the SUBJECT class carries the display-name
  // punctuation — 「陈功部署·格力云佳空调1.5匹（D栋2F教室） 调到 26 度会怎样」
  // died unmapped because 「·（）.」 fell outside `[\w一-鿿]`, so the run of
  // subject characters before 调到 ended at the paren while the DEVICE name
  // itself resolved fine (foldToken strips punctuation). The class now spans
  // the full display name (cap 24 — the folded subject stays a substring of
  // the device's folded name in lane (b)); digits INSIDE the subject
  // ("1.5匹/2F") stay harmless — the value group sits strictly after
  // 调到/设为….
  const zhAbsoluteSet =
    /(?:把|将)?\s*([\w一-鿿·（）.]{1,24})\s*的?\s*(?:调|设|改)(?:到|至|为|成)\s*(-?\d+(?:\.\d+)?)\s*(?:度|℃|°)/.exec(command);
  const enAbsoluteSet = zhAbsoluteSet === null
    ? /\b(?:set|adjust)\s+(?:the\s+)?([a-z][a-z0-9\s-]{0,24}?)\s+to\s+(-?\d+(?:\.\d+)?)\s*(?:°\s*[cf]?|degre(?:e|es)\b|celsius\b)/i.exec(command)
    : null;
  const absMatch = zhAbsoluteSet ?? enAbsoluteSet;
  if (absMatch !== null) {
    const subjectText = absMatch[1];
    const value = Number(absMatch[2]);
    const subjectHay = foldToken(subjectText);
    let pick: { device: WhatIfDeviceView; command: string } | undefined;
    let basis = '';
    if (typeZonePick !== undefined) {
      // (a) the 3b type/zone resolution already settled ONE device.
      pick = bestTemperatureCommandOf(typeZonePick);
      basis = `subject "${subjectText}" resolved by type/zone words (no 温度 noun)`;
    }
    if (pick === undefined && subjectHay.length > 1) {
      // (b) the subject clause names exactly ONE device on the surface.
      const subjectHits = devices.filter(
        d => foldToken(d.name).includes(subjectHay) || foldToken(d.deviceId).includes(subjectHay),
      );
      if (subjectHits.length === 1) {
        pick = bestTemperatureCommandOf(subjectHits[0]);
        basis = `subject "${subjectText}" is a literal device mention`;
      }
      // Several name-shaped hits stay UNRESOLVED — the 3b notes (when the
      // ambiguity was type/zone-shaped) or the candidate list below teach
      // the disambiguation; never a silent first pick.
    }
    if (pick === undefined) {
      // (c) a zone-phrase subject → the zone's own temperature device (the
      // 5c discipline), degrading to the zone baseline write when none.
      // T48 (R5, u1-F2): the whole subject 「D栋图书馆空调」 carries the type
      // word and interleaved official words no zone name literally contains —
      // when the whole-subject resolution misses, the subject's own LOCATION
      // segments (verbs/type words stripped, subsequence-matched) vote, and
      // every candidate zone is tried for a temperature device before the
      // baseline-write degradation fires.
      const typeWords = [...new Set(devices.flatMap(d => typeSynonymsOf(d.type)))];
      const subjectZoneCandidates: string[] = [];
      const pushCandidates = (mention: string): void => {
        for (const zoneId of resolveZoneMentionCandidates(mention, scope?.zones)) {
          if (!subjectZoneCandidates.includes(zoneId)) subjectZoneCandidates.push(zoneId);
        }
      };
      pushCandidates(subjectText);
      if (subjectZoneCandidates.length === 0) {
        for (const segment of clauseLocationSegments(subjectText, typeWords)) {
          pushCandidates(segment);
        }
      }
      const zoneId = subjectZoneCandidates[0] ?? resolveZoneMention(subjectText, scope?.zones) ?? mentioned[0]?.zoneId;
      let zoneTarget = pickTemperatureDevice(devices, zoneId ?? '', scope?.deviceIds);
      // The place phrase may span several zones of one facility (「图书馆」 →
      // every floor) — the first zone actually CARRYING a temperature device
      // wins; only a facility with none degrades to the baseline write.
      if (zoneTarget === undefined) {
        for (const candidateZone of subjectZoneCandidates.slice(1)) {
          const candidate = pickTemperatureDevice(devices, candidateZone, scope?.deviceIds);
          if (candidate !== undefined) {
            zoneTarget = candidate;
            notes.push(`place phrase matched multiple zones (${subjectZoneCandidates.join(', ')}) — using ${candidateZone}`);
            break;
          }
        }
      }
      if (zoneId !== undefined) {
        if (zoneTarget !== undefined) {
          // The command must sit on the device's LITERAL face (the face the
          // fork's validation enforces) — the same discipline as the T2
          // equivalence gate; the expanded vocabulary only selects.
          const literal = bestTemperatureCommandOf(zoneTarget.device) ?? zoneTarget;
          pick = { device: literal.device, command: literal.command };
          basis = `subject "${subjectText}" resolved to zone ${zoneId}`;
        } else {
          notes.push(
            `absolute temperature phrase "${absMatch[0].trim()}" parsed but zone "${zoneId}" has no temperature-capable device — writing the zone baseline`,
          );
          return {
            intervention: { type: 'parameter_change', target: zoneId, action: 'temperature', value },
            durationSec,
            notes,
          };
        }
      }
    }
    if (pick !== undefined) {
      notes.push(
        `absolute temperature phrase "${absMatch[0].trim()}" → ` +
          `${pick.device.name.length > 0 ? pick.device.name : pick.device.deviceId} ${pick.command} ${value} (${basis})`,
      );
      return {
        intervention: { type: 'device_command', target: pick.device.deviceId, action: pick.command, value },
        durationSec,
        notes,
      };
    }
    // Unresolved subject → fall through to the unmapped teaching with its
    // ranked candidate list (the honest disambiguation face).
  }

  // 6. Parameter fallback: "set temperature to 35 in floor-1" OR the passive
  //    "temperature set to 35 in floor-1" (normalized above) — applies when
  //    no own-device command matched (the bridge had its chance first).
  const setMatch =
    /\b(?:set|change|make)\s+(?:the\s+)?([\w-]+)\s+(?:to|at|=)\s+(-?\d+(?:\.\d+)?)/i.exec(command) ??
    /\b([\w-]+)\s+(?:set|changed|made)\s+to\s+(-?\d+(?:\.\d+)?)/i.exec(command);
  if (setMatch !== null) {
    const parameter = setMatch[1].toLowerCase();
    const value = Number(setMatch[2]);
    const zoneMatch = /\b(?:in|zone)\s+([\w-]+)/i.exec(command);
    const targetZone = zoneMatch?.[1] ?? resolveZoneMention(command, scope?.zones) ?? mentioned[0]?.zoneId;
    if (targetZone !== undefined) {
      return {
        intervention: { type: 'parameter_change', target: targetZone, action: parameter, value },
        durationSec,
        notes,
      };
    }
    notes.push(`parameter "${parameter}" parsed but no zone target found — a parameter_change needs a zone`);
  }

  // R83: name the devices HUMAN-READABLY and by RELEVANCE (the R44-F2
  // lesson), capped — a full-surface dump is not an error message (B1-3).
  const errorOf =
    typeof defaults.locale === 'string' && defaults.locale.toLowerCase().startsWith('zh')
      ? UNMAPPED_WHAT_IF_ERROR.zh
      : UNMAPPED_WHAT_IF_ERROR.en;
  const face = unmappedCandidateFace(text, devices, scope?.zones);
  const message = errorOf(face.list, face.exhaustive);
  if (face.singleVocabulary !== undefined && face.singleVocabulary.length > 0) {
    const zh = typeof defaults.locale === 'string' && defaults.locale.toLowerCase().startsWith('zh');
    return {
      error: `${message}\n${
        zh
          ? `该设备支持的动作词表：${face.singleVocabulary.join('、')}。`
          : `This device's supported action vocabulary: ${face.singleVocabulary.join(', ')}.`
      }`,
    };
  }
  return { error: message };
}

// ============================================================================
// Fork arm execution (the only IO: EngineRuntime construction + stepping)
// ============================================================================

/**
 * R1 (B1-3): unknown-TARGET errors sample the surface instead of dumping
 * it — the asker already named a target, so the flood taught nothing
 * (115 ids on the taicang campus).
 */
function knownIdsSummary(ids: readonly string[]): string {
  const shown = ids.slice(0, 5);
  return ids.length > shown.length
    ? `${shown.join(', ')} … (+${ids.length - shown.length} more — list the world's devices for the full surface)`
    : shown.join(', ');
}

/** Device-view budget face for validating device targets against the scenario. */
function deviceSurfaceOf(runtime: EngineRuntime): Map<string, { zoneId: string; commands: string[] }> {
  const surface = new Map<string, { zoneId: string; commands: string[] }>();
  for (const device of runtime.getSnapshot().devices) {
    surface.set(device.id, { zoneId: device.zoneId, commands: [...device.commands] });
  }
  return surface;
}

/**
 * Apply an intervention to a fork. Teaching errors for unknown targets
 * (fixable input, not a degraded prediction).
 */
async function applyIntervention(
  fork: EngineRuntime,
  intervention: WhatIfIntervention,
  surface: Map<string, { zoneId: string; commands: string[] }>,
): Promise<void> {
  switch (intervention.type) {
    case 'device_command': {
      const device = surface.get(intervention.target!);
      if (device === undefined) {
        throw new WhatIfValidationError(
          `intervention targets device "${intervention.target}" which does not exist in this world — ` +
            `known devices: ${knownIdsSummary([...surface.keys()])}`,
        );
      }
      // T70 (R8, u1-F2): the SAME equivalence judgment the execution filter
      // speaks (resolveCommandEquivalence — one computation). A canonical ask
      // ('set-temperature') on a capability-named face ('temperature-control')
      // verifies as the command that will actually dispatch, so the fork can
      // never call "not exposed" a command the execution lane runs.
      const action = resolveCommandEquivalence(intervention.action!, device.commands) ?? intervention.action!;
      if (!device.commands.includes(action)) {
        throw new WhatIfValidationError(
          `device "${intervention.target}" does not expose command "${intervention.action}" — its surface: ` +
            `${device.commands.join(', ')}`,
        );
      }
      const params =
        intervention.value !== undefined
          ? // R83: capability-name commands ('temperature-control', and the
            // mode verbs 'cooling'/'heating' whose handlers read the same
            // targetTemperature spelling) are temperature setters too.
            /temp/i.test(action) || /^(?:cooling|heating)$/i.test(action)
            ? { targetTemperature: intervention.value }
            : /level|bright/i.test(action)
              ? { level: intervention.value }
              : { value: intervention.value }
          : undefined;
      // R42-C gate 3: hypothetical lane — the fork is headless (all agents
      // disabled), so the managing-agent requirement of the governed lane
      // would reject commands on devices whose manager only exists in the
      // env's newer rows. A what-if actuates the device directly.
      const result = await fork.executeHypotheticalDeviceCommand(intervention.target!, action, params);
      if (result.success !== true) {
        throw new WhatIfValidationError(
          `hypothetical command "${action}" on "${intervention.target}" was rejected by the ` +
            `device lane: ${String(result.error ?? 'unknown error')}`,
        );
      }
      return;
    }
    case 'device_disable': {
      const device = surface.get(intervention.target!);
      if (device === undefined) {
        throw new WhatIfValidationError(
          `intervention targets device "${intervention.target}" which does not exist in this world — ` +
            `known devices: ${knownIdsSummary([...surface.keys()])}`,
        );
      }
      // An offline fault alone fails COMMANDS but leaves a registered physics
      // effect running (the fault seam freezes state, not output). "Disabled"
      // must stop the output too: run the device's own turn-off when its
      // surface has one (the platform's effect-unregistering lane — power
      // accounting reads exactly 0 W), THEN take it offline. Sensor-style
      // devices have no physics effects — the fault alone is their disable.
      if (device.commands.includes('turn-off')) {
        await fork.executeHypotheticalDeviceCommand(intervention.target!, 'turn-off'); // best-effort; the fault dominates
      }
      fork.setDeviceFault(intervention.target!, { offline: true });
      return;
    }
    case 'parameter_change': {
      if (!fork.getSnapshot().zones.some(zone => zone.id === intervention.target)) {
        throw new WhatIfValidationError(
          `intervention targets zone "${intervention.target}" which does not exist in this world — ` +
            `known zones: ${fork
              .getSnapshot()
              .zones.map(z => z.id)
              .join(', ')}`,
        );
      }
      // updateZoneBaseline is the documented external boundary-condition
      // channel (weather feeds, twin-sync): it re-seeds the zone's relaxation
      // attractor — exactly "what if this zone's condition were X".
      fork.updateZoneBaseline(intervention.target!, intervention.action!, intervention.value ?? 0);
      return;
    }
    case 'event_injection': {
      if (!fork.getSnapshot().zones.some(zone => zone.id === intervention.target)) {
        throw new WhatIfValidationError(
          `intervention targets zone "${intervention.target}" which does not exist in this world — ` +
            `known zones: ${fork
              .getSnapshot()
              .zones.map(z => z.id)
              .join(', ')}`,
        );
      }
      await fork.injectEvent({
        type: `${intervention.action}-injection`,
        zoneId: intervention.target!,
        parameter: intervention.action!,
        value: intervention.value ?? 0,
        severity: 'medium',
      });
      return;
    }
  }
}

/**
 * Sample every metric from a fork's public snapshot.
 *
 * R44-F3: under radius pruning, metrics WITHOUT an explicit zoneId are
 * sampled over the radius zones only (both arms share the scope, so the
 * delta stays fair and reflects exactly the affected region). Metrics WITH a
 * zoneId keep their explicit scope — a metric pinned to a remote zone reads
 * that zone's frozen-but-present state identically in both arms.
 */
function sampleMetrics(
  fork: EngineRuntime,
  metrics: WhatIfMetric[],
  zoneScope?: ReadonlySet<string>,
): Record<string, number | undefined> {
  const snapshot = fork.getSnapshot();
  const sampled: Record<string, number | undefined> = {};
  for (const metric of metrics) {
    const key = metricKeyOf(metric);
    if (ENERGY_METRIC_NAMES.has(metric.name.toLowerCase())) {
      // Absent meter key = 0 Wh (a device that never powered on has metered
      // nothing — not "unknown"); the metric is unsampleable only when the
      // scope holds no devices at all.
      let sum = 0;
      let devicesInScope = 0;
      for (const device of snapshot.devices) {
        if (metric.zoneId !== undefined && device.zoneId !== metric.zoneId) continue;
        if (metric.zoneId === undefined && zoneScope !== undefined && !zoneScope.has(device.zoneId)) continue;
        devicesInScope += 1;
        const wh = device.state['cumulativeEnergyWh'];
        if (typeof wh === 'number' && Number.isFinite(wh)) sum += wh;
      }
      sampled[key] = devicesInScope > 0 ? sum : undefined;
      continue;
    }
    if (COMFORT_METRIC_NAMES.has(metric.name.toLowerCase())) {
      const range = DEFAULT_PARAMETER_RANGES['temperature'];
      const values: number[] = [];
      for (const zone of snapshot.zones) {
        if (metric.zoneId !== undefined && zone.id !== metric.zoneId) continue;
        if (metric.zoneId === undefined && zoneScope !== undefined && !zoneScope.has(zone.id)) continue;
        const temp = zone.parameters['temperature'];
        if (typeof temp === 'number' && Number.isFinite(temp)) {
          values.push(normalizedDistanceOutsideRange(temp, range));
        }
      }
      sampled[key] = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
      continue;
    }
    // Zone parameter by name.
    const values: number[] = [];
    for (const zone of snapshot.zones) {
      if (metric.zoneId !== undefined && zone.id !== metric.zoneId) continue;
      if (metric.zoneId === undefined && zoneScope !== undefined && !zoneScope.has(zone.id)) continue;
      const raw = zone.parameters[metric.name];
      if (typeof raw === 'number' && Number.isFinite(raw)) values.push(raw);
    }
    sampled[key] = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
  }
  return sampled;
}

interface ArmRun {
  series: Record<string, number[]>;
  notes: string[];
}

/** Run ONE arm (baseline: intervention=null) and collect metric series. */
async function runArm(
  source: WhatIfWorldSource,
  metrics: WhatIfMetric[],
  durationSec: number,
  intervention: WhatIfIntervention | null,
  options: WhatIfRunOptions,
  sampleScope?: ReadonlySet<string>,
): Promise<ArmRun> {
  const notes: string[] = [];
  const series: Record<string, number[]> = {};
  for (const metric of metrics) series[metricKeyOf(metric)] = [];

  const fork = new EngineRuntime(source.scenario);
  try {
    // Exact fork: same scenario, same world state (deep-cloned per arm —
    // checkpoint exports carry shallow-copied device state; sharing them
    // between arms would let one arm's ticks mutate the other's baseline).
    fork.restoreWorldState(structuredClone(source.worldState));

    // Headless prediction: no agent participates (fast + deterministic —
    // no LLM, no AC handshake, no autonomous actuation lanes). The fork's
    // own scenario drives the loop: under radius pruning it carries only
    // the radius's agents.
    for (const agent of fork.scenario.agents) {
      fork.setAgentEnabled(agent.id, false);
    }

    // Tick arithmetic must be 1 sim-sec per step regardless of the live
    // world's compression knob (a speed-5 fork would blow past the window).
    if (fork.getSpeed() !== 1) {
      fork.start(1);
      fork.pause();
    }
    fork.setLodTier(options.lodTier ?? 'idle');

    const surface = deviceSurfaceOf(fork);
    const pushSample = (): void => {
      const sampled = sampleMetrics(fork, metrics, sampleScope);
      for (const metric of metrics) {
        const key = metricKeyOf(metric);
        const value = sampled[key];
        if (value === undefined) {
          if (series[key].length === 0) {
            notes.push(
              `metric "${key}" could not be sampled (no zone/device exposes it in this world) — skipped`,
            );
          }
          continue;
        }
        series[key].push(round3(value));
      }
    };

    pushSample(); // t0 — shared anchor, before any divergence
    if (intervention !== null) {
      await applyIntervention(fork, intervention, surface);
    }

    const sampleCap = options.sampleCap ?? 60;
    const sampleEverySec = Math.max(1, Math.ceil(durationSec / Math.max(1, sampleCap - 1)));
    let remaining = durationSec;
    let elapsed = 0;
    while (remaining > 0) {
      const chunk = Math.min(sampleEverySec, remaining);
      await fork.step(chunk);
      elapsed += chunk;
      remaining -= chunk;
      // Sample on stride multiples + always at the window's end (a window
      // that is not a stride multiple still carries its final reading).
      if (remaining <= 0 || elapsed % sampleEverySec === 0) pushSample();
    }
  } finally {
    try {
      fork.stop();
    } catch {
      // already torn down — the prediction must not fail on cleanup
    }
  }
  return { series, notes };
}

// ============================================================================
// Judgement (pure) — verdict, confidence, explanation
// ============================================================================

/**
 * Compare the two arms into a verdict. Deterministic and pure: same series →
 * same verdict/confidence/explanation (pinned by the determinism tests).
 */
export function judgeWhatIf(
  scenario: WhatIfScenario,
  baseline: Record<string, number[]>,
  intervention: Record<string, number[]>,
  forkedAtSimTimeSec: number,
  /** R98: resolve device ids to readable names inside the explanation. */
  deviceName?: (deviceId: string) => string | undefined,
): Pick<WhatIfResult, 'delta' | 'verdict' | 'confidence' | 'explanation' | 'contributions'> {
  const delta: Record<string, number> = {};
  const contributions: WhatIfContribution[] = [];
  let missing = 0;
  const sentences: string[] = [];

  for (const metric of scenario.metrics) {
    const key = metricKeyOf(metric);
    const base = last(baseline[key]);
    const int = last(intervention[key]);
    if (base === undefined || int === undefined) {
      missing += 1;
      continue;
    }
    const deltaValue = round3(int - base);
    delta[key] = deltaValue;

    let contribution = 0;
    const isEnergy = ENERGY_METRIC_NAMES.has(metric.name.toLowerCase());
    const isComfort = COMFORT_METRIC_NAMES.has(metric.name.toLowerCase());
    const range = isComfort ? DEFAULT_PARAMETER_RANGES['temperature'] : DEFAULT_PARAMETER_RANGES[metric.name.toLowerCase()];

    // T56 (R6, u1-F3): a comfort metric whose BOTH-ARM series is CONSTANT
    // carries no comfort signal in this world — the band judgment would
    // mechanically conclude "outside the [18,28] comfort band" for a
    // constant 0 (normalizedDistanceOutsideRange(0,[18,28]) = 1.8), which
    // contradicts the temperature sentence in the SAME explanation and reads
    // as data. Skip the band judgment; say there is no signal.
    const comfortSeriesConstant = (values: number[] | undefined): boolean => {
      const all = values ?? [];
      return all.length > 0 && all.every(value => value === all[0]);
    };
    if (isComfort && comfortSeriesConstant(baseline[key]) && comfortSeriesConstant(intervention[key])) {
      sentences.push(
        `${key}: no comfort signal in this world (series constant ${round3(base)}) — band judgement skipped`,
      );
      contributions.push({ key, contribution: 0, sentence: sentences[sentences.length - 1] });
      continue;
    }

    if (isEnergy) {
      // More consumed energy = worse (kWh scale, §5.2-weighted).
      contribution = (deltaValue / 1000) * OBJECTIVE_WEIGHTS.energy;
      const avgKw = round3((deltaValue / (scenario.durationSec / 3600)) / 1000);
      sentences.push(
        `${key}: ${deltaValue >= 0 ? '+' : ''}${round3(deltaValue / 1000)} kWh ` +
          `(${avgKw >= 0 ? '+' : ''}${avgKw} kW average vs baseline)`,
      );
    } else if (range !== undefined) {
      // Comfort band semantics (the situation assessor's single oracle):
      // drifting OUTSIDE the band is worse, pulling inside is better.
      const baseOutside = normalizedDistanceOutsideRange(base, range);
      const intOutside = normalizedDistanceOutsideRange(int, range);
      contribution = (intOutside - baseOutside) * OBJECTIVE_WEIGHTS.comfort;
      const unit = metric.name.toLowerCase() === 'temperature' ? '°C' : '';
      // T42 (R4, u1-F5): the comfort metric's [18,28] band is the comfort
      // PROXY's scale, not a temperature reading — label it "comfort band"
      // and never a degree unit, so a 0.0 comfort delta is not misread as
      // "0 °C" against a temperature range.
      const bandLabel = isComfort ? 'comfort band' : 'expected range';
      sentences.push(
        `${key}: ${deltaValue >= 0 ? '+' : ''}${deltaValue}${unit} → ${round3(int)} ` +
          `(${bandLabel} ${range.min}–${range.max}${unit}, currently ${intOutside > 0 ? 'outside' : 'inside'} it)`,
      );
    } else {
      sentences.push(`${key}: ${deltaValue >= 0 ? '+' : ''}${deltaValue} → ${round3(int)}`);
    }

    // Threshold semantics: a worse-direction breach the baseline did not
    // have counts one extra degradation unit; a repaired breach improves.
    if (metric.threshold !== undefined && Number.isFinite(metric.threshold)) {
      const center = range !== undefined ? (range.min + range.max) / 2 : metric.threshold;
      const worseUp = thresholdWorseDirection(metric.threshold, center) === 'up';
      const breachedWorse = worseUp ? int > metric.threshold : int < metric.threshold;
      const baselineHadIt = worseUp ? base > metric.threshold : base < metric.threshold;
      if (breachedWorse && !baselineHadIt) {
        contribution += 1;
        sentences[sentences.length - 1] += ` — CROSSES threshold ${metric.threshold}`;
      } else if (!breachedWorse && baselineHadIt) {
        contribution -= 1;
        sentences[sentences.length - 1] += ` — returns below threshold ${metric.threshold}`;
      }
    }

    contributions.push({ key, contribution: round3(contribution), sentence: sentences[sentences.length - 1] });
  }

  const total = contributions.reduce((sum, c) => sum + c.contribution, 0);

  // D2-F4 honesty / R98: every delta EXACTLY zero means the intervention
  // moved NO measured metric. That is either a genuinely inert action, or
  // the actuator's physics not feeding the measured metrics, or (the R98
  // zhao-05 case) the simulated target not being the device the user meant
  // — "turn off the AC" simulated on a colleague's already-off AC. An
  // affirmative 'neutral' there was a confidently wrong answer; the honest
  // verdict is 'inconclusive' with the possible causes named.
  const allZero = contributions.length > 0
    && Object.values(delta).every(value => value === 0);
  const verdict: WhatIfVerdict = allZero
    ? 'inconclusive'
    : total > 0.1 ? 'degradation' : total < -0.1 ? 'improvement' : 'neutral';

  let confidence = 0.9 - missing * 0.15;
  if (verdict === 'neutral' && contributions.every(c => Math.abs(c.contribution) < 0.01)) {
    confidence -= 0.05; // flat everywhere — the window may be too short to matter
  }
  if (allZero) {
    confidence -= 0.3; // zero movement cannot support a confident verdict
  }
  confidence = Math.min(0.95, Math.max(0.3, round3(confidence)));

  // T56 (R6, u4-F4): a NEUTRAL verdict still explains itself — name the
  // dominant contribution so "neutral" never reads as "ruled neutral with no
  // reason" (an energy nudge inside the neutral band used to be silent).
  let neutralNote = '';
  if (verdict === 'neutral' && !allZero && contributions.length > 0) {
    const dominant = [...contributions].sort(
      (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution),
    )[0];
    if (dominant !== undefined && Math.abs(dominant.contribution) >= 0.02) {
      neutralNote =
        `The dominant term is ${dominant.key} (${dominant.contribution >= 0 ? '+' : ''}${dominant.contribution}) — ` +
        'inside the neutral band (|total| ≤ 0.1), so the verdict stays neutral. ';
    }
  }

  const explanation =
    `Simulated ${scenario.durationSec}s from sim-time ${forkedAtSimTimeSec} with and without: ` +
    `${describeIntervention(scenario.intervention, deviceName)}. ` +
    (sentences.length > 0 ? sentences.join('; ') + '. ' : 'No measurable metric deltas. ') +
    (allZero
      ? // T27 (R3, u1-F4): the caveat must name the ZERO's real candidate
        // causes concretely — the physics chain itself is fixture-tested
        // (HVAC↔zone coupling), so an all-zero verdict is an honesty problem
        // about STATE or WINDOW, not about broken physics. Never leave the
        // reader with just "may already be in the target state".
        `CAVEAT: the intervention moved NO measured metric (all deltas are exactly 0 over the ` +
        `${scenario.durationSec}s window) — the verdict cannot be assessed (low signal). Likely causes, ` +
        `in checking order: (1) the device was already in the requested state — for a setpoint ask, ` +
        `the requested value may sit inside the current control dead-band; (2) the window is too short ` +
        `for the zone's thermal inertia to register (${scenario.durationSec}s may be within the dead-band ` +
        `of this HVAC loop — try a longer lookahead); (3) the simulated target is not the device you ` +
        `meant — the simulated target is named above, verify it against the world you are watching ` +
        `(the fork source is reported in forkSource/simTimeSec); (4) the device's physics is not wired ` +
        `into the measured metrics. `
      : neutralNote) +
    `Verdict: ${verdict} (confidence ${confidence}).`;

  return { delta, verdict, confidence, explanation, contributions };
}

// ============================================================================
// Public runner
// ============================================================================

/**
 * Run a what-if prediction: two headless forks of the CURRENT world, one
 * carrying the intervention, stepped in lockstep, compared. Deterministic:
 * the same (source, scenario) pair yields bit-identical results. Read-only
 * with respect to the source runtime — the export is a snapshot.
 *
 * R40-B1: the source scenario's `meta.whatIfQuota.maxDurationSec` is the
 * effective lookahead cap here (absent = WHAT_IF_MAX_DURATION_SEC) — the
 * fork source IS the scenario, so no separate quota plumbing is needed.
 */
export async function runWhatIf(
  source: WhatIfWorldSource,
  whatIf: WhatIfScenario,
  options: WhatIfRunOptions = {},
): Promise<WhatIfResult> {
  const scenario = normalizeWhatIfScenario(whatIf, {
    maxDurationSec: whatIfMaxDurationSecOf(source.scenario),
  });
  const forkedAtSimTimeSec = source.worldState.simTimeSec;

  // R44-F3: the radius decision is made ONCE, from (source, intervention)
  // only — never from arm identity — so baseline and intervention fork the
  // IDENTICAL subworld. Differently pruned arms would make the delta
  // meaningless (hard fairness constraint).
  const { forkSource, sampleScope, pruned } = resolveForkSource(
    source,
    scenario.intervention,
    options,
  );

  const [baselineArm, interventionArm] = await Promise.all([
    runArm(forkSource, scenario.metrics, scenario.durationSec, null, options, sampleScope),
    runArm(forkSource, scenario.metrics, scenario.durationSec, scenario.intervention, options, sampleScope),
  ]);

  const notes = [...baselineArm.notes, ...interventionArm.notes];
  // R98: the explanation names devices readably (zhao-05 — a bare UUID hid
  // WHICH device was simulated).
  const deviceNameOf = (deviceId: string): string | undefined =>
    source.scenario.devices.find(d => d.id === deviceId)?.name;
  const judged = judgeWhatIf(scenario, baselineArm.series, interventionArm.series, forkedAtSimTimeSec, deviceNameOf);

  return {
    scenario,
    baseline: baselineArm.series,
    intervention: interventionArm.series,
    delta: judged.delta,
    verdict: judged.verdict,
    confidence: judged.confidence,
    explanation: judged.explanation,
    contributions: judged.contributions,
    notes: [
      ...(pruned
        ? [
            `radius pruning (R44-F3): fork advanced only the affected zone neighborhood ` +
              `(${[...sampleScope!].join(', ')}) — ${forkSource.scenario.devices.length}/` +
              `${source.scenario.devices.length} devices; both arms share the identical pruning, ` +
              `so the delta reflects exactly the affected region`,
          ]
        : []),
      ...new Set(notes),
    ],
    forkedAtSimTimeSec,
  };
}
