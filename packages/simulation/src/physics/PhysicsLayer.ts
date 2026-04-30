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

export interface DevicePhysicsEffect {
  deviceId: string;
  parameter: PhysicalParameter;
  effect: 'heating' | 'cooling' | 'humidity' | 'light' | 'motion' | 'set' | 'pollutant' | 'air_flow';
  magnitude: number;
  affectedArea: {
    location: string;
    radius: number;
    position?: Coordinate2D | Coordinate3D;
  };
  falloff?: 'linear' | 'inverse-square' | 'exponential';
  enabled?: boolean;
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
  parameter: PhysicalParameter;
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

    logger.info(`Updating physics (dt = ${deltaTime.toFixed(3)}s)`);

    let updatesApplied = 0;
    let deviceEffectsProcessed = 0;
    let interpolationUpdates = 0;

    // Step 1: Translate device effects to physics effect sources
    this.syncDeviceEffectsToPropagationEngine();

    // Step 2: Apply spatial effects using the propagation engine
    if (this.propagationEngine.getRegistry().getActiveSources().length > 0) {
      const effectResult = this.applySpatialEffects(deltaTime);
      deviceEffectsProcessed = effectResult.effectsProcessed;
      updatesApplied += effectResult.updatesApplied;
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

    logger.info('Physics update complete:', result);
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

        // Translate DevicePhysicsEffect to EffectSource
        const effectSource = this.translateDeviceEffectToSource(deviceEffect);
        if (effectSource) {
          registry.register(effectSource);
        }
      }
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

    // Get device position from spatial manager or use effect's position
    const devicePos = this.spatialManager.getDevicePosition(effect.deviceId);
    const position = effect.affectedArea.position || devicePos?.position || { x: 0, y: 0 };

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
    let effectsProcessed = this.propagationEngine.getRegistry().getActiveSources().length;
    let updatesApplied = 0;

    logger.info(`Applying ${effectsProcessed} effect sources with spatial propagation...`);

    // Get all spatial locations (filter out locations without positions)
    const spatialLocations = this.spatialManager.listLocations();
    const propagationLocations: PropagationLocation[] = spatialLocations
      .filter(loc => loc.position !== undefined)
      .map(loc => ({
        id: loc.path,
        position: loc.position!,
      }));

    // Add locations from device effects that might not be in spatial manager
    for (const effects of this.deviceEffects.values()) {
      for (const effect of effects) {
        if (!effect.enabled) continue;
        const existingLoc = propagationLocations.find(l => l.id === effect.affectedArea.location);
        if (!existingLoc) {
          propagationLocations.push({
            id: effect.affectedArea.location,
            position: effect.affectedArea.position || { x: 0, y: 0 },
          });
        }
      }
    }

    // Calculate effects at each location using the propagation engine
    for (const location of propagationLocations) {
      const effectsAtLocation = this.propagationEngine.calculateEffectAtLocation(location);

      if (effectsAtLocation.size === 0) continue;

      // Process thermal effects (heating/cooling)
      const heatingPower = effectsAtLocation.get(PhysicalEffectType.HEATING) ?? 0;
      const coolingPower = effectsAtLocation.get(PhysicalEffectType.COOLING) ?? 0;
      const totalThermalPower = heatingPower - Math.abs(coolingPower);

      if (Math.abs(totalThermalPower) > 0.1 && this.config.enableFullPhysics) {
        const result = this.applyThermalEffect(location.id, totalThermalPower, deltaTime);
        if (result) updatesApplied++;
      }

      // Process light effects
      const lightMagnitude = effectsAtLocation.get(PhysicalEffectType.LIGHT) ?? 0;
      if (Math.abs(lightMagnitude) > 0.1 && this.config.enableFullPhysics) {
        const result = this.applyLightEffect(location.id, lightMagnitude);
        if (result) updatesApplied++;
      }

      // Process humidity effects
      const humidityMagnitude = effectsAtLocation.get(PhysicalEffectType.HUMIDITY) ?? 0;
      if (Math.abs(humidityMagnitude) > 0.1 && this.config.enableFullPhysics) {
        const result = this.applyHumidityEffect(location.id, humidityMagnitude);
        if (result) updatesApplied++;
      }

      // Process pollutant effects (air purifiers reducing PM2.5/VOC)
      const pollutantMagnitude = effectsAtLocation.get(PhysicalEffectType.POLLUTANT) ?? 0;
      if (Math.abs(pollutantMagnitude) > 0.01 && this.config.enableFullPhysics) {
        const result = this.applyPollutantEffect(location.id, pollutantMagnitude);
        if (result) updatesApplied++;
      }

      // Process air flow effects (exhaust fans providing ventilation)
      const airFlowMagnitude = effectsAtLocation.get(PhysicalEffectType.AIR_FLOW) ?? 0;
      if (Math.abs(airFlowMagnitude) > 0.01 && this.config.enableFullPhysics) {
        // Air flow reduces humidity similar to a dehumidifier but milder
        const result = this.applyHumidityEffect(location.id, airFlowMagnitude);
        if (result) updatesApplied++;
      }
    }

    // Process SET effects directly (not through propagation engine)
    // SET effects set absolute values and don't propagate like heating/cooling
    for (const effects of this.deviceEffects.values()) {
      for (const effect of effects) {
        if (!effect.enabled || effect.effect !== 'set') continue;

        // Find matching location in propagationLocations
        const targetLocation = propagationLocations.find(l => l.id === effect.affectedArea.location);
        if (targetLocation) {
          const result = this.applySetEffect(targetLocation.id, effect.parameter, effect.magnitude);
          if (result) updatesApplied++;
        }
      }
    }

    return { effectsProcessed, updatesApplied };
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
      this.locationTemperatures.get(locationId) ??
      (this.physicalEnvironment.getParameterValueWithoutPhysics(PhysicalParameter.TEMPERATURE, locationId) as number);

    const ambientTemp = this.physicalEnvironment.getParameterValueWithoutPhysics(
      PhysicalParameter.TEMPERATURE,
      'outside'
    ) as number;

    const result = this.heatTransferModel.calculateHeatTransfer(
      currentTemp,
      ambientTemp,
      power,
      deltaTime
    );

    this.locationTemperatures.set(locationId, result.finalTemperature);

    // CRITICAL: Write the updated temperature back to PhysicalEnvironment
    // so that subsequent getParameterValue() calls reflect the change.
    this.physicalEnvironment.setParameterValue(
      PhysicalParameter.TEMPERATURE,
      locationId,
      result.finalTemperature,
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

    logger.info(`Thermal effect at ${locationId}:`, {
      power: `${power.toFixed(1)}W`,
      tempChange: `${result.temperatureChange.toFixed(4)}°C`,
      newTemp: `${result.finalTemperature.toFixed(2)}°C`,
    });

    return true;
  }

  /**
   * Apply light effect at a location
   */
  private applyLightEffect(locationId: string, magnitude: number): boolean {
    const currentLight =
      this.locationLight.get(locationId) ??
      (this.physicalEnvironment.getParameterValueWithoutPhysics(PhysicalParameter.LIGHT, locationId) as number);

    const newLight = Math.max(0, currentLight + magnitude);

    this.locationLight.set(locationId, newLight);

    // Write back to PhysicalEnvironment
    this.physicalEnvironment.setParameterValue(
      PhysicalParameter.LIGHT,
      locationId,
      newLight,
    );

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
   * Apply humidity effect at a location
   */
  private applyHumidityEffect(locationId: string, magnitude: number): boolean {
    const currentHumidity =
      this.locationHumidity.get(locationId) ??
      (this.physicalEnvironment.getParameterValueWithoutPhysics(PhysicalParameter.HUMIDITY, locationId) as number);

    const newHumidity = Math.max(0, Math.min(100, currentHumidity + magnitude));

    this.locationHumidity.set(locationId, newHumidity);

    // Write back to PhysicalEnvironment
    this.physicalEnvironment.setParameterValue(
      PhysicalParameter.HUMIDITY,
      locationId,
      newHumidity,
    );

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
   * Apply pollutant effect at a location (reduces PM2.5/VOC from air purifiers)
   * Negative magnitude reduces pollutants; positive would add them.
   */
  private applyPollutantEffect(locationId: string, magnitude: number): boolean {
    const currentPm25 =
      this.physicalEnvironment.getParameterValueWithoutPhysics(PhysicalParameter.PM25, locationId) as number;

    if (currentPm25 === undefined || currentPm25 === null) return false;

    // Pollutant reduction: magnitude is negative (e.g., -0.25 means reduce by 0.25 µg/m³ per step)
    const newPm25 = Math.max(0, currentPm25 + magnitude * 10); // Scale up for visible effect

    this.physicalEnvironment.setParameterValue(
      PhysicalParameter.PM25,
      locationId,
      newPm25,
    );

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
   * Apply set effect at a location (sets absolute value)
   * Used for environment initialization and external simulation
   */
  private applySetEffect(locationId: string, parameter: PhysicalParameter, value: number): boolean {
    const oldValue = this.physicalEnvironment.getParameterValueWithoutPhysics(parameter, locationId) as number;

    // Set the absolute value in PhysicalEnvironment
    this.physicalEnvironment.setParameterValue(parameter, locationId, value);

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
   * Register a device physics effect
   */
  registerDeviceEffect(effect: DevicePhysicsEffect): void {
    const deviceId = effect.deviceId;

    if (!this.deviceEffects.has(deviceId)) {
      this.deviceEffects.set(deviceId, []);
    }

    const effects = this.deviceEffects.get(deviceId)!;
    effects.push({ ...effect, enabled: effect.enabled ?? true });

    logger.info(`Registered device effect for ${deviceId}:`, {
      parameter: effect.parameter,
      effect: effect.effect,
      magnitude: effect.magnitude,
      area: `${effect.affectedArea.location} (${effect.affectedArea.radius}m)`,
    });
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
      const filtered = effects.filter(e => e.parameter !== parameter);
      this.deviceEffects.set(deviceId, filtered);
      logger.info(`Unregistered ${parameter} effect for ${deviceId}`);
    } else {
      this.deviceEffects.delete(deviceId);
      logger.info(`Unregistered all effects for ${deviceId}`);
    }
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
      interpolatorStats: this.stateInterpolator.getStats(),
    };
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
    this.propagationEngine.getRegistry().clear();
    this.locationTemperatures.clear();
    this.locationHumidity.clear();
    this.locationLight.clear();
    this.locationMotion.clear();
    logger.info('Cleared all device effects');
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
