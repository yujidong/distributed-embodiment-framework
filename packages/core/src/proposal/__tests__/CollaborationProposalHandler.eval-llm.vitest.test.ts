/**
 * @vitest-environment node
 *
 * CollaborationProposalHandler R5-F10 tests — the 27B silent-degradation fix.
 *
 * The incident (data/usertest-r5/findings.md R5-F10): with LLM_MODEL a large
 * model (qwen3.8-27b) every responder evaluation fell back to deterministic
 * capability matching — 43/43 answers decisionSource 'fallback', zero
 * llm-failure records, zero eval-report llmFailures, no ops signal — while
 * the initiator lane on the SAME clients kept a 100% json rate. Root causes
 * pinned here:
 *
 * 1. The evaluation call was FREE-FORM (no format, no temperature pin): a
 *    large/thinking model's output was unparseable (truncated at maxTokens
 *    mid-reasoning). The lane now uses guided JSON (PROPOSAL_EVAL_SCHEMA)
 *    and temperature 0 like every other decision endpoint.
 * 2. The Fix-12 timeout ORPHANED the underlying request (Promise.race
 *    without an abort): the call later completed as a logged SUCCESS, so a
 *    100%-timeout lane produced zero llm-failure records. The budget is now
 *    an AbortSignal (T-023 pattern, mirroring the server's LLMReviewer).
 * 3. Fallback answers carried no error detail. Every fallback answer now
 *    carries `evaluationError`, threaded onto the trajectory's
 *    collaboration-response record (errorMessage).
 *
 * The 1.5B (small-model) path must not regress: a clean JSON answer still
 * decides the handshake, labelled 'llm', with no evaluationError.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CollaborationProposalHandler,
  PROPOSAL_EVAL_SCHEMA,
} from '../CollaborationProposalHandler.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { ChatParams, ChatResponse, LLMClient } from '@active-collaboration/llm-integration';
import { EventManager } from '../../events/EventManager.js';
import { EventType, EventPriority } from '@active-collaboration/shared';
import { TrajectoryRecorder } from '../../trajectory/index.js';
import { recordHandshakeToTrajectory } from '../../runtime/shaping/collaboration.js';
import type { SystemEvent } from '../../events/index.js';

const CANNED_ACCEPT = JSON.stringify({
  benefitScore: 0.9,
  costScore: 0.1,
  benefits: ['can help'],
  costs: [],
  recommendedDecision: 'accept',
  reasoning: 'cheap to help',
});

function okResponse(content: string): ChatResponse {
  return {
    content,
    model: 'mock-model',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface CapturedCall {
  params: ChatParams;
}

function setup(
  chat: (params: ChatParams) => Promise<ChatResponse>,
  llmTimeoutMs?: number,
) {
  const calls: CapturedCall[] = [];
  const llmClient = {
    chat: async (params: ChatParams) => {
      calls.push({ params });
      return chat(params);
    },
  } as unknown as LLMClient;

  const eventManager = new EventManager(1000);
  const handler = new CollaborationProposalHandler({
    llmClient,
    environment: { eventManager } as unknown as EnvironmentCenter,
    agentId: 'agent-1',
    agentName: 'Responder',
    agentCapabilities: ['cooling', 'temperature-control'],
    config: {
      enabled: true,
      criteria: { minBenefitThreshold: 0.5, maxCostThreshold: 0.7 },
      autoExecuteAccepted: false,
      notifyAllProposals: false,
      maxConcurrentCollaborations: 5,
      ...(llmTimeoutMs !== undefined ? { llmTimeoutMs } : {}),
    },
  });
  const published: Array<Record<string, unknown>> = [];
  eventManager.subscribe({
    subscriberId: 'recorder',
    eventType: EventType.COLLABORATION_MESSAGE,
    handler: event => {
      published.push(event.payload as Record<string, unknown>);
    },
    priority: EventPriority.NORMAL,
  });
  handler.start();
  return { eventManager, handler, published, calls };
}

function propose(eventManager: EventManager, requiredCapabilities?: string[]): void {
  eventManager.publish({
    type: EventType.COLLABORATION_MESSAGE,
    source: 'agent-2',
    priority: EventPriority.NORMAL,
    payload: {
      type: 'ac-proposal',
      collaborationId: 'ac-1',
      initiatorId: 'agent-2',
      targetAgentId: 'agent-1',
      description: 'Reduce grid load by shedding cooling',
      ...(requiredCapabilities !== undefined ? { requiredCapabilities } : {}),
    },
    metadata: {},
  });
}

describe('R5-F10 root fix — the evaluation lane uses guided JSON', () => {
  it('the evaluation call carries the schema, temperature 0 and a caller AbortSignal', async () => {
    const { eventManager, handler, published, calls } = setup(async () => okResponse(CANNED_ACCEPT));
    propose(eventManager, ['cooling']);
    await sleep(100);

    expect(calls).toHaveLength(1);
    expect(calls[0].params.format).toBe(PROPOSAL_EVAL_SCHEMA);
    expect(calls[0].params.temperature).toBe(0);
    // 768: verbose non-thinking reasoning fields hit the old 500 cap
    // mid-string (same family as R5-F13 on the decision lane).
    expect(calls[0].params.maxTokens).toBe(768);
    expect(calls[0].params.signal).toBeInstanceOf(AbortSignal);

    // 1.5B-path non-regression: a clean JSON answer still decides, labelled llm.
    const answers = published.filter(p => p.type === 'join-response');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ acDecision: 'accept', evaluationSource: 'llm' });
    expect('evaluationError' in answers[0]).toBe(false);
    handler.stop();
  });

  it('a schema-shaped (guided) response parses and decides — no extractJSON involvement needed', async () => {
    const guided = JSON.stringify({
      benefitScore: 0.2,
      costScore: 0.9,
      benefits: [],
      costs: ['too expensive'],
      recommendedDecision: 'reject',
      reasoning: 'costs outweigh benefits',
    });
    const { eventManager, handler, published } = setup(async () => okResponse(guided));
    propose(eventManager, ['cooling']);
    await sleep(100);

    const answers = published.filter(p => p.type === 'reject');
    expect(answers).toHaveLength(1);
    expect(answers[0].evaluationSource).toBe('llm');
    expect('evaluationError' in answers[0]).toBe(false);
    handler.stop();
  });
});

describe('R5-F10 tracing — degradation is never silent', () => {
  it('a timed-out evaluation aborts the underlying call and the fallback answer names the timeout', async () => {
    // A provider-shaped mock: hangs until the caller's signal aborts it,
    // then rejects like the real provider does (T-023).
    const hangUntilAbort = (params: ChatParams) =>
      new Promise<ChatResponse>((_resolve, reject) => {
        params.signal?.addEventListener('abort', () => {
          reject(new Error('Request to http://x/v1/chat/completions aborted by the caller'));
        });
      });
    const { eventManager, handler, published, calls } = setup(hangUntilAbort, 100);
    propose(eventManager, ['cooling']);
    await sleep(500);

    // The budget fired and CANCELLED the call (pre-fix the request was
    // orphaned and kept burning the queue slot until the provider timeout).
    expect(calls).toHaveLength(1);
    expect(calls[0].params.signal?.aborted).toBe(true);

    const answers = published.filter(p => p.type === 'join-response');
    expect(answers).toHaveLength(1);
    expect(answers[0].evaluationSource).toBe('fallback');
    expect(String(answers[0].evaluationError)).toContain('timed out after 100ms');
    handler.stop();
  });

  it('a failing client (e.g. the rule-only stub) degrades with the error on the answer', async () => {
    const { eventManager, handler, published } = setup(async () => {
      throw new Error('EngineRuntime: agent "agent-1" has no LLMClient (running rule-only)');
    });
    propose(eventManager, ['cooling']);
    await sleep(100);

    const answers = published.filter(p => p.type === 'join-response');
    expect(answers).toHaveLength(1);
    expect(answers[0].evaluationSource).toBe('fallback');
    expect(String(answers[0].evaluationError)).toContain('has no LLMClient');
    handler.stop();
  });

  it('unparseable LLM output degrades with the parse failure on the answer', async () => {
    const { eventManager, handler, published } = setup(async () => okResponse('not json at all'));
    propose(eventManager, ['cooling']);
    await sleep(100);

    const answers = published.filter(p => p.type === 'join-response');
    expect(answers).toHaveLength(1);
    expect(answers[0].evaluationSource).toBe('fallback');
    expect(String(answers[0].evaluationError)).toContain('analyzeWithLLM failed');
    handler.stop();
  });
});

// ---------------------------------------------------------------------------
// Shaping → trajectory: the error rides the collaboration-response record.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeRecorder(): TrajectoryRecorder {
  const dir = mkdtempSync(join(tmpdir(), 'r5f10-trajectory-test-'));
  tempDirs.push(dir);
  return new TrajectoryRecorder({
    outputDir: dir,
    condition: 'test',
    scenario: 'unit',
    iteration: 0,
    model: 'test-model',
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function answerEvent(payload: Record<string, unknown>): SystemEvent {
  return {
    id: 'evt-answer-1',
    type: EventType.COLLABORATION_MESSAGE,
    source: 'agent-1',
    timestamp: new Date(),
    payload,
    metadata: {},
  } as SystemEvent;
}

function readRecords(recorder: TrajectoryRecorder): Array<Record<string, unknown>> {
  return readFileSync(recorder.filePath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('R5-F10 tracing — recordHandshakeToTrajectory carries evaluationError', () => {
  it('a fallback answer records errorMessage alongside decisionSource fallback', () => {
    const recorder = makeRecorder();
    recordHandshakeToTrajectory(recorder, answerEvent({
      type: 'reject',
      acDecision: 'reject',
      agentId: 'agent-1',
      collaborationId: 'ac-1',
      reason: 'Capability-based rejection: only 1/3 matched',
      evaluationSource: 'fallback',
      evaluationError: '[Responder] analyzeWithLLM failed for proposal p-1: proposal evaluation LLM timed out after 30000ms',
    }), undefined);

    const records = readRecords(recorder);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'collaboration-response',
      decision: 'reject',
      decisionSource: 'fallback',
      errorMessage: expect.stringContaining('timed out'),
    });
  });

  it('an llm answer has no errorMessage — no false degradation signal', () => {
    const recorder = makeRecorder();
    recordHandshakeToTrajectory(recorder, answerEvent({
      type: 'join-response',
      acDecision: 'accept',
      agentId: 'agent-1',
      collaborationId: 'ac-2',
      reason: 'cheap to help',
      evaluationSource: 'llm',
    }), undefined);

    const records = readRecords(recorder);
    expect(records).toHaveLength(1);
    expect(records[0].decisionSource).toBe('llm');
    expect('errorMessage' in records[0]).toBe(false);
  });
});
