/**
 * Location Tracking Service
 *
 * Tracks mobile entities (smartphones, robots, beacons)
 * Provides location-aware collaboration capabilities
 */


import { createLogger } from '@active-collaboration/shared';
// ============================================================================
// Types
// ============================================================================

const logger = createLogger('LocationTrackingService');

export interface Location {
  entityId: string;
  entityName: string;
  zone: string;
  subZone?: string;
  coordinates: {
    x: number;
    y: number;
    z?: number;
    floor?: number;
  };
  timestamp: Date;
  confidence: number; // 0-1
  source: 'gps' | 'wifi' | 'ble' | 'manual' | 'rfid';
  velocity?: {
    speed: number; // m/s
    direction: number; // degrees
  };
}

export interface Zone {
  id: string;
  name: string;
  type: 'lobby' | 'office' | 'meeting-room' | 'corridor' | 'data-center' | 'outdoor';
  boundaries: {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    floor?: number;
  };
  beacons: string[]; // beacon IDs in this zone
}

export interface LocationUpdate {
  entityId: string;
  location: Location;
  predictedLocations?: PredictedLocation[];
}

export interface PredictedLocation {
  zone: string;
  probability: number;
  estimatedTime: Date;
  confidence: number;
}

// ============================================================================
// LocationTrackingService Class
// ============================================================================

export class LocationTrackingService {
  private entityLocations: Map<string, Location>;
  private zones: Map<string, Zone>;
  private locationHistory: Map<string, Location[]>;

  constructor() {
    this.entityLocations = new Map();
    this.zones = new Map();
    this.locationHistory = new Map();
    logger.info('Initialized');

    // Initialize default zones
    this.initializeDefaultZones();
  }

  // ========================================================================
  // Zone Management
  // ========================================================================

  /**
   * Initialize default zones for Smart Office Building
   */
  private initializeDefaultZones(): void {
    const defaultZones: Zone[] = [
      {
        id: 'zone-lobby-1',
        name: 'Lobby - Floor 1',
        type: 'lobby',
        boundaries: { xMin: 0, xMax: 100, yMin: 0, yMax: 100, floor: 1 },
        beacons: ['beacon-lobby-1', 'beacon-lobby-2'],
      },
      {
        id: 'zone-office-1',
        name: 'Office Zone 1 - Floor 2',
        type: 'office',
        boundaries: { xMin: 0, xMax: 100, yMin: 0, yMax: 100, floor: 2 },
        beacons: ['beacon-office-1'],
      },
      {
        id: 'zone-office-2',
        name: 'Office Zone 2 - Floor 2',
        type: 'office',
        boundaries: { xMin: 100, xMax: 200, yMin: 0, yMax: 100, floor: 2 },
        beacons: ['beacon-office-2'],
      },
      {
        id: 'zone-meeting-a',
        name: 'Meeting Room A - Floor 3',
        type: 'meeting-room',
        boundaries: { xMin: 0, xMax: 50, yMin: 0, yMax: 50, floor: 3 },
        beacons: ['beacon-meeting-1'],
      },
      {
        id: 'zone-meeting-b',
        name: 'Meeting Room B - Floor 3',
        type: 'meeting-room',
        boundaries: { xMin: 50, xMax: 100, yMin: 0, yMax: 50, floor: 3 },
        beacons: ['beacon-meeting-2'],
      },
      {
        id: 'zone-data-center',
        name: 'Data Center - Building 2',
        type: 'data-center',
        boundaries: { xMin: 0, xMax: 200, yMin: 0, yMax: 200, floor: 1 },
        beacons: [],
      },
    ];

    for (const zone of defaultZones) {
      this.zones.set(zone.id, zone);
    }

    logger.info(`Initialized ${defaultZones.length} default zones`);
  }

  /**
   * Add a new zone
   */
  addZone(zone: Zone): void {
    this.zones.set(zone.id, zone);
    logger.info(`Zone added: ${zone.name}`);
  }

  /**
   * Get zone by ID
   */
  getZone(zoneId: string): Zone | undefined {
    return this.zones.get(zoneId);
  }

  /**
   * Get all zones
   */
  getAllZones(): Zone[] {
    return Array.from(this.zones.values());
  }

  // ========================================================================
  // Location Tracking
  // ========================================================================

  /**
   * Update entity location
   */
  updateLocation(locationUpdate: LocationUpdate): void {
    const { entityId, location } = locationUpdate;

    // Store previous location in history
    if (this.entityLocations.has(entityId)) {
      const previousLocation = this.entityLocations.get(entityId)!;
      if (!this.locationHistory.has(entityId)) {
        this.locationHistory.set(entityId, []);
      }
      this.locationHistory.get(entityId)!.push(previousLocation);

      // Limit history to last 100 locations
      const history = this.locationHistory.get(entityId)!;
      if (history.length > 100) {
        history.shift();
      }
    }

    // Update current location
    this.entityLocations.set(entityId, location);

    logger.info(`Location updated: ${location.entityName} -> ${location.zone}`);
  }

  /**
   * Get entity location
   */
  getLocation(entityId: string): Location | undefined {
    return this.entityLocations.get(entityId);
  }

  /**
   * Get multiple entity locations
   */
  getLocations(entityIds: string[]): Map<string, Location> {
    const locations = new Map<string, Location>();
    for (const id of entityIds) {
      const location = this.entityLocations.get(id);
      if (location) {
        locations.set(id, location);
      }
    }
    return locations;
  }

  /**
   * Get all entities in a zone
   */
  getEntitiesInZone(zoneId: string): Location[] {
    const zone = this.zones.get(zoneId);
    if (!zone) {
      return [];
    }

    return Array.from(this.entityLocations.values()).filter(
      (loc) => loc.zone === zoneId || loc.zone === zone.name
    );
  }

  /**
   * Get entities in multiple zones
   */
  getEntitiesInZones(zoneIds: string[]): Map<string, Location[]> {
    const result = new Map<string, Location[]>();

    for (const zoneId of zoneIds) {
      const entities = this.getEntitiesInZone(zoneId);
      result.set(zoneId, entities);
    }

    return result;
  }

  /**
   * Find nearest entity to a location
   */
  findNearestEntity(
    targetCoordinates: { x: number; y: number; z?: number },
    entityType?: string
  ): { entity: Location; distance: number } | null {
    let nearest: { entity: Location; distance: number } | null = null;

    for (const location of this.entityLocations.values()) {
      // Filter by entity type if specified
      if (entityType && !location.entityName.includes(entityType)) {
        continue;
      }

      // Calculate Euclidean distance
      const dx = location.coordinates.x - targetCoordinates.x;
      const dy = location.coordinates.y - targetCoordinates.y;
      const dz = (location.coordinates.z || 0) - (targetCoordinates.z || 0);
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (!nearest || distance < nearest.distance) {
        nearest = { entity: location, distance };
      }
    }

    return nearest;
  }

  // ========================================================================
  // Zone Detection
  // ========================================================================

  /**
   * Determine which zone a coordinate is in
   */
  detectZone(coordinates: { x: number; y: number; z?: number; floor?: number }): Zone | null {
    for (const zone of this.zones.values()) {
      const b = zone.boundaries;

      // Check floor if specified
      if (coordinates.floor !== undefined && coordinates.floor !== b.floor) {
        continue;
      }

      // Check if coordinates are within boundaries
      if (
        coordinates.x >= b.xMin &&
        coordinates.x <= b.xMax &&
        coordinates.y >= b.yMin &&
        coordinates.y <= b.yMax
      ) {
        return zone;
      }
    }

    return null;
  }

  /**
   * Get zone for an entity
   */
  getEntityZone(entityId: string): Zone | null {
    const location = this.entityLocations.get(entityId);
    if (!location) {
      return null;
    }

    return this.zones.get(location.zone) || this.detectZone(location.coordinates);
  }

  // ========================================================================
  // Location Prediction
  // ========================================================================

  /**
   * Predict next location for an entity based on movement patterns
   */
  predictNextLocation(
    entityId: string,
    timeHorizon: number = 300000 // 5 minutes default
  ): PredictedLocation[] {
    const history = this.locationHistory.get(entityId);
    if (!history || history.length < 3) {
      return [];
    }

    // Simple prediction: look at recent movement patterns
    const recentLocations = history.slice(-10);
    const predictions: PredictedLocation[] = [];

    // Find most frequently visited zones
    const zoneVisits = new Map<string, number>();
    for (const loc of recentLocations) {
      const count = zoneVisits.get(loc.zone) || 0;
      zoneVisits.set(loc.zone, count + 1);
    }

    // Predict based on frequency and time
    for (const [zone, count] of zoneVisits) {
      const probability = count / recentLocations.length;
      if (probability > 0.3) {
        // Predict likely next location
        predictions.push({
          zone,
          probability,
          estimatedTime: new Date(Date.now() + timeHorizon),
          confidence: Math.min(probability, 0.9),
        });
      }
    }

    // Sort by probability
    predictions.sort((a, b) => b.probability - a.probability);

    return predictions.slice(0, 3); // Return top 3 predictions
  }

  /**
   * Predict locations for multiple entities
   */
  predictLocations(
    entityIds: string[],
    timeHorizon?: number
  ): Map<string, PredictedLocation[]> {
    const predictions = new Map<string, PredictedLocation[]>();

    for (const id of entityIds) {
      const entityPredictions = this.predictNextLocation(id, timeHorizon);
      if (entityPredictions.length > 0) {
        predictions.set(id, entityPredictions);
      }
    }

    return predictions;
  }

  // ========================================================================
  // Proximity Detection
  // ========================================================================

  /**
   * Find entities near a location
   */
  findNearbyEntities(
    targetCoordinates: { x: number; y: number; z?: number },
    radius: number,
    entityType?: string
  ): Location[] {
    const nearby: Location[] = [];

    for (const location of this.entityLocations.values()) {
      // Filter by entity type if specified
      if (entityType && !location.entityName.includes(entityType)) {
        continue;
      }

      // Calculate distance
      const dx = location.coordinates.x - targetCoordinates.x;
      const dy = location.coordinates.y - targetCoordinates.y;
      const dz = (location.coordinates.z || 0) - (targetCoordinates.z || 0);
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (distance <= radius) {
        nearby.push(location);
      }
    }

    return nearby.sort((a, b) => {
      const distA = Math.sqrt(
        Math.pow(a.coordinates.x - targetCoordinates.x, 2) +
        Math.pow(a.coordinates.y - targetCoordinates.y, 2)
      );
      const distB = Math.sqrt(
        Math.pow(b.coordinates.x - targetCoordinates.x, 2) +
        Math.pow(b.coordinates.y - targetCoordinates.y, 2)
      );
      return distA - distB;
    });
  }

  /**
   * Detect proximity between two entities
   */
  detectProximity(
    entityId1: string,
    entityId2: string,
    threshold: number = 5 // meters
  ): boolean {
    const loc1 = this.entityLocations.get(entityId1);
    const loc2 = this.entityLocations.get(entityId2);

    if (!loc1 || !loc2) {
      return false;
    }

    const dx = loc1.coordinates.x - loc2.coordinates.x;
    const dy = loc1.coordinates.y - loc2.coordinates.y;
    const dz = (loc1.coordinates.z || 0) - (loc2.coordinates.z || 0);
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    return distance <= threshold;
  }

  // ========================================================================
  // Statistics & Monitoring
  // ========================================================================

  /**
   * Get location statistics
   */
  getStatistics(): {
    totalEntities: number;
    entitiesPerZone: Map<string, number>;
    zoneOccupancy: Map<string, number>;
  } {
    const entitiesPerZone = new Map<string, number>();
    const zoneOccupancy = new Map<string, number>();

    // Count entities per zone
    for (const location of this.entityLocations.values()) {
      const count = entitiesPerZone.get(location.zone) || 0;
      entitiesPerZone.set(location.zone, count + 1);

      // Calculate zone occupancy percentage
      const zone = this.zones.get(location.zone);
      if (zone) {
        const area = (zone.boundaries.xMax - zone.boundaries.xMin) *
                    (zone.boundaries.yMax - zone.boundaries.yMin);
        const occupancy = (count / area) * 100;
        zoneOccupancy.set(location.zone, occupancy);
      }
    }

    return {
      totalEntities: this.entityLocations.size,
      entitiesPerZone,
      zoneOccupancy,
    };
  }

  /**
   * Get movement history for an entity
   */
  getMovementHistory(entityId: string, limit: number = 10): Location[] {
    const history = this.locationHistory.get(entityId);
    if (!history) {
      return [];
    }

    return history.slice(-limit);
  }
}

// Export singleton instance
export const locationTrackingService = new LocationTrackingService();
