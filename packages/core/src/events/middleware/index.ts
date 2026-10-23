/**
 * Event Middleware Module
 *
 * Provides middleware pattern for event processing
 */

// Base types and interfaces
export type {
  EventMiddleware,
  MiddlewareContext,
  MiddlewareResult,
} from './EventMiddleware.js';

export { BaseMiddleware } from './EventMiddleware.js';

// Pipeline
export { EventPipeline } from './EventPipeline.js';
export type { PipelineConfig } from './EventPipeline.js';

// Guards
export * from './guards/index.js';

// Interceptors
export * from './interceptors/index.js';
