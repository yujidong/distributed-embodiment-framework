/**
 * Base Device Class
 *
 * Abstract base class for all simulated devices
 */

import type { Device, DeviceState, DeviceCapability, DeviceLocation, ConnectionInfo } from '@active-collaboration/shared';
import { DeviceType, DeviceStatus } from '@active-collaboration/shared';
import type { BehaviorConfig, StateWithHistory, ExecutionResult } from './types.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Abstract base device class
 */
const logger = createLogger('BaseDevice');

export abstract class BaseDevice implements Device {
  public readonly id: string;
  public name: string;
  public readonly type: DeviceType;
  public readonly location: DeviceLocation;  // Location should be immutable after creation
  public status: DeviceStatus;
  public readonly capabilities: DeviceCapability[];
  public readonly metadata: Record<string, unknown>;
  public connectionInfo: ConnectionInfo;
  public lastHeartbeat: Date;

  // State management
  protected currentState: DeviceState;
  protected stateHistory: StateWithHistory[];
  protected maxHistorySize: number = 100;

  // Behaviors
  protected behaviors: BehaviorConfig[] = [];
  protected behaviorTimers: Map<string, NodeJS.Timeout> = new Map();

  // Services array
  public services: Device['services'] = [];

  constructor(config: {
    id: string;
    name: string;
    type: string;
    initialState: DeviceState;
    capabilities: DeviceCapability[];
    location?: DeviceLocation;
    metadata?: Record<string, unknown>;
  }) {
    logger.info(`[BaseDevice:${config.id}] Initializing device: ${config.name}`);

    this.id = config.id;
    this.name = config.name;
    this.type = config.type as DeviceType;

    // Handle location - ensure it's immutable
    const locationValue = config.location || 'simulated';
    if (typeof locationValue === 'object' && locationValue !== null) {
      // Freeze object to prevent modifications
      this.location = Object.freeze({ ...locationValue }) as DeviceLocation;
    } else {
      // Strings are already immutable
      this.location = locationValue;
    }

    this.status = DeviceStatus.ONLINE;
    this.capabilities = config.capabilities;
    this.metadata = Object.freeze(config.metadata || {}); // Also freeze metadata
    this.currentState = config.initialState;
    this.stateHistory = [{ state: config.initialState, timestamp: new Date() }];
    this.lastHeartbeat = new Date();

    this.connectionInfo = {
      protocol: 'http' as const,
      endpoint: `simulated://${this.id}`,
    };

    logger.info(`[BaseDevice:${this.id}] Device initialized`);
  }

  /**
   * Execute a command on this device
   * Device commands are low-level hardware operations (distinct from Agent services)
   * @param commandName - Command name
   * @param params - Command parameters
   * @returns Execution result
   */
  abstract executeCommand(commandName: string, params?: Record<string, unknown>): Promise<ExecutionResult>;

  /**
   * Get current device state
   * @returns Current state
   */
  getState(): DeviceState {
    logger.info(`[BaseDevice:${this.id}] getState() called, returning:`, this.currentState);
    return this.currentState;
  }

  /**
   * Get state history
   * @param limit - Maximum number of history entries
   * @returns State history
   */
  getStateHistory(limit?: number): StateWithHistory[] {
    const historyLimit = limit ?? this.maxHistorySize;
    const history = this.stateHistory.slice(-historyLimit);
    logger.info(`[BaseDevice:${this.id}] Getting state history: ${history.length} entries`);
    return history;
  }

  /**
   * Update device state
   * @param newState - New state
   */
  protected setState(newState: Partial<DeviceState>): void {
    const updatedState = { ...this.currentState, ...newState };
    this.currentState = updatedState;
    this.stateHistory.push({ state: updatedState, timestamp: new Date() });

    // Trim history if needed
    if (this.stateHistory.length > this.maxHistorySize) {
      this.stateHistory = this.stateHistory.slice(-this.maxHistorySize);
    }

    logger.info(`[BaseDevice:${this.id}] State updated:`, Object.keys(newState));
  }

  /**
   * Add a behavior to this device
   * @param behavior - Behavior configuration
   */
  addBehavior(behavior: BehaviorConfig): void {
    logger.info(`[BaseDevice:${this.id}] Adding behavior: ${behavior.type}`);
    this.behaviors.push(behavior);
    this.startBehavior(behavior);
  }

  /**
   * Remove a behavior from this device
   * @param behaviorType - Behavior type to remove
   */
  removeBehavior(behaviorType: string): void {
    logger.info(`[BaseDevice:${this.id}] Removing behavior: ${behaviorType}`);
    this.behaviors = this.behaviors.filter((b) => b.type !== behaviorType);

    // Stop timers for this behavior
    for (const [key, timer] of this.behaviorTimers) {
      if (key.startsWith(`${behaviorType}:`)) {
        clearTimeout(timer);
        this.behaviorTimers.delete(key);
      }
    }
  }

  /**
   * Start a behavior
   * @param behavior - Behavior to start
   */
  protected startBehavior(behavior: BehaviorConfig): void {
    logger.info(`[BaseDevice:${this.id}] Starting behavior: ${behavior.type}`);
    // Subclasses implement specific behavior logic
  }

  /**
   * Stop all behaviors
   */
  stopAllBehaviors(): void {
    logger.info(`[BaseDevice:${this.id}] Stopping all behaviors`);

    for (const timer of this.behaviorTimers.values()) {
      clearTimeout(timer);
    }

    this.behaviors = [];
    this.behaviorTimers.clear();
  }

  /**
   * Get device info as Device object
   * @returns Device object
   */
  getDeviceInfo(): Device {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      location: this.location,
      status: this.status,
      capabilities: this.capabilities,
      services: [], // Populated by subclasses
      metadata: this.metadata,
      connectionInfo: this.connectionInfo,
      lastHeartbeat: this.lastHeartbeat,
    };
  }

  /**
   * Update device metadata
   * @param updates - Fields to update
   */
  updateMetadata(updates: Record<string, unknown>): void {
    logger.info(`[BaseDevice:${this.id}] Updating metadata:`, Object.keys(updates));
    Object.assign(this.metadata, updates);
  }

  /**
   * Set device status
   * @param status - New status
   */
  setStatus(status: DeviceStatus): void {
    logger.info(`[BaseDevice:${this.id}] Status changed: ${this.status} -> ${status}`);
    this.status = status;
    this.lastHeartbeat = new Date();
  }

  /**
   * Get device location as object
   * @returns Location object or string
   */
  getLocation(): DeviceLocation {
    return this.location;
  }

  /**
   * Get device capabilities
   * @returns Array of capabilities
   */
  getCapabilities(): DeviceCapability[] {
    return this.capabilities;
  }

  /**
   * Get device behaviors
   * @returns Array of behavior configurations
   */
  getBehaviors(): BehaviorConfig[] {
    return [...this.behaviors];
  }

  /**
   * Check if device has a specific capability
   * @param capabilityName - Name of capability to check
   * @returns true if capability exists, false otherwise
   */
  hasCapability(capabilityName: string): boolean {
    return this.capabilities.some(
      (cap) => cap.name.toLowerCase() === capabilityName.toLowerCase()
    );
  }

  /**
   * Get location path (backward compatible with string locations)
   * @returns Location path string
   */
  getLocationPath(): string {
    if (typeof this.location === 'string') {
      return this.location;
    }
    // If location is an object, return the path property or JSON string
    return this.location.path || JSON.stringify(this.location);
  }

  /**
   * Get full location object
   * @returns DeviceLocation object or null if location is string
   */
  getLocationObject(): Exclude<DeviceLocation, string> | null {
    if (typeof this.location === 'string') {
      return null;
    }
    return this.location;
  }

  /**
   * Cleanup device resources
   */
  dispose(): void {
    logger.info(`[BaseDevice:${this.id}] Disposing device`);
    this.stopAllBehaviors();
    this.setStatus(DeviceStatus.OFFLINE);
  }
}
