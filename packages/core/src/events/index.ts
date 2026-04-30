/**
 * Events Package
 *
 * Central event bus system for autonomous agent collaboration.
 * All system events flow through this package.
 */

export { EventManager, EventType, EventPriority } from './EventManager.js';
export type {
  SystemEvent,
  EventFilter,
  EventSubscription,
  EventHandler,
  EmitOptions,
  EventStats,
} from './EventManager.js';

export { EventEmitter } from './EventEmitter.js';

// Layered Event Processing
export {
  EventProcessor,
  EventAggregator,
  RuleBasedFilter,
} from './EventProcessor.js';
export type {
  AggregatedEvent,
  EventRule,
  RuleContext,
  RuleActionResult,
  EventProcessorConfig,
} from './EventProcessor.js';
