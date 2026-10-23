/**
 * CollaborationCoordinator AC handshake tests (Fix-8)
 *
 * The initiator must NOT actuate anything before the requested partners
 * answer: execution is gated on at least one acceptance, only consenting
 * partners take part, and an all-reject / timeout handshake cancels the
 * session (narrated on the bus as 'ac-cancelled').
 */

import type { LLMClient } from '@active-collaboration/llm-integration';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CollaborationCoordinator, ACCollaborationConfig } from '../CollaborationCoordinator.js';
import type { CollaborationManager } from '../../../management/CollaborationManager.js';
import type { DialogueManager } from '../../../management/DialogueManager.js';
import type { EventEmitter } from '../../../events/EventEmitter.js';
import type { EnvironmentCenter } from '../../../environment/EnvironmentCenter.js';
import { EventManager } from '../../../events/EventManager.js';
import { EventEmitter } from '../../../events/EventEmitter.js';
import { EventType } from '../../../events/index.js';
import { EventPriority } from '@active-collaboration/shared';
import { CollaborationStatus } from '../../../management/CollaborationManager.js';
import { AgentStatus } from '../../CognitiveAgent.js';
import type { DualTriggerResult } from '../../../decision/DualTriggerACManager.js';

// Intercept ACExecutor so the test observes WHETHER/WITH WHOM execution
// happens without running the real execution pipeline.
const executeCollaboration = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../execution/ACExecutor.js', () => ({
  ACExecutor: class {
    executeCollaboration = executeCollaboration;
  },
}));

interface MockSession {
  id: string;
  status: string;
}

const createMockCollaborationManager = (sessions: Map<string, MockSession>): CollaborationManager =>
  ({
    createSessionWithId: vi.fn((id: string) => {
      const session: MockSession = { id, status: 'pending' };
      sessions.set(id, session);
      return session;
    }),
    updateSessionStatus: vi.fn((id: string, status: string) => {
      const session = sessions.get(id);
      if (session) session.status = status;
    }),
    getActiveSessions: vi.fn().mockReturnValue([]),
  }) as unknown as CollaborationManager;

const createMockDialogueManager = (): DialogueManager =>
  ({
    proposeCollaboration: vi.fn().mockReturnValue({ id: 'proposal-1', status: 'pending' }),
  }) as unknown as DialogueManager;

const createACConfig = (): ACCollaborationConfig => ({
  id: 'ac-1',
  name: 'Test AC',
  description: 'Cool the room together',
  priority: 'high',
  participantAgentIds: ['agent-2'],
  requiredResources: [],
  goals: [{ id: 'goal-1', name: 'Goal 1', objective: 'Cool zone-a' }],
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('CollaborationCoordinator AC handshake (Fix-8)', () => {
  let eventManager: EventManager;
  let sessions: Map<string, MockSession>;
  let collaborationManager: CollaborationManager;
  let dialogueManager: DialogueManager;
  let eventEmitter: EventEmitter;
  let statusValue: AgentStatus;
  let setStatus: (status: AgentStatus) => void;

  const buildCoordinator = (handshakeTimeoutMs?: number): CollaborationCoordinator =>
    new CollaborationCoordinator(
      collaborationManager,
      dialogueManager,
      eventEmitter,
      { eventManager } as unknown as EnvironmentCenter,
      'agent-1',
      'Initiator',
      ['coordination'],
      setStatus,
      handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs } : undefined,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager(1000);
    sessions = new Map();
    collaborationManager = createMockCollaborationManager(sessions);
    dialogueManager = createMockDialogueManager();
    // Real emitter so coordinator-emitted bus messages (e.g. 'ac-cancelled')
    // are observable by subscribers.
    eventEmitter = new EventEmitter(eventManager, 'agent-1');
    statusValue = AgentStatus.IDLE;
    setStatus = (status: AgentStatus) => {
      statusValue = status;
    };
  });

  it('creates the session under the shared AC id and does NOT execute before the partner responds', async () => {
    const coordinator = buildCoordinator();

    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);

    // Session created WITH the AC id, still pending; no execution yet.
    expect(collaborationManager.createSessionWithId).toHaveBeenCalledWith(
      'ac-1',
      'service-composition',
      ['agent-1', 'agent-2'],
      'agent-1',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(sessions.get('ac-1')?.status).toBe('pending');
    expect(executeCollaboration).not.toHaveBeenCalled();
    expect(statusValue).toBe(AgentStatus.BUSY);
  });

  it('T-036-depth: scope-of-practice exclusions ride the session + COLLABORATION_STARTED event (bounded)', async () => {
    const coordinator = buildCoordinator();
    // A mixed field: the hospital was selected while the pharmacy (capability
    // match, blocklisted class) was excluded — the DualTriggerResult carries
    // the selection result up from PartnerSelectionNegotiator.
    const startedEvents: Array<Record<string, unknown>> = [];
    eventManager.subscribe({
      subscriberId: 'test-scope-exclusions',
      eventType: EventType.COLLABORATION_STARTED,
      handler: event => startedEvents.push(event.payload as Record<string, unknown>),
    });
    const result = {
      layer2Result: {
        partnerSelection: {
          scopeExclusions: [
            { agentId: 'pharmacy', blockedBy: ['controlled-substance-dispense'] },
            ...Array.from({ length: 12 }, (_, i) => ({ agentId: `extra-${i}`, blockedBy: ['c'] })),
          ],
        },
      },
    } as unknown as DualTriggerResult;

    await coordinator.handleAutonomousACInitiation(createACConfig(), result);

    // Session row: the FIRST 10 exclusions, honest and bounded.
    const session = sessions.get('ac-1') as unknown as {
      scopeExclusions?: Array<{ agentId: string; blockedBy: string[] }>;
    };
    expect(session.scopeExclusions).toHaveLength(10);
    expect(session.scopeExclusions![0]).toEqual({
      agentId: 'pharmacy',
      blockedBy: ['controlled-substance-dispense'],
    });
    expect(session.scopeExclusions!.map(e => e.agentId)).not.toContain('extra-11');

    // Bus event: the same exclusions ride COLLABORATION_STARTED (trajectory/
    // stream consumers see WHO was blocked beside the collaboration).
    expect(startedEvents[0]?.scopeExclusions).toEqual(session.scopeExclusions);
  });

  it('T-036-depth: no exclusions → the session and event carry no scopeExclusions field', async () => {
    const coordinator = buildCoordinator();
    const result = {
      layer2Result: { partnerSelection: { scopeExclusions: undefined } },
    } as unknown as DualTriggerResult;

    await coordinator.handleAutonomousACInitiation(createACConfig(), result);

    const session = sessions.get('ac-1') as unknown as { scopeExclusions?: unknown };
    expect(session.scopeExclusions).toBeUndefined();
  });

  it('R81-D2 (R44-F4): the ac-proposal backfills the SOURCE event id (triggerEventId, shared/unsuffixed)', async () => {
    const coordinator = buildCoordinator();
    const proposals: Array<Record<string, unknown>> = [];
    eventManager.subscribe({
      subscriberId: 'test-trigger-event-id',
      eventType: EventType.COLLABORATION_MESSAGE,
      handler: event => {
        const payload = event.payload as Record<string, unknown>;
        if (payload.type === 'ac-proposal') proposals.push(payload);
      },
    });
    // The runtime suffixes per-agent event ids (`evt-heat-7:sensor-agent`)
    // and stores the shared id in metadata.eventId — the stamp must be the
    // SHARED id so trajectory queries by event find the answers.
    const result = {
      layer1Result: {
        cluster: {
          events: [{
            id: 'evt-heat-7:sensor-agent',
            type: EventType.ENVIRONMENT_PARAM_CHANGED,
            metadata: { eventId: 'evt-heat-7' },
          }],
        },
      },
    } as unknown as DualTriggerResult;

    await coordinator.handleAutonomousACInitiation(createACConfig(), result);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].triggerEventId).toBe('evt-heat-7');
  });

  it('executes with the accepting partner once it accepts', async () => {
    const coordinator = buildCoordinator();
    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);

    eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: 'agent-2',
      priority: EventPriority.NORMAL,
      payload: {
        type: 'join-response',
        acDecision: 'accept',
        agentId: 'agent-2',
        collaborationId: 'ac-1',
        reason: 'can help with cooling',
      },
      metadata: {},
    });

    await vi.waitFor(() => {
      expect(executeCollaboration).toHaveBeenCalledTimes(1);
    });

    // Session moved out of pending into in-progress, agent back to IDLE.
    expect(collaborationManager.updateSessionStatus).toHaveBeenCalledWith('ac-1', CollaborationStatus.IN_PROGRESS);
    expect(statusValue).toBe(AgentStatus.IDLE);

    // Execution runs with the initiator + the CONSENTING partner only.
    const executorConfig = executeCollaboration.mock.calls[0][0] as { participantAgentIds: string[] };
    expect(executorConfig.participantAgentIds).toEqual(['agent-1', 'agent-2']);
  });

  it('cancels the session when every partner rejects — nothing is actuated', async () => {
    const cancelled: Array<Record<string, unknown>> = [];
    eventManager.subscribe({
      subscriberId: 'test-listener',
      eventType: EventType.COLLABORATION_MESSAGE,
      handler: event => {
        const payload = event.payload as { type?: string } | undefined;
        if (payload?.type === 'ac-cancelled') cancelled.push(payload);
      },
      priority: EventPriority.NORMAL,
    });

    const coordinator = buildCoordinator();
    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);

    eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: 'agent-2',
      priority: EventPriority.NORMAL,
      payload: {
        type: 'reject',
        acDecision: 'reject',
        agentId: 'agent-2',
        collaborationId: 'ac-1',
        reason: 'workload too high',
      },
      metadata: {},
    });

    await vi.waitFor(() => {
      expect(collaborationManager.updateSessionStatus).toHaveBeenCalledWith('ac-1', CollaborationStatus.CANCELLED);
    });

    expect(executeCollaboration).not.toHaveBeenCalled();
    expect(statusValue).toBe(AgentStatus.IDLE);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      collaborationId: 'ac-1',
      agentId: 'agent-1',
      outcome: 'rejected',
    });
  });

  it('cancels the session on handshake timeout when nobody responds', async () => {
    const coordinator = buildCoordinator(50);
    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);

    await vi.waitFor(() => {
      expect(collaborationManager.updateSessionStatus).toHaveBeenCalledWith('ac-1', CollaborationStatus.CANCELLED);
    }, { timeout: 2000 });

    expect(executeCollaboration).not.toHaveBeenCalled();
    expect(statusValue).toBe(AgentStatus.IDLE);
  });

  it('ignores responses for other collaborations and duplicate answers', async () => {
    const coordinator = buildCoordinator(200);
    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);

    // Response for a DIFFERENT collaboration — must not close the handshake.
    eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: 'agent-2',
      priority: EventPriority.NORMAL,
      payload: { type: 'join-response', acDecision: 'accept', agentId: 'agent-2', collaborationId: 'ac-other' },
      metadata: {},
    });
    await sleep(50);
    expect(executeCollaboration).not.toHaveBeenCalled();

    // The real answer closes it.
    eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: 'agent-2',
      priority: EventPriority.NORMAL,
      payload: { type: 'join-response', acDecision: 'accept', agentId: 'agent-2', collaborationId: 'ac-1' },
      metadata: {},
    });
    await vi.waitFor(() => {
      expect(executeCollaboration).toHaveBeenCalledTimes(1);
    });
  });

  it('executes immediately when there is no event bus (legacy fire-and-forget)', async () => {
    const coordinator = new CollaborationCoordinator(
      collaborationManager,
      dialogueManager,
      eventEmitter,
      {} as unknown as EnvironmentCenter, // no eventManager
      'agent-1',
      'Initiator',
      ['coordination'],
      setStatus,
    );

    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);

    expect(executeCollaboration).toHaveBeenCalledTimes(1);
    expect(statusValue).toBe(AgentStatus.IDLE);
  });
});

/**
 * Wave-4a: counter/defer answers converge INTO the handshake instead of
 * falling through to the 120s timeout.
 *
 * - counter → the initiator re-evaluates (LLM, else conservative rule
 *   rejection) and answers 'counter-response'; accept → the responder's
 *   join-response closes its slot under the counter's conditions, reject →
 *   the partner counts as declined. ONE round only — a second counter is
 *   treated as a rejection.
 * - defer → the slot stays pending until the partner's re-evaluated answer
 *   arrives; the handshake timeout remains the backstop.
 */
describe('CollaborationCoordinator AC handshake — counter/defer (Wave-4a)', () => {
  let eventManager: EventManager;
  let sessions: Map<string, MockSession>;
  let collaborationManager: CollaborationManager;
  let dialogueManager: DialogueManager;
  let eventEmitter: EventEmitter;
  let statusValue: AgentStatus;
  let setStatus: (status: AgentStatus) => void;
  let busMessages: Array<Record<string, unknown>>;

  const llmAcceptingCounters = {
    chat: vi.fn().mockResolvedValue({
      content: '{"accept": true, "reason": "the modified conditions are acceptable"}',
      model: 'mock-model',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }),
  } as unknown as LLMClient;

  const buildCoordinator = (options?: { handshakeTimeoutMs?: number; withLLM?: boolean }): CollaborationCoordinator =>
    new CollaborationCoordinator(
      collaborationManager,
      dialogueManager,
      eventEmitter,
      { eventManager } as unknown as EnvironmentCenter,
      'agent-1',
      'Initiator',
      ['coordination'],
      setStatus,
      {
        ...(options?.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: options.handshakeTimeoutMs } : {}),
        ...(options?.withLLM ? { llmClient: llmAcceptingCounters } : {}),
      },
    );

  const publishBusMessage = (payload: Record<string, unknown>, source = 'agent-2'): void => {
    eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source,
      priority: EventPriority.NORMAL,
      payload,
      metadata: {},
    });
  };

  const counterPayload = (): Record<string, unknown> => ({
    type: 'counter',
    acDecision: 'counter',
    agentId: 'agent-2',
    collaborationId: 'ac-1',
    reason: 'can do it, but only after 18:00',
    counterProposal: { modifications: ['run after 18:00'], reasoning: 'busy until then' },
    originalProposal: { id: 'ac-1', proposedBy: 'agent-1', proposedTo: 'agent-2', metadata: { collaborationId: 'ac-1' } },
    evaluationSource: 'llm',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager(1000);
    sessions = new Map();
    collaborationManager = createMockCollaborationManager(sessions);
    dialogueManager = createMockDialogueManager();
    eventEmitter = new EventEmitter(eventManager, 'agent-1');
    statusValue = AgentStatus.IDLE;
    setStatus = (status: AgentStatus) => {
      statusValue = status;
    };
    busMessages = [];
    eventManager.subscribe({
      subscriberId: 'bus-recorder',
      eventType: EventType.COLLABORATION_MESSAGE,
      handler: event => {
        busMessages.push(event.payload as Record<string, unknown>);
      },
      priority: EventPriority.NORMAL,
    });
  });

  it('counter accepted (LLM) → counter-response accept → the partner\'s join-response closes the handshake', async () => {
    const coordinator = buildCoordinator({ withLLM: true });
    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);

    publishBusMessage(counterPayload());

    // The initiator re-evaluated the counter and answered with an accept.
    await vi.waitFor(() => {
      const answers = busMessages.filter(m => m.type === 'counter-response');
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({
        acDecision: 'accept',
        agentId: 'agent-1',
        targetAgentId: 'agent-2',
        collaborationId: 'ac-1',
        evaluationSource: 'llm',
      });
    });
    // Nothing executed yet — the slot closes on the responder's join-response.
    expect(executeCollaboration).not.toHaveBeenCalled();

    publishBusMessage({
      type: 'join-response',
      acDecision: 'accept',
      agentId: 'agent-2',
      collaborationId: 'ac-1',
      reason: 'Counter-proposal accepted by initiator: the modified conditions are acceptable',
    });

    await vi.waitFor(() => {
      expect(executeCollaboration).toHaveBeenCalledTimes(1);
    });
    expect(collaborationManager.updateSessionStatus).toHaveBeenCalledWith('ac-1', CollaborationStatus.IN_PROGRESS);
    expect(statusValue).toBe(AgentStatus.IDLE);
  });

  it('counter rejected by rule (no LLM configured) → counter-response reject → handshake cancels as rejected', async () => {
    const coordinator = buildCoordinator();
    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);

    publishBusMessage(counterPayload());

    await vi.waitFor(() => {
      expect(collaborationManager.updateSessionStatus).toHaveBeenCalledWith('ac-1', CollaborationStatus.CANCELLED);
    });

    const answers = busMessages.filter(m => m.type === 'counter-response');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      acDecision: 'reject',
      targetAgentId: 'agent-2',
      collaborationId: 'ac-1',
      evaluationSource: 'rule',
    });
    expect(executeCollaboration).not.toHaveBeenCalled();
    const cancelled = busMessages.filter(m => m.type === 'ac-cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ collaborationId: 'ac-1', outcome: 'rejected' });
    expect(statusValue).toBe(AgentStatus.IDLE);
  });

  it('a SECOND counter from the same partner is treated as a rejection (one negotiation round only)', async () => {
    const coordinator = buildCoordinator({ withLLM: true });
    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);

    // First counter: accepted by the initiator's LLM — the slot stays open.
    publishBusMessage(counterPayload());
    await vi.waitFor(() => {
      expect(busMessages.filter(m => m.type === 'counter-response')).toHaveLength(1);
    });

    // Instead of joining, the partner counters again → declined → cancel.
    publishBusMessage(counterPayload());
    await vi.waitFor(() => {
      expect(collaborationManager.updateSessionStatus).toHaveBeenCalledWith('ac-1', CollaborationStatus.CANCELLED);
    });

    // No second counter-response was issued; the cancel narrates the rejection.
    expect(busMessages.filter(m => m.type === 'counter-response')).toHaveLength(1);
    const cancelled = busMessages.filter(m => m.type === 'ac-cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ outcome: 'rejected' });
    expect(executeCollaboration).not.toHaveBeenCalled();
  });

  it('defer keeps the slot pending — the re-evaluated accept closes the handshake', async () => {
    const coordinator = buildCoordinator({ handshakeTimeoutMs: 2000 });
    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);

    publishBusMessage({
      type: 'defer',
      acDecision: 'defer',
      agentId: 'agent-2',
      collaborationId: 'ac-1',
      reason: 'need more information',
      evaluationSource: 'llm',
      deferMs: 50,
    });

    // The defer alone neither executes nor cancels — the handshake stays open.
    await sleep(100);
    expect(executeCollaboration).not.toHaveBeenCalled();
    expect(collaborationManager.updateSessionStatus).not.toHaveBeenCalledWith('ac-1', CollaborationStatus.CANCELLED);
    expect(sessions.get('ac-1')?.status).toBe('pending');

    // The deferred answer arrives: accept → normal closure.
    publishBusMessage({
      type: 'join-response',
      acDecision: 'accept',
      agentId: 'agent-2',
      collaborationId: 'ac-1',
      reason: 'available now',
    });
    await vi.waitFor(() => {
      expect(executeCollaboration).toHaveBeenCalledTimes(1);
    });
  });

  it('defer with no follow-up answer still falls back to the handshake timeout', async () => {
    const coordinator = buildCoordinator({ handshakeTimeoutMs: 100 });
    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);

    publishBusMessage({
      type: 'defer',
      acDecision: 'defer',
      agentId: 'agent-2',
      collaborationId: 'ac-1',
      reason: 'need more information',
      deferMs: 60_000, // beyond the handshake timeout — the timer must win
    });

    await vi.waitFor(() => {
      expect(collaborationManager.updateSessionStatus).toHaveBeenCalledWith('ac-1', CollaborationStatus.CANCELLED);
    }, { timeout: 2000 });

    expect(executeCollaboration).not.toHaveBeenCalled();
    const cancelled = busMessages.filter(m => m.type === 'ac-cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ outcome: 'timeout' });
    expect(statusValue).toBe(AgentStatus.IDLE);
  });
});

/**
 * R44-dense-F2: Phase 7 fallback proposes to a BATCH of next-ranked
 * candidates per round instead of one at a time.
 *
 * The serial iteration could not converge at dense scale (193 agents):
 * ~11-18% per-response accept rate made every single-candidate round a
 * likely miss, and each 'defer' stalled the round for its full 30s
 * re-evaluation delay — the r44city-dense run burned 114s churning 20
 * candidates one-by-one and still had not exhausted the ranked list when
 * the simulation ended (handshake stuck 'pending'). A batch multiplies the
 * per-round hit probability and any batch member's accept converges the
 * handshake while another member's defer is still pending.
 */
describe('CollaborationCoordinator AC handshake — batched fallback (R44-dense-F2)', () => {
  let eventManager: EventManager;
  let sessions: Map<string, MockSession>;
  let collaborationManager: CollaborationManager;
  let dialogueManager: DialogueManager;
  let eventEmitter: EventEmitter;
  let setStatus: (status: AgentStatus) => void;
  let acProposals: Array<Record<string, unknown>>;

  const buildCoordinator = (options?: { fallbackBatchSize?: number; handshakeTimeoutMs?: number }): CollaborationCoordinator =>
    new CollaborationCoordinator(
      collaborationManager,
      dialogueManager,
      eventEmitter,
      { eventManager } as unknown as EnvironmentCenter,
      'agent-1',
      'Initiator',
      ['coordination'],
      setStatus,
      {
        handshakeTimeoutMs: options?.handshakeTimeoutMs ?? 500,
        fallbackBatchSize: options?.fallbackBatchSize,
      },
    );

  /** DualTriggerResult carrying a ranked candidate list for Phase 7. */
  const rankedResult = (n: number) => ({
    layer2Result: {
      partnerSelection: {
        allRankedCandidates: Array.from({ length: n }, (_, i) => ({
          agentId: `candidate-${i + 1}`,
          agentName: `Candidate ${i + 1}`,
          matchScore: 1 - i * 0.05,
        })),
      },
    },
  }) as unknown as DualTriggerResult;

  const publishAnswer = (agentId: string, type: string, acDecision: string): void => {
    eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: agentId,
      priority: EventPriority.NORMAL,
      payload: { type, acDecision, agentId, collaborationId: 'ac-1', reason: 'test' },
      metadata: {},
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager(1000);
    sessions = new Map();
    collaborationManager = createMockCollaborationManager(sessions);
    dialogueManager = createMockDialogueManager();
    eventEmitter = new EventEmitter(eventManager, 'agent-1');
    setStatus = () => undefined;
    acProposals = [];
    eventManager.subscribe({
      subscriberId: 'fallback-proposal-recorder',
      eventType: EventType.COLLABORATION_MESSAGE,
      handler: event => {
        const payload = event.payload as Record<string, unknown>;
        if (payload?.type === 'ac-proposal') acProposals.push(payload);
      },
      priority: EventPriority.NORMAL,
    });
  });

  it('after the primary partner rejects, the next-ranked BATCH receives proposals at once', async () => {
    const coordinator = buildCoordinator({ fallbackBatchSize: 3, handshakeTimeoutMs: 300 });
    await coordinator.handleAutonomousACInitiation(createACConfig(), rankedResult(8));

    publishAnswer('agent-2', 'reject', 'reject');

    // Exactly the first 3 ranked candidates get the fallback proposal, in one round.
    await vi.waitFor(() => {
      expect(acProposals.filter(p => (p.metadata as Record<string, unknown>)?.fallbackAttempt === true)).toHaveLength(3);
    }, { timeout: 2000 });
    const targets = acProposals
      .filter(p => (p.metadata as Record<string, unknown>)?.fallbackAttempt === true)
      .map(p => p.targetAgentId);
    expect(targets).toEqual(['candidate-1', 'candidate-2', 'candidate-3']);

    // One batch member accepts → the handshake converges with it. The two
    // silent siblings let the (short) window elapse — the accept in hand
    // wins and the silent members count as declined (R44-dense-F2).
    publishAnswer('candidate-2', 'join-response', 'accept');
    await vi.waitFor(() => {
      expect(executeCollaboration).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
    const executorConfig = executeCollaboration.mock.calls[0][0] as { participantAgentIds: string[] };
    expect(executorConfig.participantAgentIds).toEqual(['agent-1', 'candidate-2']);
    expect(collaborationManager.updateSessionStatus).toHaveBeenCalledWith('ac-1', CollaborationStatus.IN_PROGRESS);
  });

  it('an exhausted batch falls through to the NEXT batch from the remaining ranked tail', async () => {
    const coordinator = buildCoordinator({ fallbackBatchSize: 2, handshakeTimeoutMs: 300 });
    await coordinator.handleAutonomousACInitiation(createACConfig(), rankedResult(6));

    // Primary declines → batch 1 = candidates 1-2.
    publishAnswer('agent-2', 'reject', 'reject');
    await vi.waitFor(() => {
      expect(acProposals.filter(p => (p.metadata as Record<string, unknown>)?.fallbackAttempt === true)).toHaveLength(2);
    }, { timeout: 2000 });

    // Batch 1 declines → batch 2 = candidates 3-4 (not a repeat of 1-2).
    publishAnswer('candidate-1', 'reject', 'reject');
    publishAnswer('candidate-2', 'reject', 'reject');
    await vi.waitFor(() => {
      expect(acProposals.filter(p => (p.metadata as Record<string, unknown>)?.fallbackAttempt === true)).toHaveLength(4);
    }, { timeout: 2000 });
    const targets = acProposals
      .filter(p => (p.metadata as Record<string, unknown>)?.fallbackAttempt === true)
      .map(p => p.targetAgentId);
    expect(targets).toEqual(['candidate-1', 'candidate-2', 'candidate-3', 'candidate-4']);

    // A batch-2 accept converges without waiting for its batch sibling.
    publishAnswer('candidate-3', 'join-response', 'accept');
    await vi.waitFor(() => {
      expect(executeCollaboration).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
  });

  it('when every candidate is exhausted the session is cancelled (bounded churn)', async () => {
    const coordinator = buildCoordinator({ fallbackBatchSize: 2, handshakeTimeoutMs: 150 });
    await coordinator.handleAutonomousACInitiation(createACConfig(), rankedResult(2));

    publishAnswer('agent-2', 'reject', 'reject');
    // Batch of 2 goes out; nobody answers → per-batch handshake timeout fires.
    await vi.waitFor(() => {
      expect(collaborationManager.updateSessionStatus).toHaveBeenCalledWith('ac-1', CollaborationStatus.CANCELLED);
    }, { timeout: 3000 });
    expect(executeCollaboration).not.toHaveBeenCalled();
  });

  it('R100 (chen-11): proposal service terms are SUBSET to the request face — never the partner\'s full catalog', async () => {
    const coordinator = buildCoordinator({ fallbackBatchSize: 2, handshakeTimeoutMs: 150 });
    const config = {
      ...createACConfig(),
      goals: [{
        id: 'goal-1', name: 'Goal 1', objective: 'dispatch smoke',
        requiredCapabilities: ['smoke-monitoring', 'emergency-broadcast'],
      }],
    };
    const result = {
      layer2Result: {
        partnerSelection: {
          selectedPartners: [{
            agentId: 'agent-2',
            services: [
              { name: 'Hallway Lighting Service', semanticType: 'lighting-control' },
              { name: 'Plaza Smoke Sensor Service', semanticType: 'smoke-monitoring' },
              { name: 'Emergency Speaker Service', semanticType: 'emergency-broadcast' },
            ],
          }],
        },
      },
    } as unknown as DualTriggerResult;
    await coordinator.handleAutonomousACInitiation(config, result);
    publishAnswer('agent-2', 'reject', 'reject'); // close the handshake fast

    const primary = acProposals.find(p => p.targetAgentId === 'agent-2');
    expect(primary).toBeDefined();
    const terms = ((primary!.services ?? []) as Array<{ semanticType: string }>).map(s => s.semanticType);
    // The smoke-relevant services ride the proposal; the partner's lighting
    // service does NOT (the full-face dump read as "I request everything"
    // and got the smoke AC mass-rejected).
    expect(terms.sort()).toEqual(['emergency-broadcast', 'smoke-monitoring']);
  });

  it('BUG-03: the request face is DEDUPED across primary+sub goals, and fallback proposals re-emit the trigger face', async () => {
    const coordinator = buildCoordinator({ fallbackBatchSize: 2, handshakeTimeoutMs: 300 });
    // GoalFormulationEngine shape: the primary goal AND every subgoal each
    // carry the full requiredCapabilities — the pre-fix flatMap repeated
    // the list once per goal ("cooling,temperature-control,cooling,…"
    // downstream in the server's terms.trigger).
    const config = {
      ...createACConfig(),
      goals: [
        { id: 'goal-1', name: 'Goal 1', objective: 'cool dorm-3', requiredCapabilities: ['cooling', 'temperature-control'] },
        { id: 'goal-2', name: 'Subgoal 2', objective: 'sub', requiredCapabilities: ['cooling', 'temperature-control'] },
      ],
    };
    const result = {
      layer1Result: {
        cluster: {
          events: [{ id: 'evt-heat-9:agent-1', type: 'heat-wave', metadata: { eventId: 'evt-heat-9' } }],
          region: { id: 'dorm-3-f1' },
        },
      },
      layer2Result: {
        partnerSelection: {
          allRankedCandidates: [
            { agentId: 'candidate-1', agentName: 'Candidate 1', matchScore: 0.9 },
          ],
        },
      },
    } as unknown as DualTriggerResult;

    await coordinator.handleAutonomousACInitiation(config, result);

    // Primary proposal: every capability exactly once, and the trigger face
    // (eventType + zoneId from the L1 cluster) rides the payload.
    const primary = acProposals.find(p => p.targetAgentId === 'agent-2');
    expect(primary).toBeDefined();
    expect(primary!.requiredCapabilities).toEqual(['cooling', 'temperature-control']);
    expect(primary!.triggerEventType).toBe('heat-wave');
    expect(primary!.triggerZoneId).toBe('dorm-3-f1');

    // Fallback batch: the SAME deduped face + trigger fields ride the fresh
    // proposals (pre-fix the fallback path sent no triggerEventType/
    // triggerZoneId at all — its agreements landed without either).
    publishAnswer('agent-2', 'reject', 'reject');
    await vi.waitFor(() => {
      expect(acProposals.some(p => (p.metadata as Record<string, unknown>)?.fallbackAttempt === true)).toBe(true);
    }, { timeout: 2000 });
    const fallback = acProposals.find(p => (p.metadata as Record<string, unknown>)?.fallbackAttempt === true);
    expect(fallback).toBeDefined();
    expect(fallback!.requiredCapabilities).toEqual(['cooling', 'temperature-control']);
    expect(fallback!.triggerEventType).toBe('heat-wave');
    expect(fallback!.triggerZoneId).toBe('dorm-3-f1');
    expect(fallback!.triggerEventId).toBe('evt-heat-9');
  });

  it('R100: an empty request face carries NO service terms (a pure coverage broadcast names no services)', async () => {
    const coordinator = buildCoordinator({ fallbackBatchSize: 2, handshakeTimeoutMs: 150 });
    const result = {
      layer2Result: {
        partnerSelection: {
          selectedPartners: [{
            agentId: 'agent-2',
            services: [{ name: 'Hallway Lighting Service', semanticType: 'lighting-control' }],
          }],
        },
      },
    } as unknown as DualTriggerResult;
    // createACConfig's goals carry no requiredCapabilities → empty face.
    await coordinator.handleAutonomousACInitiation(createACConfig(), result);
    publishAnswer('agent-2', 'reject', 'reject');

    const primary = acProposals.find(p => p.targetAgentId === 'agent-2');
    expect(primary).toBeDefined();
    expect(primary!.services).toBeUndefined();
  });
});

/**
 * T123 (plan-e2e-hardening §5 D1, option A): the AC handshake window is a
 * WALL-CLOCK constant (120s default) — it was never sim time (dispatch §0
 * code facts). At high world speeds the per-wall-second decision load
 * outgrows the window (R18-u3: 0/8 handshakes), so the window carries a
 * REAL-TIME FLOOR when the world's nominal sim-per-wall-second rate
 * reaches the engage gate. Below the gate — and whenever no rate provider
 * is wired — the window must be EXACTLY today's value (×1/×5 worlds stay
 * bit-identical; the D5 snapshot comparison anchors on these very tests).
 */
describe('CollaborationCoordinator AC handshake — rate-gated real-time floor (T123)', () => {
  let eventManager: EventManager;
  let sessions: Map<string, MockSession>;
  let collaborationManager: CollaborationManager;
  let dialogueManager: DialogueManager;
  let eventEmitter: EventEmitter;
  let statusValue: AgentStatus;
  let setStatus: (status: AgentStatus) => void;
  let busMessages: Array<Record<string, unknown>>;

  /** Mutable world rate the simRateProvider closure reads. */
  let worldRate: number | undefined;

  interface FloorOptions {
    handshakeTimeoutMs?: number;
    responseFloorMinWallMs?: number;
    responseFloorEngageRate?: number;
    provideRate?: boolean;
  }

  const buildCoordinator = (options?: FloorOptions): CollaborationCoordinator =>
    new CollaborationCoordinator(
      collaborationManager,
      dialogueManager,
      eventEmitter,
      { eventManager } as unknown as EnvironmentCenter,
      'agent-1',
      'Initiator',
      ['coordination'],
      setStatus,
      {
        ...(options?.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: options.handshakeTimeoutMs } : {}),
        ...(options?.responseFloorMinWallMs !== undefined ? { responseFloorMinWallMs: options.responseFloorMinWallMs } : {}),
        ...(options?.responseFloorEngageRate !== undefined ? { responseFloorEngageRate: options.responseFloorEngageRate } : {}),
        // The provider is passed ONLY when the world wired it — absence is
        // the "rate unknown, floor never engages" default (bit-identical).
        ...(options?.provideRate ? { simRateProvider: () => worldRate } : {}),
      },
    );

  const cancelledMessages = (): Array<Record<string, unknown>> =>
    busMessages.filter(m => m.type === 'ac-cancelled');

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager(1000);
    sessions = new Map();
    collaborationManager = createMockCollaborationManager(sessions);
    dialogueManager = createMockDialogueManager();
    eventEmitter = new EventEmitter(eventManager, 'agent-1');
    statusValue = AgentStatus.IDLE;
    setStatus = (status: AgentStatus) => {
      statusValue = status;
    };
    busMessages = [];
    eventManager.subscribe({
      subscriberId: 'bus-recorder-t123',
      eventType: EventType.COLLABORATION_MESSAGE,
      handler: event => {
        if ((event.payload as Record<string, unknown>)?.type === 'ac-cancelled') {
          busMessages.push(event.payload as Record<string, unknown>);
        }
      },
      priority: EventPriority.NORMAL,
    });
    worldRate = undefined;
  });

  it('no simRateProvider (or rate below the gate) → the window is EXACTLY handshakeTimeoutMs (floor never engages)', async () => {
    // Floor present but no provider wired — the ×1/×5 bit-identical anchor.
    const unwired = buildCoordinator({ handshakeTimeoutMs: 500, responseFloorMinWallMs: 1500 });
    await unwired.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);
    await vi.waitFor(() => {
      expect(cancelledMessages()).toHaveLength(1);
    }, { timeout: 3000 });
    expect(cancelledMessages()[0]).toMatchObject({ outcome: 'timeout' });
    expect(cancelledMessages()[0]!.reason).toContain('within 500ms');
    expect(cancelledMessages()[0]!.reason).not.toContain('1500ms');

    // Provider wired but the rate sits BELOW the gate (×1 world) — same base window.
    busMessages.length = 0;
    worldRate = 1;
    const belowGate = buildCoordinator({
      handshakeTimeoutMs: 400,
      responseFloorMinWallMs: 1500,
      responseFloorEngageRate: 2,
      provideRate: true,
    });
    const config2 = { ...createACConfig(), id: 'ac-2', name: 'Test AC 2' };
    await belowGate.handleAutonomousACInitiation(config2, {} as unknown as DualTriggerResult);
    await vi.waitFor(() => {
      expect(cancelledMessages()).toHaveLength(1);
    }, { timeout: 3000 });
    expect(cancelledMessages()[0]!.reason).toContain('within 400ms');
    expect(cancelledMessages()[0]!.reason).not.toContain('1500ms');
  }, 15_000);

  it('rate ≥ engage gate → the window is max(base, floor); the reason names effMs', async () => {
    worldRate = 5; // ≥ gate 2 → floor 1500ms wins over base 500ms
    const coordinator = buildCoordinator({
      handshakeTimeoutMs: 500,
      responseFloorMinWallMs: 1500,
      responseFloorEngageRate: 2,
      provideRate: true,
    });
    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);

    // At 700ms (past the base window) the floor is still holding — the
    // handshake was NOT executed upon / cancelled at the base window.
    await sleep(700);
    expect(executeCollaboration).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(cancelledMessages()).toHaveLength(1);
    }, { timeout: 3000 });
    expect(cancelledMessages()[0]!.reason).toContain('within 1500ms');
  }, 15_000);

  it('a floor-engaged timeout still narrates ac-cancelled with outcome:"timeout" (byCause compatibility anchor)', async () => {
    worldRate = 5;
    const coordinator = buildCoordinator({
      handshakeTimeoutMs: 200,
      responseFloorMinWallMs: 600,
      responseFloorEngageRate: 2,
      provideRate: true,
    });
    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);

    await vi.waitFor(() => {
      expect(cancelledMessages()).toHaveLength(1);
    }, { timeout: 3000 });
    const cancelled = cancelledMessages()[0]!;
    // The payload SHAPE is untouched — only "when it fires" changed.
    expect(cancelled).toMatchObject({ outcome: 'timeout', collaborationId: 'ac-1', agentId: 'agent-1' });
    expect(Object.keys(cancelled).sort()).toEqual(
      ['acceptedBy', 'agentId', 'collaborationId', 'declinedBy', 'outcome', 'reason', 'type'],
    );
    expect(collaborationManager.updateSessionStatus).toHaveBeenCalledWith('ac-1', CollaborationStatus.CANCELLED);
    expect(statusValue).toBe(AgentStatus.IDLE);
  }, 15_000);

  it('the provider is read PER HANDSHAKE — an online rate change adopts the new effMs on the next initiation', async () => {
    worldRate = 1; // below gate → base window
    const coordinator = buildCoordinator({
      handshakeTimeoutMs: 300,
      responseFloorMinWallMs: 1200,
      responseFloorEngageRate: 2,
      provideRate: true,
    });

    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);
    await vi.waitFor(() => {
      expect(cancelledMessages()).toHaveLength(1);
    }, { timeout: 3000 });
    expect(cancelledMessages()[0]!.reason).toContain('within 300ms');

    // The world retargets to a high rate; the NEXT handshake must see it.
    worldRate = 5;
    busMessages.length = 0;
    const config2 = { ...createACConfig(), id: 'ac-2', name: 'Test AC 2' };
    await coordinator.handleAutonomousACInitiation(config2, {} as unknown as DualTriggerResult);
    await vi.waitFor(() => {
      expect(cancelledMessages()).toHaveLength(1);
    }, { timeout: 4000 });
    expect(cancelledMessages()[0]!.reason).toContain('within 1200ms');
  }, 20_000);

  it('env resolver: EAF_AC_RESPONSE_* parse in three states (absent / valid / invalid → ignored, default falls through)', () => {
    const originalMin = process.env.EAF_AC_RESPONSE_MIN_WALL_MS;
    const originalRate = process.env.EAF_AC_RESPONSE_FLOOR_MIN_RATE;
    try {
      // Absent → undefined (caller falls through to the constant default).
      delete process.env.EAF_AC_RESPONSE_MIN_WALL_MS;
      delete process.env.EAF_AC_RESPONSE_FLOOR_MIN_RATE;
      expect(CollaborationCoordinator.responseFloorMinWallMsFromEnv()).toBeUndefined();
      expect(CollaborationCoordinator.floorEngageRateFromEnv()).toBeUndefined();

      // Valid → parsed through.
      process.env.EAF_AC_RESPONSE_MIN_WALL_MS = '450000';
      process.env.EAF_AC_RESPONSE_FLOOR_MIN_RATE = '30';
      expect(CollaborationCoordinator.responseFloorMinWallMsFromEnv()).toBe(450_000);
      expect(CollaborationCoordinator.floorEngageRateFromEnv()).toBe(30);

      // Invalid → ignored (undefined), never a startup failure.
      process.env.EAF_AC_RESPONSE_MIN_WALL_MS = '-5';
      process.env.EAF_AC_RESPONSE_FLOOR_MIN_RATE = 'abc';
      expect(CollaborationCoordinator.responseFloorMinWallMsFromEnv()).toBeUndefined();
      expect(CollaborationCoordinator.floorEngageRateFromEnv()).toBeUndefined();
      process.env.EAF_AC_RESPONSE_MIN_WALL_MS = '0';
      process.env.EAF_AC_RESPONSE_FLOOR_MIN_RATE = 'Infinity';
      expect(CollaborationCoordinator.responseFloorMinWallMsFromEnv()).toBeUndefined();
      expect(CollaborationCoordinator.floorEngageRateFromEnv()).toBeUndefined();
    } finally {
      if (originalMin === undefined) delete process.env.EAF_AC_RESPONSE_MIN_WALL_MS;
      else process.env.EAF_AC_RESPONSE_MIN_WALL_MS = originalMin;
      if (originalRate === undefined) delete process.env.EAF_AC_RESPONSE_FLOOR_MIN_RATE;
      else process.env.EAF_AC_RESPONSE_FLOOR_MIN_RATE = originalRate;
    }
  });

  it('precedence: constructor option > env (option wins; env drives the window when no option is passed)', async () => {
    worldRate = 5;
    const originalMin = process.env.EAF_AC_RESPONSE_MIN_WALL_MS;
    try {
      process.env.EAF_AC_RESPONSE_MIN_WALL_MS = '800';
      // Option wins over env.
      const optionWins = buildCoordinator({
        handshakeTimeoutMs: 200,
        responseFloorMinWallMs: 1500,
        responseFloorEngageRate: 2,
        provideRate: true,
      });
      await optionWins.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);
      await vi.waitFor(() => {
        expect(cancelledMessages()).toHaveLength(1);
      }, { timeout: 4000 });
      expect(cancelledMessages()[0]!.reason).toContain('within 1500ms');

      // No option → the env value drives the floor.
      busMessages.length = 0;
      const envDrives = buildCoordinator({
        handshakeTimeoutMs: 200,
        responseFloorEngageRate: 2,
        provideRate: true,
      });
      const config2 = { ...createACConfig(), id: 'ac-2', name: 'Test AC 2' };
      await envDrives.handleAutonomousACInitiation(config2, {} as unknown as DualTriggerResult);
      await vi.waitFor(() => {
        expect(cancelledMessages()).toHaveLength(1);
      }, { timeout: 4000 });
      expect(cancelledMessages()[0]!.reason).toContain('within 800ms');
    } finally {
      if (originalMin === undefined) delete process.env.EAF_AC_RESPONSE_MIN_WALL_MS;
      else process.env.EAF_AC_RESPONSE_MIN_WALL_MS = originalMin;
    }
  }, 20_000);
});

describe('CollaborationCoordinator AC handshake — runtime-teardown cancel (BUG-07)', () => {
  let eventManager: EventManager;
  let sessions: Map<string, MockSession>;
  let collaborationManager: CollaborationManager;
  let dialogueManager: DialogueManager;
  let eventEmitter: EventEmitter;
  let statusValue: AgentStatus;
  let setStatus: (status: AgentStatus) => void;
  let busMessages: Array<Record<string, unknown>>;

  const buildCoordinator = (): CollaborationCoordinator =>
    new CollaborationCoordinator(
      collaborationManager,
      dialogueManager,
      eventEmitter,
      { eventManager } as unknown as EnvironmentCenter,
      'agent-1',
      'Initiator',
      ['coordination'],
      setStatus,
      { handshakeTimeoutMs: 60_000 },
    );

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager(1000);
    sessions = new Map();
    collaborationManager = createMockCollaborationManager(sessions);
    dialogueManager = createMockDialogueManager();
    eventEmitter = new EventEmitter(eventManager, 'agent-1');
    statusValue = AgentStatus.IDLE;
    setStatus = (status: AgentStatus) => {
      statusValue = status;
    };
    busMessages = [];
    eventManager.subscribe({
      subscriberId: 'bus-recorder',
      eventType: EventType.COLLABORATION_MESSAGE,
      handler: event => {
        busMessages.push(event.payload as Record<string, unknown>);
      },
      priority: EventPriority.NORMAL,
    });
  });

  it('cancelPendingHandshakes narrates a pending handshake as ac-cancelled outcome:"aborted" — synchronously, before the bus dies', async () => {
    const coordinator = buildCoordinator();
    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);
    // The handshake is parked (no partner answer); nothing concluded yet.
    expect(busMessages.filter(m => m.type === 'ac-cancelled')).toHaveLength(0);
    expect(sessions.get('ac-1')?.status).toBe('pending');

    // The cancel lands SYNCHRONOUSLY (the runtime's stop() unsubscribes the
    // bus right after this returns — an async narration would be lost).
    const cancelledCount = coordinator.cancelPendingHandshakes('runtime-rebuild');
    expect(cancelledCount).toBe(1);
    const cancelled = busMessages.filter(m => m.type === 'ac-cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      collaborationId: 'ac-1',
      agentId: 'agent-1',
      outcome: 'aborted',
      reason: 'runtime-rebuild',
      acceptedBy: [],
      declinedBy: [],
    });
    expect(sessions.get('ac-1')?.status).toBe(CollaborationStatus.CANCELLED);
    expect(executeCollaboration).not.toHaveBeenCalled();

    // The parked waiter settles (status back to IDLE, no double narration).
    await vi.waitFor(() => {
      expect(statusValue).toBe(AgentStatus.IDLE);
    });
    expect(busMessages.filter(m => m.type === 'ac-cancelled')).toHaveLength(1);
  });

  it('idempotent: a concluded handshake has no abort handle; a second cancel is a no-op', async () => {
    const coordinator = buildCoordinator();
    await coordinator.handleAutonomousACInitiation(createACConfig(), {} as unknown as DualTriggerResult);

    expect(coordinator.cancelPendingHandshakes('runtime-rebuild')).toBe(1);
    // Already aborted — nothing pending anymore.
    expect(coordinator.cancelPendingHandshakes('runtime-stopped')).toBe(0);
    expect(busMessages.filter(m => m.type === 'ac-cancelled')).toHaveLength(1);

    // A fresh coordinator with no in-flight handshake cancels zero.
    expect(buildCoordinator().cancelPendingHandshakes('runtime-stopped')).toBe(0);
  });

  it('a partial-accept handshake still aborts: the accept already in hand is narrated, execution never fires', async () => {
    const coordinator = buildCoordinator();
    const config = { ...createACConfig(), participantAgentIds: ['agent-2', 'agent-3'] };
    await coordinator.handleAutonomousACInitiation(config, {} as unknown as DualTriggerResult);

    // One partner accepts; the other stays silent — the handshake is still open.
    eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: 'agent-2',
      priority: EventPriority.NORMAL,
      payload: {
        type: 'join-response',
        acDecision: 'accept',
        agentId: 'agent-2',
        collaborationId: 'ac-1',
        reason: 'available',
      },
      metadata: {},
    });
    expect(executeCollaboration).not.toHaveBeenCalled();

    expect(coordinator.cancelPendingHandshakes('runtime-stopped')).toBe(1);
    const cancelled = busMessages.filter(m => m.type === 'ac-cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      outcome: 'aborted',
      reason: 'runtime-stopped',
      acceptedBy: ['agent-2'],
      declinedBy: [],
    });
    expect(executeCollaboration).not.toHaveBeenCalled();
  });
});
