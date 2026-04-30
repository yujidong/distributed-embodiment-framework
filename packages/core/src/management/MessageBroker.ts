/**
 * Message Broker - Inter-Agent Communication Bus
 *
 * Provides REAL message passing between agents
 * Each agent registers with the broker to receive messages
 */

import type { DialogueMessage, MessageType } from './DialogueManager.js';
import { MessagePriority } from './DialogueManager.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Message handler function type
 */
const logger = createLogger('MessageBroker');

export type MessageHandler = (message: DialogueMessage) => void | Promise<void>;

/**
 * Agent registration
 */
interface AgentRegistration {
  agentId: string;
  agentName: string;
  handler: MessageHandler;
  registeredAt: Date;
}

/**
 * Message delivery status
 */
export enum DeliveryStatus {
  PENDING = 'pending',
  DELIVERED = 'delivered',
  FAILED = 'failed',
  NO_HANDLER = 'no_handler',
}

/**
 * Message delivery receipt
 */
export interface DeliveryReceipt {
  messageId: string;
  from: string;
  to: string;
  status: DeliveryStatus;
  timestamp: Date;
  error?: string;
}

/**
 * Message Broker - Central communication hub for all agents
 */
export class MessageBroker {
  private agents: Map<string, AgentRegistration>;
  private messageCounter: number;
  private deliveryReceipts: Map<string, DeliveryReceipt>;

  constructor() {
    this.agents = new Map();
    this.messageCounter = 0;
    this.deliveryReceipts = new Map();
    logger.info('Initialized - shared communication bus ready');
  }

  /**
   * Register an agent to receive messages
   * @param agentId - Agent ID
   * @param agentName - Agent name
   * @param handler - Message handler function
   */
  registerAgent(agentId: string, agentName: string, handler: MessageHandler): void {
    logger.info(`Registering agent: ${agentName} (${agentId})`);

    if (this.agents.has(agentId)) {
      logger.warn(`Agent ${agentId} already registered, updating handler`);
    }

    this.agents.set(agentId, {
      agentId,
      agentName,
      handler,
      registeredAt: new Date(),
    });

    logger.info(`Agent registered: ${agentId} (total: ${this.agents.size})`);
  }

  /**
   * Unregister an agent
   * @param agentId - Agent ID
   */
  unregisterAgent(agentId: string): void {
    logger.info(`Unregistering agent: ${agentId}`);
    this.agents.delete(agentId);
    logger.info(`Agent unregistered: ${agentId} (remaining: ${this.agents.size})`);
  }

  /**
   * Send a message from one agent to another (REAL delivery)
   * @param from - Sender agent ID
   * @param to - Recipient agent ID
   * @param type - Message type
   * @param subject - Message subject
   * @param content - Message content
   * @param options - Additional options
   * @returns Delivery receipt
   */
  async sendMessage(
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
  ): Promise<DeliveryReceipt> {
    const messageId = `msg-${++this.messageCounter}-${Date.now()}`;
    const timestamp = new Date();

    logger.info(`${from} -> ${to}: ${subject}`);

    // Create message
    const message: DialogueMessage = {
      id: messageId,
      type,
      priority: options.priority || MessagePriority.NORMAL,
      from,
      to,
      subject,
      content,
      timestamp,
      replyTo: options.replyTo,
      conversationId: options.conversationId,
      metadata: options.metadata || {},
    };

    // Find recipient agent
    const recipient = this.agents.get(to);

    let status: DeliveryStatus;
    let error: string | undefined;

    if (!recipient) {
      logger.warn(`Recipient agent not found: ${to}`);
      status = DeliveryStatus.NO_HANDLER;
      error = `Agent ${to} not registered`;
    } else {
      try {
        // Call recipient's message handler (REAL delivery!)
        await recipient.handler(message);
        logger.info(`Message delivered to ${to}: ${messageId}`);
        status = DeliveryStatus.DELIVERED;
      } catch (err) {
        logger.error(`Error delivering message to ${to}:`, err);
        status = DeliveryStatus.FAILED;
        error = err instanceof Error ? err.message : String(err);
      }
    }

    // Create delivery receipt
    const receipt: DeliveryReceipt = {
      messageId,
      from,
      to,
      status,
      timestamp,
      error,
    };

    this.deliveryReceipts.set(messageId, receipt);

    logger.info(`Message delivery receipt: ${messageId} -> ${status}`);

    return receipt;
  }

  /**
   * Broadcast a message to all registered agents
   * @param from - Sender agent ID
   * @param type - Message type
   * @param subject - Message subject
   * @param content - Message content
   * @param options - Additional options
   * @returns Array of delivery receipts
   */
  async broadcastMessage(
    from: string,
    type: MessageType,
    subject: string,
    content: string,
    options: {
      priority?: MessagePriority;
      excludeSender?: boolean;
      metadata?: Record<string, any>;
    } = {}
  ): Promise<DeliveryReceipt[]> {
    logger.info(`Broadcasting from ${from}: ${subject}`);

    const recipients = options.excludeSender
      ? Array.from(this.agents.keys()).filter(id => id !== from)
      : Array.from(this.agents.keys());

    const receipts: DeliveryReceipt[] = [];

    for (const to of recipients) {
      const receipt = await this.sendMessage(from, to, type, subject, content, options);
      receipts.push(receipt);
    }

    logger.info(`Broadcast complete: ${receipts.length} recipients`);

    return receipts;
  }

  /**
   * Get delivery receipt for a message
   * @param messageId - Message ID
   * @returns Delivery receipt or undefined
   */
  getDeliveryReceipt(messageId: string): DeliveryReceipt | undefined {
    return this.deliveryReceipts.get(messageId);
  }

  /**
   * Check if an agent is registered
   * @param agentId - Agent ID
   * @returns True if registered
   */
  isAgentRegistered(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Get list of registered agent IDs
   * @returns Array of agent IDs
   */
  getRegisteredAgents(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Get agent registration info
   * @param agentId - Agent ID
   * @returns Agent registration or undefined
   */
  getAgentInfo(agentId: string): AgentRegistration | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get broker statistics
   * @returns Statistics object
   */
  getStats(): {
    registeredAgents: number;
    messagesSent: number;
    deliveriesByStatus: Record<string, number>;
  } {
    const deliveriesByStatus: Record<string, number> = {};

    for (const receipt of this.deliveryReceipts.values()) {
      deliveriesByStatus[receipt.status] = (deliveriesByStatus[receipt.status] || 0) + 1;
    }

    return {
      registeredAgents: this.agents.size,
      messagesSent: this.messageCounter,
      deliveriesByStatus,
    };
  }

  /**
   * Clear all delivery receipts
   */
  clearReceipts(): void {
    logger.info('Clearing delivery receipts');
    this.deliveryReceipts.clear();
  }

  /**
   * Reset the broker (clear all data)
   */
  reset(): void {
    logger.info('Resetting - clearing all agents and receipts');
    this.agents.clear();
    this.deliveryReceipts.clear();
    this.messageCounter = 0;
  }
}
