/**
 * Spatial Module
 *
 * Provides coordinate systems, distance calculations, and zone management
 * for spatial simulation of IoT devices and environment effects.
 */

export { SpatialUtils, DistanceMethod } from './SpatialUtils.js';
export { SpatialManager } from './SpatialManager.js';
export type {
  Coordinate2D,
  Coordinate3D,
  SpatialPosition,
  BoundingBox,
  CircularZone,
  Zone,
  SpatialLocation,
} from './SpatialUtils.js';
export type { DevicePosition } from './SpatialManager.js';
