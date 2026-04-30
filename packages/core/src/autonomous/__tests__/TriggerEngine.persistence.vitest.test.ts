/**
 * Trigger Engine Persistence Tests
 *
 * Tests for trigger state persistence integration.
 * Sprint 7: Trigger State Persistence
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TriggerEngine } from '../TriggerEngine.js';
import { TriggerStateStore } from '../TriggerStateStore.js';
import type { TriggerConfig, TriggerAction } from '../../config/types.js';

import type { TriggerExecutionState } from '../TriggerStateStore.js';

describe('TriggerEngine with State Persistence', () => {
  let engine: TriggerEngine;
  let stateStore: TriggerStateStore;
  const testStoragePath = './test-trigger-engine-state';

  beforeEach(async () => {
    // Create state store
    stateStore = new TriggerStateStore({ path: testStoragePath });
    await stateStore.initialize({ path: testStoragePath });

    // Create engine with state store
    engine = new TriggerEngine();
    engine.setStateStore(stateStore);
  });

  afterEach(async () => {
    await stateStore.close();
    // Clean up test data
    try {
      const fs = await import('fs/promises');
      await fs.rm(testStoragePath, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  const createTestTrigger = (id: string): TriggerConfig => {
    return {
      id,
      name: `Test Trigger ${id}`,
      enabled: true,
      type: 'threshold-crossed',
      condition: {
        deviceId: 'device-1',
        parameter: 'temperature',
        operator: '>',
        value: 30,
      },
      action: {
        type: 'device-control',
        deviceId: 'device-1',
        command: 'turnOn',
      },
      cooldownMs: 1000,
      maxExecutions: 5,
    };
  };

  describe('State Persistence Integration', () => {
    it('should persist trigger state after execution', async () => {
      const config = createTestTrigger('persist-test-1');

      await engine.registerTrigger(config);

      // Trigger the trigger
      const event = {
        type: 'device-state-change',
        source: 'device-1',
        timestamp: new Date(),
        data: {
          temperature: 35,
        },
      };

      await engine.evaluateEvent(event);

      // Check state was persisted
      const state = await stateStore.getTriggerState('persist-test-1');
      expect(state).toBeDefined();
      expect(state?.executionCount).toBe(1);
    });

    it('should restore trigger state on engine restart', async () => {
      const config = createTestTrigger('restore-test-1');

      // Register and trigger
      await engine.registerTrigger(config);

      const event = {
        type: 'device-state-change',
        source: 'device-1',
        timestamp: new Date(),
        data: {
          temperature: 35,
        },
      };

      await engine.evaluateEvent(event);

      // Verify execution
      const state1 = await stateStore.getTriggerState('restore-test-1');
      expect(state1?.executionCount).toBe(1);

      // Close and recreate engine
      await stateStore.close();

      const newStateStore = new TriggerStateStore({ path: testStoragePath });
      await newStateStore.initialize({ path: testStoragePath });

      const newEngine = new TriggerEngine();
      newEngine.setStateStore(newStateStore);

      // Restore trigger (should load persisted state)
      await newEngine.registerTrigger(config);

      // Verify state was restored
      const restoredState = await newStateStore.getTriggerState('restore-test-1');
      expect(restoredState?.executionCount).toBe(1);

      await newStateStore.close();
    });

    it('should enforce max executions limit across restarts', async () => {
      const config = createTestTrigger('max-exec-test-1');
      config.maxExecutions = 2;
      config.cooldownMs = 0;

      await engine.registerTrigger(config);

      // Trigger twice
      const event = {
        type: 'device-state-change',
        source: 'device-1',
        timestamp: new Date(),
        data: { temperature: 35 },
      };

      await engine.evaluateEvent(event);
      await engine.evaluateEvent(event);

      // Verify execution count
      const state = await stateStore.getTriggerState('max-exec-test-1');
      expect(state?.executionCount).toBe(2);

      // Close and restore
      await stateStore.close();

      const newStateStore = new TriggerStateStore({ path: testStoragePath });
      await newStateStore.initialize({ path: testStoragePath });

      const newEngine = new TriggerEngine();
      newEngine.setStateStore(newStateStore);
      await newEngine.registerTrigger(config);

      // Try to trigger again (should be blocked by max executions)
      await newEngine.evaluateEvent(event);

      const restoredState = await newStateStore.getTriggerState('max-exec-test-1');
      expect(restoredState?.executionCount).toBe(2); // Should not increase

      await newStateStore.close();
    });
  });

  describe('Idempotency', () => {
    it('should prevent duplicate executions', async () => {
      const config = createTestTrigger('idempotent-test-1');

      await engine.registerTrigger(config);

      const event = {
        type: 'device-state-change',
        source: 'device-1',
        timestamp: new Date(),
        data: { temperature: 35 },
      };

      // First execution
      const result1 = await engine.evaluateEvent(event);
      expect(result1).toHaveLength(1);
      expect(result1[0].triggered).toBe(true);

      // Second execution (should be blocked by cooldown)
      const result2 = await engine.evaluateEvent(event);
      expect(result2).toHaveLength(0); // Not triggered due to cooldown
    });
  });

  describe('Execution History', () => {
    it('should record execution history', async () => {
      const config = createTestTrigger('history-test-1');

      await engine.registerTrigger(config);

      const event = {
        type: 'device-state-change',
        source: 'device-1',
        timestamp: new Date(),
        data: { temperature: 35 },
      };

      await engine.evaluateEvent(event);

      // Check history was recorded
      const history = await stateStore.getExecutionHistory('history-test-1');
      expect(history).toHaveLength(1);
      expect(history[0].triggered).toBe(true);
      expect(history[0].triggerId).toBe('history-test-1');
    });
  });
});
