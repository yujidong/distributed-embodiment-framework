/**
 * Spatial-related types shared between core and simulation packages.
 *
 * These types define 3D positioning and spatial zones in the IoT environment.
 */

/**
 * 3D position in the environment.
 */
export interface SpatialPosition {
  /** X coordinate (meters from origin) */
  x: number;
  /** Y coordinate (meters from origin) */
  y: number;
  /** Z coordinate (meters from origin, */
  z: number;
}

/**
 * 3D bounding box defined by minimum and maximum corners.
 */
export interface BoundingBox {
  /** Minimum corner coordinates */
  min: SpatialPosition;
  /** Maximum corner coordinates */
  max: SpatialPosition;
}

/**
 * Types of spatial zones in the environment.
 */
export type ZoneType =
  | 'room'      // Single room
  | 'floor'     // Entire floor
  | 'building'  // Entire building
  | 'outdoor'    // Outdoor area
  | 'zone';     // Generic zone

/**
 * Spatial zone definition.
 */
export interface SpatialZone {
  /** Unique zone identifier */
  id: string;
  /** Zone name */
  name: string;
  /** Zone type */
  type: ZoneType;
  /** Zone boundaries */
  bounds: BoundingBox;
  /** Parent zone ID (if nested) */
  parentId?: string;
  /** Zone metadata */
  metadata?: Record<string, any>;
}

/**
 * Default spatial position at origin.
 */
export const ORIGIN_POSITION: SpatialPosition = { x: 0, y: 0, z: 0 };

/**
 * Calculate distance between two positions.
 */
export function spatialDistance(a: SpatialPosition, b: SpatialPosition): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Check if a position is within a bounding box.
 */
export function isWithinBounds(position: SpatialPosition, bounds: BoundingBox): boolean {
  return (
    position.x >= bounds.min.x &&
    position.x <= bounds.max.x &&
    position.y >= bounds.min.y &&
    position.y <= bounds.max.y &&
    position.z >= bounds.min.z &&
    position.z <= bounds.max.z
  );
}
