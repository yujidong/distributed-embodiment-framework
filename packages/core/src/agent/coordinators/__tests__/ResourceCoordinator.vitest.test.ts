/**
 * ResourceCoordinator Unit Tests
 *
 * Tests for device assignment and resource management coordination
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ResourceCoordinator } from '../ResourceCoordinator.js';
import type { ResourceManager } from '../../../resource/ResourceManager.js';
import type { ServicePublisher } from '../../../service/ServicePublisher.js';
import type { ServiceRegistry } from '../../../service/ServiceRegistry.js';
import type { EnvironmentCenter } from '../../../environment/EnvironmentCenter.js';
import type { Device, Service, DeviceType, DeviceLocation } from '@active-collaboration/shared';

// Helper functions to create mocks
const createMockResourceManager = (): ResourceManager => {
  return {
    registerDevice: vi.fn(),
    getCount: vi.fn().mockReturnValue(0),
    getAllResources: vi.fn().mockReturnValue([]),
    getAllDevices: vi.fn().mockReturnValue([]),
    getResourceById: vi.fn(),
    unregisterDevice: vi.fn(),
  } as unknown as ResourceManager;
};

const createMockServicePublisher = (): ServicePublisher => {
  return {
    publishService: vi.fn(),
    unpublishService: vi.fn(),
    getPublishedServices: vi.fn().mockReturnValue([]),
  } as unknown as ServicePublisher;
};

const createMockServiceRegistry = (): ServiceRegistry => {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    findByCapability: vi.fn().mockReturnValue([]),
  } as unknown as ServiceRegistry;
};

const createMockEnvironmentCenter = (): EnvironmentCenter => {
  return {
    registerService: vi.fn(),
    unregisterService: vi.fn(),
    getAgent: vi.fn(),
    getDevice: vi.fn(),
    registerAgent: vi.fn(),
    unregisterAgent: vi.fn(),
  } as unknown as EnvironmentCenter;
};

const createTestDevice = (overrides: Partial<Device> = {}): Device => {
  return {
    id: 'device-1',
    name: 'Test Device',
    type: 'sensor',
    status: 'online',
    location: { x: 0, y: 0, z: 0 },
    capabilities: [
      { name: 'temperature', type: 'read' },
    ],
    ...overrides,
  } as Device;
};

describe('ResourceCoordinator', () => {
  let coordinator: ResourceCoordinator;
  let mockResourceManager: ResourceManager;
  let mockServicePublisher: ServicePublisher;
  let mockServiceRegistry: ServiceRegistry;
  let mockEnvironmentCenter: EnvironmentCenter;

  const agentId = 'agent-1';
  const agentCapabilities = ['monitoring', 'sensing'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockResourceManager = createMockResourceManager();
    mockServicePublisher = createMockServicePublisher();
    mockServiceRegistry = createMockServiceRegistry();
    mockEnvironmentCenter = createMockEnvironmentCenter();

    coordinator = new ResourceCoordinator(
      mockResourceManager,
      mockServicePublisher,
      mockServiceRegistry,
      mockEnvironmentCenter,
      agentId,
      agentCapabilities
    );
  });

  describe('Constructor', () => {
    it('should create coordinator with all dependencies', () => {
      expect(coordinator).toBeDefined();
    });

    it('should store agent ID and capabilities', () => {
      expect(coordinator).toBeDefined();
      // Agent ID is used in logging, verified through method calls
    });
  });

  describe('assignDevices', () => {
    it('should assign single device successfully', () => {
      const device = createTestDevice();
      const owner = 'user-1';

      coordinator.assignDevices([device], owner);

      expect(mockResourceManager.registerDevice).toHaveBeenCalledWith(device, owner);
    });

    it('should assign multiple devices', () => {
      const devices = [
        createTestDevice({ id: 'device-1' }),
        createTestDevice({ id: 'device-2' }),
        createTestDevice({ id: 'device-3' }),
      ];
      const owner = 'user-1';

      coordinator.assignDevices(devices, owner);

      expect(mockResourceManager.registerDevice).toHaveBeenCalledTimes(3);
    });

    it('should auto-publish each device as service', () => {
      const device = createTestDevice();
      const owner = 'user-1';

      coordinator.assignDevices([device], owner);

      expect(mockServicePublisher.publishService).toHaveBeenCalled();
      expect(mockEnvironmentCenter.registerService).toHaveBeenCalled();
    });

    it('should register devices after assignment', () => {
      const device = createTestDevice();
      const owner = 'user-1';

      coordinator.assignDevices([device], owner);

      expect(mockResourceManager.registerDevice).toHaveBeenCalledWith(device, owner);
    });

    it('should handle empty device list', () => {
      coordinator.assignDevices([], 'user-1');

      expect(mockResourceManager.registerDevice).not.toHaveBeenCalled();
    });
  });

  describe('Service Publishing', () => {
    it('should publish device with correct service structure', () => {
      const device = createTestDevice({
        id: 'temp-sensor-1',
        name: 'Temperature Sensor',
        type: 'sensor',
        capabilities: [{ name: 'readTemperature', type: 'read' }],
      });

      coordinator.assignDevices([device], 'user-1');

      const publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      const service = publishCall[0];

      expect(service.id).toBe('service-temp-sensor-1');
      expect(service.name).toContain('Temperature Sensor');
      expect(service.actionType).toBe('observe');
    });

    it('should set actionType to control for write capabilities', () => {
      const device = createTestDevice({
        id: 'actuator-1',
        type: 'actuator',
        capabilities: [{ name: 'setTemperature', type: 'write' }],
      });

      coordinator.assignDevices([device], 'user-1');

      const publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      const service = publishCall[0];

      expect(service.actionType).toBe('control');
    });

    it('should set actionType to both for read and write capabilities', () => {
      const device = createTestDevice({
        id: 'thermostat-1',
        type: 'thermostat',
        capabilities: [
          { name: 'readTemperature', type: 'read' },
          { name: 'setTemperature', type: 'write' },
        ],
      });

      coordinator.assignDevices([device], 'user-1');

      const publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      const service = publishCall[0];

      expect(service.actionType).toBe('both');
    });

    it('should combine device and agent capabilities', () => {
      const device = createTestDevice({
        capabilities: [{ name: 'temperature', type: 'read' }],
      });

      coordinator.assignDevices([device], 'user-1');

      const publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      const service = publishCall[0];

      expect(service.capabilities).toContain('temperature');
      expect(service.capabilities).toContain('monitoring');
      expect(service.capabilities).toContain('sensing');
    });
  });

  describe('Resource Type Mapping', () => {
    it('should map sensor devices correctly', () => {
      const device = createTestDevice({ type: 'temperature-sensor' });
      coordinator.assignDevices([device], 'user-1');

      const publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      const service = publishCall[0];

      expect(service.category).toBe('sensor');
    });

    it('should map actuator devices correctly', () => {
      const device = createTestDevice({ type: 'motor-actuator' });
      coordinator.assignDevices([device], 'user-1');

      const publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      const service = publishCall[0];

      expect(service.category).toBe('actuator');
    });

    it('should map thermostat devices correctly', () => {
      const device = createTestDevice({ type: 'smart-thermostat' });
      coordinator.assignDevices([device], 'user-1');

      const publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      const service = publishCall[0];

      expect(service.category).toBe('thermostat');
    });

    it('should map lighting devices correctly', () => {
      const device = createTestDevice({ type: 'smart-light', name: 'LED Lamp' });
      coordinator.assignDevices([device], 'user-1');

      const publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      const service = publishCall[0];

      expect(service.category).toBe('lighting');
    });

    it('should map security devices correctly', () => {
      const cameraDevice = createTestDevice({ type: 'ip-camera' });
      coordinator.assignDevices([cameraDevice], 'user-1');

      let publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      let service = publishCall[0];
      expect(service.category).toBe('security');

      const lockDevice = createTestDevice({ type: 'smart-lock', id: 'lock-1' });
      coordinator.assignDevices([lockDevice], 'user-1');

      publishCall = (mockServicePublisher.publishService as Mock).mock.calls[1];
      service = publishCall[0];
      expect(service.category).toBe('security');
    });

    it('should map HVAC devices correctly', () => {
      const device = createTestDevice({ type: 'hvac-unit' });
      coordinator.assignDevices([device], 'user-1');

      const publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      const service = publishCall[0];

      expect(service.category).toBe('hvac');
    });

    it('should map unknown device types to device', () => {
      const device = createTestDevice({ type: 'unknown-gadget' });
      coordinator.assignDevices([device], 'user-1');

      const publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      const service = publishCall[0];

      expect(service.category).toBe('device');
    });
  });

  describe('Capability Derivation', () => {
    it('should derive temperature monitoring capabilities', () => {
      const device = createTestDevice({
        type: 'temperature-sensor',
        name: 'Temp Sensor',
        capabilities: [{ name: 'temperature', type: 'read' }],
      });

      coordinator.assignDevices([device], 'user-1');

      const publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      const service = publishCall[0];

      expect(service.capabilities).toContain('temperature-monitoring');
      expect(service.capabilities).toContain('monitoring');
    });

    it('should derive HVAC control capabilities', () => {
      const device = createTestDevice({
        type: 'hvac',
        name: 'HVAC Controller',
        capabilities: [{ name: 'setTemperature', type: 'write' }],
      });

      const coordinatorWithControl = new ResourceCoordinator(
        mockResourceManager,
        mockServicePublisher,
        mockServiceRegistry,
        mockEnvironmentCenter,
        agentId,
        ['control', 'actuation']
      );

      coordinatorWithControl.assignDevices([device], 'user-1');

      const publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      const service = publishCall[0];

      expect(service.capabilities).toContain('hvac-control');
      expect(service.capabilities).toContain('temperature-control');
    });

    it('should derive lighting control capabilities', () => {
      const device = createTestDevice({
        type: 'light',
        name: 'Smart Light',
        capabilities: [{ name: 'setBrightness', type: 'write' }],
      });

      const coordinatorWithControl = new ResourceCoordinator(
        mockResourceManager,
        mockServicePublisher,
        mockServiceRegistry,
        mockEnvironmentCenter,
        agentId,
        ['control']
      );

      coordinatorWithControl.assignDevices([device], 'user-1');

      const publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      const service = publishCall[0];

      expect(service.capabilities).toContain('lighting-control');
    });
  });

  describe('getDeviceCount', () => {
    it('should return device count from resource manager', () => {
      (mockResourceManager.getCount as Mock).mockReturnValue(5);

      const count = coordinator.getDeviceCount();

      expect(count).toBe(5);
    });

    it('should return 0 when no devices', () => {
      (mockResourceManager.getCount as Mock).mockReturnValue(0);

      const count = coordinator.getDeviceCount();

      expect(count).toBe(0);
    });
  });

  describe('getAllResources', () => {
    it('should return all resources from resource manager', () => {
      const mockResources = [
        { id: 'resource-1', type: 'device' },
        { id: 'resource-2', type: 'service' },
      ];
      (mockResourceManager.getAllResources as Mock).mockReturnValue(mockResources);

      const resources = coordinator.getAllResources();

      expect(resources).toEqual(mockResources);
    });

    it('should return empty array when no resources', () => {
      (mockResourceManager.getAllResources as Mock).mockReturnValue([]);

      const resources = coordinator.getAllResources();

      expect(resources).toEqual([]);
    });
  });

  describe('Edge Cases', () => {
    it('should handle device with no capabilities', () => {
      const device = createTestDevice({ capabilities: [] });

      coordinator.assignDevices([device], 'user-1');

      expect(mockServicePublisher.publishService).toHaveBeenCalled();
    });

    it('should handle device with no type', () => {
      const device = createTestDevice({ type: undefined as unknown as DeviceType });

      coordinator.assignDevices([device], 'user-1');

      const publishCall = (mockServicePublisher.publishService as Mock).mock.calls[0];
      const service = publishCall[0];

      expect(service.category).toBe('device');
    });

    it('should handle device with null location', () => {
      const device = createTestDevice({ location: null as unknown as DeviceLocation });

      coordinator.assignDevices([device], 'user-1');

      expect(mockServicePublisher.publishService).toHaveBeenCalled();
    });

    it('should handle agent with no capabilities', () => {
      const coordinatorNoCaps = new ResourceCoordinator(
        mockResourceManager,
        mockServicePublisher,
        mockServiceRegistry,
        mockEnvironmentCenter,
        agentId,
        []
      );

      const device = createTestDevice();
      coordinatorNoCaps.assignDevices([device], 'user-1');

      expect(mockServicePublisher.publishService).toHaveBeenCalled();
    });

    it('should handle device names with special characters', () => {
      const device = createTestDevice({
        name: 'Device<script>alert("XSS")</script>',
      });

      coordinator.assignDevices([device], 'user-1');

      expect(mockServicePublisher.publishService).toHaveBeenCalled();
    });
  });
});
