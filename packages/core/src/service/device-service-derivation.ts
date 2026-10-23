/**
 * Device-service derivation — the single source of truth for how a bound
 * device becomes a DERIVED service (P1).
 *
 * Two service faces consume it:
 * - the runtime registry (ResourceCoordinator.publishDeviceAsService): one
 *   Service per device named `<device name> Service`, capabilities =
 *   declared device capability names ∪ device-only semantic derivations,
 *   semanticType = the device resource type;
 * - the world layer (server service-store syncDerivedForAgent): one row per
 *   (device × executable capability), whose honest semantic labels come from
 *   the shared `honestSemanticType` / `isSwitchingSurface` rules below. The
 *   executability oracles stay server-side — they need the simulation
 *   command registry and the world device catalog, which core must not
 *   depend on.
 *
 * Pure module: shared types only, no I/O.
 */

import type { ParameterType } from '@active-collaboration/shared';

/** Minimal device-capability shape both faces can feed (name + optional verb type). */
export interface DeviceCapabilityLike {
  name: string;
  type?: string;
}

/** Minimal device shape the derivation reads (structural — Device and the world-layer row both fit). */
export interface DeviceDerivationInput {
  type?: string;
  name: string;
  capabilities?: DeviceCapabilityLike[];
}

/**
 * Runtime-face derived service spec: everything publishDeviceAsService
 * stamps onto the Service except identity/location/provider fields.
 */
export interface DerivedDeviceServiceSpec {
  /** `<device name> Service` — consumers (partner-summaries) strip this suffix. */
  name: string;
  description: string;
  /** Semantic label of the derived service — the device resource type. */
  semanticType: string;
  /** Runtime Service.category (same value as semanticType, kept for workflow matching). */
  category: string;
  actionType: 'observe' | 'control' | 'both';
  /** Declared device capability names ∪ device-only semantic derivations (deduped). */
  capabilities: string[];
  /** Parameter definitions mirrored from the device capabilities. */
  parameters: Array<{ name: string; type: ParameterType; required: boolean; description: string }>;
}

/** Runtime-face derived service name. Keep the " Service" suffix — discovery consumers rely on it. */
export function deriveDeviceServiceName(deviceName: string): string {
  return `${deviceName} Service`;
}

/**
 * Rename-stable registry identity of a device's derived service (runtime
 * face). The EnvironmentCenter registration key is `${deviceId}:${name}` and
 * the derived name is built FROM THE DEVICE NAME, so a device rename used to
 * orphan the old key (new name → new key, old registration left behind). The
 * derived lane instead registers under this name-independent identity — the
 * runtime face contracts exactly one service per device, so the slot is a
 * constant; re-publication after a rename overwrites the same key and the new
 * display name lands in place. The world face already keys its derived rows
 * by (source_device_id, semantic_type) with the name as a patched display
 * attribute — both faces now agree: identity never contains the name.
 */
export const DERIVED_DEVICE_SERVICE_IDENTITY = 'derived:device-service';

/** Runtime-face derived service description. */
export function deriveDeviceServiceDescription(deviceName: string): string {
  return `Service provided by device ${deviceName}`;
}

/**
 * Map device type to resource type (semantic label of the derived service).
 * Extracted from CognitiveAgent.mapDeviceToResourceType().
 */
export function deviceResourceType(deviceType: string | undefined): string {
  const type = deviceType?.toLowerCase() || '';

  if (type.includes('sensor')) return 'sensor';
  if (type.includes('actuator')) return 'actuator';
  if (type.includes('thermostat')) return 'thermostat';
  if (type.includes('light') || type.includes('lamp')) return 'lighting';
  if (type.includes('camera')) return 'security';
  if (type.includes('lock')) return 'security';
  if (type.includes('switch')) return 'switch';
  if (type.includes('outlet') || type.includes('plug')) return 'power';
  if (type.includes('speaker')) return 'audio';
  if (type.includes('display') || type.includes('screen')) return 'display';
  if (type.includes('hvac')) return 'hvac';
  if (type.includes('curtain') || type.includes('blind')) return 'curtain';
  if (type.includes('appliance')) return 'appliance';

  return 'device';
}

/** Action type from the device capability verbs (read → observe, write/execute → control). */
export function deriveDeviceServiceActionType(
  capabilities: readonly DeviceCapabilityLike[],
): 'observe' | 'control' | 'both' {
  const hasReadCapabilities = capabilities.some(cap => cap.type === 'read');
  const hasWriteCapabilities = capabilities.some(cap => cap.type === 'write' || cap.type === 'execute');

  if (hasReadCapabilities && hasWriteCapabilities) return 'both';
  if (hasWriteCapabilities) return 'control';
  return 'observe';
}

/** Map capability verb type to a Service parameter type. */
export function mapCapabilityTypeToParameterType(capType: string | undefined): string {
  const typeMap: Record<string, string> = {
    'read': 'string',
    'write': 'string',
    'execute': 'string',
    'number': 'number',
    'boolean': 'boolean',
    'integer': 'integer',
    'float': 'number',
    'string': 'string',
    'array': 'array',
    'object': 'object',
  };

  return typeMap[capType?.toLowerCase() || ''] || 'string';
}

/**
 * Derive additional service capabilities for a device (semantic matching
 * aid). T-202: the runtime face calls this with NO agent capabilities for
 * service publication — derivations are device-type semantics and
 * device-capability semantics only, so a per-device service never claims
 * what only the AGENT can do.
 */
export function deriveDeviceSemanticCapabilities(
  device: DeviceDerivationInput,
  agentCapabilities: readonly string[] = [],
): string[] {
  const derived: string[] = [];
  const deviceType = device.type?.toLowerCase() || '';
  const deviceName = device.name.toLowerCase();

  // Device-TYPE semantics (T-202): derivable without any agent input —
  // what the physical device category delivers by construction.
  if (deviceType.includes('light') || deviceName.includes('light') || deviceName.includes('lamp')) {
    derived.push('lighting-control');
  }
  if (deviceType.includes('hvac') || deviceName.includes('hvac') || deviceName.includes('thermostat')) {
    derived.push('hvac-control');
    derived.push('temperature-control');
  }

  // Combine device type/name with agent capabilities to derive new capabilities
  // For example, if agent has 'monitoring' capability and device is a temperature sensor,
  // we can derive 'temperature-monitoring' capability

  for (const agentCap of agentCapabilities) {
    const agentCapLower = agentCap.toLowerCase();

    // Check for monitoring capability combinations
    if (agentCapLower.includes('monitoring') || agentCapLower.includes('sensing')) {
      if (deviceType.includes('temp') || deviceName.includes('temp')) {
        derived.push('temperature-monitoring');
        derived.push('temperature-sensor');
        derived.push('sensing');
      }
      if (deviceType.includes('humidity') || deviceName.includes('humidity')) {
        derived.push('humidity-monitoring');
        derived.push('humidity-sensor');
      }
      if (deviceType.includes('motion') || deviceName.includes('motion')) {
        derived.push('motion-monitoring');
        derived.push('motion-sensor');
      }
    }

    // Check for control capability combinations
    if (agentCapLower.includes('control') || agentCapLower.includes('actuation')) {
      if (deviceType.includes('hvac') || deviceName.includes('hvac') || deviceName.includes('thermostat')) {
        derived.push('hvac-control');
        derived.push('temperature-control');
        derived.push('cooling');
        derived.push('heating');
      }
      if (deviceType.includes('light') || deviceName.includes('light')) {
        derived.push('lighting-control');
      }
      if (deviceType.includes('curtain') || deviceName.includes('curtain') || deviceName.includes('blind')) {
        derived.push('curtain-control');
      }
    }

    // Add the agent capability itself if not already present
    derived.push(agentCap);
  }

  // Also derive from device capabilities
  const deviceCapabilities = device.capabilities || [];
  for (const deviceCap of deviceCapabilities) {
    const capName = deviceCap.name.toLowerCase();
    const capType = deviceCap.type?.toLowerCase() || '';

    // Read capabilities -> monitoring/sensing
    if (capType === 'read') {
      if (capName.includes('temp')) {
        derived.push('monitoring');
        derived.push('sensing');
        derived.push('temperature-monitoring');
      }
      if (capName.includes('humidity')) {
        derived.push('monitoring');
        derived.push('humidity-monitoring');
      }
    }

    // Write/execute capabilities -> control/actuation
    if (capType === 'write' || capType === 'execute') {
      derived.push('control');
      derived.push('actuation');

      if (capName.includes('hvac') || capName.includes('temp')) {
        derived.push('temperature-control');
        derived.push('hvac-control');
      }
    }
  }

  return derived;
}

/**
 * Runtime-face derivation core: one spec per device. Capabilities are
 * device-only (T-202 capability honesty) — declared capability names plus
 * the device-only semantic derivations, deduped, declared names first.
 */
export function deriveDeviceService(
  device: DeviceDerivationInput,
  agentCapabilities: readonly string[] = [],
): DerivedDeviceServiceSpec {
  const deviceCapabilities = device.capabilities || [];
  const deviceCapabilityNames = deviceCapabilities.map(cap => cap.name);
  const derivedCapabilities = deriveDeviceSemanticCapabilities(device, agentCapabilities);
  const resourceType = deviceResourceType(device.type);

  return {
    name: deriveDeviceServiceName(device.name),
    description: deriveDeviceServiceDescription(device.name),
    semanticType: resourceType,
    category: resourceType,
    actionType: deriveDeviceServiceActionType(deviceCapabilities),
    capabilities: Array.from(new Set([...deviceCapabilityNames, ...derivedCapabilities])),
    parameters: deviceCapabilities.map(cap => ({
      name: cap.name,
      type: mapCapabilityTypeToParameterType(cap.type) as ParameterType,
      required: false,
      description: `${cap.name} parameter`,
    })),
  };
}

// ---------------------------------------------------------------------------
// World-face honest semantic labels (T-043) — the pure tier of the server's
// per-capability derivation. The executability/surface oracles stay
// server-side (simulation registry + world catalog); the LABEL rules are
// shared here so both faces speak the same switching/semantic vocabulary.
// ---------------------------------------------------------------------------

/**
 * T-043: canonical semantic label for a derived service whose backing
 * device can only SWITCH POWER for the capability (every executable route
 * resolves to turn-on/turn-off). A marketing capability name
 * ('environment', 'ventilation' on a plain socket, …) must not label a
 * service that can do nothing but switch on/off.
 */
export const SEMANTIC_TYPE_SWITCHING = 'switching';

/** The commands that constitute a pure power-switching surface. */
export const SWITCHING_COMMANDS: ReadonlySet<string> = new Set(['turn-on', 'turn-off']);

/** Is `surface` a pure power-switching command set (possibly empty-safe)? */
export function isSwitchingSurface(surface: readonly string[]): boolean {
  return surface.length > 0 && surface.every(command => SWITCHING_COMMANDS.has(command));
}

/**
 * T-043: the honest semantic label for one derived entry. The rule:
 * - the capability IS its own executable surface (a real command or
 *   read/query name: turn-on, temperature-reading, cooling) → keep it
 *   verbatim — the label already names what runs;
 * - the surface is pure power switching → SEMANTIC_TYPE_SWITCHING (what
 *   actually runs is on/off, whatever the capability calls itself);
 * - otherwise (semantic/multi-command mapping to a richer surface —
 *   'lighting-control' on a light → turn-on + set-brightness) → keep the
 *   capability name.
 */
export function honestSemanticType(capability: string, surface: readonly string[]): string {
  if (surface.length === 1 && surface[0] === capability) return capability;
  if (isSwitchingSurface(surface)) return SEMANTIC_TYPE_SWITCHING;
  return capability;
}
