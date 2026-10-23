/**
 * Service Capability Description
 *
 * Rich capability descriptions for LLM decision-making in Active Collaboration.
 * Provides structured, detailed descriptions of what a service CAN and CANNOT do.
 */

/**
 * Operation types that services can perform
 */
export enum OperationType {
  // Data operations
  READ = 'read',
  WRITE = 'write',
  UPDATE = 'update',
  DELETE = 'delete',

  // Processing operations
  TRANSFORM = 'transform',
  AGGREGATE = 'aggregate',
  VALIDATE = 'validate',
  FILTER = 'filter',

  // Advanced operations
  ANALYZE = 'analyze',
  PREDICT = 'predict',
  COORDINATE = 'coordinate',
  SYNTHESIZE = 'synthesize',

  // Monitoring operations
  MONITOR = 'monitor',
  TRACK = 'track',
  LOG = 'log',
  ALERT = 'alert',

  // Control operations
  CONTROL = 'control',
  ADJUST = 'adjust',
  REGULATE = 'regulate',
  MANAGE = 'manage',
}

/**
 * Data flow direction
 */
export enum DataFlow {
  INPUT = 'input',       // Service consumes data
  OUTPUT = 'output',     // Service produces data
  BIDIRECTIONAL = 'bidirectional', // Service both consumes and produces
  INTERNAL = 'internal', // Service processes data internally
}

/**
 * Temporal characteristics of service operation
 */
export enum Temporal {
  DISCRETE = 'discrete',       // One-time operation
  CONTINUOUS = 'continuous',   // Ongoing operation
  REACTIVE = 'reactive',       // Responds to events
  PROACTIVE = 'proactive',     // Initiates actions
  PERIODIC = 'periodic',       // Repeats at intervals
}

/**
 * Data types handled by services
 */
export enum DataType {
  NUMERIC = 'numeric',
  TEXT = 'text',
  BOOLEAN = 'boolean',
  IMAGE = 'image',
  AUDIO = 'audio',
  VIDEO = 'video',
  TIMESERIES = 'timeseries',
  GEOSPATIAL = 'geospatial',
  JSON = 'json',
  BINARY = 'binary',
  MIXED = 'mixed',
}

/**
 * Service Capability Description
 *
 * Provides rich, structured description of a service's capabilities
 * optimized for LLM understanding and decision-making.
 */
export interface ServiceCapability {
  // Core identification
  id: string;
  name: string;
  category: string;

  // Operation characteristics
  operationType: OperationType;
  dataFlow: DataFlow;
  dataType: DataType;
  temporal: Temporal;

  // CAN/CANNOT lists for LLM reasoning
  canDo: string[];
  cannotDo: string[];

  // Dependencies
  requires?: string[];    // What this service needs
  provides?: string[];    // What this service produces

  // Quality metrics
  reliability?: number;   // 0-1 score
  performance?: number;   // 0-1 score
  accuracy?: number;      // 0-1 score

  // Constraints
  maxFrequency?: number;  // Maximum invocations per second
  maxDataSize?: number;   // Maximum data size in bytes
  latency?: number;       // Expected latency in milliseconds

  // Examples
  examples?: string[];    // Example use cases

  // Natural language description
  description: string;

  // Tags for semantic matching
  tags?: string[];

  // Related services
  compatibleWith?: string[];  // Services that work well with this one
  conflictsWith?: string[];   // Services that conflict with this one
}

/**
 * Service Capability Builder
 *
 * Helper class to build ServiceCapability descriptions
 */
export class ServiceCapabilityBuilder {
  private capability: Partial<ServiceCapability> = {};

  constructor(id: string, name: string, category: string) {
    this.capability.id = id;
    this.capability.name = name;
    this.capability.category = category;
  }

  operation(type: OperationType): this {
    this.capability.operationType = type;
    return this;
  }

  dataFlow(flow: DataFlow): this {
    this.capability.dataFlow = flow;
    return this;
  }

  dataType(type: DataType): this {
    this.capability.dataType = type;
    return this;
  }

  temporal(temp: Temporal): this {
    this.capability.temporal = temp;
    return this;
  }

  canDo(...capabilities: string[]): this {
    this.capability.canDo = capabilities;
    return this;
  }

  cannotDo(...limitations: string[]): this {
    this.capability.cannotDo = limitations;
    return this;
  }

  requires(...requirements: string[]): this {
    this.capability.requires = requirements;
    return this;
  }

  provides(...outputs: string[]): this {
    this.capability.provides = outputs;
    return this;
  }

  reliability(score: number): this {
    this.capability.reliability = score;
    return this;
  }

  performance(score: number): this {
    this.capability.performance = score;
    return this;
  }

  accuracy(score: number): this {
    this.capability.accuracy = score;
    return this;
  }

  maxFrequency(freq: number): this {
    this.capability.maxFrequency = freq;
    return this;
  }

  maxDataSize(size: number): this {
    this.capability.maxDataSize = size;
    return this;
  }

  latency(ms: number): this {
    this.capability.latency = ms;
    return this;
  }

  description(desc: string): this {
    this.capability.description = desc;
    return this;
  }

  examples(...examples: string[]): this {
    this.capability.examples = examples;
    return this;
  }

  tags(...tags: string[]): this {
    this.capability.tags = tags;
    return this;
  }

  compatibleWith(...services: string[]): this {
    this.capability.compatibleWith = services;
    return this;
  }

  conflictsWith(...services: string[]): this {
    this.capability.conflictsWith = services;
    return this;
  }

  build(): ServiceCapability {
    // Validate required fields
    if (!this.capability.id) throw new Error('Service capability requires id');
    if (!this.capability.name) throw new Error('Service capability requires name');
    if (!this.capability.category) throw new Error('Service capability requires category');
    if (!this.capability.operationType) throw new Error('Service capability requires operationType');
    if (!this.capability.dataFlow) throw new Error('Service capability requires dataFlow');
    if (!this.capability.dataType) throw new Error('Service capability requires dataType');
    if (!this.capability.temporal) throw new Error('Service capability requires temporal');
    if (!this.capability.canDo || this.capability.canDo.length === 0) {
      throw new Error('Service capability requires at least one canDo capability');
    }
    if (!this.capability.cannotDo || this.capability.cannotDo.length === 0) {
      throw new Error('Service capability requires at least one cannotDo limitation');
    }
    if (!this.capability.description) {
      throw new Error('Service capability requires description');
    }

    return this.capability as ServiceCapability;
  }
}

/**
 * Generate LLM prompt from service capability
 * Optimized for LLM decision-making in Active Collaboration
 */
export function generateLLMPrompt(capability: ServiceCapability): string {
  let prompt = `## Service: ${capability.name} (ID: ${capability.id})\n\n`;
  prompt += `**Category**: ${capability.category}\n`;
  prompt += `**Description**: ${capability.description}\n\n`;

  prompt += `### Operation Characteristics\n`;
  prompt += `- **Operation Type**: ${capability.operationType}\n`;
  prompt += `- **Data Flow**: ${capability.dataFlow}\n`;
  prompt += `- **Data Type**: ${capability.dataType}\n`;
  prompt += `- **Temporal**: ${capability.temporal}\n\n`;

  prompt += `### Capabilities\n`;
  prompt += `**CAN DO**:\n`;
  for (const can of capability.canDo) {
    prompt += `- ${can}\n`;
  }
  prompt += `\n**CANNOT DO**:\n`;
  for (const cannot of capability.cannotDo) {
    prompt += `- ${cannot}\n`;
  }
  prompt += `\n`;

  if (capability.requires && capability.requires.length > 0) {
    prompt += `**Requires**:\n`;
    for (const req of capability.requires) {
      prompt += `- ${req}\n`;
    }
    prompt += `\n`;
  }

  if (capability.provides && capability.provides.length > 0) {
    prompt += `**Provides**:\n`;
    for (const prov of capability.provides) {
      prompt += `- ${prov}\n`;
    }
    prompt += `\n`;
  }

  if (capability.examples && capability.examples.length > 0) {
    prompt += `### Examples\n`;
    for (const example of capability.examples) {
      prompt += `- ${example}\n`;
    }
    prompt += `\n`;
  }

  if (capability.tags && capability.tags.length > 0) {
    prompt += `**Tags**: ${capability.tags.join(', ')}\n\n`;
  }

  // Quality metrics
  prompt += `### Quality Metrics\n`;
  if (capability.reliability !== undefined) {
    prompt += `- **Reliability**: ${(capability.reliability * 100).toFixed(1)}%\n`;
  }
  if (capability.performance !== undefined) {
    prompt += `- **Performance**: ${(capability.performance * 100).toFixed(1)}%\n`;
  }
  if (capability.accuracy !== undefined) {
    prompt += `- **Accuracy**: ${(capability.accuracy * 100).toFixed(1)}%\n`;
  }
  prompt += `\n`;

  return prompt;
}

/**
 * Generate JSON specification for LLM consumption
 */
export function generateJSONSpec(capability: ServiceCapability): Record<string, unknown> {
  return {
    id: capability.id,
    name: capability.name,
    category: capability.category,
    description: capability.description,
    operation: {
      type: capability.operationType,
      dataFlow: capability.dataFlow,
      dataType: capability.dataType,
      temporal: capability.temporal,
    },
    capabilities: {
      canDo: capability.canDo,
      cannotDo: capability.cannotDo,
      requires: capability.requires || [],
      provides: capability.provides || [],
    },
    quality: {
      reliability: capability.reliability,
      performance: capability.performance,
      accuracy: capability.accuracy,
    },
    constraints: {
      maxFrequency: capability.maxFrequency,
      maxDataSize: capability.maxDataSize,
      latency: capability.latency,
    },
    examples: capability.examples || [],
    tags: capability.tags || [],
    compatibility: {
      compatibleWith: capability.compatibleWith || [],
      conflictsWith: capability.conflictsWith || [],
    },
  };
}
