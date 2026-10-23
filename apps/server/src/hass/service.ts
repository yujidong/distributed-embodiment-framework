/**
 * HASService — the server's Home Assistant singleton (P3a)
 *
 * Owns the ONE shared HAWebSocketConnection for the whole server, built
 * lazily on first use from env config (`HASS_URL`, `HASS_TOKEN`):
 * - unconfigured (either var missing) → `isConfigured()` false; hass-bound
 *   simulation creates fail 503 HASS_NOT_CONFIGURED and the entities route
 *   reports the same; the status route stays readable.
 * - configured → the connection connects on first demand (`ensureReady`);
 *   a failed connect surfaces as 503 HASS_CONNECT_FAILED.
 *
 * Also the registry's bridge: `createDeviceFactory(devices)` validates every
 * hass:// binding against the live entity list (unknown → 400
 * HASS_UNKNOWN_ENTITY naming the entity) and returns the EngineRuntime
 * deviceFactory closure.
 */

import type { DeviceFactory, ScenarioDevice } from '@active-collaboration/core';

import { ApiError } from '../errors.js';
import {
  HAWebSocketConnection,
  type HassConnectionState,
  type HassEntityState,
} from './connection.js';
import { createHassDeviceFactory } from './device-factory.js';
import { domainOf, mapHassEntity, suggestedCapabilitiesFor } from './entity-map.js';
import type { HassSafetyGate } from './safety-gate.js';

export interface HASServiceOptions {
  url?: string;
  token?: string;
  /** Test seam: inject a pre-built connection instead of env config. */
  connection?: HAWebSocketConnection;
  /** Actuation safety gate (P3b) threaded into every HADevice it builds. */
  gate?: HassSafetyGate;
}

/** Entity summary for the /api/hass/entities preview (deployment UI). */
export interface HassEntitySummary {
  entityId: string;
  domain: string;
  friendlyName: string;
  state: string;
  /** Capabilities the entity would expose as an HADevice (entity-map). */
  capabilities: string[];
  /**
   * Fix-18 (R7 F-02): the capability list to declare when creating a
   * platform device for this entity — semantic capabilities PLUS the
   * control verbs the platform command derivation recognizes, so the
   * device's `commands` come out non-empty and every one reaches HA.
   */
  suggestedCapabilities: string[];
}

export class HASService {
  private readonly url?: string;
  private readonly token?: string;
  private readonly gate?: HassSafetyGate;
  private connection?: HAWebSocketConnection;
  private connecting?: Promise<HAWebSocketConnection>;

  constructor(options: HASServiceOptions = {}) {
    this.url = options.url;
    this.token = options.token;
    this.connection = options.connection;
    this.gate = options.gate;
  }

  /** Both env pieces present (or a connection injected). */
  isConfigured(): boolean {
    return this.connection !== undefined ||
      (typeof this.url === 'string' && this.url.length > 0 &&
        typeof this.token === 'string' && this.token.length > 0);
  }

  /** Status for GET /api/hass/status. */
  status(): { configured: boolean; state: HassConnectionState | 'unconfigured'; entityCount?: number } {
    if (!this.isConfigured()) {
      return { configured: false, state: 'unconfigured' };
    }
    const state = this.connection?.getState() ?? 'disconnected';
    return {
      configured: true,
      state,
      ...(state === 'ready' && this.connection
        ? { entityCount: this.connection.listEntities().length }
        : {}),
    };
  }

  /**
   * The shared connection, connected. Lazily constructed on first use.
   * @throws ApiError 503 HASS_NOT_CONFIGURED / HASS_CONNECT_FAILED
   */
  async ensureReady(): Promise<HAWebSocketConnection> {
    if (!this.isConfigured()) {
      throw new ApiError(
        503,
        'HASS_NOT_CONFIGURED',
        'Home Assistant is not configured — set HASS_URL and HASS_TOKEN to enable hass:// bindings',
      );
    }
    if (!this.connection) {
      this.connection = new HAWebSocketConnection({
        url: this.url as string,
        token: this.token as string,
      });
    }
    const connection = this.connection;
    if (connection.getState() === 'ready') return connection;
    this.connecting ??= connection.connect()
      .then(() => connection)
      .catch(error => {
        // Keep the connection object (it owns reconnect policy); report the
        // failure to THIS caller only.
        throw new ApiError(
          503,
          'HASS_CONNECT_FAILED',
          `Could not connect to Home Assistant: ${(error as Error).message}`,
        );
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  /** The shared connection when it is already ready (no connect attempt). */
  peekReadyConnection(): HAWebSocketConnection | undefined {
    return this.connection?.getState() === 'ready' ? this.connection : undefined;
  }

  /** Entity list for the deployment UI preview (proxied + capability map). */
  async listEntities(filters: { domain?: string; q?: string } = {}): Promise<HassEntitySummary[]> {
    const connection = await this.ensureReady();
    return connection
      .listEntities()
      .filter(entity => (filters.domain ? domainOf(entity.entity_id) === filters.domain : true))
      .filter(entity => {
        if (!filters.q) return true;
        const needle = filters.q.toLowerCase();
        const friendly = friendlyName(entity).toLowerCase();
        return entity.entity_id.toLowerCase().includes(needle) || friendly.includes(needle);
      })
      .map(entity => ({
        entityId: entity.entity_id,
        domain: domainOf(entity.entity_id),
        friendlyName: friendlyName(entity),
        state: entity.state,
        capabilities: mapHassEntity(entity.entity_id, entity.attributes).capabilities,
        suggestedCapabilities: suggestedCapabilitiesFor(entity.entity_id, entity.attributes),
      }));
  }

  /**
   * Validate every hass:// binding in the scenario against the live entity
   * list, then return the EngineRuntime deviceFactory. sim://-only scenario
   * device lists need no factory (the engine default covers them) — the
   * caller checks for hass:// presence before calling this. `scope` threads
   * the simulation/environment identity into the safety gate (P3b) so audit
   * and pending rows name their sim and env-scoped policies apply.
   *
   * @throws ApiError 400 HASS_UNKNOWN_ENTITY (names the offending entity)
   */
  async createDeviceFactory(
    devices: ScenarioDevice[],
    scope: { simId?: string; envId?: string | null } = {},
  ): Promise<DeviceFactory> {
    const connection = await this.ensureReady();
    for (const def of devices) {
      if (!def.binding.startsWith('hass://')) continue;
      const entityId = def.binding.slice('hass://'.length);
      if (!connection.getEntity(entityId)) {
        throw new ApiError(
          400,
          'HASS_UNKNOWN_ENTITY',
          `Device "${def.id}" binds hass:// entity "${entityId}", which does not exist in Home Assistant`,
        );
      }
    }
    return createHassDeviceFactory({
      connection,
      ...(this.gate !== undefined ? { gate: this.gate } : {}),
      ...(scope.simId !== undefined ? { simId: scope.simId } : {}),
      ...(scope.envId !== undefined ? { envId: scope.envId } : {}),
    });
  }

  /** Server shutdown hook. */
  close(): void {
    this.connection?.close();
    this.connection = undefined;
  }
}

function friendlyName(entity: HassEntityState): string {
  const name = entity.attributes.friendly_name;
  return typeof name === 'string' && name.length > 0 ? name : entity.entity_id;
}
