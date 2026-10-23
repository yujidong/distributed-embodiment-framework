/**
 * Export — live environment detail → world document.
 *
 * Catalog model ids are not stored on device instances, so devices always
 * export as `spec:` blocks (type/brand/capabilities round-trip exactly).
 * Agent bindings export as device NAMES (falling back to raw ids for
 * devices whose name cannot be resolved), which keeps the document
 * human-readable and re-applicable under a fresh environment.
 */

import type { EnvDetail, EnvFlowSummary } from '../ctx.js';
import { MAP_META_FIELDS, type WorldDemoMeta, type WorldDocument, type WorldMap } from './document.js';

export function envDetailToDocument(detail: EnvDetail, flows: EnvFlowSummary[] = []): WorldDocument {
  const deviceNameById = new Map(detail.devices.map(device => [device.id, device.name]));
  // R40-B4 flow portability: translate pinned device INSTANCE ids to names
  // (the document's device identity) and drop agent row ids.
  const deviceIdToName = new Map(detail.devices.map(device => [device.id, device.name]));
  const agentIdToName = new Map(detail.agents.map(agent => [agent.id, agent.name]));

  // Building-tier map metadata (canonical list): exported whenever the
  // server reports it, so storey/floor physics survives the round-trip.
  const meta: Partial<WorldMap> = {};
  for (const field of MAP_META_FIELDS) {
    const value = detail[field];
    if (typeof value === 'number') {
      (meta as Record<string, number>)[field] = value;
    }
  }

  const document: WorldDocument = {
    version: '1.0',
    environment: {
      name: detail.name,
      ...(detail.description ? { description: detail.description } : {}),
      visibility: detail.visibility,
      map: {
        type: detail.mapType === 'geo' ? 'geo' : 'grid',
        ...(detail.mapCenter ? { center: detail.mapCenter } : {}),
        ...(detail.mapZoom !== null && detail.mapZoom !== undefined ? { zoom: detail.mapZoom } : {}),
        ...meta,
        ...(detail.demo !== null && detail.demo !== undefined
          ? { demo: detail.demo as WorldDemoMeta }
          : {}),
        zones: detail.zones,
      },
    },
    devices: detail.devices.map(device => ({
      name: device.name,
      zone: device.zoneId,
      spec: {
        type: device.type,
        ...(device.brand ? { brand: device.brand } : {}),
        capabilities: device.capabilities,
      },
      ...(device.position ? { position: device.position } : {}),
      ...(device.initialState ? { initialState: device.initialState } : {}),
    })),
    agents: detail.agents.map(agent => ({
      name: agent.name,
      capabilities: agent.capabilities,
      bind: agent.boundDeviceIds.map(id => deviceNameById.get(id) ?? id),
      zones: agent.managedZoneIds,
      ...(agent.llm ? { llm: agent.llm } : {}),
    })),
    ...(detail.events.length > 0 ? { events: detail.events } : {}),
    ...(flows.length > 0
      ? {
          flows: flows.map(flow => ({
            name: flow.name,
            ...(flow.description ? { description: flow.description } : {}),
            enabled: flow.enabled,
            trigger: portableFlowRefs(flow.trigger, deviceIdToName, agentIdToName),
            plan: portableFlowRefs(flow.plan, deviceIdToName, agentIdToName),
            ...(flow.inputs !== undefined && flow.inputs !== null ? { inputs: flow.inputs } : {}),
          })),
        }
      : {}),
  };
  return document;
}

/**
 * R40-B4: flows exported for the world document must not carry RUNTIME row
 * references — assigneeAgentId / deviceId are instance ids of the exporting
 * world and can never resolve in a re-created one (roundtrip-fidelity caught
 * the FLOW_INVALID). The receiving world re-pins flows by capability.
 */
function portableFlowRefs(
  value: unknown,
  deviceIdToName: Map<string, string>,
  agentIdToName: Map<string, string>,
): Record<string, unknown> {
  return renameDevicePins(value, deviceIdToName, agentIdToName) as Record<string, unknown>;
}

/**
 * Recursive key RENAME (JSON.stringify replacers cannot rename keys):
 * deviceId → deviceName (value translated to the device's name; unknown ids
 * dropped), assigneeAgentId removed entirely.
 */
function renameDevicePins(
  node: unknown,
  deviceIdToName: Map<string, string>,
  agentIdToName: Map<string, string>,
): unknown {
  if (Array.isArray(node)) {
    return node.map(entry => renameDevicePins(entry, deviceIdToName, agentIdToName));
  }
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'assigneeAgentId' && typeof value === 'string') {
      const name = agentIdToName.get(value);
      if (name !== undefined) out.assigneeAgentName = name;
      continue;
    }
    if (key === 'deviceId' && typeof value === 'string') {
      const name = deviceIdToName.get(value);
      if (name !== undefined) out.deviceName = name;
      continue;
    }
    out[key] = renameDevicePins(value, deviceIdToName, agentIdToName);
  }
  return out;
}
