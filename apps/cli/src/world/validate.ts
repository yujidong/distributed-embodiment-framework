/**
 * World-document validation — hand-rolled (no ajv dependency) so error
 * messages carry exact document paths (`devices[2].zone: …`). The JSON
 * Schema in apps/cli/schema/ mirrors these rules for external tooling and
 * documents the format for AI authors; this validator is the one the CLI
 * enforces, and it collects ALL issues instead of failing on the first.
 */

import { MAP_META_FIELDS, type WorldDocument } from './document.js';

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const LLMS = ['auto', 'llm', 'none'];
const VISIBILITIES = ['public', 'private'];
const MAP_TYPES = ['grid', 'geo'];

// R40-B4: flows ride the document (export→apply round-trip).
const TOP_LEVEL_KEYS = ['version', 'environment', 'devices', 'agents', 'events', 'flows', 'simulation'];
const ENV_KEYS = ['name', 'description', 'visibility', 'map'];
// Map metadata fields come from the canonical list (document.ts), so a new
// building-tier meta field is validated without touching this file.
const MAP_KEYS = ['type', 'center', 'zoom', 'demo', 'zones', ...MAP_META_FIELDS];
const ZONE_KEYS = [
  'id', 'name', 'type', 'consentClass', 'buildingId', 'floor', 'occupancy', 'envelopeU',
  'occupantSchedule', 'glassAreaM2', 'ambientBuffer',
  'bounds', 'polygon', 'adjacentZoneIds', 'baseline',
  // R82: declarative rooms — world metadata (same field the server's
  // scenario-loader validates structurally); it round-trips env export → apply.
  'rooms',
];
const ZONE_CONSENT_CLASSES = ['standard', 'supervised', 'restricted'];
const DEVICE_KEYS = ['model', 'spec', 'name', 'zone', 'position', 'initialState'];
const SPEC_KEYS = ['type', 'brand', 'capabilities'];
const AGENT_KEYS = ['name', 'capabilities', 'bind', 'zones', 'llm'];
const EVENT_KEYS = ['id', 'type', 'zoneId', 'parameter', 'value', 'severity', 'atSimTimeSec', 'requiredCapabilities'];
const SIM_KEYS = ['llm', 'speed', 'tickMs'];

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** Validate raw parsed YAML/JSON into a WorldDocument; returns all issues. */
export function validateDocument(raw: unknown): { document?: WorldDocument; issues: string[] } {
  const issues: string[] = [];
  const doc = raw as WorldDocument;

  if (!isObj(raw)) {
    return { issues: ['document must be an object (YAML mapping / JSON object)'] };
  }
  checkUnknownKeys(raw, TOP_LEVEL_KEYS, '', issues);

  if (raw.version !== '1.0') {
    issues.push(`version: must be the string "1.0", got ${JSON.stringify(raw.version)}`);
  }

  // --- environment ---------------------------------------------------------
  if (!isObj(raw.environment)) {
    issues.push('environment: required, must be an object');
  } else {
    const env = raw.environment;
    checkUnknownKeys(env, ENV_KEYS, 'environment', issues);
    if (!isNonEmptyString(env.name)) {
      issues.push('environment.name: required non-empty string');
    }
    if (env.description !== undefined && typeof env.description !== 'string') {
      issues.push('environment.description: must be a string');
    }
    if (env.visibility !== undefined && !VISIBILITIES.includes(env.visibility as string)) {
      issues.push(`environment.visibility: must be one of ${VISIBILITIES.join(' | ')}`);
    }
    if (env.map !== undefined) validateMap(env.map, issues);
  }

  // --- devices -------------------------------------------------------------
  if (raw.devices !== undefined) {
    if (!Array.isArray(raw.devices)) {
      issues.push('devices: must be an array');
    } else {
      raw.devices.forEach((device, i) => validateDevice(device, `devices[${i}]`, issues));
    }
  }

  // --- agents --------------------------------------------------------------
  if (raw.agents !== undefined) {
    if (!Array.isArray(raw.agents)) {
      issues.push('agents: must be an array');
    } else {
      raw.agents.forEach((agent, i) => {
        const path = `agents[${i}]`;
        if (!isObj(agent)) {
          issues.push(`${path}: must be an object`);
          return;
        }
        checkUnknownKeys(agent, AGENT_KEYS, path, issues);
        if (!isNonEmptyString(agent.name)) issues.push(`${path}.name: required non-empty string`);
        if (!Array.isArray(agent.capabilities) || !isStringArray(agent.capabilities)) {
          issues.push(`${path}.capabilities: required array of strings`);
        }
        if (agent.bind !== undefined && !isStringArray(agent.bind)) {
          issues.push(`${path}.bind: must be an array of device names/ids`);
        }
        if (agent.zones !== undefined && !isStringArray(agent.zones)) {
          issues.push(`${path}.zones: must be an array of zone ids`);
        }
        if (agent.llm !== undefined && !isObj(agent.llm)) {
          issues.push(`${path}.llm: must be an object (e.g. {provider, model})`);
        }
      });
    }
  }

  // --- events --------------------------------------------------------------
  if (raw.events !== undefined) {
    if (!Array.isArray(raw.events)) {
      issues.push('events: must be an array');
    } else {
      raw.events.forEach((event, i) => {
        const path = `events[${i}]`;
        if (!isObj(event)) {
          issues.push(`${path}: must be an object`);
          return;
        }
        checkUnknownKeys(event, EVENT_KEYS, path, issues);
        for (const field of ['id', 'type', 'zoneId'] as const) {
          if (!isNonEmptyString(event[field])) issues.push(`${path}.${field}: required non-empty string`);
        }
        if (event.parameter !== undefined && typeof event.parameter !== 'string') {
          issues.push(`${path}.parameter: must be a string`);
        }
        if (
          event.value !== undefined &&
          !isFiniteNumber(event.value) &&
          typeof event.value !== 'boolean' &&
          typeof event.value !== 'string'
        ) {
          issues.push(`${path}.value: must be a number | boolean | string`);
        }
        if (event.severity !== undefined && !SEVERITIES.includes(event.severity as string)) {
          issues.push(`${path}.severity: must be one of ${SEVERITIES.join(' | ')}`);
        }
        if (event.atSimTimeSec !== undefined && (!isFiniteNumber(event.atSimTimeSec) || (event.atSimTimeSec as number) < 0)) {
          issues.push(`${path}.atSimTimeSec: must be a number >= 0`);
        }
        if (event.requiredCapabilities !== undefined && !isStringArray(event.requiredCapabilities)) {
          issues.push(`${path}.requiredCapabilities: must be an array of strings`);
        }
      });
    }
  }


  // --- flows (R40-B4) -------------------------------------------------------
  if (raw.flows !== undefined) validateFlowsArray(raw.flows, 'flows', issues);
  // --- simulation ----------------------------------------------------------
  if (raw.simulation !== undefined) {
    const path = 'simulation';
    if (!isObj(raw.simulation)) {
      issues.push(`${path}: must be an object`);
    } else {
      const sim = raw.simulation;
      checkUnknownKeys(sim, SIM_KEYS, path, issues);
      if (sim.llm !== undefined && !LLMS.includes(sim.llm as string)) {
        issues.push(`${path}.llm: must be one of ${LLMS.join(' | ')}`);
      }
      if (sim.speed !== undefined && (!isFiniteNumber(sim.speed) || (sim.speed as number) <= 0)) {
        issues.push(`${path}.speed: must be a number > 0`);
      }
      if (sim.tickMs !== undefined && (!isFiniteNumber(sim.tickMs) || (sim.tickMs as number) <= 0)) {
        issues.push(`${path}.tickMs: must be a number > 0`);
      }
    }
  }

  return { document: issues.length === 0 ? doc : undefined, issues };
}

function validateMap(map: unknown, issues: string[]): void {
  const path = 'environment.map';
  if (!isObj(map)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkUnknownKeys(map, MAP_KEYS, path, issues);
  const type = map.type as string | undefined;
  if (!MAP_TYPES.includes(type ?? '')) {
    issues.push(`${path}.type: required, must be one of ${MAP_TYPES.join(' | ')}`);
  }
  for (const field of MAP_META_FIELDS) {
    if (map[field] !== undefined && !isFiniteNumber(map[field])) {
      issues.push(`${path}.${field}: must be a number`);
    }
  }
  if (!Array.isArray(map.zones)) {
    issues.push(`${path}.zones: required array of zone objects`);
  } else {
    const seen = new Set<string>();
    map.zones.forEach((zone, i) => {
      const zpath = `${path}.zones[${i}]`;
      if (!isObj(zone)) {
        issues.push(`${zpath}: must be an object`);
        return;
      }
      checkUnknownKeys(zone, ZONE_KEYS, zpath, issues);
      if (!isNonEmptyString(zone.id)) {
        issues.push(`${zpath}.id: required non-empty string`);
      } else if (seen.has(zone.id as string)) {
        issues.push(`${zpath}.id: duplicate zone id "${zone.id}"`);
      } else {
        seen.add(zone.id as string);
      }
      if (zone.name !== undefined && typeof zone.name !== 'string') {
        issues.push(`${zpath}.name: must be a string`);
      }
      if (zone.type !== undefined && typeof zone.type !== 'string') {
        issues.push(`${zpath}.type: must be a string`);
      }
      // R82: declarative rooms — structural checks only (rooms are world
      // metadata, never interpreted), mirroring the server's scenario-loader.
      if (zone.rooms !== undefined) {
        if (!Array.isArray(zone.rooms)) {
          issues.push(`${zpath}.rooms: must be an array`);
        } else {
          zone.rooms.forEach((room, r) => {
            const rpath = `${zpath}.rooms[${r}]`;
            if (!isObj(room)) {
              issues.push(`${rpath}: must be an object`);
              return;
            }
            if (!isNonEmptyString(room.name)) {
              issues.push(`${rpath}.name: required non-empty string`);
            }
            if (room.code !== undefined && typeof room.code !== 'string') {
              issues.push(`${rpath}.code: must be a string`);
            }
            if (room.type !== undefined && typeof room.type !== 'string') {
              issues.push(`${rpath}.type: must be a string`);
            }
            if (room.hours !== undefined && typeof room.hours !== 'string') {
              issues.push(`${rpath}.hours: must be a string`);
            }
          });
        }
      }
      // T-058a (R14, design-consent-semantics.md §3.1): the owner-authored
      // zone consent class — 'supervised' zones force-escalate proposals
      // touching them (same enum as the server / scenario JSON channels).
      if (
        zone.consentClass !== undefined &&
        !ZONE_CONSENT_CLASSES.includes(zone.consentClass as string)
      ) {
        issues.push(
          `${zpath}.consentClass: must be one of ${ZONE_CONSENT_CLASSES.join(' | ')} — got ${JSON.stringify(zone.consentClass)}`,
        );
      }
      if (zone.buildingId !== undefined && typeof zone.buildingId !== 'string') {
        issues.push(`${zpath}.buildingId: must be a string`);
      }
      if (zone.floor !== undefined && (!isFiniteNumber(zone.floor) || !Number.isInteger(zone.floor))) {
        issues.push(`${zpath}.floor: must be an integer`);
      }
      if (zone.occupancy !== undefined && (!isFiniteNumber(zone.occupancy) || (zone.occupancy as number) < 0)) {
        issues.push(`${zpath}.occupancy: must be a number >= 0`);
      }
      if (zone.envelopeU !== undefined && !isFiniteNumber(zone.envelopeU)) {
        issues.push(`${zpath}.envelopeU: must be a number`);
      }
      // Zone field set mirrors the core scenario schema (scenario-schema.ts)
      // — the CLI world document must round-trip every field a bundled
      // scenario may carry (the gallery refresh shipped occupantSchedule on
      // refreshed templates and broke export→apply before this sync).
      if (zone.occupantSchedule !== undefined) {
        const sched = zone.occupantSchedule;
        if (!isObj(sched)) {
          issues.push(`${zpath}.occupantSchedule: must be an object`);
        } else {
          for (const key of ['count', 'startSimTimeSec', 'endSimTimeSec']) {
            if (!isFiniteNumber(sched[key])) {
              issues.push(`${zpath}.occupantSchedule.${key}: must be a number`);
            }
          }
          if (isFiniteNumber(sched.count) && (sched.count as number) < 0) {
            issues.push(`${zpath}.occupantSchedule.count: must be >= 0`);
          }
          if (sched.repeatDaily !== undefined && typeof sched.repeatDaily !== 'boolean') {
            issues.push(`${zpath}.occupantSchedule.repeatDaily: must be a boolean`);
          }
        }
      }
      if (zone.glassAreaM2 !== undefined && (!isFiniteNumber(zone.glassAreaM2) || (zone.glassAreaM2 as number) < 0)) {
        issues.push(`${zpath}.glassAreaM2: must be a number >= 0`);
      }
      if (
        zone.ambientBuffer !== undefined &&
        (!isFiniteNumber(zone.ambientBuffer) ||
          (zone.ambientBuffer as number) < 0 ||
          (zone.ambientBuffer as number) > 1)
      ) {
        issues.push(`${zpath}.ambientBuffer: must be a number in [0, 1]`);
      }
      if (zone.bounds !== undefined) validateBounds(zone.bounds, `${zpath}.bounds`, issues);
      if (zone.polygon !== undefined) validatePolygon(zone.polygon, `${zpath}.polygon`, issues);
      if (zone.adjacentZoneIds !== undefined && !isStringArray(zone.adjacentZoneIds)) {
        issues.push(`${zpath}.adjacentZoneIds: must be an array of zone ids`);
      }
      if (zone.baseline !== undefined && !isObj(zone.baseline)) {
        issues.push(`${zpath}.baseline: must be an object of parameter values`);
      }
      if (type === 'geo' && zone.polygon === undefined) {
        issues.push(`${zpath}.polygon: required for geo maps (>= 3 [lat, lng] points)`);
      }
    });
  }
  if (type === 'geo') {
    if (!isObj(map.center) || !isFiniteNumber(map.center.lat) || !isFiniteNumber(map.center.lng)) {
      issues.push(`${path}.center: required for geo maps, must be {lat, lng}`);
    }
    if (map.zoom !== undefined && (!isFiniteNumber(map.zoom) || (map.zoom as number) < 1 || (map.zoom as number) > 19)) {
      issues.push(`${path}.zoom: must be a number in 1..19`);
    }
  }

  if (map.demo !== undefined) validateDemoBlock(map.demo, `${path}.demo`, issues);
}

function validateDevice(device: unknown, path: string, issues: string[]): void {
  if (!isObj(device)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkUnknownKeys(device, DEVICE_KEYS, path, issues);
  const hasModel = isNonEmptyString(device.model);
  const hasSpec = isObj(device.spec);
  if (device.model !== undefined && !hasModel) issues.push(`${path}.model: must be a non-empty catalog model id`);
  if (device.spec !== undefined && !hasSpec) issues.push(`${path}.spec: must be an object`);
  if (hasModel === hasSpec) {
    issues.push(`${path}: exactly one of "model" or "spec" is required`);
  }
  if (hasSpec) {
    const spec = device.spec as Obj;
    checkUnknownKeys(spec, SPEC_KEYS, `${path}.spec`, issues);
    if (!isNonEmptyString(spec.type)) issues.push(`${path}.spec.type: required non-empty string`);
    if (spec.brand !== undefined && typeof spec.brand !== 'string') {
      issues.push(`${path}.spec.brand: must be a string`);
    }
    if (!Array.isArray(spec.capabilities) || !isStringArray(spec.capabilities)) {
      issues.push(`${path}.spec.capabilities: required array of strings`);
    }
  }
  if (device.name !== undefined && !isNonEmptyString(device.name)) {
    issues.push(`${path}.name: must be a non-empty string`);
  }
  if (!hasModel && device.name === undefined) {
    issues.push(`${path}.name: required when using "spec" (it is the upsert identity)`);
  }
  if (!isNonEmptyString(device.zone)) {
    issues.push(`${path}.zone: required zone id`);
  }
  if (device.position !== undefined && !isObj(device.position)) {
    issues.push(`${path}.position: must be an object (geo: {lat, lng}; grid: {x, y})`);
  }
  if (device.initialState !== undefined && !isObj(device.initialState)) {
    issues.push(`${path}.initialState: must be an object`);
  }
}

function validateBounds(bounds: unknown, path: string, issues: string[]): void {
  if (!isObj(bounds)) {
    issues.push(`${path}: must be an object {minX, maxX, minY, maxY}`);
    return;
  }
  for (const key of ['minX', 'maxX', 'minY', 'maxY']) {
    if (!isFiniteNumber(bounds[key])) issues.push(`${path}.${key}: must be a number`);
  }
}

function validatePolygon(polygon: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(polygon)) {
    issues.push(`${path}: must be an array of [lat, lng] points`);
    return;
  }
  if (polygon.length < 3) issues.push(`${path}: must have at least 3 points`);
  polygon.forEach((point, i) => {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !isFiniteNumber(point[0]) ||
      !isFiniteNumber(point[1])
    ) {
      issues.push(`${path}[${i}]: must be a [lat, lng] pair of numbers`);
    }
  });
}

function validateDemoBlock(demo: unknown, path: string, issues: string[]): void {
  if (!isObj(demo)) {
    issues.push(`${path}: must be an object (tagline/heroEventId/recommendedPlaybackRate/vendorDisclaimer)`);
    return;
  }
  if (demo.tagline !== undefined) {
    const t = demo.tagline;
    if (!isObj(t) || typeof t.zh !== 'string' || typeof t.en !== 'string') {
      issues.push(`${path}.tagline: must be a {zh, en} object of strings`);
    }
  }
  if (demo.heroEventId !== undefined && typeof demo.heroEventId !== 'string') {
    issues.push(`${path}.heroEventId: must be a string`);
  }
  if (
    demo.recommendedPlaybackRate !== undefined &&
    (!isFiniteNumber(demo.recommendedPlaybackRate) || (demo.recommendedPlaybackRate as number) <= 0)
  ) {
    issues.push(`${path}.recommendedPlaybackRate: must be a positive number`);
  }
  if (
    demo.vendorDisclaimer !== undefined &&
    typeof demo.vendorDisclaimer !== 'string' && !isObj(demo.vendorDisclaimer)
  ) {
    issues.push(`${path}.vendorDisclaimer: must be a string or {zh, en}`);
  }
}

function validateFlowsArray(flows: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(flows)) {
    issues.push(`${path}: must be an array of flow definitions`);
    return;
  }
  flows.forEach((flow, i) => {
    const fpath = `${path}[${i}]`;
    if (!isObj(flow)) {
      issues.push(`${fpath}: must be an object`);
      return;
    }
    if (typeof flow.name !== 'string' || (flow.name as string).length === 0) {
      issues.push(`${fpath}.name: must be a non-empty string`);
    }
    if (!isObj(flow.trigger)) issues.push(`${fpath}.trigger: must be an object`);
    if (!isObj(flow.plan)) issues.push(`${fpath}.plan: must be an object`);
    if (flow.enabled !== undefined && typeof flow.enabled !== 'boolean') {
      issues.push(`${fpath}.enabled: must be a boolean`);
    }
  });
}

function checkUnknownKeys(obj: Obj, allowed: string[], path: string, issues: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      issues.push(`${path ? `${path}.` : ''}${key}: unknown field (allowed: ${allowed.join(', ')})`);
    }
  }
}
