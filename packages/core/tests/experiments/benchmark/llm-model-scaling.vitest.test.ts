/**
 * LLM Model Scaling Comparison Experiment (RQ1.2)
 *
 * Research Question: How does LLM model size and family affect
 * service composition performance?
 *
 * Hypothesis: Larger models achieve higher semantic understanding but with
 * increased latency trade-off. The AC framework should work across different
 * model families, demonstrating generalization capability.
 *
 * Paper Section: Evaluation
 *
 * IMPORTANT: This experiment uses multiple model families (Qwen, Llama, DeepSeek)
 * to demonstrate that the AC framework is not optimized for any specific model,
 * but works across different LLM architectures.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LLMClient, initializeLLM } from '@active-collaboration/llm-integration';
import {
  TimeManager,
  PhysicalEnvironment,
  DeviceFactory,
  type SimulatedDevice,
} from '@active-collaboration/simulation';
import { CognitiveAgent } from '../../../src/agent/CognitiveAgent.js';
import { EnvironmentCenter } from '../../../src/environment/EnvironmentCenter.js';
import { AgentProfileFactory } from '../../../src/goal/index.js';
import { TIMEOUT_CONFIG, TEST_LOCATIONS, generateWithLLM } from '../../utils/index.js';

/**
 * Model Configuration for Multi-Family Comparison
 *
 * Key Design Principles:
 * 1. Include multiple model families (Qwen, Llama, DeepSeek, Mistral)
 * 2. Organize by parameter size (Small, Medium, Large, XL)
 * 3. Use latest available versions where possible
 * 4. Test both general-purpose and code-specialized models
 */
interface ModelConfig {
  id: string;
  family: 'qwen' | 'llama' | 'deepseek' | 'mistral' | 'phi';
  displayName: string;
  parameters: string;
  quantization: string;
  contextWindow: number;
  category: 'small' | 'medium' | 'large' | 'xlarge';
}

const MODEL_CONFIGS: ModelConfig[] = [
  // ============================================
  // Small Models (1.5B - 3B parameters)
  // ============================================
  {
    id: 'qwen2.5:1.5b',
    family: 'qwen',
    displayName: 'Qwen 2.5 1.5B',
    parameters: '1.5B',
    quantization: 'FP16',
    contextWindow: 32768,
    category: 'small',
  },
  {
    id: 'phi3:mini',
    family: 'phi',
    displayName: 'Phi-3 Mini 3.8B',
    parameters: '3.8B',
    quantization: 'Q4',
    contextWindow: 128000,
    category: 'small',
  },

  // ============================================
  // Medium Models (7B - 8B parameters)
  // ============================================
  {
    id: 'qwen2.5:7b',
    family: 'qwen',
    displayName: 'Qwen 2.5 7B',
    parameters: '7B',
    quantization: 'Q4',
    contextWindow: 32768,
    category: 'medium',
  },
  {
    id: 'llama3.1:8b',
    family: 'llama',
    displayName: 'Llama 3.1 8B',
    parameters: '8B',
    quantization: 'Q4',
    contextWindow: 128000,
    category: 'medium',
  },
  {
    id: 'mistral:7b',
    family: 'mistral',
    displayName: 'Mistral 7B v0.3',
    parameters: '7B',
    quantization: 'Q4',
    contextWindow: 32768,
    category: 'medium',
  },

  // ============================================
  // Large Models (14B parameters)
  // ============================================
  {
    id: 'qwen3-14b-q4:latest',
    family: 'qwen',
    displayName: 'Qwen 3 14B',
    parameters: '14B',
    quantization: 'Q4',
    contextWindow: 32768,
    category: 'large',
  },
  {
    id: 'deepseek-coder:6.7b', // Alternative if 14B not available
    family: 'deepseek',
    displayName: 'DeepSeek Coder 6.7B',
    parameters: '6.7B',
    quantization: 'Q4',
    contextWindow: 16384,
    category: 'large',
  },

  // ============================================
  // Extra Large Models (32B+ parameters)
  // ============================================
  {
    id: 'qwen3-32b-q4:latest',
    family: 'qwen',
    displayName: 'Qwen 3 32B',
    parameters: '32B',
    quantization: 'Q4',
    contextWindow: 32768,
    category: 'xlarge',
  },
  {
    id: 'deepseek-v2:16b',
    family: 'deepseek',
    displayName: 'DeepSeek V2 16B',
    parameters: '16B',
    quantization: 'Q4',
    contextWindow: 65536,
    category: 'xlarge',
  },
  {
    id: 'llama3.1:70b',
    family: 'llama',
    displayName: 'Llama 3.1 70B',
    parameters: '70B',
    quantization: 'Q4',
    contextWindow: 128000,
    category: 'xlarge',
  },
];

/**
 * Task definitions for model comparison
 * These tasks are designed to test different aspects of model capability
 */
const MODEL_COMPARISON_TASKS = [
  // === Exact Match Tasks ===
  {
    id: 'exact-temp-001',
    category: 'exact-match',
    description: 'Read temperature from sensor living-room-temp',
    expectedCapabilities: ['temperature-sensing'],
    difficulty: 1,
  },
  {
    id: 'exact-hvac-001',
    category: 'exact-match',
    description: 'Set HVAC target temperature to 22 degrees',
    expectedCapabilities: ['hvac-control'],
    difficulty: 1,
  },

  // === Semantic Inference Tasks ===
  {
    id: 'semantic-comfort-001',
    category: 'semantic-inference',
    description: 'Make the room comfortable for occupants',
    expectedCapabilities: ['temperature-sensing', 'hvac-control'],
    difficulty: 3,
    requiresInference: true,
  },
  {
    id: 'semantic-energy-001',
    category: 'semantic-inference',
    description: 'Optimize energy usage without sacrificing comfort',
    expectedCapabilities: ['energy-monitoring', 'hvac-control', 'scheduling'],
    difficulty: 4,
    requiresInference: true,
  },

  // === Complex Composition Tasks ===
  {
    id: 'composition-multi-001',
    category: 'composition',
    description: 'Coordinate HVAC, lighting, and security based on occupancy patterns',
    expectedCapabilities: ['hvac-control', 'lighting-control', 'security-monitoring', 'occupancy-sensing'],
    difficulty: 5,
  },
  {
    id: 'composition-emergency-001',
    category: 'composition',
    description: 'Implement emergency response protocol with multi-zone coordination',
    expectedCapabilities: ['alert-system', 'communication', 'coordination', 'location-tracking'],
    difficulty: 6,
  },

  // === Cross-Domain Tasks ===
  {
    id: 'cross-domain-001',
    category: 'cross-domain',
    description: 'Integrate weather data with HVAC for predictive climate control',
    expectedCapabilities: ['weather-api', 'hvac-control', 'prediction'],
    difficulty: 5,
  },
];

interface ModelTestResult {
  model: ModelConfig;
  successRate: number;
  semanticScore: number;
  avgLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  tokenEfficiency: number;
  parsingSuccessRate: number;
  tasksCompleted: number;
  tasksTotal: number;
  latencyMeasurements: number[];
  errors: string[];
}

// Test state
const testResults: ModelTestResult[] = [];
const availableModels: ModelConfig[] = [];

describe('LLM Model Scaling Comparison Experiment (RQ1.2)', () => {
  beforeAll(async () => {
    console.log('\n========================================');
    console.log('[RQ1.2] LLM Model Scaling Comparison Experiment');
    console.log('========================================');
    console.log('\nPurpose: Test AC framework across different LLM families');
    console.log('Model Families: Qwen, Llama, DeepSeek, Mistral, Phi\n');

    // Check which models are available
    console.log('[RQ1.2] Checking available models...');
    for (const model of MODEL_CONFIGS) {
      try {
        const initResult = await initializeLLM({
          preferredModels: [model.id],
          allowFallback: false,
        });

        if (initResult.success) {
          availableModels.push(model);
          console.log(`  ✅ ${model.displayName} (${model.id})`);
        }
      } catch {
        // Model not available
      }
    }

    if (availableModels.length === 0) {
      console.log('  ⚠️ No models available, using fallback');
      // Use default initialization
      const initResult = await initializeLLM({
        preferredModels: MODEL_CONFIGS.map(m => m.id),
        allowFallback: true,
      });
      if (initResult.success) {
        const foundModel = MODEL_CONFIGS.find(m => m.id === initResult.selectedModel);
        if (foundModel) {
          availableModels.push(foundModel);
        }
      }
    }

    console.log(`\n[RQ1.2] ${availableModels.length} models available for testing\n`);
  }, TIMEOUT_CONFIG.testTimeout * 2);

  describe('Model Family Comparison', () => {
    // Group by family for comparison - use static list to ensure tests are registered
    const families = ['qwen', 'llama', 'deepseek', 'mistral', 'phi'] as const;

    families.forEach((family) => {
      it(`should test ${family.toUpperCase()} family models if available`, async () => {
        const familyModels = availableModels.filter(m => m.family === family);

        if (familyModels.length === 0) {
          console.log(`[RQ1.2] No ${family} models available, skipping`);
          return;
        }

        for (const model of familyModels) {
          console.log(`\n[RQ1.2] Testing ${model.displayName}...`);

          const result = await testModel(model);
          testResults.push(result);

          console.log(`  Success Rate: ${(result.successRate * 100).toFixed(1)}%`);
          console.log(`  Semantic Score: ${result.semanticScore.toFixed(2)}`);
          console.log(`  Avg Latency: ${result.avgLatency.toFixed(0)}ms`);
          console.log(`  P95 Latency: ${result.p95Latency.toFixed(0)}ms`);
        }

        // Verify that results were collected for each model tested in this family
        for (const model of familyModels) {
          const result = testResults.find(r => r.model.id === model.id);
          if (result) {
            expect(result.successRate).toBeGreaterThanOrEqual(0);
            expect(result.successRate).toBeLessThanOrEqual(1);
            expect(result.semanticScore).toBeGreaterThanOrEqual(0);
            expect(result.avgLatency).toBeGreaterThan(0);
            expect(result.tasksTotal).toBeGreaterThan(0);
          }
        }
      }, TIMEOUT_CONFIG.testTimeout * 5);
    });
  });

  describe('Size Category Comparison', () => {
    const categories = ['small', 'medium', 'large', 'xlarge'] as const;

    categories.forEach((category) => {
      it(`should analyze ${category} models category if available`, async () => {
        const categoryResults = testResults.filter(r => r.model.category === category);

        if (categoryResults.length === 0) {
          console.log(`[RQ1.2] No ${category} model results available, skipping analysis`);
          return;
        }

        const avgSuccess = categoryResults.reduce((sum, r) => sum + r.successRate, 0) / categoryResults.length;
        const avgLatency = categoryResults.reduce((sum, r) => sum + r.avgLatency, 0) / categoryResults.length;

        console.log(`\n[RQ1.2] ${category.toUpperCase()} Category Summary:`);
        console.log(`  Models: ${categoryResults.length}`);
        console.log(`  Avg Success Rate: ${(avgSuccess * 100).toFixed(1)}%`);
        console.log(`  Avg Latency: ${avgLatency.toFixed(0)}ms`);

        // Verify computed metrics are valid for this category
        expect(avgSuccess).toBeGreaterThanOrEqual(0);
        expect(avgSuccess).toBeLessThanOrEqual(1);
        expect(avgLatency).toBeGreaterThan(0);
        expect(categoryResults.length).toBeGreaterThan(0);
      });
    });
  });

  afterAll(() => {
    console.log('\n========================================');
    console.log('[RQ1.2] LLM Model Scaling Summary');
    console.log('========================================\n');

    if (testResults.length === 0) {
      console.log('No test results available.');
      return;
    }

    // Sort by success rate
    const sorted = [...testResults].sort((a, b) => b.successRate - a.successRate);

    console.log('| Model | Family | Size | Success | Semantic | Latency | P95 |');
    console.log('|-------|--------|------|---------|----------|---------|-----|');
    sorted.forEach((r) => {
      console.log(
        `| ${r.model.displayName.padEnd(20)} | ` +
        `${r.model.family.padEnd(8)} | ` +
        `${r.model.parameters.padEnd(4)} | ` +
        `${(r.successRate * 100).toFixed(1).padStart(5)}% | ` +
        `${r.semanticScore.toFixed(2).padStart(8)} | ` +
        `${r.avgLatency.toFixed(0).padStart(5)}ms | ` +
        `${r.p95Latency.toFixed(0).padStart(4)}ms |`
      );
    });

    // Family comparison
    console.log('\n=== Family Comparison ===');
    const familyGroups = groupBy(testResults, (r) => r.model.family);
    Object.entries(familyGroups).forEach(([family, results]) => {
      const avgSuccess = results.reduce((sum, r) => sum + r.successRate, 0) / results.length;
      const avgLatency = results.reduce((sum, r) => sum + r.avgLatency, 0) / results.length;
      console.log(
        `  ${family.toUpperCase().padEnd(10)}: ` +
        `Success ${(avgSuccess * 100).toFixed(1)}%, ` +
        `Latency ${avgLatency.toFixed(0)}ms ` +
        `(${results.length} models)`
      );
    });

    // Size comparison
    console.log('\n=== Size Category Comparison ===');
    const sizeGroups = groupBy(testResults, (r) => r.model.category);
    ['small', 'medium', 'large', 'xlarge'].forEach((size) => {
      const results = sizeGroups[size] || [];
      if (results.length > 0) {
        const avgSuccess = results.reduce((sum, r) => sum + r.successRate, 0) / results.length;
        const avgLatency = results.reduce((sum, r) => sum + r.avgLatency, 0) / results.length;
        console.log(
          `  ${size.toUpperCase().padEnd(8)}: ` +
          `Success ${(avgSuccess * 100).toFixed(1)}%, ` +
          `Latency ${avgLatency.toFixed(0)}ms`
        );
      }
    });

    // Key findings
    console.log('\n=== Key Findings ===');
    const bestModel = sorted[0];
    const worstModel = sorted[sorted.length - 1];
    console.log(`✅ Best Model: ${bestModel.model.displayName} (${(bestModel.successRate * 100).toFixed(1)}%)`);
    console.log(`❌ Worst Model: ${worstModel.model.displayName} (${(worstModel.successRate * 100).toFixed(1)}%)`);

    // Framework generalization evidence
    const familiesUsed = new Set(testResults.map(r => r.model.family));
    console.log(`\n🔬 Framework Generalization: Tested across ${familiesUsed.size} model families`);
    console.log(`   Families: ${Array.from(familiesUsed).join(', ')}`);

    // Cost-effectiveness analysis
    const costEffective = [...testResults].sort(
      (a, b) => (b.successRate / b.avgLatency) - (a.successRate / a.avgLatency)
    )[0];
    console.log(`\n💰 Most Cost-Effective: ${costEffective.model.displayName}`);
    console.log(`   (Success/Latency ratio: ${(costEffective.successRate / costEffective.avgLatency * 1000).toFixed(3)})`);
  });
});

/**
 * Test a specific model
 */
async function testModel(model: ModelConfig): Promise<ModelTestResult> {
  const tasks = MODEL_COMPARISON_TASKS;
  const latencies: number[] = [];
  let successful = 0;
  let semanticScore = 0;
  let parsingSuccess = 0;
  let totalTokens = 0;
  const errors: string[] = [];

  // Initialize LLM for this model
  let llmClient: LLMClient;
  try {
    const initResult = await initializeLLM({
      preferredModels: [model.id],
      allowFallback: false,
    });

    if (!initResult.success) {
      return {
        model,
        successRate: 0,
        semanticScore: 0,
        avgLatency: 0,
        p50Latency: 0,
        p95Latency: 0,
        p99Latency: 0,
        tokenEfficiency: 0,
        parsingSuccessRate: 0,
        tasksCompleted: 0,
        tasksTotal: tasks.length,
        latencyMeasurements: [],
        errors: [`Failed to initialize: ${initResult.error}`],
      };
    }

    llmClient = new LLMClient('ollama', { model: initResult.selectedModel });
  } catch (error) {
    return {
      model,
      successRate: 0,
      semanticScore: 0,
      avgLatency: 0,
      p50Latency: 0,
      p95Latency: 0,
      p99Latency: 0,
      tokenEfficiency: 0,
      parsingSuccessRate: 0,
      tasksCompleted: 0,
      tasksTotal: tasks.length,
      latencyMeasurements: [],
      errors: [`Initialization error: ${error}`],
    };
  }

  for (const task of tasks) {
    const startTime = Date.now();

    try {
      // Create test environment
      const env = createTestEnvironment();
      const agent = createTestAgent(env.envCenter, llmClient);

      // Generate prompt
      const prompt = generateModelTestPrompt(task);

      // Execute LLM call
      const response = await generateWithLLM(llmClient, prompt, {
        temperature: 0.3,
        maxTokens: 1000,
      });

      const elapsed = Date.now() - startTime;
      latencies.push(elapsed);

      // Track tokens (approximate based on response length)
      totalTokens += Math.ceil(response.content.length / 4); // Rough token estimate

      // Parse and evaluate
      const parseResult = parseModelResponse(response.content);
      if (parseResult.success) {
        parsingSuccess++;

        const semantic = evaluateSemanticMatch(parseResult.actions, task);
        semanticScore += semantic.score;

        if (semantic.score >= 0.6) {
          successful++;
        }
      }

      // Cleanup
      env.envCenter.stopPhysicsSimulation?.();

    } catch (error) {
      errors.push(`${task.id}: ${error}`);
      latencies.push(Date.now() - startTime);
    }
  }

  // Calculate latency percentiles
  latencies.sort((a, b) => a - b);
  const p50 = getPercentile(latencies, 50);
  const p95 = getPercentile(latencies, 95);
  const p99 = getPercentile(latencies, 99);

  return {
    model,
    successRate: successful / tasks.length,
    semanticScore: semanticScore / tasks.length,
    avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p50Latency: p50,
    p95Latency: p95,
    p99Latency: p99,
    tokenEfficiency: totalTokens > 0 ? semanticScore / totalTokens : 0,
    parsingSuccessRate: parsingSuccess / tasks.length,
    tasksCompleted: successful,
    tasksTotal: tasks.length,
    latencyMeasurements: latencies,
    errors,
  };
}

function createTestEnvironment() {
  const timeManager = new TimeManager({ timeScale: 1 });
  const physicalEnvironment = new PhysicalEnvironment(timeManager, {
    enablePhysics: true,
    physicsConfig: { updateInterval: 100, propagationSpeed: 0.5 },
  });

  const envCenter = new EnvironmentCenter({
    id: `test-env-${Date.now()}`,
    name: 'Model Scaling Test Environment',
    createdBy: 'experiment',
    createdAt: new Date(),
    updatedAt: new Date(),
    physicalEnvironment,
  });

  envCenter.startPhysicsSimulation?.();
  return { envCenter, physicalEnvironment, timeManager };
}

function createTestAgent(envCenter: EnvironmentCenter, llmClient: LLMClient): CognitiveAgent {
  const profile = AgentProfileFactory.createBalancedAgent();
  profile.id = `agent-${Date.now()}`;

  return new CognitiveAgent({
    id: profile.id,
    name: 'ModelTestAgent',
    description: 'Agent for model comparison testing',
    owner: 'experiment',
    environment: envCenter,
    llmClient,
    agentProfile: profile,
    capabilities: [
      'temperature-sensing', 'hvac-control', 'energy-monitoring',
      'scheduling', 'alert-system', 'communication', 'coordination',
      'location-tracking', 'security-monitoring', 'occupancy-sensing',
      'lighting-control', 'weather-api', 'prediction',
    ],
  });
}

function generateModelTestPrompt(task: typeof MODEL_COMPARISON_TASKS[0]): string {
  return `
You are an IoT agent managing a smart environment.

=== AVAILABLE DEVICES ===
- living-room-temp: Temperature sensor (temperature-sensing)
- hvac-main: HVAC controller (hvac-control, temperature-adjustment)
- energy-meter-01: Energy meter (energy-monitoring, consumption-tracking)
- motion-entrance: Motion sensor (motion-detection, occupancy-sensing)
- lighting-zone-a: Smart lighting (lighting-control, dimming)
- security-main: Security system (security-monitoring, alert-system)
- weather-api: Weather service (weather-api, forecast)

=== TASK ===
${task.description}

=== DIFFICULTY ===
${task.difficulty}/6

=== REQUIRED CAPABILITIES ===
${task.expectedCapabilities.join(', ')}

=== INSTRUCTIONS ===
Analyze the task and respond with a JSON object containing:
1. "analysis": Your understanding of the task
2. "selectedDevices": Array of device IDs to use
3. "actions": Array of actions to take
4. "reasoning": Why you chose this approach

Respond ONLY with valid JSON.
`;
}

interface ParsedResponse {
  success: boolean;
  actions: Array<{
    device?: string;
    action?: string;
    parameters?: Record<string, any>;
    analysis?: string;
  }>;
}

function parseModelResponse(response: string): ParsedResponse {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const actions = [];

      if (parsed.selectedDevices) {
        actions.push({ device: parsed.selectedDevices });
      }
      if (parsed.actions) {
        actions.push(...parsed.actions);
      }
      if (parsed.analysis) {
        actions.push({ analysis: parsed.analysis });
      }

      return { success: true, actions };
    }
    return { success: false, actions: [] };
  } catch {
    return { success: false, actions: [] };
  }
}

function evaluateSemanticMatch(
  actions: ParsedResponse['actions'],
  task: typeof MODEL_COMPARISON_TASKS[0]
): { score: number } {
  const actionText = JSON.stringify(actions).toLowerCase();
  const taskKeywords = task.description.toLowerCase().split(/\W+/).filter(w => w.length > 2);

  let score = 0;

  // Keyword overlap
  const matchedKeywords = taskKeywords.filter(k => actionText.includes(k));
  score += (matchedKeywords.length / taskKeywords.length) * 0.4;

  // Capability coverage
  if (task.expectedCapabilities.length > 0) {
    const coveredCaps = task.expectedCapabilities.filter(cap =>
      actionText.includes(cap.toLowerCase().replace('-', ' '))
    );
    score += (coveredCaps.length / task.expectedCapabilities.length) * 0.4;
  } else {
    score += 0.4; // For inference tasks
  }

  // Structure quality
  if (actions.some(a => a.device && a.action)) {
    score += 0.2;
  }

  return { score: Math.min(score, 1) };
}

function getPercentile(sortedArray: number[], percentile: number): number {
  if (sortedArray.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
  return sortedArray[Math.max(0, index)];
}

function groupBy<T, K extends string>(array: T[], keyFn: (item: T) => K): Record<K, T[]> {
  return array.reduce((groups, item) => {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
    return groups;
  }, {} as Record<K, T[]>);
}
