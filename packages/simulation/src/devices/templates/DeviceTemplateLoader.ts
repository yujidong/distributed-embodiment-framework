/**
 * Device Template Loader
 *
 * Loads device templates from JSON files and provides methods
 * to create devices from templates.
 *
 * Usage:
 * ```typescript
 * const loader = new DeviceTemplateLoader();
 *
 * // List all available templates
 * const templates = loader.listTemplates();
 *
 * // Load specific template
 * const template = loader.getTemplate('temperature-sensor-v1');
 *
 * // Create device from template
 * const device = await loader.createDevice('temperature-sensor-v1', {
 *   name: 'Living Room Temperature',
 *   location: 'living-room'
 * });
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DeviceCapability } from '@active-collaboration/shared';
import { DeviceFactory } from '../DeviceFactory.js';
import type { SimulatedDeviceConfig, BehaviorConfig } from '../types.js';
import type { PhysicalEnvironment } from '../../environment/PhysicalEnvironment.js';
import { SimulatedDevice } from '../SimulatedDevice.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Device template structure (from JSON)
 */
const logger = createLogger('DeviceTemplateLoader');

export interface DeviceTemplate {
  id: string;
  name: string;
  description: string;
  category: 'sensor' | 'actuator' | 'controller' | 'hybrid' | 'communication';
  type: string;
  capabilities: DeviceCapability[];
  defaultState: Record<string, unknown>;
  physicalEffects?: {
    parameter: string;
    effect: string;
    magnitude: number;
    radius: number;
    condition?: string;
  }[];
  semanticDescription: string;
  tags: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Device creation options
 */
export interface DeviceCreationOptions {
  /** Override default name */
  name?: string;
  /** Device location */
  location?: string | {
    path: string;
    position?: { x: number; y: number; z: number };
  };
  /** Custom ID (auto-generated if not provided) */
  id?: string;
  /** Override default state */
  initialState?: Record<string, unknown>;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Device Template Loader
 *
 * Handles loading device templates and creating device instances
 */
export class DeviceTemplateLoader {
  private templatesDir: string;
  private templateCache: Map<string, DeviceTemplate> = new Map();
  private loaded: boolean = false;

  constructor(templatesDir?: string) {
    this.templatesDir = templatesDir || path.join(__dirname);
    logger.info(`Initialized with templates directory: ${this.templatesDir}`);
  }

  /**
   * Load all templates from the templates directory
   */
  loadTemplates(): void {
    logger.info(`Loading templates from ${this.templatesDir}`);

    try {
      const files = fs.readdirSync(this.templatesDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      logger.info(`Found ${jsonFiles.length} template files`);

      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.templatesDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const template = JSON.parse(content) as DeviceTemplate;

          this.templateCache.set(template.id, template);
          logger.info(`Loaded template: ${template.id} (${template.name})`);
        } catch (error) {
          logger.error(`Failed to load template from ${file}:`, error);
        }
      }

      this.loaded = true;
      logger.info(`Successfully loaded ${this.templateCache.size} templates`);
    } catch (error) {
      logger.error(`Failed to load templates:`, error);
    }
  }

  /**
   * Ensure templates are loaded
   */
  private ensureLoaded(): void {
    if (!this.loaded) {
      this.loadTemplates();
    }
  }

  /**
   * List all available templates
   */
  listTemplates(): DeviceTemplate[] {
    this.ensureLoaded();
    return Array.from(this.templateCache.values());
  }

  /**
   * Get templates by category
   */
  getTemplatesByCategory(category: DeviceTemplate['category']): DeviceTemplate[] {
    return this.listTemplates().filter(t => t.category === category);
  }

  /**
   * Get templates by tag
   */
  getTemplatesByTag(tag: string): DeviceTemplate[] {
    return this.listTemplates().filter(t => t.tags.includes(tag));
  }

  /**
   * Search templates by name or description
   */
  searchTemplates(query: string): DeviceTemplate[] {
    const lowerQuery = query.toLowerCase();
    return this.listTemplates().filter(t =>
      t.name.toLowerCase().includes(lowerQuery) ||
      t.description.toLowerCase().includes(lowerQuery) ||
      t.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
    );
  }

  /**
   * Get a specific template by ID
   */
  getTemplate(templateId: string): DeviceTemplate | undefined {
    this.ensureLoaded();
    return this.templateCache.get(templateId);
  }

  /**
   * Create a device from a template
   */
  async createDevice(
    templateId: string,
    options: DeviceCreationOptions = {},
    physicalEnvironment?: PhysicalEnvironment
  ): Promise<SimulatedDevice> {
    const template = this.getTemplate(templateId);

    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    logger.info(`Creating device from template: ${templateId}`);
    logger.info(`Options:`, options);

    // Build device config
    const config: SimulatedDeviceConfig = {
      id: options.id,
      name: options.name || template.name,
      type: template.type,
      templateId: template.id,
      initialState: options.initialState || template.defaultState,
      capabilities: template.capabilities,
      behaviors: this.createBehaviorsFromTemplate(template),
      location: options.location,
      metadata: {
        ...template.metadata || {},
        ...options.metadata,
        templateId: template.id,
        semanticDescription: template.semanticDescription,
        tags: template.tags,
      },
    };

    // Create device using factory
    const device = DeviceFactory.createDevice(config);

    // Set physical environment if provided
    if (physicalEnvironment && device instanceof SimulatedDevice) {
      device.setPhysicalEnvironment(physicalEnvironment);
    }

    // Register physical effects if defined
    if (template.physicalEffects && template.physicalEffects.length > 0) {
      this.setupPhysicalEffects(device, template, physicalEnvironment);
    }

    logger.info(`Device created: ${device.id} (${device.name})`);
    return device;
  }

  /**
   * Create behaviors from template (placeholder for future implementation)
   */
  private createBehaviorsFromTemplate(template: DeviceTemplate): BehaviorConfig[] {
    // TODO: Implement behavior generation from template
    // For now, return empty array as behaviors are optional
    return [];
  }

  /**
   * Setup physical effects from template
   */
  private setupPhysicalEffects(
    device: SimulatedDevice,
    template: DeviceTemplate,
    physicalEnvironment?: PhysicalEnvironment
  ): void {
    if (!physicalEnvironment || !template.physicalEffects) {
      return;
    }

    logger.info(`Setting up ${template.physicalEffects.length} physical effects for ${device.id}`);

    // Physical effects are registered when device state changes
    // The actual effect application happens through PhysicsLayer
    // This is a placeholder for more sophisticated effect handling
  }

  /**
   * Get template statistics
   */
  getStatistics(): {
    totalTemplates: number;
    byCategory: Record<string, number>;
    byTag: Record<string, number>;
  } {
    const templates = this.listTemplates();

    const byCategory: Record<string, number> = {};
    const byTag: Record<string, number> = {};

    for (const template of templates) {
      byCategory[template.category] = (byCategory[template.category] || 0) + 1;
      for (const tag of template.tags) {
        byTag[tag] = (byTag[tag] || 0) + 1;
      }
    }

    return {
      totalTemplates: templates.length,
      byCategory,
      byTag,
    };
  }
}

// Export singleton instance for convenience
export const templateLoader = new DeviceTemplateLoader();
