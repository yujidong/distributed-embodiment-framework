/**
 * Event Processor - Layered Event Handling System
 *
 * Problem: Device periodic behaviors generate many events. Processing each
 * event with LLM is unsustainable for large-scale simulations.
 *
 * Solution: A three-layer processing pipeline:
 * 1. EventAggregator - Batch and deduplicate events
 * 2. RuleBasedFilter - Fast non-LLM processing for simple cases
 * 3. LLMDecisionLayer - Intelligent processing for complex cases
 *
 * This dramatically reduces LLM calls while maintaining intelligent responses.
 */

import type { SystemEvent, EventType } from './EventManager.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Aggregated event containing multiple similar events
 */
const logger = createLogger('EventProcessor');

export interface AggregatedEvent {
  id: string;
  eventType: EventType;
  deviceId?: string;
  firstOccurrence: Date;
  lastOccurrence: Date;
  count: number;
  payloads: any[];
  aggregatedPayload: any;  // Merged/summarized payload
  significance: 'low' | 'medium' | 'high';
}

/**
 * Rule definition for rule-based filtering
 */
export interface EventRule {
  id: string;
  name: string;
  description: string;
  condition: (event: AggregatedEvent, context: RuleContext) => boolean;
  action: (event: AggregatedEvent, context: RuleContext) => RuleActionResult;
  priority: number;  // Higher = checked first
}

/**
 * Context for rule evaluation
 */
export interface RuleContext {
  agentId: string;
  agentCapabilities: string[];
  deviceStates: Map<string, any>;
  recentEvents: AggregatedEvent[];
  thresholds: Map<string, number>;
}

/**
 * Result of rule action
 */
export interface RuleActionResult {
  handled: boolean;
  response?: string;
  actions?: Array<{
    type: string;
    target: string;
    params: any;
  }>;
  reason?: string;
}

/**
 * Configuration for EventProcessor
 */
export interface EventProcessorConfig {
  // Aggregation settings
  aggregationWindowMs: number;     // Time window for batching events
  maxBatchSize: number;            // Max events per batch

  // Significance thresholds
  significanceThresholds: {
    temperatureChange: number;     // e.g., 2 degrees
    humidityChange: number;        // e.g., 5 percent
    stateChangeCount: number;      // Number of changes to be significant
  };

  // LLM bypass rules
  bypassLLMForNormalChanges: boolean;  // Skip LLM for small changes
  bypassLLMForRoutinePeriodic: boolean; // Skip LLM for routine periodic updates

  // Cost control: Disable automatic LLM processing from events
  // When false, LLM is ONLY called through explicit task requests
  enableAutoLLMProcessing: boolean;
}

const DEFAULT_CONFIG: EventProcessorConfig = {
  aggregationWindowMs: 1000,  // 1 second window
  maxBatchSize: 100,
  significanceThresholds: {
    temperatureChange: 2,
    humidityChange: 5,
    stateChangeCount: 3,
  },
  bypassLLMForNormalChanges: true,
  bypassLLMForRoutinePeriodic: true,
  // Cost control: LLM is only called through explicit tasks by default
  enableAutoLLMProcessing: false,
};

/**
 * EventAggregator - Collects and batches events
 *
 * Batches events of the same type from the same source within a time window.
 * This reduces the number of LLM calls significantly.
 */
export class EventAggregator {
  private config: EventProcessorConfig;
  private pendingEvents: Map<string, AggregatedEvent> = new Map();
  private flushTimer: NodeJS.Timeout | null = null;
  private onFlush: (events: AggregatedEvent[]) => void;

  constructor(
    config: Partial<EventProcessorConfig>,
    onFlush: (events: AggregatedEvent[]) => void
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onFlush = onFlush;
  }

  /**
   * Add an event to the aggregator
   */
  addEvent(event: SystemEvent): void {
    const key = this.getAggregationKey(event);
    const now = new Date();

    if (this.pendingEvents.has(key)) {
      // Append to existing aggregated event
      const aggregated = this.pendingEvents.get(key)!;
      aggregated.count++;
      aggregated.lastOccurrence = now;

      // Limit payloads array to prevent unbounded memory growth
      // Keep only the last 10 payloads for reference
      if (aggregated.payloads.length < 10) {
        aggregated.payloads.push(event.payload);
      }

      // Update aggregated payload
      this.updateAggregatedPayload(aggregated, event.payload);
    } else {
      // Create new aggregated event
      const aggregated: AggregatedEvent = {
        id: `agg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        eventType: event.type,
        deviceId: event.payload?.deviceId,
        firstOccurrence: now,
        lastOccurrence: now,
        count: 1,
        payloads: [event.payload],
        aggregatedPayload: { ...event.payload },
        significance: 'low',
      };
      this.pendingEvents.set(key, aggregated);
    }

    // Start flush timer if not running
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.config.aggregationWindowMs);
    }

    // Force flush if batch is full
    if (this.pendingEvents.size >= this.config.maxBatchSize) {
      this.flush();
    }
  }

  /**
   * Get aggregation key for an event
   * Events with the same key will be batched together
   */
  private getAggregationKey(event: SystemEvent): string {
    // Group by event type and device
    const deviceId = event.payload?.deviceId || 'global';
    return `${event.type}:${deviceId}`;
  }

  /**
   * Update aggregated payload with new data
   */
  private updateAggregatedPayload(aggregated: AggregatedEvent, newPayload: any): void {
    // For numeric values, track min/max/avg
    for (const [key, value] of Object.entries(newPayload || {})) {
      if (typeof value === 'number') {
        const existing = aggregated.aggregatedPayload[key];
        if (typeof existing === 'object' && existing !== null) {
          // Already tracking stats
          existing.min = Math.min(existing.min, value);
          existing.max = Math.max(existing.max, value);
          existing.sum += value;
          existing.count++;
          existing.avg = existing.sum / existing.count;
        } else if (typeof existing === 'number') {
          // Convert to stats object
          aggregated.aggregatedPayload[key] = {
            min: Math.min(existing, value),
            max: Math.max(existing, value),
            sum: existing + value,
            count: 2,
            avg: (existing + value) / 2,
            first: existing,
            last: value,
          };
        } else {
          aggregated.aggregatedPayload[key] = value;
        }
      } else {
        // For non-numeric, just keep the latest
        aggregated.aggregatedPayload[key] = value;
      }
    }

    // Calculate significance
    aggregated.significance = this.calculateSignificance(aggregated);
  }

  /**
   * Calculate significance of an aggregated event
   */
  private calculateSignificance(aggregated: AggregatedEvent): 'low' | 'medium' | 'high' {
    const thresholds = this.config.significanceThresholds;

    // Check for significant changes in aggregated payload
    const payload = aggregated.aggregatedPayload;

    // Temperature change
    if (payload.temperature && typeof payload.temperature === 'object') {
      const change = Math.abs(payload.temperature.max - payload.temperature.min);
      if (change >= thresholds.temperatureChange) {
        return 'high';
      }
    }

    // Humidity change
    if (payload.humidity && typeof payload.humidity === 'object') {
      const change = Math.abs(payload.humidity.max - payload.humidity.min);
      if (change >= thresholds.humidityChange) {
        return 'high';
      }
    }

    // High frequency changes
    if (aggregated.count >= thresholds.stateChangeCount) {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Flush all pending events
   */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.pendingEvents.size === 0) return;

    const events = Array.from(this.pendingEvents.values());
    this.pendingEvents.clear();

    this.onFlush(events);
  }

  /**
   * Stop the aggregator and flush remaining events
   */
  stop(): void {
    this.flush();
  }
}

/**
 * RuleBasedFilter - Fast non-LLM event processing
 *
 * Processes events using simple rules without LLM.
 * Only passes complex cases to the LLM layer.
 */
export class RuleBasedFilter {
  private rules: EventRule[] = [];
  private config: EventProcessorConfig;

  constructor(config: Partial<EventProcessorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeDefaultRules();
  }

  /**
   * Add a custom rule
   */
  addRule(rule: EventRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);  // Sort by priority
  }

  /**
   * Process an aggregated event through rules
   * Returns true if handled by a rule (no LLM needed)
   */
  process(event: AggregatedEvent, context: RuleContext): { handled: boolean; result?: RuleActionResult } {
    // Skip low-significance events if configured
    if (this.config.bypassLLMForRoutinePeriodic && event.significance === 'low') {
      return {
        handled: true,
        result: {
          handled: true,
          reason: 'Low significance periodic event, skipped LLM processing',
        },
      };
    }

    // Try each rule in priority order
    for (const rule of this.rules) {
      try {
        if (rule.condition(event, context)) {
          const result = rule.action(event, context);
          if (result.handled) {
            logger.info(`[RuleBasedFilter] Event handled by rule: ${rule.name}`);
            return { handled: true, result };
          }
        }
      } catch (error) {
        logger.error(`[RuleBasedFilter] Rule ${rule.name} error:`, error);
      }
    }

    // No rule matched, needs LLM processing
    return { handled: false };
  }

  /**
   * Initialize default rules for common cases
   */
  private initializeDefaultRules(): void {
    // Rule 1: Small temperature changes - no action needed
    this.addRule({
      id: 'small-temp-change',
      name: 'Small Temperature Change',
      description: 'Ignore small temperature fluctuations within normal range',
      priority: 100,
      condition: (event, context) => {
        if (event.eventType !== 'device.state_change') return false;
        const temp = event.aggregatedPayload?.temperature;
        if (!temp || typeof temp !== 'object') return false;

        // Check if change is small and within normal range
        const change = Math.abs(temp.max - temp.min);
        const avgTemp = temp.avg;
        return change < this.config.significanceThresholds.temperatureChange
          && avgTemp >= 18 && avgTemp <= 28;  // Normal comfort range
      },
      action: (event, context) => ({
        handled: true,
        reason: `Temperature change within normal range, no action needed`,
      }),
    });

    // Rule 2: High temperature alert
    this.addRule({
      id: 'high-temp-alert',
      name: 'High Temperature Alert',
      description: 'Generate alert for high temperature',
      priority: 90,
      condition: (event, context) => {
        if (event.eventType !== 'device.state_change') return false;
        const temp = event.aggregatedPayload?.temperature;
        if (typeof temp !== 'object' && typeof temp !== 'number') return false;
        const tempValue = typeof temp === 'object' ? temp.max : temp;
        return tempValue > 30;
      },
      action: (event, context) => ({
        handled: false,  // Let LLM decide the response
        response: 'High temperature detected, may need cooling',
      }),
    });

    // Rule 3: Device not owned by agent - ignore
    this.addRule({
      id: 'ignore-unowned-device',
      name: 'Ignore Unowned Device',
      description: 'Ignore events from devices not managed by this agent',
      priority: 200,
      condition: (event, context) => {
        const deviceId = event.deviceId;
        if (!deviceId) return false;
        return !context.deviceStates.has(deviceId);
      },
      action: (event, context) => ({
        handled: true,
        reason: `Device ${event.deviceId} not managed by this agent`,
      }),
    });
  }
}

/**
 * EventProcessor - Main entry point for layered event processing
 *
 * Combines aggregation, rule-based filtering, and optional LLM processing.
 */
export class EventProcessor {
  private aggregator: EventAggregator;
  private ruleFilter: RuleBasedFilter;
  private config: EventProcessorConfig;
  private onLLMNeeded: (event: AggregatedEvent) => Promise<void>;
  private context: RuleContext;

  constructor(
    config: Partial<EventProcessorConfig>,
    context: RuleContext,
    onLLMNeeded: (event: AggregatedEvent) => Promise<void>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.context = context;
    this.onLLMNeeded = onLLMNeeded;

    this.aggregator = new EventAggregator(this.config, (events) => this.processBatch(events));
    this.ruleFilter = new RuleBasedFilter(this.config);
  }

  /**
   * Process an incoming event
   */
  processEvent(event: SystemEvent): void {
    this.aggregator.addEvent(event);
  }

  /**
   * Process a batch of aggregated events
   */
  private async processBatch(events: AggregatedEvent[]): Promise<void> {
    logger.info(`Processing batch of ${events.length} aggregated events`);

    for (const event of events) {
      logger.info(`Event: ${event.eventType}, Significance: ${event.significance}, Count: ${event.count}`);

      // Try rule-based processing first
      const { handled, result } = this.ruleFilter.process(event, this.context);

      if (handled) {
        logger.info(`Event handled by rules: ${result?.reason || 'no reason'}`);
        continue;
      }

      // Cost control: Skip automatic LLM processing if disabled
      // LLM should only be called through explicit task requests
      if (!this.config.enableAutoLLMProcessing) {
        logger.info(`Event not handled by rules, but auto LLM processing is disabled. Skipping.`);
        continue;
      }

      // Needs LLM processing
      logger.info(`Event requires LLM processing`);
      await this.onLLMNeeded(event);
    }
  }

  /**
   * Update context (e.g., when device states change)
   */
  updateContext(updates: Partial<RuleContext>): void {
    Object.assign(this.context, updates);
  }

  /**
   * Add custom rule to the filter
   */
  addRule(rule: EventRule): void {
    this.ruleFilter.addRule(rule);
  }

  /**
   * Stop processing and flush remaining events
   */
  stop(): void {
    this.aggregator.stop();
  }

  /**
   * Get statistics about event processing
   */
  getStats(): {
    pendingEvents: number;
    rulesCount: number;
  } {
    return {
      pendingEvents: 0,  // Would need internal access
      rulesCount: 0,     // Would need internal access
    };
  }
}
