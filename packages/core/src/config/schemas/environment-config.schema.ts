/**
 * Environment Configuration Schema Types
 * This file contains TypeScript type definitions for environment configuration.
 */

export interface EnvironmentConfigSchema {
  version: string;
  environment: {
    id: string;
    name: string;
    description?: string;
    owner?: string;
  };
  devices: DeviceConfigSchema[];
  agents: AgentConfigSchema[];
  scenarios?: ScenarioConfigSchema[];
}

export interface DeviceConfigSchema {
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

export interface AgentConfigSchema {
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

export interface ScenarioConfigSchema {
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
