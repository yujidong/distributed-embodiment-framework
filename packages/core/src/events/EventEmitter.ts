/**
 * EventEmitter - Event Emission Wrapper
 *
 * Provides a convenient wrapper for objects to emit events through
 * the central EventManager. Each emitter has a unique ID and can
 * emit events with automatic source attribution.
 */

import type { SystemEvent } from '@active-collaboration/shared';
import { EventType, EventPriority } from '@active-collaboration/shared';
import type { EventManager } from './EventManager.js';

export class EventEmitter {
  private eventManager: EventManager;
  private emitterId: string;

  constructor(eventManager: EventManager, emitterId: string) {
    this.eventManager = eventManager;
    this.emitterId = emitterId;
  }

  /**
   * Emit an event
   */
  emit(
    type: EventType,
    payload: any,
    options?: {
      priority?: EventPriority;
      correlationId?: string;
      delay?: number;
      metadata?: Record<string, any>;
    }
  ): SystemEvent {
    return this.eventManager.publish(
      {
        type,
        source: this.emitterId,
        priority: options?.priority || EventPriority.NORMAL,
        payload,
        correlationId: options?.correlationId,
        metadata: options?.metadata || {},
      },
      {
        correlationId: options?.correlationId,
        delay: options?.delay,
      }
    );
  }

  /**
   * Emit a state change event
   * Automatically detects changed parameters
   */
  emitStateChange(oldState: any, newState: any, options?: {
    priority?: EventPriority;
    correlationId?: string;
    delay?: number;
    metadata?: Record<string, any>;
  }): SystemEvent {
    // Detect changed parameters
    const changedParameters: string[] = [];

    const allKeys = new Set([...Object.keys(oldState), ...Object.keys(newState)]);

    for (const key of allKeys) {
      if (oldState[key] !== newState[key]) {
        changedParameters.push(key);
      }
    }

    return this.emit(
      EventType.DEVICE_STATE_CHANGE,
      {
        emitterId: this.emitterId,
        oldState,
        newState,
        changedParameters,
      },
      options
    );
  }

  /**
   * Emit an error event
   */
  emitError(error: Error | string, context?: any, options?: {
    priority?: EventPriority;
    correlationId?: string;
  }): SystemEvent {
    const errorMessage = typeof error === 'string' ? error : error.message;
    const errorStack = typeof error === 'string' ? undefined : error.stack;

    return this.emit(
      EventType.SYSTEM_ERROR,
      {
        error: errorMessage,
        stack: errorStack,
        context,
      },
      {
        priority: options?.priority || EventPriority.HIGH,
        correlationId: options?.correlationId,
      }
    );
  }

  /**
   * Emit a warning event
   */
  emitWarning(message: string, context?: any, options?: {
    correlationId?: string;
    delay?: number;
  }): SystemEvent {
    return this.emit(
      EventType.SYSTEM_WARNING,
      {
        message,
        context,
      },
      {
        priority: EventPriority.NORMAL,
        correlationId: options?.correlationId,
      }
    );
  }

  /**
   * Get the emitter ID
   */
  getEmitterId(): string {
    return this.emitterId;
  }

  /**
   * Get the event manager
   */
  getEventManager(): EventManager {
    return this.eventManager;
  }
}
