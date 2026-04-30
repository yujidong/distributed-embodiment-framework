/**
 * Effect Source - Abstract representation of a physical effect source
 *
 * This interface decouples the physics engine from device-specific concerns.
 * Devices, environmental events, or any other source can create EffectSources
 * to trigger physical effects in the environment.
 *
 * Key principle: The physics engine only knows about EffectSources,
 * not about devices or their internal states.
 */

import type { Coordinate2D, Coordinate3D } from '../spatial/index.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Types of physical effects that can propagate spatially
 */
const logger = createLogger('EffectSource');

export enum PhysicalEffectType {
  HEATING = 'heating',
  COOLING = 'cooling',
  HUMIDITY = 'humidity',
  DEHUMIDIFICATION = 'dehumidification',
  LIGHT = 'light',
  SOUND = 'sound',
  AIR_FLOW = 'air_flow',
  CONVECTION = 'convection',
  ZONE_TRANSFER = 'zone_transfer',
  POLLUTANT = 'pollutant',
  MOTION = 'motion',
  SET = 'set', // Set absolute value (for environment initialization/simulation)
}

/**
 * Falloff models for spatial effect propagation
 */
export type PhysicalFalloffType = 'linear' | 'inverse-square' | 'exponential';

/**
 * Effect Source - represents a source of physical effect in space
 *
 * This is the ONLY thing the physics engine needs to know about.
 * It doesn't care if the source is a device, environmental event, or simulation.
 */
export interface EffectSource {
  /** Unique identifier for this effect source */
  id: string;

  /** Type of physical effect */
  type: PhysicalEffectType;

  /** Magnitude of the effect (units depend on effect type) */
  magnitude: number;

  /** Position of the effect source in space */
  position: Coordinate2D | Coordinate3D;

  /** Radius of effect in meters */
  radius: number;

  /** How the effect attenuates with distance */
  falloff: PhysicalFalloffType;

  /** Whether the effect is currently active */
  active: boolean;

  /** Optional: Duration in milliseconds (0 = permanent while active) */
  duration?: number;

  /** Optional: Start time of the effect */
  startTime?: Date;

  /** Optional: Metadata for debugging/logging (NOT used by physics engine) */
  metadata?: Record<string, unknown>;
}

/**
 * Effect Source Registry - manages all active effect sources
 *
 * This registry is the bridge between effect producers (devices, events)
 * and the physics engine. Devices register their effects here, and the
 * physics engine reads from this registry.
 */
export class EffectSourceRegistry {
  private sources: Map<string, EffectSource> = new Map();

  /**
   * Register an effect source
   */
  register(source: EffectSource): void {
    this.sources.set(source.id, source);
    logger.info(`[EffectSourceRegistry] Registered effect: ${source.id} (${source.type}, magnitude: ${source.magnitude})`);
  }

  /**
   * Unregister an effect source
   */
  unregister(sourceId: string): boolean {
    const removed = this.sources.delete(sourceId);
    if (removed) {
      logger.info(`[EffectSourceRegistry] Unregistered effect: ${sourceId}`);
    }
    return removed;
  }

  /**
   * Get an effect source by ID
   */
  get(sourceId: string): EffectSource | undefined {
    return this.sources.get(sourceId);
  }

  /**
   * Get all active effect sources
   */
  getActiveSources(): EffectSource[] {
    return Array.from(this.sources.values()).filter(s => s.active);
  }

  /**
   * Get all effect sources of a specific type
   */
  getSourcesByType(type: PhysicalEffectType): EffectSource[] {
    return Array.from(this.sources.values()).filter(s => s.type === type && s.active);
  }

  /**
   * Get all effect sources (including inactive)
   */
  getAllSources(): EffectSource[] {
    return Array.from(this.sources.values());
  }

  /**
   * Update an effect source
   */
  update(sourceId: string, updates: Partial<EffectSource>): boolean {
    const source = this.sources.get(sourceId);
    if (!source) return false;

    Object.assign(source, updates);
    return true;
  }

  /**
   * Set effect active state
   */
  setActive(sourceId: string, active: boolean): boolean {
    return this.update(sourceId, { active });
  }

  /**
   * Clear all effect sources
   */
  clear(): void {
    this.sources.clear();
    logger.info('[EffectSourceRegistry] Cleared all effects');
  }

  /**
   * Get statistics
   */
  getStats(): { total: number; active: number; byType: Record<string, number> } {
    const sources = Array.from(this.sources.values());
    const byType: Record<string, number> = {};

    for (const source of sources) {
      byType[source.type] = (byType[source.type] || 0) + 1;
    }

    return {
      total: sources.length,
      active: sources.filter(s => s.active).length,
      byType,
    };
  }
}
