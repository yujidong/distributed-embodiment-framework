/**
 * Environment Configuration Validator Tests (TDD)
 *
 * These tests verify JSON configuration files for devices and agents.
 * Following Fail Early principle: errors are thrown loudly, not silent fallbacks.
 *
 * Reference: CLAUDE.md - Fail Early Development Principle
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigValidator } from '../ConfigValidator.js';
import type { EnvironmentConfig, ConfigValidationResult } from '@active-collaboration/shared';

describe('ConfigValidator - Environment Config Validation', () => {
  let validator: ConfigValidator;

  beforeEach(() => {
    validator = new ConfigValidator();
  });

  describe('validateEnvironmentConfig', () => {
    it('should throw error when environment is missing', () => {
      const config: any = {
        version: '1.0',
        devices: [],
        agents: [],
      };

      // Fail Early: Should throw error, not return default
      expect(() => validator.validateEnvironmentConfig(config)).toThrow(/environment is required/);
    });

    it('should throw error when environment name is missing', () => {
      const config: any = {
        version: '1.0',
        environment: { id: 'test-env' },
        devices: [],
        agents: [],
      };

      // Fail Early: Should throw error
      expect(() => validator.validateEnvironmentConfig(config)).toThrow(/environment\.name is required/);
    });

    it('should throw error when environment id has invalid format', () => {
      const config: any = {
        version: '1.0',
        environment: { id: 'Test Env', name: 'Test' },
        devices: [],
        agents: [],
      };

      // Fail Early: Should throw error
      expect(() => validator.validateEnvironmentConfig(config)).toThrow(/environment\.id must match pattern/);
    });

    it('should validate correct environment config', () => {
      const config: EnvironmentConfig = {
        version: '1.0',
        environment: {
          id: 'test-env',
          name: 'Test Environment',
        },
        devices: [],
        agents: [],
      };

      // This should succeed
      const result = validator.validateEnvironmentConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('validateDevice', () => {
    it('should throw error when device id is missing', () => {
      const device: any = {
        name: 'Test Device',
        type: 'sensor',
        capabilities: ['temperature-monitoring'],
        location: {
          building: 'Home',
          floor: 1,
          room: 'Living Room',
          coordinates: { x: 100, y: 100, z: 0 }
        },
        behavior: {
          type: 'periodic',
          interval: 60000,
          initialState: { temperature: 25 }
        }
      };

      // Fail Early: Should throw error
      expect(() => validator.validateDevice(device)).toThrow(/device\.id is required/);
    });

    it('should throw error when capabilities array is empty', () => {
      const device: any = {
        id: 'test-device',
        name: 'Test Device',
        type: 'sensor',
        capabilities: [],
        location: {
          building: 'Home',
          floor: 1,
          room: 'Living Room',
          coordinates: { x: 100, y: 100, z: 0 }
        },
        behavior: {
          type: 'periodic',
          interval: 60000,
          initialState: { temperature: 25 }
        }
      };

      // Fail Early: Should throw error
      expect(() => validator.validateDevice(device)).toThrow(/device\.capabilities must have at least 1 element/);
    });

    it('should throw error when behavior type is invalid', () => {
      const device: any = {
        id: 'test-device',
        name: 'Test Device',
        type: 'sensor',
        capabilities: ['temperature-monitoring'],
        location: {
          building: 'Home',
          floor: 1,
          room: 'Living Room',
          coordinates: { x: 100, y: 100, z: 0 }
        },
        behavior: {
          type: 'invalid-type',
          interval: 60000,
          initialState: { temperature: 25 }
        }
      };

      // Fail Early: Should throw error
      expect(() => validator.validateDevice(device)).toThrow(/Invalid behavior type/);
    });

    it('should throw error when periodic behavior has no interval', () => {
      const device: any = {
        id: 'test-device',
        name: 'Test Device',
        type: 'sensor',
        capabilities: ['temperature-monitoring'],
        location: {
          building: 'Home',
          floor: 1,
          room: 'Living Room',
          coordinates: { x: 100, y: 100, z: 0 }
        },
        behavior: {
          type: 'periodic',
          initialState: { temperature: 25 }
        }
      };

      // Fail Early: Should throw error
      expect(() => validator.validateDevice(device)).toThrow(/interval is required for periodic behavior/);
    });

    it('should validate correct device config', () => {
      const device: any = {
        id: 'test-device',
        name: 'Test Device',
        type: 'sensor',
        capabilities: ['temperature-monitoring'],
        location: {
          building: 'Home',
          floor: 1,
          room: 'Living Room',
          coordinates: { x: 100, y: 100, z: 0 }
        },
        behavior: {
          type: 'periodic',
          interval: 60000,
          initialState: { temperature: 25 }
        }
      };

      // This should succeed
      const result = validator.validateDevice(device);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('validateAgent', () => {
    it('should throw error when agent id is missing', () => {
      const agent: any = {
        name: 'Test Agent',
        type: 'cognitive',
        capabilities: ['temperature-monitoring'],
        boundDevices: ['device-1'],
        config: {
          llmModel: 'qwen3-14b-q4:latest'
        }
      };

      // Fail Early: Should throw error
      expect(() => validator.validateAgent(agent)).toThrow(/agent\.id is required/);
    });

    it('should throw error when boundDevices references non-existent device', () => {
      const agent: any = {
        id: 'test-agent',
        name: 'Test Agent',
        type: 'cognitive',
        capabilities: ['temperature-monitoring'],
        boundDevices: ['non-existent-device'],
        config: {
          llmModel: 'qwen3-14b-q4:latest'
        }
      };

      // Fail Early: Should throw error
      expect(() => validator.validateAgent(agent, ['device-1'])).toThrow(/references non-existent device/);
    });

    it('should validate correct agent config', () => {
      const agent: any = {
        id: 'test-agent',
        name: 'Test Agent',
        type: 'cognitive',
        capabilities: ['temperature-monitoring'],
        boundDevices: ['device-1'],
        config: {
          llmModel: 'qwen3-14b-q4:latest'
        }
      };

      const existingDevices = ['device-1'];

      // This should succeed
      const result = validator.validateAgent(agent, existingDevices);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
