/**
 * Multi-Factor Proposal Evaluator
 *
 * Evaluates global proposals using multiple factors:
 * - Capability Match (35%)
 * - Resource Availability (25%)
 * - Current Load (15%)
 * - Service Complexity (10%)
 * - Requirement Compliance (15%) - NEW: Validates against requirement specifications
 */

import type { LLMClient } from '@active-collaboration/llm-integration';
import type {
  IProposalEvaluator,
  GlobalProposalRequest,
  AgentContext,
  ProposalEvaluationResult,
  EvaluationFactors
} from './interfaces.js';

type ProposalTask = GlobalProposalRequest['task'];

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('MultiFactorProposalEvaluator');



export class MultiFactorProposalEvaluator implements IProposalEvaluator {
  private llmClient: LLMClient;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
    logger.info('[MultiFactorEvaluator] Initialized');
  }

  async evaluate(
    proposal: GlobalProposalRequest,
    agentContext: AgentContext
  ): Promise<ProposalEvaluationResult> {
    logger.info(`[MultiFactorEvaluator:${agentContext.agentId}] Evaluating proposal ${proposal.proposalId}`);
    logger.info(`[MultiFactorEvaluator:${agentContext.agentId}] Task: ${proposal.task.description}`);

    try {
      // Factor 1: Capability Match (35%) - Use LLM for semantic understanding
      const capabilityMatch = await this.evaluateCapabilityMatch(
        proposal.task,
        agentContext
      );

      // Factor 2: Resource Availability (25%)
      const resourceAvailability = this.evaluateResourceAvailability(
        proposal.task,
        agentContext
      );

      // Factor 3: Current Load (15%)
      const currentLoad = agentContext.currentLoad;

      // Factor 4: Service Complexity (10%)
      const serviceComplexity = this.evaluateServiceComplexity(proposal.task);

      // Factor 5: Requirement Compliance (15%) - NEW
      const requirementCompliance = await this.evaluateRequirementCompliance(
        proposal.task,
        agentContext
      );

      // Calculate weighted score
      const score =
        capabilityMatch * 0.35 +
        resourceAvailability * 0.25 +
        (1 - currentLoad) * 0.15 +  // Invert: lower load = better
        (1 - serviceComplexity) * 0.10 +  // Invert: simpler = better
        requirementCompliance * 0.15;  // NEW: Requirement compliance

      // Estimate completion time based on complexity and load
      const baseTime = 5000; // 5 seconds base
      const complexityMultiplier = 1 + serviceComplexity * 2; // up to 3x
      const loadMultiplier = 1 + currentLoad * 0.5; // up to 1.5x
      const estimatedCompletionTime = baseTime * complexityMultiplier * loadMultiplier;

      // Calculate confidence (based on how well capabilities match)
      const confidence = capabilityMatch; // Simpler: use capability match as proxy

      // Make decision
      let decision: 'accept' | 'reject' | 'negotiate';
      if (score > 0.70) {
        decision = 'accept';
      } else if (score >= 0.40) {
        decision = 'negotiate';
      } else {
        decision = 'reject';
      }

      const factors: EvaluationFactors = {
        capabilityMatch,
        resourceAvailability,
        currentLoad,
        serviceComplexity,
        requirementCompliance,  // NEW
        estimatedCompletionTime,
        confidence
      };

      logger.info(`[MultiFactorEvaluator:${agentContext.agentId}] Score: ${score.toFixed(2)}, Decision: ${decision}`);
      logger.info(`[MultiFactorEvaluator:${agentContext.agentId}] Factors:`, {
        capabilityMatch: capabilityMatch.toFixed(2),
        resourceAvailability: resourceAvailability.toFixed(2),
        currentLoad: currentLoad.toFixed(2),
        serviceComplexity: serviceComplexity.toFixed(2),
        requirementCompliance: requirementCompliance.toFixed(2),  // NEW
        estimatedCompletionTime: `${estimatedCompletionTime.toFixed(0)}ms`,
        confidence: confidence.toFixed(2)
      });

      return {
        score,
        decision,
        factors,
        reason: this.generateReason(decision, factors)
      };

    } catch (error) {
      logger.error(`[MultiFactorEvaluator:${agentContext.agentId}] Evaluation failed:`, error);

      // Return conservative rejection on error
      return {
        score: 0,
        decision: 'reject',
        factors: {
          capabilityMatch: 0,
          resourceAvailability: 0,
          currentLoad: agentContext.currentLoad,
          serviceComplexity: 1,
          requirementCompliance: 0,  // NEW
          estimatedCompletionTime: 30000,
          confidence: 0
        },
        reason: `Evaluation failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Evaluate capability match using LLM for semantic understanding
   */
  private async evaluateCapabilityMatch(
    task: ProposalTask,
    context: AgentContext
  ): Promise<number> {
    logger.info(`[MultiFactorEvaluator:${context.agentId}] Evaluating capability match using LLM...`);

    const prompt = `You are evaluating if an agent can complete a task.

Agent Capabilities: ${context.capabilities.join(', ')}
Agent Resources: ${context.resources.map(r => r.type).join(', ')}
Task: ${task.description}
Task Requirements: ${task.requirements.capabilities.join(', ')}

Evaluate on a scale of 0-1:
- 1.0: Agent can definitely complete this task
- 0.7: Agent can likely complete this task
- 0.4: Agent might partially complete this task
- 0.0: Agent cannot complete this task

Consider semantic relationships:
- "hvac" or "climate control" can handle "temperature"
- "thermostat" can handle "temperature"
- "humidifier" can handle "humidity"
- "purifier" can handle "air quality"

Return ONLY a number (0-1) with 2 decimal places, no explanation.

/no_think`;

    try {
      const response = await this.llmClient.chat({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 20  // Small enough since /no_think should give direct answer
      });

      logger.info(`[MultiFactorEvaluator:${context.agentId}] LLM raw response: "${response.content}"`);

      // Extract content after thinking tokens (handles Qwen3 and similar models)
      let cleanContent = response.content;

      // Pattern 1: Qwen3 style </thinkoreturn> tag
      const thinkingMatch = response.content.match(/<\/thinkoreturn>\s*([\s\S]*)/);
      if (thinkingMatch && thinkingMatch[1].trim()) {
        cleanContent = thinkingMatch[1].trim();
        logger.info(`[MultiFactorEvaluator:${context.agentId}] Extracted content after thinking tag`);
      }

      // Pattern 2: Alternative </thetagh> tag
      const altThinkingMatch = response.content.match(/<\/thetagh>\s*([\s\S]*)/);
      if (altThinkingMatch && altThinkingMatch[1].trim()) {
        cleanContent = altThinkingMatch[1].trim();
        logger.info(`[MultiFactorEvaluator:${context.agentId}] Extracted content after alt thinking tag`);
      }

      // Pattern 3: Generic thinking block (content after last newline if starts with thinking)
      if (cleanContent.includes('获益')) {
        const afterThink = cleanContent.split(/<\/thetagh?>/).pop();
        if (afterThink && afterThink.trim()) {
          cleanContent = afterThink.trim();
        }
      }

      // Try multiple patterns to extract score
      let score = -1; // -1 indicates no match found yet

      // Pattern 1: Match 0.XX or 1.00
      let match = cleanContent.match(/([01]\.\d+)/);
      if (match) {
        score = parseFloat(match[1]);
      } else {
        // Pattern 2: Match any decimal number between 0 and 1
        match = cleanContent.match(/\b(0?\.\d+|1\.0)\b/);
        if (match) {
          score = parseFloat(match[0]);
        } else {
          // Pattern 3: Match any number that could be a score
          match = cleanContent.match(/\b(\d+\.?\d*)\b/);
          if (match) {
            const num = parseFloat(match[1]);
            if (num >= 0 && num <= 1) {
              score = num;
            } else if (num > 1 && num <= 100) {
              // Normalize percentage-like values
              score = Math.min(num / 100, 1.0);
            }
          }
        }
      }

      // Pattern 4: Look for keywords if no numeric score found
      if (score < 0) {
        const content = cleanContent.toLowerCase();
        if (content.includes('definitely') || content.includes('fully') || content.includes('yes') || content.includes('can complete')) {
          score = 1.0;
        } else if (content.includes('likely') || content.includes('probably') || content.includes('highly')) {
          score = 0.7;
        } else if (content.includes('partially') || content.includes('somewhat') || content.includes('maybe')) {
          score = 0.4;
        } else if (content.includes('cannot') || content.includes('no') || content.includes('unable')) {
          score = 0.0;
        }
      }

      if (score >= 0) {
        logger.info(`[MultiFactorEvaluator:${context.agentId}] LLM capability score: ${score}`);
        return score;
      }

      // Log failure with details
      logger.warn(`[MultiFactorEvaluator:${context.agentId}] LLM response parse failed, using fallback`);
      logger.warn(`[MultiFactorEvaluator:${context.agentId}] Raw response was: "${response.content.substring(0, 200)}"`);
      return this.fallbackCapabilityMatch(task, context);

    } catch (error) {
      logger.error(`[MultiFactorEvaluator:${context.agentId}] LLM evaluation failed:`, error);
      return this.fallbackCapabilityMatch(task, context);
    }
  }

  /**
   * Fallback capability matching (keyword-based)
   */
  private fallbackCapabilityMatch(task: ProposalTask, context: AgentContext): number {
    logger.info(`[MultiFactorEvaluator:${context.agentId}] Using fallback capability matching`);

    const taskLower = task.description.toLowerCase();
    const reqCaps = task.requirements.capabilities || [];

    let matchCount = 0;
    for (const req of reqCaps) {
      const reqLower = req.toLowerCase();
      const matches = context.capabilities.filter(cap =>
        cap.toLowerCase().includes(reqLower) || reqLower.includes(cap.toLowerCase())
      );
      if (matches.length > 0) {
        matchCount++;
      }
    }

    // Simple heuristic
    if (matchCount === reqCaps.length) {
      return 0.9; // All requirements matched
    } else if (matchCount > 0) {
      return 0.6; // Partial match
    } else {
      return 0.2; // No match
    }
  }

  /**
   * Evaluate resource availability
   *
   * IMPORTANT: Checks both resource type AND resource capabilities for matching.
   * This follows the LLM Responsibility Principle - provide more complete context
   * by including capability information from resources, not just types.
   */
  private evaluateResourceAvailability(
    task: ProposalTask,
    context: AgentContext
  ): number {
    const requiredCapabilities = task.requirements.capabilities || [];

    // Collect all available capabilities from resources
    // Resources have both 'type' and 'capabilities' array
    const allResourceCapabilities: string[] = [];
    for (const resource of context.resources) {
      // Add resource type (e.g., 'device', 'service')
      allResourceCapabilities.push(resource.type.toLowerCase());

      // Add resource capabilities if available (e.g., 'set-temperature', 'read-humidity')
      if (resource.capabilities && resource.capabilities.length > 0) {
        allResourceCapabilities.push(...resource.capabilities.map(c => c.toLowerCase()));
      }
    }

    logger.info(`[MultiFactorEvaluator:${context.agentId}] Required capabilities: ${requiredCapabilities.join(', ')}`);
    logger.info(`[MultiFactorEvaluator:${context.agentId}] Available capabilities: ${allResourceCapabilities.join(', ')}`);

    if (requiredCapabilities.length === 0) {
      return 0.5; // Neutral if no specific requirements
    }

    // Semantic capability mapping for better matching
    const semanticMappings: Record<string, string[]> = {
      'temperature': ['set-temperature', 'read-temperature', 'temperature-sensor', 'thermostat', 'hvac', 'climate'],
      'humidity': ['read-humidity', 'humidity-sensor', 'humidifier', 'dehumidifier'],
      'light': ['set-brightness', 'turn-on', 'turn-off', 'light-switch', 'smart-light', 'lighting'],
      'hvac': ['set-temperature', 'set-mode', 'hvac', 'climate-control', 'temperature'],
      'climate': ['set-temperature', 'set-mode', 'hvac', 'thermostat', 'temperature', 'humidity'],
      'energy': ['power-monitoring', 'energy-meter', 'smart-plug', 'power-control'],
      'environment': ['temperature', 'humidity', 'light', 'air-quality'],
      'control-environment': ['set-temperature', 'set-mode', 'set-brightness', 'hvac', 'climate-control'],
    };

    let matchCount = 0;
    for (const req of requiredCapabilities) {
      const reqLower = req.toLowerCase();

      // Direct match with available capabilities
      const directMatch = allResourceCapabilities.some(avail =>
        avail.includes(reqLower) || reqLower.includes(avail)
      );

      if (directMatch) {
        matchCount++;
        continue;
      }

      // Semantic match using mappings
      const relatedCapabilities = semanticMappings[reqLower] || [];
      const semanticMatch = relatedCapabilities.some(relCap =>
        allResourceCapabilities.some(avail =>
          avail.includes(relCap) || relCap.includes(avail)
        )
      );

      if (semanticMatch) {
        matchCount++;
        logger.info(`[MultiFactorEvaluator:${context.agentId}] Semantic match: "${req}" -> ${relatedCapabilities.join(', ')}`);
      }
    }

    const availability = requiredCapabilities.length > 0
      ? matchCount / requiredCapabilities.length
      : 0.5;

    logger.info(`[MultiFactorEvaluator:${context.agentId}] Resource availability: ${availability.toFixed(2)} (${matchCount}/${requiredCapabilities.length} matched)`);
    return availability;
  }

  /**
   * Evaluate service complexity
   */
  private evaluateServiceComplexity(task: ProposalTask): number {
    // Heuristic: more requirements = more complex
    const requirements = task.requirements.capabilities?.length || 1;
    const hasConstraints = Object.keys(task.requirements.constraints || {}).length > 0;

    let complexity = 0.1; // Base complexity

    complexity += Math.min(requirements * 0.15, 0.6); // Up to 0.6 from requirements
    if (hasConstraints) complexity += 0.2; // Constraints add complexity

    return Math.min(complexity, 1.0);
  }

  /**
   * Evaluate requirement compliance
   * Validates task against requirement specifications (if available)
   *
   * @param task - Task to evaluate
   * @param context - Agent context
   * @returns Compliance score (0-1)
   */
  private async evaluateRequirementCompliance(
    task: ProposalTask,
    context: AgentContext
  ): Promise<number> {
    logger.info(`[MultiFactorEvaluator:${context.agentId}] Evaluating requirement compliance...`);

    // For now, return a default value since requirement validation is optional
    // In production, this would:
    // 1. Look up requirement specs from the registry
    // 2. Validate the task against relevant specs
    // 3. Return a compliance score based on validation results

    // TODO: Integrate with RequirementValidator
    // const requirementValidator = context.requirementValidator;
    // if (requirementValidator && task.requirementSpecId) {
    //   const result = await requirementValidator.validatePreExecution(...);
    //   return result.scores.overall;
    // }

    // Default: assume moderate compliance
    const compliance = 0.7;

    logger.info(`[MultiFactorEvaluator:${context.agentId}] Requirement compliance: ${compliance.toFixed(2)}`);
    return compliance;
  }

  /**
   * Generate human-readable reason
   */
  private generateReason(
    decision: string,
    factors: EvaluationFactors
  ): string {
    switch (decision) {
      case 'accept':
        return `Agent can handle task (confidence: ${factors.confidence.toFixed(2)})`;
      case 'reject':
        return `Agent lacks required capabilities or resources`;
      case 'negotiate':
        return `Agent can partially handle task (negotiation possible)`;
      default:
        return 'Unknown decision';
    }
  }
}
