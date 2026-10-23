/**
 * Physics-related types shared between core and simulation packages.
 *
 * These types define the physical parameters that can be simulated and measured
 * in the IoT environment.
 */

/**
 * All supported physical parameters in the simulation.
 * These represent measurable quantities in the physical environment.
 */
export type PhysicalParameter =
  | 'temperature'    // Temperature in degrees Celsius
  | 'humidity'       // Relative humidity percentage (0-100)
  | 'pressure'       // Atmospheric pressure in hPa
  | 'light'          // Light intensity in lux
  | 'airQuality'     // Air quality index (AQI)
  | 'noise'          // Noise level in decibels
  | 'motion'         // Motion detection (boolean as 0/1)
  | 'occupancy'      // Occupancy count
  | 'power'          // Power consumption in watts
  | 'voltage'        // Voltage in volts
  | 'current'        // Current in amperes
  | 'frequency'      // Frequency in Hz
  | 'co2'            // CO2 concentration in ppm
  | 'pm25'           // PM2.5 particulate matter in μg/m³
  | 'pm10';          // PM10 particulate matter in μg/m³

/**
 * Represents the physical state of an environment or device.
 * Keys are physical parameters, values are their measurements.
 */
export type PhysicalState = {
  [K in PhysicalParameter]?: number;
};

/**
 * Configuration for a physics effect.
 */
export interface PhysicsEffectConfig {
  /** The physical parameter this effect modifies */
  parameter: PhysicalParameter;
  /** The target value or delta to apply */
  value: number;
  /** Rate of change (units per second) */
  rate?: number;
  /** Radius of effect in meters */
  radius?: number;
  /** Whether the value is absolute (true) or relative delta (false) */
  isAbsolute?: boolean;
}

/**
 * A physics effect applied by a device.
 * Extends PhysicsEffectConfig with device-specific information.
 */
export interface DevicePhysicsEffect extends PhysicsEffectConfig {
  /** ID of the device causing this effect */
  deviceId: string;
  /** Timestamp when the effect was created */
  timestamp: number;
  /** Optional duration in milliseconds (0 = instant, -1 = continuous) */
  duration?: number;
}

/**
 * Threshold configuration for monitoring physical parameters.
 */
export interface PhysicsThreshold {
  /** The parameter to monitor */
  parameter: PhysicalParameter;
  /** Minimum value (triggers low alert) */
  min?: number;
  /** Maximum value (triggers high alert) */
  max?: number;
  /** Target/ideal value */
  target?: number;
  /** Tolerance range around target */
  tolerance?: number;
}

/**
 * Result of a physics threshold check.
 */
export interface ThresholdCheckResult {
  /** Whether the value is within acceptable range */
  isOk: boolean;
  /** Current value */
  value: number;
  /** The threshold configuration */
  threshold: PhysicsThreshold;
  /** Alert level: 'normal' | 'warning' | 'critical' */
  level: 'normal' | 'warning' | 'critical';
  /** Human-readable message */
  message?: string;
}

/**
 * Configuration for physics simulation.
 */
export interface PhysicsConfig {
  /** Time step for simulation in milliseconds */
  timeStep?: number;
  /** Enable thermal simulation */
  enableThermal?: boolean;
  /** Enable airflow simulation */
  enableAirflow?: boolean;
  /** Enable light propagation */
  enableLight?: boolean;
  /** Gravity constant (default 9.81) */
  gravity?: number;
  /** Air density (default 1.225 kg/m³) */
  airDensity?: number;
}
