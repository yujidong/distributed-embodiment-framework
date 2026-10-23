/**
 * Service computation store (R21-W4 split out of service-store.ts; pure
 * move, zero semantic change).
 *
 * R14 Wave-A (design-data-services.md): the provider-registered computation
 * specs on services plus the per-service last-computed frame cache — the
 * evaluation-storage half of the service store. Presence of a computation
 * flips an unbacked service consumable (the read/push lanes deliver
 * evaluation frames instead of 409s). `ServiceStore` constructs one of
 * these and delegates its five computation/frame methods, so every consumer
 * keeps calling `ctx.serviceStore.<method>` exactly as before.
 */

import { parseJsonObject, type DeviceInstanceRow } from './environment-store.js';
import type { EafDatabase } from './database.js';

/**
 * R14 Wave-A (design-data-services.md): a provider-registered computation
 * spec on a service. Presence flips an unbacked service consumable — the
 * read/push lanes deliver evaluation frames instead of 409s.
 */
export interface ComputationRow {
  service_id: string;
  kind: 'zone-query' | 'device-aggregate' | 'flow-report';
  spec_json: string;
  schema_version: number;
  registered_by: string;
  registered_at: string;
}

/** The per-service last-computed frame cache (§7 honest degradation). */
export interface ServiceDataFrameRow {
  service_id: string;
  frame_json: string;
  computed_at_wall: string;
  simulation_id: string | null;
  sim_time_sec: number | null;
}

// ---------------------------------------------------------------------------
// D4 (DevLoop R28, T-081) — the auto-minted read lane on derived telemetry
// ---------------------------------------------------------------------------

/** The auto-minted spec's cache TTL (§3.1 refresh anchor; the honest default). */
export const AUTO_MINT_REFRESH_SEC = 60;

/** Marker key riding the auto-minted spec JSON (never declarable in a registration body). */
export const AUTO_MINTED_MARKER = 'autoMinted';

/** Is this stored spec the platform's auto-mint (vs. a provider registration)? */
export function isAutoMintedSpec(computation: ComputationRow): boolean {
  try {
    return (JSON.parse(computation.spec_json) as Record<string, unknown>)[AUTO_MINTED_MARKER] === true;
  } catch {
    return false;
  }
}

/** Normalize a capability/param name for the mapping heuristic (alnum-only, lowercase). */
function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * D4 mapping: does the device state key `param` belong to `capability`?
 * Normalized containment either way — 'temperature' maps to
 * 'temperature-reading', 'heartRate' to 'heart-rate', 'spo2' to
 * 'spo2-reading'; 'battery' does NOT map to 'temperature-reading'. This is
 * the "readable parameter that maps to a computation metric" of the ruling:
 * the minted service exposes only its OWN capability's telemetry, never the
 * whole device state.
 */
export function paramMapsToCapability(param: string, capability: string): boolean {
  const p = normalizeToken(param);
  const c = normalizeToken(capability);
  if (p.length === 0 || c.length === 0) return false;
  return p === c || c.includes(p) || p.includes(c);
}

/**
 * The device's READABLE params for one capability: the NUMERIC
 * initialState keys that map to it (the honest declarative surface at
 * derivation-sync time — no runtime exists yet). Empty for devices without
 * readable params (SERVICE_DERIVED_READONLY semantics stay for them).
 */
export function readableParamsForDevice(device: DeviceInstanceRow, capability: string): string[] {
  let state: Record<string, unknown> = {};
  try {
    state = parseJsonObject(device.initial_state_json) ?? {};
  } catch {
    return []; // corrupt initialState — nothing honestly readable
  }
  return Object.entries(state)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([key]) => key)
    .filter(key => paramMapsToCapability(key, capability))
    .sort();
}

/** The minimal device-aggregate ComputationSpec the platform auto-registers (T-065 per-bed pattern generalized). */
export function autoMintSpec(
  deviceId: string,
  capability: string,
  params: readonly string[],
): Record<string, unknown> {
  return {
    kind: 'device-aggregate',
    refreshSec: AUTO_MINT_REFRESH_SEC,
    zones: '*',
    // avg over the SINGLE scoped device = the device's own value, delivered
    // through the aggregate-only privacy shape (no per-device projection
    // vocabulary is born here).
    metrics: params.map(param => ({
      source: 'device',
      capability,
      path: param,
      fn: 'avg',
      as: param,
    })),
    devices: [deviceId],
    [AUTO_MINTED_MARKER]: true,
  };
}

/** The interface.dataSchema block matching an auto-mint's output fields (§9 parity). */
export function autoMintDataSchema(params: readonly string[]): Record<string, unknown> {
  return { fields: params.map(param => ({ name: param, type: 'number' })) };
}

export class ServiceComputationStore {
  constructor(private readonly db: EafDatabase) {}

  /**
   * Register (idempotently REPLACE) a computation on a service. The spec is
   * validated + cross-checked against interface.dataSchema by the ROUTE
   * before this runs; the store only persists. `deleteService`/service
   * deletion cascades the row (FK).
   */
  registerComputation(input: {
    serviceId: string;
    kind: ComputationRow['kind'];
    specJson: string;
    schemaVersion: number;
    registeredBy: string;
  }): ComputationRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO service_computations
           (service_id, kind, spec_json, schema_version, registered_by, registered_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(service_id) DO UPDATE SET
           kind = excluded.kind,
           spec_json = excluded.spec_json,
           schema_version = excluded.schema_version,
           registered_by = excluded.registered_by,
           registered_at = excluded.registered_at`,
      )
      .run(
        input.serviceId, input.kind, input.specJson, input.schemaVersion,
        input.registeredBy, now,
      );
    return this.computationOf(input.serviceId)!;
  }

  computationOf(serviceId: string): ComputationRow | undefined {
    return this.db
      .prepare('SELECT * FROM service_computations WHERE service_id = ?')
      .get(serviceId) as ComputationRow | undefined;
  }

  /** Revoke the computation (consumable flips back; §7 governs active agreements). */
  revokeComputation(serviceId: string): boolean {
    return this.db
      .prepare('DELETE FROM service_computations WHERE service_id = ?')
      .run(serviceId).changes > 0;
  }

  /** Overwrite the per-service frame cache on every successful evaluation. */
  saveFrame(input: {
    serviceId: string;
    frameJson: string;
    computedAtWall: string;
    simulationId: string;
    simTimeSec: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO service_data_frames
           (service_id, frame_json, computed_at_wall, simulation_id, sim_time_sec)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(service_id) DO UPDATE SET
           frame_json = excluded.frame_json,
           computed_at_wall = excluded.computed_at_wall,
           simulation_id = excluded.simulation_id,
           sim_time_sec = excluded.sim_time_sec`,
      )
      .run(
        input.serviceId, input.frameJson, input.computedAtWall,
        input.simulationId, input.simTimeSec,
      );
  }

  latestFrameOf(serviceId: string): ServiceDataFrameRow | undefined {
    return this.db
      .prepare('SELECT * FROM service_data_frames WHERE service_id = ?')
      .get(serviceId) as ServiceDataFrameRow | undefined;
  }

  /**
   * T81 (R8, u2-F4): drop the per-service cached frame. A re-registration is
   * an ATOMIC spec swap — a frame computed by the OLD spec must never be
   * served after the new spec lands (the consumer read "the provider fixed
   * it, --latest still reports the old error"). The next `--latest` finds no
   * cache and recomputes from the new spec; the fallback lane (no running
   * sim) honestly reports nothing rather than an old-generation frame.
   */
  invalidateFrames(serviceId: string): void {
    this.db.prepare('DELETE FROM service_data_frames WHERE service_id = ?').run(serviceId);
  }
}
