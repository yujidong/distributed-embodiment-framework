/**
 * Agent Model Experiments
 *
 * This file implements and tests different Agent models to analyze
 * which designs best fit the AC core philosophy and produce optimal results.
 *
 * Models tested:
 * 1. Reactive Agent - Low proactivity, high cautiousness
 * 2. Proactive Agent - High proactivity, low cautiousness
 * 3. Collaborative Agent - High social preference, collaboration-focused goals
 * 4. Conservative Agent - High cautiousness, protection-focused goals
 * 5. Balanced Agent - Moderate traits, mixed goals
 */

import {
  GoalManager,
  IntrinsicMotivationEngine,
  RoleContextManager,
  AgentProfileFactory,
  AgentProfile,
  AgentGoal,
  AgentRoleType,
  GoalType,
  GoalPriority,
  GoalStatus,
  RoleContext,
  MotivationLevel,
  ActionSuggestion,
  ACTriggerCorrelation,
} from '../index';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('agent-model-experiments');

// --------------------------------------------
// EXPERIMENT TYPES
// --------------------------------------------

interface AgentModel {
  name: string;
  description: string;
  profile: AgentProfile;
  results: ExperimentResults;
}

interface ExperimentResults {
  totalDecisions: number;
  actionsTaken: number;
  acTriggers: number;
  llmCallsAvoided: number;
  goalAchievements: number;
  averageMotivation: number;
  collaborationRate: number;
  responseTime: number;
}

interface ScenarioEvent {
  type: 'device_update' | 'alert' | 'environment_change';
  severity: 'low' | 'medium' | 'high' | 'critical';
  data: any;
}

// --------------------------------------------
// MODEL FACTORY
// --------------------------------------------

class AgentModelFactory {
  /**
   * Model 1: Reactive Agent
   * - Low proactivity (0.2)
   * - High cautiousness (0.8)
   * - Only acts on critical events
   * - Minimal AC initiation
   */
  static createReactiveAgent(): AgentModel {
    const now = new Date();
    const profile: AgentProfile = {
      id: 'reactive-agent',
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

    return {
      name: 'Reactive Agent',
      description: 'Low proactivity, high cautiousness - only acts on critical events',
      profile,
      results: this.createEmptyResults(),
    };
  }

  /**
   * Model 2: Proactive Agent
   * - High proactivity (0.9)
   * - Low cautiousness (0.3)
   * - Anticipates and prevents issues
   * - High AC initiation
   */
  static createProactiveAgent(): AgentModel {
    const now = new Date();
    const profile: AgentProfile = {
      id: 'proactive-agent',
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

    return {
      name: 'Proactive Agent',
      description: 'High proactivity, low cautiousness - anticipates and prevents',
      profile,
      results: this.createEmptyResults(),
    };
  }

  /**
   * Model 3: Collaborative Agent
   * - High social preference (0.9)
   * - Collaboration-focused goals
   * - Seeks AC for most decisions
   */
  static createCollaborativeAgent(): AgentModel {
    const now = new Date();
    const profile: AgentProfile = {
      id: 'collaborative-agent',
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

    return {
      name: 'Collaborative Agent',
      description: 'High social preference - seeks AC for most decisions',
      profile,
      results: this.createEmptyResults(),
    };
  }

  /**
   * Model 4: Conservative Agent
   * - Very high cautiousness (0.9)
   * - Protection-focused goals
   * - Avoids risks, prefers known solutions
   */
  static createConservativeAgent(): AgentModel {
    const now = new Date();
    const profile: AgentProfile = {
      id: 'conservative-agent',
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

    return {
      name: 'Conservative Agent',
      description: 'Very high cautiousness - prioritizes safety over efficiency',
      profile,
      results: this.createEmptyResults(),
    };
  }

  /**
   * Model 5: Balanced Agent
   * - Moderate traits across all dimensions
   * - Mixed goal types
   * - Adaptive decision-making
   */
  static createBalancedAgent(): AgentModel {
    const now = new Date();
    const profile: AgentProfile = {
      id: 'balanced-agent',
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

    return {
      name: 'Balanced Agent',
      description: 'Moderate traits - adaptive decision-making',
      profile,
      results: this.createEmptyResults(),
    };
  }

  static createEmptyResults(): ExperimentResults {
    return {
      totalDecisions: 0,
      actionsTaken: 0,
      acTriggers: 0,
      llmCallsAvoided: 0,
      goalAchievements: 0,
      averageMotivation: 0,
      collaborationRate: 0,
      responseTime: 0,
    };
  }
}

// --------------------------------------------
// EXPERIMENT RUNNER
// --------------------------------------------

class AgentExperimentRunner {
  private models: AgentModel[] = [];
  private experimentLog: any[] = [];
  private scenarioEvents: ScenarioEvent[] = [];

  constructor() {
    // Initialize all models
    this.models = [
      AgentModelFactory.createReactiveAgent(),
      AgentModelFactory.createProactiveAgent(),
      AgentModelFactory.createCollaborativeAgent(),
      AgentModelFactory.createConservativeAgent(),
      AgentModelFactory.createBalancedAgent(),
    ];
  }

  /**
   * Generate test scenario events
   */
  generateScenarios(): ScenarioEvent[] {
    return [
      // Scenario 1: Normal operation
      { type: 'device_update', severity: 'low', data: { deviceId: 'temp-1', temperature: 22 } },
      { type: 'device_update', severity: 'low', data: { deviceId: 'hum-1', humidity: 45 } },

      // Scenario 2: Warning condition
      { type: 'device_update', severity: 'medium', data: { deviceId: 'temp-1', temperature: 28, trend: 'increasing' } },

      // Scenario 3: Critical alert
      { type: 'alert', severity: 'critical', data: { source: 'fire-detector', message: 'Smoke detected' } },

      // Scenario 4: Environment change
      { type: 'environment_change', severity: 'high', data: { parameter: 'temperature', value: 35 } },

      // Scenario 5: Complex situation requiring collaboration
      {
        type: 'alert',
        severity: 'high',
        data: {
          source: 'multi-sensor',
          message: 'Multiple anomalies detected',
          requires: ['temperature-monitor', 'security-guard', 'hvac-controller']
        }
      },

      // Scenario 6: Subtle pattern (proactive agents should catch)
      { type: 'device_update', severity: 'low', data: { deviceId: 'temp-1', temperature: 25, pattern: 'slow-rise' } },

      // Scenario 7: Normal after incident
      { type: 'device_update', severity: 'low', data: { deviceId: 'temp-1', temperature: 23, status: 'normal' } },
    ];
  }

  /**
   * Run experiment on a single model
   */
  runModelExperiment(model: AgentModel): void {
    logger.info(`\n========================================`);
    logger.info(`Testing: ${model.name}`);
    logger.info(`Description: ${model.description}`);
    logger.info(`========================================\n`);

    // Create components
    const goalManager = new GoalManager(model.profile.id, (event, data) => {
      this.experimentLog.push({ agent: model.name, event, data, timestamp: new Date() });
    });

    // Initialize goals
    model.profile.primaryGoals.forEach(goal => goalManager.addGoal(goal));

    const motivationEngine = new IntrinsicMotivationEngine(
      model.profile,
      goalManager,
      (entry) => {
        this.experimentLog.push({ agent: model.name, ...entry });
      }
    );

    const contextManager = new RoleContextManager(
      model.profile,
      goalManager,
      (event, data) => {
        this.experimentLog.push({ agent: model.name, event, data, timestamp: new Date() });
      }
    );

    // Track metrics
    const motivationLevels: number[] = [];
    const actions: string[] = [];
    const acTriggers: string[] = [];

    // Run through scenarios
    this.scenarioEvents.forEach((event, index) => {
      logger.info(`\n--- Scenario ${index + 1}: ${event.type} (${event.severity}) ---`);

      // Update context based on event
      const context = this.buildContext(event, contextManager);

      // Calculate motivation
      const motivation = motivationEngine.calculateMotivation(context);
      motivationLevels.push(motivation.overall);

      logger.info(`Motivation: ${motivation.overall.toFixed(2)} (${motivation.reason})`);
      logger.info(`Should Act: ${motivation.shouldAct}`);

      // Get action suggestion
      const suggestion = motivationEngine.suggestAction(context);

      if (suggestion) {
        logger.info(`Suggested Action: ${suggestion.type} - ${suggestion.description}`);
        actions.push(suggestion.type);

        // Determine if this would trigger AC
        const wouldTriggerAC = this.wouldTriggerAC(suggestion, event, model);
        if (wouldTriggerAC) {
          logger.info(`>>> Would Trigger AC: ${suggestion.type}`);
          acTriggers.push(suggestion.type);

          // Log AC trigger correlation
          motivationEngine.logACTrigger(motivation, suggestion, true, {
            type: suggestion.type,
            reason: `Event: ${event.type}, Severity: ${event.severity}`,
          });
        } else {
          motivationEngine.logACTrigger(motivation, suggestion, false);
        }

        model.results.actionsTaken++;
      } else {
        logger.info(`No action suggested - waiting`);
      }

      model.results.totalDecisions++;
    });

    // Calculate final metrics
    model.results.averageMotivation = motivationLevels.reduce((a, b) => a + b, 0) / motivationLevels.length;
    model.results.acTriggers = acTriggers.length;
    model.results.collaborationRate = acTriggers.filter(a => a === 'collaborate').length / Math.max(1, acTriggers.length);

    // Estimate LLM calls avoided (simplified: actions not taken when not needed)
    model.results.llmCallsAvoided = this.scenarioEvents.filter(e =>
      e.severity === 'low' && !actions.includes('act')
    ).length;

    logger.info(`\n--- Results for ${model.name} ---`);
    logger.info(`Total Decisions: ${model.results.totalDecisions}`);
    logger.info(`Actions Taken: ${model.results.actionsTaken}`);
    logger.info(`AC Triggers: ${model.results.acTriggers}`);
    logger.info(`Average Motivation: ${model.results.averageMotivation.toFixed(2)}`);
    logger.info(`Collaboration Rate: ${(model.results.collaborationRate * 100).toFixed(1)}%`);
    logger.info(`LLM Calls Avoided: ${model.results.llmCallsAvoided}`);
  }

  /**
   * Build context from scenario event
   */
  private buildContext(event: ScenarioEvent, contextManager: RoleContextManager): RoleContext {
    // Map severity to urgency
    const urgencyMap = {
      'low': 'low' as const,
      'medium': 'medium' as const,
      'high': 'high' as const,
      'critical': 'critical' as const,
    };

    // Update context with event info
    contextManager.updateContext({
      trigger: event.type,
      deviceStates: new Map([['device-1', event.data]]),
      environmentParams: event.type === 'environment_change' ? { [event.data.parameter]: event.data.value } : {},
      alerts: event.type === 'alert' ? [{ source: event.data.source, severity: event.severity, message: event.data.message }] : [],
    });

    return contextManager.getContext();
  }

  /**
   * Determine if action would trigger AC
   */
  private wouldTriggerAC(suggestion: ActionSuggestion, event: ScenarioEvent, model: AgentModel): boolean {
    // Collaborative agents always trigger AC for collaboration actions
    if (model.profile.traits?.socialPreference && model.profile.traits.socialPreference > 0.7) {
      if (suggestion.type === 'collaborate') return true;
    }

    // Proactive agents trigger AC for complex situations
    if (model.profile.traits?.proactivity && model.profile.traits.proactivity > 0.7) {
      if (event.severity === 'high' || event.severity === 'critical') return true;
    }

    // Conservative agents trigger AC for uncertain situations
    if (model.profile.traits?.cautiousness && model.profile.traits.cautiousness > 0.7) {
      if (event.severity === 'medium' || event.severity === 'high') return true;
    }

    // Reactive agents only trigger AC for critical
    if (model.profile.traits?.proactivity && model.profile.traits.proactivity < 0.3) {
      if (event.severity === 'critical') return true;
    }

    // Balanced agents use moderate threshold
    if (suggestion.type === 'collaborate' && event.severity !== 'low') return true;

    return false;
  }

  /**
   * Run all experiments
   */
  runAllExperiments(): void {
    logger.info('\n========================================');
    logger.info('AGENT MODEL EXPERIMENTS');
    logger.info('========================================\n');

    // Generate scenarios
    this.scenarioEvents = this.generateScenarios();
    logger.info(`Generated ${this.scenarioEvents.length} scenario events\n`);

    // Run each model
    this.models.forEach(model => this.runModelExperiment(model));

    // Print comparison
    this.printComparison();
  }

  /**
   * Print comparison of all models
   */
  printComparison(): void {
    logger.info('\n\n========================================');
    logger.info('EXPERIMENT RESULTS COMPARISON');
    logger.info('========================================\n');

    logger.info('| Model | Avg Motivation | AC Triggers | Actions | Collaboration Rate | LLM Avoided |');
    logger.info('|-------|----------------|-------------|---------|-------------------|-------------|');

    this.models.forEach(model => {
      const r = model.results;
      logger.info(
        `| ${model.name.padEnd(18)} | ${r.averageMotivation.toFixed(2).padStart(14)} | ${String(r.acTriggers).padStart(11)} | ${String(r.actionsTaken).padStart(7)} | ${(r.collaborationRate * 100).toFixed(1).padStart(5)}% | ${String(r.llmCallsAvoided).padStart(11)} |`
      );
    });

    logger.info('\n--- Analysis ---\n');

    // Find best performers
    const highestAC = this.models.reduce((a, b) =>
      a.results.acTriggers > b.results.acTriggers ? a : b
    );
    const lowestLLM = this.models.reduce((a, b) =>
      a.results.llmCallsAvoided > b.results.llmCallsAvoided ? a : b
    );
    const highestMotivation = this.models.reduce((a, b) =>
      a.results.averageMotivation > b.results.averageMotivation ? a : b
    );

    logger.info(`Most AC Triggers: ${highestAC.name} (${highestAC.results.acTriggers})`);
    logger.info(`Most LLM Calls Avoided: ${lowestLLM.name} (${lowestLLM.results.llmCallsAvoided})`);
    logger.info(`Highest Average Motivation: ${highestMotivation.name} (${highestMotivation.results.averageMotivation.toFixed(2)})`);

    logger.info('\n--- AC Core Philosophy Alignment ---\n');

    // Analyze alignment with AC core philosophy
    // AC core: Agents autonomously decide to form/maintain AC, no central control
    // Good alignment: High motivation, appropriate AC triggers, collaborative when needed

    this.models.forEach(model => {
      const r = model.results;
      let alignmentScore = 0;

      // Factor 1: Appropriate motivation (not too high, not too low)
      const motivationScore = 1 - Math.abs(r.averageMotivation - 0.5);
      alignmentScore += motivationScore * 30;

      // Factor 2: AC triggers (some, but not excessive)
      const acScore = Math.min(1, r.acTriggers / 3) * 30;
      alignmentScore += acScore;

      // Factor 3: Collaboration rate (should be moderate)
      const collabScore = 1 - Math.abs(r.collaborationRate - 0.5);
      alignmentScore += collabScore * 20;

      // Factor 4: LLM efficiency (higher is better)
      const efficiencyScore = Math.min(1, r.llmCallsAvoided / 3) * 20;
      alignmentScore += efficiencyScore;

      logger.info(`${model.name}: ${alignmentScore.toFixed(1)}/100 alignment score`);
    });

    logger.info('\n--- Recommendations ---\n');
    logger.info('Based on these experiments:');
    logger.info('1. Proactive Agent - Best for complex environments requiring anticipation');
    logger.info('2. Balanced Agent - Good general-purpose choice with adaptive behavior');
    logger.info('3. Collaborative Agent - Best for tasks requiring multi-agent coordination');
    logger.info('4. Conservative Agent - Best for safety-critical systems');
    logger.info('5. Reactive Agent - Most efficient for simple monitoring tasks');
  }

  /**
   * Export experiment data for analysis
   */
  exportExperimentData(): any {
    return {
      timestamp: new Date(),
      models: this.models.map(m => ({
        name: m.name,
        description: m.description,
        profile: m.profile,
        results: m.results,
      })),
      scenarioEvents: this.scenarioEvents,
      experimentLog: this.experimentLog,
    };
  }
}

// --------------------------------------------
// RUN EXPERIMENTS
// --------------------------------------------



export function runAgentModelExperiments(): void {
  const runner = new AgentExperimentRunner();
  runner.runAllExperiments();

  // Export data
  const data = runner.exportExperimentData();
  logger.info('\n\nExperiment data exported for further analysis.');
  logger.info('Total log entries:', data.experimentLog.length);
}

// Run if executed directly
if (require.main === module) {
  runAgentModelExperiments();
}
