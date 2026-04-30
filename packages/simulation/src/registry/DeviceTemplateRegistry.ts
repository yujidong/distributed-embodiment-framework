/**
 * Device Template Registry
 *
 * Predefined device templates for common IoT devices
 */

import { DeviceFactory } from '../devices/DeviceFactory.js';
import type { SimulatedDevice } from '../devices/SimulatedDevice.js';
import type { EnvironmentEffectDeclaration } from '../devices/types.js';
import { PhysicalParameter } from '../devices/types.js';
import type { CapabilityType } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
/**
 * Device template visualization metadata
 */
const logger = createLogger('DeviceTemplateRegistry');

export interface DeviceVisualization {
  icon: string; // Icon identifier for map display
  color: string; // Color for map marker (hex code)
  size: number; // Marker size (1-10)
  layer: string; // Map layer (e.g., 'transport', 'environment', 'safety')
}

/**
 * Device template
 */
export interface DeviceTemplate {
  name: string;
  type: string;
  category?: string; // Device category (e.g., 'smart-city', 'mobility', 'safety')
  description: string;
  capabilities: string[];
  defaultBehaviors: string[];
  environmentEffects?: EnvironmentEffectDeclaration[]; // Environment effects from device commands
  visualization?: DeviceVisualization; // Visualization metadata for map display
}

/**
 * Device template registry
 */
export class DeviceTemplateRegistry {
  private static templates: Map<string, DeviceTemplate> = new Map();

  /**
   * Register a device template
   * @param template - Template to register
   */
  static registerTemplate(template: DeviceTemplate): void {
    logger.info(`Registering template: ${template.name}`);
    this.templates.set(template.name.toLowerCase(), template);
  }

  /**
   * Get a template by name
   * @param name - Template name
   * @returns Template or undefined
   */
  static getTemplate(name: string): DeviceTemplate | undefined {
    return this.templates.get(name.toLowerCase());
  }

  /**
   * Check if a template exists
   * @param name - Template name
   * @returns True if template exists
   */
  static hasTemplate(name: string): boolean {
    return this.templates.has(name.toLowerCase());
  }

  /**
   * List all templates
   * @returns Array of all templates
   */
  static listTemplates(): DeviceTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Get all template names
   * @returns Array of template names
   */
  static listTemplateNames(): string[] {
    return Array.from(this.templates.keys());
  }

  /**
   * Find similar template names (for error suggestions)
   * @param name - Template name to find similarities for
   * @returns Array of similar template names
   */
  static findSimilarTemplates(name: string): string[] {
    const lowerName = name.toLowerCase();
    const allNames = this.listTemplateNames();

    // Find templates that contain the search term or vice versa
    const similar = allNames.filter(templateName => {
      return templateName.includes(lowerName) ||
             lowerName.includes(templateName) ||
             this.calculateSimilarity(lowerName, templateName) > 0.5;
    });

    return similar.slice(0, 5); // Return top 5 similar templates
  }

  /**
   * Calculate string similarity (simple Jaccard similarity)
   * @param str1 - First string
   * @param str2 - Second string
   * @returns Similarity score between 0 and 1
   */
  private static calculateSimilarity(str1: string, str2: string): number {
    const set1 = new Set(str1.split(''));
    const set2 = new Set(str2.split(''));
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    return intersection.size / union.size;
  }

  /**
   * Validate template name and throw detailed error if not found
   * @param name - Template name to validate
   * @throws Error with suggestions if template not found
   */
  static validateTemplate(name: string): void {
    if (!name || name.trim() === '') {
      throw new Error(
        `Template name cannot be empty. Available templates: ${this.listTemplateNames().slice(0, 10).join(', ')}...`
      );
    }

    if (!this.hasTemplate(name)) {
      const similar = this.findSimilarTemplates(name);
      let errorMessage = `Template not found: "${name}"`;

      if (similar.length > 0) {
        errorMessage += `\n  Did you mean one of these? ${similar.map(t => `"${t}"`).join(', ')}`;
      }

      errorMessage += `\n  Use GET /api/devices/templates to see all available templates`;
      errorMessage += `\n  Currently ${this.templates.size} templates are available`;

      throw new Error(errorMessage);
    }
  }

  /**
   * Create a device from a template
   * @param templateName - Name of template
   * @param instanceName - Name for this device instance
   * @param options - Additional options
   * @returns Simulated device instance
   */
  static createFromTemplate(
    templateName: string,
    instanceName: string,
    options: any = {}
  ): SimulatedDevice {
    // Validate template with detailed error message
    this.validateTemplate(templateName);

    const template = this.getTemplate(templateName);

    if (!template) {
      // This should never happen after validateTemplate, but TypeScript needs it
      throw new Error(`Template not found: ${templateName}`);
    }

    logger.info(`Creating device from template: ${templateName}`);
    logger.info(`Template type: "${template.type}", capabilities:`, template.capabilities);

    // Use DeviceFactory methods based on template type
    switch (template.type) {
      case 'thermostat':
        logger.info(`Using createThermostat for ${templateName}`);
        return DeviceFactory.createThermostat(instanceName, options);
      case 'light':
        logger.info(`Using createLight for ${templateName}`);
        return DeviceFactory.createLight(instanceName, options);
      case 'sensor':
        // Extract sensor type from capabilities
        logger.info(`Using createSensor for ${templateName}`);
        const sensorType = options.sensorType || 'temperature';
        logger.info(`Sensor type: ${sensorType}`);
        return DeviceFactory.createSensor(instanceName, sensorType, options);
      case 'actuator':
        logger.info(`Using createActuator for ${templateName}`);
        return DeviceFactory.createActuator(instanceName, options.actuatorType || 'switch', options);
      default:
        logger.info(`Unknown template type: ${template.type}, falling back to createDevice`);
        return DeviceFactory.createDevice({
          name: instanceName,
          type: template.type,
          initialState: {},
          capabilities: template.capabilities.map((name: string) => ({ name, type: 'read' as CapabilityType, parameters: [] })),
          behaviors: [],
          location: options.location,
          metadata: options.metadata || {},
        });
    }
  }

  /**
   * Initialize default templates
   */
  static initializeDefaults(): void {
    // Temperature Sensor
    this.registerTemplate({
      name: 'temperature-sensor',
      type: 'sensor',
      category: 'environment',
      description: 'Reports temperature readings',
      capabilities: ['read-temperature'],
      defaultBehaviors: ['periodic'],
    });

    // Humidity Sensor
    this.registerTemplate({
      name: 'humidity-sensor',
      type: 'sensor',
      category: 'environment',
      description: 'Reports humidity readings',
      capabilities: ['read-humidity'],
      defaultBehaviors: ['periodic'],
    });

    // Motion Sensor
    // Note: Motion sensors are passive - they READ motion from environment, not CREATE it
    // Motion in the environment should be created by other sources (people, animals, etc.)
    this.registerTemplate({
      name: 'motion-sensor',
      type: 'sensor',
      category: 'environment',
      description: 'Detects motion',
      capabilities: ['read-motion'],
      defaultBehaviors: ['periodic'],
      // No environment effects - motion sensors are passive observers
    });

    // Light Switch
    this.registerTemplate({
      name: 'light-switch',
      type: 'actuator',
      category: 'lighting',
      description: 'On/off light switch',
      capabilities: ['get-state', 'set-state'],
      defaultBehaviors: [],
    });

    // Smart Light
    this.registerTemplate({
      name: 'smart-light',
      type: 'light',
      category: 'lighting',
      description: 'Dimmable smart light',
      capabilities: ['get-state', 'set-state', 'set-brightness'],
      defaultBehaviors: [],
      environmentEffects: [
        // Light on effect
        {
          command: 'set-state',
          parameter: PhysicalParameter.LIGHT,
          effect: 'persistent',
          magnitude: 800, // 800 lux when turned on
          condition: {
            parameter: 'on',
            operator: 'eq',
            value: true
          },
          spatial: {
            radius: 5, // 5 meter radius
            falloff: 'inverse-square'
          }
        },
        // Light off effect
        {
          command: 'set-state',
          parameter: PhysicalParameter.LIGHT,
          effect: 'persistent',
          magnitude: 0, // 0 lux when turned off
          condition: {
            parameter: 'on',
            operator: 'eq',
            value: false
          },
          spatial: {
            radius: 5, // 5 meter radius
            falloff: 'inverse-square'
          }
        }
      ]
    });

    // Light Controller (for testing)
    this.registerTemplate({
      name: 'light-controller',
      type: 'light',
      description: 'Smart light controller with on/off and brightness',
      capabilities: ['get-state', 'set-state', 'set-brightness', 'toggle'],
      defaultBehaviors: [],
    });

    // Thermostat
    this.registerTemplate({
      name: 'thermostat',
      type: 'thermostat',
      description: 'Temperature control thermostat',
      capabilities: ['read-temperature', 'set-target-temperature', 'get-mode', 'set-mode'],
      defaultBehaviors: ['periodic'],
      environmentEffects: [
        // Cooling effect when mode is 'cool'
        {
          command: 'set-mode',
          parameter: PhysicalParameter.TEMPERATURE,
          effect: 'gradual',
          magnitude: -2500, // Cooling power: 2.5 kW = 2500 W (negative for cooling)
          duration: 300, // 5 minutes to reach target temperature
          condition: {
            parameter: 'mode',
            operator: 'eq',
            value: 'cool'
          },
          spatial: {
            radius: 10, // 10 meter radius
            falloff: 'linear'
          }
        },
        // Heating effect when mode is 'heat'
        {
          command: 'set-mode',
          parameter: PhysicalParameter.TEMPERATURE,
          effect: 'gradual',
          magnitude: 3000, // Heating power: 3.0 kW = 3000 W (positive for heating)
          duration: 300, // 5 minutes to reach target temperature
          condition: {
            parameter: 'mode',
            operator: 'eq',
            value: 'heat'
          },
          spatial: {
            radius: 10, // 10 meter radius
            falloff: 'linear'
          }
        }
      ]
    });

    // HVAC Controller
    this.registerTemplate({
      name: 'hvac-controller',
      type: 'actuator',
      category: 'hvac',
      description: 'HVAC control system for heating and cooling',
      capabilities: ['read-temperature', 'set-target-temperature', 'get-mode', 'set-mode', 'control-hvac'],
      defaultBehaviors: ['periodic'],
      environmentEffects: [
        // Cooling effect when mode is 'cool'
        {
          command: 'set-mode',
          parameter: PhysicalParameter.TEMPERATURE,
          effect: 'gradual',
          magnitude: -3500, // Cooling power: 3.5 kW = 3500 W (negative for cooling)
          duration: 600, // 10 minutes to reach target temperature
          condition: {
            parameter: 'mode',
            operator: 'eq',
            value: 'cool'
          },
          spatial: {
            radius: 15, // 15 meter radius for HVAC system
            falloff: 'linear'
          }
        },
        // Heating effect when mode is 'heat'
        {
          command: 'set-mode',
          parameter: PhysicalParameter.TEMPERATURE,
          effect: 'gradual',
          magnitude: 4000, // Heating power: 4.0 kW = 4000 W (positive for heating)
          duration: 600, // 10 minutes to reach target temperature
          condition: {
            parameter: 'mode',
            operator: 'eq',
            value: 'heat'
          },
          spatial: {
            radius: 15, // 15 meter radius for HVAC system
            falloff: 'linear'
          }
        }
      ]
    });

    // ============================================================================
    // Mobility Device Templates
    // ============================================================================

    // Smartphone
    this.registerTemplate({
      name: 'smartphone',
      type: 'smartphone',
      description: 'Personal smartphone with location tracking',
      capabilities: [
        'track-location',
        'detect-movement',
        'receive-notifications',
        'scan-environment',
        'user-presence',
        'capture-camera',
        'measure-motion'
      ],
      defaultBehaviors: ['periodic'],
    });

    // Tablet
    this.registerTemplate({
      name: 'tablet',
      type: 'tablet',
      description: 'Tablet device with location tracking',
      capabilities: [
        'track-location',
        'detect-movement',
        'receive-notifications',
        'scan-environment',
        'display-content'
      ],
      defaultBehaviors: ['periodic'],
    });

    // Wearable (Smartwatch)
    this.registerTemplate({
      name: 'wearable',
      type: 'wearable',
      description: 'Wearable device (smartwatch)',
      capabilities: [
        'track-location',
        'detect-movement',
        'heart-monitor',
        'receive-alerts',
        'measure-steps'
      ],
      defaultBehaviors: ['periodic'],
    });

    // BLE Beacon
    this.registerTemplate({
      name: 'ble-beacon',
      type: 'ble-beacon',
      description: 'Bluetooth Low Energy beacon for zone identification',
      capabilities: [
        'broadcast-location',
        'detect-proximity',
        'signal-strength',
        'zone-identify'
      ],
      defaultBehaviors: ['continuous'],
    });

    // WiFi Tracker
    this.registerTemplate({
      name: 'wifi-tracker',
      type: 'wifi-tracker',
      description: 'WiFi-based location tracker',
      capabilities: [
        'track-location',
        'detect-proximity',
        'zone-identify',
        'measure-signal-strength'
      ],
      defaultBehaviors: ['continuous'],
    });

    // RFID Tag
    this.registerTemplate({
      name: 'rfid-tag',
      type: 'rfid-tag',
      description: 'RFID identification tag',
      capabilities: [
        'broadcast-id',
        'detect-proximity',
        'log-access'
      ],
      defaultBehaviors: ['event-driven'],
    });

    // Cleaning Robot
    this.registerTemplate({
      name: 'cleaning-robot',
      type: 'cleaning-robot',
      description: 'Autonomous floor cleaning robot',
      capabilities: [
        'navigate-to',
        'avoid-obstacles',
        'detect-dirt',
        'suction-control',
        'return-to-dock',
        'report-location',
        'receive-commands'
      ],
      defaultBehaviors: ['scripted'],
    });

    // Delivery Robot
    this.registerTemplate({
      name: 'delivery-robot',
      type: 'delivery-robot',
      description: 'Autonomous package delivery robot',
      capabilities: [
        'navigate-to',
        'avoid-obstacles',
        'carry-items',
        'report-location',
        'confirm-delivery',
        'receive-commands'
      ],
      defaultBehaviors: ['scripted'],
    });

    // Security Robot
    this.registerTemplate({
      name: 'security-robot',
      type: 'security-robot',
      description: 'Autonomous night patrol robot',
      capabilities: [
        'navigate-to',
        'avoid-obstacles',
        'capture-aerial',
        'report-location',
        'detect-intruder',
        'receive-commands'
      ],
      defaultBehaviors: ['scripted'],
    });

    // Surveillance Drone
    this.registerTemplate({
      name: 'surveillance-drone',
      type: 'surveillance-drone',
      description: 'Autonomous surveillance drone',
      capabilities: [
        'fly-to',
        'capture-aerial',
        'avoid-collision',
        'follow-path',
        'land-safely',
        'report-location'
      ],
      defaultBehaviors: ['scripted'],
    });

    // Inspection Drone
    this.registerTemplate({
      name: 'inspection-drone',
      type: 'inspection-drone',
      description: 'Autonomous inspection drone',
      capabilities: [
        'fly-to',
        'capture-aerial',
        'avoid-collision',
        'follow-path',
        'land-safely',
        'inspect-structure'
      ],
      defaultBehaviors: ['scripted'],
    });

    // ============================================================================
    // Office Automation Device Templates (for Tutorial)
    // ============================================================================

    // Projector
    this.registerTemplate({
      name: 'projector',
      type: 'projector',
      description: 'Conference room projector for presentations',
      capabilities: [
        'get-state',
        'set-state',
        'get-input-source',
        'set-input-source',
        'get-lamp-hours'
      ],
      defaultBehaviors: [],
    });

    // Video Conference System
    this.registerTemplate({
      name: 'video-conference',
      type: 'video-conference',
      description: 'Video conference system for remote meetings',
      capabilities: [
        'get-state',
        'set-state',
        'start-meeting',
        'end-meeting',
        'get-participants',
        'mute-audio',
        'mute-video'
      ],
      defaultBehaviors: [],
    });

    // WiFi Access Point
    this.registerTemplate({
      name: 'wifi-ap',
      type: 'network-device',
      description: 'WiFi access point for network connectivity',
      capabilities: [
        'get-state',
        'get-connected-clients',
        'get-signal-strength',
        'reboot'
      ],
      defaultBehaviors: ['periodic'],
    });

    // Display Panel
    this.registerTemplate({
      name: 'display-panel',
      type: 'display-panel',
      description: 'Digital display panel for meeting information',
      capabilities: [
        'get-state',
        'set-state',
        'show-message',
        'show-schedule',
        'update-status'
      ],
      defaultBehaviors: [],
    });

    // Smart Lock
    this.registerTemplate({
      name: 'smart-lock',
      type: 'smart-lock',
      description: 'Smart door lock for access control',
      capabilities: [
        'get-state',
        'unlock',
        'lock',
        'get-access-log',
        'grant-temporary-access'
      ],
      defaultBehaviors: [],
    });

    // Light Sensor
    this.registerTemplate({
      name: 'light-sensor',
      type: 'sensor',
      description: 'Measures ambient light levels',
      capabilities: ['read', 'read-light'],
      defaultBehaviors: ['periodic'],
    });

    // Emergency Button
    this.registerTemplate({
      name: 'emergency-button',
      type: 'emergency-button',
      description: 'Emergency button for alerting',
      capabilities: [
        'get-state',
        'get-press-count',
        'reset'
      ],
      defaultBehaviors: ['event-driven'],
    });

    // Surveillance Camera
    this.registerTemplate({
      name: 'surveillance-camera',
      type: 'camera',
      category: 'safety',
      description: 'Surveillance camera for security monitoring',
      capabilities: [
        'get-state',
        'get-recording-status',
        'get-motion-detected',
        'enable-recording',
        'disable-recording',
        'take-snapshot'
      ],
      defaultBehaviors: ['continuous'],
    });

    // ============================================================================
    // SMART CITY DEVICE TEMPLATES (Phase 2)
    // ============================================================================

    // Transportation Devices
    this.registerTemplate({
      name: 'traffic-light-controller',
      type: 'traffic-light',
      category: 'smart-city',
      description: 'Controls traffic lights at intersections',
      capabilities: [
        'get-state',
        'set-light',
        'detect-vehicles',
        'get-queue-length',
        'set-timing-mode'
      ],
      defaultBehaviors: ['periodic'],
      environmentEffects: [
        {
          command: 'set-light',
          parameter: PhysicalParameter.TRAFFIC_FLOW,
          effect: 'persistent',
          magnitude: 100, // Maximum traffic flow when green light
          condition: { parameter: 'light', operator: 'eq', value: 'green' },
          spatial: { radius: 50, falloff: 'linear' }
        }
      ],
      visualization: { icon: 'traffic-light', color: '#FF5722', size: 6, layer: 'transport' }
    });

    this.registerTemplate({
      name: 'traffic-sensor',
      type: 'sensor',
      category: 'smart-city',
      description: 'Monitors traffic flow and congestion',
      capabilities: [
        'read-traffic-flow',
        'read-vehicle-count',
        'read-average-speed',
        'detect-congestion'
      ],
      defaultBehaviors: ['periodic'],
      visualization: { icon: 'road', color: '#795548', size: 4, layer: 'transport' }
    });

    this.registerTemplate({
      name: 'smart-parking-meter',
      type: 'parking-meter',
      category: 'smart-city',
      description: 'Smart parking meter with payment and occupancy detection',
      capabilities: [
        'get-state',
        'read-occupancy',
        'process-payment',
        'set-occupancy-rate',
        'notify-full'
      ],
      defaultBehaviors: ['event-driven'],
      visualization: { icon: 'parking', color: '#009688', size: 4, layer: 'transport' }
    });

    this.registerTemplate({
      name: 'electrical-vehicle-charging-station',
      type: 'charging-station',
      category: 'smart-city',
      description: 'EV charging station with load management',
      capabilities: [
        'get-state',
        'start-charging',
        'stop-charging',
        'read-charging-level',
        'set-charging-power',
        'get-availability'
      ],
      defaultBehaviors: ['continuous'],
      environmentEffects: [
        {
          command: 'start-charging',
          parameter: PhysicalParameter.POWER,
          effect: 'persistent',
          magnitude: 7200, // 7.2 kW charger
          spatial: { radius: 2, falloff: 'linear' }
        }
      ],
      visualization: { icon: 'charging-station', color: '#4CAF50', size: 6, layer: 'transport' }
    });

    // Environmental Monitoring Devices
    this.registerTemplate({
      name: 'air-quality-sensor',
      type: 'sensor',
      category: 'smart-city',
      description: 'Monitors air quality parameters (PM2.5, PM10, CO2, etc.)',
      capabilities: [
        'read-pm25',
        'read-pm10',
        'read-co2',
        'read-aqi',
        'detect-pollution-alert'
      ],
      defaultBehaviors: ['periodic'],
      visualization: { icon: 'air-quality', color: '#607D8B', size: 4, layer: 'environment' }
    });

    this.registerTemplate({
      name: 'noise-monitor',
      type: 'sensor',
      category: 'smart-city',
      description: 'Monitors noise levels in urban areas',
      capabilities: [
        'read-noise-level',
        'detect-noise-violation',
        'read-frequency-spectrum'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'volume-up', color: '#9C27B0', size: 4, layer: 'environment' }
    });

    this.registerTemplate({
      name: 'weather-station',
      type: 'weather-station',
      category: 'smart-city',
      description: 'Comprehensive weather monitoring station',
      capabilities: [
        'read-temperature',
        'read-humidity',
        'read-pressure',
        'read-wind-speed',
        'read-wind-direction',
        'read-rainfall',
        'read-uv-index'
      ],
      defaultBehaviors: ['periodic'],
      visualization: { icon: 'weather', color: '#03A9F4', size: 6, layer: 'environment' }
    });

    this.registerTemplate({
      name: 'water-quality-sensor',
      type: 'sensor',
      category: 'smart-city',
      description: 'Monitors water quality parameters',
      capabilities: [
        'read-ph',
        'read-turbidity',
        'read-tds',
        'read-temperature',
        'detect-contamination'
      ],
      defaultBehaviors: ['periodic'],
      visualization: { icon: 'water-drop', color: '#2196F3', size: 4, layer: 'environment' }
    });

    // Public Safety Devices
    this.registerTemplate({
      name: 'smart-street-light',
      type: 'street-light',
      category: 'smart-city',
      description: 'Intelligent street lighting with adaptive brightness',
      capabilities: [
        'get-state',
        'set-state',
        'set-brightness',
        'detect-motion',
        'enable-adaptive-mode',
        'detect-fault'
      ],
      defaultBehaviors: ['continuous'],
      environmentEffects: [
        {
          command: 'set-state',
          parameter: PhysicalParameter.LIGHT,
          effect: 'persistent',
          magnitude: 500, // Light level in lux when on
          condition: { parameter: 'on', operator: 'eq', value: true },
          spatial: { radius: 15, falloff: 'inverse-square' }
        }
      ],
      visualization: { icon: 'street-light', color: '#FFC107', size: 5, layer: 'safety' }
    });

    this.registerTemplate({
      name: 'emergency-call-box',
      type: 'emergency-device',
      category: 'smart-city',
      description: 'Emergency communication and alert system',
      capabilities: [
        'activate-emergency',
        'get-gps-location',
        'two-way-audio',
        'detect-activation',
        'notify-authorities'
      ],
      defaultBehaviors: ['event-driven'],
      environmentEffects: [
        {
          command: 'activate-emergency',
          parameter: PhysicalParameter.ALARM_STATUS,
          effect: 'persistent',
          magnitude: 1,
          spatial: { radius: 200, falloff: 'inverse-square' }
        }
      ],
      visualization: { icon: 'emergency', color: '#F44336', size: 7, layer: 'safety' }
    });

    this.registerTemplate({
      name: 'gunshot-detector',
      type: 'acoustic-sensor',
      category: 'smart-city',
      description: 'Acoustic sensor for gunshot detection',
      capabilities: [
        'detect-acoustic-event',
        'get-location',
        'classify-sound',
        'notify-authorities'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'warning', color: '#D32F2F', size: 5, layer: 'safety' }
    });

    this.registerTemplate({
      name: 'flood-detector',
      type: 'sensor',
      category: 'smart-city',
      description: 'Detects flooding in low-lying areas',
      capabilities: [
        'read-water-level',
        'detect-flood-risk',
        'trigger-alert',
        'read-flow-rate'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'flood', color: '#00BCD4', size: 5, layer: 'safety' }
    });

    this.registerTemplate({
      name: 'earthquake-sensor',
      type: 'seismic-sensor',
      category: 'smart-city',
      description: 'Seismic activity monitoring sensor',
      capabilities: [
        'read-seismic-activity',
        'detect-earthquake',
        'measure-magnitude',
        'trigger-alert'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'earthquake', color: '#795548', size: 5, layer: 'safety' }
    });

    // Waste Management Devices
    this.registerTemplate({
      name: 'smart-waste-bin',
      type: 'waste-container',
      category: 'smart-city',
      description: 'Smart waste bin with fill-level monitoring',
      capabilities: [
        'read-fill-level',
        'detect-full',
        'optimize-collection-route',
        'notify-collection'
      ],
      defaultBehaviors: ['periodic'],
      visualization: { icon: 'trash', color: '#795548', size: 4, layer: 'utilities' }
    });

    this.registerTemplate({
      name: 'recycling-sorter',
      type: 'recycling-system',
      category: 'smart-city',
      description: 'Automated recycling sorting system',
      capabilities: [
        'sort-materials',
        'read-capacity',
        'detect-contamination',
        'optimize-schedule'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'recycle', color: '#4CAF50', size: 5, layer: 'utilities' }
    });

    // Energy Management Devices
    this.registerTemplate({
      name: 'smart-meter',
      type: 'energy-meter',
      category: 'smart-city',
      description: 'Smart energy meter with real-time monitoring',
      capabilities: [
        'read-energy-consumption',
        'read-power',
        'read-voltage',
        'read-current',
        'detect-anomaly'
      ],
      defaultBehaviors: ['periodic'],
      visualization: { icon: 'meter', color: '#FF9800', size: 4, layer: 'utilities' }
    });

    this.registerTemplate({
      name: 'solar-panel-monitor',
      type: 'energy-monitor',
      category: 'smart-city',
      description: 'Solar panel generation monitoring',
      capabilities: [
        'read-generation',
        'read-efficiency',
        'detect-fault',
        'read-temperature'
      ],
      defaultBehaviors: ['periodic'],
      visualization: { icon: 'solar-panel', color: '#FFEB3B', size: 5, layer: 'utilities' }
    });

    this.registerTemplate({
      name: 'wind-turbine-monitor',
      type: 'energy-monitor',
      category: 'smart-city',
      description: 'Wind turbine generation monitoring',
      capabilities: [
        'read-generation',
        'read-wind-speed',
        'read-rotor-speed',
        'detect-fault'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'wind-turbine', color: '#00BCD4', size: 7, layer: 'utilities' }
    });

    // Infrastructure Monitoring Devices
    this.registerTemplate({
      name: 'bridge-monitor',
      type: 'structural-monitor',
      category: 'smart-city',
      description: 'Structural health monitoring for bridges',
      capabilities: [
        'read-vibration',
        'read-stress',
        'detect-damage',
        'predict-maintenance'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'bridge', color: '#607D8B', size: 8, layer: 'infrastructure' }
    });

    this.registerTemplate({
      name: 'smart-valve',
      type: 'water-valve',
      category: 'smart-city',
      description: 'Smart water flow control valve',
      capabilities: [
        'get-state',
        'open',
        'close',
        'read-flow-rate',
        'detect-leak',
        'set-pressure'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'valve', color: '#2196F3', size: 4, layer: 'infrastructure' }
    });

    this.registerTemplate({
      name: 'smart-manhole-cover',
      type: 'infrastructure-sensor',
      category: 'smart-city',
      description: 'Smart manhole cover with sensors',
      capabilities: [
        'detect-open',
        'read-gas-levels',
        'detect-unauthorized-access',
        'read-temperature'
      ],
      defaultBehaviors: ['periodic'],
      visualization: { icon: 'manhole', color: '#424242', size: 3, layer: 'infrastructure' }
    });

    // Public Services Devices
    this.registerTemplate({
      name: 'digital-billboard',
      type: 'display',
      category: 'smart-city',
      description: 'Digital billboard for public information',
      capabilities: [
        'get-state',
        'show-content',
        'update-schedule',
        'set-brightness',
        'detect-fault'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'billboard', color: '#E91E63', size: 7, layer: 'services' }
    });

    this.registerTemplate({
      name: 'public-wifi-hotspot',
      type: 'network-device',
      category: 'smart-city',
      description: 'Public WiFi hotspot with usage monitoring',
      capabilities: [
        'get-state',
        'read-connected-users',
        'read-bandwidth',
        'set-limit',
        'detect-congestion'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'wifi', color: '#9C27B0', size: 5, layer: 'services' }
    });

    this.registerTemplate({
      name: 'smart-bench',
      type: 'public-furniture',
      category: 'smart-city',
      description: 'Smart bench with environmental monitoring',
      capabilities: [
        'read-occupancy',
        'read-temperature',
        'read-noise-level',
        'solar-charging-status',
        'light-control'
      ],
      defaultBehaviors: ['periodic'],
      visualization: { icon: 'bench', color: '#8D6E63', size: 4, layer: 'services' }
    });

    this.registerTemplate({
      name: 'wayfinding-kiosk',
      type: 'information-kiosk',
      category: 'smart-city',
      description: 'Interactive wayfinding and information kiosk',
      capabilities: [
        'get-state',
        'show-map',
        'provide-directions',
        'show-schedule',
        'detect-usage'
      ],
      defaultBehaviors: ['event-driven'],
      visualization: { icon: 'kiosk', color: '#00BCD4', size: 6, layer: 'services' }
    });

    // Agriculture and Parks
    this.registerTemplate({
      name: 'smart-irrigation-controller',
      type: 'irrigation-system',
      category: 'smart-city',
      description: 'Intelligent irrigation system for parks and gardens',
      capabilities: [
        'get-state',
        'start-watering',
        'stop-watering',
        'read-soil-moisture',
        'set-schedule',
        'read-water-consumption'
      ],
      defaultBehaviors: ['continuous'],
      environmentEffects: [
        {
          command: 'start-watering',
          parameter: PhysicalParameter.SOIL_MOISTURE,
          effect: 'gradual',
          magnitude: 20,
          duration: 600,
          spatial: { radius: 10, falloff: 'linear' }
        }
      ],
      visualization: { icon: 'water', color: '#4CAF50', size: 5, layer: 'environment' }
    });

    this.registerTemplate({
      name: 'park-sensor',
      type: 'environmental-sensor',
      category: 'smart-city',
      description: 'Environmental sensor for parks',
      capabilities: [
        'read-soil-moisture',
        'read-temperature',
        'read-humidity',
        'read-light-level',
        'detect-drought-stress'
      ],
      defaultBehaviors: ['periodic'],
      visualization: { icon: 'park', color: '#4CAF50', size: 4, layer: 'environment' }
    });

    // Advanced Traffic Management
    this.registerTemplate({
      name: 'variable-message-sign',
      type: 'traffic-sign',
      category: 'smart-city',
      description: 'Electronic variable message sign for traffic',
      capabilities: [
        'get-state',
        'display-message',
        'set-priority',
        'detect-fault',
        'read-visibility'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'sign', color: '#FFC107', size: 6, layer: 'transport' }
    });

    this.registerTemplate({
      name: 'speed-camera',
      type: 'traffic-enforcement',
      category: 'smart-city',
      description: 'Speed detection and enforcement camera',
      capabilities: [
        'read-vehicle-speed',
        'detect-violation',
        'capture-image',
        'read-plate-number',
        'issue-citation'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'camera', color: '#F44336', size: 5, layer: 'transport' }
    });

    this.registerTemplate({
      name: 'bus-stop-monitor',
      type: 'transit-monitor',
      category: 'smart-city',
      description: 'Smart bus stop with real-time information',
      capabilities: [
        'read-occupancy',
        'display-arrival-time',
        'detect-crowding',
        'emergency-alert',
        'read-air-quality'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'bus', color: '#2196F3', size: 6, layer: 'transport' }
    });

    // Security and Surveillance
    this.registerTemplate({
      name: 'license-plate-reader',
      type: 'surveillance',
      category: 'smart-city',
      description: 'Automated license plate recognition system',
      capabilities: [
        'read-plate',
        'read-vehicle-speed',
        'check-database',
        'trigger-alert',
        'log-entry'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'license-plate', color: '#607D8B', size: 5, layer: 'safety' }
    });

    this.registerTemplate({
      name: 'crowd-monitor',
      type: 'analytics-sensor',
      category: 'smart-city',
      description: 'Crowd density monitoring system',
      capabilities: [
        'read-crowd-count',
        'detect-overcrowding',
        'analyze-flow',
        'predict-congestion',
        'trigger-alert'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'crowd', color: '#9E9E9E', size: 5, layer: 'safety' }
    });

    this.registerTemplate({
      name: 'smart-pole',
      type: 'multi-function-pole',
      category: 'smart-city',
      description: 'Multi-functional smart pole with various sensors',
      capabilities: [
        'street-light-control',
        'read-air-quality',
        'read-noise-level',
        'wifi-provision',
        'emergency-call',
        'camera-recording'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'smart-pole', color: '#9E9E9E', size: 7, layer: 'infrastructure' }
    });

    // Additional Smart City Devices
    this.registerTemplate({
      name: 'electric-grid-monitor',
      type: 'grid-monitor',
      category: 'smart-city',
      description: 'Electric grid health monitoring system',
      capabilities: [
        'read-voltage',
        'read-current',
        'read-frequency',
        'detect-fault',
        'predict-outage',
        'balance-load'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'grid', color: '#FFC107', size: 6, layer: 'utilities' }
    });

    this.registerTemplate({
      name: 'smart-parking-garage',
      type: 'parking-system',
      category: 'smart-city',
      description: 'Smart parking garage management system',
      capabilities: [
        'read-occupancy',
        'guide-vehicle',
        'process-payment',
        'detect-available-spots',
        'optimize-usage'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'garage', color: '#795548', size: 7, layer: 'transport' }
    });

    this.registerTemplate({
      name: 'bicycle-sharing-station',
      type: 'sharing-system',
      category: 'smart-city',
      description: 'Bicycle sharing station monitoring',
      capabilities: [
        'read-availability',
        'rent-bicycle',
        'return-bicycle',
        'detect-maintenance-need',
        'report-usage'
      ],
      defaultBehaviors: ['event-driven'],
      visualization: { icon: 'bicycle', color: '#4CAF50', size: 5, layer: 'transport' }
    });

    this.registerTemplate({
      name: 'smart-crosswalk',
      type: 'pedestrian-safety',
      category: 'smart-city',
      description: 'Smart crosswalk with pedestrian detection',
      capabilities: [
        'detect-pedestrians',
        'control-traffic-light',
        'activate-warning-lights',
        'read-traffic-flow',
        'emergency-stop'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'crosswalk', color: '#FFFFFF', size: 6, layer: 'transport' }
    });

    this.registerTemplate({
      name: 'drone-docking-station',
      type: 'drone-infrastructure',
      category: 'smart-city',
      description: 'Automated drone docking and charging station',
      capabilities: [
        'dock-drone',
        'charge-drone',
        'read-battery-level',
        'schedule-mission',
        'transmit-data'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'drone-station', color: '#9C27B0', size: 7, layer: 'infrastructure' }
    });

    this.registerTemplate({
      name: 'smart-hydrant',
      type: 'water-infrastructure',
      category: 'smart-city',
      description: 'Smart fire hydrant with pressure monitoring',
      capabilities: [
        'read-pressure',
        'detect-leak',
        'control-flow',
        'read-temperature',
        'emergency-shutoff'
      ],
      defaultBehaviors: ['continuous'],
      visualization: { icon: 'hydrant', color: '#F44336', size: 5, layer: 'infrastructure' }
    });

    // ============================================================================
    // Additional Home/Safety Device Templates
    // Used by e2e tests and closed-loop scenarios
    // ============================================================================

    // AC Controller (air conditioning)
    this.registerTemplate({
      name: 'ac-controller',
      type: 'actuator',
      category: 'hvac',
      description: 'Air conditioning controller for cooling and dehumidification',
      capabilities: ['read-temperature', 'set-target-temperature', 'get-mode', 'set-mode', 'control-ac'],
      defaultBehaviors: ['periodic'],
      environmentEffects: [
        {
          command: 'set-mode',
          parameter: PhysicalParameter.TEMPERATURE,
          effect: 'gradual',
          magnitude: -3000,
          duration: 600,
          condition: { parameter: 'mode', operator: 'eq', value: 'cool' },
          spatial: { radius: 10, falloff: 'linear' }
        },
        {
          command: 'set-mode',
          parameter: PhysicalParameter.HUMIDITY,
          effect: 'gradual',
          magnitude: -2000,
          duration: 600,
          condition: { parameter: 'mode', operator: 'eq', value: 'dehumidify' },
          spatial: { radius: 10, falloff: 'linear' }
        }
      ]
    });

    // Humidifier
    this.registerTemplate({
      name: 'humidifier',
      type: 'actuator',
      category: 'hvac',
      description: 'Humidifier for controlling indoor humidity levels',
      capabilities: ['read-humidity', 'set-target-humidity', 'get-mode', 'set-mode'],
      defaultBehaviors: ['periodic'],
      environmentEffects: [
        {
          command: 'set-mode',
          parameter: PhysicalParameter.HUMIDITY,
          effect: 'gradual',
          magnitude: 1500,
          duration: 300,
          condition: { parameter: 'mode', operator: 'eq', value: 'on' },
          spatial: { radius: 5, falloff: 'linear' }
        }
      ]
    });

    // Heater
    this.registerTemplate({
      name: 'heater',
      type: 'actuator',
      category: 'hvac',
      description: 'Electric heater for room heating',
      capabilities: ['read-temperature', 'set-target-temperature', 'get-mode', 'set-mode'],
      defaultBehaviors: ['periodic'],
      environmentEffects: [
        {
          command: 'set-mode',
          parameter: PhysicalParameter.TEMPERATURE,
          effect: 'gradual',
          magnitude: 2500,
          duration: 300,
          condition: { parameter: 'mode', operator: 'eq', value: 'on' },
          spatial: { radius: 8, falloff: 'linear' }
        }
      ]
    });

    // Smoke Sensor
    this.registerTemplate({
      name: 'smoke-sensor',
      type: 'sensor',
      category: 'safety',
      description: 'Smoke detection sensor with alarm trigger capability',
      capabilities: ['read-smoke-level', 'detect-smoke', 'get-alarm-status', 'trigger-alarm'],
      defaultBehaviors: ['continuous'],
    });

    // Emergency Alarm
    this.registerTemplate({
      name: 'emergency-alarm',
      type: 'actuator',
      category: 'safety',
      description: 'Emergency alarm system with audio and visual alerts',
      capabilities: ['get-status', 'activate', 'deactivate', 'test-alarm'],
      defaultBehaviors: [],
    });

    // Ventilator
    this.registerTemplate({
      name: 'ventilator',
      type: 'actuator',
      category: 'hvac',
      description: 'Ventilation system for air circulation and smoke extraction',
      capabilities: ['get-status', 'set-speed', 'set-mode', 'emergency-extract'],
      defaultBehaviors: ['periodic'],
      environmentEffects: [
        {
          command: 'set-mode',
          parameter: PhysicalParameter.TEMPERATURE,
          effect: 'gradual',
          magnitude: -500,
          duration: 300,
          condition: { parameter: 'mode', operator: 'eq', value: 'extract' },
          spatial: { radius: 8, falloff: 'linear' }
        }
      ]
    });

    // Sprinkler
    this.registerTemplate({
      name: 'sprinkler',
      type: 'actuator',
      category: 'safety',
      description: 'Fire sprinkler system with automatic and manual activation',
      capabilities: ['get-status', 'activate', 'deactivate', 'set-spray-pattern'],
      defaultBehaviors: [],
    });

    logger.info(`Initialized ${this.templates.size} default templates`);
  }
}

// Initialize default templates
DeviceTemplateRegistry.initializeDefaults();
