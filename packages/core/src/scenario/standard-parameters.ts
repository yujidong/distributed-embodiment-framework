/**
 * Standard physical-parameter names — the value set of the simulation
 * package's `PhysicalParameter` enum
 * (`packages/simulation/src/devices/types.ts`).
 *
 * WHY A MIRROR: core must NEVER import @active-collaboration/simulation
 * (arch-guards.vitest.test.ts — the package direction is simulation → core),
 * yet scenario validation needs to know whether a zone-parameter key names a
 * standard parameter (dedicated physics — FEAT-03 `parameterPhysics` /
 * `parameterEffects` only target CUSTOM, non-enum keys). This set is that
 * knowledge, duplicated deliberately. The drift-guard test in the simulation
 * package (`standard-parameters.mirror.vitest.test.ts`) fails the moment the
 * enum and this list diverge — update BOTH together.
 */
export const STANDARD_PHYSICAL_PARAMETERS: ReadonlySet<string> = new Set([
  // Environmental
  'temperature',
  'humidity',
  'pressure',
  'light',
  // Air quality
  'air_quality',
  'co2',
  'pm2_5',
  'pm10',
  'voc',
  'no2',
  'so2',
  'o3',
  'co',
  'formaldehyde',
  // Weather
  'wind_speed',
  'wind_direction',
  'uv_index',
  'rainfall',
  'visibility',
  'cloud_cover',
  'dew_point',
  'barometric_pressure',
  // Motion & presence
  'motion',
  'presence',
  'occupancy',
  'people_count',
  // Energy
  'energy_consumption',
  'power',
  'voltage',
  'current',
  'frequency',
  'power_factor',
  // Traffic
  'traffic_flow',
  'traffic_density',
  'vehicle_speed',
  // Safety & security
  'noise_level',
  'vibration',
  'smoke',
  'gas_leak',
  'door_state',
  'window_state',
  'alarm_status',
  // Indoor environment
  'co2_indoor',
  'pm2_5_indoor',
  'tvoc',
  'radon',
  'mold_risk',
  // Acoustic
  'sound_level',
  'sound_pressure',
  'reverberation_time',
  // Water
  'water_temperature',
  'water_level',
  'water_flow',
  'water_pressure',
  'ph_level',
  'tds',
  'turbidity',
  // Outdoor / agricultural
  'soil_moisture',
  'soil_temperature',
  'soil_ph',
  'leaf_wetness',
  'evapotranspiration',
  'solar_radiation',
  // Location & positioning
  'elevation',
  'latitude',
  'longitude',
  'altitude',
  'depth',
  // Comfort
  'comfort_index',
  'heat_index',
  'wind_chill',
  // Device status
  'battery_level',
  'signal_strength',
  'connection_status',
  'operating_temp',
  'runtime_hours',
]);

/** Whether a zone-parameter key names a standard (enum) physical parameter. */
export function isStandardPhysicalParameter(key: string): boolean {
  return STANDARD_PHYSICAL_PARAMETERS.has(key);
}
