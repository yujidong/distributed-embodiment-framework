/**
 * Partner Selection Negotiator - Layer 2 Cognitive Decision
 *
 * Finds best collaboration partners based on:
 * 1. Required capabilities from assessment
 * 2. Agent availability and workload
 * 3. Historical collaboration success — when a ReputationTracker is
 *    attached (P4-1), the LEARNED per-capability reputation score replaces
 *    the static local-history ratio (see computeReliability)
 * 4. Spatial proximity (agents in same environment)
 * 5. Geo corridor (R45-P1) — same-zone > adjacent-zone > far-zone ranking
 *    over the zone graph when capability faces tie (cross-district dispatch)
 *
 * Generates collaboration proposals for selected partners.
 */

import { v4 as uuidv4 } from 'uuid';
import type { ACNecessityAssessment } from './ACNecessityAssessor.js';
import type { CognitiveAgent } from '../agent/CognitiveAgent.js';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import { hasMatchingCapability } from '../environment/types.js';
import { capabilityMatches } from '../utils/capabilityMatching.js';
import { CapabilityRelaxer } from './CapabilityRelaxer.js';
import type { ReputationTracker } from '../reputation/index.js';
import type { ServiceBroker } from '../service/ServiceBroker.js';
import type { ServiceOffer } from '../service/ServiceRequest.js';
import type { ProposalServiceTerm } from '../types/proposal-handler.js';

import { createLogger, spatialDistance, type SpatialPosition } from '@active-collaboration/shared';
/**
 * Read the scope-of-practice blocklist (`cannotDeliverClasses`) from a
 * discovered agent record. EngineRuntime stores this in
 * `agent.metadata.cannotDeliverClasses` when constructing CognitiveAgent
 * (Workstream A3). Falls back to a top-level field for non-Cognitive
 * test doubles.
 */
function readCannotDeliverClasses(agent: unknown): string[] {
  if (!agent || typeof agent !== 'object') return [];
  const a = agent as Record<string, unknown>;
  // Preferred: nested in metadata (CognitiveAgent pattern).
  const meta = a.metadata as Record<string, unknown> | undefined;
  const metaClasses = meta?.cannotDeliverClasses;
  if (Array.isArray(metaClasses) && metaClasses.every(c => typeof c === 'string')) {
    return metaClasses as string[];
  }
  // Fallback: top-level field (test doubles).
  const topClasses = a.cannotDeliverClasses;
  if (Array.isArray(topClasses) && topClasses.every(c => typeof c === 'string')) {
    return topClasses as string[];
  }
  return [];
}

/**
 * Read the master enable switch from a discovered agent record. EngineRuntime
 * stores it in `agent.metadata.enabled` (default true) and toggles it via
 * setAgentEnabled; a disabled agent is not eligible as a partner. Missing
 * metadata means enabled (legacy/test-double agents are unaffected).
 */
function isAgentDisabled(agent: unknown): boolean {
  if (!agent || typeof agent !== 'object') return false;
  const a = agent as Record<string, unknown>;
  const meta = a.metadata as Record<string, unknown> | undefined;
  if (meta?.enabled === false) return true;
  // Fallback: top-level field (test doubles).
  return a.enabled === false;
}

/**
 * R45-P1: the discovered agent's managed zones (`managesZoneIds` ∪ bound
 * devices' zones — resolved by EngineRuntime.resolveAgentZoneIds at build
 * time). Same two-shape read as readCannotDeliverClasses: nested in
 * `agent.metadata` (CognitiveAgent pattern, set by EngineRuntime.buildAgent)
 * with a top-level fallback for non-Cognitive test doubles. Empty when the
 * record carries no zone face (geoAffinity then stays 0 — bonus-only).
 */
function readManagedZoneIds(agent: unknown): string[] {
  if (!agent || typeof agent !== 'object') return [];
  const a = agent as Record<string, unknown>;
  const meta = a.metadata as Record<string, unknown> | undefined;
  const metaZones = meta?.managedZoneIds;
  if (Array.isArray(metaZones) && metaZones.every(z => typeof z === 'string')) {
    return metaZones as string[];
  }
  const topZones = a.managedZoneIds;
  if (Array.isArray(topZones) && topZones.every(z => typeof z === 'string')) {
    return topZones as string[];
  }
  return [];
}

// ============================================================================
// R42-A/F3 §7.3: word-root near neighbors (service semanticType ↔ capability)
// ============================================================================

/**
 * Word roots of a capability/semanticType name: lowercase tokens split on
 * `-`/`_`/whitespace, noise tokens shorter than 3 chars dropped. Mirrors the
 * normalization idea of simulation's capabilityDisplayName (strip -/_
 * separators, compare lowercased) WITHOUT introducing a domain dictionary —
 * 'temperature-control' → ['temperature','control'].
 */
function wordRoots(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter(token => token.length >= 3);
}

/**
 * Whether a required capability and a service semanticType are word-root
 * NEAR NEIGHBORS: (a) the shared semantic matcher already equates them
 * (CAPABILITY_SYNONYMS equivalence groups, bidirectional substring), or
 * (b) their leading (domain) roots match with bidirectional substring
 * containment — the domain word leads in both vocabularies
 * ('temperature-control', 'air-quality-monitoring', 'co2-monitoring'), so
 * generic tails ('control', 'monitoring') alone never create false kinship
 * ('temperature-control' vs 'lighting-control' do NOT match).
 * Substring containment keeps morphology honest: 'humid' ⊂ 'humidity',
 * 'temp' ⊂ 'temperature'.
 */
function isServiceSemanticNear(requiredCapability: string, semanticType: string): boolean {
  if (capabilityMatches(requiredCapability, semanticType)) return true;
  const reqRoots = wordRoots(requiredCapability);
  const semRoots = wordRoots(semanticType);
  if (reqRoots.length === 0 || semRoots.length === 0) return false;
  const headReq = reqRoots[0];
  const headSem = semRoots[0];
  return (
    semRoots.includes(headReq) ||
    reqRoots.includes(headSem) ||
    headSem.includes(headReq) ||
    headReq.includes(headSem)
  );
}

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
  /**
   * R42-A/F3 §7.2: the services this candidate EXPOSES that are relevant
   * here (structured terms). Populated from the service registry (derived
   * rows) or a matched service offer at discovery time; rides the proposal
   * so the responder sees "Services Requested: name[semanticType]". Absent
   * for candidates with no service evidence (pure capability broadcast).
   */
  services?: ProposalServiceTerm[];
  /**
   * R42-A/F3 §7.3: serviceAffinity of this candidate for the triggering
   * event (0-1, fraction of requiredCapabilities with a word-root near
   * neighbor among the candidate's service semanticTypes). BONUS-ONLY in
   * matchScore: no service evidence ⇒ 0 ⇒ no penalty (宽容).
   */
  serviceAffinity?: number;
  /**
   * R45-P1: geoAffinity of this candidate for the triggering event's zone
   * (1.0 same zone / 0.8 adjacent-corridor / 0.3 far / 0 unknown — see
   * calculateGeoAffinity). BONUS-ONLY in matchScore like serviceAffinity:
   * a candidate without a zone face keeps the legacy score (宽容).
   */
  geoAffinity?: number;
  /**
   * R45-P1: the candidate's managed zones (managesZoneIds ∪ bound-device
   * zones), read from `agent.metadata.managedZoneIds` at discovery. Drives
   * the geo-corridor ranking: same-zone > adjacent-zone > far-zone when the
   * capability face ties (the R45 cross-district dispatch finding — 6
   * capability-identical substation keepers all accepted because the
   * proximity term was neutral in a bounds-less city world).
   */
  managedZoneIds?: string[];
  /**
   * Capability classes this candidate is NOT authorized to deliver
   * (scope-of-practice filter, Workstream A3). Populated from
   * `agent.metadata.cannotDeliverClasses` during candidate discovery.
   * The negotiator never selects a candidate whose cannotDeliverClasses
   * intersects the event's requiredCapabilities.
   */
  cannotDeliverClasses?: string[];
  /**
   * Phase 2: Service ID when this candidate was discovered via the service
   * registry (Scenario A — targeted service invocation). When present,
   * the proposal carries this serviceId so the recipient knows a published
   * service is being invoked, not a generic capability broadcast.
   */
  serviceId?: string;
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

  /**
   * Wave 7 G1 / G5: PIPL consent token. When the triggering event
   * carries `consentRequirements.consentClass = 'sensitive'`, the
   * initiator MUST attach a proof-of-consent token here before sending
   * the proposal. Recipients SHOULD reject proposals that lack a
   * required token. Engine enforcement is deferred (Wave 7 is schema-
   * only); today this is documentation + UI badge.
   */
  consentToken?: string;
  /**
   * Wave 7 G4: liability class inherited from the triggering event.
   * `must-respond` events (e.g. 120 dispatch for a code stroke) cannot
   * be legally declined; recipients SHOULD auto-accept. Engine
   * enforcement is deferred; UI surfaces as a colored badge today.
   */
  liabilityClass?: 'must-respond' | 'best-effort' | 'advisory';

  /**
   * Phase 3: How this proposal was formed. Drives handler-side
   * evaluation thresholds and UI badges.
   * - `service-invocation`: initiator found a published service and is
   *   invoking it directly (Scenario A). Accept threshold lowered.
   * - `capability-broadcast`: no service matched; broadcasting by raw
   *   capability (Scenario B). Standard threshold.
   * - `service-adaptation`: no service + no direct capability match, but
   *   the responder may have device resources to create one (Scenario C).
   */
  proposalType?: 'service-invocation' | 'capability-broadcast' | 'service-adaptation';

  /**
   * Phase 2: Service IDs + offers for partners discovered via the service
   * registry. When present, the CollaborationCoordinator can create formal
   * ServiceContracts (Phase 4).
   */
  serviceOffers?: Array<{ partnerId: string; serviceId: string }>;

  /**
   * R42-A/F3 §7.2: the service terms this proposal requests — union of the
   * selected partners' exposed services ({name, semanticType, terms?}).
   * The coordinator emits the per-partner subset on each ac-proposal so the
   * responder can match it against its own catalog (semanticType).
   */
  services?: ProposalServiceTerm[];

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
/** One scope-of-practice exclusion (T-036): who was blocked and by which class. */
export interface ScopeExclusion {
  agentId: string;
  /** The capability class(es) that intersected the event's requirements. */
  blockedBy: string[];
}

/** One scope-of-practice exclusion (T-036): who was blocked and by which class. */
export interface ScopeExclusion {
  agentId: string;
  /** The capability class(es) that intersected the event's requirements. */
  blockedBy: string[];
}

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
  /**
   * T-036 (DevLoop R17): candidates that HAD matching capabilities but were
   * excluded by the scope-of-practice filter (cannotDeliverClasses ∩ the
   * event's requiredCapabilities). Surfaced so AC records/consumers see the
   * honest exclusion reason instead of "no agents with capabilities".
   */
  scopeExclusions?: ScopeExclusion[];
  /** Whether this is a fallback to single-agent mode */
  isFallback?: boolean;
  /**
   * Phase 7: All ranked candidates (superset of selectedPartners), sorted
   * by matchScore descending. Used by CollaborationCoordinator for
   * fallback iteration when the primary candidates reject or timeout.
   */
  allRankedCandidates?: PartnerCandidate[];
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

  /**
   * When true (default) and a ReputationTracker is attached, the static
   * reliability term is replaced by the tracker's learned score for
   * (candidate, requestedCapability). When false, reliability falls back to
   * the legacy local collaboration-history ratio (ablation switch, P4-1).
   */
  reputationEnabled: boolean;

  /**
   * R42-A/F3 §7.3 / R45-P1: weight of the AFFINITY BONUS in matchScore —
   * the combined evidence term added on top of the weighted base (never
   * subtracted). The bonus splits 0.7 serviceAffinity / 0.3 geoAffinity
   * (capability evidence stays primary; geography is the corridor
   * tie-breaker — 同区 > 相邻区 > 远区 among capability-equal candidates).
   * Candidates without service/zone evidence keep their legacy score
   * (宽容 — no penalty).
   */
  serviceAffinityWeight: number;

  /**
   * R44-dense-F2: cap for the adaptive broadcast fan-out. When the ranked
   * candidate pool is much larger than `maxPartners` (dense worlds: ~30
   * capability-identical stewards per zone × 6 zones), the primary proposal
   * broadcast widens from `maxPartners` toward this cap so the handshake
   * gets enough shots at the per-response accept rate. Default
   * DEFAULT_MAX_BROADCAST_PARTNERS (15); `undefined` keeps the default.
   */
  maxBroadcastPartners?: number;

  // Proposal settings
  proposalTimeout: number; // milliseconds
  defaultDuration: number; // milliseconds
}

/**
 * R44-dense-F2: default cap for the adaptive broadcast fan-out (see
 * PartnerSelectionNegotiator.effectiveFanout). 15 partners × the observed
 * dense-tier per-response accept rate (~11% LLM / ~100% capability rule)
 * gives P(≥1 accept) well above 90% per handshake, where the legacy fixed 5
 * left it at a coin flip.
 */
export const DEFAULT_MAX_BROADCAST_PARTNERS = 15;

const DEFAULT_CONFIG: NegotiatorConfig = {
  maxPartners: 5,
  minPartners: 1,
  workloadThreshold: 3,

  // Fix-49 (decision A — strong spatial term): spatial relevance now weighs
  // as much as capability. Pre-fix (0.4/0.15) a capability match anywhere in
  // the world always outranked distance, so cross-building partners won every
  // time (campus: a dorm HVAC "partner" for a classroom event).
  capabilityWeight: 0.35,
  workloadWeight: 0.15,
  reliabilityWeight: 0.15,
  proximityWeight: 0.35,
  maxProximityDistance: 150, // proximity SCALE (meters) — see calculateProximityScore
  reputationEnabled: true,
  serviceAffinityWeight: 0.1,

  proposalTimeout: 30000, // 30 seconds
  defaultDuration: 120000, // 2 minutes
};

/**
 * R45-P1: the split of the affinity bonus between its two evidence axes —
 * capability service evidence stays primary (0.7), the geo corridor is the
 * tie-breaker (0.3). 能力仍为主，地理做 tie-breaker。
 */
export const GEO_SERVICE_SPLIT = { service: 0.7, geo: 0.3 } as const;

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

  /**
   * Learned reputation source (P4-1). Attached by the EngineRuntime (shared
   * across all agents' negotiators so every agent selects partners from the
   * same outcome history). When set and `config.reputationEnabled` is true,
   * it replaces the legacy local collaboration-history reliability term.
   */
  private reputationTracker: ReputationTracker | null = null;

  /**
   * Phase 2: Optional ServiceBroker for service-first discovery. When set,
   * findCandidatePartners() queries published services before falling back
   * to capability broadcast. Set by DualTriggerACManager (which receives it
   * from CognitiveAgent).
   */
  private serviceBroker: ServiceBroker | null = null;

  /**
   * R45-P1: zone → declared-adjacency set (the scenario's corridor graph,
   * auto-symmetrized at load). Injected by the EngineRuntime after agent
   * construction (same wiring pattern as setReputationTracker). Absent →
   * geoAffinity still ranks same-zone above everything (adjacency lookup
   * degrades to empty); candidates without a zone face stay at 0.
   */
  private zoneAdjacency: Map<string, ReadonlySet<string>> = new Map();

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
   * Attach (or detach, with null) the shared ReputationTracker used for the
   * reliability term. Scores are read per (candidate, requestedCapability)
   * at selection time; the tracker's prior covers agents with no history.
   */
  setReputationTracker(tracker: ReputationTracker | null): void {
    this.reputationTracker = tracker;
  }

  /**
   * Phase 2: Inject the ServiceBroker for service-first discovery. When set,
   * the negotiator queries published services before falling back to the
   * raw `discoverAgents({capabilities})` broadcast path.
   */
  setServiceBroker(broker: ServiceBroker | null): void {
    this.serviceBroker = broker;
    logger.info('ServiceBroker set for service-first discovery');
  }

  /**
   * R45-P1: inject the world's zone topology for the geo-corridor ranking
   * (zone id → its declared adjacentZoneIds). Pure data, safe to re-set.
   */
  setZoneTopology(
    zones: ReadonlyArray<{ id: string; adjacentZoneIds?: readonly string[] }>,
  ): void {
    this.zoneAdjacency = new Map(
      zones.map(z => [z.id, new Set(z.adjacentZoneIds ?? [])]),
    );
    logger.info(`Zone topology set for geo-corridor ranking (${zones.length} zones)`);
  }

  /**
   * Find partners and create proposal based on assessment
   */
  /**
   * findPartners + the Phase-7 capability-relaxation retry (extracted from
   * DualTriggerACManager.initiateAC, R6-E-F07: the manager now routes
   * consume_service's locked-target lane AROUND the open negotiation; the
   * relaxation semantics — CAPABILITY_SYNONYMS widening + one retry — are
   * unchanged, they just live where the negotiation lives).
   */
  async findPartnersWithRelaxation(assessment: ACNecessityAssessment): Promise<PartnerSelectionResult> {
    let partnerSelection = await this.findPartners(assessment);
    // Phase 7: Fallback — if no partners found, try capability relaxation.
    // Widen requiredCapabilities using CAPABILITY_SYNONYMS groups and retry.
    if (partnerSelection.selectedPartners.length === 0) {
      const relaxer = new CapabilityRelaxer();
      const originalCaps = assessment.llmAssessment.requiredCapabilities;
      const relaxedCaps = relaxer.relax(originalCaps);
      if (relaxedCaps.length > originalCaps.length) {
        logger.info(`[PartnerSelectionNegotiator] Phase 7 fallback: relaxing capabilities ${originalCaps.length}→${relaxedCaps.length}, retrying partner search`);
        const relaxedAssessment = {
          ...assessment,
          llmAssessment: {
            ...assessment.llmAssessment,
            requiredCapabilities: relaxedCaps,
          },
        };
        partnerSelection = await this.findPartners(relaxedAssessment);
      }
    }
    return partnerSelection;
  }

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

    // Fix-49: anchor proximity on the EVENT's position (where help is
    // needed), not the initiator's own devices — an initiator with devices
    // elsewhere would otherwise mis-rank every candidate. Falls back to the
    // initiator position when the cluster carries no geometry.
    const initiatorPosition = this.extractEventPosition(assessment)
      ?? this.extractInitiatorPosition(assessment);

    // R45-P1: the event's zone id — the geo-corridor anchor. Null when the
    // cluster carries no zone (geoAffinity then stays 0 for everyone).
    const eventZone = this.extractEventZone(assessment);

    const { candidates, scopeExclusions } = await this.findCandidatePartners(
      requiredCapabilities,
      assessment.agentContext.agentId,
      initiatorPosition
    );

    logger.info(`Discovered ${candidates.length} candidate(s)`);

    if (candidates.length === 0) {
      // T-036: when capability-matching candidates existed but the
      // scope-of-practice filter removed them all, the honest reason is the
      // EXCLUSION — "0 agents with capabilities" would be false and would
      // send operators hunting for a capability-registration bug.
      const scopeDetail = scopeExclusions.length > 0
        ? ` ${scopeExclusions.length} agent(s) HAD matching capabilities but were excluded by scope-of-practice: ` +
          scopeExclusions
            .map(ex => `${ex.agentId} (cannotDeliverClasses: ${ex.blockedBy.join(', ')})`)
            .join('; ') + '.'
        : '';
      const failure: PartnerSelectionFailureReason = {
        step: 'partner-discovery',
        reason: scopeExclusions.length > 0
          ? 'All capability-matching candidates were excluded by scope-of-practice'
          : 'No candidates found',
        details: `EnvironmentCenter.discoverAgents returned 0 eligible agents with capabilities: [${requiredCapabilities.join(', ')}]. ` +
                 `Total agents in environment: ${this.environmentCenter?.listAgents?.().length || 'unknown'}.` +
                 scopeDetail,
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
        reasoning: scopeExclusions.length > 0
          ? 'All capability-matching candidates were excluded by scope-of-practice (cannotDeliverClasses)'
          : 'No suitable partners found with required capabilities',
        failureReasons,
        ...(scopeExclusions.length > 0 ? { scopeExclusions } : {}),
        isFallback: true,
      };
    }

    // Score and rank candidates
    const scoredCandidates = this.scoreCandidates(candidates, requiredCapabilities, eventZone);

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
      // Phase 7: expose the full ranked list for fallback iteration.
      // scoredCandidates is already sorted by matchScore descending.
      allRankedCandidates: scoredCandidates,
      // T-036: who was blocked and why, even when other partners were found.
      ...(scopeExclusions.length > 0 ? { scopeExclusions } : {}),
    };
  }

  /**
   * Find candidate partners from environment
   */
  private async findCandidatePartners(
    requiredCapabilities: string[],
    excludeAgentId: string,
    initiatorPosition: SpatialPosition | null
  ): Promise<{ candidates: PartnerCandidate[]; scopeExclusions: ScopeExclusion[] }> {
    const candidates: PartnerCandidate[] = [];
    const scopeExclusions: ScopeExclusion[] = [];

    if (!this.environmentCenter) {
      logger.warn('No environment center, cannot find partners');
      return { candidates, scopeExclusions };
    }

    // ==================================================================
    // Phase 2: Service-first discovery (Scenario A — targeted service
    // invocation). Query the ServiceBroker's published-service registry
    // BEFORE falling back to raw capability broadcast (Scenario B).
    //
    // When services are found, we build PartnerCandidates directly from
    // ServiceOffer metadata (QoS, provider, capabilities) — this is the
    // "devices are private, services are public" path.
    // ==================================================================
    if (this.serviceBroker && requiredCapabilities.length > 0) {
      try {
        const discovery = await this.serviceBroker.discoverServices({
          serviceType: 'all',
          requiredCapabilities,
        });
        if (discovery.offers.length > 0) {
          logger.info(`[PartnerSelectionNegotiator] Service-first discovery found ${discovery.offers.length} offers`);
          for (const offer of discovery.offers) {
            // Skip the initiator (self-exclusion).
            if (offer.providerId === excludeAgentId) continue;

            // Scope-of-practice filter still applies.
            const agentRecord = this.environmentCenter.listAgents().find(
              (a: { id: string }) => a.id === offer.providerId,
            );
            // Master enable switch: disabled agents are not partner-eligible.
            if (agentRecord && isAgentDisabled(agentRecord)) {
              logger.info(`Service offer from ${offer.providerId} skipped: agent disabled`);
              continue;
            }
            const cannotDeliver = agentRecord ? readCannotDeliverClasses(agentRecord) : [];
            if (cannotDeliver.length > 0) {
              const blockedBy = requiredCapabilities.filter(req =>
                cannotDeliver.some(c => capabilityMatches(c, req)),
              );
              if (blockedBy.length > 0) {
                logger.info(`Service offer from ${offer.providerId} blocked by scope-of-practice (cannotDeliverClasses: ${blockedBy.join(', ')})`);
                scopeExclusions.push({ agentId: offer.providerId, blockedBy });
                continue;
              }
            }

            // Build a PartnerCandidate enriched with QoS from the offer.
            // Fix-49: resolve the PROVIDER's real position instead of a
            // hardcoded neutral 0.5 — the service-offer path used to discard
            // spatial information entirely, so an unbacked/remote provider
            // ranked as "neutral-distance" against every event. Slight
            // below-neutral fallback (0.45) when truly unresolvable.
            let proximity = 0.45;
            try {
              const provider = await this.environmentCenter?.getAgent(offer.providerId);
              const providerPos = provider
                ? this.extractPositionFromAgent(provider as never)
                : null;
              proximity = providerPos !== null
                ? this.calculateProximityScore(initiatorPosition, providerPos)
                : 0.45;
            } catch {
              proximity = 0.45;
            }
            candidates.push({
              agentId: offer.providerId,
              agentName: offer.providerName,
              capabilities: offer.capabilities || requiredCapabilities,
              // R42-A/F3 §7.2: the matched offer rides the candidate as a
              // structured service term — the proposal tells the responder
              // exactly which productized service is being invoked.
              services: [{
                name: offer.serviceName,
                semanticType: offer.serviceType,
              }],
              serviceId: offer.serviceId,
              // R45-P1: the provider's zone face for geo-corridor ranking.
              ...(agentRecord && readManagedZoneIds(agentRecord).length > 0
                ? { managedZoneIds: readManagedZoneIds(agentRecord) }
                : {}),
              cannotDeliverClasses: cannotDeliver,
              workload: 'idle', // not known from the offer; QoS availability field is reliability
              currentCollaborations: 0,
              reliability: offer.availability ?? 0.7,
              proximity,
              matchScore: 0,
            });
          }
          if (candidates.length > 0) {
            logger.info(`[PartnerSelectionNegotiator] ${candidates.length} service-based candidates (Scenario A)`);
            return { candidates, scopeExclusions };
          }
        }
      } catch (err) {
        logger.warn(`Service-first discovery failed, falling back to broadcast: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ==================================================================
    // Fallback: capability broadcast (Scenario B). Query agents directly
    // by matching their `capabilities` array against requiredCapabilities.
    // ==================================================================
    const agents = this.environmentCenter.discoverAgents({
      capabilities: requiredCapabilities.length > 0 ? requiredCapabilities : undefined,
      excludeIds: [excludeAgentId],
    });

    // R42-A/F3 §7.2/§7.3: the environment's REGISTERED services grouped by
    // provider — broadcast candidates carry their own service face (derived
    // rows), so proposals can name the services being requested and scoring
    // can see service evidence. One registry read; faults degrade to empty.
    const servicesByProvider = this.servicesByProvider();

    for (const agent of agents) {
      // Skip self (additional check, though excludeIds should handle it)
      if (agent.id === excludeAgentId) continue;

      // Master enable switch: disabled agents are not partner-eligible.
      if (isAgentDisabled(agent)) {
        logger.info(`Candidate ${agent.id} filtered out: agent disabled`);
        continue;
      }

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

      // Scope-of-practice filter (Workstream A3): read cannotDeliverClasses
      // from agent.metadata (set by EngineRuntime from scenario definition).
      // If any of the event's required capabilities falls into the agent's
      // cannotDeliverClasses, the agent is ineligible as a partner.
      const cannotDeliverClasses = readCannotDeliverClasses(agent);
      if (cannotDeliverClasses.length > 0 && requiredCapabilities.length > 0) {
        const blockedBy = requiredCapabilities.filter(req =>
          cannotDeliverClasses.some(c => capabilityMatches(c, req)),
        );
        if (blockedBy.length > 0) {
          logger.info(
            `Candidate ${agent.id} filtered out by scope-of-practice (cannotDeliverClasses=${cannotDeliverClasses.join(',')}, required=${requiredCapabilities.join(',')})`,
          );
          // T-036: record WHO was blocked and by which class so selection
          // results/failure reasons state the real cause.
          scopeExclusions.push({ agentId: agent.id, blockedBy });
          continue;
        }
      }

      // Build candidate info
      // Get candidate's position from its resources
      const candidatePos = this.extractPositionFromAgent(agent);
      const proximity = this.calculateProximityScore(initiatorPosition, candidatePos);

      const candidate: PartnerCandidate = {
        agentId: agent.id,
        agentName: agent.name,
        capabilities: capabilityStrings,
        // R42-A/F3 §7.2: the candidate's registered service face (derived
        // rows) rides the candidate → the proposal names them, the responder
        // matches them against its own catalog.
        ...(servicesByProvider.has(agent.id)
          ? { services: servicesByProvider.get(agent.id) }
          : {}),
        // R45-P1: the candidate's zone face (managesZoneIds ∪ bound-device
        // zones) for the geo-corridor ranking.
        ...(readManagedZoneIds(agent).length > 0
          ? { managedZoneIds: readManagedZoneIds(agent) }
          : {}),
        cannotDeliverClasses,
        workload: this.estimateWorkload(agent),
        currentCollaborations: this.getCurrentCollaborations(agent),
        reliability: this.computeReliability(agent.id, requiredCapabilities),
        proximity,
        matchScore: 0, // Will be calculated later
      };

      candidates.push(candidate);
    }

    logger.info(`Found ${candidates.length} candidate partners`);
    return { candidates, scopeExclusions };
  }

  /**
   * R42-A/F3 §7.2/§7.3: the environment's REGISTERED services grouped by
   * provider agent (derived rows — the same registry the ServiceBroker's
   * discovery reads). Broadcast candidates carry this face so proposals can
   * name the requested services and candidate scoring can see service
   * evidence. Registry faults degrade to an empty map, never throw.
   */
  private servicesByProvider(): Map<string, ProposalServiceTerm[]> {
    const map = new Map<string, ProposalServiceTerm[]>();
    if (!this.environmentCenter) return map;
    try {
      for (const svc of this.environmentCenter.discoverServices({})) {
        // Provider id lives in TWO shapes: AgentService instances expose it
        // via getProviderInfo(); the ResourceCoordinator's auto-published
        // DEVICE services are plain Service objects carrying providerAgentId
        // as a field (the 156-row mesh — getProviderInfo alone misses them).
        const provider = (svc as { getProviderInfo?: () => { providerAgentId?: string } }).getProviderInfo?.();
        const providerAgentId = provider?.providerAgentId
          ?? (svc as { providerAgentId?: string }).providerAgentId;
        if (!providerAgentId) continue;
        const list = map.get(providerAgentId) ?? [];
        list.push({
          name: svc.name,
          semanticType: svc.category,
        });
        map.set(providerAgentId, list);
      }
    } catch (error) {
      logger.warn(
        `Service face read failed (non-fatal, candidates keep legacy scoring): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return map;
  }

  /**
   * R42-A/F3 §7.3: serviceAffinity of a candidate for the triggering event —
   * the fraction of requiredCapabilities that have a word-root near neighbor
   * among the candidate's service semanticTypes. No service evidence ⇒ 0
   * (bonus-only term: never a penalty, the capability match still decides).
   */
  private calculateServiceAffinity(
    candidate: PartnerCandidate,
    requiredCapabilities: string[]
  ): number {
    const semanticTypes = (candidate.services ?? [])
      .map(s => s.semanticType)
      .filter((st): st is string => typeof st === 'string' && st.length > 0);
    if (semanticTypes.length === 0 || requiredCapabilities.length === 0) return 0;
    const matched = requiredCapabilities.filter(req =>
      semanticTypes.some(st => isServiceSemanticNear(req, st))
    );
    return matched.length / requiredCapabilities.length;
  }

  /**
   * R45-P1: geoAffinity of a candidate for the EVENT's zone — the
   * administrative-corridor factor the proximity term cannot supply in
   * bounds-less city worlds (there every candidate scores the neutral 0.5,
   * so 6 capability-identical district stewards tied and all accepted —
   * R45 §2.4). Discrete ladder over the zone graph:
   *   1.0 candidate manages the event zone (属地 — the host);
   *   0.8 candidate manages a zone ADJACENT to the event zone (走廊 — the
   *       declared support corridor, e.g. Bao'an↔Nanshan substations);
   *   0.3 candidate's zones are elsewhere (远区 — possible, never first);
   *   0   no zone evidence / no event zone (bonus-only, 宽容: the legacy
   *       weighted score is kept untouched).
   */
  private calculateGeoAffinity(candidate: PartnerCandidate, eventZone: string | null): number {
    if (!eventZone) return 0;
    const zones = candidate.managedZoneIds ?? [];
    if (zones.length === 0) return 0;
    if (zones.includes(eventZone)) return 1.0;
    const neighbors = this.zoneAdjacency.get(eventZone);
    if (neighbors !== undefined && zones.some(z => neighbors.has(z))) return 0.8;
    return 0.3;
  }

  /**
   * Score candidates based on multiple factors.
   *
   * R45-P1: the affinity BONUS now combines service evidence (word-root
   * near neighbors, §7.3) with the geo corridor (same/adjacent/far zone)
   * at 0.7 : 0.3 — capability remains primary (the weighted base), geography
   * breaks ties between capability-equal candidates. Both factors are
   * bonus-only: absent evidence keeps the legacy score (宽容).
   */
  private scoreCandidates(
    candidates: PartnerCandidate[],
    requiredCapabilities: string[],
    eventZone: string | null = null
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

      // R42-A/F3 §7.3 × R45-P1: combined affinity BONUS on top of the
      // weighted base — serviceAffinity × 0.7 + geoAffinity × 0.3, scaled
      // by serviceAffinityWeight. Service evidence matching the event's
      // capabilities raises a candidate; the geo corridor breaks ties among
      // capability-equal candidates (同区 > 相邻区 > 远区). No evidence on
      // either axis leaves the legacy score untouched (宽容).
      const serviceAffinity = this.calculateServiceAffinity(candidate, requiredCapabilities);
      const geoAffinity = this.calculateGeoAffinity(candidate, eventZone);
      const matchScore = totalScore + this.config.serviceAffinityWeight *
        (GEO_SERVICE_SPLIT.service * serviceAffinity + GEO_SERVICE_SPLIT.geo * geoAffinity);

      return {
        ...candidate,
        serviceAffinity,
        geoAffinity,
        matchScore,
      };
    }).sort((a, b) => b.matchScore - a.matchScore);
  }

  /**
   * Calculate capability match score.
   *
   * Routes through the shared `capabilityMatches()` utility (bidirectional
   * substring + CAPABILITY_SYNONYMS equivalence table) instead of a
   * unidirectional substring test. This makes cardiology-agent.capabilities
   * = ['cath-lab-activation','pci-procedure'] correctly match an event
   * requiring 'coronary-intervention', and similar semantic equivalences.
   */
  private calculateCapabilityScore(
    candidate: PartnerCandidate,
    requiredCapabilities: string[]
  ): number {
    if (requiredCapabilities.length === 0) return 0.5;

    const matchedCapabilities = requiredCapabilities.filter(req =>
      candidate.capabilities.some(cap => capabilityMatches(cap, req))
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
   * Reliability term of the match score (P4-1): with a ReputationTracker
   * attached and `reputationEnabled`, the learned per-capability reputation
   * of the candidate — averaged over the capabilities this AC requests
   * (each falling back to the tracker's prior when the agent has no history
   * for it); the tracker-wide aggregate when the AC requests none. Without
   * a tracker (or with the flag off) the legacy behavior is kept: the local
   * collaboration-history success ratio, defaulting to 0.5 when empty.
   */
  private computeReliability(agentId: string, requiredCapabilities: string[]): number {
    if (this.reputationTracker && this.config.reputationEnabled) {
      if (requiredCapabilities.length === 0) {
        return this.reputationTracker.agentScore(agentId);
      }
      const total = requiredCapabilities.reduce(
        (sum, capability) => sum + this.reputationTracker!.score(agentId, capability),
        0,
      );
      return total / requiredCapabilities.length;
    }

    const history = this.collaborationHistory.get(agentId);
    return history
      ? history.successCount / (history.successCount + history.failureCount || 1)
      : 0.5;
  }

  /**
   * R44-dense-F2: adaptive broadcast fan-out.
   *
   * `maxPartners` (5) was calibrated when per-response accept rates were
   * 55-62% (campus / standard tiers). At dense scale (193 agents) the
   * measured per-response accept rate drops to ~11% on the LLM lane, so a
   * fixed 5-partner broadcast leaves P(≥1 accept) ≈ 40-45% per handshake —
   * the measured 10/12 dense handshake outcome. When the ranked pool is
   * much larger than the configured fan-out (capability-identical stewards
   * per zone × 6 zones), widen the primary broadcast toward
   * `maxBroadcastPartners` (default 15, bounded by 3× maxPartners).
   * Small worlds (pool ≤ 3× maxPartners) keep the legacy behavior exactly.
   */
  private effectiveFanout(poolSize: number): number {
    const base = this.config.maxPartners;
    if (poolSize <= base * 3) return base;
    const cap = this.config.maxBroadcastPartners ?? DEFAULT_MAX_BROADCAST_PARTNERS;
    return Math.min(cap, base * 3);
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

    // Select top partners — R44-dense-F2: the slice widens adaptively when
    // the ranked pool is much larger than the configured fan-out.
    const selected = prioritized.slice(0, this.effectiveFanout(prioritized.length));

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

    // Phase 3: Determine proposalType from how partners were discovered.
    const servicePartners = partners.filter(p => p.serviceId);
    const proposalType: CollaborationProposal['proposalType'] =
      servicePartners.length === partners.length && partners.length > 0
        ? 'service-invocation'
        : servicePartners.length > 0
          ? 'service-invocation' // mix but at least some via service
          : 'capability-broadcast';

    const serviceOffers = servicePartners.length > 0
      ? servicePartners.map(p => ({ partnerId: p.agentId, serviceId: p.serviceId! }))
      : undefined;

    // R42-A/F3 §7.2: union of the selected partners' service faces (deduped
    // by name) — the proposal's structured service terms. The coordinator
    // emits the per-partner subset on each ac-proposal message.
    const services = partners.length > 0
      ? [...new Map(partners.flatMap(p => p.services ?? []).map(s => [s.name, s])).values()]
      : undefined;

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

      // Phase 3: proposal type + service offers
      proposalType,
      serviceOffers,
      // R42-A/F3 §7.2: structured service terms
      ...(services !== undefined && services.length > 0 ? { services } : {}),

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
   * Fix-49: SCALE-FREE exponential decay (exp(-d/scale), scale =
   * max(50, maxProximityDistance)) — no hard radius cliff. The old
   * `1 - d/50` zeroed every candidate beyond 50m (apartment-scale default),
   * so on campus/city worlds the spatial term silently vanished and
   * capability alone decided. exp keeps ordering at every scale:
   * same zone ≈1.0, tens of meters ≈0.7-0.9, cross-building ≈0.4-0.6.
   * Returns 0.5 (neutral) if either position is unavailable.
   */
  private calculateProximityScore(posA: SpatialPosition | null, posB: SpatialPosition | null): number {
    if (!posA || !posB) return 0.5;
    const distance = spatialDistance(posA, posB);
    if (!Number.isFinite(distance)) return 0.5; // partial coordinates — neutral
    const scale = Math.max(50, this.config.maxProximityDistance);
    return Math.exp(-distance / scale);
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
   * Fix-49: the triggering event's position from the assessment's cluster
   * region center — the spatial anchor partner proximity should be scored
   * against. Null when the cluster carries no usable geometry.
   */
  private extractEventPosition(assessment: ACNecessityAssessment): SpatialPosition | null {
    const center = assessment.clusterSummary?.region?.center as
      { x?: unknown; y?: unknown; z?: unknown } | undefined;
    if (center === undefined || typeof center.x !== 'number' || typeof center.y !== 'number') {
      return null;
    }
    return {
      x: center.x,
      y: center.y,
      z: typeof center.z === 'number' ? center.z : 0,
    } as SpatialPosition;
  }

  /**
   * R45-P1: the triggering event's zone id (the cluster region id) — the
   * geo-corridor anchor for candidate ranking. Null when the cluster
   * carries no region id.
   */
  private extractEventZone(assessment: ACNecessityAssessment): string | null {
    const zoneId = assessment.clusterSummary?.region?.id;
    return typeof zoneId === 'string' && zoneId.length > 0 ? zoneId : null;
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
