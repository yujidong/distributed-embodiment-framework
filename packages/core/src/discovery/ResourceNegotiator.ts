/**
 * Resource Negotiator
 *
 * Automated resource negotiation between agents.
 * Handles proposal creation, evaluation, and agreement lifecycle management.
 */

import { EventEmitter, EventType, EventPriority } from '../events/index.js';
import type { DialogueManager } from '../management/DialogueManager.js';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Negotiation priority levels
 */
const logger = createLogger('ResourceNegotiator');

export enum NegotiationPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  URGENT = 'urgent',
}

/**
 * Negotiation status
 */
export enum NegotiationStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  COUNTERED = 'countered',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

/**
 * Negotiation proposal
 */
export interface NegotiationProposal {
  id: string;
  proposedBy: string; // Agent ID
  proposedTo: string; // Agent ID
  resources: string[]; // Resource IDs requested
  duration: number; // Requested duration (ms)
  priority: NegotiationPriority;
  purpose: string;
  proposedAt: Date;
  expiresAt: Date;
  status: NegotiationStatus;
  metadata?: Record<string, any>;
}

/**
 * Negotiation terms (agreed-upon)
 */
export interface NegotiationTerms {
  id: string;
  proposalId: string;
  resources: string[];
  owner: string; // Agent ID who owns the resources
  borrower: string; // Agent ID borrowing the resources
  startTime: Date;
  endTime: Date;
  purpose: string;
  conditions?: string[];
  agreedAt: Date;
}

/**
 * Negotiation result
 */
export interface NegotiationResult {
  proposal: NegotiationProposal;
  terms?: NegotiationTerms;
  accepted: boolean;
  message: string;
  timestamp: Date;
}

/**
 * Negotiation configuration
 */
export interface NegotiationConfig {
  defaultResponseTimeout?: number; // How long to wait for response (ms)
  autoEvaluateProposals?: boolean; // Auto-evaluate incoming proposals
  enableCountering?: boolean; // Allow counter-proposals
  maxActiveAgreements?: number; // Maximum concurrent agreements per agent
}

/**
 * Resource Negotiator Class
 *
 * Manages automated resource negotiation between agents.
 */
export class ResourceNegotiator {
  private environmentCenter: EnvironmentCenter;
  // private dialogueManager: DialogueManager; // Reserved for future use
  private eventEmitter: EventEmitter;
  private config: Required<NegotiationConfig>;

  // Negotiation state
  private proposals: Map<string, NegotiationProposal> = new Map();
  private agreements: Map<string, NegotiationTerms> = new Map();
  private proposalCounter: number = 0;

  // Event listeners
  private eventUnsubscribers: Array<string> = []; // Store subscription IDs

  constructor(
    environmentCenter: EnvironmentCenter,
    _dialogueManager: DialogueManager,
    config: NegotiationConfig = {}
  ) {
    this.environmentCenter = environmentCenter;
    // dialogueManager reserved for future use
    this.eventEmitter = new EventEmitter(environmentCenter.eventManager, 'resource-negotiator');

    // Default configuration
    this.config = {
      defaultResponseTimeout: config.defaultResponseTimeout || 30000, // 30 seconds
      autoEvaluateProposals: config.autoEvaluateProposals ?? true,
      enableCountering: config.enableCountering ?? true,
      maxActiveAgreements: config.maxActiveAgreements || 10,
    };

    logger.info('Initialized with config:', {
      responseTimeout: `${this.config.defaultResponseTimeout}ms`,
      autoEvaluate: this.config.autoEvaluateProposals,
      countering: this.config.enableCountering,
      maxAgreements: this.config.maxActiveAgreements,
    });

    // Set up event listeners
    this.setupEventListeners();
  }

  /**
   * Initiate a negotiation proposal
   * @param proposal - Proposal data (without id, proposedAt, status)
   * @returns Created proposal
   */
  initiateNegotiation(proposal: Omit<NegotiationProposal, 'id' | 'proposedAt' | 'status'>): NegotiationProposal {
    const proposalId = this.generateProposalId();
    const now = new Date();

    const newProposal: NegotiationProposal = {
      ...proposal,
      id: proposalId,
      proposedAt: now,
      status: NegotiationStatus.PENDING,
    };

    this.proposals.set(proposalId, newProposal);

    logger.info(`Proposal initiated: ${proposalId}`, {
      from: proposal.proposedBy,
      to: proposal.proposedTo,
      resources: proposal.resources.length,
      priority: proposal.priority,
    });

    // Emit proposal created event
    this.eventEmitter.emit(EventType.COLLABORATION_STARTED, {
      proposalId,
      type: 'resource_negotiation',
      from: proposal.proposedBy,
      to: proposal.proposedTo,
    });

    // Send message through dialogue manager
    this.sendProposalMessage(newProposal);

    // Auto-evaluate if enabled
    if (this.config.autoEvaluateProposals) {
      // In a real implementation, would use LLM to evaluate
      // For now, just log
      logger.info(`Auto-evaluation enabled for proposal ${proposalId}`);
    }

    return newProposal;
  }

  /**
   * Respond to a negotiation proposal
   * @param proposalId - Proposal ID
   * @param response - Response type ('accept', 'reject', 'counter')
   * @param counterProposal - Optional counter-proposal
   * @returns Negotiation result
   */
  async respondToProposal(
    proposalId: string,
    response: 'accept' | 'reject' | 'counter',
    counterProposal?: Partial<NegotiationProposal>
  ): Promise<NegotiationResult> {
    const proposal = this.proposals.get(proposalId);

    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found`);
    }

    if (proposal.status !== NegotiationStatus.PENDING) {
      throw new Error(`Proposal ${proposalId} is not in PENDING status`);
    }

    const result: NegotiationResult = {
      proposal,
      accepted: response === 'accept',
      message: '',
      timestamp: new Date(),
    };

    switch (response) {
      case 'accept':
        proposal.status = NegotiationStatus.ACCEPTED;

        // Create agreement
        const terms = this.createAgreement(proposal);
        result.terms = terms;
        result.accepted = true;
        result.message = `Proposal ${proposalId} accepted. Agreement ${terms.id} created.`;

        logger.info(`Proposal ${proposalId} accepted. Agreement ${terms.id} created.`);
        break;

      case 'reject':
        proposal.status = NegotiationStatus.REJECTED;
        result.accepted = false;
        result.message = `Proposal ${proposalId} rejected.`;

        logger.info(`Proposal ${proposalId} rejected.`);
        break;

      case 'counter':
        if (!this.config.enableCountering) {
          throw new Error('Countering is not enabled');
        }

        if (!counterProposal) {
          throw new Error('Counter-proposal data required');
        }

        proposal.status = NegotiationStatus.COUNTERED;

        // Create counter-proposal
        const counterId = this.initiateNegotiation({
          proposedBy: proposal.proposedTo,
          proposedTo: proposal.proposedBy,
          resources: counterProposal.resources || proposal.resources,
          duration: counterProposal.duration || proposal.duration,
          priority: counterProposal.priority || proposal.priority,
          purpose: counterProposal.purpose || `Counter to ${proposalId}`,
          expiresAt: counterProposal.expiresAt || new Date(Date.now() + this.config.defaultResponseTimeout),
          metadata: { originalProposalId: proposalId },
        });

        result.accepted = false;
        result.message = `Proposal ${proposalId} countered with ${counterId}.`;

        logger.info(`Proposal ${proposalId} countered with ${counterId}.`);
        break;
    }

    // Emit negotiation completed event
    this.eventEmitter.emit(EventType.COLLABORATION_COMPLETED, {
      proposalId,
      status: proposal.status,
      accepted: result.accepted,
    });

    return result;
  }

  /**
   * Automatically negotiate a proposal
   * @param proposal - Proposal to evaluate
   * @returns Negotiation result
   */
  async negotiateAutomatically(proposal: NegotiationProposal): Promise<NegotiationResult> {
    logger.info(`Auto-negotiating proposal ${proposal.id}...`);

    // Check if resources are available
    const available = this.checkResourceAvailability(
      proposal.proposedTo,
      proposal.resources,
      proposal.duration
    );

    if (!available) {
      logger.info(`Resources not available, rejecting proposal ${proposal.id}`);
      return this.respondToProposal(proposal.id, 'reject');
    }

    // Check if agent has too many active agreements
    const activeCount = this.getActiveAgreements(proposal.proposedTo).length;
    if (activeCount >= this.config.maxActiveAgreements) {
      logger.info(`Too many active agreements, rejecting proposal ${proposal.id}`);
      return this.respondToProposal(proposal.id, 'reject');
    }

    // Evaluate priority and purpose (simplified logic)
    // In real implementation, would use LLM to evaluate
    const shouldAccept = this.evaluateProposal(proposal);

    if (shouldAccept) {
      logger.info(`Proposal ${proposal.id} accepted automatically`);
      return this.respondToProposal(proposal.id, 'accept');
    } else {
      logger.info(`Proposal ${proposal.id} rejected automatically`);
      return this.respondToProposal(proposal.id, 'reject');
    }
  }

  /**
   * Get active agreements for an agent
   * @param agentId - Agent ID
   * @returns Array of active agreements
   */
  getActiveAgreements(agentId: string): NegotiationTerms[] {
    const now = new Date();
    const agreements: NegotiationTerms[] = [];

    for (const agreement of this.agreements.values()) {
      // Check if agent is involved (owner or borrower)
      if (agreement.owner !== agentId && agreement.borrower !== agentId) {
        continue;
      }

      // Check if agreement is still active (not expired)
      if (agreement.endTime < now) {
        continue;
      }

      agreements.push(agreement);
    }

    return agreements;
  }

  /**
   * Get resource usage (agreements involving a resource)
   * @param resourceId - Resource ID
   * @returns Array of agreements
   */
  getResourceUsage(resourceId: string): NegotiationTerms[] {
    const now = new Date();
    const agreements: NegotiationTerms[] = [];

    for (const agreement of this.agreements.values()) {
      // Check if agreement involves this resource
      if (!agreement.resources.includes(resourceId)) {
        continue;
      }

      // Check if agreement is still active
      if (agreement.endTime < now) {
        continue;
      }

      agreements.push(agreement);
    }

    return agreements;
  }

  /**
   * Get proposal by ID
   * @param proposalId - Proposal ID
   * @returns Proposal or undefined
   */
  getProposal(proposalId: string): NegotiationProposal | undefined {
    return this.proposals.get(proposalId);
  }

  /**
   * Get all proposals for an agent
   * @param agentId - Agent ID
   * @param status - Optional filter by status
   * @returns Array of proposals
   */
  getProposals(agentId: string, status?: NegotiationStatus): NegotiationProposal[] {
    const proposals: NegotiationProposal[] = [];

    for (const proposal of this.proposals.values()) {
      // Check if agent is involved (proposer or receiver)
      if (proposal.proposedBy !== agentId && proposal.proposedTo !== agentId) {
        continue;
      }

      // Filter by status if specified
      if (status && proposal.status !== status) {
        continue;
      }

      proposals.push(proposal);
    }

    return proposals;
  }

  /**
   * Get agreement by ID
   * @param agreementId - Agreement ID
   * @returns Agreement or undefined
   */
  getAgreement(agreementId: string): NegotiationTerms | undefined {
    return this.agreements.get(agreementId);
  }

  /**
   * Cancel an agreement
   * @param agreementId - Agreement ID
   * @param cancelledBy - Agent ID cancelling the agreement
   */
  cancelAgreement(agreementId: string, cancelledBy: string): void {
    const agreement = this.agreements.get(agreementId);

    if (!agreement) {
      throw new Error(`Agreement ${agreementId} not found`);
    }

    // Only owner or borrower can cancel
    if (agreement.owner !== cancelledBy && agreement.borrower !== cancelledBy) {
      throw new Error(`Agent ${cancelledBy} is not authorized to cancel agreement ${agreementId}`);
    }

    this.agreements.delete(agreementId);
    logger.info(`Agreement ${agreementId} cancelled by ${cancelledBy}`);
  }

  /**
   * Get negotiation statistics
   */
  getStats(): {
    totalProposals: number;
    activeProposals: number;
    acceptedProposals: number;
    rejectedProposals: number;
    totalAgreements: number;
    activeAgreements: number;
    expiredAgreements: number;
  } {
    const now = new Date();

    let activeProposals = 0;
    let acceptedProposals = 0;
    let rejectedProposals = 0;

    for (const proposal of this.proposals.values()) {
      if (proposal.status === NegotiationStatus.PENDING && proposal.expiresAt > now) {
        activeProposals++;
      } else if (proposal.status === NegotiationStatus.ACCEPTED) {
        acceptedProposals++;
      } else if (proposal.status === NegotiationStatus.REJECTED) {
        rejectedProposals++;
      }
    }

    let activeAgreements = 0;
    let expiredAgreements = 0;

    for (const agreement of this.agreements.values()) {
      if (agreement.endTime < now) {
        expiredAgreements++;
      } else {
        activeAgreements++;
      }
    }

    return {
      totalProposals: this.proposals.size,
      activeProposals,
      acceptedProposals,
      rejectedProposals,
      totalAgreements: this.agreements.size,
      activeAgreements,
      expiredAgreements,
    };
  }

  /**
   * Cleanup expired proposals and agreements
   */
  cleanup(): void {
    const now = new Date();
    let cleanedProposals = 0;
    let cleanedAgreements = 0;

    // Clean up expired proposals
    for (const [id, proposal] of this.proposals) {
      if (proposal.status === NegotiationStatus.PENDING && proposal.expiresAt < now) {
        proposal.status = NegotiationStatus.EXPIRED;
        cleanedProposals++;
        logger.info(`Proposal ${id} expired`);
      }
    }

    // Clean up expired agreements (keep them in history but mark)
    for (const agreement of this.agreements.values()) {
      if (agreement.endTime < now) {
        cleanedAgreements++;
      }
    }

    logger.info(`Cleanup complete: ${cleanedProposals} proposals, ${cleanedAgreements} agreements`);
  }

  /**
   * Destroy and cleanup
   */
  destroy(): void {
    logger.info('Destroying...');

    // Unsubscribe from events
    for (const subscriptionId of this.eventUnsubscribers) {
      try {
        this.environmentCenter.eventManager.unsubscribe(subscriptionId);
      } catch (error) {
        logger.error('Error unsubscribing:', error);
      }
    }
    this.eventUnsubscribers = [];

    // Clear all data
    this.proposals.clear();
    this.agreements.clear();

    logger.info('Destroyed');
  }

  /**
   * Set up event listeners
   */
  private setupEventListeners(): void {
    logger.info('Setting up event listeners...');

    // Listen for collaboration messages
    const collabUnsub = this.environmentCenter.eventManager.subscribe({
      subscriberId: 'resource-negotiator',
      eventType: EventType.COLLABORATION_MESSAGE,
      handler: (event) => {
        if (event.payload.type === 'resource_negotiation') {
          logger.info(`Received negotiation message from ${event.payload.from}`);
          // Handle negotiation message
          this.handleNegotiationMessage(event.payload);
        }
      },
      priority: EventPriority.HIGH,
    });
    this.eventUnsubscribers.push(collabUnsub);

    logger.info(`Set up ${this.eventUnsubscribers.length} event listeners`);
  }

  /**
   * Send proposal message through dialogue manager
   */
  private sendProposalMessage(proposal: NegotiationProposal): void {
    // Use dialogue manager to send message
    // In a real implementation, would send structured proposal data
    logger.info(`Sending proposal ${proposal.id} message to ${proposal.proposedTo}`);
  }

  /**
   * Handle negotiation message
   */
  private async handleNegotiationMessage(message: any): Promise<void> {
    // Handle incoming negotiation messages
    if (this.config.autoEvaluateProposals) {
      // Extract proposal from message
      const proposalId = message.proposalId;
      if (proposalId && this.proposals.has(proposalId)) {
        await this.negotiateAutomatically(this.proposals.get(proposalId)!);
      }
    }
  }

  /**
   * Check resource availability
   */
  private checkResourceAvailability(_agentId: string, _resourceIds: string[], _duration: number): boolean {
    // Check if resources are owned by agent
    // Check if resources are already tied up in agreements
    // Simplified implementation - always return true for now
    return true;
  }

  /**
   * Evaluate proposal (simplified logic)
   */
  private evaluateProposal(proposal: NegotiationProposal): boolean {
    // In real implementation, would use LLM to evaluate
    // Simplified logic: accept if priority is high or medium
    return proposal.priority === NegotiationPriority.HIGH ||
           proposal.priority === NegotiationPriority.MEDIUM;
  }

  /**
   * Create agreement from accepted proposal
   */
  private createAgreement(proposal: NegotiationProposal): NegotiationTerms {
    const agreementId = this.generateAgreementId();
    const now = new Date();

    const agreement: NegotiationTerms = {
      id: agreementId,
      proposalId: proposal.id,
      resources: proposal.resources,
      owner: proposal.proposedTo,
      borrower: proposal.proposedBy,
      startTime: now,
      endTime: new Date(now.getTime() + proposal.duration),
      purpose: proposal.purpose,
      agreedAt: now,
    };

    this.agreements.set(agreementId, agreement);

    return agreement;
  }

  /**
   * Generate unique proposal ID
   */
  private generateProposalId(): string {
    this.proposalCounter++;
    return `proposal_${Date.now()}_${this.proposalCounter}`;
  }

  /**
   * Generate unique agreement ID
   */
  private generateAgreementId(): string {
    // Using random string generation for uniqueness
    const randomStr = Math.random().toString(36).substring(2, 11);
    return `agreement_${Date.now()}_${randomStr}`;
  }
}
