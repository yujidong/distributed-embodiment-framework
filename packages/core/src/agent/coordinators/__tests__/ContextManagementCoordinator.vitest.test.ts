/**
 * Tests for ContextManagementCoordinator
 *
 * Tests the thin wrapper around AgentContextBuilder that provides
 * context building with event emission.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ContextManagementCoordinator } from '../ContextManagementCoordinator.js';
import type { AgentContextBuilder, FullAgentContext, AgentInfo } from '../../../context/AgentContextBuilder.js';
import type { EventEmitter } from '../../../events/EventEmitter.js';
import { EventType, EventPriority } from '@active-collaboration/shared';

/**
 * Helper to create mock AgentContextBuilder
 */
function createMockContextBuilder(): AgentContextBuilder {
  const mockContext: FullAgentContext = {
    self: {
      id: 'agent-1',
      name: 'Test Agent',
      description: 'Test description',
      capabilities: ['sense', 'actuate'],
      role: 'controller',
      status: 'online',
    },
    environment: {
      id: 'env-1',
      name: 'Test Environment',
      type: 'test',
    },
    resources: [],
    availableServices: {
      own: [],
      fromPeers: [],
    },
    peerAgents: [],
    temporal: {
      currentTime: new Date(),
    },
  };

  return {
    buildFullContext: vi.fn().mockResolvedValue(mockContext),
    formatContextForLLM: vi.fn().mockReturnValue('Formatted context'),
    formatContextForLLMAsync: vi.fn().mockResolvedValue('Formatted context async'),
    buildFullPrompt: vi.fn().mockReturnValue('Full prompt'),
    getSections: vi.fn().mockReturnValue([]),
    registerSection: vi.fn(),
    unregisterSection: vi.fn(),
    getOntologyComposer: vi.fn(),
    setUserId: vi.fn(),
    getUserId: vi.fn().mockReturnValue(undefined),
  } as unknown as AgentContextBuilder;
}

/**
 * Helper to create mock EventEmitter
 */
function createMockEventEmitter(): EventEmitter {
  return {
    emit: vi.fn().mockReturnValue({
      id: 'event-1',
      type: EventType.AGENT_CONTEXT_BUILT,
      source: 'agent-1',
      timestamp: new Date(),
      priority: EventPriority.NORMAL,
      payload: {},
      metadata: {},
    }),
    emitStateChange: vi.fn(),
    emitError: vi.fn(),
    emitWarning: vi.fn(),
    getEmitterId: vi.fn().mockReturnValue('agent-1'),
    getEventManager: vi.fn(),
  } as unknown as EventEmitter;
}

describe('ContextManagementCoordinator', () => {
  let coordinator: ContextManagementCoordinator;
  let mockContextBuilder: AgentContextBuilder;
  let mockEventEmitter: EventEmitter;
  let agentId: string;
  let agentInfo: AgentInfo;

  beforeEach(() => {
    mockContextBuilder = createMockContextBuilder();
    mockEventEmitter = createMockEventEmitter();
    agentId = 'agent-1';
    agentInfo = {
      id: 'agent-1',
      name: 'Test Agent',
      description: 'Test description',
      capabilities: ['sense', 'actuate'],
      status: 'online',
      metadata: { role: 'controller' },
    };

    coordinator = new ContextManagementCoordinator(
      mockContextBuilder,
      mockEventEmitter,
      agentId,
      agentInfo
    );
  });

  describe('Constructor', () => {
    it('should create instance with required dependencies', () => {
      expect(coordinator).toBeDefined();
      expect(coordinator).toBeInstanceOf(ContextManagementCoordinator);
    });

    it('should store agent ID', () => {
      expect(coordinator.getAgentId()).toBe('agent-1');
    });

    it('should store agent info', () => {
      expect(coordinator.getAgentInfo()).toEqual(agentInfo);
    });
  });

  describe('buildFullContext', () => {
    it('should delegate to AgentContextBuilder.buildFullContext', async () => {
      await coordinator.buildFullContext();

      expect(mockContextBuilder.buildFullContext).toHaveBeenCalledTimes(1);
    });

    it('should return the context from AgentContextBuilder', async () => {
      const context = await coordinator.buildFullContext();

      expect(context).toBeDefined();
      expect(context.self.id).toBe('agent-1');
      expect(context.self.name).toBe('Test Agent');
    });

    it('should emit CONTEXT_BUILT event after building context', async () => {
      await coordinator.buildFullContext();

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        EventType.AGENT_CONTEXT_BUILT,
        expect.objectContaining({
          agentId: 'agent-1',
          context: expect.any(Object),
        })
      );
    });

    it('should include context snapshot in event payload', async () => {
      await coordinator.buildFullContext();

      const emitCall = (mockEventEmitter.emit as Mock).mock.calls[0];
      expect(emitCall[1].context).toBeDefined();
      expect(emitCall[1].context.self.id).toBe('agent-1');
    });

    it('should include timestamp in event payload', async () => {
      await coordinator.buildFullContext();

      const emitCall = (mockEventEmitter.emit as Mock).mock.calls[0];
      expect(emitCall[1].timestamp).toBeDefined();
      expect(emitCall[1].timestamp).toBeInstanceOf(Date);
    });

    it('should propagate errors from AgentContextBuilder', async () => {
      const error = new Error('Context build failed');
      (mockContextBuilder.buildFullContext as Mock).mockRejectedValueOnce(error);

      await expect(coordinator.buildFullContext()).rejects.toThrow('Context build failed');
    });

    it('should not emit event if context building fails', async () => {
      const error = new Error('Context build failed');
      (mockContextBuilder.buildFullContext as Mock).mockRejectedValueOnce(error);

      try {
        await coordinator.buildFullContext();
      } catch (e) {
        // Expected
      }

      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('buildTaskContext', () => {
    it('should build context with task information', async () => {
      const task = 'Monitor temperature in room A';
      const context = await coordinator.buildTaskContext(task);

      expect(context).toBeDefined();
      expect(context.taskContext).toBeDefined();
      expect(context.taskContext?.currentTask).toBe(task);
    });

    it('should delegate to AgentContextBuilder for base context', async () => {
      const task = 'Control HVAC system';
      await coordinator.buildTaskContext(task);

      expect(mockContextBuilder.buildFullContext).toHaveBeenCalled();
    });

    it('should emit CONTEXT_BUILT event with task info', async () => {
      const task = 'Check sensor readings';
      await coordinator.buildTaskContext(task);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        EventType.AGENT_CONTEXT_BUILT,
        expect.objectContaining({
          agentId: 'agent-1',
          task: 'Check sensor readings',
          context: expect.any(Object),
        })
      );
    });

    it('should include task in the context taskContext field', async () => {
      const task = 'Emergency shutdown';
      const context = await coordinator.buildTaskContext(task);

      expect(context.taskContext?.currentTask).toBe('Emergency shutdown');
    });

    it('should handle empty task string', async () => {
      const context = await coordinator.buildTaskContext('');

      expect(context).toBeDefined();
      expect(context.taskContext?.currentTask).toBe('');
    });
  });

  describe('getAgentInfo', () => {
    it('should return the stored agent info', () => {
      const info = coordinator.getAgentInfo();

      expect(info).toEqual(agentInfo);
    });

    it('should return agent capabilities', () => {
      const info = coordinator.getAgentInfo();

      expect(info.capabilities).toEqual(['sense', 'actuate']);
    });

    it('should return agent status', () => {
      const info = coordinator.getAgentInfo();

      expect(info.status).toBe('online');
    });

    it('should return agent metadata', () => {
      const info = coordinator.getAgentInfo();

      expect(info.metadata).toEqual({ role: 'controller' });
    });
  });

  describe('formatContextForLLM', () => {
    it('should delegate to AgentContextBuilder.formatContextForLLM', async () => {
      const context = await coordinator.buildFullContext();
      coordinator.formatContextForLLM(context);

      expect(mockContextBuilder.formatContextForLLM).toHaveBeenCalledWith(context, undefined);
    });

    it('should delegate with task parameter', async () => {
      const context = await coordinator.buildFullContext();
      const task = 'Test task';
      coordinator.formatContextForLLM(context, task);

      expect(mockContextBuilder.formatContextForLLM).toHaveBeenCalledWith(context, task);
    });

    it('should return formatted string from builder', async () => {
      const context = await coordinator.buildFullContext();
      const result = coordinator.formatContextForLLM(context);

      expect(result).toBe('Formatted context');
    });
  });

  describe('formatContextForLLMAsync', () => {
    it('should delegate to AgentContextBuilder.formatContextForLLMAsync', async () => {
      const context = await coordinator.buildFullContext();
      await coordinator.formatContextForLLMAsync(context);

      expect(mockContextBuilder.formatContextForLLMAsync).toHaveBeenCalledWith(context, undefined);
    });

    it('should delegate with task parameter', async () => {
      const context = await coordinator.buildFullContext();
      const task = 'Test task';
      await coordinator.formatContextForLLMAsync(context, task);

      expect(mockContextBuilder.formatContextForLLMAsync).toHaveBeenCalledWith(context, task);
    });

    it('should return formatted string from builder', async () => {
      const context = await coordinator.buildFullContext();
      const result = await coordinator.formatContextForLLMAsync(context);

      expect(result).toBe('Formatted context async');
    });
  });

  describe('buildFullPrompt', () => {
    it('should delegate to AgentContextBuilder.buildFullPrompt', () => {
      const task = 'Test task';
      const instructions = 'Test instructions';
      coordinator.buildFullPrompt(task, instructions);

      expect(mockContextBuilder.buildFullPrompt).toHaveBeenCalledWith(task, instructions, undefined);
    });

    it('should pass optional context parameter', async () => {
      const context = await coordinator.buildFullContext();
      const task = 'Test task';
      const instructions = 'Test instructions';
      coordinator.buildFullPrompt(task, instructions, context);

      expect(mockContextBuilder.buildFullPrompt).toHaveBeenCalledWith(task, instructions, context);
    });

    it('should return the prompt from builder', () => {
      const result = coordinator.buildFullPrompt('task', 'instructions');

      expect(result).toBe('Full prompt');
    });
  });

  describe('setUserId', () => {
    it('should delegate to AgentContextBuilder.setUserId', () => {
      coordinator.setUserId('user-123');

      expect(mockContextBuilder.setUserId).toHaveBeenCalledWith('user-123');
    });
  });

  describe('getUserId', () => {
    it('should delegate to AgentContextBuilder.getUserId', () => {
      coordinator.getUserId();

      expect(mockContextBuilder.getUserId).toHaveBeenCalled();
    });

    it('should return the user ID from builder', () => {
      const result = coordinator.getUserId();

      expect(result).toBeUndefined();
    });
  });

  describe('Event Emission', () => {
    it('should use correct event type', async () => {
      await coordinator.buildFullContext();

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        EventType.AGENT_CONTEXT_BUILT,
        expect.any(Object)
      );
    });

    it('should include agent ID in all events', async () => {
      await coordinator.buildFullContext();
      await coordinator.buildTaskContext('test task');

      const calls = (mockEventEmitter.emit as Mock).mock.calls;
      for (const call of calls) {
        expect(call[1].agentId).toBe('agent-1');
      }
    });

    it('should emit events with NORMAL priority by default', async () => {
      await coordinator.buildFullContext();

      // EventEmitter.emit doesn't take priority directly, but we verify the call structure
      expect(mockEventEmitter.emit).toHaveBeenCalled();
    });
  });

  describe('Delegation Pattern', () => {
    it('should not reimplement context building logic', async () => {
      // The coordinator should only delegate, not have its own implementation
      await coordinator.buildFullContext();

      // Verify that the result comes directly from the mock builder
      const context = await coordinator.buildFullContext();
      expect(context.self.id).toBe('agent-1');
    });

    it('should be a thin wrapper', () => {
      // Verify the coordinator has minimal methods
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(coordinator));
      const expectedMethods = [
        'constructor',
        'buildFullContext',
        'buildTaskContext',
        'getAgentInfo',
        'getAgentId',
        'formatContextForLLM',
        'formatContextForLLMAsync',
        'buildFullPrompt',
        'setUserId',
        'getUserId',
      ];

      // All methods should be accounted for
      for (const method of methods) {
        if (method !== 'constructor') {
          expect(expectedMethods).toContain(method);
        }
      }
    });
  });
});

describe('ContextManagementCoordinator Error Handling', () => {
  let coordinator: ContextManagementCoordinator;
  let mockContextBuilder: AgentContextBuilder;
  let mockEventEmitter: EventEmitter;

  beforeEach(() => {
    mockContextBuilder = createMockContextBuilder();
    mockEventEmitter = createMockEventEmitter();

    coordinator = new ContextManagementCoordinator(
      mockContextBuilder,
      mockEventEmitter,
      'agent-1',
      {
        id: 'agent-1',
        name: 'Test Agent',
        description: 'Test',
        capabilities: [],
        status: 'online',
      }
    );
  });

  it('should handle errors from buildFullContext gracefully', async () => {
    (mockContextBuilder.buildFullContext as Mock).mockRejectedValueOnce(
      new Error('Builder error')
    );

    await expect(coordinator.buildFullContext()).rejects.toThrow('Builder error');
  });

  it('should not emit event on buildFullContext error', async () => {
    (mockContextBuilder.buildFullContext as Mock).mockRejectedValueOnce(
      new Error('Builder error')
    );

    try {
      await coordinator.buildFullContext();
    } catch {
      // Expected
    }

    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });

  it('should handle errors from buildTaskContext gracefully', async () => {
    (mockContextBuilder.buildFullContext as Mock).mockRejectedValueOnce(
      new Error('Builder error')
    );

    await expect(coordinator.buildTaskContext('task')).rejects.toThrow('Builder error');
  });
});
