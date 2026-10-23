/**
 * L1 → context projections (§3.1, §14.2 "world model as single source").
 *
 * The glue that converges the legacy context builders onto the world model:
 *
 *  - `enrichAgentDevices`: the live device-state enrichment DualTriggerACManager
 *    built inline (extracted verbatim — behavior pinned by the context-builder
 *    pins; ONE implementation now feeds both the legacy `availableResources`
 *    face and the world-model device face).
 *  - `WorldModelZoneSource` + `buildAgentCognitionContext`: assembles the
 *    per-round AgentCognitionContext (world model via the pure builder,
 *    working-memory round, rule-based situation assessment) that
 *    `buildAgentContext` attaches and the assessor prompt renders.
 *
 * Pure/dependency-injected: no clocks, no I/O, no registries imported.
 */

import { assessSituation } from './situation-assessment.js';
import type { AgentCognitionContext } from './prompt-context.js';
import {
  buildAgentWorldModel,
  deriveDeviceCommands,
  type WorldModelGoalInput,
  type WorldModelZoneInput,
} from './world-model-builder.js';
import type { WorkingMemoryStore } from './working-memory.js';
import type { WorldModelEvent } from './world-model.js';

// ============================================================================
// Device enrichment (extracted from DualTriggerACManager.buildAgentContext)
// ============================================================================

/** Structural face the enrichment reads from the resource layer. */
export interface DeviceResourceLike {
  getState?: () => Record<string, unknown>;
  isAvailable?: () => boolean;
  getLocation?: () => unknown;
  location?: unknown;
}

/** Structural face the enrichment reads from the environment's live devices. */
export interface LiveDeviceLike {
  getState?: () => Record<string, unknown>;
  location?: unknown;
  status?: string;
}

/** Bound-device info the enrichment consumes (PlannerDeviceInfo shape). */
export interface BoundDeviceInfo {
  deviceId: string;
  type: string;
  capabilities: string[];
  zoneId?: string;
}

/** The enriched resource entry buildAgentContext returns (legacy shape). */
export interface EnrichedResource {
  deviceId: string;
  type: string;
  capabilities: string[];
  currentState: Record<string, unknown>;
  location: unknown;
  isOnline: boolean;
}

export interface DeviceEnrichmentDeps {
  resourceManager?: { getResource(deviceId: string): DeviceResourceLike | null | undefined };
  environment?: { getDevice?(deviceId: string): LiveDeviceLike | undefined };
  /** Ablation: strip physical context (locations) when true. */
  disablePhysicalContext?: boolean;
}

/**
 * Live state/zone enrichment for the agent's BOUND devices (verbatim
 * extraction of the R37-F2 block from DualTriggerACManager.buildAgentContext
 * — the pins must stay green): resource layer first; else the environment's
 * LIVE device; else the binding's zoneId; faults degrade, never throw.
 */
export function enrichAgentDevices(
  devices: readonly BoundDeviceInfo[],
  deps: DeviceEnrichmentDeps,
): EnrichedResource[] {
  return devices.map(deviceInfo => {
    const resource = deps.resourceManager?.getResource(deviceInfo.deviceId);
    let currentState: Record<string, unknown> | undefined = resource?.getState?.();
    let isOnline = resource ? (resource.isAvailable?.() ?? true) : true;
    let location: unknown;
    if (!deps.disablePhysicalContext) {
      try {
        location = typeof resource?.getLocation === 'function'
          ? resource.getLocation()
          : resource?.location;
      } catch { location = undefined; }
    }
    if (currentState === undefined) {
      try {
        const live = deps.environment?.getDevice?.(deviceInfo.deviceId);
        if (typeof live?.getState === 'function') currentState = live.getState();
        if (!deps.disablePhysicalContext) {
          if (location === undefined && live !== undefined) location = live.location;
          if (live?.status === 'offline' || live?.status === 'error') isOnline = false;
        }
      } catch { /* enrichment must never break the decision path */ }
    }
    if (location === undefined && !deps.disablePhysicalContext && deviceInfo.zoneId !== undefined) {
      location = deviceInfo.zoneId; // assignDevices scopes sim devices by location = zoneId
    }
    return {
      deviceId: deviceInfo.deviceId,
      type: deviceInfo.type,
      capabilities: deviceInfo.capabilities,
      currentState: currentState ?? {},
      location,
      isOnline,
    };
  });
}

/** Resolve a device location to its zone id (same logic as MY_DEVICES' zoneOf). */
export function zoneIdOfLocation(location: unknown): string | undefined {
  if (typeof location === 'string' && location.length > 0) return location;
  if (typeof location === 'object' && location !== null) {
    const rec = location as Record<string, unknown>;
    const zone = rec.zoneId ?? rec.path;
    if (typeof zone === 'string' && zone.length > 0) return zone;
  }
  return undefined;
}

/** Structural face of environment.listDevices() entries. */
export interface ListedDeviceLike {
  id: string;
  type?: string;
  capabilities?: Array<string | { name?: string; type?: string }>;
  state?: Record<string, unknown>;
  location?: unknown;
  status?: string;
}

/**
 * The no-bound-devices fallback face (verbatim extraction from
 * buildAgentContext): up to 10 environment devices, capabilities flattened,
 * online iff status === 'online'.
 */
export function environmentDevicesFace(
  devices: readonly ListedDeviceLike[],
  disablePhysicalContext?: boolean,
): EnrichedResource[] {
  return devices.slice(0, 10).map(d => ({
    deviceId: d.id,
    type: d.type || 'unknown',
    capabilities: (d.capabilities || []).map(c =>
      typeof c === 'string' ? c : c.name || c.type || String(c)),
    currentState: d.state || {},
    location: disablePhysicalContext ? undefined : d.location,
    isOnline: d.status === 'online',
  }));
}

// ============================================================================
// Zone source (runtime seam)
// ============================================================================

/**
 * The runtime's live zone face for one agent: sim clock + the zones the
 * agent can see (managed + adjacent) with current parameters and adjacency.
 * Provided by EngineRuntime (setWorldModelProvider); absent in embedded
 * contexts → the world model carries devices/goals/events but no zones.
 */
export interface WorldModelZoneSource {
  simTimeSec: number;
  /** Wall-clock epoch ms sim-time 0 maps to (for event-time conversion). */
  simStartEpochMs?: number;
  zones: readonly WorldModelZoneInput[];
}

// ============================================================================
// Cognition context assembly
// ============================================================================

export interface CognitionContextDeps {
  agentId: string;
  /** T-202-enriched surface (declared ∪ device-derived). */
  capabilities: string[];
  scopeOfPractice?: string[];
  /** The enriched bound-device face (output of enrichAgentDevices). */
  availableResources: readonly EnrichedResource[];
  /** Runtime zone face; optional (embedded contexts). */
  zoneSource?: WorldModelZoneSource;
  /** Owner-assigned goal stack inputs. */
  goals?: readonly WorldModelGoalInput[];
  /** Chronological digested events (the manager's bounded ring). */
  events?: readonly WorldModelEvent[];
  /** Fallback sim time when no zone source is wired. */
  fallbackSimTimeSec?: number;
  /** The agent's working-memory store (opens the round). */
  workingMemoryStore: WorkingMemoryStore;
}

/**
 * Assemble the per-round cognition context: build the world model (single
 * builder), open the working-memory round (previous decision + what
 * changed), classify the situation (rules lane). The ONE source the
 * assessor prompt and future L2 consumers read.
 */
export function buildAgentCognitionContext(deps: CognitionContextDeps): AgentCognitionContext {
  const devices = deps.availableResources.map(resource => ({
    deviceId: resource.deviceId,
    type: resource.type,
    ...(zoneIdOfLocation(resource.location) !== undefined
      ? { zoneId: zoneIdOfLocation(resource.location) }
      : {}),
    state: resource.currentState,
    commands: deriveDeviceCommands(resource.capabilities),
  }));

  const worldModel = buildAgentWorldModel({
    agentId: deps.agentId,
    capabilities: deps.capabilities,
    ...(deps.scopeOfPractice !== undefined && deps.scopeOfPractice.length > 0
      ? { scopeOfPractice: deps.scopeOfPractice }
      : {}),
    devices,
    zones: deps.zoneSource?.zones ?? [],
    goalStack: deps.goals ?? [],
    events: deps.events ?? [],
    simTimeSec: deps.zoneSource?.simTimeSec ?? deps.fallbackSimTimeSec ?? 0,
  });

  const workingMemory = deps.workingMemoryStore.beginRound(worldModel);
  return { worldModel, situation: assessSituation(worldModel), workingMemory };
}
