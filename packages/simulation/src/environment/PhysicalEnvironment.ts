/**
 * Physical Environment
 *
 * Models physical parameters (temperature, humidity, light, etc.)
 * across space and time for IoT device simulation.
 */

import { TimeManager } from './TimeManager.js';
import type { DeviceLocation, ValueModel, PhysicalEnvironmentConfig } from '../devices/types.js';
import { PhysicalParameter } from '../devices/types.js';
import { DailyCycleModel } from './models/DailyCycleModel.js';
import { SimpleFunctionModel } from './models/SimpleFunctionModel.js';
import { PhysicsLayer, type PhysicsLayerConfig, type DevicePhysicsEffect } from '../physics/PhysicsLayer.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Event manager interface for emitting environment change events
 */
interface EventManager {
  emit(event: string, ...args: unknown[]): void;
}

/**
 * Physical Environment Class
 *
 * Manages physical parameter values at different locations and times.
 * Uses pluggable value models to generate realistic parameter values.
 * Optionally integrates physics simulation for realistic device effects.
 */
const logger = createLogger('PhysicalEnvironment');

/**
 * Goal specification for feedback-controlled simulation.
 * Used by `PhysicalEnvironment.simulateWithFeedback()` to implement
 * AC goal-directed device control (e.g., stop cooling when target temperature reached).
 */
export interface SimulateGoal {
  parameter: PhysicalParameter | string;
  location: string;
  targetValue: number;
  tolerance?: number;
  direction: 'below' | 'above';
}

/**
 * Result of feedback-controlled simulation.
 * Reports whether the goal was achieved and when.
 */
export interface SimulateResult {
  stepsExecuted: number;
  goalAchieved: boolean;
  achievedAtStep?: number;
  achievedAtSeconds?: number;
  finalValue?: number;
}

export class PhysicalEnvironment {
  private timeManager: TimeManager;
  private valueModels: Map<PhysicalParameter, ValueModel>;
  private config: PhysicalEnvironmentConfig;
  private physicsLayer?: PhysicsLayer;
  private disablePhysicsCheck: boolean = false; // Flag to prevent circular dependency
  private eventManager?: EventManager; // EventManager for emitting environment change events

  constructor(timeManager: TimeManager, config: PhysicalEnvironmentConfig = {}) {
    this.timeManager = timeManager;
    this.valueModels = new Map();
    this.config = config;

    logger.info('Initialized', {
      physics: config.enablePhysics !== false,
      simDuration: `${this.getSimDurationSeconds()}s per command`,
    });

    this.initializeDefaultModels();

    // Initialize physics layer if enabled
    if (config.enablePhysics !== false) {
      this.initializePhysicsLayer(config.physicsConfig);
    }
  }

  /**
   * Set event manager for emitting environment parameter change events
   * @param eventManager - EventManager instance
   */
  setEventManager(eventManager: EventManager): void {
    this.eventManager = eventManager;

    // If physics layer exists, update its event manager
    if (this.physicsLayer) {
      // Recreate physics layer with event manager
      const config = this.physicsLayer.getConfig();
      this.physicsLayer.stopPhysicsSimulation();
      this.initializePhysicsLayer(config);
    }
  }

  /**
   * Get parameter value at device location
   * @param parameter - Physical parameter to retrieve
   * @param location - Device location (path string or DeviceLocation object)
   * @returns Parameter value at current time and location
   */
  getParameterValue(parameter: PhysicalParameter | string, location: DeviceLocation | string): number | boolean {
    const deviceLocation = this.normalizeLocation(location);

    // Convert string parameter to enum if needed
    const paramKey = this.stringToParameterKey(parameter);
    if (!paramKey) {
      logger.warn(`Unknown parameter: ${parameter}, using default`);
      return this.getDefaultValue(parameter);
    }

    // If physics layer is enabled and physics check is not disabled, try to get interpolated value first
    if (this.physicsLayer && !this.disablePhysicsCheck) {
      const interpolatedValue = this.physicsLayer.interpolateParameter(
        paramKey,
        deviceLocation,
        this.timeManager.getCurrentTime()
      );

      if (interpolatedValue !== null) {
        return interpolatedValue;
      }
    }

    // Fall back to value model
    const time = this.timeManager.getCurrentTime();
    const model = this.valueModels.get(paramKey);

    if (!model) {
      // No model registered, return default value
      const defaultValue = this.getDefaultValue(paramKey);
      logger.warn(`No model for ${paramKey}, using default: ${defaultValue}`);
      return defaultValue;
    }

    return model.getValue(time, deviceLocation);
  }

  /**
   * Register a custom value model for a parameter
   * @param parameter - Physical parameter
   * @param model - Value model to use
   */
  registerValueModel(parameter: PhysicalParameter, model: ValueModel): void {
    this.valueModels.set(parameter, model);
  }

  /**
   * Set parameter value at location (for testing and device effects)
   * Creates a simple function model that returns the specified value
   * @param parameter - Physical parameter to set
   * @param location - Device location (not used for simple values)
   * @param value - Value to set
   */
  setParameterValue(parameter: PhysicalParameter | string, location: DeviceLocation | string, value: number | boolean): void {
    const paramKey = this.stringToParameterKey(parameter);
    if (!paramKey) {
      logger.warn(`Unknown parameter: ${parameter}`);
      return;
    }

    // For boolean values (motion, presence), create a model that returns the boolean
    if (typeof value === 'boolean') {
      const booleanModel = new SimpleFunctionModel({
        base: value ? 1 : 0,
        noiseLevel: 0,
        minValue: value ? 1 : 0,
        maxValue: value ? 1 : 0
      });
      this.valueModels.set(paramKey, booleanModel);
      return;
    }

    // For numeric values, create a model that returns the number
    const numericValue = value as number;
    const constantModel = new SimpleFunctionModel({
      base: numericValue,
      noiseLevel: 0,
      minValue: numericValue,
      maxValue: numericValue
    });

    this.valueModels.set(paramKey, constantModel);
  }

  /**
   * Get time manager
   * @returns Time manager instance
   */
  getTimeManager(): TimeManager {
    return this.timeManager;
  }

  /**
   * Get physics layer (if enabled)
   * @returns Physics layer instance or undefined
   */
  getPhysicsLayer(): PhysicsLayer | undefined {
    return this.physicsLayer;
  }

  /**
   * Get simulated duration per device command execution (in seconds).
   * Controls how much simulated time passes for each physics effect.
   */
  getSimDurationSeconds(): number {
    return this.config.simDurationSeconds ?? 60;
  }

  /**
   * Run continuous physics simulation synchronously for a specified duration.
   *
   * This method executes N physics steps (where N = totalDuration / stepSize)
   * in a synchronous loop, allowing device effects to accumulate gradually
   * toward thermal/light/humidity equilibrium.
   *
   * Device effects must be registered BEFORE calling this method (they persist
   * across steps). Each step applies all registered effects, so an HVAC cooling
   * effect of -3000W gradually reduces temperature across steps, naturally
   * converging toward the target value.
   *
   * @param totalDuration - Total simulated time to advance (in seconds)
   * @param stepSize - Duration per physics step (in seconds, default 1.0)
   * @returns Number of physics steps executed
   */
  simulate(totalDuration: number, stepSize: number = 1.0): number {
    if (!this.physicsLayer) {
      logger.warn('Physics layer not enabled, cannot simulate');
      return 0;
    }

    const steps = Math.ceil(totalDuration / stepSize);
    logger.info(`Running continuous physics simulation: ${totalDuration}s (${steps} steps x ${stepSize}s)`);

    for (let i = 0; i < steps; i++) {
      this.physicsLayer.updatePhysics(stepSize);
    }

    logger.info(`Simulation complete: ${steps} steps executed`);
    return steps;
  }

  /**
   * Run feedback-controlled physics simulation with AC goal-directed control.
   *
   * This implements the core AC advantage: the agent monitors the physical
   * environment and stops device effects when the goal is achieved. This is
   * analogous to a thermostat feedback loop - the HVAC cools until the target
   * temperature is reached, then automatically stops.
   *
   * Unlike the basic `simulate()` which runs for a fixed duration, this method:
   * 1. Runs physics steps
   * 2. After each step, checks if the goal parameter has reached the target
   * 3. When the goal is achieved, unregisters ALL device effects (devices stop)
   * 4. Runs a few settling steps (device is off, natural equilibrium)
   * 5. Returns detailed result including achievement timing
   *
   * @param totalDuration - Maximum simulated time (timeout, in seconds)
   * @param goal - The target outcome to achieve
   * @param stepSize - Duration per physics step (in seconds, default 1.0)
   * @param settleSteps - Extra steps to run after goal achievement for settling (default: 5)
   * @returns Simulation result with achievement details
   */
  simulateWithFeedback(
    totalDuration: number,
    goal: SimulateGoal,
    stepSize: number = 1.0,
    settleSteps: number = 5,
  ): SimulateResult {
    if (!this.physicsLayer) {
      logger.warn('Physics layer not enabled, cannot simulate');
      return { stepsExecuted: 0, goalAchieved: false };
    }

    const maxSteps = Math.ceil(totalDuration / stepSize);
    const tolerance = goal.tolerance ?? 2;
    const paramKey = this.stringToParameterKey(goal.parameter);

    logger.info(
      `Running feedback-controlled simulation: ${totalDuration}s max, ` +
      `goal: ${goal.parameter}@${goal.location} ${goal.direction} ${goal.targetValue}±${tolerance}`,
    );

    let goalAchieved = false;
    let achievedAtStep: number | undefined;
    let achievedAtSeconds: number | undefined;
    let step = 0;

    for (; step < maxSteps; step++) {
      this.physicsLayer.updatePhysics(stepSize);

      // Check goal every step (feedback loop)
      if (!goalAchieved && paramKey) {
        const currentValue = this.getParameterValue(goal.parameter, goal.location);
        if (typeof currentValue === 'number') {
          const achieved = goal.direction === 'below'
            ? currentValue <= goal.targetValue + tolerance
            : currentValue >= goal.targetValue - tolerance;

          if (achieved) {
            goalAchieved = true;
            achievedAtStep = step;
            achievedAtSeconds = step * stepSize;
            logger.info(
              `Goal achieved at step ${step} (${achievedAtSeconds}s): ` +
              `${goal.parameter}@${goal.location} = ${currentValue.toFixed(2)}`,
            );

            // AC feedback control: stop all device effects (HVAC stops)
            // This is the key AC advantage - precise control based on context
            this.physicsLayer.clearAllDeviceEffects();
            logger.info('All device effects removed (AC feedback: target reached, devices stopped)');

            // Run a few more settling steps (natural equilibrium, no active devices)
            for (let s = 0; s < settleSteps; s++) {
              step++;
              this.physicsLayer.updatePhysics(stepSize);
            }
            break;
          }
        }
      }
    }

    const finalValue = paramKey
      ? this.getParameterValue(goal.parameter, goal.location)
      : undefined;

    const result: SimulateResult = {
      stepsExecuted: step,
      goalAchieved,
      achievedAtStep,
      achievedAtSeconds,
      finalValue: typeof finalValue === 'number' ? finalValue : undefined,
    };

    logger.info(
      `Simulation complete: ${step} steps, goal achieved: ${goalAchieved}, ` +
      `final value: ${result.finalValue?.toFixed(2) ?? 'N/A'}`,
    );

    return result;
  }

  /**
   * Get parameter value without physics (for internal physics layer use)
   * @param parameter - Physical parameter to retrieve
   * @param location - Device location
   * @returns Parameter value from value models only
   */
  getParameterValueWithoutPhysics(parameter: PhysicalParameter | string, location: DeviceLocation | string): number | boolean {
    // Disable physics check to prevent circular dependency
    this.disablePhysicsCheck = true;
    try {
      return this.getParameterValue(parameter, location);
    } finally {
      this.disablePhysicsCheck = false;
    }
  }

  /**
   * Register a device physics effect
   * @param effect - Device effect to register
   */
  registerDeviceEffect(effect: DevicePhysicsEffect): void {
    if (!this.physicsLayer) {
      logger.warn('Physics layer not enabled, cannot register device effect');
      return;
    }

    this.physicsLayer.registerDeviceEffect(effect);
  }

  /**
   * Unregister a device physics effect
   * @param deviceId - Device ID
   * @param parameter - Parameter (optional, removes all effects for device if not specified)
   */
  unregisterDeviceEffect(deviceId: string, parameter?: PhysicalParameter): void {
    if (!this.physicsLayer) {
      return;
    }

    this.physicsLayer.unregisterDeviceEffect(deviceId, parameter);
  }

  /**
   * Start physics simulation
   */
  startPhysicsSimulation(): void {
    if (!this.physicsLayer) {
      logger.warn('Physics layer not enabled');
      return;
    }

    this.physicsLayer.startPhysicsSimulation();
  }

  /**
   * Stop physics simulation
   */
  stopPhysicsSimulation(): void {
    if (!this.physicsLayer) {
      return;
    }

    this.physicsLayer.stopPhysicsSimulation();
  }

  /**
   * Initialize physics layer
   * @param config - Physics layer configuration
   */
  private initializePhysicsLayer(config?: PhysicsLayerConfig): void {
    this.physicsLayer = new PhysicsLayer(
      this.timeManager,
      this,
      config || {},
      this.eventManager // Pass event manager to physics layer
    );
  }

  /**
   * Normalize location to object form with guaranteed path
   * @param location - Location (string or DeviceLocation)
   * @returns Normalized DeviceLocation object with guaranteed path
   */
  private normalizeLocation(location: DeviceLocation | string | null | undefined): Exclude<DeviceLocation, string> {
    // Handle null/undefined by returning default location
    if (!location) {
      return { path: 'default' };
    }

    if (typeof location === 'string') {
      return { path: location };
    }

    // It's already an object, return as-is (path is required in object form)
    return location;
  }

  /**
   * Convert string parameter to PhysicalParameter enum
   * @param parameter - Parameter as string or enum
   * @returns PhysicalParameter enum or undefined
   */
  private stringToParameterKey(parameter: PhysicalParameter | string): PhysicalParameter | undefined {
    if (typeof parameter === 'string') {
      // Convert string to enum
      const upperParam = parameter.toUpperCase().replace(/[^A-Z_]/g, '');
      const enumValues = Object.values(PhysicalParameter);
      for (const value of enumValues) {
        if (value.toUpperCase() === upperParam || value === parameter) {
          return value as PhysicalParameter;
        }
      }
      return undefined;
    }
    return parameter;
  }

  /**
   * Get default value for a parameter
   * @param parameter - Physical parameter
   * @returns Default value
   */
  private getDefaultValue(parameter: PhysicalParameter | string): number | boolean {
    const paramStr = String(parameter).toLowerCase();

    // Temperature: 22°C default
    if (paramStr.includes('temperature')) return 22;

    // Humidity: 50% default
    if (paramStr.includes('humidity')) return 50;

    // Light: 500 lux default
    if (paramStr.includes('light')) return 500;

    // Air quality: 50 (moderate)
    if (paramStr.includes('air_quality')) return 50;

    // CO2: 400 ppm default
    if (paramStr.includes('co2')) return 400;

    // PM2.5: 10 µg/m³ default
    if (paramStr.includes('pm2_5') || paramStr.includes('pm25')) return 10;

    // UV index: 5 (moderate)
    if (paramStr.includes('uv')) return 5;

    // Wind speed: 5 m/s default
    if (paramStr.includes('wind_speed')) return 5;

    // Wind direction: 0 degrees (North)
    if (paramStr.includes('wind_direction')) return 0;

    // Pressure: 1013 hPa default
    if (paramStr.includes('pressure')) return 1013;

    // Motion: false default
    if (paramStr.includes('motion')) return false;

    // Presence: false default
    if (paramStr.includes('presence')) return false;

    // Energy consumption: 0 W default
    if (paramStr.includes('energy')) return 0;

    // Power: 0 W default
    if (paramStr.includes('power')) return 0;

    // Voltage: 120 V default
    if (paramStr.includes('voltage')) return 120;

    // Current: 0 A default
    if (paramStr.includes('current')) return 0;

    // Noise level: 40 dB default
    if (paramStr.includes('noise')) return 40;

    // Rainfall: 0 mm default
    if (paramStr.includes('rain')) return 0;

    // Soil moisture: 30% default
    if (paramStr.includes('soil_moisture')) return 30;

    // Elevation: 0 m default
    if (paramStr.includes('elevation')) return 0;

    // Default: 0
    return 0;
  }

  /**
   * Initialize default value models for common parameters
   */
  private initializeDefaultModels(): void {

    // ============================================================================
    // ENVIRONMENTAL PARAMETERS (Comfort)
    // ============================================================================

    // Temperature: Daily cycle, 22°C base, 5°C amplitude, peak at 2 PM
    this.registerValueModel(
      PhysicalParameter.TEMPERATURE,
      new DailyCycleModel({
        base: 22,
        amplitude: 5,
        peakHour: 14, // 2 PM
        noiseLevel: 0.5,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Humidity: Daily cycle, 50% base, 20% amplitude, peak at 6 AM
    this.registerValueModel(
      PhysicalParameter.HUMIDITY,
      new DailyCycleModel({
        base: 50,
        amplitude: 20,
        peakHour: 6, // 6 AM
        noiseLevel: 2,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Pressure: Simple noise model
    this.registerValueModel(
      PhysicalParameter.PRESSURE,
      new SimpleFunctionModel({
        base: 1013,
        noiseLevel: 5,
      })
    );

    // Light: Day/night cycle
    this.registerValueModel(
      PhysicalParameter.LIGHT,
      new DailyCycleModel({
        base: 500,
        amplitude: 450,
        peakHour: 12, // Noon
        noiseLevel: 50,
        minValue: 0,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // ============================================================================
    // AIR QUALITY PARAMETERS
    // ============================================================================

    // Air quality: Simple noise model
    this.registerValueModel(
      PhysicalParameter.AIR_QUALITY,
      new SimpleFunctionModel({
        base: 50,
        noiseLevel: 10,
        minValue: 0,
        maxValue: 500,
      })
    );

    // CO2: Simple noise model
    this.registerValueModel(
      PhysicalParameter.CO2,
      new SimpleFunctionModel({
        base: 400,
        noiseLevel: 50,
        minValue: 300,
      })
    );

    // PM2.5: Simple noise model
    this.registerValueModel(
      PhysicalParameter.PM25,
      new SimpleFunctionModel({
        base: 10,
        noiseLevel: 5,
        minValue: 0,
      })
    );

    // PM10: Simple noise model
    this.registerValueModel(
      PhysicalParameter.PM10,
      new SimpleFunctionModel({
        base: 20,
        noiseLevel: 8,
        minValue: 0,
      })
    );

    // VOC: Simple noise model
    this.registerValueModel(
      PhysicalParameter.VOC,
      new SimpleFunctionModel({
        base: 100,
        noiseLevel: 30,
        minValue: 0,
      })
    );

    // NO2: Simple noise model
    this.registerValueModel(
      PhysicalParameter.NO2,
      new SimpleFunctionModel({
        base: 20,
        noiseLevel: 5,
        minValue: 0,
      })
    );

    // SO2: Simple noise model
    this.registerValueModel(
      PhysicalParameter.SO2,
      new SimpleFunctionModel({
        base: 5,
        noiseLevel: 2,
        minValue: 0,
      })
    );

    // O3: Daily cycle
    this.registerValueModel(
      PhysicalParameter.O3,
      new DailyCycleModel({
        base: 30,
        amplitude: 20,
        peakHour: 15, // 3 PM
        noiseLevel: 5,
        minValue: 0,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // CO: Simple noise model
    this.registerValueModel(
      PhysicalParameter.CO,
      new SimpleFunctionModel({
        base: 1,
        noiseLevel: 0.5,
        minValue: 0,
      })
    );

    // Formaldehyde: Simple noise model
    this.registerValueModel(
      PhysicalParameter.FORMALDEHYDE,
      new SimpleFunctionModel({
        base: 0.02,
        noiseLevel: 0.01,
        minValue: 0,
      })
    );

    // ============================================================================
    // WEATHER PARAMETERS
    // ============================================================================

    // UV index: Daily cycle
    this.registerValueModel(
      PhysicalParameter.UV_INDEX,
      new DailyCycleModel({
        base: 3,
        amplitude: 4,
        peakHour: 12, // Noon
        noiseLevel: 0.5,
        minValue: 0,
        maxValue: 15,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Wind speed: Simple noise model
    this.registerValueModel(
      PhysicalParameter.WIND_SPEED,
      new SimpleFunctionModel({
        base: 5,
        noiseLevel: 3,
        minValue: 0,
      })
    );

    // Wind direction: Random
    this.registerValueModel(
      PhysicalParameter.WIND_DIRECTION,
      new SimpleFunctionModel({
        base: 180,
        noiseLevel: 90,
        minValue: 0,
        maxValue: 360,
      })
    );

    // Rainfall: Simple noise model
    this.registerValueModel(
      PhysicalParameter.RAINFALL,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 1,
        minValue: 0,
      })
    );

    // Visibility: Simple noise model
    this.registerValueModel(
      PhysicalParameter.VISIBILITY,
      new SimpleFunctionModel({
        base: 10,
        noiseLevel: 2,
        minValue: 0,
      })
    );

    // Cloud cover: Daily cycle
    this.registerValueModel(
      PhysicalParameter.CLOUD_COVER,
      new DailyCycleModel({
        base: 50,
        amplitude: 30,
        peakHour: 14,
        noiseLevel: 10,
        minValue: 0,
        maxValue: 100,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Dew point: Daily cycle
    this.registerValueModel(
      PhysicalParameter.DEW_POINT,
      new DailyCycleModel({
        base: 12,
        amplitude: 5,
        peakHour: 5,
        noiseLevel: 1,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Barometric pressure: Simple noise model
    this.registerValueModel(
      PhysicalParameter.BAROMETRIC_PRESSURE,
      new SimpleFunctionModel({
        base: 1013,
        noiseLevel: 3,
      })
    );

    // ============================================================================
    // MOTION & PRESENCE
    // ============================================================================

    // Motion: Boolean (default false)
    this.registerValueModel(
      PhysicalParameter.MOTION,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Presence: Boolean (default false)
    this.registerValueModel(
      PhysicalParameter.PRESENCE,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Occupancy: Daily cycle
    this.registerValueModel(
      PhysicalParameter.OCCUPANCY,
      new DailyCycleModel({
        base: 30,
        amplitude: 30,
        peakHour: 14,
        noiseLevel: 5,
        minValue: 0,
        maxValue: 100,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // People count: Daily cycle
    this.registerValueModel(
      PhysicalParameter.PEOPLE_COUNT,
      new DailyCycleModel({
        base: 2,
        amplitude: 2,
        peakHour: 14,
        noiseLevel: 1,
        minValue: 0,
        maxValue: 20,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // ============================================================================
    // ENERGY PARAMETERS
    // ============================================================================

    // Energy consumption: Daily cycle
    this.registerValueModel(
      PhysicalParameter.ENERGY_CONSUMPTION,
      new DailyCycleModel({
        base: 5,
        amplitude: 3,
        peakHour: 19,
        noiseLevel: 1,
        minValue: 0,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Power: Simple noise model
    this.registerValueModel(
      PhysicalParameter.POWER,
      new SimpleFunctionModel({
        base: 500,
        noiseLevel: 100,
        minValue: 0,
      })
    );

    // Voltage: Simple noise model
    this.registerValueModel(
      PhysicalParameter.VOLTAGE,
      new SimpleFunctionModel({
        base: 120,
        noiseLevel: 2,
        minValue: 110,
        maxValue: 130,
      })
    );

    // Current: Simple noise model
    this.registerValueModel(
      PhysicalParameter.CURRENT,
      new SimpleFunctionModel({
        base: 5,
        noiseLevel: 1,
        minValue: 0,
      })
    );

    // Frequency: Simple noise model
    this.registerValueModel(
      PhysicalParameter.FREQUENCY,
      new SimpleFunctionModel({
        base: 60,
        noiseLevel: 0.1,
        minValue: 59,
        maxValue: 61,
      })
    );

    // Power factor: Simple noise model
    this.registerValueModel(
      PhysicalParameter.POWER_FACTOR,
      new SimpleFunctionModel({
        base: 0.9,
        noiseLevel: 0.05,
        minValue: 0,
        maxValue: 1,
      })
    );

    // ============================================================================
    // SAFETY & SECURITY
    // ============================================================================

    // Noise level: Simple noise model
    this.registerValueModel(
      PhysicalParameter.NOISE_LEVEL,
      new SimpleFunctionModel({
        base: 40,
        noiseLevel: 10,
        minValue: 0,
      })
    );

    // Vibration: Simple noise model
    this.registerValueModel(
      PhysicalParameter.VIBRATION,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0.1,
        minValue: 0,
      })
    );

    // Smoke: Simple noise model
    this.registerValueModel(
      PhysicalParameter.SMOKE,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0.5,
        minValue: 0,
      })
    );

    // Gas leak: Simple noise model
    this.registerValueModel(
      PhysicalParameter.GAS_LEAK,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0.1,
        minValue: 0,
      })
    );

    // Door state: Boolean (default false/closed)
    this.registerValueModel(
      PhysicalParameter.DOOR_STATE,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Window state: Boolean (default false/closed)
    this.registerValueModel(
      PhysicalParameter.WINDOW_STATE,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Alarm status: Simple noise model
    this.registerValueModel(
      PhysicalParameter.ALARM_STATUS,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // ============================================================================
    // INDOOR ENVIRONMENT
    // ============================================================================

    // Indoor CO2: Daily cycle
    this.registerValueModel(
      PhysicalParameter.CO2_INDOOR,
      new DailyCycleModel({
        base: 450,
        amplitude: 150,
        peakHour: 16,
        noiseLevel: 30,
        minValue: 300,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Indoor PM2.5: Simple noise model
    this.registerValueModel(
      PhysicalParameter.PM25_INDOOR,
      new SimpleFunctionModel({
        base: 8,
        noiseLevel: 3,
        minValue: 0,
      })
    );

    // TVOC: Simple noise model
    this.registerValueModel(
      PhysicalParameter.TVOC,
      new SimpleFunctionModel({
        base: 150,
        noiseLevel: 40,
        minValue: 0,
      })
    );

    // Radon: Simple noise model
    this.registerValueModel(
      PhysicalParameter.RADON,
      new SimpleFunctionModel({
        base: 50,
        noiseLevel: 20,
        minValue: 0,
      })
    );

    // Mold risk: Daily cycle
    this.registerValueModel(
      PhysicalParameter.MOLD_RISK,
      new DailyCycleModel({
        base: 20,
        amplitude: 15,
        peakHour: 6,
        noiseLevel: 3,
        minValue: 0,
        maxValue: 100,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // ============================================================================
    // ACOUSTIC PARAMETERS
    // ============================================================================

    // Sound level: Same as noise level
    this.registerValueModel(
      PhysicalParameter.SOUND_LEVEL,
      new SimpleFunctionModel({
        base: 40,
        noiseLevel: 10,
        minValue: 0,
      })
    );

    // Sound pressure: Simple noise model
    this.registerValueModel(
      PhysicalParameter.SOUND_PRESSURE,
      new SimpleFunctionModel({
        base: 0.02,
        noiseLevel: 0.01,
        minValue: 0,
      })
    );

    // Reverberation time: Simple noise model
    this.registerValueModel(
      PhysicalParameter.REVERBERATION_TIME,
      new SimpleFunctionModel({
        base: 0.8,
        noiseLevel: 0.2,
        minValue: 0,
      })
    );

    // ============================================================================
    // WATER PARAMETERS
    // ============================================================================

    // Water temperature: Daily cycle
    this.registerValueModel(
      PhysicalParameter.WATER_TEMPERATURE,
      new DailyCycleModel({
        base: 18,
        amplitude: 3,
        peakHour: 16,
        noiseLevel: 1,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Water level: Simple noise model
    this.registerValueModel(
      PhysicalParameter.WATER_LEVEL,
      new SimpleFunctionModel({
        base: 2,
        noiseLevel: 0.2,
        minValue: 0,
      })
    );

    // Water flow: Simple noise model
    this.registerValueModel(
      PhysicalParameter.WATER_FLOW,
      new SimpleFunctionModel({
        base: 5,
        noiseLevel: 1,
        minValue: 0,
      })
    );

    // Water pressure: Simple noise model
    this.registerValueModel(
      PhysicalParameter.WATER_PRESSURE,
      new SimpleFunctionModel({
        base: 3,
        noiseLevel: 0.5,
        minValue: 0,
      })
    );

    // pH level: Simple noise model
    this.registerValueModel(
      PhysicalParameter.PH_LEVEL,
      new SimpleFunctionModel({
        base: 7,
        noiseLevel: 0.5,
        minValue: 0,
        maxValue: 14,
      })
    );

    // TDS: Simple noise model
    this.registerValueModel(
      PhysicalParameter.TDS,
      new SimpleFunctionModel({
        base: 100,
        noiseLevel: 20,
        minValue: 0,
      })
    );

    // Turbidity: Simple noise model
    this.registerValueModel(
      PhysicalParameter.TURBIDITY,
      new SimpleFunctionModel({
        base: 1,
        noiseLevel: 0.5,
        minValue: 0,
      })
    );

    // ============================================================================
    // OUTDOOR/AGRICULTURAL
    // ============================================================================

    // Soil moisture: Daily cycle
    this.registerValueModel(
      PhysicalParameter.SOIL_MOISTURE,
      new DailyCycleModel({
        base: 30,
        amplitude: 15,
        peakHour: 6,
        noiseLevel: 3,
        minValue: 0,
        maxValue: 100,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Soil temperature: Daily cycle
    this.registerValueModel(
      PhysicalParameter.SOIL_TEMPERATURE,
      new DailyCycleModel({
        base: 18,
        amplitude: 5,
        peakHour: 15,
        noiseLevel: 1,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Soil pH: Simple noise model
    this.registerValueModel(
      PhysicalParameter.SOIL_PH,
      new SimpleFunctionModel({
        base: 6.5,
        noiseLevel: 0.5,
        minValue: 0,
        maxValue: 14,
      })
    );

    // Leaf wetness: Daily cycle
    this.registerValueModel(
      PhysicalParameter.LEAF_WETNESS,
      new DailyCycleModel({
        base: 30,
        amplitude: 30,
        peakHour: 6,
        noiseLevel: 5,
        minValue: 0,
        maxValue: 100,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Evapotranspiration: Daily cycle
    this.registerValueModel(
      PhysicalParameter.EVAPOTRANSPIRATION,
      new DailyCycleModel({
        base: 2,
        amplitude: 2,
        peakHour: 14,
        noiseLevel: 0.3,
        minValue: 0,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Solar radiation: Daily cycle
    this.registerValueModel(
      PhysicalParameter.SOLAR_RADIATION,
      new DailyCycleModel({
        base: 250,
        amplitude: 250,
        peakHour: 12,
        noiseLevel: 30,
        minValue: 0,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // ============================================================================
    // LOCATION & POSITIONING
    // ============================================================================

    // Elevation: Simple constant
    this.registerValueModel(
      PhysicalParameter.ELEVATION,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Latitude: Simple constant
    this.registerValueModel(
      PhysicalParameter.LATITUDE,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Longitude: Simple constant
    this.registerValueModel(
      PhysicalParameter.LONGITUDE,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Altitude: Simple constant
    this.registerValueModel(
      PhysicalParameter.ALTITUDE,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Depth: Simple constant
    this.registerValueModel(
      PhysicalParameter.DEPTH,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // ============================================================================
    // COMFORT PARAMETERS
    // ============================================================================

    // Comfort index: Daily cycle
    this.registerValueModel(
      PhysicalParameter.COMFORT_INDEX,
      new DailyCycleModel({
        base: 70,
        amplitude: 15,
        peakHour: 14,
        noiseLevel: 5,
        minValue: 0,
        maxValue: 100,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Heat index: Daily cycle
    this.registerValueModel(
      PhysicalParameter.HEAT_INDEX,
      new DailyCycleModel({
        base: 22,
        amplitude: 5,
        peakHour: 15,
        noiseLevel: 1,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Wind chill: Daily cycle
    this.registerValueModel(
      PhysicalParameter.WIND_CHILL,
      new DailyCycleModel({
        base: 20,
        amplitude: 5,
        peakHour: 5,
        noiseLevel: 1,
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // ============================================================================
    // DEVICE STATUS
    // ============================================================================

    // Battery level: Simple noise model
    this.registerValueModel(
      PhysicalParameter.BATTERY_LEVEL,
      new SimpleFunctionModel({
        base: 100,
        noiseLevel: 0,
        minValue: 0,
        maxValue: 100,
      })
    );

    // Signal strength: Simple noise model
    this.registerValueModel(
      PhysicalParameter.SIGNAL_STRENGTH,
      new SimpleFunctionModel({
        base: -50,
        noiseLevel: 5,
        maxValue: 0,
      })
    );

    // Connection status: Boolean (default true)
    this.registerValueModel(
      PhysicalParameter.CONNECTION_STATUS,
      new SimpleFunctionModel({
        base: 1,
        noiseLevel: 0,
      })
    );

    // Operating temperature: Simple noise model
    this.registerValueModel(
      PhysicalParameter.OPERATING_TEMP,
      new SimpleFunctionModel({
        base: 35,
        noiseLevel: 2,
      })
    );

    // Runtime hours: Simple increasing model (base = 0, will be managed by device)
    this.registerValueModel(
      PhysicalParameter.RUNTIME_HOURS,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );
  }
}

// Re-export types for convenience
export type { DeviceLocation, ValueModel, PhysicalEnvironmentConfig } from '../devices/types.js';
export { PhysicalParameter } from '../devices/types.js';
