/**
 * ResourceAutoGenerator Unit Tests
 *
 * Tests for automatic resource generation with semantic metadata
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ResourceAutoGenerator, type ResourceGenDeviceContext, type ResourceGenEnvContext } from '../ResourceAutoGenerator.js';

describe('ResourceAutoGenerator', () => {
  let generator: ResourceAutoGenerator;

  beforeEach(() => {
    generator = new ResourceAutoGenerator();
  });

  describe('generateFromDevice', () => {
    const device: ResourceGenDeviceContext = {
      id: 'device-1',
      name: 'Temperature Sensor',
      type: 'temperature-sensor',
      location: 'living-room',
      state: { temperature: 22.5 },
      capabilities: [
        { name: 'readTemperature', type: 'read' },
      ],
    };

    it('should generate resource from device', () => {
      const result = generator.generateFromDevice(device, 'owner-1');

      expect(result).toBeDefined();
      expect(result.deviceId).toBe('device-1');
      expect(result.resourceType).toBe('temperature-sensor');
    });

    it('should generate resource with correct owner', () => {
      const result = generator.generateFromDevice(device, 'owner-1');

      expect(result.resource.owner).toBe('owner-1');
    });

    it('should generate semantic tags', () => {
      const result = generator.generateFromDevice(device, 'owner-1');

      expect(result.semanticTags.length).toBeGreaterThan(0);
      expect(result.semanticTags).toContain('temperature');
      expect(result.semanticTags).toContain('sensor');
    });

    it('should generate LLM specification', () => {
      const result = generator.generateFromDevice(device, 'owner-1');

      expect(result.llmSpec).toBeDefined();
      expect(result.llmSpec).toContain('Temperature Sensor');
      expect(result.llmSpec).toContain('device-1');
    });

    it('should include capabilities in LLM spec', () => {
      const result = generator.generateFromDevice(device, 'owner-1');

      expect(result.llmSpec).toContain('readTemperature');
    });

    it('should include location in LLM spec', () => {
      const result = generator.generateFromDevice(device, 'owner-1');

      expect(result.llmSpec).toContain('living-room');
    });
  });

  describe('inferCategory', () => {
    it('should infer environmental-sensor category for temperature sensor', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Temp Sensor',
        type: 'temperature-sensor',
      };

      const category = generator.inferCategory(device);

      expect(category).toBe('environmental-sensor');
    });

    it('should infer environmental-sensor category for humidity sensor', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Humidity Sensor',
        type: 'humidity-sensor',
      };

      const category = generator.inferCategory(device);

      expect(category).toBe('environmental-sensor');
    });

    it('should infer security-sensor category for motion sensor', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Motion Sensor',
        type: 'motion-sensor',
      };

      const category = generator.inferCategory(device);

      expect(category).toBe('security-sensor');
    });

    it('should infer hvac-actuator category for thermostat', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Thermostat',
        type: 'thermostat',
      };

      const category = generator.inferCategory(device);

      expect(category).toBe('hvac-actuator');
    });

    it('should infer lighting-actuator category for smart light', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Smart Light',
        type: 'smart-light',
      };

      const category = generator.inferCategory(device);

      expect(category).toBe('lighting-actuator');
    });

    it('should infer security-actuator category for smart lock', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Smart Lock',
        type: 'smart-lock',
      };

      const category = generator.inferCategory(device);

      expect(category).toBe('security-actuator');
    });

    it('should infer sensor category from capabilities', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Custom Sensor',
        type: 'unknown-type',  // Use a type that won't match any existing key
        capabilities: [
          { name: 'read', type: 'read' },
        ],
      };

      const category = generator.inferCategory(device);

      expect(category).toBe('sensor');
    });

    it('should infer actuator category from capabilities', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Custom Actuator',
        type: 'unknown-type',  // Use a type that won't match any existing key
        capabilities: [
          { name: 'write', type: 'write' },
        ],
      };

      const category = generator.inferCategory(device);

      expect(category).toBe('actuator');
    });

    it('should infer composite category from mixed capabilities', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Hybrid Device',
        type: 'unknown-type',  // Use a type that won't match any existing key
        capabilities: [
          { name: 'read', type: 'read' },
          { name: 'write', type: 'write' },
        ],
      };

      const category = generator.inferCategory(device);

      expect(category).toBe('composite');
    });
  });

  describe('inferSemanticTags', () => {
    it('should generate temperature-related tags', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Temperature Sensor',
        type: 'temperature-sensor',
      };

      const tags = generator.inferSemanticTags(device);

      expect(tags).toContain('temperature');
      expect(tags).toContain('environmental');
      expect(tags).toContain('iot');
      expect(tags).toContain('sensor');
    });

    it('should generate humidity-related tags', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Humidity Sensor',
        type: 'humidity-sensor',
      };

      const tags = generator.inferSemanticTags(device);

      expect(tags).toContain('humidity');
      expect(tags).toContain('environmental');
    });

    it('should generate security-related tags for motion sensor', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Motion Sensor',
        type: 'motion-sensor',
      };

      const tags = generator.inferSemanticTags(device);

      expect(tags).toContain('motion');
      expect(tags).toContain('security');
      expect(tags).toContain('presence');
    });

    it('should include capability names as tags', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Device',
        type: 'sensor',
        capabilities: [
          { name: 'customCapability', type: 'read' },
        ],
      };

      const tags = generator.inferSemanticTags(device);

      expect(tags).toContain('customcapability');
    });

    it('should include capability types as tags', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Device',
        type: 'sensor',
        capabilities: [
          { name: 'read', type: 'read' },
        ],
      };

      const tags = generator.inferSemanticTags(device);

      expect(tags).toContain('read');
    });

    it('should include location-based tags', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Device',
        type: 'sensor',
        location: 'building/floor1/room1',
      };

      const tags = generator.inferSemanticTags(device);

      expect(tags).toContain('location-aware');
      expect(tags).toContain('building');
      expect(tags).toContain('floor1');
      expect(tags).toContain('room1');
    });

    it('should include criticality tag from metadata', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Critical Device',
        type: 'sensor',
        metadata: { criticality: 'critical' },
      };

      const tags = generator.inferSemanticTags(device);

      expect(tags).toContain('criticality:critical');
    });

    it('should include zone tag from metadata', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Device',
        type: 'sensor',
        metadata: { zone: 'zone-1' },
      };

      const tags = generator.inferSemanticTags(device);

      expect(tags).toContain('zone:zone-1');
    });
  });

  describe('generateLlmSpec', () => {
    it('should generate markdown specification', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Temperature Sensor',
        type: 'temperature-sensor',
        location: 'living-room',
      };

      const spec = generator.generateLlmSpec(device, 'sensor', ['temperature', 'iot'], undefined);

      expect(spec).toContain('# Resource: Temperature Sensor');
      expect(spec).toContain('ID: dev-1');
      expect(spec).toContain('Type: temperature-sensor');
      expect(spec).toContain('Category: sensor');
    });

    it('should include description section', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Sensor',
        type: 'sensor',
      };

      const spec = generator.generateLlmSpec(device, 'sensor', [], undefined);

      expect(spec).toContain('## Description');
    });

    it('should include capabilities section', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Device',
        type: 'sensor',
        capabilities: [
          { name: 'readTemp', type: 'read' },
        ],
      };

      const spec = generator.generateLlmSpec(device, 'sensor', [], undefined);

      expect(spec).toContain('## Capabilities');
      expect(spec).toContain('readTemp');
    });

    it('should include location section', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Device',
        type: 'sensor',
        location: 'living-room',
      };

      const spec = generator.generateLlmSpec(device, 'sensor', [], undefined);

      expect(spec).toContain('## Location');
      expect(spec).toContain('living-room');
    });

    it('should include tags section', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Device',
        type: 'sensor',
      };

      const spec = generator.generateLlmSpec(device, 'sensor', ['temperature', 'iot'], undefined);

      expect(spec).toContain('## Tags');
      expect(spec).toContain('`temperature`');
      expect(spec).toContain('`iot`');
    });

    it('should include environment context when provided', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Device',
        type: 'sensor',
      };

      const envContext: ResourceGenEnvContext = {
        id: 'env-1',
        name: 'Smart Home',
        type: 'residential',
      };

      const spec = generator.generateLlmSpec(device, 'sensor', [], envContext);

      expect(spec).toContain('## Environment Context');
      expect(spec).toContain('Smart Home');
      expect(spec).toContain('residential');
    });

    it('should include state section when state exists', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Device',
        type: 'sensor',
        state: { temperature: 25, humidity: 50 },
      };

      const spec = generator.generateLlmSpec(device, 'sensor', [], undefined);

      expect(spec).toContain('## Current State');
      expect(spec).toContain('temperature');
      expect(spec).toContain('25');
    });

    it('should include usage hints', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Device',
        type: 'sensor',
      };

      const spec = generator.generateLlmSpec(device, 'environmental-sensor', [], undefined);

      expect(spec).toContain('## Usage Hints');
    });
  });

  describe('generateFromDevices', () => {
    it('should generate resources for multiple devices', () => {
      const devices: ResourceGenDeviceContext[] = [
        { id: 'dev-1', name: 'Sensor 1', type: 'temperature-sensor' },
        { id: 'dev-2', name: 'Sensor 2', type: 'humidity-sensor' },
      ];

      const results = generator.generateFromDevices(devices, 'owner-1');

      expect(results.length).toBe(2);
      expect(results[0].deviceId).toBe('dev-1');
      expect(results[1].deviceId).toBe('dev-2');
    });

    it('should include environment context in all resources', () => {
      const devices: ResourceGenDeviceContext[] = [
        { id: 'dev-1', name: 'Sensor 1', type: 'sensor' },
        { id: 'dev-2', name: 'Sensor 2', type: 'sensor' },
      ];

      const envContext: ResourceGenEnvContext = {
        id: 'env-1',
        name: 'Test Environment',
      };

      const results = generator.generateFromDevices(devices, 'owner-1', envContext);

      results.forEach(result => {
        expect(result.llmSpec).toContain('Test Environment');
      });
    });
  });

  describe('Resource properties', () => {
    it('should have correct id', () => {
      const device: ResourceGenDeviceContext = {
        id: 'device-123',
        name: 'Test Device',
        type: 'sensor',
      };

      const result = generator.generateFromDevice(device, 'owner-1');

      expect(result.resource.id).toBe('device-123');
    });

    it('should have correct name', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'My Temperature Sensor',
        type: 'sensor',
      };

      const result = generator.generateFromDevice(device, 'owner-1');

      expect(result.resource.name).toBe('My Temperature Sensor');
    });

    it('should have tags set', () => {
      const device: ResourceGenDeviceContext = {
        id: 'dev-1',
        name: 'Device',
        type: 'temperature-sensor',
      };

      const result = generator.generateFromDevice(device, 'owner-1');

      expect(result.resource.tags.length).toBeGreaterThan(0);
    });
  });
});
