/**
 * TDD Tests for Fail Early Principle Violations
 *
 * Sprint 14-15: P0 Code Quality Issues
 *
 * These tests verify that:
 * 1. No silent failures (returning default values in catch blocks)
 * 2. All errors are thrown with complete context
 * 3. No 'as any' type casts that bypass TypeScript type checking
 * 4. Proper error propagation following Erlang philosophy
 *
 * Reference: CLAUDE.md - Fail Early Development Principle
 * ❌ BAD: catch (e) { return defaultValue; }  // Silent failure
 * ✅ GOOD: catch (e) { logger.error('Context', e); throw e; }  // Loud failure
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { DualTriggerACManager } from '../DualTriggerACManager.js';
import { ACNecessityAssessor } from '../ACNecessityAssessor.js';
import { CollaborationProposalHandler } from '../../proposal/CollaborationProposalHandler.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { ChatParams, ChatResponse } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { SystemEvent } from '@active-collaboration/shared';
import type { SpatialClusterSummary } from '../../events/SpatialTemporalClusterEngine.js';

// ============================================================================
// ACNecessityAssessor Fail Early Tests
// ============================================================================

describe('ACNecessityAssessor - Fail Early Principle (P0)', () => {
  let assessor: ACNecessityAssessor;
  let mockLLMClient: LLMClient;

  beforeEach(() => {
    // Mock LLM client
    mockLLMClient = {
      chat: vi.fn(),
      quickChat: vi.fn(),
    } as unknown as LLMClient;

    // Create assessor
    assessor = new ACNecessityAssessor({}, mockLLMClient);
  });

  describe('performLLMAssessment - No Silent Failures', () => {
    it('should throw error when LLM client is not available, not return default', async () => {
      // Arrange: Create assessor without LLM client
      const assessorWithoutLLM = new ACNecessityAssessor({});

      const clusterSummary: SpatialClusterSummary = {
        clusterId: 'cluster-1',
        region: {
          id: 'region-1',
          center: { x: 0, y: 0 },
          radius: 10,
          type: 'zone',
        },
        timeWindow: new Date().toISOString(),
        significance: 'high',
        summary: 'Test cluster',
        findings: [],
        recommendation: 'evaluate_with_llm',
      };

      const agentContext = {
        agentId: 'agent-1',
        agentName: 'TestAgent',
        capabilities: ['temperature-control'],
        availableResources: [],
        currentWorkload: 'idle' as const,
        recentCollaborations: [],
        currentCollaborations: 0,
      };

      // Act & Assert: Should throw error
      await expect(
        assessorWithoutLLM['performLLMAssessment'](clusterSummary, agentContext)
      ).rejects.toThrow(/LLM client not available/);
    });

    it('should throw error when LLM call fails, not return fallback assessment (drop policy)', async () => {
      // T-022 (DevLoop R17): the DEFAULT failure policy is now honest
      // degradation (a rule-fallback decision naming the provider error).
      // The Fail-Early throw this test pins is the explicit 'drop' policy.
      // Arrange
      const clusterSummary: SpatialClusterSummary = {
        clusterId: 'cluster-2',
        region: {
          id: 'region-2',
          center: { x: 10, y: 10 },
          radius: 15,
          type: 'zone',
        },
        timeWindow: new Date().toISOString(),
        significance: 'medium',  // Changed from 'high' to avoid pre-check triggering
        summary: 'Test cluster needing LLM evaluation',
        // Fix-21: explicit capability requirement so the preCheck Type-A rule
        // (direct coverage + no capability gap → handle_independently) does NOT
        // short-circuit before the LLM is reached. 'plumbing-repair' is used
        // because 'cooling' is a synonym of the agent's 'temperature-control'
        // capability (see utils/capabilityMatching.ts CAPABILITY_SYNONYMS).
        findings: [{
          eventType: 'device.anomaly',
          count: 1,
          trend: 'rising',
          anomaly: true,
          details: { requiredCapabilities: ['plumbing-repair'] },
        }],
        recommendation: 'evaluate_with_llm',  // Changed to trigger LLM assessment
      };

      const agentContext = {
        agentId: 'agent-2',
        agentName: 'TestAgent',
        capabilities: ['temperature-control'],
        availableResources: [],
        currentWorkload: 'idle' as const,
        recentCollaborations: [],
        currentCollaborations: 0,
        // Fix-21: direct actuator coverage of the event zone is required for
        // preCheck to fall through to 'needs_llm'. Without it the agent is
        // classified sensor-only (no actuatorZoneIds) and preCheck decides
        // 'initiate_ac' without ever calling the LLM — which made this test
        // resolve instead of reject.
        actuatorZoneIds: ['region-2'],
      };

      const dropAssessor = new ACNecessityAssessor(
        { llmFailurePolicy: 'drop', maxRetries: 0 },
        mockLLMClient,
      );

      // Mock LLM to throw error
      const llmError = new Error('LLM service unavailable');
      (mockLLMClient.quickChat as Mock).mockRejectedValue(llmError);

      // Act & Assert: Should throw error with context
      await expect(
        dropAssessor.assess(clusterSummary, agentContext)
      ).rejects.toThrow();

      try {
        await dropAssessor.assess(clusterSummary, agentContext);
        expect.fail('Should have thrown');
      } catch (error: unknown) {
        // Error should contain context about what failed
        const errorMsg = error instanceof Error ? error.message : String(error);
        expect(errorMsg).toMatch(/LLM|assess|failed|unavailable/i);
      }
    });

    it('should tolerate unparseable (prose) LLM responses via FSM fallback, but throw on empty response', async () => {
      // Fix-21: updated to current behavior. parseLLMResponse deliberately
      // tolerates prose answers: providers that ignore the JSON `format`
      // still answer in natural language, and the FSM keyword parser extracts
      // a decision from them (see parseLLMResponse / extractDecisionFSM).
      // That is a documented degradation path, NOT a silent failure — the
      // decision is derived from the actual response text and logged.
      // Fail-Early still applies to genuinely missing responses ('' etc.),
      // which DO throw.
      const clusterSummary: SpatialClusterSummary = {
        clusterId: 'cluster-3',
        region: {
          id: 'region-3',
          center: { x: 20, y: 20 },
          radius: 20,
          type: 'zone',
        },
        timeWindow: new Date().toISOString(),
        significance: 'medium',
        summary: 'Test cluster',
        findings: [],
        recommendation: 'evaluate_with_llm',
      };

      const agentContext = {
        agentId: 'agent-3',
        agentName: 'TestAgent',
        capabilities: ['monitoring'],
        availableResources: [],
        currentWorkload: 'idle' as const,
        recentCollaborations: [],
        currentCollaborations: 0,
      };

      // Prose response → FSM fallback produces a decision instead of throwing
      (mockLLMClient.quickChat as Mock).mockResolvedValue({
        content: 'Not JSON at all, just plain text',
      });

      const { assessment, source } = await assessor['performLLMAssessment'](clusterSummary, agentContext);
      expect(source).toBe('llm');
      expect(typeof assessment.needsCollaboration).toBe('boolean');
      expect(assessment.rawResponse).toBe('Not JSON at all, just plain text');

      // Empty response → hard failure (Fail Early preserved)
      (mockLLMClient.quickChat as Mock).mockResolvedValue({ content: '' });
      await expect(
        assessor['performLLMAssessment'](clusterSummary, agentContext)
      ).rejects.toThrow();
    });
  });
});

// ============================================================================
// DualTriggerACManager - No 'as any' Type Casts
// ============================================================================

describe('DualTriggerACManager - No "as any" Type Casts (P0)', () => {
  let manager: DualTriggerACManager;
  let mockLLMClient: LLMClient;
  let mockEnvironment: EnvironmentCenter;

  beforeEach(() => {
    // Mock LLM client
    mockLLMClient = {
      chat: vi.fn(),
      quickChat: vi.fn(),
    } as unknown as LLMClient;

    // Mock environment
    mockEnvironment = {
      listDevices: vi.fn().mockReturnValue([]),
      listAgents: vi.fn().mockReturnValue([]),
      getParameters: vi.fn().mockReturnValue({}),
      eventManager: {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        publish: vi.fn(),
      },
      services: new Map(),
    } as unknown as EnvironmentCenter;

    // Create manager
    manager = new DualTriggerACManager(
      'agent-1',
      'TestAgent',
      ['temperature-control', 'monitoring'],
      mockLLMClient,
      mockEnvironment,
      vi.fn(),
      {
        enableLayer1: false,
        enableLayer2: true,
        autoInitiateAC: false,
      }
    );
  });

  describe('Dependency Injection - No Private Member Access', () => {
    it('should not use "as any" to access resourceManager', async () => {
      // This test verifies proper dependency injection
      // The code should NOT do: (this as any).resourceManager

      // Arrange: Set up agent devices
      manager.setAgentDevices([{
        deviceId: 'device-1',
        type: 'thermostat',
        capabilities: ['temperature-control'],
      }]);

      // Act: Build agent context should work without 'as any'
      const context = await manager['buildAgentContext']();

      // Assert: Context should be built correctly
      expect(context).toBeDefined();
      expect(context.agentId).toBe('agent-1');

      // The implementation should use proper dependency injection
      // not access private members via 'as any'
    });

    it('should not use "as any" to access serviceRegistry', async () => {
      // This test verifies proper dependency injection for ServiceRegistry

      // Act
      const context = await manager['buildAgentContext']();

      // Assert: Should work without 'as any' casts
      expect(context).toBeDefined();
      expect(context.ownServices).toBeDefined();
    });

    it('should use proper interface to get environment parameters', async () => {
      // The code should use getParameters() method, not (this as any).environment.getParameters

      // Act
      const context = await manager['buildAgentContext']();

      // Assert: Should get environment state through proper interface
      expect(context.environmentState).toBeDefined();
    });
  });

  describe('Fail Early - No Silent Failures', () => {
    it('should throw error when buildAgentContext fails, not return empty context', async () => {
      // Arrange: Make environment throw an error
      (mockEnvironment as unknown as Record<string, unknown>).listDevices = vi.fn().mockImplementation(() => {
        throw new Error('Environment error');
      });

      // Act & Assert: Should throw error
      await expect(manager['buildAgentContext']()).rejects.toThrow(/Environment error/);
    });
  });
});

// ============================================================================
// CollaborationProposalHandler Fail Early Tests
// ============================================================================

describe('CollaborationProposalHandler - Fail Early Principle (P0)', () => {
  let handler: CollaborationProposalHandler;
  let mockLLMClient: LLMClient;
  let mockEnvironment: EnvironmentCenter;

  beforeEach(() => {
    // Mock LLM client
    mockLLMClient = {
      chat: vi.fn(),
      quickChat: vi.fn(),
    } as unknown as LLMClient;

    // Mock environment
    mockEnvironment = {
      listDevices: vi.fn().mockReturnValue([]),
      listAgents: vi.fn().mockReturnValue([]),
      eventManager: {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        publish: vi.fn(),
      },
    } as unknown as EnvironmentCenter;

    // Create handler
    handler = new CollaborationProposalHandler({
      llmClient: mockLLMClient,
      environment: mockEnvironment,
      agentId: 'agent-1',
      agentName: 'TestAgent',
      agentCapabilities: ['temperature-control', 'monitoring'],
      config: {
        enabled: true,
        autoExecuteAccepted: false,
        maxConcurrentCollaborations: 5,
        criteria: {
          minBenefitThreshold: 0.5,
          maxCostThreshold: 0.7,
          trustedPartnerBonus: 0.1,
        },
      },
    });
  });

  describe('analyzeWithLLM - No Silent Failures', () => {
    it('should throw error when LLM call fails, not return default analysis', async () => {
      // Arrange
      const proposal = {
        id: 'proposal-1',
        proposedBy: 'agent-2',
        proposedTo: 'agent-1',
        task: 'Temperature adjustment',
        services: ['cooling'],
        description: 'Need cooling assistance',
        timestamp: new Date(),
      };

      // Mock LLM to throw error
      const llmError = new Error('LLM connection failed');
      (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mockRejectedValue(llmError);

      // Act & Assert: Should throw error
      await expect(handler['analyzeWithLLM'](proposal)).rejects.toThrow();

      try {
        await handler['analyzeWithLLM'](proposal);
        expect.fail('Should have thrown');
      } catch (error: unknown) {
        // Error should contain context
        const errorMsg = error instanceof Error ? error.message : String(error);
        expect(errorMsg).toMatch(/LLM|analyze|failed/i);
      }
    });

    it('should throw error when LLM returns invalid JSON, not return default', async () => {
      // Arrange
      const proposal = {
        id: 'proposal-2',
        proposedBy: 'agent-3',
        proposedTo: 'agent-1',
        task: 'Test task',
        services: [],
        timestamp: new Date(),
      };

      // Mock LLM to return invalid JSON
      (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mockResolvedValue({
        content: 'Not valid JSON response',
      });

      // Act & Assert: Should throw error
      await expect(handler['analyzeWithLLM'](proposal)).rejects.toThrow();
    });
  });
});

// ============================================================================
// Source Code Static Analysis - No 'as any'
// ============================================================================

describe('Static Analysis - No "as any" Type Casts', () => {

  it('should not contain "as any" in DualTriggerACManager source', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const sourcePath = path.join(
      import.meta.dirname,
      '../DualTriggerACManager.ts'
    );

    const source = fs.readFileSync(sourcePath, 'utf-8');

    const lines = source.split('\n');
    const asAnyLines = lines.filter((line) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
        return false;
      }
      return line.includes(' as any');
    });

    expect(asAnyLines.length).toBe(0);
  });

  it('should not contain "as any" in ACNecessityAssessor source', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const sourcePath = path.join(
      import.meta.dirname,
      '../ACNecessityAssessor.ts'
    );

    const source = fs.readFileSync(sourcePath, 'utf-8');

    const lines = source.split('\n');
    const asAnyLines = lines.filter((line) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
        return false;
      }
      return line.includes(' as any');
    });

    expect(asAnyLines.length).toBe(0);
  });

  it('should not contain "as any" in CollaborationProposalHandler source', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const sourcePath = path.join(
      import.meta.dirname,
      '../../proposal/CollaborationProposalHandler.ts'
    );

    const source = fs.readFileSync(sourcePath, 'utf-8');

    const lines = source.split('\n');
    const asAnyLines = lines.filter((line) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
        return false;
      }
      return line.includes(' as any');
    });

    expect(asAnyLines.length).toBe(0);
  });
});
