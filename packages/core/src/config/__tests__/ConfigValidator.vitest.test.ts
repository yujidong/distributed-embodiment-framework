/**
 * ConfigValidator Unit Tests
 *
 * Tests for declarative configuration validation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigValidator } from '../ConfigValidator.js';
import type { DeclarativeConfig } from '../types.js';

describe('ConfigValidator', () => {
  let validator: ConfigValidator;

  beforeEach(() => {
    validator = new ConfigValidator();
  });

  describe('Basic validation', () => {
    it('should validate a minimal valid configuration', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test Environment',
          type: 'private',
          visibility: 'private',
          zones: [],
          devicePlacements: [],
          agentPlacements: [],
        }],
      };

      const result = validator.validate(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject configuration without version', () => {
      const config = {
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [],
          devicePlacements: [],
          agentPlacements: [],
        }],
      } as unknown as DeclarativeConfig;

      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'VERSION_REQUIRED')).toBe(true);
    });

    it('should reject configuration without environments', () => {
      const config = {
        version: '1.0',
        environments: [],
      } as DeclarativeConfig;

      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'ENVIRONMENT_REQUIRED')).toBe(true);
    });
  });

  describe('Environment validation', () => {
    it('should reject environment without id', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: '',
          name: 'Test Environment',
          type: 'private',
          visibility: 'private',
          zones: [],
          devicePlacements: [],
          agentPlacements: [],
        }],
      };

      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'ID_REQUIRED')).toBe(true);
    });

    it('should reject environment without name', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: '',
          type: 'private',
          visibility: 'private',
          zones: [],
          devicePlacements: [],
          agentPlacements: [],
        }],
      };

      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'NAME_REQUIRED')).toBe(true);
    });

    it('should validate environment type', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'invalid-type' as DeclarativeConfig['environments'][number]['type'],
          visibility: 'private',
          zones: [],
          devicePlacements: [],
          agentPlacements: [],
        }],
      };

      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'INVALID_TYPE')).toBe(true);
    });

    it('should accept shared and private environment types', () => {
      const sharedConfig: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Shared Env',
          type: 'shared',
          visibility: 'platform',
          zones: [],
          devicePlacements: [],
          agentPlacements: [],
        }],
      };

      const privateConfig: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-2',
          name: 'Private Env',
          type: 'private',
          visibility: 'private',
          zones: [],
          devicePlacements: [],
          agentPlacements: [],
        }],
      };

      // Both should pass type validation
      expect(validator.validate(sharedConfig).errors.some(e => e.code === 'INVALID_TYPE')).toBe(false);
      expect(validator.validate(privateConfig).errors.some(e => e.code === 'INVALID_TYPE')).toBe(false);
    });
  });

  describe('Zone validation', () => {
    it('should validate zones', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [
            { id: 'zone-1', name: 'Living Room', type: 'room' },
            { id: 'zone-2', name: 'Kitchen', type: 'room' },
          ],
          devicePlacements: [],
          agentPlacements: [],
        }],
      };

      const result = validator.validate(config);

      // Zones are valid, no ID_REQUIRED errors for zones
      expect(result.errors.some(e => e.path.includes('zones') && e.code === 'ID_REQUIRED')).toBe(false);
    });

    it('should reject zone without id', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [
            { id: '', name: 'Zone 1', type: 'room' },
          ],
          devicePlacements: [],
          agentPlacements: [],
        }],
      };

      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path.includes('zones') && e.code === 'ID_REQUIRED')).toBe(true);
    });
  });

  describe('Device placement validation', () => {
    it('should validate device placements with template', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [{ id: 'zone-1', name: 'Room', type: 'room' }],
          devicePlacements: [{
            instanceName: 'temp-sensor-1',
            templateId: 'temperature-sensor',
            zone: 'zone-1',
          }],
          agentPlacements: [],
        }],
      };

      const result = validator.validate(config);

      // Device has templateId, so TEMPLATE_OR_INLINE_REQUIRED error should not occur
      expect(result.errors.some(e => e.code === 'TEMPLATE_OR_INLINE_REQUIRED')).toBe(false);
    });

    it('should reject device placement without instance name', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [],
          devicePlacements: [{
            instanceName: '',
            zone: 'default',
          }],
          agentPlacements: [],
        }],
      };

      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'INSTANCE_NAME_REQUIRED')).toBe(true);
    });

    it('should reject device placement without templateId or inline config', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [],
          devicePlacements: [{
            instanceName: 'device-1',
            zone: 'default',
            // No templateId or inline
          }],
          agentPlacements: [],
        }],
      };

      const result = validator.validate(config);

      expect(result.errors.some(e => e.code === 'TEMPLATE_OR_INLINE_REQUIRED')).toBe(true);
    });
  });

  describe('Agent placement validation', () => {
    it('should validate agent placements with template', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [{ id: 'default', name: 'Default Zone', type: 'room' }],
          devicePlacements: [{
            instanceName: 'device-1',
            templateId: 'dev-template',
            zone: 'default',
          }],
          agentPlacements: [{
            instanceName: 'agent-1',
            templateId: 'agent-template',
            devices: ['device-1'],
          }],
        }],
        deviceTemplates: [{
          id: 'dev-template',
          name: 'Device Template',
          category: 'environmental',
          type: 'sensor',
          capabilities: [],
          defaultState: {},
        }],
        agentTemplates: [{
          id: 'agent-template',
          name: 'Agent Template',
          category: 'monitor',
          capabilities: [],
          priority: 'medium',
        }],
      };

      const result = validator.validate(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject agent placement without instance name', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [],
          devicePlacements: [],
          agentPlacements: [{
            instanceName: '',
            devices: [],
          }],
        }],
      };

      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'INSTANCE_NAME_REQUIRED')).toBe(true);
    });

    it('should reject agent referencing non-existent device', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [{ id: 'default', name: 'Default Zone', type: 'room' }],
          devicePlacements: [{
            instanceName: 'device-1',
            templateId: 'dev-template',
            zone: 'default',
          }],
          agentPlacements: [{
            instanceName: 'agent-1',
            templateId: 'agent-template',
            devices: ['non-existent-device'],
          }],
        }],
        deviceTemplates: [{
          id: 'dev-template',
          name: 'Device Template',
          category: 'environmental',
          type: 'sensor',
          capabilities: [],
          defaultState: {},
        }],
        agentTemplates: [{
          id: 'agent-template',
          name: 'Agent Template',
          category: 'monitor',
          capabilities: [],
          priority: 'medium',
        }],
      };

      const result = validator.validate(config);

      expect(result.errors.some(e => e.code === 'UNDEFINED_DEVICE')).toBe(true);
    });
  });

  describe('Autonomous mode validation', () => {
    it('should validate autonomous mode configuration', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [{ id: 'default', name: 'Default Zone', type: 'room' }],
          devicePlacements: [{
            instanceName: 'device-1',
            templateId: 'dev-template',
            zone: 'default',
          }],
          agentPlacements: [{
            instanceName: 'agent-1',
            templateId: 'agent-template',
            devices: ['device-1'],
            autonomousMode: {
              enabled: true,
              triggers: [{
                id: 'trigger-1',
                name: 'Trigger 1',
                enabled: true,
                type: 'device-state-change',
                condition: {},
                action: { type: 'device-control' },
              }],
            },
          }],
        }],
        deviceTemplates: [{
          id: 'dev-template',
          name: 'Device Template',
          category: 'environmental',
          type: 'sensor',
          capabilities: [],
          defaultState: {},
        }],
        agentTemplates: [{
          id: 'agent-template',
          name: 'Agent Template',
          category: 'monitor',
          capabilities: [],
          priority: 'medium',
        }],
      };

      const result = validator.validate(config);

      expect(result.valid).toBe(true);
    });

    it('should validate trigger configuration', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [{ id: 'default', name: 'Default Zone', type: 'room' }],
          devicePlacements: [{
            instanceName: 'device-1',
            templateId: 'dev-template',
            zone: 'default',
          }],
          agentPlacements: [{
            instanceName: 'agent-1',
            templateId: 'agent-template',
            devices: ['device-1'],
            autonomousMode: {
              enabled: true,
              triggers: [{
                id: 'trigger-1',
                name: 'High Temperature',
                enabled: true,
                type: 'threshold-crossed',
                condition: {},
                action: { type: 'device-control' },
              }],
            },
          }],
        }],
        deviceTemplates: [{
          id: 'dev-template',
          name: 'Device Template',
          category: 'environmental',
          type: 'sensor',
          capabilities: [],
          defaultState: {},
        }],
        agentTemplates: [{
          id: 'agent-template',
          name: 'Agent Template',
          category: 'monitor',
          capabilities: [],
          priority: 'medium',
        }],
      };

      const result = validator.validate(config);

      expect(result.valid).toBe(true);
    });

    it('should validate threshold monitor configuration', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [{ id: 'default', name: 'Default Zone', type: 'room' }],
          devicePlacements: [{
            instanceName: 'device-1',
            templateId: 'dev-template',
            zone: 'default',
          }],
          agentPlacements: [{
            instanceName: 'agent-1',
            templateId: 'agent-template',
            devices: ['device-1'],
            autonomousMode: {
              enabled: true,
              thresholdMonitors: [{
                id: 'monitor-1',
                name: 'Temperature Monitor',
                enabled: true,
                deviceId: 'device-1',
                parameter: 'temperature',
                warningThreshold: { operator: '>', value: 25 },
                criticalThreshold: { operator: '>', value: 35 },
              }],
            },
          }],
        }],
        deviceTemplates: [{
          id: 'dev-template',
          name: 'Device Template',
          category: 'environmental',
          type: 'sensor',
          capabilities: [],
          defaultState: {},
        }],
        agentTemplates: [{
          id: 'agent-template',
          name: 'Agent Template',
          category: 'monitor',
          capabilities: [],
          priority: 'medium',
        }],
      };

      const result = validator.validate(config);

      expect(result.valid).toBe(true);
    });

    it('should validate scheduled check configuration', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [{ id: 'default', name: 'Default Zone', type: 'room' }],
          devicePlacements: [{
            instanceName: 'device-1',
            templateId: 'dev-template',
            zone: 'default',
          }],
          agentPlacements: [{
            instanceName: 'agent-1',
            templateId: 'agent-template',
            devices: ['device-1'],
            autonomousMode: {
              enabled: true,
              scheduledChecks: [{
                id: 'schedule-1',
                name: 'Self Check',
                enabled: true,
                interval: 300000, // 5 minutes
                task: 'selfCheck',
              }],
            },
          }],
        }],
        deviceTemplates: [{
          id: 'dev-template',
          name: 'Device Template',
          category: 'environmental',
          type: 'sensor',
          capabilities: [],
          defaultState: {},
        }],
        agentTemplates: [{
          id: 'agent-template',
          name: 'Agent Template',
          category: 'monitor',
          capabilities: [],
          priority: 'medium',
        }],
      };

      const result = validator.validate(config);

      expect(result.valid).toBe(true);
    });

    it('should warn when autonomous mode is enabled but no actions defined', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [{ id: 'default', name: 'Default Zone', type: 'room' }],
          devicePlacements: [{
            instanceName: 'device-1',
            templateId: 'dev-template',
            zone: 'default',
          }],
          agentPlacements: [{
            instanceName: 'agent-1',
            templateId: 'agent-template',
            devices: ['device-1'],
            autonomousMode: {
              enabled: true,
              // No triggers, monitors, or schedules
            },
          }],
        }],
        deviceTemplates: [{
          id: 'dev-template',
          name: 'Device Template',
          category: 'environmental',
          type: 'sensor',
          capabilities: [],
          defaultState: {},
        }],
        agentTemplates: [{
          id: 'agent-template',
          name: 'Agent Template',
          category: 'monitor',
          capabilities: [],
          priority: 'medium',
        }],
      };

      const result = validator.validate(config);

      expect(result.warnings.some(w => w.message.includes('no triggers, monitors, or schedules'))).toBe(true);
    });
  });

  describe('Template validation', () => {
    it('should validate device templates', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        deviceTemplates: [{
          id: 'temp-sensor',
          name: 'Temperature Sensor',
          category: 'environmental',
          type: 'sensor',
          capabilities: [{
            name: 'readTemperature',
            type: 'read',
            parameters: [],
          }],
          defaultState: { temperature: 20 },
        }],
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [],
          devicePlacements: [],
          agentPlacements: [],
        }],
      };

      const result = validator.validate(config);

      expect(result.valid).toBe(true);
    });

    it('should reject device template without id', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        deviceTemplates: [{
          id: '',
          name: 'Template',
          category: 'environmental',
          type: 'sensor',
          capabilities: [],
          defaultState: {},
        }],
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [],
          devicePlacements: [],
          agentPlacements: [],
        }],
      };

      const result = validator.validate(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'ID_REQUIRED')).toBe(true);
    });
  });

  describe('Cross-reference validation', () => {
    it('should warn about device referencing non-existent template', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [{
          id: 'env-1',
          name: 'Test',
          type: 'private',
          visibility: 'private',
          zones: [{ id: 'zone-1', name: 'Zone', type: 'room' }],
          devicePlacements: [{
            instanceName: 'device-1',
            templateId: 'non-existent-template',
            zone: 'zone-1',
          }],
          agentPlacements: [],
        }],
      };

      const result = validator.validate(config);

      expect(result.warnings.some(w => w.message.includes('not defined in config'))).toBe(true);
    });
  });

  describe('Multiple environments', () => {
    it('should validate multiple environments', () => {
      const config: DeclarativeConfig = {
        version: '1.0',
        environments: [
          {
            id: 'env-1',
            name: 'Environment 1',
            type: 'private',
            visibility: 'private',
            zones: [],
            devicePlacements: [],
            agentPlacements: [],
          },
          {
            id: 'env-2',
            name: 'Environment 2',
            type: 'shared',
            visibility: 'platform',
            zones: [],
            devicePlacements: [],
            agentPlacements: [],
          },
        ],
      };

      const result = validator.validate(config);

      // Valid structure (though will have warnings for empty placements)
      expect(result.errors).toHaveLength(0);
    });
  });
});
