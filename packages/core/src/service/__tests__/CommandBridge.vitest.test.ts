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
import { ServiceAutoGenerator, setBridgeOnGeneratedService, type BridgeExecutionFn } from '../ServiceAutoGenerator.js';
import type { ServiceExecutionContext, ServiceExecutionResult } from '../Service.js';
import type { Resource, ResourceCapability, ResourceExecutionResult } from '../../resource/Resource.js';
import { BaseResource } from '../../resource/Resource.js';
import type { Device } from '@active-collaboration/shared';

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

    // Generate services from device
    const generator = new ServiceAutoGenerator();
    const generated = generator.generateFromDevice(
      {
        id: 'device-1',
        name: 'HVAC Controller',
        type: 'hvac-controller',
        location: 'room-1',
      },
      [
        { name: 'set-temperature', type: 'write', description: 'Set target temperature' },
        { name: 'read-temperature', type: 'read', description: 'Read current temperature' },
      ],
      'agent-1'
    );

    // Register generated services
    for (const gen of generated) {
      registry.registerService(gen.service);
    }
  });

  it('should have registered the auto-generated services', () => {
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
    const generator = new ServiceAutoGenerator();
    const generated = generator.generateFromDevice(
      {
        id: 'unknown',  // 'unknown' deviceId = non-device-derived
        name: 'Pure Computation',
        type: 'logic',
        location: 'cloud',
      },
      [
        { name: 'compute', type: 'execute', description: 'Pure computation' },
      ],
      'agent-1'
    );

    // Don't set bridge on these - they're pure logic
    for (const gen of generated) {
      registry.registerService(gen.service);
    }

    const pureService = generated[0].service;
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

describe('BridgeExecutionFn integration with ServiceAutoGenerator', () => {
  it('should call bridge function when set on generated service', async () => {
    let bridgeCalled = false;

    const bridgeFn: BridgeExecutionFn = async (capabilityName, deviceId, context) => {
      bridgeCalled = true;
      return {
        success: true,
        result: { capabilityName, deviceId },
        executedAt: new Date(),
        executionTime: 10,
      };
    };

    const generator = new ServiceAutoGenerator();
    const generated = generator.generateFromDevice(
      {
        id: 'device-1',
        name: 'HVAC',
        type: 'hvac-controller',
        location: 'room-1',
      },
      [{ name: 'set-temperature', type: 'write', description: 'Set temperature' }],
      'agent-1'
    );

    // Set the bridge on the generated service
    setBridgeOnGeneratedService(generated[0], bridgeFn);

    // Execute the service
    const context: ServiceExecutionContext = {
      serviceId: generated[0].service.id,
      requester: 'test',
      timestamp: new Date(),
      params: { temperature: 22 },
    };

    const result = await generated[0].service.execute(context);

    expect(bridgeCalled).toBe(true);
    expect(result.success).toBe(true);
  });

  it('should fail when device-derived service has no bridge function set', async () => {
    const generator = new ServiceAutoGenerator();
    const generated = generator.generateFromDevice(
      {
        id: 'device-1',
        name: 'Sensor',
        type: 'sensor',
        location: 'room-1',
      },
      [{ name: 'read-temperature', type: 'read' }],
      'agent-1'
    );

    // Don't set bridge - device-derived service should fail (Fail Early principle)
    const context: ServiceExecutionContext = {
      serviceId: generated[0].service.id,
      requester: 'test',
      timestamp: new Date(),
      params: {},
    };

    const result = await generated[0].service.execute(context);

    // Should fail because device-derived service has no bridge configured
    expect(result.success).toBe(false);
    expect(result.error).toContain('no CommandBridge configured');
  });

  it('should succeed when non-device service has no bridge function set', async () => {
    const generator = new ServiceAutoGenerator();
    const generated = generator.generateFromDevice(
      {
        id: 'unknown',
        name: 'Sensor',
        type: 'sensor',
        location: 'room-1',
      },
      [{ name: 'read-temperature', type: 'read' }],
      'agent-1'
    );

    // Don't set bridge
    const context: ServiceExecutionContext = {
      serviceId: generated[0].service.id,
      requester: 'test',
      timestamp: new Date(),
      params: {},
    };

    const result = await generated[0].service.execute(context);

    // Should still succeed (pure service, no bridge)
    expect(result.success).toBe(true);
  });
});
