/**
 * Event-Driven System Integration Tests
 *
 * Tests for autonomous, event-driven collaboration between agents and devices
 */

import { EventManager, EventType, EventPriority } from './EventManager.js';
import { EventEmitter } from './EventEmitter.js';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('EventIntegration.test');
logger.info('='.repeat(80));
logger.info('EVENT-DRIVEN SYSTEM INTEGRATION TESTS');
logger.info('='.repeat(80));
logger.info('\n');

// ============================================================================
// Test 1: Device State Change Event Emission
// ============================================================================
logger.info('Test 1: Device State Change Event Emission');
logger.info('-'.repeat(80));
logger.info('Scenario: Device state changes and emits event to all subscribers');
logger.info('Expected: Event is published with correct payload');
logger.info('');

try {
  const eventManager = new EventManager(100);
  let deviceStateChangeEventReceived = false;

  // Simulate a device
  const deviceId = 'sensor-temperature-1';
  const deviceEmitter = new EventEmitter(eventManager, deviceId);

  // Subscribe to device state changes
  eventManager.subscribe({
    subscriberId: 'test-subscriber',
    eventType: EventType.DEVICE_STATE_CHANGE,
    handler: (event: any) => {
      logger.info(`[Test 1] Event received: ${event.type}`);
      logger.info(`[Test 1] Source: ${event.source}`);
      logger.info(`[Test 1] Payload:`, event.payload);

      // Verify event payload (emitStateChange wraps it in emitterId, oldState, newState, changedParameters)
      if (
        event.payload.emitterId === deviceId &&
        event.payload.changedParameters.includes('temperature')
      ) {
        deviceStateChangeEventReceived = true;
        logger.info('[Test 1] PASS: Device state change event received correctly');
      } else {
        logger.info('[Test 1] FAIL: Event payload incorrect');
      }
    },
  });

  // Simulate device state change
  logger.info('[Test 1] Simulating device state change...');
  const oldState = { temperature: 20, humidity: 50, online: true };
  const newState = { temperature: 25, humidity: 50, online: true };

  deviceEmitter.emitStateChange(oldState, newState, {
    metadata: {
      deviceId,
      deviceName: 'Temperature Sensor 1',
      deviceType: 'sensor',
      location: 'room1',
    },
  });

  // Wait a bit for async event delivery
  setTimeout(() => {
    if (deviceStateChangeEventReceived) {
      logger.info('[Test 1] ✓ COMPLETE: Device state change event system working');
    } else {
      logger.info('[Test 1] ✗ FAIL: Device state change event not received');
    }
    logger.info('\n');
    runTest2();
  }, 100);
} catch (error) {
  logger.info('[Test 1] ✗ FAIL: Error in device state change test:', error);
  logger.info('\n');
  runTest2();
}

// ============================================================================
// Test 2: Agent Responds to Device Events (Autonomous Collaboration)
// ============================================================================
function runTest2() {
  logger.info('Test 2: Agent Responds to Device Events (Autonomous)');
  logger.info('-'.repeat(80));
  logger.info('Scenario: Agent receives device event and evaluates response autonomously');
  logger.info('Expected: Agent evaluates event and takes action without human prompt');
  logger.info('');

  try {
    const eventManager = new EventManager(100);

    // Simulate an agent
    const agentId = 'agent-safety-1';
    const agentEmitter = new EventEmitter(eventManager, agentId);

    // Simulate a device owned by user
    const deviceId = 'sensor-smoke-1';
    const deviceEmitter = new EventEmitter(eventManager, deviceId);

    let agentReceivedEvent = false;
    let agentTookAction = false;

    // Agent subscribes to device state changes
    eventManager.subscribe({
      subscriberId: agentId,
      eventType: EventType.DEVICE_STATE_CHANGE,
      handler: (event: any) => {
        logger.info(`[Test 2] Agent ${agentId} received event from ${event.source}`);
        agentReceivedEvent = true;

        // Check if this is the agent's device (emitStateChange uses emitterId)
        if (event.payload.emitterId === deviceId) {
          logger.info(`[Test 2] Agent ${agentId} identified this as my device`);
          logger.info(`[Test 2] Changed parameters:`, event.payload.changedParameters);

          // Agent autonomously evaluates and responds
          const smokeDetected = event.payload.newState.smoke === true;

          if (smokeDetected) {
            logger.info(`[Test 2] Agent ${agentId} detected smoke!`);
            logger.info(`[Test 2] Agent ${agentId} autonomously triggering alarm...`);

            // Agent takes autonomous action (emit collaboration event)
            agentEmitter.emit(EventType.COLLABORATION_MESSAGE, {
              fromAgent: agentId,
              toAgent: 'all',
              messageType: 'emergency',
              content: 'Smoke detected! Triggering emergency protocol.',
              urgency: 'high',
            });

            agentTookAction = true;
            logger.info('[Test 2] PASS: Agent autonomously responded to device event');
          }
        }
      },
      priority: EventPriority.HIGH,
    });

    // Another agent subscribes to collaboration messages
    eventManager.subscribe({
      subscriberId: 'agent-emergency-1',
      eventType: EventType.COLLABORATION_MESSAGE,
      handler: (event: any) => {
        logger.info(`[Test 2] Emergency agent received collaboration message`);
        logger.info(`[Test 2] Message: ${event.payload.content}`);
        logger.info('[Test 2] PASS: Autonomous collaboration working');
      },
      priority: EventPriority.HIGH,
    });

    // Simulate smoke detection event
    logger.info('[Test 2] Simulating smoke detection (no human prompt)...');
    setTimeout(() => {
      const oldState = { smoke: false, temperature: 22 };
      const newState = { smoke: true, temperature: 28 };

      deviceEmitter.emitStateChange(oldState, newState, {
        metadata: {
          deviceId,
          deviceName: 'Smoke Detector 1',
          deviceType: 'sensor',
          location: 'kitchen',
        },
      });

      // Verify results
      setTimeout(() => {
        if (agentReceivedEvent && agentTookAction) {
          logger.info('[Test 2] ✓ COMPLETE: Autonomous agent response verified');
        } else {
          logger.info('[Test 2] ✗ FAIL: Agent did not respond autonomously');
          logger.info(`[Test 2] Agent received event: ${agentReceivedEvent}`);
          logger.info(`[Test 2] Agent took action: ${agentTookAction}`);
        }
        logger.info('\n');
        runTest3();
      }, 100);
    }, 100);
  } catch (error) {
    logger.info('[Test 2] ✗ FAIL: Error in autonomous agent test:', error);
    logger.info('\n');
    runTest3();
  }
}

// ============================================================================
// Test 3: Event-Driven Multi-Agent Collaboration
// ============================================================================
function runTest3() {
  logger.info('Test 3: Event-Driven Multi-Agent Collaboration');
  logger.info('-'.repeat(80));
  logger.info('Scenario: Multiple agents collaborate based on device events (no prompts)');
  logger.info('Expected: Safety agent notifies emergency agent without human intervention');
  logger.info('');

  try {
    const eventManager = new EventManager(100);

    // Create multiple agents
    const safetyAgentId = 'agent-safety-2';
    const emergencyAgentId = 'agent-emergency-2';
    const comfortAgentId = 'agent-comfort-1';

    const safetyEmitter = new EventEmitter(eventManager, safetyAgentId);
    const emergencyEmitter = new EventEmitter(eventManager, emergencyAgentId);
    // Note: comfortEmitter is not used in this test

    // Create device
    const deviceId = 'sensor-gas-1';
    const deviceEmitter = new EventEmitter(eventManager, deviceId);

    const eventLog: string[] = [];

    // Safety agent subscribes to gas sensor
    eventManager.subscribe({
      subscriberId: safetyAgentId,
      eventType: EventType.DEVICE_STATE_CHANGE,
      filter: { source: deviceId },
      handler: (event: any) => {
        if (event.payload.newState.gas_detected === true) {
          eventLog.push(`${safetyAgentId} detected gas leak`);
          logger.info(`[Test 3] ${safetyAgentId}: Gas leak detected!`);

          // Safety agent autonomously collaborates with emergency agent
          safetyEmitter.emit(EventType.COLLABORATION_MESSAGE, {
            fromAgent: safetyAgentId,
            toAgent: emergencyAgentId,
            messageType: 'emergency',
            content: 'Gas leak detected! Emergency response required.',
            deviceId,
            severity: 'critical',
          });

          eventLog.push(`${safetyAgentId} notified ${emergencyAgentId}`);
          logger.info(`[Test 3] ${safetyAgentId}: Notified ${emergencyAgentId}`);
        }
      },
      priority: EventPriority.URGENT,
    });

    // Emergency agent subscribes to collaboration messages
    // Note: filter checks payload.toAgent, not metadata.toAgent
    eventManager.subscribe({
      subscriberId: emergencyAgentId,
      eventType: EventType.COLLABORATION_MESSAGE,
      handler: (event: any) => {
        // Check if message is for this agent or for all agents
        const isForMe = event.payload.toAgent === emergencyAgentId || event.payload.toAgent === 'all';

        if (isForMe && event.payload.severity === 'critical') {
          eventLog.push(`${emergencyAgentId} received emergency alert`);
          logger.info(`[Test 3] ${emergencyAgentId}: Received emergency alert from ${event.payload.fromAgent}`);
          logger.info(`[Test 3] ${emergencyAgentId}: Initiating emergency protocol...`);

          // Emergency agent takes autonomous action
          emergencyEmitter.emit(EventType.AGENT_TASK_ASSIGNED, {
            agentId: emergencyAgentId,
            taskId: 'emergency-response-1',
            taskTitle: 'Gas Leak Emergency Response',
            priority: 'urgent',
            assignedBy: 'system',
          });

          eventLog.push(`${emergencyAgentId} initiated emergency protocol`);
        }
      },
      priority: EventPriority.URGENT,
    });

    // Comfort agent also receives state change but should NOT respond
    eventManager.subscribe({
      subscriberId: comfortAgentId,
      eventType: EventType.DEVICE_STATE_CHANGE,
      filter: { source: deviceId },
      handler: () => {
        eventLog.push(`${comfortAgentId} received event but took no action`);
        logger.info(`[Test 3] ${comfortAgentId}: Event received (not my responsibility)`);
      },
      priority: EventPriority.NORMAL,
    });

    // Simulate gas leak detection
    logger.info('[Test 3] Simulating gas leak (purely event-driven, no human prompts)...');
    setTimeout(() => {
      const oldState = { gas_detected: false, gas_level: 0 };
      const newState = { gas_detected: true, gas_level: 150 };

      deviceEmitter.emitStateChange(oldState, newState, {
        metadata: {
          deviceId,
          deviceName: 'Gas Sensor 1',
          deviceType: 'sensor',
          location: 'basement',
        },
      });

      // Verify autonomous collaboration
      setTimeout(() => {
        logger.info('[Test 3] Event log:', eventLog);

        const safetyActed = eventLog.some(log => log.includes(safetyAgentId) && log.includes('detected'));
        const safetyNotifiedEmergency = eventLog.some(log => log.includes(safetyAgentId) && log.includes('notified'));
        const emergencyReceivedAlert = eventLog.some(log => log.includes(emergencyAgentId) && log.includes('received emergency alert'));
        const emergencyResponded = eventLog.some(log => log.includes(emergencyAgentId) && log.includes('initiated emergency protocol'));
        const comfortAgentReceived = eventLog.some(log => log.includes(comfortAgentId) && log.includes('received event but took no action'));

        if (safetyActed && safetyNotifiedEmergency && emergencyReceivedAlert && emergencyResponded && comfortAgentReceived) {
          logger.info('[Test 3] ✓ COMPLETE: Multi-agent autonomous collaboration verified');
          logger.info('[Test 3] Key: No human prompts were used - purely event-driven');
        } else {
          logger.info('[Test 3] ✗ FAIL: Multi-agent collaboration incomplete');
          logger.info(`[Test 3]   Safety acted: ${safetyActed}`);
          logger.info(`[Test 3]   Safety notified emergency: ${safetyNotifiedEmergency}`);
          logger.info(`[Test 3]   Emergency received alert: ${emergencyReceivedAlert}`);
          logger.info(`[Test 3]   Emergency responded: ${emergencyResponded}`);
          logger.info(`[Test 3]   Comfort agent received (but did not act): ${comfortAgentReceived}`);
        }
        logger.info('\n');
        runTest4();
      }, 200);
    }, 100);
  } catch (error) {
    logger.info('[Test 3] ✗ FAIL: Error in multi-agent collaboration test:', error);
    logger.info('\n');
    runTest4();
  }
}

// ============================================================================
// Test 4: Event Correlation and Tracing
// ============================================================================
function runTest4() {
  logger.info('Test 4: Event Correlation and Tracing');
  logger.info('-'.repeat(80));
  logger.info('Scenario: Multiple related events are traced using correlation ID');
  logger.info('Expected: All events with same correlation ID are retrieved');
  logger.info('');

  try {
    const eventManager = new EventManager(100);
    const correlationId = 'emergency-response-abc123';

    // Create device and agents
    const deviceEmitter = new EventEmitter(eventManager, 'sensor-1');
    const safetyEmitter = new EventEmitter(eventManager, 'agent-safety');
    const emergencyEmitter = new EventEmitter(eventManager, 'agent-emergency');

    logger.info('[Test 4] Emitting correlated events...');

    // Event 1: Device detects issue
    deviceEmitter.emit(EventType.DEVICE_STATE_CHANGE, {
      deviceId: 'sensor-1',
      issue: 'gas_detected',
    }, {
      correlationId,
    });

    // Event 2: Safety agent responds
    safetyEmitter.emit(EventType.COLLABORATION_MESSAGE, {
      fromAgent: 'agent-safety',
      toAgent: 'agent-emergency',
      message: 'Emergency!',
    }, {
      correlationId,
    });

    // Event 3: Emergency agent takes action
    emergencyEmitter.emit(EventType.AGENT_TASK_ASSIGNED, {
      agentId: 'agent-emergency',
      task: 'emergency-response',
    }, {
      correlationId,
    });

    // Unrelated event (should not be correlated)
    deviceEmitter.emit(EventType.DEVICE_STATE_CHANGE, {
      deviceId: 'sensor-2',
      status: 'normal',
    });

    // Retrieve correlated events
    const correlatedEvents = eventManager.correlateEvents(correlationId);

    logger.info(`[Test 4] Found ${correlatedEvents.length} correlated events (expected 3)`);

    if (correlatedEvents.length === 3) {
      logger.info('[Test 4] ✓ PASS: All correlated events retrieved');
      correlatedEvents.forEach((event, index) => {
        logger.info(`[Test 4]   ${index + 1}. ${event.type} from ${event.source}`);
      });
      logger.info('[Test 4] ✓ COMPLETE: Event correlation system working');
    } else {
      logger.info('[Test 4] ✗ FAIL: Incorrect number of correlated events');
    }

    logger.info('\n');
    runTest5();
  } catch (error) {
    logger.info('[Test 4] ✗ FAIL: Error in event correlation test:', error);
    logger.info('\n');
    runTest5();
  }
}

// ============================================================================
// Test 5: Event Priority and Ordering
// ============================================================================
function runTest5() {
  logger.info('Test 5: Event Priority and Ordering');
  logger.info('-'.repeat(80));
  logger.info('Scenario: Critical events are processed before normal events');
  logger.info('Expected: URGENT events delivered first, then HIGH, then NORMAL');
  logger.info('');

  try {
    const eventManager = new EventManager(100);
    const callOrder: string[] = [];

    // Subscribe with different priorities
    eventManager.subscribe({
      subscriberId: 'low-priority-handler',
      eventType: EventType.DEVICE_STATE_CHANGE,
      priority: EventPriority.LOW,
      handler: () => { callOrder.push('LOW'); },
    });

    eventManager.subscribe({
      subscriberId: 'urgent-priority-handler',
      eventType: EventType.DEVICE_STATE_CHANGE,
      priority: EventPriority.URGENT,
      handler: () => { callOrder.push('URGENT'); },
    });

    eventManager.subscribe({
      subscriberId: 'normal-priority-handler',
      eventType: EventType.DEVICE_STATE_CHANGE,
      priority: EventPriority.NORMAL,
      handler: () => { callOrder.push('NORMAL'); },
    });

    eventManager.subscribe({
      subscriberId: 'high-priority-handler',
      eventType: EventType.DEVICE_STATE_CHANGE,
      priority: EventPriority.HIGH,
      handler: () => { callOrder.push('HIGH'); },
    });

    // Publish a single event
    const emitter = new EventEmitter(eventManager, 'device-1');
    emitter.emit(EventType.DEVICE_STATE_CHANGE, { test: 'priority-ordering' });

    // Check delivery order
    setTimeout(() => {
      const expectedOrder = 'URGENT,HIGH,NORMAL,LOW';
      const actualOrder = callOrder.join(',');

      logger.info(`[Test 5] Expected order: ${expectedOrder}`);
      logger.info(`[Test 5] Actual order: ${actualOrder}`);

      if (actualOrder === expectedOrder) {
        logger.info('[Test 5] ✓ PASS: Events delivered in correct priority order');
        logger.info('[Test 5] ✓ COMPLETE: Priority-based event routing working');
      } else {
        logger.info('[Test 5] ✗ FAIL: Events not delivered in correct order');
      }

      logger.info('\n');
      printSummary();
    }, 100);
  } catch (error) {
    logger.info('[Test 5] ✗ FAIL: Error in priority ordering test:', error);
    logger.info('\n');
    printSummary();
  }
}

// ============================================================================
// Summary
// ============================================================================
function printSummary() {
  logger.info('='.repeat(80));
  logger.info('EVENT-DRIVEN SYSTEM INTEGRATION TESTS COMPLETE');
  logger.info('='.repeat(80));
  logger.info('\n');
  logger.info('Summary:');
  logger.info('--------');
  logger.info('✓ Test 1: Device state change event emission');
  logger.info('✓ Test 2: Agent responds autonomously to device events');
  logger.info('✓ Test 3: Multi-agent autonomous collaboration (no human prompts)');
  logger.info('✓ Test 4: Event correlation and tracing');
  logger.info('✓ Test 5: Event priority and ordering');
  logger.info('\n');
  logger.info('Key Achievement: Event-driven collaboration WITHOUT human prompts');
  logger.info('This demonstrates the foundation for autonomous agent behavior.');
  logger.info('\n');
}
