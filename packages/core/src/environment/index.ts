/**
 * Environment Center Module
 *
 * Provides distributed environment center management for the Active Collaboration IoT Framework
 */

// Classes
export { EnvironmentCenter } from './EnvironmentCenter.js';
export { EnvironmentRegistry, environmentRegistry } from './EnvironmentRegistry.js';
export { LocalDiscovery, localDiscovery } from './LocalDiscovery.js';
export {
  CrossCenterRouterStub,
  crossCenterRouter,
  type ICrossCenterRouter,
} from './CrossCenterRouter.js';

// Types
export type {
  EnvironmentCenterData,
  EnvironmentMember,
  ServiceQuery,
  AgentCriteria,
  RouteInfo,
  DiscoveryResult,
  ServiceRegistration,
  EnvironmentStats,
} from './types.js';

export type {
  RouterConfig,
  RoutingResult,
  RouterStats,
} from './CrossCenterRouter.js';

// Re-export shared types
export type { Device, Service, Agent, Message } from './types.js';
