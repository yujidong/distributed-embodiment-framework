/**
 * Daily Cycle Value Model
 *
 * Generates values following a daily sinusoidal pattern.
 * Useful for temperature, humidity, light, etc.
 */

import type { DeviceLocation, ValueModel } from '../../devices/types.js';
import { isStructuredLocation } from '../../devices/types.js';

/**
 * Daily cycle model configuration
 */
export interface DailyCycleConfig {
  base: number; // Base value (average)
  amplitude: number; // Amplitude of daily variation
  peakHour: number; // Hour of peak value (0-23)
  noiseLevel: number; // Standard deviation of noise
  minValue?: number; // Minimum value clamp
  maxValue?: number; // Maximum value clamp
  enableSpatialVariation?: boolean; // Enable spatial variation
}

/**
 * Daily Cycle Model
 *
 * Generates values that follow a sinusoidal daily pattern.
 * Useful for simulating temperature, humidity, light levels, etc.
 */
export class DailyCycleModel implements ValueModel {
  private config: DailyCycleConfig;

  constructor(config: DailyCycleConfig) {
    this.config = config;
  }

  /**
   * Get value at specific time and location
   * @param time - Time to calculate value for
   * @param location - Location to calculate value for
   * @returns Calculated value
   */
  getValue(time: Date, location: DeviceLocation): number {
    const hour = time.getHours() + time.getMinutes() / 60 + time.getSeconds() / 3600;

    // Calculate sinusoidal daily pattern
    // Shift so peak occurs at peakHour
    const hourOffset = hour - this.config.peakHour;
    const hourRadians = (hourOffset / 24) * 2 * Math.PI;

    // Cosine gives peak at 0 radians (our peakHour)
    let value = this.config.base + this.config.amplitude * Math.cos(hourRadians);

    // Add noise
    const noise = this.generateNoise();
    value += noise;

    // Apply spatial variation if enabled and position available
    if (this.config.enableSpatialVariation && isStructuredLocation(location) && location.position) {
      const spatialOffset = this.calculateSpatialVariation(location.position);
      value += spatialOffset;
    }

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
   * @param offset - Spatial offset
   * @returns Calculated value
   */
  getValueAt(time: Date, location: DeviceLocation, offset: { x: number; y: number; z: number }): number {
    // Create offset location
    const offsetLocation: DeviceLocation = {
      path: isStructuredLocation(location) ? location.path : String(location),
      position: isStructuredLocation(location) && location.position
        ? {
            x: location.position.x + offset.x,
            y: location.position.y + offset.y,
            z: location.position.z + offset.z,
          }
        : offset,
    };

    return this.getValue(time, offsetLocation);
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

  /**
   * Calculate spatial variation based on position
   * @param position - 3D position
   * @returns Spatial offset
   */
  private calculateSpatialVariation(position: { x: number; y: number; z: number }): number {
    // Simple distance-based variation using sine waves
    const distance = Math.sqrt(position.x ** 2 + position.y ** 2);

    // Create gradual variation across space
    const spatialVariation = Math.sin(distance / 10) * 2 + Math.sin(position.z / 2) * 1;

    return spatialVariation;
  }
}
