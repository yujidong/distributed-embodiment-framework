/**
 * Trajectory Recorder — mock-LLM smoke test (no GPU, no LLM backend)
 *
 * Runs ONE iteration of the single-room scenario against a MockLLMClient
 * (injected via PaperExperimentConfig.llmClient, which makes the runner skip
 * initializeLLM()/backend entirely) with recordTrajectories: true, then
 * verifies the trajectory JSONL on disk.
 *
 * The mock duck-types everything the runner/agents call on LLMClient in the
 * decision path: quickChat (ACNecessityAssessor), chat, setLoggingCallback,
 * setContextProvider, getProviderName, healthCheck. Like the real LLMClient,
 * it invokes the registered logging callback on every call.
 *
 * Scenario events are trimmed to 2 for speed (restored afterwards):
 *   - evt-sr-1 temperature-anomaly (severity high)
 *   - evt-sr-4 smoke-detected (severity critical)
 * In routed multi-agent mode all three single-room agents manage room-1, so
 * each event yields 3 (agent, event) assessments; agents lacking the event's
 * required capabilities fall through preCheck to the (mock) LLM.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LLMClient } from '@active-collaboration/llm-integration';

import { PaperExperimentRunner } from './paper-experiment-runner.js';
import { SCENARIOS } from './scenario-definitions.js';
import { getResultsBaseDir } from './result-persistence.js';
import type { TestEventDef } from './types.js';

// ---------------------------------------------------------------------------
// MockLLMClient
// ---------------------------------------------------------------------------

/** Structural mirror of the LLMClient logging-callback parameter object. */
interface MockLogParams {
  systemPrompt?: string;
  userPrompt: string;
  response: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs: number;
  model?: string;
  success: boolean;
  errorMessage?: string;
  context?: {
    agentId?: string;
    agentName?: string;
    interactionType?: string;
    decisionContext?: string;
    eventId?: string;
  };
}

class MockLLMClient {
  static readonly MODEL = 'mock-model';
  /** Canned structured decision the assessor's JSON path accepts. */
  static readonly CANNED = JSON.stringify({ decision: 'collaborate', reasoning: 'mock' });

  private loggingCallback: ((params: MockLogParams) => void) | null = null;
  private contextProvider: (() => MockLogParams['context']) | null = null;

  setLoggingCallback(callback: ((params: MockLogParams) => void) | null): void {
    this.loggingCallback = callback;
  }

  setContextProvider(provider: () => MockLogParams['context']): void {
    this.contextProvider = provider;
  }

  getProviderName(): string {
    return 'mock';
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async quickChat(content: string, systemPrompt?: string): Promise<{
    content: string;
    model: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  }> {
    const start = Date.now();
    const response = {
      content: MockLLMClient.CANNED,
      model: MockLLMClient.MODEL,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };

    // Invoke the registered logging callback exactly like LLMClient.chat does
    this.loggingCallback?.({
      systemPrompt,
      userPrompt: content,
      response: response.content,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
      durationMs: Date.now() - start,
      model: response.model,
      success: true,
      context: this.contextProvider?.() ?? {},
    });

    return response;
  }

  async chat(params: {
    messages: Array<{ role: string; content: string }>;
  }): Promise<{
    content: string;
    model: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  }> {
    const userPrompt = params.messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join('\n');
    const systemPrompt = params.messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
      .join('\n');
    return this.quickChat(userPrompt, systemPrompt);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DECISIONS = ['initiate_ac', 'handle_independently', 'defer', 'ignore'];
const INTERACTION_TYPES = ['A', 'B', 'C', 'D', 'E'];
const TRAJECTORY_FILE = join(
  getResultsBaseDir(),
  'trajectories',
  `full-ac-iter0-single-room-${MockLLMClient.MODEL}.jsonl`,
);

function readTrajectoryRecords(): Array<Record<string, any>> {
  return readFileSync(TRAJECTORY_FILE, 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

function expectRequiredFields(record: Record<string, any>): void {
  expect(typeof record.recordedAt).toBe('string');
  expect(record.scenario).toBe('single-room');
  expect(record.condition).toBe('full-ac');
  expect(record.iteration).toBe(0);
  expect(typeof record.eventId).toBe('string');
  expect(typeof record.agentId).toBe('string');
  expect(record.context).toBeDefined();
  expect(Array.isArray(record.context.capabilities)).toBe(true);
  expect(Array.isArray(record.context.partnerServices)).toBe(true);
  expect(DECISIONS).toContain(record.decision);
  expect(['precheck', 'llm']).toContain(record.decisionSource);
  expect(record.groundTruth).toBeDefined();
  expect(DECISIONS).toContain(record.groundTruth.correctDecision);
  expect(INTERACTION_TYPES).toContain(record.groundTruth.interactionType);
  expect(typeof record.correct).toBe('boolean');
  if (record.goalAchieved !== undefined) {
    expect(typeof record.goalAchieved).toBe('boolean');
  }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('TrajectoryRecorder smoke test (mock LLM, no backend)', () => {
  const scenario = SCENARIOS['single-room'];
  let originalEvents: TestEventDef[];

  beforeAll(() => {
    // Trim to 2 events for speed; restore afterwards.
    originalEvents = scenario.events;
    scenario.events = originalEvents.filter(e => e.id === 'evt-sr-1' || e.id === 'evt-sr-4');
  });

  afterAll(() => {
    scenario.events = originalEvents;
  });

  it('records per-(event, agent) trajectories in routed multi-agent mode', async () => {
    const mock = new MockLLMClient();
    const config = PaperExperimentRunner.createConfig({
      id: 'trajectory-smoke-multi',
      name: 'Trajectory Recorder Smoke (multi-agent)',
      rq: 'RQ1',
      scenario: 'single-room',
      condition: 'full-ac',
      iterations: 1,
      llmModel: MockLLMClient.MODEL,
      timeoutMs: 10000,
      decisionOnly: true,
      multiAgentEval: true,
      recordTrajectories: true,
      llmClient: mock as unknown as LLMClient,
    });

    await new PaperExperimentRunner(config).runIteration(0);

    expect(existsSync(TRAJECTORY_FILE)).toBe(true);
    const records = readTrajectoryRecords();
    console.log(`[smoke] multi-agent: ${records.length} trajectory records → ${TRAJECTORY_FILE}`);
    expect(records.length).toBeGreaterThanOrEqual(1);

    for (const record of records) {
      expectRequiredFields(record);
    }

    // Both trimmed events must be covered, and at least one record must come
    // from an actual (mock) LLM call with prompt + raw response captured.
    expect(new Set(records.map(r => r.eventId))).toEqual(new Set(['evt-sr-1', 'evt-sr-4']));

    const llmRecords = records.filter(r => r.decisionSource === 'llm');
    expect(llmRecords.length).toBeGreaterThanOrEqual(1);
    for (const record of llmRecords) {
      expect(typeof record.prompt?.userPrompt).toBe('string');
      expect(record.prompt.userPrompt.length).toBeGreaterThan(0);
      expect(typeof record.rawResponse).toBe('string');
      expect(record.rawResponse.length).toBeGreaterThan(0);
      expect(record.model).toBe(MockLLMClient.MODEL);
      expect(record.promptTokens).toBe(10);
      expect(record.completionTokens).toBe(5);
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
    }
  }, 60000);

  it('records trajectories in single-agent mode (collectEventResult path)', async () => {
    const mock = new MockLLMClient();
    const config = PaperExperimentRunner.createConfig({
      id: 'trajectory-smoke-single',
      name: 'Trajectory Recorder Smoke (single-agent)',
      rq: 'RQ1',
      scenario: 'single-room',
      condition: 'full-ac',
      iterations: 1,
      llmModel: MockLLMClient.MODEL,
      timeoutMs: 10000,
      decisionOnly: true,
      recordTrajectories: true,
      llmClient: mock as unknown as LLMClient,
    });

    await new PaperExperimentRunner(config).runIteration(0);

    expect(existsSync(TRAJECTORY_FILE)).toBe(true);
    const records = readTrajectoryRecords();
    console.log(`[smoke] single-agent: ${records.length} trajectory records → ${TRAJECTORY_FILE}`);
    expect(records.length).toBeGreaterThanOrEqual(1);

    for (const record of records) {
      expectRequiredFields(record);
      // Single-agent mode: only the primary (first) agent assesses events.
      expect(record.agentId).toBe('climate-agent');
    }
  }, 60000);
});
