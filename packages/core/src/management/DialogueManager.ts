/**
 * Dialogue Manager
 *
 * Middle layer component for agent-to-agent communication
 * Handles collaboration negotiation and message passing
 */


import { createLogger } from '@active-collaboration/shared';
/**
 * Message type
 */
const logger = createLogger('DialogueManager');

export enum MessageType {
  REQUEST = 'request',
  RESPONSE = 'response',
  NOTIFICATION = 'notification',
  NEGOTIATION = 'negotiation',
  AGREEMENT = 'agreement',
  REJECTION = 'rejection',
}

/**
 * Message priority
 */
export enum MessagePriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent',
}

/**
 * Dialogue message
 */
export interface DialogueMessage {
  id: string;
  type: MessageType;
  priority: MessagePriority;
  from: string; // Agent ID
  to: string; // Agent ID
  subject: string;
  content: string;
  timestamp: Date;
  replyTo?: string; // Message ID this is replying to
  conversationId?: string; // Thread multiple messages together
  metadata: Record<string, any>;
}

/**
 * Collaboration proposal
 */
export interface CollaborationProposal {
  id: string;
  proposedBy: string; // Agent ID
  proposedTo: string; // Agent ID
  task: string;
  description: string;
  resources: string[]; // Resource IDs being offered/requested
  terms: Record<string, any>;
  status: ProposalStatus;
  createdAt: Date;
  expiresAt?: Date;
  responseDeadline?: Date;
}

/**
 * Proposal status
 */
export enum ProposalStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  COUNTERED = 'countered',
  EXPIRED = 'expired',
}

/**
 * Conversation state
 */
export interface Conversation {
  id: string;
  participants: string[]; // Agent IDs
  messages: DialogueMessage[];
  startedAt: Date;
  lastActivity: Date;
  metadata: Record<string, any>;
}

/**
 * Dialogue Manager handles agent communication and collaboration
 */
export class DialogueManager {
  private conversations: Map<string, Conversation>;
  private proposals: Map<string, CollaborationProposal>;
  private messageCounter: number;
  private conversationCounter: number;
  private proposalCounter: number;

  constructor() {
    this.conversations = new Map();
    this.proposals = new Map();
    this.messageCounter = 0;
    this.conversationCounter = 0;
    this.proposalCounter = 0;
    logger.info('Initialized');
  }

  /**
   * Send a message from one agent to another
   * @param from - Sender agent ID
   * @param to - Recipient agent ID
   * @param type - Message type
   * @param subject - Message subject
   * @param content - Message content
   * @param options - Additional options
   * @returns Sent message
   */
  sendMessage(
    from: string,
    to: string,
    type: MessageType,
    subject: string,
    content: string,
    options: {
      priority?: MessagePriority;
      replyTo?: string;
      conversationId?: string;
      metadata?: Record<string, any>;
    } = {}
  ): DialogueMessage {
    logger.info(`${from} -> ${to}: ${subject}`);

    const message: DialogueMessage = {
      id: this.generateMessageId(),
      type,
      priority: options.priority || MessagePriority.NORMAL,
      from,
      to,
      subject,
      content,
      timestamp: new Date(),
      replyTo: options.replyTo,
      conversationId: options.conversationId || this.generateConversationId([from, to]),
      metadata: options.metadata || {},
    };

    // Add to conversation
    const conversationId = message.conversationId!;
    let conversation = this.conversations.get(conversationId);
    if (!conversation) {
      conversation = {
        id: conversationId,
        participants: [from, to],
        messages: [],
        startedAt: new Date(),
        lastActivity: new Date(),
        metadata: {},
      };
      this.conversations.set(conversationId, conversation);
    }

    conversation.messages.push(message);
    conversation.lastActivity = new Date();

    logger.info(`Message sent: ${message.id}`);

    return message;
  }

  /**
   * Get messages for an agent
   * @param agentId - Agent ID
   * @returns Array of messages
   */
  getMessages(agentId: string): DialogueMessage[] {
    const messages: DialogueMessage[] = [];

    for (const conversation of this.conversations.values()) {
      if (!conversation.participants.includes(agentId)) {
        continue;
      }

      for (const message of conversation.messages) {
        if (message.to === agentId) {
          messages.push(message);
        }
      }
    }

    return messages;
  }

  /**
   * Get a conversation by ID
   * @param conversationId - Conversation ID
   * @returns Conversation or undefined
   */
  getConversation(conversationId: string): Conversation | undefined {
    return this.conversations.get(conversationId);
  }

  /**
   * Get conversations for an agent
   * @param agentId - Agent ID
   * @returns Array of conversations
   */
  getConversations(agentId: string): Conversation[] {
    return Array.from(this.conversations.values()).filter((c) =>
      c.participants.includes(agentId)
    );
  }

  /**
   * Propose collaboration to another agent
   * @param proposedBy - Proposing agent ID
   * @param proposedTo - Target agent ID
   * @param task - Task description
   * @param description - Detailed description
   * @param resources - Resource IDs involved
   * @param terms - Collaboration terms
   * @param options - Additional options
   * @returns Created proposal
   */
  proposeCollaboration(
    proposedBy: string,
    proposedTo: string,
    task: string,
    description: string,
    resources: string[],
    terms: Record<string, any>,
    options: {
      expiresAt?: Date;
      responseDeadline?: Date;
    } = {}
  ): CollaborationProposal {
    logger.info(`Collaboration proposal: ${proposedBy} -> ${proposedTo} for "${task}"`
    );

    const proposal: CollaborationProposal = {
      id: this.generateProposalId(),
      proposedBy,
      proposedTo,
      task,
      description,
      resources,
      terms,
      status: ProposalStatus.PENDING,
      createdAt: new Date(),
      expiresAt: options.expiresAt,
      responseDeadline: options.responseDeadline,
    };

    this.proposals.set(proposal.id, proposal);

    // Send notification message
    this.sendMessage(
      proposedBy,
      proposedTo,
      MessageType.NEGOTIATION,
      `Collaboration Proposal: ${task}`,
      description,
      {
        priority: MessagePriority.HIGH,
        metadata: { proposalId: proposal.id },
      }
    );

    logger.info(`Proposal created: ${proposal.id}`);

    return proposal;
  }

  /**
   * Accept a collaboration proposal
   * @param proposalId - Proposal ID
   * @param responderId - Agent responding to the proposal
   * @returns True if accepted successfully
   */
  acceptProposal(proposalId: string, responderId: string): boolean {
    logger.info(`Accepting proposal: ${proposalId}`);

    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      logger.error(`Proposal not found: ${proposalId}`);
      return false;
    }

    if (proposal.proposedTo !== responderId) {
      logger.error(`Agent ${responderId} cannot accept proposal`);
      return false;
    }

    if (proposal.status !== ProposalStatus.PENDING) {
      logger.error(`Proposal not in PENDING state`);
      return false;
    }

    proposal.status = ProposalStatus.ACCEPTED;

    // Send acceptance message
    this.sendMessage(
      responderId,
      proposal.proposedBy,
      MessageType.AGREEMENT,
      `Collaboration Accepted: ${proposal.task}`,
      `Proposal accepted. Terms: ${JSON.stringify(proposal.terms)}`,
      {
        priority: MessagePriority.HIGH,
        metadata: { proposalId },
      }
    );

    logger.info(`Proposal accepted: ${proposalId}`);

    return true;
  }

  /**
   * Reject a collaboration proposal
   * @param proposalId - Proposal ID
   * @param responderId - Agent responding to the proposal
   * @param reason - Rejection reason
   * @returns True if rejected successfully
   */
  rejectProposal(proposalId: string, responderId: string, reason?: string): boolean {
    logger.info(`Rejecting proposal: ${proposalId}`);

    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      logger.error(`Proposal not found: ${proposalId}`);
      return false;
    }

    if (proposal.proposedTo !== responderId) {
      logger.error(`Agent ${responderId} cannot reject proposal`);
      return false;
    }

    if (proposal.status !== ProposalStatus.PENDING) {
      logger.error(`Proposal not in PENDING state`);
      return false;
    }

    proposal.status = ProposalStatus.REJECTED;

    // Send rejection message
    this.sendMessage(
      responderId,
      proposal.proposedBy,
      MessageType.REJECTION,
      `Collaboration Rejected: ${proposal.task}`,
      reason || 'Proposal rejected',
      {
        priority: MessagePriority.NORMAL,
        metadata: { proposalId },
      }
    );

    logger.info(`Proposal rejected: ${proposalId}`);

    return true;
  }

  /**
   * Counter a collaboration proposal
   * @param proposalId - Original proposal ID
   * @param responderId - Agent responding with counter
   * @param newTerms - New proposed terms
   * @returns New counter proposal
   */
  counterProposal(
    proposalId: string,
    responderId: string,
    newTerms: Record<string, any>
  ): CollaborationProposal | undefined {
    logger.info(`Countering proposal: ${proposalId}`);

    const original = this.proposals.get(proposalId);
    if (!original) {
      logger.error(`Proposal not found: ${proposalId}`);
      return undefined;
    }

    if (original.proposedTo !== responderId) {
      logger.error(`Agent ${responderId} cannot counter proposal`);
      return undefined;
    }

    if (original.status !== ProposalStatus.PENDING) {
      logger.error(`Proposal not in PENDING state`);
      return undefined;
    }

    // Create counter proposal (swap roles)
    const counter = this.proposeCollaboration(
      responderId,
      original.proposedBy,
      original.task,
      `Counter to: ${original.description}`,
      original.resources,
      newTerms
    );

    original.status = ProposalStatus.COUNTERED;

    // Send counter message
    this.sendMessage(
      responderId,
      original.proposedBy,
      MessageType.NEGOTIATION,
      `Counter Proposal: ${original.task}`,
      `Counter proposal with new terms: ${JSON.stringify(newTerms)}`,
      {
        priority: MessagePriority.HIGH,
        metadata: { originalProposalId: proposalId, counterProposalId: counter.id },
      }
    );

    logger.info(`Counter proposal created: ${counter.id}`);

    return counter;
  }

  /**
   * Get a proposal by ID
   * @param proposalId - Proposal ID
   * @returns Proposal or undefined
   */
  getProposal(proposalId: string): CollaborationProposal | undefined {
    return this.proposals.get(proposalId);
  }

  /**
   * Get proposals for an agent
   * @param agentId - Agent ID
   * @param status - Filter by status (optional)
   * @returns Array of proposals
   */
  getProposals(agentId: string, status?: ProposalStatus): CollaborationProposal[] {
    let proposals = Array.from(this.proposals.values()).filter(
      (p) => p.proposedTo === agentId || p.proposedBy === agentId
    );

    if (status) {
      proposals = proposals.filter((p) => p.status === status);
    }

    return proposals;
  }

  /**
   * Get proposals sent by an agent
   * @param agentId - Agent ID (optional, defaults to all sent proposals)
   * @returns Array of proposals sent by the agent
   */
  getSentProposals(agentId?: string): CollaborationProposal[] {
    if (agentId) {
      return Array.from(this.proposals.values()).filter((p) => p.proposedBy === agentId);
    }
    return Array.from(this.proposals.values());
  }

  /**
   * Get proposals received by an agent
   * @param agentId - Agent ID (optional, defaults to all received proposals)
   * @returns Array of proposals received by the agent
   */
  getReceivedProposals(agentId?: string): CollaborationProposal[] {
    if (agentId) {
      return Array.from(this.proposals.values()).filter((p) => p.proposedTo === agentId);
    }
    return Array.from(this.proposals.values());
  }

  /**
   * Get dialogue statistics
   * @returns Statistics object
   */
  getStats(): {
    conversations: number;
    messages: number;
    proposals: number;
    pendingProposals: number;
    byStatus: Record<string, number>;
  } {
    const messages: DialogueMessage[] = [];
    for (const conv of this.conversations.values()) {
      messages.push(...conv.messages);
    }

    const byStatus: Record<string, number> = {};
    for (const proposal of this.proposals.values()) {
      byStatus[proposal.status] = (byStatus[proposal.status] || 0) + 1;
    }

    return {
      conversations: this.conversations.size,
      messages: messages.length,
      proposals: this.proposals.size,
      pendingProposals: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      byStatus,
    };
  }

  /**
   * Clear all conversations and proposals
   */
  clear(): void {
    logger.info('Clearing all conversations and proposals');
    this.conversations.clear();
    this.proposals.clear();
  }

  /**
   * Generate unique message ID
   * @returns Message ID
   */
  private generateMessageId(): string {
    return `msg-${++this.messageCounter}-${Date.now()}`;
  }

  /**
   * Generate unique conversation ID
   * @param participants - Array of participant IDs
   * @returns Conversation ID
   */
  private generateConversationId(participants: string[]): string {
    // Sort participants to ensure consistent ID
    const sorted = [...participants].sort().join('-');
    return `conv-${sorted}-${++this.conversationCounter}`;
  }

  /**
   * Generate unique proposal ID
   * @returns Proposal ID
   */
  private generateProposalId(): string {
    return `prop-${++this.proposalCounter}-${Date.now()}`;
  }
}
