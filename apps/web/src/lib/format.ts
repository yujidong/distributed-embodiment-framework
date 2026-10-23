/**
 * Formatting helpers for live snapshot values.
 *
 * Physical parameters arrive as `number | boolean`; device state is an open
 * record. All rendering is defensive: unknown keys are still shown, values
 * are coerced to short display strings.
 */

/** Display units for well-known physical parameters (unitless otherwise). */
const PARAMETER_UNITS: Record<string, string> = {
  temperature: '°C',
  humidity: '%',
  light: ' lux',
  co2: ' ppm',
};

/** Device-state keys that are bookkeeping rather than physical state. */
const INTERNAL_STATE_KEYS = new Set(['zoneId', 'cumulativeEnergyWh']);

/** Format one physical parameter as a short `label value unit` string. */
export function formatParameter(key: string, value: number | boolean): string {
  const unit = PARAMETER_UNITS[key] ?? '';
  if (typeof value === 'boolean') {
    return `${key}: ${value ? 'on' : 'off'}`;
  }
  return `${key}: ${value.toFixed(1)}${unit}`;
}

/** Cumulative device energy: Wh below 1 kWh, kWh (2dp) above; '--' when absent. */
export function formatEnergyWh(wh: number | null | undefined): string {
  if (typeof wh !== 'number' || !Number.isFinite(wh)) return '--';
  if (Math.abs(wh) < 1000) return `${Math.round(wh)} Wh`;
  return `${(wh / 1000).toFixed(2)} kWh`;
}

/** Format a single device-state value (number 1dp, boolean ON/OFF, else stringified). */
export function formatStateValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') {
    if (key === 'power') return value ? 'ON' : 'OFF';
    return `${key}: ${value ? 'on' : 'off'}`;
  }
  if (typeof value === 'number') {
    return `${key}: ${Number.isInteger(value) ? value : value.toFixed(1)}`;
  }
  if (typeof value === 'string') return `${key}: ${value}`;
  return `${key}: ${JSON.stringify(value)}`;
}

/**
 * Compact device-state summary lines (max `maxLines`), most interesting keys
 * first (power/mode before the rest, insertion order otherwise).
 */
export function summarizeDeviceState(
  state: Record<string, unknown> | undefined,
  maxLines = 3,
): string[] {
  if (!state) return [];
  const entries = Object.entries(state).filter(([key]) => !INTERNAL_STATE_KEYS.has(key));
  entries.sort(([a], [b]) => priority(a) - priority(b));
  return entries.slice(0, maxLines).map(([key, value]) => formatStateValue(key, value));
}

/** All device-state entries as formatted lines (for the full device table). */
export function fullDeviceState(state: Record<string, unknown> | undefined): string {
  if (!state) return '';
  return Object.entries(state)
    .filter(([key]) => !INTERNAL_STATE_KEYS.has(key))
    .map(([key, value]) => formatStateValue(key, value))
    .join('  ');
}

function priority(key: string): number {
  if (key === 'power') return 0;
  if (key === 'mode') return 1;
  if (key === 'status') return 9;
  return 5;
}
