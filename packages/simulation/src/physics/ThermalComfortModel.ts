/**
 * Thermal Comfort Model
 *
 * Implements ASHRAE 55 thermal comfort calculations including:
 * - PMV (Predicted Mean Vote): -3 (cold) to +3 (hot)
 * - PPD (Predicted Percentage Dissatisfied): 0-100%
 *
 * Based on Fanger's Thermal Comfort Model (1970)
 * Reference: ASHRAE Standard 55 - Thermal Environmental Conditions for Human Occupancy
 */


import { createLogger } from '@active-collaboration/shared';
/**
 * Thermal comfort configuration
 */
const logger = createLogger('ThermalComfortModel');

export interface ThermalComfortConfig {
  // Default human factors
  defaultClothingInsulation: number;  // clo (1 clo = 0.155 m²K/W)
  defaultMetabolicRate: number;       // met (1 met = 58.2 W/m²)

  // Comfort thresholds
  comfortPMVRange: { min: number; max: number };  // Default: -0.5 to +0.5
  comfortablePPDThreshold: number;   // Default: 10% (PPD <= 10% is comfortable)
}

/**
 * Thermal comfort result
 */
export interface ThermalComfortResult {
  pmv: number;   // Predicted Mean Vote (-3 to +3)
  ppd: number;   // Predicted Percentage Dissatisfied (0-100%)
  sensation: ThermalSensation;
  comfortLevel: 'comfortable' | 'slightly_uncomfortable' | 'uncomfortable';
  recommendation?: string;
}

/**
 * Thermal sensation scale
 */
export type ThermalSensation =
  | 'cold'           // PMV < -2.5
  | 'cool'           // -2.5 <= PMV < -1.5
  | 'slightly_cool'  // -1.5 <= PMV < -0.5
  | 'neutral'        // -0.5 <= PMV <= 0.5
  | 'slightly_warm'  // 0.5 < PMV <= 1.5
  | 'warm'           // 1.5 < PMV <= 2.5
  | 'hot';           // PMV > 2.5

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<ThermalComfortConfig> = {
  defaultClothingInsulation: 0.5,  // 0.5 clo (typical indoor clothing)
  defaultMetabolicRate: 1.0,       // 1.0 met (sedentary activity)
  comfortPMVRange: { min: -0.5, max: 0.5 },
  comfortablePPDThreshold: 10,
};

/**
 * Physical constants
 */
const CONSTANTS = {
  // Convective heat transfer coefficient constant
  C1: 0.303,
  C2: 0.028,
  // Evaporative heat transfer coefficient
  HE: 16.7,  // W/(m²·kPa) at 1 met
  // Saturation vapor pressure calculation
  C3: 3.05,
  C4: 0.35,
  C5: 0.0014,
  // Radiation and convection constants
  C6: 0.42,
  C7: 0.017,
  // Additional constants for heat loss calculation
  C8: 0.0014,
  C9: 0.0,
  C10: 0.023,
  C11: 0.2,
  // Mechanical efficiency
  ETA: 0.0,  // For sedentary activity
  // Stefan-Boltzmann constant (W/(m²·K⁴))
  SIGMA: 5.67e-8,
  // Clothing area factor coefficient
  FCL_COEFF: 0.31,
  // Skin temperature coefficients
  TSK1: 35.7,
  TSK2: 0.028,
  // Sweat rate coefficient
  RS: 0.041,
};

/**
 * Thermal Comfort Model Class
 *
 * Implements Fanger's thermal comfort equations for PMV and PPD calculations.
 */
export class ThermalComfortModel {
  private config: Required<ThermalComfortConfig>;

  constructor(config: Partial<ThermalComfortConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.info('Initialized with config:', {
      defaultClothing: `${this.config.defaultClothingInsulation} clo`,
      defaultMetabolicRate: `${this.config.defaultMetabolicRate} met`,
      comfortPMVRange: `[${this.config.comfortPMVRange.min}, ${this.config.comfortPMVRange.max}]`,
      comfortablePPDThreshold: `${this.config.comfortablePPDThreshold}%`,
    });
  }

  /**
   * Calculate PMV (Predicted Mean Vote)
   *
   * PMV formula based on ASHRAE 55 / ISO 7730:
   * PMV = (0.303 * exp(-0.036*M) + 0.028) * L
   * Where L is the thermal load (heat balance)
   *
   * @param airTemp - Air temperature (°C)
   * @param meanRadiantTemp - Mean radiant temperature (°C)
   * @param airVelocity - Air velocity (m/s)
   * @param humidity - Relative humidity (%)
   * @param clothing - Clothing insulation (clo), optional
   * @param metabolicRate - Metabolic rate (met), optional
   * @returns PMV value (-3 to +3)
   */
  calculatePMV(
    airTemp: number,
    meanRadiantTemp: number,
    airVelocity: number,
    humidity: number,
    clothing?: number,
    metabolicRate?: number
  ): number {
    const clo = clothing ?? this.config.defaultClothingInsulation;
    const met = metabolicRate ?? this.config.defaultMetabolicRate;

    // Convert units
    const M = met * 58.2;  // W/m² (metabolic rate)
    const W = 0;           // W/m² (external work, assumed 0 for sedentary)
    const Icl = clo * 0.155;  // m²·K/W (clothing insulation)

    // Calculate clothing surface temperature and area factor
    const fcl = this.calculateClothingAreaFactor(clo);

    // Calculate heat transfer coefficients
    const { hc, tcl } = this.iterateClothingTemperature(
      airTemp,
      meanRadiantTemp,
      airVelocity,
      M,
      Icl,
      fcl
    );

    // Calculate partial water vapor pressure (kPa)
    const pa = this.calculateVaporPressure(humidity, airTemp);

    // Calculate heat loss components
    // 1. Skin heat loss (radiation + convection)
    const hl1 = fcl * (3.96e-8 * Math.pow(tcl + 273.15, 4) -
      Math.pow(meanRadiantTemp + 273.15, 4) / 1.0);

    const hl2 = fcl * hc * (tcl - airTemp);

    // 2. Respiration sensible heat loss
    const hl3 = 1.7e-5 * M * (3068.2 - pa);

    // 3. Respiration latent heat loss
    const hl4 = 1.7e-5 * M * 5867;

    // 4. Skin diffusion heat loss
    const hl5 = 3.05e-3 * (5733 - 6.99 * M - pa);

    // 5. Sweat evaporation heat loss
    const hl6 = 0.42 * (M - 58.2);

    // Total heat loss
    const totalHeatLoss = hl1 + hl2 + hl3 + hl4 + hl5 + hl6;

    // Thermal load (difference between heat production and heat loss)
    const L = (M - W) - totalHeatLoss;

    // PMV calculation
    const pmv = (CONSTANTS.C1 * Math.exp(-0.036 * M) + CONSTANTS.C2) * L;

    // Clamp to valid range
    const clampedPMV = Math.max(-3, Math.min(3, pmv));

    logger.info('PMV calculation:', {
      inputs: { airTemp: `${airTemp}°C`, mrt: `${meanRadiantTemp}°C`, velocity: `${airVelocity}m/s`, rh: `${humidity}%` },
      params: { clo, met, M: `${M.toFixed(1)}W/m²`, fcl: fcl.toFixed(3) },
      heatLoss: { radiation: hl1.toFixed(2), convection: hl2.toFixed(2), respiration: (hl3 + hl4).toFixed(2), skin: (hl5 + hl6).toFixed(2) },
      result: { L: L.toFixed(2), pmv: clampedPMV.toFixed(2) },
    });

    return clampedPMV;
  }

  /**
   * Calculate PPD (Predicted Percentage Dissatisfied)
   *
   * PPD formula: PPD = 100 - 95 * exp(-0.03353*PMV^4 - 0.2179*PMV^2)
   *
   * @param pmv - PMV value (-3 to +3)
   * @returns PPD percentage (0-100%)
   */
  calculatePPD(pmv: number): number {
    // Ensure PMV is within valid range
    const clampedPMV = Math.max(-3, Math.min(3, pmv));

    // PPD calculation
    const ppd = 100 - 95 * Math.exp(
      -0.03353 * Math.pow(clampedPMV, 4) - 0.2179 * Math.pow(clampedPMV, 2)
    );

    // Clamp to valid range
    const clampedPPD = Math.max(5, Math.min(100, ppd));

    logger.info(`PPD calculation: PMV=${pmv.toFixed(2)} -> PPD=${clampedPPD.toFixed(1)}%`);

    return clampedPPD;
  }

  /**
   * Evaluate thermal comfort and provide comprehensive result
   *
   * @param airTemp - Air temperature (°C)
   * @param meanRadiantTemp - Mean radiant temperature (°C)
   * @param airVelocity - Air velocity (m/s)
   * @param humidity - Relative humidity (%)
   * @param clothing - Clothing insulation (clo), optional
   * @param metabolicRate - Metabolic rate (met), optional
   * @returns Complete thermal comfort evaluation
   */
  evaluateComfort(
    airTemp: number,
    meanRadiantTemp: number,
    airVelocity: number,
    humidity: number,
    clothing?: number,
    metabolicRate?: number
  ): ThermalComfortResult {
    const pmv = this.calculatePMV(
      airTemp,
      meanRadiantTemp,
      airVelocity,
      humidity,
      clothing,
      metabolicRate
    );

    const ppd = this.calculatePPD(pmv);
    const sensation = this.getThermalSensation(pmv);
    const comfortLevel = this.getComfortLevel(pmv, ppd);
    const recommendation = this.getRecommendation(pmv, airTemp, humidity, airVelocity);

    return {
      pmv,
      ppd,
      sensation,
      comfortLevel,
      recommendation,
    };
  }

  /**
   * Get thermal sensation from PMV value
   */
  getThermalSensation(pmv: number): ThermalSensation {
    if (pmv < -2.5) return 'cold';
    if (pmv < -1.5) return 'cool';
    if (pmv < -0.5) return 'slightly_cool';
    if (pmv <= 0.5) return 'neutral';
    if (pmv <= 1.5) return 'slightly_warm';
    if (pmv <= 2.5) return 'warm';
    return 'hot';
  }

  /**
   * Get comfort level based on PMV and PPD
   */
  getComfortLevel(pmv: number, ppd: number): 'comfortable' | 'slightly_uncomfortable' | 'uncomfortable' {
    const absPMV = Math.abs(pmv);

    if (absPMV <= 0.5 && ppd <= this.config.comfortablePPDThreshold) {
      return 'comfortable';
    } else if (absPMV <= 1.0 && ppd <= 25) {
      return 'slightly_uncomfortable';
    } else {
      return 'uncomfortable';
    }
  }

  /**
   * Get comfort recommendation
   */
  private getRecommendation(
    pmv: number,
    airTemp: number,
    humidity: number,
    airVelocity: number
  ): string {
    const absPMV = Math.abs(pmv);

    if (absPMV <= 0.5) {
      return 'Thermal environment is comfortable';
    }

    if (pmv < -0.5) {
      // Too cold
      if (airVelocity > 0.2) {
        return 'Reduce air velocity or increase temperature to improve comfort';
      }
      if (airTemp < 20) {
        return 'Increase air temperature to improve thermal comfort';
      }
      return 'Consider increasing temperature or adding clothing';
    } else {
      // Too warm
      if (humidity > 60) {
        return 'Reduce humidity or increase ventilation to improve comfort';
      }
      if (airVelocity < 0.1) {
        return 'Increase air velocity to improve thermal comfort';
      }
      return 'Consider reducing temperature or improving ventilation';
    }
  }

  /**
   * Calculate clothing area factor (fcl)
   *
   * fcl = 1.0 + 0.31 * clo (for clo <= 0.5)
   * fcl = 1.05 + 0.1 * clo (for clo > 0.5)
   */
  private calculateClothingAreaFactor(clo: number): number {
    if (clo <= 0.5) {
      return 1.0 + 0.31 * clo;
    } else {
      return 1.05 + 0.1 * clo;
    }
  }

  /**
   * Iterate to find clothing surface temperature
   *
   * Uses iterative method to solve for tcl and hc simultaneously
   */
  private iterateClothingTemperature(
    ta: number,      // Air temperature
    tr: number,      // Mean radiant temperature
    va: number,      // Air velocity
    M: number,       // Metabolic rate (W/m²)
    Icl: number,     // Clothing insulation (m²·K/W)
    fcl: number      // Clothing area factor
  ): { hc: number; tcl: number } {
    // Initial estimates
    let tcl = ta;
    let hc = 3.0;  // Minimum convective heat transfer coefficient

    // Iterate until convergence (max 150 iterations)
    for (let i = 0; i < 150; i++) {
      const tclOld = tcl;

      // Calculate convective heat transfer coefficient
      // Natural convection component
      const hcNat = 2.38 * Math.pow(Math.abs(tcl - ta), 0.25);

      // Forced convection component
      const hcFor = 12.1 * Math.sqrt(va);

      // Use the larger value
      hc = Math.max(hcNat, hcFor);

      // Calculate clothing surface temperature
      // tcl = (M - W - E*) / (hc + hr) + ta - (hr/(hc+hr)) * (ta - tr)
      // Simplified iteration formula
      const hr = 4.7;  // Approximate radiative heat transfer coefficient

      const numerator = 35.7 - 0.028 * (M - 0) +
        Icl * (fcl * (hc * ta + hr * tr) - hc * ta - hr * tr);
      const denominator = 1 + Icl * fcl * (hc + hr);

      tcl = numerator / denominator;

      // Check convergence
      if (Math.abs(tcl - tclOld) < 0.001) {
        break;
      }
    }

    return { hc, tcl };
  }

  /**
   * Calculate water vapor pressure from relative humidity
   *
   * Uses the Arden Buck equation for saturation vapor pressure
   *
   * @param rh - Relative humidity (%)
   * @param temp - Temperature (°C)
   * @returns Vapor pressure (kPa)
   */
  private calculateVaporPressure(rh: number, temp: number): number {
    // Arden Buck equation for saturation vapor pressure (kPa)
    const pSat = 0.61121 * Math.exp(
      (18.678 - temp / 234.5) * (temp / (257.14 + temp))
    );

    // Actual vapor pressure
    return (rh / 100) * pSat;
  }

  /**
   * Calculate the operative temperature
   *
   * Operative temperature is the uniform temperature of an imaginary black enclosure
   * in which an occupant would exchange the same amount of heat by radiation and
   * convection as in the actual non-uniform environment.
   *
   * @param airTemp - Air temperature (°C)
   * @param meanRadiantTemp - Mean radiant temperature (°C)
   * @param airVelocity - Air velocity (m/s)
   * @returns Operative temperature (°C)
   */
  calculateOperativeTemperature(
    airTemp: number,
    meanRadiantTemp: number,
    airVelocity: number
  ): number {
    // For low air velocities (< 0.2 m/s): to = (ta + tr) / 2
    // For higher velocities, use convection/radiation weighting
    let hr = 4.7;  // Approximate radiative coefficient
    let hc: number;

    if (airVelocity < 0.1) {
      hc = 3.0;  // Natural convection
    } else {
      hc = 12.1 * Math.sqrt(airVelocity);  // Forced convection
    }

    // Operative temperature formula
    const to = (hr * meanRadiantTemp + hc * airTemp) / (hr + hc);

    logger.info(`Operative temperature: ta=${airTemp}°C, tr=${meanRadiantTemp}°C -> to=${to.toFixed(1)}°C`);

    return to;
  }

  /**
   * Find the comfort temperature range for given conditions
   *
   * @param humidity - Relative humidity (%)
   * @param airVelocity - Air velocity (m/s)
   * @param clothing - Clothing insulation (clo)
   * @param metabolicRate - Metabolic rate (met)
   * @returns Temperature range for comfort (°C)
   */
  findComfortTemperatureRange(
    humidity: number,
    airVelocity: number,
    clothing?: number,
    metabolicRate?: number
  ): { min: number; max: number } {
    // Binary search to find temperature range where PMV is within [-0.5, 0.5]
    const targetMin = this.config.comfortPMVRange.min;
    const targetMax = this.config.comfortPMVRange.max;

    // Find minimum comfortable temperature (PMV = targetMin)
    let low = 10, high = 30;
    while (high - low > 0.1) {
      const mid = (low + high) / 2;
      const pmv = this.calculatePMV(mid, mid, airVelocity, humidity, clothing, metabolicRate);
      if (pmv < targetMin) {
        low = mid;
      } else {
        high = mid;
      }
    }
    const minTemp = (low + high) / 2;

    // Find maximum comfortable temperature (PMV = targetMax)
    low = 20; high = 35;
    while (high - low > 0.1) {
      const mid = (low + high) / 2;
      const pmv = this.calculatePMV(mid, mid, airVelocity, humidity, clothing, metabolicRate);
      if (pmv < targetMax) {
        low = mid;
      } else {
        high = mid;
      }
    }
    const maxTemp = (low + high) / 2;

    logger.info(`Comfort temperature range: ${minTemp.toFixed(1)}°C to ${maxTemp.toFixed(1)}°C`);

    return { min: minTemp, max: maxTemp };
  }

  /**
   * Get configuration
   */
  getConfig(): Required<ThermalComfortConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<ThermalComfortConfig>): void {
    Object.assign(this.config, updates);
    logger.info('Configuration updated:', updates);
  }
}
