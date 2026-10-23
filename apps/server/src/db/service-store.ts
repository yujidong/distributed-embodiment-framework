/**
 * Service store — the platform's service layer (W3)
 *
 * Services are the public, cross-owner visibility boundary: other users in a
 * shared world discover what an agent OFFERS (its services), not necessarily
 * what it HAS (its devices). Two origins:
 *
 * - `derived` — managed rows, one per (bound device × its capabilities),
 *   mirroring what the engine derives when a CognitiveAgent registers
 *   device-derived services from its bound devices
 *   (packages/core/src/service/ServiceRegistry.ts). The derivation sync
 *   (`syncDerivedForAgent` / `syncDerivedForDevice`) keeps them equal to the
 *   current bindings: unbind a device → its derived services go; a device
 *   capability change → refresh; agent delete → FK cascade. Derived rows are
 *   NOT user-editable — only their visibility may be toggled. Their
 *   `interface` is generated (Fix-15, F-27): the backing device's executable
 *   commands with basic parameter hints, so invoke consumers can discover
 *   the callable surface instead of guessing action names.
 * - `published` — explicit offers created through the API (an agent may
 *   broker a capability it does not itself own; the `unbacked` flag marks
 *   published services whose semantic type is not discoverable from the
 *   provider's bound devices — informational, never blocking).
 *
 * Visibility is the cross-owner boundary:
 * - `public`  — anyone who can read the environment (incl. anonymous
 *   viewers of public worlds);
 * - `members` — environment members only;
 * - `hidden`  — the provider agent's owner + the environment owner only.
 */

import { randomUUID } from 'node:crypto';

import {
  CommandHandlerRegistry,
  capabilityDisplayName,
  deviceExecutableCommandNames,
  isCapabilityExecutable,
  serviceInterfaceForCapabilities,
} from '@active-collaboration/simulation';
import {
  capabilityMatches,
  deviceProvides,
  deviceProvidesExecutablePath,
  executableCommandPath,
  honestSemanticType,
  isSwitchingSurface,
  mergeOfferRules,
  SEMANTIC_TYPE_SWITCHING,
  semanticCapabilityTypesOf,
  semanticOffersOf,
  SWITCHING_COMMANDS,
  type FlowDefinition,
  type SemanticOfferRule,
} from '@active-collaboration/core';

// P1: the honest-label rules moved to core's device-service-derivation (the
// single derivation source of truth shared with the runtime face). Re-export
// so existing `service-store.js` importers keep working.
export { honestSemanticType, SEMANTIC_TYPE_SWITCHING } from '@active-collaboration/core';

import { ApiError } from '../errors.js';
import {
  autoMintDataSchema,
  autoMintSpec,
  isAutoMintedSpec,
  readableParamsForDevice,
  ServiceComputationStore,
  type ComputationRow,
  type ServiceDataFrameRow,
} from './service-computation-store.js';
import type { EafDatabase } from './database.js';
import {
  parseJsonArray,
  parseMapData,
  type AgentInstanceRow,
  type DeviceInstanceRow,
  type EnvironmentRow,
  type EnvironmentStore,
  type EnvRole,
} from './environment-store.js';

/**
 * Mechanism D (design-mixed-initiative-flows.md §5.1): 'flow' joins the
 * origin set — a service whose backing is a PUBLISHED FLOW (source_flow_id),
 * not a device. Invocation runs the flow in the PROVIDER's context; T-201
 * author scoping (the flow author's agents/devices only) is the security
 * model — no new permission machinery.
 */
export type ServiceOrigin = 'derived' | 'published' | 'flow' | 'aggregate';
export type ServiceVisibility = 'public' | 'members' | 'hidden';

export interface ServiceInstanceRow {
  id: string;
  env_id: string;
  provider_agent_id: string;
  name: string;
  semantic_type: string;
  description: string;
  interface_json: string;
  origin: ServiceOrigin;
  source_device_id: string | null;
  /** Mechanism D: the published flow backing an origin='flow' row. */
  source_flow_id: string | null;
  visibility: ServiceVisibility;
  /**
   * D2 (DevLoop R28, T-079): the DECLARED zone of a published/flow service
   * (§11.2(6) amended). Null = undeclared (zone-less — matches zone-less
   * asks only); derived rows keep deriving their zone from the source
   * device (this column stays null for them).
   */
  zone_id: string | null;
  created_at: string;
}

export interface CreateServiceInput {
  envId: string;
  providerAgentId: string;
  name: string;
  semanticType: string;
  description?: string;
  interface?: Record<string, unknown>;
  origin: ServiceOrigin;
  sourceDeviceId?: string | null;
  /** Mechanism D: the backing flow of an origin='flow' row. */
  sourceFlowId?: string | null;
  visibility?: ServiceVisibility;
  /** D2 (T-079): the declared zone of a published/flow offer (validated by the route). */
  zoneId?: string | null;
}

export interface ServicePatch {
  name?: string;
  semanticType?: string;
  description?: string;
  interface?: Record<string, unknown>;
  visibility?: ServiceVisibility;
}

/**
 * R14 Wave-A (design-data-services.md) — computation registration and the
 * evaluation-frame cache now live in service-computation-store.ts (R21-W4
 * split); this store delegates the five methods below so every consumer
 * keeps its `ctx.serviceStore.<method>` call shape. The row types are
 * re-exported for compatibility.
 */
export {
  type ComputationRow,
  type ServiceDataFrameRow,
} from './service-computation-store.js';

/** One derivation-sync change (routes publish these as world-sync messages). */
export interface DerivedSyncChange {
  action: 'created' | 'updated' | 'deleted';
  row: ServiceInstanceRow;
}

/**
 * T-058b (design-consent-semantics.md §4.2): a lightweight access REQUEST on
 * a hidden service — a bilateral data transaction (requester ↔ provider
 * owner), NOT a proposal (no world-structure change). No SLA: it may sit
 * pending forever; the requester may withdraw, the provider may explicitly
 * reject (DELETE) or simply never answer.
 */
export interface AccessRequestRow {
  id: string;
  service_id: string;
  requester_id: string;
  purpose: string;
  duration_days: number | null;
  status: 'pending' | 'granted' | 'withdrawn' | 'rejected';
  created_at: string;
  decided_at: string | null;
}

/**
 * T-058b (§4.1): the provider-owned DOOR on a hidden service — grantee ×
 * expiry × basis. The grant opens visibility (list/GET/propose); the
 * AGREEMENT remains the contract (terms.read.fields/quota/freshness scope
 * what a granted viewer may consume). One row per (service, grantee): a
 * repeat grant EXTENDS (expires_at overwritten). dataSubject is the
 * declarative resident label (§4.3) — informational, provider-owned; the
 * platform does not verify real-world relationships.
 */
export interface AccessGrantRow {
  id: string;
  service_id: string;
  grantee_user_id: string;
  granted_by: string;
  granted_at: string;
  expires_at: string;
  basis: string | null;
  data_subject_json: string | null;
  request_id: string | null;
}

/** The declarative data-subject label carried on grants (§4.3, closed shape). */
export interface DataSubjectLabel {
  ref: string;
  consentBasis?: string;
}

export class ServiceStore {
  /**
   * Mechanism D: historical migrations v28/v36 run the LIVE derivation
   * backfill (`backfillDerivedServices` → `syncDerivedForAgent` →
   * `createService`) against PRE-v38 schemas where `source_flow_id` does not
   * exist yet. The INSERT therefore branches on the column's presence —
   * one pragma probe per store instance, a no-op cost after migration.
   * D2 (T-079): same story for `zone_id` (v47).
   */
  private readonly hasSourceFlowColumn: boolean;
  private readonly hasZoneColumn: boolean;
  /**
   * D4 (T-081): historical migrations (v28/v36 backfills) run the LIVE
   * derivation sync against schemas where `service_computations` does not
   * exist yet (v32) — the auto-mint lanes no-op there instead of throwing.
   */
  private readonly hasComputationsTable: boolean;

  private readonly computations: ServiceComputationStore;

  constructor(
    private readonly db: EafDatabase,
    readonly envStore: EnvironmentStore,
    /**
     * R100 (agreement-row-integrity): the agreement retire lane consulted
     * before ANY service row is deleted (deleteService is the single choke
     * point for every regeneration/removal path). Duck-typed so the store
     * layer stays import-cycle-free; absent in minimal/migration contexts,
     * where deletion keeps the legacy FK-cascade behavior (migrations run
     * before agreements exist).
     */
    private readonly agreementRetirer?: {
      retireServiceAgreements(serviceId: string): unknown;
    },
  ) {
    this.computations = new ServiceComputationStore(db);
    this.hasSourceFlowColumn =
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('service_instances') WHERE name = 'source_flow_id'")
          .get() as { n: number }
      ).n > 0;
    this.hasZoneColumn =
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('service_instances') WHERE name = 'zone_id'")
          .get() as { n: number }
      ).n > 0;
    this.hasComputationsTable =
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('service_computations')")
          .get() as { n: number }
      ).n > 0;
  }

  // -------------------------------------------------------------------------
  // Catalog change notifications (P2 world-catalog → runtime sync)
  // -------------------------------------------------------------------------

  private readonly catalogChangeListeners = new Set<(envId: string) => void>();

  /**
   * P2: subscribe to catalog writes (publish / update / delete / visibility
   * toggle / derivation sync / restore). The listener fires AFTER the write
   * lands, with the env id; listener faults never break the write path.
   * Returns an unsubscribe function. NOTE: FK-cascade deletes (agent/device
   * removal) bypass the store write methods — the delete routes and the
   * proposal apply paths call `notifyCatalogChange` explicitly after the
   * cascade lands.
   */
  onCatalogChange(listener: (envId: string) => void): () => void {
    this.catalogChangeListeners.add(listener);
    return () => {
      this.catalogChangeListeners.delete(listener);
    };
  }

  /**
   * Fire the catalog-change listeners for one env. Public because FK-cascade
   * deletes (agent/device removal in the routes and proposal apply paths)
   * bypass the store write methods — those callers notify explicitly once the
   * cascade has landed. Listener faults never break the caller.
   */
  notifyCatalogChange(envId: string): void {
    for (const listener of this.catalogChangeListeners) {
      try {
        listener(envId);
      } catch {
        // Listener faults must never break the write path.
      }
    }
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  createService(input: CreateServiceInput): ServiceInstanceRow {
    const row: ServiceInstanceRow = {
      id: randomUUID(),
      env_id: input.envId,
      provider_agent_id: input.providerAgentId,
      name: input.name,
      semantic_type: input.semanticType,
      description: input.description ?? '',
      interface_json: JSON.stringify(input.interface ?? {}),
      origin: input.origin,
      source_device_id: input.sourceDeviceId ?? null,
      source_flow_id: input.sourceFlowId ?? null,
      // T-208: derived rows (device telemetry/actuation mirrors) default to
      // 'members' — patient heart-rate or SpO2 services no longer surface
      // PUBLIC in a shared multi-tenant world (HF-F04). Env members still
      // discover them; cross-env sharing becomes an explicit PATCH.
      // Published offers keep their explicit body-supplied visibility.
      visibility: input.visibility ?? (input.origin === 'derived' ? 'members' : 'public'),
      zone_id: input.zoneId ?? null,
      created_at: new Date().toISOString(),
    };
    this.insertServiceRow(row);
    this.notifyCatalogChange(row.env_id);
    return row;
  }

  /**
   * Shared INSERT with presence-probed optional columns (MI-D
   * schema-awareness — see `hasSourceFlowColumn`/`hasZoneColumn`: the
   * migration backfills run the live derivation sync against pre-v38/v47
   * schemas). Column ORDER in the INSERT is irrelevant (named columns).
   */
  private insertServiceRow(row: ServiceInstanceRow): void {
    const columns = [
      'id', 'env_id', 'provider_agent_id', 'name', 'semantic_type', 'description',
      'interface_json', 'origin', 'source_device_id', 'visibility', 'created_at',
    ];
    const values: unknown[] = [
      row.id, row.env_id, row.provider_agent_id, row.name, row.semantic_type,
      row.description, row.interface_json, row.origin, row.source_device_id,
      row.visibility, row.created_at,
    ];
    if (this.hasSourceFlowColumn) {
      columns.push('source_flow_id');
      values.push(row.source_flow_id);
    }
    if (this.hasZoneColumn) {
      columns.push('zone_id');
      values.push(row.zone_id);
    }
    this.db
      .prepare(
        `INSERT INTO service_instances (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      )
      .run(...values);
  }

  getService(id: string): ServiceInstanceRow | undefined {
    return this.db.prepare('SELECT * FROM service_instances WHERE id = ?').get(id) as
      | ServiceInstanceRow
      | undefined;
  }

  servicesOf(envId: string): ServiceInstanceRow[] {
    return this.db
      .prepare('SELECT * FROM service_instances WHERE env_id = ? ORDER BY created_at ASC, id ASC')
      .all(envId) as ServiceInstanceRow[];
  }

  servicesOfAgent(agentId: string): ServiceInstanceRow[] {
    return this.db
      .prepare(
        'SELECT * FROM service_instances WHERE provider_agent_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(agentId) as ServiceInstanceRow[];
  }

  updateService(id: string, patch: ServicePatch): ServiceInstanceRow {
    const existing = this.getService(id);
    if (!existing) {
      throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service "${id}" not found`);
    }
    const next: ServiceInstanceRow = {
      ...existing,
      name: patch.name ?? existing.name,
      semantic_type: patch.semanticType ?? existing.semantic_type,
      description: patch.description ?? existing.description,
      interface_json:
        patch.interface !== undefined ? JSON.stringify(patch.interface) : existing.interface_json,
      visibility: patch.visibility ?? existing.visibility,
    };
    this.db
      .prepare(
        `UPDATE service_instances
         SET name = ?, semantic_type = ?, description = ?, interface_json = ?, visibility = ?
         WHERE id = ?`,
      )
      .run(next.name, next.semantic_type, next.description, next.interface_json,
        next.visibility, id);
    this.notifyCatalogChange(next.env_id);
    return next;
  }

  deleteService(id: string): void {
    // Fetch first: the change notification needs the env id, and a delete of
    // a non-existent row is a no-op worth no rebuild.
    const existing = this.getService(id);
    if (existing === undefined) return;
    // R100 (wang-07): retire + unlink the row's agreements FIRST — the
    // service_agreements.service_id FK cascade must never physically
    // swallow an agreement or its usage/receipts ledger (v60 discipline,
    // generalized from agent removal to every service-row deletion).
    this.agreementRetirer?.retireServiceAgreements(id);
    this.db.prepare('DELETE FROM service_instances WHERE id = ?').run(id);
    this.notifyCatalogChange(existing.env_id);
  }

  /**
   * Re-insert a previously snapshotted service row with its ORIGINAL id and
   * created_at (T-209: the revert of a remove-agents proposal restores the
   * cascaded services verbatim, so subscriptions and references resolve).
   * D2: the declared zone_id restores verbatim too (the presence-probed
   * insert keeps migration-era backfills safe).
   */
  restoreService(row: ServiceInstanceRow): ServiceInstanceRow {
    this.insertServiceRow(row);
    this.notifyCatalogChange(row.env_id);
    return row;
  }

  /**
   * Mechanism D: the origin='flow' rows backed by one flow (the flows PATCH
   * route refreshes their generated interface when the flow's inputs surface
   * changes; flow deletion cascades the rows via FK instead).
   */
  servicesOfFlow(flowId: string): ServiceInstanceRow[] {
    return this.db
      .prepare(
        "SELECT * FROM service_instances WHERE source_flow_id = ? AND origin = 'flow'",
      )
      .all(flowId) as ServiceInstanceRow[];
  }

  // -------------------------------------------------------------------------
  // Derivation sync
  // -------------------------------------------------------------------------

  /**
   * Reconcile an agent's derived services with its current bindings:
   * expected = one row per (bound device × EXECUTABLE capability), named
   * `"<device name>: <capability>"`. Missing rows are created, stale rows
   * (unbound device / dropped capability / now-type-dead capability) are
   * deleted, renames are applied. User-toggled visibility on surviving rows
   * is preserved.
   *
   * T-207 (R11-corrective order): a derived service is only contracted for
   * capabilities with an executable path ON THAT DEVICE TYPE — the oracle
   * decides first (telemetry derives on any declaring type), name-level
   * actuation handlers are then judged by catalog type metadata with the
   * regex family table as fallback (`deviceExecutesCapability`, the T-002
   * oracle name-level executability is not enough: `set-brightness` is
   * globally executable but type-dead on a display, RF-F07). Dead
   * capabilities stay VISIBLE as device fields/warnings; they just stop
   * being contracted as services. hass:// devices keep full derivation
   * (real hardware — the registry cannot speak for them).
   */
  syncDerivedForAgent(agentId: string): DerivedSyncChange[] {
    const agent = this.envStore.getAgent(agentId);
    if (!agent) return [];

    const typeUniverses = catalogTypeUniverses(this.db);
    const expected = new Map<string, DerivedServiceSpec>();
    for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
      const device = this.envStore.getDevice(deviceId);
      if (!device) continue;
      for (const spec of derivedServiceSpecs(device, typeUniverses)) {
        expected.set(derivedKey(device.id, spec.semanticType), spec);
      }
    }

    const changes: DerivedSyncChange[] = [];
    const existing = this.derivedServicesOfAgent(agentId);
    for (const row of existing) {
      const key =
        row.source_device_id !== null ? derivedKey(row.source_device_id, row.semantic_type) : null;
      const match = key !== null ? expected.get(key) : undefined;
      if (match === undefined) {
        this.deleteService(row.id);
        changes.push({ action: 'deleted', row });
        continue;
      }
      expected.delete(key!);
      // Fix-15 (F-27): derived rows expose the backing device's executable
      // command surface; refresh it together with renames/capability changes.
      // T-043: the interface is the HONEST surface — executable commands of
      // capabilities that pass the type filter, plus this capability's own
      // dispatch path (a display's 'content-display' row advertises
      // set-message, not the type-dead set-brightness).
      // D4 (T-081): while the row's computation is the AUTO-MINT, the
      // dataSchema block is part of the expected interface (pure function of
      // device+capability — stable across syncs, no churn). An EXPLICIT
      // provider registration owns the interface instead (never clobbered);
      // no computation at all (param-less device, or the provider revoked
      // the mint) means no dataSchema either — the read lane is withdrawn.
      const expectedInterface = this.withAutoMintDataSchema(
        row,
        derivedInterface(match.device, typeUniverses, match.surface),
        match.capability,
        match.device,
      );
      const patch: ServicePatch = {};
      const { name: expectedName, description: expectedDescription } = derivedRowLabels(match);
      if (row.name !== expectedName) patch.name = expectedName;
      if (row.description !== expectedDescription) patch.description = expectedDescription;
      if (row.interface_json !== JSON.stringify(expectedInterface)) patch.interface = expectedInterface;
      if (patch.name !== undefined || patch.interface !== undefined || patch.description !== undefined) {
        const updated = this.updateService(row.id, patch);
        changes.push({ action: 'updated', row: updated });
      }
    }
    for (const spec of expected.values()) {
      const { name, description } = derivedRowLabels(spec);
      // D4 (T-081): the mint seam — when the source device has a readable
      // parameter that maps to this capability, the platform auto-registers
      // a minimal device-aggregate ComputationSpec over that single device
      // (the T-065 per-bed pattern generalized) and the generated interface
      // carries the matching dataSchema. Removes the double ceremony for
      // "I want to read my sensor's data as a service". Marked
      // autoMinted:true; an explicit provider registration REPLACES it.
      // Devices without readable params mint nothing (SERVICE_DERIVED_READONLY
      // stays for them).
      const readableParams = readableParamsForDevice(spec.device, spec.capability);
      const row = this.createService({
        envId: agent.env_id,
        providerAgentId: agent.id,
        name,
        semanticType: spec.semanticType,
        description,
        // Fix-15 (F-27): the callable surface of the backing device, so
        // invoke consumers can discover action names + parameter schemas
        // instead of guessing (the service contract was empty before).
        interface: readableParams.length > 0
          ? {
              ...derivedInterface(spec.device, typeUniverses, spec.surface),
              dataSchema: autoMintDataSchema(readableParams),
            }
          : derivedInterface(spec.device, typeUniverses, spec.surface),
        origin: 'derived',
        sourceDeviceId: spec.device.id,
        // R15 (FR15-F02): the agent's install-time declaration wins for
        // NEWLY derived rows — a per-bed vitals agent installed with
        // derivedServiceVisibility:'hidden' never exposes its services at
        // 'members' for even a moment (the live-round leak window was
        // derivation-members → hide-PATCH minutes later). NULL keeps the
        // stored 'members' default (T-208); whether members rows actually
        // read as public is decided at READ time by the env-level
        // derivedServiceVisibilityMode overlay (public envs default public,
        // knob only tightens). Surviving rows keep their user-toggled
        // visibility (this path only creates).
        ...(agent.derived_service_visibility === 'hidden' ||
            agent.derived_service_visibility === 'members'
          ? { visibility: agent.derived_service_visibility }
          : {}),
      });
      if (readableParams.length > 0 && this.hasComputationsTable) {
        this.computations.registerComputation({
          serviceId: row.id,
          kind: 'device-aggregate',
          specJson: JSON.stringify(autoMintSpec(spec.device.id, spec.capability, readableParams)),
          schemaVersion: 1,
          // The mint acts for the provider (their device, their lane — the
          // fiduciary is the agent's owner).
          registeredBy: agent.owner_id,
        });
      }
      changes.push({ action: 'created', row });
    }

    // R53: semantic (aggregate) offers — the agent-level service face over
    // its capability bundle. Rules live in core (semantic-offers.ts); rows
    // use origin='aggregate' so the device-derived cleanup above never
    // touches them, and the semantic types join the agent's DECLARED
    // capabilities so AC partner matching speaks the semantic level.
    changes.push(...this.syncAggregateOffers(agent));
    return changes;
  }

  /**
   * P3: the world's scenario-authored offer rules (imported into map data;
   * absent on legacy/patched worlds = built-in rules only).
   */
  private scenarioOfferRulesOf(envId: string): SemanticOfferRule[] {
    const env = this.envStore.getEnvironment(envId);
    if (env === undefined) return [];
    return parseMapData(env).semanticOfferRules ?? [];
  }

  /**
   * P3: land a scenario agent's author-DECLARED semantic services
   * (`agents[].services`) as origin='published' rows. Unlike aggregate
   * offers these are not derived from the capability bundle — the offer
   * exists because the author says so (same posture as an API-published
   * offer, incl. the unbacked-tolerance). The callable interface is
   * grounded the same way as aggregate offers (the bound devices'
   * executable surface under requires∪actuates). One-shot: the import
   * creates a FRESH environment per call inside one transaction, so there
   * is no re-run lane to idempotence-guard against and no 'imported'
   * marker column to maintain — origin='published' + the import
   * transaction are the whole story.
   */
  importDeclaredServices(
    agentId: string,
    services: readonly SemanticOfferRule[],
  ): ServiceInstanceRow[] {
    const agent = this.envStore.getAgent(agentId);
    if (!agent) return [];
    // The declared semantic face follows the environment's visibility, same
    // as the read-time overlay for derived/aggregate rows (设备私有、服务公开):
    // public envs get publicly visible declared offers, non-public envs keep
    // the members default; the provider can tighten like any other row.
    const envVisibility = this.envStore.getEnvironment(agent.env_id)?.visibility;
    const visibility = envVisibility === 'public' ? 'public' : 'members';
    return services.map(rule =>
      this.createService({
        envId: agent.env_id,
        providerAgentId: agent.id,
        name: rule.label,
        semanticType: rule.semanticType,
        description: rule.description,
        interface: this.aggregateInterface(agent, rule),
        origin: 'published',
        sourceDeviceId: null,
        visibility,
      }),
    );
  }

  /**
   * R53: the offer's callable surface — the executable commands of the
   * agent's bound devices under the rule's actuation capabilities.
   */
  private aggregateInterface(agent: AgentInstanceRow, rule: SemanticOfferRule): Record<string, unknown> {
    const typeUniverses = catalogTypeUniverses(this.db);
    const commands = new Set<string>();
    for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
      const device = this.envStore.getDevice(deviceId);
      if (!device) continue;
      for (const capability of parseJsonArray<string>(device.capabilities_json)) {
        // The offer's operational vocabulary: the qualifying capabilities
        // (requires ∪ actuates) plus any directly executable capability of
        // the same devices — umbrella types like valve-control resolve via
        // the catalog where one exists, raw commands ride along otherwise.
        const qualifying =
          rule.requires.includes(capability) ||
          rule.actuates.includes(capability) ||
          isCapabilityExecutable(capability);
        if (!qualifying) continue;
        const surface =
          executableCommandPath(asScenarioDevice(device), capability, isCapabilityExecutable) ?? [];
        for (const command of surface) commands.add(command);
      }
    }
    return serviceInterfaceForCapabilities([...commands]);
  }

  /**
   * R53: derive/refresh/remove the agent's aggregate offers. Idempotent by
   * (provider, semanticType); the callable interface is the actuation
   * backing's executable command surface (serviceInterfaceForCapabilities).
   * P3: the rule table is the built-ins merged with the world's
   * scenario-authored rules (mapData.semanticOfferRules — custom wins on
   * semanticType collisions), so a scenario's own vocabulary derives the
   * same rows the runtime face registers.
   */
  private syncAggregateOffers(agent: AgentInstanceRow): DerivedSyncChange[] {
    const union = new Set<string>(parseJsonArray<string>(agent.capabilities_json));
    for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
      const device = this.envStore.getDevice(deviceId);
      if (!device) continue;
      for (const capability of parseJsonArray<string>(device.capabilities_json)) {
        union.add(capability);
      }
    }
    const rules = mergeOfferRules(this.scenarioOfferRulesOf(agent.env_id));
    const wanted = new Map(semanticOffersOf(union, rules).map(rule => [rule.semanticType, rule]));
    const changes: DerivedSyncChange[] = [];

    const existing = this.db
      .prepare(
        `SELECT * FROM service_instances
         WHERE provider_agent_id = ? AND origin = 'aggregate'`,
      )
      .all(agent.id) as ServiceInstanceRow[];
    for (const row of existing) {
      const rule = wanted.get(row.semantic_type);
      if (rule === undefined) {
        this.deleteService(row.id);
        changes.push({ action: 'deleted', row });
        continue;
      }
      wanted.delete(row.semantic_type);
      const patch: ServicePatch = {};
      if (row.name !== rule.label) patch.name = rule.label;
      if (row.description !== rule.description) patch.description = rule.description;
      const expectedInterface = this.aggregateInterface(agent, rule);
      if (row.interface_json !== JSON.stringify(expectedInterface)) patch.interface = expectedInterface;
      if (Object.keys(patch).length > 0) {
        const updated = this.updateService(row.id, patch);
        changes.push({ action: 'updated', row: updated });
      }
    }
    for (const rule of wanted.values()) {
      const row = this.createService({
        envId: agent.env_id,
        providerAgentId: agent.id,
        name: rule.label,
        semanticType: rule.semanticType,
        description: rule.description,
        // The callable surface of the offer = the EXECUTABLE commands the
        // agent's bound devices expose under the actuation capabilities
        // (same grounding as device-derived rows — the static capability
        // contract alone can be empty for umbrella types like valve-control).
        interface: this.aggregateInterface(agent, rule),
        origin: 'aggregate',
        sourceDeviceId: null,
        // Aggregate offers are the collaboration face — members-visible by
        // default; the provider can tighten like any other row.
        visibility: 'members',
      });
      changes.push({ action: 'created', row });
    }

    // NOTE (R53 design correction): the stored capabilities stay CLEAN —
    // the semantic surface joins the runtime matching via the
    // environment-bridge at scenario assembly instead. Mutating the stored
    // declaration here made the PATCH backing check
    // (AGENT_CAPABILITIES_UNBACKED) reject legitimate rebinding once a
    // qualifying device left the bundle.
    return changes;
  }

  /**
   * D4 (T-081): extend a derived row's expected interface with the auto-mint
   * dataSchema ONLY while the stored computation is the platform's mint —
   * an explicit provider override owns the interface, and a revoked mint
   * means the read lane (and its schema) is gone.
   */
  private withAutoMintDataSchema(
    row: ServiceInstanceRow,
    base: Record<string, unknown>,
    capability: string,
    device: DeviceInstanceRow,
  ): Record<string, unknown> {
    if (!this.hasComputationsTable) return base; // pre-v32 migration backfill
    const stored = this.computations.computationOf(row.id);
    if (stored === undefined || !isAutoMintedSpec(stored)) return base;
    const params = readableParamsForDevice(device, capability);
    return params.length > 0 ? { ...base, dataSchema: autoMintDataSchema(params) } : base;
  }

  /** Re-sync every agent bound to `deviceId` (capability change / rename). */
  syncDerivedForDevice(deviceId: string): DerivedSyncChange[] {
    const device = this.envStore.getDevice(deviceId);
    if (!device) return [];
    const changes: DerivedSyncChange[] = [];
    for (const agent of this.envStore.agentsOf(device.env_id)) {
      if (parseJsonArray<string>(agent.bound_device_ids_json).includes(deviceId)) {
        changes.push(...this.syncDerivedForAgent(agent.id));
      }
    }
    return changes;
  }

  /**
   * T-503 (EC24-F01, R24) — RETIRED with its only consumer by D2 (T-079,
   * DevLoop R28): the zone-provable vocabulary taught at zone-pinned ask
   * creation. §11.2(6) amended — published/flow services may declare a
   * zoneId, so no semantic type is structurally unmatchable anymore and the
   * refusal gate (plus this vocabulary) is dead. Removed rather than kept
   * dead: a stale list reads as a live invariant.
   */

  /** Drop derived rows sourced from a device about to be deleted. */
  deleteDerivedForDevice(deviceId: string): DerivedSyncChange[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM service_instances
         WHERE source_device_id = ? AND origin = 'derived'`,
      )
      .all(deviceId) as ServiceInstanceRow[];
    for (const row of rows) this.deleteService(row.id);
    return rows.map(row => ({ action: 'deleted' as const, row }));
  }

  private derivedServicesOfAgent(agentId: string): ServiceInstanceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM service_instances
         WHERE provider_agent_id = ? AND origin = 'derived'`,
      )
      .all(agentId) as ServiceInstanceRow[];
  }

  // -------------------------------------------------------------------------
  // Computations + frame cache (R14 Wave-A, design-data-services.md)
  // — delegated to ServiceComputationStore (R21-W4 split, pure move)
  // -------------------------------------------------------------------------

  registerComputation(input: {
    serviceId: string;
    kind: ComputationRow['kind'];
    specJson: string;
    schemaVersion: number;
    registeredBy: string;
  }): ComputationRow {
    return this.computations.registerComputation(input);
  }

  computationOf(serviceId: string): ComputationRow | undefined {
    return this.computations.computationOf(serviceId);
  }

  /** Revoke the computation (consumable flips back; §7 governs active agreements). */
  revokeComputation(serviceId: string): boolean {
    return this.computations.revokeComputation(serviceId);
  }

  /** Overwrite the per-service frame cache on every successful evaluation. */
  saveFrame(input: {
    serviceId: string;
    frameJson: string;
    computedAtWall: string;
    simulationId: string;
    simTimeSec: number;
  }): void {
    this.computations.saveFrame(input);
  }

  latestFrameOf(serviceId: string): ServiceDataFrameRow | undefined {
    return this.computations.latestFrameOf(serviceId);
  }

  /**
   * T81 (R8, u2-F4): drop the per-service cached frame — re-registration is
   * an atomic spec swap, and an old-generation frame must never survive it.
   */
  invalidateFramesOf(serviceId: string): void {
    this.computations.invalidateFrames(serviceId);
  }

  // -------------------------------------------------------------------------
  // Access grants + requests (T-058b, design-consent-semantics.md §4)
  // -------------------------------------------------------------------------

  createAccessRequest(input: {
    serviceId: string;
    requesterId: string;
    purpose: string;
    durationDays: number | null;
  }): AccessRequestRow {
    const row: AccessRequestRow = {
      id: randomUUID(),
      service_id: input.serviceId,
      requester_id: input.requesterId,
      purpose: input.purpose,
      duration_days: input.durationDays,
      status: 'pending',
      created_at: new Date().toISOString(),
      decided_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO service_access_requests
           (id, service_id, requester_id, purpose, duration_days, status, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.service_id, row.requester_id, row.purpose, row.duration_days,
        row.status, row.created_at, row.decided_at,
      );
    return row;
  }

  accessRequest(id: string): AccessRequestRow | undefined {
    return this.db
      .prepare('SELECT * FROM service_access_requests WHERE id = ?')
      .get(id) as AccessRequestRow | undefined;
  }

  accessRequestsOf(serviceId: string): AccessRequestRow[] {
    return this.db
      .prepare(
        'SELECT * FROM service_access_requests WHERE service_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(serviceId) as AccessRequestRow[];
  }

  /** Close a request (withdraw by the requester / explicit reject by the provider). */
  closeAccessRequest(id: string, status: 'withdrawn' | 'rejected' | 'granted'): AccessRequestRow {
    const decidedAt = new Date().toISOString();
    this.db
      .prepare('UPDATE service_access_requests SET status = ?, decided_at = ? WHERE id = ?')
      .run(status, decidedAt, id);
    return this.accessRequest(id)!;
  }

  /**
   * Grant (or EXTEND — the UNIQUE(service, grantee) makes a repeat grant an
   * expiry extension) access to a hidden service. Pure persistence: routes
   * validate the grantee/basis shape before this runs.
   */
  grantAccess(input: {
    serviceId: string;
    granteeUserId: string;
    grantedBy: string;
    expiresAt: string;
    basis: string | null;
    dataSubject: DataSubjectLabel | null;
    requestId: string | null;
  }): AccessGrantRow {
    const grantedAt = new Date().toISOString();
    const dataSubjectJson = input.dataSubject !== null ? JSON.stringify(input.dataSubject) : null;
    this.db
      .prepare(
        `INSERT INTO service_access_grants
           (id, service_id, grantee_user_id, granted_by, granted_at, expires_at,
            basis, data_subject_json, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(service_id, grantee_user_id) DO UPDATE SET
           granted_by = excluded.granted_by,
           granted_at = excluded.granted_at,
           expires_at = excluded.expires_at,
           basis = excluded.basis,
           data_subject_json = excluded.data_subject_json,
           request_id = excluded.request_id`,
      )
      .run(
        randomUUID(), input.serviceId, input.granteeUserId, input.grantedBy, grantedAt,
        input.expiresAt, input.basis, dataSubjectJson, input.requestId,
      );
    return this.grantOf(input.serviceId, input.granteeUserId)!;
  }

  grantOf(serviceId: string, granteeUserId: string): AccessGrantRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM service_access_grants WHERE service_id = ? AND grantee_user_id = ?',
      )
      .get(serviceId, granteeUserId) as AccessGrantRow | undefined;
  }

  grantsOf(serviceId: string): AccessGrantRow[] {
    return this.db
      .prepare(
        'SELECT * FROM service_access_grants WHERE service_id = ? ORDER BY granted_at ASC, id ASC',
      )
      .all(serviceId) as AccessGrantRow[];
  }

  /** Revoke one grantee's grant (canSee falls back to 404 immediately). */
  revokeAccess(serviceId: string, granteeUserId: string): boolean {
    return this.db
      .prepare(
        'DELETE FROM service_access_grants WHERE service_id = ? AND grantee_user_id = ?',
      )
      .run(serviceId, granteeUserId).changes > 0;
  }

  /**
   * T-067 (R16): SHORTEN an existing grant's expiry — the test-deployment
   * expiry boundary probe. Only reachable through the env-flag-gated admin
   * route (EAF_ALLOW_GRANT_TIME_CONTROL=1); the route enforces env-owner +
   * shorten-only before this runs. Extensions stay on the grant lane
   * (`grantAccess` UNIQUE upsert).
   */
  shortenGrantExpiry(serviceId: string, granteeUserId: string, expiresAt: string): AccessGrantRow | undefined {
    this.db
      .prepare(
        'UPDATE service_access_grants SET expires_at = ? WHERE service_id = ? AND grantee_user_id = ?',
      )
      .run(expiresAt, serviceId, granteeUserId);
    return this.grantOf(serviceId, granteeUserId);
  }

  /**
   * T-058b §4.1: does `userId` hold an UNEXPIRED grant on this service? The
   * door check behind every canSeeService call on hidden services — callers
   * additionally require env membership (design: grants are for members).
   */
  hasActiveAccessGrant(serviceId: string, userId: string | null): boolean {
    if (userId === null) return false;
    const row = this.grantOf(serviceId, userId);
    if (row === undefined) return false;
    const expiresMs = Date.parse(row.expires_at);
    return Number.isFinite(expiresMs) ? expiresMs > Date.now() : true;
  }

  // -------------------------------------------------------------------------
  // Subscriptions (W5) — "我依赖的服务" bookmarks
  // -------------------------------------------------------------------------

  /**
   * Bookmark a service for a user. Idempotent: the UNIQUE(user_id,
   * service_id) constraint makes a repeat subscribe a no-op, reported via
   * `alreadySubscribed`.
   */
  subscribe(userId: string, service: ServiceInstanceRow): ServiceSubscription {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO service_subscriptions (user_id, service_id, env_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(userId, service.id, service.env_id, createdAt);
    if (result.changes > 0) {
      return { userId, serviceId: service.id, envId: service.env_id, createdAt, alreadySubscribed: false };
    }
    const existing = this.db
      .prepare('SELECT created_at FROM service_subscriptions WHERE user_id = ? AND service_id = ?')
      .get(userId, service.id) as { created_at: string };
    return {
      userId,
      serviceId: service.id,
      envId: service.env_id,
      createdAt: existing.created_at,
      alreadySubscribed: true,
    };
  }

  /** Remove a bookmark (idempotent — deleting nothing is fine). */
  unsubscribe(userId: string, serviceId: string): void {
    this.db
      .prepare('DELETE FROM service_subscriptions WHERE user_id = ? AND service_id = ?')
      .run(userId, serviceId);
  }

  /**
   * T-049: how many users bookmarked one service — the remove-agents rule
   * check names this count so the approver sees the marketplace blast radius
   * (the FK cascade deletes subscriptions with the service).
   */
  countSubscriptionsOfService(serviceId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM service_subscriptions WHERE service_id = ?')
      .get(serviceId) as { n: number };
    return row.n;
  }

  /** Service ids the user has bookmarked inside one environment. */
  subscribedServiceIds(userId: string, envId: string): string[] {
    return (
      this.db
        .prepare(
          'SELECT service_id FROM service_subscriptions WHERE user_id = ? AND env_id = ? ORDER BY created_at ASC',
        )
        .all(userId, envId) as { service_id: string }[]
    ).map(row => row.service_id);
  }

  /** The user's bookmarked services (optionally scoped to one environment). */
  subscriptionsOf(userId: string, envId?: string): ServiceInstanceRow[] {
    const sql =
      `SELECT s.* FROM service_instances s
       JOIN service_subscriptions sub ON sub.service_id = s.id
       WHERE sub.user_id = ?` + (envId !== undefined ? ' AND sub.env_id = ?' : '') +
      ' ORDER BY sub.created_at ASC, s.id ASC';
    return (envId !== undefined
      ? this.db.prepare(sql).all(userId, envId)
      : this.db.prepare(sql).all(userId)) as ServiceInstanceRow[];
  }

  /** envId → bookmark count for the workbench overview cards. */
  subscriptionCountsByEnv(userId: string): Map<string, number> {
    const rows = this.db
      .prepare(
        'SELECT env_id, COUNT(*) AS n FROM service_subscriptions WHERE user_id = ? GROUP BY env_id',
      )
      .all(userId) as { env_id: string; n: number }[];
    return new Map(rows.map(row => [row.env_id, row.n]));
  }
}

/** One subscription row as returned by `subscribe`. */
export interface ServiceSubscription {
  userId: string;
  serviceId: string;
  envId: string;
  createdAt: string;
  alreadySubscribed: boolean;
}

// ---------------------------------------------------------------------------
// Derivation helpers
// ---------------------------------------------------------------------------

function derivedKey(deviceId: string, capability: string): string {
  return `${deviceId}${capability}`;
}

/**
 * T-207 type-affinity (R11-corrective refactor): capability FAMILIES →
 * device types whose runtime has an EFFECT MODEL for them. Name-level
 * executability is not enough (RF-F07: `set-brightness` is a globally
 * registered command but type-dead on a display: it "succeeds" and nothing
 * changes).
 *
 * This table is the LAST-RESORT tier only — it applies when the device's
 * type is NOT known to the catalog (see `deviceExecutesCapability`): type
 * identity is CATALOG data, so a catalog-known type is judged by the
 * capabilities its models declare, not by an English substring. It is the
 * derivation-side bridge until the per-type effect-model tier (deferred
 * T-034) makes it structural.
 */
const CAPABILITY_TYPE_FAMILIES: ReadonlyArray<{ family: RegExp; types: RegExp }> = [
  // Brightness/illuminance actuation exists only on light-family devices.
  { family: /bright|dim|illumin/, types: /light|lamp|led|spot|strip/ },
  // Broadcast/audio output exists on the speaker/siren/PA family only.
  { family: /broadcast|audio|announce|(^|[-_])pa([-_]|$)|volume/, types: /speaker|siren|pa$|pa[-_]|sound|horn|amp/ },
  // Lock actuation exists on locks/gates/doors only.
  { family: /^(lock|unlock)/, types: /lock|gate|door/ },
  // Content/message surfaces exist on displays/signs/boards only.
  { family: /content|message|(^|[-_])text([-_]|$)|vms/, types: /display|screen|sign|board/ },
];

/**
 * Shared handler-name oracle (same instance pattern as the simulation
 * package's capability contract — handlers are stateless). Lets the
 * affinity tiers distinguish NAME-REGISTERED ACTUATION commands (the only
 * names a type check is meaningful for) from read/query names and
 * type-mapped semantics, without duplicating the registry's canHandle
 * internals.
 */
let affinityHandlerRegistry: CommandHandlerRegistry | undefined;
function hasRegisteredCommandHandler(capability: string): boolean {
  affinityHandlerRegistry ??= new CommandHandlerRegistry('capability-affinity', 'generic');
  return affinityHandlerRegistry.getHandler(capability) !== undefined;
}

/**
 * R11-corrective (T-047): catalog type metadata for the affinity tier.
 * Maps lowercased device type → union of capabilities that ACTIVE catalog
 * models of that type declare. A type present here is "known to the
 * catalog" and is judged by this metadata; absent types fall back to the
 * regex family table. Derived live from `device_models` so community
 * catalog types are honored without code changes.
 */
export function catalogTypeUniverses(db: EafDatabase): ReadonlyMap<string, ReadonlySet<string>> {
  const rows = db
    .prepare("SELECT device_type, capabilities_json FROM device_models WHERE status = 'active'")
    .all() as Array<{ device_type: string; capabilities_json: string }>;
  const universes = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = row.device_type.toLowerCase();
    let universe = universes.get(key);
    if (!universe) {
      universe = new Set();
      universes.set(key, universe);
    }
    for (const capability of parseJsonArray<string>(row.capabilities_json)) {
      universe.add(capability);
    }
  }
  return universes;
}

/**
 * T-207 (R11-corrective order): does THIS device type execute the
 * capability? The tiers, in decision order:
 *
 * 1. hass:// bindings trust every declaration (real hardware — the
 *    registry cannot speak for them).
 * 2. The EXECUTABLE-PATH ORACLE decides FIRST (`deviceProvidesExecutablePath`,
 *    core's T-002 oracle with the simulation registry's live verdict):
 *    read/query capabilities (a lux sensor's `brightness-reading`) and
 *    type-mapped semantics are legitimately executable on any type that
 *    declares them — the affinity tier must never suppress telemetry.
 * 3. Only what the oracle CANNOT express remains: a NAME-REGISTERED
 *    ACTUATION handler (e.g. `set-brightness` via the generic set-*
 *    handler) executes on EVERY type it is declared on, so whether it has
 *    an effect is a property of the TYPE. For such capabilities the
 *    affinity check runs — catalog metadata when the type is known (the
 *    type implements the family iff any of its catalog models declares a
 *    handler-backed member of the same family), the regex family table as
 *    a last resort for unknown types.
 *
 * Pure and exported (T-002 export pattern) so the v28 migration backfill
 * and tests run the EXACT derivation verdict.
 */
export function deviceExecutesCapability(
  device: DeviceInstanceRow,
  capability: string,
  typeUniverses?: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (device.binding?.startsWith('hass://')) return true;
  if (
    !deviceProvidesExecutablePath(
      {
        id: device.id,
        name: device.name,
        type: device.type,
        role: 'actuator',
        capabilities: parseJsonArray<string>(device.capabilities_json),
        zoneId: device.zone_id,
        binding: device.binding ?? `sim://${device.id}`,
      },
      capability,
      isCapabilityExecutable,
    )
  ) {
    return false; // no executable path at all — dead regardless of type
  }
  const family = CAPABILITY_TYPE_FAMILIES.find(rule =>
    rule.family.test(capability.toLowerCase()),
  );
  // No family, or not a name-registered actuation command (read/query name,
  // containment/semantic/expansion route): the oracle's verdict is final.
  if (family === undefined || !hasRegisteredCommandHandler(capability)) return true;
  const type = device.type.toLowerCase();
  const universe = typeUniverses?.get(type);
  if (universe !== undefined) {
    // Catalog-known type: metadata decides — the type implements the family
    // iff one of its models declares a handler-backed family member.
    return [...universe].some(
      member =>
        family.family.test(member.toLowerCase()) && hasRegisteredCommandHandler(member),
    );
  }
  // Unknown type: the regex family table is the last-resort fallback.
  return family.types.test(type);
}

// ---------------------------------------------------------------------------
// T-043 — honest semantic labels over the executable surface
//
// The label RULES (SEMANTIC_TYPE_SWITCHING / isSwitchingSurface /
// honestSemanticType / SWITCHING_COMMANDS) live in core's
// service/device-service-derivation.ts — the single derivation source of
// truth shared with the runtime face (imported + re-exported above). What
// stays here is the surface COMPUTATION, which needs the simulation command
// registry and the world device catalog.
// ---------------------------------------------------------------------------

/** ScenarioDevice adapter for the core executable-path oracle. */
function asScenarioDevice(device: DeviceInstanceRow) {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    role: 'actuator' as const,
    capabilities: parseJsonArray<string>(device.capabilities_json),
    zoneId: device.zone_id,
    binding: device.binding ?? `sim://${device.id}`,
  };
}

export interface DerivedServiceSpec {
  /** T-043: the honest semantic label for the derived row. */
  semanticType: string;
  /** The capability the row is derived FROM (name/description source). */
  capability: string;
  /** The executable command names the capability dispatches to here. */
  surface: readonly string[];
  device: DeviceInstanceRow;
}

/**
 * T-043 derivation core: one entry per (device × capability) that passes the
 * executability filter, each carrying its honest label and executable
 * surface. Capabilities whose surface collapses to pure switching are
 * DEDUPED: a device that also declares the switching commands directly keeps
 * only the verbatim rows (turn-on/turn-off), and multiple switching-only
 * marketing capabilities collapse into a single 'switching' row — the market
 * shows one honest switch per device, not three names for the same relay
 * (SF-R2 duplicate-services class).
 */
export function derivedServiceSpecs(
  device: DeviceInstanceRow,
  typeUniverses?: ReadonlyMap<string, ReadonlySet<string>>,
): DerivedServiceSpec[] {
  const specs: DerivedServiceSpec[] = [];
  const capabilities = parseJsonArray<string>(device.capabilities_json);
  const hasDirectSwitching = capabilities.some(
    capability => SWITCHING_COMMANDS.has(capability) && deviceExecutesCapability(device, capability, typeUniverses),
  );
  let switchingCollapsed = false;
  for (const capability of capabilities) {
    if (!deviceExecutesCapability(device, capability, typeUniverses)) continue;
    const surface =
      executableCommandPath(asScenarioDevice(device), capability, isCapabilityExecutable) ?? [];
    if (isSwitchingSurface(surface)) {
      // Direct switching declarations keep their verbatim labels; a
      // marketing capability that only reaches on/off collapses — skip it
      // entirely when the device already declares the switching commands,
      // else collapse all of them into one 'switching' row.
      if (SWITCHING_COMMANDS.has(capability)) {
        specs.push({ semanticType: capability, capability, surface, device });
        continue;
      }
      if (hasDirectSwitching || switchingCollapsed) continue;
      switchingCollapsed = true;
      specs.push({ semanticType: SEMANTIC_TYPE_SWITCHING, capability, surface, device });
      continue;
    }
    specs.push({ semanticType: honestSemanticType(capability, surface), capability, surface, device });
  }
  return specs;
}

// Fix-46 (B-agent P2-2): derived services carry a Chinese display name for
// well-known capabilities so the catalog is searchable in Chinese (`q=温度`
// finds `101 教室空调: 温度控制` instead of nothing). T-043: switching-only
// rows get the honest 开关控制 label instead of the marketing capability.

function derivedName(device: DeviceInstanceRow, capability: string): string {
  return `${device.name}: ${capabilityDisplayName(capability)}`;
}

/** T-043: honest name + description for one derived row spec. */
function derivedRowLabels(spec: DerivedServiceSpec): { name: string; description: string } {
  if (spec.semanticType === SEMANTIC_TYPE_SWITCHING) {
    return {
      name: `${spec.device.name}: ${capabilityDisplayName(SEMANTIC_TYPE_SWITCHING)}`,
      description:
        `由设备「${spec.device.name}」派生的开关能力 —— 该设备仅支持开启/关闭指令` +
        `（派生自能力 ${spec.capability}）`,
    };
  }
  return {
    name: derivedName(spec.device, spec.capability),
    description: `由设备「${spec.device.name}」派生的 ${spec.capability} 能力`,
  };
}

/**
 * Fix-15 (F-27) + T-043: a derived service's interface = the HONEST callable
 * surface of its backing device — the executable commands of every
 * capability that passes the type filter, PLUS this row's own dispatch path
 * (the semantic/multi-command route the capability actually takes here).
 * Pre-T-043 this listed every NAME-executable capability verbatim, so a
 * display's content-display row advertised the type-dead set-brightness.
 */
function derivedInterface(
  device: DeviceInstanceRow,
  typeUniverses?: ReadonlyMap<string, ReadonlySet<string>>,
  ownSurface: readonly string[] = [],
): Record<string, unknown> {
  const commands = new Set<string>();
  for (const capability of parseJsonArray<string>(device.capabilities_json)) {
    if (!deviceExecutesCapability(device, capability, typeUniverses)) continue;
    const surface =
      executableCommandPath(asScenarioDevice(device), capability, isCapabilityExecutable) ?? [];
    for (const command of surface) commands.add(command);
  }
  for (const command of ownSurface) commands.add(command);
  return serviceInterfaceForCapabilities([...commands]);
}

// ---------------------------------------------------------------------------
// Visibility + backing rules (shared by routes, detail assembly, the stream)
// ---------------------------------------------------------------------------

export interface ServiceViewer {
  userId: string | null;
  role: EnvRole | undefined;
}

/**
 * Can this viewer see a service with `visibility` offered by an agent owned
 * by `providerOwnerId` inside `env`? (The caller must already have read
 * access to the environment itself.)
 *
 * T-058b (design-consent-semantics.md §4.1): `options.accessGrant` — the
 * caller's verdict that the viewer holds an UNEXPIRED provider grant
 * (`ServiceStore.hasActiveAccessGrant`; membership required) — opens HIDDEN
 * services: the grant is the door (see / negotiate), the agreement remains
 * the contract. Everything else keeps the exact prior behavior, 404 with no
 * existence leak.
 */
export function canSeeService(
  visibility: ServiceVisibility,
  providerOwnerId: string,
  env: EnvironmentRow,
  viewer: ServiceViewer,
  options?: { accessGrant?: boolean; origin?: ServiceOrigin },
): boolean {
  // Derived-service visibility follows the environment (vision.md: 设备私有、
  // 服务公开 — the earlier members-only default left public worlds showing
  // every device but zero services, an inverted posture). On a PUBLIC
  // environment whose derived-service mode is 'public' (the default there —
  // mapData.derivedServiceVisibility:'members' retracts it), members-visible
  // DERIVED and AGGREGATE rows read as public for everyone: both origins are
  // auto-derived from device capabilities, so they share one posture.
  // Published offers keep their own value and hidden rows NEVER open
  // (privacy tiers are the provider's explicit choice).
  if (
    (options?.origin === 'derived' || options?.origin === 'aggregate') &&
    visibility === 'members' &&
    env.visibility === 'public' &&
    derivedServiceVisibilityMode(env) === 'public'
  ) {
    visibility = 'public';
  }
  if (visibility === 'public') return true;
  if (visibility === 'members') return viewer.role !== undefined;
  if (options?.accessGrant === true && viewer.role !== undefined) return true;
  return viewer.userId !== null && (viewer.userId === providerOwnerId || viewer.userId === env.owner_id);
}

/**
 * The env-level visibility mode for derived (and aggregate) services
 * (mapData.derivedServiceVisibility). The DEFAULT FOLLOWS THE ENVIRONMENT:
 * public envs default to 'public' (vision.md: 设备私有、服务公开), non-public
 * envs to 'members'. The explicit knob only ever TIGHTENS, never widens:
 * 'members' retracts the default even on a public env, while 'public' is
 * inert on a non-public env (no accidental leak past the env's own posture).
 * Exported so the env detail serializer can surface the live mode.
 */
export function derivedServiceVisibilityMode(env: EnvironmentRow): 'members' | 'public' {
  if (parseMapData(env).derivedServiceVisibility === 'members') return 'members';
  return env.visibility === 'public' ? 'public' : 'members';
}

/**
 * Capability universe backing an agent's services: the union of its bound
 * (still existing) devices' capabilities. A service whose semantic type is
 * outside this set is "unbacked" — legitimate (brokering others'
 * capability), but flagged so the UI can show it.
 */
export function backingCapabilities(
  agent: AgentInstanceRow,
  envStore: EnvironmentStore,
): Set<string> {
  const capabilities = new Set<string>();
  for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
    const device = envStore.getDevice(deviceId);
    if (!device) continue;
    for (const capability of parseJsonArray<string>(device.capabilities_json)) {
      capabilities.add(capability);
    }
  }
  return capabilities;
}

/**
 * T31 (R3 u2-F-04): the shared remedy sentence for an unbacked AGGREGATE
 * offer — the catalog face (aggregateBackingMissing.remedy) and the signing
 * gate's 409 SERVICE_NOT_BACKED (assertAggregateDeliverable) compose the
 * SAME sentence, so "can this be delivered?" never speaks two remedies.
 */
export const AGGREGATE_BACKING_REMEDY =
  'Bind a device holding one of those capabilities (PATCH /api/agents/:id boundDeviceIds) ' +
  'before contracting — signing now would land an agreement whose every invoke answers ' +
  '409 SERVICE_NOT_BACKED';

/**
 * The provider agent's bound devices holding at least one of the given
 * actuation capabilities — the byCapability condition every aggregate
 * judgment shares (signing gate, invoke lane, catalog flag, detail view).
 */
export function actuationBackedDevices(
  envStore: EnvironmentStore,
  providerAgentId: string,
  actuates: readonly string[],
): Array<{ deviceId: string; deviceName: string }> {
  const backed: Array<{ deviceId: string; deviceName: string }> = [];
  const agent = envStore.getAgent(providerAgentId);
  if (agent === undefined) return backed;
  for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
    const device = envStore.getDevice(deviceId);
    if (!device) continue;
    const caps = parseJsonArray<string>(device.capabilities_json);
    if (actuates.some(capability => caps.includes(capability))) {
      backed.push({ deviceId: device.id, deviceName: device.name });
    }
  }
  return backed;
}

export interface AggregateBackingEvaluation {
  /** The merged-table offer rule (built-in ∪ mapData.semanticOfferRules); undefined when the semantic type matches none. */
  rule: SemanticOfferRule | undefined;
  /** The provider agent's bound devices holding ≥1 of the rule's actuation capabilities. */
  actuationDevices: Array<{ deviceId: string; deviceName: string }>;
}

/**
 * T31: the ONE aggregate-backing judgment — rule resolution and actuation
 * device discovery in a single place. The signing gates
 * (assertAggregateDeliverable), the invoke lane, the catalog unbacked flag
 * (unbackedFlagsForEnv) and the agreement detail view (aggregateBackingView)
 * all read this, so "backed or not" can never be two answers again.
 */
export function evaluateAggregateBacking(
  envStore: EnvironmentStore,
  service: ServiceInstanceRow,
): AggregateBackingEvaluation {
  const env = envStore.getEnvironment(service.env_id);
  const scenarioRules = env !== undefined ? (parseMapData(env).semanticOfferRules ?? []) : [];
  const rule = mergeOfferRules(scenarioRules).find(rule => rule.semanticType === service.semantic_type);
  return {
    rule,
    actuationDevices:
      rule === undefined ? [] : actuationBackedDevices(envStore, service.provider_agent_id, rule.actuates),
  };
}

export interface AggregateRuleBackingView {
  kind: 'rule';
  rule: string;
  actuates: string[];
  devices: Array<{ id: string; name: string }>;
  callableActions: string[];
}

/**
 * T31: the catalog face of the aggregate backing — the same shape the
 * agreement detail's `backing` field carries (kind/rule/actuates/devices/
 * callableActions). null = genuinely unbacked (no resolvable rule OR no
 * bound device holding an actuation capability) — exactly the 409
 * SERVICE_NOT_BACKED class.
 */
export function aggregateRuleBackingView(
  envStore: EnvironmentStore,
  service: ServiceInstanceRow,
): AggregateRuleBackingView | null {
  if (service.origin !== 'aggregate') return null;
  const evaluation = evaluateAggregateBacking(envStore, service);
  if (evaluation.rule === undefined || evaluation.actuationDevices.length === 0) return null;
  const actions = new Set<string>();
  for (const { deviceId } of evaluation.actuationDevices) {
    const device = envStore.getDevice(deviceId);
    if (device === undefined) continue;
    for (const action of deviceExecutableCommandNames(
      parseJsonArray<string>(device.capabilities_json),
      device.type,
      device.binding,
    )) {
      actions.add(action);
    }
  }
  return {
    kind: 'rule',
    rule: service.semantic_type,
    actuates: [...evaluation.rule.actuates],
    devices: evaluation.actuationDevices.map(({ deviceId, deviceName }) => ({ id: deviceId, name: deviceName })),
    callableActions: [...actions].sort(),
  };
}

export interface AggregateBackingMissingView {
  /** false = the semantic type matches no rule of the merged (built-in ∪ scenario) table — the stale-rule 409 class. */
  ruleResolved: boolean;
  /** The rule's actuation capabilities when resolved; else []. */
  actuates: string[];
  /** The provider agent's currently bound devices (the devices the remedy would qualify). */
  boundDevices: Array<{ id: string; name: string }>;
  /** The same remedy the SERVICE_NOT_BACKED signing gate teaches (AGGREGATE_BACKING_REMEDY). */
  remedy: string;
}

/**
 * T28 (R3 u3-F1): DECLARATION drift — a capability-minted row (derived, the
 * aggregate offers minted from declared ∪ device capabilities, or — since
 * T53 (R6 u2-F-1-1) — a published offer) whose provider agent's DECLARED
 * capability set no longer covers the row's semantic capability. The row
 * SURVIVES (identity stability, the R2-T1 ruling: rows don't shrink on
 * withdrawal) and stays consumable (the bound device still executes) — but
 * the declaration/governance face has drifted, and the flow side already
 * warns "succeeding on borrowed authority". This is the catalog/agreement
 * face of the SAME drift: `declaredByProvider: false` until the capability
 * is re-declared, then gone (bidirectional, like the flow side's live
 * annotation).
 *
 * T53: PUBLISHED rows are IN the judgment. The old exemption ("a published
 * offer exists because the author says so, declaration-independent by
 * construction") assumed the publish lane validates the semantic type
 * against the declaring agent — it does not (POST …/agents/:agentId/services
 * never cross-checks), and published semantic types conventionally use
 * capability-family names (air-purification, temperature-reading …). So the
 * same withdrawal event annotated the derived face while the published face
 * stayed silent for the SAME provider + capability. Same `capabilityMatches`
 * judgment as derived — one event, one verdict on every face. A custom
 * semantic type no declared capability covers reads as drifted, which is the
 * honest face ("the provider never declared this"), not noise.
 *
 * FLOW rows stay exempt: their backing is the published FLOW (T-201 author
 * scope), not the agent's declared capability set — no capability face to
 * drift against.
 *
 * BUG-08 ①: AGGREGATE rows judge against the runtime bridge's declaration
 * surface (stored ∪ rule types from the capability union), not the stored
 * declaration alone — see the comment inside the function.
 */
export function declaredOfferDriftForEnv(
  envStore: EnvironmentStore,
  services: ServiceInstanceRow[],
): Map<string, boolean> {
  const declaredByAgent = new Map<string, string[]>();
  const declaredOf = (agentId: string): string[] => {
    let declared = declaredByAgent.get(agentId);
    if (!declared) {
      const agent = envStore.getAgent(agentId);
      declared = agent !== undefined ? parseJsonArray<string>(agent.capabilities_json) : [];
      declaredByAgent.set(agentId, declared);
    }
    return declared;
  };
  // BUG-08 ①: AGGREGATE rows are judged against the SAME declaration surface
  // the runtime bridge exposes (environment-bridge.ts: the stored declaration
  // ∪ the semantic rule types derived from the agent's capability union) —
  // an aggregate row's semantic type IS a rule name R53 deliberately never
  // writes back to the stored declaration, so judging it against the stored
  // set alone made every rule-backed aggregate drift from birth with no API
  // path to clear it. Chosen over a blanket origin='aggregate' exemption so
  // a genuinely lapsed rule (the union no longer qualifies) still reads
  // drifted instead of silently washing clean.
  const aggregateSurfaceByAgent = new Map<string, string[]>();
  const aggregateSurfaceOf = (agentId: string, envId: string): string[] => {
    let surface = aggregateSurfaceByAgent.get(agentId);
    if (!surface) {
      const agent = envStore.getAgent(agentId);
      const env = envStore.getEnvironment(envId);
      const scenarioRules = env !== undefined ? (parseMapData(env).semanticOfferRules ?? []) : [];
      const union = agent !== undefined
        ? new Set<string>([...declaredOf(agentId), ...backingCapabilities(agent, envStore)])
        : new Set<string>(declaredOf(agentId));
      surface = [...new Set([
        ...declaredOf(agentId),
        ...semanticCapabilityTypesOf(union, mergeOfferRules(scenarioRules)),
      ])];
      aggregateSurfaceByAgent.set(agentId, surface);
    }
    return surface;
  };
  return new Map(services.map(row => {
    if (row.origin !== 'derived' && row.origin !== 'aggregate' && row.origin !== 'published') {
      return [row.id, false] as const;
    }
    const candidates = row.origin === 'aggregate'
      ? aggregateSurfaceOf(row.provider_agent_id, row.env_id)
      : declaredOf(row.provider_agent_id);
    const drifted = !candidates.some(candidate => capabilityMatches(candidate, row.semantic_type));
    return [row.id, drifted] as const;
  }));
}

/** Single-row convenience over declaredOfferDriftForEnv (detail faces). */
export function declaredOfferDriftOf(
  envStore: EnvironmentStore,
  row: ServiceInstanceRow,
): boolean {
  return declaredOfferDriftForEnv(envStore, [row]).get(row.id) ?? false;
}

/**
 * T31: what an unbacked AGGREGATE offer is missing — the catalog-side
 * diagnosis mirroring the signing gate's 409 teaching (missing rule, or the
 * required actuation capabilities + the bound-device list + the PATCH
 * boundDeviceIds remedy).
 */
export function aggregateBackingMissing(
  envStore: EnvironmentStore,
  service: ServiceInstanceRow,
): AggregateBackingMissingView {
  const evaluation = evaluateAggregateBacking(envStore, service);
  const boundDevices: Array<{ id: string; name: string }> = [];
  const agent = envStore.getAgent(service.provider_agent_id);
  if (agent !== undefined) {
    for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
      const device = envStore.getDevice(deviceId);
      if (device !== undefined) boundDevices.push({ id: device.id, name: device.name });
    }
  }
  return {
    ruleResolved: evaluation.rule !== undefined,
    actuates: evaluation.rule !== undefined ? [...evaluation.rule.actuates] : [],
    boundDevices,
    remedy: AGGREGATE_BACKING_REMEDY,
  };
}

/** serviceId → unbacked flag for every service in an environment. */
export function unbackedFlagsForEnv(
  envStore: EnvironmentStore,
  services: ServiceInstanceRow[],
): Map<string, boolean> {
  const backingByAgent = new Map<string, Set<string>>();
  const backingOf = (agentId: string): Set<string> => {
    let backing = backingByAgent.get(agentId);
    if (!backing) {
      const agent = envStore.getAgent(agentId);
      backing = agent ? backingCapabilities(agent, envStore) : new Set<string>();
      backingByAgent.set(agentId, backing);
    }
    return backing;
  };
  // T-043: DERIVED rows are backed by definition — they exist only because
  // the derivation filter found an executable path on their pinned source
  // device (their honest labels — e.g. 'switching' — intentionally do NOT
  // appear in any capability declaration). The universe check stays for
  // PUBLISHED offers, where an unbacked semantic type is a real finding.
  // Mechanism D: origin='flow' rows are backed by their PUBLISHED FLOW the
  // same way (publish refuses unknown/disabled/surface-less flows), so they
  // are consumable — invoke delivers a flow run, not a device command.
  // T31 (R3 u2-F-04): AGGREGATE rows lose their hardcoded backed=false —
  // they now run the SAME rule-lane judgment as the signing gates
  // (assertAggregateDeliverable) and the invoke lane: the merged offer-rule
  // table must resolve the semantic type AND at least one bound device must
  // hold one of the rule's actuation capabilities. The old hardcode said
  // "backed" while propose answered 409 SERVICE_NOT_BACKED — two judgments,
  // opposite verdicts.
  return new Map(services.map(row => {
    if (row.origin === 'derived' || row.origin === 'flow') return [row.id, false] as const;
    if (row.origin === 'aggregate') {
      const evaluation = evaluateAggregateBacking(envStore, row);
      return [row.id, evaluation.rule === undefined || evaluation.actuationDevices.length === 0] as const;
    }
    return [row.id, !backingOf(row.provider_agent_id).has(row.semantic_type)] as const;
  }));
}

// ---------------------------------------------------------------------------
// Mechanism D — the flow-service interface (design §5.1/§5.2)
// ---------------------------------------------------------------------------

/**
 * Generate a flow-service's interface FROM the flow's declared inputs
 * surface (the derived-interface design idea, Fix-15/F-27, applied to flows):
 * the callable surface is exactly one action — 'run' — whose parameters are
 * the flow's inputs (name → {type, required?, default?, min?, max?, enum?}),
 * plus the flow identity and the Wave-A caution surfaced as data: the
 * DELEGATE-NODE COUNT, so a consumer can see whether one "deterministic"
 * call may internally consult agent judgment (bounded by timeoutMs) before
 * contracting.
 */
export function flowServiceInterface(flow: FlowDefinition): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  for (const input of flow.inputs ?? []) {
    parameters[input.name] = {
      type: input.type,
      ...(input.required === true ? { required: true } : {}),
      ...(input.default !== undefined ? { default: input.default } : {}),
      ...(input.min !== undefined ? { min: input.min } : {}),
      ...(input.max !== undefined ? { max: input.max } : {}),
      ...(input.enum !== undefined ? { enum: input.enum } : {}),
    };
  }
  return {
    kind: 'flow',
    flowId: flow.id,
    flowName: flow.name,
    actions: [{ name: 'run', parameters }],
    delegateNodeCount: flow.plan.nodes.filter(node => node.delegate !== undefined).length,
  };
}
