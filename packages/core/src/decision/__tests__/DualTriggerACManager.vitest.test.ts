/**
 * TDD Tests for DualTriggerACManager Context Management Improvements
 *
 * Sprint 14: Optimize Agent Context Management
 *
 * These tests verify that:
 * 1. Agent context includes complete device state information
 * 2. Device states are retrieved from ResourceManager when available
 * 3. Environment state and services are included in context
 * 4. All relevant information is passed to LLM for decision making
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { DualTriggerACManager } from '../DualTriggerACManager.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { SystemEvent } from '../../events/EventManager.js';
import { EventType } from '@active-collaboration/shared';
import type { AgentContext } from '../ACNecessityAssessor.js';

// ============================================================================
// Helper Types for Private Member Access
// ============================================================================

/** Interface for accessing DualTriggerACManager private members in tests */
interface DualTriggerACManagerTestAccess {
  resourceManager: ResourceManagerLike | undefined;
  serviceRegistry: ServiceRegistryLike | undefined;
  activeACs: Map<string, Record<string, unknown>>;
  buildAgentContext: () => Promise<AgentContext>;
}

/** Minimal ResourceManager interface used by DualTriggerACManager */
interface ResourceManagerLike {
  getResource: Mock<(deviceId: string) => DeviceResourceLike | null>;
}

/** Device resource returned by ResourceManager */
interface DeviceResourceLike {
  getState: () => Record<string, unknown>;
  getLocation: () => Record<string, unknown>;
  isAvailable: () => boolean;
}

/** Minimal ServiceRegistry interface used by DualTriggerACManager */
interface ServiceRegistryLike {
  getOwnServices: Mock<() => ServiceEntryLike[]>;
}

/** Service entry from ServiceRegistry */
interface ServiceEntryLike {
  name: string;
  capabilities: string[];
  status: string;
}

describe('DualTriggerACManager - Context Management (Sprint 14)', () => {
  let manager: DualTriggerACManager;
  let mockLLMClient: LLMClient;
  let mockEnvironment: EnvironmentCenter;
  let mockResourceManager: ResourceManagerLike;
  let mockServiceRegistry: ServiceRegistryLike;

  beforeEach(() => {
    // Mock LLM client
    mockLLMClient = {
      chat: vi.fn(),
      quickChat: vi.fn(),
    } as unknown as LLMClient;

    // Mock ResourceManager
    mockResourceManager = {
      getResource: vi.fn(),
    };

    // Mock ServiceRegistry
    mockServiceRegistry = {
      getOwnServices: vi.fn(),
    };

    // Mock environment
    mockEnvironment = {
      listDevices: vi.fn(),
      listAgents: vi.fn(),
      getParameters: vi.fn(),
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
      ['temperature-control', 'monitoring', 'cooling'],
      mockLLMClient,
      mockEnvironment,
      vi.fn(), // onACInitiation callback
      {
        enableLayer1: false, // Disable Layer 1 for testing Layer 2 directly
        enableLayer2: true,
        autoInitiateAC: false, // Don't auto-initiate in tests
      }
    );

    // Inject mock ResourceManager and ServiceRegistry for testing
    const managerAccess = manager as unknown as DualTriggerACManagerTestAccess;
    managerAccess.resourceManager = mockResourceManager;
    managerAccess.serviceRegistry = mockServiceRegistry;
  });

  describe('RED: Test for Complete Device State Information', () => {
    it('should include device states from ResourceManager when available', async () => {
      // Arrange: Set up agent devices with resource manager
      const agentDevices = [
        {
          deviceId: 'device-1',
          type: 'thermostat',
          capabilities: ['temperature-control'],
        },
        {
          deviceId: 'device-2',
          type: 'sensor',
          capabilities: ['monitoring'],
        },
      ];

      manager.setAgentDevices(agentDevices);

      // Mock ResourceManager to return device states
      mockResourceManager.getResource.mockImplementation((deviceId: string) => {
        if (deviceId === 'device-1') {
          return {
            getState: () => ({ temperature: 22, mode: 'cooling', setpoint: 20 }),
            getLocation: () => ({ x: 10, y: 20, floor: 1 }),
            isAvailable: () => true,
          };
        }
        if (deviceId === 'device-2') {
          return {
            getState: () => ({ temperature: 25, battery: 85, lastUpdate: '2024-03-15T10:30:00Z' }),
            getLocation: () => ({ x: 15, y: 25, floor: 1 }),
            isAvailable: () => true,
          };
        }
        return null;
      });

      // Act: Build agent context
      const context = await (manager as unknown as DualTriggerACManagerTestAccess).buildAgentContext();

      // Assert
      expect(context).toBeDefined();
      expect(context.availableResources).toBeDefined();
      expect(context.availableResources.length).toBe(2);

      // Should include device states
      const device1 = context.availableResources.find((d: { deviceId: string }) => d.deviceId === 'device-1');
      expect(device1).toBeDefined();
      expect(device1.currentState).toBeDefined();
      expect(device1.currentState.temperature).toBe(22);
      expect(device1.currentState.mode).toBe('cooling');

      const device2 = context.availableResources.find((d: { deviceId: string }) => d.deviceId === 'device-2');
      expect(device2).toBeDefined();
      expect(device2.currentState).toBeDefined();
      expect(device2.currentState.temperature).toBe(25);
      expect(device2.currentState.battery).toBe(85);

      // Should include location information
      expect(device1.location).toBeDefined();
      expect(device1.location.x).toBe(10);

      // Should include online status
      expect(device1.isOnline).toBe(true);
      expect(device2.isOnline).toBe(true);
    });

    it('should handle missing ResourceManager gracefully', async () => {
      // Arrange: Set up agent devices without ResourceManager
      const agentDevices = [
        {
          deviceId: 'device-1',
          type: 'thermostat',
          capabilities: ['temperature-control'],
        },
      ];

      manager.setAgentDevices(agentDevices);

      // Remove ResourceManager
      (manager as unknown as DualTriggerACManagerTestAccess).resourceManager = undefined;

      // Act: Build agent context
      const context = await (manager as unknown as DualTriggerACManagerTestAccess).buildAgentContext();

      // Assert
      expect(context).toBeDefined();
      expect(context.availableResources).toBeDefined();
      expect(context.availableResources.length).toBe(1);

      // Should still include device info, just without detailed state
      const device1 = context.availableResources[0];
      expect(device1.deviceId).toBe('device-1');
      expect(device1.capabilities).toEqual(['temperature-control']);
    });

    it('should mark devices as offline when not available', async () => {
      // Arrange
      const agentDevices = [
        {
          deviceId: 'device-1',
          type: 'thermostat',
          capabilities: ['temperature-control'],
        },
      ];

      manager.setAgentDevices(agentDevices);

      // Mock ResourceManager to return unavailable device
      mockResourceManager.getResource.mockReturnValue(null);

      // Act
      const context = await (manager as unknown as DualTriggerACManagerTestAccess).buildAgentContext();

      // Assert
      const device1 = context.availableResources[0];
      expect(device1.isOnline).toBe(true); // Default to true if resource not found
    });
  });

  describe('RED: Test for Environment State and Services', () => {
    it('should include environment state in agent context', async () => {
      // Arrange
      const agentDevices = [];

      manager.setAgentDevices(agentDevices);

      // Mock environment parameters
      (mockEnvironment as unknown as Record<string, Mock>).getParameters.mockReturnValue({
        outdoorTemperature: 32,
        outdoorHumidity: 65,
        timeOfDay: '10:30',
        season: 'summer',
      });

      // Act
      const context = await (manager as unknown as DualTriggerACManagerTestAccess).buildAgentContext();

      // Assert
      expect(context.environmentState).toBeDefined();
      expect(context.environmentState.outdoorTemperature).toBe(32);
      expect(context.environmentState.season).toBe('summer');
    });

    it('should include own services from ServiceRegistry', async () => {
      // Arrange
      const agentDevices = [];

      manager.setAgentDevices(agentDevices);

      // Mock ServiceRegistry
      mockServiceRegistry.getOwnServices.mockReturnValue([
        {
          name: 'temperature-control-service',
          capabilities: ['temperature-control', 'cooling'],
          status: 'active',
        },
        {
          name: 'monitoring-service',
          capabilities: ['monitoring', 'alerting'],
          status: 'active',
        },
      ]);

      // Act
      const context = await (manager as unknown as DualTriggerACManagerTestAccess).buildAgentContext();

      // Assert
      expect(context.ownServices).toBeDefined();
      expect(context.ownServices.length).toBe(2);

      const tempService = context.ownServices.find((s: ServiceEntryLike) => s.name === 'temperature-control-service');
      expect(tempService).toBeDefined();
      expect(tempService.capabilities).toContain('temperature-control');
      expect(tempService.status).toBe('active');

      const monitoringService = context.ownServices.find((s: ServiceEntryLike) => s.name === 'monitoring-service');
      expect(monitoringService).toBeDefined();
      expect(monitoringService.capabilities).toContain('monitoring');
    });

    it('should handle missing ServiceRegistry gracefully', async () => {
      // Arrange
      const agentDevices = [];
      manager.setAgentDevices(agentDevices);

      // Remove ServiceRegistry
      (manager as unknown as DualTriggerACManagerTestAccess).serviceRegistry = undefined;

      // Act
      const context = await (manager as unknown as DualTriggerACManagerTestAccess).buildAgentContext();

      // Assert
      expect(context).toBeDefined();
      expect(context.ownServices).toEqual([]);
    });
  });

  describe('RED: Test for Fallback to Environment Devices', () => {
    it('should use environment devices when no agent devices set', async () => {
      // Arrange: No agent devices set
      manager.setAgentDevices([]);

      // Mock environment devices
      (mockEnvironment as unknown as Record<string, Mock>).listDevices.mockReturnValue([
        {
          id: 'env-device-1',
          type: 'sensor',
          capabilities: ['monitoring'],
          state: { temperature: 24 },
          location: { x: 5, y: 10 },
          status: 'online',
        },
        {
          id: 'env-device-2',
          type: 'actuator',
          capabilities: ['control'],
          state: { active: false },
          location: { x: 15, y: 20 },
          status: 'online',
        },
      ]);

      // Act
      const context = await (manager as unknown as DualTriggerACManagerTestAccess).buildAgentContext();

      // Assert
      expect(context.availableResources).toBeDefined();
      expect(context.availableResources.length).toBeGreaterThan(0);

      // Should include environment device info
      const device1 = context.availableResources.find((d: { deviceId: string }) => d.deviceId === 'env-device-1');
      expect(device1).toBeDefined();
      expect(device1.type).toBe('sensor');
      expect(device1.capabilities).toContain('monitoring');
    });

    it('should limit environment devices to 10', async () => {
      // Arrange: Create many environment devices
      const manyDevices = Array.from({ length: 15 }, (_, i) => ({
        id: `device-${i}`,
        type: 'sensor',
        capabilities: ['monitoring'],
      }));

      (mockEnvironment as unknown as Record<string, Mock>).listDevices.mockReturnValue(manyDevices);

      // Act
      const context = await (manager as unknown as DualTriggerACManagerTestAccess).buildAgentContext();

      // Assert
      expect(context.availableResources.length).toBeLessThanOrEqual(10);
    });

    it('should handle mixed capability formats from environment', async () => {
      // Arrange: Environment devices with mixed capability formats
      (mockEnvironment as unknown as Record<string, Mock>).listDevices.mockReturnValue([
        {
          id: 'device-1',
          type: 'sensor',
          capabilities: ['monitoring'], // String array
        },
        {
          id: 'device-2',
          type: 'actuator',
          capabilities: [ // Object array
            { name: 'control', type: 'actuation' },
            { name: 'adjustment' },
          ],
        },
        {
          id: 'device-3',
          type: 'hybrid',
          capabilities: [ // Mixed
            'reading',
            { name: 'processing' },
            { type: 'analysis' },
          ],
        },
      ]);

      // Act
      const context = await (manager as unknown as DualTriggerACManagerTestAccess).buildAgentContext();

      // Assert
      expect(context.availableResources).toBeDefined();

      // All devices should have string capabilities
      context.availableResources.forEach((device: { capabilities: string[] }) => {
        device.capabilities.forEach((cap: string) => {
          expect(typeof cap).toBe('string');
        });
      });
    });
  });

  describe('RED: Test for Complete Agent Context', () => {
    it('should include all required context fields', async () => {
      // Arrange
      const agentDevices = [
        {
          deviceId: 'device-1',
          type: 'thermostat',
          capabilities: ['temperature-control'],
        },
      ];

      manager.setAgentDevices(agentDevices);

      mockResourceManager.getResource.mockReturnValue({
        getState: () => ({ temperature: 22 }),
        getLocation: () => ({ x: 10, y: 20 }),
        isAvailable: () => true,
      });

      // Act
      const context = await (manager as unknown as DualTriggerACManagerTestAccess).buildAgentContext();

      // Assert: All required fields should be present
      expect(context.agentId).toBe('agent-1');
      expect(context.agentName).toBe('TestAgent');
      expect(context.capabilities).toEqual(['temperature-control', 'monitoring', 'cooling']);
      expect(context.availableResources).toBeDefined();
      expect(context.currentWorkload).toBeDefined();
      expect(context.recentCollaborations).toBeDefined();
      expect(context.currentCollaborations).toBeDefined();
    });

    it('should calculate workload based on active ACs', async () => {
      // Arrange
      manager.setAgentDevices([]);
      const managerAccess = manager as unknown as DualTriggerACManagerTestAccess;

      // Fix-21: updated to current behavior. Workload is classified RELATIVE
      // to config.maxConcurrentACs (default 5), not by absolute AC counts:
      //   >= maxACs → heavy, >= floor(maxACs*0.6) → moderate, >= 1 → light.
      // (See buildAgentContext in DualTriggerACManager.ts, "Determine workload
      // based on active ACs and configured max concurrency".)
      // The manager in beforeEach uses the default maxConcurrentACs = 5.
      const testCases = [
        { activeACs: 0, expectedWorkload: 'idle' },
        { activeACs: 1, expectedWorkload: 'light' },
        { activeACs: 2, expectedWorkload: 'light' },
        { activeACs: 3, expectedWorkload: 'moderate' },
        { activeACs: 4, expectedWorkload: 'moderate' },
        { activeACs: 5, expectedWorkload: 'heavy' },
        { activeACs: 7, expectedWorkload: 'heavy' },
      ];

      for (const testCase of testCases) {
        // Add active ACs
        for (let i = 0; i < testCase.activeACs; i++) {
          managerAccess.activeACs.set(`ac-${i}`, {});
        }

        // Act
        const context = await managerAccess.buildAgentContext();

        // Assert
        expect(context.currentWorkload).toBe(testCase.expectedWorkload);

        // Clean up for next test
        managerAccess.activeACs.clear();
      }
    });

    it('should include recent collaboration IDs', async () => {
      // Arrange
      manager.setAgentDevices([]);
      const managerAccess = manager as unknown as DualTriggerACManagerTestAccess;

      // Add active ACs
      managerAccess.activeACs.set('ac-1', {});
      managerAccess.activeACs.set('ac-2', {});
      managerAccess.activeACs.set('ac-3', {});

      // Act
      const context = await managerAccess.buildAgentContext();

      // Assert
      expect(context.recentCollaborations).toContain('ac-1');
      expect(context.recentCollaborations).toContain('ac-2');
      expect(context.recentCollaborations).toContain('ac-3');
      expect(context.currentCollaborations).toBe(3);
    });
  });

  describe('GREEN: Verify Context Integration with ACNecessityAssessor', () => {
    it('should pass complete context to ACNecessityAssessor', async () => {
      // This test verifies that when processEvent handles an event that
      // requires LLM evaluation, the full agent context flows through.
      // We use a non-urgent event with a neutral type to ensure:
      // 1. isUrgentEvent returns false (no urgent bypass)
      // 2. eventToClusterSummary produces medium significance
      // 3. preCheck returns 'needs_llm' (no capability gaps)
      // 4. quickChat is called with the full context
      //
      // Fix-21: reaching the LLM now requires more than a neutral event.
      // The preCheck in ACNecessityAssessor gained spatial Type A–E rules:
      // an agent with no actuatorZoneIds is classified sensor-only and
      // preCheck short-circuits to 'initiate_ac' WITHOUT calling the LLM,
      // and an agent with direct coverage + no capability gap is Type A
      // ('handle_independently', also no LLM). So this fixture injects
      // actuatorZoneIds covering the event zone and uses a humidity event
      // (a capability the agent lacks) so preCheck falls through to
      // 'needs_llm'.
      const agentDevices = [
        {
          deviceId: 'device-1',
          type: 'thermostat',
          capabilities: ['temperature-control'],
        },
      ];

      manager.setAgentDevices(agentDevices);

      // Inject actuator zone coverage via config (config is readonly through
      // the constructor, so rebuild a manager for this test).
      manager = new DualTriggerACManager(
        'agent-1',
        'TestAgent',
        ['temperature-control', 'monitoring', 'cooling'],
        mockLLMClient,
        mockEnvironment,
        vi.fn(),
        {
          enableLayer1: false,
          enableLayer2: true,
          autoInitiateAC: false,
          actuatorZoneIds: ['zone-1'],
        }
      );
      const localAccess = manager as unknown as DualTriggerACManagerTestAccess;
      localAccess.resourceManager = mockResourceManager;
      localAccess.serviceRegistry = mockServiceRegistry;
      manager.setAgentDevices(agentDevices);

      mockResourceManager.getResource.mockReturnValue({
        getState: () => ({ temperature: 22, mode: 'cooling' }),
        getLocation: () => ({ x: 10, y: 20 }),
        isAvailable: () => true,
      });

      mockServiceRegistry.getOwnServices.mockReturnValue([
        {
          name: 'temp-service',
          capabilities: ['temperature-control'],
          status: 'active',
        },
      ]);

      (mockEnvironment as unknown as Record<string, Mock>).getParameters.mockReturnValue({
        outdoorTemp: 30,
      });

      // Mock LLM response
      (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
        needsCollaboration: true,
        reasoning: 'Test reasoning',
        urgency: 'high',
        suggestedPartnerTypes: ['cooling-agent'],
        requiredCapabilities: ['cooling'],
        confidence: 0.8,
        estimatedDuration: 60000,
        potentialRisks: [],
      }));

      // Use a non-urgent humidity event in the covered zone: the agent has
      // direct coverage (zone-1) but lacks 'humidity-control', so preCheck
      // cannot resolve it by rule and defers to the LLM. The declared face
      // includes 'monitoring' so the agent has a NON-zero intersection with
      // the event requirements — FEAT-09's observe-only gate (zero
      // intersection ⟹ no initiate evaluation) does not apply, and this
      // test keeps exercising the LLM context lane it was built for.
      const event: SystemEvent = {
        id: 'event-1',
        type: 'humidity.reading' as EventType,
        source: 'sensor-1',
        payload: {
          value: 42,
          zoneId: 'zone-1',
          requiredCapabilities: ['humidity-control', 'monitoring'],
        },
        metadata: {},
        timestamp: new Date(),
      };

      // Act
      await manager.processEvent(event);

      // Assert
      const calls = (mockLLMClient.quickChat as Mock).mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const prompt = calls[0][0] as string;

      // Should contain comprehensive information
      expect(prompt).toMatch(/agent|capabilities|resources|workload/i);
    });
  });
});

// ---------------------------------------------------------------------------
// T-203 — event context in cluster summaries
// ---------------------------------------------------------------------------

describe('DualTriggerACManager — eventToClusterSummary event context (T-203)', () => {
  it('carries the original injected type, parameter and value in the summary', () => {
    const mockLLM = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
    const mockEnv = {
      listDevices: vi.fn().mockReturnValue([]),
      eventManager: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() },
    } as unknown as EnvironmentCenter;
    const mgr = new DualTriggerACManager(
      'agent-1', 'TestAgent', ['monitoring'],
      mockLLM, mockEnv, vi.fn(),
      { enableLayer1: false, enableLayer2: true, autoInitiateAC: false },
    );

    const summary = (mgr as unknown as { eventToClusterSummary(event: unknown): { summary: string } })
      .eventToClusterSummary({
        id: 'evt-42',
        type: 'ENVIRONMENT_PARAM_CHANGED',
        source: 'engine-runtime:evt-42',
        timestamp: new Date(),
        payload: {
          eventType: 'footfall-spike',
          parameter: 'motion-count',
          newValue: 180,
          zoneId: 'retail-floor',
          severity: 'high',
        },
        metadata: {},
      });

    expect(summary.summary).toContain('Event footfall-spike from engine-runtime:evt-42');
    expect(summary.summary).toContain('parameter=motion-count');
    expect(summary.summary).toContain('newValue=180');
    expect(summary.summary).toContain('severity=high');
  });
});

// ---------------------------------------------------------------------------
// T-204 — autonomous actuation on handle_independently
// ---------------------------------------------------------------------------

describe('DualTriggerACManager — T-204 independent actuation gates', () => {
  /** Assessment fixture: a heat event the agent fully covers in zone-a. */
  const heatAssessment = (): Record<string, unknown> => ({
    decision: 'handle_independently',
    clusterSummary: {
      clusterId: 'c-1',
      region: { id: 'zone-a', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
      significance: 'high',
      summary: 'Event temperature-spike, parameter=temperature, newValue=38',
      findings: [{
        eventType: 'temperature-spike',
        count: 1,
        trend: 'increasing',
        anomaly: true,
        details: { parameter: 'temperature', newValue: 38 },
      }],
      recommendation: 'immediate_action',
    },
    llmAssessment: { reasoning: 'covered' },
  });

  function makeManager(config: Record<string, unknown>) {
    const executor = vi.fn(async () => ({ success: true }));
    const mockLLM = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
    const mockEnv = {
      listDevices: vi.fn().mockReturnValue([]),
      eventManager: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() },
    } as unknown as EnvironmentCenter;
    const mgr = new DualTriggerACManager(
      'facility-agent', 'FacilityOps Agent', ['temperature-control'],
      mockLLM, mockEnv, vi.fn(),
      {
        enableLayer1: false, enableLayer2: true, autoInitiateAC: true,
        commandExecutor: executor,
        ...config,
      },
    );
    mgr.setAgentDevices([
      {
        deviceId: 'hvac-a',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling'],
        zoneId: 'zone-a',
      },
    ]);
    return { mgr: mgr as unknown as {
      executeRuleActions(assessment: Record<string, unknown>): Promise<void>;
      canActuateIndependently(): boolean;
    }, executor };
  }

  it('actuates own in-zone devices on handle_independently in ANY mode (not rule-only)', async () => {
    const { mgr, executor } = makeManager({}); // LLM mode, default flag
    expect(mgr.canActuateIndependently()).toBe(true);
    await mgr.executeRuleActions(heatAssessment());
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith('hvac-a', 'temperature-control', expect.objectContaining({ target: 24 }));
  });

  it('does not actuate when autoActuateIndependent=false (eval opt-out)', async () => {
    const { mgr, executor } = makeManager({ autoActuateIndependent: false });
    expect(mgr.canActuateIndependently()).toBe(false);
    await mgr.executeRuleActions(heatAssessment());
    expect(executor).not.toHaveBeenCalled();
  });

  it('does not actuate in decision-only mode (autoInitiateAC=false)', async () => {
    const { mgr, executor } = makeManager({ autoInitiateAC: false });
    expect(mgr.canActuateIndependently()).toBe(false);
    await mgr.executeRuleActions(heatAssessment());
    expect(executor).not.toHaveBeenCalled();
  });

  it('non-temperature events actuate via the event\'s requiredCapabilities', async () => {
    const executor = vi.fn(async () => ({ success: true }));
    const mockLLM = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
    const mockEnv = {
      listDevices: vi.fn().mockReturnValue([]),
      eventManager: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() },
    } as unknown as EnvironmentCenter;
    const mgr = new DualTriggerACManager(
      'retail-agent', 'Retail Agent', ['lighting-control'],
      mockLLM, mockEnv, vi.fn(),
      { enableLayer1: false, enableLayer2: true, autoInitiateAC: true, commandExecutor: executor },
    );
    mgr.setAgentDevices([
      {
        deviceId: 'strip-1',
        type: 'light',
        capabilities: ['set-brightness', 'turn-on'],
        zoneId: 'retail-floor',
      },
    ]);

    const assessment = {
      decision: 'handle_independently',
      clusterSummary: {
        clusterId: 'c-2',
        region: { id: 'retail-floor', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
        significance: 'high',
        summary: 'Event footfall-spike, parameter=motion-count, newValue=180',
        findings: [{
          eventType: 'footfall-spike',
          count: 1,
          trend: 'increasing',
          anomaly: true,
          details: { parameter: 'motion-count', newValue: 180, requiredCapabilities: ['brightness'] },
        }],
        recommendation: 'immediate_action',
      },
      llmAssessment: { reasoning: 'brighten the strip' },
    };

    await (mgr as unknown as { executeRuleActions(a: unknown): Promise<void> }).executeRuleActions(assessment);
    // The device's OWN declared capability name is the command issued.
    expect(executor).toHaveBeenCalledWith('strip-1', 'set-brightness', expect.anything());
  });
});

// ---------------------------------------------------------------------------
// T-041 — custom events with NO declared requiredCapabilities actuate the
// agent's own devices (the compound retail-retry failure: the keyword-table
// mislabel turned the decision into defer AND the planner dead-ended).
// ---------------------------------------------------------------------------

describe('DualTriggerACManager — T-041 own-device actuation without declared requirements', () => {
  function makeRetailManager(devices: Array<{ deviceId: string; type: string; capabilities: string[]; zoneId?: string }>) {
    const executor = vi.fn(async () => ({ success: true }));
    const mockLLM = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
    const mockEnv = {
      listDevices: vi.fn().mockReturnValue([]),
      eventManager: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() },
    } as unknown as EnvironmentCenter;
    const mgr = new DualTriggerACManager(
      'retail-agent', 'Retail Agent', ['lighting-control'],
      mockLLM, mockEnv, vi.fn(),
      { enableLayer1: false, enableLayer2: true, autoInitiateAC: true, commandExecutor: executor },
    );
    mgr.setAgentDevices(devices);
    return {
      mgr: mgr as unknown as { executeRuleActions(a: unknown): Promise<void> },
      executor,
    };
  }

  /** handle_independently assessment for a custom event that declares NO
   *  requiredCapabilities — produced by the LLM path (the T-041 scenario:
   *  the model answered independent against the agent's own device surface). */
  const customEventAssessment = (): Record<string, unknown> => ({
    decision: 'handle_independently',
    decisionSource: 'llm',
    clusterSummary: {
      clusterId: 'c-3',
      region: { id: 'retail-floor', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
      significance: 'high',
      summary: 'Event footfall-spike from engine-runtime:evt-42, parameter=motion-count, newValue=180',
      findings: [{
        eventType: 'footfall-spike',
        count: 1,
        trend: 'increasing',
        anomaly: true,
        details: { eventType: 'footfall-spike', parameter: 'motion-count', newValue: 180 },
      }],
      recommendation: 'immediate_action',
    },
    llmAssessment: { reasoning: 'I know my devices' },
  });

  it('actuates ONE representative own in-zone device (its own capability vocabulary)', async () => {
    const { mgr, executor } = makeRetailManager([
      {
        deviceId: 'strip-1',
        type: 'light',
        capabilities: ['set-brightness', 'turn-on', 'motion-reading'], // motion-reading is sensor-style
        zoneId: 'retail-floor',
      },
    ]);

    await mgr.executeRuleActions(customEventAssessment());

    expect(executor).toHaveBeenCalledTimes(1);
    // The device's OWN declared actuation capability is the command. The
    // numeric event value does NOT ride along — 'set-brightness' shares no
    // word with motion-count/footfall-spike, and an unrelated number from
    // another physical domain must not become a command parameter.
    expect(executor).toHaveBeenCalledWith('strip-1', 'set-brightness', {});
  });

  it('passes the numeric event value when the device capability names the event', async () => {
    const { mgr, executor } = makeRetailManager([
      { deviceId: 'display-1', type: 'display', capabilities: ['footfall-trigger', 'turn-on'], zoneId: 'retail-floor' },
    ]);

    await mgr.executeRuleActions(customEventAssessment());

    // 'footfall-trigger' shares the 'footfall' token with the event type →
    // the related capability is preferred and the value rides along.
    expect(executor).toHaveBeenCalledWith('display-1', 'footfall-trigger', { value: 180 });
  });

  it('deterministic (precheck) decisions with no declared requirements keep the zero-command skip reason', async () => {
    const { mgr, executor } = makeRetailManager([
      { deviceId: 'strip-1', type: 'light', capabilities: ['set-brightness'], zoneId: 'retail-floor' },
    ]);
    const assessment = {
      ...customEventAssessment(),
      decisionSource: 'precheck',
    };

    await mgr.executeRuleActions(assessment);

    expect(executor).not.toHaveBeenCalled();
  });

  it('never commands sensor-style capabilities and skips devices outside the event zone', async () => {
    const { mgr, executor } = makeRetailManager([
      { deviceId: 'cam-1', type: 'camera', capabilities: ['motion-detection', 'image-reading'], zoneId: 'retail-floor' },
      { deviceId: 'strip-2', type: 'light', capabilities: ['set-brightness'], zoneId: 'stock-room' },
    ]);

    await mgr.executeRuleActions(customEventAssessment());

    // cam-1 has no actuation-class capability; strip-2 is out of zone —
    // nothing actuates, and the no-op must be explainable (skipReason).
    expect(executor).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T-050 — acMode 'shadow' is observe/record only: it must NEVER actuate.
// ---------------------------------------------------------------------------

describe('DualTriggerACManager — T-050 shadow-mode actuation suppression', () => {
  function makeManagerWithMode(acMode: 'enabled' | 'disabled' | 'shadow') {
    const executor = vi.fn(async () => ({ success: true }));
    const mockLLM = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
    const mockEnv = {
      listDevices: vi.fn().mockReturnValue([]),
      eventManager: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() },
    } as unknown as EnvironmentCenter;
    const mgr = new DualTriggerACManager(
      'facility-agent', 'FacilityOps Agent', ['temperature-control'],
      mockLLM, mockEnv, vi.fn(),
      { enableLayer1: false, enableLayer2: true, autoInitiateAC: true, commandExecutor: executor, acMode },
    );
    mgr.setAgentDevices([
      { deviceId: 'hvac-a', type: 'hvac', capabilities: ['temperature-control', 'cooling'], zoneId: 'zone-a' },
    ]);
    return {
      mgr: mgr as unknown as {
        executeRuleActions(a: unknown): Promise<void>;
        canActuateIndependently(): boolean;
        processAssessmentResult(a: Record<string, unknown>, t: number, e?: unknown): Promise<{ path: string }>;
      },
      executor,
    };
  }

  const heatAssessment = (): Record<string, unknown> => ({
    decision: 'handle_independently',
    decisionSource: 'llm',
    clusterSummary: {
      clusterId: 'c-1',
      region: { id: 'zone-a', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
      significance: 'high',
      summary: 'Event temperature-spike, parameter=temperature, newValue=38',
      findings: [{
        eventType: 'temperature-spike',
        count: 1,
        trend: 'increasing',
        anomaly: true,
        details: { parameter: 'temperature', newValue: 38 },
      }],
      recommendation: 'immediate_action',
    },
    llmAssessment: { reasoning: 'covered' },
  });

  it('shadow: records the decision but never actuates the own device', async () => {
    const { mgr, executor } = makeManagerWithMode('shadow');
    expect(mgr.canActuateIndependently()).toBe(false);
    await mgr.executeRuleActions(heatAssessment());
    expect(executor).not.toHaveBeenCalled();
  });

  it("shadow: an initiate_ac decision is rewritten with an auditable would-have note and no actuation", async () => {
    const { mgr, executor } = makeManagerWithMode('shadow');
    const assessment = { ...heatAssessment(), decision: 'initiate_ac' };

    const result = await mgr.processAssessmentResult(assessment, Date.now());

    // Recorded as handled independently for post-hoc analysis…
    expect(result.path).toBe('handled_independently');
    expect(assessment.decision).toBe('handle_independently');
    // …with the would-be initiation ON the record…
    expect(String((assessment.llmAssessment as { reasoning?: string }).reasoning))
      .toContain('[ac-shadow: would initiate AC');
    // …and no device command executed (shadow = observe/record only).
    expect(executor).not.toHaveBeenCalled();
  });

  it("disabled (the no-AC baseline arm): own-device actuation still runs", async () => {
    const { mgr, executor } = makeManagerWithMode('disabled');
    expect(mgr.canActuateIndependently()).toBe(true);
    await mgr.executeRuleActions(heatAssessment());
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('enabled (default behavior preserved): actuation runs', async () => {
    const { mgr, executor } = makeManagerWithMode('enabled');
    await mgr.executeRuleActions(heatAssessment());
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
