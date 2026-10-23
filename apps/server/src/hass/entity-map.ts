/**
 * entity-map — HA entity → engine device semantics
 *
 * Two pure mapping layers, shared by HADevice (runtime adapter) and the
 * /api/hass/entities preview:
 *
 * 1. `mapHassEntity(entityId, attributes)` → `{ deviceType, capabilities }`.
 *    The HA domain drives control capabilities; a sensor's `device_class`
 *    attribute refines monitoring capabilities. Unknown domains/classes fall
 *    back to `<domain>-monitoring` (documented fallback — the entity stays
 *    visible/readable, it just offers no control verbs).
 *
 * 2. `makeCommandMapper(domain)` → engine semantic command → HA service call.
 *    The mapper is an ALLOWLIST: commands outside the table map to `null`,
 *    and HADevice turns that into `success:false` — nothing unmapped ever
 *    reaches HA (the real safety gates are P3b; this is the P3a floor).
 */

/** Engine-facing semantics derived from one HA entity. */
export interface HassEntityMapping {
  /** Engine device type (the HA domain, e.g. 'climate', 'light'). */
  deviceType: string;
  /** Engine capability names (e.g. 'temperature-control'). */
  capabilities: string[];
}

/** A Home Assistant call_service invocation (target added by the caller). */
export interface HassServiceCall {
  domain: string;
  service: string;
  service_data?: Record<string, unknown>;
}

/**
 * Maps an engine command to an HA service call, or returns null when the
 * command is not supported for this entity's domain.
 */
export type HassCommandMapper = (
  commandName: string,
  params?: Record<string, unknown>,
) => HassServiceCall | null;

// ---------------------------------------------------------------------------
// Domain / device_class → capabilities
// ---------------------------------------------------------------------------

/** Control domains: capability set is fixed per domain. */
const CONTROL_DOMAIN_CAPABILITIES: Record<string, string[]> = {
  climate: ['temperature-control', 'cooling', 'heating', 'temperature-monitoring'],
  light: ['lighting-control', 'brightness-control'],
  switch: ['power-control'],
  'smart-plug': ['power-control'],
  smart_plug: ['power-control'],
  fan: ['ventilation'],
  humidifier: ['humidity-control'],
  cover: ['curtain-control'],
};

/** sensor/binary_sensor `device_class` → monitoring capability. */
const DEVICE_CLASS_CAPABILITIES: Record<string, string> = {
  temperature: 'temperature-monitoring',
  humidity: 'humidity-monitoring',
  pm25: 'pm25-monitoring',
  co2: 'co2-monitoring',
  illuminance: 'light-monitoring',
  motion: 'motion-detection',
  smoke: 'smoke-detection',
  energy: 'energy-monitoring',
  power: 'energy-monitoring',
  // binary_sensor contact classes
  door: 'contact-monitoring',
  window: 'contact-monitoring',
  opening: 'contact-monitoring',
};

/**
 * Derive engine device semantics from an HA entity id + attributes.
 * `attributes.device_class` refines sensor-ish domains; everything unknown
 * falls back to `<domain>-monitoring`.
 */
export function mapHassEntity(
  entityId: string,
  attributes: Record<string, unknown> = {},
): HassEntityMapping {
  const domain = domainOf(entityId);

  const control = CONTROL_DOMAIN_CAPABILITIES[domain];
  if (control) {
    return { deviceType: domain, capabilities: [...control] };
  }

  if (domain === 'sensor' || domain === 'binary_sensor') {
    const deviceClass = typeof attributes.device_class === 'string'
      ? attributes.device_class
      : undefined;
    const capability = deviceClass ? DEVICE_CLASS_CAPABILITIES[deviceClass] : undefined;
    return {
      deviceType: domain,
      capabilities: [capability ?? `${domain}-monitoring`],
    };
  }

  // Documented fallback: unknown domains stay readable, nothing more.
  return { deviceType: domain, capabilities: [`${domain}-monitoring`] };
}

// ---------------------------------------------------------------------------
// Suggested device capabilities (Fix-18, R7 F-02)
// ---------------------------------------------------------------------------

/**
 * Control-verb capabilities per HA domain, in the vocabulary the platform's
 * command derivation (simulation capability-contract) recognizes — every
 * verb here maps to a registered command handler AND to an HA service call
 * via the domain's command mapper above. `mapHassEntity` capabilities alone
 * are semantic class names (e.g. 'lighting-control'); a device created with
 * only those ends up with `commands: []` (uncontrollable).
 */
const SUGGESTED_COMMAND_CAPABILITIES: Record<string, string[]> = {
  climate: ['set-temperature', 'set-mode'],
  light: ['set-brightness'],
  cover: ['set-curtain'],
  humidifier: ['set-humidity'],
  fan: ['set-fan-speed'],
};

/**
 * The capability list to COPY when creating a platform device backed by this
 * entity: the semantic capabilities from `mapHassEntity` plus the control
 * verbs the entity's domain actually supports (universal on/off + the
 * domain verbs). Declaring these yields a device whose `commands` are all
 * executable end to end (platform handler → HA service call).
 */
export function suggestedCapabilitiesFor(
  entityId: string,
  attributes: Record<string, unknown> = {},
): string[] {
  const { capabilities } = mapHassEntity(entityId, attributes);
  const domain = domainOf(entityId);
  const isControlDomain = CONTROL_DOMAIN_CAPABILITIES[domain] !== undefined;
  const verbs = isControlDomain
    ? ['turn-on', 'turn-off', ...(SUGGESTED_COMMAND_CAPABILITIES[domain] ?? [])]
    : [];
  return [...new Set([...capabilities, ...verbs])];
}

// ---------------------------------------------------------------------------
// Semantic command → HA service call
// ---------------------------------------------------------------------------

/**
 * Build the command mapper for one entity domain. Pure and total: every
 * input yields a service call or `null` (never throws).
 */
export function makeCommandMapper(domain: string): HassCommandMapper {
  return (commandName, params) => {
    // Normalize 'turnOn' / 'turn_on' → 'turn-on'.
    const command = commandName
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/_/g, '-');

    // Universal on/off/toggle verbs, valid for every controllable domain.
    if (command === 'turn-on') return { domain, service: 'turn_on' };
    if (command === 'turn-off') return { domain, service: 'turn_off' };
    if (command === 'toggle') return { domain, service: 'toggle' };

    switch (domain) {
      case 'climate': {
        if (command === 'set-temperature') {
          const temperature = numericParam(params, ['targetTemperature', 'temperature', 'target', 'value']);
          return temperature === undefined
            ? null
            : { domain, service: 'set_temperature', service_data: { temperature } };
        }
        if (command === 'set-hvac-mode' || command === 'set-mode') {
          const mode = stringParam(params, ['mode', 'hvacMode', 'value']);
          return mode === undefined
            ? null
            : { domain, service: 'set_hvac_mode', service_data: { hvac_mode: mode } };
        }
        return null;
      }

      case 'light': {
        if (command === 'set-brightness') {
          const pct = percentParam(params, ['brightnessPct', 'brightness_pct', 'brightness', 'value']);
          return pct === undefined
            ? null
            : { domain, service: 'turn_on', service_data: { brightness_pct: pct } };
        }
        return null;
      }

      case 'cover': {
        if (command === 'set-curtain' || command === 'set-cover-position' || command === 'set-position') {
          const position = percentParam(params, ['position', 'value', 'percentage']);
          return position === undefined
            ? null
            : { domain, service: 'set_cover_position', service_data: { position } };
        }
        if (command === 'open-curtain' || command === 'open') return { domain, service: 'open_cover' };
        if (command === 'close-curtain' || command === 'close') return { domain, service: 'close_cover' };
        if (command === 'stop-curtain' || command === 'stop') return { domain, service: 'stop_cover' };
        return null;
      }

      case 'humidifier': {
        if (command === 'set-humidity') {
          const humidity = numericParam(params, ['humidity', 'targetHumidity', 'value']);
          return humidity === undefined
            ? null
            : { domain, service: 'set_humidity', service_data: { humidity } };
        }
        return null;
      }

      case 'fan': {
        if (command === 'set-speed' || command === 'set-fan-speed') {
          const percentage = percentParam(params, ['percentage', 'speed', 'value']);
          return percentage === undefined
            ? null
            : { domain, service: 'set_percentage', service_data: { percentage } };
        }
        if (command === 'oscillate') return { domain, service: 'oscillate' };
        return null;
      }

      default:
        // switch/smart-plug and every other domain: on/off/toggle only.
        return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Entity id → domain (`light.living_room` → `light`). */
export function domainOf(entityId: string): string {
  const dot = entityId.indexOf('.');
  return dot === -1 ? entityId : entityId.slice(0, dot);
}

/** First defined numeric param among `names` (numeric strings accepted). */
function numericParam(params: Record<string, unknown> | undefined, names: string[]): number | undefined {
  for (const name of names) {
    const value = params?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

/** First defined non-empty string param among `names`. */
function stringParam(params: Record<string, unknown> | undefined, names: string[]): string | undefined {
  for (const name of names) {
    const value = params?.[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Percentage-style param: 0–1 fractions scale to 0–100, 0–255 values scale
 * from the 8-bit convention, everything else clamps into 0–100.
 */
function percentParam(params: Record<string, unknown> | undefined, names: string[]): number | undefined {
  const raw = numericParam(params, names);
  if (raw === undefined) return undefined;
  if (raw >= 0 && raw <= 1) return Math.round(raw * 100);
  if (raw > 100 && raw <= 255) return Math.round((raw / 255) * 100);
  return Math.min(100, Math.max(0, Math.round(raw)));
}
