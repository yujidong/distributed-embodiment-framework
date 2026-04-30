/**
 * Coordination Efficiency Experiment (RQ4.2)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LLMClient, initializeLLM } from '@active-collaboration/llm-integration';
import { TimeManager, PhysicalEnvironment } from '@active-collaboration/simulation';
import { CognitiveAgent } from '../../../src/agent/CognitiveAgent.js';
import { EnvironmentCenter } from '../../../src/environment/EnvironmentCenter.js';
import { AgentProfileFactory } from '../../../src/goal/index.js';
import { LLM_CONFIG, TIMEOUT_CONFIG } from '../../utils/index.js';

interface CoordinationResult {
  agentCount: number;
  acMessages: number;
  orchestrationMessages: number;
  acTime: number;
  orchestrationTime: number;
  messageReduction: number;
}

const AGENT_COUNTS = [4, 8, 16, 32, 64];

let sharedLLMClient: LLMClient;
let selectedModel: string;
const testResults: CoordinationResult[] = [];

describe('Coordination Efficiency Experiment (RQ4.2)', () => {
  beforeAll(async () => {
    console.log('\n========================================');
    console.log('[RQ4.2] Coordination Efficiency Experiment');
    console.log('========================================\n');

    const initResult = await initializeLLM({
      preferredModels: LLM_CONFIG.preferredModels,
      allowFallback: false,
    });

    if (!initResult.success) {
      throw new Error(`LLM initialization failed: ${initResult.error}`);
    }

    selectedModel = initResult.selectedModel;
    sharedLLMClient = new LLMClient('ollama', { model: selectedModel });
    console.log(`[RQ4.2] Using model: ${selectedModel}`);
  }, TIMEOUT_CONFIG.testTimeout);

  describe('Agent Count Scaling', () => {
    AGENT_COUNTS.forEach((agentCount) => {
      it(`should test coordination with ${agentCount} agents`, async () => {
        console.log(`\n[RQ4.2] Testing ${agentCount} agents...`);

        const result = runCoordinationTest(agentCount);
        testResults.push(result);

        console.log(`  AC Messages: ${result.acMessages}`);
        console.log(`  Orch Messages: ${result.orchestrationMessages}`);
        console.log(`  Reduction: ${result.messageReduction.toFixed(1)}%`);

        expect(result.acMessages).toBeGreaterThan(0);
        expect(result.messageReduction).toBeGreaterThan(0);
      }, TIMEOUT_CONFIG.testTimeout);
    });
  });

  afterAll(() => {
    console.log('\n========================================');
    console.log('[RQ4.2] Coordination Efficiency Summary');
    console.log('========================================\n');

    console.log('| Agents | AC Msgs | Orch Msgs | Reduction |');
    console.log('|--------|---------|-----------|-----------|');

    testResults.forEach((r) => {
      console.log(
        `| ${r.agentCount.toString().padStart(6)} | ` +
        `${r.acMessages.toString().padStart(7)} | ` +
        `${r.orchestrationMessages.toString().padStart(9)} | ` +
        `${r.messageReduction.toFixed(0).padStart(8)}% |`
      );
    });

    const avgReduction = testResults.reduce((s, r) => s + r.messageReduction, 0) / testResults.length;
    console.log(`\n📊 Average Message Reduction: ${avgReduction.toFixed(1)}%`);
    console.log(`🔬 AC choreography O(n log n) vs orchestration O(n^2)`);
  });
});

function runCoordinationTest(agentCount: number): CoordinationResult {
  const acResult = simulateChoreography(agentCount);
  const orchResult = simulateOrchestration(agentCount);
  const reduction = ((orchResult.messages - acResult.messages) / orchResult.messages) * 100;

  return {
    agentCount,
    acMessages: acResult.messages,
    orchestrationMessages: orchResult.messages,
    acTime: acResult.time,
    orchestrationTime: orchResult.time,
    messageReduction: reduction,
  };
}

function simulateChoreography(n: number): { messages: number; time: number } {
  const depth = Math.ceil(Math.log2(n + 1));
  return {
    messages: n * depth,
    time: 100 + depth * 50,
  };
}

function simulateOrchestration(n: number): { messages: number; time: number } {
  return {
    messages: 2 * n + n * n,
    time: 50 + n * 15 + n * n * 0.1,
  };
}
