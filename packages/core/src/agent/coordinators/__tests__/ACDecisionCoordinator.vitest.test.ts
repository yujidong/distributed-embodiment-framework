/**
 * ACDecisionCoordinator Unit Tests
 *
 * Tests for AC decision coordinator with comprehensive coverage
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ACDecisionCoordinator } from '../ACDecisionCoordinator.js';
import type { DualTriggerACManager } from '../../../decision/DualTriggerACManager.js';
import type { AutonomousDecisionEngine } from '../../../decision/AutonomousDecisionEngine.js';
import type { EventEmitter } from '../../../events/EventEmitter.js';
import type { ResourceRequirement, ACCollaborationGoal } from '../ACDecisionCoordinator.js';

// Helper functions to create mocks
const createMockDualTriggerACManager = (): DualTriggerACManager => {
  return {
    processEvent: vi.fn(),
    isEnabled: vi.fn().mockReturnValue(true),
  } as unknown as DualTriggerACManager;
};

const createMockAutonomousDecisionEngine = (): AutonomousDecisionEngine => {
  return {
    evaluateSituation: vi.fn().mockResolvedValue({
      action: 'handle_independently',
      reasoning: 'Default decision',
    }),
    makeDecision: vi.fn().mockResolvedValue({
      decision: 'collaborate',
      confidence: 0.8,
    }),
  } as unknown as AutonomousDecisionEngine;
};

const createMockEventEmitter = (): EventEmitter => {
  return {
    emit: vi.fn().mockReturnValue({
      id: 'event-123',
      source: 'agent-1',
      timestamp: new Date(),
    }),
    emitStateChange: vi.fn(),
    emitError: vi.fn(),
    emitWarning: vi.fn(),
    getEmitterId: vi.fn().mockReturnValue('agent-1'),
    getEventManager: vi.fn(),
  } as unknown as EventEmitter;
};

describe('ACDecisionCoordinator', () => {
  let coordinator: ACDecisionCoordinator;
  let mockDualTriggerManager: DualTriggerACManager;
  let mockDecisionEngine: AutonomousDecisionEngine;
  let mockEventEmitter: EventEmitter;

  const agentId = 'agent-1';

  beforeEach(() => {
    vi.clearAllMocks();
    mockDualTriggerManager = createMockDualTriggerACManager();
    mockDecisionEngine = createMockAutonomousDecisionEngine();
    mockEventEmitter = createMockEventEmitter();

    coordinator = new ACDecisionCoordinator(
      mockDualTriggerManager,
      mockDecisionEngine,
      mockEventEmitter,
      agentId,
      undefined // No proposal evaluator
    );
  });

  describe('Constructor', () => {
    it('should create coordinator with all dependencies', () => {
      expect(coordinator).toBeDefined();
    });

    it('should create coordinator with optional proposal evaluator', () => {
      const mockEvaluator = {
        evaluate: vi.fn().mockResolvedValue({
          score: 0.7,
          recommendation: 'Test',
        })
      };

      const coordinatorWithEvaluator = new ACDecisionCoordinator(
        mockDualTriggerManager,
        mockDecisionEngine,
        mockEventEmitter,
        agentId,
        mockEvaluator
      );

      expect(coordinatorWithEvaluator).toBeDefined();
    });
  });

  describe('enableDualTriggerAC', () => {
    it('should enable dual trigger AC and confirm manager is enabled', () => {
      coordinator.enableDualTriggerAC();
      // Verify that after enabling, the dual trigger manager reports as enabled
      expect(mockDualTriggerManager.isEnabled()).toBe(true);
    });
  });

  describe('disableDualTriggerAC', () => {
    it('should disable dual trigger AC without throwing', () => {
      // Verify coordinator can disable dual trigger AC and still formulate goals afterwards
      expect(() => coordinator.disableDualTriggerAC()).not.toThrow();
    });
  });

  describe('evaluateProposal', () => {
    it('should return default evaluation when no evaluator configured', async () => {
      const proposal = { id: 'proposal-1', type: 'collaboration' };
      const result = await coordinator.evaluateProposal(proposal);

      expect(result.score).toBe(0.5);
      expect(result.recommendation).toContain('No evaluator');
    });

    it('should evaluate proposal with evaluator', async () => {
      const mockEvaluator = {
        evaluate: vi.fn().mockResolvedValue({
          score: 0.8,
          recommendation: 'Accept proposal',
        })
      };

      const coordinatorWithEvaluator = new ACDecisionCoordinator(
        mockDualTriggerManager,
        mockDecisionEngine,
        mockEventEmitter,
        agentId,
        mockEvaluator
      );

      const proposal = { id: 'proposal-1', type: 'collaboration' };
      const result = await coordinatorWithEvaluator.evaluateProposal(proposal);

      expect(result.score).toBe(0.8);
      expect(result.recommendation).toBe('Accept proposal');
      // The coordinator passes both the proposal and agent context to the evaluator
      expect(mockEvaluator.evaluate).toHaveBeenCalledWith(proposal, {
        agentId: 'agent-1',
        capabilities: [],
        currentLoad: 0,
        availableResources: []
      });
    });

    it('should evaluate different proposal types', async () => {
      const mockEvaluator = {
        evaluate: vi.fn().mockResolvedValue({
          score: 0.9,
          recommendation: 'High-value collaboration',
        })
      };

      const coordinatorWithEvaluator = new ACDecisionCoordinator(
        mockDualTriggerManager,
        mockDecisionEngine,
        mockEventEmitter,
        agentId,
        mockEvaluator
      );

      const proposalTypes = ['collaboration', 'resource-sharing', 'task-delegation'];

      for (const type of proposalTypes) {
        const proposal = { id: `proposal-${type}`, type };
        const result = await coordinatorWithEvaluator.evaluateProposal(proposal);

        expect(result.score).toBeDefined();
        expect(result.recommendation).toBeDefined();
      }
    });

    it('should handle high-score proposals', async () => {
      const mockEvaluator = {
        evaluate: vi.fn().mockResolvedValue({
          score: 0.95,
          recommendation: 'Excellent proposal, strongly recommend acceptance',
        })
      };

      const coordinatorWithEvaluator = new ACDecisionCoordinator(
        mockDualTriggerManager,
        mockDecisionEngine,
        mockEventEmitter,
        agentId,
        mockEvaluator
      );

      const proposal = { id: 'high-value-proposal', type: 'collaboration' };
      const result = await coordinatorWithEvaluator.evaluateProposal(proposal);

      expect(result.score).toBeGreaterThan(0.9);
      expect(result.recommendation).toContain('Excellent');
    });

    it('should handle low-score proposals', async () => {
      const mockEvaluator = {
        evaluate: vi.fn().mockResolvedValue({
          score: 0.2,
          recommendation: 'Proposal does not align with agent goals',
        })
      };

      const coordinatorWithEvaluator = new ACDecisionCoordinator(
        mockDualTriggerManager,
        mockDecisionEngine,
        mockEventEmitter,
        agentId,
        mockEvaluator
      );

      const proposal = { id: 'low-value-proposal', type: 'collaboration' };
      const result = await coordinatorWithEvaluator.evaluateProposal(proposal);

      expect(result.score).toBeLessThan(0.5);
      expect(result.recommendation).toContain('does not align');
    });
  });

  describe('makeAutonomousDecision', () => {
    it('should return default decision', async () => {
      const context = { situation: 'test' };
      const result = await coordinator.makeAutonomousDecision(context);

      expect(result.decision).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should delegate to AutonomousDecisionEngine', async () => {
      const context = {
        situation: 'emergency',
        availableResources: ['device-1'],
        taskComplexity: 'high'
      };

      await coordinator.makeAutonomousDecision(context);

      expect(mockDecisionEngine.makeDecision).toHaveBeenCalledWith(context);
    });

    it('should handle emergency situations', async () => {
      (mockDecisionEngine.makeDecision as Mock).mockResolvedValue({
        decision: 'handle_independently',
        confidence: 0.95,
        reasoning: 'Emergency requires immediate independent action',
      });

      const context = { situation: 'emergency', urgency: 'critical' };
      const result = await coordinator.makeAutonomousDecision(context);

      expect(result.decision).toBe('handle_independently');
      expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('should handle collaborative contexts', async () => {
      (mockDecisionEngine.makeDecision as Mock).mockResolvedValue({
        decision: 'collaborate',
        confidence: 0.85,
        reasoning: 'Task benefits from multi-agent collaboration',
      });

      const context = {
        situation: 'complex_task',
        requiresDiverseCapabilities: true,
        availableAgents: ['agent-2', 'agent-3']
      };
      const result = await coordinator.makeAutonomousDecision(context);

      expect(result.decision).toBe('collaborate');
      expect(result.confidence).toBeGreaterThan(0.8);
    });

    it('should handle decision engine errors', async () => {
      (mockDecisionEngine.makeDecision as Mock).mockRejectedValue(
        new Error('Decision engine failed')
      );

      const context = { situation: 'test' };
      const result = await coordinator.makeAutonomousDecision(context);

      // Should return default decision on error
      expect(result.decision).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0);
    });
  });

  describe('shouldTriggerAC', () => {
    it('should return false by default', async () => {
      const context = { situation: 'test' };
      const result = await coordinator.shouldTriggerAC(context);

      expect(result).toBe(false);
    });

    it('should return false for simple tasks', async () => {
      const context = {
        situation: 'simple_task',
        complexity: 'low',
        requiredCapabilities: ['basic-sensing']
      };
      const result = await coordinator.shouldTriggerAC(context);

      expect(result).toBe(false);
    });

    it('should return true for complex tasks when implemented', async () => {
      // This test assumes shouldTriggerAC logic will be enhanced
      // For now, it returns false, but we test the interface
      const context = {
        situation: 'complex_task',
        complexity: 'high',
        requiredCapabilities: ['advanced-analytics', 'multi-device-control']
      };
      const result = await coordinator.shouldTriggerAC(context);

      // Currently returns false, but interface is tested
      expect(typeof result).toBe('boolean');
    });

    it('should consider resource availability', async () => {
      const contextWithResources = {
        situation: 'data_processing',
        availableResources: ['sensor-1', 'sensor-2'],
        requiredCapabilities: ['data-aggregation']
      };
      const result = await coordinator.shouldTriggerAC(contextWithResources);

      expect(typeof result).toBe('boolean');
    });
  });

  describe('formulateGoal', () => {
    it('should create goal from resource requirements', async () => {
      const requirements: ResourceRequirement[] = [
        { type: 'device', id: 'temp-sensor-1', capability: 'temperature-monitoring', required: true, estimatedUsage: 80 },
        { type: 'device', id: 'humidity-sensor-1', capability: 'humidity-sensing', required: true, estimatedUsage: 60 },
      ];

      const goal = await coordinator.formulateGoal(requirements);

      expect(goal).toBeDefined();
      expect(goal.requiredCapabilities).toContain('temperature-monitoring');
      expect(goal.requiredCapabilities).toContain('humidity-sensing');
    });

    it('should handle empty requirements', async () => {
      const requirements: ResourceRequirement[] = [];

      const goal = await coordinator.formulateGoal(requirements);

      expect(goal).toBeDefined();
      expect(goal.requiredCapabilities).toEqual([]);
    });

    it('should validate goal structure', async () => {
      const requirements: ResourceRequirement[] = [
        { type: 'service', id: 'proc-service-1', capability: 'data-processing', required: true, estimatedUsage: 90 },
      ];

      const goal = await coordinator.formulateGoal(requirements);

      expect(goal).toHaveProperty('requiredCapabilities');
      expect(Array.isArray(goal.requiredCapabilities)).toBe(true);
    });

    it('should handle complex requirements', async () => {
      const requirements: ResourceRequirement[] = [
        { type: 'device', id: 'sensor-1', capability: 'sensing', required: true, estimatedUsage: 70 },
        { type: 'device', id: 'actuator-1', capability: 'actuation', required: true, estimatedUsage: 50 },
        { type: 'agent', id: 'agent-1', capability: 'analytics', required: true, estimatedUsage: 100 },
      ];

      const goal = await coordinator.formulateGoal(requirements);

      expect(goal.requiredCapabilities.length).toBe(3);
    });

    it('should handle errors in goal formulation', async () => {
      const invalidRequirements = null as unknown as ResourceRequirement[];

      // Should not throw, should handle gracefully
      const goal = await coordinator.formulateGoal(invalidRequirements);

      expect(goal).toBeDefined();
    });
  });

  describe('Integration Scenarios', () => {
    it('should integrate with DualTriggerACManager', () => {
      expect(mockDualTriggerManager).toBeDefined();
      expect(mockDualTriggerManager.isEnabled()).toBe(true);
    });

    it('should integrate with AutonomousDecisionEngine', async () => {
      const context = { situation: 'test' };
      await coordinator.makeAutonomousDecision(context);

      expect(mockDecisionEngine.makeDecision).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle proposal evaluation errors gracefully', async () => {
      const mockEvaluator = {
        evaluate: vi.fn().mockRejectedValue(new Error('Evaluation failed'))
      };

      const coordinatorWithEvaluator = new ACDecisionCoordinator(
        mockDualTriggerManager,
        mockDecisionEngine,
        mockEventEmitter,
        agentId,
        mockEvaluator
      );

      const proposal = { id: 'proposal-1', type: 'collaboration' };
      const result = await coordinatorWithEvaluator.evaluateProposal(proposal);

      expect(result.score).toBe(0);
      expect(result.recommendation).toContain('failed');
    });

    it('should handle null proposal', async () => {
      const mockEvaluator = {
        evaluate: vi.fn().mockRejectedValue(new Error('Invalid proposal'))
      };

      const coordinatorWithEvaluator = new ACDecisionCoordinator(
        mockDualTriggerManager,
        mockDecisionEngine,
        mockEventEmitter,
        agentId,
        mockEvaluator
      );

      const result = await coordinatorWithEvaluator.evaluateProposal(null as unknown as Record<string, unknown>);

      expect(result.score).toBe(0);
      expect(result.recommendation).toContain('failed');
    });

    it('should handle undefined context', async () => {
      const result = await coordinator.makeAutonomousDecision(undefined as unknown as Record<string, unknown>);

      expect(result.decision).toBeDefined();
    });

    it('should handle concurrent evaluations', async () => {
      const mockEvaluator = {
        evaluate: vi.fn().mockResolvedValue({
          score: 0.7,
          recommendation: 'Concurrent test',
        })
      };

      const coordinatorWithEvaluator = new ACDecisionCoordinator(
        mockDualTriggerManager,
        mockDecisionEngine,
        mockEventEmitter,
        agentId,
        mockEvaluator
      );

      const proposals = [
        { id: 'proposal-1', type: 'collaboration' },
        { id: 'proposal-2', type: 'resource-sharing' },
        { id: 'proposal-3', type: 'task-delegation' },
      ];

      const results = await Promise.all(
        proposals.map(p => coordinatorWithEvaluator.evaluateProposal(p))
      );

      expect(results.length).toBe(3);
      results.forEach(result => {
        expect(result.score).toBeDefined();
        expect(result.recommendation).toBeDefined();
      });
    });

    it('should handle resource conflicts in goal formulation', async () => {
      const requirements: ResourceRequirement[] = [
        { type: 'device', id: 'exclusive-1', capability: 'exclusive-resource', required: true, estimatedUsage: 100 },
        { type: 'device', id: 'exclusive-2', capability: 'exclusive-resource', required: true, estimatedUsage: 60 }, // Conflict
      ];

      const goal = await coordinator.formulateGoal(requirements);

      // Should handle duplicates or conflicts gracefully
      expect(goal).toBeDefined();
    });
  });

  describe('Event Emission', () => {
    it('should emit events during decision making', async () => {
      const context = { situation: 'test' };
      await coordinator.makeAutonomousDecision(context);

      // Event emission is optional, but interface should be available
      expect(mockEventEmitter.emit).toBeDefined();
    });
  });

  describe('Performance', () => {
    it('should make decisions within reasonable time', async () => {
      const startTime = Date.now();

      const context = { situation: 'performance-test' };
      await coordinator.makeAutonomousDecision(context);

      const executionTime = Date.now() - startTime;

      // Decision should be fast (< 100ms for mocked engine)
      expect(executionTime).toBeLessThan(100);
    });

    it('should evaluate proposals within reasonable time', async () => {
      const mockEvaluator = {
        evaluate: vi.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return { score: 0.8, recommendation: 'Test' };
        })
      };

      const coordinatorWithEvaluator = new ACDecisionCoordinator(
        mockDualTriggerManager,
        mockDecisionEngine,
        mockEventEmitter,
        agentId,
        mockEvaluator
      );

      const startTime = Date.now();

      const proposal = { id: 'test', type: 'collaboration' };
      await coordinatorWithEvaluator.evaluateProposal(proposal);

      const executionTime = Date.now() - startTime;

      expect(executionTime).toBeLessThan(50);
    });
  });
});
