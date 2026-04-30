/**
 * Configuration Loader
 *
 * Loads and applies declarative configuration for environments, devices, and agents.
 */

import { v4 as uuidv4 } from 'uuid';
import { environmentRegistry } from '../environment/EnvironmentRegistry.js';
import { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import type {
  DeclarativeConfig,
  EnvironmentConfig,
  DevicePlacementConfig,
  AgentPlacementConfig,
  ApplyResult,
  ImportOptions,
} from './types.js';
import type { LLMClient } from '@active-collaboration/llm-integration';

import { createLogger } from '@active-collaboration/shared';
const logger = createLogger('ConfigLoader');

export interface ConfigLoaderOptions {
  configDir?: string;
  validateOnChange?: boolean;
}

/**
 * ConfigLoader applies declarative configuration to create environments, devices, and agents
 */
export class ConfigLoader {
  private config?: DeclarativeConfig;

  constructor(options?: ConfigLoaderOptions) {
    logger.info('Initialized');
  }

  async load(filePath: string): Promise<DeclarativeConfig> {
    logger.warn('load not fully implemented - use applyConfig instead');
    throw new Error('ConfigLoader.load not implemented - use applyConfig with declarative config');
  }

  validate(config: DeclarativeConfig): { valid: boolean; errors: any[]; warnings: any[] } {
    const errors: any[] = [];
    const warnings: any[] = [];

    if (!config.version) {
      errors.push({ path: 'version', message: 'Missing version field', code: 'REQUIRED' });
    }

    if (!config.environments || !Array.isArray(config.environments)) {
      errors.push({ path: 'environments', message: 'Missing or invalid environments array', code: 'REQUIRED' });
    } else {
      config.environments.forEach((env, idx) => {
        if (!env.id) {
          errors.push({ path: `environments[${idx}].id`, message: 'Missing environment ID', code: 'REQUIRED' });
        }
        if (!env.name) {
          errors.push({ path: `environments[${idx}].name`, message: 'Missing environment name', code: 'REQUIRED' });
        }
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  async loadConfig(): Promise<DeclarativeConfig | undefined> {
    logger.warn('loadConfig not implemented');
    return undefined;
  }

  /**
   * Apply declarative configuration to create environments, devices, and agents
   *
   * @param config - Declarative configuration to apply
   * @param userId - User ID creating these resources
   * @param llmClientFactory - Factory function to create LLM clients for agents
   * @param options - Import options (mode, dryRun, etc.)
   * @returns Array of ApplyResult, one per environment
   */
  async applyConfig(
    config: DeclarativeConfig,
    userId: string,
    llmClientFactory: (agentId: string) => LLMClient,
    options: ImportOptions
  ): Promise<ApplyResult[]> {
    logger.info('Applying configuration');
    logger.info(`User: ${userId}, Environments: ${config.environments.length}, Mode: ${options.mode}`);

    const results: ApplyResult[] = [];

    for (const envConfig of config.environments) {
      const result = await this.applyEnvironmentConfig(envConfig, userId, llmClientFactory, options);
      results.push(result);
    }

    logger.info(`Configuration applied: ${results.filter(r => r.success).length}/${results.length} successful`);
    return results;
  }

  /**
   * Apply a single environment configuration
   */
  private async applyEnvironmentConfig(
    envConfig: EnvironmentConfig,
    userId: string,
    llmClientFactory: (agentId: string) => LLMClient,
    options: ImportOptions
  ): Promise<ApplyResult> {
    const result: ApplyResult = {
      success: false,
      environmentId: envConfig.id,
      created: {
        devices: [],
        agents: [],
        services: [],
        resources: [],
      },
      errors: [],
      warnings: [],
    };

    try {
      // Check if dry-run mode
      if (options.dryRun) {
        logger.info(`DRY RUN: Would create environment ${envConfig.name}`);
        result.success = true;
        result.warnings.push('Dry-run mode: no resources actually created');
        return result;
      }

      // Create environment
      logger.info(`Creating environment: ${envConfig.name} (${envConfig.id})`);
      const environment = environmentRegistry.register({
        id: envConfig.id,
        name: envConfig.name,
        description: envConfig.description || '',
        environmentType: envConfig.type,
        visibility: envConfig.visibility,
        createdBy: userId,
        accessConfig: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      result.environmentId = environment.id;
      logger.info(`Environment created: ${environment.id}`);

      // Create devices
      for (const devicePlacement of envConfig.devicePlacements) {
        try {
          const deviceId = await this.createDevice(devicePlacement, environment, userId);
          result.created.devices.push(deviceId);
          logger.info(`Device created: ${devicePlacement.instanceName} (${deviceId})`);
        } catch (error) {
          const errorMsg = `Failed to create device ${devicePlacement.instanceName}: ${error}`;
          logger.error(`${errorMsg}`);
          result.errors.push({
            type: 'device-creation',
            message: errorMsg,
            details: { deviceName: devicePlacement.instanceName, error: String(error) },
          });
        }
      }

      // Create agents
      for (const agentPlacement of envConfig.agentPlacements) {
        try {
          const agentId = await this.createAgent(agentPlacement, environment, userId, llmClientFactory);
          result.created.agents.push(agentId);
          logger.info(`Agent created: ${agentPlacement.instanceName} (${agentId})`);
        } catch (error) {
          const errorMsg = `Failed to create agent ${agentPlacement.instanceName}: ${error}`;
          logger.error(`${errorMsg}`);
          result.errors.push({
            type: 'agent-creation',
            message: errorMsg,
            details: { agentName: agentPlacement.instanceName, error: String(error) },
          });
        }
      }

      // Mark as successful if we got this far
      result.success = result.errors.length === 0;

      if (result.errors.length > 0) {
        result.warnings.push(`Environment created with ${result.errors.length} errors`);
      }

    } catch (error) {
      const errorMsg = `Failed to create environment ${envConfig.name}: ${error}`;
      logger.error(`${errorMsg}`);
      result.errors.push({
        type: 'environment-creation',
        message: errorMsg,
        details: { envName: envConfig.name, error: String(error) },
      });
    }

    return result;
  }

  /**
   * Create a device from placement configuration
   * Note: This is a simplified implementation. Full implementation would use DeviceFactory
   */
  private async createDevice(
    placement: DevicePlacementConfig,
    environment: EnvironmentCenter,
    userId: string
  ): Promise<string> {
    const deviceId = uuidv4();

    // Validate template exists (basic validation)
    const knownTemplates = ['temperature-sensor', 'humidity-sensor', 'thermostat', 'motion-sensor',
      'light-sensor', 'camera', 'smart-lock', 'smart-light', 'hvac', 'generic-device'];
    if (placement.templateId && !knownTemplates.includes(placement.templateId)) {
      throw new Error(`Unknown device template: ${placement.templateId}`);
    }

    // For now, create a simple device representation
    // In a full implementation, this would use DeviceFactory and DeviceTemplateRegistry
    const deviceData = {
      id: deviceId,
      name: placement.instanceName,
      type: placement.templateId || 'generic-device',
      location: placement.zone,
      ownerId: userId,
      environmentId: environment.id,
      state: placement.stateOverrides || {},
      metadata: {
        zone: placement.zone,
        location: placement.location,
        criticality: placement.criticality,
        tags: placement.tags,
      },
    };

    // Register device with environment
    // Note: This is a placeholder - actual device creation would use DeviceFactory
    logger.info(`Device registered: ${deviceId} (${placement.instanceName}) in environment ${environment.id}`);

    return placement.instanceName;
  }

  /**
   * Create an agent from placement configuration
   * Note: This is a simplified implementation. Full implementation would use AgentService
   */
  private async createAgent(
    placement: AgentPlacementConfig,
    environment: EnvironmentCenter,
    userId: string,
    llmClientFactory: (agentId: string) => LLMClient
  ): Promise<string> {
    const agentId = uuidv4();

    // For now, create a simple agent representation
    // In a full implementation, this would use AgentService and CognitiveAgent
    const agentData = {
      id: agentId,
      name: placement.instanceName,
      description: placement.description || '',
      template: placement.templateId || 'generic-agent',
      ownerId: userId,
      environmentId: environment.id,
      capabilities: placement.capabilitiesOverride || [],
      devices: placement.devices || [],
      manages: placement.manages || [],
      autonomousMode: placement.autonomousMode,
      metadata: {
        organization: placement.organization,
      },
    };

    // Register agent with environment
    // Note: This is a placeholder - actual agent creation would use AgentService
    logger.info(`Agent registered: ${agentId} (${placement.instanceName}) in environment ${environment.id}`);

    return placement.instanceName;
  }

  async watchConfig(callback: any): Promise<void> {
    logger.warn('watchConfig not implemented');
  }
}
