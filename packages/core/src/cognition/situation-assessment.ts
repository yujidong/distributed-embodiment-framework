/**
 * L2 Cognition — Situation Assessment, RULES lane (§4.1, Phase 2).
 *
 * Pre-LLM classification of the current situation from the world model
 * alone — fast, free, deterministic. Four situations with decision meaning
 * (§4.1): normal → maintain; anomaly → causal analysis + low-cost
 * intervention; emergency → safety-first reordering + fast lane;
 * opportunity → opportunistic goal push (the agent can create value, not
 * only fight fires).
 *
 * This is the RULE prior, not the verdict: it feeds the LLM prompt as
 * `SITUATION: {type, severity}` so the model does not have to re-derive the
 * situation from raw data (single-truth: the runtime-side cluster
 * `significance` and this assessment are priors the model refines — it can
 * disagree, and the structured answer wins).
 *
 * Expected ranges: v1 ships documented defaults (below). Scenario zone
 * baselines can override per-parameter via `ranges` — the function never
 * invents thresholds at runtime.
 */

import type { AgentWorldModel } from './world-model.js';

// ============================================================================
// Types
// ============================================================================

export type SituationType = 'normal' | 'anomaly' | 'emergency' | 'opportunity';

export interface SituationAssessment {
  type: SituationType;
  /** 1 (negligible) … 5 (critical) — §11 situation_assessment.severity. */
  severity: 1 | 2 | 3 | 4 | 5;
  /** Zones carrying anomalies (or the comfort zones, for opportunity). */
  affectedZones: string[];
  /** Audit trail: WHY this classification (bounded, rendered into the prompt). */
  reasons: string[];
}

export interface ParameterRange {
  min: number;
  max: number;
}

// ============================================================================
// Range tables (v1 defaults; overridable per call)
// ============================================================================

/**
 * Default expected (comfort) ranges for the standard physical parameters.
 * Scenario baselines can override any entry via `assessSituation(…, ranges)`.
 */
export const DEFAULT_PARAMETER_RANGES: Readonly<Record<string, ParameterRange>> = {
  temperature: { min: 18, max: 28 },
  humidity: { min: 30, max: 70 },
  co2: { min: 350, max: 1000 },
  pm2_5: { min: 0, max: 75 },
  illuminance: { min: 0, max: 1000 },
  occupancy: { min: 0, max: 50 },
};

/**
 * Hard SAFETY bounds — breaching one is an emergency by itself (§4.1
 * "safety threshold breached"), independent of how many comfort anomalies
 * exist.
 */
export const SAFETY_PARAMETER_BOUNDS: Readonly<Record<string, ParameterRange>> = {
  temperature: { min: 2, max: 40 },
  co2: { min: 0, max: 5000 },
  pm2_5: { min: 0, max: 250 },
};

/** Boolean parameters whose TRUE value is a safety condition. */
export const SAFETY_BOOLEAN_PARAMETERS = new Set(['smoke', 'fire', 'gas-leak', 'gas_leak', 'emergency']);

/** Event types that are safety conditions outright (emergency). */
const SAFETY_EVENT_PATTERN = /fire|smoke|gas-?leak|evacuat|explos|toxic|hazmat|emergency/i;

/** Event types that indicate anomalies (but not safety emergencies). */
const ALARM_EVENT_PATTERN =
  /spike|breach|alarm|failure|fault|outage|leak|critical|danger|overheat|unsafe|high/i;

/** Device state keys read for fault detection (case-insensitive). */
const DEVICE_FAULT_STATES = new Set(['offline', 'error', 'fault', 'faulted', 'failure']);

/** Max reasons rendered (bounded audit trail). */
const SITUATION_REASONS_CAP = 8;

// ============================================================================
// Assessment
// ============================================================================

interface Anomaly {
  zoneId?: string;
  severity: 2 | 3 | 4 | 5;
  reason: string;
}

/**
 * Classify the situation from a world model (pure, deterministic). Rule
 * order (safety-first): safety events / safety bounds / safety booleans →
 * emergency; ≥2 compounding anomalies (2+ zones, or 2+ parameters in one
 * zone) → emergency; any single anomaly → anomaly; else comfort-band slack
 * with active actuators → opportunity; else normal.
 */
export function assessSituation(
  worldModel: AgentWorldModel,
  ranges: Readonly<Record<string, ParameterRange>> = DEFAULT_PARAMETER_RANGES,
  safetyBounds: Readonly<Record<string, ParameterRange>> = SAFETY_PARAMETER_BOUNDS,
): SituationAssessment {
  const anomalies: Anomaly[] = [];
  const anomalyZones = new Set<string>();

  // --- Events: safety events and alarm events ------------------------------
  for (const event of worldModel.recentEvents) {
    if (SAFETY_EVENT_PATTERN.test(event.type)) {
      anomalies.push({
        zoneId: event.zoneId,
        severity: 5,
        reason: `safety event ${event.type}${event.zoneId !== undefined ? ` in ${event.zoneId}` : ''}`,
      });
      if (event.zoneId !== undefined) anomalyZones.add(event.zoneId);
    } else if (ALARM_EVENT_PATTERN.test(event.type)) {
      anomalies.push({
        zoneId: event.zoneId,
        severity: 3,
        reason: `alarm event ${event.type}${event.zoneId !== undefined ? ` in ${event.zoneId}` : ''}`,
      });
      if (event.zoneId !== undefined) anomalyZones.add(event.zoneId);
    }
  }

  // --- Zone parameters: comfort-range anomalies + safety-bound breaches ----
  for (const zone of worldModel.zones) {
    let zoneParamAnomalies = 0;
    for (const [param, raw] of Object.entries(zone.parameters)) {
      const key = param.toLowerCase();
      if (typeof raw === 'boolean') {
        if (raw && SAFETY_BOOLEAN_PARAMETERS.has(key)) {
          anomalies.push({ zoneId: zone.zoneId, severity: 5, reason: `${zone.zoneId}.${param}=true (safety condition)` });
          anomalyZones.add(zone.zoneId);
          zoneParamAnomalies++;
        }
        continue;
      }
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;

      const safety = safetyBounds[key];
      if (safety !== undefined && (raw < safety.min || raw > safety.max)) {
        anomalies.push({
          zoneId: zone.zoneId,
          severity: 5,
          reason: `${zone.zoneId}.${param}=${raw} breaches safety bound [${safety.min}, ${safety.max}]`,
        });
        anomalyZones.add(zone.zoneId);
        zoneParamAnomalies++;
        continue;
      }

      const range = ranges[key];
      if (range !== undefined && (raw < range.min || raw > range.max)) {
        anomalies.push({
          zoneId: zone.zoneId,
          severity: 3,
          reason: `${zone.zoneId}.${param}=${raw} outside expected [${range.min}, ${range.max}]`,
        });
        anomalyZones.add(zone.zoneId);
        zoneParamAnomalies++;
      }
    }
    if (zoneParamAnomalies >= 2) {
      // Compounding within one zone: two parameters out at once escalates.
      anomalies.push({
        zoneId: zone.zoneId,
        severity: 4,
        reason: `${zone.zoneId}: ${zoneParamAnomalies} parameters out of range simultaneously`,
      });
    }
  }

  // --- Devices: faults (offline/error/fault states) ------------------------
  for (const device of worldModel.devices) {
    for (const [key, value] of Object.entries(device.state)) {
      // Any state key whose value IS a fault state — covers the common
      // `{status:'offline'}`, `{health:'error'}` and bespoke fault keys
      // uniformly (value-driven, no key-name guessing).
      if (typeof value === 'string' && DEVICE_FAULT_STATES.has(value.toLowerCase())) {
        anomalies.push({ zoneId: device.zoneId, severity: 2, reason: `device ${device.deviceId} ${key}=${value}` });
        if (device.zoneId !== 'unknown') anomalyZones.add(device.zoneId);
        break;
      }
    }
  }

  // --- Classification (safety-first order) ---------------------------------
  if (anomalies.length > 0) {
    const hasSafety = anomalies.some(a => a.severity >= 5);
    const distinctZones = anomalyZones.size;
    const compounding = distinctZones >= 2 || anomalies.some(a => a.severity >= 4);
    const severity = (hasSafety ? 5 : compounding ? 4 : Math.max(...anomalies.map(a => a.severity))) as 1 | 2 | 3 | 4 | 5;
    return {
      type: hasSafety || compounding ? 'emergency' : 'anomaly',
      severity,
      affectedZones: [...anomalyZones],
      reasons: anomalies.map(a => a.reason).slice(0, SITUATION_REASONS_CAP),
    };
  }

  // --- Opportunity: comfort slack + active actuators ------------------------
  const comfortZones = worldModel.zones
    .filter(zone => inInnerComfortBand(zone.parameters, ranges))
    .map(zone => zone.zoneId);
  const hasActiveActuator = worldModel.devices.some(device =>
    device.commands.length > 0 && isActive(device.state));
  if (comfortZones.length > 0 && hasActiveActuator) {
    return {
      type: 'opportunity',
      severity: 1,
      affectedZones: comfortZones,
      reasons: [
        `${comfortZones.length} zone(s) inside the comfort band while actuators run — optimization window (e.g. relax setpoints / shed load)`,
      ],
    };
  }

  return { type: 'normal', severity: 1, affectedZones: [], reasons: [] };
}

/** True when every monitored numeric parameter sits in the MIDDLE half of its range. */
function inInnerComfortBand(
  parameters: Record<string, number | boolean>,
  ranges: Readonly<Record<string, ParameterRange>>,
): boolean {
  let monitored = 0;
  for (const [param, raw] of Object.entries(parameters)) {
    const range = ranges[param.toLowerCase()];
    if (range === undefined || typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    monitored++;
    const width = (range.max - range.min) / 4;
    if (raw < range.min + width || raw > range.max - width) return false;
  }
  return monitored > 0;
}

/** True when a device state suggests the actuator is currently driving something. */
function isActive(state: Record<string, unknown>): boolean {
  const power = state['power'] ?? state['on'];
  if (power === true || power === 'on' || power === 1) return true;
  const status = state['status'];
  if (status === 'active' || status === 'running' || status === 'on' || status === 'cooling' || status === 'heating') return true;
  const mode = state['mode'];
  return typeof mode === 'string' && mode.length > 0 && mode !== 'off' && mode !== 'idle' && mode !== 'standby';
}
