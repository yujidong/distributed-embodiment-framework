/**
 * Environment bridge — environment records → ScenarioDefinition
 *
 * EngineRuntime keeps consuming `ScenarioDefinition` unchanged
 * (product_design.md §11.2): an environment's zones come from its map data,
 * devices and agents from its instance rows. The assembled wire object is
 * passed through the core loader so defaults (role inference, `sim://`
 * bindings, adjacency lists) and semantic validation (reference integrity)
 * are identical to file-loaded scenarios.
 *
 * The bridged scenario takes its id/name from the environment, so engine
 * snapshots built from environments report the environment id as
 * `scenarioId`.
 *
 * Geo map tier (§11.4): when `map_type` is 'geo', zone polygons (lat/lng)
 * are projected onto local meters around the map center and zone adjacency
 * is derived from polygon boundary proximity — see geo.ts. Scheduled events
 * baked into map data (`mapData.events`) become scenario events.
 */

import {
  loadScenarioFile,
  mergeOfferRules,
  semanticCapabilityTypesOf,
  isReadOnlyCapabilityName,
  ScenarioValidationError,
  type DeviceRole,
  type FlowDefinition,
  type ScenarioDefinition,
} from '@active-collaboration/core';

import { ApiError } from './errors.js';
import {
  demoToScenarioMeta,
  mapMetaToScenarioMeta,
  mapZoneToGeoScenarioZone,
  mapZoneToScenarioZone,
} from './env-map-conversion.js';
import { deriveGeoAdjacency, polygonBboxMeters, requireGeoCenter } from './geo.js';
import {
  parseDeviceRoleColumn,
  parseJsonArray,
  parseJsonObject,
  parseMapData,
  type AgentInstanceRow,
  type DeviceInstanceRow,
  type EnvironmentRow,
  type EnvMapData,
} from './db/environment-store.js';
import { unbackedFlagsForEnv, type ServiceInstanceRow, type ServiceStore } from './db/service-store.js';

/**
 * BUG-01: recheck a persisted device role against the shared read-only
 * capability predicate. Rows written while the loader's classifier misread
 * verb-prefixed sensor names (read-occupancy / detect-smoke / read-power)
 * as execute were persisted as role='actuator' (or 'hybrid') although every
 * capability the device holds is OBSERVATION — downstream the actuation
 * planner then issues zero commands for coverage the precheck granted.
 * A persisted actuator/hybrid whose capabilities are ALL read-only is
 * downgraded to 'sensor'; a persisted 'sensor' and any device holding at
 * least one actuation-class capability keep their declared role.
 */
export function recheckPersistedDeviceRole(
  role: DeviceRole | undefined,
  capabilities: readonly string[],
): DeviceRole | undefined {
  if (role === undefined || role === 'sensor') return role;
  if (capabilities.every(cap => isReadOnlyCapabilityName(cap))) return 'sensor';
  return role;
}

/**
 * Bridge-time consistency check (W3): services whose semantic type is NOT
 * discoverable from the provider agent's bound devices — published offers
 * backed by nothing. This is a warn-list, never a blocker: brokering another
 * agent's capability is legitimate, but the UI flags it (`unbacked`) and the
 * simulation log surfaces it here.
 */
export function environmentServiceWarnings(
  serviceStore: ServiceStore,
  env: EnvironmentRow,
): Array<{ serviceId: string; name: string; providerAgentId: string; semanticType: string }> {
  const services: ServiceInstanceRow[] = serviceStore.servicesOf(env.id);
  const unbacked = unbackedFlagsForEnv(serviceStore.envStore, services);
  return services
    // R14 Wave-A: a registered computation makes an unbacked offer a
    // deliverable data service — no longer a warning, a product.
    .filter(row => unbacked.get(row.id) === true && serviceStore.computationOf(row.id) === undefined)
    .map(row => ({
      serviceId: row.id,
      name: row.name,
      providerAgentId: row.provider_agent_id,
      semanticType: row.semantic_type,
    }));
}

/**
 * Geo map tier: project zone polygons onto local meters around the map
 * center (see geo.ts) so the engine's SpatialField keeps working in meters
 * — zone bounds become the polygon bbox in meters. Adjacency is derived
 * from polygon boundary proximity (not stored). City scale makes the 5 m
 * diffusion coupling between zones physically irrelevant; that is intended
 * (§11.4) — physics still runs per-zone off the projected geometry.
 * All other zone fields pass through (env-map-conversion.ts).
 */
function geoScenarioZones(mapData: EnvMapData, envId: string) {
  const center = requireGeoCenter(mapData, envId);
  const adjacency = deriveGeoAdjacency(mapData.zones, center);
  return mapData.zones.map(zone => {
    // R64: a DECLARED adjacency list wins over polygon proximity — real
    // administrative borders (or authored scenarios) carry semantic truth a
    // boundary-distance heuristic cannot see (district boxes sit far apart
    // inside their districts, so the derivation collapses to empty there).
    const declared = zone.adjacentZoneIds;
    return mapZoneToGeoScenarioZone(
      zone,
      zone.polygon ? polygonBboxMeters(center, zone.polygon) : undefined,
      declared !== undefined && declared.length > 0
        ? declared
        : adjacency.get(zone.id) ?? [],
    );
  });
}

/** Fix-43e: instance-scope options for the environment → scenario bridge. */
export interface EnvironmentBridgeOptions {
  /**
   * Zone ids the simulation instance should contain (MMO "instance scoping"):
   * zones/devices/events outside the scope are pruned; adjacentZoneIds are
   * filtered to in-scope neighbors; agents keep only in-scope managed zones
   * and bound devices. Undefined = the full environment (legacy behavior).
   */
  zoneIds?: string[];
  /**
   * T-020 (DevLoop R17): the environment's flow rows, as core
   * FlowDefinitions (FlowStore.listByEnvironment → flowRowToDefinition,
   * INCLUDING disabled rows). When given, the bridged scenario carries a
   * `flows` array — the export hop of the four-channel promise ("场景 JSON
   * 可内嵌 flows 数组随场景加载"). The core loader validates them against
   * the bridged world (dead zone refs / UNSAT assignments fail the bridge),
   * so callers that must stay drift-tolerant (replay) catch flow-only
   * validation issues and retry without flows. Note: for env-backed
   * simulations the registry's live flowsProvider wins over
   * scenario.flows — passing flows here never double-runs them in sims.
   */
  flows?: FlowDefinition[];
}

/**
 * Build the ScenarioDefinition for an environment's current contents.
 * @throws ApiError 400 ENVIRONMENT_INVALID when the stored world fails
 *         scenario validation (e.g. an agent bound to a deleted device),
 *         or UNKNOWN_ZONE when the instance scope references absent zones.
 */
export function environmentToScenario(
  env: EnvironmentRow,
  devices: DeviceInstanceRow[],
  agents: AgentInstanceRow[],
  options?: EnvironmentBridgeOptions,
): ScenarioDefinition {
  const mapData = parseMapData(env);
  const allZones =
    env.map_type === 'geo'
      ? geoScenarioZones(mapData, env.id)
      : mapData.zones.map(mapZoneToScenarioZone);
  // Fix-43e: prune to the requested zone scope when one was given. The
  // pruned world stays loader-valid: adjacency references, devices, events
  // and agent bindings are all filtered to the surviving zones.
  const scope = options?.zoneIds !== undefined && options.zoneIds.length > 0
    ? new Set(options.zoneIds)
    : undefined;
  if (scope) {
    const known = new Set(allZones.map(z => z.id));
    const unknown = [...scope].filter(id => !known.has(id));
    if (unknown.length > 0) {
      throw new ApiError(
        400,
        'UNKNOWN_ZONE',
        `Instance scope references ${unknown.length} zone(s) not in the environment: ${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? ', …' : ''}`,
      );
    }
  }
  const inScope = (id: string | null | undefined): boolean =>
    scope === undefined || (id !== null && id !== undefined && scope.has(id));
  const zones = scope
    ? allZones
        .filter(z => scope.has(z.id))
        .map(z => ({ ...z, adjacentZoneIds: z.adjacentZoneIds?.filter(id => scope.has(id)) }))
    : allZones;
  const raw = {
    version: '1.0',
    meta: {
      id: env.id,
      name: env.name,
      description: env.description,
      // Building tiers (B-A/B-B): map-level metadata (storeyHeight,
      // slabAttenuation, envelopeU, occupancy*) survives the bridge via the
      // canonical MAP_META_FIELDS list (env-map-conversion.ts).
      ...mapMetaToScenarioMeta(mapData),
      // T-032 (EC-F09): demo metadata re-enters the scenario meta on every
      // export hop (bridge, replay) — the loader passes these through, so a
      // demo authored on the template plays identically on re-imported envs.
      ...demoToScenarioMeta(mapData.demo),
    },
    zones,
    devices: devices
      .filter(device => inScope(device.zone_id))
      .map(device => {
      const capabilities = parseJsonArray<string>(device.capabilities_json);
      return {
      id: device.id,
      name: device.name,
      type: device.type,
      capabilities,
      zoneId: device.zone_id,
      // T-021: a persisted role is explicit author/declaration intent —
      // NULL keeps the loader's capability inference (legacy rows).
      // BUG-01: rows persisted while the loader's capability classifier
      // misread verb-prefixed sensor names (read-*/detect-*) as execute
      // carry role='actuator'/'hybrid' for devices that can only OBSERVE —
      // recheck those against the shared read-only predicate and downgrade
      // to 'sensor' (a persisted 'sensor' is never touched).
      ...(device.role != null
        ? { role: recheckPersistedDeviceRole(parseDeviceRoleColumn(device.role) ?? undefined, capabilities) }
        : {}),
      // P3b: a stored hass:// binding turns this device into an HADevice;
      // absent → the scenario loader's sim:// default applies.
      ...(device.binding != null ? { binding: device.binding } : {}),
      ...(device.initial_state_json != null
        ? { initialState: parseJsonObject(device.initial_state_json) }
        : {}),
      };
    }),
    agents: agents
      .map(agent => ({
      id: agent.id,
      name: agent.name,
      // R53: the runtime matching surface unions the agent's SEMANTIC offer
      // types (derived from its capability bundle, core semantic-offers) on
      // top of the stored declaration — the stored rows stay clean so the
      // PATCH backing check (AGENT_CAPABILITIES_UNBACKED) keeps policing
      // hand-written declarations only.
      // P3: the SAME merged rule table the aggregate sync used (built-ins +
      // the world's scenario-authored rules) derives these types, so the
      // runtime capability surface and the DB aggregate rows never diverge.
      capabilities: [...new Set([
        ...parseJsonArray<string>(agent.capabilities_json),
        ...semanticCapabilityTypesOf(
          agentCapabilityUnion(devices, agent),
          mergeOfferRules(mapData.semanticOfferRules ?? []),
        ),
      ])],
      managesZoneIds: parseJsonArray<string>(agent.managed_zone_ids_json).filter(inScope),
      boundDeviceIds: parseJsonArray<string>(agent.bound_device_ids_json)
        .filter(id => devices.some(d => d.id === id && inScope(d.zone_id))),
      // Agent 启停（migration v21）：enabled=0 的行以 ScenarioAgent.enabled=false
      // 进入运行时（core loader 已透传），EngineRuntime 构建时即排除其事件与
      // 伙伴选择——比在 registry 里事后调 setAgentEnabled 更干净（任务设计二选一，
      // 此处选桥接路径）。仅在为 0 时显式输出，保持默认行的桥接结果不变。
      ...(agent.enabled === 0 ? { enabled: false } : {}),
      // T-201 tenant attribution: agent_instances.owner_id → ScenarioAgent
      // .ownerUserId (core loader passes it through). Flow assignment uses it
      // to scope flow nodes to the flow author's own agents/devices.
      ...(agent.owner_id != null ? { ownerUserId: agent.owner_id } : {}),
      // T-021 (EC-F07): scope-of-practice blocklist survives the bridge —
      // the runtime hands it to PartnerSelectionNegotiator as agent metadata.
      ...(agent.cannot_deliver_classes_json !== null
        ? { cannotDeliverClasses: parseJsonArray<string>(agent.cannot_deliver_classes_json) }
        : {}),
      // T-601 (R26): the store keeps explicit llm:null as the JSON string
      // 'null' — this round-trips to llm:null here, and EngineRuntime builds
      // NO client for the agent (rule-only by construction).
      ...(agent.llm_json != null ? { llm: parseJsonObject(agent.llm_json) } : {}),
      // T-051: the author's per-agent actuation defaults → ScenarioAgent
      // .decisionPolicy (core resolves sim option > this policy > default).
      ...(agent.decision_policy_json != null
        ? { decisionPolicy: parseJsonObject(agent.decision_policy_json) ?? {} }
        : {}),
    }))
      // An instance-scoped agent with nothing left to manage/bind still
      // participates in partner selection (its capabilities matter); the
      // loader accepts empty manages/bounds. Keep every agent by default —
      // pruning them would change collaboration topology.
      ,
    events: (mapData.events ?? []).filter(e => inScope(e.zoneId)),
    // P3: the world's authored offer rules / synonym groups re-enter the
    // scenario on every bridge hop (the loader re-registers the synonyms;
    // EngineRuntime merges the rules into its aggregate-offer registration).
    ...(mapData.semanticOfferRules !== undefined
      ? { semanticOfferRules: mapData.semanticOfferRules }
      : {}),
    ...(mapData.capabilitySynonyms !== undefined
      ? { capabilitySynonyms: mapData.capabilitySynonyms }
      : {}),
    // T-020: the env's flows ride the export (validated by the loader —
    // see EnvironmentBridgeOptions.flows).
    ...(options?.flows !== undefined && options.flows.length > 0
      ? { flows: options.flows.map(flow => ({ ...flow })) }
      : {}),
  };

  try {
    return loadScenarioFile(raw);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      // R15-DevLoop: actionable guidance instead of a generic "invalid scenario"
      // — the most common cause is an empty world (no zones yet).
      const zoneIssues = error.issues.filter(i => i.includes('zone'));
      const hint = zoneIssues.length > 0
        ? ' — the environment has no zones yet. Add a zone (or import a scenario template) before simulating.'
        : '';
      throw new ApiError(
        400,
        'ENVIRONMENT_INVALID',
        `Environment "${env.id}" cannot be simulated${hint}`,
        error.issues,
      );
    }
    throw error;
  }
}


/**
 * R53: the agent's capability union = its stored declaration ∪ its bound
 * devices' capabilities (same grounding the service derivation uses).
 */
function agentCapabilityUnion(
  devices: Array<{ id: string; capabilities_json: string }>,
  agent: { capabilities_json: string; bound_device_ids_json: string },
): Set<string> {
  const union = new Set<string>(parseJsonArray<string>(agent.capabilities_json));
  for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
    const device = devices.find(d => d.id === deviceId);
    if (!device) continue;
    for (const capability of parseJsonArray<string>(device.capabilities_json)) union.add(capability);
  }
  return union;
}
