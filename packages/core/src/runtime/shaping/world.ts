/**
 * World physics — zone geometry, baselines, defaults, RNG, fault normalization, effect checks — pure shaping (L2), see docs/architecture-runtime.md
 *
 * Deterministic, no engine state, no I/O. Types come from ../contract.js.
 */
import type { FaultProfile } from '../contract.js';
import type { ScenarioMeta } from '../../scenario/scenario-types.js';
import type { LocalizedText } from '@active-collaboration/shared';
import { localizedText } from '@active-collaboration/shared';import { EventPriority, EventType, type SystemEvent } from '../../events/index.js';import type {  EngineSnapshot,} from '../contract.js';/** JSON-serializable engine state snapshot (for a future frontend). */
/**
 * Fix-42a: manual `step(n)` yields to the host event loop every N ticks so a
 * long step degrades to "slow" instead of starving every other task in the
 * process (API/WebSocket traffic interleaves between tick chunks).
 */
export const STEP_YIELD_EVERY = 5;// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

/** Physical parameters included in per-zone snapshots. */
export const SNAPSHOT_PARAMETERS = ['temperature', 'humidity', 'light', 'motion', 'smoke', 'co2', 'pm2_5', 'power'];/**
 * NFR-2: outdoor baseline auto-drive. Computes what the outdoor temperature
 * SHOULD be at the current sim time (daily + seasonal sinusoid, matching the
 * DailyCycleModel in the simulation package), so the outdoor boundary
 * condition evolves naturally instead of sitting at a static baseline.
 * Called per tick; cheap (one Math.sin per call).
 */
export function autoOutdoorTemperature(simTimeSec: number, seasonalAmplitude: number = 12): number {
  const DAY_SEC = 86400;
  const YEAR_SEC = DAY_SEC * 365;
  const base = 18;
  const dailyAmp = 5;
  const dailyPhase = ((simTimeSec % DAY_SEC) / DAY_SEC - 14 / 24) * 2 * Math.PI;
  const seasonalPhase = ((simTimeSec % YEAR_SEC) / YEAR_SEC - 0.5) * 2 * Math.PI;
  return base
    + dailyAmp * Math.cos(dailyPhase)              // daily cycle, peak 14:00
    + seasonalAmplitude * Math.sin(seasonalPhase + Math.PI / 2); // seasonal, peak July
}
/**
 * T-704 (DevLoop R29, F-PH13): PV daylight factor — sinusoidal, zero at
 * night. Sunrise 06:00, sunset 18:00, peak 1.0 at solar noon (12:00) in
 * sim-local time (sim time IS local, matching autoOutdoorTemperature's
 * phase convention). A zone declaring PV capacity as `baseline.pvOutputW`
 * produces `capacity × factor` each tick: 02:17 local → factor 0 (≤5% of
 * rated; was a static 8800 W around the clock), noon ≈ rated.
 */
export function pvDaylightFactor(simTimeSec: number): number {
  const hour = ((simTimeSec % 86400) + 86400) % 86400 / 3600;
  return Math.max(0, Math.sin((Math.PI * (hour - 6)) / 12));
}

/**
 * R30 extraction (from EngineRuntime.advanceTickBy — identical writes, same
 * order): drive the per-tick ENVIRONMENT baselines.
 *   - NFR-2: outdoor zones without an explicit temperature baseline ride the
 *     seasonal + daily sinusoid (autoOutdoorTemperature);
 *   - T-704: zones declaring `baseline.pvOutputW` capacity produce
 *     `capacity × pvDaylightFactor`.
 * The write callback absorbs per-zone write faults (zones without bounds);
 * it must never throw upward.
 */
export function driveEnvironmentBaselines(
  zones: ReadonlyArray<{
    id: string;
    type?: string;
    baseline?: Record<string, number | boolean>;
  }>,
  simTimeSec: number,
  writeBaseline: (parameter: string, zoneId: string, value: number) => void,
): void {
  const outdoorZones = zones.filter(
    z => z.type === 'outdoor' && z.baseline?.temperature === undefined,
  );
  if (outdoorZones.length > 0) {
    const outdoorTemp = autoOutdoorTemperature(simTimeSec);
    for (const zone of outdoorZones) {
      writeBaseline('temperature', zone.id, outdoorTemp);
    }
  }
  for (const zone of zones) {
    const peak = zone.baseline?.pvOutputW;
    if (typeof peak === 'number' && peak > 0) {
      writeBaseline('pvOutputW', zone.id, peak * pvDaylightFactor(simTimeSec));
    }
  }
}

/**
 * FEAT-03: scenario-declared custom-parameter field dynamics (`meta.
 * parameterPhysics`) + device coupling (`meta.parameterEffects`) — pure
 * pass-through into the PhysicalEnvironment config. Loader-validated
 * upstream (custom keys only, coupling targets declared); absent keys stay
 * absent so the legacy config object shape is preserved bit-for-bit.
 */
export function parameterPhysicsConfig(meta: ScenarioMeta): {
  parameterPhysics?: ScenarioMeta['parameterPhysics'];
  parameterEffects?: ScenarioMeta['parameterEffects'];
} {
  return {
    ...(meta.parameterPhysics !== undefined ? { parameterPhysics: meta.parameterPhysics } : {}),
    ...(meta.parameterEffects !== undefined ? { parameterEffects: meta.parameterEffects } : {}),
  };
}/** Cap on the recent-decisions ring buffer embedded in snapshots. */
export const MAX_RECENT_DECISIONS = 50;/**
 * Default (parameter, value) for well-known event types, mirroring the
 * experiment runner's event mapping. Unknown types fall back to
 * `{ parameter: <type>, value: true }`.
 */
export const EVENT_TYPE_DEFAULTS: Record<string, { parameter: string; value: number | boolean }> = {
  // R98: bare physical-type events (no -spike/-anomaly suffix, no declared
  // value) get the same sensible magnitudes as their suffixed siblings —
  // the generic `?? true` fallback used to write boolean TRUE into numeric
  // parameters (1 °C "noon heat" freezing a whole building, chen-03).
  'temperature': { parameter: 'temperature', value: 32 },
  'air-quality': { parameter: 'co2', value: 1500 },
  'power': { parameter: 'power', value: 1000 },
  'smoke': { parameter: 'smoke', value: true },
  'temperature-spike': { parameter: 'temperature', value: 32 },
  'temperature-rise': { parameter: 'temperature', value: 30 },
  'temperature-anomaly': { parameter: 'temperature', value: 32 },
  'temperature-drop': { parameter: 'temperature', value: 15 },
  'temperature-normal': { parameter: 'temperature', value: 22 },
  'humidity-spike': { parameter: 'humidity', value: 85 },
  'humidity-anomaly': { parameter: 'humidity', value: 88 },
  'humidity-normal': { parameter: 'humidity', value: 45 },
  'motion-detected': { parameter: 'motion', value: true },
  'presence-detected': { parameter: 'motion', value: true },
  'intrusion-detected': { parameter: 'motion', value: true },
  // R98: a bare 'occupancy' event (no declared value) means "someone
  // arrived" — default to one person rather than falling through to the
  // generic `true` fallback, which the occupancy headcount guard rejects
  // (previously: fired:true, zero world change, error swallowed by the
  // scheduler). Authors should declare explicit headcounts for crowds.
  'occupancy': { parameter: 'occupancy', value: 1 },
  'smoke-detected': { parameter: 'smoke', value: true },
  'fire-detected': { parameter: 'smoke', value: true },
  'lighting-needed': { parameter: 'light', value: 300 },
  // T-103 (F-PH21): a power-outage event's physical write is the zone's grid
  // feed going to 0 (what ACTriggerMonitor's 'trigger-power-outage-detected'
  // rule watches). The DEVICE envelope (unpowered/frozen/gradual-restore) is
  // driven by the runtime on top of this parameter write.
  'power-outage': { parameter: 'grid_power', value: 0 },
  'grid-power-loss': { parameter: 'grid_power', value: 0 },
  // R93：能耗削峰线（evt-energy-price-peak）——写入 power 参数，
  // flow condition（power >= threshold）从此可以解析触发
  'power-peak': { parameter: 'power', value: 1000 },
  'power-price-surge': { parameter: 'power', value: 1000 },
};

/**
 * R98: parameters with NUMERIC event semantics (the standard physical
 * quantities). A boolean value resolved for one of these is always a
 * misdeclaration (typically the `?? true` fallback for an event declared
 * without a value) — injectEvent rejects it with a teaching error instead
 * of writing `true` as 1 (°C/ppm/…) into the world. Custom flag parameters
 * (unknown names — an event type doubling as a boolean flag) and the
 * motion/smoke flags keep their boolean semantics.
 */
export const NUMERIC_EVENT_PARAMETERS: ReadonlySet<string> = new Set([
  'temperature', 'humidity', 'light', 'co2', 'pm2_5', 'power', 'occupancy',
]);

/**
 * R99: boolean FIELD flags (stored 1/0 in the spatial field, with relaxation
 * back to the background). On bounds-less zones these must take the
 * per-zone field write like numeric parameters — the legacy global write
 * pinned the flag for every zone forever (chen-08: a night smoke event left
 * the whole building, outdoor plaza included, at smoke=1 for 64 sim-days).
 * Custom flag parameters (unknown names) are NOT here: they keep the legacy
 * static store semantics.
 */
export const BOOLEAN_FIELD_FLAGS: ReadonlySet<string> = new Set(['motion', 'smoke']);export function severityToPriority(severity?: string): EventPriority {
  switch (severity) {
    case 'critical': return EventPriority.URGENT;
    case 'high': return EventPriority.HIGH;
    case 'low': return EventPriority.LOW;
    default: return EventPriority.NORMAL;
  }
}/**
 * Resolve a `humanNarrative` input (plain string or `{zh, en}` object) into
 * the wire-DTO shape consumed by `eventLog.ts`: `humanNarrative` carries the
 * zh side (or the legacy plain string), `humanNarrativeEn` carries the en
 * side. The web consumer reads `p.humanNarrative ?? p.humanNarrativeEn`.
 *
 * Phase 4 will swap this for a pass-through of the `{zh, en}` object once the
 * web's `eventLog.ts` calls `localizedText()` directly.
 */
export function resolveHumanNarrative(
  value: LocalizedText | string | undefined,
): { humanNarrative?: string; humanNarrativeEn?: string } {
  if (value === undefined) return {};
  if (typeof value === 'string') return value === '' ? {} : { humanNarrative: value };
  const zh = value.zh?.trim();
  const en = value.en?.trim();
  return {
    ...(zh ? { humanNarrative: zh } : {}),
    ...(en ? { humanNarrativeEn: en } : {}),
  };
}/**
 * mulberry32 — small deterministic PRNG for reproducible fault injection.
 * Returns a function producing uniform numbers in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}/**
 * Validate a caller-supplied fault profile and return a normalized copy
 * (only defined fields kept). Throws on out-of-range values.
 */
export function normalizeFaultProfile(profile: FaultProfile, deviceId: string): FaultProfile {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    throw new Error(`normalizeFaultProfile: profile for "${deviceId}" must be an object`);
  }
  const normalized: FaultProfile = {};
  if (profile.offline !== undefined) {
    if (typeof profile.offline !== 'boolean') {
      throw new Error(`normalizeFaultProfile: offline for "${deviceId}" must be a boolean`);
    }
    normalized.offline = profile.offline;
  }
  if (profile.failureRate !== undefined) {
    if (
      typeof profile.failureRate !== 'number' || !Number.isFinite(profile.failureRate) ||
      profile.failureRate < 0 || profile.failureRate > 1
    ) {
      throw new Error(
        `normalizeFaultProfile: failureRate for "${deviceId}" must be a number in [0, 1], ` +
        `got ${JSON.stringify(profile.failureRate)}`,
      );
    }
    normalized.failureRate = profile.failureRate;
  }
  if (profile.latencyMs !== undefined) {
    if (
      typeof profile.latencyMs !== 'number' || !Number.isFinite(profile.latencyMs) ||
      profile.latencyMs < 0
    ) {
      throw new Error(
        `normalizeFaultProfile: latencyMs for "${deviceId}" must be a number >= 0, ` +
        `got ${JSON.stringify(profile.latencyMs)}`,
      );
    }
    normalized.latencyMs = profile.latencyMs;
  }
  if (profile.staleState !== undefined) {
    if (typeof profile.staleState !== 'boolean') {
      throw new Error(`normalizeFaultProfile: staleState for "${deviceId}" must be a boolean`);
    }
    normalized.staleState = profile.staleState;
  }
  return normalized;
}/**
 * Default floor-to-floor height (m) when the scenario meta omits
 * `storeyHeight` (building tier, B-A).
 */
export const DEFAULT_STOREY_HEIGHT_M = 3.5;/**
 * Building tier (B-B) occupancy model defaults: per-person sensible heat
 * (W) and CO2 emission rate (ppm/s at the zone center). Scenario meta
 * (`occupancyHeatW` / `occupancyCo2Rate`) overrides them.
 */
export const DEFAULT_OCCUPANCY_HEAT_W = 75;export const DEFAULT_OCCUPANCY_CO2_RATE_PPM_S = 0.03;/**
 * Center of a zone's bounds, or undefined when the zone has no bounds.
 * Zones with bounds get spatially-real behavior (localized writes, per-zone
 * field sampling); zones without bounds keep legacy global behavior.
 *
 * Building tier (B-A): the center carries `z = floor × storeyHeight`
 * (floorless zones → z = 0, i.e. legacy behavior). The physics field only
 * uses x/y for same-floor distance; z documents the storey elevation and
 * keeps 3D consumers (device placement) consistent.
 */
export function zoneCenter(
  zone: {
    bounds?: { minX: number; maxX: number; minY: number; maxY: number };
    floor?: number;
  },
  storeyHeight: number = DEFAULT_STOREY_HEIGHT_M,
): { x: number; y: number; z: number } | undefined {
  if (!zone.bounds) return undefined;
  return {
    x: (zone.bounds.minX + zone.bounds.maxX) / 2,
    y: (zone.bounds.minY + zone.bounds.maxY) / 2,
    z: (zone.floor ?? 0) * storeyHeight,
  };
}/**
 * Radius of a localized write for a zone: half the bounds diagonal, so the
 * write covers the zone without immediately flooding neighboring zones.
 *
 * T-708 (DevLoop R29, F-PH09): airborne pollutants that the field DIFFUSES
 * (pm2_5, smoke, co2) are written as POINT writes (radius 0) — the
 * disturbance must spread gradually through diffusion, not land
 * simultaneously in every neighbor as a frozen one-shot step (measured:
 * a lab-b PM150 injection jumped the cleanroom 2→6.696 in one tick and
 * froze there for 12+ min). All other parameters keep the radius write.
 */
export function zoneWriteRadius(
  zone: { bounds?: { minX: number; maxX: number; minY: number; maxY: number } },
  parameter?: string,
): number {
  if (parameter !== undefined && DIFFUSING_POLLUTANT_PARAMETERS.has(parameter)) return 0;
  if (!zone.bounds) return 0;
  const width = zone.bounds.maxX - zone.bounds.minX;
  const height = zone.bounds.maxY - zone.bounds.minY;
  return Math.sqrt(width * width + height * height) / 2;
}

/** Field-diffused pollutant parameters — injections are point writes (T-708). */
const DIFFUSING_POLLUTANT_PARAMETERS = new Set(['pm2_5', 'smoke', 'co2']);/** One pending before/after temperature recheck (Fix-12). */
export interface EffectCheck {
  agentId: string;
  deviceId: string;
  zoneId: string;
  commandName: string;
  direction: 'up' | 'down';
  before: number;
  dueSimSec: number;
  capabilities: string[];
}/**
 * Fix-12 eligibility + direction resolution for a temperature-class command.
 * Direction: 'cool' in the name → down, 'heat' → up; setpoint-style commands
 * take the target from params and compare against the before value. Returns
 * null when there is nothing honest to verify.
 */
export function resolveEffectCheck(input: {
  commandName?: unknown;
  params?: unknown;
  before: number | boolean | undefined;
  deviceCapabilities: string[];
}): { direction: 'up' | 'down'; capabilities: string[] } | null {
  if (typeof input.commandName !== 'string') return null;
  const lower = input.commandName.toLowerCase();
  if (!/(cool|heat|temperature)/.test(lower)) return null;
  if (typeof input.before !== 'number') return null;

  let direction: 'up' | 'down' | undefined;
  if (lower.includes('cool')) {
    direction = 'down';
  } else if (lower.includes('heat')) {
    direction = 'up';
  } else {
    const params = input.params as Record<string, unknown> | undefined;
    const target = [params?.targetTemperature, params?.temperature, params?.setpoint, params?.value]
      .find((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (target === undefined || target === input.before) return null;
    direction = target > input.before ? 'up' : 'down';
  }

  const capabilities = input.deviceCapabilities.filter(c => /(cool|heat|temperature)/i.test(c));
  if (capabilities.length === 0) return null;
  return { direction, capabilities };
}/** Did the commanded effect actually happen within the window? (Fix-12) */
export function isEffectEffective(
  check: Pick<EffectCheck, 'direction' | 'before'>,
  after: number,
  epsilonC = 0.05,
): boolean {
  return check.direction === 'down'
    ? after < check.before - epsilonC
    : after > check.before + epsilonC;
}/** Per-zone physics registration metadata (building tier B-A/B-B). */
export function zonePhysicsRegistration(
  zone: {
    floor?: number;
    adjacentZoneIds?: string[];
    type?: string;
    envelopeU?: number;
    glassAreaM2?: number;
    ambientBuffer?: number;
    bounds?: { minX: number; maxX: number; minY: number; maxY: number };
  },
  storeyHeight: number,
): {
  floor: number;
  adjacentZoneIds: string[] | undefined;
  outdoor: boolean;
  envelopeU?: number;
  glassAreaM2?: number;
  ambientBuffer?: number;
  volumeM3?: number;
} {
  // RC-5 calibration: zone air volume → per-zone thermal mass (2D floor area
  // × storeyHeight; replaces the global constant for bounded zones).
  const volumeM3 = zone.bounds
    ? (zone.bounds.maxX - zone.bounds.minX) *
      (zone.bounds.maxY - zone.bounds.minY) *
      storeyHeight
    : undefined;
  return {
    floor: zone.floor ?? 0,
    adjacentZoneIds: zone.adjacentZoneIds,
    // B-B: outdoor zones are infinite boundaries.
    outdoor: zone.type === 'outdoor',
    ...(zone.envelopeU !== undefined ? { envelopeU: zone.envelopeU } : {}),
    // T-105 (F-PH05): solar aperture + interior ambient buffer pass through.
    ...(zone.glassAreaM2 !== undefined ? { glassAreaM2: zone.glassAreaM2 } : {}),
    ...(zone.ambientBuffer !== undefined ? { ambientBuffer: zone.ambientBuffer } : {}),
    ...(volumeM3 !== undefined ? { volumeM3 } : {}),
  };
}