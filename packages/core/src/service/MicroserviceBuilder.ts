/**
 * Microservice Builder
 *
 * Helper utilities for creating MicroserviceService instances.
 * Microservices are independent business logic units that can optionally
 * interact with devices, but are NOT bound to them.
 *
 * Key Principle: Microservices are general-purpose business logic units.
 * - They CAN operate on devices (optional)
 * - They CAN be pure software services (no device involvement)
 * - They CAN aggregate data from multiple sources
 * - They SHOULD be composable and reusable
 */

import { MicroserviceService, MicroserviceConfig } from './MicroserviceService.js';
import {
  ServiceCapabilityBuilder,
  OperationType,
  DataFlow,
  DataType,
  Temporal,
} from './ServiceCapability.js';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('MicroserviceBuilder');

/**
 * Microservice Builder Options
 */


export interface MicroserviceBuilderOptions {
  id: string;
  name: string;
  description: string;
  category: string;
  owner: string;
  location?: string;

  // Capability definition
  operation: OperationType;
  dataFlow: DataFlow;
  dataType: DataType;
  temporal: Temporal;

  // Rich capability descriptions
  canDo: string[];
  cannotDo: string[];
  provides?: string[];
  requires?: string[];
  examples?: string[];
  compatibleWith?: string[];

  // Performance characteristics
  reliability?: number;
  performance?: number;
  accuracy?: number;
  latency?: number;

  // Business logic handler
  handler: (params: Record<string, unknown>, context: unknown) => Promise<unknown>;

  // Optional deployment
  timeout?: number;
  maxRetries?: number;
  tags?: string[];
}

/**
 * Build a MicroserviceService from options
 *
 * This is the primary method for creating microservices.
 * It provides a fluent interface for defining all aspects of a microservice.
 *
 * @example
 * ```typescript
 * const monitorService = buildMicroservice({
 *   id: 'temp-monitor',
 *   name: 'Temperature Monitor',
 *   description: 'Monitors temperature in real-time',
 *   category: 'monitoring',
 *   owner: 'agent-1',
 *   operation: OperationType.READ,
 *   dataFlow: DataFlow.OUTPUT,
 *   dataType: DataType.NUMERIC,
 *   temporal: Temporal.CONTINUOUS,
 *   canDo: [
 *     'CAN: Read temperature from sensors',
 *     'CAN: Provide real-time readings'
 *   ],
 *   cannotDo: [
 *     'CANNOT: Control HVAC systems',
 *     'CANNOT: Modify device states'
 *   ],
 *   handler: async (params, context) => {
 *     // Business logic here
 *     return { temperature: 22.5, unit: '°C' };
 *   }
 * });
 * ```
 */
export function buildMicroservice(
  options: MicroserviceBuilderOptions
): MicroserviceService {
  const capabilityBuilder = new ServiceCapabilityBuilder(
    options.id,
    options.name,
    options.category
  )
    .operation(options.operation)
    .dataFlow(options.dataFlow)
    .dataType(options.dataType)
    .temporal(options.temporal)
    .canDo(...options.canDo)
    .cannotDo(...options.cannotDo)
    .description(options.description);

  // Optional capability fields
  if (options.provides && options.provides.length > 0) {
    capabilityBuilder.provides(...options.provides);
  }
  if (options.requires && options.requires.length > 0) {
    capabilityBuilder.requires(...options.requires);
  }
  if (options.examples && options.examples.length > 0) {
    capabilityBuilder.examples(...options.examples);
  }
  if (options.compatibleWith && options.compatibleWith.length > 0) {
    capabilityBuilder.compatibleWith(...options.compatibleWith);
  }
  if (options.reliability !== undefined) {
    capabilityBuilder.reliability(options.reliability);
  }
  if (options.performance !== undefined) {
    capabilityBuilder.performance(options.performance);
  }
  if (options.accuracy !== undefined) {
    capabilityBuilder.accuracy(options.accuracy);
  }
  if (options.latency !== undefined) {
    capabilityBuilder.latency(options.latency);
  }
  if (options.tags && options.tags.length > 0) {
    capabilityBuilder.tags(...options.tags);
  }

  const capability = capabilityBuilder.build();

  const config: MicroserviceConfig = {
    id: options.id,
    name: options.name,
    description: options.description,
    category: options.category,
    owner: options.owner,
    location: options.location || 'unknown',
    capability,
    handler: options.handler,
    timeout: options.timeout || 10000,
    maxRetries: options.maxRetries || 2,
  };

  const service = new MicroserviceService(config);
  logger.info(`Created microservice: ${service.id}`);

  return service;
}

/**
 * Helper: Create a monitoring microservice (READ operation)
 *
 * Monitoring services observe and report data without modifying anything.
 *
 * @example
 * ```typescript
 * const tempMonitor = createMonitoringService({
 *   id: 'temp-monitor',
 *   name: 'Temperature Monitor',
 *   owner: 'agent-1',
 *   dataType: DataType.NUMERIC,
 *   canMonitor: ['temperature', 'humidity'],
 *   location: 'living-room',
 *   handler: async (params, context) => {
 *     return { temperature: 22.5, unit: '°C' };
 *   }
 * });
 * ```
 */
export function createMonitoringService(options: {
  id: string;
  name: string;
  category?: string;  // Optional category (defaults to 'monitoring')
  owner: string;
  dataType: DataType;
  canMonitor: string[];
  location?: string;
  description?: string;
  handler: (params: Record<string, unknown>, context: unknown) => Promise<unknown>;
}): MicroserviceService {
  return buildMicroservice({
    id: options.id,
    name: options.name,
    description: options.description || `Monitors ${options.canMonitor.join(', ')}`,
    category: options.category || 'monitoring',  // Use provided category or default
    owner: options.owner,
    location: options.location,

    operation: OperationType.MONITOR,
    dataFlow: DataFlow.OUTPUT,
    dataType: options.dataType,
    temporal: Temporal.CONTINUOUS,

    canDo: [
      `CAN: Continuously monitor ${options.canMonitor.join(', ')}`,
      'CAN: Provide real-time readings with timestamps',
      'CAN: Detect threshold violations (configurable)',
      'CAN: Emit alerts when thresholds exceeded',
      'CAN: Log historical data for analysis',
    ],
    cannotDo: [
      'CANNOT: Control devices or modify states',
      'CANNOT: Make autonomous decisions',
      'CANNOT: Execute commands on actuators',
      'CANNOT: Modify environment parameters',
    ],
    provides: [
      ...options.canMonitor.map((m) => `${m}-reading`),
      `${options.canMonitor.join('-')}-history`,
      `${options.canMonitor.join('-')}-alerts`,
    ],
    examples: [`Monitor ${options.canMonitor.join(', ')} at ${options.location || 'target location'}`],

    handler: options.handler,
    tags: ['monitoring', 'observation', ...options.canMonitor],
  });
}

/**
 * Helper: Create a control microservice (WRITE operation)
 *
 * Control services modify device states and environment parameters.
 *
 * @example
 * ```typescript
 * const hvacControl = createControlService({
 *   id: 'hvac-control',
 *   name: 'HVAC Control',
 *   owner: 'agent-2',
 *   canControl: ['hvac', 'thermostat'],
 *   location: 'building-1',
 *   handler: async (params, context) => {
 *     // Execute HVAC control
 *     return { executed: true, newState: 'cooling' };
 *   }
 * });
 * ```
 */
export function createControlService(options: {
  id: string;
  name: string;
  category?: string;  // Optional category (defaults to 'control')
  owner: string;
  canControl: string[];
  location?: string;
  description?: string;
  handler: (params: Record<string, unknown>, context: unknown) => Promise<unknown>;
}): MicroserviceService {
  return buildMicroservice({
    id: options.id,
    name: options.name,
    description: options.description || `Controls ${options.canControl.join(', ')}`,
    category: options.category || 'control',  // Use provided category or default
    owner: options.owner,
    location: options.location,

    operation: OperationType.CONTROL,
    dataFlow: DataFlow.INPUT,
    dataType: DataType.NUMERIC,
    temporal: Temporal.REACTIVE,

    canDo: [
      `CAN: Control ${options.canControl.join(', ')}`,
      'CAN: Execute commands and modify states',
      'CAN: Accept control commands from external systems',
      'CAN: Respond to control requests with confirmation',
      'CAN: Report state changes after execution',
    ],
    cannotDo: [
      'CANNOT: Monitor or observe environment directly',
      'CANNOT: Make autonomous decisions (needs trigger)',
      'CANNOT: Access sensor data',
      'CANNOT: Operate proactively without commands',
    ],
    provides: [
      ...options.canControl.map((c) => `${c}-control`),
      `${options.canControl.join('-')}-state-change`,
    ],
    requires: ['control-command', 'execution-request'],

    examples: [`Control ${options.canControl.join(', ')} at ${options.location || 'target location'}`],

    handler: options.handler,
    tags: ['control', 'actuator', ...options.canControl],
  });
}

/**
 * Helper: Create a coordination microservice (COORDINATE operation)
 *
 * Coordination services orchestrate multiple other services to achieve complex goals.
 *
 * @example
 * ```typescript
 * const climateController = createCoordinationService({
 *   id: 'climate-controller',
 *   name: 'Smart Climate Controller',
 *   owner: 'agent-3',
 *   coordinates: ['temperature-monitor', 'hvac-control'],
 *   goal: 'Maintain optimal temperature',
 *   handler: async (params, context) => {
 *     // Coordinate monitoring + control
 *     return { action: 'cooling', temperature: 22.5 };
 *   }
 * });
 * ```
 */
export function createCoordinationService(options: {
  id: string;
  name: string;
  owner: string;
  coordinates: string[];
  goal: string;
  location?: string;
  description?: string;
  handler: (params: Record<string, unknown>, context: unknown) => Promise<unknown>;
}): MicroserviceService {
  return buildMicroservice({
    id: options.id,
    name: options.name,
    description: options.description || `Coordinates ${options.coordinates.join(', ')} to ${options.goal}`,
    category: 'coordination',
    owner: options.owner,
    location: options.location,

    operation: OperationType.COORDINATE,
    dataFlow: DataFlow.BIDIRECTIONAL,
    dataType: DataType.MIXED,
    temporal: Temporal.CONTINUOUS,

    canDo: [
      `CAN: Coordinate ${options.coordinates.join(', ')}`,
      `CAN: ${options.goal}`,
      'CAN: Make decisions based on monitoring data',
      'CAN: Trigger appropriate control actions',
      'CAN: Adapt strategies automatically',
    ],
    cannotDo: [
      `CANNOT: Operate independently without ${options.coordinates.join(' and ')}`,
      'CANNOT: Access sensors or devices directly (uses other services)',
      'CANNOT: Function if coordinated services are unavailable',
    ],
    requires: [...options.coordinates],
    provides: [
      `intelligent-${options.coordinates.join('-')}`,
      `adaptive-${options.goal.toLowerCase().replace(/\s+/g, '-')}`,
    ],
    examples: [options.goal],

    handler: options.handler,
    tags: ['coordination', 'intelligent', 'automation'],
  });
}

/**
 * Helper: Create an aggregation microservice (AGGREGATE operation)
 *
 * Aggregation services collect and analyze data from multiple sources.
 *
 * @example
 * ```typescript
 * const aggregator = createAggregationService({
 *   id: 'temp-aggregator',
 *   name: 'Temperature Aggregator',
 *   owner: 'agent-4',
 *   aggregates: ['zone1-temp', 'zone2-temp', 'zone3-temp'],
 *   statistics: ['average', 'min', 'max', 'stddev'],
 *   handler: async (params, context) => {
 *     return { average: 22.5, min: 20, max: 25 };
 *   }
 * });
 * ```
 */
export function createAggregationService(options: {
  id: string;
  name: string;
  owner: string;
  aggregates: string[];
  statistics: string[];
  location?: string;
  description?: string;
  handler: (params: Record<string, unknown>, context: unknown) => Promise<unknown>;
}): MicroserviceService {
  return buildMicroservice({
    id: options.id,
    name: options.name,
    description: options.description || `Aggregates ${options.aggregates.join(', ')}`,
    category: 'analytics',
    owner: options.owner,
    location: options.location,

    operation: OperationType.AGGREGATE,
    dataFlow: DataFlow.BIDIRECTIONAL,
    dataType: DataType.TIMESERIES,
    temporal: Temporal.DISCRETE,

    canDo: [
      `CAN: Collect data from ${options.aggregates.length} sources`,
      `CAN: Calculate statistics: ${options.statistics.join(', ')}`,
      'CAN: Aggregate data over time windows',
      'CAN: Generate summary reports and insights',
      'CAN: Identify anomalies in patterns',
    ],
    cannotDo: [
      'CANNOT: Read sensors directly (requires data from monitoring services)',
      'CANNOT: Control devices or change parameters',
      'CANNOT: Make decisions based on aggregated data',
    ],
    requires: [...options.aggregates],
    provides: [
      `aggregated-${options.aggregates[0].split('-')[0]}-stats`,
      `${options.aggregates[0].split('-')[0]}-summary-report`,
    ],
    examples: [`Calculate ${options.statistics[0]} across all ${options.aggregates[0].split('-')[0]} sources`],

    handler: options.handler,
    tags: ['aggregation', 'analytics', 'statistics'],
  });
}
