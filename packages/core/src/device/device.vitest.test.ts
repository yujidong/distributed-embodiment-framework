/**
 * Device Driver Tests
 *
 * Tests for device driver abstraction layer
 */

import { describe, it, expect } from 'vitest';
// SimulatedDeviceDriver moved to src/testing/device/SimulatedDeviceDriver.ts
// For tests, import from the testing directory
import { SimulatedDeviceDriver } from '../testing/SimulatedDeviceDriver.js';
import { RealDeviceDriver } from './RealDeviceDriver.js';
import type { DeviceConfig } from './IDevice.js';
import type { RealDeviceConnection } from './RealDeviceDriver.js';

describe('Device Driver Abstraction', () => {
  describe('SimulatedDeviceDriver', () => {
    it('should create driver with correct type', () => {
      const driver = new SimulatedDeviceDriver();
      expect(driver.type).toBe('simulated');
    });

    it('should start disconnected', () => {
      const driver = new SimulatedDeviceDriver();
      const status = driver.getStatus();
      expect(status.connected).toBe(false);
      expect(status.deviceCount).toBe(0);
    });

    it('should connect successfully', async () => {
      const driver = new SimulatedDeviceDriver();
      await driver.connect();
      expect(driver.getStatus().connected).toBe(true);
    });

    it('should create a temperature sensor device', async () => {
      const driver = new SimulatedDeviceDriver();
      await driver.connect();

      const config: DeviceConfig = {
        name: 'Test Temperature Sensor',
        type: 'temperature-sensor',
        capabilities: [{ name: 'read-temperature', type: 'read', parameters: [] }],
        location: 'test-room',
      };

      const device = await driver.createDevice(config);

      expect(device).toBeDefined();
      expect(device.name).toBe('Test Temperature Sensor');
      expect(device.type).toBeDefined();
    });

    it('should track created devices', async () => {
      const driver = new SimulatedDeviceDriver();
      await driver.connect();

      const config: DeviceConfig = {
        name: 'Test Device',
        type: 'sensor',
        capabilities: [{ name: 'read', type: 'read', parameters: [] }],
        location: 'test-location',
      };

      const device = await driver.createDevice(config);

      expect(driver.getAllDevices()).toHaveLength(1);
      expect(driver.getDevice(device.id)).toBeDefined();
    });

    it('should remove devices', async () => {
      const driver = new SimulatedDeviceDriver();
      await driver.connect();

      const config: DeviceConfig = {
        name: 'Test Device',
        type: 'sensor',
        capabilities: [{ name: 'read', type: 'read', parameters: [] }],
        location: 'test-location',
      };

      const device = await driver.createDevice(config);
      driver.removeDevice(device.id);

      expect(driver.getAllDevices()).toHaveLength(0);
    });

    it('should provide supported device types', () => {
      const driver = new SimulatedDeviceDriver();
      const types = driver.getSupportedTypes();

      expect(types.length).toBeGreaterThan(0);
      expect(types.find(t => t.type === 'temperature-sensor')).toBeDefined();
      expect(types.find(t => t.type === 'hvac-controller')).toBeDefined();
    });
  });

  describe('RealDeviceDriver', () => {
    it('should create driver with correct type', () => {
      const connection: RealDeviceConnection = {
        protocol: 'mqtt',
        endpoint: 'mqtt://localhost:1883',
      };
      const driver = new RealDeviceDriver(connection);
      expect(driver.type).toBe('real');
    });

    it('should start disconnected', () => {
      const connection: RealDeviceConnection = {
        protocol: 'mqtt',
        endpoint: 'mqtt://localhost:1883',
      };
      const driver = new RealDeviceDriver(connection);
      const status = driver.getStatus();
      expect(status.connected).toBe(false);
    });

    it('should connect (placeholder implementation)', async () => {
      const connection: RealDeviceConnection = {
        protocol: 'mqtt',
        endpoint: 'mqtt://localhost:1883',
      };
      const driver = new RealDeviceDriver(connection);
      await driver.connect();
      expect(driver.getStatus().connected).toBe(true);
    });

    it('should create placeholder device when no real connection', async () => {
      const connection: RealDeviceConnection = {
        protocol: 'mqtt',
        endpoint: 'mqtt://localhost:1883',
      };
      const driver = new RealDeviceDriver(connection);
      await driver.connect();

      const config: DeviceConfig = {
        name: 'Test Real Device',
        type: 'temperature-sensor',
        capabilities: [{ name: 'read-temperature', type: 'read', parameters: [] }],
        location: 'test-room',
      };

      const device = await driver.createDevice(config);

      expect(device).toBeDefined();
      expect(device.name).toBe('Test Real Device');
      expect(device.status).toBe('offline');
    });

    it('placeholder device should indicate not available', async () => {
      const connection: RealDeviceConnection = {
        protocol: 'mqtt',
        endpoint: 'mqtt://localhost:1883',
      };
      const driver = new RealDeviceDriver(connection);
      await driver.connect();

      const config: DeviceConfig = {
        name: 'Unavailable Device',
        type: 'sensor',
        capabilities: [{ name: 'read', type: 'read', parameters: [] }],
        location: 'test-location',
      };

      const device = await driver.createDevice(config);
      expect(device.isAvailable()).toBe(false);
    });

    it('placeholder device should fail commands gracefully', async () => {
      const connection: RealDeviceConnection = {
        protocol: 'mqtt',
        endpoint: 'mqtt://localhost:1883',
      };
      const driver = new RealDeviceDriver(connection);
      await driver.connect();

      const config: DeviceConfig = {
        name: 'Placeholder Device',
        type: 'sensor',
        capabilities: [{ name: 'read', type: 'read', parameters: [] }],
        location: 'test-location',
      };

      const device = await driver.createDevice(config);
      const result = await device.executeCommand('read');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('Driver Abstraction Verification', () => {
    it('should allow switching between simulated and real drivers', async () => {
      const simDriver = new SimulatedDeviceDriver();
      await simDriver.connect();

      const realConnection: RealDeviceConnection = {
        protocol: 'http',
        endpoint: 'http://localhost:8080',
      };
      const realDriver = new RealDeviceDriver(realConnection);
      await realDriver.connect();

      const config: DeviceConfig = {
        name: 'Test Device',
        type: 'temperature-sensor',
        capabilities: [{ name: 'read-temperature', type: 'read', parameters: [] }],
        location: 'test-room',
      };

      // Create device with simulated driver
      const simDevice = await simDriver.createDevice(config);

      // Create device with real driver (placeholder)
      const realDevice = await realDriver.createDevice(config);

      // Both should implement IDevice interface
      expect(simDevice.id).toBeDefined();
      expect(realDevice.id).toBeDefined();
      expect(simDevice.executeCommand).toBeDefined();
      expect(realDevice.executeCommand).toBeDefined();
      expect(simDevice.getState).toBeDefined();
      expect(realDevice.getState).toBeDefined();
    });
  });
});
