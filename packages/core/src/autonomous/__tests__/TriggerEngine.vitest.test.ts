/**
 * TriggerEngine Unit Tests (TDD)
 *
 * Tests for event-driven trigger evaluation and action execution.
 * These tests are written BEFORE implementation following TDD principles.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TriggerEngine, type TriggerContext, type TriggerEvent, type TriggerResult } from '../TriggerEngine.js';
import type { TriggerConfig, TriggerAction, ConfigTriggerCondition } from '../../config/types.js';

describe('TriggerEngine', () => {
  let engine: TriggerEngine;
  let executedActions: TriggerAction[];

  beforeEach(() => {
    engine = new TriggerEngine();
    executedActions = [];

    // Set up action executor mock
    engine.setActionExecutor(async (action: TriggerAction, context: TriggerContext) => {
      executedActions.push(action);
      return { success: true, action };
    });
  });

  afterEach(() => {
    engine.clearAllTriggers();
    vi.useRealTimers();
  });

  describe('registerTrigger', () => {
    it('should register a valid trigger', async () => {
      const trigger: TriggerConfig = {
        id: 'trigger-1',
        name: 'High Temperature Alert',
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
          deviceId: 'device-2',
          command: 'turnOn',
        },
      };

      await expect(engine.registerTrigger(trigger)).resolves.not.toThrow();
      expect(engine.hasTrigger('trigger-1')).toBe(true);
    });

    it('should throw error when registering trigger with duplicate id', async () => {
      const trigger: TriggerConfig = {
        id: 'trigger-1',
        name: 'Trigger 1',
        enabled: true,
        type: 'device-state-change',
        condition: { deviceId: 'device-1' },
        action: { type: 'notification' },
      };

      await engine.registerTrigger(trigger);

      const duplicateTrigger: TriggerConfig = {
        ...trigger,
        name: 'Duplicate Trigger',
      };

      await expect(engine.registerTrigger(duplicateTrigger)).rejects.toThrow(/already exists/);
    });

    it('should not register disabled trigger for evaluation', async () => {
      const trigger: TriggerConfig = {
        id: 'trigger-disabled',
        name: 'Disabled Trigger',
        enabled: false,
        type: 'device-state-change',
        condition: { deviceId: 'device-1' },
        action: { type: 'notification' },
      };

      await engine.registerTrigger(trigger);

      // Disabled trigger should not be in active triggers
      const activeTriggers = engine.getActiveTriggers();
      expect(activeTriggers.find(t => t.id === 'trigger-disabled')).toBeUndefined();
    });
  });

  describe('unregisterTrigger', () => {
    it('should remove a registered trigger', async () => {
      const trigger: TriggerConfig = {
        id: 'trigger-1',
        name: 'Test Trigger',
        enabled: true,
        type: 'device-state-change',
        condition: { deviceId: 'device-1' },
        action: { type: 'notification' },
      };

      await engine.registerTrigger(trigger);
      expect(engine.hasTrigger('trigger-1')).toBe(true);

      engine.unregisterTrigger('trigger-1');
      expect(engine.hasTrigger('trigger-1')).toBe(false);
    });

    it('should return false when unregistering non-existent trigger', () => {
      const result = engine.unregisterTrigger('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('evaluateEvent', () => {
    it('should trigger action when condition matches', async () => {
      const trigger: TriggerConfig = {
        id: 'trigger-1',
        name: 'High Temperature',
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
          deviceId: 'device-2',
          command: 'turnOn',
        },
      };

      await engine.registerTrigger(trigger);

      const event: TriggerEvent = {
        type: 'device-state-change',
        source: 'device-1',
        timestamp: new Date(),
        data: {
          temperature: 35,
        },
      };

      const results = await engine.evaluateEvent(event);

      expect(results.length).toBe(1);
      expect(results[0].triggered).toBe(true);
      expect(results[0].triggerId).toBe('trigger-1');
      expect(executedActions.length).toBe(1);
      expect(executedActions[0].command).toBe('turnOn');
    });

    it('should not trigger action when condition does not match', async () => {
      const trigger: TriggerConfig = {
        id: 'trigger-1',
        name: 'High Temperature',
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
          deviceId: 'device-2',
          command: 'turnOn',
        },
      };

      await engine.registerTrigger(trigger);

      const event: TriggerEvent = {
        type: 'device-state-change',
        source: 'device-1',
        timestamp: new Date(),
        data: {
          temperature: 25, // Below threshold
        },
      };

      const results = await engine.evaluateEvent(event);

      expect(results.length).toBe(0);
      expect(executedActions.length).toBe(0);
    });

    it('should not trigger for events from different device', async () => {
      const trigger: TriggerConfig = {
        id: 'trigger-1',
        name: 'Device 1 Monitor',
        enabled: true,
        type: 'device-state-change',
        condition: {
          deviceId: 'device-1',
        },
        action: { type: 'notification' },
      };

      await engine.registerTrigger(trigger);

      const event: TriggerEvent = {
        type: 'device-state-change',
        source: 'device-2', // Different device
        timestamp: new Date(),
        data: {},
      };

      const results = await engine.evaluateEvent(event);

      expect(results.length).toBe(0);
    });
  });

  describe('evaluateCondition', () => {
    it('should evaluate greater than operator correctly', () => {
      const condition: ConfigTriggerCondition = {
        parameter: 'temperature',
        operator: '>',
        value: 30,
      };

      const data = { temperature: 35 };

      expect(engine.evaluateCondition(condition, data)).toBe(true);

      const dataBelow = { temperature: 25 };
      expect(engine.evaluateCondition(condition, dataBelow)).toBe(false);
    });

    it('should evaluate less than operator correctly', () => {
      const condition: ConfigTriggerCondition = {
        parameter: 'humidity',
        operator: '<',
        value: 20,
      };

      expect(engine.evaluateCondition(condition, { humidity: 15 })).toBe(true);
      expect(engine.evaluateCondition(condition, { humidity: 25 })).toBe(false);
    });

    it('should evaluate equality operator correctly', () => {
      const condition: ConfigTriggerCondition = {
        parameter: 'status',
        operator: '==',
        value: 'active',
      };

      expect(engine.evaluateCondition(condition, { status: 'active' })).toBe(true);
      expect(engine.evaluateCondition(condition, { status: 'inactive' })).toBe(false);
    });

    it('should evaluate not equal operator correctly', () => {
      const condition: ConfigTriggerCondition = {
        parameter: 'status',
        operator: '!=',
        value: 'offline',
      };

      expect(engine.evaluateCondition(condition, { status: 'online' })).toBe(true);
      expect(engine.evaluateCondition(condition, { status: 'offline' })).toBe(false);
    });

    it('should evaluate greater than or equal operator correctly', () => {
      const condition: ConfigTriggerCondition = {
        parameter: 'pressure',
        operator: '>=',
        value: 100,
      };

      expect(engine.evaluateCondition(condition, { pressure: 100 })).toBe(true);
      expect(engine.evaluateCondition(condition, { pressure: 101 })).toBe(true);
      expect(engine.evaluateCondition(condition, { pressure: 99 })).toBe(false);
    });

    it('should evaluate less than or equal operator correctly', () => {
      const condition: ConfigTriggerCondition = {
        parameter: 'pressure',
        operator: '<=',
        value: 100,
      };

      expect(engine.evaluateCondition(condition, { pressure: 100 })).toBe(true);
      expect(engine.evaluateCondition(condition, { pressure: 99 })).toBe(true);
      expect(engine.evaluateCondition(condition, { pressure: 101 })).toBe(false);
    });

    it('should evaluate contains operator correctly', () => {
      const condition: ConfigTriggerCondition = {
        parameter: 'message',
        operator: 'contains',
        value: 'error',
      };

      expect(engine.evaluateCondition(condition, { message: 'system error detected' })).toBe(true);
      expect(engine.evaluateCondition(condition, { message: 'all ok' })).toBe(false);
    });

    it('should evaluate in operator correctly', () => {
      const condition: ConfigTriggerCondition = {
        parameter: 'level',
        operator: 'in',
        value: ['high', 'critical'],
      };

      expect(engine.evaluateCondition(condition, { level: 'high' })).toBe(true);
      expect(engine.evaluateCondition(condition, { level: 'critical' })).toBe(true);
      expect(engine.evaluateCondition(condition, { level: 'low' })).toBe(false);
    });

    it('should return false when parameter is missing', () => {
      const condition: ConfigTriggerCondition = {
        parameter: 'temperature',
        operator: '>',
        value: 30,
      };

      expect(engine.evaluateCondition(condition, {})).toBe(false);
      expect(engine.evaluateCondition(condition, { humidity: 50 })).toBe(false);
    });
  });

  describe('cooldown mechanism', () => {
    it('should respect cooldown period and not re-trigger', async () => {
      vi.useFakeTimers();

      const trigger: TriggerConfig = {
        id: 'trigger-1',
        name: 'Cooldown Test',
        enabled: true,
        type: 'threshold-crossed',
        condition: {
          deviceId: 'device-1',
          parameter: 'temperature',
          operator: '>',
          value: 30,
        },
        action: { type: 'notification' },
        cooldownMs: 5000, // 5 second cooldown
      };

      await engine.registerTrigger(trigger);

      const event: TriggerEvent = {
        type: 'device-state-change',
        source: 'device-1',
        timestamp: new Date(),
        data: { temperature: 35 },
      };

      // First trigger
      await engine.evaluateEvent(event);
      expect(executedActions.length).toBe(1);

      // Immediate re-trigger should be blocked by cooldown
      await engine.evaluateEvent(event);
      expect(executedActions.length).toBe(1); // Still 1

      // Advance time past cooldown
      vi.advanceTimersByTime(5001);

      // Should trigger again now
      await engine.evaluateEvent(event);
      expect(executedActions.length).toBe(2);
    });
  });

  describe('maxExecutions limit', () => {
    it('should stop triggering after max executions reached', async () => {
      const trigger: TriggerConfig = {
        id: 'trigger-1',
        name: 'Limited Trigger',
        enabled: true,
        type: 'device-state-change',
        condition: {
          deviceId: 'device-1',
          parameter: 'value',
          operator: '>',
          value: 10,
        },
        action: { type: 'notification' },
        maxExecutions: 3,
      };

      await engine.registerTrigger(trigger);

      const event: TriggerEvent = {
        type: 'device-state-change',
        source: 'device-1',
        timestamp: new Date(),
        data: { value: 20 },
      };

      // Should trigger 3 times
      for (let i = 0; i < 5; i++) {
        await engine.evaluateEvent(event);
      }

      expect(executedActions.length).toBe(3);
    });
  });

  describe('enableTrigger / disableTrigger', () => {
    it('should toggle trigger enabled state', async () => {
      const trigger: TriggerConfig = {
        id: 'trigger-1',
        name: 'Toggle Test',
        enabled: true,
        type: 'device-state-change',
        condition: { deviceId: 'device-1' },
        action: { type: 'notification' },
      };

      await engine.registerTrigger(trigger);
      expect(engine.isTriggerEnabled('trigger-1')).toBe(true);

      engine.disableTrigger('trigger-1');
      expect(engine.isTriggerEnabled('trigger-1')).toBe(false);

      engine.enableTrigger('trigger-1');
      expect(engine.isTriggerEnabled('trigger-1')).toBe(true);
    });

    it('disabled trigger should not evaluate', async () => {
      const trigger: TriggerConfig = {
        id: 'trigger-1',
        name: 'Toggle Test',
        enabled: true,
        type: 'device-state-change',
        condition: {
          deviceId: 'device-1',
          parameter: 'value',
          operator: '>',
          value: 10,
        },
        action: { type: 'notification' },
      };

      await engine.registerTrigger(trigger);
      engine.disableTrigger('trigger-1');

      const event: TriggerEvent = {
        type: 'device-state-change',
        source: 'device-1',
        timestamp: new Date(),
        data: { value: 20 },
      };

      const results = await engine.evaluateEvent(event);
      expect(results.length).toBe(0);
    });
  });

  describe('getTriggerStats', () => {
    it('should return execution statistics for a trigger', async () => {
      const trigger: TriggerConfig = {
        id: 'trigger-1',
        name: 'Stats Test',
        enabled: true,
        type: 'device-state-change',
        condition: {
          deviceId: 'device-1',
          parameter: 'value',
          operator: '>',
          value: 10,
        },
        action: { type: 'notification' },
      };

      await engine.registerTrigger(trigger);

      const matchingEvent: TriggerEvent = {
        type: 'device-state-change',
        source: 'device-1',
        timestamp: new Date(),
        data: { value: 20 },
      };

      const nonMatchingEvent: TriggerEvent = {
        type: 'device-state-change',
        source: 'device-1',
        timestamp: new Date(),
        data: { value: 5 },
      };

      await engine.evaluateEvent(matchingEvent);
      await engine.evaluateEvent(nonMatchingEvent);
      await engine.evaluateEvent(matchingEvent);

      const stats = engine.getTriggerStats('trigger-1');

      expect(stats.totalEvaluations).toBe(3);
      expect(stats.successfulTriggers).toBe(2);
      expect(stats.failedTriggers).toBe(0);
    });
  });

  describe('multiple triggers', () => {
    it('should evaluate all matching triggers for an event', async () => {
      const triggers: TriggerConfig[] = [
        {
          id: 'trigger-1',
          name: 'Temperature High',
          enabled: true,
          type: 'threshold-crossed',
          condition: {
            deviceId: 'device-1',
            parameter: 'temperature',
            operator: '>',
            value: 30,
          },
          action: { type: 'notification', description: 'High temp alert' },
        },
        {
          id: 'trigger-2',
          name: 'Temperature Critical',
          enabled: true,
          type: 'threshold-crossed',
          condition: {
            deviceId: 'device-1',
            parameter: 'temperature',
            operator: '>',
            value: 40,
          },
          action: { type: 'notification', description: 'Critical temp alert' },
        },
      ];

      for (const t of triggers) {
        await engine.registerTrigger(t);
      }

      const event: TriggerEvent = {
        type: 'device-state-change',
        source: 'device-1',
        timestamp: new Date(),
        data: { temperature: 45 }, // Matches both triggers
      };

      const results = await engine.evaluateEvent(event);

      expect(results.length).toBe(2);
      expect(executedActions.length).toBe(2);
    });
  });

  describe('clearAllTriggers', () => {
    it('should remove all registered triggers', async () => {
      const triggers: TriggerConfig[] = [
        {
          id: 'trigger-1',
          name: 'Trigger 1',
          enabled: true,
          type: 'device-state-change',
          condition: { deviceId: 'device-1' },
          action: { type: 'notification' },
        },
        {
          id: 'trigger-2',
          name: 'Trigger 2',
          enabled: true,
          type: 'device-state-change',
          condition: { deviceId: 'device-2' },
          action: { type: 'notification' },
        },
      ];

      for (const t of triggers) {
        await engine.registerTrigger(t);
      }
      expect(engine.getActiveTriggers().length).toBe(2);

      engine.clearAllTriggers();
      expect(engine.getActiveTriggers().length).toBe(0);
    });
  });
});
