/**
 * CollaborationManager - Manages Active Collaboration between agents
 *
 * Handles:
 * - Permission requests and responses
 * - Collaboration negotiation
 * - Collaboration history tracking
 * - Multi-agent coordination
 * - AC lifecycle state tracking
 */

import { v4 as uuidv4 } from 'uuid';
import { EventManager, EventType, EventPriority } from '../events/index.js';

import { createLogger } from '@active-collaboration/shared';
// ============================================================================
// Types
// ============================================================================

const logger = createLogger('CollaborationManager');

export enum CollaborationPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum CollaborationStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  DENIED = 'denied',
  IN_PROGRESS = 'in-progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface PermissionRequest {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  toAgentName: string;
  resourceId: string;
  resourceName: string;
  permissions: string[];
  reason: string;
  priority: CollaborationPriority;
  duration?: number; // milliseconds
  timestamp: Date;
  expiresAt?: Date;
}

export interface CollaborationSession {
  id: string;
  type: 'permission-grant' | 'service-composition' | 'emergency-response';
  participants: string[]; // agent IDs
  initiator: string; // agent ID
  status: CollaborationStatus;
  priority: CollaborationPriority;
  description: string;
  requestedResources: string[]; // resource IDs
  grantedPermissions: Map<string, string[]>; // agentId -> permissions
  messages: CollaborationMessage[];
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  // Participant details for tracking
  participantDetails?: Map<string, {
    agentId: string;
    role: string;
    capabilities: string[];
    joinedAt: Date;
    status: 'active' | 'withdrawn' | 'completed';
  }>;
  // Expected participants for automatic state transitions
  expectedParticipants?: string[];
}

export interface CollaborationMessage {
  id: string;
  fromAgentId: string;
  toAgentId?: string; // undefined if broadcast to all
  content: string;
  timestamp: Date;
  type: 'request' | 'response' | 'proposal' | 'notification' | 'alert';
}

/**
 * AC Lifecycle States
 * Tracks the complete lifecycle of an Active Collaboration
 */
export enum ACState {
  CREATED = 'created',
  INITIALIZING = 'initializing',
  FORMING = 'forming',       // Agents are being recruited
  READY = 'ready',
  RUNNING = 'running',
  PAUSED = 'paused',
  COMPLETING = 'completing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  TERMINATED = 'terminated',
}

/**
 * AC State Transition Record
 */
export interface ACStateTransition {
  from: ACState;
  to: ACState;
  timestamp: Date;
  reason?: string;
  triggeredBy?: string;
  metadata?: Record<string, any>;
}

/**
 * AC Error Record
 */
export interface ACError {
  type: 'critical' | 'recoverable';
  message: string;
  agentId?: string;
  recoverable: boolean;
  recoveryStrategy?: string;
  timestamp: Date;
  recovered?: boolean;
}

/**
 * AC Operation Record
 */
export interface ACOperation {
  id: string;
  type: string;
  agentId?: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  retryCount: number;
  maxRetries: number;
  error?: string;
  timestamp: Date;
}

/**
 * AC Completion Criteria
 */
export interface ACCompletionCriteria {
  type: 'all-goals-achieved' | 'time-bound' | 'manual';
  goals?: Array<{
    id: string;
    description: string;
    achieved: boolean;
    failed?: boolean;
  }>;
  deadline?: Date;
}

/**
 * Agent Withdrawal Request
 */
export interface WithdrawalRequest {
  id: string;
  collaborationId: string;
  agentId: string;
  agentName: string;
  reason: string;
  gracefulPeriod: number; // milliseconds for handoff
  timestamp: Date;
  status: 'pending' | 'approved' | 'rejected' | 'completed';
  taskHandoff?: {
    taskId: string;
    reassignedTo?: string;
    status: 'pending' | 'completed';
  }[];
}

/**
 * Dissolution Proposal
 */
export interface DissolutionProposal {
  id: string;
  collaborationId: string;
  proposerId: string;
  proposerName: string;
  reason: string;
  voteThreshold: number; // percentage (0-100)
  votes: Map<string, boolean>; // agentId -> vote
  createdAt: Date;
  expiresAt: Date;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
}

// ============================================================================
// CollaborationManager Class
// ============================================================================

export class CollaborationManager {
  private pendingRequests: Map<string, PermissionRequest>;
  private activeSessions: Map<string, CollaborationSession>;
  private sessionHistory: CollaborationSession[];

  // AC State Tracking
  private acStateTransitions: Map<string, ACStateTransition[]>;
  public eventManager: EventManager;

  // Withdrawal and Dissolution Tracking
  private withdrawalRequests: Map<string, WithdrawalRequest>;
  private dissolutionProposals: Map<string, DissolutionProposal>;

  // Timeout and Error Recovery
  private formingTimeouts: Map<string, NodeJS.Timeout>;
  private acErrors: Map<string, ACError[]>;
  private acOperations: Map<string, ACOperation[]>;
  private acCompletionCriteria: Map<string, ACCompletionCriteria>;
  private formingTimeoutTimers: Map<string, { timeout: number; startTime: Date }>;

  constructor() {
    this.pendingRequests = new Map();
    this.activeSessions = new Map();
    this.sessionHistory = [];
    this.acStateTransitions = new Map();
    this.eventManager = new EventManager(1000);
    this.withdrawalRequests = new Map();
    this.dissolutionProposals = new Map();
    this.formingTimeouts = new Map();
    this.acErrors = new Map();
    this.acOperations = new Map();
    this.acCompletionCriteria = new Map();
    this.formingTimeoutTimers = new Map();
    logger.info('Initialized with AC state tracking, withdrawal, and dissolution support');
  }

  // ========================================================================
  // Permission Request System
  // ========================================================================

  /**
   * Request permission from another agent to access a resource
   */
  requestPermission(
    fromAgentId: string,
    fromAgentName: string,
    toAgentId: string,
    toAgentName: string,
    resourceId: string,
    resourceName: string,
    permissions: string[],
    reason: string,
    priority: CollaborationPriority = CollaborationPriority.NORMAL,
    duration?: number
  ): PermissionRequest {
    logger.info(`Permission request: ${fromAgentName} -> ${toAgentName}`);
    logger.info(`  Resource: ${resourceName}`);
    logger.info(`  Permissions: ${permissions.join(', ')}`);
    logger.info(`  Priority: ${priority}`);

    const request: PermissionRequest = {
      id: uuidv4(),
      fromAgentId,
      fromAgentName,
      toAgentId,
      toAgentName,
      resourceId,
      resourceName,
      permissions,
      reason,
      priority,
      duration,
      timestamp: new Date(),
    };

    // Set expiration if duration specified
    if (duration) {
      request.expiresAt = new Date(Date.now() + duration);
    }

    this.pendingRequests.set(request.id, request);

    // Auto-approve for critical priority
    if (priority === CollaborationPriority.CRITICAL) {
      logger.info(`Auto-approving CRITICAL priority request`);
      this.approvePermissionRequest(request.id);
    }

    return request;
  }

  /**
   * Get pending permission requests for an agent
   */
  getPendingRequests(agentId: string): PermissionRequest[] {
    return Array.from(this.pendingRequests.values()).filter(
      (req) => req.toAgentId === agentId
    );
  }

  /**
   * Approve a permission request
   */
  approvePermissionRequest(requestId: string): CollaborationSession | null {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      logger.warn(`Request not found: ${requestId}`);
      return null;
    }

    logger.info(`Permission approved: ${request.fromAgentName} -> ${request.toAgentName}`);

    // Create collaboration session
    const session = this.createSession(
      'permission-grant',
      [request.fromAgentId, request.toAgentId],
      request.fromAgentId,
      request.priority,
      `${request.fromAgentName} requesting access to ${request.resourceName}`,
      [request.resourceId]
    );

    // Grant permissions
    session.grantedPermissions.set(request.fromAgentId, request.permissions);

    // Remove from pending
    this.pendingRequests.delete(requestId);

    return session;
  }

  /**
   * Deny a permission request
   */
  denyPermissionRequest(requestId: string, reason?: string): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      logger.warn(`Request not found: ${requestId}`);
      return;
    }

    logger.info(`Permission denied: ${request.fromAgentName} -> ${request.toAgentName}`);
    if (reason) {
      logger.info(`  Reason: ${reason}`);
    }

    this.pendingRequests.delete(requestId);
  }

  // ========================================================================
  // Collaboration Session Management
  // ========================================================================

  /**
   * Create a new collaboration session
   */
  createSession(
    type: 'permission-grant' | 'service-composition' | 'emergency-response',
    participants: string[],
    initiator: string,
    priority: CollaborationPriority,
    description: string,
    requestedResources: string[],
    duration?: number
  ): CollaborationSession {
    const session: CollaborationSession = {
      id: uuidv4(),
      type,
      participants,
      initiator,
      status: CollaborationStatus.PENDING,
      priority,
      description,
      requestedResources,
      grantedPermissions: new Map(),
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (duration) {
      session.expiresAt = new Date(Date.now() + duration);
    }

    this.activeSessions.set(session.id, session);
    logger.info(`Session created: ${session.id} (${type})`);

    return session;
  }

  /**
   * Create a new collaboration session with a specific ID
   *
   * Used when an agent accepts a proposal and needs to create a session
   * using the collaborationId from the proposal (instead of a generated UUID).
   *
   * @param sessionId - The specific session ID to use
   * @param type - Session type
   * @param participants - Initial participant IDs
   * @param initiator - Initiator agent ID
   * @param priority - Collaboration priority
   * @param description - Session description
   * @param requestedResources - Requested resource IDs
   * @param duration - Optional duration in milliseconds
   */
  createSessionWithId(
    sessionId: string,
    type: 'permission-grant' | 'service-composition' | 'emergency-response',
    participants: string[],
    initiator: string,
    priority: CollaborationPriority,
    description: string,
    requestedResources: string[],
    duration?: number
  ): CollaborationSession {
    const session: CollaborationSession = {
      id: sessionId,
      type,
      participants,
      initiator,
      status: CollaborationStatus.PENDING,
      priority,
      description,
      requestedResources,
      grantedPermissions: new Map(),
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (duration) {
      session.expiresAt = new Date(Date.now() + duration);
    }

    this.activeSessions.set(session.id, session);
    logger.info(`Session created with specific ID: ${session.id} (${type})`);

    return session;
  }

  /**
   * Get active sessions
   * If agentId is provided, returns only sessions involving that agent
   * If no agentId is provided, returns all active sessions
   */
  getActiveSessions(agentId?: string): CollaborationSession[] {
    const all = Array.from(this.activeSessions.values());
    if (agentId) {
      return all.filter((session) =>
        session.participants.includes(agentId)
      );
    }
    return all;
  }

  /**
   * Get completed/historical sessions for an agent
   */
  getCompletedSessions(agentId: string): CollaborationSession[] {
    return this.sessionHistory.filter((session) =>
      session.participants.includes(agentId)
    );
  }

  /**
   * Get all sessions (active + completed) for an agent
   */
  getAllSessions(agentId: string): {
    active: CollaborationSession[];
    completed: CollaborationSession[];
    total: number;
  } {
    const active = this.getActiveSessions(agentId);
    const completed = this.getCompletedSessions(agentId);
    return {
      active,
      completed,
      total: active.length + completed.length
    };
  }

  /**
   * Get total collaboration count for an agent (for testing verification)
   */
  getTotalCollaborationCount(agentId: string): number {
    const activeCount = this.getActiveSessions(agentId).length;
    const completedCount = this.getCompletedSessions(agentId).length;
    return activeCount + completedCount;
  }

  /**
   * Check if agent has ever participated in any collaboration
   */
  hasCollaborated(agentId: string): boolean {
    return this.getTotalCollaborationCount(agentId) > 0;
  }

  /**
   * Get session by ID (active sessions only)
   *
   * Completed/failed/cancelled sessions are moved to history and are no
   * longer returned by this method. Use getSessionFromHistory() to retrieve
   * historical sessions.
   */
  getSession(sessionId: string): CollaborationSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Get a session from history by ID
   *
   * Returns sessions that have been completed, failed, or cancelled.
   */
  getSessionFromHistory(sessionId: string): CollaborationSession | undefined {
    return this.sessionHistory.find(s => s.id === sessionId);
  }

  /**
   * Get a session from either active or historical records
   *
   * Use this when you need to find a session regardless of its status.
   */
  findSessionAnywhere(sessionId: string): CollaborationSession | undefined {
    return this.activeSessions.get(sessionId) ||
      this.sessionHistory.find(s => s.id === sessionId);
  }

  /**
   * Update session status
   */
  updateSessionStatus(sessionId: string, status: CollaborationStatus): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      logger.warn(`Session not found: ${sessionId}`);
      return;
    }

    session.status = status;
    session.updatedAt = new Date();

    logger.info(`Session ${sessionId} status: ${status}`);

    // Check for automatic state transition when status changes
    this.checkAndTransitionState(sessionId);

    // Move to history if completed/failed/cancelled
    if (
      status === CollaborationStatus.COMPLETED ||
      status === CollaborationStatus.FAILED ||
      status === CollaborationStatus.CANCELLED
    ) {
      this.activeSessions.delete(sessionId);
      this.sessionHistory.push(session);
    }
  }

  /**
   * Add message to session
   */
  addMessage(
    sessionId: string,
    fromAgentId: string,
    content: string,
    type: 'request' | 'response' | 'proposal' | 'notification' | 'alert',
    toAgentId?: string
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      logger.warn(`Session not found: ${sessionId}`);
      return;
    }

    const message: CollaborationMessage = {
      id: uuidv4(),
      fromAgentId,
      toAgentId,
      content,
      timestamp: new Date(),
      type,
    };

    session.messages.push(message);
    session.updatedAt = new Date();

    logger.info(`Message added to session ${sessionId}: ${type}`);
  }

  /**
   * Complete a collaboration session
   */
  completeSession(sessionId: string): void {
    this.updateSessionStatus(sessionId, CollaborationStatus.COMPLETED);
  }

  /**
   * Cancel a collaboration session
   */
  cancelSession(sessionId: string, reason?: string): void {
    if (reason) {
      const session = this.activeSessions.get(sessionId);
      if (session) {
        this.addMessage(sessionId, session.initiator, reason, 'notification');
      }
    }
    this.updateSessionStatus(sessionId, CollaborationStatus.CANCELLED);
  }

  // ========================================================================
  // Participant Management (State Tracking Only - No Control)
  // ========================================================================

  /**
   * Add a participant to a collaboration session
   *
   * CRITICAL ARCHITECTURE PRINCIPLE:
   * - This method is called BY THE AGENT after it autonomously decides to join
   * - CollaborationManager TRACKS state, does NOT control behavior
   * - Agents call this method to notify CM of their decision
   *
   * @param sessionId - Collaboration session ID
   * @param agentId - Agent ID joining the collaboration
   * @param details - Participation details (role, capabilities, etc.)
   */
  addParticipant(
    sessionId: string,
    agentId: string,
    details: {
      role: string;
      capabilities: string[];
      joinedAt?: Date;
    }
  ): { success: boolean; error?: string } {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      logger.warn(`Session not found: ${sessionId}`);
      return { success: false, error: 'Session not found' };
    }

    logger.info(`Agent ${agentId} joining session ${sessionId} as ${details.role}`);

    // Add to participants array if not already present
    if (!session.participants.includes(agentId)) {
      session.participants.push(agentId);
    }

    // Initialize participantDetails map if needed
    if (!session.participantDetails) {
      session.participantDetails = new Map();
    }

    // Track participant details
    session.participantDetails.set(agentId, {
      agentId,
      role: details.role,
      capabilities: details.capabilities,
      joinedAt: details.joinedAt || new Date(),
      status: 'active',
    });

    session.updatedAt = new Date();

    // Check for automatic state transition
    this.checkAndTransitionState(sessionId);

    logger.info(`Agent ${agentId} added to session ${sessionId}. Total participants: ${session.participants.length}`);

    return { success: true };
  }

  /**
   * Get participant details from a collaboration
   *
   * @param sessionId - Collaboration session ID
   * @param agentId - Agent ID to query
   * @returns Participant details or undefined
   */
  getParticipant(
    sessionId: string,
    agentId: string
  ): {
    agentId: string;
    role: string;
    capabilities: string[];
    joinedAt: Date;
    status: 'active' | 'withdrawn' | 'completed';
  } | undefined {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.participantDetails) {
      return undefined;
    }

    return session.participantDetails.get(agentId);
  }

  /**
   * Get all participants in a collaboration
   *
   * @param sessionId - Collaboration session ID
   * @returns Array of participant details
   */
  getAllParticipants(sessionId: string): Array<{
    agentId: string;
    role: string;
    capabilities: string[];
    joinedAt: Date;
    status: 'active' | 'withdrawn' | 'completed';
  }> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.participantDetails) {
      return [];
    }

    return Array.from(session.participantDetails.values());
  }

  /**
   * Set expected participants for automatic state transitions
   *
   * @param sessionId - Collaboration session ID
   * @param expectedAgents - Array of expected agent IDs
   */
  setExpectedParticipants(sessionId: string, expectedAgents: string[]): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      logger.warn(`Session not found: ${sessionId}`);
      return;
    }

    session.expectedParticipants = expectedAgents;
    logger.info(`Expected participants set for ${sessionId}: ${expectedAgents.join(', ')}`);

    // Check if we can transition immediately
    this.checkAndTransitionState(sessionId);
  }

  /**
   * Check and perform automatic state transitions
   *
   * Architecture: State transitions happen automatically based on participant joining
   * - FORMING → READY: When all expected participants have joined
   * - READY → RUNNING: When collaboration execution begins (session status changes to IN_PROGRESS)
   *
   * @param sessionId - Collaboration session ID
   */
  private checkAndTransitionState(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return;
    }

    const currentState = this.getCurrentACState(sessionId);

    // Check FORMING → READY transition
    // IMPORTANT: Use participantDetails (actual joined via addParticipant) not session.participants (pre-declared list)
    if (currentState === ACState.FORMING && session.expectedParticipants) {
      const joinedAgentIds = session.participantDetails
        ? Array.from(session.participantDetails.keys())
        : [];

      const allJoined = session.expectedParticipants.every(expected =>
        joinedAgentIds.includes(expected)
      );

      if (allJoined && joinedAgentIds.length >= session.expectedParticipants.length) {
        logger.info(`All expected participants joined, transitioning to READY`);
        this.trackACState(sessionId, ACState.READY, 'All expected participants have joined');
      }
    }

    // Check READY → RUNNING transition
    if (currentState === ACState.READY && session.status === CollaborationStatus.IN_PROGRESS) {
      logger.info(`Collaboration execution started, transitioning to RUNNING`);
      this.trackACState(sessionId, ACState.RUNNING, 'Collaboration execution started');
    }
  }

  // ========================================================================
  // Collaboration Discovery & Matching
  // ========================================================================

  /**
   * Find agents that can help with a request
   * Based on agent capabilities and available resources
   */
  findPotentialCollaborators(
    requesterAgentId: string,
    requiredCapabilities: string[],
    allAgents: Array<{ id: string; name: string; capabilities: string[] }>
  ): Array<{ id: string; name: string; matchScore: number }> {
    const collaborators: Array<{ id: string; name: string; matchScore: number }> = [];

    for (const agent of allAgents) {
      // Skip the requester
      if (agent.id === requesterAgentId) {
        continue;
      }

      // Calculate match score based on capabilities
      const matchedCapabilities = agent.capabilities.filter((cap) =>
        requiredCapabilities.some((required) => cap.includes(required) || required.includes(cap))
      );

      if (matchedCapabilities.length > 0) {
        const matchScore = matchedCapabilities.length / requiredCapabilities.length;
        collaborators.push({
          id: agent.id,
          name: agent.name,
          matchScore,
        });
      }
    }

    // Sort by match score (highest first)
    collaborators.sort((a, b) => b.matchScore - a.matchScore);

    return collaborators;
  }

  // ========================================================================
  // Emergency Collaboration
  // ========================================================================

  /**
   * Initiate emergency collaboration
   * Automatically broadcasts to all relevant agents
   *
   * Bug #2 Fix: Properly track AC state lifecycle to keep sessions active
   */
  initiateEmergencyCollaboration(
    initiatorAgentId: string,
    emergencyType: 'cooling-failure' | 'fire' | 'security-breach' | 'power-outage',
    description: string,
    participantAgentIds: string[]
  ): CollaborationSession {
    logger.info(`EMERGENCY collaboration initiated by ${initiatorAgentId}`);
    logger.info(`  Type: ${emergencyType}`);
    logger.info(`  Participants: ${participantAgentIds.length} agents`);

    const session = this.createSession(
      'emergency-response',
      participantAgentIds,
      initiatorAgentId,
      CollaborationPriority.CRITICAL,
      `EMERGENCY: ${description}`,
      [],
      300000 // 5 minutes
    );

    // Bug #2 Fix: Track AC state lifecycle
    // CREATED -> INITIALIZING -> READY -> RUNNING
    this.trackACState(session.id, ACState.CREATED, 'Emergency collaboration session created');

    // Transition to INITIALIZING
    this.trackACState(session.id, ACState.INITIALIZING, 'Notifying participants');

    // Add emergency alert message
    this.addMessage(
      session.id,
      initiatorAgentId,
      `EMERGENCY ALERT: ${description}. All agents respond immediately.`,
      'alert'
    );

    // Bug #2 Fix: Transition to READY status after alert sent
    this.trackACState(session.id, ACState.READY, 'Alert sent to participants');

    // Bug #2 Fix: Update session status to IN_PROGRESS to keep it active
    // This prevents the session from being considered "completed" immediately
    this.updateSessionStatus(session.id, CollaborationStatus.IN_PROGRESS);

    // Bug #2 Fix: Transition to RUNNING state
    this.trackACState(session.id, ACState.RUNNING, 'Collaboration in progress');

    logger.info(`Emergency session ${session.id} is now active and running`);

    return session;
  }

  // ========================================================================
  // History & Statistics
  // ========================================================================

  /**
   * Get collaboration history for an agent
   */
  getAgentHistory(agentId: string): CollaborationSession[] {
    return this.sessionHistory.filter((session) =>
      session.participants.includes(agentId)
    );
  }

  /**
   * Get collaboration statistics
   */
  getStatistics(agentId?: string): {
    totalSessions: number;
    completedSessions: number;
    failedSessions: number;
    activeSessions: number;
    avgCompletionTime?: number;
  } {
    const history = agentId
      ? this.getAgentHistory(agentId)
      : this.sessionHistory;

    const completed = history.filter(
      (s) => s.status === CollaborationStatus.COMPLETED
    ).length;
    const failed = history.filter(
      (s) => s.status === CollaborationStatus.FAILED
    ).length;

    const stats: {
      totalSessions: number;
      completedSessions: number;
      failedSessions: number;
      activeSessions: number;
      avgCompletionTime?: number;
    } = {
      totalSessions: history.length,
      completedSessions: completed,
      failedSessions: failed,
      activeSessions: this.activeSessions.size,
    };

    // Calculate average completion time
    const completedSessionsData = history.filter(
      (s) => s.status === CollaborationStatus.COMPLETED
    );
    if (completedSessionsData.length > 0) {
      const totalTime = completedSessionsData.reduce(
        (sum, s) => sum + (s.updatedAt.getTime() - s.createdAt.getTime()),
        0
      );
      stats.avgCompletionTime = totalTime / completedSessionsData.length;
    }

    return stats;
  }

  /**
   * Cleanup expired sessions
   */
  cleanupExpiredSessions(): void {
    const now = new Date();
    let cleaned = 0;

    for (const [sessionId, session] of this.activeSessions) {
      if (session.expiresAt && session.expiresAt < now) {
        logger.info(`Session expired: ${sessionId}`);
        this.updateSessionStatus(sessionId, CollaborationStatus.CANCELLED);
        cleaned++;
      }
    }

    // Cleanup expired pending requests
    for (const [requestId, request] of this.pendingRequests) {
      if (request.expiresAt && request.expiresAt < now) {
        logger.info(`Request expired: ${requestId}`);
        this.pendingRequests.delete(requestId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} expired sessions/requests`);
    }
  }

  // ========================================================================
  // AC Lifecycle State Tracking
  // ========================================================================

  /**
   * Track AC state transition for a collaboration
   * @param collaborationId - Collaboration/session ID
   * @param newState - New AC state
   * @param reason - Optional reason for state change
   */
  async trackACState(
    collaborationId: string,
    newState: ACState,
    reason?: string,
    options?: { triggeredBy?: string; metadata?: Record<string, any> }
  ): Promise<void> {
    const transitions = this.acStateTransitions.get(collaborationId) || [];

    const lastTransition = transitions[transitions.length - 1];
    const fromState = lastTransition ? lastTransition.to : ACState.CREATED;

    const transition: ACStateTransition = {
      from: fromState,
      to: newState,
      timestamp: new Date(),
      reason,
      triggeredBy: options?.triggeredBy,
      metadata: options?.metadata,
    };

    transitions.push(transition);
    this.acStateTransitions.set(collaborationId, transitions);

    logger.info(`AC state tracked: ${collaborationId} ${fromState} -> ${newState}`);

    // Publish event for visualization and monitoring
    this.eventManager.publish({
      type: EventType.CUSTOM,
      source: `CollaborationManager`,
      payload: {
        collaborationId,
        from: fromState,
        to: newState,
        reason,
        triggeredBy: options?.triggeredBy,
        metadata: options?.metadata,
        customType: 'AC_STATE_CHANGED',
      },
      priority: EventPriority.NORMAL,
      metadata: {},
    });
  }

  /**
   * Get AC state transition history for a collaboration
   * @param collaborationId - Collaboration/session ID
   * @returns Array of state transitions
   */
  getACStateHistory(collaborationId: string): ACStateTransition[] {
    return this.acStateTransitions.get(collaborationId) || [];
  }

  /**
   * Get current AC state for a collaboration
   * @param collaborationId - Collaboration/session ID
   * @returns Current AC state or undefined if no history
   */
  getCurrentACState(collaborationId: string): ACState | undefined {
    const transitions = this.acStateTransitions.get(collaborationId);
    return transitions ? transitions[transitions.length - 1].to : undefined;
  }

  /**
   * Get all collaborations in a specific AC state
   * @param state - AC state to filter by
   * @returns Array of collaboration IDs in the specified state
   */
  getCollaborationsByACState(state: ACState): string[] {
    const results: string[] = [];

    for (const [collaborationId, transitions] of this.acStateTransitions.entries()) {
      const current = transitions[transitions.length - 1];
      if (current && current.to === state) {
        results.push(collaborationId);
      }
    }

    return results;
  }

  /**
   * Get all AC state transitions across all collaborations
   * @returns Map of collaboration ID to state transitions
   */
  getAllACStateTransitions(): Map<string, ACStateTransition[]> {
    return new Map(this.acStateTransitions);
  }

  // ========================================================================
  // Agent Withdrawal Mechanism
  // ========================================================================

  /**
   * Request to withdraw from a collaboration
   * Agent autonomously decides to leave an AC
   */
  requestWithdrawal(params: {
    collaborationId: string;
    agentId: string;
    agentName: string;
    reason: string;
    gracefulPeriod?: number; // default 30 seconds
    taskHandoff?: WithdrawalRequest['taskHandoff'];
  }): WithdrawalRequest {
    logger.info(`Withdrawal request from ${params.agentName}`);
    logger.info(`  Collaboration: ${params.collaborationId}`);
    logger.info(`  Reason: ${params.reason}`);

    const request: WithdrawalRequest = {
      id: uuidv4(),
      collaborationId: params.collaborationId,
      agentId: params.agentId,
      agentName: params.agentName,
      reason: params.reason,
      gracefulPeriod: params.gracefulPeriod || 30000, // default 30 seconds
      timestamp: new Date(),
      status: 'pending',
      taskHandoff: params.taskHandoff,
    };

    this.withdrawalRequests.set(request.id, request);

    // Publish withdrawal request event
    this.eventManager.publish({
      type: EventType.CUSTOM,
      source: `Agent:${params.agentId}`,
      payload: {
        withdrawalId: request.id,
        collaborationId: params.collaborationId,
        agentId: params.agentId,
        agentName: params.agentName,
        reason: params.reason,
        gracefulPeriod: request.gracefulPeriod,
        customType: 'AC_WITHDRAWAL_REQUESTED',
      },
      priority: EventPriority.HIGH,
      metadata: {},
    });

    return request;
  }

  /**
   * Process withdrawal request
   * Called when withdrawal period expires or is explicitly processed
   */
  async processWithdrawal(withdrawalId: string): Promise<{
    success: boolean;
    session?: CollaborationSession;
    error?: string;
  }> {
    const request = this.withdrawalRequests.get(withdrawalId);
    if (!request) {
      return { success: false, error: 'Withdrawal request not found' };
    }

    const session = this.activeSessions.get(request.collaborationId);
    if (!session) {
      return { success: false, error: 'Collaboration session not found' };
    }

    logger.info(`Processing withdrawal: ${request.agentName} from ${request.collaborationId}`);

    // Remove agent from participants
    const previousParticipants = [...session.participants];
    session.participants = session.participants.filter(id => id !== request.agentId);

    // Check if collaboration can continue
    if (session.participants.length < 2) {
      logger.info(`Cannot continue: only ${session.participants.length} participant(s) remaining`);
      request.status = 'completed';
      this.updateSessionStatus(session.id, CollaborationStatus.CANCELLED);

      // Track AC state
      await this.trackACState(session.id, ACState.TERMINATED, `Agent ${request.agentName} withdrew, insufficient participants`);

      return {
        success: true,
        session,
        error: 'Collaboration cancelled due to insufficient participants',
      };
    }

    // Update session
    session.updatedAt = new Date();
    request.status = 'completed';

    // Add notification message
    this.addMessage(
      session.id,
      request.agentId,
      `Agent ${request.agentName} has withdrawn from collaboration. Reason: ${request.reason}`,
      'notification'
    );

    // Track AC state
    await this.trackACState(session.id, ACState.RUNNING, `Agent ${request.agentName} withdrew, continuing with remaining participants`);

    // Publish withdrawal completed event
    this.eventManager.publish({
      type: EventType.CUSTOM,
      source: 'CollaborationManager',
      payload: {
        withdrawalId,
        collaborationId: session.id,
        previousParticipants,
        currentParticipants: session.participants,
        withdrawnAgent: request.agentId,
        customType: 'AC_WITHDRAWAL_COMPLETED',
      },
      priority: EventPriority.NORMAL,
      metadata: {},
    });

    logger.info(`Withdrawal complete. Remaining participants: ${session.participants.length}`);

    return { success: true, session };
  }

  /**
   * Get pending withdrawal requests for a collaboration
   */
  getPendingWithdrawals(collaborationId: string): WithdrawalRequest[] {
    return Array.from(this.withdrawalRequests.values()).filter(
      r => r.collaborationId === collaborationId && r.status === 'pending'
    );
  }

  /**
   * Get all withdrawal requests for an agent
   */
  getAgentWithdrawals(agentId: string): WithdrawalRequest[] {
    return Array.from(this.withdrawalRequests.values()).filter(
      r => r.agentId === agentId
    );
  }

  // ========================================================================
  // Dissolution Proposal Mechanism
  // ========================================================================

  /**
   * Propose dissolution of a collaboration
   * Agents can vote on whether to dissolve the AC
   */
  proposeDissolution(params: {
    collaborationId: string;
    proposerId: string;
    proposerName: string;
    reason: string;
    voteThreshold?: number; // default 51%
    expiresIn?: number; // milliseconds, default 5 minutes
  }): DissolutionProposal {
    logger.info(`Dissolution proposed by ${params.proposerName}`);
    logger.info(`  Collaboration: ${params.collaborationId}`);
    logger.info(`  Reason: ${params.reason}`);

    const session = this.activeSessions.get(params.collaborationId);
    if (!session) {
      throw new Error(`Collaboration session not found: ${params.collaborationId}`);
    }

    const proposal: DissolutionProposal = {
      id: uuidv4(),
      collaborationId: params.collaborationId,
      proposerId: params.proposerId,
      proposerName: params.proposerName,
      reason: params.reason,
      voteThreshold: params.voteThreshold || 51, // default simple majority
      votes: new Map(),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + (params.expiresIn || 300000)), // default 5 minutes
      status: 'pending',
    };

    // Proposer automatically votes yes
    proposal.votes.set(params.proposerId, true);

    this.dissolutionProposals.set(proposal.id, proposal);

    // Publish dissolution proposal event
    this.eventManager.publish({
      type: EventType.CUSTOM,
      source: `Agent:${params.proposerId}`,
      payload: {
        proposalId: proposal.id,
        collaborationId: params.collaborationId,
        proposerId: params.proposerId,
        proposerName: params.proposerName,
        reason: params.reason,
        voteThreshold: proposal.voteThreshold,
        expiresAt: proposal.expiresAt,
        customType: 'AC_DISSOLUTION_PROPOSED',
      },
      priority: EventPriority.HIGH,
      metadata: {},
    });

    return proposal;
  }

  /**
   * Vote on a dissolution proposal
   */
  voteOnDissolution(params: {
    proposalId: string;
    agentId: string;
    vote: boolean;
  }): {
    success: boolean;
    proposal?: DissolutionProposal;
    result?: 'approved' | 'rejected' | 'pending';
    error?: string;
  } {
    const proposal = this.dissolutionProposals.get(params.proposalId);
    if (!proposal) {
      return { success: false, error: 'Proposal not found' };
    }

    if (proposal.status !== 'pending') {
      return { success: false, error: `Proposal already ${proposal.status}` };
    }

    if (new Date() > proposal.expiresAt) {
      proposal.status = 'expired';
      return { success: false, error: 'Proposal has expired', proposal };
    }

    const session = this.activeSessions.get(proposal.collaborationId);
    if (!session) {
      return { success: false, error: 'Collaboration session not found' };
    }

    // Check if agent is a participant
    if (!session.participants.includes(params.agentId)) {
      return { success: false, error: 'Agent is not a participant in this collaboration' };
    }

    // Record vote
    proposal.votes.set(params.agentId, params.vote);
    logger.info(`Vote recorded: ${params.agentId} -> ${params.vote ? 'YES' : 'NO'}`);

    // Calculate result
    const totalParticipants = session.participants.length;
    const yesVotes = Array.from(proposal.votes.values()).filter(v => v).length;
    const votePercentage = (yesVotes / totalParticipants) * 100;

    logger.info(`Vote tally: ${yesVotes}/${totalParticipants} (${votePercentage.toFixed(1)}%)`);

    // Check if threshold met
    if (votePercentage >= proposal.voteThreshold) {
      proposal.status = 'approved';
      logger.info(`Dissolution approved! Threshold met: ${votePercentage.toFixed(1)}% >= ${proposal.voteThreshold}%`);

      // Dissolve the collaboration
      this.updateSessionStatus(session.id, CollaborationStatus.COMPLETED);

      // Track AC state
      this.trackACState(session.id, ACState.COMPLETED, `Dissolution approved by vote: ${yesVotes}/${totalParticipants}`);

      return { success: true, proposal, result: 'approved' };
    }

    // Check if dissolution is impossible (not enough remaining votes)
    const remainingVotes = totalParticipants - proposal.votes.size;
    const maxPossibleYes = yesVotes + remainingVotes;
    const maxPossiblePercentage = (maxPossibleYes / totalParticipants) * 100;

    if (maxPossiblePercentage < proposal.voteThreshold) {
      proposal.status = 'rejected';
      logger.info(`Dissolution rejected. Max possible: ${maxPossiblePercentage.toFixed(1)}% < ${proposal.voteThreshold}%`);
      return { success: true, proposal, result: 'rejected' };
    }

    return { success: true, proposal, result: 'pending' };
  }

  /**
   * Get pending dissolution proposals for a collaboration
   */
  getPendingDissolutionProposals(collaborationId: string): DissolutionProposal[] {
    return Array.from(this.dissolutionProposals.values()).filter(
      p => p.collaborationId === collaborationId && p.status === 'pending'
    );
  }

  /**
   * Get all dissolution proposals
   */
  getAllDissolutionProposals(): DissolutionProposal[] {
    return Array.from(this.dissolutionProposals.values());
  }

  /**
   * Cleanup expired dissolution proposals
   */
  cleanupExpiredDissolutionProposals(): number {
    let cleaned = 0;
    const now = new Date();

    for (const [id, proposal] of this.dissolutionProposals) {
      if (proposal.status === 'pending' && now > proposal.expiresAt) {
        proposal.status = 'expired';
        cleaned++;
        logger.info(`Dissolution proposal expired: ${id}`);
      }
    }

    return cleaned;
  }

  // ========================================================================
  // Timeout Handling Mechanism
  // ========================================================================

  /**
   * Set forming timeout for a collaboration
   * Automatically transitions to FAILED if participants don't join within timeout
   *
   * @param sessionId - Collaboration session ID
   * @param timeoutMs - Timeout in milliseconds
   */
  setFormingTimeout(sessionId: string, timeoutMs: number): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      logger.warn(`Session not found: ${sessionId}`);
      return;
    }

    logger.info(`Setting forming timeout for ${sessionId}: ${timeoutMs}ms`);

    // Clear existing timeout if any
    const existingTimeout = this.formingTimeouts.get(sessionId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Store timeout metadata
    this.formingTimeoutTimers.set(sessionId, {
      timeout: timeoutMs,
      startTime: new Date(),
    });

    // Set new timeout
    const timeout = setTimeout(async () => {
      const currentState = this.getCurrentACState(sessionId);

      // Only timeout if still in FORMING state
      if (currentState === ACState.FORMING) {
        logger.info(`Forming timeout reached for ${sessionId}`);

        await this.trackACState(
          sessionId,
          ACState.FAILED,
          `Forming timeout: participants did not join within ${timeoutMs}ms`
        );

        // Update session status
        this.updateSessionStatus(sessionId, CollaborationStatus.FAILED);

        // Publish timeout event
        this.eventManager.publish({
          type: EventType.CUSTOM,
          source: 'CollaborationManager',
          payload: {
            collaborationId: sessionId,
            timeout: timeoutMs,
            reason: 'Participants did not join within deadline',
            customType: 'AC_FORMING_TIMEOUT',
          },
          priority: EventPriority.HIGH,
          metadata: {},
        });
      }

      this.formingTimeouts.delete(sessionId);
      this.formingTimeoutTimers.delete(sessionId);
    }, timeoutMs);

    this.formingTimeouts.set(sessionId, timeout);
  }

  /**
   * Cancel forming timeout (when all participants join)
   *
   * @param sessionId - Collaboration session ID
   */
  private cancelFormingTimeout(sessionId: string): void {
    const timeout = this.formingTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.formingTimeouts.delete(sessionId);
      this.formingTimeoutTimers.delete(sessionId);
      logger.info(`Forming timeout cancelled for ${sessionId}`);
    }
  }

  // ========================================================================
  // Error Recovery Mechanism
  // ========================================================================

  /**
   * Report an error in AC execution
   * Handles both critical and recoverable errors
   *
   * @param sessionId - Collaboration session ID
   * @param error - Error details
   * @returns Whether recovery was attempted
   */
  async reportACError(
    sessionId: string,
    error: Omit<ACError, 'timestamp' | 'recovered'>
  ): Promise<boolean> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      logger.warn(`Session not found: ${sessionId}`);
      return false;
    }

    logger.info(`Error reported for ${sessionId}:`, error.message);

    // Record error
    const errorRecord: ACError = {
      ...error,
      timestamp: new Date(),
      recovered: false,
    };

    const errors = this.acErrors.get(sessionId) || [];
    errors.push(errorRecord);
    this.acErrors.set(sessionId, errors);

    // Publish error event
    this.eventManager.publish({
      type: EventType.SYSTEM_ERROR,
      source: 'CollaborationManager',
      payload: {
        collaborationId: sessionId,
        error: errorRecord,
        customType: 'AC_ERROR_OCCURRED',
      },
      priority: EventPriority.HIGH,
      metadata: {},
    });

    // Handle error based on type
    if (error.type === 'critical' && !error.recoverable) {
      // Critical non-recoverable error: transition to FAILED
      logger.info(`Critical error, transitioning to FAILED`);

      await this.trackACState(
        sessionId,
        ACState.FAILED,
        `Critical error: ${error.message}`
      );

      this.updateSessionStatus(sessionId, CollaborationStatus.FAILED);

      return false;
    }

    // Recoverable error: attempt recovery
    if (error.recoverable) {
      logger.info(`Recoverable error, attempting recovery`);

      // Mark as recovered (in real implementation, would attempt actual recovery)
      errorRecord.recovered = true;

      // Publish recovery event
      this.eventManager.publish({
        type: EventType.CUSTOM,
        source: 'CollaborationManager',
        payload: {
          collaborationId: sessionId,
          error: errorRecord,
          recoveryStrategy: error.recoveryStrategy,
          customType: 'AC_ERROR_RECOVERED',
        },
        priority: EventPriority.NORMAL,
        metadata: {},
      });

      return true;
    }

    return false;
  }

  /**
   * Get all errors for a collaboration
   *
   * @param sessionId - Collaboration session ID
   * @returns Array of errors
   */
  getACErrors(sessionId: string): ACError[] {
    return this.acErrors.get(sessionId) || [];
  }

  /**
   * Track an AC operation
   *
   * @param sessionId - Collaboration session ID
   * @param operation - Operation details
   */
  trackACOperation(sessionId: string, operation: Omit<ACOperation, 'timestamp'>): void {
    const operationRecord: ACOperation = {
      ...operation,
      timestamp: new Date(),
    };

    const operations = this.acOperations.get(sessionId) || [];
    operations.push(operationRecord);
    this.acOperations.set(sessionId, operations);

    logger.info(`Operation tracked: ${operation.id} (${operation.status})`);
  }

  /**
   * Get all operations for a collaboration
   *
   * @param sessionId - Collaboration session ID
   * @returns Array of operations
   */
  getACOperations(sessionId: string): ACOperation[] {
    return this.acOperations.get(sessionId) || [];
  }

  /**
   * Retry a failed operation
   *
   * @param sessionId - Collaboration session ID
   * @param operationId - Operation ID to retry
   * @returns Retry result
   */
  async retryACOperation(
    sessionId: string,
    operationId: string
  ): Promise<{ success: boolean; retryCount: number; error?: string }> {
    const operations = this.acOperations.get(sessionId);
    if (!operations) {
      return { success: false, retryCount: 0, error: 'Session not found' };
    }

    const operation = operations.find(o => o.id === operationId);
    if (!operation) {
      return { success: false, retryCount: 0, error: 'Operation not found' };
    }

    if (operation.retryCount >= operation.maxRetries) {
      return { success: false, retryCount: operation.retryCount, error: 'Max retries exceeded' };
    }

    // Increment retry count
    operation.retryCount++;
    operation.status = 'pending';
    operation.error = undefined;

    logger.info(`Retrying operation ${operationId} (attempt ${operation.retryCount}/${operation.maxRetries})`);

    return { success: true, retryCount: operation.retryCount };
  }

  // ========================================================================
  // Completion Condition Checking
  // ========================================================================

  /**
   * Set completion criteria for a collaboration
   *
   * @param sessionId - Collaboration session ID
   * @param criteria - Completion criteria
   */
  setACCompletionCriteria(sessionId: string, criteria: ACCompletionCriteria): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      logger.warn(`Session not found: ${sessionId}`);
      return;
    }

    this.acCompletionCriteria.set(sessionId, criteria);
    logger.info(`Completion criteria set for ${sessionId}: ${criteria.type}`);
  }

  /**
   * Update a goal's status
   *
   * @param sessionId - Collaboration session ID
   * @param goalId - Goal ID
   * @param updates - Goal updates
   */
  updateACGoal(
    sessionId: string,
    goalId: string,
    updates: { achieved?: boolean; failed?: boolean }
  ): void {
    const criteria = this.acCompletionCriteria.get(sessionId);
    if (!criteria || !criteria.goals) {
      logger.warn(`No completion criteria or goals for ${sessionId}`);
      return;
    }

    const goal = criteria.goals.find(g => g.id === goalId);
    if (!goal) {
      logger.warn(`Goal not found: ${goalId}`);
      return;
    }

    if (updates.achieved !== undefined) {
      goal.achieved = updates.achieved;
    }
    if (updates.failed !== undefined) {
      goal.failed = updates.failed;
    }

    logger.info(`Goal ${goalId} updated: achieved=${goal.achieved}, failed=${goal.failed}`);
  }

  /**
   * Check completion status and transition if ready
   *
   * @param sessionId - Collaboration session ID
   * @returns Completion status
   */
  async checkACCompletion(sessionId: string): Promise<{
    allGoalsAchieved: boolean;
    readyToComplete: boolean;
    partialCompletion?: boolean;
    failedGoals?: string[];
  }> {
    const criteria = this.acCompletionCriteria.get(sessionId);
    if (!criteria) {
      return { allGoalsAchieved: false, readyToComplete: false };
    }

    const result = {
      allGoalsAchieved: false,
      readyToComplete: false,
      partialCompletion: false,
      failedGoals: [] as string[],
    };

    if (criteria.type === 'all-goals-achieved' && criteria.goals) {
      const achievedGoals = criteria.goals.filter(g => g.achieved);
      const failedGoals = criteria.goals.filter(g => g.failed);

      result.allGoalsAchieved = achievedGoals.length === criteria.goals.length;
      result.failedGoals = failedGoals.map(g => g.id);
      result.partialCompletion = achievedGoals.length > 0 && !result.allGoalsAchieved;
      result.readyToComplete = result.allGoalsAchieved;

      // Auto-transition to COMPLETING if all goals achieved
      if (result.allGoalsAchieved) {
        const currentState = this.getCurrentACState(sessionId);
        if (currentState === ACState.RUNNING) {
          logger.info(`All goals achieved, transitioning to COMPLETING`);
          await this.trackACState(sessionId, ACState.COMPLETING, 'All goals achieved');
        }
      }
    }

    return result;
  }

  /**
   * Finalize a collaboration
   *
   * @param sessionId - Collaboration session ID
   * @param results - Finalization results
   */
  async finalizeAC(
    sessionId: string,
    results: {
      success: boolean;
      results?: any;
    }
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      logger.warn(`Session not found: ${sessionId}`);
      return;
    }

    logger.info(`Finalizing collaboration ${sessionId}`);

    const finalState = results.success ? ACState.COMPLETED : ACState.FAILED;
    const reason = results.success
      ? 'Collaboration completed successfully'
      : 'Collaboration failed';

    await this.trackACState(sessionId, finalState, reason);

    // Update session status
    this.updateSessionStatus(
      sessionId,
      results.success ? CollaborationStatus.COMPLETED : CollaborationStatus.FAILED
    );

    // Publish completion event
    this.eventManager.publish({
      type: EventType.COLLABORATION_COMPLETED,
      source: 'CollaborationManager',
      payload: {
        collaborationId: sessionId,
        success: results.success,
        results: results.results,
        finalState,
        customType: 'AC_FINALIZED',
      },
      priority: EventPriority.HIGH,
      metadata: {},
    });
  }
}
