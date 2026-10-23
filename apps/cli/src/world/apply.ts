/**
 * Apply — reconcile a world document with the platform (kubectl-style).
 *
 * Semantics:
 * - Environment matched by EXACT NAME among the caller's own environments;
 *   created (with the map) when missing, PATCHed when mapData changed.
 * - Devices/agents are upserted BY NAME within the env: created when
 *   missing, patched when changed, never deleted — unless `prune` is set,
 *   which deletes objects absent from the document (reported in the summary).
 * - Every per-object failure is collected into `errors` and reported at the
 *   end; processing continues so one bad entry never hides the others.
 * - When the environment would be CREATED by this apply, every intra-document
 *   reference (device/agent/event zone ids, agent binds, catalog models) is
 *   validated up front — a failed apply never leaves an empty garbage
 *   environment behind (Fix-6).
 * - With a simulation: block, live sims on the environment are detected
 *   first (T-029): `--reuse-sim` attaches to the newest one instead of
 *   creating another; without it a prominent warning lists the sims being
 *   left behind (each apply used to silently leak a running sim until the
 *   running_sims_per_user quota rejected the create).
 */

import type { ApiClient } from '../client.js';
import type { Ctx, EnvDetail, EnvMapEvent, EnvProposal, EnvZone } from '../ctx.js';
import { isEnvProposal } from '../ctx.js';
import { MAP_META_FIELDS, type WorldDevice, type WorldDocument, type WorldMap } from './document.js';
import { renameDevicePins } from './flow-refs.js';

export interface NamedId {
  id: string;
  name: string;
}

/**
 * T-076 (R22, CC-F07): a create that went through governance. When the
 * pipeline AUTO-APPLIED the proposal, `id` is the CREATED OBJECT's id (from
 * the Fix-10 createdIds echo) so callers chain without a second lookup;
 * `proposal` records the governance wrapper for transparency. Entries whose
 * proposal is still PENDING are NOT created objects — they land in
 * `warnings` instead (see pendingCreateNote) and never poison name→id
 * resolution (the proposal id used to masquerade as a device id, and later
 * agent binds addressed a proposal: the "flow node pointed at a proposal
 * id" 422 trap).
 */
export interface GovernedCreate extends NamedId {
  proposal?: { id: string; status: string };
}

export interface ChangeSet {
  created: GovernedCreate[];
  updated: NamedId[];
  unchanged: NamedId[];
  deleted: NamedId[];
}

export interface ApplySummary {
  envId: string;
  envName: string;
  envAction: 'created' | 'updated' | 'unchanged';
  devices: ChangeSet;
  agents: ChangeSet;
  simulationId?: string;
  simulationState?: string;
  /**
   * T-029 (DevLoop R17, EC-F10): true when the simulation block attached to
   * an already-live simulation (`--reuse-sim`) instead of creating one.
   */
  simulationReused?: boolean;
  /**
   * T-029: non-fatal advisories. Carrying them in the summary (not errors)
   * keeps apply's exit code honest — e.g. the "you are stacking running
   * simulations" warning that precedes a QUOTA_EXCEEDED.
   */
  warnings: string[];
  errors: string[];
}

/** Live (quota-counted) sim states — mirrors the server's running_sims_per_user budget. */
const LIVE_SIM_STATES = new Set(['running', 'paused']);

interface SimListEntry {
  id: string;
  state: string;
  /** T-087: the env's authoritative world session, surfaced in the list. */
  platformOwned?: boolean;
}

const emptyChanges = (): ChangeSet => ({ created: [], updated: [], unchanged: [], deleted: [] });

/** Canonical stringify (sorted object keys) for stable deep comparisons. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const sortedCopy = (values: string[]): string[] => [...values].sort();
const sameStrings = (a: string[], b: string[]): boolean =>
  canonical(sortedCopy(a)) === canonical(sortedCopy(b));

/** Normalize map data the way the server stores it (undefined keys dropped). */
function mapDataFrom(map: WorldMap, events: EnvMapEvent[] | undefined): Record<string, unknown> {
  const meta: Record<string, number> = {};
  for (const field of MAP_META_FIELDS) {
    if (typeof map[field] === 'number') meta[field] = map[field] as number;
  }
  return {
    ...(map.center ? { center: map.center } : {}),
    ...(map.zoom !== undefined ? { zoom: map.zoom } : {}),
    ...meta,
    // R40-B4: demo metadata rides mapData (the server accepts it on both
    // create and patch — parseDemoInput).
    ...(map.demo !== undefined ? { demo: map.demo } : {}),
    zones: map.zones,
    ...(events !== undefined ? { events } : {}),
  };
}

function currentMapData(detail: EnvDetail): Record<string, unknown> {
  const meta: Record<string, number> = {};
  for (const field of MAP_META_FIELDS) {
    const value = detail[field];
    if (typeof value === 'number') meta[field] = value;
  }
  return {
    ...(detail.mapCenter ? { center: detail.mapCenter } : {}),
    ...(detail.mapZoom !== null && detail.mapZoom !== undefined ? { zoom: detail.mapZoom } : {}),
    ...meta,
    ...(detail.demo !== null && detail.demo !== undefined ? { demo: detail.demo } : {}),
    zones: detail.zones,
    ...(detail.events.length > 0 ? { events: detail.events } : {}),
  };
}

export async function applyDocument(
  ctx: Ctx,
  document: WorldDocument,
  options: { prune: boolean; reuseSim?: boolean },
): Promise<ApplySummary> {
  const client = ctx.authedClient();
  const summary: ApplySummary = {
    envId: '',
    envName: document.environment.name,
    envAction: 'unchanged',
    devices: emptyChanges(),
    agents: emptyChanges(),
    warnings: [],
    errors: [],
  };

  // --- 1. environment: find by exact name (mine), create or patch ---------
  const desiredEvents = document.events as EnvMapEvent[] | undefined;
  let detail: EnvDetail;
  const mine = (await ctx.listEnvs()).filter(env => env.name === document.environment.name);
  const owned = mine.filter(env => env.myRole === 'owner');
  if (mine.length > 1) {
    summary.errors.push(
      `environment: name "${document.environment.name}" matches ${mine.length} of your environments — ` +
      `rename one (ids: ${mine.map(env => env.id).join(', ')})`,
    );
    return summary;
  }
  if (mine.length === 1 && (document.flows?.length ?? 0) > 0) {
    // Flows are versioned runtime rows managed by `eaf flow *` / governance;
    // applying a document to an EXISTING env never mutates them (the doc's
    // flows section only seeds a fresh create).
    summary.warnings.push(
      `flows: ${document.flows!.length} flow(s) in the document were skipped — the environment ` +
      'already exists (flows are managed via `eaf flow` / adopt-config proposals)',
    );
  }
  if (mine.length === 1 && owned.length === 0) {
    summary.errors.push(
      `environment "${document.environment.name}" (${mine[0].id}) exists but your role is ` +
      `"${mine[0].myRole ?? 'none'}" — only the owner can apply documents to it`,
    );
    return summary;
  }

  if (mine.length === 0) {
    if (!document.environment.map) {
      summary.errors.push('environment.map: required when the environment does not exist yet');
      return summary;
    }
    const map = document.environment.map;
    // Fix-6: validate every intra-document reference BEFORE creating the
    // environment, so a broken document never leaves an empty garbage env.
    const preErrors = await prevalidateNewEnvironment(client, document);
    if (preErrors.length > 0) {
      summary.errors.push(...preErrors);
      return summary;
    }
    try {
      detail = (await client.post('/api/environments', {
        name: document.environment.name,
        ...(document.environment.description !== undefined
          ? { description: document.environment.description }
          : {}),
        mapType: map.type,
        mapData: mapDataFrom(map, desiredEvents),
        ...(document.environment.visibility ? { visibility: document.environment.visibility } : {}),
      })) as EnvDetail;
      summary.envAction = 'created';
    } catch (error) {
      summary.errors.push(`environment: create failed — ${messageOf(error)}`);
      return summary;
    }
  } else {
    detail = (await client.get(`/api/environments/${encodeURIComponent(mine[0].id)}`)) as EnvDetail;
    const desired = document.environment.map
      ? mapDataFrom(document.environment.map, desiredEvents ?? (detail.events.length > 0 ? detail.events : undefined))
      : { ...currentMapData(detail), ...(desiredEvents !== undefined ? { events: desiredEvents } : {}) };
    if (canonical(desired) !== canonical(currentMapData(detail))) {
      try {
        detail = (await client.patch(`/api/environments/${encodeURIComponent(detail.id)}`, {
          mapData: desired,
        })) as EnvDetail;
        summary.envAction = 'updated';
      } catch (error) {
        summary.errors.push(`environment: mapData patch failed — ${messageOf(error)}`);
        return summary;
      }
    }
  }
  summary.envId = detail.id;

  const zoneIds = new Set(detail.zones.map((zone: EnvZone) => zone.id));
  const devicesByName = new Map(detail.devices.map(device => [device.name, device]));
  const agentsByName = new Map(detail.agents.map(agent => [agent.name, agent]));

  // --- 2. devices: upsert by name ------------------------------------------
  const docDeviceNames = new Set<string>();
  const deviceEntries = document.devices ?? [];
  /** T-076: name → pending create proposal (binds to not-yet-created devices fail LOUDLY). */
  const pendingDeviceCreates = new Map<string, EnvProposal>();
  for (const [index, device] of deviceEntries.entries()) {
    const path = `devices[${index}]`;
    const name = await resolveDeviceName(client, device, index, summary.errors);
    if (name === undefined) continue;
    docDeviceNames.add(name);
    if (!zoneIds.has(device.zone)) {
      summary.errors.push(`${path} "${name}": zone "${device.zone}" does not exist in the environment`);
      continue;
    }
    const existing = devicesByName.get(name);
    try {
      if (!existing) {
        const created = await createDevice(client, detail.id, device, name);
        if (isEnvProposal(created)) {
          // T-076: the server answered a GOVERNANCE PROPOSAL, not a device.
          const realId = created.createdIds?.devices?.[0];
          if (created.status === 'applied' && realId !== undefined) {
            // Auto-applied: the createdIds echo is the device id — chain on.
            summary.devices.created.push({ id: realId, name, proposal: { id: created.id, status: created.status } });
            devicesByName.set(name, { ...(created as object), id: realId, name } as EnvDetail['devices'][number]);
          } else {
            pendingDeviceCreates.set(name, created);
            summary.warnings.push(pendingCreateNote('device', name, created));
          }
        } else {
          summary.devices.created.push({ id: created.id, name });
          devicesByName.set(name, { ...created, name });
        }
      } else {
        const patch = devicePatch(device, existing);
        if (Object.keys(patch).length === 0) {
          summary.devices.unchanged.push({ id: existing.id, name });
        } else {
          await client.patch(`/api/devices/${encodeURIComponent(existing.id)}`, patch);
          summary.devices.updated.push({ id: existing.id, name });
        }
      }
    } catch (error) {
      summary.errors.push(`${path} "${name}": ${messageOf(error)}`);
    }
  }

  // --- 3. agents: upsert by name --------------------------------------------
  const docAgentNames = new Set<string>();
  const agentEntries = document.agents ?? [];
  for (const [index, agent] of agentEntries.entries()) {
    const path = `agents[${index}]`;
    docAgentNames.add(agent.name);
    const boundDeviceIds: string[] = [];
    let failed = false;
    for (const ref of agent.bind ?? []) {
      const resolved =
        devicesByName.get(ref) ?? [...devicesByName.values()].find(device => device.id === ref);
      if (resolved) {
        if (!boundDeviceIds.includes(resolved.id)) boundDeviceIds.push(resolved.id);
      } else {
        // T-076: a bind to a device whose create proposal is still pending
        // names the governance reason — not the bare "no device with that
        // name" that used to hide the proposal id trap.
        const pending = pendingDeviceCreates.get(ref);
        summary.errors.push(
          pending !== undefined
            ? `${path} "${agent.name}": cannot resolve bind "${ref}" — its install-devices proposal ` +
              `${pending.id} is still ${pending.status} (not yet approved), so the device does not ` +
              'exist yet. Approve the proposal, then re-apply this document.'
            : `${path} "${agent.name}": cannot resolve bind "${ref}" (no device with that name or id)`,
        );
        failed = true;
      }
    }
    for (const zone of agent.zones ?? []) {
      if (!zoneIds.has(zone)) {
        summary.errors.push(`${path} "${agent.name}": zone "${zone}" does not exist in the environment`);
        failed = true;
      }
    }
    if (failed) continue;
    const existing = agentsByName.get(agent.name);
    try {
      if (!existing) {
        const created = (await client.post(`/api/environments/${encodeURIComponent(detail.id)}/agents`, {
          name: agent.name,
          capabilities: agent.capabilities,
          boundDeviceIds,
          managedZoneIds: agent.zones ?? [],
          ...(agent.llm !== undefined ? { llm: agent.llm } : {}),
        })) as EnvDetail['agents'][number] | EnvProposal;
        if (isEnvProposal(created)) {
          // T-076: the answer is a proposal wrapper — chain on the
          // createdIds echo when it auto-applied; a pending proposal is NOT
          // an agent (the old code recorded the proposal id as the agent id).
          const realId = created.createdIds?.agents?.[0];
          if (created.status === 'applied' && realId !== undefined) {
            summary.agents.created.push({ id: realId, name: agent.name, proposal: { id: created.id, status: created.status } });
          } else {
            summary.warnings.push(pendingCreateNote('agent', agent.name, created));
          }
        } else {
          summary.agents.created.push({ id: created.id, name: agent.name });
        }
      } else {
        const patch: Record<string, unknown> = {};
        if (!sameStrings(agent.capabilities, existing.capabilities)) patch.capabilities = agent.capabilities;
        if (!sameStrings(boundDeviceIds, existing.boundDeviceIds)) patch.boundDeviceIds = boundDeviceIds;
        if (!sameStrings(agent.zones ?? [], existing.managedZoneIds)) {
          patch.managedZoneIds = agent.zones ?? [];
        }
        if (agent.llm !== undefined && canonical(agent.llm) !== canonical(existing.llm)) patch.llm = agent.llm;
        if (Object.keys(patch).length === 0) {
          summary.agents.unchanged.push({ id: existing.id, name: agent.name });
        } else {
          await client.patch(`/api/agents/${encodeURIComponent(existing.id)}`, patch);
          summary.agents.updated.push({ id: existing.id, name: agent.name });
        }
      }
    } catch (error) {
      summary.errors.push(`${path} "${agent.name}": ${messageOf(error)}`);
    }
  }


  // --- R40-B4: flows (create path only) -------------------------------------
  // Runs AFTER devices/agents exist: the document's flows pin devices and
  // agents BY NAME (portable identity — export translated the source
  // world's runtime row ids), so the re-pin maps need the freshly created
  // rows. Only when this apply CREATED the env (envAction 'created');
  // applying to an existing env never mutates its flows (warned above).
    // R40-B4: create the document's flows on the fresh env (one POST per
    // flow via the governed flow endpoint; ids are runtime rows). The
    // document carries deviceName pins (portable identity) — re-pin to the
    // new world's device instance ids right before the POST.
    // detail was captured BEFORE devices/agents were upserted — fetch the
    // world's CURRENT rows so the name→id re-pin maps are complete.
    const flowsDetail = (await client.get(
      `/api/environments/${encodeURIComponent(detail.id)}`,
    )) as EnvDetail;
    const deviceNameToId = new Map(flowsDetail.devices.map(device => [device.name, device.id]));
    const agentNameToId = new Map(flowsDetail.agents.map(agent => [agent.name, agent.id]));
    for (const flow of document.flows ?? []) {
      try {
        await client.post(`/api/environments/${encodeURIComponent(detail.id)}/flows`, {
          ...flow,
          trigger: repinDeviceNames(flow.trigger, deviceNameToId, agentNameToId),
          plan: repinDeviceNames(flow.plan, deviceNameToId, agentNameToId),
        } as Record<string, unknown>);
        summary.warnings.push(`flow "${flow.name}" created`);
      } catch (error) {
        summary.errors.push(`flow "${flow.name}": create failed — ${messageOf(error)}`);
      }
    }
  // --- 4. prune --------------------------------------------------------------
  if (options.prune) {
    // Kept agents must not dangle onto devices we are about to delete.
    const doomedDeviceIds = new Set(
      detail.devices.filter(device => !docDeviceNames.has(device.name)).map(device => device.id),
    );
    for (const agent of detail.agents) {
      if (!docAgentNames.has(agent.name)) continue; // deleted below anyway
      const kept = agent.boundDeviceIds.filter(id => !doomedDeviceIds.has(id));
      if (kept.length !== agent.boundDeviceIds.length) {
        try {
          await client.patch(`/api/agents/${encodeURIComponent(agent.id)}`, { boundDeviceIds: kept });
        } catch (error) {
          summary.errors.push(`prune: could not unbind pruned devices from agent "${agent.name}": ${messageOf(error)}`);
        }
      }
    }
    for (const agent of detail.agents) {
      if (docAgentNames.has(agent.name)) continue;
      try {
        await client.delete(`/api/agents/${encodeURIComponent(agent.id)}`);
        summary.agents.deleted.push({ id: agent.id, name: agent.name });
      } catch (error) {
        summary.errors.push(`prune: delete agent "${agent.name}" failed — ${messageOf(error)}`);
      }
    }
    for (const device of detail.devices) {
      if (docDeviceNames.has(device.name)) continue;
      try {
        await client.delete(`/api/devices/${encodeURIComponent(device.id)}`);
        summary.devices.deleted.push({ id: device.id, name: device.name });
      } catch (error) {
        summary.errors.push(`prune: delete device "${device.name}" failed — ${messageOf(error)}`);
      }
    }
  }

  // --- 5. optional simulation plan ------------------------------------------
  if (document.simulation) {
    const plan = document.simulation;
    // T-029 (EC-F10): applying a document with a simulation: block used to
    // ALWAYS create a new sim — re-applying an unchanged doc silently
    // stacked running sims until the running_sims_per_user quota rejected
    // the apply. Detect the env's live sims first: reuse one when asked
    // (--reuse-sim), otherwise warn loudly while creating.
    // platformOwned world sessions (T-087) are excluded: the env's standing
    // `sim-<envId>-world-session` is platform-owned infrastructure every env
    // has — not an apply-stacked sim — so it must neither trigger the
    // stacking warning nor become the --reuse-sim target.
    let live: SimListEntry[] = [];
    try {
      const listed = (await client.get(
        `/api/simulations?environmentId=${encodeURIComponent(detail.id)}`,
      )) as { simulations?: SimListEntry[] };
      live = (listed.simulations ?? []).filter(
        sim => LIVE_SIM_STATES.has(sim.state) && sim.platformOwned !== true,
      );
    } catch (error) {
      summary.warnings.push(`simulation: could not check for already-running sims — ${messageOf(error)}`);
    }

    if (options.reuseSim && live.length > 0) {
      // Attach to the NEWEST live sim (list is insertion-ordered): a paused
      // sim is resumed (with the plan's speed when given); a running one is
      // left as-is — no second sim, no quota burn.
      const target = live[live.length - 1]!;
      try {
        let state = target.state;
        if (target.state === 'paused') {
          const resumed = (await client.post(
            `/api/simulations/${encodeURIComponent(target.id)}/resume`,
            plan.speed !== undefined ? { speed: plan.speed } : {},
          )) as { state?: string };
          state = resumed.state ?? 'running';
        }
        summary.simulationId = target.id;
        summary.simulationState = state;
        summary.simulationReused = true;
      } catch (error) {
        summary.errors.push(`simulation: reusing ${target.id} failed — ${messageOf(error)}`);
      }
    } else {
      if (live.length > 0) {
        summary.warnings.push(
          `simulation: ${live.length} live simulation${live.length === 1 ? '' : 's'} already ` +
          `exist${live.length === 1 ? 's' : ''} on this environment — this apply creates ANOTHER one ` +
          `(repeated applies stack sims until the running_sims_per_user quota rejects the create):`,
          ...live.map(
            sim => `  - ${sim.id} (state=${sim.state}) — stop it: eaf sim stop ${sim.id}`,
          ),
          'Re-run with --reuse-sim to attach to the newest live sim instead of creating one.',
        );
      }
      try {
        const created = (await client.post('/api/simulations', {
          environmentId: detail.id,
          options: {
            ...(plan.llm ? { llmClient: plan.llm } : {}),
            ...(plan.tickMs !== undefined ? { tickMs: plan.tickMs } : {}),
          },
        })) as { id: string; state: string };
        summary.simulationId = created.id;
        const started = (await client.post(
          `/api/simulations/${encodeURIComponent(created.id)}/start`,
          plan.speed !== undefined ? { speed: plan.speed } : {},
        )) as { id: string; state: string };
        summary.simulationState = started.state;
        summary.simulationReused = false;
      } catch (error) {
        summary.errors.push(`simulation: ${messageOf(error)}`);
      }
    }
  }

  return summary;
}

/**
 * T-076 (R22, CC-F07): the honest advisory for a create whose governance
 * proposal is still pending — the object DOES NOT EXIST yet, its future id
 * rides the proposal's createdIds once applied, and nothing in this run
 * (binds, later applies) may treat the proposal id as the object id.
 */
function pendingCreateNote(kind: 'device' | 'agent', name: string, proposal: EnvProposal): string {
  return (
    `${kind} "${name}": create submitted as ${proposal.kind} proposal ${proposal.id} ` +
    `(status=${proposal.status}) — the object does not exist until the proposal is applied; ` +
    `its id will ride that proposal's createdIds once applied (GET /api/proposals/${proposal.id}). ` +
    'Nothing else in this document may reference it yet.'
  );
}

/** Device identity: explicit name, else the catalog model's display name. */
async function resolveDeviceName(
  client: ApiClient,
  device: WorldDevice,
  index: number,
  errors: string[],
): Promise<string | undefined> {
  if (device.name !== undefined) return device.name;
  if (device.model === undefined) return undefined; // validated earlier
  try {
    const model = (await client.get(`/api/catalog/${encodeURIComponent(device.model)}`)) as { name: string };
    return model.name;
  } catch (error) {
    errors.push(`devices[${index}]: catalog model "${device.model}" not found (${messageOf(error)})`);
    return undefined;
  }
}

async function createDevice(
  client: ApiClient,
  envId: string,
  device: WorldDevice,
  name: string,
): Promise<EnvDetail['devices'][number]> {
  if (device.model !== undefined) {
    return (await client.post(`/api/environments/${encodeURIComponent(envId)}/devices:instantiate`, {
      modelId: device.model,
      name,
      zoneId: device.zone,
      ...(device.position !== undefined ? { position: device.position } : {}),
    })) as EnvDetail['devices'][number];
  }
  const spec = device.spec!;
  return (await client.post(`/api/environments/${encodeURIComponent(envId)}/devices`, {
    name,
    type: spec.type,
    ...(spec.brand !== undefined ? { brand: spec.brand } : {}),
    capabilities: spec.capabilities,
    zoneId: device.zone,
    ...(device.position !== undefined ? { position: device.position } : {}),
    ...(device.initialState !== undefined ? { initialState: device.initialState } : {}),
  })) as EnvDetail['devices'][number];
}

/** Fields worth patching on an existing device (doc-absent ⇒ leave alone). */
function devicePatch(
  device: WorldDevice,
  existing: { zoneId: string; position: unknown; type?: string; brand?: string | null; capabilities?: string[]; initialState?: unknown },
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (device.zone !== existing.zoneId) patch.zoneId = device.zone;
  if (device.position !== undefined && canonical(device.position) !== canonical(existing.position)) {
    patch.position = device.position;
  }
  if (device.spec !== undefined) {
    if (device.spec.type !== existing.type) patch.type = device.spec.type;
    const brand = device.spec.brand ?? null;
    if (brand !== (existing.brand ?? null)) patch.brand = brand;
    if (!sameStrings(device.spec.capabilities, existing.capabilities ?? [])) {
      patch.capabilities = device.spec.capabilities;
    }
    if (device.initialState !== undefined && canonical(device.initialState) !== canonical(existing.initialState)) {
      patch.initialState = device.initialState;
    }
  }
  return patch;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create-path pre-validation (Fix-6): check every reference that can be
 * checked against the document itself (zone ids of devices/agents/events,
 * agent binds against document device names, catalog model existence)
 * BEFORE the environment is created — a failed apply must not leave an
 * empty garbage environment behind. Device names come from explicit `name`
 * or the catalog model's display name (read-only GETs).
 */
async function prevalidateNewEnvironment(
  client: ApiClient,
  document: WorldDocument,
): Promise<string[]> {
  const errors: string[] = [];
  const zoneIds = new Set(document.environment.map!.zones.map(zone => zone.id));

  const deviceNames = new Set<string>();
  for (const [index, device] of (document.devices ?? []).entries()) {
    const path = `devices[${index}]`;
    let name = device.name;
    if (name === undefined && device.model !== undefined) {
      try {
        const model = (await client.get(
          `/api/catalog/${encodeURIComponent(device.model)}`,
        )) as { name: string };
        name = model.name;
      } catch (error) {
        errors.push(`${path}: catalog model "${device.model}" not found (${messageOf(error)})`);
        continue;
      }
    }
    if (name !== undefined) deviceNames.add(name);
    if (!zoneIds.has(device.zone)) {
      errors.push(
        `${path}${name !== undefined ? ` "${name}"` : ''}: zone "${device.zone}" does not exist in the document's map`,
      );
    }
  }

  for (const [index, agent] of (document.agents ?? []).entries()) {
    const path = `agents[${index}]`;
    for (const ref of agent.bind ?? []) {
      if (!deviceNames.has(ref)) {
        errors.push(
          `${path} "${agent.name}": cannot resolve bind "${ref}" (no device with that name in the document)`,
        );
      }
    }
    for (const zone of agent.zones ?? []) {
      if (!zoneIds.has(zone)) {
        errors.push(`${path} "${agent.name}": zone "${zone}" does not exist in the document's map`);
      }
    }
  }

  for (const [index, event] of (document.events ?? []).entries()) {
    if (!zoneIds.has(event.zoneId)) {
      errors.push(`events[${index}] "${event.id}": zone "${event.zoneId}" does not exist in the document's map`);
    }
  }

  return errors;
}

/**
 * R40-B4 inverse of export's portableFlowRefs: walk a flow block replacing
 * {deviceName: "<name>"} pins with {deviceId: "<new instance id>"} using the
 * freshly-created world's device rows. Unknown names are dropped (the flow
 * validates loudly rather than pinning a stale id). R1 (B1-12): the
 * renamer lives in world/flow-refs.ts — the one shared name↔id vocabulary
 * now also serves `flow add`/`flow update`.
 */
function repinDeviceNames(
  value: unknown,
  deviceNameToId: Map<string, string>,
  agentNameToId: Map<string, string>,
): Record<string, unknown> {
  return renameDevicePins(value, deviceNameToId, agentNameToId) as Record<string, unknown>;
}
