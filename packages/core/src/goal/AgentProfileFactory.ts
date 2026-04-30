/**
 * Agent Profile Factory
 *
 * Creates predefined agent profiles for common use cases.
 */

import {
  AgentProfile,
  AgentGoal,
  AgentRoleType,
  AgentTraits,
  GoalType,
  GoalPriority,
  GoalStatus,
} from './types';

/**
 * Factory for creating agent profiles
 */
export class AgentProfileFactory {
  /**
   * Create a temperature monitoring agent profile
   */
  static createTemperatureMonitor(overrides?: Partial<AgentProfile>): AgentProfile {
    const now = new Date();
    const profile: AgentProfile = {
      id: `temp-monitor-${Date.now()}`,
      name: 'Temperature Monitor',
      role: AgentRoleType.ENVIRONMENT_MONITOR,
      description: 'Monitors and maintains temperature within safe ranges',
      capabilities: ['temperature-sensing', 'hvac-control', 'alert-generation'],
      primaryGoals: [
        this.createMaintenanceGoal(
          'maintain-safe-temp',
          'Maintain temperature in safe range (18-26°C)',
          'temperature',
          { min: 18, max: 26 },
          GoalPriority.HIGH
        ),
        this.createProtectionGoal(
          'prevent-overheating',
          'Prevent temperature from exceeding 30°C',
          'temperature',
          30,
          GoalPriority.CRITICAL
        ),
      ],
      secondaryGoals: [
        this.createOptimizationGoal(
          'optimize-energy',
          'Optimize energy usage while maintaining comfort',
          GoalPriority.LOW
        ),
      ],
      traits: {
        cautiousness: 0.6,
        proactivity: 0.5,
        socialPreference: 0.6,
        expertise: ['hvac', 'thermodynamics'],
        riskTolerance: 0.3,
      },
      createdAt: now,
      updatedAt: now,
    };

    return { ...profile, ...overrides };
  }

  /**
   * Create a security guard agent profile
   */
  static createSecurityGuard(overrides?: Partial<AgentProfile>): AgentProfile {
    const now = new Date();
    const profile: AgentProfile = {
      id: `security-guard-${Date.now()}`,
      name: 'Security Guard',
      role: AgentRoleType.SECURITY_GUARD,
      description: 'Monitors security sensors and responds to threats',
      capabilities: ['motion-detection', 'alert-generation', 'access-control', 'video-monitoring'],
      primaryGoals: [
        this.createProtectionGoal(
          'prevent-unauthorized-access',
          'Prevent unauthorized access to secured areas',
          'unauthorizedAccessCount',
          0,
          GoalPriority.CRITICAL
        ),
        this.createMaintenanceGoal(
          'monitor-motion',
          'Monitor all motion sensors for anomalies',
          'sensorCoverage',
          { min: 95, max: 100 },
          GoalPriority.HIGH
        ),
      ],
      traits: {
        cautiousness: 0.8,
        proactivity: 0.7,
        socialPreference: 0.4,
        expertise: ['security', 'access-control'],
        riskTolerance: 0.2,
      },
      createdAt: now,
      updatedAt: now,
    };

    return { ...profile, ...overrides };
  }

  /**
   * Create a climate controller agent profile
   */
  static createClimateController(overrides?: Partial<AgentProfile>): AgentProfile {
    const now = new Date();
    const profile: AgentProfile = {
      id: `climate-controller-${Date.now()}`,
      name: 'Climate Controller',
      role: AgentRoleType.CLIMATE_CONTROLLER,
      description: 'Controls HVAC, humidity, and air quality systems',
      capabilities: ['hvac-control', 'humidity-control', 'air-quality-monitoring', 'energy-optimization'],
      primaryGoals: [
        this.createMaintenanceGoal(
          'maintain-comfort',
          'Maintain comfortable climate conditions',
          'comfortIndex',
          { min: 70, max: 100 },
          GoalPriority.HIGH
        ),
        this.createAchievementGoal(
          'reduce-energy',
          'Reduce energy consumption by 20%',
          'energyReduction',
          20,
          GoalPriority.MEDIUM
        ),
      ],
      traits: {
        cautiousness: 0.4,
        proactivity: 0.7,
        socialPreference: 0.7,
        expertise: ['hvac', 'energy-management'],
        riskTolerance: 0.4,
      },
      createdAt: now,
      updatedAt: now,
    };

    return { ...profile, ...overrides };
  }

  /**
   * Create a coordinator agent profile
   */
  static createCoordinator(overrides?: Partial<AgentProfile>): AgentProfile {
    const now = new Date();
    const profile: AgentProfile = {
      id: `coordinator-${Date.now()}`,
      name: 'Coordinator',
      role: AgentRoleType.COORDINATOR,
      description: 'Coordinates activities between multiple agents',
      capabilities: ['task-assignment', 'resource-allocation', 'conflict-resolution', 'communication'],
      primaryGoals: [
        this.createCollaborationGoal(
          'facilitate-collaboration',
          'Facilitate effective collaboration between agents',
          GoalPriority.HIGH
        ),
        this.createAchievementGoal(
          'optimize-resources',
          'Optimize resource allocation across agents',
          'resourceEfficiency',
          85,
          GoalPriority.MEDIUM
        ),
      ],
      traits: {
        cautiousness: 0.5,
        proactivity: 0.8,
        socialPreference: 0.9,
        expertise: ['coordination', 'optimization'],
        riskTolerance: 0.5,
      },
      createdAt: now,
      updatedAt: now,
    };

    return { ...profile, ...overrides };
  }

  /**
   * Create an energy optimizer agent profile
   */
  static createEnergyOptimizer(overrides?: Partial<AgentProfile>): AgentProfile {
    const now = new Date();
    const profile: AgentProfile = {
      id: `energy-optimizer-${Date.now()}`,
      name: 'Energy Optimizer',
      role: AgentRoleType.ENERGY_OPTIMIZER,
      description: 'Optimizes energy consumption across systems',
      capabilities: ['energy-monitoring', 'load-balancing', 'scheduling', 'optimization'],
      primaryGoals: [
        this.createAchievementGoal(
          'reduce-consumption',
          'Reduce overall energy consumption by 30%',
          'energyReduction',
          30,
          GoalPriority.HIGH
        ),
        this.createMaintenanceGoal(
          'maintain-efficiency',
          'Maintain energy efficiency above 80%',
          'efficiency',
          { min: 80, max: 100 },
          GoalPriority.MEDIUM
        ),
      ],
      traits: {
        cautiousness: 0.3,
        proactivity: 0.9,
        socialPreference: 0.6,
        expertise: ['energy', 'optimization', 'scheduling'],
        riskTolerance: 0.5,
      },
      createdAt: now,
      updatedAt: now,
    };

    return { ...profile, ...overrides };
  }

  /**
   * Create a general purpose agent profile
   */
  static createGeneralAgent(overrides?: Partial<AgentProfile>): AgentProfile {
    const now = new Date();
    const profile: AgentProfile = {
      id: `general-${Date.now()}`,
      name: 'General Agent',
      role: AgentRoleType.GENERAL,
      description: 'General purpose agent with configurable goals',
      capabilities: ['monitoring', 'control', 'communication'],
      primaryGoals: [],
      traits: {
        cautiousness: 0.5,
        proactivity: 0.5,
        socialPreference: 0.5,
        riskTolerance: 0.5,
      },
      createdAt: now,
      updatedAt: now,
    };

    return { ...profile, ...overrides };
  }

  // --------------------------------------------
  // GOAL FACTORY HELPERS
  // --------------------------------------------

  /**
   * Create a maintenance goal
   */
  static createMaintenanceGoal(
    id: string,
    description: string,
    property: string,
    value: number | { min: number; max: number },
    priority: GoalPriority
  ): AgentGoal {
    const now = new Date();
    const isRange = typeof value === 'object' && value !== null && 'min' in value;
    return {
      id,
      description,
      type: GoalType.MAINTENANCE,
      priority,
      target: {
        property,
        operator: isRange ? 'range' : 'eq',
        value,
      },
      status: GoalStatus.PENDING,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Create a protection goal
   */
  static createProtectionGoal(
    id: string,
    description: string,
    property: string,
    maxValue: number,
    priority: GoalPriority
  ): AgentGoal {
    const now = new Date();
    return {
      id,
      description,
      type: GoalType.PROTECTION,
      priority,
      target: {
        property,
        operator: 'lte',
        value: maxValue,
      },
      status: GoalStatus.ACTIVE,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Create an achievement goal
   */
  static createAchievementGoal(
    id: string,
    description: string,
    property: string,
    targetValue: number,
    priority: GoalPriority
  ): AgentGoal {
    const now = new Date();
    return {
      id,
      description,
      type: GoalType.ACHIEVEMENT,
      priority,
      target: {
        property,
        operator: 'gte',
        value: targetValue,
      },
      status: GoalStatus.PENDING,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Create a collaboration goal
   */
  static createCollaborationGoal(
    id: string,
    description: string,
    priority: GoalPriority
  ): AgentGoal {
    const now = new Date();
    return {
      id,
      description,
      type: GoalType.COLLABORATION,
      priority,
      status: GoalStatus.ACTIVE,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Create an exploration goal
   */
  static createExplorationGoal(
    id: string,
    description: string,
    priority: GoalPriority
  ): AgentGoal {
    const now = new Date();
    return {
      id,
      description,
      type: GoalType.EXPLORATION,
      priority,
      status: GoalStatus.PENDING,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Create an optimization goal (special type of achievement)
   */
  static createOptimizationGoal(
    id: string,
    description: string,
    priority: GoalPriority
  ): AgentGoal {
    const now = new Date();
    return {
      id,
      description,
      type: GoalType.ACHIEVEMENT,
      priority,
      status: GoalStatus.PENDING,
      createdAt: now,
      updatedAt: now,
    };
  }

  // --------------------------------------------
  // EXPERIMENT AGENT MODELS
  // --------------------------------------------

  /**
   * Create a reactive agent profile (low proactivity, high cautiousness)
   */
  static createReactiveAgent(overrides?: Partial<AgentProfile>): AgentProfile {
    const now = new Date();
    const profile: AgentProfile = {
      id: `reactive-agent-${Date.now()}`,
      name: 'Reactive Agent',
      role: AgentRoleType.ENVIRONMENT_MONITOR,
      description: 'Reactive agent that only acts on critical events',
      capabilities: ['monitoring', 'alert-response'],
      primaryGoals: [
        {
          id: 'respond-critical',
          description: 'Respond to critical events only',
          type: GoalType.PROTECTION,
          priority: GoalPriority.CRITICAL,
          status: GoalStatus.ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
      ],
      traits: {
        cautiousness: 0.8,
        proactivity: 0.2,
        socialPreference: 0.3,
        riskTolerance: 0.2,
      },
      createdAt: now,
      updatedAt: now,
    };

    return { ...profile, ...overrides };
  }

  /**
   * Create a proactive agent profile (high proactivity, low cautiousness)
   */
  static createProactiveAgent(overrides?: Partial<AgentProfile>): AgentProfile {
    const now = new Date();
    const profile: AgentProfile = {
      id: `proactive-agent-${Date.now()}`,
      name: 'Proactive Agent',
      role: AgentRoleType.ENVIRONMENT_MONITOR,
      description: 'Proactive agent that anticipates and prevents issues',
      capabilities: ['monitoring', 'prediction', 'prevention', 'collaboration'],
      primaryGoals: [
        {
          id: 'anticipate-issues',
          description: 'Anticipate and prevent issues before they occur',
          type: GoalType.PROTECTION,
          priority: GoalPriority.HIGH,
          status: GoalStatus.ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'explore-patterns',
          description: 'Explore patterns to improve predictions',
          type: GoalType.EXPLORATION,
          priority: GoalPriority.MEDIUM,
          status: GoalStatus.ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'initiate-collaboration',
          description: 'Proactively initiate collaboration for complex issues',
          type: GoalType.COLLABORATION,
          priority: GoalPriority.MEDIUM,
          status: GoalStatus.ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
      ],
      traits: {
        cautiousness: 0.3,
        proactivity: 0.9,
        socialPreference: 0.7,
        riskTolerance: 0.6,
      },
      createdAt: now,
      updatedAt: now,
    };

    return { ...profile, ...overrides };
  }

  /**
   * Create a collaborative agent profile (high social preference)
   */
  static createCollaborativeAgent(overrides?: Partial<AgentProfile>): AgentProfile {
    const now = new Date();
    const profile: AgentProfile = {
      id: `collaborative-agent-${Date.now()}`,
      name: 'Collaborative Agent',
      role: AgentRoleType.COORDINATOR,
      description: 'Collaborative agent that seeks AC for most decisions',
      capabilities: ['communication', 'coordination', 'negotiation'],
      primaryGoals: [
        {
          id: 'collaborate-decisions',
          description: 'Make decisions through collaboration',
          type: GoalType.COLLABORATION,
          priority: GoalPriority.HIGH,
          status: GoalStatus.ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'build-partnerships',
          description: 'Build partnerships with other agents',
          type: GoalType.COLLABORATION,
          priority: GoalPriority.MEDIUM,
          status: GoalStatus.ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'share-knowledge',
          description: 'Share knowledge with other agents',
          type: GoalType.ACHIEVEMENT,
          priority: GoalPriority.MEDIUM,
          status: GoalStatus.ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
      ],
      traits: {
        cautiousness: 0.5,
        proactivity: 0.6,
        socialPreference: 0.9,
        riskTolerance: 0.5,
      },
      createdAt: now,
      updatedAt: now,
    };

    return { ...profile, ...overrides };
  }

  /**
   * Create a conservative agent profile (very high cautiousness)
   */
  static createConservativeAgent(overrides?: Partial<AgentProfile>): AgentProfile {
    const now = new Date();
    const profile: AgentProfile = {
      id: `conservative-agent-${Date.now()}`,
      name: 'Conservative Agent',
      role: AgentRoleType.SECURITY_GUARD,
      description: 'Conservative agent that prioritizes safety',
      capabilities: ['monitoring', 'protection', 'verification'],
      primaryGoals: [
        {
          id: 'ensure-safety',
          description: 'Ensure system safety at all costs',
          type: GoalType.PROTECTION,
          priority: GoalPriority.CRITICAL,
          status: GoalStatus.ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'verify-actions',
          description: 'Verify all actions before execution',
          type: GoalType.MAINTENANCE,
          priority: GoalPriority.HIGH,
          status: GoalStatus.ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'avoid-risks',
          description: 'Avoid any actions with uncertain outcomes',
          type: GoalType.PROTECTION,
          priority: GoalPriority.HIGH,
          status: GoalStatus.ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
      ],
      traits: {
        cautiousness: 0.9,
        proactivity: 0.3,
        socialPreference: 0.5,
        riskTolerance: 0.1,
      },
      createdAt: now,
      updatedAt: now,
    };

    return { ...profile, ...overrides };
  }

  /**
   * Create a balanced agent profile (moderate traits)
   */
  static createBalancedAgent(overrides?: Partial<AgentProfile>): AgentProfile {
    const now = new Date();
    const profile: AgentProfile = {
      id: `balanced-agent-${Date.now()}`,
      name: 'Balanced Agent',
      role: AgentRoleType.GENERAL,
      description: 'Balanced agent with moderate traits and mixed goals',
      capabilities: ['monitoring', 'control', 'collaboration', 'optimization'],
      primaryGoals: [
        {
          id: 'maintain-stability',
          description: 'Maintain system stability',
          type: GoalType.MAINTENANCE,
          priority: GoalPriority.HIGH,
          status: GoalStatus.ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'improve-efficiency',
          description: 'Improve operational efficiency',
          type: GoalType.ACHIEVEMENT,
          priority: GoalPriority.MEDIUM,
          status: GoalStatus.ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'collaborate-when-needed',
          description: 'Collaborate when situation requires',
          type: GoalType.COLLABORATION,
          priority: GoalPriority.MEDIUM,
          status: GoalStatus.ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'explore-opportunities',
          description: 'Explore improvement opportunities',
          type: GoalType.EXPLORATION,
          priority: GoalPriority.LOW,
          status: GoalStatus.PENDING,
          createdAt: now,
          updatedAt: now,
        },
      ],
      traits: {
        cautiousness: 0.5,
        proactivity: 0.5,
        socialPreference: 0.5,
        riskTolerance: 0.5,
      },
      createdAt: now,
      updatedAt: now,
    };

    return { ...profile, ...overrides };
  }
}
