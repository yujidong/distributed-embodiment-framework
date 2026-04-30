/**
 * Feature Flags Manager
 *
 * Simple feature flag system for gradual refactoring.
 * Allows toggling between old and new implementations without code changes.
 */

import fs from 'fs';
import path from 'path';

import { createLogger } from '@active-collaboration/shared';
const logger = createLogger('FeatureFlags');

export interface FeatureFlagConfig {
  enabled: boolean;
  description: string;
}

export interface FeatureFlags {
  features: {
    [key: string]: FeatureFlagConfig;
  };
}

class FeatureFlagManager {
  private config: FeatureFlags;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath || path.join(process.cwd(), '..', '..', 'feature-flags.json');
    // Initialize with default config first
    this.config = {
      features: {}
    };
    this.loadConfig();
  }

  private loadConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf-8');
        this.config = JSON.parse(content);
      } else {
        // Default configuration - all features disabled
        this.config = {
          features: {
            verticalLayerArchitecture: {
              enabled: false,
              description: 'Enable vertical layer architecture refactoring'
            },
            serviceDiscovery: {
              enabled: false,
              description: 'Use extracted ServiceDiscovery module'
            },
            collaborationCoordinator: {
              enabled: false,
              description: 'Use extracted CollaborationCoordinator module'
            },
            messageHandler: {
              enabled: false,
              description: 'Use extracted MessageHandler module'
            },
            deviceExecutor: {
              enabled: false,
              description: 'Use extracted DeviceExecutor module'
            },
            useAgentModules: {
              enabled: false,
              description: 'Use DI-based agent module initialization'
            },
            useResourceCoordinator: {
              enabled: false,
              description: 'Use extracted ResourceCoordinator for device/resource management'
            }
          }
        };
      }
    } catch (error) {
      logger.error('Failed to load config:', error);
      // Use default configuration
      this.config = {
        features: {}
      };
    }
  }

  isEnabled(featureName: string): boolean {
    return this.config.features[featureName]?.enabled ?? false;
  }

  getDescription(featureName: string): string {
    return this.config.features[featureName]?.description ?? '';
  }

  setEnabled(featureName: string, enabled: boolean): void {
    if (!this.config.features[featureName]) {
      this.config.features[featureName] = {
        enabled: false,
        description: ''
      };
    }
    this.config.features[featureName].enabled = enabled;
    this.saveConfig();
  }

  private saveConfig(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      logger.error('Failed to save config:', error);
    }
  }

  getConfig(): FeatureFlags {
    return this.config;
  }
}

// Global instance
export const featureFlags = new FeatureFlagManager();
