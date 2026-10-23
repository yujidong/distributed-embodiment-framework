/**
 * ScheduledTaskRunner Unit Tests (TDD)
 *
 * Tests for scheduled task execution and management.
 * These tests are written BEFORE implementation following TDD principles.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ScheduledTaskRunner, type ScheduledTaskResult, type TaskStats } from '../ScheduledTaskRunner.js';
import type { ScheduledCheckConfig, TriggerAction } from '../../config/types.js';

describe('ScheduledTaskRunner', () => {
  let runner: ScheduledTaskRunner;
  let executedTasks: { task: string; context: any }[];

  beforeEach(() => {
    runner = new ScheduledTaskRunner();
    executedTasks = [];

    // Set up task executor mock
    runner.setTaskExecutor(async (task: string, context: any) => {
      executedTasks.push({ task, context });
      return { success: true, result: `Executed: ${task}` };
    });
  });

  afterEach(() => {
    runner.stopAll();
    vi.useRealTimers();
  });

  describe('scheduleTask', () => {
    it('should schedule a task with interval', () => {
      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Periodic Check',
        enabled: true,
        interval: 60000, // 1 minute
        task: 'checkDeviceStatus',
      };

      expect(() => runner.scheduleTask(config)).not.toThrow();
      expect(runner.hasTask('task-1')).toBe(true);
    });

    it('should throw error when scheduling task with duplicate id', () => {
      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Task 1',
        enabled: true,
        interval: 60000,
        task: 'checkDeviceStatus',
      };

      runner.scheduleTask(config);

      const duplicateConfig: ScheduledCheckConfig = {
        ...config,
        name: 'Duplicate Task',
      };

      expect(() => runner.scheduleTask(duplicateConfig)).toThrow(/already exists/);
    });

    it('should schedule task with cron expression', () => {
      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Daily Report',
        enabled: true,
        cron: '0 9 * * *', // Every day at 9 AM
        task: 'generateDailyReport',
      };

      expect(() => runner.scheduleTask(config)).not.toThrow();
      expect(runner.hasTask('task-1')).toBe(true);
    });

    it('should not start disabled task', () => {
      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Disabled Task',
        enabled: false,
        interval: 60000,
        task: 'checkDeviceStatus',
      };

      runner.scheduleTask(config);

      // Task exists but should not be running
      expect(runner.hasTask('task-1')).toBe(true);
      expect(runner.isTaskRunning('task-1')).toBe(false);
    });
  });

  describe('cancelTask', () => {
    it('should cancel a scheduled task', () => {
      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Test Task',
        enabled: true,
        interval: 60000,
        task: 'checkDeviceStatus',
      };

      runner.scheduleTask(config);
      expect(runner.hasTask('task-1')).toBe(true);

      runner.cancelTask('task-1');
      expect(runner.hasTask('task-1')).toBe(false);
    });

    it('should return false when canceling non-existent task', () => {
      const result = runner.cancelTask('non-existent');
      expect(result).toBe(false);
    });

    it('should stop running interval when canceled', async () => {
      vi.useFakeTimers();

      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Test Task',
        enabled: true,
        interval: 1000,
        task: 'checkDeviceStatus',
      };

      runner.scheduleTask(config);

      // Let it run once
      await vi.advanceTimersByTimeAsync(1000);
      expect(executedTasks.length).toBe(1);

      // Cancel the task
      runner.cancelTask('task-1');

      // Advance more time - should not execute again
      await vi.advanceTimersByTimeAsync(5000);
      expect(executedTasks.length).toBe(1); // Still 1, not 6
    });
  });

  describe('interval execution', () => {
    it('should execute task at specified interval', async () => {
      vi.useFakeTimers();

      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Periodic Task',
        enabled: true,
        interval: 1000, // 1 second
        task: 'periodicCheck',
      };

      runner.scheduleTask(config);

      // Initially no executions
      expect(executedTasks.length).toBe(0);

      // After 1 second
      await vi.advanceTimersByTimeAsync(1000);
      expect(executedTasks.length).toBe(1);

      // After 2 seconds
      await vi.advanceTimersByTimeAsync(1000);
      expect(executedTasks.length).toBe(2);

      // After 3 seconds
      await vi.advanceTimersByTimeAsync(1000);
      expect(executedTasks.length).toBe(3);
    });

    it('should not execute disabled task even when scheduled', async () => {
      vi.useFakeTimers();

      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Disabled Task',
        enabled: false,
        interval: 1000,
        task: 'checkDeviceStatus',
      };

      runner.scheduleTask(config);

      await vi.advanceTimersByTimeAsync(5000);
      expect(executedTasks.length).toBe(0);
    });
  });

  describe('executeNow', () => {
    it('should execute task immediately regardless of schedule', async () => {
      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Test Task',
        enabled: true,
        interval: 60000, // 1 minute
        task: 'checkDeviceStatus',
      };

      runner.scheduleTask(config);

      // Execute immediately without waiting for interval
      const result = await runner.executeNow('task-1');

      expect(result.success).toBe(true);
      expect(executedTasks.length).toBe(1);
      expect(executedTasks[0].task).toBe('checkDeviceStatus');
    });

    it('should throw error for non-existent task', async () => {
      await expect(runner.executeNow('non-existent')).rejects.toThrow(/not found/);
    });
  });

  describe('enableTask / disableTask', () => {
    it('should toggle task enabled state', () => {
      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Test Task',
        enabled: true,
        interval: 60000,
        task: 'checkDeviceStatus',
      };

      runner.scheduleTask(config);
      expect(runner.isTaskEnabled('task-1')).toBe(true);

      runner.disableTask('task-1');
      expect(runner.isTaskEnabled('task-1')).toBe(false);

      runner.enableTask('task-1');
      expect(runner.isTaskEnabled('task-1')).toBe(true);
    });

    it('should stop interval when task is disabled', async () => {
      vi.useFakeTimers();

      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Test Task',
        enabled: true,
        interval: 1000,
        task: 'checkDeviceStatus',
      };

      runner.scheduleTask(config);

      // Let it run once
      await vi.advanceTimersByTimeAsync(1000);
      expect(executedTasks.length).toBe(1);

      // Disable the task
      runner.disableTask('task-1');

      // Advance more time - should not execute again
      await vi.advanceTimersByTimeAsync(5000);
      expect(executedTasks.length).toBe(1);
    });

    it('should start interval when task is enabled', async () => {
      vi.useFakeTimers();

      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Test Task',
        enabled: false,
        interval: 1000,
        task: 'checkDeviceStatus',
      };

      runner.scheduleTask(config);

      // Should not run while disabled
      await vi.advanceTimersByTimeAsync(3000);
      expect(executedTasks.length).toBe(0);

      // Enable the task
      runner.enableTask('task-1');

      // Now it should start running
      await vi.advanceTimersByTimeAsync(1000);
      expect(executedTasks.length).toBe(1);
    });
  });

  describe('getTaskStats', () => {
    it('should return statistics for a task', async () => {
      vi.useFakeTimers();

      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Test Task',
        enabled: true,
        interval: 1000,
        task: 'checkDeviceStatus',
      };

      runner.scheduleTask(config);

      // Execute 3 times
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      const stats = runner.getTaskStats('task-1');

      expect(stats.executionCount).toBe(3);
      expect(stats.successCount).toBe(3);
      expect(stats.failureCount).toBe(0);
      expect(stats.lastExecutionTime).toBeDefined();
    });

    it('should track failed executions', async () => {
      // Override executor to fail
      runner.setTaskExecutor(async (task: string, context: any) => {
        throw new Error('Task failed');
      });

      vi.useFakeTimers();

      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Test Task',
        enabled: true,
        interval: 1000,
        task: 'checkDeviceStatus',
      };

      runner.scheduleTask(config);

      await vi.advanceTimersByTimeAsync(1000);

      const stats = runner.getTaskStats('task-1');

      expect(stats.executionCount).toBe(1);
      expect(stats.successCount).toBe(0);
      expect(stats.failureCount).toBe(1);
      expect(stats.lastError).toBe('Task failed');
    });
  });

  describe('getActiveTasks', () => {
    it('should return all enabled tasks', () => {
      const config1: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Task 1',
        enabled: true,
        interval: 60000,
        task: 'task1',
      };

      const config2: ScheduledCheckConfig = {
        id: 'task-2',
        name: 'Task 2',
        enabled: false,
        interval: 60000,
        task: 'task2',
      };

      const config3: ScheduledCheckConfig = {
        id: 'task-3',
        name: 'Task 3',
        enabled: true,
        interval: 60000,
        task: 'task3',
      };

      runner.scheduleTask(config1);
      runner.scheduleTask(config2);
      runner.scheduleTask(config3);

      const activeTasks = runner.getActiveTasks();

      expect(activeTasks.length).toBe(2);
      expect(activeTasks.find(t => t.id === 'task-1')).toBeDefined();
      expect(activeTasks.find(t => t.id === 'task-3')).toBeDefined();
    });
  });

  describe('stopAll', () => {
    it('should stop all scheduled tasks', async () => {
      vi.useFakeTimers();

      const config1: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Task 1',
        enabled: true,
        interval: 1000,
        task: 'task1',
      };

      const config2: ScheduledCheckConfig = {
        id: 'task-2',
        name: 'Task 2',
        enabled: true,
        interval: 2000,
        task: 'task2',
      };

      runner.scheduleTask(config1);
      runner.scheduleTask(config2);

      // Let them run a bit
      await vi.advanceTimersByTimeAsync(2000);

      // Stop all
      runner.stopAll();

      // Advance more time - should not execute
      await vi.advanceTimersByTimeAsync(5000);

      // Count should be same as before stopAll
      const countAfterRun = executedTasks.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(executedTasks.length).toBe(countAfterRun);
    });
  });

  describe('condition checking', () => {
    it('should execute task only when condition is met', async () => {
      vi.useFakeTimers();

      let conditionMet = false;

      // Set up context provider
      runner.setContextProvider(async () => ({
        timestamp: new Date(),
        deviceState: { temperature: conditionMet ? 35 : 25 },
      }));

      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Conditional Task',
        enabled: true,
        interval: 1000,
        task: 'checkTemperature',
        condition: {
          parameter: 'deviceState.temperature',
          operator: '>',
          value: 30,
        },
      };

      runner.scheduleTask(config);

      // First execution - condition not met
      await vi.advanceTimersByTimeAsync(1000);
      expect(executedTasks.length).toBe(0);

      // Change condition to be met
      conditionMet = true;

      // Second execution - condition met
      await vi.advanceTimersByTimeAsync(1000);
      expect(executedTasks.length).toBe(1);
    });
  });

  describe('task context', () => {
    it('should pass context to task executor', async () => {
      vi.useFakeTimers();

      // Set up context provider
      runner.setContextProvider(async () => ({
        agentId: 'agent-1',
        environmentId: 'env-1',
        timestamp: new Date(),
      }));

      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Test Task',
        enabled: true,
        interval: 1000,
        task: 'checkDeviceStatus',
      };

      runner.scheduleTask(config);

      await vi.advanceTimersByTimeAsync(1000);

      expect(executedTasks.length).toBe(1);
      expect(executedTasks[0].context.agentId).toBe('agent-1');
      expect(executedTasks[0].context.environmentId).toBe('env-1');
    });
  });

  describe('getNextExecutionTime', () => {
    it('should return next execution time for interval task', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Test Task',
        enabled: true,
        interval: 60000,
        task: 'checkDeviceStatus',
      };

      runner.scheduleTask(config);

      const nextTime = runner.getNextExecutionTime('task-1');

      expect(nextTime).toBeDefined();
      expect(nextTime!.getTime()).toBe(now + 60000);
    });

    it('should return undefined for disabled task', () => {
      const config: ScheduledCheckConfig = {
        id: 'task-1',
        name: 'Disabled Task',
        enabled: false,
        interval: 60000,
        task: 'checkDeviceStatus',
      };

      runner.scheduleTask(config);

      const nextTime = runner.getNextExecutionTime('task-1');

      expect(nextTime).toBeUndefined();
    });
  });
});
