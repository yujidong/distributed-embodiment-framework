/**
 * Active Collaboration Simulation Package
 *
 * IoT device simulation framework
 */

// Devices
export { BaseDevice } from './devices/BaseDevice.js';
export { SimulatedDevice } from './devices/SimulatedDevice.js';
export { DeviceFactory } from './devices/DeviceFactory.js';

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
