/**
 * Metrics Interceptor
 *
 * Collects metrics on events passing through pipeline
 * Provides performance monitoring
 */

import type { MiddlewareContext } from '../EventMiddleware.js';
import type { MiddlewareResult } from '../EventMiddleware.js';
import { BaseMiddleware } from '../EventMiddleware.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Event metrics
 */
const logger = createLogger('MetricsInterceptor');

export interface EventMetrics {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsBySource: Record<string, number>;
  averageProcessingTime: number;
  errors: number;
  lastEventTime?: Date;
}

/**
 * Metrics configuration
 */
export interface MetricsConfig {
  /**
   * Whether to collect metrics (default: true)
   */
  enabled?: boolean;
  /**
   * How often to reset metrics (default: never)
   */
  resetInterval?: number;
}

/**
 * Metrics Interceptor Implementation
 */
export class MetricsInterceptor extends BaseMiddleware {
  private config: MetricsConfig;
  private metrics: EventMetrics;
  private processingTimes: number[] = [];

  constructor(config: MetricsConfig = {}) {
    super('metrics-interceptor', 'MetricsInterceptor', 5);
    this.config = {
      enabled: true,
      resetInterval: 0,
      ...config
    };
    this.metrics = {
      totalEvents: 0,
      eventsByType: {},
      eventsBySource: {},
      averageProcessingTime: 0,
      errors: 0
    };
    logger.info(`Initialized`);
  }

  /**
   * Handle event through metrics interceptor
   */
  protected async handleEvent(context: MiddlewareContext): Promise<MiddlewareResult> {
    const { event } = context;

    // Update metrics
    this.metrics.totalEvents++;
    this.metrics.eventsByType[event.type] = (this.metrics.eventsByType[event.type] || 0) + 1;
    this.metrics.eventsBySource[event.source] = (this.metrics.eventsBySource[event.source] || 0) + 1;
    this.metrics.lastEventTime = new Date();

    // Track processing time
    const processingTime = Date.now() - context.timestamp.getTime();
    this.processingTimes.push(processingTime);

    // Update average
    this.metrics.averageProcessingTime =
      this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length;

    return {
      success: true,
      shouldContinue: true
    };
  }

  /**
   * Record error
   */
  recordError(): void {
    this.metrics.errors++;
  }

  /**
   * Get current metrics
   */
  getMetrics(): EventMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      totalEvents: 0,
      eventsByType: {},
      eventsBySource: {},
      averageProcessingTime: 0,
      errors: 0
    };
    this.processingTimes = [];
    logger.info(`Metrics reset`);
  }
}
