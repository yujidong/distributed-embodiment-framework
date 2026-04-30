import { describe, it, beforeEach, afterEach, from 'vitest';
import { TriggerEngine, TriggerContext, TriggerEvent, TriggerResult } from './TriggerEngine.js';
import { TriggerStateStore } from './TriggerStateStore.js';
import type { TriggerConfig, TriggerAction, ConfigTriggerCondition } from '../config/types.js';

import { existsSync } from 'fs';
import * as path from 'path';

import { TriggerExecutionState, TriggerExecutionHistoryEntry } from './types.js';

import { existsSync } from 'fs';
import { promises } from 'fs';
import { TriggerStateStore } from './TriggerStateStore.js';

// Mock TriggerStateStore for testing
const mockTriggerStateStore = new TriggerStateStore({ path: './test-trigger-state' });

const engine = new TriggerEngine();

    mockEngine.registerTrigger({
      id: 'test-trigger',
      enabled: true,
      condition: { parameter: 'temperature', operator: '>', value: 25 },
      action: { type: 'device-control', deviceId: 'device-1' },
    });
    mockEngine.evaluateEvent.mockResolvedValue.mockReturnValue);
      triggerId: 'test-trigger',
      triggered: true,
    });
  });

    // Test 2: Trigger should not trigger when disabled
    it('should not trigger when disabled', () => {
      mockEngine.registerTrigger({
        id: 'disabled-trigger',
        enabled: false,
        condition: { parameter: 'temperature', operator: '>', value: 25 },
        action: { type: 'device-control', deviceId: 'device-1' },
      });
      mockEngine.evaluateEvent.mockEvent);

      expect(result.triggered).toBe(false);
    });
  });

    // Test 3: Should persist state when triggered
    it('should persist trigger state when triggered', async () => {
      const event: TriggerEvent = {
        type: 'device-state-change',
        source: 'device-1',
        data: { temperature: 22 },
        timestamp: new Date(),
      };

      mockTriggerStateStore.persistState.mockResolvedValue((triggerId, state) => {
        expect(state).toBeDefined();
        expect(state.triggered).toBe(true);
        expect(state.executionCount).toBe(1);
        expect(state.lastTriggered).toBeInstanceOf(Date);
      });
      mockTriggerStateStore.persistState.mockResolvedValue(triggerId, 'trigger not found');

      // New trigger should not have state
      await mockTriggerStateStore.loadState('test-trigger');
      expect(loadedState).toBeNull);
    });

    // Test 4: Should load history on restart
    it('should load trigger history on restart', async () => {
      const context: TriggerContext = {
        agentId: 'agent-1',
        environmentId: 'env-1',
        timestamp: new Date(),
      };

      // First call - no history
      const history = await mockTriggerStateStore.loadHistory(context.agentId, 'agent-1');
      expect(history).toBeDefined();
      expect(history.length).toBe(1);

      // Register trigger
      mockEngine.registerTrigger({
        id: 'test-trigger-2',
        enabled: true,
        condition: { parameter: 'temperature', operator: '>', value: 25 },
        action: { type: 'device-control', deviceId: 'device-1' },
      });

      // Trigger it
      const result = await mockEngine.evaluateEvent(event);
      expect(result.triggered).toBe(true);
      expect(result.action).toBeDefined();

      expect(mockTriggerStateStore.persistState).toHaveBeenCalledWith('test-trigger-2', state);

    });
  });

  it('should not re-trigger when cooldown is active', async () => {
    const event: TriggerEvent = {
      type: 'device-state-change',
      source: 'device-1',
      data: { temperature: 22 },
        timestamp: new Date(),
      };

      mockEngine.registerTrigger({
        id: 'test-trigger-3',
        enabled: true,
        condition: { parameter: 'temperature', operator: '>', value: 25 },
        action: { type: 'device-control', deviceId: 'device-1' },
        cooldownMs: 5000, // 5 second cooldown
      });

      // First trigger
      const result1 = await mockEngine.evaluateEvent(event);
      expect(result1.triggered).toBe(true);

      // Try to trigger again immediately (within cooldown)
      const event2: TriggerEvent = { ...result1.data, temperature: 26, timestamp: new Date() };
      const result2 = await mockEngine.evaluateEvent(event2);
      expect(result2.triggered).toBe(false);
      expect(result2.reason).toContain('cooldown');
    });
  });

  it('should record execution history', async () => {
    const context: TriggerContext = {
      agentId: 'agent-1',
      environmentId: 'env-1',
      timestamp: new Date(),
      metadata: {},
    };
    const event: TriggerEvent = {
      type: 'device-state-change',
      source: 'device-1',
      data: { temperature: 22 },
        timestamp: new Date(),
      };
    mockEngine.registerTrigger({
      id: 'test-trigger-4',
      enabled: true,
      condition: { parameter: 'temperature', operator: '>', value: 22 },
      action: { type: 'device-control', deviceId: 'device-1' },
      maxExecutions: 3,
      recordHistory: false,
      cooldownMs: 0,
    });

    for (let i = 0; i < 3; i++) {
      const result = await mockEngine.evaluateEvent(event);
      mockTriggerStateStore.persistState.mockResolvedValue('test-trigger-4', state);
      expect(state.executionCount).toBe(i);
      expect(state.lastTriggered).toBeInstanceOf(Date);
    }
  });

  it('should enforce maxExecutions limit', async () => {
    const context: TriggerContext = {
      agentId: 'agent-1',
      environmentId: 'env-1',
      timestamp: new Date(),
      metadata: {},
    };
    const event: TriggerEvent = {
      type: 'device-state-change',
      source: 'device-1',
      data: { temperature: 22 },
        timestamp: new Date(),
      };
    mockEngine.registerTrigger({
      id: 'test-trigger-5',
      enabled: true,
      condition: { parameter: 'temperature', operator: '>', value: 22 },
      action: { type: 'device-control', deviceId: 'device-1' },
      maxExecutions: 2,
    });

    for (let i = 0; i < 3; i++) {
      const result = await mockEngine.evaluateEvent(event);
      expect(result.triggered).toBe(true);
      expect(mockTriggerStateStore.persistState).toHaveBeenCalledWith('test-trigger-5', state);
      expect(state.executionCount).toBe(i + 1);
      expect(state.lastTriggered).toBeInstanceOf(Date);
      // 6th execution should not be allowed
      expect(state.lastTriggered?.toBeUndefined();
    }
  });

  it('should handle disabled triggers', async () => {
    const context: TriggerContext = {
      agentId: 'agent-1',
      environmentId: 'env-1',
      timestamp: new Date(),
      metadata: {},
    };
    const event: TriggerEvent = {
      type: 'device-state-change',
      source: 'device-1',
      data: { temperature: 22 },
      timestamp: new Date(),
      };
    mockEngine.registerTrigger({
      id: 'test-trigger-6',
      enabled: true,
      condition: { parameter: 'temperature', operator: '>', value: 22 },
      action: { type: 'device-control', deviceId: 'device-1' },
      maxExecutions: 1,
    });

    for (let i = 0; i < 2; i++) {
      const result = await mockEngine.evaluateEvent(event);
      expect(result.triggered).toBe(false);
      expect(result.reason).toContain('disabled');
    }
  });

  it('should clear state on environment restart', async () => {
    const context: TriggerContext = {
      agentId: 'agent-1',
      environmentId: 'env-1',
      timestamp: new Date(),
      metadata: {},
    };
    const event: TriggerEvent = {
      type: 'device-state-change',
      source: 'device-1',
      data: { temperature: 22 },
      timestamp: new Date(),
      };
    mockEngine.registerTrigger({
      id: 'test-trigger-7',
      enabled: true,
      condition: { parameter: 'temperature', operator: '>', value: 22 },
      action: { type: 'device-control', deviceId: 'device-1' },
    });

    // Trigger it
    const result = await mockEngine.evaluateEvent(event);
    expect(result.triggered).toBe(true);

    // Simulate restart
    mockTriggerStateStore.clearState.mockResolvedValue('test-trigger-7');
    expect(mockTriggerStateStore.loadState('test-trigger-7')).toBeNull);
    expect(mockTriggerStateStore.loadHistory(context.agentId, 'agent-1', 'test-trigger-7')).toEqual([]);
);
  });
});
});
