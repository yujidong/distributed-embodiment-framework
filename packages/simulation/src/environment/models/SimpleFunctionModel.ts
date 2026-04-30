/**
 * Simple Function Value Model
 *
 * Generates values using a simple formula: base + noise
 * Useful for stable parameters with random variation.
 */

import type { DeviceLocation, ValueModel } from '../../devices/types.js';

/**
 * Simple function model configuration
 */
export interface SimpleFunctionConfig {
  base: number; // Base value
  noiseLevel: number; // Standard deviation of noise
  minValue?: number; // Minimum value clamp
  maxValue?: number; // Maximum value clamp
  timeFactor?: number; // Optional time-based drift factor
}

/**
 * Simple Function Model
 *
 * Generates values using: base + time_offset + noise
 * Useful for parameters that don't follow daily patterns.
 */
export class SimpleFunctionModel implements ValueModel {
  private config: SimpleFunctionConfig;
  private startTime: number;

  constructor(config: SimpleFunctionConfig) {
    this.config = config;
    this.startTime = Date.now();
  }

  /**
   * Get value at specific time and location
   * @param time - Time to calculate value for
   * @param _location - Location (not used in simple model)
   * @returns Calculated value
   */
  getValue(time: Date, _location: DeviceLocation): number {
    let value = this.config.base;

    // Add time-based drift if configured
    if (this.config.timeFactor) {
      const elapsed = time.getTime() - this.startTime;
      const timeOffset = (this.config.timeFactor * elapsed) / 1000; // Convert to seconds
      value += timeOffset;
    }

    // Add noise
    const noise = this.generateNoise();
    value += noise;

    // Clamp to min/max if specified
    if (this.config.minValue !== undefined) {
      value = Math.max(value, this.config.minValue);
    }
    if (this.config.maxValue !== undefined) {
      value = Math.min(value, this.config.maxValue);
    }

    return Number(value);
  }

  /**
   * Get value at specific time, location with spatial offset
   * @param time - Time to calculate value for
   * @param location - Base location
   * @param _offset - Spatial offset (not used in simple model)
   * @returns Calculated value
   */
  getValueAt(time: Date, location: DeviceLocation, _offset: { x: number; y: number; z: number }): number {
    // Simple model doesn't use spatial offset
    return this.getValue(time, location);
  }

  /**
   * Generate random noise using Gaussian distribution approximation
   * @returns Noise value
   */
  private generateNoise(): number {
    // Box-Muller transform for Gaussian noise
    const u1 = Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    return z0 * this.config.noiseLevel;
  }
}
