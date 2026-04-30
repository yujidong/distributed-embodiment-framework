/**
 * Partner Selection Negotiator - Layer 2 Cognitive Decision
 *
 * Finds best collaboration partners based on:
 * 1. Required capabilities from assessment
 * 2. Agent availability and workload
 * 3. Historical collaboration success
 * 4. Spatial proximity (agents in same environment)
 *
 * Generates collaboration proposals for selected partners.
 */

import { v4 as uuidv4 } from 'uuid';
import type { ACNecessityAssessment } from './ACNecessityAssessor.js';
import type { CognitiveAgent } from '../agent/CognitiveAgent.js';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import { hasMatchingCapability } from '../environment/types.js';

import { createLogger, spatialDistance, type SpatialPosition } from '@active-collaboration/shared';
// ============================================================================
// Types
// ============================================================================

/**
 * Partner candidate information
 */
const logger = createLogger('PartnerSelectionNegotiator');

export interface PartnerCandidate {
  agentId: string;
  agentName: string;
  capabilities: string[];
  workload: 'idle' | 'light' | 'moderate' | 'heavy';
  currentCollaborations: number;
  reliability: number; // 0-1 based on past collaborations
  proximity: number; // 0-1 based on location relevance
  matchScore: number; // 0-1 overall match score
}

/**
 * Collaboration requirement
 */
export interface CollaborationRequirement {
  capabilityType: string;
  minAgents: number;
  maxAgents?: number;
  preferredAgents?: string[];
  required: boolean;
  priority: number;
}

/**
 * Collaboration proposal
 */
export interface CollaborationProposal {
  id: string;
  initiatorId: string;
  initiatorName: string;

  // What
  collaborationGoal: string;
  detailedDescription: string;

  // Why
  triggerSummary: string;
  reasoning: string;
  benefits: string[];

  // Who
  requiredCapabilities: string[];
  targetPartnerIds: string[];
  targetPartnerProfiles: string[];

  // How
  proposedDuration: number; // milliseconds
  proposedConstraints: Record<string, any>;

  // Metadata
  priority: 'low' | 'medium' | 'high' | 'urgent';
  expiresAt: Date;
  createdAt: Date;

  // Status
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  responses: CollaborationResponse[];
}

/**
 * Response to collaboration proposal
 */
export interface CollaborationResponse {
  agentId: string;
  agentName: string;
  response: 'accept' | 'reject' | 'negotiate';
  reasoning?: string;
  counterProposal?: Partial<CollaborationProposal>;
  timestamp: Date;
}

/**
 * Failure reason for partner selection
 */
export interface PartnerSelectionFailureReason {
  step: string;
  reason: string;
  details: string;
  timestamp: Date;
}

/**
 * Partner selection result
 */
export interface PartnerSelectionResult {
  selectedPartners: PartnerCandidate[];
  proposal: CollaborationProposal;
  confidence: number;
  reasoning: string;
  /** Failure details if partners were not found */
  failureReasons?: PartnerSelectionFailureReason[];
  /** Whether this is a fallback to single-agent mode */
  isFallback?: boolean;
}

/**
 * Configuration for PartnerSelectionNegotiator
 */
export interface NegotiatorConfig {
  // Selection settings
  maxPartners: number;
  minPartners: number;
  workloadThreshold: number; // Max collaborations to be considered available

  // Scoring weights
  capabilityWeight: number;
  workloadWeight: number;
  reliabilityWeight: number;
  proximityWeight: number;
  /** Maximum distance (meters) for proximity scoring. Beyond this, score = 0. Default: 50 */
  maxProximityDistance: number;

  // Proposal settings
  proposalTimeout: number; // milliseconds
  defaultDuration: number; // milliseconds
}

const DEFAULT_CONFIG: NegotiatorConfig = {
  maxPartners: 5,
  minPartners: 1,
  workloadThreshold: 3,

  capabilityWeight: 0.4,
  workloadWeight: 0.25,
  reliabilityWeight: 0.2,
  proximityWeight: 0.15,
  maxProximityDistance: 50, // 50 meters

  proposalTimeout: 30000, // 30 seconds
  defaultDuration: 120000, // 2 minutes
};

// ============================================================================
// PartnerSelectionNegotiator
// ============================================================================

export class PartnerSelectionNegotiator {
  private config: NegotiatorConfig;
  private environmentCenter: EnvironmentCenter | null = null;
  private llmClient: import('@active-collaboration/llm-integration').LLMClient | undefined;

  // Statistics
  private stats = {
    totalSelections: 0,
    partnersFound: 0,
    proposalsSent: 0,
    proposalsAccepted: 0,
    proposalsRejected: 0,
  };

  // Historical data
  private collaborationHistory: Map<string, {
    successCount: number;
    failureCount: number;
    lastCollaboration: Date;
  }> = new Map();

  constructor(
    config: Partial<NegotiatorConfig> = {},
    environmentCenter?: EnvironmentCenter,
    llmClient?: import('@active-collaboration/llm-integration').LLMClient
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.environmentCenter = environmentCenter || null;
    this.llmClient = llmClient;

    logger.info('Initialized');
  }

  /**
   * Find partners and create proposal based on assessment
   */
  async findPartners(assessment: ACNecessityAssessment): Promise<PartnerSelectionResult> {
    this.stats.totalSelections++;
    const failureReasons: PartnerSelectionFailureReason[] = [];
    const startTime = Date.now();

    logger.info(`\n[PartnerSelectionNegotiator] ========== PARTNER SELECTION START ==========`);
    logger.info(`Initiator: ${assessment.agentContext.agentName}`);
    logger.info(`Required capabilities: [${assessment.llmAssessment.requiredCapabilities.join(', ')}]`);

    // Get required capabilities from assessment
    const requiredCapabilities = assessment.llmAssessment.requiredCapabilities;

    // Check if environment center is available
    if (!this.environmentCenter) {
      const failure: PartnerSelectionFailureReason = {
        step: 'environment-check',
        reason: 'EnvironmentCenter not available',
        details: 'PartnerSelectionNegotiator was initialized without an EnvironmentCenter',
        timestamp: new Date(),
      };
      failureReasons.push(failure);
      logger.error(`FAILURE: ${failure.reason} - ${failure.details}`);

      return {
        selectedPartners: [],
        proposal: this.createEmptyProposal(assessment),
        confidence: 0,
        reasoning: 'EnvironmentCenter not available for partner discovery',
        failureReasons,
        isFallback: true,
      };
    }

    // Find candidate partners
    logger.info(`Step 1: Discovering candidate partners...`);

    // Extract initiator's position from assessment context
    const initiatorPosition = this.extractInitiatorPosition(assessment);

    const candidates = await this.findCandidatePartners(
      requiredCapabilities,
      assessment.agentContext.agentId,
      initiatorPosition
    );

    logger.info(`Discovered ${candidates.length} candidate(s)`);

    if (candidates.length === 0) {
      const failure: PartnerSelectionFailureReason = {
        step: 'partner-discovery',
        reason: 'No candidates found',
        details: `EnvironmentCenter.discoverAgents returned 0 agents with capabilities: [${requiredCapabilities.join(', ')}]. ` +
                 `Total agents in environment: ${this.environmentCenter?.listAgents?.().length || 'unknown'}`,
        timestamp: new Date(),
      };
      failureReasons.push(failure);

      logger.error(`\n[PartnerSelectionNegotiator] ========== PARTNER SELECTION FAILED ==========`);
      logger.error(`Step: ${failure.step}`);
      logger.error(`Reason: ${failure.reason}`);
      logger.error(`Details: ${failure.details}`);
      logger.error(`Duration: ${Date.now() - startTime}ms`);
      logger.error(`========================================\n`);

      return {
        selectedPartners: [],
        proposal: this.createEmptyProposal(assessment),
        confidence: 0,
        reasoning: 'No suitable partners found with required capabilities',
        failureReasons,
        isFallback: true,
      };
    }

    // Score and rank candidates
    const scoredCandidates = this.scoreCandidates(candidates, requiredCapabilities);

    // Select best partners
    const selectedPartners = this.selectBestPartners(
      scoredCandidates,
      assessment.llmAssessment.suggestedPartnerTypes
    );

    // Create proposal
    const proposal = this.createProposal(assessment, selectedPartners);

    this.stats.partnersFound += selectedPartners.length;

    return {
      selectedPartners,
      proposal,
      confidence: this.calculateConfidence(selectedPartners, assessment),
      reasoning: this.generateSelectionReasoning(selectedPartners, assessment),
    };
  }

  /**
   * Find candidate partners from environment
   */
  private async findCandidatePartners(
    requiredCapabilities: string[],
    excludeAgentId: string,
    initiatorPosition: SpatialPosition | null
  ): Promise<PartnerCandidate[]> {
    const candidates: PartnerCandidate[] = [];

    if (!this.environmentCenter) {
      logger.warn('No environment center, cannot find partners');
      return candidates;
    }

    // Get agents from environment using discovery with capability and exclusion filters
    const agents = this.environmentCenter.discoverAgents({
      capabilities: requiredCapabilities.length > 0 ? requiredCapabilities : undefined,
      excludeIds: [excludeAgentId],
    });

    for (const agent of agents) {
      // Skip self (additional check, though excludeIds should handle it)
      if (agent.id === excludeAgentId) continue;

      // Check if agent has any required capabilities
      const agentCapabilities = agent.capabilities || [];
      const capabilityStrings = agentCapabilities.map((cap: unknown) =>
        typeof cap === 'string' ? cap : String((cap as Record<string, unknown>).type || (cap as Record<string, unknown>).description || '')
      );

      // If no specific capabilities required, all agents are eligible
      // Otherwise, check if agent has relevant capabilities using semantic matching
      const hasRelevantCapabilities = requiredCapabilities.length === 0 ||
        hasMatchingCapability(capabilityStrings, requiredCapabilities);

      if (!hasRelevantCapabilities) continue;

      // Build candidate info
      const history = this.collaborationHistory.get(agent.id);
      const reliability = history
        ? history.successCount / (history.successCount + history.failureCount || 1)
        : 0.5;

      // Get candidate's position from its resources
      const candidatePos = this.extractPositionFromAgent(agent);
      const proximity = this.calculateProximityScore(initiatorPosition, candidatePos);

      const candidate: PartnerCandidate = {
        agentId: agent.id,
        agentName: agent.name,
        capabilities: capabilityStrings,
        workload: this.estimateWorkload(agent),
        currentCollaborations: this.getCurrentCollaborations(agent),
        reliability,
        proximity,
        matchScore: 0, // Will be calculated later
      };

      candidates.push(candidate);
    }

    logger.info(`Found ${candidates.length} candidate partners`);
    return candidates;
  }

  /**
   * Score candidates based on multiple factors
   */
  private scoreCandidates(
    candidates: PartnerCandidate[],
    requiredCapabilities: string[]
  ): PartnerCandidate[] {
    return candidates.map(candidate => {
      // Capability match score
      const capabilityScore = this.calculateCapabilityScore(candidate, requiredCapabilities);

      // Workload score (lower is better)
      const workloadScore = this.calculateWorkloadScore(candidate);

      // Reliability score
      const reliabilityScore = candidate.reliability;

      // Proximity score
      const proximityScore = candidate.proximity;

      // Weighted total score
      const totalScore =
        capabilityScore * this.config.capabilityWeight +
        workloadScore * this.config.workloadWeight +
        reliabilityScore * this.config.reliabilityWeight +
        proximityScore * this.config.proximityWeight;

      return {
        ...candidate,
        matchScore: totalScore,
      };
    }).sort((a, b) => b.matchScore - a.matchScore);
  }

  /**
   * Calculate capability match score
   */
  private calculateCapabilityScore(
    candidate: PartnerCandidate,
    requiredCapabilities: string[]
  ): number {
    if (requiredCapabilities.length === 0) return 0.5;

    const matchedCapabilities = requiredCapabilities.filter(req =>
      candidate.capabilities.some(cap =>
        cap.toLowerCase().includes(req.toLowerCase())
      )
    );

    return matchedCapabilities.length / requiredCapabilities.length;
  }

  /**
   * Calculate workload score (inverse - lower workload = higher score)
   */
  private calculateWorkloadScore(candidate: PartnerCandidate): number {
    const workloadMap = {
      idle: 1.0,
      light: 0.75,
      moderate: 0.5,
      heavy: 0.1,
    };

    return workloadMap[candidate.workload] || 0.5;
  }

  /**
   * Select best partners from scored candidates
   */
  private selectBestPartners(
    candidates: PartnerCandidate[],
    suggestedTypes: string[]
  ): PartnerCandidate[] {
    // Prioritize candidates matching suggested types
    const prioritized = candidates.sort((a, b) => {
      // Check if matches suggested types
      const aMatchesType = suggestedTypes.some(type =>
        a.capabilities.some(cap => cap.toLowerCase().includes(type.toLowerCase()))
      );
      const bMatchesType = suggestedTypes.some(type =>
        b.capabilities.some(cap => cap.toLowerCase().includes(type.toLowerCase()))
      );

      if (aMatchesType && !bMatchesType) return -1;
      if (!aMatchesType && bMatchesType) return 1;

      // Otherwise, use match score
      return b.matchScore - a.matchScore;
    });

    // Select top partners
    const selected = prioritized.slice(0, this.config.maxPartners);

    logger.info(`Selected ${selected.length} partners before workload filtering`);
    logger.info(`Selected partners: [${selected.map(p => p.agentName).join(', ')}]`);

    // Filter out heavy workload
    const available = selected.filter(
      c => {
        const isHeavy = c.workload === 'heavy';
        const isOverThreshold = c.currentCollaborations >= this.config.workloadThreshold;
        const shouldFilter = isHeavy || isOverThreshold;

        if (shouldFilter) {
          logger.warn(`FILTERING OUT: ${c.agentName}`);
          logger.warn(`Reason: workload=${c.workload}, currentCollaborations=${c.currentCollaborations} (threshold=${this.config.workloadThreshold})`);
        }
        return !shouldFilter;
      }
    );

    // Log summary
    const filtered = selected.length - available.length;
    if (filtered > 0) {
      logger.warn(`WORKLOAD FILTERING: ${filtered} partners filtered out`);
    }

    logger.info(`FINAL SELECTION: ${available.length} partners available`);
    for (const p of available) {
      logger.info(`- ${p.agentName} (workload: ${p.workload}, score: ${p.matchScore.toFixed(2)})`);
    }

    return available.slice(0, Math.max(this.config.minPartners, available.length));
  }

  /**
   * Create collaboration proposal
   */
  private createProposal(
    assessment: ACNecessityAssessment,
    partners: PartnerCandidate[]
  ): CollaborationProposal {
    const now = new Date();

    return {
      id: uuidv4(),
      initiatorId: assessment.agentContext.agentId,
      initiatorName: assessment.agentContext.agentName,

      collaborationGoal: this.extractGoal(assessment),
      detailedDescription: assessment.clusterSummary.summary,

      triggerSummary: assessment.clusterSummary.summary,
      reasoning: assessment.llmAssessment.reasoning,
      benefits: this.generateBenefits(assessment, partners),

      requiredCapabilities: assessment.llmAssessment.requiredCapabilities,
      targetPartnerIds: partners.map(p => p.agentId),
      targetPartnerProfiles: partners.map(p => p.agentName),

      proposedDuration: assessment.llmAssessment.estimatedDuration || this.config.defaultDuration,
      proposedConstraints: {
        maxDuration: this.config.defaultDuration * 2,
        requiresAcknowledgment: assessment.llmAssessment.urgency === 'urgent',
      },

      priority: assessment.llmAssessment.urgency,
      expiresAt: new Date(now.getTime() + this.config.proposalTimeout),
      createdAt: now,

      status: 'pending',
      responses: [],
    };
  }

  /**
   * Extract collaboration goal from assessment
   */
  private extractGoal(assessment: ACNecessityAssessment): string {
    const summary = assessment.clusterSummary.summary;
    const findings = assessment.clusterSummary.findings;

    // Generate goal based on findings
    const mainFinding = findings[0];
    if (mainFinding) {
      if (mainFinding.anomaly) {
        return `Address detected anomaly: ${mainFinding.eventType}`;
      }
      if (mainFinding.trend === 'increasing') {
        return `Manage increasing trend in ${mainFinding.eventType}`;
      }
    }

    return 'Respond to detected events';
  }

  /**
   * Generate benefits list
   */
  private generateBenefits(
    assessment: ACNecessityAssessment,
    partners: PartnerCandidate[]
  ): string[] {
    const benefits: string[] = [];

    // Capability-based benefits
    const capabilities = new Set<string>();
    for (const partner of partners) {
      for (const cap of partner.capabilities) {
        capabilities.add(cap);
      }
    }

    benefits.push(`Combined capabilities: ${Array.from(capabilities).slice(0, 3).join(', ')}`);

    // Urgency-based benefits
    if (assessment.llmAssessment.urgency === 'urgent') {
      benefits.push('Rapid response to urgent situation');
    }

    // Risk mitigation
    if (assessment.llmAssessment.potentialRisks.length > 0) {
      benefits.push('Risk mitigation through coordinated response');
    }

    return benefits;
  }

  /**
   * Create empty proposal when no partners found
   */
  private createEmptyProposal(assessment: ACNecessityAssessment): CollaborationProposal {
    const now = new Date();

    return {
      id: uuidv4(),
      initiatorId: assessment.agentContext.agentId,
      initiatorName: assessment.agentContext.agentName,
      collaborationGoal: 'No partners available',
      detailedDescription: assessment.clusterSummary.summary,
      triggerSummary: assessment.clusterSummary.summary,
      reasoning: 'No suitable partners found for collaboration',
      benefits: [],
      requiredCapabilities: assessment.llmAssessment.requiredCapabilities,
      targetPartnerIds: [],
      targetPartnerProfiles: [],
      proposedDuration: 0,
      proposedConstraints: {},
      priority: assessment.llmAssessment.urgency,
      expiresAt: now,
      createdAt: now,
      status: 'rejected',
      responses: [],
    };
  }

  /**
   * Calculate confidence in selection
   */
  private calculateConfidence(
    partners: PartnerCandidate[],
    assessment: ACNecessityAssessment
  ): number {
    if (partners.length === 0) return 0;

    // Average match score
    const avgScore = partners.reduce((sum, p) => sum + p.matchScore, 0) / partners.length;

    // Number of partners factor
    const countFactor = Math.min(1, partners.length / this.config.minPartners);

    // LLM confidence factor
    const llmFactor = assessment.llmAssessment.confidence;

    return avgScore * 0.4 + countFactor * 0.3 + llmFactor * 0.3;
  }

  /**
   * Generate reasoning for selection
   */
  private generateSelectionReasoning(
    partners: PartnerCandidate[],
    assessment: ACNecessityAssessment
  ): string {
    const reasons: string[] = [];

    reasons.push(`Selected ${partners.length} partner(s) for collaboration`);

    // Capability coverage
    const allCapabilities = new Set<string>();
    for (const partner of partners) {
      for (const cap of partner.capabilities) {
        allCapabilities.add(cap);
      }
    }
    reasons.push(`Combined capabilities: ${Array.from(allCapabilities).slice(0, 5).join(', ')}`);

    // Workload status
    const workloads = partners.map(p => p.workload);
    reasons.push(`Partner availability: ${workloads.join(', ')}`);

    // Reliability
    const avgReliability = partners.reduce((sum, p) => sum + p.reliability, 0) / partners.length;
    reasons.push(`Average reliability: ${(avgReliability * 100).toFixed(0)}%`);

    return reasons.join('. ');
  }

  /**
   * Extract a SpatialPosition from a DeviceLocation.
   * Returns null if the location is a plain string or lacks position data.
   */
  private extractPosition(location: unknown): SpatialPosition | null {
    if (!location) return null;
    if (typeof location === 'string') return null;
    const loc = location as Record<string, unknown>;
    const pos = loc.position as Record<string, unknown> | undefined;
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return null;
    return { x: pos.x, y: pos.y, z: (typeof pos.z === 'number' ? pos.z : 0) };
  }

  /**
   * Calculate proximity score between two positions.
   * Returns a value between 0 (far apart) and 1 (same location).
   * Returns 0.5 (neutral) if either position is unavailable.
   */
  private calculateProximityScore(posA: SpatialPosition | null, posB: SpatialPosition | null): number {
    if (!posA || !posB) return 0.5;
    const distance = spatialDistance(posA, posB);
    return Math.max(0, 1 - distance / this.config.maxProximityDistance);
  }

  /**
   * Extract position from a CognitiveAgent's first resource with location data.
   */
  private extractPositionFromAgent(agent: any): SpatialPosition | null {
    // Try to get position from resourceManager
    const resourceManager = agent.resourceManager as { getAllResources?: () => Array<{ getLocation?: () => unknown }> } | undefined;
    if (resourceManager?.getAllResources) {
      const resources = resourceManager.getAllResources();
      for (const resource of resources) {
        if (resource.getLocation) {
          const location = resource.getLocation();
          const pos = this.extractPosition(location);
          if (pos) return pos;
        }
      }
    }
    return null;
  }

  /**
   * Extract the initiator's spatial position from the assessment context.
   */
  private extractInitiatorPosition(assessment: ACNecessityAssessment): SpatialPosition | null {
    const resources = assessment.agentContext.availableResources;
    if (!resources || resources.length === 0) return null;
    for (const resource of resources) {
      if (resource.location) {
        const pos = this.extractPosition(resource.location);
        if (pos) return pos;
      }
    }
    return null;
  }

  /**
   * Estimate workload of an agent
   */
  private estimateWorkload(agent: any): 'idle' | 'light' | 'moderate' | 'heavy' {
    // This would normally check agent's current state
    const collabs = this.getCurrentCollaborations(agent);
    if (collabs === 0) return 'idle';
    if (collabs <= 1) return 'light';
    if (collabs <= 2) return 'moderate';
    return 'heavy';
  }

  /**
   * Get current number of collaborations for an agent
   */
  private getCurrentCollaborations(agent: any): number {
    // This would normally query CollaborationManager
    return (agent as unknown as { currentCollaborations?: number }).currentCollaborations || 0;
  }

  /**
   * Record collaboration result for future reliability scoring
   */
  recordCollaborationResult(agentId: string, success: boolean): void {
    const history = this.collaborationHistory.get(agentId) || {
      successCount: 0,
      failureCount: 0,
      lastCollaboration: new Date(),
    };

    if (success) {
      history.successCount++;
    } else {
      history.failureCount++;
    }
    history.lastCollaboration = new Date();

    this.collaborationHistory.set(agentId, history);
  }

  /**
   * Get statistics
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }
}

export default PartnerSelectionNegotiator;
