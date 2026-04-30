/**
 * Context Management Coordinator
 *
 * Encapsulates context building and management for CognitiveAgent.
 * This is a thin wrapper around AgentContextBuilder that adds event emission.
 *
 * Key Responsibilities:
 * - Build full agent context (delegates to AgentContextBuilder)
 * - Build task-specific context (adds task context to base context)
 * - Provide agent info access
 * - Emit CONTEXT_BUILT events when context is built
 *
 * Architecture Principle:
 * - Does NOT reimplement context building logic
 * - Delegates all actual work to AgentContextBuilder
 * - Only adds coordination and event emission
 */

import type { AgentContextBuilder, FullAgentContext, AgentInfo } from '../../context/AgentContextBuilder.js';
import type { EventEmitter } from '../../events/EventEmitter.js';
import { EventType } from '@active-collaboration/shared';

/**
 * Context Management Coordinator
 *
 * Coordinates context building for CognitiveAgent by wrapping AgentContextBuilder.
 * Emits events when context is built for observability and debugging.
 */
export class ContextManagementCoordinator {
  /**
   * Creates a new ContextManagementCoordinator
   *
   * @param contextBuilder - The AgentContextBuilder instance to wrap
   * @param eventEmitter - EventEmitter for emitting context events
   * @param agentId - ID of the agent this coordinator belongs to
   * @param agentInfo - Agent information for quick access
   */
  constructor(
    private readonly contextBuilder: AgentContextBuilder,
    private readonly eventEmitter: EventEmitter,
    private readonly agentId: string,
    private readonly agentInfo: AgentInfo
  ) {}

  /**
   * Build full agent context
   *
   * Delegates to AgentContextBuilder.buildFullContext() and emits
   * a CONTEXT_BUILT event upon successful completion.
   *
   * @returns Complete agent context for LLM decision-making
   */
  async buildFullContext(): Promise<FullAgentContext> {
    const context = await this.contextBuilder.buildFullContext();

    // Emit event after successful context build
    this.eventEmitter.emit(EventType.AGENT_CONTEXT_BUILT, {
      agentId: this.agentId,
      context: {
        self: context.self,
        resourceCount: context.resources.length,
        peerCount: context.peerAgents.length,
        ownServiceCount: context.availableServices.own.length,
        peerServiceCount: context.availableServices.fromPeers.length,
      },
      timestamp: new Date(),
    });

    return context;
  }

  /**
   * Build task-specific context
   *
   * Builds full context and adds task information to the context.
   * Useful for providing focused context for specific tasks.
   *
   * @param task - The task description to include in context
   * @returns Complete agent context with task information
   */
  async buildTaskContext(task: string): Promise<FullAgentContext> {
    const context = await this.contextBuilder.buildFullContext();

    // Add task context to the result
    const taskContext: FullAgentContext = {
      ...context,
      taskContext: {
        ...context.taskContext,
        currentTask: task,
      },
    };

    // Emit event with task information
    this.eventEmitter.emit(EventType.AGENT_CONTEXT_BUILT, {
      agentId: this.agentId,
      task,
      context: {
        self: taskContext.self,
        resourceCount: taskContext.resources.length,
        peerCount: taskContext.peerAgents.length,
        ownServiceCount: taskContext.availableServices.own.length,
        peerServiceCount: taskContext.availableServices.fromPeers.length,
        currentTask: task,
      },
      timestamp: new Date(),
    });

    return taskContext;
  }

  /**
   * Get agent information
   *
   * @returns The agent info object
   */
  getAgentInfo(): AgentInfo {
    return this.agentInfo;
  }

  /**
   * Get agent ID
   *
   * @returns The agent ID
   */
  getAgentId(): string {
    return this.agentId;
  }

  /**
   * Format context for LLM consumption (synchronous)
   *
   * Delegates to AgentContextBuilder.formatContextForLLM()
   *
   * @param context - The context to format
   * @param task - Optional task description
   * @returns Formatted context string
   */
  formatContextForLLM(context: FullAgentContext, task?: string): string {
    return this.contextBuilder.formatContextForLLM(context, task);
  }

  /**
   * Format context for LLM consumption (async)
   *
   * Delegates to AgentContextBuilder.formatContextForLLMAsync()
   *
   * @param context - The context to format
   * @param task - Optional task description
   * @returns Formatted context string
   */
  async formatContextForLLMAsync(context: FullAgentContext, task?: string): Promise<string> {
    return this.contextBuilder.formatContextForLLMAsync(context, task);
  }

  /**
   * Build full LLM prompt
   *
   * Delegates to AgentContextBuilder.buildFullPrompt()
   *
   * @param task - Task description
   * @param instructions - Instructions for the LLM
   * @param context - Optional pre-built context
   * @returns Complete prompt string
   */
  buildFullPrompt(task: string, instructions: string, context?: FullAgentContext): string {
    return this.contextBuilder.buildFullPrompt(task, instructions, context);
  }

  /**
   * Set user ID for permission filtering
   *
   * Delegates to AgentContextBuilder.setUserId()
   *
   * @param userId - The user ID to set
   */
  setUserId(userId: string): void {
    this.contextBuilder.setUserId(userId);
  }

  /**
   * Get current user ID
   *
   * Delegates to AgentContextBuilder.getUserId()
   *
   * @returns The current user ID or undefined
   */
  getUserId(): string | undefined {
    return this.contextBuilder.getUserId();
  }
}
