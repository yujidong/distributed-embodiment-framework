/**
 * Air Quality Model
 *
 * Provides realistic air quality and pollutant dispersion modeling including
 * - Pollutant dispersion (advection-diffusion)
 * - Natural decay and chemical reactions
 * - Filtration effects
 * - Health risk assessment
 *
 * Supports multiple pollutant types:
 * - PM2.5, PM10 (particulate matter)
 * - CO2 (carbon dioxide)
 * - VOC (volatile organic compounds)
 * - CO (carbon monoxide)
 * - NO2 (nitrogen dioxide)
 */

import type { Coordinate3D } from '../spatial/index.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Pollutant source configuration
 */
const logger = createLogger('AirQualityModel');

export interface PollutantSource {
  id: string;
  pollutantType: PollutantType;
  emissionRate: number;      // µg/s or ppm/s (depending on pollutant)
  position: Coordinate3D;
  active: boolean;
}

/**
 * Pollutant types
 */
export type PollutantType = 'pm25' | 'pm10' | 'co2' | 'voc' | 'co' | 'no2';

/**
 * Air quality configuration
 */
export interface AirQualityConfig {
  enableDecay: boolean;
  enableDeposition: boolean;  // For particles
  defaultVentilationRate: number;  // ACH (air changes per hour)
  outdoorInfiltrationRate: number;  // ACH (infiltration from outside)
}

/**
 * Decay constants for different pollutants (1/s)
 */
export interface PollutantDecayConstants {
  pm25: number;   // Very slow decay (settling)
  pm10: number;   // Slow decay (settling)
  co2: number;    // Very slow decay (metabolic consumption)
  voc: number;    // Moderate decay (chemical reactions)
  co: number;     // Slow decay (oxidation)
  no2: number;    // Moderate decay (oxidation)
}

/**
 * Air quality result
 */
export interface AirQualityResult {
  pollutant: PollutantType;
  concentration: number;  // µg/m³ or ppm
  changeRate: number;     // µg/m³/s or ppm/s
  healthRisk: HealthRisk;
  exposure: ExposureLevel;
}

/**
 * Health risk levels
 */
export type HealthRisk = 'good' | 'moderate' | 'unhealthy_for_sensitive' | 'unhealthy' | 'hazardous';

/**
 * Exposure levels
 */
export type ExposureLevel = 'safe' | 'caution' | 'unhealthy' | 'very_unhealthy' | 'hazardous';

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<AirQualityConfig> = {
  enableDecay: true,
  enableDeposition: true,
  defaultVentilationRate: 0.35, // 0.35 ACH (typical residential)
  outdoorInfiltrationRate: 0.1, // 0.1 ACH (typical infiltration)
};

/**
 * Default decay constants (half-life based)
 */
const DEFAULT_DECAY_CONSTANTS: PollutantDecayConstants = {
  pm25: 0.0001,   // ~3 hours half-life (settling)
  pm10: 0.0002,   // ~8 minutes half-life (settling)
  co2: 0.00001,   // Very slow (metabolic consumption)
  voc: 0.0001,    // ~3 hours half-life (reactions)
  co: 0.0002,     // ~1 hour half-life (oxidation)
  no2: 0.0003,    // ~30 minutes half-life (oxidation)
};

/**
 * Health risk thresholds (based on WHO/EPA standards)
 */
const HEALTH_RISK_THRESHOLDS: Record<PollutantType, { good: number; moderate: number; unhealthy_for_sensitive: number; unhealthy: number; hazardous: number }> = {
  pm25: { good: 12, moderate: 35.5, unhealthy_for_sensitive: 55.5, unhealthy: 150.5, hazardous: 500 }, // µg/m³
  pm10: { good: 54, moderate: 154, unhealthy_for_sensitive: 254, unhealthy: 354, hazardous: 424 }, // µg/m³
  co2: { good: 800, moderate: 1000, unhealthy_for_sensitive: 1500, unhealthy: 2000, hazardous: 5000 }, // ppm
  voc: { good: 0.1, moderate: 0.3, unhealthy_for_sensitive: 0.5, unhealthy: 1.0, hazardous: 3.0 }, // ppm
  co: { good: 4.4, moderate: 9.4, unhealthy_for_sensitive: 15, unhealthy: 30, hazardous: 50 }, // ppm
  no2: { good: 0.05, moderate: 0.1, unhealthy_for_sensitive: 0.2, unhealthy: 0.5, hazardous: 1.0 }, // ppm
};

/**
 * Air Quality Model Class
 *
 * Implements realistic pollutant dispersion and air quality modeling.
 */
export class AirQualityModel {
  private config: Required<AirQualityConfig>;
  private pollutantSources: Map<string, PollutantSource> = new Map();
  private decayConstants: PollutantDecayConstants;

  constructor(config: Partial<AirQualityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.pollutantSources = new Map();
    this.decayConstants = { ...DEFAULT_DECAY_CONSTANTS };

    logger.info('Initialized with config:', {
      enableDecay: this.config.enableDecay,
      enableDeposition: this.config.enableDeposition,
      ventilationRate: `${this.config.defaultVentilationRate} ACH`,
      infiltrationRate: `${this.config.outdoorInfiltrationRate} ACH`,
    });
  }

  /**
   * Register a pollutant source
   */
  registerSource(source: PollutantSource): void {
    this.pollutantSources.set(source.id, source);
    logger.info(`Registered pollutant source:`, {
      id: source.id,
      type: source.pollutantType,
      emissionRate: `${source.emissionRate} ${source.pollutantType === 'co2' ? 'ppm/s' : 'µg/s'}`,
      position: `(${source.position.x}, ${source.position.y}, ${source.position.z || 0})`,
    });
  }

  /**
   * Unregister a pollutant source
   */
  unregisterSource(sourceId: string): boolean {
    const removed = this.pollutantSources.delete(sourceId);
    if (removed) {
      logger.info(`Unregistered pollutant source: ${sourceId}`);
    }
    return removed;
  }

  /**
   * Get all pollutant sources
   */
  getSources(): PollutantSource[] {
    return Array.from(this.pollutantSources.values());
  }

  /**
   * Get active pollutant sources
   */
  getActiveSources(): PollutantSource[] {
    return Array.from(this.pollutantSources.values()).filter(s => s.active);
  }

  /**
   * Calculate pollutant dispersion using advection-diffusion equation
   *
   * @param currentConcentration Current concentration (µg/m³ or ppm)
   * @param neighborConcentrations Map of neighbor ID to concentration
   * @param airflowVelocity Airflow velocity vector (m/s)
   * @param diffusivity Diffusion coefficient (m²/s)
   * @param deltaTime Time step (seconds)
   * @returns New concentration after dispersion
   */
  calculateDispersion(
    currentConcentration: number,
    neighborConcentrations: Map<string, number>,
    airflowVelocity: { x: number; y: number; z: number },
    diffusivity: number,
    deltaTime: number
  ): number {
    if (neighborConcentrations.size === 0) {
      return currentConcentration;
    }

    // Advection-diffusion equation (simplified)
    // ∂C/∂t + D*∇²C + v·∇C
    // Where:
    // - C = concentration
    // - D = diffusivity
    // - v = velocity
    // - ∇ = gradient operator

    let totalChange = 0;

    // Diffusion component (Fick's law)
    let diffusionChange = 0;
    for (const [_neighborId, neighborConc] of neighborConcentrations) {
      const diff = neighborConc - currentConcentration;
      diffusionChange += diff * diffusivity * deltaTime;
    }
    diffusionChange /= neighborConcentrations.size;

    // Advection component (simplified - proportional to velocity)
    const velocityMag = Math.sqrt(
      airflowVelocity.x ** 2 +
      airflowVelocity.y ** 2 +
      airflowVelocity.z ** 2
    );
    const advectionChange = velocityMag * 0.01 * deltaTime;  // Simplified coefficient

    totalChange = diffusionChange + advectionChange;

    return currentConcentration + totalChange;
  }

  /**
   * Calculate natural decay of pollutants
   *
   * @param concentration Current concentration
   * @param pollutantType Type of pollutant
   * @param deltaTime Time step (seconds)
   * @returns New concentration after decay
   */
  calculateDecay(
    concentration: number,
    pollutantType: PollutantType,
    deltaTime: number
  ): number {
    if (!this.config.enableDecay) {
      return concentration;
    }

    // First-order decay: C(t) = C0 * e^(-kt)
    const decayConstant = this.decayConstants[pollutantType] || DEFAULT_DECAY_CONSTANTS[pollutantType];
    const newConcentration = concentration * Math.exp(-decayConstant * deltaTime);

    logger.info('Decay calculation:', {
      pollutant: pollutantType,
      initial: `${concentration.toFixed(2)} ${this.getUnit(pollutantType)}`,
      decayConstant: `${decayConstant.toFixed(6)} 1/s`,
      deltaTime: `${deltaTime.toFixed(1)}s`,
      newConcentration: `${newConcentration.toFixed(2)} ${this.getUnit(pollutantType)}`,
    });

    return newConcentration;
  }

  /**
   * Apply filtration effect
   *
   * @param concentration Current concentration (µg/m³ or ppm)
   * @param filterEfficiency Filter efficiency (0-1)
   * @param airflowRate Airflow rate through filter (m³/s)
   * @param deltaTime Time step (seconds)
   * @returns New concentration after filtration
   */
  applyFiltration(
    concentration: number,
    filterEfficiency: number,
    airflowRate: number,
    deltaTime: number
  ): number {
    if (filterEfficiency <= 0 || airflowRate <= 0) {
      return concentration;
    }

    // Filtration: C_out = C_in * (1 - efficiency)
    // Simplified model: removal rate proportional to efficiency * airflow
    const removalRate = filterEfficiency * airflowRate * 0.001;  // Simplified coefficient
    const removalFraction = removalRate * deltaTime;
    const newConcentration = concentration * (1 - removalFraction);

    logger.info('Filtration calculation:', {
      initial: `${concentration.toFixed(2)}`,
      filterEfficiency: `${(filterEfficiency * 100).toFixed(0)}%`,
      airflowRate: `${airflowRate.toFixed(3)} m³/s`,
      removal: `${(removalFraction * 100).toFixed(2)}%`,
      newConcentration: `${newConcentration.toFixed(2)}`,
    });

    return Math.max(0, newConcentration);
  }

  /**
   * Assess health risk for a specific pollutant
   *
   * @param pollutantType Type of pollutant
   * @param concentration Current concentration
   * @returns Health risk level
   */
  assessHealthRisk(pollutantType: PollutantType, concentration: number): HealthRisk {
    const thresholds = HEALTH_RISK_THRESHOLDS[pollutantType];

    if (concentration <= thresholds.good) {
      return 'good';
    } else if (concentration <= thresholds.moderate) {
      return 'moderate';
    } else if (concentration <= thresholds.unhealthy_for_sensitive) {
      return 'unhealthy_for_sensitive';
    } else if (concentration <= thresholds.unhealthy) {
      return 'unhealthy';
    } else {
      return 'hazardous';
    }
  }

  /**
   * Get exposure level
   *
   * @param pollutantType Type of pollutant
   * @param concentration Current concentration
   * @returns Exposure level
   */
  getExposureLevel(pollutantType: PollutantType, concentration: number): ExposureLevel {
    const thresholds = HEALTH_RISK_THRESHOLDS[pollutantType];

    if (concentration <= thresholds.good) {
      return 'safe';
    } else if (concentration <= thresholds.moderate) {
      return 'caution';
    } else if (concentration <= thresholds.unhealthy_for_sensitive) {
      return 'unhealthy';
    } else if (concentration <= thresholds.unhealthy) {
      return 'very_unhealthy';
    } else {
      return 'hazardous';
    }
  }

  /**
   * Get unit string for pollutant type
   */
  private getUnit(pollutantType: PollutantType): string {
    switch (pollutantType) {
      case 'pm25':
        return 'µg/m³';
      case 'pm10':
        return 'µg/m³';
      case 'co2':
        return 'ppm';
      case 'voc':
      case 'co':
      case 'no2':
        return 'ppm';
      default:
        return 'µg/m³';
    }
  }

  /**
   * Get complete air quality result
   */
  getAirQualityResult(
    pollutantType: PollutantType,
    concentration: number,
    changeRate: number
  ): AirQualityResult {
    const healthRisk = this.assessHealthRisk(pollutantType, concentration);
    const exposure = this.getExposureLevel(pollutantType, concentration);

    return {
      pollutant: pollutantType,
      concentration,
      changeRate,
      healthRisk,
      exposure,
    };
  }

  /**
   * Apply ventilation effect
   *
   * @param concentration Current concentration (µg/m³ or ppm)
   * @param _pollutantType Type of pollutant
   * @param _roomVolume Room volume (m³)
   * @param deltaTime Time step (seconds)
   * @returns New concentration after ventilation
   */
  applyVentilation(
    concentration: number,
    _pollutantType: PollutantType,
    _roomVolume: number,
    deltaTime: number
  ): number {
    // Ventilation: C_out = C_in * ventilation_rate
    // Simple model: C_new = C_old * e^(-ACH * t)
    const ach = this.config.defaultVentilationRate + this.config.outdoorInfiltrationRate;
    const newConcentration = concentration * Math.exp(-ach * deltaTime);

    return newConcentration;
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<AirQualityConfig>): void {
    Object.assign(this.config, updates);
    logger.info('Configuration updated');
  }
}
