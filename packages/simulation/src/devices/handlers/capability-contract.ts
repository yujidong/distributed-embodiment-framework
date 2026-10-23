/**
 * Capability → Command Contract (single source of truth)
 *
 * "Declared = executable": a capability a device declares must either
 * dispatch to a registered command handler or be a legitimate read/query
 * capability. This module derives that contract from the live
 * CommandHandlerRegistry — no separate static command list anywhere.
 *
 * Consumers:
 * - SimulatedDevice.getExecutableCommands() (per-device, with capability
 *   type metadata)
 * - apps/server environment device details (capability name strings only)
 * - the contract scan test (every template/scenario capability must pass)
 */

import {
  executableCommandPath,
  isReadOnlyCapabilityName,
  type ScenarioDevice,
} from '@active-collaboration/core';

import {
  CommandHandlerRegistry,
  registeredCustomCommandHandlers,
} from './CommandHandlerRegistry.js';
import { GenericSetCommandHandler, GENERIC_SET_PARAM_NAMES } from './GenericSetCommandHandler.js';

/**
 * Read/query capability classification — re-exported from core's SINGLE
 * shared predicate (capabilities/read-only.ts, BUG-04: the four historical
 * copies — this oracle, capabilityNameToDeviceCapability,
 * SimulatedDevice.isReadOnlyCommand, isSensorStyleCapability — drifted on
 * the `detect-` verb prefix; all four now read the same source).
 * Such capabilities are "executable" as queries: they legitimately cause no
 * state change. Exported for the T-056 parity sweep (the sweep must know
 * which oracle-true names are query-class rather than handler-backed).
 */
export { isReadOnlyCapabilityName };

/** Shared registry instance for capability-name lookups (handlers are stateless). */
let contractRegistry: CommandHandlerRegistry | undefined;

function getContractRegistry(): CommandHandlerRegistry {
  if (!contractRegistry) {
    contractRegistry = new CommandHandlerRegistry('capability-contract', 'generic');
  }
  return contractRegistry;
}

// ---------------------------------------------------------------------------
// Capability display names (Fix-46, B-agent P2-2)
// ---------------------------------------------------------------------------

/**
 * Chinese display names for well-known capabilities. Derived services are
 * named `<device>: <capability>` — without this table every derived service
 * on a bilingual campus world carries an English capability fragment, and
 * `q=温度` finds nothing (the search tokenizer is Chinese-aware but the
 * CONTENT it indexes is English). Keys are matched exactly after
 * normalization (lowercase, `-`/`_` stripped); unknown capabilities fall
 * back to the raw name.
 */
const CAPABILITY_DISPLAY_ZH: Record<string, string> = {
  'temperature-control': '温度控制',
  'temperature-reading': '温度读数',
  'temperature-monitoring': '温度监测',
  cooling: '制冷',
  heating: '制热',
  'turn-on': '开启',
  'turn-off': '关闭',
  // T-043: honest label for derived services whose backing device can only
  // switch power (every executable route resolves to turn-on/turn-off).
  switching: '开关控制',
  'set-mode': '模式设置',
  'set-temperature': '温度设定',
  'set-brightness': '亮度调节',
  'set-fan-speed': '风速调节',
  'set-humidity': '湿度调节',
  'set-spray-pattern': '喷淋模式设置',
  'lighting-control': '照明控制',
  'brightness-control': '亮度控制',
  'humidity-reading': '湿度读数',
  'humidity-monitoring': '湿度监测',
  'air-quality': '空气质量',
  'motion-detection': '人体感应',
  'energy-monitoring': '用能监测',
  'power-monitoring': '电力监测',
  ventilation: '通风',
  'demand-response': '需求响应',
  'demand-response-aggregation': '需求响应聚合',
  'emergency-coordination': '应急联动',
  'fleet-dispatch-service': '运力调度',
  'emergency-logistics-service': '应急投送',
  'orderly-charging-service': '有序充电',
  'micromobility-service': '短驳运力',
  'weather-forecast': '天气预测',
};

/**
 * The Chinese display name for a capability, or the raw name when unknown
 * (Fix-46). Used by derived-service naming so the service catalog is
 * searchable in Chinese.
 */
export function capabilityDisplayName(capabilityName: string): string {
  const normalized = capabilityName.toLowerCase();
  const stripped = normalized.replace(/[-_]/g, '');
  // Try exact then stripped (turn-on → turnon) matches.
  return CAPABILITY_DISPLAY_ZH[normalized] ?? CAPABILITY_DISPLAY_ZH[stripped] ?? capabilityName;
}

/**
 * Check whether a declared capability name is executable: it dispatches to a
 * registered command handler, or it is a read/query capability.
 *
 * T-056 (oracle-vs-dispatch parity): a handler registered at RUNTIME on any
 * CommandHandlerRegistry instance is visible HERE too (shared module-level
 * source) — registering a handler and gaining oracle coverage are the same
 * act, so validation (flow authoring, derived services, invoke gates) can
 * never disagree with what the device dispatch actually executes.
 */
export function isCapabilityExecutable(capabilityName: string): boolean {
  if (isReadOnlyCapabilityName(capabilityName)) return true;
  if (getContractRegistry().getHandler(capabilityName) !== undefined) return true;
  return registeredCustomCommandHandlers().some(handler => {
    try {
      return handler.canHandle(capabilityName);
    } catch {
      return false; // a throwing custom handler must not break validation
    }
  });
}

/**
 * Derive the executable command list for a set of declared capability names.
 * Order is preserved; the result is the user-facing "commands this device
 * accepts" list.
 */
export function executableCommandsForCapabilities(capabilityNames: string[]): string[] {
  return capabilityNames.filter(isCapabilityExecutable);
}

/**
 * T-074 (R22, NW-F05): the HONEST executability surface of one device —
 * the concrete command names the platform's dispatch will execute for its
 * declared capabilities, computed by the SAME oracle that backs flow
 * validation and agreement-invoke gates (core's executableCommandPath with
 * this module's isCapabilityExecutable): the handler-backed capability
 * names themselves, the device-type SEMANTIC mappings ('environment' →
 * turn-on on actuators) and the multi-command expansions ('lighting-control'
 * on a light → turn-on + set-brightness). A declared capability with no
 * dispatch route contributes nothing (a misleading pre-flight surface is
 * the bug this fixes — `commands: []` for a device flows happily execute).
 *
 * hass://-bound devices mirror the oracle's own contract: real hardware the
 * sim registry cannot speak for — the declared capabilities ARE the surface.
 */
export function deviceExecutableCommandNames(
  capabilityNames: readonly string[],
  deviceType: string,
  binding?: string | null,
): string[] {
  const device: ScenarioDevice = {
    id: 'executability-oracle',
    name: 'executability-oracle',
    type: deviceType,
    role: 'hybrid',
    capabilities: [...capabilityNames],
    zoneId: 'zone-oracle',
    binding: binding ?? 'sim://executability-oracle',
  };
  const commands = new Set<string>();
  for (const capability of capabilityNames) {
    const path = executableCommandPath(device, capability, isCapabilityExecutable);
    if (path !== null) for (const name of path) commands.add(name);
  }
  return [...commands];
}

// ---------------------------------------------------------------------------
// Service interface derivation (Fix-15, F-27)
// ---------------------------------------------------------------------------

/** Basic parameter schema hint for one command parameter. */
export interface CommandParameterHint {
  type: 'number' | 'string' | 'boolean';
  enum?: string[];
  description?: string;
  /** R102: inclusive numeric range, when the command's semantics have one. */
  min?: number;
  max?: number;
  /** R102: string length cap (display/alert payloads). */
  maxLength?: number;
}

/** One callable action of a service interface. */
export interface ServiceActionSpec {
  name: string;
  parameters: Record<string, CommandParameterHint>;
}

/**
 * Descriptive parameter hints for the well-known commands (NOT the
 * executability contract — that stays derived live from the registry above;
 * a command missing here is still callable, just without hints).
 *
 * R13 (CB-F01): each entry now lists EVERY spelling its handler accepts
 * (verified against the handler sources) and doubles as the
 * accepted-parameter oracle for flow-authoring validation — an authoring-time
 * param-shape check (core flow-invoker) flags node params whose keys match
 * NONE of these spellings, because such params are silently dropped at run
 * time and the command executes with no effect.
 */
/** T-034: the shared parameter surface of display content commands. */
const DISPLAY_CONTENT_PARAMS: Record<string, CommandParameterHint> = {
  content: { type: 'string', maxLength: 500, description: 'the content to display' },
  message: { type: 'string', maxLength: 500, description: 'content (accepted spelling)' },
  text: { type: 'string', maxLength: 500, description: 'content (accepted spelling)' },
};

/** R102: the device-safe target-temperature range (same 5–40°C the flow/bridge clamps teach). */
const TEMPERATURE_PARAM: CommandParameterHint = {
  type: 'number', min: 5, max: 40,
  description: 'target temperature in °C (5–40)',
};

const COMMAND_PARAMETER_HINTS: Record<string, Record<string, CommandParameterHint>> = {
  'set-temperature': {
    targetTemperature: { ...TEMPERATURE_PARAM },
    temperature: { ...TEMPERATURE_PARAM, description: 'target temperature in °C (accepted spelling)' },
    target: { ...TEMPERATURE_PARAM, description: 'target temperature in °C (accepted spelling)' },
    value: { ...TEMPERATURE_PARAM, description: 'target temperature in °C (accepted spelling)' },
  },
  'adjust-temperature': {
    adjustment: { type: 'number', description: 'relative adjustment in °C' },
  },
  'set-mode': {
    mode: {
      type: 'string',
      // The CLOSED climate set (the ClimateModeCommandHandler's own rule —
      // 'off' is not a set-mode value; turn the unit off with turn-off).
      // On non-climate types any non-empty mode string is legal (T-607).
      enum: ['cooling', 'heating', 'auto'],
      description: 'climate devices (hvac/thermostat/air-conditioner): cooling|heating|auto; every other device type accepts any non-empty mode string verbatim (T-607: generic set-* semantics — e.g. turbo on a purifier, track on a tracker)',
    },
    target: { ...TEMPERATURE_PARAM, description: 'optional target in °C alongside the mode' },
    temperature: { ...TEMPERATURE_PARAM, description: 'optional target in °C alongside the mode' },
    targetTemperature: { ...TEMPERATURE_PARAM, description: 'optional target in °C alongside the mode' },
  },
  'set-fan-speed': {
    speed: { type: 'number', min: 0, max: 100, description: 'fan speed, 0–100' },
    fanSpeed: { type: 'number', min: 0, max: 100, description: 'fan speed, 0–100 (accepted spelling of speed)' },
  },
  'set-humidity': {
    targetHumidity: { type: 'number', min: 0, max: 100, description: 'target humidity in % (0–100)' },
    value: { type: 'number', min: 0, max: 100, description: 'target humidity in % (accepted spelling)' },
  },
  'set-brightness': {
    brightness: { type: 'number', description: 'brightness (the device family\'s scale — 0–1 or 0–100)' },
    value: { type: 'number', description: 'brightness (accepted spelling)' },
  },
  'set-volume': {
    volume: { type: 'number', min: 0, max: 100, description: 'volume level, 0–100' },
    value: { type: 'number', min: 0, max: 100, description: 'volume level, 0–100 (accepted spelling)' },
  },
  // R2-FEAT-11: the sprinkler template declares set-spray-pattern — its
  // dedicated handler (SprinklerCommandHandler) recognizes exactly ONE
  // spelling, so the accepted-params oracle names it honestly instead of
  // falling back to the generic 14-word list (whose value/power spellings
  // are type-gated no-ops on a sprinkler).
  'set-spray-pattern': {
    pattern: { type: 'string', description: 'spray pattern (e.g. mist, jet, shower)' },
  },
  // --- Emergency-story audio commands (R101 handlers; R102 schema) ---
  'play-alert': {
    message: { type: 'string', maxLength: 500, description: 'alert message or type to play (optional)' },
  },
  'emergency-broadcast': {
    message: { type: 'string', maxLength: 500, description: 'broadcast message (optional)' },
  },
  // --- Display content commands (T-034 effect models) ---
  'set-message': DISPLAY_CONTENT_PARAMS,
  'set-content': DISPLAY_CONTENT_PARAMS,
  'show-message': DISPLAY_CONTENT_PARAMS,
  'show-content': DISPLAY_CONTENT_PARAMS,
  'display-message': DISPLAY_CONTENT_PARAMS,
  'show-schedule': {
    schedule: { type: 'string', description: 'schedule text to display' },
    content: { type: 'string', description: 'content (accepted spelling)' },
  },
  'update-schedule': {
    schedule: { type: 'string', description: 'schedule text to display' },
    content: { type: 'string', description: 'content (accepted spelling)' },
  },
  'update-status': {
    status: { type: 'string', description: 'status text the panel should display' },
  },
  // --- Secure-state commands (T-034 lock audit) ---
  // R17 params-purity: `actor` is NO LONGER a command parameter — attribution
  // rides the invocation context (executeDeviceCommand options.actor →
  // handler execute-args actor), so it is deliberately absent from these
  // spellings; an author-time `{actor}` node param is flagged as unrecognized.
  lock: {},
  unlock: {},
  'grant-temporary-access': {
    to: { type: 'string', description: 'grantee identity' },
    durationMin: { type: 'number', description: 'grant duration in minutes (sim time); auto-relock at expiry (T-706)' },
    durationSec: { type: 'number', description: 'grant duration in seconds (sim time); durationMin wins when both given' },
  },
  // --- Capability-NAME commands (Fix-44g/44j) ---
  // Devices declare capabilities as names ('temperature-control', 'cooling',
  // …) and the handler registry executes them directly; the pre-44j hints
  // table only knew the legacy command spellings, so every derived service
  // shipped parameters:{} and consumers had to guess (B-P1-1).
  'temperature-control': {
    temperature: {
      ...TEMPERATURE_PARAM,
      description: 'target temperature in °C (targetTemperature/target/value are accepted spellings)',
    },
    targetTemperature: { ...TEMPERATURE_PARAM, description: 'target temperature in °C (accepted spelling)' },
    target: { ...TEMPERATURE_PARAM, description: 'target temperature in °C (accepted spelling)' },
    value: { ...TEMPERATURE_PARAM, description: 'target temperature in °C (accepted spelling)' },
  },
  cooling: {
    targetTemperature: { ...TEMPERATURE_PARAM, description: 'optional target in °C; defaults to the comfort setpoint' },
    target: { ...TEMPERATURE_PARAM, description: 'optional target in °C (accepted spelling)' },
    temperature: { ...TEMPERATURE_PARAM, description: 'optional target in °C (accepted spelling)' },
  },
  heating: {
    targetTemperature: { ...TEMPERATURE_PARAM, description: 'optional target in °C; defaults to the comfort setpoint' },
    target: { ...TEMPERATURE_PARAM, description: 'optional target in °C (accepted spelling)' },
    temperature: { ...TEMPERATURE_PARAM, description: 'optional target in °C (accepted spelling)' },
  },
};

/**
 * The parameter spellings a command's handler accepts, or undefined when the
 * command has no hint entry (unknown commands stay callable — this is NOT
 * the executability contract). R13 (CB-F01): injected into core's flow
 * validation so an all-unrecognized params object is an authoring-time
 * error instead of a mid-run "no handler / no effect".
 *
 * T-506 (EC24-F03): any OTHER set-* command claims the GenericSetCommandHandler
 * — return ITS recognized spellings so the SimulatedDevice no-op failure
 * always names usable params ("this command only changes state with params:
 * value, brightness, power, …") instead of silently omitting the hint.
 *
 * R2-FEAT-11: when the caller supplies the device context (deviceType +
 * currentState), the generic fallback is FILTERED to the spellings that
 * would actually change THIS device's state — the flat vocabulary listed
 * value/power on devices whose handler branches are type-gated no-ops
 * (the sprinkler finding: every listed param errored, only the
 * semantically-wrong {enable}→charging write "worked"). The filter probes
 * the handler itself, so the list can never drift from the implementation
 * (the same discipline the T-506 parity test pins). Without a deviceType
 * the legacy full list is returned (validation lanes that know only the
 * command name keep the permissive superset).
 */
export function acceptedParameterNames(
  commandName: string,
  deviceType?: string,
  currentState?: Record<string, unknown>,
): readonly string[] | undefined {
  const hints = COMMAND_PARAMETER_HINTS[commandName.toLowerCase()];
  if (hints !== undefined) return Object.keys(hints);
  if (/^set[-_]/i.test(commandName)) {
    if (deviceType === undefined) return GENERIC_SET_PARAM_NAMES;
    const probe = new GenericSetCommandHandler('accepted-params-probe');
    return GENERIC_SET_PARAM_NAMES.filter(name =>
      Object.keys(probe.execute({
        commandName,
        params: { [name]: GENERIC_SET_PROBE_VALUES[name] },
        currentState: currentState ?? {},
        deviceType,
        deviceId: 'accepted-params-probe',
      })).length > 0);
  }
  return undefined;
}

/**
 * R2-FEAT-11: one type-correct sample value per generic set-* spelling,
 * used to probe whether the spelling produces a state update on a given
 * (deviceType, currentState). Keys mirror GENERIC_SET_PARAM_NAMES.
 */
const GENERIC_SET_PROBE_VALUES: Record<string, unknown> = {
  value: 1,
  brightness: 0.5,
  power: true,
  speed: 1,
  fanSpeed: 1,
  targetHumidity: 50,
  target: 21,
  targetTemp: 21,
  mode: 'auto',
  charging: true,
  enable: true,
  rate: 1,
  chargingRate: 1,
  volume: 30,
};

/**
 * R102 (wang-17): the shared command-parameter VALIDATOR, derived from the
 * SAME COMMAND_PARAMETER_HINTS schema the flow-authoring param oracle and
 * the derived-service interface read — one truth for every dispatch lane
 * (invoke gate / sim command / flow node / AC executor):
 * - a KNOWN param with the wrong type, an out-of-range number, an illegal
 *   enum value (enforced for climate-class device types, whose mode set is
 *   closed — T-607 keeps arbitrary mode strings legal elsewhere), or an
 *   over-cap string is a VIOLATION: refuse the command, never execute it,
 *   never meter it as a success, never let the value reach device state;
 * - an UNKNOWN param is DROPPED (never applied) — the long-standing
 *   "unrecognized params are dropped" 口径, unchanged; the drop is
 *   reported so lanes can surface it instead of staying silent.
 */
export interface CommandParamValidation {
  /** Params the schema does not know — dropped, never applied. */
  dropped: string[];
  /** The first hard violation, or undefined when every known param validates. */
  violation?: string;
}

/** Device types whose set-mode enum is CLOSED (cooling|heating|auto|off). */
const CLIMATE_MODE_DEVICE_PATTERN = /hvac|thermostat|air-?conditioner|ac-controller|climate/i;

export function validateCommandParams(
  commandName: string,
  params: Record<string, unknown> | undefined,
  deviceType?: string,
): CommandParamValidation {
  const dropped: string[] = [];
  if (params === undefined || Object.keys(params).length === 0) return { dropped };
  const accepted = acceptedParameterNames(commandName);
  const specs = COMMAND_PARAMETER_HINTS[commandName.toLowerCase()];
  const enforceEnum = deviceType !== undefined && CLIMATE_MODE_DEVICE_PATTERN.test(deviceType);
  for (const [key, value] of Object.entries(params)) {
    // No schema for the command at all → every param is unknown (dropped,
    // never applied — the handler reads nothing it doesn't recognize).
    if (accepted === undefined || !accepted.includes(key)) {
      dropped.push(key);
      continue;
    }
    const spec = specs?.[key];
    if (spec === undefined) continue;
    const violation = validateParamValue(key, value, spec, enforceEnum);
    if (violation !== undefined) return { dropped, violation };
  }
  return { dropped };
}

function validateParamValue(
  key: string,
  value: unknown,
  spec: CommandParameterHint,
  enforceEnum: boolean,
): string | undefined {
  switch (spec.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `parameter "${key}" expects a number, got ${JSON.stringify(value)}`;
      }
      if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
        return `parameter "${key}" expects a number in [${spec.min ?? '-∞'}, ${spec.max ?? '+∞'}], got ${value}`;
      }
      return undefined;
    }
    case 'string': {
      if (typeof value !== 'string') {
        return `parameter "${key}" expects a string, got ${JSON.stringify(value)}`;
      }
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        return `parameter "${key}" exceeds the ${spec.maxLength}-character limit (${value.length})`;
      }
      if (enforceEnum && spec.enum !== undefined && !spec.enum.includes(value)) {
        return `parameter "${key}" expects one of ${spec.enum.join('|')}, got ${JSON.stringify(value)}`;
      }
      return undefined;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        return `parameter "${key}" expects a boolean, got ${JSON.stringify(value)}`;
      }
      return undefined;
    }
  }
}

/**
 * Build a service interface from a backing device's declared capabilities:
 * one action per executable command (capabilities ∩ registered handlers),
 * with basic parameter schema hints where known. Lets invoke consumers
 * discover the callable surface instead of guessing command names (F-27).
 */
export function serviceInterfaceForCapabilities(capabilityNames: string[]): {
  actions: ServiceActionSpec[];
} {
  return {
    actions: executableCommandsForCapabilities(capabilityNames).map(name => ({
      name,
      parameters: COMMAND_PARAMETER_HINTS[name] ?? {},
    })),
  };
}
