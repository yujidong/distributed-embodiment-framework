/**
 * World model — the render-facing shape consumed by the shared world map
 * (components/worldmap). Both world sources are adapted into it:
 *
 * - `worldModelFromEnvironment` — a P2a environment detail (multi-user:
 *   devices/agents carry owners, devices may carry a persisted position);
 * - `worldModelFromScenario` — a legacy file scenario (no owners/positions).
 *
 * `scenarioFromEnvironment` goes the other way: it reshapes an environment
 * detail into the ScenarioDefinition the legacy console panels
 * (EventInjectPanel etc.) were built against, so the sim console works
 * unchanged for environment-backed simulations.
 *
 * `inferDeviceRole` mirrors packages/core/src/scenario/scenario-loader.ts —
 * environment device instances do not carry a persisted `role`, so the dot
 * color derives from capabilities exactly the way the server-side loader
 * would infer it (read-only → sensor; write/execute-only → actuator;
 * mixed → hybrid). Keep in sync with the core implementation.
 */

import type {
  DeviceRole,
  EnvZone,
  EnvironmentDetail,
  ScenarioAgentLLM,
  ScenarioDefinition,
} from '../api/types';
import { readLatLng, type LatLng } from './geo';

export interface WorldModelDevice {
  id: string;
  name: string;
  type: string;
  role: DeviceRole;
  capabilities: string[];
  zoneId: string;
  /** Persisted position in world units (zone-bounds space), if the builder placed the dot. */
  position: { x: number; y: number } | null;
  /** Geo map tier: persisted position as lat/lng (geo environments only). */
  latLng: LatLng | null;
  ownerId: string | null;
  ownerName: string | null;
  /**
   * S2 (device privacy): undefined on the coarse view (non-owner viewers) —
   * the device owner / env owner / admin reads the persisted state.
   */
  initialState: Record<string, unknown> | null | undefined;
}

export interface WorldModelAgent {
  id: string;
  name: string;
  capabilities: string[];
  boundDeviceIds: string[];
  managedZoneIds: string[];
  llm: ScenarioAgentLLM | null;
  ownerId: string | null;
  ownerName: string | null;
}

export interface WorldModel {
  zones: EnvZone[];
  devices: WorldModelDevice[];
  agents: WorldModelAgent[];
}

function classifyCapability(name: string): 'read' | 'write' | 'execute' {
  const lower = name.toLowerCase();
  if (
    lower.includes('reading') ||
    lower.includes('sensing') ||
    lower.includes('monitoring') ||
    lower.includes('detection')
  ) {
    return 'read';
  }
  if (lower.includes('control') || lower.includes('adjustment') || lower.includes('setting')) {
    return 'write';
  }
  return 'execute';
}

/** Mirror of the core loader's role inference (see file header). */
export function inferDeviceRole(capabilities: string[]): DeviceRole {
  let reads = 0;
  let writes = 0;
  for (const capability of capabilities) {
    if (classifyCapability(capability) === 'read') reads += 1;
    else writes += 1;
  }
  if (writes === 0) return 'sensor';
  return reads > 0 ? 'hybrid' : 'actuator';
}

/** Defensive read of the free-form position JSON (`{x, y}` numbers or null). */
export function readPosition(raw: Record<string, unknown> | null | undefined): {
  x: number;
  y: number;
} | null {
  if (!raw) return null;
  const { x, y } = raw;
  if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
    return { x, y };
  }
  return null;
}

export function worldModelFromEnvironment(detail: EnvironmentDetail): WorldModel {
  return {
    zones: detail.zones,
    devices: detail.devices.map(device => ({
      id: device.id,
      name: device.name,
      type: device.type,
      role: inferDeviceRole(device.capabilities),
      capabilities: device.capabilities,
      zoneId: device.zoneId,
      position: readPosition(device.position),
      latLng: readLatLng(device.position),
      ownerId: device.owner.id,
      ownerName: device.owner.displayName,
      initialState: device.initialState,
    })),
    agents: detail.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      capabilities: agent.capabilities,
      boundDeviceIds: agent.boundDeviceIds,
      managedZoneIds: agent.managedZoneIds,
      llm: agent.llm,
      ownerId: agent.owner.id,
      ownerName: agent.owner.displayName,
    })),
  };
}

export function worldModelFromScenario(scenario: ScenarioDefinition): WorldModel {
  return {
    zones: scenario.zones,
    devices: scenario.devices.map(device => ({
      id: device.id,
      name: device.name,
      type: device.type,
      role: device.role,
      capabilities: device.capabilities,
      zoneId: device.zoneId,
      position: null,
      latLng: null,
      ownerId: null,
      ownerName: null,
      initialState: device.initialState ?? null,
    })),
    agents: scenario.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      capabilities: agent.capabilities,
      boundDeviceIds: agent.boundDeviceIds,
      managedZoneIds: agent.managesZoneIds,
      llm: agent.llm ?? null,
      ownerId: null,
      ownerName: null,
    })),
  };
}

/** Reshape an environment detail for the legacy scenario-based console panels. */
export function scenarioFromEnvironment(detail: EnvironmentDetail): ScenarioDefinition {
  return {
    version: '1.0',
    meta: { id: detail.id, name: detail.name, description: detail.description },
    zones: detail.zones.map(zone => ({
      id: zone.id,
      ...(zone.name !== undefined ? { name: zone.name } : {}),
      ...(zone.type !== undefined ? { type: zone.type } : {}),
      ...(zone.buildingId !== undefined ? { buildingId: zone.buildingId } : {}),
      ...(zone.floor !== undefined ? { floor: zone.floor } : {}),
      ...(zone.bounds !== undefined ? { bounds: zone.bounds } : {}),
      adjacentZoneIds: zone.adjacentZoneIds ?? [],
    })),
    devices: detail.devices.map(device => ({
      id: device.id,
      name: device.name,
      type: device.type,
      role: inferDeviceRole(device.capabilities),
      capabilities: device.capabilities,
      zoneId: device.zoneId,
      binding: `sim://${device.type}`,
      ...(device.initialState !== null ? { initialState: device.initialState } : {}),
    })),
    agents: detail.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      capabilities: agent.capabilities,
      managesZoneIds: agent.managedZoneIds,
      boundDeviceIds: agent.boundDeviceIds,
      ...(agent.llm !== null ? { llm: agent.llm } : {}),
    })),
    events: detail.events.map(event => ({ ...event })),
  };
}
