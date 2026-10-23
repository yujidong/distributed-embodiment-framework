/**
 * Test: Trigger State Persistence
 * Sprint 7: Verifies trigger state persistence on restart
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TriggerStateStore } from './TriggerStateStore.js';
import type { TriggerExecutionState } from './TriggerStateStore.js';

describe('TriggerStateStore - Sprint 7', () => {
  let store: TriggerStateStore;
  const testPath = './test-trigger-state-sprint7';

  beforeEach(async () => {
    store = new TriggerStateStore({ path: testPath });
    await store.initialize({ path: testPath });
  });

  afterEach(async () => {
    await store.close();
    const fs = await import('fs/promises');
    await fs.rm(testPath, { recursive: true, force: true });
  });

  it('should persist trigger state', async () => {
    const triggerId = 'test-trigger';
    const state: TriggerExecutionState = {
      triggerId,
      executionCount: 5,
      lastTriggered: new Date('2026-01-01T00:00:00Z'),
      enabled: true,
      metadata: {},
    };

    await store.saveTriggerState(state);

    const loaded = await store.getTriggerState(triggerId);
    expect(loaded).toBeDefined();
    expect(loaded!.triggerId).toBe(triggerId);
    expect(loaded!.executionCount).toBe(5);
    expect(loaded!.enabled).toBe(true);
  });

  it('should record and retrieve execution history', async () => {
    const triggerId = 'test-trigger';
    const state: TriggerExecutionState = {
      triggerId,
      executionCount: 0,
      enabled: true,
      metadata: {},
    };

    await store.saveTriggerState(state);

    await store.recordExecution({
      id: 'exec-1',
      triggerId,
      timestamp: new Date(),
      triggered: true,
      actionTaken: 'test-action',
    });

    const history = await store.getExecutionHistory(triggerId);
    expect(history).toBeDefined();
    expect(history).toHaveLength(1);
    expect(history[0].triggerId).toBe(triggerId);
    expect(history[0].triggered).toBe(true);
  });
});
