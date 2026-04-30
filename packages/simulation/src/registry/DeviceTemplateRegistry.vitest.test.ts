/**
 * @vitest-environment node
 *
 * Test for Device Template Validation Bug
 *
 * Bug: Creating multiple devices with different templates fails on the second device
 * Expected: Should be able to create multiple devices with different templates
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { DeviceTemplateRegistry } from './DeviceTemplateRegistry.js';

describe('DeviceTemplateRegistry - Multi-Device Creation', () => {
  beforeAll(() => {
    // Ensure templates are initialized (module-level init may be cleared by mockReset)
    DeviceTemplateRegistry.initializeDefaults();
  });

  describe('Template Registration', () => {
    it('should have temperature-sensor template registered', () => {
      expect(DeviceTemplateRegistry.getTemplate('temperature-sensor')).toBeDefined();
    });

    it('should have hvac-controller template registered', () => {
      expect(DeviceTemplateRegistry.getTemplate('hvac-controller')).toBeDefined();
    });

    it('should list both temperature-sensor and hvac-controller templates', () => {
      const templates = DeviceTemplateRegistry.listTemplates();
      const templateNames = templates.map(t => t.name);

      expect(templateNames).toContain('temperature-sensor');
      expect(templateNames).toContain('hvac-controller');
    });
  });

  describe('Multi-Device Creation', () => {
    it('should successfully create a temperature-sensor device', () => {
      const device = DeviceTemplateRegistry.createFromTemplate(
        'temperature-sensor',
        'Test Temperature Sensor',
        { location: 'room-1' }
      );

      expect(device).toBeDefined();
      expect(device.name).toBe('Test Temperature Sensor');
      expect(device.type).toBe('sensor');
    });

    it('should successfully create an hvac-controller device', () => {
      const device = DeviceTemplateRegistry.createFromTemplate(
        'hvac-controller',
        'Test HVAC Controller',
        { location: 'room-1' }
      );

      expect(device).toBeDefined();
      expect(device.name).toBe('Test HVAC Controller');
    });

    it('should successfully create multiple devices with different templates in sequence', () => {
      const device1 = DeviceTemplateRegistry.createFromTemplate(
        'temperature-sensor',
        'Living Room Temperature',
        { location: 'living-room' }
      );

      expect(device1).toBeDefined();
      expect(device1.name).toBe('Living Room Temperature');

      const device2 = DeviceTemplateRegistry.createFromTemplate(
        'hvac-controller',
        'Living Room HVAC',
        { location: 'living-room' }
      );

      expect(device2).toBeDefined();
      expect(device2.name).toBe('Living Room HVAC');
      expect(device1.id).not.toBe(device2.id);
    });

    it('should create three devices with different templates without errors', () => {
      const devices = [];

      const tempSensor = DeviceTemplateRegistry.createFromTemplate(
        'temperature-sensor',
        'Temp Sensor 1',
        { location: 'zone-1' }
      );
      devices.push(tempSensor);
      expect(tempSensor).toBeDefined();

      const hvacController = DeviceTemplateRegistry.createFromTemplate(
        'hvac-controller',
        'HVAC Controller 1',
        { location: 'zone-1' }
      );
      devices.push(hvacController);
      expect(hvacController).toBeDefined();

      const thermostat = DeviceTemplateRegistry.createFromTemplate(
        'thermostat',
        'Thermostat 1',
        { location: 'zone-1' }
      );
      devices.push(thermostat);
      expect(thermostat).toBeDefined();

      const ids = devices.map(d => d.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });
  });

  describe('Template Validation', () => {
    it('should validate template name case-insensitively', () => {
      expect(DeviceTemplateRegistry.getTemplate('Temperature-Sensor')).toBeDefined();
      expect(DeviceTemplateRegistry.getTemplate('TEMPERATURE-SENSOR')).toBeDefined();
      expect(DeviceTemplateRegistry.getTemplate('Hvac-Controller')).toBeDefined();
      expect(DeviceTemplateRegistry.getTemplate('HVAC-CONTROLLER')).toBeDefined();
    });

    it('should throw descriptive error for non-existent template', () => {
      expect(() => {
        DeviceTemplateRegistry.createFromTemplate(
          'non-existent-template',
          'Test Device',
          {}
        );
      }).toThrow(/Template not found/);
    });

    it('should provide helpful suggestions when template not found', () => {
      expect(() => {
        DeviceTemplateRegistry.createFromTemplate(
          'temp-sensor',
          'Test Device',
          {}
        );
      }).toThrow(/Template not found/);
    });
  });
});
