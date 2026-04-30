/**
 * Collaboration Proposal Handler
 *
 * Automatically evaluates and responds to incoming collaboration proposals.
 * Uses LLM-based cost-benefit analysis to decide whether to accept, reject, or counter-propose.
 */

import type {
  CollaborationProposal,
  ProposalDecision,
  ProposalEvaluation,
  ProposalHandlerConfig,
  LLMProposalAnalysis,
} from '../types/proposal-handler.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import type { SystemEvent } from '@active-collaboration/shared';
import { EventType, EventPriority } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
const logger = createLogger('CollaborationProposalHandler');

export interface CollaborationProposalHandlerOptions {
  llmClient: LLMClient;
  environment: EnvironmentCenter;
  agentId: string;
  agentName: string;
  agentCapabilities: string[];
  config: ProposalHandlerConfig;
}

/**
 * Interface for the agent that the handler can call back to.
 * This avoids a direct dependency on CognitiveAgent, preventing circular imports.
 */
export interface ProposalHandlerAgent {
  joinCollaboration(
    collaborationId: string,
    options: {
      role: string;
      capabilities?: string[];
      metadata?: Record<string, unknown>;
    }
  ): Promise<{
    success: boolean;
    collaborationId: string;
    role: string;
    error?: string;
  }>;
}

/**
 * Handles incoming collaboration proposals autonomously
 */
export class CollaborationProposalHandler {
  private llmClient: LLMClient;
  private environment: EnvironmentCenter;
  private agentId: string;
  private agentName: string;
  private agentCapabilities: string[];
  private config: ProposalHandlerConfig;

  // Reference to the owning agent for joining collaborations
  private agent?: ProposalHandlerAgent;

  // Track collaboration history
  private collaborationHistory: Map<string, Date[]> = new Map();
  private activeCollaborations: Set<string> = new Set();

  // Event subscriptions (can subscribe to multiple event types)
  private subscriptionIds: string[] = [];

  constructor(options: CollaborationProposalHandlerOptions) {
    this.llmClient = options.llmClient;
    this.environment = options.environment;
    this.agentId = options.agentId;
    this.agentName = options.agentName;
    this.agentCapabilities = options.agentCapabilities;
    this.config = options.config;

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Initialized with config:`, {
      enabled: this.config.enabled,
      autoExecute: this.config.autoExecuteAccepted,
      maxConcurrent: this.config.maxConcurrentCollaborations,
    });
  }

  /**
   * Set the agent reference for joining collaborations.
   * Called after construction to avoid circular dependency issues.
   */
  setAgent(agent: ProposalHandlerAgent): void {
    this.agent = agent;
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Agent reference set`);
  }

  /**
   * Start listening for collaboration proposals
   *
   * Subscribes to both COLLABORATION_PROPOSAL and COLLABORATION_MESSAGE events
   * because proposals may arrive through either channel:
   * - COLLABORATION_PROPOSAL: formal typed proposals with CollaborationProposal shape
   * - COLLABORATION_MESSAGE: informal proposals with payload.type 'ac-proposal' or 'proposal'
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info(`[CollaborationProposalHandler:${this.agentId}] Not enabled, not starting`);
      return;
    }

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Starting to listen for proposals`);

    const handler = this.handleCollaborationProposal.bind(this);

    // Subscribe to formal collaboration proposal events
    const proposalSubId = this.environment.eventManager.subscribe({
      subscriberId: `${this.agentId}-proposal`,
      eventType: EventType.COLLABORATION_PROPOSAL,
      handler,
      priority: EventPriority.NORMAL,
    });
    this.subscriptionIds.push(proposalSubId);

    // Also subscribe to collaboration message events (informal proposals)
    // Many agents send proposals as COLLABORATION_MESSAGE with payload.type 'ac-proposal' or 'proposal'
    const messageSubId = this.environment.eventManager.subscribe({
      subscriberId: `${this.agentId}-message`,
      eventType: EventType.COLLABORATION_MESSAGE,
      handler,
      priority: EventPriority.NORMAL,
    });
    this.subscriptionIds.push(messageSubId);

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Subscribed to COLLABORATION_PROPOSAL and COLLABORATION_MESSAGE events`);
  }

  /**
   * Stop listening for collaboration proposals
   */
  stop(): void {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Stopping`);

    for (const subId of this.subscriptionIds) {
      this.environment.eventManager.unsubscribe(subId);
    }
    this.subscriptionIds = [];
  }

  /**
   * Handle incoming collaboration proposal event
   *
   * Handles proposals arriving through both COLLABORATION_PROPOSAL and
   * COLLABORATION_MESSAGE event types. Normalizes different payload formats
   * into a consistent CollaborationProposal object.
   */
  private async handleCollaborationProposal(event: SystemEvent): Promise<void> {
    // Normalize the event payload into a CollaborationProposal
    const proposal = this.normalizeProposal(event);

    // Check if this proposal is for me
    if (!proposal || proposal.proposedTo !== this.agentId) {
      return;
    }

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Received proposal from ${proposal.proposedBy}`);

    try {
      // Evaluate the proposal
      const evaluation = await this.evaluateProposal(proposal);

      logger.info(`[CollaborationProposalHandler:${this.agentId}] Evaluation:`, {
        decision: evaluation.decision,
        confidence: evaluation.confidence.toFixed(2),
        reasoning: evaluation.reasoning,
      });

      // Act on the decision, passing event payload for additional context (e.g., collaborationId)
      await this.actOnProposal(evaluation, event.payload);
    } catch (error) {
      // If LLM analysis fails, fall back to capability-based evaluation
      // This is NOT a silent fallback -- we log the full error and make an explicit decision
      logger.error(`[CollaborationProposalHandler:${this.agentId}] Proposal evaluation failed, using capability-based fallback:`, error);

      const evaluation = this.evaluateByCapabilities(proposal);
      logger.info(`[CollaborationProposalHandler:${this.agentId}] Capability-based evaluation:`, {
        decision: evaluation.decision,
        confidence: evaluation.confidence.toFixed(2),
        reasoning: evaluation.reasoning,
      });

      await this.actOnProposal(evaluation, event.payload);
    }
  }

  /**
   * Evaluate a proposal using only capability matching (no LLM)
   *
   * Used as a fallback when LLM analysis is unavailable.
   * The agent still makes an autonomous decision based on capability alignment.
   */
  private evaluateByCapabilities(proposal: CollaborationProposal): ProposalEvaluation {
    // Check capability alignment
    const requiredCaps = proposal.capabilities || [];
    const matchedCaps = requiredCaps.filter(cap =>
      this.agentCapabilities.some(agentCap =>
        agentCap.includes(cap) || cap.includes(agentCap)
      )
    );

    const capabilityMatch = requiredCaps.length > 0
      ? matchedCaps.length / requiredCaps.length
      : 0.5;

    const decision: ProposalDecision = capabilityMatch >= 0.5 ? 'accept' : 'reject';
    const reasoning = capabilityMatch >= 0.5
      ? `Capability-based acceptance: ${matchedCaps.length}/${requiredCaps.length} required capabilities matched (${matchedCaps.join(', ')})`
      : `Capability-based rejection: only ${matchedCaps.length}/${requiredCaps.length} required capabilities matched`;

    return {
      proposal,
      decision,
      confidence: capabilityMatch,
      reasoning,
      benefits: capabilityMatch >= 0.5
        ? [`Capability match: ${matchedCaps.join(', ')}`]
        : [],
      costs: capabilityMatch < 0.5
        ? [`Missing capabilities: ${requiredCaps.filter(c => !matchedCaps.includes(c)).join(', ')}`]
        : [],
      evaluatedAt: new Date(),
    };
  }

  /**
   * Normalize event payload into a CollaborationProposal
   *
   * Handles two formats:
   * 1. Formal: event.payload.proposal is a CollaborationProposal (COLLABORATION_PROPOSAL events)
   * 2. Informal: event.payload itself contains proposal fields (COLLABORATION_MESSAGE events)
   */
  private normalizeProposal(event: SystemEvent): CollaborationProposal | null {
    const payload = event.payload;

    if (!payload) {
      return null;
    }

    // Check if this is an informal proposal via COLLABORATION_MESSAGE
    const payloadRecord = payload as Record<string, unknown>;
    const payloadType = payloadRecord.type as string;
    if (payloadType === 'ac-proposal' || payloadType === 'proposal') {
      const p = payloadRecord;
      return {
        id: (p.collaborationId || p.id || `informal-${Date.now()}`) as string,
        proposedBy: (p.initiatorId || p.proposedBy || event.source) as string,
        proposedTo: (p.targetAgentId || p.proposedTo || this.agentId) as string,
        type: (p.type || 'collaboration-invitation') as string,
        goal: (p.collaborationName || p.description || p.goal || 'Active Collaboration') as string,
        task: (p.task as Record<string, unknown>)?.description as string || p.task as string,
        description: p.description as string,
        capabilities: (p.requiredCapabilities || p.capabilities || []) as string[],
        services: p.services as string[] | undefined,
        resources: p.resources as string[] | undefined,
        priority: p.priority as 'low' | 'medium' | 'high' | 'urgent' | undefined,
        validUntil: p.validUntil as Date | undefined,
        metadata: {
          ...((p.metadata || {}) as Record<string, unknown>),
          collaborationId: p.collaborationId as string,
        },
      };
    }

    // Formal proposal: event.payload.proposal is a CollaborationProposal
    const proposal = (payloadRecord.proposal as CollaborationProposal | undefined);
    if (proposal && proposal.proposedTo) {
      return proposal;
    }

    return null;
  }

  /**
   * Evaluate a collaboration proposal
   */
  async evaluateProposal(proposal: CollaborationProposal): Promise<ProposalEvaluation> {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Evaluating proposal from ${proposal.proposedBy}`);

    // Check if we can accept more collaborations
    if (this.activeCollaborations.size >= this.config.maxConcurrentCollaborations) {
      return {
        proposal,
        decision: 'reject',
        confidence: 1.0,
        reasoning: 'Maximum concurrent collaborations reached',
        benefits: [],
        costs: ['Resource limit exceeded'],
        evaluatedAt: new Date(),
      };
    }

    // Use LLM to analyze the proposal
    const analysis = await this.analyzeWithLLM(proposal);

    // Apply decision criteria
    const decision = this.makeDecision(analysis, proposal);

    const evaluation: ProposalEvaluation = {
      proposal,
      decision: decision.decision,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      benefits: analysis.benefits,
      costs: analysis.costs,
      counterProposal: decision.counterProposal as { modifications: string[]; reasoning: string } | undefined,
      resourceRequirements: this.estimateResourceRequirements(analysis),
      evaluatedAt: new Date(),
    };

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Evaluation complete:`, {
      decision: evaluation.decision,
      benefits: evaluation.benefits.length,
      costs: evaluation.costs.length,
      confidence: evaluation.confidence.toFixed(2),
    });

    return evaluation;
  }

  /**
   * Use LLM to analyze a proposal
   */
  private async analyzeWithLLM(proposal: CollaborationProposal): Promise<LLMProposalAnalysis> {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Using LLM to analyze proposal...`);

    try {
      const previousCollabs = this.collaborationHistory.get(proposal.proposedBy)?.length || 0;

      // Natural language prompt format instead of pipe-separated format
      const prompt = `COLLABORATION PROPOSAL EVALUATION

YOUR PROFILE:
- Agent: ${this.agentName}
- Capabilities: ${this.agentCapabilities.join(', ')}
- Current Workload: ${this.activeCollaborations.size}/${this.config.maxConcurrentCollaborations} collaborations
- Active Collaborations: ${Array.from(this.activeCollaborations).join(', ')}

PROPOSAL DETAILS:
- From: ${proposal.proposedBy}
- Trust Level: ${previousCollabs > 0 ? `High (${previousCollabs} previous collaborations)` : 'Unknown (first collaboration)'}
- Task: ${proposal.task}
- Services Requested: ${proposal.services?.join(', ') || 'none'}
- Description: ${proposal.description || 'No description'}

EVALUATION CRITERIA:
1. CAPABILITY ALIGNMENT: Do you have the requested capabilities?
2. BENEFIT ANALYSIS: Value gained from this collaboration
3. COST ANALYSIS: Resource consumption, time commitment, risks
4. WORKLOAD IMPACT: Effect on existing commitments
5. TRUST FACTOR: Partner's reliability and past performance

DECISION OPTIONS:
- ACCEPT: Benefits clearly outweigh costs
- REJECT: Costs too high or misaligned
- COUNTER: Acceptable with modifications
- DEFER: Need more information

Respond in JSON:
{
  "benefitScore": 0.0-1.0,
  "costScore": 0.0-1.0,
  "benefits": ["specific benefit 1", "specific benefit 2"],
  "costs": ["specific cost 1", "specific cost 2"],
  "recommendedDecision": "accept|reject|counter|defer",
  "reasoning": "detailed explanation",
  "counterModifications": ["modification 1", "modification 2"]
}`;

      const response = await this.llmClient.chat({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 500,
      });

      // Extract JSON from response (handle markdown code blocks)
      const cleanedContent = this.extractJSON(response.content);
      const analysis = JSON.parse(cleanedContent);

      return {
        benefitScore: analysis.benefitScore || 0.5,
        costScore: analysis.costScore || 0.5,
        benefits: analysis.benefits || [],
        costs: analysis.costs || [],
        recommendedDecision: analysis.recommendedDecision || 'defer',
        reasoning: analysis.reasoning || 'Analysis failed',
        counterModifications: analysis.counterModifications,
      };
    } catch (error: unknown) {
      // Fail Early: Log with full context and throw error instead of returning default value
      logger.error(`[CollaborationProposalHandler:${this.agentId}] LLM analysis failed for proposal ${proposal.id} from ${proposal.proposedBy}:`, error);
      throw new Error(`[${this.agentName}] analyzeWithLLM failed for proposal ${proposal.id} from ${proposal.proposedBy}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Make final decision based on analysis and criteria
   */
  private makeDecision(
    analysis: LLMProposalAnalysis,
    proposal: CollaborationProposal
  ): { decision: ProposalDecision; confidence: number; reasoning: string; counterProposal?: Record<string, unknown> } {
    const criteria = this.config.criteria;

    // Calculate confidence based on benefit/cost ratio
    const ratio = analysis.benefitScore / (analysis.costScore + 0.01);
    const confidence = Math.min(1.0, ratio);

    // Check if proposal meets minimum criteria
    const meetsBenefitThreshold = analysis.benefitScore >= criteria.minBenefitThreshold;
    const withinCostLimit = analysis.costScore <= criteria.maxCostThreshold;

    // Check if we've collaborated with this partner before
    const previousCollabs = this.collaborationHistory.get(proposal.proposedBy)?.length || 0;
    const trustedPartner = previousCollabs > 0;

    let decision: ProposalDecision;
    let reasoning = analysis.reasoning;

    // Decision logic
    if (meetsBenefitThreshold && withinCostLimit) {
      decision = 'accept';
      reasoning += analysis.benefits.length > 0 ? `. Benefits: ${analysis.benefits.join(', ')}` : '';
    } else if (analysis.benefitScore > criteria.minBenefitThreshold * 0.8) {
      // Close to threshold, consider counter-proposal
      decision = analysis.recommendedDecision === 'counter' ? 'counter' : 'defer';
      reasoning += '. Needs negotiation.';
    } else {
      decision = 'reject';
      reasoning += `. Costs: ${analysis.costs.join(', ')}`;
    }

    return {
      decision,
      confidence,
      reasoning: reasoning || 'No reasoning provided',
      counterProposal: decision === 'counter'
        ? {
            modifications: analysis.counterModifications || [],
            reasoning: 'Counter-proposal based on analysis',
          }
        : undefined,
    };
  }

  /**
   * Estimate resource requirements for a collaboration
   */
  private estimateResourceRequirements(analysis: LLMProposalAnalysis) {
    return {
      computation: analysis.costScore * 0.5, // Estimate
      memory: analysis.costScore * 0.3, // Estimate
      time: analysis.costScore * 10000, // Estimate in ms
    };
  }

  /**
   * Act on a proposal decision
   *
   * @param evaluation - The evaluation result
   * @param eventPayload - The original event payload (for additional context like collaborationId)
   */
  private async actOnProposal(evaluation: ProposalEvaluation, eventPayload?: Record<string, unknown>): Promise<void> {
    const { proposal, decision } = evaluation;

    switch (decision) {
      case 'accept':
        await this.acceptProposal(proposal, evaluation, eventPayload);
        break;

      case 'reject':
        await this.rejectProposal(proposal, evaluation);
        break;

      case 'counter':
        await this.counterProposal(proposal, evaluation);
        break;

      case 'defer':
        logger.info(`[CollaborationProposalHandler:${this.agentId}] Deferring decision on proposal ${proposal.id}`);
        break;
    }
  }

  /**
   * Accept a collaboration proposal
   *
   * @param proposal - The accepted proposal
   * @param evaluation - The evaluation result
   * @param eventPayload - Original event payload for additional context (collaborationId, etc.)
   */
  private async acceptProposal(
    proposal: CollaborationProposal,
    evaluation: ProposalEvaluation,
    eventPayload?: Record<string, unknown>
  ): Promise<void> {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Accepting proposal from ${proposal.proposedBy}`);

    // Record collaboration
    if (!this.collaborationHistory.has(proposal.proposedBy)) {
      this.collaborationHistory.set(proposal.proposedBy, []);
    }
    this.collaborationHistory.get(proposal.proposedBy)!.push(new Date());
    this.activeCollaborations.add(proposal.id);

    // Determine the collaborationId from multiple possible sources:
    // 1. proposal.metadata.collaborationId (set during normalization for informal proposals)
    // 2. (proposal as unknown as Record<string, unknown>).collaborationId (if present on the proposal object)
    // 3. eventPayload.collaborationId (for COLLABORATION_MESSAGE events)
    const collaborationId =
      proposal.metadata?.collaborationId ??
      (proposal as unknown as Record<string, unknown>).collaborationId as string ??
      (eventPayload as Record<string, unknown> | undefined)?.collaborationId as string;

    // Publish acceptance event with all relevant data
    // Uses 'join-response' type so listeners can identify this as a response to a collaboration proposal
    this.environment.eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: this.agentId,
      priority: EventPriority.NORMAL,
      payload: {
        type: 'join-response',
        acDecision: 'accept',
        proposal: proposal,
        evaluation: evaluation,
        agentId: this.agentId,
        collaborationId: collaborationId,
        decision: 'accept',
        reason: evaluation.reasoning,
      },
      metadata: {},
    });

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Published acceptance for proposal ${proposal.id}`);

    // Join the collaboration session autonomously
    if (collaborationId && this.agent) {
      logger.info(`[CollaborationProposalHandler:${this.agentId}] Joining collaboration ${collaborationId}`);

      const joinResult = await this.agent.joinCollaboration(collaborationId, {
        role: 'participant',
        capabilities: this.agentCapabilities,
        metadata: {
          proposalId: proposal.id,
          proposedBy: proposal.proposedBy,
          evaluationConfidence: evaluation.confidence,
          evaluationReasoning: evaluation.reasoning,
        },
      });

      if (joinResult.success) {
        logger.info(`[CollaborationProposalHandler:${this.agentId}] Successfully joined collaboration ${collaborationId}`);
      } else {
        logger.error(
          `[CollaborationProposalHandler:${this.agentId}] Failed to join collaboration ${collaborationId}: ${joinResult.error}`
        );
      }
    } else if (!collaborationId) {
      logger.warn(
        `[CollaborationProposalHandler:${this.agentId}] No collaborationId found in proposal ${proposal.id}, cannot join session`
      );
    } else if (!this.agent) {
      logger.warn(
        `[CollaborationProposalHandler:${this.agentId}] No agent reference set, cannot join collaboration ${collaborationId}. Call setAgent() first.`
      );
    }

    // If auto-execute is enabled, integrate external services
    if (this.config.autoExecuteAccepted) {
      await this.integrateExternalServices(proposal, evaluation);
    }
  }

  /**
   * Reject a collaboration proposal
   */
  private async rejectProposal(
    proposal: CollaborationProposal,
    evaluation: ProposalEvaluation
  ): Promise<void> {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Rejecting proposal from ${proposal.proposedBy}`);

    // Publish rejection event
    this.environment.eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: this.agentId,
      priority: EventPriority.NORMAL,
      payload: {
        type: 'reject',
        proposal: proposal,
        reason: evaluation.reasoning,
      },
      metadata: {},
    });

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Published rejection for proposal ${proposal.id}`);
  }

  /**
   * Send a counter-proposal
   */
  private async counterProposal(
    proposal: CollaborationProposal,
    evaluation: ProposalEvaluation
  ): Promise<void> {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Sending counter-proposal to ${proposal.proposedBy}`);

    // Publish counter-proposal event
    this.environment.eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: this.agentId,
      priority: EventPriority.NORMAL,
      payload: {
        type: 'counter',
        originalProposal: proposal,
        counterProposal: evaluation.counterProposal,
        reason: evaluation.reasoning,
      },
      metadata: {},
    });

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Published counter-proposal for ${proposal.id}`);
  }

  /**
   * Integrate external services from accepted proposal
   */
  private async integrateExternalServices(
    proposal: CollaborationProposal,
    evaluation: ProposalEvaluation
  ): Promise<void> {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Integrating external services from ${proposal.proposedBy}`);

    // This would typically:
    // 1. Discover services provided by the partner
    // 2. Add them to the agent's resource registry
    // 3. Make them available for use

    // For now, just log
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Services to integrate:`, proposal.services);

    // Publish integration event
    this.environment.eventManager.publish({
      type: EventType.ENVIRONMENT_PARAM_CHANGED, // Reuse event type for now
      source: this.agentId,
      priority: EventPriority.NORMAL,
      payload: {
        type: 'services-integrated',
        partner: proposal.proposedBy,
        services: proposal.services,
      },
      metadata: {},
    });
  }

  /**
   * Extract JSON from LLM response (handles markdown code blocks)
   */
  private extractJSON(content: string): string {
    // Check if content contains markdown code blocks
    const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      return jsonBlockMatch[1].trim();
    }

    // Check if content starts with { but has extra text
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return content.substring(firstBrace, lastBrace + 1);
    }

    // Return as-is if no patterns found
    return content.trim();
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ProposalHandlerConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Config updated`);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      activeCollaborations: this.activeCollaborations.size,
      totalCollaborations: Array.from(this.collaborationHistory.values()).reduce(
        (sum, dates) => sum + dates.length,
        0
      ),
      uniquePartners: this.collaborationHistory.size,
    };
  }
}
