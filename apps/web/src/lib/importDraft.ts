/**
 * UX-W3 import draft review — pure helpers over the scenario-JSON drafts the
 * three import lanes (import-floorplan / import-ifc / import-osm) return.
 *
 * The draft is an opaque `Record<string, unknown>` (server-owned schema);
 * these helpers read/edit only the review surface the UI exposes:
 * - zone list (id / name / type / floor-from-bounds) for the review table;
 * - rename / remove edits that keep the draft internally consistent
 *   (removing a zone also drops its devices and unbinds it from agents);
 * - summary counts for the header line;
 * - the scale suggestion the floorplan lane's 400 message embeds (the
 *   server never applies the LLM-read scale silently — it rides the error
 *   text so the UI can offer「采用并重试」).
 */

export interface DraftZoneRow {
  id: string;
  name: string;
  /** Scenario zone `type` (room/corridor/…); '' when undeclared. */
  type: string;
  /** Bounds floor index when the draft declares one (building tier). */
  floor: number | null;
}

interface DraftZone {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  bounds?: unknown;
}

function zonesOf(draft: Record<string, unknown>): DraftZone[] {
  return Array.isArray(draft.zones) ? (draft.zones as DraftZone[]) : [];
}

function zoneFloor(zone: DraftZone): number | null {
  // Building tier (B-B compileBuildingIR / NL lane): floor rides the ZONE.
  // Older W3 drafts tucked it into bounds — keep that as the fallback.
  const direct = (zone as { floor?: unknown }).floor;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const bounds = zone.bounds;
  if (typeof bounds !== 'object' || bounds === null) return null;
  const floor = (bounds as { floor?: unknown }).floor;
  return typeof floor === 'number' && Number.isFinite(floor) ? floor : null;
}

/** The review table rows (zone order preserved). */
export function extractDraftZones(draft: Record<string, unknown>): DraftZoneRow[] {
  return zonesOf(draft)
    .filter(zone => typeof zone.id === 'string')
    .map(zone => ({
      id: zone.id as string,
      name: typeof zone.name === 'string' && zone.name.length > 0 ? zone.name : (zone.id as string),
      type: typeof zone.type === 'string' ? zone.type : '',
      floor: zoneFloor(zone),
    }));
}

export interface DraftCounts {
  zones: number;
  devices: number;
  agents: number;
}

/** Header summary: how much the draft carries (arrays only, 0 otherwise). */
export function draftCounts(draft: Record<string, unknown>): DraftCounts {
  const len = (key: string) => (Array.isArray(draft[key]) ? (draft[key] as unknown[]).length : 0);
  return { zones: len('zones'), devices: len('devices'), agents: len('agents') };
}

/** The draft's display name (meta.name), for the review header. */
export function draftName(draft: Record<string, unknown>): string {
  const meta = draft.meta;
  if (typeof meta === 'object' && meta !== null) {
    const name = (meta as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

/** Rename a zone by id — returns a NEW draft (no mutation). */
export function renameDraftZone(
  draft: Record<string, unknown>,
  zoneId: string,
  name: string,
): Record<string, unknown> {
  return {
    ...draft,
    zones: zonesOf(draft).map(zone =>
      zone.id === zoneId ? { ...zone, name } : zone,
    ),
  };
}

/**
 * Remove a zone by id — returns a NEW draft. Devices bound to the zone go
 * with it (a device without a zone cannot import), and the id is stripped
 * from every agent's zoneIds list (a now-empty list is left as-is: the
 * server treats an agent without zones as env-wide).
 */
export function removeDraftZone(
  draft: Record<string, unknown>,
  zoneId: string,
): Record<string, unknown> {
  const devices = Array.isArray(draft.devices) ? (draft.devices as Array<{ zoneId?: unknown }>) : [];
  const agents = Array.isArray(draft.agents) ? (draft.agents as Array<{ zoneIds?: unknown }>) : [];
  return {
    ...draft,
    // Prune dangling adjacency too — a surviving zone referencing the removed
    // one fails the server import (SCENARIO_VALIDATION_FAILED), the same
    // prune strategy as the template $repeat expansion (ux-w3 probe P1).
    zones: zonesOf(draft)
      .filter(zone => zone.id !== zoneId)
      .map(zone =>
        Array.isArray((zone as { adjacentZoneIds?: unknown }).adjacentZoneIds)
          ? {
              ...zone,
              adjacentZoneIds: ((zone as { adjacentZoneIds: unknown[] }).adjacentZoneIds)
                .filter(id => id !== zoneId),
            }
          : zone,
      ),
    devices: devices.filter(device => device.zoneId !== zoneId),
    agents: agents.map(agent =>
      Array.isArray(agent.zoneIds)
        ? { ...agent, zoneIds: agent.zoneIds.filter(id => id !== zoneId) }
        : agent,
    ),
  };
}

/**
 * Extract the LLM-read scale suggestion from a floorplan-400 error message.
 * The server embeds it as `retry with "pixelsPerMeter": <N>` (and earlier as
 * `… scale off the drawing: <N> px/m`); both phrasings are matched. Returns
 * null when the message carries no suggestion.
 */
export function parseScaleSuggestionFromMessage(message: string): number | null {
  const match =
    /"pixelsPerMeter":\s*([0-9]+(?:\.[0-9]+)?)/.exec(message) ??
    /scale off the drawing:\s*([0-9]+(?:\.[0-9]+)?)\s*px\/m/.exec(message);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}
