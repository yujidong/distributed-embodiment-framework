/**
 * Device Control Loops
 *
 * Control POLICY for simulated devices — the device layer's half of the
 * feedback loop. The physics layer owns the field (per-location state,
 * propagation, relaxation); a device only:
 *   1. SENSES the field at its own location (via the public read API), and
 *   2. DECIDES whether its own registered physics effect is enabled.
 *
 * No field math lives here, and the physics layer knows nothing about
 * thermostats, targets, or hysteresis.
 *
 * Policies (thresholds documented per requirement):
 *   - hvac / ac / air-conditioner — thermostat hysteresis of ±0.5 °C.
 *     Cooling: run until target−0.5 °C, stop; restart at target+0.5 °C.
 *     Heating is symmetric (run until target+0.5 °C, restart at target−0.5 °C).
 *     The operating direction comes from the registered effect's sign,
 *     falling back to the device mode / target-vs-current comparison.
 *   - humidifier — stop at target humidity, restart at target−2 %.
 *   - dehumidifier — stop at target humidity, restart at target+2 %.
 *   - air-purifier — run until PM2.5 ≤ 12 µg/m³ (US EPA "good" 24-h
 *     threshold), then idle; restart at ≥ 20 µg/m³.
 *
 * A device without a control target (no targetTemperature / targetHumidity,
 * or powered off) is left exactly as-is: its effect keeps whatever state
 * the last command gave it.
 */

import { PhysicalParameter } from './types.js';

/** Thermostat dead-band around the target (°C). */
export const THERMOSTAT_HYSTERESIS_C = 0.5;
/** Humidifier/dehumidifier dead-band (%). */
export const HUMIDITY_HYSTERESIS_PCT = 2;
/** Air purifier thresholds (µg/m³): idle below, restart above. */
export const PURIFIER_PM25_STOP = 12;
export const PURIFIER_PM25_RESTART = 20;

/**
 * A device's view of the world for control purposes. Provided by the
 * device itself; policies never touch physics internals directly.
 */
export interface DeviceControlView {
  /** Semantic device type (e.g. 'hvac'). */
  readonly type: string;
  /** Read a key from the device's own state. */
  getStateValue(key: string): unknown;
  /** Sample the field at the device's own location (public read API). */
  readLocal(parameter: PhysicalParameter): number | undefined;
  /** Magnitude of the device's own registered effect, if any. */
  getEffectMagnitude(parameter: PhysicalParameter): number | undefined;
  /** Enable/disable the device's own registered effect. */
  setEffectEnabled(parameter: PhysicalParameter, enabled: boolean): void;
  /**
   * T-106 (F-PH02b): the OTHER thermostat-intending HVAC units in this
   * zone (their target/capacity/direction as published this tick).
   * Absent on devices without zone visibility — the policy then behaves
   * exactly as before (single-unit thermostat).
   */
  zoneHvacPeers?: () => readonly ZoneThermostatPeer[];
}

/**
 * T-106 (F-PH02b): one HVAC unit's published thermostat intent in a zone.
 */
export interface ZoneThermostatPeer {
  targetTemperature: number;
  /** Thermal capacity in W (rated/class default when not declared). */
  capacityW: number;
  heating: boolean;
}

/**
 * T-106 (F-PH02b): capacity-weighted zone setpoint / explicit contention
 * semantics for multiple thermostats in ONE zone.
 *
 * Before: each unit cycled blindly against its own target — two units with
 * different setpoints fought through the field and the zone drifted to an
 * unweighted average (F-PH02b).
 *
 * Semantics (pure, deterministic):
 *   1. Net direction = the side (heating vs cooling) with the larger total
 *      capacity. A tie keeps the unit's own direction.
 *   2. The zone's EFFECTIVE setpoint is the capacity-weighted average of
 *      the targets of the units ALIGNED with the net direction — a 3 kW
 *      unit at 18 °C plus a 1 kW unit at 24 °C settles at 19.5 °C, not 21.
 *   3. A unit OPPOSING the net direction yields (its thermostat disables
 *      the effect) — majority thermal capacity wins the zone, explicitly,
 *      instead of both compressors burning against each other forever.
 */
export function effectiveZoneSetpointC(
  self: ZoneThermostatPeer,
  peers: readonly ZoneThermostatPeer[] = [],
): { targetC: number; heating: boolean; yields: boolean } {
  if (peers.length === 0) {
    return { targetC: self.targetTemperature, heating: self.heating, yields: false };
  }

  const all = [self, ...peers];
  const heatingCapacity = all.filter(p => p.heating).reduce((sum, p) => sum + p.capacityW, 0);
  const coolingCapacity = all.filter(p => !p.heating).reduce((sum, p) => sum + p.capacityW, 0);
  // Tie → self's direction wins (no majority either way).
  const netHeating = heatingCapacity === coolingCapacity ? self.heating : heatingCapacity > coolingCapacity;

  if (self.heating !== netHeating) {
    // Opposing the majority capacity: this unit yields. Its own target is
    // irrelevant to the report — the aligned units define the zone.
    const aligned = all.filter(p => p.heating === netHeating);
    return {
      targetC: weightedTarget(aligned),
      heating: netHeating,
      yields: true,
    };
  }

  const aligned = all.filter(p => p.heating === netHeating);
  return {
    targetC: weightedTarget(aligned),
    heating: netHeating,
    yields: false,
  };
}

/** Capacity-weighted target over the given units (≥1 by construction). */
function weightedTarget(units: readonly ZoneThermostatPeer[]): number {
  const totalCapacity = units.reduce((sum, p) => sum + p.capacityW, 0);
  if (totalCapacity <= 0) return units[0]!.targetTemperature;
  return units.reduce((sum, p) => sum + p.capacityW * p.targetTemperature, 0) / totalCapacity;
}

/**
 * Run the device's control policy for one physics tick. Device types
 * without a policy, and devices without control targets, are no-ops.
 */
export function applyDeviceControlLoop(view: DeviceControlView): void {
  switch (view.type.toLowerCase()) {
    case 'hvac':
    case 'ac':
    case 'air-conditioner':
    case 'hvac-controller':
      applyThermostatLoop(view);
      break;
    case 'humidifier':
      applyHumidifierLoop(view);
      break;
    case 'dehumidifier':
      applyDehumidifierLoop(view);
      break;
    case 'air-purifier':
      applyAirPurifierLoop(view);
      break;
    default:
      // No control policy for this device type — behaves exactly as before.
      break;
  }
}

/**
 * Thermostat hysteresis: cycle the thermal effect around the target.
 * Requires power on and a numeric target; otherwise the device is manual.
 */
function applyThermostatLoop(view: DeviceControlView): void {
  if (view.getStateValue('power') !== true) return;

  const targetRaw = view.getStateValue('targetTemperature') ?? view.getStateValue('targetTemp');
  if (typeof targetRaw !== 'number') return; // no control target → manual device

  const current = view.readLocal(PhysicalParameter.TEMPERATURE);
  if (current === undefined) return;

  // Operating direction: the registered effect's sign is authoritative
  // (it was chosen at command time from the sensed temperature). Fallback:
  // explicit mode, then target-vs-current comparison.
  const magnitude = view.getEffectMagnitude(PhysicalParameter.TEMPERATURE);
  // No effect registered → nothing to cycle. (The device layer rebuilds a
  // lost effect before this policy runs — Fix-15, F-24.)
  if (magnitude === undefined) return;
  const mode = view.getStateValue('mode');
  const heating = magnitude > 0 ||
    (magnitude === 0 && (mode === 'heating' || (mode !== 'cooling' && targetRaw > current)));

  // T-106 (F-PH02b): with sibling thermostats in the zone, the unit cycles
  // around the capacity-weighted EFFECTIVE setpoint and yields when it
  // opposes the majority capacity.
  let target = targetRaw;
  let yields = false;
  if (view.zoneHvacPeers !== undefined) {
    const peers = view.zoneHvacPeers();
    if (peers.length > 0) {
      const effective = effectiveZoneSetpointC(
        { targetTemperature: targetRaw, capacityW: Math.abs(magnitude), heating },
        peers,
      );
      target = effective.targetC;
      yields = effective.yields;
    }
  }
  if (yields) {
    view.setEffectEnabled(PhysicalParameter.TEMPERATURE, false);
    return;
  }

  const h = THERMOSTAT_HYSTERESIS_C;
  if (heating) {
    // Heat until target+h, restart at target−h.
    if (current >= target + h) {
      view.setEffectEnabled(PhysicalParameter.TEMPERATURE, false);
    } else if (current <= target - h) {
      view.setEffectEnabled(PhysicalParameter.TEMPERATURE, true);
    }
  } else {
    // Cool until target−h, restart at target+h.
    if (current <= target - h) {
      view.setEffectEnabled(PhysicalParameter.TEMPERATURE, false);
    } else if (current >= target + h) {
      view.setEffectEnabled(PhysicalParameter.TEMPERATURE, true);
    }
  }
}

/** Humidifier: stop at target, restart at target−hysteresis. */
function applyHumidifierLoop(view: DeviceControlView): void {
  if (view.getStateValue('power') !== true) return;

  const targetRaw = view.getStateValue('targetHumidity');
  if (typeof targetRaw !== 'number') return;

  const current = view.readLocal(PhysicalParameter.HUMIDITY);
  if (current === undefined) return;
  if (view.getEffectMagnitude(PhysicalParameter.HUMIDITY) === undefined) return;

  if (current >= targetRaw) {
    view.setEffectEnabled(PhysicalParameter.HUMIDITY, false);
  } else if (current <= targetRaw - HUMIDITY_HYSTERESIS_PCT) {
    view.setEffectEnabled(PhysicalParameter.HUMIDITY, true);
  }
}

/** Dehumidifier: stop at target, restart at target+hysteresis. */
function applyDehumidifierLoop(view: DeviceControlView): void {
  if (view.getStateValue('power') !== true) return;

  const targetRaw = view.getStateValue('targetHumidity');
  if (typeof targetRaw !== 'number') return;

  const current = view.readLocal(PhysicalParameter.HUMIDITY);
  if (current === undefined) return;
  if (view.getEffectMagnitude(PhysicalParameter.HUMIDITY) === undefined) return;

  if (current <= targetRaw) {
    view.setEffectEnabled(PhysicalParameter.HUMIDITY, false);
  } else if (current >= targetRaw + HUMIDITY_HYSTERESIS_PCT) {
    view.setEffectEnabled(PhysicalParameter.HUMIDITY, true);
  }
}

/** Air purifier: run until PM2.5 is below the "good air" threshold, then idle. */
function applyAirPurifierLoop(view: DeviceControlView): void {
  if (view.getStateValue('power') !== true) return;

  const current = view.readLocal(PhysicalParameter.PM25);
  if (current === undefined) return;
  if (view.getEffectMagnitude(PhysicalParameter.PM25) === undefined) return;

  if (current <= PURIFIER_PM25_STOP) {
    view.setEffectEnabled(PhysicalParameter.PM25, false);
  } else if (current >= PURIFIER_PM25_RESTART) {
    view.setEffectEnabled(PhysicalParameter.PM25, true);
  }
}
