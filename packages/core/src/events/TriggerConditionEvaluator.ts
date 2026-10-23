/**
 * Trigger Condition Evaluator
 *
 * Fast rule-based evaluation to determine if AC is potentially needed.
 * This is the second stage of Layer 1 - applies rules to cluster summaries
 * to determine if they should be passed to Layer 2 (LLM-based decision).
 *
 * Key Features:
 * 1. Rule-based AC need detection (no LLM)
 * 2. Threshold-based urgency classification
 * 3. Integration with SMART_CITY_AC_TRIGGERS
 * 4. Filters 95% of events without LLM involvement
 */

import type { SpatialCluster, SpatialClusterSummary } from './SpatialTemporalClusterEngine.js';
import type { ACTriggerCondition } from '../autonomous/ACTriggerMonitor.js';
import { SMART_CITY_AC_TRIGGERS } from '../autonomous/ACTriggerMonitor.js';

import { createLogger } from '@active-collaboration/shared';
// ============================================================================
// Types
// ============================================================================

/**
 * Result of trigger evaluation
 */
const logger = createLogger('TriggerConditionEvaluator');

export interface TriggerEvaluationResult {
  needsEvaluation: boolean;
  urgency: 'low' | 'medium' | 'high' | 'urgent';
  matchedTriggers: ACTriggerCondition[];
  reasoning: string;
  recommendation: 'ignore' | 'monitor' | 'evaluate_with_llm' | 'immediate_action';
}

/**
 * Rule for trigger evaluation
 */
export interface EvaluationRule {
  id: string;
  name: string;
  description: string;
  condition: (cluster: SpatialCluster, summary: SpatialClusterSummary) => boolean;
  action: (cluster: SpatialCluster, summary: SpatialClusterSummary) => {
    needsEvaluation: boolean;
    urgency: 'low' | 'medium' | 'high' | 'urgent';
    reasoning: string;
  };
  priority: number; // Higher = checked first
}

/**
 * Configuration for TriggerConditionEvaluator
 */
export interface EvaluatorConfig {
  // Evaluation settings
  enableRuleEvaluation: boolean;
  enableTriggerMatching: boolean;

  // Thresholds
  immediateActionScore: number; // Significance score for immediate action
  evaluateWithLLMScore: number; // Significance score for LLM evaluation

  // Urgency multipliers
  urgencyMultipliers: {
    eventCount: number; // Multiplier for event count
    patternCount: number; // Multiplier for pattern count
    thresholdBreach: number; // Multiplier for threshold breach
  };

  // Custom rules injected by experiment or application layer
  customRules?: EvaluationRule[];
}

const DEFAULT_CONFIG: EvaluatorConfig = {
  enableRuleEvaluation: true,
  enableTriggerMatching: true,

  immediateActionScore: 85,
  evaluateWithLLMScore: 60,

  urgencyMultipliers: {
    eventCount: 2,
    patternCount: 10,
    thresholdBreach: 30,
  },
};

// ============================================================================
// TriggerConditionEvaluator
// ============================================================================

export class TriggerConditionEvaluator {
  private config: EvaluatorConfig;
  private rules: EvaluationRule[] = [];
  private triggers: ACTriggerCondition[];

  // Statistics
  private stats = {
    totalEvaluations: 0,
    passedToLLM: 0,
    filtered: 0,
    immediateActions: 0,
  };

  constructor(config: Partial<EvaluatorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.triggers = [...SMART_CITY_AC_TRIGGERS];
    this.initializeDefaultRules();

    // Apply custom rules after defaults (higher priority possible)
    if (this.config.customRules) {
      for (const rule of this.config.customRules) {
        this.addRule(rule);
      }
    }

    logger.info('Initialized with:', {
      rulesCount: this.rules.length,
      triggersCount: this.triggers.length,
      evaluateWithLLMScore: this.config.evaluateWithLLMScore,
      immediateActionScore: this.config.immediateActionScore,
    });
  }

  /**
   * Evaluate a cluster to determine if AC is potentially needed
   */
  evaluate(cluster: SpatialCluster, summary: SpatialClusterSummary): TriggerEvaluationResult {
    this.stats.totalEvaluations++;

    // Check if already marked for immediate action
    if (summary.recommendation === 'immediate_action') {
      this.stats.immediateActions++;
      return {
        needsEvaluation: true,
        urgency: 'urgent',
        matchedTriggers: this.matchTriggers(cluster),
        reasoning: 'Cluster marked for immediate action based on significance',
        recommendation: 'immediate_action',
      };
    }

    // Apply evaluation rules
    if (this.config.enableRuleEvaluation) {
      const ruleResult = this.applyRules(cluster, summary);
      if (ruleResult) {
        if (ruleResult.needsEvaluation) {
          this.stats.passedToLLM++;
        } else {
          this.stats.filtered++;
        }
        return {
          needsEvaluation: ruleResult.needsEvaluation,
          urgency: ruleResult.urgency,
          matchedTriggers: ruleResult.needsEvaluation ? this.matchTriggers(cluster) : [],
          reasoning: ruleResult.reasoning,
          recommendation: ruleResult.needsEvaluation ? 'evaluate_with_llm' : 'monitor',
        };
      }
    }

    // Check against AC triggers
    if (this.config.enableTriggerMatching) {
      const matchedTriggers = this.matchTriggers(cluster);
      if (matchedTriggers.length > 0) {
        this.stats.passedToLLM++;
        const highestUrgency = this.getHighestUrgency(matchedTriggers);
        return {
          needsEvaluation: true,
          urgency: highestUrgency,
          matchedTriggers,
          reasoning: `Matched ${matchedTriggers.length} AC trigger(s): ${matchedTriggers.map(t => t.name).join(', ')}`,
          recommendation: highestUrgency === 'urgent' ? 'immediate_action' : 'evaluate_with_llm',
        };
      }
    }

    // Default: based on significance score
    const score = cluster.statistics.significanceScore;
    if (score >= this.config.immediateActionScore) {
      this.stats.passedToLLM++;
      return {
        needsEvaluation: true,
        urgency: 'urgent',
        matchedTriggers: [],
        reasoning: `High significance score (${score}) requires immediate evaluation`,
        recommendation: 'immediate_action',
      };
    }

    if (score >= this.config.evaluateWithLLMScore) {
      this.stats.passedToLLM++;
      return {
        needsEvaluation: true,
        urgency: 'high',
        matchedTriggers: [],
        reasoning: `Significance score (${score}) requires LLM evaluation`,
        recommendation: 'evaluate_with_llm',
      };
    }

    // Low significance - filter out
    this.stats.filtered++;
    return {
      needsEvaluation: false,
      urgency: 'low',
      matchedTriggers: [],
      reasoning: `Low significance score (${score}) - no AC needed`,
      recommendation: 'ignore',
    };
  }

  /**
   * Apply evaluation rules to cluster
   */
  private applyRules(
    cluster: SpatialCluster,
    summary: SpatialClusterSummary
  ): { needsEvaluation: boolean; urgency: 'low' | 'medium' | 'high' | 'urgent'; reasoning: string } | null {
    // Sort rules by priority (descending)
    const sortedRules = [...this.rules].sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      try {
        if (rule.condition(cluster, summary)) {
          const result = rule.action(cluster, summary);
          logger.info(`Rule matched: ${rule.name}`);
          return result;
        }
      } catch (error) {
        logger.error(`Rule ${rule.name} error:`, error);
      }
    }

    return null;
  }

  /**
   * Match cluster against AC triggers
   */
  private matchTriggers(cluster: SpatialCluster): ACTriggerCondition[] {
    const matched: ACTriggerCondition[] = [];

    for (const trigger of this.triggers) {
      if (this.evaluateTriggerCondition(trigger, cluster)) {
        matched.push(trigger);
      }
    }

    return matched;
  }

  /**
   * Evaluate a single trigger condition against cluster
   */
  private evaluateTriggerCondition(trigger: ACTriggerCondition, cluster: SpatialCluster): boolean {
    // Check events in cluster for trigger conditions
    for (const event of cluster.events) {
      const payload = event.payload || {};

      if (trigger.conditionType === 'environment-parameter') {
        const paramValue = payload[trigger.triggerParameter as string];
        if (paramValue !== undefined && typeof paramValue === 'number') {
          if (this.evaluateOperator(paramValue, trigger.triggerOperator!, trigger.triggerValue as number)) {
            return true;
          }
        }
      }

      if (trigger.conditionType === 'device-state') {
        if (trigger.stateProperty && payload[trigger.stateProperty] !== undefined) {
          const currentValue = payload[trigger.stateProperty];
          if (this.evaluateOperator(currentValue, trigger.triggerOperator!, trigger.triggerValue)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Evaluate comparison operator
   */
  private evaluateOperator(value: any, operator: string, threshold: any): boolean {
    switch (operator) {
      case '>':
        return value > threshold;
      case '<':
        return value < threshold;
      case '>=':
        return value >= threshold;
      case '<=':
        return value <= threshold;
      case '==':
        return value === threshold;
      case '!=':
        return value !== threshold;
      default:
        return false;
    }
  }

  /**
   * Get highest urgency from matched triggers
   */
  private getHighestUrgency(triggers: ACTriggerCondition[]): 'low' | 'medium' | 'high' | 'urgent' {
    const urgencyOrder = { urgent: 4, high: 3, medium: 2, low: 1 };
    let highest: 'low' | 'medium' | 'high' | 'urgent' = 'low';

    for (const trigger of triggers) {
      if (urgencyOrder[trigger.priority] > urgencyOrder[highest]) {
        highest = trigger.priority;
      }
    }

    return highest;
  }

  /**
   * Initialize default evaluation rules
   */
  private initializeDefaultRules(): void {
    // Rule 1: Very low event count - no AC needed (only filter 0 events)
    // NOTE: Single events (1-2) can still trigger AC for task assignments
    this.rules.push({
      id: 'low-event-count',
      name: 'Low Event Count',
      description: 'Clusters with no events do not need AC',
      priority: 200,
      condition: (cluster, summary) => {
        return cluster.statistics.eventCount === 0;
      },
      action: (cluster, summary) => ({
        needsEvaluation: false,
        urgency: 'low',
        reasoning: `No events in cluster`,
      }),
    });

    // Rule 2: Threshold breach detected - immediate action
    this.rules.push({
      id: 'threshold-breach',
      name: 'Threshold Breach',
      description: 'Any threshold breach requires immediate evaluation',
      priority: 150,
      condition: (cluster, summary) => {
        return cluster.patterns.some(p => p.type === 'threshold_breach');
      },
      action: (cluster, summary) => {
        const breaches = cluster.patterns.filter(p => p.type === 'threshold_breach');
        return {
          needsEvaluation: true,
          urgency: 'urgent',
          reasoning: `Threshold breach detected: ${breaches.map(b => b.description).join('; ')}`,
        };
      },
    });

    // Rule 3: Anomaly detected - high priority
    this.rules.push({
      id: 'anomaly-detected',
      name: 'Anomaly Detected',
      description: 'Anomalous patterns require LLM evaluation',
      priority: 140,
      condition: (cluster, summary) => {
        return cluster.patterns.some(p => p.type === 'anomaly');
      },
      action: (cluster, summary) => {
        const anomalies = cluster.patterns.filter(p => p.type === 'anomaly');
        return {
          needsEvaluation: true,
          urgency: 'high',
          reasoning: `Anomaly detected: ${anomalies.map(a => a.description).join('; ')}`,
        };
      },
    });

    // Rule 4: Strong correlation - medium priority
    this.rules.push({
      id: 'strong-correlation',
      name: 'Strong Correlation',
      description: 'Strong correlations between parameters may need investigation',
      priority: 130,
      condition: (cluster, summary) => {
        const correlations = cluster.patterns.filter(p => p.type === 'correlation');
        return correlations.some(c => c.confidence > 0.8);
      },
      action: (cluster, summary) => {
        const correlations = cluster.patterns.filter(p => p.type === 'correlation');
        return {
          needsEvaluation: true,
          urgency: 'medium',
          reasoning: `Strong correlation detected: ${correlations.map(c => c.description).join('; ')}`,
        };
      },
    });

    // Rule 5: High event rate - monitor
    this.rules.push({
      id: 'high-event-rate',
      name: 'High Event Rate',
      description: 'Clusters with many events but no patterns should be monitored',
      priority: 100,
      condition: (cluster, summary) => {
        return cluster.statistics.eventCount >= 10 && cluster.patterns.length === 0;
      },
      action: (cluster, summary) => ({
        needsEvaluation: false,
        urgency: 'medium',
        reasoning: `High event count (${cluster.statistics.eventCount}) but no significant patterns`,
      }),
    });

    // Rule 6: Volatile trend - needs evaluation
    this.rules.push({
      id: 'volatile-trend',
      name: 'Volatile Trend',
      description: 'Volatile trends may indicate instability',
      priority: 90,
      condition: (cluster, summary) => {
        return cluster.statistics.trend === 'volatile';
      },
      action: (cluster, summary) => ({
        needsEvaluation: true,
        urgency: 'medium',
        reasoning: 'Volatile trend detected - may indicate system instability',
      }),
    });

    // Rule 7: Multiple event types - potential coordination needed
    this.rules.push({
      id: 'multiple-event-types',
      name: 'Multiple Event Types',
      description: 'Multiple event types in same location may need coordination',
      priority: 80,
      condition: (cluster, summary) => {
        return cluster.statistics.eventTypes.size >= 3;
      },
      action: (cluster, summary) => ({
        needsEvaluation: true,
        urgency: 'medium',
        reasoning: `${cluster.statistics.eventTypes.size} different event types in same location`,
      }),
    });
  }

  /**
   * Add custom evaluation rule
   */
  addRule(rule: EvaluationRule): void {
    this.rules.push(rule);
    logger.info(`Added rule: ${rule.name}`);
  }

  /**
   * Remove evaluation rule
   */
  removeRule(ruleId: string): boolean {
    const index = this.rules.findIndex(r => r.id === ruleId);
    if (index !== -1) {
      this.rules.splice(index, 1);
      logger.info(`Removed rule: ${ruleId}`);
      return true;
    }
    return false;
  }

  /**
   * Add custom trigger
   */
  addTrigger(trigger: ACTriggerCondition): void {
    this.triggers.push(trigger);
    logger.info(`Added trigger: ${trigger.name}`);
  }

  /**
   * Get statistics
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Get filtering rate
   */
  getFilteringRate(): number {
    if (this.stats.totalEvaluations === 0) return 0;
    return (this.stats.filtered / this.stats.totalEvaluations) * 100;
  }
}

export default TriggerConditionEvaluator;
