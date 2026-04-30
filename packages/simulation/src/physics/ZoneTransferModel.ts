/**
 * Zone Transfer Model
 *
 * Manages heat transfer between connected rooms/zones in a building.
 * Supports:
 * - Wall heat transfer (conduction through walls)
 * - Door/window heat transfer (with dynamic open/close)
 * - Air exchange between connected zones
 *
 * Based on:
 * - U-value method for heat transfer through building envelope
 * - Natural ventilation/infiltration calculations
 */

import type { Coordinate3D } from '../spatial/index.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Zone connection configuration
 */
const logger = createLogger('ZoneTransferModel');

export interface ZoneConnection {
  id: string;
  zone1Id: string;
  zone2Id: string;
  connectionType: 'wall' | 'door' | 'window' | 'open_archway' | 'floor' | 'ceiling';
  area: number;              // m² - surface area of connection
  uValue: number;            // W/m²K - thermal transmittance
  isOpen: boolean;           // For doors/windows
  openAirflowFactor: number; // 0-1, air exchange factor when open (0 = no exchange, 1 = max exchange)
  position1?: Coordinate3D;  // Optional: position of the connection
  zone1Volume?: number;       // Optional: volume of zone 1 (m³)
  zone2Volume?: number;       // Optional: volume of zone 2 (m³)
}

/**
 * Zone transfer result
 */
export interface ZoneTransferResult {
  connectionId: string;
  heatFlow: number;          // W (positive = zone1 to zone2)
  massFlow: number;          // kg/s (air mass flow rate)
  energyTransferred: number;  // J (energy transferred)
  airExchangeRate: number;  // m³/s (air exchange rate when open)
}

/**
 * Zone Transfer Model Configuration
 */
export interface ZoneTransferConfig {
  defaultWallUValue: number;     // W/m²K (typical: 0.5-2.5)
  defaultInfiltrationRate: number;  // ACH (air changes per hour)
  enableAirExchange: boolean;
  airExchangeCoefficient: number;  // Default 0.5
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<ZoneTransferConfig> = {
  defaultWallUValue: 0.5,
  defaultInfiltrationRate: 0.35,
  enableAirExchange: true,
  airExchangeCoefficient: 0.5,
};

/**
 * Zone Transfer Model Class
 *
 * Calculates heat and air transfer between building zones
 */
export class ZoneTransferModel {
  private connections: Map<string, ZoneConnection> = new Map();
  private config: Required<ZoneTransferConfig>;

  constructor(config: Partial<ZoneTransferConfig> = {}) {
    this.connections = new Map();
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.info('Initialized with config:', {
      defaultWallUValue: `${this.config.defaultWallUValue} W/m²K`,
      defaultInfiltrationRate: `${this.config.defaultInfiltrationRate} ACH`,
      enableAirExchange: this.config.enableAirExchange,
      airExchangeCoefficient: this.config.airExchangeCoefficient,
    });
  }

  /**
   * Add a zone connection
   */
  addConnection(connection: ZoneConnection): void {
    this.connections.set(connection.id, connection);
    logger.info(`Added connection: ${connection.id}`, {
      type: connection.connectionType,
      zone1: connection.zone1Id,
      zone2: connection.zone2Id,
      area: `${connection.area}m²`,
      uValue: `${connection.uValue} W/m²K`,
    });
  }

  /**
   * Remove a zone connection
   */
  removeConnection(connectionId: string): boolean {
    const removed = this.connections.delete(connectionId);
    if (removed) {
      logger.info(`Removed connection: ${connectionId}`);
    }
    return removed;
  }

  /**
   * Update a zone connection
   */
  updateConnection(connectionId: string, updates: Partial<ZoneConnection>): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      logger.warn(`Connection ${connectionId} not found`);
      return false;
    }

    Object.assign(connection, updates);
    logger.info(`Updated connection ${connectionId}`);
    return true;
  }

  /**
   * Get all connections
   */
  getConnections(): ZoneConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Get connections for a specific zone
   */
  getConnectionsForZone(zoneId: string): ZoneConnection[] {
    return Array.from(this.connections.values()).filter(
      c => c.zone1Id === zoneId || c.zone2Id === zoneId
    );
  }

  /**
   * Calculate heat transfer between zones
   *
   * Uses the formula: Q = U * A * ΔT
   * Where:
   * - Q = heat flow rate (W)
   * - U = thermal transmittance (W/m²K)
   * - A = surface area (m²)
   * - ΔT = temperature difference (°C)
   *
   * @param zoneTemps Map of zone ID to temperature (°C)
   * @param deltaTime Time interval (seconds)
   * @returns Array of zone transfer results
   */
  calculateHeatTransfer(
    zoneTemps: Map<string, number>,
    deltaTime: number
  ): ZoneTransferResult[] {
    const results: ZoneTransferResult[] = [];

    for (const connection of this.connections.values()) {
      const temp1 = zoneTemps.get(connection.zone1Id);
      const temp2 = zoneTemps.get(connection.zone2Id);

      if (temp1 === undefined || temp2 === undefined) {
        logger.warn(`Missing temperature for zone ${connection.zone1Id} or ${connection.zone2Id}`);
        continue;
      }

      const deltaT = temp1 - temp2;

      // Heat flow: Q = U * A * ΔT (W)
      const heatFlow = connection.uValue * connection.area * deltaT;
      const massFlow = 0;  // Simplified: no mass flow for closed connections
      const energyTransferred = heatFlow * deltaTime;

      // Additional air exchange for open doors/windows
      let airExchangeRate = 0;
      if (connection.isOpen && this.config.enableAirExchange) {
        // Air exchange through opening
        // Based on temperature difference (stack effect)
        const heightDiff = 2; // Assume 2m height difference
        const tempDiff = Math.abs(temp1 - temp2);
        const flowFactor = this.config.airExchangeCoefficient * Math.sqrt(tempDiff / heightDiff);
        airExchangeRate = flowFactor * connection.area;  // m³/s
      }

      results.push({
        connectionId: connection.id,
        heatFlow,
        massFlow,
        energyTransferred,
        airExchangeRate,
      });

      logger.info(`Heat transfer for ${connection.id}:`, {
        deltaT: `${deltaT.toFixed(1)}°C`,
        heatFlow: `${heatFlow.toFixed(1)}W`,
        massFlow: `${massFlow.toFixed(4)} kg/s`,
        energyTransferred: `${(energyTransferred / 1000).toFixed(1)} kJ`,
        airExchangeRate: airExchangeRate > 0 ? `${airExchangeRate.toFixed(3)} m³/s` : 'N/A',
      });
    }

    return results;
  }

  /**
   * Calculate infiltration rate for a zone
   * Based on ACH (air changes per hour) and zone volume
   *
   * @param zoneId Zone ID
   * @param zoneVolume Volume of zone (m³)
   * @returns Infiltration rate in m³/h
   */
  calculateInfiltrationRate(_zoneId: string, zoneVolume: number): number {
    return this.config.defaultInfiltrationRate * zoneVolume;
  }

  /**
   * Calculate total building heat loss/gain
   *
   * @param zoneTemps Map of zone ID to temperature (°C)
   * @param _zoneVolumes Map of zone ID to volume (m³)
   * @param _ambientTemp Ambient temperature (°C)
   * @param deltaTime Time interval (seconds)
   * @returns Total heat loss/gain in W
   */
  calculateBuildingHeatLoss(
    zoneTemps: Map<string, number>,
    _zoneVolumes: Map<string, number>,
    _ambientTemp: number,
    deltaTime: number
  ): number {
    const results = this.calculateHeatTransfer(zoneTemps, deltaTime);

    let totalHeatLoss = 0;
    let totalTransferEnergy = 0;

    for (const result of results) {
      totalHeatLoss += result.heatFlow;
      totalTransferEnergy += result.energyTransferred;
    }

    logger.info('Building heat balance:', {
      totalHeatLoss: `${totalHeatLoss.toFixed(1)} W`,
      totalTransferEnergy: `${(totalTransferEnergy / 1000).toFixed(1)} kJ`,
    });

    return totalHeatLoss;
  }

  /**
   * Get configuration
   */
  getConfig(): Required<ZoneTransferConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<ZoneTransferConfig>): void {
    Object.assign(this.config, updates);
    logger.info('Configuration updated');
  }
}
