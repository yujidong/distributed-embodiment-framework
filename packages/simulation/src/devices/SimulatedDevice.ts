/**
 * Simulated Device Class
 *
 * Generic simulated device with behavior support
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseDevice } from './BaseDevice.js';
import type { BehaviorConfig, ExecutionResult, SimulatedDeviceConfig } from './types.js';
import { BehaviorType, PhysicalParameter } from './types.js';
import type { PhysicalEnvironment } from '../environment/PhysicalEnvironment.js';
import type { DevicePhysicsEffect, PhysicsLayer } from '../physics/PhysicsLayer.js';
import { HeatTransferModel } from '../physics/HeatTransferModel.js';
import { brightnessToLuxContribution } from '../physics/illuminance.js';

// Event types
import type { EventEmitter } from '@active-collaboration/core';
import type { EventManager } from '@active-collaboration/core';
import { EventType, isReadOnlyCapabilityName } from '@active-collaboration/core';
import type { DeviceState, DeviceCapability } from '@active-collaboration/shared';
import type { ParameterDefinition, SystemEvent, Device, Service } from '@active-collaboration/shared';

// Command handlers
import { CommandHandlerRegistry } from './handlers/CommandHandlerRegistry.js';
import { resolveCommandAlias, type CommandInvocationContext } from './handlers/CommandHandler.js';
import { acceptedParameterNames, validateCommandParams } from './handlers/capability-contract.js';
import { applyDeviceControlLoop, type DeviceControlView } from './controllers.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Simulated device with configurable behaviors
 */
const logger = createLogger('SimulatedDevice');

/**
 * Compact params summary for error messages (R13 CB-F01): names the keys a
 * caller actually sent so a wrong param spelling is visible in the failure
 * itself. Values are stringified and truncated; command params are not
 * credentials, so no redaction is needed.
 */
function safeParamSummary(params: Record<string, unknown>): string {
  const keys = Object.keys(params);
  const rendered = keys
    .slice(0, 6)
    .map(key => {
      const raw = typeof params[key] === 'object' && params[key] !== null
        ? JSON.stringify(params[key])
        : String(params[key]);
      return `${key}: ${raw.length > 40 ? raw.slice(0, 40) + '…' : raw}`;
    })
    .join(', ');
  return `{${rendered}${keys.length > 6 ? `, …(+${keys.length - 6})` : ''}}`;
}

export class SimulatedDevice extends BaseDevice {
  private physicalEnvironment?: PhysicalEnvironment;
  private eventEmitter?: EventEmitter;
  private eventManager?: EventManager; // Store eventManager reference for lazy EventEmitter creation
  public readonly templateId: string; // Make templateId accessible
  private commandHandlerRegistry: CommandHandlerRegistry; // Command handler registry
  /** Last commanded physics effect per parameter (control-loop rebuild source, F-24). */
  private readonly lastRegisteredEffects = new Map<string, DevicePhysicsEffect>();

  constructor(config: SimulatedDeviceConfig) {
    super({
      id: config.id || uuidv4(),
      name: config.name,
      type: config.type,
      initialState: config.initialState,
      capabilities: config.capabilities,
      location: config.location as string | undefined,
      metadata: {
        ...config.metadata,
        templateId: config.templateId, // Store templateId in metadata
      },
    });

    // Store templateId as property for easy access
    this.templateId = config.templateId || '';

    // NFR-3: read ramp rate from initialState if declared (W/s).
    const init = (config.initialState ?? {}) as Record<string, unknown>;
    if (typeof init.rampRateWPerSec === 'number' && init.rampRateWPerSec > 0) {
      this.rampRateWPerSec = init.rampRateWPerSec;
      this.rampProgress = 0; // starts un-ramped, ramps up when powered
    }

    // Initialize command handler registry
    this.commandHandlerRegistry = new CommandHandlerRegistry(this.id, this.type);

    // Add behaviors
    for (const behavior of (config.behaviors || [])) {
      this.addBehavior(behavior);
    }

    // Generate services from capabilities
    this.generateServices();
  }

  /**
   * Initialize the device (async initialization hook)
   * Called after construction for async setup operations
   */
  async initialize(): Promise<void> {
    logger.info(`[SimulatedDevice:${this.id}] Initialized`);
  }

  /**
   * Set physical environment reference (called by SimulatedEnvironment)
   * @param env - Physical environment instance
   */
  setPhysicalEnvironment(env: PhysicalEnvironment): void {
    this.physicalEnvironment = env;
    logger.info(`[SimulatedDevice:${this.id}] PhysicalEnvironment attached`);
  }

  /**
   * Living-worlds P0 (design-living-worlds.md §9): restore a checkpointed
   * device state onto a freshly constructed device. This is the inject half
   * of the checkpoint seam — `getCheckpointState()` is the export half. The
   * restore is a full REPLACE (not a merge): a checkpointed state is the
   * complete post-evolution state, and leftover construction-time keys would
   * drift the control loop (e.g. a `power: false` checkpoint must not keep a
   * fresh `status: 'active'`). Private meters (`cumulativeEnergyWh`) are
   * seeded at FULL precision from the checkpoint while the observable copy
   * is re-rounded — the meter writes back a 2-decimal view each tick but
   * accumulates internally unrounded, so restoring the rounded view would
   * drift the resumed sum by up to one display unit (found by the P0
   * acceptance invariant: 15.62 vs 15.63 Wh). No events are emitted: the
   * restore happens before the world is observable again, and a resumed
   * world's timeline must not contain synthetic state-change rows for
   * history that already happened.
   */
  restoreState(state: Record<string, unknown>): void {
    const observable = { ...state } as Record<string, unknown>;
    if (typeof state.cumulativeEnergyWh === 'number') {
      this.cumulativeEnergyWh = state.cumulativeEnergyWh; // full precision
      observable.cumulativeEnergyWh = Math.round(state.cumulativeEnergyWh * 100) / 100;
    }
    this.currentState = observable as unknown as DeviceState;
    // T54: a checkpoint-restored state is authoritative-at-freeze world
    // state, not a fresh construction placeholder — record its keys as
    // written so the read lane's UNWRITTEN gate doesn't misfire on resumed
    // worlds.
    this.markStatePathsWritten(Object.keys(observable));
    logger.info(
      `[SimulatedDevice:${this.id}] Checkpoint state restored (${Object.keys(state).length} keys)`,
    );
  }

  /**
   * Living-worlds P0: full-fidelity export half of the checkpoint seam —
   * the observable state, but with the energy meter at full internal
   * precision (getState() carries the 2-decimal write-back view).
   * T-703: the meter key rides only when the observable state carries it
   * (a never-powered device never meters; injecting a 0 key here would
   * surface it after restore and break chunked-vs-one-shot determinism).
   */
  getCheckpointState(): Record<string, unknown> {
    const state = { ...this.getState() } as Record<string, unknown>;
    if (typeof state.cumulativeEnergyWh === 'number') {
      state.cumulativeEnergyWh = this.cumulativeEnergyWh;
    }
    return state;
  }

  /**
   * Set event manager reference (called by EnvironmentCenter)
   * Enables device to emit events when state changes
   * @param eventManager - Event manager instance
   */
  setEventManager(eventManager: EventManager): void {
    // Store eventManager reference for lazy EventEmitter creation
    this.eventManager = eventManager;
    logger.info(`[SimulatedDevice:${this.id}] EventManager reference stored`);
  }

  /**
   * Get or create EventEmitter instance (lazy initialization)
   * Creates EventEmitter synchronously on first access to avoid race conditions
   * @returns EventEmitter instance or undefined if no eventManager set
   */
  private getEventEmitter(): EventEmitter | undefined {
    if (!this.eventManager) {
      return undefined;
    }

    if (!this.eventEmitter) {
      // Dynamically import EventEmitter and create instance synchronously
      // We use require() for synchronous import in CommonJS context
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const EventEmitterClass = require('@active-collaboration/core').EventEmitter;
        this.eventEmitter = new EventEmitterClass(this.eventManager, this.id);
        logger.info(`[SimulatedDevice:${this.id}] EventEmitter created`);
      } catch (error) {
        logger.error(`[SimulatedDevice:${this.id}] Failed to create EventEmitter:`, error);
      }
    }

    return this.eventEmitter;
  }

  /**
   * Override setState to emit events when state changes
   * @param newState - New state (partial or full)
   */
  protected setState(newState: Partial<DeviceState>): void {
    const oldState: Record<string, unknown> = { ...this.currentState as unknown as Record<string, unknown> };
    const stateMap: Record<string, unknown> = newState as unknown as Record<string, unknown>;

    // Call parent setState
    super.setState(newState);

    // Emit state change event if eventManager is available
    const emitter = this.getEventEmitter();
    if (emitter) {
      const changedParameters: string[] = [];

      for (const key of Object.keys(newState)) {
        if (oldState[key] !== stateMap[key]) {
          changedParameters.push(key);
        }
      }

      emitter.emitStateChange(oldState, this.currentState, {
        metadata: {
          deviceId: this.id,
          deviceName: this.name,
          deviceType: this.type,
          location: this.getLocationPath(),
        },
      });
    }
  }

  /**
   * Device control loop hook — run once per physics tick by the runtime's
   * scheduler (e.g. EngineRuntime). The device SENSES the field at its own
   * location via the public read API and toggles its OWN registered physics
   * effect (thermostat-style hysteresis). Devices without a control policy
   * or without a control target are exact no-ops.
   *
   * This is the device layer's half of the feedback loop: control policy
   * lives here, field math lives in the physics layer.
   *
   * @param dtSeconds - Physics step duration in seconds
   */
  onPhysicsTick(dtSeconds: number): void {
    if (!this.physicalEnvironment) {
      return;
    }
    const physicsLayer = this.physicalEnvironment.getPhysicsLayer?.();
    if (!physicsLayer) {
      return;
    }

    this.ensureControlEffect(physicsLayer);
    // NFR-3: advance ramp state; the ramp scale is consumed by the energy
    // metering path (partially-ramped devices draw proportionally less power).
    this.advanceRamp(dtSeconds);

    // T-106 (F-PH02b): publish this unit's thermostat intent on its
    // registered effect (sibling-visibility lane), then let the policy see
    // the zone's other thermostat-intending units.
    this.publishThermostatIntent(physicsLayer);

    applyDeviceControlLoop(this.controlViewFor(physicsLayer));

    // Fix-51b/T-703/T-710: energy metering — accumulate Wh from actual power
    // state (0 W unless genuinely powered; standby when the control effect
    // idles). NFR-3: ramp scale reduces the effective power during spin-up.
    const powerW = this.accumulateEnergy(dtSeconds, physicsLayer, this.rampProgress);

    // T-709: publish the draw so energy meters can aggregate their zone.
    this.reportZonePower?.(physicsLayer, powerW);
    // T-709: an energy meter reports its zone's aggregate consumption.
    if (this.isEnergyMeter()) {
      this.updateZoneMetering(dtSeconds, physicsLayer);
    }

    // T-705: sensors sample the field into their state every tick.
    if (this.isSensorDevice()) {
      this.sampleSensorReadings();
    }

    // T-706: enforce temporary-access grant expiry (auto-relock).
    this.enforceGrantExpiry();
  }

  /**
   * R44-insane §11.6: the per-tick control view, cached per physics layer.
   * Building it inline allocated the view object plus 3–4 closures per
   * device per tick (thousands of devices → tens of thousands of
   * short-lived allocations per tick, pure GC churn). Every field binds
   * only to `this` / the layer reference — both stable within a layer
   * epoch — so the cached view is semantically identical. Rebuilt when the
   * environment hands out a different layer (setPhysicalEnvironment).
   */
  private controlViewCache?: { layer: PhysicsLayer; view: DeviceControlView };

  private controlViewFor(physicsLayer: PhysicsLayer): DeviceControlView {
    if (this.controlViewCache !== undefined && this.controlViewCache.layer === physicsLayer) {
      return this.controlViewCache.view;
    }
    const view: DeviceControlView = {
      type: this.type,
      getStateValue: key => (this.getState() as unknown as Record<string, unknown>)[key],
      readLocal: parameter => this.senseLocalParameter(parameter),
      getEffectMagnitude: parameter => physicsLayer.getDeviceEffect(this.id, parameter)?.magnitude,
      setEffectEnabled: (parameter, enabled) => {
        const effect = physicsLayer.getDeviceEffect(this.id, parameter);
        if (effect && effect.enabled !== enabled) {
          physicsLayer.setDeviceEffectEnabled(this.id, parameter, enabled);
        }
      },
      ...(this.location !== undefined && typeof physicsLayer.zoneHvacIntents === 'function'
        ? {
            zoneHvacPeers: () => {
              const zone = typeof this.location === 'string' ? this.location : this.location?.path;
              if (zone === undefined) return [];
              return physicsLayer.zoneHvacIntents(zone, this.id);
            },
          }
        : {}),
    };
    this.controlViewCache = { layer: physicsLayer, view };
    return view;
  }

  /** T-709: energy-meter detection (type or energy-monitoring capability). */
  private isEnergyMeter(): boolean {
    if (this.type.toLowerCase().includes('meter')) return true;
    return this.capabilities.some(cap =>
      cap.name.toLowerCase().includes('energy-monitoring') ||
      cap.name.toLowerCase().includes('power-monitoring'));
  }

  /**
   * T-709: publish this device's current draw (W) to the physics layer's
   * per-device power accounting, keyed by its zone, so meters can sum
   * their zone without knowing sibling devices.
   */
  private reportZonePower(
    physicsLayer: { reportDevicePower?: (deviceId: string, location: string, watts: number) => void },
    powerW: number,
  ): void {
    const location = typeof this.location === 'string' ? this.location : this.location?.path;
    if (location) {
      physicsLayer.reportDevicePower?.(this.id, location, powerW);
    }
  }

  /**
   * T-709: the meter's zone aggregate — zonePowerW (sum of every OTHER
   * device's draw in this zone) plus its own idle draw, accumulated into
   * cumulativeZoneWh. Was: only its own 100 W idle (140→1858 Wh while 5
   * real loads burned 17 kWh+ around it, F-PH12).
   */
  private updateZoneMetering(dtSeconds: number, physicsLayer: { zonePowerW?: (location: string, excludeDeviceId?: string) => number }): void {
    const location = typeof this.location === 'string' ? this.location : this.location?.path;
    if (!location) return;
    const zonePower = physicsLayer.zonePowerW?.(location, this.id) ?? 0;
    const state = this.currentState as unknown as Record<string, unknown>;
    state.zonePowerW = Math.round(zonePower * 10) / 10;
    this.cumulativeZoneWh += (zonePower * dtSeconds) / 3600;
    state.cumulativeZoneWh = Math.round(this.cumulativeZoneWh * 100) / 100;
  }

  /**
   * T-705 (F-PH18): sensors sample the spatial field at their own location
   * every tick and write canonical reading keys into state — a climate
   * sensor's state carries `temperature`, a CO2 sensor carries `co2`, a PM
   * monitor carries `pm2_5`. Readings are the field values plus the
   * device's opt-in sensorNoise (Fix-53a: deterministic 0 by default).
   * Written directly to currentState (like cumulativeEnergyWh) — per-tick
   * telemetry is not a state-change event.
   */
  private sampleSensorReadings(): void {
    if (!this.physicalEnvironment || !this.location) return;
    const updates: Record<string, unknown> = {};
    for (const cap of this.capabilities) {
      const parameter = this.mapCapabilityToParameter(cap.name);
      if (parameter === null) continue;
      const raw = this.physicalEnvironment.getParameterValue(parameter, this.location);
      if (typeof raw !== 'number') continue;
      const noisy = raw + this.generateSensorNoise(cap);
      const key = this.readingKeyFor(parameter);
      if (key !== undefined) updates[key] = Math.round(noisy * 10000) / 10000;
    }
    if (Object.keys(updates).length > 0) {
      const state = this.currentState as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(updates)) state[key] = value;
      // SIM-time seconds, not wall-clock ISO: the hibernate/resume
      // equivalence test requires bit-identical state between frozen+resumed
      // and continuous twins — wall-clock timestamps differ between paths.
      state.lastReadingAt =
        Math.round(this.currentSimTime().getTime() / 1000);
    }
  }

  /** Canonical state key for a physical parameter's sensor reading. */
  private readingKeyFor(parameter: PhysicalParameter): string | undefined {
    switch (parameter) {
      case PhysicalParameter.TEMPERATURE: return 'temperature';
      case PhysicalParameter.HUMIDITY: return 'humidity';
      case PhysicalParameter.CO2: return 'co2';
      case PhysicalParameter.PM25: return 'pm2_5';
      case PhysicalParameter.LIGHT: return 'lightLevel';
      case PhysicalParameter.MOTION: return 'motion';
      case PhysicalParameter.SMOKE: return 'smokeLevel';
      case PhysicalParameter.AIR_QUALITY: return 'airQuality';
      case PhysicalParameter.PRESSURE: return 'pressure';
      // R52: every OTHER numeric parameter now surfaces too — the enum
      // value IS the canonical key (wind_speed, water_level, rainfall, …),
      // so a wind gauge or flood detector's reading is no longer dropped
      // on the floor for lack of a hand-written case (the R46 "telemetry
      // missing" finding: wind/water sensors had empty state while
      // temperature/humidity worked).
      default: return String(parameter);
    }
  }

  /** Sim clock's current time (falls back to wall clock without an env). */
  private currentSimTime(): Date {
    return this.physicalEnvironment?.getTimeManager?.().getCurrentTime() ?? new Date();
  }

  /**
   * T-706 (F-PH16): grant-temporary-access expiry. Grants carry
   * `expiresAt` (sim-clock ISO, grantedAt + durationSec/durationMin); once
   * past, the lock re-engages (`auto-relock` access-log entry) and the
   * grant is marked `expired: true`. Runs every tick so relock lands within
   * one tick of the expiry instant.
   */
  private enforceGrantExpiry(): void {
    const t = this.type.toLowerCase();
    if (!t.includes('lock')) return;
    const state = this.currentState as unknown as Record<string, unknown>;
    const grants = state.temporaryGrants as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(grants) || grants.length === 0) return;
    const now = this.currentSimTime().getTime();
    let changed = false;
    const nextGrants = grants.map(grant => {
      const expiresAtRaw = grant.expiresAt;
      if (grant.expired === true || typeof expiresAtRaw !== 'string') return grant;
      const expiresAt = Date.parse(expiresAtRaw);
      if (!Number.isFinite(expiresAt) || expiresAt > now) return grant;
      changed = true;
      return { ...grant, expired: true };
    });
    if (!changed) return;
    state.temporaryGrants = nextGrants;
    // Re-engage the lock (it was unlocked by the grant) + audit entry.
    state.locked = true;
    state.lastLockTime = this.currentSimTime().toISOString();
    state.lastActionBy = 'system:auto-relock';
    const log = Array.isArray(state.accessLog) ? [...state.accessLog as Array<Record<string, unknown>>] : [];
    log.push({
      action: 'auto-relock',
      at: this.currentSimTime().toISOString(),
      by: 'system:auto-relock',
      reason: 'temporary-access grant expired',
    });
    if (log.length > 20) log.splice(0, log.length - 20);
    state.accessLog = log;
    logger.info(`[SimulatedDevice:${this.id}] Temporary grant expired — lock re-engaged (auto-relock)`);
  }

  /**
   * Fix-51b: cumulative energy consumption in Wh. Updated every physics
   * tick from the device's actual power state; read via getState() or the
   * snapshot (`devices[].state.cumulativeEnergyWh`).
   */
  private cumulativeEnergyWh = 0;

  /**
   * T-709: cumulative zone energy in Wh (energy-meter devices only) — the
   * meter's own view of its zone's aggregate consumption.
   */
  private cumulativeZoneWh = 0;

  /**
   * T-702/T-703: precise HVAC type match. The legacy check
   * (`includes('hvac') || includes('air')`) mis-classified air-purifiers and
   * exhaust fans as heat pumps, COP-derating a 50 W purifier to a flat
   * 937.5 W (= 3000/3.2) draw — the F-PH11 two-bucket class constant.
   */
  private static isHvacType(type: string): boolean {
    const t = type.toLowerCase();
    return t === 'hvac' || t === 'ac' || t === 'air-conditioner' || t === 'hvac-controller';
  }

  /**
   * T-705: sensor-role detection — capabilities of type read, or a type
   * name that says sensor/monitor/detector. These devices sample the field
   * into their state every tick (F-PH18: sensors must sense).
   */
  private isSensorDevice(): boolean {
    if (this.type.toLowerCase().match(/sensor|monitor|detector/)) return true;
    return this.capabilities.some(cap => cap.type === 'read');
  }

  /**
   * T-710: whether the device's own primary control effect is actively
   * driving. Returns undefined when the device has no registered physics
   * effect at all (lights, speakers, meters — full load when powered) and
   * a boolean when its primary effect exists (true = full load, false =
   * thermostat/purifier idle → standby draw).
   */
  private primaryEffectActive(physicsLayer: {
    getDeviceEffect?: (deviceId: string, parameter: PhysicalParameter) =>
      { parameter: string; enabled?: boolean } | undefined;
  }): boolean | undefined {
    const t = this.type.toLowerCase();
    let primary: PhysicalParameter | undefined;
    if (SimulatedDevice.isHvacType(this.type)) primary = PhysicalParameter.TEMPERATURE;
    else if (t.includes('humidifier') || t.includes('dehumidifier')) primary = PhysicalParameter.HUMIDITY;
    else if (t.includes('purifier')) primary = PhysicalParameter.PM25;
    // R44-insane: single find via getDeviceEffect — the old path deep-copied
    // the device's whole effect list (getDeviceEffects) every powered device
    // every tick, pure allocation churn (only `enabled` is read here).
    const effect = primary !== undefined
      ? physicsLayer.getDeviceEffect?.(this.id, primary)
      : undefined;
    if (effect === undefined) return undefined;
    return effect.enabled ?? true;
  }

  /**
   * Fix-51b/T-702/T-703/T-710: accumulate energy from the device's actual
   * operating state. Power-state semantics:
   *   - powered = `power === true` or `status === 'on'` ONLY (the
   *     construction-time `status: 'active'` is operational liveness, not
   *     power — sensors no longer draw 100 W from creation, and dormant
   *     devices no longer back-fill Wh history on activation, F-PH14);
   *   - HVAC: electrical input = mode-appropriate thermal capacity (catalog
   *     coolingPowerW/heatingPowerW, T-702) / COP(T_out, state.cop ?? 3.2);
   *   - T-710: a powered device whose own control effect is idle (thermostat
   *     satisfied) draws standby (~2%, clamped 5–10 W), not full load;
   *   - off devices draw exactly 0 W and their Wh freezes.
   * Returns the power draw in W (the T-709 zone meter reads it).
   */
  private accumulateEnergy(
    dtSeconds: number,
    physicsLayer: {
      getDeviceEffect?: (deviceId: string, parameter: PhysicalParameter) =>
        { parameter: string; enabled?: boolean } | undefined;
    },
    rampScale: number = 1,
  ): number {
    const state = this.getState() as unknown as Record<string, unknown>;
    // T-103 (F-PH21): an EXPLICIT power=false is authoritative — a device
    // cut off by a zone power outage (or any writer that forces power off)
    // meters exactly 0 W even while its commanded status still reads 'on'.
    const powered = state.power === true ||
      (state.power !== false && state.status === 'on');
    if (!powered) return 0;

    // Rated power from state or type-based defaults
    const ratedPowerW = (state.ratedPowerW as number) ??
      this.defaultRatedPowerW();

    let actualPowerW: number;

    if (SimulatedDevice.isHvacType(this.type)) {
      // HVAC: the meter sees the ELECTRICAL input = thermal output / COP.
      // T-702: use the mode-appropriate CATALOG capacity when present
      // (coolingPowerW/heatingPowerW seeded from specs.coolingCapacityW…),
      // falling back to ratedPowerW, then the 3 kW class default.
      const mode = state.mode === 'heating' ? 'heating' : 'cooling';
      const capacityW = (mode === 'heating'
        ? state.heatingPowerW : state.coolingPowerW) as number | undefined;
      const thermalOutputW = (typeof capacityW === 'number' && capacityW > 0
        ? capacityW
        : ratedPowerW);
      const ratedCOP = (typeof state.cop === 'number' && state.cop > 0
        ? state.cop
        : (typeof state.copRated === 'number' && state.copRated > 0 ? state.copRated : undefined));
      const outdoorTemp = this.senseOutdoorTemperature() ?? 35;
      actualPowerW = HeatTransferModel.calculateHvacElectricalPower(
        thermalOutputW * rampScale, outdoorTemp, mode, ratedCOP,
      );
    } else {
      actualPowerW = ratedPowerW * rampScale; // NFR-3: ramp-scaled power
    }

    // T-710: thermostat/purifier idle → standby draw (~2% of full load,
    // clamped to 5–9 W — an idling compressor is not a heater; T-703 bar:
    // idle draw strictly < 10 W, not the 100 W class bucket).
    const effectActive = this.primaryEffectActive(physicsLayer);
    if (effectActive === false) {
      actualPowerW = Math.min(9, Math.max(5, actualPowerW * 0.02));
    }

    // Accumulate: Wh = W × s / 3600
    this.cumulativeEnergyWh += (actualPowerW * dtSeconds) / 3600;

    // Write back to state so snapshots expose it
    (this.currentState as unknown as Record<string, unknown>).cumulativeEnergyWh =
      Math.round(this.cumulativeEnergyWh * 100) / 100;

    return actualPowerW;
  }

  /**
   * Type-based default rated power (W) for energy metering. T-703: honest
   * per-class wattages instead of a flat 100 W for every unknown type —
   * sensors/locks/meters are 2–5 W devices, not space heaters.
   * R44-insane: memoized per instance — the type string never changes, and
   * the chain of includes() ran per powered device per tick.
   */
  private defaultRatedPowerW(): number {
    if (this.cachedDefaultRatedPowerW === undefined) {
      this.cachedDefaultRatedPowerW = SimulatedDevice.defaultRatedPowerForType(this.type);
    }
    return this.cachedDefaultRatedPowerW;
  }

  private cachedDefaultRatedPowerW?: number;

  private static defaultRatedPowerForType(type: string): number {
    const t = type.toLowerCase();
    if (SimulatedDevice.isHvacType(type)) return 3000;
    if (t.includes('heater') || t.includes('radiator')) return 1500;
    if (t.includes('purifier')) return 50;
    if (t.includes('fan')) return 50;
    if (t.includes('humidifier') || t.includes('dehumidifier')) return 200;
    if (t.includes('light') || t.includes('lamp')) return 60;
    if (t.includes('curtain')) return 15;
    if (t.includes('speaker')) return 15;
    if (t.includes('camera')) return 8;
    if (t.includes('display') || t.includes('screen')) return 30;
    if (t.includes('lock')) return 2;
    if (t.includes('sensor') || t.includes('monitor') || t.includes('detector')) return 3;
    if (t.includes('meter')) return 3;
    return 100; // generic actuator
  }

  /** Best-effort outdoor temperature read (for COP calculation). */
  private senseOutdoorTemperature(): number | undefined {
    try {
      const state = this.getState() as unknown as Record<string, unknown>;
      if (typeof state.outdoorTemperature === 'number') return state.outdoorTemperature;
      return 35; // rated condition default
    } catch {
      return 35;
    }
  }

  /**
   * NFR-3: ramp rate tracking. When a device declares `rampRateWPerSec`
   * (W/s of thermal power ramp-up/down), the effect magnitude smoothly
   * transitions from 0 to full over `ratedPower / rampRate` seconds instead
   * of jumping instantly — mirroring real compressor spin-up and valve
   * travel. `rampProgress` tracks 0→1 and is advanced every physics tick.
   */
  private rampProgress = 1; // 1 = fully ramped (legacy behavior: instant)
  private rampRateWPerSec: number = 0; // 0 = no ramping

  /**
   * NFR-3: advance the ramp state and return the current effect scale
   * factor (0-1). Called from onPhysicsTick; when rampRate is 0, always 1.
   */
  private advanceRamp(dtSeconds: number): number {
    if (this.rampRateWPerSec <= 0) return 1;
    const state = this.getState() as unknown as Record<string, unknown>;
    const powered = state.power === true || state.status === 'on';
    const ratedW = (state.ratedPowerW as number) ?? this.defaultRatedPowerW();
    if (ratedW <= 0) return 1;

    const rampTimeSec = ratedW / this.rampRateWPerSec;
    if (rampTimeSec <= 0) return 1;
    const increment = dtSeconds / rampTimeSec;

    if (powered) {
      this.rampProgress = Math.min(1, this.rampProgress + increment);
    } else {
      this.rampProgress = Math.max(0, this.rampProgress - increment);
    }
    return this.rampProgress;
  }

  /**
   * Fix-15 (F-24): a thermostat-style target is a PERSISTENT setpoint, not a
   * one-shot command. The effect registered at command time can be lost
   * while the device state keeps saying power=on / targetTemperature=24 —
   * e.g. the AC feedback pipeline (PhysicalEnvironment.simulateWithFeedback)
   * clears the goal zone's device effects when its target is reached (it
   * used to clear ALL effects globally until Fix-21 scoped it to the goal
   * location). The control loop
   * can only enable/disable an existing effect, so a lost effect meant the
   * device ran forever with zero physical output (observed: room pinned at
   * its no-cooling equilibrium ~31 °C with the AC "on", target 24). Rebuild
   * the missing effect from the current state so the loop keeps governing
   * toward the target — matching what a real thermostat does. turn-off
   * still wins: power=false → no rebuild.
   */
  private ensureControlEffect(physicsLayer: PhysicsLayer): void {
    const state = this.getState() as unknown as Record<string, unknown>;
    if (state.power !== true) return;

    let parameter: PhysicalParameter;
    switch (this.type.toLowerCase()) {
      case 'hvac':
      case 'ac':
      case 'air-conditioner':
      case 'hvac-controller':
        if (typeof (state.targetTemperature ?? state.targetTemp) !== 'number') return;
        parameter = PhysicalParameter.TEMPERATURE;
        break;
      case 'humidifier':
      case 'dehumidifier':
        if (typeof state.targetHumidity !== 'number') return;
        parameter = PhysicalParameter.HUMIDITY;
        break;
      case 'air-purifier':
        parameter = PhysicalParameter.PM25;
        break;
      default:
        return; // No control policy for this type — nothing to rebuild.
    }

    if (physicsLayer.getDeviceEffect(this.id, parameter) !== undefined) return;

    // Rebuild from the last COMMANDED effect (direction/magnitude as the
    // user set them); fall back to re-deriving from current state when no
    // command registered one this session.
    const remembered = this.lastRegisteredEffects.get(parameter);
    const effect = remembered !== undefined
      ? { ...remembered }
      : this.createPhysicsEffect('control-tick');
    if (effect && effect.parameter === parameter) {
      physicsLayer.registerDeviceEffect(effect);
      logger.info(`[SimulatedDevice:${this.id}] Rebuilt missing ${parameter} effect for the control loop`);
    }
  }

  /**
   * Sense the physical field at this device's own location (public read API).
   * @returns Numeric field value, or undefined when unavailable/boolean.
   */
  private senseLocalParameter(parameter: PhysicalParameter): number | undefined {
    if (!this.physicalEnvironment || !this.location) {
      return undefined;
    }
    const value = this.physicalEnvironment.getParameterValue(parameter, this.location);
    return typeof value === 'number' ? value : undefined;
  }

  /**
   * T-106 (F-PH02b): publish this HVAC unit's thermostat intent (target /
   * capacity / direction) on its registered temperature effect so sibling
   * units in the same zone can compute the capacity-weighted setpoint.
   * Non-HVAC types and units without a target clear their intent (absent
   * on the effect = invisible to siblings = single-unit behavior).
   */
  private publishThermostatIntent(physicsLayer: PhysicsLayer): void {
    if (typeof physicsLayer.setDeviceEffectThermostat !== 'function') return;
    const t = this.type.toLowerCase();
    const isHvac = t === 'hvac' || t === 'ac' || t === 'air-conditioner' || t === 'hvac-controller';
    const state = this.getState() as unknown as Record<string, unknown>;
    const targetRaw = state.targetTemperature ?? state.targetTemp;
    if (!isHvac || state.power !== true || typeof targetRaw !== 'number') {
      if (isHvac) {
        physicsLayer.setDeviceEffectThermostat(this.id, PhysicalParameter.TEMPERATURE, undefined);
      }
      return;
    }
    const effect = physicsLayer.getDeviceEffect(this.id, PhysicalParameter.TEMPERATURE);
    if (effect === undefined) return;
    const mode = state.mode;
    const heating = effect.magnitude > 0 ||
      (effect.magnitude === 0 && (mode === 'heating' || mode !== 'cooling'));
    const state2 = this.getState() as unknown as Record<string, unknown>;
    const capacityW = Math.abs(
      (heating
        ? (typeof state2.heatingPowerW === 'number' ? state2.heatingPowerW : undefined)
        : (typeof state2.coolingPowerW === 'number' ? state2.coolingPowerW : undefined))
      ?? effect.magnitude
      ?? this.defaultRatedPowerW(),
    ) || 1;
    physicsLayer.setDeviceEffectThermostat(this.id, PhysicalParameter.TEMPERATURE, {
      targetTemperature: targetRaw,
      capacityW,
      heating,
    });
  }

  /**
   * Execute a command on this device
   * Device commands are low-level hardware operations (distinct from Agent services)
   * @param commandName - Command name
   * @param params - Command parameters (PURE semantic arguments — identity/
   *   metadata must ride `context`, never params; R17 params-purity fix)
   * @param context - Invocation context (who invoked: audit attribution for
   *   secure-state effect models, and stamped on DEVICE_OPERATION_EXECUTED)
   * @returns Execution result
   */
  async executeCommand(
    commandName: string,
    params?: Record<string, unknown>,
    context?: CommandInvocationContext,
  ): Promise<ExecutionResult> {
    logger.info(`[SimulatedDevice:${this.id}] *** DEBUG: executeCommand called with ${commandName} ***`);
    logger.info(
      `[SimulatedDevice:${this.id}] Executing command: ${commandName}`,
      params || ''
    );
    // Attribution stamp for every DEVICE_OPERATION_EXECUTED emission below:
    // the actor is invocation context, deliberately NOT merged into `params`
    // (T-039 timeline records + T-019 replay hygiene require pure params).
    // R102: same treatment for the triggering event id (decision attribution).
    const actorFields = context?.actor !== undefined ? { actor: context.actor } : {};
    const eventIdFields = context?.eventId !== undefined ? { eventId: context.eventId } : {};

    const startTime = performance.now();

    try {
      // TASK-002: resolve common-sense aliases first (on→turn-on, etc.)
      commandName = resolveCommandAlias(commandName);

      // Check if capability exists — declared verbatim, or an ALIAS a
      // registered handler can execute (Fix-44g: the resource layer's
      // multi-command expansion emits 'set-mode'/'set-temperature', which
      // devices never declare as capabilities; getExecutableCommands already
      // derives executability from handlers, and the dispatch gate now honors
      // the same contract instead of bouncing with "Command not found").
      const capability = this.capabilities.find((cap) => cap.name === commandName)
        ?? this.aliasCapabilityFor(commandName);

      if (!capability) {
        const executionTime = Math.round(performance.now() - startTime);
        // TASK-002: teach the caller what IS available instead of a bare
        // "not found" — the #1 new-user trap was undiscoverable vocabulary.
        const executable = this.getExecutableCommands();
        const hint = executable.length > 0
          ? ` — this device responds to: ${executable.slice(0, 8).join(', ')}`
          : ' — this device has no executable commands (its capabilities may not match any command handler)。' +
            '该设备当前没有任何可调用的命令：声明的能力没有对应的命令处理器。' +
            '服务提供方的补救办法：为设备改声明有处理器支撑的能力（可用命令见设备详情 commands 字段），' +
            '或调整设备类型使语义映射命中可执行命令';
        const errorResult = {
          success: false,
          error: `Command ${commandName} not found${hint}`,
          timestamp: new Date(),
          executionTime,
        };

        // Emit operation execution event (failed)
        const emitter = this.getEventEmitter();
        if (emitter) {
          emitter.emit(EventType.DEVICE_OPERATION_EXECUTED, {
            deviceId: this.id,
            deviceName: this.name,
            commandName,
            params,
            result: errorResult,
            executionTime,
            ...actorFields,
            ...eventIdFields,
          });
        }

        return errorResult;
      }

      // Validate required parameters
      if (capability.parameters) {
        const missingParams = capability.parameters
          .filter((param: ParameterDefinition) => param.required)
          .filter((param: ParameterDefinition) => params?.[param.name] === undefined);

        if (missingParams.length > 0) {
          const executionTime = Math.round(performance.now() - startTime);
          const missingParamNames = missingParams.map((p: ParameterDefinition) => p.name).join(', ');
          const errorResult = {
            success: false,
            error: `Missing required parameter(s): ${missingParamNames}`,
            timestamp: new Date(),
            executionTime,
          };

          // Emit operation execution event (failed - missing params)
          const emitter = this.getEventEmitter();
          if (emitter) {
            emitter.emit(EventType.DEVICE_OPERATION_EXECUTED, {
              deviceId: this.id,
              deviceName: this.name,
              commandName,
              params,
              result: errorResult,
              executionTime,
              ...actorFields,
              ...eventIdFields,
            });
          }

          return errorResult;
        }
      }

      // Simulate command execution based on capability type
      const result = await this.simulateCapability(capability, params);

      // R102 (wang-17): the shared parameter schema validates BEFORE any
      // state write — a known param with the wrong type/range/enum refuses
      // the command (never a success, never reaches device state). Unknown
      // params keep the long-standing dropped-not-applied 口径. This is the
      // defense-in-depth layer behind the invoke gate: every dispatch lane
      // (sim command / flow node / AC executor / NL) is covered here.
      const paramValidation = validateCommandParams(commandName, params, this.type);
      if (paramValidation.violation !== undefined) {
        const executionTime = Math.round(performance.now() - startTime);
        const errorResult = {
          success: false,
          error: `invalid parameter: ${paramValidation.violation}`,
          timestamp: new Date(),
          executionTime,
        };
        const emitter = this.getEventEmitter();
        if (emitter) {
          emitter.emit(EventType.DEVICE_OPERATION_EXECUTED, {
            deviceId: this.id,
            deviceName: this.name,
            commandName,
            params,
            result: errorResult,
            executionTime,
            ...actorFields,
            ...eventIdFields,
          });
        }
        return errorResult;
      }

      // Update device state based on command execution
      // This is critical: executeCommand MUST change device state
      logger.info(`[SimulatedDevice:${this.id}] === ABOUT TO CALL updateStateFromCommand ===`);
      const stateUpdates = this.updateStateFromCommand(commandName, params, context);
      logger.info(`[SimulatedDevice:${this.id}] === RETURNED FROM updateStateFromCommand ===`);

      // Fail loudly on no-op commands: the command IS a declared capability, but
      // it produced no state change — either no handler claimed it, or a handler
      // claimed it but returned an empty update (TASK-001: the second case used
      // to pass as success, making fake-success commands indistinguishable from
      // real ones). Read/query-type commands legitimately cause no state change.
      if (
        Object.keys(stateUpdates).length === 0 &&
        !this.isReadOnlyCommand(commandName, capability)
      ) {
        const executionTime = Math.round(performance.now() - startTime);
        // R13 (CB-F01): teach WHICH params were sent and WHICH spellings the
        // handler accepts — "no handler / no effect" alone is ambiguous
        // between "capability is a dead end" and "param name wrong", and the
        // round-13 clinic flow died on exactly that ({fanSpeed} vs {speed}).
        // R2-FEAT-11: pass the device context so the generic set-* fallback
        // names only the spellings that would actually change THIS device's
        // state (type-gated no-ops like value/power on a sprinkler are
        // filtered out instead of being advertised as usable).
        const accepted = acceptedParameterNames(
          commandName,
          this.type,
          this.getState() as unknown as Record<string, unknown>,
        );
        const paramNote = params !== undefined && Object.keys(params).length > 0
          ? ` (params sent: ${safeParamSummary(params)})`
          : ' (no params sent)';
        const acceptedNote = accepted !== undefined
          ? ` — this command only changes state with params: ${accepted.join(', ')}`
          : '';
        const errorResult = {
          success: false,
          error:
            `no handler / no effect for command ${commandName}${paramNote}${acceptedNote}` +
            '; unrecognized params are dropped, so the command ran with nothing to apply',
          timestamp: new Date(),
          executionTime,
        };

        logger.warn(
          `[SimulatedDevice:${this.id}] Command ${commandName} is a declared capability but had no handler and no effect - reporting failure`
        );

        // Emit operation execution event (failed - no-op command)
        const emitter = this.getEventEmitter();
        if (emitter) {
          emitter.emit(EventType.DEVICE_OPERATION_EXECUTED, {
            deviceId: this.id,
            deviceName: this.name,
            commandName,
            params,
            result: errorResult,
            executionTime,
            ...actorFields,
            ...eventIdFields,
          });
        }

        return errorResult;
      }

      this.lastHeartbeat = new Date();

      logger.info(`[SimulatedDevice:${this.id}] Command executed successfully: ${commandName}`);

      // Register physics effects with physical environment
      this.registerPhysicsEffects(commandName, params);

      let executionTime = Math.round(performance.now() - startTime);

      // Ensure executionTime is at least 1ms (for testing purposes)
      // In real scenarios, actual device commands would take measurable time
      if (executionTime === 0) {
        executionTime = 1;
      }

      const successResult = {
        success: true,
        result,
        timestamp: new Date(),
        executionTime,
      };

      // Emit operation execution event (success)
      const successEmitter = this.getEventEmitter();
      if (successEmitter) {
        successEmitter.emit(EventType.DEVICE_OPERATION_EXECUTED, {
          deviceId: this.id,
          deviceName: this.name,
          commandName,
          params,
          result: successResult,
          executionTime,
          ...actorFields,
            ...eventIdFields,
        });
      }

      return successResult;
    } catch (error) {
      logger.error(`[SimulatedDevice:${this.id}] Command execution failed:`, error);

      const executionTime = Math.round(performance.now() - startTime);
      const errorResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
        executionTime,
      };

      // Emit operation execution event (error)
      const errorEmitter = this.getEventEmitter();
      if (errorEmitter) {
        errorEmitter.emit(EventType.DEVICE_OPERATION_EXECUTED, {
          deviceId: this.id,
          deviceName: this.name,
          commandName,
          params,
          result: errorResult,
          executionTime,
          ...actorFields,
          ...eventIdFields,
        });
      }

      return errorResult;
    }
  }

  /**
   * Simulate a capability execution
   * @param capability - Capability to simulate
   * @param params - Parameters
   * @returns Simulated result with structured physical data
   */
  private async simulateCapability(capability: DeviceCapability, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const timestamp = new Date();
    const value = this.generateSimulatedValue(capability);
    const capabilityName = capability.name.toLowerCase();

    // Build structured result with common physical parameters
    const result: Record<string, unknown> = {
      timestamp,
      value,
      capability: capability.name,
      params: params || {},
    };

    // Add specific physical parameter fields for better test compatibility
    if (capabilityName.includes('temperature')) {
      result.temperature = typeof value === 'number' ? value : 20.0;
    }

    if (capabilityName.includes('humidity')) {
      result.humidity = typeof value === 'number' ? value : 50.0;
    }

    if (capabilityName.includes('light') || capabilityName.includes('brightness')) {
      result.lightLevel = typeof value === 'number' ? value : 50;
      result.brightness = typeof value === 'number' ? value : 50;
    }

    if (capabilityName.includes('motion')) {
      result.motion = typeof value === 'boolean' ? value : false;
      result.detected = typeof value === 'boolean' ? value : false;
    }

    if (capabilityName.includes('presence')) {
      result.presence = typeof value === 'boolean' ? value : false;
      result.occupied = typeof value === 'boolean' ? value : false;
    }

    if (capabilityName.includes('pressure')) {
      result.pressure = typeof value === 'number' ? value : 1013.25;
    }

    if (capabilityName.includes('air_quality') || capabilityName.includes('air-quality')) {
      result.airQuality = typeof value === 'number' ? value : 50;
      result.aqi = typeof value === 'number' ? value : 50;
    }

    if (capabilityName.includes('co2')) {
      result.co2 = typeof value === 'number' ? value : 400;
      result.carbonDioxide = typeof value === 'number' ? value : 400;
    }

    // For 'read' service, return all current state values
    if (capabilityName === 'read' || capabilityName === 'read-temperature' || capabilityName === 'get') {
      // Include current state values, but skip metadata objects
      const state = this.getState() as unknown as Record<string, unknown>;
      for (const [key, val] of Object.entries(state)) {
        // Skip entries that are objects (metadata) - only include primitive values
        if (!result[key] && typeof val !== 'object') {
          result[key] = val;
        }
      }

      // Ensure temperature field exists and is a number for temperature sensors
      if (this.capabilities.some((cap: DeviceCapability) => cap.name.toLowerCase().includes('temperature'))) {
        // Only set if not already a number
        if (typeof result.temperature !== 'number') {
          // Try to get numeric temperature from state, value, or default
          result.temperature = typeof state?.temperature === 'number' ? state.temperature :
                             (typeof value === 'number' ? value : 20.0);
        }
      }
    }

    // For 'getStatus' command, return the full device state
    if (capabilityName === 'getstatus') {
      const state = this.getState() as unknown as Record<string, unknown>;
      result.status = state.status || 'operational';
      result.deviceState = { ...state };
      // Include all primitive state values
      for (const [key, val] of Object.entries(state)) {
        if (typeof val !== 'object') {
          result[key] = val;
        }
      }
    }

    return result;
  }

  /**
   * Update device state based on command execution
   * Uses CommandHandlerRegistry for extensible command handling (OCP-compliant)
   * @param commandName - Command that was executed
   * @param params - Command parameters (pure semantic arguments)
   * @param context - Invocation context (audit actor; R17 params-purity fix)
   * @returns State updates that were applied (empty object if none)
   */
  private updateStateFromCommand(
    commandName: string,
    params?: Record<string, unknown>,
    context?: CommandInvocationContext,
  ): Partial<Record<string, unknown>> {
    logger.info(`[SimulatedDevice:${this.id}] updateStateFromCommand() called with:`, {
      commandName,
      params,
      currentStateBefore: this.currentState
    });

    // Use command handler registry to process the command
    const stateUpdates = this.commandHandlerRegistry.processCommand({
      commandName,
      params,
      currentState: this.getState(),
      deviceType: this.type,
      deviceId: this.id,
      ...(context?.actor !== undefined ? { actor: context.actor } : {}),
      // T-706: duration semantics (grant expiry) live on the SIM clock.
      simNow: this.physicalEnvironment?.getTimeManager?.().getCurrentTime(),
    });

    // Only update if there are changes
    if (Object.keys(stateUpdates).length > 0) {
      logger.info(`[SimulatedDevice:${this.id}] Calling setState with updates:`, stateUpdates);
      this.setState(stateUpdates);
      logger.info(`[SimulatedDevice:${this.id}] State after setState:`, this.currentState);
    } else {
      logger.info(`[SimulatedDevice:${this.id}] No state updates to apply (stateUpdate is empty)`);
    }

    return stateUpdates;
  }

  /**
   * Check whether a command is read/query-type (legitimately causes no state change)
   * Uses capability metadata when available, plus the SHARED read-only name
   * predicate (core capabilities/read-only.ts, BUG-04 — detect-* included).
   * @param commandName - Command name
   * @param capability - Matched device capability
   * @returns true if the command is read-only/query-type
   */
  private isReadOnlyCommand(commandName: string, capability: DeviceCapability): boolean {
    // Capability metadata marks read-type capabilities
    if (capability.type === 'read') {
      return true;
    }

    // Name-based classification for query-style commands (single source)
    return isReadOnlyCapabilityName(commandName);
  }

  /**
   * The commands this device can actually execute — the single source of
   * truth for the "declared = executable" contract. Derived live from the
   * declared capabilities plus the registered command handlers: a
   * capability is executable when a handler accepts it or it is a
   * read/query capability. Exposed in simulation snapshots so users can
   * discover device commands without reading source code.
   */
  getExecutableCommands(): string[] {
    return this.capabilities
      .filter(cap =>
        this.commandHandlerRegistry.getHandler(cap.name) !== undefined ||
        this.isReadOnlyCommand(cap.name, cap)
      )
      .map(cap => cap.name);
  }

  /**
   * Fix-44g: synthetic capability for alias COMMANDS a registered handler
   * claims but the device does not declare as a capability (e.g. 'set-mode'
   * / 'set-temperature' from core DeviceResource's multi-command expansion).
   * Parameters are not statically validated for aliases (no declared
   * ParameterDefinition) — the handler validates its own inputs; the state
   * change still flows through the normal updateStateFromCommand path.
   */
  private aliasCapabilityFor(commandName: string): DeviceCapability | undefined {
    try {
      if (this.commandHandlerRegistry.getHandler(commandName) === undefined) return undefined;
    } catch {
      return undefined;
    }
    return { name: commandName, type: 'execute', parameters: [] };
  }

  /**
   * Register physics effects with the physical environment
   * This connects device commands to the physics simulation
   * @param commandName - Name of the executed command
   * @param params - Command parameters
   */
  private registerPhysicsEffects(commandName: string, params?: Record<string, unknown>): void {
    if (!this.physicalEnvironment) {
      logger.info(`[SimulatedDevice:${this.id}] No physical environment, skipping physics effects`);
      return;
    }

    const physicsLayer = this.physicalEnvironment.getPhysicsLayer?.();
    if (!physicsLayer) {
      logger.info(`[SimulatedDevice:${this.id}] No physics layer available, skipping physics effects`);
      return;
    }

    // turn-off DISABLES the device's physics effects. Without this, an
    // actuator commanded off would keep emitting its effect forever.
    const normalized = commandName.toLowerCase().replace(/[-_\s]/g, '');
    if (normalized === 'turnoff' || normalized === 'poweroff') {
      physicsLayer.unregisterDeviceEffect(this.id);
      logger.info(`[SimulatedDevice:${this.id}] Device turned off, physics effects unregistered`);
      return;
    }

    // Create physics effect based on device type and command
    const effect = this.createPhysicsEffect(commandName, params);
    if (effect) {
      physicsLayer.registerDeviceEffect(effect);
      // FEAT-02: an exhaust fan is a ventilation device — alongside its
      // humidity effect it exchanges air while it runs (T-707 `air_flow`:
      // zone CO2 decays toward outdoor ppm, mild humidity relief, smoke
      // clearing). Same zone geometry as the primary effect; turn-off
      // unregisters both through the standard all-effects path.
      if (this.type.toLowerCase() === 'exhaust-fan') {
        const airFlowEffect: DevicePhysicsEffect = {
          deviceId: this.id,
          parameter: PhysicalParameter.CO2,
          effect: 'air_flow',
          magnitude: -0.1,
          affectedArea: { ...effect.affectedArea },
        };
        physicsLayer.registerDeviceEffect(airFlowEffect);
        this.lastRegisteredEffects.set(airFlowEffect.parameter, { ...airFlowEffect });
      }
      // Remember the last commanded effect per parameter: the control loop
      // rebuilds a lost effect from this snapshot (ensureControlEffect),
      // because re-deriving direction at target-crossing time is ambiguous
      // (target ≈ current → heating/cooling coin flip).
      this.lastRegisteredEffects.set(effect.parameter, { ...effect });
      logger.info(`[SimulatedDevice:${this.id}] Registered physics effect: ${effect.effect} for ${effect.parameter}`);

      // Note: Physics effects are now persistent. Call PhysicalEnvironment.simulate()
      // after command execution to run the continuous physics loop and let effects
      // accumulate gradually toward equilibrium.
      // The old approach of updatePhysics(simDuration) here did a single-step physics
      // update which was insufficient for many physical processes (e.g., HVAC cooling
      // needs many small steps to converge naturally).
    }

    // FEAT-03 (stage 2): scenario-declared device couplings
    // (`parameterEffects`) are INDEPENDENT of the device-type effect table
    // above — a fume hood has no standard physics effect, yet its
    // `ventilation` capability still drains a declared custom zone
    // parameter while it runs.
    this.registerDeclaredParameterEffects(physicsLayer, commandName);
  }

  /**
   * FEAT-03 (stage 2): register `parameter_rate` effects for the scenario's
   * declared device couplings (PhysicalEnvironmentConfig.parameterEffects,
   * intake-filtered to declared custom parameters only). Gated on the device
   * being ON — the coupling is "active device drives the zone parameter";
   * turn-off unregisters every effect through the standard path above, so a
   * powered-off device couples nothing. Multiple declarations onto the same
   * parameter SUM into one effect (registerDeviceEffect replaces per
   * (deviceId, parameter), so repeated commands never stack).
   */
  private registerDeclaredParameterEffects(
    physicsLayer: PhysicsLayer,
    commandName: string,
  ): void {
    const declarations = this.physicalEnvironment?.getParameterEffectDeclarations?.();
    if (!declarations || declarations.length === 0) return;

    const stateRecord = this.getState() as unknown as Record<string, unknown>;
    const normalizedCommand = commandName.toLowerCase().replace(/[-_\s]/g, '');
    const isPoweredOn = normalizedCommand === 'turnon' || stateRecord.power === true;
    if (!isPoweredOn) return;

    const matching = declarations.filter(decl => {
      const capabilityHit = decl.capability !== undefined &&
        this.capabilities.some(c => c.name.toLowerCase() === decl.capability!.toLowerCase());
      const typeHit = decl.deviceType !== undefined &&
        this.type.toLowerCase() === decl.deviceType.toLowerCase();
      return capabilityHit || typeHit;
    });
    if (matching.length === 0) return;

    const locationStr = typeof this.location === 'string' ? this.location : JSON.stringify(this.location);

    // Aggregate per target parameter: two declarations onto the same key
    // (capability- and type-selected) sum their rates into ONE effect.
    const rateByParameter = new Map<string, number>();
    for (const decl of matching) {
      rateByParameter.set(decl.zoneParameter, (rateByParameter.get(decl.zoneParameter) ?? 0) + decl.ratePerSec);
    }
    for (const [zoneParameter, ratePerSec] of rateByParameter) {
      physicsLayer.registerDeviceEffect({
        deviceId: this.id,
        parameter: zoneParameter,
        effect: 'parameter_rate',
        magnitude: ratePerSec,
        affectedArea: { location: locationStr, radius: 0 },
      });
      logger.info(
        `[SimulatedDevice:${this.id}] Registered parameter coupling: ${zoneParameter} @ ${ratePerSec}/s while on`,
      );
    }
  }

  /**
   * Create a physics effect based on device type and command
   * @param commandName - Name of the executed command
   * @param params - Command parameters
   * @returns DevicePhysicsEffect or null
   */
  private createPhysicsEffect(commandName: string, params?: Record<string, unknown>): DevicePhysicsEffect | null {
    const deviceType = this.type.toLowerCase();
    const state = this.getState();

    // Parse location string
    const locationStr = typeof this.location === 'string' ? this.location : JSON.stringify(this.location);

    // Parse position from location
    let position: { x: number; y: number; z?: number } = { x: 0, y: 0, z: 0 };
    if (typeof this.location === 'string') {
      const parts = this.location.split(',').map(p => parseFloat(p.trim()));
      if (parts.length >= 2) {
        position = { x: parts[0], y: parts[1], z: parts[2] || 0 };
      }
    } else if (typeof this.location === 'object' && this.location !== null) {
      position = this.location as unknown as { x: number; y: number; z?: number };
    }

    // Check if device has power on
    const stateRecord = state as unknown as Record<string, unknown>;
    const isPoweredOn = commandName === 'turnOn' || stateRecord.power === true;

    // R101 (chen-15): the 'ventilation' command exchanges air at the
    // device's zone — a T-707 `air_flow` effect (zone CO2 decays toward
    // outdoor ppm while the unit runs, plus mild humidity relief). Gated
    // on the device declaring a ventilation-class capability so a stray
    // 'ventilation' command on a non-vent unit stays physically inert.
    // FEAT-02: `set-mode {mode:'ventilation'}` on such a device is the same
    // physical act (the ClimateModeCommandHandler lands it in state as
    // power-on + mode 'ventilation') — same effect, same gate.
    const normalizedCommand = commandName.toLowerCase().replace(/[-_\s]/g, '');
    const isVentilationActuation = normalizedCommand === 'ventilation' ||
      (normalizedCommand === 'setmode' &&
        String(params?.mode ?? '').toLowerCase() === 'ventilation');
    if (isVentilationActuation) {
      if (!isPoweredOn) return null;
      const declaresVentilation = this.capabilities.some(c => /ventilat|exhaust|purif/i.test(c.name));
      if (!declaresVentilation) return null;
      return {
        deviceId: this.id,
        parameter: PhysicalParameter.CO2,
        effect: 'air_flow',
        magnitude: -0.1,
        affectedArea: {
          location: locationStr,
          radius: 4,
          position,
        },
      };
    }

    // Determine effect based on device type and command
    switch (deviceType) {
      case 'ac':
      case 'air-conditioner':
      case 'hvac':
      case 'hvac-controller':
        if (isPoweredOn) {
          // Default rated power: 3 kW cooling/heating (typical residential
          // split; overridable per device via initialState.coolingPowerW /
          // heatingPowerW). The HeatTransferModel converts power (W) to ΔT
          // using the zone's thermal mass: ΔT = P·t / (ρ·V·c) — per zone
          // volume when the runtime registered one, else the global
          // 100 m³ default (≈123 kJ/K → ≈0.024 °C/s at 3 kW).
          //
          // HVAC mode determines direction:
          //   mode === 'cooling' → negative magnitude (cooling)
          //   mode === 'heating' → positive magnitude (heating)
          //   mode === 'auto'    → determine from targetTemperature vs current
          const hvacMode = stateRecord.mode as string | undefined;
          const targetTemp = (stateRecord.targetTemperature as number) ?? (params?.target as number) ?? 22;
          // Auto-mode direction needs the CURRENT temperature. Prefer the
          // physical field at the device's own location (the real world)
          // over state mirrors; fall back to 22°C when no field is attached.
          const currentTemp = this.senseLocalParameter(PhysicalParameter.TEMPERATURE) ??
            (stateRecord.currentTemperature as number) ??
            (stateRecord.temperature as number) ??
            22;
          // Rated power is device-declared (initialState.coolingPowerW /
          // heatingPowerW), not only the hardcoded 3 kW template default —
          // a 40-person classroom unit and a bedroom split differ.
          const coolingPowerW = (stateRecord.coolingPowerW as number) ?? 3000;
          const heatingPowerW = (stateRecord.heatingPowerW as number) ?? 3000;

          let effectDirection: 'cooling' | 'heating';
          let magnitude: number;

          if (hvacMode === 'cooling') {
            effectDirection = 'cooling';
            magnitude = -coolingPowerW;
          } else if (hvacMode === 'heating') {
            effectDirection = 'heating';
            magnitude = heatingPowerW;
          } else {
            // auto or unspecified: determine from target vs current
            if (targetTemp < currentTemp) {
              effectDirection = 'cooling';
              magnitude = -coolingPowerW;
            } else {
              effectDirection = 'heating';
              magnitude = heatingPowerW;
            }
          }

          return {
            deviceId: this.id,
            parameter: PhysicalParameter.TEMPERATURE,
            effect: effectDirection,
            magnitude,
            affectedArea: {
              location: locationStr,
              // A split residential unit conditions ITS room: ~4 m effective
              // range. (The old radius 10 bathed a whole 12×9 m apartment,
              // collapsing every zone to the same temperature.)
              radius: 4,
              position,
            },
          };
        }
        break;

      case 'heater':
      case 'radiator':
        if (isPoweredOn) {
          return {
            deviceId: this.id,
            parameter: PhysicalParameter.TEMPERATURE,
            effect: 'heating',
            magnitude: (params?.intensity as number) || 3000,
            affectedArea: {
              location: locationStr,
              radius: 5,
              position,
            },
          };
        }
        break;

      case 'humidifier':
        if (isPoweredOn) {
          return {
            deviceId: this.id,
            parameter: PhysicalParameter.HUMIDITY,
            effect: 'humidity',
            magnitude: 0.3, // %RH/s rate (BUG-09: PhysicsLayer scales by dt)
            affectedArea: {
              location: locationStr,
              radius: 3,
              position,
            },
          };
        }
        break;

      case 'light':
      case 'lamp':
        if (isPoweredOn) {
          // BUG-09: map brightness to the luminaire's steady-state
          // illuminance contribution in lux — the raw 0-100 brightness used
          // to be passed straight through as the effect magnitude (and then
          // added per pass with no dt in PhysicsLayer). The 0.8 fallback is
          // the family's historical default (legacy 0-1 fraction = 80%).
          return {
            deviceId: this.id,
            parameter: PhysicalParameter.LIGHT,
            effect: 'light',
            magnitude: brightnessToLuxContribution((params?.brightness as number) || 0.8),
            affectedArea: {
              location: locationStr,
              radius: 4,
              position,
            },
          };
        }
        break;

      case 'dehumidifier':
        if (isPoweredOn) {
          return {
            deviceId: this.id,
            parameter: PhysicalParameter.HUMIDITY,
            effect: 'humidity',
            magnitude: -0.3, // %RH/s rate (BUG-09: PhysicsLayer scales by dt)
            affectedArea: {
              location: locationStr,
              radius: 3,
              position,
            },
          };
        }
        break;

      case 'thermostat':
        // Thermostat produces heating or cooling effect based on mode
        const thermostatMode = stateRecord.mode;
        const targetTemp = (stateRecord.targetTemperature as number) || 22;
        if (thermostatMode === 'heating') {
          return {
            deviceId: this.id,
            parameter: PhysicalParameter.TEMPERATURE,
            effect: 'heating',
            magnitude: 0.5,
            affectedArea: {
              location: locationStr,
              radius: 5,
              position,
            },
          };
        } else if (thermostatMode === 'cooling') {
          return {
            deviceId: this.id,
            parameter: PhysicalParameter.TEMPERATURE,
            effect: 'cooling',
            magnitude: -0.5,
            affectedArea: {
              location: locationStr,
              radius: 5,
              position,
            },
          };
        }
        break;

      case 'air-purifier':
        if (isPoweredOn) {
          // Reduces airborne pollutants (PM2.5, VOC) when running
          const purifyPower = (stateRecord.fanSpeed as number) || 50;
          const purifyMagnitude = -(purifyPower / 100) * 0.5; // Scale with fan speed
          return {
            deviceId: this.id,
            parameter: PhysicalParameter.PM25,
            effect: 'pollutant',
            magnitude: purifyMagnitude,
            affectedArea: {
              location: locationStr,
              radius: 5,
              position,
            },
          };
        }
        break;

      case 'exhaust-fan':
        if (isPoweredOn) {
          // Exhaust fan provides ventilation — slight humidity reduction + air exchange
          const fanSpeed = (stateRecord.speed as number) || 50;
          const exhaustMagnitude = -(fanSpeed / 100) * 0.2; // %RH/s rate (BUG-09: scaled by dt)
          return {
            deviceId: this.id,
            parameter: PhysicalParameter.HUMIDITY,
            effect: 'humidity',
            magnitude: exhaustMagnitude,
            affectedArea: {
              location: locationStr,
              radius: 4,
              position,
            },
          };
        }
        break;

      case 'speaker':
        // Speaker is a state-only actuator; no physical environment effect needed.
        // The command execution (play-alert, set-volume) changes device state, which
        // is verified by the experiment metrics without requiring physics simulation.
        break;

      case 'environment-source':
      case 'weather-simulator':
        // Environment source sets absolute values for simulation purposes
        // Used for initializing environment and simulating external changes
        // IMPORTANT: Supports params.location to set values at specific locations
        // If params.location is provided, use it; otherwise use device's own location
        const envTargetLocation = params?.location || locationStr;
        let envTargetPosition = position;

        // Parse target position from params.location if provided
        if (params?.location && typeof params.location === 'string') {
          const parts = params.location.split(',').map((p: string) => parseFloat(p.trim()));
          if (parts.length >= 2) {
            envTargetPosition = { x: parts[0], y: parts[1], z: parts[2] || 0 };
          }
        }

        if (commandName === 'set-temperature' && params?.value !== undefined) {
          return {
            deviceId: this.id,
            parameter: PhysicalParameter.TEMPERATURE,
            effect: 'set',
            magnitude: params.value as number,
            affectedArea: {
              location: envTargetLocation as string,
              radius: (params.radius as number) || 10,
              position: envTargetPosition,
            },
          };
        } else if (commandName === 'set-humidity' && params?.value !== undefined) {
          return {
            deviceId: this.id,
            parameter: PhysicalParameter.HUMIDITY,
            effect: 'set',
            magnitude: params.value as number,
            affectedArea: {
              location: envTargetLocation as string,
              radius: (params.radius as number) || 10,
              position: envTargetPosition,
            },
          };
        }
        break;
    }

    // Turn off effects - unregister
    if (commandName === 'turnOff') {
      // Return null to indicate no active effect
      logger.info(`[SimulatedDevice:${this.id}] Device turned off, no physics effect needed`);
      return null;
    }

    return null;
  }

  /**
   * Generate a simulated value for a capability
   * ENHANCED: Read from physical environment if available, otherwise use random generation
   * @param capability - Capability
   * @returns Simulated value
   */
  private generateSimulatedValue(capability: DeviceCapability): unknown {
    // Use physical environment if available and device has location
    if (this.physicalEnvironment && this.location) {
      const physicalValue = this.getPhysicalValue(capability.name);
      if (physicalValue !== null) {
        // Add sensor-specific noise to the environment value
        const sensorNoise = this.generateSensorNoise(capability);
        return this.addNoise(physicalValue, sensorNoise);
      }
    }

    // Fallback to original random generation
    return this.generateRandomValue(capability);
  }

  /**
   * Get value from physical environment
   * @param capabilityName - Name of the capability
   * @returns Physical value or null if not available
   */
  private getPhysicalValue(capabilityName: string): number | boolean | null {
    const parameter = this.mapCapabilityToParameter(capabilityName);
    if (!parameter) {
      return null;
    }

    return this.physicalEnvironment!.getParameterValue(parameter, this.location);
  }

  /**
   * Map capability name to physical parameter
   * @param name - Capability name
   * @returns Physical parameter or null
   */
  /**
   * R44-insane §11.6: memoized capability→parameter mapping. The pure
   * chain of includes() ran per sensor per capability per tick (sensors
   * sample every tick; capability names repeat across a fleet, so a
   * module-level Map turns nearly every call into one lookup). Misses run
   * the ORIGINAL chain unchanged.
   */
  private static readonly capabilityParameterCache = new Map<string, PhysicalParameter | null>();

  private mapCapabilityToParameter(name: string): PhysicalParameter | null {
    if (SimulatedDevice.capabilityParameterCache.has(name)) {
      return SimulatedDevice.capabilityParameterCache.get(name) ?? null;
    }
    const resolved = SimulatedDevice.resolveCapabilityParameter(name);
    SimulatedDevice.capabilityParameterCache.set(name, resolved);
    return resolved;
  }

  private static resolveCapabilityParameter(name: string): PhysicalParameter | null {
    const nameLower = name.toLowerCase();

    if (nameLower.includes('temperature')) return PhysicalParameter.TEMPERATURE;
    if (nameLower.includes('humidity')) return PhysicalParameter.HUMIDITY;
    if (nameLower.includes('light') || nameLower.includes('brightness')) return PhysicalParameter.LIGHT;
    if (nameLower.includes('motion')) return PhysicalParameter.MOTION;
    if (nameLower.includes('presence')) return PhysicalParameter.PRESENCE;
    if (nameLower.includes('pressure') && !nameLower.includes('blood')) return PhysicalParameter.PRESSURE;
    if (nameLower.includes('air_quality') || nameLower.includes('air-quality')) return PhysicalParameter.AIR_QUALITY;
    if (nameLower.includes('co2')) return PhysicalParameter.CO2;
    if (nameLower.includes('pm2_5') || nameLower.includes('pm25') || nameLower.includes('pm2.5')) return PhysicalParameter.PM25;
    if (nameLower.includes('uv')) return PhysicalParameter.UV_INDEX;
    if (nameLower.includes('wind')) {
      if (nameLower.includes('speed')) return PhysicalParameter.WIND_SPEED;
      if (nameLower.includes('direction')) return PhysicalParameter.WIND_DIRECTION;
      return PhysicalParameter.WIND_SPEED;
    }
    if (nameLower.includes('noise')) return PhysicalParameter.NOISE_LEVEL;
    if (nameLower.includes('energy') || nameLower.includes('power')) return PhysicalParameter.ENERGY_CONSUMPTION;
    if (nameLower.includes('voltage')) return PhysicalParameter.VOLTAGE;
    if (nameLower.includes('current')) return PhysicalParameter.CURRENT;
    if (nameLower.includes('rain')) return PhysicalParameter.RAINFALL;
    if (nameLower.includes('soil') && nameLower.includes('moisture')) return PhysicalParameter.SOIL_MOISTURE;
    // R52: water-level sensing (flood detectors, grid water gauges) — the
    // missing branch is why 内涝水位计/网格水位传感器 carried no reading.
    if (nameLower.includes('water_level') || nameLower.includes('water-level') || nameLower.includes('waterlevel')) {
      return PhysicalParameter.WATER_LEVEL;
    }
    // R78-D: crowd/people sensing (people counters, R77 F2) — without this
    // branch the new 客流 counters would place fine but carry no reading.
    if (nameLower.includes('people') || nameLower.includes('crowd') || nameLower.includes('occupancy')) {
      return PhysicalParameter.OCCUPANCY;
    }

    return null;
  }

  /**
   * Generate sensor-specific noise
   * @param capability - Capability
   * @returns Noise value
   */
  /**
   * Fix-53a: configurable sensor noise. When `sensorNoise` is NOT declared
   * on the device (the default), this returns 0 — the sensor reads the
   * physics field deterministically, matching the platform's determinism
   * principle. Devices that explicitly declare noise (via initialState
   * `sensorNoise: { sigma: 0.3 }` or a future device-config field) get
   * Gaussian noise with the declared sigma.
   *
   * Pre-fix this was always-on uniform noise (±0.5°C, ±2%RH, ±10 lux)
   * hardcoded per capability type — non-configurable, non-deterministic,
   * and impossible to disable for testing.
   */
  private generateSensorNoise(capability: DeviceCapability): number {
    // Fix-53a: opt-in noise only — read from the device's initialState
    const state = this.currentState as unknown as Record<string, unknown>;
    const noiseConfig = state.sensorNoise as { sigma?: number; type?: string } | undefined;

    if (!noiseConfig || typeof noiseConfig.sigma !== 'number' || noiseConfig.sigma <= 0) {
      return 0; // no noise configured → deterministic read
    }

    // Gaussian noise via Box-Muller transform
    const sigma = noiseConfig.sigma;
    if (noiseConfig.type === 'uniform') {
      return (Math.random() - 0.5) * 2 * sigma;
    }
    // Default: Gaussian
    const u1 = Math.max(1e-10, Math.random());
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
  }

  /**
   * Add noise to a value
   * @param value - Base value
   * @param noise - Noise value
   * @returns Value with noise added
   */
  private addNoise(value: number | boolean, noise: number): number | boolean {
    if (typeof value === 'boolean') {
      // For boolean values, noise flips the value with small probability
      return Math.abs(noise) > 0.8 ? !value : value;
    }
    return value + noise;
  }

  /**
   * Original random generation (fallback)
   * @param capability - Capability
   * @returns Random value
   */
  private generateRandomValue(capability: DeviceCapability): unknown {
    // Generate different values based on capability name
    const name = capability.name.toLowerCase();

    if (name.includes('temperature')) {
      // Simulate temperature between 18-26°C
      return 18 + Math.random() * 8;
    }

    if (name.includes('humidity')) {
      // Simulate humidity between 30-70%
      return 30 + Math.random() * 40;
    }

    if (name.includes('light') || name.includes('brightness')) {
      // Simulate light level 0-100
      return Math.floor(Math.random() * 101);
    }

    if (name.includes('motion')) {
      // Simulate motion detection (true/false)
      return Math.random() > 0.7;
    }

    if (name.includes('switch') || name.includes('on')) {
      // Simulate switch state
      return Math.random() > 0.5;
    }

    // Default value
    return { simulated: true, timestamp: new Date() };
  }

  /**
   * Start a behavior
   * @param behavior - Behavior to start
   */
  protected startBehavior(behavior: BehaviorConfig): void {
    switch (behavior.type) {
      case BehaviorType.PERIODIC:
        this.startPeriodicBehavior(behavior);
        break;
      case BehaviorType.EVENT_DRIVEN:
        this.startEventDrivenBehavior(behavior);
        break;
      case BehaviorType.RANDOM:
        this.startRandomBehavior(behavior);
        break;
      case BehaviorType.SCRIPTED:
        this.startScriptedBehavior(behavior);
        break;
    }
  }

  /**
   * Start periodic behavior
   * @param behavior - Periodic behavior config
   */
  private startPeriodicBehavior(behavior: BehaviorConfig): void {
    if (!behavior.interval) {
      logger.warn(`[SimulatedDevice:${this.id}] Periodic behavior missing interval`);
      return;
    }

    const timer = setInterval(() => {
      this.updateStateFromBehavior(behavior);
    }, behavior.interval);

    this.behaviorTimers.set(`${BehaviorType.PERIODIC}:${behavior.interval}`, timer);

    logger.info(
      `[SimulatedDevice:${this.id}] Started periodic behavior: ${behavior.interval}ms`
    );
  }

  /**
   * Start event-driven behavior
   * @param behavior - Event-driven behavior config
   */
  private startEventDrivenBehavior(behavior: BehaviorConfig): void {
    // For now, just log that it's registered
    // In a full implementation, this would set up event listeners
    logger.info(
      `[SimulatedDevice:${this.id}] Registered event-driven behavior:`,
      behavior.conditions
    );
  }

  /**
   * Start random behavior
   * @param behavior - Random behavior config
   */
  private startRandomBehavior(behavior: BehaviorConfig): void {
    const probability = behavior.probability || 0.1;
    const interval = 1000; // Check every second

    const timer = setInterval(() => {
      if (Math.random() < probability) {
        this.updateStateFromBehavior(behavior);
      }
    }, interval);

    this.behaviorTimers.set(`${BehaviorType.RANDOM}:${Date.now()}`, timer);

    logger.info(
      `[SimulatedDevice:${this.id}] Started random behavior: probability=${probability}`
    );
  }

  /**
   * Start scripted behavior
   * @param behavior - Scripted behavior config
   */
  private startScriptedBehavior(behavior: BehaviorConfig): void {
    if (!behavior.script || behavior.script.length === 0) {
      logger.warn(`[SimulatedDevice:${this.id}] Scripted behavior missing script`);
      return;
    }

    let scriptIndex = 0;

    const executeNextScriptStep = () => {
      if (scriptIndex >= behavior.script!.length) {
        logger.info(`[SimulatedDevice:${this.id}] Script completed`);
        return;
      }

      const step = behavior.script![scriptIndex];
      this.setState(step);

      scriptIndex++;

      // Schedule next step if there's a delay
      if (scriptIndex < behavior.script!.length && step.delay) {
        const timer = setTimeout(executeNextScriptStep, step.delay);
        this.behaviorTimers.set(`scripted:${scriptIndex}`, timer as unknown as NodeJS.Timeout);
      }
    };

    // Start executing the script
    executeNextScriptStep();

    logger.info(`[SimulatedDevice:${this.id}] Started scripted behavior`);
  }

  /**
   * Update state from behavior
   * @param behavior - Behavior that triggered update
   */
  private updateStateFromBehavior(behavior: BehaviorConfig): void {
    // Generate simulated state update
    const updates: Record<string, unknown> = {
      lastBehavior: behavior.type,
      lastUpdate: new Date(),
    };

    // Add behavior-specific updates
    for (const cap of this.capabilities) {
      updates[cap.name] = this.generateSimulatedValue(cap);
    }

    this.setState(updates);
  }

  /**
   * Generate services from capabilities
   */
  private generateServices(): void {
    this.services = (this.capabilities || []).map((cap) => ({
      id: `${this.id}-${cap.name}`,
      name: cap.name,
      description: `Simulated ${cap.name} service`,
      deviceId: this.id,
      uri: `simulated://${this.id}/services/${cap.name}`,
      httpMethod: 'GET',
      parameters: cap.parameters || [],
      location: this.getLocationPath(),
      category: this.type,
      isConditional: false,
    }));

    logger.info(`[SimulatedDevice:${this.id}] Generated ${this.services.length} services`);
  }

  /**
   * Get device info as Device object
   * @returns Device object with services
   */
  getDeviceInfo(): Device {
    const device = super.getDeviceInfo();
    device.services = this.services;
    return device;
  }

  /**
   * Get all services
   * @returns Array of services
   */
  getServices(): Service[] {
    return this.services;
  }

  // ==========================================================================
  // Device State Update Architecture
  // ==========================================================================

  /**
   * Handle PhysicsEvent from PhysicalEnvironment
   *
   * This method receives internal physics events and converts them to
   * DeviceStateUpdates for agents. This is the key abstraction that makes
   * the system portable between simulation and real deployment.
   *
   * @param physicsEvent - Physics event from PhysicalEnvironment
   */
  handlePhysicsEvent(physicsEvent: {
    type: string;
    location: { x: number; y: number; z: number };
    parameter: string;
    oldValue: number;
    newValue: number;
    timestamp: Date;
    isAnomaly?: boolean;
    cause?: string;
  }): void {
    logger.info(`[SimulatedDevice:${this.id}] Received physics event:`, physicsEvent.type);

    // Check if this device is at the affected location
    const deviceLocation = this.getLocation();
    if (deviceLocation) {
      const locStr = JSON.stringify(deviceLocation);
      const eventLocStr = JSON.stringify(physicsEvent.location);

      // If locations don't match, ignore the event
      // (Device only processes physics events at its location)
      if (locStr !== eventLocStr) {
        return;
      }
    }

    // Convert physics event to device state change
    const stateChange = this.physicsToStateChange(physicsEvent);

    if (stateChange) {
      // Update internal state
      const oldState = { ...this.currentState };
      this.setState({ [stateChange.property]: stateChange.newValue });

      // Emit DeviceStateUpdate for agents
      this.emitDeviceStateUpdate({
        property: stateChange.property,
        oldValue: stateChange.oldValue,
        newValue: stateChange.newValue,
        unit: stateChange.unit,
        significance: this.assessSignificance(physicsEvent),
        anomaly: physicsEvent.isAnomaly || false,
        source: 'physics',
      });
    }
  }

  /**
   * Convert physics event to device state change
   * Maps physics parameters to device state properties
   */
  private physicsToStateChange(physicsEvent: {
    parameter: string;
    oldValue: number;
    newValue: number;
  }): { property: string; oldValue: unknown; newValue: unknown; unit?: string } | null {
    const mapping: Record<string, { property: string; unit: string }> = {
      temperature: { property: 'temperature', unit: '°C' },
      humidity: { property: 'humidity', unit: '%' },
      airQuality: { property: 'airQuality', unit: 'AQI' },
      pressure: { property: 'pressure', unit: 'hPa' },
      light: { property: 'lightLevel', unit: 'lux' },
      motion: { property: 'motion', unit: 'boolean' },
    };

    const map = mapping[physicsEvent.parameter];
    if (!map) {
      return null;
    }

    return {
      property: map.property,
      oldValue: physicsEvent.oldValue,
      newValue: physicsEvent.newValue,
      unit: map.unit,
    };
  }

  /**
   * Assess significance of a physics event
   */
  private assessSignificance(physicsEvent: {
    parameter: string;
    newValue: number;
    isAnomaly?: boolean;
  }): 'normal' | 'warning' | 'critical' {
    // Anomaly events are at least warnings
    if (physicsEvent.isAnomaly) {
      return 'warning';
    }

    // Parameter-specific thresholds
    const thresholds: Record<string, { warning: [number, number]; critical: [number, number] }> = {
      temperature: { warning: [30, 38], critical: [40, 50] },
      humidity: { warning: [70, 90], critical: [90, 100] },
      airQuality: { warning: [100, 150], critical: [200, 500] },
    };

    const threshold = thresholds[physicsEvent.parameter];
    if (!threshold) {
      return 'normal';
    }

    const value = physicsEvent.newValue;
    if (value >= threshold.critical[0] || value <= threshold.critical[1]) {
      return 'critical';
    }
    if (value >= threshold.warning[0] || value <= threshold.warning[1]) {
      return 'warning';
    }

    return 'normal';
  }

  /**
   * Emit DeviceStateUpdate to agents
   *
   * This is the PRIMARY way agents receive device information.
   * Agents should ONLY receive these from devices they manage.
   *
   * @param stateChange - State change details
   */
  emitDeviceStateUpdate(stateChange: {
    property: string;
    oldValue: unknown;
    newValue: unknown;
    unit?: string;
    significance?: 'normal' | 'warning' | 'critical';
    anomaly?: boolean;
    source?: string;
  }): void {
    const emitter = this.getEventEmitter();
    if (!emitter) {
      logger.info(`[SimulatedDevice:${this.id}] No emitter, cannot emit DeviceStateUpdate`);
      return;
    }

    const location = this.getLocation();

    const deviceStateUpdate = {
      deviceId: this.id,
      deviceType: this.type,
      timestamp: new Date(),
      location: location,
      stateChange: {
        property: stateChange.property,
        oldValue: stateChange.oldValue,
        newValue: stateChange.newValue,
        unit: stateChange.unit,
      },
      context: {
        significance: stateChange.significance || 'normal',
        anomaly: stateChange.anomaly || false,
        source: stateChange.source || 'device',
      },
      fullState: this.currentState,
    };

    // Emit as DEVICE_STATE_UPDATE (agent-facing notification)
    emitter.emit(EventType.DEVICE_STATE_UPDATE, deviceStateUpdate);

    logger.info(`[SimulatedDevice:${this.id}] Emitted DeviceStateUpdate:`, {
      property: stateChange.property,
      oldValue: stateChange.oldValue,
      newValue: stateChange.newValue,
      significance: stateChange.significance,
    });
  }

  /**
   * Subscribe to physics events from EventManager
   *
   * This method allows the device to receive physics events
   * from the PhysicalEnvironment. The device will convert these
   * to DeviceStateUpdates for agents.
   *
   * @param eventManager - EventManager to subscribe to
   */
  subscribeToPhysicsEvents(eventManager: EventManager): void {
    const physicsEventTypes = [
      EventType.PHYSICS_TEMPERATURE_CHANGE,
      EventType.PHYSICS_HUMIDITY_CHANGE,
      EventType.PHYSICS_AIR_QUALITY_CHANGE,
      EventType.PHYSICS_MOTION_DETECTED,
      EventType.PHYSICS_LIGHT_CHANGE,
      EventType.PHYSICS_PRESSURE_CHANGE,
    ];

    physicsEventTypes.forEach(eventType => {
      eventManager.subscribe({
        subscriberId: `device:${this.id}`,
        eventType,
        handler: async (event: SystemEvent) => {
          try {
            this.handlePhysicsEvent(event.payload);
          } catch (error) {
            logger.error(`[SimulatedDevice:${this.id}] Error handling physics event:`, error);
          }
        },
      });
    });

    logger.info(`[SimulatedDevice:${this.id}] Subscribed to physics events`);
  }
}
