/**
 * CognitiveAgent P12 Feature Unit Tests
 *
 * Tests for P12 features added to CognitiveAgent:
 * 1. assignDevices() syncs to DualTriggerACManager
 * 2. environmentStateSnapshot updates from ENVIRONMENT_PARAM_CHANGED events
 * 3. getEnvironmentState() returns correct snapshot data
 * 4. dualTriggerEnabled defaults to true
 * 5. Device info is used by DualTriggerACManager.buildAgentContext()
 *
 * Uses real Ollama LLMClient (skips if unavailable),
 * real EnvironmentCenter, and SimulatedDevice for device simulation.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { CognitiveAgent } from '../CognitiveAgent.js';
import { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import { LLMClient, type ChatResponse } from '@active-collaboration/llm-integration';
import { SimulatedDevice } from '@active-collaboration/simulation';
import { EventType, EventPriority } from '@active-collaboration/shared';
import type { SystemEvent } from '@active-collaboration/shared';
import type { Device, DeviceCapability } from '@active-collaboration/shared';
import type { DualTriggerACManager } from '../../decision/DualTriggerACManager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Attempt to create a real Ollama LLMClient; return null if Ollama is down. */
async function createRealLLMClient(): Promise<LLMClient | null> {
  try {
    const client = new LLMClient('ollama', {
      model: 'qwen3-14b-q4:latest',
      baseUrl: 'http://localhost:11434',
    });
    // Light health-check -- send a tiny chat request
    await client.chat({
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0,
      maxTokens: 1,
    });
    return client;
  } catch {
    return null;
  }
}

/** Build a minimal SystemEvent for ENVIRONMENT_PARAM_CHANGED. */
function makeEnvParamEvent(payload: {
  parameter: string;
  location: string;
  newValue: number | boolean;
  oldValue?: number | boolean;
}): SystemEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: EventType.ENVIRONMENT_PARAM_CHANGED,
    source: 'test-source',
    timestamp: new Date(),
    priority: EventPriority.NORMAL,
    payload,
    metadata: {},
  };
}

/** Build a simple SimulatedDevice that satisfies the Device interface. */
function createTestSimulatedDevice(id: string, deviceType: string, caps: string[]): SimulatedDevice {
  const capabilities: DeviceCapability[] = caps.map((name) => ({
    name,
    type: 'read' as const,
    parameters: [],
  }));

  const device = new SimulatedDevice({
    id,
    name: `${deviceType}-${id}`,
    type: deviceType,
    capabilities,
    location: '0,0,0',
    initialState: { power: true, temperature: 25.0 },
    behaviors: [],
  });

  return device;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('CognitiveAgent P12 Features', () => {
  let llmClient: LLMClient | null = null;
  let ollamaAvailable = false;
  let environment: EnvironmentCenter;
  let agent: CognitiveAgent;

  beforeAll(async () => {
    llmClient = await createRealLLMClient();
    ollamaAvailable = llmClient !== null;
  });

  beforeEach(() => {
    if (!ollamaAvailable) {
      return;
    }

    // Create a fresh environment for every test
    environment = new EnvironmentCenter({
      id: `p12-test-env-${Date.now()}`,
      name: 'P12 Test Environment',
      createdBy: 'p12-test-user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    agent = new CognitiveAgent({
      id: `p12-agent-${Date.now()}`,
      name: 'P12 Test Agent',
      description: 'Agent for P12 feature testing',
      owner: 'p12-test-user',
      environment,
      llmClient: llmClient!,
      capabilities: ['temperature-monitoring', 'device-control'],
    });
  });

  afterEach(() => {
    if (agent) {
      agent.stop();
    }
  });

  // =========================================================================
  // 1. assignDevices() syncs to DualTriggerACManager
  // =========================================================================
  describe('assignDevices() syncs to DualTriggerACManager', () => {
    it('should sync assigned device info to DualTriggerACManager.setAgentDevices()', () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      const sensor = createTestSimulatedDevice('sensor-001', 'temperature-sensor', [
        'temperature-sensing',
        'humidity-sensing',
      ]);

      // Register device in environment first so it can be looked up
      environment.registerDevice(sensor.getDeviceInfo() as unknown as Device, 'p12-test-user');

      // Assign the device to the agent
      agent.assignDevices([sensor.getDeviceInfo() as unknown as Device], 'p12-test-user');

      // Access the DualTriggerACManager through the public getter
      const acManager = agent.getDualTriggerACManager();
      expect(acManager).toBeDefined();

      // Verify agent devices via public getter
      const agentDevices = acManager!.getAgentDevices();

      expect(agentDevices).toHaveLength(1);
      expect(agentDevices[0].deviceId).toBe('sensor-001');
      expect(agentDevices[0].type).toBeDefined();
      expect(agentDevices[0].capabilities.length).toBeGreaterThanOrEqual(1);
    });

    it('should sync multiple devices to DualTriggerACManager', () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      const sensor = createTestSimulatedDevice('sensor-002', 'temperature-sensor', [
        'temperature-sensing',
      ]);
      const hvac = createTestSimulatedDevice('hvac-001', 'hvac-controller', [
        'temperature-control',
      ]);

      environment.registerDevice(sensor.getDeviceInfo() as unknown as Device, 'p12-test-user');
      environment.registerDevice(hvac.getDeviceInfo() as unknown as Device, 'p12-test-user');

      agent.assignDevices(
        [sensor.getDeviceInfo() as unknown as Device, hvac.getDeviceInfo() as unknown as Device],
        'p12-test-user',
      );

      const acManager = agent.getDualTriggerACManager();
      const agentDevices = acManager!.getAgentDevices();

      expect(agentDevices).toHaveLength(2);
      const ids = agentDevices.map((d) => d.deviceId);
      expect(ids).toContain('sensor-002');
      expect(ids).toContain('hvac-001');
    });
  });

  // =========================================================================
  // 2. environmentStateSnapshot updates from ENVIRONMENT_PARAM_CHANGED
  // =========================================================================
  describe('environmentStateSnapshot updates from ENVIRONMENT_PARAM_CHANGED events', () => {
    it('should update environmentStateSnapshot when handleEvent receives an ENVIRONMENT_PARAM_CHANGED event', async () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      const event = makeEnvParamEvent({
        parameter: 'temperature',
        location: 'zone-1',
        newValue: 28.5,
      });

      await agent.handleEvent(event);

      // Access snapshot via public getter (returns array)
      const snapshot = agent.getEnvironmentStateSnapshot();

      expect(snapshot).toHaveLength(1);
      const entry = snapshot.find((s) => s.key === 'zone-1:temperature');
      expect(entry).toBeDefined();
      expect(entry!.value).toBe(28.5);
      expect(entry!.location).toBe('zone-1');
      expect(entry!.timestamp).toBeInstanceOf(Date);
    });

    it('should handle multiple parameters at the same location', async () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      await agent.handleEvent(
        makeEnvParamEvent({
          parameter: 'temperature',
          location: 'zone-1',
          newValue: 26.0,
        }),
      );
      await agent.handleEvent(
        makeEnvParamEvent({
          parameter: 'humidity',
          location: 'zone-1',
          newValue: 65,
        }),
      );

      const snapshot = agent.getEnvironmentStateSnapshot();

      expect(snapshot).toHaveLength(2);
      const tempEntry = snapshot.find((s) => s.key === 'zone-1:temperature');
      const humidEntry = snapshot.find((s) => s.key === 'zone-1:humidity');
      expect(tempEntry!.value).toBe(26.0);
      expect(humidEntry!.value).toBe(65);
    });

    it('should overwrite previous value for the same location:parameter key', async () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      await agent.handleEvent(
        makeEnvParamEvent({
          parameter: 'temperature',
          location: 'zone-1',
          newValue: 20.0,
        }),
      );
      await agent.handleEvent(
        makeEnvParamEvent({
          parameter: 'temperature',
          location: 'zone-1',
          newValue: 22.5,
        }),
      );

      const snapshot = agent.getEnvironmentStateSnapshot();

      // Should have only 1 entry (overwritten)
      expect(snapshot).toHaveLength(1);
      expect(snapshot.find((s) => s.key === 'zone-1:temperature')!.value).toBe(22.5);
    });

    it('should handle boolean values in environment parameters', async () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      await agent.handleEvent(
        makeEnvParamEvent({
          parameter: 'occupied',
          location: 'room-A',
          newValue: true,
        }),
      );

      const snapshot = agent.getEnvironmentStateSnapshot();

      const entry = snapshot.find((s) => s.key === 'room-A:occupied');
      expect(entry).toBeDefined();
      expect(entry!.value).toBe(true);
    });
  });

  // =========================================================================
  // 3. getEnvironmentState() returns correct snapshot data
  // =========================================================================
  describe('getEnvironmentState() returns correct snapshot data', () => {
    it('should return the entry for a specific parameter and location', async () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      await agent.handleEvent(
        makeEnvParamEvent({
          parameter: 'temperature',
          location: 'zone-1',
          newValue: 27.3,
        }),
      );

      const result = agent.getEnvironmentState('temperature', 'zone-1');

      // When both parameter and location are provided, the method returns
      // { value, timestamp } or {} if not found.
      expect(result).toBeDefined();
      expect(result.value).toBe(27.3);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should return empty object when querying non-existent parameter/location', () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      const result = agent.getEnvironmentState('nonexistent', 'nowhere');
      expect(result).toBeDefined();
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('should return all snapshot data when called without parameters', async () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      await agent.handleEvent(
        makeEnvParamEvent({
          parameter: 'temperature',
          location: 'zone-1',
          newValue: 25.0,
        }),
      );
      await agent.handleEvent(
        makeEnvParamEvent({
          parameter: 'humidity',
          location: 'zone-2',
          newValue: 55,
        }),
      );

      const result = agent.getEnvironmentState();

      // Should contain both entries keyed by "location:parameter"
      expect(result).toBeDefined();
      expect(Object.keys(result)).toHaveLength(2);
      expect(result['zone-1:temperature']).toBeDefined();
      expect((result['zone-1:temperature'] as { value: number }).value).toBe(25.0);
      expect(result['zone-2:humidity']).toBeDefined();
      expect((result['zone-2:humidity'] as { value: number }).value).toBe(55);
    });

    it('should return empty object when no events have been received', () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      const result = agent.getEnvironmentState();
      expect(result).toBeDefined();
      expect(Object.keys(result)).toHaveLength(0);
    });
  });

  // =========================================================================
  // 4. dualTriggerEnabled defaults to true
  // =========================================================================
  describe('dualTriggerEnabled defaults to true', () => {
    it('should have dualTriggerEnabled set to true after construction', () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      const enabled = agent.getDualTriggerEnabled();
      expect(enabled).toBe(true);
    });

    it('should still be true without calling enableDualTriggerAC()', () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      // The agent was constructed in beforeEach without explicitly calling
      // enableDualTriggerAC().  Verify it defaults to true.
      const enabled = agent.getDualTriggerEnabled();
      expect(enabled).toBe(true);
    });

    it('should be true after explicitly calling enableDualTriggerAC()', () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      agent.enableDualTriggerAC();
      const enabled = agent.getDualTriggerEnabled();
      expect(enabled).toBe(true);
    });
  });

  // =========================================================================
  // 5. Device info is used by DualTriggerACManager.buildAgentContext()
  // =========================================================================
  describe('Device info is used by DualTriggerACManager.buildAgentContext()', () => {
    it('should have devices available in DualTriggerACManager after assignDevices', () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      const sensor = createTestSimulatedDevice('ctx-sensor-001', 'temperature-sensor', [
        'temperature-sensing',
      ]);

      environment.registerDevice(sensor.getDeviceInfo() as unknown as Device, 'p12-test-user');
      agent.assignDevices([sensor.getDeviceInfo() as unknown as Device], 'p12-test-user');

      const acManager = agent.getDualTriggerACManager();
      expect(acManager).toBeDefined();

      // The DualTriggerACManager should have stored the device info via public getter
      const agentDevices = acManager!.getAgentDevices();

      expect(agentDevices.length).toBeGreaterThan(0);

      // Verify the specific device data is present
      const device = agentDevices.find((d) => d.deviceId === 'ctx-sensor-001');
      expect(device).toBeDefined();
      expect(device!.type).toBeDefined();
      expect(device!.capabilities).toBeDefined();
      expect(Array.isArray(device!.capabilities)).toBe(true);
    });

    it('should use agent-assigned devices (not environment devices) when devices are set', async () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      // Register a sensor device in the environment and assign it to the agent
      const sensor = createTestSimulatedDevice('ctx-sensor-002', 'temperature-sensor', [
        'temperature-sensing',
        'humidity-sensing',
      ]);
      environment.registerDevice(sensor.getDeviceInfo() as unknown as Device, 'p12-test-user');
      agent.assignDevices([sensor.getDeviceInfo() as unknown as Device], 'p12-test-user');

      const acManager = agent.getDualTriggerACManager();

      // Call buildAgentContext() via public method to verify it uses agent-assigned devices
      const context = await acManager!.buildAgentContext();

      expect(context).toBeDefined();
      expect(context.availableResources).toBeDefined();
      expect(Array.isArray(context.availableResources)).toBe(true);
      expect(context.availableResources.length).toBeGreaterThan(0);

      // The first resource should correspond to our assigned device
      const resource = context.availableResources[0];
      expect(resource.deviceId).toBe('ctx-sensor-002');
      expect(resource.type).toBeDefined();
      expect(resource.capabilities).toBeDefined();
    });

    it('should have empty agentDevices when no devices are assigned', () => {
      if (!ollamaAvailable) {
        console.warn('Skipping test - Ollama unavailable');
        return;
      }

      const acManager = agent.getDualTriggerACManager();
      const agentDevices = acManager!.getAgentDevices();
      expect(agentDevices).toHaveLength(0);
    });
  });
});
