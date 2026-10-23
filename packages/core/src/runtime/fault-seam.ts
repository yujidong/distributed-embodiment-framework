/**
 * Device fault seam (P3d) — R21-W2 extraction from EngineRuntime (pure
 * move; still an L3 runtime file: it is stateful orchestration machinery,
 * not shaping).
 *
 * Holds EVERYTHING fault-injection: active profiles per device, states
 * frozen at fault-set time (offline/staleState), the seeded RNG driving
 * failureRate, and the fault-aware device Proxy. The runtime delegates
 * here; the only thing it supplies is the bus narration callback (the
 * engine owns the event manager and its source tag).
 *
 * Living-worlds P0: the fault RNG is checkpointed as (resolved seed, draws
 * consumed) — the wrapper counts every draw so the restore can fast-forward
 * a re-seeded mulberry32 to the exact same position in the sequence.
 */

import { mulberry32, normalizeFaultProfile } from './shaping/index.js';
import type { FaultProfile, RuntimeDevice } from './contract.js';

/** Bus narration the ENGINE supplies (it owns the event manager). */
export interface DeviceFaultSeamEvents {
  /**
   * Narrate a fault-caused command failure on the bus (device.error).
   * Emitted at the seam because every command path observes the failure
   * differently: the DeviceCommandCoordinator narrates its own catch
   * (manual commands), but agent-internal paths (ACExecutor →
   * DeviceResource) only log. Emitting at the seam guarantees the episode
   * log always shows WHY commands failed.
   */
  narrateCommandFailure(
    device: RuntimeDevice,
    commandName: string,
    error: string,
    profile: FaultProfile,
  ): void;
  /**
   * T-103 (F-PH21): predicate consulted at dispatch — true means the device
   * sits in an ACTIVE power-outage envelope and commands must fail (a
   * de-energized device cannot receive anything). Supplied by the engine
   * (the outage state machine lives there); absent = no outages possible.
   */
  isUnpowered?: (deviceId: string) => boolean;
}

export class DeviceFaultSeam {
  private readonly profiles = new Map<string, FaultProfile>();
  private readonly frozenStates = new Map<string, Record<string, unknown>>();
  private readonly seedResolved: number;
  private draws = 0;
  private rngImpl: () => number;
  private readonly rng: () => number;
  private readonly isUnpowered?: (deviceId: string) => boolean;

  constructor(
    seed: number,
    private readonly events: DeviceFaultSeamEvents,
    options: { isUnpowered?: (deviceId: string) => boolean } = {},
  ) {
    this.seedResolved = seed >>> 0;
    this.rngImpl = mulberry32(this.seedResolved);
    this.rng = () => {
      this.draws += 1;
      return this.rngImpl();
    };
    this.isUnpowered = options.isUnpowered;
  }

  /** Default seed when the operator did not pin one (constructor-time). */
  static randomSeed(): number {
    return Math.floor(Math.random() * 0xffffffff);
  }

  /** Checkpoint view: (resolved seed, draws consumed). */
  rngState(): { seed: number; draws: number } {
    return { seed: this.seedResolved, draws: this.draws };
  }

  /** Restore: re-seed and fast-forward to the checkpointed draw count. */
  restoreRng(seed: number, draws: number): void {
    this.rngImpl = mulberry32(seed);
    for (let i = 0; i < draws; i++) this.rngImpl();
    this.draws = draws;
  }

  has(deviceId: string): boolean {
    return this.profiles.has(deviceId);
  }

  /** Active profile (shared reference — internal/emit use). */
  rawProfile(deviceId: string): FaultProfile | undefined {
    return this.profiles.get(deviceId);
  }

  /** Active fault profile of a device, or null when healthy/unknown. */
  profileOf(deviceId: string): FaultProfile | null {
    const profile = this.profiles.get(deviceId);
    return profile ? { ...profile } : null;
  }

  /** All active fault profiles, keyed by device id. */
  allProfiles(): Record<string, FaultProfile> {
    const out: Record<string, FaultProfile> = {};
    for (const [deviceId, profile] of this.profiles) {
      out[deviceId] = { ...profile };
    }
    return out;
  }

  /**
   * setDeviceFault's state mutation (the engine keeps transition detection,
   * event publication and logging): null clears; an offline/staleState
   * profile freezes the device's last-known state at fault-set time.
   */
  applyProfile(
    deviceId: string,
    profile: FaultProfile | null,
    captureState: () => Record<string, unknown>,
  ): void {
    if (profile === null) {
      this.profiles.delete(deviceId);
      this.frozenStates.delete(deviceId);
      return;
    }
    const normalized = normalizeFaultProfile(profile, deviceId);
    this.profiles.set(deviceId, normalized);
    if (normalized.offline === true || normalized.staleState === true) {
      // Freeze the last-known state NOW: while offline/staleState is
      // active, getState keeps returning this snapshot.
      try {
        this.frozenStates.set(deviceId, { ...captureState() });
      } catch {
        this.frozenStates.delete(deviceId);
      }
    } else {
      this.frozenStates.delete(deviceId);
    }
  }

  /**
   * Wrap a device in the fault-injection seam (P3d): a Proxy that forwards
   * everything to the real device EXCEPT `executeCommand` and `getState`,
   * which consult the device's active fault profile first. The Proxy keeps
   * the full device surface (capabilities, location, setEventManager, …)
   * intact, so the wrapped device can be registered anywhere the raw one
   * could. With no fault set, behavior is identical to the raw device.
   */
  wrap(device: RuntimeDevice): RuntimeDevice {
    const seam = this;
    return new Proxy(device, {
      get(target, prop, _receiver) {
        if (prop === 'executeCommand') {
          // R17 params-purity: the invocation-context actor rides the third
          // argument — forwarded intact (it is attribution context, not a
          // fault-relevant command argument).
          return (
            commandName: string,
            params?: Record<string, unknown>,
            context?: { actor?: string },
          ) => seam.executeCommand(target, commandName, params, context);
        }
        if (prop === 'getState') {
          return () => seam.getState(target);
        }
        // Bind methods to the RAW target so private state and internal
        // `this` calls never see the Proxy.
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeDevice;
  }

  /**
   * Fault-aware executeCommand. Fault errors are THROWN (not returned as a
   * failure payload) so the DeviceCommandCoordinator's catch path reports
   * `{ success: false, error }` — the same shape as a real device error.
   */
  async executeCommand(
    device: RuntimeDevice,
    commandName: string,
    params?: Record<string, unknown>,
    context?: { actor?: string },
  ): Promise<unknown> {
    const inner = device as RuntimeDevice & {
      executeCommand?: (
        commandName: string,
        params?: Record<string, unknown>,
        context?: { actor?: string },
      ) => Promise<unknown>;
    };
    if (typeof inner.executeCommand !== 'function') {
      throw new Error(`Device ${device.id} does not support command execution`);
    }

    // T-103 (F-PH21): an ACTIVE power-outage envelope cuts the device off —
    // fail fast with the outage named (before any fault-profile handling:
    // an unpowered device has no reachable fault semantics either).
    if (this.isUnpowered?.(device.id) === true) {
      throw new Error(
        `Device ${device.id} is unpowered (zone power outage active) — command "${commandName}" not delivered`,
      );
    }

    const profile = this.profiles.get(device.id);
    if (profile) {
      // Offline: the device is unreachable — fail fast, no latency, no RNG.
      if (profile.offline === true) {
        throw this.faultError(device, commandName, 'device offline', profile);
      }
      // Latency: the command takes latencyMs to reach the device.
      if (profile.latencyMs !== undefined && profile.latencyMs > 0) {
        await new Promise(resolve => setTimeout(resolve, profile.latencyMs));
      }
      // Intermittent failure: seeded RNG decides per command.
      if (profile.failureRate !== undefined && profile.failureRate > 0 &&
        this.rng() < profile.failureRate) {
        throw this.faultError(device, commandName, 'intermittent failure', profile);
      }
    }
    return inner.executeCommand(commandName, params, context);
  }

  /**
   * Fault-aware getState: while offline or staleState is active, return the
   * state frozen at fault-set time (offline: unreachable device reports
   * nothing new; staleState: reporting stuck while actuation still works).
   */
  getState(device: RuntimeDevice): Record<string, unknown> {
    const profile = this.profiles.get(device.id);
    if (profile && (profile.offline === true || profile.staleState === true)) {
      const frozen = this.frozenStates.get(device.id);
      if (frozen !== undefined) return { ...frozen };
    }
    return device.getState();
  }

  /** Narrate on the bus, then return the Error to throw. */
  private faultError(
    device: RuntimeDevice,
    commandName: string,
    error: string,
    profile: FaultProfile,
  ): Error {
    this.events.narrateCommandFailure(device, commandName, error, profile);
    return new Error(error);
  }
}
