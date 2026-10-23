/**
 * Scenario import — expand a v1.0 scenario JSON into an environment
 *
 * The scenario file format (product_design.md §11.2) is the import/export
 * format for environments: zones are baked into `map_data`, devices and
 * agents become instance rows owned by the importer.
 *
 * Map tiers (§11.4):
 * - grid (default): zone `bounds` go into map data as-is;
 * - geo: the file carries a top-level `map: { type: 'geo', center, zoom? }`
 *   block and per-zone `polygon` rings; both are validated (geo.ts) and
 *   stored in map data. Device `position` ({lat, lng}) survives the import
 *   like `brand`.
 *
 * Field fidelity (Fix-2): zones, map-level metadata (storeyHeight et al.)
 * and scheduled `events` flow through the shared converters in
 * env-map-conversion.ts — spread passthrough plus the canonical
 * MAP_META_FIELDS list, so every field the core loader knows survives the
 * import for BOTH map tiers (grid no longer drops events).
 *
 * The body is validated with the core loader (`loadScenarioFile`), which
 * also applies wire defaults (adjacency lists, role inference, binding
 * URIs). `brand`, `position`, zone `polygon` and the `map` block are NOT
 * part of the validated definition — the loader drops them — so they are
 * recovered from the raw body.
 *
 * The whole import (environment + owner membership + all instances) is one
 * transaction: a failed import leaves no half-built world behind.
 *
 * R46 (P0-1): the import body may also carry `invites` (immediate
 * membership) and `ownerAssignment` (regex rules handing agents/devices to
 * those members at world-initialization time — 资产归属下放; see
 * applyOwnerAssignment below). Both run inside the same transaction.
 */

import {
  loadScenarioFile,
  ScenarioFlowValidationError,
  ScenarioValidationError,
  type ScenarioDefinition,
} from '@active-collaboration/core';
import { localizedText } from '@active-collaboration/shared';
import {
  acceptedParameterNames,
  isCapabilityExecutable,
} from '@active-collaboration/simulation';

import { ApiError } from './errors.js';
import { assertEnvNameLength } from './env-access.js';
import {
  scenarioEventsToMapEvents,
  scenarioMetaToDemo,
  scenarioMetaToMapMeta,
  scenarioZoneToGeoMapZone,
  scenarioZoneToMapZone,
} from './env-map-conversion.js';
import { parseGeoMapData, parseGeoPolygon, validateDevicePositionForEnv } from './geo.js';
import type { ServiceStore } from './db/service-store.js';
import type { FlowStore } from './db/flow-store.js';
import {
  parseJsonArray,
  type EnvironmentRow,
  type EnvironmentStore,
  type EnvMapData,
  type EnvFloorPlan,
  type EnvVisibility,
} from './db/environment-store.js';

export interface ImportOptions {
  ownerId: string;
  visibility?: EnvVisibility;
  /**
   * C3 (R42-B, devloop-r41-a1 §8.3): the world's ownership plan.
   * 'importer' (default) = legacy behavior — every imported agent/device
   * lands on the importer, theirs to keep or hand over. 'members' = the
   * importer declares a multi-stakeholder world: everything still lands on
   * the importer (owner_id is NOT NULL), but the env records
   * mapData.governance.ownershipPlan='members' so members may CLAIM
   * unassigned objects through ownership-transfer proposals (提案制，不自动分).
   */
  ownershipPlan?: 'importer' | 'members';
  /**
   * When provided, derivation runs for every imported agent (one derived
   * service per bound device × capability — W3). Optional so legacy callers
   * without a service layer keep working.
   */
  serviceStore?: ServiceStore;
  /**
   * Fix-44a: when provided, the scenario's embedded `flows` array is persisted
   * as environment flow rows (one per definition, owned by the importer).
   * The loader already rejected invalid embedded flows semantically, so this
   * seam only writes. Optional so seeding/legacy callers without a flow layer
   * keep working.
   */
  flowStore?: FlowStore;
  /**
   * R46 (P0-1): import-time membership invites — `{email, role}` rows added
   * as members right after the environment row lands, inside the same
   * transaction (immediate-effect, same semantics as POST
   * /api/environments/:id/members). Assignment rules below key off
   * membership, so ONE import body can invite + assign. Emails are resolved
   * to userIds by the route before the import starts; the store-level seam
   * only sees ids.
   */
  invites?: ImportInvite[];
  /**
   * R46 (P0-1): import-time ownership assignment (资产归属下放). This is
   * world INITIALIZATION, not a runtime change — it does not go through
   * ownership-transfer proposals (too slow for a multi-stakeholder import
   * where the org mapping is known up front). Rules match the imported
   * instance NAME by regex; first matching rule wins; unmatched instances
   * stay with the importer. Every assignee must be a member of the freshly
   * imported environment (owner, or invited via `invites` in the same body)
   * — otherwise 400 before anything lands (one transaction, no half-built
   * world).
   */
  ownerAssignment?: OwnerAssignmentPlan;
}

/** R46 (P0-1): a membership row the import adds alongside the world itself. */
export interface ImportInvite {
  userId: string;
  /** Kept for error messages only — the store seam works in ids. */
  email: string;
  role: 'builder' | 'viewer';
}

/**
 * R46 (P0-1): one ownership-assignment rule. `pattern` is a pre-compiled
 * regex over the imported instance NAME (e.g. /变电站/ or /学校|中小学/).
 */
export interface OwnerAssignmentRule {
  pattern: RegExp;
  toUserId: string;
  /** Kept for error messages only. */
  toUserEmail: string;
}

export interface OwnerAssignmentPlan {
  /** Agent-name rules — first match wins, unmatched agents stay importer-owned. */
  agents: OwnerAssignmentRule[];
  /**
   * Device-name rules — optional, same first-match semantics. They OVERRIDE
   * the follow rule below for the devices they match.
   */
  devices?: OwnerAssignmentRule[];
}

interface RawZoneBlock {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  polygon?: unknown;
  baseline?: unknown;
}

/** Read the `map.type` marker of a scenario file ('geo' for the geo tier). */
function scenarioMapType(raw: unknown): string {
  const map = (raw as { map?: unknown }).map;
  if (typeof map === 'object' && map !== null && !Array.isArray(map)) {
    const type = (map as { type?: unknown }).type;
    if (typeof type === 'string') return type;
  }
  return 'grid';
}

/**
 * Validate `raw` as a v1.0 scenario and import it as a new environment.
 * @throws ApiError 400 when the body is not a valid scenario.
 */
export function importScenarioAsEnvironment(
  store: EnvironmentStore,
  raw: unknown,
  options: ImportOptions,
): EnvironmentRow {
  let definition: ScenarioDefinition;
  try {
    // BUG-06: inject the SAME flow-validation oracles the REST flow routes
    // use (T-002 executability + R13 param-spelling), so an embedded flow
    // with an unrecognized param spelling is refused AT IMPORT with the
    // rename hint instead of sailing through and dying mid-run.
    definition = loadScenarioFile(raw, {
      flowValidation: { isExecutableCapability: isCapabilityExecutable, acceptedParameterNames },
    });
  } catch (error) {
    // Flow-semantic failures answer like the REST authoring lane (422
    // FLOW_INVALID with the issue list); schema/structural failures keep the
    // long-standing 400.
    if (error instanceof ScenarioFlowValidationError) {
      throw new ApiError(422, 'FLOW_INVALID', `Scenario flow validation failed: ${error.issues[0]}`, error.issues);
    }
    if (error instanceof ScenarioValidationError) {
      throw new ApiError(400, 'SCENARIO_VALIDATION_FAILED', 'Scenario validation failed', error.issues);
    }
    throw error;
  }

  const mapType = scenarioMapType(raw);
  // Fix-6: the environment name cap applies to the import path too
  // (meta.name becomes the environment name). Resolve the (possibly bilingual)
  // meta.name to a zh-side plain string to preserve legacy env-storage shape;
  // Phase 3 widens the env record to carry `{zh, en}` directly.
  assertEnvNameLength(localizedText(definition.meta.name, 'zh-CN'));

  // brand/position live outside the validated definition — index the raw devices.
  const brandByDeviceId = new Map<string, string>();
  const positionByDeviceId = new Map<string, Record<string, unknown>>();
  const rawDevices = (raw as { devices?: unknown }).devices;
  if (Array.isArray(rawDevices)) {
    for (const device of rawDevices) {
      const d = device as { id?: unknown; brand?: unknown; position?: unknown };
      if (typeof d.id === 'string' && typeof d.brand === 'string') {
        brandByDeviceId.set(d.id, d.brand);
      }
      if (
        typeof d.id === 'string' &&
        typeof d.position === 'object' &&
        d.position !== null &&
        !Array.isArray(d.position)
      ) {
        positionByDeviceId.set(d.id, d.position as Record<string, unknown>);
      }
    }
  }

  let mapData: EnvMapData;
  if (mapType === 'geo') {
    // Geo tier: center/zoom from the `map` block; polygons from the raw
    // zones (the loader strips them). Both validated here (geo.ts).
    const mapBlock = ((raw as { map?: unknown }).map ?? {}) as Record<string, unknown>;
    const geo = parseGeoMapData(mapBlock);
    const rawZones = ((raw as { zones?: unknown }).zones ?? []) as RawZoneBlock[];
    mapData = {
      center: geo.center,
      ...(geo.zoom !== undefined ? { zoom: geo.zoom } : {}),
      ...scenarioMetaToMapMeta(definition.meta),
      zones: definition.zones.map((zone, index) =>
        scenarioZoneToGeoMapZone(
          zone,
          parseGeoPolygon(rawZones[index]?.polygon, `zones[${index}].polygon`),
        ),
      ),
      events: scenarioEventsToMapEvents(definition.events),
    };
  } else {
    // Grid tier: zones and events pass through verbatim (Fix-2 — the legacy
    // "grid imports drop events" behavior is gone; a world keeps its script).
    mapData = {
      ...scenarioMetaToMapMeta(definition.meta),
      zones: definition.zones.map(scenarioZoneToMapZone),
      events: scenarioEventsToMapEvents(definition.events),
    };
    // B-D: plan-image underlays ride the non-validated `map` block (the
    // loader drops it, like the geo tier's polygons) — recover + validate.
    const floorPlans = parseFloorPlansBlock(
      (raw as { map?: { floorPlans?: unknown } }).map?.floorPlans,
    );
    if (floorPlans !== undefined) mapData.floorPlans = floorPlans;
  }
  // T-032 (EC-F09): demo metadata (tagline/heroEventId/playback/disclaimer)
  // gets an env-level home in map data — both tiers, straight off the
  // validated scenario meta the loader preserved.
  const demo = scenarioMetaToDemo(definition.meta);
  if (demo !== undefined) mapData.demo = demo;
  // P3: the scenario's authored offer rules / synonym groups ride map data
  // so the aggregate sync (import + every later rebind) and the runtime
  // bridge keep deriving/matching with the world's own vocabulary.
  if (definition.semanticOfferRules !== undefined) {
    mapData.semanticOfferRules = definition.semanticOfferRules;
  }
  if (definition.capabilitySynonyms !== undefined) {
    mapData.capabilitySynonyms = definition.capabilitySynonyms;
  }
  // C3 (R42-B): a members-plan import stamps the governance marker — the
  // objects still land on the importer, but the world declares itself
  // claimable by members via ownership-transfer proposals.
  if (options.ownershipPlan === 'members') {
    mapData.governance = { ...mapData.governance, ownershipPlan: 'members' };
  }

  return store.transaction(() => {
    const env = store.createEnvironment({
      name: localizedText(definition.meta.name, 'zh-CN'),
      description: localizedText(definition.meta.description, 'zh-CN'),
      mapType,
      mapData,
      ownerId: options.ownerId,
      ...(options.visibility !== undefined ? { visibility: options.visibility } : {}),
    });
    // Instance rows get fresh ids — remap agent bindings from the scenario's
    // device ids onto the new instance ids so the world stays consistent.
    const deviceIdMap = new Map<string, string>();
    const agentIdMap = new Map<string, string>();
    for (const device of definition.devices) {
      const position = positionByDeviceId.get(device.id);
      if (position !== undefined) validateDevicePositionForEnv(mapType, position);
      const row = store.createDevice({
        envId: env.id,
        ownerId: options.ownerId,
        name: device.name,
        type: device.type,
        brand: brandByDeviceId.get(device.id) ?? null,
        capabilities: device.capabilities,
        zoneId: device.zoneId,
        // T-110: a hass:// binding names REAL hardware and survives the id
        // remap — pass it through like the per-device API does (dropping it
        // silently swapped real hardware for a simulated twin). sim:// URIs
        // reference scenario-local ids that die at import; NULL keeps the
        // row-level sim default.
        ...(device.binding.startsWith('hass://') ? { binding: device.binding } : {}),
        ...(position !== undefined ? { position } : {}),
        ...(device.initialState !== undefined ? { initialState: device.initialState } : {}),
        // T-021: the loader-resolved role (explicit or inferred) persists on
        // the row — no silent re-inference at the bridge.
        role: device.role,
      });
      deviceIdMap.set(device.id, row.id);
    }
    for (const agent of definition.agents) {
      const row = store.createAgent({
        envId: env.id,
        ownerId: options.ownerId,
        name: agent.name,
        capabilities: agent.capabilities,
        boundDeviceIds: agent.boundDeviceIds.map(id => deviceIdMap.get(id) ?? id),
        managedZoneIds: agent.managesZoneIds,
        // T-021 (EC-F07): scope-of-practice blocklist persists through the
        // import — dropping it silently let PartnerSelectionNegotiator pick
        // agents without regulatory authority (the flagship medical scenario
        // changed collaboration semantics the moment it was imported).
        ...(agent.cannotDeliverClasses !== undefined
          ? { cannotDeliverClasses: [...agent.cannotDeliverClasses] }
          : {}),
        // T-601 (R26): an explicit llm:null in the scenario survives the
        // import verbatim (rule-only opt-out), instead of silently becoming
        // an empty llm block.
        ...(agent.llm !== undefined
          ? { llm: agent.llm === null ? null : { ...agent.llm } }
          : {}),
        // R43-B/lever-b: the per-agent decisionPolicy (T-050 actuation
        // toggles + the precheck Type-A pass-through pair) survives the
        // import — template agents carrying a policy must not silently lose
        // it across the scenario → environment hop.
        ...(agent.decisionPolicy !== undefined
          ? { decisionPolicy: { ...agent.decisionPolicy } }
          : {}),
      });
      agentIdMap.set(agent.id, row.id);
      options.serviceStore?.syncDerivedForAgent(row.id);
      // P3: the agent's author-declared semantic services land as
      // origin='published' rows (after the derivation sync so the
      // aggregate lane has already settled its own rows — the two lanes
      // never touch each other's origin).
      if (agent.services !== undefined && agent.services.length > 0) {
        options.serviceStore?.importDeclaredServices(row.id, agent.services);
      }
    }
    // Fix-44a: scenario-embedded flows become environment flows (the
    // four-channel promise — "场景 JSON 可内嵌 flows 数组随场景加载").
    // Rows get fresh store ids; the definition (trigger/plan) survives
    // verbatim. The loader's semantic validation already gated this array.
    // T-020: T-201 pins survive the import hop REMAPPED — device/agent
    // instance ids regenerate above, so a node pinning the exported
    // scenario's ids is rewritten onto the new instance ids (zone ids are
    // map-data keys and stay verbatim). authorUserId in the JSON is
    // ownership-neutral by design: the importer (the new env's owner) is
    // stamped as createdBy, so re-imported flows keep unrestricted
    // semantics ("server-stamped, never client-suppliable").
    if (definition.flows !== undefined && definition.flows.length > 0 && options.flowStore !== undefined) {
      for (const flow of definition.flows) {
        options.flowStore.create({
          environmentId: env.id,
          name: flow.name,
          description: flow.description ?? '',
          enabled: flow.enabled,
          trigger: flow.trigger,
          // Mechanism D: the declared input surface survives the import hop.
          ...(flow.inputs !== undefined ? { inputs: flow.inputs } : {}),
          // Mechanism C: the policy envelope survives the import hop.
          ...(flow.policy !== undefined ? { policy: flow.policy } : {}),
          // Mechanism B: the agent-invocation opt-in survives the import hop.
          ...(flow.agentInvocable === true ? { agentInvocable: true } : {}),
          plan: {
            goal: flow.plan.goal,
            nodes: flow.plan.nodes.map(node => ({
              ...node,
              ...(typeof node.assigneeAgentId === 'string' && agentIdMap.has(node.assigneeAgentId)
                ? { assigneeAgentId: agentIdMap.get(node.assigneeAgentId)! }
                : {}),
              ...(typeof node.deviceId === 'string' && deviceIdMap.has(node.deviceId)
                ? { deviceId: deviceIdMap.get(node.deviceId)! }
                : {}),
            })),
          },
          createdBy: options.ownerId,
        });
      }
    }
    // R46 (P0-1): membership first (invites), then the ownership handover —
    // both inside the import transaction, so a bad rule leaves no
    // half-assigned world behind.
    applyImportInvites(store, env, options.invites);
    applyOwnerAssignment(store, env, options.ownerAssignment);
    return env;
  });
}

/**
 * R46 (P0-1): add the import body's invitees as members. Idempotent per
 * user — the importer (already the owner member) and duplicate rows are
 * skipped instead of tripping the env_members primary key.
 */
function applyImportInvites(
  store: EnvironmentStore,
  env: EnvironmentRow,
  invites: ImportInvite[] | undefined,
): void {
  if (invites === undefined) return;
  for (const invite of invites) {
    if (store.roleOf(env.id, invite.userId) !== undefined) continue;
    store.addMember(env.id, invite.userId, invite.role);
  }
}

/**
 * R46 (P0-1): import-time ownership assignment (资产归属下放).
 *
 * Semantics:
 * 1. Every assignee must already be a member of the new environment (the
 *    importer, or an invitee from the same body) — assignment hands world
 *    assets to people who are IN the world; 400 otherwise.
 * 2. Agent rules match agent NAMES by regex, first match wins; unmatched
 *    agents stay with the importer.
 * 3. Device rules match device NAMES the same way and take precedence.
 * 4. Follow rule: a device not matched by any device rule follows its
 *    managing agents — when the agents bound to it that got reassigned
 *    agree on exactly ONE new owner, the device moves with them. A
 *    multi-stakeholder import maps ORGS onto agents (泵站管家 → 水务), and
 *    the pump valves are water's assets exactly because their keeper is —
 *    without this, every device would stay importer-owned and the device
 *    command boundary (R46 P0-2) would have nothing to key on. Devices
 *    with no reassigned keeper (or contested ones) stay importer-owned
 *    (the shared-sandbox carve-out covers them).
 */
function applyOwnerAssignment(
  store: EnvironmentStore,
  env: EnvironmentRow,
  plan: OwnerAssignmentPlan | undefined,
): void {
  if (plan === undefined) return;
  const membershipCheck = (rule: OwnerAssignmentRule, kind: 'agents' | 'devices'): void => {
    if (store.roleOf(env.id, rule.toUserId) !== undefined) return;
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `ownerAssignment.${kind}: target user "${rule.toUserEmail}" is not a member of the ` +
      'imported environment — invite them in the same body ' +
      '("invites": [{"email": "...", "role": "builder"}]) or via POST /api/environments/{id}/members, ' +
      'then assign. Import-time assignment only hands assets to members.',
    );
  };
  for (const rule of plan.agents) membershipCheck(rule, 'agents');
  for (const rule of plan.devices ?? []) membershipCheck(rule, 'devices');

  // Agents: first matching rule wins; unmatched stay importer-owned.
  const reassignedAgentOwner = new Map<string, string>();
  for (const agent of store.agentsOf(env.id)) {
    const rule = plan.agents.find(candidate => candidate.pattern.test(agent.name));
    if (rule === undefined) continue;
    store.updateAgent(agent.id, { ownerId: rule.toUserId });
    reassignedAgentOwner.set(agent.id, rule.toUserId);
  }

  // Devices: explicit rules first (first match wins).
  const explicitlyAssigned = new Set<string>();
  for (const device of store.devicesOf(env.id)) {
    const rule = plan.devices?.find(candidate => candidate.pattern.test(device.name));
    if (rule === undefined) continue;
    store.updateDevice(device.id, { ownerId: rule.toUserId });
    explicitlyAssigned.add(device.id);
  }

  // Follow rule: unassigned devices move with their reassigned keepers when
  // those keepers agree on exactly one new owner.
  const agents = store.agentsOf(env.id);
  for (const device of store.devicesOf(env.id)) {
    if (explicitlyAssigned.has(device.id)) continue;
    const candidateOwners = new Set<string>();
    for (const agent of agents) {
      const owner = reassignedAgentOwner.get(agent.id);
      if (owner === undefined) continue;
      if (parseJsonArray<string>(agent.bound_device_ids_json).includes(device.id)) {
        candidateOwners.add(owner);
      }
    }
    if (candidateOwners.size === 1) {
      store.updateDevice(device.id, { ownerId: [...candidateOwners][0] });
    }
  }
}

/**
 * Validate the `map.floorPlans` sidecar of a scenario file (B-D plan-image
 * underlays). Absent → undefined (no underlays); present but malformed →
 * 400 like any other broken import field.
 */
function parseFloorPlansBlock(raw: unknown): EnvFloorPlan[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'map.floorPlans must be an array');
  }
  return raw.map((entry, index) => {
    const plan = entry as Partial<EnvFloorPlan>;
    const where = `map.floorPlans[${index}]`;
    if (typeof plan !== 'object' || plan === null) {
      throw new ApiError(400, 'BAD_REQUEST', `${where} must be an object`);
    }
    if (typeof plan.floor !== 'number' || !Number.isInteger(plan.floor)) {
      throw new ApiError(400, 'BAD_REQUEST', `${where}.floor must be an integer`);
    }
    if (typeof plan.image !== 'string' || plan.image.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', `${where}.image must be a non-empty string (URL or data URI)`);
    }
    if (
      typeof plan.pixelsPerMeter !== 'number' ||
      !Number.isFinite(plan.pixelsPerMeter) ||
      plan.pixelsPerMeter <= 0
    ) {
      throw new ApiError(400, 'BAD_REQUEST', `${where}.pixelsPerMeter must be a positive number`);
    }
    return {
      ...(typeof plan.buildingId === 'string' && plan.buildingId.length > 0
        ? { buildingId: plan.buildingId }
        : {}),
      floor: plan.floor,
      image: plan.image,
      pixelsPerMeter: plan.pixelsPerMeter,
    };
  });
}
