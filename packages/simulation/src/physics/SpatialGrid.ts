/**
 * Spatial Grid
 *
 * Manages a sparse 3D grid of physics cells.
 * Uses hashmap for efficient sparse storage and O(1) access.
 */

import { GridCell, type GridCoordinates, type GridCellState } from './GridCell.js';
import { PhysicalParameter } from '../devices/types.js';
import { type SpatialPosition, type Coordinate2D, type Coordinate3D } from '../spatial/index.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Grid configuration
 */
const logger = createLogger('SpatialGrid');

export interface SpatialGridConfig {
  cellSize: number; // Cell size in meters (default: 1m)
  minX: number; // Minimum X boundary (meters)
  maxX: number; // Maximum X boundary (meters)
  minY: number; // Minimum Y boundary (meters)
  maxY: number; // Maximum Y boundary (meters)
  minZ: number; // Minimum Z boundary (meters)
  maxZ: number; // Maximum Z boundary (meters)
  diffusivity?: number; // Default diffusion coefficient (0-1)
}

/**
 * Spatial Grid Class
 */
export class SpatialGrid {
  private cells: Map<string, GridCell> = new Map();
  private config: Required<SpatialGridConfig>;

  constructor(config: SpatialGridConfig) {
    this.config = {
      cellSize: config.cellSize,
      minX: config.minX,
      maxX: config.maxX,
      minY: config.minY,
      maxY: config.maxY,
      minZ: config.minZ ?? 0,
      maxZ: config.maxZ ?? 0,
      diffusivity: config.diffusivity ?? 0.1,
    };

    logger.info('Initialized with config:', {
      cellSize: `${this.config.cellSize}m`,
      bounds: {
        x: `${this.config.minX}m to ${this.config.maxX}m`,
        y: `${this.config.minY}m to ${this.config.maxY}m`,
        z: `${this.config.minZ}m to ${this.config.maxZ}m`,
      },
      diffusivity: this.config.diffusivity,
    });
  }

  /**
   * Convert world position to grid coordinates
   */
  worldToGrid(position: SpatialPosition): GridCoordinates {
    const cellSize = this.config.cellSize;

    let x: number;
    let y: number;
    let z: number;

    if ('z' in position) {
      // 3D position
      x = Math.floor((position as Coordinate3D).x / cellSize);
      y = Math.floor((position as Coordinate3D).y / cellSize);
      z = Math.floor((position as Coordinate3D).z / cellSize);
    } else {
      // 2D position
      x = Math.floor(position.x / cellSize);
      y = Math.floor(position.y / cellSize);
      z = 0;
    }

    return { x, y, z };
  }

  /**
   * Convert grid coordinates to world position (cell center)
   */
  gridToWorld(coordinates: GridCoordinates): { x: number; y: number; z: number } {
    const halfCell = this.config.cellSize / 2;
    return {
      x: coordinates.x * this.config.cellSize + halfCell,
      y: coordinates.y * this.config.cellSize + halfCell,
      z: coordinates.z * this.config.cellSize + halfCell,
    };
  }

  /**
   * Get or create cell at world position
   */
  getCell(position: SpatialPosition): GridCell | undefined {
    const coords = this.worldToGrid(position);
    return this.getCellByCoords(coords);
  }

  /**
   * Get or create cell by grid coordinates
   */
  getCellByCoords(coords: GridCoordinates): GridCell | undefined {
    const cellId = this.getCellId(coords);

    // Return existing cell
    if (this.cells.has(cellId)) {
      return this.cells.get(cellId);
    }

    // Check if within bounds
    if (
      coords.x < Math.floor(this.config.minX / this.config.cellSize) ||
      coords.x > Math.floor(this.config.maxX / this.config.cellSize) ||
      coords.y < Math.floor(this.config.minY / this.config.cellSize) ||
      coords.y > Math.floor(this.config.maxY / this.config.cellSize) ||
      coords.z < Math.floor(this.config.minZ / this.config.cellSize) ||
      coords.z > Math.floor(this.config.maxZ / this.config.cellSize)
    ) {
      return undefined;
    }

    // Create new cell
    const worldPos = this.gridToWorld(coords);
    const cell = new GridCell(coords, worldPos, this.config.cellSize);
    this.cells.set(cellId, cell);

    // Set up neighbors (for diffusion)
    this.setupNeighbors(cell);

    return cell;
  }

  /**
   * Setup cell neighbors for diffusion calculations
   */
  private setupNeighbors(cell: GridCell): void {
    const { x, y, z } = cell.coordinates;
    const directions = [
      { dx: 1, dy: 0, dz: 0 },   // +X
      { dx: -1, dy: 0, dz: 0 },  // -X
      { dx: 0, dy: 1, dz: 0 },   // +Y
      { dx: 0, dy: -1, dz: 0 },  // -Y
      { dx: 0, dy: 0, dz: 1 },   // +Z
      { dx: 0, dy: 0, dz: -1 },  // -Z
    ];

    for (const dir of directions) {
      const neighborCoords = { x: x + dir.dx, y: y + dir.dy, z: z + dir.dz };
      const neighborId = this.getCellId(neighborCoords);

      // Check if neighbor exists
      if (this.cells.has(neighborId)) {
        const neighbor = this.cells.get(neighborId)!;
        cell.neighbors.set(neighborId, neighbor);
        // Add reverse reference
        neighbor.neighbors.set(cell.getCellId(), cell);
      }
    }
  }

  /**
   * Get parameter value at world position
   */
  getParameterValue(parameter: PhysicalParameter, position: SpatialPosition): number | boolean {
    const cell = this.getCell(position);

    if (!cell) {
      // Return default value if outside grid
      return this.getDefaultValue(parameter);
    }

    return cell.getParameter(parameter);
  }

  /**
   * Set parameter value at world position
   */
  setParameterValue(parameter: PhysicalParameter, position: SpatialPosition, value: number | boolean): void {
    const cell = this.getCell(position);

    if (!cell) {
      logger.warn(`Cannot set parameter: position outside grid bounds`);
      return;
    }

    cell.setParameter(parameter, value);
  }

  /**
   * Add device effect to grid cells within radius
   */
  addDeviceEffect(
    parameter: PhysicalParameter,
    position: SpatialPosition,
    magnitude: number,
    radius: number,
    falloff: 'linear' | 'inverse-square' | 'exponential' = 'linear'
  ): void {
    const centerCoords = this.worldToGrid(position);
    const radiusInCells = Math.ceil(radius / this.config.cellSize);

    // Iterate over cells within radius
    for (let dx = -radiusInCells; dx <= radiusInCells; dx++) {
      for (let dy = -radiusInCells; dy <= radiusInCells; dy++) {
        for (let dz = -radiusInCells; dz <= radiusInCells; dz++) {
          const coords = {
            x: centerCoords.x + dx,
            y: centerCoords.y + dy,
            z: centerCoords.z + dz,
          };

          const cell = this.getCellByCoords(coords);
          if (!cell) continue;

          // Calculate distance and falloff
          const distance = Math.sqrt(
            Math.pow(dx * this.config.cellSize, 2) +
            Math.pow(dy * this.config.cellSize, 2) +
            Math.pow(dz * this.config.cellSize, 2)
          );

          if (distance > radius) continue;

          const falloffFactor = this.calculateFalloff(distance, radius, falloff);
          const effectMagnitude = magnitude * falloffFactor;

          // Apply effect to cell
          switch (parameter) {
            case 'temperature':
              cell.addTemperatureEffect(effectMagnitude);
              break;
            case 'humidity':
              cell.addHumidityEffect(effectMagnitude);
              break;
            case 'light':
              cell.addLightEffect(effectMagnitude);
              break;
          }
        }
      }
    }
  }

  /**
   * Calculate falloff factor
   */
  private calculateFalloff(
    distance: number,
    radius: number,
    falloffType: 'linear' | 'inverse-square' | 'exponential'
  ): number {
    if (distance >= radius) return 0;

    const normalizedDistance = distance / radius;

    switch (falloffType) {
      case 'linear':
        return 1 - normalizedDistance;
      case 'inverse-square':
        return Math.max(0, 1 - Math.pow(normalizedDistance, 2));
      case 'exponential':
        return Math.exp(-3 * normalizedDistance);
      default:
        return 1 - normalizedDistance;
    }
  }

  /**
   * Update physics for all cells
   */
  updatePhysics(deltaTime: number): void {
    // Step 1: Apply accumulated device effects
    for (const cell of this.cells.values()) {
      cell.applyEffects(deltaTime);
    }

    // Step 2: Calculate diffusion (spread to neighbors)
    // Multiple iterations for better stability
    const diffusionIterations = 2;
    for (let i = 0; i < diffusionIterations; i++) {
      for (const cell of this.cells.values()) {
        cell.calculateDiffusion(deltaTime / diffusionIterations, this.config.diffusivity);
      }
    }
  }

  /**
   * Get all active cells
   */
  getActiveCells(): GridCell[] {
    return Array.from(this.cells.values());
  }

  /**
   * Get cells within radius of position
   */
  getCellsNearby(position: SpatialPosition, radius: number): GridCell[] {
    const nearby: GridCell[] = [];
    const centerCoords = this.worldToGrid(position);
    const radiusInCells = Math.ceil(radius / this.config.cellSize);

    for (let dx = -radiusInCells; dx <= radiusInCells; dx++) {
      for (let dy = -radiusInCells; dy <= radiusInCells; dy++) {
        for (let dz = -radiusInCells; dz <= radiusInCells; dz++) {
          const coords = {
            x: centerCoords.x + dx,
            y: centerCoords.y + dy,
            z: centerCoords.z + dz,
          };

          const cell = this.getCellByCoords(coords);
          if (cell) {
            nearby.push(cell);
          }
        }
      }
    }

    return nearby;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalCells: number;
    activeCells: number;
    gridBounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  } {
    return {
      totalCells: this.cells.size,
      activeCells: this.cells.size,
      gridBounds: {
        minX: this.config.minX,
        maxX: this.config.maxX,
        minY: this.config.minY,
        maxY: this.config.maxY,
        minZ: this.config.minZ,
        maxZ: this.config.maxZ,
      },
    };
  }

  /**
   * Clear all cells
   */
  clear(): void {
    this.cells.clear();
    logger.info('Cleared all cells');
  }

  /**
   * Get cell ID from coordinates
   */
  private getCellId(coords: GridCoordinates): string {
    return `${coords.x},${coords.y},${coords.z}`;
  }

  /**
   * Get default value for parameter
   */
  private getDefaultValue(parameter: PhysicalParameter): number | boolean {
    switch (parameter) {
      case 'temperature':
        return 22;
      case 'humidity':
        return 50;
      case 'light':
        return 500;
      case 'air_quality':
        return 50;
      case 'motion':
      case 'presence':
        return false;
      default:
        return 0;
    }
  }
}
