/**
 * ServiceAutoGenerator Unit Tests
 *
 * Tests for automatic semantic service generation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ServiceAutoGenerator, type ServiceGenCapability, type ServiceGenDeviceContext } from '../ServiceAutoGenerator.js';
import { ServiceOntologyClass, SemanticAnnotationType } from '../SemanticService.js';

describe('ServiceAutoGenerator', () => {
  let generator: ServiceAutoGenerator;

  beforeEach(() => {
    generator = new ServiceAutoGenerator();
  });

  describe('generateFromDevice', () => {
    const device: ServiceGenDeviceContext = {
      id: 'device-1',
      name: 'Temperature Sensor',
      type: 'temperature-sensor',
      location: 'living-room',
    };

    const capabilities: ServiceGenCapability[] = [
      {
        name: 'readTemperature',
        type: 'read',
        description: 'Read temperature value',
      },
    ];

    it('should generate services from device capabilities', () => {
      const results = generator.generateFromDevice(device, capabilities, 'owner-1');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].capabilityName).toBe('readTemperature');
      expect(results[0].service).toBeDefined();
    });

    it('should set correct owner on generated services', () => {
      const results = generator.generateFromDevice(device, capabilities, 'owner-1');

      expect(results[0].service.getOwner()).toBe('owner-1');
    });

    it('should set location on generated services', () => {
      const results = generator.generateFromDevice(device, capabilities, 'owner-1');

      expect(results[0].service.location).toBe('living-room');
    });

    it('should generate multiple services for multiple capabilities', () => {
      const multiCapabilities: ServiceGenCapability[] = [
        { name: 'readTemperature', type: 'read' },
        { name: 'readHumidity', type: 'read' },
        { name: 'setTarget', type: 'write' },
      ];

      const results = generator.generateFromDevice(device, multiCapabilities, 'owner-1');

      expect(results.length).toBeGreaterThan(3); // 3 individual + composite services
    });

    it('should generate composite monitoring service for multiple read capabilities', () => {
      const readCapabilities: ServiceGenCapability[] = [
        { name: 'readTemperature', type: 'read' },
        { name: 'readHumidity', type: 'read' },
      ];

      const results = generator.generateFromDevice(device, readCapabilities, 'owner-1');

      const compositeMonitoring = results.find(r => r.capabilityName === 'monitoring-composite');
      expect(compositeMonitoring).toBeDefined();
      expect(compositeMonitoring?.ontologyClass).toBe(ServiceOntologyClass.IOT_MONITORING_SERVICE);
    });

    it('should generate composite control service for multiple write capabilities', () => {
      const writeCapabilities: ServiceGenCapability[] = [
        { name: 'setTemperature', type: 'write' },
        { name: 'setMode', type: 'control' },
      ];

      const results = generator.generateFromDevice(device, writeCapabilities, 'owner-1');

      const compositeControl = results.find(r => r.capabilityName === 'control-composite');
      expect(compositeControl).toBeDefined();
      expect(compositeControl?.ontologyClass).toBe(ServiceOntologyClass.IOT_CONTROL_SERVICE);
    });
  });

  describe('inferOntologyClasses', () => {
    it('should infer temperature ontology for temperature capability', () => {
      const capability: ServiceGenCapability = {
        name: 'readTemperature',
        type: 'read',
      };

      const classes = generator.inferOntologyClasses(capability);

      expect(classes).toContain(ServiceOntologyClass.SSN_TEMPERATURE_SERVICE);
    });

    it('should infer humidity ontology for humidity capability', () => {
      const capability: ServiceGenCapability = {
        name: 'readHumidity',
        type: 'read',
      };

      const classes = generator.inferOntologyClasses(capability);

      expect(classes).toContain(ServiceOntologyClass.SSN_HUMIDITY_SERVICE);
    });

    it('should infer lighting ontology for light capability', () => {
      const capability: ServiceGenCapability = {
        name: 'controlLight',
        type: 'write',
      };

      const classes = generator.inferOntologyClasses(capability);

      expect(classes).toContain(ServiceOntologyClass.SAREF_LIGHTING_SERVICE);
    });

    it('should infer HVAC ontology for hvac capability', () => {
      const capability: ServiceGenCapability = {
        name: 'controlHVAC',
        type: 'write',
      };

      const classes = generator.inferOntologyClasses(capability);

      expect(classes).toContain(ServiceOntologyClass.SAREF_HVAC_SERVICE);
    });

    it('should infer security ontology for lock capability', () => {
      const capability: ServiceGenCapability = {
        name: 'controlLock',
        type: 'write',
      };

      const classes = generator.inferOntologyClasses(capability);

      expect(classes).toContain(ServiceOntologyClass.SAREF_SECURITY_SERVICE);
    });

    it('should infer energy ontology for power capability', () => {
      const capability: ServiceGenCapability = {
        name: 'monitorPower',
        type: 'read',
      };

      const classes = generator.inferOntologyClasses(capability);

      expect(classes).toContain(ServiceOntologyClass.SAREF_ENERGY_SERVICE);
    });

    it('should infer sensing service for read type', () => {
      const capability: ServiceGenCapability = {
        name: 'genericRead',
        type: 'read',
      };

      const classes = generator.inferOntologyClasses(capability);

      expect(classes).toContain(ServiceOntologyClass.SSN_SENSING_SERVICE);
    });

    it('should infer actuation service for write type', () => {
      const capability: ServiceGenCapability = {
        name: 'genericWrite',
        type: 'write',
      };

      const classes = generator.inferOntologyClasses(capability);

      expect(classes).toContain(ServiceOntologyClass.SAREF_ACTUATION_SERVICE);
    });
  });

  describe('inferSemanticCapabilities', () => {
    it('should infer basic capabilities', () => {
      const capability: ServiceGenCapability = {
        name: 'readTemperature',
        type: 'read',
      };

      const capabilities = generator.inferSemanticCapabilities(capability);

      expect(capabilities).toContain('Provides readTemperature functionality');
      expect(capabilities).toContain('Can read sensor data');
    });

    it('should infer write capabilities', () => {
      const capability: ServiceGenCapability = {
        name: 'setTemperature',
        type: 'write',
      };

      const capabilities = generator.inferSemanticCapabilities(capability);

      expect(capabilities).toContain('Can control/actuate');
      expect(capabilities).toContain('Accepts commands');
    });

    it('should infer event capabilities', () => {
      const capability: ServiceGenCapability = {
        name: 'onMotion',
        type: 'event',
      };

      const capabilities = generator.inferSemanticCapabilities(capability);

      expect(capabilities).toContain('Generates events');
      expect(capabilities).toContain('Supports event subscription');
    });

    it('should infer temperature-specific capabilities', () => {
      const capability: ServiceGenCapability = {
        name: 'readTemperature',
        type: 'read',
      };

      const capabilities = generator.inferSemanticCapabilities(capability);

      expect(capabilities).toContain('Measures temperature');
    });

    it('should infer humidity-specific capabilities', () => {
      const capability: ServiceGenCapability = {
        name: 'readHumidity',
        type: 'read',
      };

      const capabilities = generator.inferSemanticCapabilities(capability);

      expect(capabilities).toContain('Measures relative humidity');
    });

    it('should infer lighting-specific capabilities', () => {
      const capability: ServiceGenCapability = {
        name: 'controlLighting',
        type: 'write',
      };

      const capabilities = generator.inferSemanticCapabilities(capability);

      expect(capabilities.some(c => c.includes('lighting'))).toBe(true);
    });
  });

  describe('inferServiceSchema', () => {
    it('should generate input schema from parameters', () => {
      const capability: ServiceGenCapability = {
        name: 'setTemperature',
        type: 'write',
        parameters: [
          { name: 'targetTemp', type: 'number', required: true },
          { name: 'unit', type: 'string', required: false },
        ],
      };

      const { inputSchema } = generator.inferServiceSchema(capability);

      expect(inputSchema.properties.targetTemp).toBeDefined();
      expect(inputSchema.properties.targetTemp.type).toBe('number');
      expect(inputSchema.required).toContain('targetTemp');
      expect(inputSchema.required).not.toContain('unit');
    });

    it('should generate output schema for read capability', () => {
      const capability: ServiceGenCapability = {
        name: 'readTemperature',
        type: 'read',
      };

      const { outputSchema } = generator.inferServiceSchema(capability);

      expect(outputSchema.properties.success).toBeDefined();
      expect(outputSchema.properties.data).toBeDefined();
      expect(outputSchema.properties.value).toBeDefined();
      expect(outputSchema.properties.unit).toBeDefined();
    });

    it('should map parameter types correctly', () => {
      const capability: ServiceGenCapability = {
        name: 'test',
        type: 'write',
        parameters: [
          { name: 'numParam', type: 'number' },
          { name: 'strParam', type: 'string' },
          { name: 'boolParam', type: 'boolean' },
          { name: 'objParam', type: 'object' },
          { name: 'arrParam', type: 'array' },
        ],
      };

      const { inputSchema } = generator.inferServiceSchema(capability);

      expect(inputSchema.properties.numParam.type).toBe('number');
      expect(inputSchema.properties.strParam.type).toBe('string');
      expect(inputSchema.properties.boolParam.type).toBe('boolean');
      expect(inputSchema.properties.objParam.type).toBe('object');
      expect(inputSchema.properties.arrParam.type).toBe('array');
    });
  });

  describe('generateFromDevices', () => {
    it('should generate services for multiple devices', () => {
      const devices = [
        {
          device: { id: 'dev-1', name: 'Sensor 1', type: 'temperature-sensor' },
          capabilities: [{ name: 'readTemperature', type: 'read' }],
        },
        {
          device: { id: 'dev-2', name: 'Sensor 2', type: 'humidity-sensor' },
          capabilities: [{ name: 'readHumidity', type: 'read' }],
        },
      ];

      const results = generator.generateFromDevices(devices, 'owner-1');

      expect(results.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Generated service properties', () => {
    it('should have semantic annotations', () => {
      const device: ServiceGenDeviceContext = {
        id: 'device-1',
        name: 'Temperature Sensor',
        type: 'sensor',
        location: 'room-1',
      };

      const capabilities: ServiceGenCapability[] = [
        { name: 'readTemperature', type: 'read' },
      ];

      const results = generator.generateFromDevice(device, capabilities, 'owner-1');
      const service = results[0].service;

      expect(service.semanticAnnotations).toBeDefined();
      expect(service.semanticAnnotations.size).toBeGreaterThan(0);
    });

    it('should have ontology class', () => {
      const device: ServiceGenDeviceContext = {
        id: 'device-1',
        name: 'Temperature Sensor',
        type: 'sensor',
      };

      const capabilities: ServiceGenCapability[] = [
        { name: 'readTemperature', type: 'read' },
      ];

      const results = generator.generateFromDevice(device, capabilities, 'owner-1');

      expect(results[0].ontologyClass).toBeDefined();
    });

    it('should be available by default', () => {
      const device: ServiceGenDeviceContext = {
        id: 'device-1',
        name: 'Sensor',
        type: 'sensor',
      };

      const capabilities: ServiceGenCapability[] = [
        { name: 'read', type: 'read' },
      ];

      const results = generator.generateFromDevice(device, capabilities, 'owner-1');

      expect(results[0].service.isAvailable()).toBe(true);
    });

    it('should have execute method', async () => {
      // Use 'unknown' deviceId to test pure-service execution (no bridge needed)
      const device: ServiceGenDeviceContext = {
        id: 'unknown',
        name: 'Pure Service',
        type: 'logic',
      };

      const capabilities: ServiceGenCapability[] = [
        { name: 'read', type: 'read' },
      ];

      const results = generator.generateFromDevice(device, capabilities, 'owner-1');
      const result = await results[0].service.execute({
        serviceId: results[0].service.id,
        requester: 'test',
        timestamp: new Date(),
        params: {},
      });

      expect(result.success).toBe(true);
    });
  });
});
