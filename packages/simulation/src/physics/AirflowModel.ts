/**
 * Airflow Model
 *
 * Simulates air movement and convective heat transfer.
 * Based on HVAC operation and natural convection principles.
 */

import type { Coordinate3D } from '../spatial/index.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Airflow configuration
 */
const logger = createLogger('AirflowModel');

export interface AirflowConfig {
  enableNaturalConvection: boolean;
  enableForcedConvection: boolean;
  naturalConvectionCoeff: number;  // W/m²K (typical: 2-5)
  forcedConvectionBaseCoeff: number;  // W/m²K
  airDensity: number;  // kg/m³ (default: 1.225)
  specificHeat: number;  // J/kg·K (default: 1005)
}

/**
 * Airflow state at a location
 */
export interface AirflowState {
  velocity: { x: number; y: number; z: number };  // m/s
  direction: number;  // radians (0 to 2π)
  magnitude: number;  // m/s
}

/**
 * HVAC airflow source
 */
export interface HVACAirflowSource {
  id: string;
  position: Coordinate3D;
  velocity: number;  // m/s
  direction: number;  // radians
  temperature?: number;  // °C (optional, for temperature-dependent air density)
}

/**
 * Convection calculation result
 */
export interface ConvectionResult {
  heatTransferCoeff: number;  // W/m²K
  convectionPower: number;    // W (positive = heating, negative = cooling)
  airflowEffect: AirflowState;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<AirflowConfig> = {
  enableNaturalConvection: true,
  enableForcedConvection: true,
  naturalConvectionCoeff: 2.5,  // W/m²K
  forcedConvectionBaseCoeff: 10,  // W/m²K
  airDensity: 1.2,  // kg/m³
  specificHeat: 1005,  // J/kg·K
};

/**
 * Airflow Model Class
 *
 * Provides air movement and convection heat transfer calculations
 * for HVAC and building simulation.
 */
export class AirflowModel {
  private config: Required<AirflowConfig>;

  // Physical constants
  private static readonly GRAVITY = 9.81; // m/s²
  private static readonly THERMAL_EXPANSIVITY = 3.3e-3; // 1/K (thermal expansion coefficient for air)

  constructor(config: Partial<AirflowConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.info('Initialized with config:', {
      enableNaturalConvection: this.config.enableNaturalConvection,
      enableForcedConvection: this.config.enableForcedConvection,
      naturalConvectionCoeff: `${this.config.naturalConvectionCoeff} W/m²K`,
      forcedConvectionBaseCoeff: `${this.config.forcedConvectionBaseCoeff} W/m²K`,
      airDensity: `${this.config.airDensity} kg/m³`,
    });
  }

  /**
   * Calculate natural convection heat transfer coefficient
   *
   * Uses the correlation: h = C * (ΔT/L)^0.25
   * Where:
   * - h = heat transfer coefficient (W/m²K)
   * - ΔT = temperature difference (surface - ambient)
   * - L = characteristic length (height of surface)
   * - C = empirical constant (typically 1.4-2.0 for vertical surfaces)
   *
   * @param surfaceTemp Surface temperature (°C)
   * @param ambientTemp Ambient temperature (°C)
   * @param surfaceHeight Height of the surface (m)
   * @returns Convection result with heat transfer coefficient
   */
  calculateNaturalConvection(
    surfaceTemp: number,
    ambientTemp: number,
    surfaceHeight: number
  ): ConvectionResult {
    if (!this.config.enableNaturalConvection) {
      return {
        heatTransferCoeff: 0,
        convectionPower: 0,
        airflowEffect: { velocity: { x: 0, y: 0, z: 0 }, direction: 0, magnitude: 0 },
      };
    }

    const deltaT = Math.abs(surfaceTemp - ambientTemp);
    const height = Math.max(0.1, surfaceHeight); // Minimum height to avoid division issues

    // Natural convection coefficient using simplified correlation
    // h = C * (ΔT/L)^0.25 for vertical surfaces
    let heatTransferCoeff = this.config.naturalConvectionCoeff;

    if (deltaT > 0.1) {
      // Apply temperature difference effect
      const naturalCoeff = 1.42 * Math.pow(deltaT / height, 0.25);
      heatTransferCoeff = Math.max(heatTransferCoeff, naturalCoeff);
    }

    // Calculate buoyancy-driven velocity
    // v = sqrt(g * β * ΔT * L)
    const buoyancyVelocity = Math.sqrt(
      AirflowModel.GRAVITY * AirflowModel.THERMAL_EXPANSIVITY * deltaT * height
    );

    // Direction: upward if surface is hot, downward if cold
    const direction = surfaceTemp > ambientTemp ? Math.PI / 2 : -Math.PI / 2;

    // Calculate convection power: Q = h * A * ΔT
    // Assuming unit area (1 m²) for simplicity
    const convectionPower = heatTransferCoeff * deltaT;

    const airflowEffect: AirflowState = {
      velocity: {
        x: 0,
        y: buoyancyVelocity * Math.sin(direction),
        z: 0,
      },
      direction,
      magnitude: buoyancyVelocity,
    };

    logger.info('Natural convection:', {
      surfaceTemp: `${surfaceTemp.toFixed(1)}°C`,
      ambientTemp: `${ambientTemp.toFixed(1)}°C`,
      deltaT: `${deltaT.toFixed(2)}K`,
      heatTransferCoeff: `${heatTransferCoeff.toFixed(2)} W/m²K`,
      convectionPower: `${convectionPower.toFixed(2)} W`,
      buoyancyVelocity: `${buoyancyVelocity.toFixed(3)} m/s`,
    });

    return {
      heatTransferCoeff,
      convectionPower,
      airflowEffect,
    };
  }

  /**
   * Calculate forced convection heat transfer coefficient
   *
   * Uses the correlation: h = C * v^0.8
   * Where:
   * - h = heat transfer coefficient (W/m²K)
   * - v = air velocity (m/s)
   * - C = empirical constant (typically 5-15 for HVAC)
   *
   * @param surfaceTemp Surface temperature (°C)
   * @param ambientTemp Ambient temperature (°C)
   * @param airflowVelocity Air velocity (m/s)
   * @returns Convection result
   */
  calculateForcedConvection(
    surfaceTemp: number,
    ambientTemp: number,
    airflowVelocity: number
  ): ConvectionResult {
    if (!this.config.enableForcedConvection || airflowVelocity <= 0) {
      return {
        heatTransferCoeff: 0,
        convectionPower: 0,
        airflowEffect: { velocity: { x: 0, y: 0, z: 0 }, direction: 0, magnitude: 0 },
      };
    }

    // Clamp velocity to reasonable range
    const velocity = Math.min(10, Math.max(0, airflowVelocity));

    // Forced convection coefficient: h = C * v^0.8
    const heatTransferCoeff = this.config.forcedConvectionBaseCoeff * Math.pow(velocity, 0.5);

    const deltaT = Math.abs(surfaceTemp - ambientTemp);
    const convectionPower = heatTransferCoeff * deltaT;

    const airflowEffect: AirflowState = {
      velocity: {
        x: velocity,
        y: 0,
        z: 0,
      },
      direction: 0, // Assume horizontal flow
      magnitude: velocity,
    };

    logger.info('Forced convection:', {
      surfaceTemp: `${surfaceTemp.toFixed(1)}°C`,
      ambientTemp: `${ambientTemp.toFixed(1)}°C`,
      velocity: `${velocity.toFixed(2)} m/s`,
      heatTransferCoeff: `${heatTransferCoeff.toFixed(2)} W/m²K`,
      convectionPower: `${convectionPower.toFixed(2)} W`,
    });

    return {
      heatTransferCoeff,
      convectionPower,
      airflowEffect,
    };
  }

  /**
   * Calculate combined convection (natural + forced)
   *
   * Uses the combination rule: h_combined = (h_natural^n + h_forced^n)^(1/n)
   * where n ≈ 3-4 for mixed convection
   *
   * @param surfaceTemp Surface temperature (°C)
   * @param ambientTemp Ambient temperature (°C)
   * @param airflowVelocity Air velocity (m/s)
   * @param surfaceHeight Height of surface (m)
   * @returns Convection result
   */
  calculateCombinedConvection(
    surfaceTemp: number,
    ambientTemp: number,
    airflowVelocity: number,
    surfaceHeight: number
  ): ConvectionResult {
    const natural = this.calculateNaturalConvection(surfaceTemp, ambientTemp, surfaceHeight);
    const forced = this.calculateForcedConvection(surfaceTemp, ambientTemp, airflowVelocity);

    // Combined convection using power law combination
    // h_combined = (h_n^3 + h_f^3)^(1/3)
    const hNatural = natural.heatTransferCoeff;
    const hForced = forced.heatTransferCoeff;

    const combinedCoeff = Math.pow(
      Math.pow(hNatural, 3) + Math.pow(hForced, 3),
      1 / 3
    );

    const deltaT = Math.abs(surfaceTemp - ambientTemp);
    const convectionPower = combinedCoeff * deltaT;

    // Combined velocity (vector sum approximation)
    const combinedVelocity = {
      x: forced.airflowEffect.velocity.x,
      y: natural.airflowEffect.velocity.y,
      z: 0,
    };
    const combinedMagnitude = Math.sqrt(
      combinedVelocity.x ** 2 + combinedVelocity.y ** 2 + combinedVelocity.z ** 2
    );

    logger.info('Combined convection:', {
      naturalCoeff: `${hNatural.toFixed(2)} W/m²K`,
      forcedCoeff: `${hForced.toFixed(2)} W/m²K`,
      combinedCoeff: `${combinedCoeff.toFixed(2)} W/m²K`,
      convectionPower: `${convectionPower.toFixed(2)} W`,
    });

    return {
      heatTransferCoeff: combinedCoeff,
      convectionPower,
      airflowEffect: {
        velocity: combinedVelocity,
        direction: Math.atan2(combinedVelocity.y, combinedVelocity.x),
        magnitude: combinedMagnitude,
      },
    };
  }

  /**
   * Update airflow field based on HVAC sources
   *
   * @param currentField Current airflow field (location ID -> state)
   * @param hvacSources Active HVAC airflow sources
   * @param deltaTime Time step (seconds)
   * @returns Updated airflow field
   */
  updateAirflowField(
    currentField: Map<string, AirflowState>,
    hvacSources: HVACAirflowSource[],
    deltaTime: number
  ): Map<string, AirflowState> {
    const newField = new Map(currentField);

    // Process each HVAC source
    for (const source of hvacSources) {
      if (source.velocity <= 0) continue;

      // Calculate airflow effect at source location
      const sourceState: AirflowState = {
        velocity: {
          x: source.velocity * Math.cos(source.direction),
          y: source.velocity * Math.sin(source.direction),
          z: 0,
        },
        direction: source.direction,
        magnitude: source.velocity,
      };

      // Update field at source position (using position as key)
      const sourceKey = `${source.position.x},${source.position.y},${source.position.z || 0}`;
      newField.set(sourceKey, sourceState);
    }

    // Apply decay to existing field values (airflow dissipates over distance)
    for (const [key, state] of newField.entries()) {
      const decayFactor = Math.exp(-0.1 * deltaTime); // Simple exponential decay
      newField.set(key, {
        velocity: {
          x: state.velocity.x * decayFactor,
          y: state.velocity.y * decayFactor,
          z: state.velocity.z * decayFactor,
        },
        direction: state.direction,
        magnitude: state.magnitude * decayFactor,
      });
    }

    logger.info('Updated airflow field:', {
      sources: hvacSources.length,
      fieldSize: newField.size,
      deltaTime: `${deltaTime}s`,
    });

    return newField;
  }

  /**
   * Get configuration
   */
  getConfig(): Required<AirflowConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<AirflowConfig>): void {
    Object.assign(this.config, updates);
    logger.info('Configuration updated:', updates);
  }
}
