/**
 * Environment Configuration Types
 *
 * These types define the structure of environment configuration files
 * used for batch importing devices, agents, and scenarios.
 */

export interface EnvironmentConfig {
  version: string;
  environment: {
    id: string;
    name: string;
    description?: string;
    owner?: string;
  };
  devices: DeviceConfig[];
  agents: AgentConfig[];
  scenarios?: ScenarioConfig[];
}

export interface DeviceConfig {
  id: string;
  name: string;
  type: string;
  brand?: string;
  model?: string;
  capabilities: string[];
  location: {
    building: string;
    floor: number;
    room: string;
    coordinates: {
      x: number;
      y: number;
      z: number;
    };
  };
  behavior: {
    type: 'periodic' | 'event-driven' | 'random';
    interval?: number;
    initialState: Record<string, any>;
  };
  commands?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface AgentConfig {
  id: string;
  name: string;
  type: 'cognitive' | 'reactive';
  capabilities: string[];
  boundDevices: string[];
  config: {
    llmModel: string;
    decisionThreshold?: number;
    enableAutoCollaboration?: boolean;
  };
}

export interface ScenarioConfig {
  id: string;
  name: string;
  description?: string;
  trigger: {
    type: 'manual' | 'automatic';
    description?: string;
  };
  expectedOutcome?: {
    acBuilt?: boolean;
    participants?: number;
    [key: string]: any;
  };
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;
    message: string;
    code?: string;
  }>;
}
