/**
 * Grid Physics Engine
 *
 * High-performance physics simulation using spatial grid.
 * Manages device effects, diffusion, and environmental updates.
 */

import { TimeManager } from '../environment/TimeManager.js';
import { SpatialGrid, type SpatialGridConfig } from './SpatialGrid.js';
import { StateInterpolator } from './StateInterpolator.js';
import { PhysicalParameter } from '../devices/types.js';
import type { SpatialPosition } from '../spatial/index.js';
import type { DevicePhysicsEffect, StateChangeEvent } from './PhysicsLayer.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Device effect on grid
 */
interface GridDeviceEffect {
  deviceId: string;
  parameter: PhysicalParameter;
  magnitude: number;
  position: SpatialPosition;
  radius: number;
  falloff: 'linear' | 'inverse-square' | 'exponential';
  enabled: boolean;
}

/**
 * Grid physics engine configuration
 */
const logger = createLogger('GridPhysicsEngine');

export interface GridPhysicsEngineConfig extends Omit<SpatialGridConfig, 'diffusivity'> {
  enableDiffusion?: boolean;
  updateInterval?: number; // milliseconds
  interpolationConfig?: any;
  diffusivity?: number; // Override diffusivity from SpatialGridConfig
}

/**
 * Grid Physics Engine Class
 */
export class GridPhysicsEngine {
  private timeManager: TimeManager;
  private grid: SpatialGrid;
  private stateInterpolator: StateInterpolator;

  private deviceEffects: Map<string, GridDeviceEffect[]> = new Map();
  private stateChangeListeners: Set<(event: StateChangeEvent) => void> = new Set();

  private config: Required<GridPhysicsEngineConfig>;
  private isRunning: boolean = false;
  private updateInterval?: NodeJS.Timeout;
  private lastUpdateTime: Date;

  constructor(timeManager: TimeManager, config: GridPhysicsEngineConfig) {
    this.timeManager = timeManager;
    this.lastUpdateTime = new Date();

    this.config = {
      enableDiffusion: config.enableDiffusion ?? true,
      updateInterval: config.updateInterval ?? 1000,
      interpolationConfig: config.interpolationConfig || {},
      diffusivity: config.diffusivity ?? 0.1,
      cellSize: config.cellSize,
      minX: config.minX,
      maxX: config.maxX,
      minY: config.minY,
      maxY: config.maxY,
      minZ: config.minZ ?? 0,
      maxZ: config.maxZ ?? 0,
    };

    // Initialize grid
    this.grid = new SpatialGrid({
      cellSize: this.config.cellSize,
      minX: this.config.minX,
      maxX: this.config.maxX,
      minY: this.config.minY,
      maxY: this.config.maxY,
      minZ: this.config.minZ,
      maxZ: this.config.maxZ,
      diffusivity: this.config.diffusivity,
    });

    // Initialize interpolator
    this.stateInterpolator = new StateInterpolator(this.config.interpolationConfig);

    logger.info('Initialized with config:', {
      gridBounds: {
        x: `${this.config.minX}m to ${this.config.maxX}m`,
        y: `${this.config.minY}m to ${this.config.maxY}m`,
        z: `${this.config.minZ}m to ${this.config.maxZ}m`,
      },
      cellSize: `${this.config.cellSize}m`,
      diffusivity: this.config.diffusivity,
      enableDiffusion: this.config.enableDiffusion,
      updateInterval: `${this.config.updateInterval}ms`,
    });
  }

  /**
   * Start physics simulation
   */
  startPhysicsSimulation(): void {
    if (this.isRunning) {
      logger.warn('Already running');
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
   * @param customDeltaTime - Custom delta time in seconds (optional)
   */
  updatePhysics(customDeltaTime?: number): {
    deltaTime: number;
    cellsUpdated: number;
    effectsApplied: number;
  } {
    if (!this.isRunning && customDeltaTime === undefined) {
      return {
        deltaTime: 0,
        cellsUpdated: 0,
        effectsApplied: 0,
      };
    }

    const currentTime = this.timeManager.getCurrentTime();
    let deltaTime = customDeltaTime || (currentTime.getTime() - this.lastUpdateTime.getTime()) / 1000;

    // Ensure deltaTime is never 0 or negative
    if (deltaTime <= 0) {
      deltaTime = 0.001; // 1ms minimum
    }

    this.lastUpdateTime = currentTime;

    logger.info(`Updating physics (dt = ${deltaTime.toFixed(3)}s)`);

    // Step 1: Apply device effects to grid
    let effectsApplied = 0;
    for (const effects of this.deviceEffects.values()) {
      for (const effect of effects) {
        if (!effect.enabled) continue;

        this.grid.addDeviceEffect(
          effect.parameter,
          effect.position,
          effect.magnitude,
          effect.radius,
          effect.falloff
        );
        effectsApplied++;
      }
    }

    // Step 2: Update grid physics (diffusion, etc.)
    this.grid.updatePhysics(deltaTime);

    // Step 3: Record cell states in interpolator
    const cellsUpdated = this.recordCellStates();

    logger.info('Physics update complete:', {
      deltaTime: `${deltaTime.toFixed(3)}s`,
      effectsApplied,
      cellsUpdated,
    });

    return {
      deltaTime,
      cellsUpdated,
      effectsApplied,
    };
  }

  /**
   * Record all cell states in interpolator
   */
  private recordCellStates(): number {
    let updates = 0;
    const cells = this.grid.getActiveCells();
    const currentTime = this.timeManager.getCurrentTime();

    for (const cell of cells) {
      const location = cell.getCellId();

      // Record key parameters
      const parameters: PhysicalParameter[] = [
        PhysicalParameter.TEMPERATURE,
        PhysicalParameter.HUMIDITY,
        PhysicalParameter.LIGHT,
        PhysicalParameter.AIR_QUALITY,
      ];

      for (const param of parameters) {
        const value = cell.getParameter(param);
        this.stateInterpolator.recordState(location, param, value as number, currentTime);
        updates++;
      }
    }

    return updates;
  }

  /**
   * Register a device effect
   */
  registerDeviceEffect(effect: DevicePhysicsEffect, position: SpatialPosition): void {
    if (!effect.affectedArea.position) {
      logger.warn('Device effect missing position, using affectedArea.location as reference');
      // For effects without explicit position, use a default position
      // This could be improved by getting device position from a device registry
    }

    const deviceId = effect.deviceId;

    if (!this.deviceEffects.has(deviceId)) {
      this.deviceEffects.set(deviceId, []);
    }

    const gridEffect: GridDeviceEffect = {
      deviceId,
      parameter: effect.parameter,
      magnitude: effect.magnitude,
      position: effect.affectedArea.position || { x: 0, y: 0, z: 0 },
      radius: effect.affectedArea.radius,
      falloff: effect.falloff || 'linear',
      enabled: effect.enabled ?? true,
    };

    this.deviceEffects.get(deviceId)!.push(gridEffect);

    logger.info(`Registered effect for ${deviceId}:`, {
      parameter: effect.parameter,
      magnitude: effect.magnitude,
      radius: `${effect.affectedArea.radius}m`,
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
   * Get parameter value at position
   */
  getParameterValue(parameter: PhysicalParameter, position: SpatialPosition): number | boolean {
    return this.grid.getParameterValue(parameter, position);
  }

  /**
   * Get interpolated parameter value
   */
  interpolateParameter(
    parameter: PhysicalParameter,
    location: string,
    targetTime?: Date
  ): number | boolean | null {
    return this.stateInterpolator.interpolate(location, parameter, targetTime);
  }

  /**
   * Subscribe to state change events
   */
  onStateChange(listener: (event: StateChangeEvent) => void): () => void {
    this.stateChangeListeners.add(listener);

    return () => {
      this.stateChangeListeners.delete(listener);
    };
  }

  /**
   * Get statistics
   */
  getStats(): {
    isRunning: boolean;
    activeDeviceEffects: number;
    gridStats: ReturnType<SpatialGrid['getStats']>;
    interpolatorStats: ReturnType<StateInterpolator['getStats']>;
  } {
    let activeEffects = 0;
    for (const effects of this.deviceEffects.values()) {
      activeEffects += effects.filter(e => e.enabled).length;
    }

    return {
      isRunning: this.isRunning,
      activeDeviceEffects: activeEffects,
      gridStats: this.grid.getStats(),
      interpolatorStats: this.stateInterpolator.getStats(),
    };
  }

  /**
   * Get spatial grid (for advanced usage)
   */
  getSpatialGrid(): SpatialGrid {
    return this.grid;
  }

  /**
   * Get state interpolator (for advanced usage)
   */
  getStateInterpolator(): StateInterpolator {
    return this.stateInterpolator;
  }

  /**
   * Clear all device effects
   */
  clearAllDeviceEffects(): void {
    this.deviceEffects.clear();
    logger.info('Cleared all device effects');
  }

  /**
   * Clear grid cells
   */
  clearGrid(): void {
    this.grid.clear();
    logger.info('Cleared grid');
  }
}
