/**
 * EventManager - Central Event Bus
 *
 * Provides publish-subscribe messaging for system-wide events.
 * All device state changes, agent actions, and collaboration events
 * flow through this central event bus.
 */

import type {
  SystemEvent,
  EventFilter,
  EventSubscription,
  EventHandler,
  EventStats,
  EmitOptions,
} from '@active-collaboration/shared';
import { EventType, EventPriority } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
// Re-export types for convenience
const logger = createLogger('EventManager');

export type {
  SystemEvent,
  EventFilter,
  EventSubscription,
  EventHandler,
  EventStats,
  EmitOptions,
};
export { EventType, EventPriority };

const PRIORITY_WEIGHTS: Record<EventPriority, number> = {
  [EventPriority.LOW]: 1,
  [EventPriority.NORMAL]: 2,
  [EventPriority.HIGH]: 3,
  [EventPriority.URGENT]: 4,
};

export class EventManager {
  private subscriptions: Map<string, EventSubscription>;
  private eventHistory: SystemEvent[];
  private maxHistorySize: number;
  private stats: EventStats;

  constructor(maxHistorySize: number = 1000) {
    this.subscriptions = new Map();
    this.eventHistory = [];
    this.maxHistorySize = maxHistorySize;
    this.stats = {
      totalEvents: 0,
      eventsByType: {},
      totalSubscriptions: 0,
      subscriptionsBySubscriber: {},
    };

    logger.info(`Initialized with max history size: ${maxHistorySize}`);
  }

  /**
   * Publish an event to all matching subscribers
   */
  publish(event: Omit<SystemEvent, 'id' | 'timestamp'>, options?: EmitOptions): SystemEvent {
    const fullEvent: SystemEvent = {
      id: this.generateEventId(),
      timestamp: new Date(),
      ...event,
    };

    // Add to history
    this.addToHistory(fullEvent);

    // Update stats
    this.stats.totalEvents++;
    this.stats.eventsByType[fullEvent.type] = (this.stats.eventsByType[fullEvent.type] || 0) + 1;

    // Log event publication
    logger.info(`Publishing event: ${fullEvent.type} from ${fullEvent.source}`);

    // Handle delayed events
    if (options?.delay) {
      setTimeout(() => {
        this.deliverEvent(fullEvent);
      }, options.delay);
    } else {
      // Deliver immediately
      this.deliverEvent(fullEvent);
    }

    return fullEvent;
  }

  /**
   * Publish multiple events in batch
   */
  publishBatch(events: Array<Omit<SystemEvent, 'id' | 'timestamp'>>): SystemEvent[] {
    return events.map(event => this.publish(event));
  }

  /**
   * Subscribe to events
   */
  subscribe(subscription: Omit<EventSubscription, 'id'>): string {
    const subscriptionId = this.generateSubscriptionId();
    const fullSubscription: EventSubscription = {
      id: subscriptionId,
      ...subscription,
    };

    this.subscriptions.set(subscriptionId, fullSubscription);

    // Update stats
    this.stats.totalSubscriptions++;
    this.stats.subscriptionsBySubscriber[subscription.subscriberId] =
      (this.stats.subscriptionsBySubscriber[subscription.subscriberId] || 0) + 1;

    logger.info(`Subscription created: ${subscriptionId} for ${subscription.subscriberId}` +
        (Array.isArray(subscription.eventType)
          ? ` (events: ${subscription.eventType.join(', ')})`
          : ` (event: ${subscription.eventType})`)
    );

    return subscriptionId;
  }

  /**
   * Unsubscribe by subscription ID
   */
  unsubscribe(subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      logger.warn(`Subscription not found: ${subscriptionId}`);
      return false;
    }

    this.subscriptions.delete(subscriptionId);

    // Update stats
    this.stats.totalSubscriptions--;
    this.stats.subscriptionsBySubscriber[subscription.subscriberId]--;

    logger.info(`Subscription removed: ${subscriptionId}`);
    return true;
  }

  /**
   * Unsubscribe all subscriptions for a subscriber
   */
  unsubscribeAll(subscriberId: string): void {
    const subscriptionIds: string[] = [];

    for (const [id, subscription] of this.subscriptions.entries()) {
      if (subscription.subscriberId === subscriberId) {
        subscriptionIds.push(id);
      }
    }

    subscriptionIds.forEach(id => this.unsubscribe(id));

    logger.info(`Removed ${subscriptionIds.length} subscriptions for ${subscriberId}`);
  }

  /**
   * Get event by ID
   */
  getEvent(eventId: string): SystemEvent | undefined {
    return this.eventHistory.find(event => event.id === eventId);
  }

  /**
   * Get events with optional filtering
   */
  getEvents(filter?: EventFilter): SystemEvent[] {
    let events = [...this.eventHistory];

    if (filter) {
      events = events.filter(event => this.matchesFilter(event, filter));
    }

    return events;
  }

  /**
   * Get events for a specific subscriber
   */
  getEventsForSubscriber(subscriberId: string): SystemEvent[] {
    const subscription = Array.from(this.subscriptions.values()).find(
      sub => sub.subscriberId === subscriberId
    );

    if (!subscription) {
      return [];
    }

    return this.getEvents({
      eventType: subscription.eventType,
    });
  }

  /**
   * Get all correlated events
   */
  correlateEvents(correlationId: string): SystemEvent[] {
    return this.eventHistory.filter(event => event.correlationId === correlationId);
  }

  /**
   * Get event statistics
   */
  getStats(): EventStats {
    return { ...this.stats };
  }

  /**
   * Clear event history
   */
  clearHistory(): void {
    this.eventHistory = [];
    logger.info('Event history cleared');
  }

  /**
   * Get current subscriptions
   */
  getSubscriptions(): EventSubscription[] {
    return Array.from(this.subscriptions.values());
  }

  /**
   * Deliver event to matching subscribers
   */
  private deliverEvent(event: SystemEvent): void {
    const matchingSubscriptions = this.findMatchingSubscriptions(event);

    // Sort by priority
    matchingSubscriptions.sort((a, b) => {
      const priorityA = PRIORITY_WEIGHTS[a.priority || EventPriority.NORMAL];
      const priorityB = PRIORITY_WEIGHTS[b.priority || EventPriority.NORMAL];
      return priorityB - priorityA;
    });

    // Deliver to each subscriber
    matchingSubscriptions.forEach(subscription => {
      this.deliverToSubscriber(subscription, event);
    });
  }

  /**
   * Find subscriptions that match an event
   */
  private findMatchingSubscriptions(event: SystemEvent): EventSubscription[] {
    const matching: EventSubscription[] = [];

    for (const subscription of this.subscriptions.values()) {
      // Check event type match
      const eventTypeMatches = Array.isArray(subscription.eventType)
        ? subscription.eventType.includes(event.type)
        : subscription.eventType === event.type;

      if (!eventTypeMatches) {
        continue;
      }

      // Check filter match
      if (subscription.filter && !this.matchesFilter(event, subscription.filter)) {
        continue;
      }

      matching.push(subscription);
    }

    return matching;
  }

  /**
   * Check if event matches filter
   */
  private matchesFilter(event: SystemEvent, filter: EventFilter): boolean {
    // Source filter
    if (filter.source) {
      const sources = Array.isArray(filter.source) ? filter.source : [filter.source];
      if (!sources.includes(event.source)) {
        return false;
      }
    }

    // Event type filter
    if (filter.eventType) {
      const types = Array.isArray(filter.eventType) ? filter.eventType : [filter.eventType];
      if (!types.includes(event.type)) {
        return false;
      }
    }

    // Time range filter
    if (filter.after && event.timestamp < filter.after) {
      return false;
    }
    if (filter.before && event.timestamp > filter.before) {
      return false;
    }

    // Priority filter
    if (filter.minPriority) {
      const eventWeight = PRIORITY_WEIGHTS[event.priority];
      const minWeight = PRIORITY_WEIGHTS[filter.minPriority];
      if (eventWeight < minWeight) {
        return false;
      }
    }

    // Metadata filter
    if (filter.metadata) {
      for (const [key, value] of Object.entries(filter.metadata)) {
        if (event.metadata[key] !== value) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Deliver event to a specific subscriber
   */
  private async deliverToSubscriber(subscription: EventSubscription, event: SystemEvent): Promise<void> {
    try {
      await subscription.handler(event);

      // Unsubscribe if it's a once subscription
      if (subscription.once) {
        this.unsubscribe(subscription.id);
      }
    } catch (error) {
      logger.error(`Error delivering event ${event.id} to subscriber ${subscription.subscriberId}:`,
        error
      );
    }
  }

  /**
   * Add event to history
   */
  private addToHistory(event: SystemEvent): void {
    this.eventHistory.push(event);

    // Maintain max history size
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }
  }

  /**
   * Generate unique event ID
   */
  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate unique subscription ID
   */
  private generateSubscriptionId(): string {
    return `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
