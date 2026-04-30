/**
 * Quick Verification Test for GA vs AC Experiment
 *
 * Runs a small subset (4 tasks per complexity = 16 total) to verify:
 * - Statistics utilities work correctly (no Infinity/NaN)
 * - GA runs with optimizations
 * - Parallel processing works
 * - Results are collected properly
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { LLMClient, initializeLLM } from '@active-collaboration/llm-integration';
import {
  TimeManager,
  PhysicalEnvironment,
} from '@active-collaboration/simulation';
import { EnvironmentCenter } from '../../../src/environment/EnvironmentCenter.js';
import {
  LLM_CONFIG,
  TIMEOUT_CONFIG,
  generateWithLLM,
  GeneticAlgorithm,
  createIoTFitnessFunction,
  createServiceCapabilityMap,
  type GAConfig,
  generateGATasks,
  compareTwoGroups,
  holmBonferroniCorrection,
  descriptiveStats,
  runParallel,
} from '../../utils/index.js';

// ============================================
// Types
// ============================================

type TaskComplexity = 'easy' | 'medium' | 'hard' | 'extreme';

interface GATask {
  id: string;
  description: string;
  requiredCapabilities: string[];
  complexity: TaskComplexity;
}

interface ComparisonResult {
  taskId: string;
  complexity: TaskComplexity;
  gaSuccess: boolean;
  gaProcessingTime: number;
  gaGenerations: number;
  gaFitness: number;
  acSuccess: boolean;
  acProcessingTime: number;
  semanticScore: number;
}

// ============================================
// Configuration - REDUCED for quick verification
// ============================================

const GA_CONFIG: Partial<GAConfig> = {
  populationSize: 30,
  maxGenerations: 50,
  mutationRate: 0.15,
  crossoverRate: 0.8,
  elitismCount: 2,
  tournamentSize: 3,
  maxTime: 2000,
};

const SERVICE_POOL = [
  'temperature-sensor-001', 'temperature-sensor-002',
  'humidity-sensor-001', 'hvac-controller-001',
  'light-controller-001', 'motion-sensor-001',
  'lock-controller-001', 'security-camera-001',
];

const SERVICE_CAPABILITIES = createServiceCapabilityMap(SERVICE_POOL);

let sharedLLMClient: LLMClient;
let selectedModel: string;

// Generate only 16 tasks (4 per complexity) for quick verification
const TASKS_PER_COMPLEXITY = 4;
const GA_TASKS: GATask[] = generateGATasks(TASKS_PER_COMPLEXITY * 4);

// ============================================
// Test Suite
// ============================================

describe('Quick Verification: AC vs GA Experiment', () => {
  beforeAll(async () => {
    console.log('\n========================================');
    console.log('[QUICK VERIFY] Testing with 16 tasks');
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
    console.log(`[QUICK VERIFY] Using model: ${selectedModel}`);
  }, TIMEOUT_CONFIG.testTimeout);

  it('should verify statistics utilities work correctly', () => {
    // Test with identical data (edge case)
    const identical = [1, 1, 1, 1, 1];
    const statsIdentical = descriptiveStats(identical);

    expect(Number.isFinite(statsIdentical.mean)).toBe(true);
    expect(Number.isFinite(statsIdentical.stdDev)).toBe(true);
    // Note: variance is not a direct property of DescriptiveStats

    // Test comparison with identical groups
    const comparison = compareTwoGroups([1, 1, 1], [1, 1, 1]);
    expect(Number.isFinite(comparison.testResult.pValue)).toBe(true);
    expect(comparison.testResult.pValue).toBeGreaterThan(0);
    expect(comparison.testResult.pValue).toBeLessThanOrEqual(1);

    // Test Holm-Bonferroni correction
    const pValues = [0.01, 0.02, 0.03, 0.04];
    const correction = holmBonferroniCorrection(pValues, 0.05);

    expect(correction.comparisons.length).toBe(4);
    correction.comparisons.forEach(c => {
      expect(Number.isFinite(c.adjustedPValue)).toBe(true);
      expect(c.adjustedPValue).toBeGreaterThanOrEqual(0);
      expect(c.adjustedPValue).toBeLessThanOrEqual(1);
    });

    console.log('[QUICK VERIFY] Statistics utilities: PASS');
  });

  it('should verify GA runs with optimizations', async () => {
    const task: GATask = {
      id: 'verify-ga-001',
      description: 'Test task',
      requiredCapabilities: ['temperature-sensing', 'hvac-control'],
      complexity: 'medium',
    };

    const fitnessFn = createIoTFitnessFunction(
      { requiredCapabilities: task.requiredCapabilities, description: task.description },
      SERVICE_CAPABILITIES
    );

    const problem = {
      services: SERVICE_POOL,
      constraints: { requiredCapabilities: task.requiredCapabilities },
      fitnessFunction: fitnessFn,
    };

    const ga = new GeneticAlgorithm(problem, GA_CONFIG);
    const startTime = Date.now();
    const result = await ga.run();
    const duration = Date.now() - startTime;

    // Verify result structure
    expect(result.bestFitness).toBeGreaterThanOrEqual(0);
    expect(result.bestFitness).toBeLessThanOrEqual(1);
    expect(result.generations).toBeLessThanOrEqual(50); // Should respect maxGenerations
    expect(duration).toBeLessThan(3000); // Should complete within 3 seconds (maxTime + overhead)

    console.log(`[QUICK VERIFY] GA completed in ${duration}ms, fitness=${result.bestFitness.toFixed(3)}, generations=${result.generations}`);
  });

  it('should verify parallel processing works', async () => {
    const tasks = GA_TASKS.slice(0, 4); // Just 4 tasks

    const results: ComparisonResult[] = [];

    const runnerResult = await runParallel(
      tasks,
      async (task) => {
        // Run GA only for speed
        const gaResult = await runGAOnly(task);
        return gaResult;
      },
      {
        concurrency: 2,
        batchSize: 2,
        timeout: 10000,
      }
    );

    expect(runnerResult.results.length).toBe(4);
    expect(runnerResult.successCount).toBe(4);

    console.log(`[QUICK VERIFY] Parallel processing: ${runnerResult.results.length} tasks completed in ${runnerResult.totalTime}ms`);
  });

  it('should run full comparison on small sample', async () => {
    const results: ComparisonResult[] = [];

    // Run 2 tasks per complexity (8 total)
    const sampleTasks = [
      ...GA_TASKS.filter(t => t.complexity === 'easy').slice(0, 2),
      ...GA_TASKS.filter(t => t.complexity === 'medium').slice(0, 2),
      ...GA_TASKS.filter(t => t.complexity === 'hard').slice(0, 2),
      ...GA_TASKS.filter(t => t.complexity === 'extreme').slice(0, 2),
    ];

    console.log(`[QUICK VERIFY] Running full comparison on ${sampleTasks.length} tasks...`);

    const runnerResult = await runParallel(
      sampleTasks,
      async (task) => runComparison(task),
      {
        concurrency: 2,
        batchSize: 2,
        timeout: 60000,
      }
    );

    results.push(...runnerResult.results.filter(r => r !== null) as ComparisonResult[]);

    // Verify all results are valid
    expect(results.length).toBe(sampleTasks.length);
    results.forEach(r => {
      expect(Number.isFinite(r.gaFitness)).toBe(true);
      expect(Number.isFinite(r.semanticScore)).toBe(true);
      expect(Number.isFinite(r.gaProcessingTime)).toBe(true);
      expect(Number.isFinite(r.acProcessingTime)).toBe(true);
    });

    // Calculate summary
    const gaSuccess = results.filter(r => r.gaSuccess).length;
    const acSuccess = results.filter(r => r.acSuccess).length;

    console.log('\n[QUICK VERIFY] Results:');
    console.log(`  GA Success: ${gaSuccess}/${results.length}`);
    console.log(`  AC Success: ${acSuccess}/${results.length}`);

    // Verify statistics work on results
    const gaResults = results.map(r => r.gaSuccess ? 1 : 0);
    const acResults = results.map(r => r.acSuccess ? 1 : 0);
    const comparison = compareTwoGroups(gaResults, acResults);

    expect(Number.isFinite(comparison.testResult.pValue)).toBe(true);
    console.log(`  P-value: ${comparison.testResult.pValue.toFixed(4)}`);
    console.log(`  Effect Size (Cohen's d): ${comparison.effectSize.value.toFixed(3)}`);
  }, TIMEOUT_CONFIG.testTimeout * 5);
});

// ============================================
// Helper Functions
// ============================================

async function runGAOnly(task: GATask): Promise<ComparisonResult> {
  const startTime = Date.now();

  const fitnessFn = createIoTFitnessFunction(
    { requiredCapabilities: task.requiredCapabilities, description: task.description },
    SERVICE_CAPABILITIES
  );

  const problem = {
    services: SERVICE_POOL,
    constraints: { requiredCapabilities: task.requiredCapabilities },
    fitnessFunction: fitnessFn,
  };

  const ga = new GeneticAlgorithm(problem, GA_CONFIG);
  const result = await ga.run();
  const gaTime = Date.now() - startTime;

  return {
    taskId: task.id,
    complexity: task.complexity,
    gaSuccess: result.bestFitness > 0.7,
    gaProcessingTime: gaTime,
    gaGenerations: result.generations,
    gaFitness: result.bestFitness,
    acSuccess: false,
    acProcessingTime: 0,
    semanticScore: 0,
  };
}

async function runComparison(task: GATask): Promise<ComparisonResult> {
  const startTime = Date.now();

  // Run GA
  const gaResult = await runGAOnly(task);

  // Run AC
  const acStartTime = Date.now();
  const acResult = await simulateAC(task);
  const acTime = Date.now() - acStartTime;

  return {
    ...gaResult,
    acSuccess: acResult.success,
    acProcessingTime: acTime,
    semanticScore: acResult.semanticScore,
  };
}

async function simulateAC(task: GATask): Promise<{
  success: boolean;
  semanticScore: number;
}> {
  try {
    const prompt = `
You are an IoT agent managing a smart environment.

Task: ${task.description}

Required Capabilities: ${task.requiredCapabilities.join(', ')}

Analyze the task and determine the best approach to complete it.
Consider semantic understanding and practical constraints.

Respond with a JSON object containing:
1. "approach": Your recommended approach
2. "selectedCapabilities": Array of capabilities to use
3. "reasoning": Why this approach is optimal
4. "confidence": Your confidence level (0.0-1.0)
`;

    const response = await generateWithLLM(sharedLLMClient, prompt, {
      temperature: 0.3,
      maxTokens: 500,
    });

    const parseResult = parseACResponse(response.content);
    const semanticScore = parseResult.success
      ? 0.5 + (parseResult.confidence * 0.5)
      : 0.2;

    const success = parseResult.success && semanticScore > 0.5;
    return { success, semanticScore };

  } catch (error) {
    console.error(`[QUICK VERIFY] AC error for ${task.id}:`, error);
    return { success: false, semanticScore: 0 };
  }
}

function parseACResponse(content: string): {
  success: boolean;
  approach: string;
  capabilities: string[];
  confidence: number;
} {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, approach: '', capabilities: [], confidence: 0 };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      success: !!parsed.approach && Array.isArray(parsed.selectedCapabilities),
      approach: parsed.approach || '',
      capabilities: parsed.selectedCapabilities || [],
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    };
  } catch {
    return { success: false, approach: '', capabilities: [], confidence: 0 };
  }
}
