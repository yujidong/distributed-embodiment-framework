/**
 * EventManager Unit Tests
 *
 * Comprehensive tests for the central event bus system
 */

import { EventManager, EventType, EventPriority } from './EventManager.js';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('EventManager.test');
logger.info('='.repeat(80));
logger.info('EVENT MANAGER UNIT TESTS');
logger.info('='.repeat(80));
logger.info('\n');

// Test 1: Basic publish and subscribe
logger.info('Test 1: Basic publish and subscribe');
logger.info('-'.repeat(80));
try {
  const manager = new EventManager();
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

  if (eventReceived && receivedEvent && receivedEvent.payload.deviceId === 'device-1') {
    logger.info('✓ PASS: Event received successfully');
    logger.info(`  Event ID: ${publishedEvent.id}`);
    logger.info(`  Payload:`, receivedEvent.payload);
  } else {
    logger.info('✗ FAIL: Event not received or incorrect payload');
  }
} catch (error) {
  logger.info('✗ FAIL: Error in basic publish/subscribe test:', error);
}

logger.info('\n');

// Test 2: Multiple subscribers
logger.info('Test 2: Multiple subscribers to same event');
logger.info('-'.repeat(80));
try {
  const manager = new EventManager();
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

  // Wait a bit for async handlers
  setTimeout(() => {
    if (receivedEvents.length === 3) {
      logger.info('✓ PASS: All 3 subscribers received the event');
      receivedEvents.forEach((item) => {
        logger.info(`  Subscriber ${item.subscriber}: received event ${item.event.id}`);
      });
    } else {
      logger.info(`✗ FAIL: Expected 3 events, received ${receivedEvents.length}`);
    }
  }, 100);
} catch (error) {
  logger.info('✗ FAIL: Error in multiple subscribers test:', error);
}

logger.info('\n');

// Test 3: Event filtering by source
logger.info('Test 3: Event filtering by source');
logger.info('-'.repeat(80));
try {
  const manager = new EventManager();
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

  setTimeout(() => {
    if (device1Events === 2 && device2Events === 1) {
      logger.info('✓ PASS: Source filtering working correctly');
      logger.info(`  Device-1 monitor received: ${device1Events} events`);
      logger.info(`  Device-2 monitor received: ${device2Events} events`);
    } else {
      logger.info('✗ FAIL: Source filtering not working');
      logger.info(`  Expected device-1: 2, device-2: 1`);
      logger.info(`  Got device-1: ${device1Events}, device-2: ${device2Events}`);
    }
  }, 100);
} catch (error) {
  logger.info('✗ FAIL: Error in event filtering test:', error);
}

logger.info('\n');

// Test 4: Event priority ordering
logger.info('Test 4: Event priority ordering');
logger.info('-'.repeat(80));
try {
  const manager = new EventManager();
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

  setTimeout(() => {
    if (callOrder.join(',') === 'URGENT,NORMAL,LOW') {
      logger.info('✓ PASS: Events delivered in priority order');
      logger.info(`  Order: ${callOrder.join(' → ')}`);
    } else {
      logger.info('✗ FAIL: Events not delivered in correct priority order');
      logger.info(`  Expected: URGENT → NORMAL → LOW`);
      logger.info(`  Got: ${callOrder.join(' → ')}`);
    }
  }, 100);
} catch (error) {
  logger.info('✗ FAIL: Error in priority ordering test:', error);
}

logger.info('\n');

// Test 5: Event history
logger.info('Test 5: Event history tracking');
logger.info('-'.repeat(80));
try {
  const manager = new EventManager(10); // Small history size for testing

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

  if (allEvents.length === 5 && stats.totalEvents === 5) {
    logger.info('✓ PASS: Event history tracking correctly');
    logger.info(`  Total events in history: ${allEvents.length}`);
    logger.info(`  Total events published: ${stats.totalEvents}`);
    logger.info(`  Events by type:`, stats.eventsByType);
  } else {
    logger.info('✗ FAIL: Event history not tracking correctly');
    logger.info(`  Expected 5 events, got ${allEvents.length}`);
  }
} catch (error) {
  logger.info('✗ FAIL: Error in event history test:', error);
}

logger.info('\n');

// Test 6: Event correlation
logger.info('Test 6: Event correlation');
logger.info('-'.repeat(80));
try {
  const manager = new EventManager();
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

  if (correlatedEvents.length === 2) {
    logger.info('✓ PASS: Event correlation working correctly');
    logger.info(`  Correlation ID: ${correlationId}`);
    logger.info(`  Correlated events: ${correlatedEvents.length}`);
    correlatedEvents.forEach((event, index) => {
      logger.info(`    ${index + 1}. ${event.type} from ${event.source}`);
    });
  } else {
    logger.info('✗ FAIL: Event correlation not working');
    logger.info(`  Expected 2 correlated events, got ${correlatedEvents.length}`);
  }
} catch (error) {
  logger.info('✗ FAIL: Error in event correlation test:', error);
}

logger.info('\n');

// Test 7: Unsubscription
logger.info('Test 7: Unsubscription');
logger.info('-'.repeat(80));
try {
  const manager = new EventManager();
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

  setTimeout(() => {
    if (unsubscribed && eventCount === 1) {
      logger.info('✓ PASS: Unsubscription working correctly');
      logger.info(`  Events received before unsubscribe: 1`);
      logger.info(`  Events received after unsubscribe: 0 (total: ${eventCount})`);
    } else {
      logger.info('✗ FAIL: Unsubscription not working');
      logger.info(`  Unsubscribe successful: ${unsubscribed}`);
      logger.info(`  Event count: ${eventCount} (expected 1)`);
    }
  }, 100);
} catch (error) {
  logger.info('✗ FAIL: Error in unsubscription test:', error);
}

logger.info('\n');

// Test 8: Event statistics
logger.info('Test 8: Event statistics');
logger.info('-'.repeat(80));
try {
  const manager = new EventManager();

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

  if (
    stats.totalEvents === 3 &&
    stats.totalSubscriptions === 3 &&
    stats.eventsByType[EventType.DEVICE_STATE_CHANGE] === 2 &&
    stats.eventsByType[EventType.AGENT_REGISTERED] === 1
  ) {
    logger.info('✓ PASS: Statistics tracking correctly');
    logger.info(`  Total events: ${stats.totalEvents}`);
    logger.info(`  Total subscriptions: ${stats.totalSubscriptions}`);
    logger.info(`  Subscriptions by subscriber:`, stats.subscriptionsBySubscriber);
    logger.info(`  Events by type:`, stats.eventsByType);
  } else {
    logger.info('✗ FAIL: Statistics not tracking correctly');
    logger.info(`  Stats:`, stats);
  }
} catch (error) {
  logger.info('✗ FAIL: Error in statistics test:', error);
}

logger.info('\n');
logger.info('='.repeat(80));
logger.info('EVENT MANAGER UNIT TESTS COMPLETE');
logger.info('='.repeat(80));
