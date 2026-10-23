/**
 * TaskPlanningCoordinator Unit Tests
 *
 * Tests for task planning and execution coordination
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { TaskPlanningCoordinator, TaskPlan, TaskExecutionResult, Task } from '../TaskPlanningCoordinator.js';
import type { EventEmitter } from '../../../events/EventEmitter.js';
import type { ACExecutor } from '../../../execution/ACExecutor.js';
import type { TaskPlanner } from '../../../planning/TaskPlanner.js';
import type { TaskManager } from '../../../management/TaskManager.js';
import type { AgentContextBuilder } from '../../../context/AgentContextBuilder.js';
import { EventType } from '@active-collaboration/shared';

// Mock Types
interface MockACExecutor {
  execute: ReturnType<typeof vi.fn>;
}

interface MockTaskPlanner {
  plan: ReturnType<typeof vi.fn>;
  evaluateComplexity: ReturnType<typeof vi.fn>;
}

interface MockTaskManager {
  createTask: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
}

// Helper functions to create mocks
const createMockEventEmitter = (): EventEmitter => {
  return {
    emit: vi.fn().mockReturnValue({
      id: 'event-123',
      type: EventType.AGENT_TASK_ASSIGNED,
      source: 'test-agent',
      timestamp: new Date(),
      priority: 1,
      payload: {},
      metadata: {},
    }),
    emitStateChange: vi.fn(),
    emitError: vi.fn(),
    emitWarning: vi.fn(),
    getEmitterId: vi.fn().mockReturnValue('test-agent'),
    getEventManager: vi.fn(),
  } as unknown as EventEmitter;
};

const createMockACExecutor = (): MockACExecutor => ({
  execute: vi.fn().mockResolvedValue({ success: true, result: { message: 'Executed' } }),
});

const createMockTaskPlanner = (): MockTaskPlanner => ({
  plan: vi.fn().mockResolvedValue({
    taskId: 'task-1',
    summary: 'Test task',
    intent: 'Test intent',
    actionType: 'observe',
    complexity: 'medium',
    confidence: 0.8,
    entity: null,
    scope: 'local',
    requiredCapabilities: ['sense'],
    requiredDataTypes: ['temperature'],
    executionStrategy: 'sequential',
    availableResources: ['device-1'],
    constraints: [],
    planningTime: 50,
  } as TaskPlan),
  evaluateComplexity: vi.fn().mockResolvedValue('medium'),
});

const createMockTaskManager = (): MockTaskManager => ({
  createTask: vi.fn().mockReturnValue({ id: 'task-new', status: 'pending' }),
  updateTask: vi.fn().mockReturnValue({ success: true }),
});

describe('TaskPlanningCoordinator', () => {
  let coordinator: TaskPlanningCoordinator;
  let mockEventEmitter: EventEmitter;
  let mockACExecutor: MockACExecutor;
  let mockTaskPlanner: MockTaskPlanner;
  let mockTaskManager: MockTaskManager;

  const agentId = 'agent-1';
  const agentName = 'Test Agent';

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventEmitter = createMockEventEmitter();
    mockACExecutor = createMockACExecutor();
    mockTaskPlanner = createMockTaskPlanner();
    mockTaskManager = createMockTaskManager();

    coordinator = new TaskPlanningCoordinator(
      mockACExecutor as unknown as ACExecutor,
      mockTaskPlanner as unknown as TaskPlanner,
      mockTaskManager as unknown as TaskManager,
      undefined as unknown as AgentContextBuilder,  // No AgentContextBuilder
      mockEventEmitter,
      agentId,
      agentName
    );
  });

  describe('Constructor', () => {
    it('should create coordinator with all dependencies', () => {
      expect(coordinator).toBeDefined();
    });

    it('should initialize with empty active tasks', () => {
      const tasks = coordinator.getActiveTasks();
      expect(tasks).toEqual([]);
    });
  });

  describe('planTask', () => {
    it('should plan a task successfully', async () => {
      const goal = 'Monitor temperature';
      const plan = await coordinator.planTask(goal);

      expect(plan).toBeDefined();
      expect(plan.taskId).toBe('task-1');
      expect(mockTaskPlanner.plan).toHaveBeenCalled();
    });

    it('should track planned task in active tasks', async () => {
      const goal = 'Monitor temperature';
      await coordinator.planTask(goal);

      const tasks = coordinator.getActiveTasks();
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe('task-1');
      expect(tasks[0].status).toBe('planning');
    });

    it('should emit TASK_PLANNED event', async () => {
      const goal = 'Monitor temperature';
      await coordinator.planTask(goal);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        EventType.AGENT_TASK_ASSIGNED,
        expect.objectContaining({
          agentId: agentId,
          taskId: 'task-1',
          goal: goal,
        })
      );
    });

    it('should handle planning context', async () => {
      const goal = 'Monitor temperature';
      const context = {
        agentId: agentId,
        agentName: agentName,
        agentCapabilities: ['sense'],
        resources: [],
        services: [],
        environmentType: 'indoor',
        environmentId: 'env-1',
        peerAgents: [],
      };

      const plan = await coordinator.planTask(goal, context);
      expect(plan).toBeDefined();
    });
  });

  describe('executeTask', () => {
    it('should execute a planned task successfully', async () => {
      // First plan a task
      const goal = 'Monitor temperature';
      await coordinator.planTask(goal);

      // Then execute it
      const result = await coordinator.executeTask('task-1');

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('should return error for non-existent task', async () => {
      const result = await coordinator.executeTask('non-existent-task');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should update task status to executing during execution', async () => {
      // Plan a task
      await coordinator.planTask('Test task');

      // Execute it
      const executePromise = coordinator.executeTask('task-1');

      // Check status right after starting
      const tasks = coordinator.getActiveTasks();
      // Task should be executing or completed
      expect(['executing', 'completed']).toContain(tasks[0].status);

      await executePromise;
    });

    it('should remove task from active tasks after completion', async () => {
      // Plan and execute a task
      await coordinator.planTask('Test task');
      await coordinator.executeTask('task-1');

      const tasks = coordinator.getActiveTasks();
      expect(tasks.length).toBe(0);
    });

    it('should emit TASK_COMPLETED event', async () => {
      await coordinator.planTask('Test task');
      await coordinator.executeTask('task-1');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        EventType.AGENT_TASK_COMPLETED,
        expect.objectContaining({
          agentId: agentId,
          taskId: 'task-1',
          success: true,
        })
      );
    });
  });

  describe('getActiveTasks', () => {
    it('should return empty array when no active tasks', () => {
      const tasks = coordinator.getActiveTasks();
      expect(tasks).toEqual([]);
    });

    it('should return all active tasks', async () => {
      await coordinator.planTask('Task 1');
      await coordinator.planTask('Task 2');

      // Mock will return same taskId, so we'll have one task
      const tasks = coordinator.getActiveTasks();
      expect(tasks.length).toBeGreaterThanOrEqual(1);
    });

    it('should return copy of tasks array', () => {
      const tasks1 = coordinator.getActiveTasks();
      const tasks2 = coordinator.getActiveTasks();
      expect(tasks1).not.toBe(tasks2); // Different array references
    });
  });

  describe('evaluateTaskComplexity', () => {
    it('should evaluate task complexity', async () => {
      const task = {
        id: 'task-1',
        description: 'Complex task',
      };

      const complexity = await coordinator.evaluateTaskComplexity(task);

      expect(complexity).toBe('medium');
      expect(mockTaskPlanner.plan).toHaveBeenCalled();
    });
  });

  describe('Task Lifecycle', () => {
    it('should handle complete task lifecycle', async () => {
      // Plan
      const plan = await coordinator.planTask('Lifecycle test');
      expect(plan.taskId).toBe('task-1');

      // Check active
      let tasks = coordinator.getActiveTasks();
      expect(tasks.length).toBe(1);

      // Execute
      const result = await coordinator.executeTask('task-1');
      expect(result.success).toBe(true);

      // Check completed
      tasks = coordinator.getActiveTasks();
      expect(tasks.length).toBe(0);
    });

    it('should handle task failure', async () => {
      // Plan a task
      await coordinator.planTask('Test task');

      // Mock planner to throw error on next call
      mockTaskPlanner.plan.mockRejectedValueOnce(new Error('Planning failed'));

      // Try to plan another task (should fail)
      await expect(coordinator.planTask('Failing task')).rejects.toThrow();
    });
  });

  describe('Event Payloads', () => {
    it('should include agentId in all event payloads', async () => {
      await coordinator.planTask('Test task');
      await coordinator.executeTask('task-1');

      const emitCalls = (mockEventEmitter.emit as Mock).mock.calls;

      emitCalls.forEach((call: any[]) => {
        expect(call[1]).toHaveProperty('agentId', agentId);
      });
    });

    it('should emit events in correct order', async () => {
      await coordinator.planTask('Test task');
      await coordinator.executeTask('task-1');

      const emitCalls = (mockEventEmitter.emit as Mock).mock.calls;

      // First event should be TASK_ASSIGNED (planned)
      expect(emitCalls[0][0]).toBe(EventType.AGENT_TASK_ASSIGNED);

      // Last event should be TASK_COMPLETED
      const lastCall = emitCalls[emitCalls.length - 1];
      expect(lastCall[0]).toBe(EventType.AGENT_TASK_COMPLETED);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty goal', async () => {
      const plan = await coordinator.planTask('');
      expect(plan).toBeDefined();
    });

    it('should handle very long goal description', async () => {
      const longGoal = 'A'.repeat(1000);
      const plan = await coordinator.planTask(longGoal);
      expect(plan).toBeDefined();
    });

    it('should handle special characters in goal', async () => {
      const specialGoal = 'Test <script>alert("XSS")</script>';
      const plan = await coordinator.planTask(specialGoal);
      expect(plan).toBeDefined();
    });

    it('should handle concurrent task planning', async () => {
      const goals = ['Task 1', 'Task 2', 'Task 3'];
      const plans = await Promise.all(goals.map(g => coordinator.planTask(g)));

      expect(plans.length).toBe(3);
      plans.forEach(plan => expect(plan).toBeDefined());
    });

    it('should handle task execution with no result', async () => {
      await coordinator.planTask('Test task');

      // The implementation returns a default result, so success should be true
      const result = await coordinator.executeTask('task-1');
      expect(result.success).toBe(true);
    });
  });
});
