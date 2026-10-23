/**
 * Unit Tests for PeriodicBehavior
 *
 * Tests both factory function and timer-based periodic execution
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPeriodicBehavior, PeriodicBehaviorConfig } from './PeriodicBehavior';

describe('createPeriodicBehavior', () => {
  describe('Factory Function', () => {
    it('should create periodic behavior config with correct type', () => {
      const action = vi.fn();
      const config = createPeriodicBehavior(1000, action);

      expect(config).toBeDefined();
      expect(config.type).toBe('periodic');
    });

    it('should store interval as provided', () => {
      const action = vi.fn();
      const config = createPeriodicBehavior(5000, action);

      expect((config as PeriodicBehaviorConfig).interval).toBe(5000);
    });

    it('should store action reference', () => {
      const action = vi.fn();
      const config = createPeriodicBehavior(1000, action);

      expect((config as PeriodicBehaviorConfig).action).toBe(action);
    });

    it('should create configs with different intervals independently', () => {
      const action1 = vi.fn();
      const action2 = vi.fn();

      const config1 = createPeriodicBehavior(1000, action1);
      const config2 = createPeriodicBehavior(5000, action2);

      expect((config1 as PeriodicBehaviorConfig).interval).toBe(1000);
      expect((config2 as PeriodicBehaviorConfig).interval).toBe(5000);
      expect((config1 as PeriodicBehaviorConfig).action).toBe(action1);
      expect((config2 as PeriodicBehaviorConfig).action).toBe(action2);
    });
  });

  describe('Action Execution', () => {
    it('should execute action when called directly', async () => {
      const action = vi.fn().mockResolvedValue('result');
      const config = createPeriodicBehavior(1000, action);

      const periodicConfig = config as PeriodicBehaviorConfig;
      await periodicConfig.action();

      expect(action).toHaveBeenCalledTimes(1);
    });

    it('should support synchronous actions', () => {
      const action = vi.fn();
      const config = createPeriodicBehavior(1000, action);

      const periodicConfig = config as PeriodicBehaviorConfig;
      periodicConfig.action();

      expect(action).toHaveBeenCalledTimes(1);
    });

    it('should support asynchronous actions', async () => {
      const action = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      const config = createPeriodicBehavior(1000, action);

      const periodicConfig = config as PeriodicBehaviorConfig;
      await periodicConfig.action();

      expect(action).toHaveBeenCalledTimes(1);
    });
  });

  describe('Timer-Based Execution', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should execute action once after one interval elapses', () => {
      const action = vi.fn();
      const interval = 1000;
      const config = createPeriodicBehavior(interval, action) as PeriodicBehaviorConfig;

      // Set up periodic execution using setInterval
      const timerId = setInterval(() => {
        config.action();
      }, interval);

      // Advance time by exactly one interval
      vi.advanceTimersByTime(1000);

      expect(action).toHaveBeenCalledTimes(1);

      clearInterval(timerId);
    });

    it('should execute action N times after N intervals elapse', () => {
      const action = vi.fn();
      const interval = 500;
      const config = createPeriodicBehavior(interval, action) as PeriodicBehaviorConfig;

      const timerId = setInterval(() => {
        config.action();
      }, interval);

      // Advance time by 5 intervals
      vi.advanceTimersByTime(2500);

      expect(action).toHaveBeenCalledTimes(5);

      clearInterval(timerId);
    });

    it('should not execute action before interval elapses', () => {
      const action = vi.fn();
      const interval = 1000;
      const config = createPeriodicBehavior(interval, action) as PeriodicBehaviorConfig;

      const timerId = setInterval(() => {
        config.action();
      }, interval);

      // Advance time by less than one interval
      vi.advanceTimersByTime(500);

      expect(action).not.toHaveBeenCalled();

      clearInterval(timerId);
    });

    it('should stop executing after clearInterval is called', () => {
      const action = vi.fn();
      const interval = 100;
      const config = createPeriodicBehavior(interval, action) as PeriodicBehaviorConfig;

      const timerId = setInterval(() => {
        config.action();
      }, interval);

      // Let it fire twice
      vi.advanceTimersByTime(200);
      expect(action).toHaveBeenCalledTimes(2);

      // Clear the interval
      clearInterval(timerId);

      // Advance more time - no additional calls should happen
      vi.advanceTimersByTime(1000);
      expect(action).toHaveBeenCalledTimes(2); // Still only 2
    });

    it('should handle rapid intervals correctly', () => {
      const action = vi.fn();
      const interval = 10;
      const config = createPeriodicBehavior(interval, action) as PeriodicBehaviorConfig;

      const timerId = setInterval(() => {
        config.action();
      }, interval);

      // Advance by 100ms with 10ms intervals => 10 calls
      vi.advanceTimersByTime(100);

      expect(action).toHaveBeenCalledTimes(10);

      clearInterval(timerId);
    });
  });

  describe('Async Timer-Based Execution', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should execute async action at each interval', async () => {
      let executionCount = 0;
      const action = vi.fn().mockImplementation(async () => {
        executionCount++;
      });
      const interval = 200;
      const config = createPeriodicBehavior(interval, action) as PeriodicBehaviorConfig;

      const timerId = setInterval(() => {
        config.action();
      }, interval);

      // Advance by 2 intervals
      vi.advanceTimersByTime(400);

      // The action was called synchronously by the timer, but the async
      // implementation increments executionCount on the next microtask.
      // We need to wait for the promises to resolve.
      await Promise.resolve();
      await Promise.resolve();

      expect(action).toHaveBeenCalledTimes(2);
      expect(executionCount).toBe(2);

      clearInterval(timerId);
    });

    it('should handle action that modifies external state', () => {
      const state = { counter: 0 };
      const action = () => { state.counter++; };
      const interval = 100;
      const config = createPeriodicBehavior(interval, action) as PeriodicBehaviorConfig;

      const timerId = setInterval(() => {
        config.action();
      }, interval);

      // Advance by 5 intervals
      vi.advanceTimersByTime(500);

      expect(state.counter).toBe(5);

      clearInterval(timerId);
    });

    it('should accumulate state changes across intervals', () => {
      const readings: number[] = [];
      const action = () => {
        readings.push(readings.length);
      };
      const interval = 100;
      const config = createPeriodicBehavior(interval, action) as PeriodicBehaviorConfig;

      const timerId = setInterval(() => {
        config.action();
      }, interval);

      // Advance by 3 intervals
      vi.advanceTimersByTime(300);

      expect(readings).toEqual([0, 1, 2]);

      clearInterval(timerId);
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero interval', () => {
      const action = vi.fn();
      const config = createPeriodicBehavior(0, action) as PeriodicBehaviorConfig;

      expect(config.interval).toBe(0);
      expect(config.action).toBe(action);
    });

    it('should handle very large interval', () => {
      const action = vi.fn();
      const config = createPeriodicBehavior(86400000, action) as PeriodicBehaviorConfig; // 24 hours

      expect(config.interval).toBe(86400000);
    });

    it('should handle action that throws without breaking interval', () => {
      vi.useFakeTimers();

      let callCount = 0;
      const action = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('First call fails');
        }
      });

      const interval = 100;
      const config = createPeriodicBehavior(interval, action) as PeriodicBehaviorConfig;

      const timerId = setInterval(() => {
        try {
          config.action();
        } catch {
          // Expected on first call
        }
      }, interval);

      // Advance by 3 intervals
      vi.advanceTimersByTime(300);

      // Action should have been called 3 times (even though first one threw)
      expect(action).toHaveBeenCalledTimes(3);
      expect(callCount).toBe(3);

      vi.useRealTimers();
      clearInterval(timerId);
    });
  });
});
