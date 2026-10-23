/**
 * Configuration Validator
 *
 * Validates declarative configuration against schema rules
 * and semantic constraints.
 */

import type {
  DeclarativeConfig,
  EnvironmentConfig,
  DeviceTemplateConfig,
  AgentTemplateConfig,
  DevicePlacementConfig,
  AgentPlacementConfig,
  AutonomousModeConfig,
  TriggerConfig,
  ThresholdMonitorConfig,
  ScheduledCheckConfig,
  ConfigValidationResult,
  ConfigValidationError,
  ConfigValidationWarning,
} from './types';
import type { ConfigValidationResult as EnvConfigValidationResult } from '@active-collaboration/shared';

export class ConfigValidator {
  /**
   * Validate environment configuration (new schema)
   * Following Fail Early principle: throws errors loudly, not silent fallbacks
   */
  validateEnvironmentConfig(config: any): EnvConfigValidationResult {
    // Validate required fields
    if (!config.version) {
      throw new Error('version is required');
    }

    if (!config.environment) {
      throw new Error('environment is required');
    }

    if (!config.environment.id) {
      throw new Error('environment.id is required');
    }

    if (!config.environment.name) {
      throw new Error('environment.name is required');
    }

    // Validate ID format (lowercase, numbers, hyphens only)
    const idPattern = /^[a-z0-9-]+$/;
    if (!idPattern.test(config.environment.id)) {
      throw new Error(`environment.id must match pattern ${idPattern.source}`);
    }

    // Validate devices array
    if (!Array.isArray(config.devices)) {
      throw new Error('devices must be an array');
    }

    // Validate agents array
    if (!Array.isArray(config.agents)) {
      throw new Error('agents must be an array');
    }

    // Validate each device
    const deviceIds: string[] = [];
    for (const device of config.devices) {
      this.validateDevice(device);
      deviceIds.push(device.id);
    }

    // Validate each agent
    for (const agent of config.agents) {
      this.validateAgent(agent, deviceIds);
    }

    // Validate scenarios if present
    if (config.scenarios) {
      if (!Array.isArray(config.scenarios)) {
        throw new Error('scenarios must be an array');
      }
      for (const scenario of config.scenarios) {
        this.validateScenario(scenario);
      }
    }

    return { valid: true, errors: [] };
  }

  /**
   * Validate device configuration
   */
  validateDevice(device: any): EnvConfigValidationResult {
    if (!device.id) {
      throw new Error('device.id is required');
    }

    if (!device.name) {
      throw new Error('device.name is required');
    }

    if (!device.type) {
      throw new Error('device.type is required');
    }

    if (!Array.isArray(device.capabilities)) {
      throw new Error('device.capabilities must be an array');
    }

    if (device.capabilities.length === 0) {
      throw new Error('device.capabilities must have at least 1 element');
    }

    if (!device.location) {
      throw new Error('device.location is required');
    }

    if (!device.location.coordinates) {
      throw new Error('device.location.coordinates is required');
    }

    if (typeof device.location.coordinates.x !== 'number') {
      throw new Error('device.location.coordinates.x must be a number');
    }

    if (typeof device.location.coordinates.y !== 'number') {
      throw new Error('device.location.coordinates.y must be a number');
    }

    if (!device.behavior) {
      throw new Error('device.behavior is required');
    }

    if (!device.behavior.type) {
      throw new Error('device.behavior.type is required');
    }

    const validBehaviorTypes = ['periodic', 'event-driven', 'random'];
    if (!validBehaviorTypes.includes(device.behavior.type)) {
      throw new Error(`Invalid behavior type: ${device.behavior.type}. Must be one of: ${validBehaviorTypes.join(', ')}`);
    }

    if (device.behavior.type === 'periodic') {
      if (!device.behavior.interval) {
        throw new Error('interval is required for periodic behavior');
      }
      if (typeof device.behavior.interval !== 'number') {
        throw new Error('device.behavior.interval must be a number');
      }
    }

    if (!device.behavior.initialState) {
      throw new Error('device.behavior.initialState is required');
    }

    // Validate ID format
    const idPattern = /^[a-z0-9-]+$/;
    if (!idPattern.test(device.id)) {
      throw new Error(`device.id must match pattern ${idPattern.source}`);
    }

    return { valid: true, errors: [] };
  }

  /**
   * Validate agent configuration
   */
  validateAgent(agent: any, existingDevices: string[] = []): EnvConfigValidationResult {
    if (!agent.id) {
      throw new Error('agent.id is required');
    }

    if (!agent.name) {
      throw new Error('agent.name is required');
    }

    if (!agent.type) {
      throw new Error('agent.type is required');
    }

    const validAgentTypes = ['cognitive', 'reactive'];
    if (!validAgentTypes.includes(agent.type)) {
      throw new Error(`Invalid agent type: ${agent.type}. Must be one of: ${validAgentTypes.join(', ')}`);
    }

    if (!Array.isArray(agent.capabilities)) {
      throw new Error('agent.capabilities must be an array');
    }

    if (agent.capabilities.length === 0) {
      throw new Error('agent.capabilities must have at least 1 element');
    }

    if (!Array.isArray(agent.boundDevices)) {
      throw new Error('agent.boundDevices must be an array');
    }

    if (agent.boundDevices.length === 0) {
      throw new Error('agent.boundDevices must have at least 1 element');
    }

    // Validate boundDevices references
    for (const deviceId of agent.boundDevices) {
      if (!existingDevices.includes(deviceId)) {
        throw new Error(`agent.boundDevices references non-existent device: ${deviceId}`);
      }
    }

    if (!agent.config) {
      throw new Error('agent.config is required');
    }

    if (!agent.config.llmModel) {
      throw new Error('agent.config.llmModel is required');
    }

    // Validate ID format
    const idPattern = /^[a-z0-9-]+$/;
    if (!idPattern.test(agent.id)) {
      throw new Error(`agent.id must match pattern ${idPattern.source}`);
    }

    return { valid: true, errors: [] };
  }

  /**
   * Validate scenario configuration
   */
  private validateScenario(scenario: any): void {
    if (!scenario.id) {
      throw new Error('scenario.id is required');
    }

    if (!scenario.name) {
      throw new Error('scenario.name is required');
    }

    if (!scenario.trigger) {
      throw new Error('scenario.trigger is required');
    }

    if (!scenario.trigger.type) {
      throw new Error('scenario.trigger.type is required');
    }

    const validTriggerTypes = ['manual', 'automatic', 'scheduled'];
    if (!validTriggerTypes.includes(scenario.trigger.type)) {
      throw new Error(`Invalid trigger type: ${scenario.trigger.type}. Must be one of: ${validTriggerTypes.join(', ')}`);
    }

    if (!scenario.expectedOutcome) {
      throw new Error('scenario.expectedOutcome is required');
    }

    // Validate ID format
    const idPattern = /^[a-z0-9-]+$/;
    if (!idPattern.test(scenario.id)) {
      throw new Error(`scenario.id must match pattern ${idPattern.source}`);
    }
  }

  /**
   * Validate complete configuration
   */
  validate(config: DeclarativeConfig): ConfigValidationResult {
    const errors: ConfigValidationError[] = [];
    const warnings: ConfigValidationWarning[] = [];

    // Validate root structure
    this.validateRoot(config, errors, warnings);

    // Validate version
    this.validateVersion(config.version, errors);

    // Validate environments
    if (config.environments) {
      for (let i = 0; i < config.environments.length; i++) {
        this.validateEnvironment(config.environments[i], `environments[${i}]`, errors, warnings);
      }
    }

    // Validate device templates
    if (config.deviceTemplates) {
      for (let i = 0; i < config.deviceTemplates.length; i++) {
        this.validateDeviceTemplate(config.deviceTemplates[i], `deviceTemplates[${i}]`, errors, warnings);
      }
    }

    // Validate agent templates
    if (config.agentTemplates) {
      for (let i = 0; i < config.agentTemplates.length; i++) {
        this.validateAgentTemplate(config.agentTemplates[i], `agentTemplates[${i}]`, errors, warnings);
      }
    }

    // Validate autonomous rules
    if (config.autonomousRules) {
      for (let i = 0; i < config.autonomousRules.length; i++) {
        this.validateAutonomousRule(config.autonomousRules[i], `autonomousRules[${i}]`, errors, warnings);
      }
    }

    // Cross-reference validation
    this.validateCrossReferences(config, errors, warnings);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate root configuration structure
   */
  private validateRoot(config: DeclarativeConfig, errors: ConfigValidationError[], warnings: ConfigValidationWarning[]): void {
    if (!config.version) {
      errors.push({
        path: 'version',
        message: 'Configuration version is required',
        code: 'VERSION_REQUIRED',
      });
    }

    if (!config.environments || config.environments.length === 0) {
      errors.push({
        path: 'environments',
        message: 'At least one environment must be defined',
        code: 'ENVIRONMENT_REQUIRED',
      });
    }
  }

  /**
   * Validate configuration version
   */
  private validateVersion(version: string, errors: ConfigValidationError[]): void {
    const supportedVersions = ['1.0', '1.0.0'];
    if (!supportedVersions.includes(version)) {
      errors.push({
        path: 'version',
        message: `Unsupported configuration version: ${version}. Supported: ${supportedVersions.join(', ')}`,
        code: 'UNSUPPORTED_VERSION',
      });
    }
  }

  /**
   * Validate environment configuration
   */
  private validateEnvironment(
    env: EnvironmentConfig,
    basePath: string,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[]
  ): void {
    // Required fields
    if (!env.id) {
      errors.push({
        path: `${basePath}.id`,
        message: 'Environment ID is required',
        code: 'ID_REQUIRED',
      });
    }

    if (!env.name) {
      errors.push({
        path: `${basePath}.name`,
        message: 'Environment name is required',
        code: 'NAME_REQUIRED',
      });
    }

    // Validate type
    const validTypes = ['shared', 'private'];
    if (env.type && !validTypes.includes(env.type)) {
      errors.push({
        path: `${basePath}.type`,
        message: `Invalid environment type: ${env.type}. Must be one of: ${validTypes.join(', ')}`,
        code: 'INVALID_TYPE',
      });
    }

    // Validate visibility
    const validVisibilities = ['platform', 'invite-only', 'private'];
    if (env.visibility && !validVisibilities.includes(env.visibility)) {
      errors.push({
        path: `${basePath}.visibility`,
        message: `Invalid visibility: ${env.visibility}. Must be one of: ${validVisibilities.join(', ')}`,
        code: 'INVALID_VISIBILITY',
      });
    }

    // Validate zones
    if (env.zones) {
      for (let i = 0; i < env.zones.length; i++) {
        this.validateZone(env.zones[i], `${basePath}.zones[${i}]`, errors, warnings);
      }
    }

    // Validate device placements
    if (!env.devicePlacements || env.devicePlacements.length === 0) {
      warnings.push({
        path: `${basePath}.devicePlacements`,
        message: 'Environment has no devices defined',
        suggestion: 'Consider adding devices or this environment will be empty',
      });
    } else {
      for (let i = 0; i < env.devicePlacements.length; i++) {
        this.validateDevicePlacement(env.devicePlacements[i], `${basePath}.devicePlacements[${i}]`, errors, warnings);
      }
    }

    // Validate agent placements
    if (!env.agentPlacements || env.agentPlacements.length === 0) {
      warnings.push({
        path: `${basePath}.agentPlacements`,
        message: 'Environment has no agents defined',
        suggestion: 'Consider adding agents to manage devices',
      });
    } else {
      for (let i = 0; i < env.agentPlacements.length; i++) {
        this.validateAgentPlacement(env.agentPlacements[i], `${basePath}.agentPlacements[${i}]`, errors, warnings);
      }
    }

    // Validate zone references in device placements
    if (env.zones && env.devicePlacements) {
      const zoneIds = new Set(env.zones.map(z => z.id));
      for (const device of env.devicePlacements) {
        if (device.zone && !zoneIds.has(device.zone)) {
          errors.push({
            path: `${basePath}.devicePlacements`,
            message: `Device ${device.instanceName} references undefined zone: ${device.zone}`,
            code: 'UNDEFINED_ZONE',
          });
        }
      }
    }
  }

  /**
   * Validate zone configuration
   */
  private validateZone(
    zone: any,
    basePath: string,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[]
  ): void {
    if (!zone.id) {
      errors.push({
        path: `${basePath}.id`,
        message: 'Zone ID is required',
        code: 'ID_REQUIRED',
      });
    }

    if (!zone.name) {
      warnings.push({
        path: `${basePath}.name`,
        message: 'Zone name is recommended for clarity',
      });
    }

    const validZoneTypes = [
      'building', 'floor', 'room', 'outdoor', 'corridor',
      'storage', 'production', 'office', 'lab', 'datacenter', 'custom'
    ];
    if (zone.type && !validZoneTypes.includes(zone.type)) {
      warnings.push({
        path: `${basePath}.type`,
        message: `Unknown zone type: ${zone.type}`,
        suggestion: `Consider using one of: ${validZoneTypes.join(', ')}`,
      });
    }
  }

  /**
   * Validate device placement configuration
   */
  private validateDevicePlacement(
    device: DevicePlacementConfig,
    basePath: string,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[]
  ): void {
    if (!device.instanceName) {
      errors.push({
        path: `${basePath}.instanceName`,
        message: 'Device instance name is required',
        code: 'INSTANCE_NAME_REQUIRED',
      });
    }

    if (!device.zone) {
      errors.push({
        path: `${basePath}.zone`,
        message: 'Device zone is required',
        code: 'ZONE_REQUIRED',
      });
    }

    // Must have either templateId or inline definition
    if (!device.templateId && !device.inline) {
      errors.push({
        path: basePath,
        message: 'Device must have either templateId or inline definition',
        code: 'TEMPLATE_OR_INLINE_REQUIRED',
      });
    }

    // Validate inline device if present
    if (device.inline) {
      this.validateDeviceTemplate(device.inline, `${basePath}.inline`, errors, warnings);
    }

    // Validate criticality
    const validCriticalities = ['critical', 'high', 'medium', 'low'];
    if (device.criticality && !validCriticalities.includes(device.criticality)) {
      warnings.push({
        path: `${basePath}.criticality`,
        message: `Unknown criticality level: ${device.criticality}`,
        suggestion: `Use one of: ${validCriticalities.join(', ')}`,
      });
    }
  }

  /**
   * Validate agent placement configuration
   */
  private validateAgentPlacement(
    agent: AgentPlacementConfig,
    basePath: string,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[]
  ): void {
    if (!agent.instanceName) {
      errors.push({
        path: `${basePath}.instanceName`,
        message: 'Agent instance name is required',
        code: 'INSTANCE_NAME_REQUIRED',
      });
    }

    // Must have either templateId or inline definition
    if (!agent.templateId && !agent.inline) {
      errors.push({
        path: basePath,
        message: 'Agent must have either templateId or inline definition',
        code: 'TEMPLATE_OR_INLINE_REQUIRED',
      });
    }

    // Validate inline agent if present
    if (agent.inline) {
      this.validateAgentTemplate(agent.inline, `${basePath}.inline`, errors, warnings);
    }

    // Validate autonomous mode if present
    if (agent.autonomousMode) {
      this.validateAutonomousMode(agent.autonomousMode, `${basePath}.autonomousMode`, errors, warnings);
    }

    // Validate priority
    const validPriorities = ['critical', 'high', 'medium', 'low'];
    if (agent.priorityOverride && !validPriorities.includes(agent.priorityOverride)) {
      warnings.push({
        path: `${basePath}.priorityOverride`,
        message: `Unknown priority level: ${agent.priorityOverride}`,
        suggestion: `Use one of: ${validPriorities.join(', ')}`,
      });
    }
  }

  /**
   * Validate device template configuration
   */
  private validateDeviceTemplate(
    template: DeviceTemplateConfig,
    basePath: string,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[]
  ): void {
    if (!template.id) {
      errors.push({
        path: `${basePath}.id`,
        message: 'Device template ID is required',
        code: 'ID_REQUIRED',
      });
    }

    if (!template.name) {
      errors.push({
        path: `${basePath}.name`,
        message: 'Device template name is required',
        code: 'NAME_REQUIRED',
      });
    }

    if (!template.type) {
      errors.push({
        path: `${basePath}.type`,
        message: 'Device type is required',
        code: 'TYPE_REQUIRED',
      });
    }

    // Validate capabilities
    if (!template.capabilities || template.capabilities.length === 0) {
      warnings.push({
        path: `${basePath}.capabilities`,
        message: 'Device template has no capabilities defined',
        suggestion: 'Add capabilities to make the device useful',
      });
    } else {
      for (let i = 0; i < template.capabilities.length; i++) {
        this.validateCapability(template.capabilities[i], `${basePath}.capabilities[${i}]`, errors, warnings);
      }
    }
  }

  /**
   * Validate device capability
   */
  private validateCapability(
    capability: any,
    basePath: string,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[]
  ): void {
    if (!capability.name) {
      errors.push({
        path: `${basePath}.name`,
        message: 'Capability name is required',
        code: 'CAPABILITY_NAME_REQUIRED',
      });
    }

    const validTypes = ['read', 'control', 'event', 'composite'];
    if (capability.type && !validTypes.includes(capability.type)) {
      warnings.push({
        path: `${basePath}.type`,
        message: `Unknown capability type: ${capability.type}`,
        suggestion: `Consider using one of: ${validTypes.join(', ')}`,
      });
    }
  }

  /**
   * Validate agent template configuration
   */
  private validateAgentTemplate(
    template: AgentTemplateConfig,
    basePath: string,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[]
  ): void {
    if (!template.id) {
      errors.push({
        path: `${basePath}.id`,
        message: 'Agent template ID is required',
        code: 'ID_REQUIRED',
      });
    }

    if (!template.name) {
      errors.push({
        path: `${basePath}.name`,
        message: 'Agent template name is required',
        code: 'NAME_REQUIRED',
      });
    }

    if (!template.priority) {
      warnings.push({
        path: `${basePath}.priority`,
        message: 'Agent priority not specified, defaulting to medium',
      });
    }
  }

  /**
   * Validate autonomous mode configuration
   */
  private validateAutonomousMode(
    config: AutonomousModeConfig,
    basePath: string,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[]
  ): void {
    if (config.triggers) {
      for (let i = 0; i < config.triggers.length; i++) {
        this.validateTrigger(config.triggers[i], `${basePath}.triggers[${i}]`, errors, warnings);
      }
    }

    if (config.thresholdMonitors) {
      for (let i = 0; i < config.thresholdMonitors.length; i++) {
        this.validateThresholdMonitor(config.thresholdMonitors[i], `${basePath}.thresholdMonitors[${i}]`, errors, warnings);
      }
    }

    if (config.scheduledChecks) {
      for (let i = 0; i < config.scheduledChecks.length; i++) {
        this.validateScheduledCheck(config.scheduledChecks[i], `${basePath}.scheduledChecks[${i}]`, errors, warnings);
      }
    }

    // Warn if autonomous mode is enabled but has no actions
    if (config.enabled) {
      const hasActions =
        (config.triggers && config.triggers.length > 0) ||
        (config.thresholdMonitors && config.thresholdMonitors.length > 0) ||
        (config.scheduledChecks && config.scheduledChecks.length > 0) ||
        (config.eventSubscriptions && config.eventSubscriptions.length > 0);

      if (!hasActions) {
        warnings.push({
          path: basePath,
          message: 'Autonomous mode is enabled but no triggers, monitors, or schedules are defined',
          suggestion: 'Add triggers, threshold monitors, or scheduled checks',
        });
      }
    }
  }

  /**
   * Validate trigger configuration
   */
  private validateTrigger(
    trigger: TriggerConfig,
    basePath: string,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[]
  ): void {
    if (!trigger.id) {
      errors.push({
        path: `${basePath}.id`,
        message: 'Trigger ID is required',
        code: 'ID_REQUIRED',
      });
    }

    if (!trigger.type) {
      errors.push({
        path: `${basePath}.type`,
        message: 'Trigger type is required',
        code: 'TRIGGER_TYPE_REQUIRED',
      });
    }

    if (!trigger.action) {
      errors.push({
        path: `${basePath}.action`,
        message: 'Trigger action is required',
        code: 'TRIGGER_ACTION_REQUIRED',
      });
    }

    // Validate trigger type
    const validTypes = [
      'device-state-change',
      'environment-parameter',
      'time-based',
      'event-received',
      'threshold-crossed',
      'custom'
    ];
    if (trigger.type && !validTypes.includes(trigger.type)) {
      warnings.push({
        path: `${basePath}.type`,
        message: `Unknown trigger type: ${trigger.type}`,
        suggestion: `Consider using one of: ${validTypes.join(', ')}`,
      });
    }
  }

  /**
   * Validate threshold monitor configuration
   */
  private validateThresholdMonitor(
    monitor: ThresholdMonitorConfig,
    basePath: string,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[]
  ): void {
    if (!monitor.id) {
      errors.push({
        path: `${basePath}.id`,
        message: 'Monitor ID is required',
        code: 'ID_REQUIRED',
      });
    }

    if (!monitor.deviceId) {
      errors.push({
        path: `${basePath}.deviceId`,
        message: 'Device ID is required for threshold monitor',
        code: 'DEVICE_ID_REQUIRED',
      });
    }

    if (!monitor.parameter) {
      errors.push({
        path: `${basePath}.parameter`,
        message: 'Parameter is required for threshold monitor',
        code: 'PARAMETER_REQUIRED',
      });
    }

    if (!monitor.warningThreshold && !monitor.criticalThreshold) {
      warnings.push({
        path: basePath,
        message: 'Threshold monitor has no thresholds defined',
        suggestion: 'Define at least warning or critical threshold',
      });
    }
  }

  /**
   * Validate scheduled check configuration
   */
  private validateScheduledCheck(
    check: ScheduledCheckConfig,
    basePath: string,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[]
  ): void {
    if (!check.id) {
      errors.push({
        path: `${basePath}.id`,
        message: 'Scheduled check ID is required',
        code: 'ID_REQUIRED',
      });
    }

    if (!check.interval && !check.cron) {
      errors.push({
        path: basePath,
        message: 'Scheduled check must have either interval or cron expression',
        code: 'SCHEDULE_REQUIRED',
      });
    }

    if (!check.task) {
      errors.push({
        path: `${basePath}.task`,
        message: 'Task description is required for scheduled check',
        code: 'TASK_REQUIRED',
      });
    }

    // Validate interval is reasonable
    if (check.interval && check.interval < 1000) {
      warnings.push({
        path: `${basePath}.interval`,
        message: 'Very short interval may cause performance issues',
        suggestion: 'Consider using interval >= 1000ms (1 second)',
      });
    }
  }

  /**
   * Validate autonomous rule configuration
   */
  private validateAutonomousRule(
    rule: any,
    basePath: string,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[]
  ): void {
    if (!rule.id) {
      errors.push({
        path: `${basePath}.id`,
        message: 'Rule ID is required',
        code: 'ID_REQUIRED',
      });
    }

    if (!rule.name) {
      warnings.push({
        path: `${basePath}.name`,
        message: 'Rule name is recommended for clarity',
      });
    }

    // Validate triggers if present
    if (rule.triggers) {
      for (let i = 0; i < rule.triggers.length; i++) {
        this.validateTrigger(rule.triggers[i], `${basePath}.triggers[${i}]`, errors, warnings);
      }
    }
  }

  /**
   * Validate cross-references between configuration elements
   */
  private validateCrossReferences(
    config: DeclarativeConfig,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[]
  ): void {
    // Build template ID sets
    const deviceTemplateIds = new Set((config.deviceTemplates || []).map(t => t.id));
    const agentTemplateIds = new Set((config.agentTemplates || []).map(t => t.id));

    // Check device template references
    for (const env of config.environments || []) {
      for (const device of env.devicePlacements || []) {
        if (device.templateId && !deviceTemplateIds.has(device.templateId)) {
          // Template not found - might be a built-in template
          warnings.push({
            path: `environments.devicePlacements[${device.instanceName}]`,
            message: `Device references template that is not defined in config: ${device.templateId}`,
            suggestion: 'Define the template or use a built-in template ID',
          });
        }
      }

      for (const agent of env.agentPlacements || []) {
        if (agent.templateId && !agentTemplateIds.has(agent.templateId)) {
          warnings.push({
            path: `environments.agentPlacements[${agent.instanceName}]`,
            message: `Agent references template that is not defined in config: ${agent.templateId}`,
            suggestion: 'Define the template or use a built-in template ID',
          });
        }

        // Check device references in agent
        const deviceNames = new Set((env.devicePlacements || []).map(d => d.instanceName));
        for (const deviceRef of agent.devices || []) {
          if (!deviceNames.has(deviceRef)) {
            errors.push({
              path: `environments.agentPlacements[${agent.instanceName}].devices`,
              message: `Agent references undefined device: ${deviceRef}`,
              code: 'UNDEFINED_DEVICE',
            });
          }
        }
      }
    }
  }
}
