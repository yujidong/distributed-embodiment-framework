/**
 * Environment store — shared worlds, their members, and their objects
 *
 * An environment is a persistent, multi-user world (product_design.md §11):
 * map data (zones, baked into `map_data_json` for the 'grid' map type),
 * device instances, and agent instances. Every instance is owned by its
 * creator (`owner_id`); environment membership carries a role
 * (owner/builder/viewer) that gates mutations.
 *
 * Multi-row writes (create + owner member, scenario import) run inside
 * better-sqlite3 transactions so a partial world is never persisted.
 */

import { randomUUID } from 'node:crypto';

import type { SemanticOfferRule } from '@active-collaboration/core';

import { ApiError } from '../errors.js';
import type { EafDatabase } from './database.js';

export type EnvVisibility = 'public' | 'private';
export type EnvRole = 'owner' | 'builder' | 'viewer';

/** Geographic reference point (WGS84 degrees). */
export interface EnvGeoCenter {
  lat: number;
  lng: number;
}

/**
 * T-058a (design-consent-semantics.md §3): a zone's consent class — the
 * governance attribute declaring WHO must consent to third-party changes
 * touching the zone. Authored by the env owner via mapData (PATCH mapData is
 * owner-only, FR-F02 — no new channel needed); rides map_data_json verbatim.
 */
export type ZoneConsentClass = 'standard' | 'supervised' | 'restricted';

export const ZONE_CONSENT_CLASSES: readonly ZoneConsentClass[] = [
  'standard',
  'supervised',
  'restricted',
];

/**
 * R82: declarative interior room inside a zone (mirrors core ScenarioRoom) —
 * descriptive world metadata authored from a source document (campus guide,
 * building directory); the runtime never interprets it, consumers render it
 * (web zone detail) and future NL/service layers may query it.
 */
export interface EnvRoom {
  code?: string;
  name: string;
  type?: string;
  hours?: string;
  /** Normalized [u, v] within the floor footprint bbox (0-1); see ScenarioRoom. */
  pos?: [number, number];
}

/** Zone shape baked into map_data ('grid' uses bounds; 'geo' uses polygon). */
export interface EnvZone {
  id: string;
  name?: string;
  type?: string;
  /** Building tier (B-A): owning building; absent = single-building world. */
  buildingId?: string;
  /** Building tier (B-A): storey number (0 = ground); absent = 0. */
  floor?: number;
  /**
   * T-058a: 'standard' (default — today's behavior) | 'supervised'
   * (proposals touching the zone ALWAYS escalate to the env owner; AI review
   * is advisory there) | 'restricted' (reserved enum value, not yet
   * enforced — future multi-person consent).
   */
  consentClass?: ZoneConsentClass;
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
  /** Geo map tier: zone outline as a [lat, lng] ring (>= 3 points). */
  polygon?: [number, number][];
  /** Building tier (B-B): current headcount (drives occupancy effect sources). */
  occupancy?: number;
  /**
   * Fix-52a: schedule-driven occupancy — the runtime auto-fires
   * setZoneOccupancy at the window boundaries (start → count, end → 0;
   * repeatDaily default true). Writable at runtime via the env-level
   * occupant-schedule PATCH (FEAT-07); rides the scenario zone verbatim.
   */
  occupantSchedule?: {
    count: number;
    startSimTimeSec: number;
    endSimTimeSec: number;
    repeatDaily?: boolean;
  };
  /**
   * FEAT-07 phase-2 (calendar overlay): a TEMPORARY timetable replacing the
   * base occupantSchedule inside the absolute sim-time window
   * `[startsAtSimSec, endsAtSimSec)` (exam-week extended hours); the base
   * timetable governs again at the window end. Writable at runtime via the
   * occupant-schedule PATCH (`overlay` field); rides the scenario zone
   * verbatim.
   */
  occupantScheduleOverlay?: {
    schedule: {
      count: number;
      startSimTimeSec: number;
      endSimTimeSec: number;
      repeatDaily?: boolean;
    };
    startsAtSimSec: number;
    endsAtSimSec: number;
  };
  /** Building tier (B-B): per-zone envelope flux multiplier (indoor↔outdoor). */
  envelopeU?: number;
  adjacentZoneIds?: string[];
  baseline?: Record<string, number | boolean>;
  /** R82: declarative interior rooms (passthrough — rides map_data verbatim). */
  rooms?: EnvRoom[];
}

/**
 * Plan-image underlay for one storey (B-D): a floor-plan raster (http(s)
 * URL or data URI) rendered behind the zone layer on the grid map. The
 * image's top-left pixel sits at world (0,0); `pixelsPerMeter` converts
 * image pixels to world meters (the frontend renders at 64 px/m).
 */
export interface EnvFloorPlan {
  buildingId?: string;
  floor: number;
  image: string;
  pixelsPerMeter: number;
}

/**
 * Scheduled event baked into an environment's map data (scenario event wire
 * format). The environment bridge emits these as scenario events so
 * environment-backed simulations fire them on schedule.
 */
export interface EnvMapEvent {
  id: string;
  type: string;
  zoneId: string;
  parameter?: string;
  value?: number | boolean | string;
  atSimTimeSec?: number;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  requiredCapabilities?: string[];
}

/**
 * Canonical map-level building/physics metadata fields (Fix-2, RC-2). Every
 * conversion point (import, bridge, detail view, parseMapData) reads this
 * list, so a new meta field is added HERE once and flows everywhere.
 * Mirrors the optional numeric fields of the core scenario `meta` block.
 */
export const MAP_META_FIELDS = [
  'storeyHeight',
  'slabAttenuation',
  'envelopeU',
  'occupancyHeatW',
  'occupancyCo2Rate',
] as const;

export type MapMetaField = (typeof MAP_META_FIELDS)[number];

/**
 * T-032 (DevLoop R17, EC-F09): demo-playback metadata — the template/
 * scenario `meta` fields the demo player consumes (tagline, hero event,
 * playback-rate hint, vendor disclaimer). They used to die at the
 * template→env import because envs had no home for non-numeric meta; they
 * live in map data (like events/floorPlans) so import → detail view →
 * bridge/export all carry them with one field.
 */
export interface EnvDemoMeta {
  /** Marketing tagline (bilingual). */
  tagline?: { zh: string; en: string };
  /** Event id the demo UI should auto-focus (the "hero moment"). */
  heroEventId?: string;
  /** Playback-rate hint for the demo player (1 = real-time). */
  recommendedPlaybackRate?: number;
  /** Illustrative-vendor disclaimer (bilingual object or plain string). */
  vendorDisclaimer?: { zh: string; en: string } | string;
}

export interface EnvMapData {
  zones: EnvZone[];
  /** Geo map tier: projection origin + default map view center. */
  center?: EnvGeoCenter;
  /** Geo map tier: default map zoom (Leaflet scale). */
  zoom?: number;
  /** Building tier (B-A): floor-to-floor height in meters (physics z). */
  storeyHeight?: number;
  /** Building tier (B-A): cross-floor diffusion flux multiplier (0..1). */
  slabAttenuation?: number;
  /** Building tier (B-B): default envelope flux multiplier (indoor↔outdoor). */
  envelopeU?: number;
  /** Building tier (B-B): per-person sensible heat (W) for occupancy sources. */
  occupancyHeatW?: number;
  /** Building tier (B-B): per-person CO2 emission rate (ppm/s) for occupancy sources. */
  occupancyCo2Rate?: number;
  /** Scheduled events baked into the world (bridged into scenario events). */
  events?: EnvMapEvent[];
  /** Building tier (B-D): per-storey plan-image underlays for the grid map. */
  floorPlans?: EnvFloorPlan[];
  /** T-032: demo-playback metadata (tagline / heroEventId / …). */
  demo?: EnvDemoMeta;
  /**
   * P3: scenario-authored semantic offer rules imported with the world —
   * merged over the built-in rule table wherever aggregate offers are
   * derived (ServiceStore.syncAggregateOffers at import/rebind; the runtime
   * face via the bridge → EngineRuntime). Rides map_data like events.
   */
  semanticOfferRules?: SemanticOfferRule[];
  /**
   * P3: scenario capability synonym groups — re-registered into the
   * process-level registry at every load (import / bridge), so a fresh
   * process recovers the world's matching vocabulary from storage.
   */
  capabilitySynonyms?: string[][];
  /**
   * T-053: env-level demo visibility mode for DERIVED services. 'public'
   * (only meaningful on a public environment) makes members-visible DERIVED
   * rows readable by anonymous visitors — a public teaching world's demo
   * surface. Default 'members' (the T-208 boundary). Published offers and
   * hidden derived rows are NEVER affected.
   */
  derivedServiceVisibility?: 'members' | 'public';
  /**
   * S1 (Task 3): owner-authored governance policy block — currently the
   * human-review breadth thresholds (`humanReview.maxAgentsPerProposal` /
   * `maxEventsPerProposal` / `maxZonesTouched`; 0 = class disarmed). Same
   * authoring lane as zone consentClass: OWNER-only PATCH mapData (a
   * proposal may never arm it). Validated in parseMapDataInput.
   */
  governance?: {
    humanReview?: {
      maxAgentsPerProposal?: number;
      maxEventsPerProposal?: number;
      maxZonesTouched?: number;
    };
    /**
     * C3 (R42-B, devloop-r41-a1 §8.3): the world's ownership plan —
     * 'importer' (default, legacy) = template imports land everything on
     * the importer, theirs to keep or hand over; 'members' = the importer
     * declares a multi-stakeholder world — members may CLAIM unassigned
     * objects (still owned by the env owner) through ownership-transfer
     * proposals. Set by the import body (`ownershipPlan`) or the owner's
     * PATCH mapData lane.
     */
    ownershipPlan?: 'importer' | 'members';
    /**
     * R6-C-F02: the env-wide escape hatch for the signing-time contract
     * zone-reachability gate (terms.targetZoneId vs the provider backing
     * devices' zones). Default ON (absent = enforce); false disarms it —
     * demo fallback only, same owner-only PATCH mapData lane as the rest of
     * the governance block.
     */
    contractReachabilityCheck?: boolean;
  };
}

export interface EnvironmentRow {
  id: string;
  name: string;
  description: string;
  map_type: string;
  map_data_json: string;
  owner_id: string;
  visibility: EnvVisibility;
  /** Fix-19: the owner's structured world guide (JSON), NULL = no guide. */
  guide_json: string | null;
  /**
   * T122 (R17-u3 / R19-u4): the owner's default-simulation binding — the sim
   * the env's default-lane calls (ask/what-if/read) target while it is
   * RUNNING. NULL = no binding; a binding naming a stopped/deleted sim is
   * inert (the lanes fall back + disclose, never silently switch worlds).
   */
  default_simulation_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Fix-19 latecomer onboarding: the owner-written structured guide to the
 * world. All fields optional text; `roleGuide` carries per-role directions
 * (what a builder / a viewer can do here).
 */
export interface EnvGuide {
  purpose?: string;
  zoneGuide?: string;
  roleGuide?: { builder?: string; viewer?: string };
  serviceMap?: string;
}

export interface EnvMemberRow {
  env_id: string;
  user_id: string;
  role: EnvRole;
}

/**
 * T-021: the persisted device role domain — same values as core
 * ScenarioDevice.role ('sensor' | 'actuator' | 'hybrid').
 */
export type DeviceRoleValue = 'sensor' | 'actuator' | 'hybrid';

/** T-021: parse + validate a persisted role column value. */
export function parseDeviceRoleColumn(
  value: string | null | undefined,
): DeviceRoleValue | null {
  if (value === null || value === undefined || value === '') return null;
  if (value === 'sensor' || value === 'actuator' || value === 'hybrid') return value;
  throw new ApiError(
    400,
    'BAD_REQUEST',
    `Device role must be one of sensor|actuator|hybrid, got "${value}"`,
  );
}

export interface DeviceInstanceRow {
  id: string;
  env_id: string;
  owner_id: string;
  name: string;
  type: string;
  brand: string | null;
  capabilities_json: string;
  zone_id: string;
  position_json: string | null;
  initial_state_json: string | null;
  /** Backend binding URI (P3b); NULL = the sim:// default for this device. */
  binding: string | null;
  /**
   * T-021 (migration v35): sensor/actuator/hybrid classification persisted
   * from the scenario definition. NULL = infer from capabilities at the
   * bridge (legacy rows; identical outcome today, so the value was latent).
   */
  role: string | null;
  /** Fix-38: blueprint lineage (NULL = not installed from a blueprint). */
  installed_from: string | null;
  created_at: string;
}

export interface AgentInstanceRow {
  id: string;
  env_id: string;
  owner_id: string;
  name: string;
  capabilities_json: string;
  bound_device_ids_json: string;
  managed_zone_ids_json: string;
  llm_json: string | null;
  /**
   * T-021 (migration v35): scope-of-practice blocklist
   * (`["controlled-substance-dispense", …]`, JSON string array) — consumed
   * by PartnerSelectionNegotiator to drop candidates without regulatory
   * authority for a required capability class. NULL = no restriction.
   */
  cannot_deliver_classes_json: string | null;
  /** Master enable switch (migration v21; 1 = enabled, 0 = stopped). */
  enabled: number;
  /**
   * Per-agent autonomous-decision policy (migration v29, T-051):
   * { autoActuateIndependent?, autoInitiateAC? } — null keeps the
   * runtime-wide defaults.
   */
  decision_policy_json: string | null;
  /**
   * R15 (FR15-F02, migration v34): default visibility for services derived
   * from this agent's bindings in the FUTURE ('members' | 'hidden'; NULL =
   * the T-208 'members' default). Declared at install so sensitive
   * per-device services can be born hidden instead of members-visible
   * until a later PATCH. Applies to newly derived rows only — the
   * provider's per-service visibility PATCHes keep winning on surviving
   * rows.
   */
  derived_service_visibility: string | null;
  /** Fix-38: blueprint lineage (NULL = not installed from a blueprint). */
  installed_from: string | null;
  created_at: string;
}

export interface CreateEnvironmentInput {
  name: string;
  description?: string;
  mapType?: string;
  mapData?: EnvMapData;
  ownerId: string;
  visibility?: EnvVisibility;
}

export interface CreateDeviceInput {
  envId: string;
  ownerId: string;
  name: string;
  type: string;
  brand?: string | null;
  capabilities: string[];
  zoneId: string;
  position?: Record<string, unknown> | null;
  initialState?: Record<string, unknown> | null;
  /**
   * Deployment binding (sim:// | hass://). T-110: the scenario import path
   * passes the loader-validated binding through instead of silently
   * swapping real hardware for a simulated twin.
   */
  binding?: string | null;
  /**
   * T-021: explicit sensor/actuator/hybrid role (from the scenario
   * definition; undefined/null = infer from capabilities at the bridge).
   */
  role?: DeviceRoleValue | null;
  /** Fix-38: blueprint lineage for whole-blueprint uninstall. */
  installedFrom?: string | null;
}

export interface CreateAgentInput {
  envId: string;
  ownerId: string;
  name: string;
  capabilities: string[];
  boundDeviceIds?: string[];
  managedZoneIds?: string[];
  llm?: Record<string, unknown> | null;
  /**
   * T-021: scope-of-practice blocklist — capability classes this agent must
   * NOT be selected to deliver even though `capabilities` lists them
   * (PartnerSelectionNegotiator filters candidates on it). Undefined/null =
   * no restriction.
   */
  cannotDeliverClasses?: string[] | null;
  /** T-051: per-agent autonomous-decision policy (nullable = defaults). */
  decisionPolicy?: Record<string, unknown> | null;
  /**
   * R15 (FR15-F02): default visibility for FUTURE derived services
   * ('members' | 'hidden'; absent = the T-208 'members' default).
   */
  derivedServiceVisibility?: 'members' | 'hidden' | null;
  /** Fix-38: blueprint lineage. */
  installedFrom?: string | null;
}

export class EnvironmentStore {
  constructor(private readonly db: EafDatabase) {}

  /** Run `fn` inside a database transaction (savepoint-safe when nested). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // -------------------------------------------------------------------------
  // Environments
  // -------------------------------------------------------------------------

  /** Create an environment and register the creator as its owner member. */
  createEnvironment(input: CreateEnvironmentInput): EnvironmentRow {
    const now = new Date().toISOString();
    const row: EnvironmentRow = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? '',
      map_type: input.mapType ?? 'grid',
      map_data_json: JSON.stringify(input.mapData ?? { zones: [] }),
      owner_id: input.ownerId,
      visibility: input.visibility ?? 'private',
      guide_json: null,
      default_simulation_id: null,
      created_at: now,
      updated_at: now,
    };
    this.db.transaction(() => {
      this.insertEnvironment(row);
      this.insertMember(row.id, row.owner_id, 'owner');
    })();
    return row;
  }

  getEnvironment(id: string): EnvironmentRow | undefined {
    return this.db.prepare('SELECT * FROM environments WHERE id = ?').get(id) as
      | EnvironmentRow
      | undefined;
  }

  // -------------------------------------------------------------------------
  // Counts (P4-4 quotas + observability)
  // -------------------------------------------------------------------------

  /** Environments OWNED by the user (the environments_per_user quota usage). */
  countEnvironmentsOwnedBy(userId: string): number {
    return this.count('SELECT COUNT(*) AS n FROM environments WHERE owner_id = ?', userId);
  }

  /**
   * R75: how many OTHER environments the user owns with exactly this name —
   * the duplicate-name teaching warning's data (same-name worlds are legal
   * but must not be silent; the public list cannot disambiguate them).
   */
  countOwnedEnvironmentsWithName(userId: string, name: string, excludeEnvId?: string): number {
    return this.count(
      'SELECT COUNT(*) AS n FROM environments WHERE owner_id = ? AND name = ? AND id != ?',
      userId, name, excludeEnvId ?? '',
    );
  }

  /** Device instances in one environment (the devices_per_env quota usage). */
  countDevicesIn(envId: string): number {
    return this.count('SELECT COUNT(*) AS n FROM device_instances WHERE env_id = ?', envId);
  }

  /** Agent instances in one environment (the agents_per_env quota usage). */
  countAgentsIn(envId: string): number {
    return this.count('SELECT COUNT(*) AS n FROM agent_instances WHERE env_id = ?', envId);
  }

  /**
   * Largest device count across environments the user OWNS (0 when they own
   * none) — the binding per-env usage number for /api/me/quotas.
   */
  maxDevicesInOwnedEnvs(userId: string): number {
    return this.maxInOwnedEnvs('device_instances', userId);
  }

  /** Largest agent count across environments the user OWNS (see above). */
  maxAgentsInOwnedEnvs(userId: string): number {
    return this.maxInOwnedEnvs('agent_instances', userId);
  }

  private maxInOwnedEnvs(table: 'device_instances' | 'agent_instances', userId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(per_env), 0) AS m FROM (
           SELECT COUNT(*) AS per_env FROM ${table} t
           JOIN environments e ON e.id = t.env_id
           WHERE e.owner_id = ?
           GROUP BY t.env_id
         )`,
      )
      .get(userId) as { m: number };
    return row.m;
  }

  /** Global row counts for the observability endpoints. */
  countAllEnvironments(): number {
    return this.count('SELECT COUNT(*) AS n FROM environments');
  }

  countAllDevices(): number {
    return this.count('SELECT COUNT(*) AS n FROM device_instances');
  }

  countAllAgents(): number {
    return this.count('SELECT COUNT(*) AS n FROM agent_instances');
  }

  private count(sql: string, ...params: string[]): number {
    return (this.db.prepare(sql).get(...params) as { n: number }).n;
  }

  /** Lookup by exact name (used by template seeding for idempotency). */
  findEnvironmentByName(name: string): EnvironmentRow | undefined {
    return this.db.prepare('SELECT * FROM environments WHERE name = ?').get(name) as
      | EnvironmentRow
      | undefined;
  }

  /**
   * Lookup by exact name AND owner — the template-seeding identity. User
   * copies with a colliding name are invisible here, so they never shadow
   * the system-owned gallery template (see db/seed.ts).
   */
  findEnvironmentByNameAndOwner(name: string, ownerId: string): EnvironmentRow | undefined {
    return this.db
      .prepare('SELECT * FROM environments WHERE name = ? AND owner_id = ?')
      .get(name, ownerId) as EnvironmentRow | undefined;
  }

  /**
   * Environments visible to a user: everything they belong to, plus every
   * public environment. `my_role` is the user's member role, or null when
   * they only see it because it is public.
   */
  listVisibleFor(userId: string): (EnvironmentRow & { my_role: EnvRole | null })[] {
    return this.db
      .prepare(
        `SELECT e.*, m.role AS my_role
         FROM environments e
         LEFT JOIN env_members m ON m.env_id = e.id AND m.user_id = ?
         WHERE e.visibility = 'public' OR m.user_id IS NOT NULL
         ORDER BY e.created_at ASC`,
      )
      .all(userId) as (EnvironmentRow & { my_role: EnvRole | null })[];
  }

  /**
   * R15-D2: only the environments the user BELONGS to (any role). The list
   * endpoint's default — a shared deployment's public catalog can grow far
   * beyond one user's worlds, and "mine first" is what the workbench means.
   */
  listMineFor(userId: string): (EnvironmentRow & { my_role: EnvRole })[] {
    return this.db
      .prepare(
        `SELECT e.*, m.role AS my_role
         FROM environments e
         JOIN env_members m ON m.env_id = e.id AND m.user_id = ?
         ORDER BY e.created_at ASC`,
      )
      .all(userId) as (EnvironmentRow & { my_role: EnvRole })[];
  }

  updateEnvironment(
    id: string,
    patch: {
      name?: string;
      description?: string;
      visibility?: EnvVisibility;
      mapData?: EnvMapData;
      /** Fix-19: structured world guide; null clears it. */
      guide?: EnvGuide | null;
      /**
       * T122: the owner's default-simulation binding; null clears it. The
       * ROUTE validates existence/ownership (sim of this env, running not
       * required at bind time) — the store stores the reference as given.
       */
      defaultSimulationId?: string | null;
    },
  ): EnvironmentRow {
    const existing = this.getEnvironment(id);
    if (!existing) {
      throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${id}" not found`);
    }
    const next: EnvironmentRow = {
      ...existing,
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      visibility: patch.visibility ?? existing.visibility,
      map_data_json:
        patch.mapData !== undefined ? JSON.stringify(patch.mapData) : existing.map_data_json,
      guide_json:
        patch.guide !== undefined
          ? patch.guide != null
            ? JSON.stringify(patch.guide)
            : null
          : existing.guide_json,
      default_simulation_id:
        patch.defaultSimulationId !== undefined
          ? patch.defaultSimulationId
          : existing.default_simulation_id,
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE environments
         SET name = ?, description = ?, visibility = ?, map_data_json = ?, guide_json = ?,
             default_simulation_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name, next.description, next.visibility, next.map_data_json, next.guide_json,
        next.default_simulation_id, next.updated_at, id,
      );
    return next;
  }

  /** Delete an environment; members + instances cascade in the database. */
  deleteEnvironment(id: string): void {
    this.db.prepare('DELETE FROM environments WHERE id = ?').run(id);
  }

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  membersOf(envId: string): EnvMemberRow[] {
    return this.db
      .prepare('SELECT * FROM env_members WHERE env_id = ? ORDER BY rowid ASC')
      .all(envId) as EnvMemberRow[];
  }

  roleOf(envId: string, userId: string): EnvRole | undefined {
    const row = this.db
      .prepare('SELECT role FROM env_members WHERE env_id = ? AND user_id = ?')
      .get(envId, userId) as { role: EnvRole } | undefined;
    return row?.role;
  }

  addMember(envId: string, userId: string, role: EnvRole): void {
    this.insertMember(envId, userId, role);
  }

  /** Change a member's role (Fix-4 member management). Caller gates owner. */
  updateMemberRole(envId: string, userId: string, role: EnvRole): void {
    this.db
      .prepare('UPDATE env_members SET role = ? WHERE env_id = ? AND user_id = ?')
      .run(role, envId, userId);
  }

  removeMember(envId: string, userId: string): void {
    this.db.prepare('DELETE FROM env_members WHERE env_id = ? AND user_id = ?').run(envId, userId);
  }

  // -------------------------------------------------------------------------
  // Device instances
  // -------------------------------------------------------------------------

  createDevice(input: CreateDeviceInput): DeviceInstanceRow {
    const row: DeviceInstanceRow = {
      id: randomUUID(),
      env_id: input.envId,
      owner_id: input.ownerId,
      name: input.name,
      type: input.type,
      brand: input.brand ?? null,
      capabilities_json: JSON.stringify(input.capabilities),
      zone_id: input.zoneId,
      position_json: input.position != null ? JSON.stringify(input.position) : null,
      initial_state_json: input.initialState != null ? JSON.stringify(input.initialState) : null,
      // T-110: imports carry the loader-validated binding; NULL stays the
      // sim:// default for every interactive/API path.
      binding: input.binding ?? null,
      // T-021: explicit role from the scenario definition; NULL = infer at
      // the bridge (loader semantics preserved for legacy rows).
      role: input.role ?? null,
      // Fix-38: blueprint lineage — CreateDeviceInput.installedFrom passes
      // the blueprint id through; NULL = not installed from a blueprint.
      installed_from: input.installedFrom ?? null,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO device_instances
         (id, env_id, owner_id, name, type, brand, capabilities_json, zone_id,
          position_json, initial_state_json, binding, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.env_id, row.owner_id, row.name, row.type, row.brand,
        row.capabilities_json, row.zone_id, row.position_json, row.initial_state_json,
        row.binding, row.role, row.created_at,
      );
    return row;
  }

  getDevice(id: string): DeviceInstanceRow | undefined {
    return this.db.prepare('SELECT * FROM device_instances WHERE id = ?').get(id) as
      | DeviceInstanceRow
      | undefined;
  }

  devicesOf(envId: string): DeviceInstanceRow[] {
    return this.db
      .prepare('SELECT * FROM device_instances WHERE env_id = ? ORDER BY created_at ASC, id ASC')
      .all(envId) as DeviceInstanceRow[];
  }

  updateDevice(
    id: string,
    patch: {
      name?: string;
      type?: string;
      brand?: string | null;
      capabilities?: string[];
      zoneId?: string;
      position?: Record<string, unknown> | null;
      initialState?: Record<string, unknown> | null;
      /** New backend binding URI; null resets to the sim:// default. */
      binding?: string | null;
      /** T-021: explicit role; null resets to capability inference. */
      role?: DeviceRoleValue | null;
      /**
       * C3 (R42-B): governance-plane ownership handover (ownership-transfer
       * proposals + revert), plus the R46 (P0-1) import-time initialization
       * lane (environment-import.ts ownerAssignment) — the owner_id column
       * is the trust boundary the device-privacy rules and the device
       * command gate (R46 P0-2) key on. No runtime lane may set it.
       */
      ownerId?: string;
    },
  ): DeviceInstanceRow {
    const existing = this.getDevice(id);
    if (!existing) {
      throw new ApiError(404, 'DEVICE_NOT_FOUND', `Device "${id}" not found`);
    }
    const next: DeviceInstanceRow = {
      ...existing,
      name: patch.name ?? existing.name,
      type: patch.type ?? existing.type,
      brand: patch.brand !== undefined ? patch.brand : existing.brand,
      capabilities_json:
        patch.capabilities !== undefined ? JSON.stringify(patch.capabilities) : existing.capabilities_json,
      zone_id: patch.zoneId ?? existing.zone_id,
      position_json:
        patch.position !== undefined
          ? patch.position != null ? JSON.stringify(patch.position) : null
          : existing.position_json,
      initial_state_json:
        patch.initialState !== undefined
          ? patch.initialState != null ? JSON.stringify(patch.initialState) : null
          : existing.initial_state_json,
      binding: patch.binding !== undefined ? patch.binding : existing.binding,
      role: patch.role !== undefined ? patch.role : existing.role,
      owner_id: patch.ownerId ?? existing.owner_id,
    };
    this.db
      .prepare(
        `UPDATE device_instances
         SET name = ?, type = ?, brand = ?, capabilities_json = ?, zone_id = ?,
             position_json = ?, initial_state_json = ?, binding = ?, role = ?, owner_id = ?
         WHERE id = ?`,
      )
      .run(
        next.name, next.type, next.brand, next.capabilities_json, next.zone_id,
        next.position_json, next.initial_state_json, next.binding, next.role, next.owner_id, id,
      );
    return next;
  }

  deleteDevice(id: string): void {
    this.db.prepare('DELETE FROM device_instances WHERE id = ?').run(id);
  }

  /**
   * Re-insert a previously snapshotted device row with its ORIGINAL id and
   * binding (Fix-7: the revert of a remove-devices proposal restores exactly
   * what the apply deleted, so references that survived — replay material,
   * audit entries — resolve again).
   */
  restoreDevice(row: DeviceInstanceRow): DeviceInstanceRow {
    this.db
      .prepare(
        `INSERT INTO device_instances
         (id, env_id, owner_id, name, type, brand, capabilities_json, zone_id,
          position_json, initial_state_json, binding, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.env_id, row.owner_id, row.name, row.type, row.brand,
        row.capabilities_json, row.zone_id, row.position_json, row.initial_state_json,
        row.binding, row.role ?? null, row.created_at,
      );
    return row;
  }

  // -------------------------------------------------------------------------
  // Agent instances
  // -------------------------------------------------------------------------

  createAgent(input: CreateAgentInput): AgentInstanceRow {
    const row: AgentInstanceRow = {
      id: randomUUID(),
      env_id: input.envId,
      owner_id: input.ownerId,
      name: input.name,
      capabilities_json: JSON.stringify(input.capabilities),
      bound_device_ids_json: JSON.stringify(input.boundDeviceIds ?? []),
      managed_zone_ids_json: JSON.stringify(input.managedZoneIds ?? []),
      // T-601 (R26): explicit llm:null persists as the JSON string 'null' so
      // it stays distinguishable from "never authored" (SQL NULL). The bridge
      // parses it back to llm:null and EngineRuntime builds NO client for the
      // agent (rule-only by construction) instead of the shared fall-through.
      llm_json: input.llm !== undefined ? JSON.stringify(input.llm) : null,
      cannot_deliver_classes_json:
        input.cannotDeliverClasses != null && input.cannotDeliverClasses.length > 0
          ? JSON.stringify(input.cannotDeliverClasses)
          : null,
      enabled: 1,
      decision_policy_json: input.decisionPolicy != null ? JSON.stringify(input.decisionPolicy) : null,
      derived_service_visibility: input.derivedServiceVisibility ?? null,
      // Fix-38: blueprint lineage (NULL = not installed from a blueprint).
      installed_from: input.installedFrom ?? null,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO agent_instances
         (id, env_id, owner_id, name, capabilities_json, bound_device_ids_json,
          managed_zone_ids_json, llm_json, cannot_deliver_classes_json,
          enabled, decision_policy_json, derived_service_visibility, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.env_id, row.owner_id, row.name, row.capabilities_json,
        row.bound_device_ids_json, row.managed_zone_ids_json, row.llm_json,
        row.cannot_deliver_classes_json, row.enabled, row.decision_policy_json,
        row.derived_service_visibility, row.created_at,
      );
    return row;
  }

  getAgent(id: string): AgentInstanceRow | undefined {
    return this.db.prepare('SELECT * FROM agent_instances WHERE id = ?').get(id) as
      | AgentInstanceRow
      | undefined;
  }

  agentsOf(envId: string): AgentInstanceRow[] {
    return this.db
      .prepare('SELECT * FROM agent_instances WHERE env_id = ? ORDER BY created_at ASC, id ASC')
      .all(envId) as AgentInstanceRow[];
  }

  updateAgent(
    id: string,
    patch: {
      name?: string;
      capabilities?: string[];
      boundDeviceIds?: string[];
      managedZoneIds?: string[];
      llm?: Record<string, unknown> | null;
      /** T-021: scope-of-practice blocklist (null clears to no restriction). */
      cannotDeliverClasses?: string[] | null;
      /** Master enable switch (migration v21): agent start/stop. */
      enabled?: boolean;
      /** T-051: per-agent decision policy (null clears to defaults). */
      decisionPolicy?: Record<string, unknown> | null;
      /**
       * C3 (R42-B): governance-plane ownership handover (ownership-transfer
       * proposals + revert), plus the R46 (P0-1) import-time initialization
       * lane (environment-import.ts ownerAssignment). No runtime lane may
       * set it.
       */
      ownerId?: string;
    },
  ): AgentInstanceRow {
    const existing = this.getAgent(id);
    if (!existing) {
      throw new ApiError(404, 'AGENT_NOT_FOUND', `Agent "${id}" not found`);
    }
    const next: AgentInstanceRow = {
      ...existing,
      name: patch.name ?? existing.name,
      capabilities_json:
        patch.capabilities !== undefined ? JSON.stringify(patch.capabilities) : existing.capabilities_json,
      bound_device_ids_json:
        patch.boundDeviceIds !== undefined
          ? JSON.stringify(patch.boundDeviceIds)
          : existing.bound_device_ids_json,
      managed_zone_ids_json:
        patch.managedZoneIds !== undefined
          ? JSON.stringify(patch.managedZoneIds)
          : existing.managed_zone_ids_json,
      // T-601: patch.llm === null (explicit clear/opt-out) stores 'null';
      // undefined leaves the stored value untouched.
      llm_json:
        patch.llm !== undefined
          ? JSON.stringify(patch.llm)
          : existing.llm_json,
      cannot_deliver_classes_json:
        patch.cannotDeliverClasses !== undefined
          ? patch.cannotDeliverClasses != null && patch.cannotDeliverClasses.length > 0
            ? JSON.stringify(patch.cannotDeliverClasses)
            : null
          : existing.cannot_deliver_classes_json,
      enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
      decision_policy_json:
        patch.decisionPolicy !== undefined
          ? patch.decisionPolicy != null ? JSON.stringify(patch.decisionPolicy) : null
          : existing.decision_policy_json,
      owner_id: patch.ownerId ?? existing.owner_id,
    };
    this.db
      .prepare(
        `UPDATE agent_instances
         SET name = ?, capabilities_json = ?, bound_device_ids_json = ?,
             managed_zone_ids_json = ?, llm_json = ?, cannot_deliver_classes_json = ?,
             enabled = ?, decision_policy_json = ?, owner_id = ?
         WHERE id = ?`,
      )
      .run(
        next.name, next.capabilities_json, next.bound_device_ids_json,
        next.managed_zone_ids_json, next.llm_json, next.cannot_deliver_classes_json,
        next.enabled, next.decision_policy_json, next.owner_id, id,
      );
    return next;
  }

  deleteAgent(id: string): void {
    this.db.prepare('DELETE FROM agent_instances WHERE id = ?').run(id);
  }

  /**
   * Re-insert a previously snapshotted agent row with its ORIGINAL id and
   * enabled state (T-209: the revert of a remove-agents proposal restores
   * exactly what the apply deleted, so references that survived — flows,
   * audit entries — resolve again).
   */
  restoreAgent(row: AgentInstanceRow): AgentInstanceRow {
    this.db
      .prepare(
        `INSERT INTO agent_instances
         (id, env_id, owner_id, name, capabilities_json, bound_device_ids_json,
          managed_zone_ids_json, llm_json, cannot_deliver_classes_json, enabled,
          decision_policy_json, derived_service_visibility, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.env_id, row.owner_id, row.name, row.capabilities_json,
        row.bound_device_ids_json, row.managed_zone_ids_json, row.llm_json,
        row.cannot_deliver_classes_json ?? null, row.enabled, row.decision_policy_json,
        row.derived_service_visibility, row.created_at,
      );
    return row;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private insertEnvironment(row: EnvironmentRow): void {
    this.db
      .prepare(
        `INSERT INTO environments
         (id, name, description, map_type, map_data_json, owner_id, visibility,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.name, row.description, row.map_type, row.map_data_json,
        row.owner_id, row.visibility, row.created_at, row.updated_at,
      );
  }

  private insertMember(envId: string, userId: string, role: EnvRole): void {
    this.db
      .prepare('INSERT INTO env_members (env_id, user_id, role) VALUES (?, ?, ?)')
      .run(envId, userId, role);
  }
}

/** Structural guard for the P3 map-data passthrough (non-empty string list). */
function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(member => typeof member === 'string' && member.length > 0)
  );
}

/**
 * P3 structural filter for scenario-authored semantic offer rules — the ONE
 * validation shared by the storage passthrough (parseMapData) and the
 * mapData PATCH whitelist (routes/environments.ts parseMapDataInput), so an
 * entry loadable from storage is always re-writable through the API
 * (R5-F04 round-trip). Non-array input → undefined (key absent).
 */
export function filterSemanticOfferRules(value: unknown): SemanticOfferRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (rule): rule is SemanticOfferRule =>
      typeof rule === 'object' &&
      rule !== null &&
      typeof (rule as { semanticType?: unknown }).semanticType === 'string' &&
      typeof (rule as { label?: unknown }).label === 'string' &&
      typeof (rule as { description?: unknown }).description === 'string' &&
      isNonEmptyStringArray((rule as { requires?: unknown }).requires) &&
      isNonEmptyStringArray((rule as { actuates?: unknown }).actuates),
  );
}

/**
 * P3 structural filter for capability synonym groups (≥2 non-empty strings)
 * — shared by parseMapData and the mapData PATCH whitelist (R5-F04).
 */
export function filterCapabilitySynonyms(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (group): group is string[] =>
      Array.isArray(group) &&
      group.length >= 2 &&
      group.every(member => typeof member === 'string' && member.length > 0),
  );
}

/** Parse an environment's map_data, tolerating legacy/absent zone lists. */
export function parseMapData(row: EnvironmentRow): EnvMapData {
  try {
    const parsed = JSON.parse(row.map_data_json) as Partial<EnvMapData>;
    const data: EnvMapData = { zones: Array.isArray(parsed.zones) ? parsed.zones : [] };
    if (
      typeof parsed.center === 'object' &&
      parsed.center !== null &&
      typeof (parsed.center as EnvGeoCenter).lat === 'number' &&
      typeof (parsed.center as EnvGeoCenter).lng === 'number'
    ) {
      data.center = parsed.center;
    }
    if (typeof parsed.zoom === 'number' && Number.isFinite(parsed.zoom)) {
      data.zoom = parsed.zoom;
    }
    // Map-level building/physics metadata rides the canonical field list.
    for (const field of MAP_META_FIELDS) {
      const value = parsed[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        data[field] = value;
      }
    }
    if (Array.isArray(parsed.events)) {
      data.events = parsed.events;
    }
    // P3: scenario-authored offer rules / synonym groups — tolerant
    // passthrough of structurally valid entries only (legacy rows without
    // them stay unchanged). The shared filters keep the PATCH whitelist
    // byte-compatible (R5-F04).
    const semanticOfferRules = filterSemanticOfferRules(parsed.semanticOfferRules);
    if (semanticOfferRules !== undefined) {
      data.semanticOfferRules = semanticOfferRules;
    }
    const capabilitySynonyms = filterCapabilitySynonyms(parsed.capabilitySynonyms);
    if (capabilitySynonyms !== undefined) {
      data.capabilitySynonyms = capabilitySynonyms;
    }
    if (Array.isArray(parsed.floorPlans)) {
      // Tolerant passthrough: keep only structurally valid entries.
      data.floorPlans = parsed.floorPlans.filter(
        (plan): plan is EnvFloorPlan =>
          typeof plan === 'object' &&
          plan !== null &&
          typeof (plan as { floor?: unknown }).floor === 'number' &&
          typeof (plan as { image?: unknown }).image === 'string' &&
          typeof (plan as { pixelsPerMeter?: unknown }).pixelsPerMeter === 'number',
      );
    }
    // T-053: derived-service demo visibility mode — tolerant enum passthrough
    // (anything but the literal 'public' keeps the 'members' default).
    if (parsed.derivedServiceVisibility === 'public' || parsed.derivedServiceVisibility === 'members') {
      data.derivedServiceVisibility = parsed.derivedServiceVisibility;
    }
    // S1 (Task 3): governance block — tolerant passthrough of non-negative
    // integer thresholds only (legacy rows without it stay unchanged).
    // C3 (R42-B): the ownershipPlan enum rides the same block.
    if (typeof parsed.governance === 'object' && parsed.governance !== null && !Array.isArray(parsed.governance)) {
      const governance: NonNullable<EnvMapData['governance']> = {};
      const rawHumanReview = (parsed.governance as { humanReview?: unknown }).humanReview;
      if (typeof rawHumanReview === 'object' && rawHumanReview !== null && !Array.isArray(rawHumanReview)) {
        const readThreshold = (value: unknown): number | undefined =>
          typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
        const humanReview: NonNullable<NonNullable<EnvMapData['governance']>['humanReview']> = {};
        const maxAgents = readThreshold((rawHumanReview as { maxAgentsPerProposal?: unknown }).maxAgentsPerProposal);
        if (maxAgents !== undefined) humanReview.maxAgentsPerProposal = maxAgents;
        const maxEvents = readThreshold((rawHumanReview as { maxEventsPerProposal?: unknown }).maxEventsPerProposal);
        if (maxEvents !== undefined) humanReview.maxEventsPerProposal = maxEvents;
        const maxZones = readThreshold((rawHumanReview as { maxZonesTouched?: unknown }).maxZonesTouched);
        if (maxZones !== undefined) humanReview.maxZonesTouched = maxZones;
        if (Object.keys(humanReview).length > 0) governance.humanReview = humanReview;
      }
      const rawPlan = (parsed.governance as { ownershipPlan?: unknown }).ownershipPlan;
      if (rawPlan === 'importer' || rawPlan === 'members') governance.ownershipPlan = rawPlan;
      // R6-C-F02: boolean passthrough (absent = the enforce default).
      const rawReach = (parsed.governance as { contractReachabilityCheck?: unknown }).contractReachabilityCheck;
      if (typeof rawReach === 'boolean') governance.contractReachabilityCheck = rawReach;
      if (Object.keys(governance).length > 0) data.governance = governance;
    }
    // T-032: demo metadata — tolerant passthrough of the known fields with
    // their expected types (legacy rows without `demo` stay unchanged).
    if (typeof parsed.demo === 'object' && parsed.demo !== null && !Array.isArray(parsed.demo)) {
      const rawDemo = parsed.demo as Record<string, unknown>;
      const demo: EnvDemoMeta = {};
      const tagline = rawDemo.tagline;
      if (
        typeof tagline === 'object' && tagline !== null &&
        typeof (tagline as { zh?: unknown }).zh === 'string' &&
        typeof (tagline as { en?: unknown }).en === 'string'
      ) {
        demo.tagline = tagline as EnvDemoMeta['tagline'];
      }
      if (typeof rawDemo.heroEventId === 'string') demo.heroEventId = rawDemo.heroEventId;
      if (typeof rawDemo.recommendedPlaybackRate === 'number' && Number.isFinite(rawDemo.recommendedPlaybackRate)) {
        demo.recommendedPlaybackRate = rawDemo.recommendedPlaybackRate;
      }
      const disclaimer = rawDemo.vendorDisclaimer;
      if (typeof disclaimer === 'string') {
        demo.vendorDisclaimer = disclaimer;
      } else if (
        typeof disclaimer === 'object' && disclaimer !== null &&
        typeof (disclaimer as { zh?: unknown }).zh === 'string' &&
        typeof (disclaimer as { en?: unknown }).en === 'string'
      ) {
        demo.vendorDisclaimer = disclaimer as NonNullable<EnvDemoMeta['vendorDisclaimer']>;
      }
      if (Object.keys(demo).length > 0) data.demo = demo;
    }
    return data;
  } catch {
    return { zones: [] };
  }
}

/**
 * Parse an environment's guide_json (Fix-19), tolerating legacy/absent or
 * malformed content. Returns null when the world carries no usable guide.
 */
export function parseGuide(row: EnvironmentRow): EnvGuide | null {
  if (row.guide_json == null) return null;
  try {
    const parsed = JSON.parse(row.guide_json) as Partial<EnvGuide>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const guide: EnvGuide = {};
    if (typeof parsed.purpose === 'string' && parsed.purpose.length > 0) {
      guide.purpose = parsed.purpose;
    }
    if (typeof parsed.zoneGuide === 'string' && parsed.zoneGuide.length > 0) {
      guide.zoneGuide = parsed.zoneGuide;
    }
    if (typeof parsed.serviceMap === 'string' && parsed.serviceMap.length > 0) {
      guide.serviceMap = parsed.serviceMap;
    }
    if (typeof parsed.roleGuide === 'object' && parsed.roleGuide !== null) {
      const roleGuide: { builder?: string; viewer?: string } = {};
      if (typeof parsed.roleGuide.builder === 'string' && parsed.roleGuide.builder.length > 0) {
        roleGuide.builder = parsed.roleGuide.builder;
      }
      if (typeof parsed.roleGuide.viewer === 'string' && parsed.roleGuide.viewer.length > 0) {
        roleGuide.viewer = parsed.roleGuide.viewer;
      }
      if (roleGuide.builder !== undefined || roleGuide.viewer !== undefined) {
        guide.roleGuide = roleGuide;
      }
    }
    return Object.keys(guide).length > 0 ? guide : null;
  } catch {
    return null;
  }
}

export function parseJsonArray<T = unknown>(json: string | null): T[] {
  if (json == null) return [];
  const parsed = JSON.parse(json);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

export function parseJsonObject<T = Record<string, unknown>>(json: string | null): T | null {
  if (json == null) return null;
  return JSON.parse(json) as T;
}
