/**
 * T-103 (DevLoop R32, F-PH21) — power-outage physical envelope.
 *
 * The `power-outage` event used to be routed to agents but physically inert:
 * zero device status changes, energy kept metering, displays stayed on. This
 * module holds the STATE MACHINE of a zone-scoped outage envelope:
 *
 *   active    (start … end)        every electric device in the zone is forced
 *                                  unpowered — state.power=false (energy
 *                                  freezes, physics effects disabled) and
 *                                  commands fail with an outage error;
 *   restoring (end … end+N·stagger) devices come back ONE PER stagger step
 *                                  (gradual restore — real feeders re-energize
 *                                  in sequence, not all at once), each to the
 *                                  power state it had before the outage;
 *   ended     (all restored)       the envelope is dropped.
 *
 * Pure module: no I/O, no clocks, no device access — the engine applies the
 * transitions the state machine emits. Sim-time driven, so pause/step and
 * wall-clock lanes behave identically.
 */

/** Event types that engage the envelope (the journal's F-PH21 spelling first). */
export const POWER_OUTAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'power-outage',
  'grid-power-loss',
]);

/** Outage duration when the event does not carry `durationSec` (5 sim-min). */
export const DEFAULT_POWER_OUTAGE_DURATION_SEC = 300;

/** Gradual restore: one device re-energizes every N sim-seconds after `end`. */
export const POWER_RESTORE_STAGGER_SEC = 2;

/** True when an injected event type engages the power-outage envelope. */
export function isPowerOutageEvent(type: string): boolean {
  return POWER_OUTAGE_EVENT_TYPES.has(type);
}

/**
 * R102 (arch-guard extraction, behavior verbatim from
 * EngineRuntime.injectEvent §1a): engage the envelope for a power-outage
 * event — begin (or replace) the zone's envelope with its electric devices'
 * current power state, then let the caller apply the pending transitions.
 */
export function maybeBeginPowerOutage(args: {
  type: string;
  zoneId: string;
  simTimeSec: number;
  durationSec?: number;
  scenarioDevices: ReadonlyArray<{ id: string; zoneId?: string }>;
  deviceStateOf: (deviceId: string) => Record<string, unknown> | undefined;
  outages: PowerOutageState;
  apply: () => void;
}): void {
  if (!isPowerOutageEvent(args.type)) return;
  const durationSec = args.durationSec ?? DEFAULT_POWER_OUTAGE_DURATION_SEC;
  const zoneDevices = zoneDeviceEntries(args.scenarioDevices, args.zoneId, args.deviceStateOf);
  if (zoneDevices.length === 0) return;
  args.outages.begin(args.zoneId, args.simTimeSec, durationSec, zoneDevices);
  args.apply();
}

export interface OutageDeviceEntry {
  deviceId: string;
  /** The device's powered state BEFORE the outage (restored after it). */
  wasPowered: boolean;
  /** Sim-time at which this device re-energizes (end + (i+1)·stagger). */
  restoreAtSimSec: number;
  /** Whether the gradual-restore pass has already re-energized it. */
  restored: boolean;
}

export interface OutageEnvelope {
  zoneId: string;
  startedAtSimSec: number;
  endSimSec: number;
  devices: OutageDeviceEntry[];
}

/** One transition the engine must apply on the tick that produced it. */
export interface OutageTransition {
  deviceId: string;
  /** true = force unpowered (outage active), false = restore pre-outage state. */
  powered: boolean;
  zoneId: string;
}

/**
 * Live outage envelopes, keyed by zone (a re-injected outage on the same zone
 * replaces the pending one). Device membership is captured at outage START so
 * restore returns exactly the devices that lost power.
 */
export class PowerOutageState {
  private readonly envelopes = new Map<string, OutageEnvelope>();

  /**
   * Begin (or replace) the outage envelope for a zone. `devices` carries the
   * zone's electric devices with their CURRENT powered state; the restore
   * schedule staggers them one per POWER_RESTORE_STAGGER_SEC after `end`.
   */
  begin(
    zoneId: string,
    startSimSec: number,
    durationSec: number,
    devices: Array<{ deviceId: string; powered: boolean }>,
  ): OutageEnvelope {
    const endSimSec = startSimSec + Math.max(0, durationSec);
    const envelope: OutageEnvelope = {
      zoneId,
      startedAtSimSec: startSimSec,
      endSimSec,
      devices: devices.map((d, i) => ({
        deviceId: d.deviceId,
        wasPowered: d.powered,
        restoreAtSimSec: endSimSec + (i + 1) * POWER_RESTORE_STAGGER_SEC,
        restored: false,
      })),
    };
    this.envelopes.set(zoneId, envelope);
    return envelope;
  }

  /**
   * Advance to `simTimeSec` and return the transitions to apply NOW:
   *   - devices still inside the active window report powered:false every
   *     tick (idempotent — a command that flipped `power` back on mid-outage
   *     is re-cut on the next tick, which is what a dead feeder does);
   *   - devices past their restoreAt report powered:wasPowered once.
   * Ended envelopes (every device restored) are dropped.
   */
  tick(simTimeSec: number): OutageTransition[] {
    const transitions: OutageTransition[] = [];
    for (const [zoneId, envelope] of this.envelopes) {
      for (const entry of envelope.devices) {
        if (simTimeSec < envelope.endSimSec) {
          transitions.push({ deviceId: entry.deviceId, powered: false, zoneId });
        } else if (!entry.restored && simTimeSec >= entry.restoreAtSimSec) {
          entry.restored = true;
          transitions.push({ deviceId: entry.deviceId, powered: entry.wasPowered, zoneId });
        }
      }
      if (simTimeSec >= envelope.endSimSec && envelope.devices.every(d => d.restored)) {
        this.envelopes.delete(zoneId);
      }
    }
    return transitions;
  }

  /**
   * Command gate: true while the device sits in an ACTIVE (not yet restoring)
   * outage — a de-energized device cannot receive a command. During the
   * restore window the device is re-energized, so commands go through.
   */
  isDeviceCutOff(deviceId: string, simTimeSec: number): boolean {
    for (const envelope of this.envelopes.values()) {
      if (simTimeSec >= envelope.endSimSec) continue;
      if (envelope.devices.some(d => d.deviceId === deviceId)) return true;
    }
    return false;
  }

  /** Snapshot view of the live envelopes (for observability/tests). */
  active(): Array<{ zoneId: string; endSimSec: number; deviceIds: string[] }> {
    return [...this.envelopes.values()].map(e => ({
      zoneId: e.zoneId,
      endSimSec: e.endSimSec,
      deviceIds: e.devices.map(d => d.deviceId),
    }));
  }
}


/** Seams the engine supplies to apply outage transitions (pure module). */
export interface OutageApplicationSeams {
  getDeviceState(deviceId: string): Record<string, unknown> | undefined;
  /** Layer duck-type for disabling the dead device's physics effects. */
  physicsLayer?: {
    getDeviceEffects?: (deviceId: string) => Array<{ parameter: string }>;
    setDeviceEffectEnabled?: (deviceId: string, parameter: string, enabled: boolean) => void;
  };
  /** Narrate a power transition on the bus (device.power DEVICE_STATE_CHANGE). */
  publish(event: {
    deviceId: string;
    power: boolean;
    reason: string;
    zoneId: string;
  }): void;
  warn(message: string): void;
}

/**
 * T-103: apply one tick's transitions to device states — force-unpower
 * cut-off devices (power=false + visible powerOutage marker + physics
 * effects disabled), restore re-energized ones to their pre-outage state,
 * narrate each transition. Pure with respect to the engine: everything it
 * touches arrives through the seams.
 */
export function applyOutageTransitions(
  transitions: readonly OutageTransition[],
  seams: OutageApplicationSeams,
): void {
  for (const t of transitions) {
    const state = seams.getDeviceState(t.deviceId);
    if (state === undefined) continue;
    try {
      if (t.powered) {
        state.power = true;
        delete state.powerOutage;
      } else {
        state.power = false;
        state.powerOutage = true;
        // A dead device exerts nothing: disable its registered physics
        // effects (the control loop re-enables them once re-energized).
        const effects = seams.physicsLayer?.getDeviceEffects?.(t.deviceId) ?? [];
        for (const effect of effects) {
          seams.physicsLayer?.setDeviceEffectEnabled?.(t.deviceId, effect.parameter, false);
        }
      }
      seams.publish({
        deviceId: t.deviceId,
        power: t.powered,
        reason: t.powered ? 'power-restored' : 'power-outage',
        zoneId: t.zoneId,
      });
    } catch (error) {
      seams.warn(
        `Power-outage transition for ${t.deviceId} failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}


/**
 * T-103: collect the event zone's electric devices with their CURRENT
 * powered state (state.power===true, or power unset and status==='on').
 * Pure: scenario defs + a state reader.
 */
export function zoneDeviceEntries(
  defs: ReadonlyArray<{ id: string; zoneId?: string }>,
  zoneId: string,
  readState: (deviceId: string) => Record<string, unknown> | undefined,
): Array<{ deviceId: string; powered: boolean }> {
  return defs
    .filter(def => def.zoneId === zoneId)
    .map(def => {
      let powered = false;
      try {
        const state = readState(def.id);
        powered = state?.power === true ||
          (state?.power !== false && state?.status === 'on');
      } catch { /* unpowered by default */ }
      return { deviceId: def.id, powered };
    });
}
