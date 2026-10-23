/**
 * Physical Environment
 *
 * Models physical parameters (temperature, humidity, light, etc.)
 * across space and time for IoT device simulation.
 */

import { TimeManager } from './TimeManager.js';
import type { DeviceLocation, ValueModel, PhysicalEnvironmentConfig, ParameterEffectDeclaration } from '../devices/types.js';
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
  /**
   * R41-F1: unknown-parameter warns deduped per parameter — a scenario
   * event carrying a physics-unknown key (wind/status) used to warn on
   * EVERY evaluation (242k lines / 31MB in one 25-min collab run,
   * drowning real WARNs). Same discipline as StateInterpolator.warnedKeys.
   */
  private readonly warnedUnknownParams = new Set<string>();

  private warnUnknownParameterOnce(parameter: PhysicalParameter | string, suffix = ''): void {
    const key = `${String(parameter)}${suffix}`;
    if (this.warnedUnknownParams.has(key)) return;
    this.warnedUnknownParams.add(key);
    logger.warn(`Unknown parameter: ${key} (further occurrences suppressed)`);
  }

  private timeManager: TimeManager;
  private valueModels: Map<PhysicalParameter, ValueModel>;
  private config: PhysicalEnvironmentConfig;
  private physicsLayer?: PhysicsLayer;
  private disablePhysicsCheck: boolean = false; // Flag to prevent circular dependency
  private eventManager?: EventManager; // EventManager for emitting environment change events
  /**
   * T-304: custom (non-enum) parameter store — STATIC fields. Keys outside
   * the PhysicalParameter enum (e.g. 'powerW', 'pvOutputW', occupancy
   * counters — any domain quantity a scenario declares as a zone baseline)
   * hold their value until written again: no relaxation physics, no coupling
   * with the standard models (the enum-only physics stays untouched).
   * Shape: parameter name → location path → value, plus a global entry
   * ('*') written by the legacy zone-agnostic setParameterValue path.
   */
  private readonly customParameterValues = new Map<string, Map<string, number | boolean>>();

  /**
   * FEAT-03 (stage 2): device-coupling declarations, filtered at intake —
   * only couplings onto keys DECLARED in `parameterPhysics` are honored
   * (undeclared keys keep the T-304 static semantics; standard enum
   * parameters keep their dedicated physics). Scenario files get a teaching
   * rejection at LOAD (scenario-loader); this filter is the defense-in-depth
   * for direct PhysicalEnvironment construction.
   */
  private readonly parameterEffectDeclarations: ParameterEffectDeclaration[];

  constructor(timeManager: TimeManager, config: PhysicalEnvironmentConfig = {}) {
    this.timeManager = timeManager;
    this.valueModels = new Map();
    this.config = config;

    logger.info('Initialized', {
      physics: config.enablePhysics !== false,
      simDuration: `${this.getSimDurationSeconds()}s per command`,
    });

    this.initializeDefaultModels();

    this.parameterEffectDeclarations = this.filterParameterEffectDeclarations(config);

    // Initialize physics layer if enabled
    if (config.enablePhysics !== false) {
      this.initializePhysicsLayer(config.physicsConfig);
    }
    this.applyCustomParameterPhysicsRates();
  }

  /**
   * FEAT-03 (stage 2): keep only couplings whose target is a DECLARED custom
   * parameter — an undeclared target would silently never move (static
   * store, T-304) and an enum target would fight the parameter's dedicated
   * physics. Dropped entries warn once each with the fix.
   */
  private filterParameterEffectDeclarations(config: PhysicalEnvironmentConfig): ParameterEffectDeclaration[] {
    const declared = config.parameterPhysics ?? {};
    const kept: ParameterEffectDeclaration[] = [];
    for (const effect of config.parameterEffects ?? []) {
      if (this.stringToParameterKey(effect.zoneParameter) !== undefined) {
        logger.warn(
          `parameterEffects: zoneParameter '${effect.zoneParameter}' is a standard parameter ` +
          `with its own dedicated physics — coupling dropped (parameterEffects only targets ` +
          `custom parameters declared in parameterPhysics)`,
        );
        continue;
      }
      if (declared[effect.zoneParameter] === undefined) {
        logger.warn(
          `parameterEffects: zoneParameter '${effect.zoneParameter}' is not declared in ` +
          `parameterPhysics — coupling dropped (custom parameters are static unless opted ` +
          `into field dynamics)`,
        );
        continue;
      }
      if (typeof effect.ratePerSec !== 'number' || !Number.isFinite(effect.ratePerSec)) {
        logger.warn(
          `parameterEffects: coupling onto '${effect.zoneParameter}' has a non-finite ` +
          `ratePerSec — dropped`,
        );
        continue;
      }
      kept.push({ ...effect });
    }
    return kept;
  }

  /**
   * FEAT-03 (stage 2): the intake-filtered device-coupling declarations.
   * SimulatedDevice consults them at command time to register a
   * `parameter_rate` effect for every declaration its capabilities/type
   * match while it is ON (turn-off unregisters through the standard
   * all-effects path).
   */
  getParameterEffectDeclarations(): readonly ParameterEffectDeclaration[] {
    return this.parameterEffectDeclarations;
  }

  /**
   * FEAT-03: pin the declared `relaxRatePerSec` of every `parameterPhysics`
   * key onto the field (runtime per-parameter rate override). Re-applied
   * whenever the physics layer is rebuilt (setEventManager).
   */
  private applyCustomParameterPhysicsRates(): void {
    if (!this.physicsLayer) return;
    for (const [key, physics] of Object.entries(this.config.parameterPhysics ?? {})) {
      const rate = physics.relaxRatePerSec;
      if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) {
        this.physicsLayer.setParameterRelaxationRate(key, rate);
      }
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
      this.applyCustomParameterPhysicsRates();
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
      // T-304: custom (non-enum) parameters read from the static store —
      // no more warn-and-drop. Unseeded keys read as 0 (a declared-baseline
      // key is always seeded by the caller that declares it).
      const customKey = typeof parameter === 'string' ? parameter : undefined;
      if (customKey !== undefined) {
        // FEAT-03: a key declared in `parameterPhysics` lives in the spatial
        // field (relaxation dynamics) — sample it first, exactly like the
        // enum path. Skipped while disablePhysicsCheck is set (the field's
        // own attractor probe must not read the field back as its target).
        if (
          this.config.parameterPhysics?.[customKey] !== undefined &&
          this.physicsLayer && !this.disablePhysicsCheck
        ) {
          const fieldValue = this.physicsLayer.getLocalParameterValue(customKey, deviceLocation);
          if (fieldValue !== undefined) return fieldValue;
        }
        const stored = this.readCustomParameterValue(customKey, deviceLocation.path);
        if (stored !== undefined) return stored;
      }
      this.warnUnknownParameterOnce(parameter, ', using default');
      return this.getDefaultValue(parameter);
    }

    // If physics layer is enabled and physics check is not disabled, sample
    // the SPATIAL FIELD first: a location-scoped value always wins over the
    // global value model.
    if (this.physicsLayer && !this.disablePhysicsCheck) {
      const fieldValue = this.physicsLayer.getLocalParameterValue(paramKey, deviceLocation);
      if (fieldValue !== undefined) {
        return fieldValue;
      }

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
   * Registration path for the built-in default models. Unless environmental
   * noise was explicitly opted into (`config.environmentNoise === true`),
   * the model's per-read Gaussian noise is silenced so an undeclared
   * parameter starts at its deterministic base value — a fresh world is
   * never "dirty" by default. Custom models registered through the public
   * `registerValueModel` are untouched (their randomness is the caller's
   * explicit choice).
   */
  private registerDefaultModel(parameter: PhysicalParameter, model: ValueModel): void {
    if (this.config.environmentNoise !== true) {
      (model as { setNoiseLevel?: (noiseLevel: number) => void }).setNoiseLevel?.(0);
    }
    this.registerValueModel(parameter, model);
  }

  /**
   * Set parameter value at location (for testing and device effects)
   * Creates a simple function model that returns the specified value.
   *
   * LEGACY GLOBAL WRITE: the value model is zone-agnostic — the location
   * argument is ignored and every location reads this value. A global write
   * also INVALIDATES the spatial field for this parameter (field values are
   * dropped, seeded baselines survive): a global write is an override, and
   * this keeps reset-to-baseline semantics exact for callers such as the
   * experiment runner. Use `setLocalParameterValue()` for spatial writes.
   *
   * @param parameter - Physical parameter to set
   * @param location - Device location (not used for simple values)
   * @param value - Value to set
   */
  setParameterValue(parameter: PhysicalParameter | string, location: DeviceLocation | string, value: number | boolean): void {
    const paramKey = this.stringToParameterKey(parameter);
    if (!paramKey) {
      // T-304: custom parameters land in the static store (global write —
      // the location is ignored, matching this method's legacy semantics).
      if (typeof parameter === 'string') {
        this.writeCustomParameterValue(parameter, '*', value);
        return;
      }
      this.warnUnknownParameterOnce(parameter);
      return;
    }

    // A global write overrides the spatial field for this parameter.
    this.physicsLayer?.clearLocalParameter(paramKey);

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
   * Set parameter value at/around a location WITHOUT touching the global
   * value model (spatial write).
   *
   * The value lands in the physics layer's per-location field; subsequent
   * `getParameterValue(parameter, location)` calls sample the field first.
   * With `radius` > 0, nearby known locations receive a delta-based,
   * falloff-attenuated share of the write.
   *
   * Falls back to a legacy global write when physics is disabled.
   *
   * @param parameter - Physical parameter to set
   * @param location - Location to write at
   * @param value - Value to set (booleans stored as 1/0)
   * @param radius - Optional spillover radius in meters (default 0: point write)
   */
  setLocalParameterValue(
    parameter: PhysicalParameter | string,
    location: DeviceLocation | string,
    value: number | boolean,
    radius: number = 0,
  ): void {
    const paramKey = this.stringToParameterKey(parameter);
    if (!paramKey) {
      // T-304: custom parameters are STATIC point values — a spatial write
      // is just a per-location store write (no radius falloff physics).
      if (typeof parameter === 'string') {
        // FEAT-03: a key declared in `parameterPhysics` takes the field path
        // (relaxation dynamics) instead of the static store.
        if (this.config.parameterPhysics?.[parameter] !== undefined && this.physicsLayer) {
          this.physicsLayer.setLocalParameterValue(parameter, location, value, radius);
          return;
        }
        this.writeCustomParameterValue(
          parameter,
          this.normalizeLocation(location).path,
          value,
        );
        return;
      }
      this.warnUnknownParameterOnce(parameter);
      return;
    }

    if (!this.physicsLayer) {
      logger.warn('Physics layer not enabled, falling back to global write');
      this.setParameterValue(paramKey, location, value);
      return;
    }

    this.physicsLayer.setLocalParameterValue(paramKey, location, value, radius);
  }

  /**
   * Seed a per-location environmental baseline: the value the field relaxes
   * toward at this location. Also writes the current field value, so a
   * freshly seeded zone starts AT its baseline. Does not touch the global
   * value model. No-op when physics is disabled.
   */
  setParameterBaseline(
    parameter: PhysicalParameter | string,
    location: DeviceLocation | string,
    value: number | boolean,
  ): void {
    const paramKey = this.stringToParameterKey(parameter);
    if (!paramKey) {
      // T-304: a custom-parameter baseline is its (static) value — seeding
      // writes it so a freshly declared zone starts AT its baseline, exactly
      // like the enum path.
      if (typeof parameter === 'string') {
        // FEAT-03: a declared key seeds the FIELD baseline (the relaxation
        // attractor) instead. `relaxToBaseline: false` writes only the
        // current value — no attractor, so the value holds until rewritten.
        const declared = this.config.parameterPhysics?.[parameter];
        if (declared !== undefined && this.physicsLayer) {
          if (declared.relaxToBaseline !== false) {
            this.physicsLayer.setParameterBaseline(parameter, location, value);
          }
          this.physicsLayer.setLocalParameterValue(parameter, location, value, 0);
          return;
        }
        const path = this.normalizeLocation(location).path;
        this.writeCustomParameterValue(parameter, path, value);
        return;
      }
      this.warnUnknownParameterOnce(parameter);
      return;
    }
    if (!this.physicsLayer) return;

    this.physicsLayer.setParameterBaseline(paramKey, location, value);
    this.physicsLayer.setLocalParameterValue(paramKey, location, value, 0);
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

            // AC feedback control: stop the device effects in the GOAL zone
            // (HVAC stops). Fix-21: this used to clear ALL device effects
            // globally, killing unrelated thermostats in other zones; now
            // only effects affecting the goal location are removed.
            const removed = this.physicsLayer.clearDeviceEffectsForLocation(goal.location);
            if (removed === 0) {
              logger.warn(
                `AC feedback: goal reached at '${goal.location}' but no device ` +
                `effects matched that location — devices keep their current effects`,
              );
            }
            logger.info('Goal-zone device effects removed (AC feedback: target reached, devices stopped)');

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
   * R44-insane §11.6: memoized resolution of parameter-name strings. The
   * resolver itself re-allocated `Object.values(PhysicalParameter)` and
   * re-normalized the string per call — and it sits under EVERY
   * getParameterValue (each sensor samples several parameters per tick;
   * thousands of devices → millions of calls per simulated hour). The
   * distinct parameter strings in a world number in the dozens, so a
   * module-level Map cache turns every hit into one hash lookup. Misses run
   * the ORIGINAL loop unchanged, so resolution semantics are identical.
   */
  private static readonly parameterKeyCache = new Map<string, PhysicalParameter | undefined>();

  /**
   * Convert string parameter to PhysicalParameter enum
   * @param parameter - Parameter as string or enum
   * @returns PhysicalParameter enum or undefined
   */
  private stringToParameterKey(parameter: PhysicalParameter | string): PhysicalParameter | undefined {
    if (typeof parameter === 'string') {
      if (PhysicalEnvironment.parameterKeyCache.has(parameter)) {
        return PhysicalEnvironment.parameterKeyCache.get(parameter);
      }
      // Convert string to enum (legacy loop, verbatim)
      const upperParam = parameter.toUpperCase().replace(/[^A-Z_]/g, '');
      const enumValues = Object.values(PhysicalParameter);
      for (const value of enumValues) {
        if (value.toUpperCase() === upperParam || value === parameter) {
          PhysicalEnvironment.parameterKeyCache.set(parameter, value as PhysicalParameter);
          return value as PhysicalParameter;
        }
      }
      PhysicalEnvironment.parameterKeyCache.set(parameter, undefined);
      return undefined;
    }
    return parameter;
  }

  /**
   * T-304: custom-parameter store accessors. Static semantics: a write
   * replaces the value; nothing relaxes, decays, or couples — the value
   * holds until the next write. '*' is the global (location-agnostic) entry
   * used by the legacy setParameterValue path.
   */
  private writeCustomParameterValue(key: string, path: string, value: number | boolean): void {
    let byLocation = this.customParameterValues.get(key);
    if (byLocation === undefined) {
      byLocation = new Map();
      this.customParameterValues.set(key, byLocation);
    }
    byLocation.set(path, value);
  }

  private readCustomParameterValue(key: string, path: string): number | boolean | undefined {
    const byLocation = this.customParameterValues.get(key);
    if (byLocation === undefined) return undefined;
    return byLocation.get(path) ?? byLocation.get('*');
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

    // Temperature: Daily cycle, 18°C base, 5°C daily amplitude, peak at 2 PM.
    // Fix-50d: seasonal amplitude 12°C — January averages ~6°C, July ~30°C.
    // The daily sinusoid rides on the seasonal baseline; scenario baselines
    // (zone `baseline.temperature`) override this model per-zone, so worlds
    // with explicit per-zone baselines are unaffected.
    this.registerDefaultModel(
      PhysicalParameter.TEMPERATURE,
      new DailyCycleModel({
        base: 18,
        amplitude: 5,
        peakHour: 14, // 2 PM
        noiseLevel: 0.5,
        seasonalAmplitude: 12, // Fix-50d: winter -12°C, summer +12°C
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Humidity: Daily cycle, 50% base, 20% amplitude, peak at 6 AM.
    // Fix-50d: slight seasonal tilt — winter is drier (indoor heating).
    this.registerDefaultModel(
      PhysicalParameter.HUMIDITY,
      new DailyCycleModel({
        base: 50,
        amplitude: 20,
        peakHour: 6, // 6 AM
        noiseLevel: 2,
        seasonalAmplitude: 5, // winter -5%, summer +5%
        enableSpatialVariation: this.config.enableSpatialVariation ?? true,
      })
    );

    // Pressure: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.PRESSURE,
      new SimpleFunctionModel({
        base: 1013,
        noiseLevel: 5,
      })
    );

    // Light: Day/night cycle
    this.registerDefaultModel(
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
    this.registerDefaultModel(
      PhysicalParameter.AIR_QUALITY,
      new SimpleFunctionModel({
        base: 50,
        noiseLevel: 10,
        minValue: 0,
        maxValue: 500,
      })
    );

    // CO2: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.CO2,
      new SimpleFunctionModel({
        base: 400,
        noiseLevel: 50,
        minValue: 300,
      })
    );

    // PM2.5: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.PM25,
      new SimpleFunctionModel({
        base: 10,
        noiseLevel: 5,
        minValue: 0,
      })
    );

    // PM10: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.PM10,
      new SimpleFunctionModel({
        base: 20,
        noiseLevel: 8,
        minValue: 0,
      })
    );

    // VOC: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.VOC,
      new SimpleFunctionModel({
        base: 100,
        noiseLevel: 30,
        minValue: 0,
      })
    );

    // NO2: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.NO2,
      new SimpleFunctionModel({
        base: 20,
        noiseLevel: 5,
        minValue: 0,
      })
    );

    // SO2: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.SO2,
      new SimpleFunctionModel({
        base: 5,
        noiseLevel: 2,
        minValue: 0,
      })
    );

    // O3: Daily cycle
    this.registerDefaultModel(
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
    this.registerDefaultModel(
      PhysicalParameter.CO,
      new SimpleFunctionModel({
        base: 1,
        noiseLevel: 0.5,
        minValue: 0,
      })
    );

    // Formaldehyde: Simple noise model
    this.registerDefaultModel(
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
    this.registerDefaultModel(
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
    this.registerDefaultModel(
      PhysicalParameter.WIND_SPEED,
      new SimpleFunctionModel({
        base: 5,
        noiseLevel: 3,
        minValue: 0,
      })
    );

    // Wind direction: Random
    this.registerDefaultModel(
      PhysicalParameter.WIND_DIRECTION,
      new SimpleFunctionModel({
        base: 180,
        noiseLevel: 90,
        minValue: 0,
        maxValue: 360,
      })
    );

    // Rainfall: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.RAINFALL,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 1,
        minValue: 0,
      })
    );

    // Visibility: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.VISIBILITY,
      new SimpleFunctionModel({
        base: 10,
        noiseLevel: 2,
        minValue: 0,
      })
    );

    // Cloud cover: Daily cycle
    this.registerDefaultModel(
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
    this.registerDefaultModel(
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
    this.registerDefaultModel(
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
    this.registerDefaultModel(
      PhysicalParameter.MOTION,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Presence: Boolean (default false)
    this.registerDefaultModel(
      PhysicalParameter.PRESENCE,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Occupancy: Daily cycle
    this.registerDefaultModel(
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
    this.registerDefaultModel(
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
    this.registerDefaultModel(
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
    this.registerDefaultModel(
      PhysicalParameter.POWER,
      new SimpleFunctionModel({
        base: 500,
        noiseLevel: 100,
        minValue: 0,
      })
    );

    // Voltage: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.VOLTAGE,
      new SimpleFunctionModel({
        base: 120,
        noiseLevel: 2,
        minValue: 110,
        maxValue: 130,
      })
    );

    // Current: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.CURRENT,
      new SimpleFunctionModel({
        base: 5,
        noiseLevel: 1,
        minValue: 0,
      })
    );

    // Frequency: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.FREQUENCY,
      new SimpleFunctionModel({
        base: 60,
        noiseLevel: 0.1,
        minValue: 59,
        maxValue: 61,
      })
    );

    // Power factor: Simple noise model
    this.registerDefaultModel(
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
    this.registerDefaultModel(
      PhysicalParameter.NOISE_LEVEL,
      new SimpleFunctionModel({
        base: 40,
        noiseLevel: 10,
        minValue: 0,
      })
    );

    // Vibration: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.VIBRATION,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0.1,
        minValue: 0,
      })
    );

    // Smoke: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.SMOKE,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0.5,
        minValue: 0,
      })
    );

    // Gas leak: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.GAS_LEAK,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0.1,
        minValue: 0,
      })
    );

    // Door state: Boolean (default false/closed)
    this.registerDefaultModel(
      PhysicalParameter.DOOR_STATE,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Window state: Boolean (default false/closed)
    this.registerDefaultModel(
      PhysicalParameter.WINDOW_STATE,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Alarm status: Simple noise model
    this.registerDefaultModel(
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
    this.registerDefaultModel(
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
    this.registerDefaultModel(
      PhysicalParameter.PM25_INDOOR,
      new SimpleFunctionModel({
        base: 8,
        noiseLevel: 3,
        minValue: 0,
      })
    );

    // TVOC: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.TVOC,
      new SimpleFunctionModel({
        base: 150,
        noiseLevel: 40,
        minValue: 0,
      })
    );

    // Radon: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.RADON,
      new SimpleFunctionModel({
        base: 50,
        noiseLevel: 20,
        minValue: 0,
      })
    );

    // Mold risk: Daily cycle
    this.registerDefaultModel(
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
    this.registerDefaultModel(
      PhysicalParameter.SOUND_LEVEL,
      new SimpleFunctionModel({
        base: 40,
        noiseLevel: 10,
        minValue: 0,
      })
    );

    // Sound pressure: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.SOUND_PRESSURE,
      new SimpleFunctionModel({
        base: 0.02,
        noiseLevel: 0.01,
        minValue: 0,
      })
    );

    // Reverberation time: Simple noise model
    this.registerDefaultModel(
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
    this.registerDefaultModel(
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
    this.registerDefaultModel(
      PhysicalParameter.WATER_LEVEL,
      new SimpleFunctionModel({
        base: 2,
        noiseLevel: 0.2,
        minValue: 0,
      })
    );

    // Water flow: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.WATER_FLOW,
      new SimpleFunctionModel({
        base: 5,
        noiseLevel: 1,
        minValue: 0,
      })
    );

    // Water pressure: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.WATER_PRESSURE,
      new SimpleFunctionModel({
        base: 3,
        noiseLevel: 0.5,
        minValue: 0,
      })
    );

    // pH level: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.PH_LEVEL,
      new SimpleFunctionModel({
        base: 7,
        noiseLevel: 0.5,
        minValue: 0,
        maxValue: 14,
      })
    );

    // TDS: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.TDS,
      new SimpleFunctionModel({
        base: 100,
        noiseLevel: 20,
        minValue: 0,
      })
    );

    // Turbidity: Simple noise model
    this.registerDefaultModel(
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
    this.registerDefaultModel(
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
    this.registerDefaultModel(
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
    this.registerDefaultModel(
      PhysicalParameter.SOIL_PH,
      new SimpleFunctionModel({
        base: 6.5,
        noiseLevel: 0.5,
        minValue: 0,
        maxValue: 14,
      })
    );

    // Leaf wetness: Daily cycle
    this.registerDefaultModel(
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
    this.registerDefaultModel(
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
    this.registerDefaultModel(
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
    this.registerDefaultModel(
      PhysicalParameter.ELEVATION,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Latitude: Simple constant
    this.registerDefaultModel(
      PhysicalParameter.LATITUDE,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Longitude: Simple constant
    this.registerDefaultModel(
      PhysicalParameter.LONGITUDE,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Altitude: Simple constant
    this.registerDefaultModel(
      PhysicalParameter.ALTITUDE,
      new SimpleFunctionModel({
        base: 0,
        noiseLevel: 0,
      })
    );

    // Depth: Simple constant
    this.registerDefaultModel(
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
    this.registerDefaultModel(
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
    this.registerDefaultModel(
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
    this.registerDefaultModel(
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
    this.registerDefaultModel(
      PhysicalParameter.BATTERY_LEVEL,
      new SimpleFunctionModel({
        base: 100,
        noiseLevel: 0,
        minValue: 0,
        maxValue: 100,
      })
    );

    // Signal strength: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.SIGNAL_STRENGTH,
      new SimpleFunctionModel({
        base: -50,
        noiseLevel: 5,
        maxValue: 0,
      })
    );

    // Connection status: Boolean (default true)
    this.registerDefaultModel(
      PhysicalParameter.CONNECTION_STATUS,
      new SimpleFunctionModel({
        base: 1,
        noiseLevel: 0,
      })
    );

    // Operating temperature: Simple noise model
    this.registerDefaultModel(
      PhysicalParameter.OPERATING_TEMP,
      new SimpleFunctionModel({
        base: 35,
        noiseLevel: 2,
      })
    );

    // Runtime hours: Simple increasing model (base = 0, will be managed by device)
    this.registerDefaultModel(
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
