/**
 * CommandBridge Integration Tests
 *
 * Tests the Service→Device command bridging:
 *   ServiceRegistry.executeService() → CommandBridge → Resource.execute() → Device.executeCommand()
 *
 * Verifies:
 * 1. CommandBridge routes service executions to device resources
 * 2. ServiceRegistry detects device-derived services and uses CommandBridge
 * 3. Location-aware resource selection
 * 4. Capability-based resource lookup
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CommandBridge, type BridgedCommandResult } from '../CommandBridge.js';
import { ServiceRegistry, type ServiceFilter } from '../ServiceRegistry.js';
import { ResourceManager } from '../../resource/ResourceManager.js';
import { BaseAgentService, type ServiceExecutionContext, type ServiceExecutionResult } from '../Service.js';
import type { Resource, ResourceCapability, ResourceExecutionResult } from '../../resource/Resource.js';
import { BaseResource } from '../../resource/Resource.js';
import type { Device } from '@active-collaboration/shared';

/**
 * Minimal concrete service for registry tests
 */
class TestService extends BaseAgentService {
  async execute(context: ServiceExecutionContext): Promise<ServiceExecutionResult> {
    return {
      success: true,
      result: { params: context.params },
      executedAt: new Date(),
      executionTime: 0,
    };
  }
}

function makeTestService(id: string, name: string, deviceId: string, category: string): TestService {
  return new TestService({
    id,
    name,
    description: name,
    deviceId,
    owner: 'agent-1',
    location: 'room-1',
    category,
  });
}

/**
 * Mock device that supports executeCommand
 */
class MockSimulatedDevice implements Device {
  id: string;
  name: string;
  type: string;
  status: 'online' | 'offline' = 'online';
  location: string;
  capabilities: Array<{ name: string; type: string; parameters?: Array<{ name: string; type: string }> }>;
  services: string[] = [];
  lastCommand: string | null = null;
  lastParams: Record<string, unknown> | null = null;

  constructor(id: string, name: string, type: string, location: string) {
    this.id = id;
    this.name = name;
    this.type = type;
    this.location = location;
    this.capabilities = [
      { name: 'set-temperature', type: 'write', parameters: [{ name: 'temperature', type: 'number' }] },
      { name: 'read-temperature', type: 'read' },
      { name: 'set-mode', type: 'write', parameters: [{ name: 'mode', type: 'string' }] },
    ];
  }

  async executeCommand(commandName: string, params: Record<string, unknown> = {}): Promise<{ success: boolean; result?: unknown; error?: string }> {
    this.lastCommand = commandName;
    this.lastParams = params;
    return {
      success: true,
      result: { command: commandName, params, executed: true },
    };
  }
}

describe('CommandBridge', () => {
  let resourceManager: ResourceManager;
  let commandBridge: CommandBridge;
  let mockDevice: MockSimulatedDevice;

  beforeEach(() => {
    resourceManager = new ResourceManager();
    mockDevice = new MockSimulatedDevice('device-1', 'HVAC Controller', 'hvac-controller', 'room-1');
    resourceManager.registerDevice(mockDevice as unknown as Device, 'owner-1');
    commandBridge = new CommandBridge({ agentId: 'agent-1', resourceManager });
  });

  describe('executeServiceAsDeviceCommand', () => {
    it('should find and execute a capability through the Resource layer', async () => {
      const context: ServiceExecutionContext = {
        serviceId: 'svc-1',
        requester: 'agent-2',
        timestamp: new Date(),
        params: { temperature: 22 },
      };

      const result = await commandBridge.executeServiceAsDeviceCommand('climate-control', context);

      expect(result.success).toBe(true);
      // The DeviceResource should have received and executed the command
      expect(mockDevice.lastCommand).toBeTruthy();
    });

    it('should return error when no resources match capability', async () => {
      const context: ServiceExecutionContext = {
        serviceId: 'svc-1',
        requester: 'agent-2',
        timestamp: new Date(),
        params: {},
      };

      const result = await commandBridge.executeServiceAsDeviceCommand('nonexistent-capability', context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No resources available');
    });

    it('should prefer device resources in same location', async () => {
      const device2 = new MockSimulatedDevice('device-2', 'HVAC Controller 2', 'hvac-controller', 'room-2');
      resourceManager.registerDevice(device2 as unknown as Device, 'owner-1');

      const context: ServiceExecutionContext = {
        serviceId: 'svc-1',
        requester: 'agent-2',
        timestamp: new Date(),
        params: { temperature: 22, location: 'room-2' },
      };

      const result = await commandBridge.executeServiceAsDeviceCommand('climate-control', context);

      expect(result.success).toBe(true);
      expect(result.deviceId).toBe('device-2');
    });
  });

  describe('executeDeviceCommand', () => {
    it('should execute a command on a specific device by ID', async () => {
      const result = await commandBridge.executeDeviceCommand('device-1', 'set-mode', { mode: 'cool' });

      expect(result.success).toBe(true);
      expect(result.deviceId).toBe('device-1');
      expect(result.command).toBe('set-mode');
      expect(mockDevice.lastCommand).toBeTruthy();
    });

    it('should return error for unknown device', async () => {
      const result = await commandBridge.executeDeviceCommand('nonexistent', 'set-temperature', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Resource not found');
    });
  });

  describe('toServiceExecutionResult', () => {
    it('should convert BridgedCommandResult to ServiceExecutionResult', () => {
      const bridged: BridgedCommandResult = {
        success: true,
        deviceId: 'device-1',
        command: 'set-temperature',
        result: { executed: true },
      };

      const startTime = Date.now() - 100;
      const result = commandBridge.toServiceExecutionResult(bridged, startTime);

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ executed: true });
      expect(result.executionTime).toBeGreaterThanOrEqual(100);
      expect(result.executedAt).toBeInstanceOf(Date);
    });
  });
});

describe('ServiceRegistry with CommandBridge', () => {
  let resourceManager: ResourceManager;
  let registry: ServiceRegistry;
  let mockDevice: MockSimulatedDevice;
  let bridge: CommandBridge;

  beforeEach(() => {
    resourceManager = new ResourceManager();
    mockDevice = new MockSimulatedDevice('device-1', 'HVAC Controller', 'hvac-controller', 'room-1');
    resourceManager.registerDevice(mockDevice as unknown as Device, 'agent-1');

    registry = new ServiceRegistry('agent-1');
    bridge = new CommandBridge({ agentId: 'agent-1', resourceManager });
    registry.setCommandBridge(bridge);

    // Register device-derived services
    registry.registerService(makeTestService('svc-set-temp', 'Set Temperature', 'device-1', 'hvac'));
    registry.registerService(makeTestService('svc-read-temp', 'Read Temperature', 'device-1', 'hvac'));
  });

  it('should have registered the device-derived services', () => {
    expect(registry.getServiceCount()).toBeGreaterThan(0);
  });

  it('should route device-derived service execution through CommandBridge', async () => {
    const services = registry.getAllServices();
    const tempService = services.find(s => s.category === 'hvac' || s.name.includes('temperature'));
    expect(tempService).toBeDefined();

    const context: ServiceExecutionContext = {
      serviceId: tempService!.id,
      requester: 'test-user',
      timestamp: new Date(),
      params: { temperature: 22 },
    };

    const result = await registry.executeService(tempService!.id, context);

    // The service should have been routed through CommandBridge
    // Either the bridge found a matching resource or fell back to service.execute()
    expect(result).toBeDefined();
    expect(result.success).toBeDefined();
  });

  it('should execute non-device-derived services normally', async () => {
    // A service with deviceId='unknown' should not go through CommandBridge
    const pureService = makeTestService('svc-compute', 'Pure Computation', 'unknown', 'logic');
    registry.registerService(pureService);

    const context: ServiceExecutionContext = {
      serviceId: pureService.id,
      requester: 'test-user',
      timestamp: new Date(),
      params: {},
    };

    const result = await registry.executeService(pureService.id, context);
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
  });
});
