/**
 * EventManager Unit Tests
 *
 * Comprehensive tests for the central event bus system
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventManager, EventType, EventPriority } from './EventManager.js';

describe('EventManager', () => {
  let manager: EventManager;

  beforeEach(() => {
    manager = new EventManager(10);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic publish and subscribe', () => {
    it('should receive published event', async () => {
      let receivedEvent: any = null;
      let eventReceived = false;

      manager.subscribe({
        subscriberId: 'test-subscriber',
        eventType: EventType.DEVICE_STATE_CHANGE,
        handler: (event: any) => {
          receivedEvent = event;
          eventReceived = true;
        },
      });

      const publishedEvent = manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-1',
        priority: EventPriority.NORMAL,
        payload: { deviceId: 'device-1', temperature: 25 },
        metadata: {},
      });

      // Wait for async handler
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(eventReceived).toBe(true);
      expect(receivedEvent).toBeDefined();
      expect(receivedEvent.payload.deviceId).toBe('device-1');
      expect(publishedEvent.id).toBeDefined();
    });

    it('should handle multiple subscribers to same event', async () => {
      const receivedEvents: any[] = [];

      // Subscribe 3 different handlers
      for (let i = 1; i <= 3; i++) {
        manager.subscribe({
          subscriberId: `subscriber-${i}`,
          eventType: EventType.DEVICE_STATE_CHANGE,
          handler: (event: any) => {
            receivedEvents.push({ subscriber: i, event });
          },
        });
      }

      manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-2',
        priority: EventPriority.NORMAL,
        payload: { deviceId: 'device-2' },
        metadata: {},
      });

      // Wait for async handlers
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(receivedEvents.length).toBe(3);
      receivedEvents.forEach((item) => {
        expect(item.event.id).toBeDefined();
      });
    });
  });

  describe('Event filtering', () => {
    it('should filter events by source', async () => {
      let device1Events = 0;
      let device2Events = 0;

      // Subscribe only to device-1 events
      manager.subscribe({
        subscriberId: 'device-1-monitor',
        eventType: EventType.DEVICE_STATE_CHANGE,
        filter: { source: 'device-1' },
        handler: () => {
          device1Events++;
        },
      });

      // Subscribe only to device-2 events
      manager.subscribe({
        subscriberId: 'device-2-monitor',
        eventType: EventType.DEVICE_STATE_CHANGE,
        filter: { source: 'device-2' },
        handler: () => {
          device2Events++;
        },
      });

      // Publish events from both devices
      manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-1',
        priority: EventPriority.NORMAL,
        payload: { deviceId: 'device-1' },
        metadata: {},
      });

      manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-2',
        priority: EventPriority.NORMAL,
        payload: { deviceId: 'device-2' },
        metadata: {},
      });

      manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-1',
        priority: EventPriority.NORMAL,
        payload: { deviceId: 'device-1' },
        metadata: {},
      });

      // Wait for async handlers
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(device1Events).toBe(2);
      expect(device2Events).toBe(1);
    });
  });

  describe('Event priority', () => {
    it('should deliver events in priority order', async () => {
      const callOrder: string[] = [];

      manager.subscribe({
        subscriberId: 'low-priority-sub',
        eventType: EventType.DEVICE_STATE_CHANGE,
        priority: EventPriority.LOW,
        handler: () => {
          callOrder.push('LOW');
        },
      });

      manager.subscribe({
        subscriberId: 'urgent-priority-sub',
        eventType: EventType.DEVICE_STATE_CHANGE,
        priority: EventPriority.URGENT,
        handler: () => {
          callOrder.push('URGENT');
        },
      });

      manager.subscribe({
        subscriberId: 'normal-priority-sub',
        eventType: EventType.DEVICE_STATE_CHANGE,
        priority: EventPriority.NORMAL,
        handler: () => {
          callOrder.push('NORMAL');
        },
      });

      manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-1',
        priority: EventPriority.NORMAL,
        payload: {},
        metadata: {},
      });

      // Wait for async handlers
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(callOrder.join(',')).toBe('URGENT,NORMAL,LOW');
    });
  });

  describe('Event history', () => {
    it('should track event history', () => {
      // Publish 5 events
      for (let i = 1; i <= 5; i++) {
        manager.publish({
          type: EventType.DEVICE_STATE_CHANGE,
          source: `device-${i}`,
          priority: EventPriority.NORMAL,
          payload: { index: i },
          metadata: {},
        });
      }

      const allEvents = manager.getEvents();
      const stats = manager.getStats();

      expect(allEvents.length).toBe(5);
      expect(stats.totalEvents).toBe(5);
    });

    it('should limit history size', () => {
      const smallManager = new EventManager(3);

      // Publish 5 events
      for (let i = 1; i <= 5; i++) {
        smallManager.publish({
          type: EventType.DEVICE_STATE_CHANGE,
          source: `device-${i}`,
          priority: EventPriority.NORMAL,
          payload: { index: i },
          metadata: {},
        });
      }

      const allEvents = smallManager.getEvents();

      // Should only keep last 3 events
      expect(allEvents.length).toBe(3);
      expect(allEvents[0].payload.index).toBe(3);
      expect(allEvents[1].payload.index).toBe(4);
      expect(allEvents[2].payload.index).toBe(5);
    });
  });

  describe('Event correlation', () => {
    it('should correlate events by correlation ID', () => {
      const correlationId = 'test-correlation-123';

      // Publish correlated events
      manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-1',
        priority: EventPriority.NORMAL,
        payload: { step: 1 },
        correlationId,
        metadata: {},
      });

      manager.publish({
        type: EventType.DEVICE_OPERATION_EXECUTED,
        source: 'device-1',
        priority: EventPriority.NORMAL,
        payload: { step: 2 },
        correlationId,
        metadata: {},
      });

      manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-2',
        priority: EventPriority.NORMAL,
        payload: { step: 3 },
        correlationId: 'different-correlation',
        metadata: {},
      });

      const correlatedEvents = manager.correlateEvents(correlationId);

      expect(correlatedEvents.length).toBe(2);
      expect(correlatedEvents[0].type).toBe(EventType.DEVICE_STATE_CHANGE);
      expect(correlatedEvents[0].source).toBe('device-1');
      expect(correlatedEvents[1].type).toBe(EventType.DEVICE_OPERATION_EXECUTED);
    });

    it('should return empty array for non-existent correlation ID', () => {
      const correlatedEvents = manager.correlateEvents('non-existent-id');
      expect(correlatedEvents.length).toBe(0);
    });
  });

  describe('Unsubscription', () => {
    it('should unsubscribe and stop receiving events', async () => {
      let eventCount = 0;

      const subscriptionId = manager.subscribe({
        subscriberId: 'test-subscriber',
        eventType: EventType.DEVICE_STATE_CHANGE,
        handler: () => {
          eventCount++;
        },
      });

      // Publish first event
      manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-1',
        priority: EventPriority.NORMAL,
        payload: {},
        metadata: {},
      });

      // Wait for handler
      await new Promise(resolve => setTimeout(resolve, 50));

      // Unsubscribe
      const unsubscribed = manager.unsubscribe(subscriptionId);

      // Publish second event (should not be received)
      manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-1',
        priority: EventPriority.NORMAL,
        payload: {},
        metadata: {},
      });

      // Wait for handlers
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(unsubscribed).toBe(true);
      expect(eventCount).toBe(1);
    });

    it('should return false when unsubscribing non-existent subscription', () => {
      const unsubscribed = manager.unsubscribe('non-existent-id');
      expect(unsubscribed).toBe(false);
    });
  });

  describe('Event statistics', () => {
    it('should track event statistics', async () => {
      // Subscribe multiple times
      manager.subscribe({
        subscriberId: 'subscriber-1',
        eventType: EventType.DEVICE_STATE_CHANGE,
        handler: () => {},
      });

      manager.subscribe({
        subscriberId: 'subscriber-1',
        eventType: EventType.AGENT_REGISTERED,
        handler: () => {},
      });

      manager.subscribe({
        subscriberId: 'subscriber-2',
        eventType: EventType.DEVICE_STATE_CHANGE,
        handler: () => {},
      });

      // Publish various events
      manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-1',
        priority: EventPriority.NORMAL,
        payload: {},
        metadata: {},
      });

      manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-2',
        priority: EventPriority.NORMAL,
        payload: {},
        metadata: {},
      });

      manager.publish({
        type: EventType.AGENT_REGISTERED,
        source: 'agent-1',
        priority: EventPriority.NORMAL,
        payload: {},
        metadata: {},
      });

      const stats = manager.getStats();

      expect(stats.totalEvents).toBe(3);
      expect(stats.totalSubscriptions).toBe(3);
      expect(stats.eventsByType[EventType.DEVICE_STATE_CHANGE]).toBe(2);
      expect(stats.eventsByType[EventType.AGENT_REGISTERED]).toBe(1);
      expect(stats.subscriptionsBySubscriber['subscriber-1']).toBe(2);
      expect(stats.subscriptionsBySubscriber['subscriber-2']).toBe(1);
    });
  });

  describe('Event types', () => {
    it('should support all event types', () => {
      const eventTypes = [
        EventType.DEVICE_STATE_CHANGE,
        EventType.DEVICE_OPERATION_EXECUTED,
        EventType.AGENT_REGISTERED,
        EventType.AGENT_UNREGISTERED,
        EventType.DEVICE_REGISTERED,
        EventType.DEVICE_UNREGISTERED,
        EventType.AGENT_STATE_CHANGE,
        EventType.ENVIRONMENT_PARAM_CHANGED,
        EventType.COLLABORATION_STARTED,
      ];

      eventTypes.forEach((type) => {
        const event = manager.publish({
          type,
          source: 'test-source',
          priority: EventPriority.NORMAL,
          payload: {},
          metadata: {},
        });
        expect(event.type).toBe(type);
      });

      const stats = manager.getStats();
      expect(stats.totalEvents).toBe(eventTypes.length);
    });
  });

  describe('Event metadata', () => {
    it('should include metadata in published events', () => {
      const metadata = {
        timestamp: Date.now(),
        userId: 'user-123',
        transactionId: 'txn-456',
      };

      const publishedEvent = manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-1',
        priority: EventPriority.NORMAL,
        payload: { deviceId: 'device-1' },
        metadata,
      });

      expect(publishedEvent.metadata).toEqual(metadata);
      expect(publishedEvent.metadata.timestamp).toBeDefined();
      expect(publishedEvent.metadata.userId).toBe('user-123');
    });
  });

  describe('Edge cases', () => {
    it('should handle publishing without subscribers', () => {
      const event = manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-1',
        priority: EventPriority.NORMAL,
        payload: {},
        metadata: {},
      });

      expect(event).toBeDefined();
      expect(event.id).toBeDefined();
    });

    it('should handle empty payload', async () => {
      let receivedEvent: any = null;

      manager.subscribe({
        subscriberId: 'test-subscriber',
        eventType: EventType.DEVICE_STATE_CHANGE,
        handler: (event: any) => {
          receivedEvent = event;
        },
      });

      manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-1',
        priority: EventPriority.NORMAL,
        payload: {},
        metadata: {},
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(receivedEvent).toBeDefined();
      expect(receivedEvent.payload).toEqual({});
    });

    it('should handle large payload', async () => {
      let receivedPayload: any = null;

      manager.subscribe({
        subscriberId: 'test-subscriber',
        eventType: EventType.DEVICE_STATE_CHANGE,
        handler: (event: any) => {
          receivedPayload = event.payload;
        },
      });

      const largePayload = {
        data: 'x'.repeat(10000),
        nested: {
          array: Array(100).fill('item'),
        },
      };

      manager.publish({
        type: EventType.DEVICE_STATE_CHANGE,
        source: 'device-1',
        priority: EventPriority.NORMAL,
        payload: largePayload,
        metadata: {},
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(receivedPayload).toBeDefined();
      expect(receivedPayload.data.length).toBe(10000);
      expect(receivedPayload.nested.array.length).toBe(100);
    });
  });
});
