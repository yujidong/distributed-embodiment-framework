/**
 * IDevice - Unified Device Interface
 *
 * This interface provides a common abstraction for both simulated and real devices.
 * Agents interact with devices through this interface, without knowing
 * whether the device is simulated or real.
 *
 * Design Principle:
 * - Agent code is independent of device implementation
 * - Switch between simulated and real devices by changing only the driver
 * - Supports LLM-friendly semantic descriptions
 */

import type { Device, DeviceState, DeviceCapability, DeviceLocation } from '@active-collaboration/shared';

/**
 * Execution result from device command
 */
export interface DeviceExecutionResult {
  success: boolean;
  result?: any;
  error?: string;
  timestamp: Date;
}

/**
 * Semantic capability description for LLM understanding
 */
export interface SemanticCapability {
  /** Capability name (e.g., 'temperature-sensing') */
  name: string;
  /** Human-readable description */
  description: string;
  /** Parameter schema if applicable */
  parameters?: {
    name: string;
    type: 'number' | 'string' | 'boolean' | 'object';
    required: boolean;
    description?: string;
  }[];
  /** Expected output description */
  outputDescription?: string;
  /** Example usage */
  example?: string;
}

 /**
 * Unified Device Interface
 *
 * Extends the base Device interface with additional methods
 * needed for Agent interaction and LLM understanding
 */
export interface IDevice extends Device {
  /**
   * Get current device state
   */
  getState(): DeviceState;

  /**
   * Execute a command on this device
   * @param commandName - Command to execute
   * @param params - Optional parameters for the command
   * @returns Execution result
   */
  executeCommand(commandName: string, params?: any): Promise<DeviceExecutionResult>;

  /**
   * Get semantic description of this device for LLM understanding
   * This allows Agents/LLMs to understand what the device can do
   * without knowing technical details
   */
  getSemanticDescription(): string;

  /**
   * Get detailed semantic capabilities
   * Returns capabilities with human-readable descriptions
   */
  getSemanticCapabilities(): SemanticCapability[];

  /**
   * Check if device is available for commands
   */
  isAvailable(): boolean;

  /**
   * Get device health status
   */
  getHealth(): {
    status: 'healthy' | 'degraded' | 'offline';
    lastResponse?: number; // ms since last command
    errorCount: number;
  };
}

/**
 * Device configuration for creating devices
 */
export interface DeviceConfig {
  id?: string;
  name: string;
  type: string;
  templateId?: string;
  location?: DeviceLocation;
  capabilities: DeviceCapability[];
  initialState?: DeviceState;
  metadata?: Record<string, any>;
}

/**
 * Device type information
 */
export interface DeviceTypeInfo {
  type: string;
  category: 'sensor' | 'actuator' | 'controller' | 'hybrid' | 'communication';
  description: string;
  defaultCapabilities: string[];
  physicalEffects?: {
    parameter: string;
    effect: 'heating' | 'cooling' | 'humidity' | 'light' | 'motion' | 'set';
    magnitude: number;
    radius: number;
  }[];
}
