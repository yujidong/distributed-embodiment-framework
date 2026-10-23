/**
 * Trigger State Store Tests
 *
 * Tests for trigger execution state persistence.
 * Sprint 7: Trigger State Persistence
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TriggerStateStore } from '../TriggerStateStore.js';
import type { TriggerExecutionState, ExecutionHistoryEntry } from '../TriggerStateStore.js';

describe('TriggerStateStore', () => {
  let store: TriggerStateStore;
  const testStoragePath = path.join(__dirname, 'test-trigger-state');

  beforeEach(async () => {
    // Create a fresh store for each test
    store = new TriggerStateStore({ path: testStoragePath });
    await store.initialize({ path: testStoragePath });
  });

  afterEach(async () => {
    // Clean up test data
    await store.close();
    try {
      await fs.rm(testStoragePath, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('State Persistence', () => {
    it('should save trigger execution state', async () => {
      const state: TriggerExecutionState = {
        triggerId: 'test-trigger-1',
        executionCount: 5,
        lastTriggered: new Date('2024-01-15T10:30:00Z'),
        lastEvaluation: new Date('2024-01-15T10:35:00Z'),
        enabled: true,
        metadata: {
          lastError: undefined,
          successfulExecutions: 4,
          failedExecutions: 1,
        },
      };

      await store.saveTriggerState(state);

      const retrieved = await store.getTriggerState('test-trigger-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.triggerId).toBe('test-trigger-1');
      expect(retrieved?.executionCount).toBe(5);
      expect(retrieved?.lastTriggered).toEqual(new Date('2024-01-15T10:30:00Z'));
      expect(retrieved?.enabled).toBe(true);
    });

    it('should return null for non-existent trigger state', async () => {
      const state = await store.getTriggerState('non-existent');
      expect(state).toBeNull();
    });

    it('should update existing trigger state', async () => {
      const state1: TriggerExecutionState = {
        triggerId: 'test-trigger-2',
        executionCount: 1,
        lastTriggered: new Date('2024-01-15T10:00:00Z'),
        lastEvaluation: new Date('2024-01-15T10:00:00Z'),
        enabled: true,
        metadata: {},
      };

      await store.saveTriggerState(state1);

      const state2: TriggerExecutionState = {
        triggerId: 'test-trigger-2',
        executionCount: 2,
        lastTriggered: new Date('2024-01-15T11:00:00Z'),
        lastEvaluation: new Date('2024-01-15T11:00:00Z'),
        enabled: false,
        metadata: {},
      };

      await store.saveTriggerState(state2);

      const retrieved = await store.getTriggerState('test-trigger-2');
      expect(retrieved?.executionCount).toBe(2);
      expect(retrieved?.enabled).toBe(false);
    });

    it('should persist state across store restarts', async () => {
      const state: TriggerExecutionState = {
        triggerId: 'persistent-trigger',
        executionCount: 10,
        lastTriggered: new Date('2024-01-15T12:00:00Z'),
        lastEvaluation: new Date('2024-01-15T12:00:00Z'),
        enabled: true,
        metadata: {},
      };

      await store.saveTriggerState(state);
      await store.close();

      // Create a new store instance
      const newStore = new TriggerStateStore({ path: testStoragePath });
      await newStore.initialize({ path: testStoragePath });

      const retrieved = await newStore.getTriggerState('persistent-trigger');
      expect(retrieved).toBeDefined();
      expect(retrieved?.executionCount).toBe(10);

      await newStore.close();
    });
  });

  describe('Execution History', () => {
    it('should record execution history entries', async () => {
      const entry: ExecutionHistoryEntry = {
        id: 'exec-1',
        triggerId: 'test-trigger-1',
        timestamp: new Date('2024-01-15T10:30:00Z'),
        triggered: true,
        actionTaken: 'device-control',
        details: 'Temperature exceeded threshold',
        executionTime: 150,
      };

      await store.recordExecution(entry);

      const history = await store.getExecutionHistory('test-trigger-1');
      expect(history).toHaveLength(1);
      expect(history[0].triggerId).toBe('test-trigger-1');
      expect(history[0].triggered).toBe(true);
      expect(history[0].actionTaken).toBe('device-control');
    });

    it('should retrieve limited execution history', async () => {
      // Record multiple executions with proper timestamps
      const baseTime = Date.now();
      for (let i = 0; i < 20; i++) {
        const entry: ExecutionHistoryEntry = {
          id: `exec-${i}`,
          triggerId: 'test-trigger-2',
          timestamp: new Date(baseTime + i * 1000), // Each entry 1 second apart
          triggered: i % 2 === 0,
          actionTaken: i % 2 === 0 ? 'device-control' : undefined,
          details: `Execution ${i}`,
          executionTime: 100 + i,
        };
        await store.recordExecution(entry);
      }

      const history = await store.getExecutionHistory('test-trigger-2', 5);
      expect(history).toHaveLength(5);
      // Should get most recent entries (highest indices have latest timestamps)
      expect(history[0].id).toBe('exec-19');
      expect(history[1].id).toBe('exec-18');
      expect(history[2].id).toBe('exec-17');
    });

    it('should retrieve all trigger states', async () => {
      const state1: TriggerExecutionState = {
        triggerId: 'trigger-1',
        executionCount: 1,
        enabled: true,
        metadata: {},
      };

      const state2: TriggerExecutionState = {
        triggerId: 'trigger-2',
        executionCount: 2,
        enabled: false,
        metadata: {},
      };

      await store.saveTriggerState(state1);
      await store.saveTriggerState(state2);

      const allStates = await store.getAllTriggerStates();
      expect(allStates).toHaveLength(2);
      expect(allStates.map(s => s.triggerId)).toContain('trigger-1');
      expect(allStates.map(s => s.triggerId)).toContain('trigger-2');
    });
  });

  describe('Idempotency', () => {
    it('should detect duplicate execution within idempotency window', async () => {
      const executionId = 'exec-duplicate-test';

      const isFirst = await store.checkAndMarkIdempotent(executionId, 5000);
      expect(isFirst).toBe(true);

      const isSecond = await store.checkAndMarkIdempotent(executionId, 5000);
      expect(isSecond).toBe(false);

      const isThird = await store.checkAndMarkIdempotent(executionId, 5000);
      expect(isThird).toBe(false);
    });

    it('should allow execution after idempotency window expires', async () => {
      const executionId = 'exec-window-test';

      const isFirst = await store.checkAndMarkIdempotent(executionId, 100);
      expect(isFirst).toBe(true);

      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      const isAfterWindow = await store.checkAndMarkIdempotent(executionId, 100);
      expect(isAfterWindow).toBe(true);
    });
  });

  describe('Concurrent Safety', () => {
    it('should handle concurrent state updates safely', async () => {
      const triggerId = 'concurrent-trigger';

      // Simulate concurrent updates
      const updates = Array(10).fill(null).map((_, i) => {
        const state: TriggerExecutionState = {
          triggerId,
          executionCount: i,
          enabled: true,
          metadata: { index: i },
        };
        return store.saveTriggerState(state);
      });

      await Promise.all(updates);

      const finalState = await store.getTriggerState(triggerId);
      expect(finalState).toBeDefined();
      expect(finalState?.triggerId).toBe(triggerId);
      // One of the updates should have succeeded
      expect(finalState?.metadata.index).toBeGreaterThanOrEqual(0);
      expect(finalState?.metadata.index).toBeLessThan(10);
    });

    it('should handle concurrent execution recordings', async () => {
      const triggerId = 'concurrent-history-trigger';

      const recordings = Array(20).fill(null).map((_, i) => {
        const entry: ExecutionHistoryEntry = {
          id: `concurrent-exec-${i}`,
          triggerId,
          timestamp: new Date(),
          triggered: true,
          executionTime: i,
        };
        return store.recordExecution(entry);
      });

      await Promise.all(recordings);

      const history = await store.getExecutionHistory(triggerId);
      expect(history).toHaveLength(20);
    });
  });

  describe('Cleanup', () => {
    it('should clear all trigger states', async () => {
      const state1: TriggerExecutionState = {
        triggerId: 'trigger-1',
        executionCount: 1,
        enabled: true,
        metadata: {},
      };

      const state2: TriggerExecutionState = {
        triggerId: 'trigger-2',
        executionCount: 2,
        enabled: false,
        metadata: {},
      };

      await store.saveTriggerState(state1);
      await store.saveTriggerState(state2);

      await store.clearAllStates();

      const allStates = await store.getAllTriggerStates();
      expect(allStates).toHaveLength(0);
    });

    it('should clean up old execution history', async () => {
      const triggerId = 'cleanup-trigger';
      const now = Date.now();
      const oldTimestamp = new Date(now - 10 * 24 * 60 * 60 * 1000); // 10 days ago
      const recentTimestamp = new Date(now - 1 * 60 * 60 * 1000); // 1 hour ago

      // Record old entry
      await store.recordExecution({
        id: 'old-exec',
        triggerId,
        timestamp: oldTimestamp,
        triggered: true,
        executionTime: 100,
      });

      // Record recent entry
      await store.recordExecution({
        id: 'recent-exec',
        triggerId,
        timestamp: recentTimestamp,
        triggered: true,
        executionTime: 100,
      });

      // Clean up entries older than 7 days
      const deleted = await store.cleanupOldHistory(7 * 24 * 60 * 60 * 1000);

      expect(deleted).toBe(1);

      const history = await store.getExecutionHistory(triggerId);
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe('recent-exec');
    });
  });
});
