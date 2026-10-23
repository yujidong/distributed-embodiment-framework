/**
 * World document — the declarative, versioned description of an
 * environment (kubectl-style). YAML or JSON on disk (by extension);
 * validated by validate.ts; applied by apply.ts; produced by export.ts.
 *
 * Canonical shape (version "1.0"):
 *
 * ```yaml
 * version: "1.0"
 * environment:
 *   name: my-world
 *   description?: ...
 *   visibility?: public|private
 *   map:                        # required to CREATE an environment
 *     type: grid|geo
 *     center?: {lat, lng}       # geo only
 *     zoom?: 1..19              # geo only
 *     storeyHeight? / slabAttenuation? / envelopeU? / occupancyHeatW? / occupancyCo2Rate?
 *     zones: [{id, name?, type?, consentClass?, buildingId?, floor?, occupancy?,
 *              envelopeU?, bounds?|polygon?, baseline?, adjacentZoneIds?}]
 * devices: [{model: <catalogId> | spec: {type, brand?, capabilities},
 *            name?, zone, position?}]
 * agents:  [{name, capabilities, bind?: [device names], zones?: [ids], llm?}]
 * events:  [{id, type, zoneId, parameter?, value?, severity?, atSimTimeSec?}]
 * simulation: {llm?: auto|llm|none, speed?, tickMs?}   # optional plan
 * ```
 */

import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import { usageError } from '../errors.js';
import type { IO } from '../io.js';

export interface WorldMapZone {
  id: string;
  name?: string;
  type?: string;
  /** T-058a (R14): zone consent class — 'supervised' zones force-escalate proposals touching them. */
  consentClass?: 'standard' | 'supervised' | 'restricted';
  /** Building tier: owning building id. */
  buildingId?: string;
  /** Building tier: storey number (0 = ground). */
  floor?: number;
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
  polygon?: [number, number][];
  /** Building tier: current headcount (occupancy effect sources). */
  occupancy?: number;
  /** Building tier: per-zone envelope flux multiplier (indoor↔outdoor). */
  envelopeU?: number;
  adjacentZoneIds?: string[];
  baseline?: Record<string, number | boolean>;
  /**
   * R82: declarative rooms — world metadata the server validates
   * structurally (scenario-loader) and never interprets. Round-trips through
   * `env export` → `apply` like every other zone field.
   */
  rooms?: WorldRoom[];
}

/** R82: one declarative room of a zone (metadata only — never interpreted). */
export interface WorldRoom {
  /** Non-empty display name. */
  name: string;
  code?: string;
  type?: string;
  hours?: string;
}

/**
 * Canonical map-level building/physics metadata fields (Fix-2). Mirrored by
 * the server's MAP_META_FIELDS; a new meta field is added HERE once and
 * flows through validation, export, and apply.
 */
export const MAP_META_FIELDS = [
  'storeyHeight',
  'slabAttenuation',
  'envelopeU',
  'occupancyHeatW',
  'occupancyCo2Rate',
] as const;

export type MapMetaField = (typeof MAP_META_FIELDS)[number];

export interface WorldMap {
  type: 'grid' | 'geo';
  center?: { lat: number; lng: number };
  zoom?: number;
  /** R40-B4: demo-playback metadata round-trips with the world document. */
  demo?: WorldDemoMeta;
  /** Building tier (B-A): floor-to-floor height in meters. */
  storeyHeight?: number;
  /** Building tier (B-A): cross-floor diffusion flux multiplier (0..1). */
  slabAttenuation?: number;
  /** Building tier (B-B): default envelope flux multiplier (indoor↔outdoor). */
  envelopeU?: number;
  /** Building tier (B-B): per-person sensible heat (W). */
  occupancyHeatW?: number;
  /** Building tier (B-B): per-person CO2 emission rate (ppm/s). */
  occupancyCo2Rate?: number;
  zones: WorldMapZone[];
}

export interface WorldEnvironment {
  name: string;
  description?: string;
  visibility?: 'public' | 'private';
  map?: WorldMap;
}

/**
 * Demo-playback metadata (T-032) — rides the map block exactly like the
 * server's mapData.demo (accepted by parseDemoInput on create AND patch).
 * R40-B4: exported/imported so gallery worlds survive CLI round-trips.
 */
export interface WorldDemoMeta {
  tagline?: { zh: string; en: string };
  heroEventId?: string;
  recommendedPlaybackRate?: number;
  vendorDisclaimer?: string | { zh: string; en: string };
}

/**
 * A user-orchestrated flow in the WORLD DOCUMENT (R40-B4) — the wire shape
 * POST /api/environments/:id/flows accepts (name-required; ids are runtime
 * row ids and never exported).
 */
export interface WorldFlow {
  name: string;
  description?: string;
  enabled?: boolean;
  trigger: Record<string, unknown>;
  plan: Record<string, unknown>;
  inputs?: unknown[];
  policy?: Record<string, unknown>;
  agentInvocable?: boolean;
}

export interface WorldDeviceSpec {
  type: string;
  brand?: string;
  capabilities: string[];
}

export interface WorldDevice {
  /** Catalog model id — mutually exclusive with `spec`. */
  model?: string;
  spec?: WorldDeviceSpec;
  /** Identity for upsert-by-name. Optional with `model` (defaults to the
   *  catalog display name); required with `spec`. */
  name?: string;
  zone: string;
  position?: Record<string, unknown>;
  initialState?: Record<string, unknown>;
}

export interface WorldAgent {
  name: string;
  capabilities: string[];
  /** Device names (resolved within the env) or raw ids. */
  bind?: string[];
  /** Managed zone ids. */
  zones?: string[];
  llm?: Record<string, unknown>;
}

export interface WorldEvent {
  id: string;
  type: string;
  zoneId: string;
  parameter?: string;
  value?: number | boolean | string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  atSimTimeSec?: number;
  requiredCapabilities?: string[];
}

export interface WorldSimulation {
  llm?: 'auto' | 'llm' | 'none';
  speed?: number;
  tickMs?: number;
}

export interface WorldDocument {
  version: '1.0';
  environment: WorldEnvironment;
  devices?: WorldDevice[];
  agents?: WorldAgent[];
  events?: WorldEvent[];
  /** R40-B4: flows ride the document so export→apply round-trips them. */
  flows?: WorldFlow[];
  simulation?: WorldSimulation;
}

/** Read + parse a document file. JSON when the extension is .json, YAML otherwise. */
export function parseDocumentFile(io: IO, path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw usageError(`cannot read document file "${path}"`);
  }
  try {
    return path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw usageError(`cannot parse "${path}": ${message.split('\n')[0]}`);
  }
}
