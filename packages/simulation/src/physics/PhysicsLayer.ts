/**
 * Physics Layer
 *
 * Coordinator between devices and the physics simulation.
 * Responsibilities:
 * 1. Translate device effects to abstract effect sources
 * 2. Coordinate with SpatialPropagationEngine for spatial calculations
 * 3. Apply physics results to PhysicalEnvironment
 * 4. Manage state interpolation
 *
 * Key architectural principle:
 * - PhysicsLayer is a COORDINATOR, not a physics calculator
 * - SpatialPropagationEngine handles pure spatial propagation
 * - Devices don't know about physics, physics doesn't know about devices
 */

import { TimeManager } from '../environment/TimeManager.js';
import { PhysicalEnvironment } from '../environment/PhysicalEnvironment.js';
import { HeatTransferModel, type HeatTransferConfig } from './HeatTransferModel.js';
import { StateInterpolator, type InterpolationConfig } from './StateInterpolator.js';
import { SpatialPropagationEngine, type PropagationLocation } from './SpatialPropagationEngine.js';
import { EffectSourceRegistry, EffectSource, PhysicalEffectType, type PhysicalFalloffType } from './EffectSource.js';
import { SpatialField, clampFieldValue, type FieldAttractor, type FieldPosition, type ZonePhysicsMetadata } from './SpatialField.js';
import { HumidityModel } from './HumidityModel.js';
import { ThermalComfortModel } from './ThermalComfortModel.js';
import { AirQualityModel } from './AirQualityModel.js';
import { PhysicalParameter, type DeviceLocation } from '../devices/types.js';
import { SpatialManager, type Coordinate2D, type Coordinate3D } from '../spatial/index.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Device physics effect (device-specific representation)
 *
 * This is what devices provide. PhysicsLayer translates this to
 * EffectSource for the SpatialPropagationEngine.
 */
const logger = createLogger('PhysicsLayer');

/**
 * T-707: outdoor CO2 concentration (ppm) — the ventilation asymptote. Fresh
 * air never pulls a zone below the outdoor baseline (F-PH08: the old
 * single-step flush settled to 497.85 while the baseline was 600).
 */
const OUTDOOR_CO2_PPM = 420;

/**
 * R102: smoke-removal extraction per unit of air_flow magnitude (1/s per
 * unit). The ventilation command's air_flow magnitude is 0.1 → ~0.03/s
 * removal — ≈3× the field's natural smoke relaxation (0.01/s, half-life
 * ≈69 s), so a running fresh-air unit visibly accelerates smoke clearing
 * (half-life ≈23 s) as the emergency story requires, without the
 * purifier path's up-to-0.5/s instant wipe.
 */
const SMOKE_VENTILATION_EXTRACTION = 0.3;

export interface DevicePhysicsEffect {
  deviceId: string;
  /**
   * Target parameter. Enum parameters ride the propagation engine; the
   * FEAT-03 `parameter_rate` coupling targets a CUSTOM (non-enum) key.
   */
  parameter: PhysicalParameter | string;
  /**
   * `parameter_rate` (FEAT-03 stage 2): a scenario-declared device coupling
   * (`parameterEffects`) — while the device is ON, the custom zone parameter
   * drifts at `magnitude` units/second (dt-normalized in updatePhysics;
   * negative = removal). Never enters the propagation engine; the physics
   * layer applies it straight onto the field entry.
   */
  effect: 'heating' | 'cooling' | 'humidity' | 'light' | 'motion' | 'set' | 'pollutant' | 'air_flow' | 'parameter_rate';
  /**
   * Effect strength. Units depend on the effect type: heating/cooling =
   * watts; light = steady-state illuminance contribution in LUX (BUG-09 —
   * map device brightness via brightnessToLuxContribution, do NOT pass the
   * raw 0-100 brightness); humidity = %RH/s rate (BUG-09 dt-normalized);
   * pollutant = fraction/s (removal) or per-pass add (source); set =
   * absolute value.
   */
  magnitude: number;
  affectedArea: {
    location: string;
    radius: number;
    position?: Coordinate2D | Coordinate3D;
  };
  falloff?: 'linear' | 'inverse-square' | 'exponential';
  enabled?: boolean;
  /**
   * T-106 (F-PH02b): the device's published thermostat intent for this
   * effect (target/capacity/direction), refreshed by the device each
   * control tick. Lets sibling HVAC units in the same zone see each other
   * WITHOUT devices holding references to one another — the effect entry
   * is the shared, layer-owned state.
   */
  thermostat?: {
    targetTemperature: number;
    capacityW: number;
    heating: boolean;
  };
}

/**
 * Physics update result
 */
export interface PhysicsUpdateResult {
  deltaTime: number;
  updatesApplied: number;
  deviceEffectsProcessed: number;
  interpolationUpdates: number;
}

/**
 * Physics layer configuration
 */
export interface PhysicsLayerConfig {
  enableFullPhysics?: boolean;
  updateInterval?: number;
  spatialResolution?: number;
  heatTransferConfig?: HeatTransferConfig;
  interpolationConfig?: InterpolationConfig;
  spatialManager?: SpatialManager;
}

/**
 * State change event
 */
export interface StateChangeEvent {
  location: string;
  parameter: PhysicalParameter | string;
  oldValue: number | boolean;
  newValue: number | boolean;
  cause: 'natural' | 'device_effect' | 'physics_update';
  timestamp: Date;
}

/**
 * Effect type mapping from device effect to physics effect type
 */
const EFFECT_TYPE_MAP: Record<string, PhysicalEffectType> = {
  heating: PhysicalEffectType.HEATING,
  cooling: PhysicalEffectType.COOLING,
  humidity: PhysicalEffectType.HUMIDITY,
  light: PhysicalEffectType.LIGHT,
  motion: PhysicalEffectType.MOTION,
  set: PhysicalEffectType.SET,
  pollutant: PhysicalEffectType.POLLUTANT,
  air_flow: PhysicalEffectType.AIR_FLOW,
};

/**
 * Physics Layer Class
 *
 * Coordinates between:
 * - Devices (which trigger effects)
 * - SpatialPropagationEngine (which calculates spatial propagation)
 * - PhysicalEnvironment (which stores physical state)
 */
export class PhysicsLayer {
  private timeManager: TimeManager;
  private physicalEnvironment: PhysicalEnvironment;
  private heatTransferModel: HeatTransferModel;
  private stateInterpolator: StateInterpolator;
  private spatialManager: SpatialManager;

  // Pure physics engine - handles spatial propagation
  private propagationEngine: SpatialPropagationEngine;

  // Persistent per-(parameter, location) field state. The field is the
  // source of truth for WHERE physical values live; the global value
  // models in PhysicalEnvironment only serve as fallback + relaxation
  // attractors. The field knows nothing about device semantics.
  private readonly field: SpatialField;
  private readonly fieldAttractor: FieldAttractor;
  /** Fix-50a: real thermodynamic humidity (Tetens formula RH↔AH chain). */
  private readonly humidityModel = new HumidityModel();
  /** NFR-1: ASHRAE 55 thermal comfort (PMV/PPD per zone). */
  private readonly comfortModel = new ThermalComfortModel();
  /**
   * T-707 (F-PH08): fresh-air ventilation while an air handler runs.
   * HVAC/exhaust airflow adds an air-changes-per-hour term to the zone CO2
   * field: exponential decay toward outdoor ppm, wired through
   * AirQualityModel.applyVentilation (pre-fix dead code; the observed
   * "ventilation" was a single-step flush that settled below baseline).
   * 2.0 ACH supply + the model's 0.1 ACH infiltration → 646 ppm crosses
   * below 500 after ~22 one-minute samples (was 1 step), floor 420.
   *
   * While a zone is ventilated, its CO2 attractor override is set to
   * outdoor ppm (the default baseline/global relaxation for that entry is
   * skipped — air exchange is not double-counted); the override clears the
   * first tick the handler stops, resuming occupancy accumulation.
   */
  private readonly ventilationModel = new AirQualityModel({ defaultVentilationRate: 2.0 });
  /** Zones with an active CO2 attractor override (ventilation). */
  private readonly ventilationAttractorZones = new Set<string>();
  /** Zones ventilated on the CURRENT updatePhysics pass. */
  private currentPassVentilatedZones = new Set<string>();
  /** Zones with an active light attractor override (a luminaire is driving them, BUG-09). */
  private readonly lightAttractorZones = new Set<string>();
  /** Zones light-driven on the CURRENT updatePhysics pass. */
  private currentPassLightZones = new Set<string>();

  // Device effect tracking (for device-to-physics translation)
  private deviceEffects: Map<string, DevicePhysicsEffect[]>;
  private stateChangeListeners: Set<(event: StateChangeEvent) => void>;

  private config: Required<PhysicsLayerConfig>;
  private isRunning: boolean = false;
  private updateInterval?: NodeJS.Timeout;
  private lastUpdateTime: Date;

  // Tracking maps for various parameters per location
  private locationTemperatures: Map<string, number>;
  private locationHumidity: Map<string, number>;
  private locationLight: Map<string, number>;
  private locationMotion: Map<string, boolean>;
  /**
   * Per-location thermal mass (J/K) derived from zone volume (RC-5). A
   * location without an entry uses the HeatTransferModel's global default.
   */
  private readonly locationThermalMass = new Map<string, number>();
  private eventManager?: any;

  constructor(
    timeManager: TimeManager,
    physicalEnvironment: PhysicalEnvironment,
    config: PhysicsLayerConfig = {},
    eventManager?: any
  ) {
    this.timeManager = timeManager;
    this.physicalEnvironment = physicalEnvironment;
    this.deviceEffects = new Map();
    this.stateChangeListeners = new Set();
    this.locationTemperatures = new Map();
    this.locationHumidity = new Map();
    this.locationLight = new Map();
    this.locationMotion = new Map();
    this.lastUpdateTime = new Date();
    this.eventManager = eventManager;

    this.config = {
      enableFullPhysics: config.enableFullPhysics ?? true,
      updateInterval: config.updateInterval ?? 1000,
      spatialResolution: config.spatialResolution ?? 1.0,
      heatTransferConfig: config.heatTransferConfig || {},
      interpolationConfig: config.interpolationConfig || {},
      spatialManager: config.spatialManager ?? new SpatialManager(),
    };

    // Initialize components
    this.heatTransferModel = new HeatTransferModel(this.config.heatTransferConfig);
    this.stateInterpolator = new StateInterpolator(this.config.interpolationConfig);
    this.spatialManager = this.config.spatialManager;

    // Initialize pure physics engine
    this.propagationEngine = new SpatialPropagationEngine();

    // Initialize the spatial field. The relaxation attractor for a location
    // without a seeded baseline is the global value model's current value
    // (read WITHOUT physics to avoid recursion).
    this.field = new SpatialField();
    this.fieldAttractor = (parameter, locationKey) => {
      const value = this.physicalEnvironment.getParameterValueWithoutPhysics(parameter, locationKey);
      if (typeof value === 'number') return value;
      if (typeof value === 'boolean') return value ? 1 : 0;
      return undefined;
    };

    logger.info('Initialized as coordinator:', {
      fullPhysics: this.config.enableFullPhysics,
      updateInterval: `${this.config.updateInterval}ms`,
      spatialResolution: `${this.config.spatialResolution}m`,
      architecture: 'device → PhysicsLayer → SpatialPropagationEngine → environment',
    });
  }

  /**
   * Start physics simulation
   */
  startPhysicsSimulation(): void {
    if (this.isRunning) {
      logger.warn('Physics simulation already running');
      return;
    }

    this.isRunning = true;
    this.lastUpdateTime = this.timeManager.getCurrentTime();

    logger.info('Starting physics simulation...');

    this.updateInterval = setInterval(() => {
      this.updatePhysics();
    }, this.config.updateInterval);

    logger.info('Physics simulation started');
  }

  /**
   * Stop physics simulation
   */
  stopPhysicsSimulation(): void {
    if (!this.isRunning) {
      logger.warn('Physics simulation not running');
      return;
    }

    this.isRunning = false;

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }

    logger.info('Physics simulation stopped');
  }

  /**
   * Update physics simulation
   */
  updatePhysics(customDeltaTime?: number): PhysicsUpdateResult {
    if (!this.isRunning && customDeltaTime === undefined) {
      logger.warn('Physics simulation not running, update skipped');
      return {
        deltaTime: 0,
        updatesApplied: 0,
        deviceEffectsProcessed: 0,
        interpolationUpdates: 0,
      };
    }

    const currentTime = this.timeManager.getCurrentTime();
    let deltaTime = customDeltaTime || (currentTime.getTime() - this.lastUpdateTime.getTime()) / 1000;

    if (deltaTime <= 0) {
      deltaTime = 0.001;
    }

    this.lastUpdateTime = currentTime;

    logger.debug(`Updating physics (dt = ${deltaTime.toFixed(3)}s)`);

    let updatesApplied = 0;
    let deviceEffectsProcessed = 0;
    let interpolationUpdates = 0;

    // T-707: per-pass ventilation bookkeeping (attractor overrides).
    this.currentPassVentilatedZones = new Set();
    // BUG-09: per-pass light-drive bookkeeping (attractor overrides).
    this.currentPassLightZones = new Set();

    // Step 1: Translate device effects to physics effect sources
    this.syncDeviceEffectsToPropagationEngine();

    // Step 2: Apply spatial effects using the propagation engine
    if (this.propagationEngine.getRegistry().getActiveSources().length > 0) {
      const effectResult = this.applySpatialEffects(deltaTime);
      deviceEffectsProcessed = effectResult.effectsProcessed;
      updatesApplied += effectResult.updatesApplied;
    }

    // Step 2b: Field dynamics. After effects have been integrated into the
    // field, nearby locations exchange value (diffusion), every location
    // relaxes toward its environmental baseline, and values are clamped to
    // physically possible ranges (safety net — not device control).
    if (this.field.size > 0) {
      this.syncFieldLocations();
      this.field.step(deltaTime, this.fieldAttractor);
    }

    // Step 2c (T-707): zones whose ventilation stopped this pass lose the
    // CO2 attractor override — default relaxation toward baseline/global
    // resumes (occupancy accumulation climbs again, F-PH07).
    for (const zone of this.ventilationAttractorZones) {
      if (!this.currentPassVentilatedZones.has(zone)) {
        this.field.setAttractorOverride(PhysicalParameter.CO2, zone, undefined);
        this.ventilationAttractorZones.delete(zone);
      }
    }

    // Step 2d (BUG-09): zones no longer light-driven this pass (lamp turned
    // off / effect unregistered) lose the light attractor override — the
    // field relaxes back to the ambient baseline at the light rate.
    for (const zone of this.lightAttractorZones) {
      if (!this.currentPassLightZones.has(zone)) {
        this.field.setAttractorOverride(PhysicalParameter.LIGHT, zone, undefined);
        this.lightAttractorZones.delete(zone);
      }
    }

    // Step 2e (FEAT-02): couple the T-709 device power ledger into the zone
    // field — a zone with ANY device power report reads `power` as the sum
    // of its devices' draws, so switching loads off visibly drops the zone
    // power (was: the ledger only fed meter state; the field/global model
    // kept reading a static 500 W no matter what ran). Design choice (of
    // the two options considered — write the ledger into the field per tick
    // vs. make every snapshot read prefer the meter sum): the field write
    // keeps ALL read faces (snapshot / flow conditions / agent observations)
    // on the one existing read path with zero call-site changes. Written
    // AFTER field.step so the value a reader sees between ticks is exactly
    // the ledger sum; the next pass's relaxation toward the global model is
    // overwritten again before anyone can read it. Zones with no reports
    // keep their baseline/global-model power.
    for (const [location, watts] of this.zonePowerSums) {
      this.field.set(PhysicalParameter.POWER, location, watts);
    }

    // Step 2f (FEAT-03 stage 2): scenario-declared device couplings
    // (`parameterEffects`) — an active device with the declared capability
    // drains/feeds its zone's CUSTOM parameter at magnitude units/second.
    // dt-normalized (BUG-09 discipline: rate × dt, never rate per tick);
    // applied AFTER field.step (same posture as the Step-2e power write) so
    // the reader sees the exact post-drive value between ticks. Entries that
    // don't exist yet (never seeded, never injected) are skipped — a drain
    // cannot invent value, and the coupling targets only zones where the
    // parameter actually lives. Clamped through the same safety net as every
    // other field write.
    for (const effects of this.deviceEffects.values()) {
      for (const effect of effects) {
        if (effect.effect !== 'parameter_rate' || effect.enabled === false) continue;
        const key = String(effect.parameter);
        const location = effect.affectedArea.location;
        const current = this.field.get(key, location) ?? this.field.getBaseline(key, location);
        if (current === undefined) continue;
        this.field.set(key, location, clampFieldValue(key, current + effect.magnitude * deltaTime));
        updatesApplied++;
      }
    }

    // Step 3: Update interpolator
    if (this.config.enableFullPhysics) {
      interpolationUpdates += this.updateInterpolator();
    }

    const result: PhysicsUpdateResult = {
      deltaTime,
      updatesApplied,
      deviceEffectsProcessed,
      interpolationUpdates,
    };

    logger.debug('Physics update complete:', result);
    return result;
  }

  /**
   * Sync device effects to the propagation engine
   *
   * This translates device-specific effects to abstract effect sources
   * that the physics engine can process.
   */
  private syncDeviceEffectsToPropagationEngine(): void {
    const registry = this.propagationEngine.getRegistry();

    // Clear and rebuild effect sources from device effects
    registry.clear();

    for (const effects of this.deviceEffects.values()) {
      for (const deviceEffect of effects) {
        if (!deviceEffect.enabled) continue;
        // FEAT-03: parameter_rate couplings apply straight onto the field in
        // updatePhysics (Step 2f) — they are not propagation sources.
        if (deviceEffect.effect === 'parameter_rate') continue;

        // Translate DevicePhysicsEffect to EffectSource
        const effectSource = this.translateDeviceEffectToSource(deviceEffect);
        if (effectSource) {
          registry.register(effectSource);
        }
      }
    }

    // T-105 (F-PH05): solar gain for glass zones — a virtual heating source
    // per zone with a declared solar aperture, magnitude re-derived every
    // pass from the CURRENT solar radiation (daily cycle), so a glass
    // atrium is warm in the afternoon sun and inert at night. Registered
    // AFTER the device sources (same registry, distinct id namespace).
    this.syncSolarGainSources(registry);
  }

  /** T-105: g-value (solar heat gain coefficient) of typical glazing. */
  private static readonly SOLAR_GAIN_G_VALUE = 0.45;

  /**
   * T-105 (F-PH05): register one heating source per glass zone. The solar
   * radiation is read WITHOUT physics (the global daily-cycle model — the
   * value weather reports); the zone's own field position carries the
   * source. Zero radiation (night) registers nothing.
   */
  private syncSolarGainSources(registry: {
    register: (source: EffectSource) => void;
  }): void {
    for (const { locationKey, glassAreaM2 } of this.field.glassZones()) {
      const position = this.resolveLocationPosition(locationKey) ?? { x: 0, y: 0 };
      const solarWPerM2 = this.readSolarRadiationAt(locationKey, position);
      if (!(solarWPerM2 > 0)) continue;
      const magnitudeW = solarWPerM2 * glassAreaM2 * PhysicsLayer.SOLAR_GAIN_G_VALUE;
      if (!(magnitudeW > 0.1)) continue;
      registry.register({
        id: `solar-gain:${locationKey}`,
        type: PhysicalEffectType.HEATING,
        magnitude: magnitudeW,
        position,
        // Small positive radius: falloff(distance=0, radius=0) is 0 by
        // definition (distance >= radius), so a zero-radius source would
        // transmit nothing. 2 m keeps the source inside its own zone.
        radius: 2,
        falloff: 'linear',
        active: true,
        metadata: {
          virtual: 'solar-gain',
          locationKey,
          glassAreaM2,
          solarWPerM2,
        },
      });
    }
  }

  /**
   * T-105: the current solar radiation for a zone — the environment's
   * global daily-cycle model value at the zone's location (read without
   * physics: this is an INPUT, not a simulated state).
   */
  private readSolarRadiationAt(locationKey: string, position: FieldPosition): number {
    try {
      const value = this.physicalEnvironment.getParameterValueWithoutPhysics(
        PhysicalParameter.SOLAR_RADIATION,
        this.spatialManager.getLocationByPath(locationKey)?.id ?? locationKey,
      );
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      void position;
      return 0;
    } catch {
      return 0;
    }
  }

  /**
   * Translate a device effect to an abstract effect source
   *
   * This is the key translation layer between devices and physics.
   */
  private translateDeviceEffectToSource(effect: DevicePhysicsEffect): EffectSource | null {
    const effectType = EFFECT_TYPE_MAP[effect.effect];
    if (!effectType) {
      logger.warn(`Unknown effect type: ${effect.effect}`);
      return null;
    }

    // Get device position: the spatial manager's registered placement is
    // authoritative (the runtime places devices at zone centers); the
    // effect's own position is a fallback (devices parsing "x,y" location
    // strings), then the origin.
    const devicePos = this.spatialManager.getDevicePosition(effect.deviceId);
    const position = devicePos?.position || effect.affectedArea.position || { x: 0, y: 0 };

    // Map falloff type
    const falloffMap: Record<string, PhysicalFalloffType> = {
      linear: 'linear',
      'inverse-square': 'inverse-square',
      exponential: 'exponential',
    };

    return {
      id: `${effect.deviceId}-${effect.parameter}`,
      type: effectType,
      magnitude: effect.magnitude,
      position,
      radius: effect.affectedArea.radius,
      falloff: falloffMap[effect.falloff || 'linear'] || 'linear',
      active: effect.enabled ?? true,
      metadata: {
        deviceId: effect.deviceId,
        parameter: effect.parameter,
        originalEffect: effect.effect,
      },
    };
  }

  /**
   * Apply spatial effects using the propagation engine
   *
   * This method:
   * 1. Gets all spatial locations
   * 2. Calculates effect magnitudes at each location using the propagation engine
   * 3. Applies physics calculations (heat transfer, etc.)
   * 4. Updates the physical environment
   */
  private applySpatialEffects(deltaTime: number): {
    effectsProcessed: number;
    updatesApplied: number;
  } {
    const activeSources = this.propagationEngine.getRegistry().getActiveSources();
    let effectsProcessed = activeSources.length;
    let updatesApplied = 0;

    logger.debug(`Applying ${effectsProcessed} effect sources with spatial propagation...`);

    // Get all spatial locations (filter out locations without positions)
    const spatialLocations = this.spatialManager.listLocations();
    const propagationLocations: PropagationLocation[] = spatialLocations
      .filter(loc => loc.position !== undefined)
      .map(loc => ({
        id: loc.path,
        position: loc.position!,
      }));
    const locationById = new Map<string, PropagationLocation>();
    for (const loc of propagationLocations) {
      // First occurrence wins — mirrors the find() semantics replaced below.
      if (!locationById.has(loc.id)) locationById.set(loc.id, loc);
    }

    // Add locations from device effects that might not be in spatial manager
    // (R44-insane: Map lookup instead of an O(locations) find per effect —
    // the dedupe scan used to be O(effects × locations) per tick).
    for (const effects of this.deviceEffects.values()) {
      for (const effect of effects) {
        if (!effect.enabled) continue;
        if (locationById.has(effect.affectedArea.location)) continue;
        const added: PropagationLocation = {
          id: effect.affectedArea.location,
          position: effect.affectedArea.position || { x: 0, y: 0 },
        };
        propagationLocations.push(added);
        locationById.set(added.id, added);
      }
    }

    // Calculate effects at each location using the propagation engine.
    // B-A floor rule: a direct device effect only reaches locations on its
    // OWN floor — spillover never crosses a slab (cross-floor exchange is
    // the field's job, via declared shaft zones). Sources/locations without
    // floor metadata keep the legacy distance-only behavior.
    const sourceFloorById = new Map<string, number>();
    for (const effects of this.deviceEffects.values()) {
      for (const effect of effects) {
        const floor = this.field.floorOf(effect.affectedArea.location);
        if (floor !== undefined) {
          sourceFloorById.set(`${effect.deviceId}-${effect.parameter}`, floor);
        }
      }
    }

    // R44-insane §11.6: the applicable-source set and the CO2/PM2.5 split
    // depend ONLY on the location's floor, yet they used to be re-derived
    // per location with three filter passes over ALL sources
    // (O(locations × sources), plus an O(sources × co2Sources) includes()
    // inside one of them). Cache one {co2, other} partition per distinct
    // floor (and one for floorless locations, which see every source).
    // Array contents and ORDER are identical to the per-location filters —
    // filter() preserves activeSources order, and so does this single pass —
    // so every downstream float sum is bit-identical.
    const sourceGroupsByFloor = new Map<number, { co2: EffectSource[]; other: EffectSource[] }>();
    let allSourcesGroup: { co2: EffectSource[]; other: EffectSource[] } | undefined;
    const groupForFloor = (floor: number): { co2: EffectSource[]; other: EffectSource[] } => {
      let group = sourceGroupsByFloor.get(floor);
      if (group === undefined) {
        group = { co2: [], other: [] };
        for (const source of activeSources) {
          const sourceFloor = sourceFloorById.get(source.id);
          if (sourceFloor !== undefined && sourceFloor !== floor) continue;
          if (source.type === PhysicalEffectType.POLLUTANT &&
              source.metadata?.parameter === PhysicalParameter.CO2) {
            group.co2.push(source);
          } else {
            group.other.push(source);
          }
        }
        sourceGroupsByFloor.set(floor, group);
      }
      return group;
    };
    const groupForAllSources = (): { co2: EffectSource[]; other: EffectSource[] } => {
      if (allSourcesGroup === undefined) {
        allSourcesGroup = { co2: [], other: [] };
        for (const source of activeSources) {
          if (source.type === PhysicalEffectType.POLLUTANT &&
              source.metadata?.parameter === PhysicalParameter.CO2) {
            allSourcesGroup.co2.push(source);
          } else {
            allSourcesGroup.other.push(source);
          }
        }
      }
      return allSourcesGroup;
    };

    for (const location of propagationLocations) {
      const locationFloor = this.field.floorOf(location.id);
      // B-B: pollutant sources carrying a specific target parameter in their
      // metadata (e.g. occupancy CO2 emission) are split out of the generic
      // PM2.5 path and applied to their own parameter instead.
      const group = locationFloor === undefined ? groupForAllSources() : groupForFloor(locationFloor);
      const co2Sources = group.co2;
      const pm25Sources = group.other;
      const effectsAtLocation = this.propagationEngine.calculateEffectAtLocation(location, pm25Sources);

      if (co2Sources.length > 0) {
        const co2Effects = this.propagationEngine.calculateEffectAtLocation(location, co2Sources);
        const co2Rate = co2Effects.get(PhysicalEffectType.POLLUTANT) ?? 0;
        if (Math.abs(co2Rate) > 1e-9 && this.config.enableFullPhysics) {
          const result = this.applyCo2EmissionEffect(location.id, co2Rate, deltaTime);
          if (result) updatesApplied++;
        }
      }

      if (effectsAtLocation.size === 0) continue;

      // Process thermal effects (heating/cooling)
      const heatingPower = effectsAtLocation.get(PhysicalEffectType.HEATING) ?? 0;
      const coolingPower = effectsAtLocation.get(PhysicalEffectType.COOLING) ?? 0;
      const totalThermalPower = heatingPower - Math.abs(coolingPower);

      if (Math.abs(totalThermalPower) > 0.1 && this.config.enableFullPhysics) {
        const result = this.applyThermalEffect(location.id, totalThermalPower, deltaTime);
        if (result) updatesApplied++;
        // T-707: a running air handler supplies fresh air — the zone's CO2
        // decays exponentially toward outdoor ppm (gradual, not a step).
        if (this.applyCo2Ventilation(location.id, deltaTime)) updatesApplied++;
        // T-104 (F-PH10): net COOLING with a running coil also drains
        // moisture — condensate mass proportional to the cooling delivered
        // (latent share of the load), removed from the zone's absolute
        // humidity so RH genuinely DROPS instead of only re-computing with
        // the new temperature.
        if (totalThermalPower < -0.1 && Math.abs(coolingPower) > 0.1) {
          if (this.applyCoilDehumidification(location.id, Math.abs(coolingPower), deltaTime)) {
            updatesApplied++;
          }
        }
      }

      // Process light effects
      const lightMagnitude = effectsAtLocation.get(PhysicalEffectType.LIGHT) ?? 0;
      if (Math.abs(lightMagnitude) > 0.1 && this.config.enableFullPhysics) {
        const result = this.applyLightEffect(location.id, lightMagnitude, deltaTime);
        if (result) updatesApplied++;
      }

      // Process humidity effects
      const humidityMagnitude = effectsAtLocation.get(PhysicalEffectType.HUMIDITY) ?? 0;
      if (Math.abs(humidityMagnitude) > 0.1 && this.config.enableFullPhysics) {
        const result = this.applyHumidityEffect(location.id, humidityMagnitude, deltaTime);
        if (result) updatesApplied++;
      }

      // Process pollutant effects (air purifiers reducing PM2.5/VOC)
      const pollutantMagnitude = effectsAtLocation.get(PhysicalEffectType.POLLUTANT) ?? 0;
      if (Math.abs(pollutantMagnitude) > 0.01 && this.config.enableFullPhysics) {
        const result = this.applyPollutantEffect(location.id, pollutantMagnitude, deltaTime);
        if (result) updatesApplied++;
      }
    }

    // Process SET effects directly (not through propagation engine)
    // SET effects set absolute values and don't propagate like heating/cooling
    // (R44-insane: Map lookup instead of an O(locations) find per effect.)
    for (const effects of this.deviceEffects.values()) {
      for (const effect of effects) {
        if (!effect.enabled) continue;

        // R101: air_flow (the ventilation command) applies by ZONE ID
        // directly — no propagation geometry required, so bounds-less
        // zones ventilate too (the simtest building declares no zone
        // bounds; the geometry path would have silently lost the effect).
        // This is the single application path for air_flow — the effect
        // type has no other producer and must not also aggregate above.
        if (effect.effect === 'air_flow') {
          if (this.config.enableFullPhysics) {
            const zoneId = effect.affectedArea.location;
            const magnitude = typeof effect.magnitude === 'number' ? effect.magnitude : 0;
            // Air flow reduces humidity similar to a dehumidifier but milder.
            if (Math.abs(magnitude) > 0.01 && this.applyHumidityEffect(zoneId, magnitude, deltaTime)) updatesApplied++;
            // T-707: the airflow also exchanges air — CO2 toward outdoor.
            if (this.applyCo2Ventilation(zoneId, deltaTime)) updatesApplied++;
            // R102 (chen-18): the exchange also clears airborne SMOKE — the
            // emergency story's whole point (a fresh-air unit must visibly
            // accelerate smoke removal, not only CO2/humidity). Without
            // this, the smoke parameter decayed only at its natural
            // relaxation rate no matter how many units ran.
            if (this.applySmokeVentilation(zoneId, Math.abs(magnitude), deltaTime)) updatesApplied++;
          }
          continue;
        }

        if (effect.effect !== 'set') continue;

        // Find matching location in propagationLocations
        const targetLocation = locationById.get(effect.affectedArea.location);
        if (targetLocation) {
          const result = this.applySetEffect(targetLocation.id, effect.parameter, effect.magnitude);
          if (result) updatesApplied++;
        }
      }
    }

    return { effectsProcessed, updatesApplied };
  }

  /**
   * T-104 (F-PH10): active dehumidification at a zone with a running
   * cooling coil. Computes the condensate mass (HumidityModel physics),
   * removes it from the zone's absolute moisture, and writes the resulting
   * RH into the field — same write path as applyHumidityEffect so
   * interpolator/state-change seams observe it.
   */
  private applyCoilDehumidification(
    locationId: string,
    coolingPowerW: number,
    deltaTime: number,
  ): boolean {
    const currentHumidity =
      this.field.get(PhysicalParameter.HUMIDITY, locationId) ??
      this.locationHumidity.get(locationId) ??
      (this.physicalEnvironment.getParameterValueWithoutPhysics(PhysicalParameter.HUMIDITY, locationId) as number);
    if (typeof currentHumidity !== 'number') return false;

    // Post-cooling air temperature (applyThermalEffect already wrote it).
    const airTemp =
      this.field.get(PhysicalParameter.TEMPERATURE, locationId) ??
      this.locationTemperatures.get(locationId) ??
      22;

    // Zone volume from the registered thermal mass (ρ·c = 1206 J/m³·K);
    // zones without mass metadata get no condensate model (no volume to
    // spread the mass over — same gate as the mass-scaled envelope).
    const zoneMass = this.locationThermalMass.get(locationId);
    if (zoneMass === undefined) return false;
    const zoneVolumeM3 = zoneMass / (1.2 * 1005);

    const { condensateG, newRelativeHumidity } = this.humidityModel.calculateCoilCondensate({
      coolingPowerW,
      deltaTimeSec: deltaTime,
      airTempC: airTemp,
      relativeHumidity: currentHumidity,
      zoneVolumeM3,
    });
    if (condensateG <= 0 || Math.abs(newRelativeHumidity - currentHumidity) < 1e-6) {
      return false;
    }

    this.locationHumidity.set(locationId, newRelativeHumidity);
    this.field.set(PhysicalParameter.HUMIDITY, locationId, newRelativeHumidity, this.resolveLocationPosition(locationId));
    this.stateInterpolator.recordState(
      locationId,
      PhysicalParameter.HUMIDITY,
      newRelativeHumidity,
      this.timeManager.getCurrentTime(),
    );
    this.emitStateChange({
      location: locationId,
      parameter: PhysicalParameter.HUMIDITY,
      oldValue: currentHumidity,
      newValue: newRelativeHumidity,
      cause: 'device_effect',
      timestamp: this.timeManager.getCurrentTime(),
    });
    logger.debug(`Coil dehumidification at ${locationId}:`, {
      coolingPowerW: coolingPowerW.toFixed(0),
      condensateG: condensateG.toFixed(3),
      rh: `${currentHumidity.toFixed(1)}% → ${newRelativeHumidity.toFixed(1)}%`,
    });
    return true;
  }

  /**
   * Apply thermal effect at a location
   */
  private applyThermalEffect(
    locationId: string,
    power: number,
    deltaTime: number
  ): boolean {
    const currentTemp =
      this.field.get(PhysicalParameter.TEMPERATURE, locationId) ??
      this.locationTemperatures.get(locationId) ??
      (this.physicalEnvironment.getParameterValueWithoutPhysics(PhysicalParameter.TEMPERATURE, locationId) as number);

    const ambientTemp = this.physicalEnvironment.getParameterValueWithoutPhysics(
      PhysicalParameter.TEMPERATURE,
      'outside'
    ) as number;

    // T-701: zones with a per-zone thermal mass (volumeM3 registered) get
    // ALL of their ambient exchange from the spatial field's U·A model
    // (envelope coupling + mass-scaled relaxation). The HeatTransferModel's
    // built-in Newtonian leak toward 'outside' was a legacy global-envelope
    // approximation — kept for unregistered zones, disabled here so the
    // envelope is not double-counted against the HVAC drive.
    const zoneMass = this.locationThermalMass.get(locationId);
    const result = this.heatTransferModel.calculateHeatTransfer(
      currentTemp,
      ambientTemp,
      power,
      deltaTime,
      zoneMass !== undefined ? 0 : undefined,
      zoneMass,
    );

    this.locationTemperatures.set(locationId, result.finalTemperature);

    // CRITICAL: write the updated temperature into the SPATIAL FIELD at this
    // location — never the global value model, which would destroy spatiality.
    this.field.set(
      PhysicalParameter.TEMPERATURE,
      locationId,
      result.finalTemperature,
      this.resolveLocationPosition(locationId),
    );

    this.stateInterpolator.recordState(
      locationId,
      PhysicalParameter.TEMPERATURE,
      result.finalTemperature,
      this.timeManager.getCurrentTime()
    );

    this.emitStateChange({
      location: locationId,
      parameter: PhysicalParameter.TEMPERATURE,
      oldValue: currentTemp,
      newValue: result.finalTemperature,
      cause: 'device_effect',
      timestamp: this.timeManager.getCurrentTime(),
    });

    logger.debug(`Thermal effect at ${locationId}:`, {
      power: `${power.toFixed(1)}W`,
      tempChange: `${result.temperatureChange.toFixed(4)}°C`,
      newTemp: `${result.finalTemperature.toFixed(2)}°C`,
    });

    return true;
  }

  /**
   * Apply light effect at a location (BUG-09: dt-normalized drive).
   *
   * The incoming magnitude is the luminaires' STEADY-STATE illuminance
   * contribution in lux at this location (the falloff-attenuated sum over
   * sources; producers map device brightness (0-100) to lux via
   * brightnessToLuxContribution). Pre-fix the raw magnitude was added on
   * EVERY pass with no deltaTime (`currentLight + magnitude`), so with the
   * field relaxing light at 0.1/s the equilibrium scaled with 1/dt and
   * readings drifted with the engine tick rate / LOD substep.
   *
   * Post-fix the running luminaire REDEFINES the zone's light attractor to
   * baseline + contribution and the value approaches it exactly:
   *
   *   v ← target + (v − target)·e^(−k·dt)
   *
   * with k the field's light relaxation rate (read from the field so
   * instance rate overrides stay consistent). The attractor override
   * suspends the field's own relaxation for the entry (T-707 pattern — no
   * double-count), so the fixed point is EXACTLY baseline + contribution
   * for any dt, including coarse idle-LOD substeps where an additive
   * rate×dt drive would leak an O(k·dt) splitting error (at k=0.1/s and
   * the 10 s idle stride the additive form's equilibrium collapses back to
   * baseline — the lamp would do nothing while idle). When the last
   * luminaire effect leaves, updatePhysics clears the override and the
   * zone relaxes back to its ambient baseline at the same rate.
   *
   * Zones with NO light relax target at all (no seeded baseline and no
   * model value) degrade to an additive contribution·k·dt drive — the
   * pre-fix unbounded-growth shape, now dt-scaled.
   */
  private applyLightEffect(locationId: string, luxContribution: number, deltaTime: number): boolean {
    const currentLight =
      this.field.get(PhysicalParameter.LIGHT, locationId) ??
      this.locationLight.get(locationId) ??
      (this.physicalEnvironment.getParameterValueWithoutPhysics(PhysicalParameter.LIGHT, locationId) as number);

    const dt = Math.max(0, deltaTime);
    const k = this.field.getRelaxationRate(PhysicalParameter.LIGHT);
    const baseline =
      this.field.getBaseline(PhysicalParameter.LIGHT, locationId) ??
      this.fieldAttractor(PhysicalParameter.LIGHT, locationId);

    let newLight: number;
    if (baseline === undefined) {
      // No relax target for this entry — additive degradation (see header).
      newLight = Math.max(0, currentLight + luxContribution * k * dt);
    } else {
      const target = baseline + luxContribution;
      // While driven, the zone's light attractor IS baseline + contribution
      // (the default relaxation for this entry is suspended) — set even
      // when no approach is needed, so an already-lit zone stays pinned
      // while the lamp runs.
      this.field.setAttractorOverride(PhysicalParameter.LIGHT, locationId, target);
      this.lightAttractorZones.add(locationId);
      this.currentPassLightZones.add(locationId);
      newLight = Math.max(0, target + (currentLight - target) * Math.exp(-k * dt));
    }

    this.locationLight.set(locationId, newLight);

    // Write back to the spatial field (location-scoped, not global)
    this.field.set(PhysicalParameter.LIGHT, locationId, newLight, this.resolveLocationPosition(locationId));

    this.stateInterpolator.recordState(
      locationId,
      PhysicalParameter.LIGHT,
      newLight,
      this.timeManager.getCurrentTime()
    );

    this.emitStateChange({
      location: locationId,
      parameter: PhysicalParameter.LIGHT,
      oldValue: currentLight,
      newValue: newLight,
      cause: 'device_effect',
      timestamp: this.timeManager.getCurrentTime(),
    });

    return true;
  }

  /**
   * Apply humidity effect at a location (Fix-50a: real thermodynamics;
   * BUG-09: dt-normalized rate).
   *
   * The magnitude is a relative-humidity RATE in %RH/s (pre-fix it was a
   * %RH delta added on EVERY pass with no deltaTime, so the equilibrium
   * against the field's 0.003/s relaxation scaled with 1/dt and drifted
   * with the engine tick rate / LOD substep; at the observed dt=1 grid the
   * rate form is numerically identical to the old per-pass add). The
   * additive rate×dt form keeps an O(k·dt) splitting error against the
   * field's Euler relaxation — negligible at humidity's k=0.003/s even at
   * the 10 s idle-LOD stride (~3%), unlike light (k=0.1/s), which is why
   * the light path uses the exact attractor-override form instead.
   *
   * Fix-50a note: this used to be `currentHumidity + magnitude` clamped
   * 0-100 — a magic number that ignored temperature entirely. Real humidity
   * physics: when temperature changes, the SAME absolute moisture yields a
   * different relative humidity (warm air holds more water). The
   * HumidityModel's Tetens-formula conversion chain is wired in:
   *
   *   RH_old + rate·dt → AH (at T_old) → RH_new (at T_current)
   *
   * This means: HVAC cooling automatically drops RH (cold surface removes
   * moisture via condensation); heating drops RH (same moisture, warmer air
   * → lower saturation fraction); humidifiers/dehumidifiers change the
   * absolute moisture content directly.
   */
  private applyHumidityEffect(locationId: string, magnitude: number, deltaTime: number): boolean {
    const currentHumidity =
      this.field.get(PhysicalParameter.HUMIDITY, locationId) ??
      this.locationHumidity.get(locationId) ??
      (this.physicalEnvironment.getParameterValueWithoutPhysics(PhysicalParameter.HUMIDITY, locationId) as number);

    // Current temperature at this location (needed for the RH↔AH conversion)
    const currentTemp =
      this.field.get(PhysicalParameter.TEMPERATURE, locationId) ??
      (this.physicalEnvironment.getParameterValueWithoutPhysics(PhysicalParameter.TEMPERATURE, locationId) as number) ??
      22; // comfortable default when no field value exists yet

    // Fix-50a: use the HumidityModel for temperature-aware humidity changes.
    // BUG-09: the magnitude is a %RH/s RATE — scale the delta by dt, then
    // convert through absolute humidity so a temperature shift between the
    // previous read and now is accounted for.
    const dt = Math.max(0, deltaTime);
    let newHumidity: number;
    try {
      const absoluteNow = this.humidityModel.calculateAbsoluteHumidity(currentHumidity, currentTemp);
      // Apply the delta as an absolute moisture change: a +N %RH delta at
      // the current temperature corresponds to adding N% of the saturation
      // absolute humidity.
      const saturationAH = this.humidityModel.calculateAbsoluteHumidity(100, currentTemp);
      const absoluteDelta = ((magnitude * dt) / 100) * saturationAH;
      const absoluteNew = Math.max(0, absoluteNow + absoluteDelta);
      newHumidity = Math.max(0, Math.min(100,
        this.humidityModel.calculateRelativeHumidity(absoluteNew, currentTemp),
      ));
    } catch {
      // Fallback to the old behavior if the model faults (defensive)
      newHumidity = Math.max(0, Math.min(100, currentHumidity + magnitude * dt));
    }

    this.locationHumidity.set(locationId, newHumidity);

    // Write back to the spatial field (location-scoped, not global)
    this.field.set(PhysicalParameter.HUMIDITY, locationId, newHumidity, this.resolveLocationPosition(locationId));

    this.stateInterpolator.recordState(
      locationId,
      PhysicalParameter.HUMIDITY,
      newHumidity,
      this.timeManager.getCurrentTime()
    );

    this.emitStateChange({
      location: locationId,
      parameter: PhysicalParameter.HUMIDITY,
      oldValue: currentHumidity,
      newValue: newHumidity,
      cause: 'device_effect',
      timestamp: this.timeManager.getCurrentTime(),
    });

    return true;
  }

  /**
   * Apply pollutant effect at a location (Fix-50b: real first-order decay).
   *
   * Pre-fix this was `magnitude * 10` ("Scale up for visible effect") — a
   * linear hack with no physical basis. Real air purification follows
   * first-order exponential decay: the CLEAN AIR DELIVERY RATE (CADR, m³/h)
   * removes a fraction of pollutants per time step proportional to the
   * current concentration. The AirQualityModel's `calculateDecay` gives us
   * the physically correct fraction:
   *
   *   C_new = C_old × exp(-k × dt)
   *
   * where k = CADR / roomVolume. The magnitude from the device effect
   * (negative = removal) maps to a CADR fraction.
   */
  private applyPollutantEffect(locationId: string, magnitude: number, deltaTime: number): boolean {
    const currentPm25 =
      this.field.get(PhysicalParameter.PM25, locationId) ??
      (this.physicalEnvironment.getParameterValueWithoutPhysics(PhysicalParameter.PM25, locationId) as number);

    if (currentPm25 === undefined || currentPm25 === null) return false;

    // Fix-50b: exponential decay proportional to current concentration.
    // magnitude is negative (removal) from air purifiers. We interpret
    // |magnitude| as the fraction removed per second (e.g., 0.15 = 15%/s
    // for a strong purifier in a small room). R30 (LOD): the decay exponent
    // follows the pass deltaTime (was a hardcoded dt=1 — timestep-dependent
    // decay that under-decayed at the coarse idle substep; identical at the
    // observed dt=1 grid).
    const removalFractionPerSec = Math.min(0.5, Math.abs(magnitude));
    const dt = Math.max(0, deltaTime);
    let newPm25: number;
    if (magnitude < 0) {
      // Removal: C_new = C_old × exp(-k × dt) — proportional decay
      newPm25 = currentPm25 * Math.exp(-removalFractionPerSec * dt);
    } else {
      // Addition: linear (pollutant sources add, they don't multiply)
      newPm25 = currentPm25 + magnitude;
    }
    newPm25 = Math.max(0, newPm25);

    // Write back to the spatial field (location-scoped, not global)
    this.field.set(PhysicalParameter.PM25, locationId, newPm25, this.resolveLocationPosition(locationId));

    this.stateInterpolator.recordState(
      locationId,
      PhysicalParameter.PM25,
      newPm25,
      this.timeManager.getCurrentTime()
    );

    this.emitStateChange({
      location: locationId,
      parameter: PhysicalParameter.PM25,
      oldValue: currentPm25,
      newValue: newPm25,
      cause: 'device_effect',
      timestamp: this.timeManager.getCurrentTime(),
    });

    return true;
  }

  /**
   * Apply a CO2 emission effect at a location (B-B: occupancy respiration).
   * The magnitude is an emission RATE (ppm/s at the source, falloff-
   * attenuated), so the accumulated value scales with deltaTime — unlike
   * the legacy per-step PM2.5 pollutant path above.
   */
  private applyCo2EmissionEffect(locationId: string, rate: number, deltaTime: number): boolean {
    const currentCo2 =
      this.field.get(PhysicalParameter.CO2, locationId) ??
      (this.physicalEnvironment.getParameterValueWithoutPhysics(PhysicalParameter.CO2, locationId) as number);

    if (currentCo2 === undefined || currentCo2 === null) return false;

    const newCo2 = Math.max(0, currentCo2 + rate * deltaTime);

    // Write back to the spatial field (location-scoped, not global)
    this.field.set(PhysicalParameter.CO2, locationId, newCo2, this.resolveLocationPosition(locationId));

    this.stateInterpolator.recordState(
      locationId,
      PhysicalParameter.CO2,
      newCo2,
      this.timeManager.getCurrentTime(),
    );

    this.emitStateChange({
      location: locationId,
      parameter: PhysicalParameter.CO2,
      oldValue: currentCo2,
      newValue: newCo2,
      cause: 'device_effect',
      timestamp: this.timeManager.getCurrentTime(),
    });

    return true;
  }

  /**
   * R102 (chen-18): fresh-air exchange removes airborne SMOKE with the
   * same CADR-fraction mechanism as the pollutant path
   * (applyPollutantEffect) — exponential removal proportional to the
   * current concentration, clamped at zero. The air_flow effect's
   * |magnitude| maps to a removal fraction via
   * SMOKE_VENTILATION_EXTRACTION (a unit exchanging air at the stylized
   * smoke zone clears it visibly faster than the field's natural 0.01/s
   * relaxation — the assignment's acceptance is a significantly shorter
   * half-life, so the extraction must outpace the natural rate, which
   * the ACH-only formula used for CO2 cannot: 2.1 ACH ≈ 0.0006/s).
   */
  private applySmokeVentilation(locationId: string, magnitude: number, deltaTime: number): boolean {
    const currentSmoke =
      this.field.get(PhysicalParameter.SMOKE, locationId) ??
      (this.physicalEnvironment.getParameterValueWithoutPhysics(PhysicalParameter.SMOKE, locationId) as number);
    if (currentSmoke === undefined || currentSmoke === null || currentSmoke <= 0) return false;
    const removalFractionPerSec = Math.min(0.5, magnitude * SMOKE_VENTILATION_EXTRACTION);
    if (removalFractionPerSec <= 0) return false;
    const newSmoke = Math.max(0, currentSmoke * Math.exp(-removalFractionPerSec * Math.max(0, deltaTime)));
    this.field.set(PhysicalParameter.SMOKE, locationId, newSmoke, this.resolveLocationPosition(locationId));
    this.stateInterpolator.recordState(
      locationId,
      PhysicalParameter.SMOKE,
      newSmoke,
      this.timeManager.getCurrentTime(),
    );
    this.emitStateChange({
      location: locationId,
      parameter: PhysicalParameter.SMOKE,
      oldValue: currentSmoke,
      newValue: newSmoke,
      cause: 'device_effect',
      timestamp: this.timeManager.getCurrentTime(),
    });
    return true;
  }

  /**
   * T-707 (F-PH08): fresh-air ventilation — CO2 decays exponentially toward
   * outdoor ppm while an air handler / exhaust fan runs. Uses
   * AirQualityModel.applyVentilation on the EXCESS above outdoor so the
   * asymptote is outdoor (~420 ppm), never below it and never a step: each
   * tick multiplies the excess by e^(−ACH·dt) (ratio constant per sample).
   */
  private applyCo2Ventilation(locationId: string, deltaTime: number): boolean {
    const currentCo2 =
      this.field.get(PhysicalParameter.CO2, locationId) ??
      (this.physicalEnvironment.getParameterValueWithoutPhysics(PhysicalParameter.CO2, locationId) as number);
    if (currentCo2 === undefined || currentCo2 === null) return false;

    // While ventilated, the zone's CO2 attractor IS the outdoor air (the
    // default baseline/global relaxation for this entry is suspended) —
    // set even when no decay is needed, so an already-fresh zone stays
    // pinned while the handler runs.
    this.field.setAttractorOverride(PhysicalParameter.CO2, locationId, OUTDOOR_CO2_PPM);
    this.ventilationAttractorZones.add(locationId);
    this.currentPassVentilatedZones.add(locationId);

    if (currentCo2 <= OUTDOOR_CO2_PPM + 0.5) return false; // already fresh

    const excess = currentCo2 - OUTDOOR_CO2_PPM;
    const ventilatedExcess = this.ventilationModel.applyVentilation(
      excess, 'co2', 0, deltaTime,
    );
    const newCo2 = OUTDOOR_CO2_PPM + ventilatedExcess;

    this.field.set(PhysicalParameter.CO2, locationId, newCo2, this.resolveLocationPosition(locationId));
    this.stateInterpolator.recordState(
      locationId,
      PhysicalParameter.CO2,
      newCo2,
      this.timeManager.getCurrentTime(),
    );
    this.emitStateChange({
      location: locationId,
      parameter: PhysicalParameter.CO2,
      oldValue: currentCo2,
      newValue: newCo2,
      cause: 'device_effect',
      timestamp: this.timeManager.getCurrentTime(),
    });
    return true;
  }

  /**
   * Apply set effect at a location (sets absolute value)
   * Used for environment initialization and external simulation
   */
  private applySetEffect(locationId: string, parameter: PhysicalParameter | string, value: number): boolean {
    const oldValue = this.field.get(parameter, locationId) ??
      this.physicalEnvironment.getParameterValueWithoutPhysics(parameter, locationId) as number;

    // Set the absolute value in the spatial field (location-scoped, not global)
    this.field.set(parameter, locationId, value, this.resolveLocationPosition(locationId));

    // Update tracking maps
    if (parameter === 'temperature') {
      this.locationTemperatures.set(locationId, value);
    } else if (parameter === 'humidity') {
      this.locationHumidity.set(locationId, value);
    } else if (parameter === 'light') {
      this.locationLight.set(locationId, value);
    }

    // Record in interpolator
    this.stateInterpolator.recordState(
      locationId,
      parameter,
      value,
      this.timeManager.getCurrentTime()
    );

    this.emitStateChange({
      location: locationId,
      parameter: parameter,
      oldValue,
      newValue: value,
      cause: 'device_effect',
      timestamp: this.timeManager.getCurrentTime(),
    });

    logger.info(`Set effect at ${locationId}: ${parameter} = ${value}`);

    return true;
  }

  /**
   * Register a device physics effect.
   * An existing effect for the same (deviceId, parameter) is REPLACED, so
   * repeated commands (e.g. set-temperature 25 → set-temperature 28) never
   * stack duplicate effects.
   */
  registerDeviceEffect(effect: DevicePhysicsEffect): void {
    const deviceId = effect.deviceId;

    if (!this.deviceEffects.has(deviceId)) {
      this.deviceEffects.set(deviceId, []);
    }

    const effects = this.deviceEffects.get(deviceId)!;
    const entry = { ...effect, enabled: effect.enabled ?? true };
    const existingIndex = effects.findIndex(e => e.parameter === effect.parameter);
    if (existingIndex >= 0) {
      // T-106: a re-registration preserves the device's published
      // thermostat intent when the caller did not carry it (the intent is
      // layer-shared state refreshed by the device's control tick).
      if (entry.thermostat === undefined && effects[existingIndex]!.thermostat !== undefined) {
        entry.thermostat = effects[existingIndex]!.thermostat;
      }
      // R44-insane: keep the zone index in step with the final thermostat
      // state (index membership tracks PUBLISHED intents; dropFromHvacIndex
      // is a no-op for non-members, and indexTemperatureEffect dedupes).
      if (effect.parameter === PhysicalParameter.TEMPERATURE) {
        const oldLoc = effects[existingIndex]!.affectedArea.location;
        if (entry.thermostat !== undefined) {
          this.indexTemperatureEffect(deviceId, oldLoc, entry.affectedArea.location);
        } else {
          this.dropFromHvacIndex(oldLoc, deviceId);
        }
      }
      effects[existingIndex] = entry;
    } else {
      effects.push(entry);
      if (effect.parameter === PhysicalParameter.TEMPERATURE && entry.thermostat !== undefined) {
        this.indexTemperatureEffect(deviceId, undefined, entry.affectedArea.location);
      }
    }

    logger.info(`Registered device effect for ${deviceId}:`, {
      parameter: effect.parameter,
      effect: effect.effect,
      magnitude: effect.magnitude,
      area: `${effect.affectedArea.location} (${effect.affectedArea.radius}m)`,
    });
  }

  /**
   * T-106 (F-PH02b): publish/refresh a device's thermostat intent on its
   * registered temperature effect — the sibling-visibility lane for
   * multi-HVAC zones (see DevicePhysicsEffect.thermostat).
   */
  setDeviceEffectThermostat(
    deviceId: string,
    parameter: PhysicalParameter,
    thermostat: { targetTemperature: number; capacityW: number; heating: boolean } | undefined,
  ): void {
    const effect = this.deviceEffects.get(deviceId)?.find(e => e.parameter === parameter);
    if (!effect) return;
    if (thermostat === undefined) {
      delete effect.thermostat;
      // R44-insane: the zone index tracks PUBLISHED intents only.
      if (parameter === PhysicalParameter.TEMPERATURE) {
        this.dropFromHvacIndex(effect.affectedArea.location, deviceId);
      }
      return;
    }
    // R44-insane: unchanged republish is a no-op (per-tick steady state).
    if (PhysicsLayer.sameThermostat(effect.thermostat, thermostat)) return;
    effect.thermostat = { ...thermostat };
    // R44-insane: publish → join the zone's intent index.
    if (parameter === PhysicalParameter.TEMPERATURE) {
      this.indexTemperatureEffect(deviceId, undefined, effect.affectedArea.location);
    }
  }

  /**
   * R44-insane §11.6: devices republish their intent every control tick
   * with an unchanged payload; skip the copy + index churn when the three
   * semantic fields are identical (value equality, not object identity).
   */
  private static sameThermostat(
    a: { targetTemperature: number; capacityW: number; heating: boolean } | undefined,
    b: { targetTemperature: number; capacityW: number; heating: boolean },
  ): boolean {
    return a !== undefined &&
      a.targetTemperature === b.targetTemperature &&
      a.capacityW === b.capacityW &&
      a.heating === b.heating;
  }

  /**
   * R44-insane §11.6: per-zone index of devices with a TEMPERATURE effect
   * that PUBLISHED a thermostat intent — zone → deviceIds. zoneHvacIntents
   * used to scan EVERY device's effects per calling HVAC unit per tick
   * (O(hvac-units × devices) per tick — a measured superlinear term); the
   * first index cut it to O(devices in zone), but a city packs ~600
   * devices per zone while only the thermostat-carrying HVAC units ever
   * match, so the index now tracks exactly those (maintained by
   * register/unregister/clear + setDeviceEffectThermostat; the lookup
   * still re-checks the live effect, so the RESULT is identical).
   */
  private readonly hvacIntentZoneIndex = new Map<string, Array<string>>();

  /** Index maintenance: record/remove a device's temperature-effect zone. */
  private indexTemperatureEffect(deviceId: string, fromLocation: string | undefined, toLocation: string): void {
    if (fromLocation !== undefined && fromLocation !== toLocation) {
      this.dropFromHvacIndex(fromLocation, deviceId);
    }
    let list = this.hvacIntentZoneIndex.get(toLocation);
    if (list === undefined) {
      list = [];
      this.hvacIntentZoneIndex.set(toLocation, list);
    }
    if (!list.includes(deviceId)) list.push(deviceId);
  }

  private dropFromHvacIndex(location: string, deviceId: string): void {
    const list = this.hvacIntentZoneIndex.get(location);
    if (list === undefined) return;
    const at = list.indexOf(deviceId);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.hvacIntentZoneIndex.delete(location);
  }

  /**
   * T-106 (F-PH02b): the OTHER thermostat-intending HVAC effects in a zone
   * (excludeDeviceId keeps a device from seeing itself; units without a
   * published intent — manual devices — are invisible, matching the
   * single-unit behavior). R44-insane: walks the published-intent zone
   * index instead of all device effects, and returns the LIVE intent
   * objects (read-only by contract — the only consumer is the thermostat
   * policy) instead of copying each peer per calling unit per tick.
   */
  zoneHvacIntents(
    locationKey: string,
    excludeDeviceId: string,
  ): Array<{ targetTemperature: number; capacityW: number; heating: boolean }> {
    const out: Array<{ targetTemperature: number; capacityW: number; heating: boolean }> = [];
    const zoneDevices = this.hvacIntentZoneIndex.get(locationKey);
    if (zoneDevices === undefined) return out;
    for (const deviceId of zoneDevices) {
      if (deviceId === excludeDeviceId) continue;
      const effect = this.deviceEffects.get(deviceId)?.find(e => e.parameter === PhysicalParameter.TEMPERATURE);
      if (effect === undefined) continue;
      if (effect.affectedArea.location !== locationKey) continue;
      if (effect.thermostat === undefined) continue;
      out.push(effect.thermostat);
    }
    return out;
  }

  /**
   * Unregister a device effect
   */
  unregisterDeviceEffect(deviceId: string, parameter?: PhysicalParameter): void {
    if (!this.deviceEffects.has(deviceId)) {
      return;
    }

    if (parameter) {
      const effects = this.deviceEffects.get(deviceId)!;
      // R44-insane: drop the zone-index entry before the effect goes away.
      if (parameter === PhysicalParameter.TEMPERATURE) {
        const removed = effects.find(e => e.parameter === parameter);
        if (removed !== undefined) this.dropFromHvacIndex(removed.affectedArea.location, deviceId);
      }
      const filtered = effects.filter(e => e.parameter !== parameter);
      this.deviceEffects.set(deviceId, filtered);
      logger.info(`Unregistered ${parameter} effect for ${deviceId}`);
    } else {
      // R44-insane: drop every zone-index entry this device held.
      for (const effect of this.deviceEffects.get(deviceId)!) {
        if (effect.parameter === PhysicalParameter.TEMPERATURE) {
          this.dropFromHvacIndex(effect.affectedArea.location, deviceId);
        }
      }
      this.deviceEffects.delete(deviceId);
      logger.info(`Unregistered all effects for ${deviceId}`);
    }
  }

  /**
   * Get a device's registered effect for a parameter (device control loops
   * use this to cycle their own effect; never exposes other devices).
   */
  getDeviceEffect(deviceId: string, parameter: PhysicalParameter): DevicePhysicsEffect | undefined {
    return this.deviceEffects.get(deviceId)?.find(e => e.parameter === parameter);
  }

  /**
   * Living-worlds P0 (design-living-worlds.md §9 快照格式): every registered
   * device effect, deep-copied — the checkpoint capture seam. Effect entries
   * are mutable (the control loop toggles `enabled` in place), so copies are
   * mandatory: a checkpoint must freeze the state it saw, not alias it.
   * Virtual occupancy sources (`occupancy:<zoneId>`, registered by
   * EngineRuntime.setZoneOccupancy) are included; the checkpoint shaper
   * filters them out because occupancy re-registers them from its own state.
   */
  listDeviceEffects(): DevicePhysicsEffect[] {
    const out: DevicePhysicsEffect[] = [];
    for (const effects of this.deviceEffects.values()) {
      for (const effect of effects) {
        out.push({
          ...effect,
          affectedArea: {
            ...effect.affectedArea,
            ...(effect.affectedArea.position !== undefined
              ? { position: { ...effect.affectedArea.position } }
              : {}),
          },
        });
      }
    }
    return out;
  }

  /**
   * Living-worlds P0: seeded per-location baseline read (the relaxation
   * attractor), or undefined when the field holds no baseline for the pair.
   * Companion to getLocalParameterValue for checkpoint capture/restore.
   */
  getLocalParameterBaseline(
    parameter: PhysicalParameter,
    location: DeviceLocation | string,
  ): number | undefined {
    return this.field.getBaseline(parameter, this.locationKeyOf(location));
  }

  /**
   * Enable/disable a device effect
   */
  setDeviceEffectEnabled(deviceId: string, parameter: PhysicalParameter, enabled: boolean): void {
    const effects = this.deviceEffects.get(deviceId);
    if (!effects) {
      logger.warn(`No effects found for ${deviceId}`);
      return;
    }

    const effect = effects.find(e => e.parameter === parameter);
    if (effect) {
      effect.enabled = enabled;
      logger.info(`${deviceId} ${parameter} effect ${enabled ? 'enabled' : 'disabled'}`);
    }
  }

  // -------------------------------------------------------------------------
  // T-709 (DevLoop R29): per-device power accounting for zone metering.
  //
  // Every device reports its current electrical draw (W) each tick; an
  // energy-meter device sums the draws of the devices sharing its zone.
  // The layer is a neutral ledger: it stores the last reported watts per
  // (deviceId, location) — it never computes power itself.
  // -------------------------------------------------------------------------

  private readonly devicePowerReports = new Map<string, { deviceId: string; location: string; watts: number }>();
  /**
   * R44-insane §11.6: per-zone RUNNING SUM of reported draws. The zone
   * meter path used to walk EVERY device's report per meter per tick
   * (O(meters × devices) per tick — one of the measured superlinear
   * terms; a city packs hundreds of devices AND meters into one zone).
   * Each report now applies its delta atomically, so a meter's read is
   * exactly "the stored watts of every device in the zone as of this
   * instant" — the same quantity the full scan produced, minus the
   * excluded meter device (subtract its stored entry). Metering state
   * rounds to 0.1 W / 0.01 Wh, so incremental-sum associativity drift is
   * orders of magnitude below display precision.
   */
  private readonly zonePowerSums = new Map<string, number>();

  /** Report a device's current draw (W) in a zone (0 W = off/idle). */
  reportDevicePower(deviceId: string, location: string, watts: number): void {
    const existing = this.devicePowerReports.get(deviceId);
    if (existing !== undefined && existing.location === location) {
      if (existing.watts !== watts) {
        this.zonePowerSums.set(location, (this.zonePowerSums.get(location) ?? 0) + (watts - existing.watts));
        existing.watts = watts;
      }
      return;
    }
    if (existing !== undefined) {
      // Zone change (rare): retire the old zone's contribution.
      this.zonePowerSums.set(existing.location, (this.zonePowerSums.get(existing.location) ?? 0) - existing.watts);
    }
    this.devicePowerReports.set(deviceId, { deviceId, location, watts });
    this.zonePowerSums.set(location, (this.zonePowerSums.get(location) ?? 0) + watts);
  }

  /**
   * Sum the reported draws of every device in a zone, optionally excluding
   * one device (the meter itself). Devices that never reported are absent.
   */
  zonePowerW(location: string, excludeDeviceId?: string): number {
    let sum = this.zonePowerSums.get(location) ?? 0;
    if (excludeDeviceId !== undefined) {
      const excluded = this.devicePowerReports.get(excludeDeviceId);
      if (excluded !== undefined && excluded.location === location) {
        sum -= excluded.watts;
      }
    }
    return sum;
  }

  /** All of a device's registered effects (copies — callers may mutate). */
  getDeviceEffects(deviceId: string): DevicePhysicsEffect[] {
    const effects = this.deviceEffects.get(deviceId);
    if (!effects) return [];
    return effects.map(effect => ({
      ...effect,
      affectedArea: { ...effect.affectedArea },
    }));
  }

  // -------------------------------------------------------------------------
  // Spatial field API (location-scoped reads/writes)
  //
  // This is the clean seam for runtime/device layers: writes land in the
  // per-location field WITHOUT touching the global value models, and reads
  // sample the field. The API exposes field math only — no device semantics.
  // -------------------------------------------------------------------------

  /**
   * Write a parameter value at/around a location WITHOUT touching the
   * global value model.
   *
   * @param parameter - Physical parameter
   * @param location - Location (path string or DeviceLocation)
   * @param value - Value to write (booleans are stored as 1/0)
   * @param radius - Optional spillover radius (m). Other known locations
   *   within radius receive a delta-based, linearly attenuated share of the
   *   write. radius <= 0 (default) is a pure point write.
   */
  setLocalParameterValue(
    parameter: PhysicalParameter | string,
    location: DeviceLocation | string,
    value: number | boolean,
    radius: number = 0,
  ): void {
    const locationKey = this.locationKeyOf(location);
    const numericValue = typeof value === 'boolean' ? (value ? 1 : 0) : value;

    const position = this.resolveLocationPosition(locationKey);
    if (position) {
      this.field.registerLocation(locationKey, position);
    }

    this.field.setLocalized(parameter, locationKey, numericValue, radius, this.fieldAttractor);
    this.stateInterpolator.recordState(
      locationKey,
      parameter,
      numericValue,
      this.timeManager.getCurrentTime(),
    );

    logger.info(`Local write: ${parameter}@${locationKey} = ${numericValue} (radius ${radius}m)`);
  }

  /**
   * Sample the spatial field at a location.
   * @returns The field value, or undefined when the field holds no state
   *   for (parameter, location) — callers should then fall back to the
   *   global value model.
   */
  getLocalParameterValue(
    parameter: PhysicalParameter | string,
    location: DeviceLocation | string,
  ): number | undefined {
    return this.field.get(parameter, this.locationKeyOf(location));
  }

  /**
   * NFR-1: ASHRAE 55 thermal comfort for a zone (PMV + PPD + sensation).
   * Reads temperature and humidity from the field; agents and flows can
   * query this to reason about occupant comfort — the key metric for
   * smart-building applications ("is this classroom comfortable?").
   * Returns undefined when the zone has no field temperature yet.
   */
  getZoneComfort(location: string): {
    pmv: number;
    ppd: number;
    sensation: string;
    comfortLevel: string;
  } | undefined {
    const temp = this.field.get(PhysicalParameter.TEMPERATURE, this.locationKeyOf(location));
    if (temp === undefined || typeof temp !== 'number') return undefined;
    const humidity = this.field.get(PhysicalParameter.HUMIDITY, this.locationKeyOf(location)) ?? 50;
    const result = this.comfortModel.evaluateComfort(temp, temp, 0.1, humidity);
    return {
      pmv: Math.round(result.pmv * 100) / 100,
      ppd: Math.round(result.ppd * 10) / 10,
      sensation: result.sensation,
      comfortLevel: result.comfortLevel,
    };
  }

  /**
   * Seed a per-location environmental baseline: the attractor the field
   * relaxes toward at this location (e.g. a zone's `baseline` from a
   * scenario). Does not change the current field value.
   */
  setParameterBaseline(
    parameter: PhysicalParameter | string,
    location: DeviceLocation | string,
    value: number | boolean,
  ): void {
    const locationKey = this.locationKeyOf(location);
    const numericValue = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    const position = this.resolveLocationPosition(locationKey);
    if (position) {
      this.field.registerLocation(locationKey, position);
    }
    this.field.setBaseline(parameter, locationKey, numericValue);
  }

  /**
   * Register a zone's floor + declared adjacency with the spatial field
   * (building tier, B-A). The runtime calls this once per zone at build
   * time; the field then gates cross-floor diffusion coupling, and this
   * layer restricts direct device effects to the source's own floor.
   *
   * RC-5 calibration: when the metadata carries `volumeM3`, the zone's
   * thermal mass is derived from its air volume (ρ·V·c) and used for every
   * thermal effect at this location, replacing the global 100 m³ constant.
   */
  registerZonePhysics(locationKey: string, metadata: ZonePhysicsMetadata): void {
    this.field.registerZoneMetadata(locationKey, metadata);
    if (metadata.volumeM3 !== undefined && metadata.volumeM3 > 0) {
      this.locationThermalMass.set(
        locationKey,
        HeatTransferModel.airThermalMassJPerK(metadata.volumeM3),
      );
    }
  }

  /** Override the cross-floor diffusion flux multiplier (scenario meta). */
  setSlabAttenuation(value: number): void {
    this.field.setSlabAttenuation(value);
  }

  /** Override the indoor↔outdoor envelope flux multiplier (scenario meta, B-B). */
  setEnvelopeU(value: number): void {
    this.field.setEnvelopeU(value);
  }

  /**
   * FEAT-03: runtime per-parameter relaxation-rate override — a scenario
   * declaring `parameterPhysics` pins a custom zone parameter's field
   * relaxation rate (`relaxRatePerSec`, 1/s).
   */
  setParameterRelaxationRate(parameter: string, ratePerSec: number): void {
    this.field.setRelaxationRate(parameter, ratePerSec);
  }

  /**
   * Drop all field VALUES for a parameter (seeded baselines survive), along
   * with its recorded interpolation states. Used by
   * PhysicalEnvironment.setParameterValue to keep legacy global writes
   * consistent: a global write overrides both the spatial field and any
   * stale recorded states for that parameter.
   */
  clearLocalParameter(parameter: PhysicalParameter): void {
    this.field.clearParameter(parameter);
    this.stateInterpolator.clearParameterHistory(parameter);
  }

  /** Normalize a location to its field key (the location path). */
  private locationKeyOf(location: DeviceLocation | string): string {
    return typeof location === 'string' ? location : location?.path ?? 'default';
  }

  /** Best-effort position lookup for a location key. */
  private resolveLocationPosition(locationKey: string): FieldPosition | undefined {
    const byPath = this.spatialManager.getLocationByPath(locationKey);
    if (byPath?.position) return byPath.position;
    const byId = this.spatialManager.getLocation(locationKey);
    if (byId?.position) return byId.position;
    return undefined;
  }

  /**
   * Register all spatial-manager locations (and device-effect locations)
   * with the field so diffusion geometry is available. Cheap: a handful of
   * map writes per tick.
   */
  private syncFieldLocations(): void {
    for (const loc of this.spatialManager.listLocations()) {
      if (loc.position) {
        this.field.registerLocation(loc.path ?? loc.id, loc.position);
      }
    }
    for (const effects of this.deviceEffects.values()) {
      for (const effect of effects) {
        if (effect.affectedArea.position) {
          this.field.registerLocation(effect.affectedArea.location, effect.affectedArea.position);
        }
      }
    }
  }

  /**
   * Get interpolated parameter value
   */
  interpolateParameter(
    parameter: PhysicalParameter,
    location: DeviceLocation | string,
    targetTime?: Date
  ): number | boolean | null {
    if (!this.config.enableFullPhysics) {
      return null;
    }

    const interpolated = this.stateInterpolator.interpolate(location, parameter, targetTime);

    if (interpolated !== null) {
      return interpolated;
    }

    return null;
  }

  /**
   * Update interpolator with current environmental values
   */
  private updateInterpolator(): number {
    let updates = 0;

    const parametersToUpdate: PhysicalParameter[] = [
      PhysicalParameter.TEMPERATURE,
      PhysicalParameter.HUMIDITY,
      PhysicalParameter.LIGHT,
      PhysicalParameter.AIR_QUALITY,
    ];

    const locations = new Set<string>();
    for (const effects of this.deviceEffects.values()) {
      for (const effect of effects) {
        locations.add(effect.affectedArea.location);
      }
    }

    const affectedPairs = new Set<string>();
    for (const effects of this.deviceEffects.values()) {
      for (const effect of effects) {
        if (effect.enabled) {
          affectedPairs.add(`${effect.affectedArea.location}:${effect.parameter}`);
        }
      }
    }

    for (const location of locations) {
      for (const parameter of parametersToUpdate) {
        const pairKey = `${location}:${parameter}`;
        if (affectedPairs.has(pairKey)) {
          continue;
        }

        const value = this.physicalEnvironment.getParameterValueWithoutPhysics(parameter, location);

        if (typeof value === 'number' || typeof value === 'boolean') {
          this.stateInterpolator.recordState(location, parameter, value, this.timeManager.getCurrentTime());
          updates++;
        }
      }
    }

    return updates;
  }

  /**
   * Subscribe to state change events
   */
  onStateChange(listener: (event: StateChangeEvent) => void): () => void {
    this.stateChangeListeners.add(listener);
    logger.info('State change listener added');

    return () => {
      this.stateChangeListeners.delete(listener);
      logger.info('State change listener removed');
    };
  }

  /**
   * Emit state change event
   */
  private emitStateChange(event: StateChangeEvent): void {
    for (const listener of this.stateChangeListeners) {
      try {
        listener(event);
      } catch (error) {
        logger.error('Error in state change listener:', error);
      }
    }
  }

  /**
   * Get physics statistics
   */
  getStats(): {
    isRunning: boolean;
    activeDeviceEffects: number;
    activeEffectSources: number;
    trackedLocations: number;
    trackedTemperatureLocations: number;
    trackedHumidityLocations: number;
    trackedLightLocations: number;
    trackedMotionLocations: number;
    fieldEntries: number;
    interpolatorStats: ReturnType<StateInterpolator['getStats']>;
  } {
    let activeEffects = 0;
    for (const effects of this.deviceEffects.values()) {
      activeEffects += effects.filter(e => e.enabled).length;
    }

    const effectStats = this.propagationEngine.getRegistry().getStats();

    return {
      isRunning: this.isRunning,
      activeDeviceEffects: activeEffects,
      activeEffectSources: effectStats.active,
      trackedLocations: this.locationTemperatures.size,
      trackedTemperatureLocations: this.locationTemperatures.size,
      trackedHumidityLocations: this.locationHumidity.size,
      trackedLightLocations: this.locationLight.size,
      trackedMotionLocations: this.locationMotion.size,
      fieldEntries: this.field.size,
      interpolatorStats: this.stateInterpolator.getStats(),
    };
  }

  /**
   * Get the spatial field (per-location parameter state)
   */
  getSpatialField(): SpatialField {
    return this.field;
  }

  /**
   * Get the propagation engine (for advanced usage)
   */
  getPropagationEngine(): SpatialPropagationEngine {
    return this.propagationEngine;
  }

  /**
   * Get heat transfer model
   */
  getHeatTransferModel(): HeatTransferModel {
    return this.heatTransferModel;
  }

  /**
   * Get state interpolator
   */
  getStateInterpolator(): StateInterpolator {
    return this.stateInterpolator;
  }

  /**
   * Get spatial manager
   */
  getSpatialManager(): SpatialManager {
    return this.spatialManager;
  }

  /**
   * Get configuration
   */
  getConfig(): PhysicsLayerConfig {
    return {
      enableFullPhysics: this.config.enableFullPhysics,
      updateInterval: this.config.updateInterval,
      spatialResolution: this.config.spatialResolution,
      heatTransferConfig: this.config.heatTransferConfig,
      interpolationConfig: this.config.interpolationConfig,
    };
  }

  /**
   * Clear all device effects
   */
  clearAllDeviceEffects(): void {
    this.deviceEffects.clear();
    this.hvacIntentZoneIndex.clear();
    this.propagationEngine.getRegistry().clear();
    this.locationTemperatures.clear();
    this.locationHumidity.clear();
    this.locationLight.clear();
    this.locationMotion.clear();
    logger.info('Cleared all device effects');
  }

  /**
   * Clear device effects scoped to one location (zone).
   *
   * Fix-21: the AC closed-loop monitor (PhysicalEnvironment.simulateWithFeedback)
   * used to call clearAllDeviceEffects() when its goal was reached, wiping
   * EVERY zone's effects — including unrelated thermostats governing other
   * rooms. This scoped variant removes only effects whose affectedArea is the
   * goal location, leaving other zones' control effects untouched.
   *
   * The propagation registry is not touched here: it is rebuilt from
   * deviceEffects on the next updatePhysics sync.
   *
   * @param location - Location/zone id to clear effects for
   * @returns Number of effects removed
   */
  clearDeviceEffectsForLocation(location: string): number {
    let removed = 0;
    for (const [deviceId, effects] of [...this.deviceEffects]) {
      const remaining = effects.filter(e => e.affectedArea.location !== location);
      removed += effects.length - remaining.length;
      // R44-insane: zone-index upkeep for removed temperature effects.
      for (const effect of effects) {
        if (effect.parameter === PhysicalParameter.TEMPERATURE &&
            effect.affectedArea.location === location) {
          this.dropFromHvacIndex(location, deviceId);
        }
      }
      if (remaining.length === 0) {
        this.deviceEffects.delete(deviceId);
      } else if (remaining.length !== effects.length) {
        this.deviceEffects.set(deviceId, remaining);
      }
    }
    logger.info(`Cleared ${removed} device effect(s) for location '${location}'`);
    return removed;
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<PhysicsLayerConfig>): void {
    if (updates.heatTransferConfig) {
      this.heatTransferModel.updateConfig(updates.heatTransferConfig);
    }

    Object.assign(this.config, updates);
    logger.info('Configuration updated');
  }
}
