/**
 * HADevice — engine Device adapter backed by a Home Assistant entity (P3a)
 *
 * Mirrors the SimulatedDevice surface the engine touches, but state and
 * actuation go through a shared HAWebSocketConnection:
 *
 * - `getState()` reads the connection's live entity cache (seeded by
 *   get_states, refreshed by the state_changed subscription this device
 *   registers — see `dispose`).
 * - `executeCommand()` translates engine semantic commands to HA service
 *   calls via the entity-map ALLOWLIST. Unmapped commands return
 *   `success:false` ("unsupported on HA entity") — nothing unmapped is ever
 *   sent to HA, and nothing ever silently succeeds. Read-type commands
 *   (monitoring capabilities) answer from the cached state without touching
 *   HA, mirroring SimulatedDevice's read path.
 * - Physics: a real device's physics is the real world. This adapter does
 *   NOT implement `setPhysicalEnvironment` (EnvironmentCenter therefore
 *   never attaches one) and never registers SpatialField effects.
 *   `setDevicePosition` is a documented no-op.
 * - Health: `isOnline()` reflects entity availability + staleness of the
 *   last state push.
 *
 * Events: when EnvironmentCenter attaches the EventManager (`setEventManager`),
 * command executions and pushed state changes are emitted as
 * DEVICE_OPERATION_EXECUTED / DEVICE_STATE_CHANGE — same contract as
 * SimulatedDevice, so streams/world-sync see no difference.
 */

import { EventEmitter, isReadOnlyCapabilityName, type EventManager } from '@active-collaboration/core';
import {
  DeviceStatus,
  EventType,
  createLogger,
  type Device,
  type DeviceCapability,
} from '@active-collaboration/shared';

import type { HAWebSocketConnection, HassEntityState } from './connection.js';
import { domainOf, makeCommandMapper, type HassCommandMapper } from './entity-map.js';
import type { GateActuationResult, HassSafetyGate } from './safety-gate.js';

const logger = createLogger('HADevice');

/** Engine-style execution result (superset of the simulation package's). */
export interface HADeviceExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  timestamp: Date;
  executionTime: number;
}

export interface HADeviceOptions {
  /** Engine device id (the scenario device id, NOT the entity id). */
  id: string;
  name: string;
  /** Scenario zone the device is deployed in (metadata/location only). */
  zoneId: string;
  /** HA entity this device is bound to (from the `hass://` binding). */
  entityId: string;
  /** Engine capability names from `mapHassEntity`. */
  capabilities: string[];
  /** Shared, ready HA connection. */
  connection: HAWebSocketConnection;
  /**
   * Safety gate (P3b). When provided TOGETHER WITH `simId`, every actuation
   * is evaluated (policy/confirm/rate-limit/E-stop) and audited before it can
   * reach the socket; without a gate the device behaves exactly as in P3a
   * (allowlist-only) — a combination only tests should use.
   */
  gate?: HassSafetyGate;
  /** Owning simulation id (required for the gate; identifies audit rows). */
  simId?: string;
  /** Owning environment for env-scoped policies (null for file scenarios). */
  envId?: string | null;
  /** Per-command timeout in ms (default 10_000). */
  commandTimeoutMs?: number;
  /** Entity staleness budget for isOnline() in ms (default 15 min). */
  staleMs?: number;
}

/** Monitoring-ish names answer from cache instead of calling a service. */
function isReadCommand(commandName: string, capabilities: DeviceCapability[]): boolean {
  const capability = capabilities.find(c => c.name === commandName);
  if (capability?.type === 'read') return true;
  // The name heuristic is core's SHARED read-only predicate (BUG-04) —
  // the same source the sim dispatch and prompt surfaces read.
  return isReadOnlyCapabilityName(commandName);
}

export class HADevice {
  readonly id: string;
  readonly name: string;
  /** Engine device type: the HA domain (e.g. 'climate', 'light'). */
  readonly type: Device['type'];
  readonly location: string;
  status: DeviceStatus = DeviceStatus.ONLINE;
  readonly capabilities: DeviceCapability[];
  readonly services: Device['services'] = [];
  readonly metadata: Record<string, unknown>;
  readonly connectionInfo: Device['connectionInfo'];
  lastHeartbeat: Date;

  readonly entityId: string;
  private readonly zoneId: string;
  private readonly connection: HAWebSocketConnection;
  private readonly commandMapper: HassCommandMapper;
  private readonly commandTimeoutMs: number;
  private readonly staleMs: number;
  private readonly gate?: HassSafetyGate;
  private readonly simId?: string;
  private readonly envId: string | null;

  private currentEntity?: HassEntityState;
  private lastSeenAt = 0;
  private eventManager?: EventManager;
  private eventEmitter?: EventEmitter;
  private readonly unsubscribe: () => void;

  constructor(options: HADeviceOptions) {
    this.id = options.id;
    this.name = options.name;
    this.zoneId = options.zoneId;
    this.entityId = options.entityId;
    this.type = domainOf(options.entityId) as Device['type'];
    this.location = options.zoneId;
    this.connection = options.connection;
    this.commandMapper = makeCommandMapper(domainOf(options.entityId));
    this.commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
    this.staleMs = options.staleMs ?? 15 * 60_000;
    this.gate = options.gate;
    this.simId = options.simId;
    this.envId = options.envId ?? null;
    this.lastHeartbeat = new Date();

    // Capability objects via the engine's own read/write/execute heuristic.
    this.capabilities = options.capabilities.map(name => ({
      name,
      type: capabilityTypeOf(name),
      parameters: [],
    }));

    this.metadata = Object.freeze({
      backend: 'hass',
      entityId: options.entityId,
    });
    this.connectionInfo = {
      protocol: 'websocket',
      endpoint: `hass://${options.entityId}`,
    };

    // Live state: seeded synchronously from the connection cache (when the
    // entity was part of get_states), then kept current by the subscription.
    this.unsubscribe = this.connection.onEntityState(this.entityId, state => {
      this.applyEntityState(state);
    });
    if (!this.currentEntity) {
      this.status = DeviceStatus.OFFLINE;
    }
  }

  /**
   * Current engine-visible state: HA attributes (unit_of_measurement etc.)
   * plus the raw HA state string and a derived `power` boolean.
   */
  getState(): Record<string, unknown> {
    const entity = this.currentEntity;
    return {
      ...(entity?.attributes ?? {}),
      entityId: this.entityId,
      zoneId: this.zoneId,
      status: 'active',
      state: entity?.state ?? 'unavailable',
      power: entity?.state === 'on',
      online: this.isOnline(),
    };
  }

  /**
   * Execute an engine command: allowlist-map it to an HA service call and
   * invoke it with a per-call timeout. Unmapped/unknown commands fail
   * loudly (success:false) and are NEVER sent to HA. When a safety gate is
   * wired (P3b), mapped actuations pass through it first — denied/parked/
   * rate-limited/E-stopped commands return their gate result (success:false
   * with a distinguishing `result.code`) and never reach the socket.
   */
  async executeCommand(
    commandName: string,
    params?: Record<string, unknown>,
  ): Promise<HADeviceExecutionResult> {
    const startTime = performance.now();
    const finish = (result: Omit<HADeviceExecutionResult, 'timestamp' | 'executionTime'>): HADeviceExecutionResult => {
      const executionTime = Math.max(1, Math.round(performance.now() - startTime));
      const full: HADeviceExecutionResult = { ...result, timestamp: new Date(), executionTime };
      this.getEventEmitter()?.emit(EventType.DEVICE_OPERATION_EXECUTED, {
        deviceId: this.id,
        deviceName: this.name,
        entityId: this.entityId,
        commandName,
        params,
        result: full,
        executionTime,
        success: full.success,
      });
      return full;
    };

    // Read path: monitoring commands answer from the cached state.
    if (isReadCommand(commandName, this.capabilities)) {
      return finish({ success: true, result: this.getState() });
    }

    // Allowlist mapping — the P3a safety floor.
    const call = this.commandMapper(commandName, params);
    if (!call) {
      return finish({
        success: false,
        error:
          `Command "${commandName}" is unsupported on HA entity "${this.entityId}" ` +
          `(domain "${domainOf(this.entityId)}")`,
      });
    }

    // Safety gate (P3b): policy/confirm/rate-limit/E-stop BEFORE the socket.
    // The dispatch closure is only invoked when the gate allows it.
    if (this.gate && this.simId) {
      const gated = await this.gate.actuate(
        {
          simId: this.simId,
          envId: this.envId,
          deviceId: this.id,
          entityId: this.entityId,
          commandName,
          ...(params !== undefined ? { params } : {}),
        },
        () => this.dispatch(call.domain, call.service, commandName, call.service_data),
      );
      return finish(gated);
    }

    return finish(await this.dispatch(call.domain, call.service, commandName, call.service_data));
  }

  /**
   * The actual HA service call (post-gate): health check, socket call with
   * timeout, success bookkeeping. Never called for denied/parked commands.
   */
  private async dispatch(
    domain: string,
    service: string,
    commandName: string,
    serviceData?: Record<string, unknown>,
  ): Promise<GateActuationResult> {
    if (!this.isOnline()) {
      return {
        success: false,
        error: `HA entity "${this.entityId}" is unavailable (offline or stale)`,
      };
    }

    try {
      await this.connection.callService(
        domain,
        service,
        this.entityId,
        serviceData,
        this.commandTimeoutMs,
      );
    } catch (error) {
      return {
        success: false,
        error: `HA service call ${domain}.${service} failed: ${(error as Error).message}`,
      };
    }

    this.lastHeartbeat = new Date();
    logger.info(`[HADevice:${this.id}] ${commandName} → ${domain}.${service} on ${this.entityId}`);
    return {
      success: true,
      result: {
        entityId: this.entityId,
        command: commandName,
        service: `${domain}.${service}`,
        ...(serviceData !== undefined ? { serviceData } : {}),
      },
    };
  }

  /**
   * Positioning is engine-side spatial bookkeeping for SIMULATED devices;
   * a real device's location is the real world. Deliberate no-op.
   */
  setDevicePosition(): void {
    // no-op by design (documented)
  }

  /**
   * NOTE: `setPhysicalEnvironment` is intentionally NOT implemented. The
   * EnvironmentCenter only attaches physics to devices that ask for it, and
   * an HA device must never register SpatialField effects — its actuation
   * feedback loop closes through the real world and HA state pushes.
   */

  /** Health: entity known to HA, not 'unavailable'/'unknown', not stale. */
  isOnline(): boolean {
    if (!this.currentEntity) return false;
    if (this.currentEntity.state === 'unavailable' || this.currentEntity.state === 'unknown') {
      return false;
    }
    return Date.now() - this.lastSeenAt < this.staleMs;
  }

  /** EnvironmentCenter hook: attach the event manager (mirrors SimulatedDevice). */
  setEventManager(eventManager: EventManager): void {
    this.eventManager = eventManager;
  }

  /** Runtime stop() hook: drop the state_changed subscription. */
  dispose(): void {
    this.unsubscribe();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private applyEntityState(state: HassEntityState): void {
    const previous = this.getState();
    this.currentEntity = state;
    this.lastSeenAt = Date.now();
    this.lastHeartbeat = new Date();
    this.status = state.state === 'unavailable' ? DeviceStatus.OFFLINE : DeviceStatus.ONLINE;

    const emitter = this.getEventEmitter();
    if (emitter) {
      emitter.emitStateChange(previous, this.getState(), {
        metadata: {
          deviceId: this.id,
          deviceName: this.name,
          entityId: this.entityId,
          backend: 'hass',
        },
      });
    }
  }

  private getEventEmitter(): EventEmitter | undefined {
    if (!this.eventManager) return undefined;
    if (!this.eventEmitter) {
      this.eventEmitter = new EventEmitter(this.eventManager, this.id);
    }
    return this.eventEmitter;
  }
}

/** Same read/write/execute heuristic the engine applies to capability names. */
function capabilityTypeOf(name: string): DeviceCapability['type'] {
  const lower = name.toLowerCase();
  if (
    lower.includes('reading') || lower.includes('sensing') ||
    lower.includes('monitoring') || lower.includes('detection')
  ) {
    return 'read';
  }
  if (lower.includes('control') || lower.includes('adjustment') || lower.includes('setting')) {
    return 'write';
  }
  return 'execute';
}
