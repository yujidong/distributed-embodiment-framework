/**
 * AC State Transitions Tests - Critical Bug Fix
 *
 * Problem: AC sessions stuck in "forming" status forever
 * Root Cause: Missing complete state transition mechanism
 *
 * Missing Features:
 * 1. Timeout handling (forming timeout)
 * 2. Error recovery mechanism
 * 3. Completion condition checking
 * 4. State transition events
 *
 * TDD Approach: RED-GREEN-REFACTOR
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CollaborationManager, ACState, CollaborationStatus, CollaborationPriority } from '../CollaborationManager.js';
import { EventManager } from '../../events/index.js';
import { EventPriority, EventType } from '@active-collaboration/shared';
import type { SystemEvent } from '@active-collaboration/shared';

describe('AC State Transitions - Critical Bug Fix', () => {
  let collaborationManager: CollaborationManager;
  let eventManager: EventManager;

  beforeEach(() => {
    eventManager = new EventManager(1000);
    collaborationManager = new CollaborationManager();
    collaborationManager.eventManager = eventManager;
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('RED Phase: Missing Timeout Handling', () => {
    it('should timeout FORMING state if participants do not join within deadline', async () => {
      /**
       * Test: AC should automatically transition to FAILED if stuck in FORMING
       * Current State: FAILS - no timeout mechanism exists
       */
      const session = collaborationManager.createSession(
        'service-composition',
        [],
        'agent-initiator',
        CollaborationPriority.HIGH,
        'Timeout test',
        []
      );

      // Initialize in FORMING state with expected participants
      await collaborationManager.trackACState(session.id, ACState.FORMING, 'Waiting for participants');
      collaborationManager.setExpectedParticipants(session.id, ['agent-1', 'agent-2']);

      // Activate fake timers BEFORE scheduling the timeout
      vi.useFakeTimers();

      // Set forming timeout (e.g., 5 seconds)
      const timeoutMs = 5000;
      collaborationManager.setFormingTimeout(session.id, timeoutMs);

      // Advance time past timeout
      vi.advanceTimersByTime(timeoutMs + 1000);

      // State should have transitioned to FAILED due to timeout
      const currentState = collaborationManager.getCurrentACState(session.id);
      expect(currentState).toBe(ACState.FAILED);

      // Should have timeout reason recorded
      const history = collaborationManager.getACStateHistory(session.id);
      const timeoutTransition = history.find(t => t.to === ACState.FAILED);
      expect(timeoutTransition?.reason).toContain('timeout');

      vi.useRealTimers();
    });

    it('should cancel timeout when all participants join', async () => {
      /**
       * Test: Timeout should be cancelled when AC transitions out of FORMING
       * Current State: FAILS - no timeout cancellation mechanism
       */
      const session = collaborationManager.createSession(
        'service-composition',
        [],
        'agent-initiator',
        CollaborationPriority.HIGH,
        'Timeout cancellation test',
        []
      );

      await collaborationManager.trackACState(session.id, ACState.FORMING, 'Waiting');
      collaborationManager.setExpectedParticipants(session.id, ['agent-1']);

      // Activate fake timers BEFORE scheduling the timeout so setTimeout is captured
      vi.useFakeTimers();

      collaborationManager.setFormingTimeout(session.id, 5000);

      // Participant joins before timeout
      collaborationManager.addParticipant(session.id, 'agent-1', {
        role: 'participant',
        capabilities: []
      });

      // State should be READY (not FAILED)
      const currentState = collaborationManager.getCurrentACState(session.id);
      expect(currentState).toBe(ACState.READY);

      // Advance time past original timeout
      vi.advanceTimersByTime(6000);

      // Should still be READY (timeout was cancelled)
      const stateAfterTimeout = collaborationManager.getCurrentACState(session.id);
      expect(stateAfterTimeout).toBe(ACState.READY);

      vi.useRealTimers();
    });
  });

  describe('RED Phase: Missing Error Recovery', () => {
    it('should transition to FAILED state on critical error', async () => {
      /**
       * Test: AC should handle errors and transition to FAILED state
       * Current State: FAILS - no error handling mechanism
       */
      const session = collaborationManager.createSession(
        'service-composition',
        ['agent-1'],
        'agent-initiator',
        CollaborationPriority.HIGH,
        'Error recovery test',
        []
      );

      await collaborationManager.trackACState(session.id, ACState.RUNNING, 'In progress');

      // Report critical error
      await collaborationManager.reportACError(session.id, {
        type: 'critical',
        message: 'Agent communication failure',
        agentId: 'agent-1',
        recoverable: false,
      });

      // Should transition to FAILED
      const currentState = collaborationManager.getCurrentACState(session.id);
      expect(currentState).toBe(ACState.FAILED);

      // Error should be recorded
      const errors = collaborationManager.getACErrors(session.id);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Agent communication failure');
    });

    it('should attempt automatic recovery for recoverable errors', async () => {
      /**
       * Test: AC should attempt recovery for recoverable errors
       * Current State: FAILS - no recovery mechanism
       */
      const session = collaborationManager.createSession(
        'service-composition',
        ['agent-1', 'agent-2'],
        'agent-initiator',
        CollaborationPriority.HIGH,
        'Recovery test',
        []
      );

      await collaborationManager.trackACState(session.id, ACState.RUNNING, 'In progress');

      // Report recoverable error
      const recoveryAttempted = await collaborationManager.reportACError(session.id, {
        type: 'recoverable',
        message: 'Agent temporarily unavailable',
        agentId: 'agent-1',
        recoverable: true,
        recoveryStrategy: 'retry',
      });

      // Should attempt recovery
      expect(recoveryAttempted).toBe(true);

      // Should NOT transition to FAILED
      const currentState = collaborationManager.getCurrentACState(session.id);
      expect(currentState).toBe(ACState.RUNNING);

      // Error should be logged but AC continues
      const errors = collaborationManager.getACErrors(session.id);
      expect(errors).toHaveLength(1);
    });

    it('should support retry mechanism for failed operations', async () => {
      /**
       * Test: AC should support retrying failed operations
       * Current State: FAILS - no retry mechanism
       */
      const session = collaborationManager.createSession(
        'service-composition',
        ['agent-1'],
        'agent-initiator',
        CollaborationPriority.HIGH,
        'Retry test',
        []
      );

      await collaborationManager.trackACState(session.id, ACState.RUNNING, 'In progress');

      // Track a failed operation
      collaborationManager.trackACOperation(session.id, {
        id: 'op-1',
        type: 'device-control',
        agentId: 'agent-1',
        status: 'failed',
        retryCount: 0,
        maxRetries: 3,
      });

      // Attempt retry
      const retryResult = await collaborationManager.retryACOperation(session.id, 'op-1');

      expect(retryResult.success).toBe(true);
      expect(retryResult.retryCount).toBe(1);

      // Operation should be marked for retry
      const operations = collaborationManager.getACOperations(session.id);
      const op = operations.find(o => o.id === 'op-1');
      expect(op?.status).toBe('pending');
      expect(op?.retryCount).toBe(1);
    });
  });

  describe('RED Phase: Missing Completion Condition Checking', () => {
    it('should check completion conditions and transition to COMPLETING', async () => {
      /**
       * Test: AC should automatically check if goals are achieved
       * Current State: FAILS - no completion checking mechanism
       */
      const session = collaborationManager.createSession(
        'service-composition',
        ['agent-1'],
        'agent-initiator',
        CollaborationPriority.HIGH,
        'Completion test',
        []
      );

      await collaborationManager.trackACState(session.id, ACState.RUNNING, 'In progress');

      // Set completion criteria
      collaborationManager.setACCompletionCriteria(session.id, {
        type: 'all-goals-achieved',
        goals: [
          { id: 'goal-1', description: 'Task 1', achieved: false },
          { id: 'goal-2', description: 'Task 2', achieved: false },
        ],
      });

      // Mark goals as achieved
      collaborationManager.updateACGoal(session.id, 'goal-1', { achieved: true });
      collaborationManager.updateACGoal(session.id, 'goal-2', { achieved: true });

      // Trigger completion check
      const completionStatus = await collaborationManager.checkACCompletion(session.id);

      expect(completionStatus.allGoalsAchieved).toBe(true);
      expect(completionStatus.readyToComplete).toBe(true);

      // Should automatically transition to COMPLETING
      const currentState = collaborationManager.getCurrentACState(session.id);
      expect(currentState).toBe(ACState.COMPLETING);
    });

    it('should transition to COMPLETED after finalizing', async () => {
      /**
       * Test: AC should finalize and transition to COMPLETED
       * Current State: FAILS - no finalization mechanism
       */
      const session = collaborationManager.createSession(
        'service-composition',
        ['agent-1'],
        'agent-initiator',
        CollaborationPriority.HIGH,
        'Finalization test',
        []
      );

      await collaborationManager.trackACState(session.id, ACState.COMPLETING, 'Finalizing');

      // Finalize collaboration
      await collaborationManager.finalizeAC(session.id, {
        success: true,
        results: {
          goalsAchieved: 2,
          goalsTotal: 2,
          duration: 5000,
        },
      });

      // Should transition to COMPLETED
      const currentState = collaborationManager.getCurrentACState(session.id);
      expect(currentState).toBe(ACState.COMPLETED);

      // Session should be marked as completed (use findSessionAnywhere since completed sessions are moved to history)
      const completedSession = collaborationManager.findSessionAnywhere(session.id);
      expect(completedSession?.status).toBe(CollaborationStatus.COMPLETED);
    });

    it('should handle partial completion (some goals failed)', async () => {
      /**
       * Test: AC should handle scenarios where some goals fail
       * Current State: FAILS - no partial completion handling
       */
      const session = collaborationManager.createSession(
        'service-composition',
        ['agent-1'],
        'agent-initiator',
        CollaborationPriority.HIGH,
        'Partial completion test',
        []
      );

      await collaborationManager.trackACState(session.id, ACState.RUNNING, 'In progress');

      collaborationManager.setACCompletionCriteria(session.id, {
        type: 'all-goals-achieved',
        goals: [
          { id: 'goal-1', description: 'Task 1', achieved: false },
          { id: 'goal-2', description: 'Task 2', achieved: false },
        ],
      });

      // Only one goal achieved
      collaborationManager.updateACGoal(session.id, 'goal-1', { achieved: true });
      collaborationManager.updateACGoal(session.id, 'goal-2', { achieved: false, failed: true });

      const completionStatus = await collaborationManager.checkACCompletion(session.id);

      expect(completionStatus.allGoalsAchieved).toBe(false);
      expect(completionStatus.partialCompletion).toBe(true);
      expect(completionStatus.failedGoals).toContain('goal-2');
    });
  });

  describe('RED Phase: Missing State Transition Events', () => {
    it('should emit events on state transitions', async () => {
      /**
       * Test: State transitions should emit events for monitoring
       * Current State: FAILS - no event emission on transitions
       */
      const session = collaborationManager.createSession(
        'service-composition',
        ['agent-1'],
        'agent-initiator',
        CollaborationPriority.HIGH,
        'Event test',
        []
      );

      // Subscribe to state transition events
      // Source publishes EventType.CUSTOM with customType: 'AC_STATE_CHANGED' in payload,
      // so we subscribe to EventType.CUSTOM and filter by customType in the handler.
      const transitionEvents: SystemEvent[] = [];
      eventManager.subscribe({
        subscriberId: 'test-monitor',
        eventType: EventType.CUSTOM,
        handler: (event) => {
          if (event.payload?.customType === 'AC_STATE_CHANGED') {
            transitionEvents.push(event);
          }
        },
        priority: EventPriority.NORMAL,
      });

      // Trigger state transitions
      await collaborationManager.trackACState(session.id, ACState.FORMING, 'Starting');
      await collaborationManager.trackACState(session.id, ACState.READY, 'Ready');

      // Should have emitted events
      expect(transitionEvents.length).toBeGreaterThanOrEqual(2);

      const readyEvent = transitionEvents.find(
        (e) => e.payload?.to === ACState.READY
      );
      expect(readyEvent).toBeDefined();
      expect(readyEvent.payload.collaborationId).toBe(session.id);
      expect(readyEvent.payload.from).toBe(ACState.FORMING);
      expect(readyEvent.payload.to).toBe(ACState.READY);
    });

    it('should emit detailed events with transition metadata', async () => {
      /**
       * Test: Events should include detailed metadata
       * Current State: FAILS - events lack detailed metadata
       */
      const session = collaborationManager.createSession(
        'service-composition',
        ['agent-1'],
        'agent-initiator',
        CollaborationPriority.HIGH,
        'Metadata test',
        []
      );

      const events: SystemEvent[] = [];
      eventManager.subscribe({
        subscriberId: 'test-monitor',
        eventType: EventType.CUSTOM,
        handler: (event) => {
          if (event.payload?.customType === 'AC_STATE_CHANGED') {
            events.push(event);
          }
        },
        priority: EventPriority.NORMAL,
      });

      await collaborationManager.trackACState(session.id, ACState.FORMING, 'Test reason', {
        triggeredBy: 'agent-1',
        metadata: {
          participantCount: 0,
          expectedParticipants: 2,
        },
      });

      const event = events[events.length - 1];
      expect(event.payload.reason).toBe('Test reason');
      expect(event.payload.triggeredBy).toBe('agent-1');
      expect(event.payload.metadata.participantCount).toBe(0);
    });
  });

  describe('Integration: Complete State Transition Flow', () => {
    it('should handle complete lifecycle with all mechanisms', async () => {
      /**
       * Test: Complete lifecycle from FORMING to COMPLETED
       * Includes: timeout, error recovery, completion checking, events
       */
      vi.useFakeTimers();

      const session = collaborationManager.createSession(
        'service-composition',
        [],
        'agent-initiator',
        CollaborationPriority.HIGH,
        'Complete lifecycle test',
        []
      );

      // Track all events
      const events: SystemEvent[] = [];
      eventManager.subscribe({
        subscriberId: 'test-monitor',
        eventType: EventType.CUSTOM,
        handler: (event) => {
          if (event.payload?.customType === 'AC_STATE_CHANGED') {
            events.push(event);
          }
        },
        priority: EventPriority.NORMAL,
      });

      // Step 1: Initialize in FORMING with timeout
      await collaborationManager.trackACState(session.id, ACState.FORMING, 'Starting');
      collaborationManager.setExpectedParticipants(session.id, ['agent-1']);
      collaborationManager.setFormingTimeout(session.id, 10000);

      // Step 2: Participant joins
      collaborationManager.addParticipant(session.id, 'agent-1', {
        role: 'participant',
        capabilities: ['test'],
      });

      // Should be READY
      expect(collaborationManager.getCurrentACState(session.id)).toBe(ACState.READY);

      // Step 3: Start execution
      collaborationManager.updateSessionStatus(session.id, CollaborationStatus.IN_PROGRESS);

      // Should be RUNNING
      expect(collaborationManager.getCurrentACState(session.id)).toBe(ACState.RUNNING);

      // Step 4: Set and achieve goals
      collaborationManager.setACCompletionCriteria(session.id, {
        type: 'all-goals-achieved',
        goals: [{ id: 'goal-1', description: 'Test', achieved: false }],
      });

      collaborationManager.updateACGoal(session.id, 'goal-1', { achieved: true });

      // Step 5: Check completion
      await collaborationManager.checkACCompletion(session.id);

      // Should be COMPLETING
      expect(collaborationManager.getCurrentACState(session.id)).toBe(ACState.COMPLETING);

      // Step 6: Finalize
      await collaborationManager.finalizeAC(session.id, { success: true });

      // Should be COMPLETED
      expect(collaborationManager.getCurrentACState(session.id)).toBe(ACState.COMPLETED);

      // Verify events were emitted
      expect(events.length).toBeGreaterThan(0);

      vi.useRealTimers();
    });
  });
});
