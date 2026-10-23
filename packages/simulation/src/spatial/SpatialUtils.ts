/**
 * Spatial Utilities
 *
 * Provides coordinate systems, distance calculations, and zone management
 * for spatial simulation of IoT devices and environment effects.
 */


import { createLogger } from '@active-collaboration/shared';
/**
 * 2D Coordinate
 */
const logger = createLogger('SpatialUtils');

export interface Coordinate2D {
  x: number;
  y: number;
}

/**
 * 3D Coordinate
 */
export interface Coordinate3D extends Coordinate2D {
  z: number;
}

/**
 * Spatial position (2D or 3D)
 */
export type SpatialPosition = Coordinate2D | Coordinate3D;

/**
 * Bounding box (rectangular area)
 */
export interface BoundingBox {
  min: Coordinate2D;
  max: Coordinate2D;
}

/**
 * Circular zone
 */
export interface CircularZone {
  center: Coordinate2D;
  radius: number;
}

/**
 * Zone definition
 */
export interface Zone {
  id: string;
  name: string;
  type: 'room' | 'area' | 'zone' | 'building' | 'floor';
  boundary: BoundingBox | CircularZone;
  metadata?: Record<string, unknown>;
}

/**
 * Location with spatial position
 */
export interface SpatialLocation {
  id: string;
  name: string;
  path: string;
  position?: SpatialPosition;
  zoneId?: string;
}

/**
 * Distance calculation methods
 */
export enum DistanceMethod {
  EUCLIDEAN = 'euclidean',
  MANHATTAN = 'manhattan',
  CHEBYSHEV = 'chebyshev',
}

/**
 * Spatial Utilities Class
 */
export class SpatialUtils {
  /**
   * Calculate distance between two 2D points
   * @param p1 - First point
   * @param p2 - Second point
   * @param method - Distance calculation method
   * @returns Distance
   */
  static distance2D(
    p1: Coordinate2D,
    p2: Coordinate2D,
    method: DistanceMethod = DistanceMethod.EUCLIDEAN
  ): number {
    switch (method) {
      case DistanceMethod.EUCLIDEAN:
        return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));

      case DistanceMethod.MANHATTAN:
        return Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y);

      case DistanceMethod.CHEBYSHEV:
        return Math.max(Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));

      default:
        return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
    }
  }

  /**
   * Calculate distance between two 3D points
   * @param p1 - First point
   * @param p2 - Second point
   * @param method - Distance calculation method
   * @returns Distance
   */
  static distance3D(
    p1: Coordinate3D,
    p2: Coordinate3D,
    method: DistanceMethod = DistanceMethod.EUCLIDEAN
  ): number {
    switch (method) {
      case DistanceMethod.EUCLIDEAN:
        return Math.sqrt(
          Math.pow(p2.x - p1.x, 2) +
          Math.pow(p2.y - p1.y, 2) +
          Math.pow(p2.z - p1.z, 2)
        );

      case DistanceMethod.MANHATTAN:
        return Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y) + Math.abs(p2.z - p1.z);

      case DistanceMethod.CHEBYSHEV:
        return Math.max(
          Math.abs(p2.x - p1.x),
          Math.abs(p2.y - p1.y),
          Math.abs(p2.z - p1.z)
        );

      default:
        return Math.sqrt(
          Math.pow(p2.x - p1.x, 2) +
          Math.pow(p2.y - p1.y, 2) +
          Math.pow(p2.z - p1.z, 2)
        );
    }
  }

  /**
   * Calculate distance between two spatial positions
   * @param p1 - First position
   * @param p2 - Second position
   * @param method - Distance calculation method
   * @returns Distance or 0 if positions are incompatible
   */
  static distance(
    p1: SpatialPosition,
    p2: SpatialPosition,
    method: DistanceMethod = DistanceMethod.EUCLIDEAN
  ): number {
    const is3D1 = 'z' in p1;
    const is3D2 = 'z' in p2;

    if (is3D1 && is3D2) {
      return this.distance3D(p1 as Coordinate3D, p2 as Coordinate3D, method);
    } else if (!is3D1 && !is3D2) {
      return this.distance2D(p1, p2, method);
    } else {
      logger.warn('Cannot calculate distance between 2D and 3D positions');
      return 0;
    }
  }

  /**
   * Check if a point is inside a bounding box
   * @param point - Point to check
   * @param bbox - Bounding box
   * @returns True if point is inside
   */
  static isInBoundingBox(point: Coordinate2D, bbox: BoundingBox): boolean {
    return (
      point.x >= bbox.min.x &&
      point.x <= bbox.max.x &&
      point.y >= bbox.min.y &&
      point.y <= bbox.max.y
    );
  }

  /**
   * Check if a point is inside a circular zone
   * @param point - Point to check
   * @param zone - Circular zone
   * @returns True if point is inside
   */
  static isInCircularZone(point: Coordinate2D, zone: CircularZone): boolean {
    const distance = this.distance2D(point, zone.center);
    return distance <= zone.radius;
  }

  /**
   * Check if a point is inside a zone
   * @param point - Point to check
   * @param zone - Zone
   * @returns True if point is inside
   */
  static isInZone(point: Coordinate2D, zone: Zone): boolean {
    // Check if boundary is CircularZone (has 'radius' property)
    if ('radius' in zone.boundary && 'center' in zone.boundary) {
      return this.isInCircularZone(point, zone.boundary as CircularZone);
    } else {
      return this.isInBoundingBox(point, zone.boundary as BoundingBox);
    }
  }

  /**
   * Calculate falloff factor based on distance and radius
   * @param distance - Distance from source
   * @param radius - Effect radius
   * @param falloffType - Type of falloff ('linear', 'inverse-square', 'exponential')
   * @returns Falloff factor (0-1)
   */
  static calculateFalloff(
    distance: number,
    radius: number,
    falloffType: 'linear' | 'inverse-square' | 'exponential' = 'linear'
  ): number {
    if (distance >= radius) {
      return 0;
    }

    const normalizedDistance = distance / radius;

    switch (falloffType) {
      case 'linear':
        return 1 - normalizedDistance;

      case 'inverse-square':
        // Inverse square law with minimum to avoid division by zero
        return Math.max(0, 1 - Math.pow(normalizedDistance, 2));

      case 'exponential':
        // Exponential decay
        return Math.exp(-3 * normalizedDistance);

      default:
        return 1 - normalizedDistance;
    }
  }

  /**
   * Find nearest zone to a point
   * @param point - Point
   * @param zones - Array of zones
   * @returns Nearest zone or undefined
   */
  static findNearestZone(point: Coordinate2D, zones: Zone[]): Zone | undefined {
    if (zones.length === 0) {
      return undefined;
    }

    // First check if point is inside any zone
    for (const zone of zones) {
      if (this.isInZone(point, zone)) {
        return zone;
      }
    }

    // If not inside any zone, find nearest zone center
    let nearestZone: Zone | undefined;
    let minDistance = Infinity;

    for (const zone of zones) {
      let center: Coordinate2D;

      // Check if boundary is CircularZone (has 'radius' property)
      if ('radius' in zone.boundary && 'center' in zone.boundary) {
        center = (zone.boundary as CircularZone).center;
      } else {
        const bbox = zone.boundary as BoundingBox;
        center = {
          x: (bbox.min.x + bbox.max.x) / 2,
          y: (bbox.min.y + bbox.max.y) / 2,
        };
      }

      const distance = this.distance2D(point, center);
      if (distance < minDistance) {
        minDistance = distance;
        nearestZone = zone;
      }
    }

    return nearestZone;
  }

  /**
   * Convert position string to coordinate
   * @param positionStr - Position string (e.g., "10,20" or "10,20,5")
   * @returns SpatialPosition or undefined
   */
  static parsePosition(positionStr: string): SpatialPosition | undefined {
    const parts = positionStr.split(',').map(s => parseFloat(s.trim()));

    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return { x: parts[0], y: parts[1] };
    } else if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
      return { x: parts[0], y: parts[1], z: parts[2] };
    }

    return undefined;
  }

  /**
   * Convert coordinate to position string
   * @param position - Spatial position
   * @returns Position string
   */
  static positionToString(position: SpatialPosition): string {
    if ('z' in position) {
      return `${position.x},${position.y},${position.z}`;
    } else {
      return `${position.x},${position.y}`;
    }
  }
}
