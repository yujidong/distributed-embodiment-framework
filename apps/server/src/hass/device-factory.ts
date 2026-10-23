/**
 * device-factory — scenario device definitions → runtime devices (P3a)
 *
 * The bridge between `binding` URIs and the engine's `deviceFactory`
 * extension point:
 * - `sim://` → the EXACT SimulatedDevice construction EngineRuntime uses
 *   today (reused via `createSimulatedDevice` from core, not replicated);
 * - `hass://<entity-id>` → an HADevice bound to that entity on the shared
 *   connection (capabilities/type derived from the entity via entity-map);
 * - unknown entity / unsupported scheme → throw at BUILD time with the
 *   entity named, so a broken scenario never reaches a running engine.
 */

import {
  createSimulatedDevice,
  type DeviceFactory,
  type RuntimeDevice,
  type ScenarioDevice,
} from '@active-collaboration/core';

import type { HAWebSocketConnection } from './connection.js';
import { mapHassEntity } from './entity-map.js';
import { HADevice } from './HADevice.js';
import type { HassSafetyGate } from './safety-gate.js';

/** Thrown when a scenario binding cannot be resolved to a runtime device. */
export class DeviceBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceBindingError';
  }
}

export interface HassDeviceFactoryContext {
  /** Shared, ready HA connection. */
  connection: HAWebSocketConnection;
  /** Actuation safety gate (P3b); optional so sim-only/test paths stay bare. */
  gate?: HassSafetyGate;
  /** Owning simulation id — threads into the gate for audit/pending rows. */
  simId?: string;
  /** Owning environment for env-scoped policies (null = file scenario). */
  envId?: string | null;
}

/** Build one runtime device from its scenario definition + binding. */
export function createDeviceFromBinding(
  def: ScenarioDevice,
  ctx: HassDeviceFactoryContext,
): RuntimeDevice {
  const binding = def.binding;

  if (binding.startsWith('sim://')) {
    return createSimulatedDevice(def);
  }

  if (binding.startsWith('hass://')) {
    const entityId = binding.slice('hass://'.length);
    const entity = ctx.connection.getEntity(entityId);
    if (!entity) {
      throw new DeviceBindingError(
        `hass:// entity "${entityId}" (device "${def.id}") not found in Home Assistant`,
      );
    }
    const mapping = mapHassEntity(entityId, entity.attributes);
    return new HADevice({
      id: def.id,
      name: def.name,
      zoneId: def.zoneId,
      entityId,
      capabilities: mapping.capabilities,
      connection: ctx.connection,
      ...(ctx.gate !== undefined ? { gate: ctx.gate } : {}),
      ...(ctx.simId !== undefined ? { simId: ctx.simId } : {}),
      ...(ctx.envId !== undefined ? { envId: ctx.envId } : {}),
    });
  }

  throw new DeviceBindingError(
    `Device "${def.id}" has unsupported binding "${binding}" (expected sim:// or hass://)`,
  );
}

/**
 * The EngineRuntime `deviceFactory` for a mixed sim/hass scenario. Handles
 * EVERY device (the engine calls it for sim:// defs too).
 */
export function createHassDeviceFactory(ctx: HassDeviceFactoryContext): DeviceFactory {
  return def => createDeviceFromBinding(def, ctx);
}
