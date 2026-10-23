/**
 * Spatial Propagation Engine
 *
 * A pure physics engine that handles spatial propagation of physical effects.
 * This engine is completely decoupled from device concerns - it only knows about:
 * 1. Effect sources (position, type, magnitude, radius, falloff)
 * 2. Spatial locations (position, ID)
 * 3. Propagation calculations (distance, attenuation, diffusion)
 *
 * Key principle: The engine does NOT know about devices, device states,
 * or device-specific logic. It only calculates how effects spread in space.
 */

import { SpatialUtils, type Coordinate2D, type Coordinate3D } from '../spatial/index.js';
import {
  EffectSourceRegistry,
  type EffectSource,
  PhysicalEffectType,
  type PhysicalFalloffType,
} from './EffectSource.js';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('SpatialPropagationEngine');

/**
 * Spatial location for effect propagation
 */


export interface PropagationLocation {
  id: string;
  position: Coordinate2D | Coordinate3D;
}

/**
 * Result of propagation calculation for a single location
 */
export interface PropagationResult {
  locationId: string;
  effects: Map<PhysicalEffectType, number>; // Effect type -> net magnitude at this location
}

/**
 * Spatial Propagation Engine - pure physics calculations
 */
export class SpatialPropagationEngine {
  private effectRegistry: EffectSourceRegistry;

  constructor(effectRegistry?: EffectSourceRegistry) {
    this.effectRegistry = effectRegistry ?? new EffectSourceRegistry();
    logger.info('Initialized');
  }

  /**
   * Get the effect registry (for registering/unregistering effects)
   */
  getRegistry(): EffectSourceRegistry {
    return this.effectRegistry;
  }

  /**
   * Calculate effect attenuation based on distance and falloff model
   *
   * @param distance - Distance from source in meters
   * @param radius - Maximum effect radius in meters
   * @param falloff - Falloff model type
   * @returns Attenuation factor (0 to 1)
   */
  calculateAttenuation(
    distance: number,
    radius: number,
    falloff: PhysicalFalloffType
  ): number {
    return SpatialUtils.calculateFalloff(distance, radius, falloff);
  }

  /**
   * Calculate the net effect magnitude at a specific location
   *
   * This is the core propagation calculation:
   * 1. Find all active sources within range
   * 2. Calculate attenuation for each source based on distance
   * 3. Sum up attenuated magnitudes by effect type
   *
   * @param location - Target location
   * @param sources - Active effect sources (optional, defaults to all active)
   * @returns Map of effect types to net magnitudes
   */
  calculateEffectAtLocation(
    location: PropagationLocation,
    sources?: EffectSource[]
  ): Map<PhysicalEffectType, number> {
    const activeSources = sources ?? this.effectRegistry.getActiveSources();
    const effects = new Map<PhysicalEffectType, number>();

    for (const source of activeSources) {
      const distance = SpatialUtils.distance(source.position, location.position);

      // Skip if outside effect radius
      if (distance > source.radius) continue;

      // Calculate attenuation
      const attenuation = this.calculateAttenuation(distance, source.radius, source.falloff);

      // Skip if attenuation is effectively zero
      if (attenuation <= 0.001) continue;

      // Calculate attenuated magnitude
      const attenuatedMagnitude = source.magnitude * attenuation;

      // Add to net effect for this type
      const currentMagnitude = effects.get(source.type) ?? 0;
      effects.set(source.type, currentMagnitude + attenuatedMagnitude);
    }

    return effects;
  }

  /**
   * Calculate effects at all specified locations
   *
   * @param locations - Target locations
   * @returns Array of propagation results
   */
  calculateEffectsAtLocations(
    locations: PropagationLocation[]
  ): PropagationResult[] {
    const activeSources = this.effectRegistry.getActiveSources();
    const results: PropagationResult[] = [];

    for (const location of locations) {
      const effects = this.calculateEffectAtLocation(location, activeSources);
      results.push({
        locationId: location.id,
        effects,
      });
    }

    return results;
  }

  /**
   * Find all locations affected by a specific source
   *
   * @param source - Effect source
   * @param locations - All possible locations
   * @returns Locations within the source's effect radius
   */
  findAffectedLocations(
    source: EffectSource,
    locations: PropagationLocation[]
  ): PropagationLocation[] {
    return locations.filter(loc => {
      const distance = SpatialUtils.distance(source.position, loc.position);
      return distance <= source.radius;
    });
  }

  /**
   * Calculate heat/cooling power at a location (in Watts)
   *
   * This is a specialized calculation for HVAC-type effects:
   * - HEATING effects contribute positive power
   * - COOLING effects contribute negative power
   *
   * @param location - Target location
   * @returns Net heating/cooling power in Watts
   */
  calculateThermalPowerAtLocation(location: PropagationLocation): number {
    const effects = this.calculateEffectAtLocation(location);

    let totalPower = 0;

    // Add heating power (positive)
    const heatingPower = effects.get(PhysicalEffectType.HEATING) ?? 0;
    totalPower += heatingPower;

    // Subtract cooling power (negative)
    const coolingPower = effects.get(PhysicalEffectType.COOLING) ?? 0;
    totalPower -= Math.abs(coolingPower); // Ensure cooling is always negative

    return totalPower;
  }

  /**
   * Get all active thermal sources (heating + cooling)
   */
  getActiveThermalSources(): EffectSource[] {
    return this.effectRegistry.getSourcesByType(PhysicalEffectType.HEATING)
      .concat(this.effectRegistry.getSourcesByType(PhysicalEffectType.COOLING));
  }

  /**
   * Calculate propagation statistics for debugging
   */
  calculateStats(locations: PropagationLocation[]): {
    sourcesCount: number;
    affectedLocationsCount: number;
    effectDistribution: Map<PhysicalEffectType, number>;
  } {
    const activeSources = this.effectRegistry.getActiveSources();
    const effectDistribution = new Map<PhysicalEffectType, number>();

    let affectedCount = 0;

    for (const location of locations) {
      const effects = this.calculateEffectAtLocation(location, activeSources);
      if (effects.size > 0) {
        affectedCount++;

        for (const [type, magnitude] of effects) {
          const current = effectDistribution.get(type) ?? 0;
          effectDistribution.set(type, current + Math.abs(magnitude));
        }
      }
    }

    return {
      sourcesCount: activeSources.length,
      affectedLocationsCount: affectedCount,
      effectDistribution,
    };
  }
}
