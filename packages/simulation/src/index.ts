/**
 * Active Collaboration Simulation Package
 *
 * IoT device simulation framework
 */

// Devices
export { BaseDevice } from './devices/BaseDevice.js';
export { SimulatedDevice } from './devices/SimulatedDevice.js';
export { DeviceFactory } from './devices/DeviceFactory.js';
export {
  applyDeviceControlLoop,
  THERMOSTAT_HYSTERESIS_C,
  HUMIDITY_HYSTERESIS_PCT,
  PURIFIER_PM25_STOP,
  PURIFIER_PM25_RESTART,
  type DeviceControlView,
} from './devices/controllers.js';

// Command handlers + capability→command contract (declared = executable)
export { CommandHandlerRegistry } from './devices/handlers/CommandHandlerRegistry.js';
export {
  resolveCommandAlias,
  type CommandInvocationContext,
} from './devices/handlers/CommandHandler.js';
export {
  isCapabilityExecutable,
  isReadOnlyCapabilityName,
  executableCommandsForCapabilities,
  deviceExecutableCommandNames,
  serviceInterfaceForCapabilities,
  capabilityDisplayName,
  acceptedParameterNames,
  validateCommandParams,
  type CommandParamValidation,
  type CommandParameterHint,
  type ServiceActionSpec,
} from './devices/handlers/capability-contract.js';

// Device Types
export * from './devices/types.js';

// Behaviors
export * from './devices/behaviors/index.js';

// Environment
export * from './environment/index.js';

// Physics Simulation
export * from './physics/index.js';

// Spatial
export * from './spatial/index.js';

// Registry
export { DeviceTemplateRegistry } from './registry/DeviceTemplateRegistry.js';
export type { DeviceTemplate } from './registry/DeviceTemplateRegistry.js';

// Services
export { LocationTrackingService, locationTrackingService } from './services/LocationTrackingService.js';
export type { Location, Zone, LocationUpdate, PredictedLocation } from './services/LocationTrackingService.js';


// Simulated Data Source
export { SimulatedDataSource } from './services/SimulatedDataSource.js';
export type {
  SimulatedDataConfig,
  WeatherReading,
  AirQualityReading,
  EnergyReading,
  TrafficReading,
  DeviceReading,
  SecurityEvent,
} from './services/SimulatedDataSource.js';

// Calibration (P3d) - thermal constant fitting
export {
  DEFAULT_THERMAL_RATES,
  fitThermalCurve,
  formatComparison,
  formatPatchSnippet,
  parseThermalCsv,
  rmse,
  sampleCurve,
  simulateThermalCurve,
  toThermalCsv,
  type FitOptions,
  type FitResult,
  type RateRange,
  type SetpointStep,
  type ThermalRates,
  type ThermalSample,
  type ThermalScenario,
} from './calibration/thermalFit.js';
