/**
 * Simulation Device Types
 */

import type { DeviceCapability, DeviceLocation as SharedDeviceLocation } from '@active-collaboration/shared';

// Re-export DeviceLocation from shared for consistency
export type DeviceLocation = SharedDeviceLocation;

/**
 * Type guard to check if DeviceLocation is an object (not a string)
 */
export function isStructuredLocation(location: DeviceLocation): location is Exclude<DeviceLocation, string> {
  return typeof location !== 'string';
}

/**
 * Helper to get path from DeviceLocation (works for both string and object forms)
 */
export function getLocationPath(location: DeviceLocation): string {
  if (typeof location === 'string') {
    return location;
  }
  return location.path;
}

/**
 * Device state with history
 */
export interface StateWithHistory<T = any> {
  state: T;
  timestamp: Date;
}

/**
 * Device behavior types
 */
export enum BehaviorType {
  PERIODIC = 'periodic',
  EVENT_DRIVEN = 'event-driven',
  RANDOM = 'random',
  SCRIPTED = 'scripted',
}

/**
 * Device behavior configuration
 */
export interface BehaviorConfig {
  type: string;
  interval?: number; // For periodic behaviors (ms)
  probability?: number; // For random behaviors (0-1)
  conditions?: any[]; // For event-driven behaviors
  script?: any[]; // For scripted behaviors
  [key: string]: any; // Allow additional properties
}

/**
 * Simulated device configuration
 */
export interface SimulatedDeviceConfig {
  id?: string;
  name: string;
  type: string;
  templateId?: string; // Device template identifier
  initialState: any;
  capabilities: DeviceCapability[];
  behaviors: BehaviorConfig[];
  location?: DeviceLocation | string; // Support both old (string) and new (DeviceLocation) formats
  metadata?: Record<string, unknown>;
}

/**
 * Service execution result
 */
export interface ExecutionResult {
  success: boolean;
  result?: any;
  error?: string;
}

/**
 * Time manager configuration
 */
export interface TimeConfig {
  timeScale?: number; // 1 = real time, 10 = 10x speed
  startTime?: Date;
}

/**
 * Physical parameter types for environment simulation
 */
export enum PhysicalParameter {
  // ============================================================================
  // ENVIRONMENTAL PARAMETERS (舒适度参数)
  // ============================================================================
  TEMPERATURE = 'temperature',           // 空气温度 (°C)
  HUMIDITY = 'humidity',                 // 相对湿度 (%)
  PRESSURE = 'pressure',                 // 气压 (hPa)
  LIGHT = 'light',                       // 光照度 (lux)

  // ============================================================================
  // AIR QUALITY PARAMETERS (空气质量参数)
  // ============================================================================
  AIR_QUALITY = 'air_quality',           // 综合空气质量指数 (0-500)
  CO2 = 'co2',                          // 二氧化碳 (ppm)
  PM25 = 'pm2_5',                       // PM2.5细颗粒物 (µg/m³)
  PM10 = 'pm10',                        // PM10可吸入颗粒物 (µg/m³)
  VOC = 'voc',                          // 挥发性有机化合物 (ppb)
  NO2 = 'no2',                          // 二氧化氮 (ppb)
  SO2 = 'so2',                          // 二氧化硫 (ppb)
  O3 = 'o3',                           // 臭氧 (ppb)
  CO = 'co',                           // 一氧化碳 (ppm)
  FORMALDEHYDE = 'formaldehyde',        // 甲醛 (mg/m³)

  // ============================================================================
  // WEATHER PARAMETERS (气象参数)
  // ============================================================================
  WIND_SPEED = 'wind_speed',            // 风速 (m/s)
  WIND_DIRECTION = 'wind_direction',    // 风向 (度, 0=N, 90=E)
  UV_INDEX = 'uv_index',                // 紫外线指数 (0-11+)
  RAINFALL = 'rainfall',                // 降水量 (mm)
  VISIBILITY = 'visibility',            // 能见度 (km)
  CLOUD_COVER = 'cloud_cover',          // 云量 (0-100%)
  DEW_POINT = 'dew_point',              // 露点温度 (°C)
  BAROMETRIC_PRESSURE = 'barometric_pressure', // 大气压 (hPa)

  // ============================================================================
  // MOTION & PRESENCE (运动和存在检测)
  // ============================================================================
  MOTION = 'motion',                    // 运动检测 (boolean)
  PRESENCE = 'presence',                // 人员存在 (boolean)
  OCCUPANCY = 'occupancy',              // 占用率 (0-100%)
  PEOPLE_COUNT = 'people_count',        // 人员数量

  // ============================================================================
  // ENERGY PARAMETERS (能源参数)
  // ============================================================================
  ENERGY_CONSUMPTION = 'energy_consumption', // 能耗 (kWh)
  POWER = 'power',                      // 实时功率 (W)
  VOLTAGE = 'voltage',                  // 电压 (V)
  CURRENT = 'current',                  // 电流 (A)
  FREQUENCY = 'frequency',              // 频率 (Hz)
  POWER_FACTOR = 'power_factor',        // 功率因数 (0-1)

  // ============================================================================
  // TRAFFIC & TRANSPORTATION (交通参数)
  // ============================================================================
  TRAFFIC_FLOW = 'traffic_flow',        // 交通流量 (vehicles/hour)
  TRAFFIC_DENSITY = 'traffic_density',    // 交通密度 (vehicles/km)
  VEHICLE_SPEED = 'vehicle_speed',        // 车辆速度 (km/h)

  // ============================================================================
  // SAFETY & SECURITY (安全安防参数)
  // ============================================================================
  NOISE_LEVEL = 'noise_level',          // 噪音水平 (dB)
  VIBRATION = 'vibration',              // 振动 (mm/s)
  SMOKE = 'smoke',                      // 烟雾浓度 (ppm)
  GAS_LEAK = 'gas_leak',                // 气体泄漏 (ppm)
  DOOR_STATE = 'door_state',            // 门状态 (open/closed)
  WINDOW_STATE = 'window_state',        // 窗户状态 (open/closed)
  ALARM_STATUS = 'alarm_status',        // 报警状态

  // ============================================================================
  // INDOOR ENVIRONMENT (室内环境参数)
  // ============================================================================
  CO2_INDOOR = 'co2_indoor',            // 室内CO2 (ppm)
  PM25_INDOOR = 'pm2_5_indoor',         // 室内PM2.5 (µg/m³)
  TVOC = 'tvoc',                        // 总挥发性有机化合物 (ppb)
  RADON = 'radon',                      // 氡气 (Bq/m³)
  MOLD_RISK = 'mold_risk',              // 发霉风险 (0-100)

  // ============================================================================
  // ACOUSTIC PARAMETERS (声学参数)
  // ============================================================================
  SOUND_LEVEL = 'sound_level',         // 声级 (dB)
  SOUND_PRESSURE = 'sound_pressure',    // 声压 (Pa)
  REVERBERATION_TIME = 'reverberation_time', // 混响时间 (s)

  // ============================================================================
  // WATER PARAMETERS (水务参数)
  // ============================================================================
  WATER_TEMPERATURE = 'water_temperature', // 水温 (°C)
  WATER_LEVEL = 'water_level',          // 水位 (m)
  WATER_FLOW = 'water_flow',            // 水流 (L/min)
  WATER_PRESSURE = 'water_pressure',    // 水压 (Bar)
  PH_LEVEL = 'ph_level',                // pH值 (0-14)
  TDS = 'tds',                          // 总溶解固体 (ppm)
  TURBIDITY = 'turbidity',              // 浊度 (NTU)

  // ============================================================================
  // OUTDOOR/AGRICULTURAL (室外农业参数)
  // ============================================================================
  SOIL_MOISTURE = 'soil_moisture',      // 土壤湿度 (%)
  SOIL_TEMPERATURE = 'soil_temperature', // 土壤温度 (°C)
  SOIL_PH = 'soil_ph',                  // 土壤pH (0-14)
  LEAF_WETNESS = 'leaf_wetness',        // 叶面湿度 (0-100%)
  EVAPOTRANSPIRATION = 'evapotranspiration', // 蒸散发量 (mm)
  SOLAR_RADIATION = 'solar_radiation',  // 太阳辐射 (W/m²)

  // ============================================================================
  // LOCATION & POSITIONING (位置定位参数)
  // ============================================================================
  ELEVATION = 'elevation',              // 海拔 (m)
  LATITUDE = 'latitude',                // 纬度
  LONGITUDE = 'longitude',              // 经度
  ALTITUDE = 'altitude',                // 高度 (m)
  DEPTH = 'depth',                      // 深度 (m)

  // ============================================================================
  // COMFORT PARAMETERS (舒适度参数)
  // ============================================================================
  COMFORT_INDEX = 'comfort_index',     // 舒适度指数 (0-100)
  HEAT_INDEX = 'heat_index',            // 热指数 (°C)
  WIND_CHILL = 'wind_chill',            // 风寒指数 (°C)

  // ============================================================================
  // DEVICE STATUS (设备状态参数)
  // ============================================================================
  BATTERY_LEVEL = 'battery_level',      // 电池电量 (%)
  SIGNAL_STRENGTH = 'signal_strength',  // 信号强度 (dBm)
  CONNECTION_STATUS = 'connection_status', // 连接状态
  OPERATING_TEMP = 'operating_temp',    // 设备运行温度 (°C)
  RUNTIME_HOURS = 'runtime_hours',      // 运行时长 (h)
}

/**
 * Value model interface for parameter generation
 * Calculates physical parameter values based on time and location
 */
export interface ValueModel {
  /**
   * Get value at specific time and location
   */
  getValue(time: Date, location: DeviceLocation): number | boolean;

  /**
   * Get value at specific time, location with spatial offset
   */
  getValueAt(time: Date, location: DeviceLocation, offset: { x: number; y: number; z: number }): number | boolean;
}

/**
 * Physical environment configuration
 */
export interface PhysicalEnvironmentConfig {
  baseTime?: Date;
  globalOffset?: Partial<Record<PhysicalParameter, number>>;
  enableSpatialVariation?: boolean;
  defaultLocation?: DeviceLocation;
  enablePhysics?: boolean; // Enable physics simulation (default: true)
  physicsConfig?: import('../physics/PhysicsLayer.js').PhysicsLayerConfig; // Physics layer config
  /**
   * Simulated duration (in seconds) that one device command execution covers.
   * Controls how much simulated time passes when a device produces a physics
   * effect. Higher values = faster simulated outcomes (e.g., 300s = 5 minutes
   * of cooling per command). Default: 60 (1 minute).
   */
  simDurationSeconds?: number;
}

/**
 * Simulated environment configuration (updated to include physical model)
 */
export interface SimulatedEnvironmentConfig {
  name: string;
  timeScale?: number;
  startTime?: Date;
  enablePhysicalModel?: boolean; // Default: true
  physicalConfig?: PhysicalEnvironmentConfig;
}

// ============================================================================
// ENVIRONMENT EFFECT TYPES
// ============================================================================

/**
 * Effect types for device operations on physical environment
 * - immediate: Instant change (e.g., light on → light level changes immediately)
 * - gradual: Over time (e.g., HVAC cooling → temperature drops over 5 minutes)
 * - persistent: Continuous while device active (e.g., motion sensor reporting)
 */
export type EffectType = 'immediate' | 'gradual' | 'persistent';

/**
 * Condition for triggering an environment effect
 */
export interface EffectCondition {
  parameter: string; // Parameter to check (e.g., 'mode', 'state')
  operator: 'eq' | 'gt' | 'lt' | 'ne'; // Comparison operator
  value: any; // Value to compare against
}

/**
 * Spatial effect configuration
 */
export interface SpatialEffect {
  radius: number; // Effect radius in meters
  falloff?: 'linear' | 'inverse-square'; // How effect diminishes with distance
}

/**
 * Environment effect declaration for device commands
 * Defines how a device command affects physical environment parameters
 */
export interface EnvironmentEffectDeclaration {
  command: string; // Device command that triggers this effect (e.g., 'set-mode', 'turn-on')
  parameter: PhysicalParameter; // Physical parameter affected (e.g., 'temperature', 'light')
  effect: EffectType; // Type of effect (immediate/gradual/persistent)
  magnitude: number; // Effect strength (e.g., -2.5 for cooling, 800 for light in lux)
  duration?: number; // Duration in seconds (for gradual effects)
  condition?: EffectCondition; // Optional trigger condition (e.g., mode='cool')
  spatial?: SpatialEffect; // Optional spatial configuration
}

/**
 * Extended device template interface with environment effects
 * Augments the base DeviceTemplate with effect declarations
 */
export interface DeviceTemplateWithEffects {
  name: string;
  type: string;
  description: string;
  capabilities: string[];
  defaultBehaviors: string[];
  environmentEffects?: EnvironmentEffectDeclaration[]; // Environment effects from device commands
}
