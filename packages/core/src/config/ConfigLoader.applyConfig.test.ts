/**
 * Test: ConfigLoader.applyConfig() Implementation
 * Sprint 6: Tests for real applyConfig functionality
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from './ConfigLoader.js';
import type { DeclarativeConfig } from './types.js';
import type { LLMClient } from '@active-collaboration/llm-integration';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ConfigLoader.applyConfig.test');
describe('ConfigLoader.applyConfig - Sprint 6', () => {
  let configLoader: ConfigLoader;

  beforeEach(() => {
    configLoader = new ConfigLoader('./configs');
  });

  afterEach(() => {
    // Cleanup handled by individual tests
  });

  it('should apply a simple environment configuration', async () => {
    const config: DeclarativeConfig = {
      version: '1.0',
      environments: [
        {
          id: 'test-env-1',
          name: 'Test Environment',
          type: 'private',
          visibility: 'private',
          zones: [],
          devicePlacements: [],
          agentPlacements: [],
        },
      ],
    };

    const userId = 'test-user-1';
    const llmClientFactory = () => null as unknown as LLMClient;
    const options = { mode: 'create' };

    const results = await configLoader.applyConfig(config, userId, llmClientFactory, options);

    expect(results).toBeDefined();
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].environmentId).toBe('test-env-1');
    expect(results[0].created).toBeDefined();
    expect(results[0].errors).toEqual([]);
  });

  it('should create devices from device placements', async () => {
    const config: DeclarativeConfig = {
      version: '1.0',
      environments: [
        {
          id: 'test-env-2',
          name: 'Test Environment with Devices',
          type: 'private',
          visibility: 'private',
          zones: [{ id: 'zone-1', name: 'Room 1', type: 'room' }],
          devicePlacements: [
            {
              templateId: 'temperature-sensor',
              instanceName: 'temp-sensor-1',
              zone: 'zone-1',
              location: { x: 0, y: 0 },
            },
          ],
          agentPlacements: [],
        },
      ],
    };

    const userId = 'test-user-2';
    const llmClientFactory = () => null as unknown as LLMClient;
    const options = { mode: 'create' };

    const results = await configLoader.applyConfig(config, userId, llmClientFactory, options);

    expect(results).toBeDefined();
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].created.devices.length).toBeGreaterThan(0);
    expect(results[0].created.devices).toContain('temp-sensor-1');
  });

  it('should create agents from agent placements', async () => {
    const config: DeclarativeConfig = {
      version: '1.0',
      environments: [
        {
          id: 'test-env-3',
          name: 'Test Environment with Agents',
          type: 'private',
          visibility: 'private',
          zones: [{ id: 'zone-1', name: 'Room 1', type: 'room' }],
          devicePlacements: [],
          agentPlacements: [
            {
              templateId: 'monitor',
              instanceName: 'monitor-agent-1',
              devices: [],
              capabilitiesOverride: ['monitoring'],
            },
          ],
        },
      ],
    };

    const userId = 'test-user-3';
    const llmClientFactory = () => null as unknown as LLMClient;
    const options = { mode: 'create' };

    const results = await configLoader.applyConfig(config, userId, llmClientFactory, options);

    expect(results).toBeDefined();
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].created.agents.length).toBeGreaterThan(0);
    expect(results[0].created.agents).toContain('monitor-agent-1');
  });

  it('should handle multiple environments', async () => {
    const config: DeclarativeConfig = {
      version: '1.0',
      environments: [
        {
          id: 'test-env-4a',
          name: 'Environment A',
          type: 'private',
          visibility: 'private',
          zones: [],
          devicePlacements: [],
          agentPlacements: [],
        },
        {
          id: 'test-env-4b',
          name: 'Environment B',
          type: 'shared',
          visibility: 'platform',
          zones: [],
          devicePlacements: [],
          agentPlacements: [],
        },
      ],
    };

    const userId = 'test-user-4';
    const llmClientFactory = () => null as unknown as LLMClient;
    const options = { mode: 'create' };

    const results = await configLoader.applyConfig(config, userId, llmClientFactory, options);

    expect(results).toBeDefined();
    expect(results.length).toBe(2);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
    expect(results[0].environmentId).toBe('test-env-4a');
    expect(results[1].environmentId).toBe('test-env-4b');
  });

  it('should return errors for invalid configurations', async () => {
    const config: DeclarativeConfig = {
      version: '1.0',
      environments: [
        {
          id: 'test-env-5',
          name: 'Environment with Invalid Device',
          type: 'private',
          visibility: 'private',
          zones: [{ id: 'zone-1', name: 'Room 1', type: 'room' }],
          devicePlacements: [
            {
              templateId: 'non-existent-template',
              instanceName: 'invalid-device',
              zone: 'zone-1',
            },
          ],
          agentPlacements: [],
        },
      ],
    };

    const userId = 'test-user-5';
    const llmClientFactory = () => null as unknown as LLMClient;
    const options = { mode: 'create' };

    const results = await configLoader.applyConfig(config, userId, llmClientFactory, options);

    expect(results).toBeDefined();
    expect(results.length).toBe(1);
    // Environment might still be created, but device creation should fail
    expect(results[0].errors.length).toBeGreaterThan(0);
    expect(results[0].errors[0].type).toContain('device');
  });

  it('should support dry-run mode', async () => {
    const config: DeclarativeConfig = {
      version: '1.0',
      environments: [
        {
          id: 'test-env-6',
          name: 'Dry Run Environment',
          type: 'private',
          visibility: 'private',
          zones: [],
          devicePlacements: [],
          agentPlacements: [],
        },
      ],
    };

    const userId = 'test-user-6';
    const llmClientFactory = () => null as unknown as LLMClient;
    const options = { mode: 'create', dryRun: true };

    const results = await configLoader.applyConfig(config, userId, llmClientFactory, options);

    expect(results).toBeDefined();
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    // In dry-run mode, nothing should actually be created
    expect(results[0].created.devices).toEqual([]);
    expect(results[0].created.agents).toEqual([]);
  });
});

logger.info('Sprint 6 Test: ConfigLoader.applyConfig() Implementation');
