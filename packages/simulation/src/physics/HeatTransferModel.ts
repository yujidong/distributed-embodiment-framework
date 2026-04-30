/**
 * Heat Transfer Model
 *
 * Implements physics-based heat transfer calculations for HVAC simulation.
 * Uses Newton's Law of Cooling, thermal mass response, and HVAC power calculations.
 */


import { createLogger } from '@active-collaboration/shared';
/**
 * Heat transfer configuration
 */
const logger = createLogger('HeatTransferModel');

export interface HeatTransferConfig {
  // Room/building properties
  roomVolume?: number; // m³
  thermalMass?: number; // J/K (Joules per Kelvin) - heat capacity of the room
  surfaceArea?: number; // m² - surface area for heat exchange with outside
  insulationFactor?: number; // 0-1, where 1 = perfectly insulated, 0 = no insulation

  // Air properties
  airDensity?: number; // kg/m³ (default: 1.225 at sea level)
  specificHeat?: number; // J/kg·K (default: 1005 for air)

  // HVAC properties
  hvacEfficiency?: number; // 0-1 (default: 0.9 for modern HVAC)
  maxAirflowRate?: number; // m³/s (maximum airflow rate)
}

/**
 * Heat transfer calculation result
 */
export interface HeatTransferResult {
  temperatureChange: number; // °C
  energyTransferred: number; // Joules
  powerRequired: number; // Watts
  finalTemperature: number; // °C
}

/**
 * Heat Transfer Model Class
 *
 * Provides realistic physics calculations for HVAC systems.
 */
export class HeatTransferModel {
  private config: Required<HeatTransferConfig>;

  // Physical constants
  // private static STEFAN_BOLTZMANN = 5.67e-8; // W/m²·K⁴ - Reserved for future use
  private static DEFAULT_AIR_DENSITY = 1.225; // kg/m³ at sea level, 15°C
  private static DEFAULT_SPECIFIC_HEAT = 1005; // J/kg·K for dry air

  constructor(config: HeatTransferConfig = {}) {
    this.config = {
      roomVolume: config.roomVolume || 100, // m³ (typical room: 5m x 5m x 4m)
      thermalMass: config.thermalMass || 1.225 * 100 * 1005, // J/K (air mass * specific heat)
      surfaceArea: config.surfaceArea || 60, // m² (typical room surface area)
      insulationFactor: config.insulationFactor || 0.8, // decent insulation
      airDensity: config.airDensity || HeatTransferModel.DEFAULT_AIR_DENSITY,
      specificHeat: config.specificHeat || HeatTransferModel.DEFAULT_SPECIFIC_HEAT,
      hvacEfficiency: config.hvacEfficiency || 0.9,
      maxAirflowRate: config.maxAirflowRate || 0.5, // m³/s
    };

    logger.info('Initialized with config:', {
      roomVolume: `${this.config.roomVolume}m³`,
      thermalMass: `${(this.config.thermalMass / 1000).toFixed(1)}kJ/K`,
      surfaceArea: `${this.config.surfaceArea}m²`,
      insulation: `${(this.config.insulationFactor * 100).toFixed(0)}%`,
    });
  }

  /**
   * Calculate temperature change using Newton's Law of Cooling
   *
   * Formula: dT/dt = -k * (T - T_ambient)
   * Where: k = cooling constant, T = current temp, T_ambient = ambient temp
   *
   * @param currentTemp - Current temperature (°C)
   * @param ambientTemp - Ambient temperature (°C)
   * @param coolingConstant - Cooling constant (1/s)
   * @param deltaTime - Time interval (seconds)
   * @returns New temperature after cooling/heating
   */
  calculateNewtonianCooling(
    currentTemp: number,
    ambientTemp: number,
    coolingConstant: number,
    deltaTime: number
  ): number {
    logger.info('Newtonian cooling calculation:', {
      currentTemp,
      ambientTemp,
      coolingConstant,
      deltaTime,
    });

    // T(t) = T_ambient + (T_initial - T_ambient) * e^(-kt)
    const tempDifference = currentTemp - ambientTemp;
    const decayFactor = Math.exp(-coolingConstant * deltaTime);
    const newTemp = ambientTemp + tempDifference * decayFactor;

    logger.info('Result:', {
      tempDifference: `${tempDifference.toFixed(2)}°C`,
      decayFactor: decayFactor.toFixed(4),
      tempChange: `${(newTemp - currentTemp).toFixed(2)}°C`,
      newTemp: `${newTemp.toFixed(2)}°C`,
    });

    return newTemp;
  }

  /**
   * Calculate HVAC heating/cooling power
   *
   * Formula: Q = m_dot * c * (T_outlet - T_inlet)
   * Where: m_dot = mass flow rate, c = specific heat, T = temperatures
   *
   * @param airflowRate - Air flow rate (m³/s)
   * @param inletTemp - Inlet air temperature (°C)
   * @param outletTemp - Outlet air temperature (°C)
   * @param airDensity - Air density (kg/m³, default from config)
   * @param specificHeat - Specific heat capacity (J/kg·K, default from config)
   * @returns Power in Watts
   */
  calculateHVACPower(
    airflowRate: number,
    inletTemp: number,
    outletTemp: number,
    airDensity?: number,
    specificHeat?: number
  ): number {
    const density = airDensity || this.config.airDensity;
    const heat = specificHeat || this.config.specificHeat;

    // Mass flow rate: m_dot = ρ * V_dot
    const massFlowRate = density * airflowRate; // kg/s

    // Heat transfer rate: Q = m_dot * c * ΔT
    const tempDifference = outletTemp - inletTemp;
    const power = massFlowRate * heat * tempDifference; // Watts

    logger.info('HVAC power calculation:', {
      airflowRate: `${airflowRate.toFixed(3)}m³/s`,
      massFlowRate: `${massFlowRate.toFixed(3)}kg/s`,
      tempDifference: `${tempDifference.toFixed(2)}°C`,
      power: `${power.toFixed(1)}W`,
    });

    return power;
  }

  /**
   * Calculate thermal mass response to heating/cooling
   *
   * Formula: Q = mcΔT → ΔT = Q / (mc) * t
   * Where: Q = power input, m = mass, c = specific heat, t = time
   *
   * @param currentTemp - Current temperature (°C)
   * @param targetTemp - Target temperature (°C)
   * @param power - Heating/cooling power (Watts, negative for cooling)
   * @param deltaTime - Time interval (seconds)
   * @returns New temperature after heating/cooling
   */
  calculateThermalMassResponse(
    currentTemp: number,
    targetTemp: number,
    power: number,
    deltaTime: number
  ): number {
    logger.info('Thermal mass response calculation:', {
      currentTemp: `${currentTemp.toFixed(2)}°C`,
      targetTemp: `${targetTemp.toFixed(2)}°C`,
      power: `${power.toFixed(1)}W`,
      deltaTime: `${deltaTime}s`,
    });

    // Energy input: Q = P * t
    const energyInput = power * deltaTime; // Joules

    // Temperature change: ΔT = Q / (mc)
    const tempChange = energyInput / this.config.thermalMass; // °C

    // Apply temperature change
    let newTemp = currentTemp + tempChange;

    // Check if we've reached or passed target temperature
    if ((power > 0 && newTemp >= targetTemp) || (power < 0 && newTemp <= targetTemp)) {
      newTemp = targetTemp;
      logger.info('Target temperature reached');
    }

    logger.info('Result:', {
      energyInput: `${(energyInput / 1000).toFixed(2)}kJ`,
      tempChange: `${tempChange.toFixed(4)}°C`,
      newTemp: `${newTemp.toFixed(2)}°C`,
    });

    return newTemp;
  }

  /**
   * Calculate complete heat transfer with HVAC and ambient exchange
   *
   * Combines:
   * 1. HVAC heating/cooling effect
   * 2. Natural heat exchange with ambient (through walls)
   * 3. Thermal mass response
   *
   * @param currentTemp - Current room temperature (°C)
   * @param ambientTemp - Outside ambient temperature (°C)
   * @param hvacPower - HVAC power (Watts, positive=heating, negative=cooling, 0=off)
   * @param deltaTime - Time interval (seconds)
   * @param coolingConstant - Natural cooling constant (1/s, default: 0.0001)
   * @returns Heat transfer result
   */
  calculateHeatTransfer(
    currentTemp: number,
    ambientTemp: number,
    hvacPower: number,
    deltaTime: number,
    coolingConstant: number = 0.0001
  ): HeatTransferResult {
    logger.info('Complete heat transfer calculation:', {
      currentTemp: `${currentTemp.toFixed(2)}°C`,
      ambientTemp: `${ambientTemp.toFixed(2)}°C`,
      hvacPower: `${hvacPower.toFixed(1)}W`,
      deltaTime: `${deltaTime}s`,
    });

    // Step 1: Natural heat exchange with ambient (Newton's law of cooling)
    const tempAfterAmbientExchange = this.calculateNewtonianCooling(
      currentTemp,
      ambientTemp,
      coolingConstant * this.config.insulationFactor,
      deltaTime
    );

    // Step 2: HVAC heating/cooling effect (thermal mass response)
    // Use power-based approach for spatial attenuation compatibility
    // Power (already attenuated by distance) directly determines temperature change rate
    let tempAfterHVAC = tempAfterAmbientExchange;
    let hvacEnergy = 0;

    if (Math.abs(hvacPower) > 0.1) {
      // Adjust power for HVAC efficiency
      const effectivePower = hvacPower * this.config.hvacEfficiency;

      // Power-based temperature change (no fixed target temperature)
      // This allows spatial attenuation to work correctly:
      // - Higher power (closer to source) → faster temperature change
      // - Lower power (further from source) → slower temperature change
      // Formula: ΔT = P * t / thermal_mass
      // Where P is already attenuated by distance in PhysicsLayer
      const energyInput = effectivePower * deltaTime; // Joules
      const tempChange = energyInput / this.config.thermalMass; // °C

      tempAfterHVAC = tempAfterAmbientExchange + tempChange;
      hvacEnergy = energyInput;

      logger.info('Power-based temperature change:', {
        effectivePower: `${effectivePower.toFixed(1)}W`,
        energyInput: `${(energyInput / 1000).toFixed(2)}kJ`,
        tempChange: `${tempChange.toFixed(4)}°C`,
        newTemp: `${tempAfterHVAC.toFixed(2)}°C`,
      });
    }

    // Calculate results
    const temperatureChange = tempAfterHVAC - currentTemp;
    const ambientEnergy =
      (tempAfterAmbientExchange - currentTemp) * this.config.thermalMass;
    const totalEnergy = ambientEnergy + hvacEnergy;
    const avgPower = totalEnergy / deltaTime;

    const result: HeatTransferResult = {
      temperatureChange,
      energyTransferred: totalEnergy,
      powerRequired: avgPower,
      finalTemperature: tempAfterHVAC,
    };

    logger.info('Final result:', {
      tempChange: `${temperatureChange.toFixed(4)}°C`,
      energyTransferred: `${(totalEnergy / 1000).toFixed(2)}kJ`,
      avgPower: `${avgPower.toFixed(1)}W`,
      finalTemp: `${tempAfterHVAC.toFixed(2)}°C`,
    });

    return result;
  }

  /**
   * Calculate heat loss through building envelope
   *
   * @param indoorTemp - Indoor temperature (°C)
   * @param outdoorTemp - Outdoor temperature (°C)
   * @param surfaceArea - Surface area (m²)
   * @param uValue - U-value (W/m²·K) - thermal transmittance
   * @returns Heat loss in Watts
   */
  calculateHeatLoss(
    indoorTemp: number,
    outdoorTemp: number,
    surfaceArea: number,
    uValue: number = 2.5 // Typical wall U-value (W/m²·K)
  ): number {
    // Q = U * A * ΔT
    const tempDifference = indoorTemp - outdoorTemp;
    const heatLoss = uValue * surfaceArea * tempDifference;

    logger.info('Heat loss calculation:', {
      indoorTemp: `${indoorTemp.toFixed(2)}°C`,
      outdoorTemp: `${outdoorTemp.toFixed(2)}°C`,
      tempDifference: `${tempDifference.toFixed(2)}°C`,
      surfaceArea: `${surfaceArea}m²`,
      uValue: `${uValue}W/m²·K`,
      heatLoss: `${heatLoss.toFixed(1)}W`,
    });

    return heatLoss;
  }

  /**
   * Estimate cooling constant based on room properties
   *
   * @param surfaceArea - Surface area (m²)
   * @param roomVolume - Room volume (m³)
   * @param insulationFactor - Insulation factor (0-1)
   * @returns Cooling constant (1/s)
   */
  estimateCoolingConstant(
    surfaceArea: number,
    roomVolume: number,
    insulationFactor: number
  ): number {
    // Cooling constant depends on surface-area-to-volume ratio and insulation
    // k = (A/V) * (1-insulation) * base_rate
    const surfaceToVolumeRatio = surfaceArea / roomVolume;
    const baseRate = 0.01; // Base cooling rate (1/s)
    const coolingConstant = surfaceToVolumeRatio * (1 - insulationFactor) * baseRate;

    logger.info('Cooling constant estimate:', {
      surfaceToVolumeRatio: `${surfaceToVolumeRatio.toFixed(3)}m⁻¹`,
      insulationFactor: `${(insulationFactor * 100).toFixed(0)}%`,
      coolingConstant: `${(coolingConstant * 1000).toFixed(4)}ms⁻¹`,
    });

    return coolingConstant;
  }

  /**
   * Get configuration
   */
  getConfig(): Required<HeatTransferConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<HeatTransferConfig>): void {
    Object.assign(this.config, updates);
    logger.info('Configuration updated');
  }
}
