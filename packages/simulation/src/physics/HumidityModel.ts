/**
 * Humidity Model
 *
 * Provides realistic humidity modeling including:
 * - Relative/Absolute humidity conversion
 * - Dew point calculation
 * - Vapor pressure calculation
 * - Condensation detection
 * - Humidity diffusion
 * - HVAC humidification/dehumidification support
 *
 * Based on:
 * - Tetens formula for saturation vapor pressure
 * - Antoine equation for vapor pressure
 * - Phase change (condensation/evaporation) calculations
 */

import type { Coordinate3D } from '../spatial/index.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Humidity configuration
 */
const logger = createLogger('HumidityModel');

export interface HumidityConfig {
  enableCondensation: boolean;
  enableEvaporation: boolean;
  saturationVaporPressureModel: 'tetens' | 'antoine';
  defaultTemp: number;  // °C
  defaultHumidity: number;  // %RH
  condensationThreshold: number;  // %RH threshold for condensation
  evaporationThreshold: number;    // %RH threshold for evaporation
}

/**
 * Humidity state
 */
export interface HumidityState {
  relativeHumidity: number;     // %RH (0-100)
  absoluteHumidity: number;     // g/m³
  dewPoint: number;             // °C
  vaporPressure: number;        // hPa
  saturationVaporPressure: number;  // hPa
}

/**
 * Condensation result
 */
export interface CondensationResult {
  condensed: boolean;
  condensationRate: number;     // g/s
  latentHeatReleased: number;   // W
  surfaceDewPoint: number;      // °C
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<HumidityConfig> = {
  enableCondensation: true,
  enableEvaporation: true,
  saturationVaporPressureModel: 'tetens',
  defaultTemp: 20,
  defaultHumidity: 50,
  condensationThreshold: 80,
  evaporationThreshold: 20,
};

/**
 * Humidity Model Class
 *
 * Implements realistic humidity physics.
 */
export class HumidityModel {
  private config: Required<HumidityConfig>;

  // Physical constants
  private static readonly LATENT_HEAT_VAPORIZATION = 2.45e6;  // J/kg (for water)
  private static readonly WATER_DENSITY = 1000;  // kg/m³

  constructor(config: Partial<HumidityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.info('Initialized with config:', {
      enableCondensation: this.config.enableCondensation,
      enableEvaporation: this.config.enableEvaporation,
      model: this.config.saturationVaporPressureModel,
      defaultTemp: `${this.config.defaultTemp}°C`,
      defaultHumidity: `${this.config.defaultHumidity}%`,
    });
  }

  /**
   * Calculate saturation vapor pressure using Tetens formula
   *
   * Formula: P_sat = 6.1078 * exp(17.27 * T / (T + 237.3))
   * Where:
   * - P_sat = saturation vapor pressure (hPa)
   * - T = temperature (°C)
   *
   * @param temp Temperature (°C)
   * @returns Saturation vapor pressure (hPa)
   */
  calculateSaturationVaporPressure(temp: number): number {
    // Tetens formula: P_sat = 6.1078 * exp(17.27 * temp / (temp + 237.3))
    return 6.1078 * Math.exp((17.27 * temp) / (temp + 237.3));
  }

  /**
   * Calculate saturation vapor pressure using Antoine equation
   *
   * Formula: log10(P_sat) = A - B / (C + T)
   * Where:
   * - P_sat = saturation vapor pressure (hPa)
   * - A, B, C are Antoine constants
   * - T = temperature (°C)
   *
   * @param temp Temperature (°C)
   * @returns Saturation vapor pressure (hPa)
   */
  calculateSaturationVaporPressureAntoine(temp: number): number {
    // Antoine equation constants for water (typical values)
    const A = 8.07131;
    const B = 1730.63;
    const C = 233.426;

    // log10(P_sat) = A - B / (C + T)
    return Math.pow(10, A - B / (C + temp));
  }

  /**
   * Convert relative humidity to absolute humidity
   *
   * @param relativeHumidity Relative humidity (%RH)
   * @param temp Temperature (°C)
   * @returns Absolute humidity (g/m³)
   */
  calculateAbsoluteHumidity(relativeHumidity: number, temp: number): number {
    // P_sat = P_sat(T)
    // AH = RH/100 * P_sat * 217 / (T + 273.15)
    // Where:
    // - AH = absolute humidity (g/m³)
    // - RH = relative humidity (%)
    // - P_sat = saturation vapor pressure (hPa)
    // - T = temperature (K)

    const P_sat = this.calculateSaturationVaporPressure(temp);
    const T_kelvin = temp + 273.15;

    return (relativeHumidity / 100) * P_sat * 217 / T_kelvin;
  }

  /**
   * Convert absolute humidity to relative humidity
   *
   * @param absoluteHumidity Absolute humidity (g/m³)
   * @param temp Temperature (°C)
   * @returns Relative humidity (%RH)
   */
  calculateRelativeHumidity(absoluteHumidity: number, temp: number): number {
    const P_sat = this.calculateSaturationVaporPressure(temp);
    const T_kelvin = temp + 273.15;
    // RH = AH / (P_sat * 217 / T_kelvin) * 100
    const maxAH = P_sat * 217 / T_kelvin;
    return (absoluteHumidity / maxAH) * 100;
  }

  /**
   * Calculate dew point temperature
   *
   * @param relativeHumidity Relative humidity (%RH)
   * @param temp Temperature (°C)
   * @returns Dew point temperature (°C)
   */
  calculateDewPoint(relativeHumidity: number, temp: number): number {
    // Magnus formula approximation
    // T_dew ≈ T - (100 - RH)/5
    const dewPoint = temp - (100 - relativeHumidity) / 5;
    return dewPoint;
  }

  /**
   * Calculate vapor pressure
   *
   * @param absoluteHumidity Absolute humidity (g/m³)
   * @param temp Temperature (°C)
   * @returns Vapor pressure (hPa)
   */
  calculateVaporPressure(absoluteHumidity: number, temp: number): number {
    // P_v = AH * R_v * T / 217
    // Where:
    // - P_v = vapor pressure (Pa)
    // - AH = absolute humidity (g/m³)
    // - R_v = specific gas constant for water vapor = 461.5 J/kg·K
    // - T = temperature (K)
    const Rv = 461.5;
    const T = temp + 273.15;  // Convert to Kelvin

    return (absoluteHumidity * Rv * T) / 217000;  // Convert to hPa
  }

  /**
   * Check for condensation on a surface
   *
   * @param humidity Relative humidity (%RH)
   * @param airTemp Air temperature (°C)
   * @param surfaceTemp Surface temperature (°C)
   * @returns Condensation result
   */
  checkCondensation(
    humidity: number,
    airTemp: number,
    surfaceTemp: number
  ): CondensationResult {
    const dewPoint = this.calculateDewPoint(humidity, airTemp);

    // Check if surface temperature is below dew point
    const condensed = surfaceTemp < dewPoint;

    if (!condensed || !this.config.enableCondensation) {
      return { condensed: false, condensationRate: 0, latentHeatReleased: 0, surfaceDewPoint: dewPoint };
    }

    // Calculate condensation rate (simplified model)
    // Rate proportional to temperature difference below dew point
    const tempDiff = dewPoint - surfaceTemp;
    const condensationRate = Math.max(0, tempDiff * 0.1);  // g/s per degree

    // Calculate latent heat released
    // Q = m * L where m = mass rate, L = latent heat
    const massRate = condensationRate / 1000;  // Convert to kg/s
    const latentHeatReleased = massRate * HumidityModel.LATENT_HEAT_VAPORIZATION;  // W

    logger.info('Condensation detected:', {
      airTemp: `${airTemp.toFixed(1)}°C`,
      surfaceTemp: `${surfaceTemp.toFixed(1)}°C`,
      dewPoint: `${dewPoint.toFixed(1)}°C`,
      condensationRate: `${condensationRate.toFixed(3)} g/s`,
      latentHeat: `${latentHeatReleased.toFixed(2)} W`,
    });

    return { condensed, condensationRate, latentHeatReleased, surfaceDewPoint: dewPoint };
  }

  /**
   * Calculate humidity diffusion between cells
   *
   * @param currentHumidity Current cell humidity (%RH)
   * @param neighborHumidities Map of neighbor cell ID to humidity
   * @param diffusivity Diffusion coefficient (m²/s)
   * @param distance Distance to neighbors (m)
   * @param deltaTime Time step (seconds)
   * @returns New humidity after diffusion
   */
  calculateHumidityDiffusion(
    currentHumidity: number,
    neighborHumidities: Map<string, number>,
    diffusivity: number,
    distance: number,
    deltaTime: number
  ): number {
    if (neighborHumidities.size === 0) {
      return currentHumidity;
    }

    // Fick's law of diffusion
    // ∂H/∂t = D * (∂²H/∂x²)
    // Discrete form for multiple neighbors:
    // dH = D * dt * Σ(H_neighbor - H_current) / d²

    let totalDiffusion = 0;
    for (const [_neighborId, neighborHum] of neighborHumidities) {
      const diff = neighborHum - currentHumidity;
      totalDiffusion += (diffusivity * diff * deltaTime) / (distance * distance);
    }

    // Apply diffusion
    const newHumidity = currentHumidity + totalDiffusion;

    logger.info('Diffusion calculation:', {
      initial: `${currentHumidity.toFixed(1)}%`,
      neighborCount: neighborHumidities.size,
      totalDiffusion: `${totalDiffusion.toFixed(3)} %RH`,
      newHumidity: `${newHumidity.toFixed(1)}%`,
    });

    return newHumidity;
  }

  /**
   * Get complete humidity state
   */
  getHumidityState(relativeHumidity: number, temp: number): HumidityState {
    const absoluteHumidity = this.calculateAbsoluteHumidity(relativeHumidity, temp);
    const dewPoint = this.calculateDewPoint(relativeHumidity, temp);
    const vaporPressure = this.calculateVaporPressure(absoluteHumidity, temp);
    const saturationVaporPressure = this.calculateSaturationVaporPressure(temp);

    return {
      relativeHumidity,
      absoluteHumidity,
      dewPoint,
      vaporPressure,
      saturationVaporPressure,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<HumidityConfig>): void {
    Object.assign(this.config, updates);
    logger.info('Configuration updated');
  }
}
