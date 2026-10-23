/**
 * Devices Module
 */

export { BaseDevice } from './BaseDevice.js';
export { SimulatedDevice } from './SimulatedDevice.js';
export { DeviceFactory } from './DeviceFactory.js';
export { resolveCommandAlias, type CommandInvocationContext } from './handlers/CommandHandler.js';
export {
  applyDeviceControlLoop,
  THERMOSTAT_HYSTERESIS_C,
  HUMIDITY_HYSTERESIS_PCT,
  PURIFIER_PM25_STOP,
  PURIFIER_PM25_RESTART,
  type DeviceControlView,
} from './controllers.js';
export * from './types.js';
export * from './behaviors/index.js';
