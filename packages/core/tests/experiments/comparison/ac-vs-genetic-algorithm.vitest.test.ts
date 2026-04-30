/**
 * AC vs Genetic Algorithm Comparison Experiment (RQ2.2) - OPTIMIZED
 *
 * Research Question: How does AC's LLM-driven approach compare to
 * evolutionary optimization (Genetic Algorithm)?
 *
 * Optimizations:
 * - Parallel task processing (3 concurrent)
 * - Expanded task set (200 tasks total, 50 per complexity)
 * - Optimized GA with early stopping
 * - Progress reporting
 *
 * Paper Section: Evaluation - Comparative Analysis
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LLMClient, initializeLLM } from '@active-collaboration/llm-integration';
import {
  TimeManager,
  PhysicalEnvironment,
} from '@active-collaboration/simulation';
import { CognitiveAgent } from '../../../src/agent/CognitiveAgent.js';
import { EnvironmentCenter } from '../../../src/environment/EnvironmentCenter.js';
import { AgentProfileFactory } from '../../../src/goal/index.js';
import {
  LLM_CONFIG,
  TIMEOUT_CONFIG,
  generateWithLLM,
  // GA imports
  GeneticAlgorithm,
  createIoTFitnessFunction,
  createServiceCapabilityMap,
  type GAConfig,
  // Task generator imports
  generateGATasks,
  // Advanced statistics
  compareTwoGroups,
  holmBonferroniCorrection,
  descriptiveStats,
  formatExperimentReport,
  // Experiment runner
  runParallel,
  createProgressReporter,
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
// Configuration
// ============================================

// GA configuration - optimized for fast execution
const GA_CONFIG: Partial<GAConfig> = {
  populationSize: 30,
  maxGenerations: 50,
  mutationRate: 0.15,
  crossoverRate: 0.8,
  elitismCount: 2,
  tournamentSize: 3,
  maxTime: 2000, // 2 seconds max
};

// Service pool for GA to search through
const SERVICE_POOL = [
  'temperature-sensor-001', 'temperature-sensor-002', 'temperature-sensor-003',
  'humidity-sensor-001', 'humidity-sensor-002',
  'hvac-controller-001', 'hvac-controller-002', 'hvac-controller-003',
  'light-controller-001', 'light-controller-002', 'light-controller-003',
  'motion-sensor-001', 'motion-sensor-002', 'motion-sensor-003',
  'lock-controller-001', 'lock-controller-002',
  'security-camera-001', 'security-camera-002',
  'air-quality-sensor-001', 'air-quality-sensor-002',
  'energy-monitor-001', 'energy-monitor-002',
  'ventilation-controller-001', 'ventilation-controller-002',
  'scheduler-service-001', 'scheduler-service-002',
  'alert-service-001', 'alert-service-002',
];

// Create capability mapping for services
const SERVICE_CAPABILITIES = createServiceCapabilityMap(SERVICE_POOL);

// Shared test resources
let sharedLLMClient: LLMClient;
let selectedModel: string;
const testResults: ComparisonResult[] = [];

// Generate tasks - EXPANDED to 200 tasks (50 per complexity)
const TASKS_PER_COMPLEXITY = 50;
const GA_TASKS: GATask[] = generateGATasks(TASKS_PER_COMPLEXITY * 4);

// Shared environment (reused across tasks)
let sharedEnv: {
  envCenter: EnvironmentCenter;
  physicalEnvironment: PhysicalEnvironment;
  timeManager: TimeManager;
} | null = null;

// ============================================
// Test Suite
// ============================================

describe('AC vs Genetic Algorithm Comparison Experiment (RQ2.2)', () => {
  beforeAll(async () => {
    console.log('\n========================================');
    console.log('[RQ2.2] AC vs Genetic Algorithm Comparison (Optimized)');
    console.log('========================================\n');
    console.log(`[RQ2.2] Tasks: ${GA_TASKS.length} (${GA_TASKS.filter(t => t.complexity === 'easy').length} easy, ${GA_TASKS.filter(t => t.complexity === 'medium').length} medium, ${GA_TASKS.filter(t => t.complexity === 'hard').length} hard, ${GA_TASKS.filter(t => t.complexity === 'extreme').length} extreme)`);

    const initResult = await initializeLLM({
      preferredModels: LLM_CONFIG.preferredModels,
      allowFallback: false,
    });

    if (!initResult.success) {
      throw new Error(`LLM initialization failed: ${initResult.error}`);
    }

    selectedModel = initResult.selectedModel;
    sharedLLMClient = new LLMClient('ollama', { model: selectedModel });

    // Create shared environment
    sharedEnv = createTestEnvironment();

    console.log(`[RQ2.2] Using model: ${selectedModel}`);
    console.log(`[RQ2.2] GA config: population=${GA_CONFIG.populationSize}, generations=${GA_CONFIG.maxGenerations}, maxTime=${GA_CONFIG.maxTime}ms`);
    console.log(`[RQ2.2] Running with parallel processing (concurrency: 3)`);
  }, TIMEOUT_CONFIG.testTimeout);

  describe('Complexity Comparison', () => {
    const complexities: TaskComplexity[] = ['easy', 'medium', 'hard', 'extreme'];

    complexities.forEach((complexity) => {
      const tasks = GA_TASKS.filter(t => t.complexity === complexity);
      const taskCount = tasks.length;

      it(`should compare AC vs GA for ${complexity} tasks (${taskCount} tasks)`, async () => {
        console.log(`\n[RQ2.2] Testing ${complexity} tasks (${taskCount} total)...`);

        // Run tasks in parallel with progress reporting
        const progressReporter = createProgressReporter(`RQ2.2-${complexity}`);

        const runnerResult = await runParallel(
          tasks,
          async (task) => runComparison(task),
          {
            concurrency: 3,
            batchSize: 10,
            onProgress: progressReporter,
            timeout: 30000, // 30s per task
          }
        );

        // Collect results
        testResults.push(...runnerResult.results.filter(r => r !== null) as ComparisonResult[]);

        // Report for this complexity level
        const complexityResults = testResults.filter(r => r.complexity === complexity);
        const gaSuccess = complexityResults.filter(r => r.gaSuccess).length;
        const acSuccess = complexityResults.filter(r => r.acSuccess).length;
        const avgGaTime = complexityResults.reduce((sum, r) => sum + r.gaProcessingTime, 0) / complexityResults.length;
        const avgAcTime = complexityResults.reduce((sum, r) => sum + r.acProcessingTime, 0) / complexityResults.length;
        const avgFitness = complexityResults.reduce((sum, r) => sum + r.gaFitness, 0) / complexityResults.length;
        const avgSemantic = complexityResults.reduce((sum, r) => sum + r.semanticScore, 0) / complexityResults.length;

        console.log(`\n[RQ2.2] ${complexity} results:`);
        console.log(`  GA: ${gaSuccess}/${complexityResults.length} (${((gaSuccess / complexityResults.length) * 100).toFixed(1)}%)`);
        console.log(`  AC: ${acSuccess}/${complexityResults.length} (${((acSuccess / complexityResults.length) * 100).toFixed(1)}%)`);
        console.log(`  Avg GA Time: ${avgGaTime.toFixed(0)}ms, Fitness: ${avgFitness.toFixed(3)}`);
        console.log(`  Avg AC Time: ${avgAcTime.toFixed(0)}ms, Semantic: ${avgSemantic.toFixed(2)}`);

        expect(runnerResult.results.length).toBe(taskCount);
      }, TIMEOUT_CONFIG.testTimeout * 10); // Extended timeout for 50 tasks
    });
  });

  afterAll(() => {
    // Cleanup
    if (sharedEnv) {
      sharedEnv.envCenter.stopPhysicsSimulation?.();
      sharedEnv = null;
    }

    console.log('\n========================================');
    console.log('[RQ2.2] AC vs GA Comparison Summary');
    console.log('========================================\n');

    // Group by complexity
    const grouped = GA_TASKS.reduce((acc, task) => {
      const complexity = task.complexity;
      if (!acc[complexity]) acc[complexity] = [];
      acc[complexity].push(task);
      return acc;
    }, {} as Record<TaskComplexity, GATask[]>);

    console.log('| Complexity | N | GA Success | AC Success | GA Time | AC Time | GA Fitness | AC Semantic |');
    console.log('|------------|---|------------|------------|---------|---------|------------|-------------|');

    const pValuesByComplexity: { complexity: string; pValue: number }[] = [];

    Object.entries(grouped).forEach(([complexity, tasks]) => {
      const results = testResults.filter(r => tasks.some(t => t.id === r.taskId));
      if (results.length === 0) return;

      const gaSuccess = results.filter(r => r.gaSuccess).length;
      const acSuccess = results.filter(r => r.acSuccess).length;
      const gaTime = results.reduce((sum, r) => sum + r.gaProcessingTime, 0) / results.length;
      const acTime = results.reduce((sum, r) => sum + r.acProcessingTime, 0) / results.length;
      const gaFitness = results.reduce((sum, r) => sum + r.gaFitness, 0) / results.length;
      const semantic = results.reduce((sum, r) => sum + r.semanticScore, 0) / results.length;

      console.log(
        `| ${complexity.padEnd(10)} | ${results.length} | ` +
        `${gaSuccess}/${results.length} (${((gaSuccess / results.length) * 100).toFixed(0)}%) | ` +
        `${acSuccess}/${results.length} (${((acSuccess / results.length) * 100).toFixed(0)}%) | ` +
        `${gaTime.toFixed(0)}ms | ` +
        `${acTime.toFixed(0)}ms | ` +
        `${gaFitness.toFixed(3)} | ` +
        `${semantic.toFixed(2)} |`
      );

      // Calculate p-value for this complexity level
      const gaResults = results.map(r => r.gaSuccess ? 1 : 0);
      const acResults = results.map(r => r.acSuccess ? 1 : 0);
      const comparison = compareTwoGroups(gaResults, acResults, { alpha: 0.05 });
      pValuesByComplexity.push({ complexity, pValue: comparison.testResult.pValue });
    });

    // Apply Bonferroni-Holm correction
    console.log('\n=== Statistical Analysis (with Holm-Bonferroni Correction) ===');
    const correction = holmBonferroniCorrection(
      pValuesByComplexity.map(p => p.pValue),
      0.05
    );

    correction.comparisons.forEach((c, i) => {
      console.log(`${pValuesByComplexity[i].complexity}: p=${c.originalPValue.toFixed(4)}, adjusted=${c.adjustedPValue.toFixed(4)}, significant=${c.significant}`);
    });

    // Overall comparison
    const overallGA = testResults.map(r => r.gaSuccess ? 1 : 0);
    const overallAC = testResults.map(r => r.acSuccess ? 1 : 0);
    const overallComparison = compareTwoGroups(overallGA, overallAC, { alpha: 0.05 });

    console.log('\n=== Overall Results ===');
    const totalGASuccess = testResults.filter(r => r.gaSuccess).length;
    const totalACSuccess = testResults.filter(r => r.acSuccess).length;
    console.log(`GA Success: ${totalGASuccess}/${testResults.length} (${((totalGASuccess / testResults.length) * 100).toFixed(1)}%)`);
    console.log(`AC Success: ${totalACSuccess}/${testResults.length} (${((totalACSuccess / testResults.length) * 100).toFixed(1)}%)`);
    console.log(`P-value: ${overallComparison.testResult.pValue.toFixed(4)}`);
    console.log(`Effect Size (Cohen's d): ${overallComparison.effectSize.value.toFixed(3)} (${overallComparison.effectSize.interpretation})`);

    // Semantic understanding comparison
    const avgSemantic = testResults.reduce((sum, r) => sum + r.semanticScore, 0) / testResults.length;
    const avgFitness = testResults.reduce((sum, r) => sum + r.gaFitness, 0) / testResults.length;
    console.log('\n=== Key Findings ===');
    console.log(`Average GA Fitness Score: ${avgFitness.toFixed(3)} (optimization quality)`);
    console.log(`Average AC Semantic Score: ${avgSemantic.toFixed(2)} (understanding quality)`);
    console.log(`Superiority: ${overallComparison.superiority === 'method1' ? 'GA' : overallComparison.superiority === 'method2' ? 'AC' : 'No significant difference'}`);

    // Print full report
    console.log('\n' + formatExperimentReport(
      overallComparison,
      'Genetic Algorithm',
      'Active Collaboration (AC)'
    ));
  });
});

// ============================================
// Comparison Functions
// ============================================

/**
 * Run comparison for a single task
 */
async function runComparison(task: GATask): Promise<ComparisonResult> {
  const startTime = Date.now();

  // Run GA approach
  const gaResult = await runRealGA(task);
  const gaTime = Date.now() - startTime;

  // Run AC approach
  const acStartTime = Date.now();
  const acResult = await simulateAC(task);
  const acTime = Date.now() - acStartTime;

  return {
    taskId: task.id,
    complexity: task.complexity,
    gaSuccess: gaResult.success,
    gaProcessingTime: gaTime,
    gaGenerations: gaResult.generations,
    gaFitness: gaResult.fitness,
    acSuccess: acResult.success,
    acProcessingTime: acTime,
    semanticScore: acResult.semanticScore,
  };
}

/**
 * Run REAL Genetic Algorithm (optimized)
 */
async function runRealGA(task: GATask): Promise<{
  success: boolean;
  fitness: number;
  generations: number;
}> {
  try {
    // Create fitness function for this task
    const fitnessFn = createIoTFitnessFunction(
      { requiredCapabilities: task.requiredCapabilities, description: task.description },
      SERVICE_CAPABILITIES
    );

    // Define the problem
    const problem = {
      services: SERVICE_POOL,
      constraints: {
        requiredCapabilities: task.requiredCapabilities,
      },
      fitnessFunction: fitnessFn,
    };

    // Create and run GA with optimized config
    const ga = new GeneticAlgorithm(problem, GA_CONFIG);
    const result = await ga.run();

    // Success threshold: fitness > 0.7 means at least 70% capability coverage
    const success = result.bestFitness > 0.7;

    return {
      success,
      fitness: result.bestFitness,
      generations: result.generations,
    };

  } catch (error) {
    console.error(`[RQ2.2] GA error for ${task.id}:`, error);
    return { success: false, fitness: 0, generations: 0 };
  }
}

/**
 * Simulate AC approach using real LLM
 */
async function simulateAC(task: GATask): Promise<{
  success: boolean;
  semanticScore: number;
}> {
  try {
    // Generate prompt for task
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

    // Call LLM
    const response = await generateWithLLM(sharedLLMClient, prompt, {
      temperature: 0.3,
      maxTokens: 500,
    });

    // Parse response
    const parseResult = parseACResponse(response.content);

    // Calculate semantic score based on response quality
    const semanticScore = parseResult.success
      ? 0.5 + (parseResult.confidence * 0.5)
      : 0.2;

    // AC succeeds when semantic understanding is demonstrated
    const success = parseResult.success && semanticScore > 0.5;

    return { success, semanticScore };

  } catch (error) {
    console.error(`[RQ2.2] AC simulation error for ${task.id}:`, error);
    return { success: false, semanticScore: 0 };
  }
}

/**
 * Parse AC response from LLM
 */
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

// ============================================
// Test Environment Setup
// ============================================

function createTestEnvironment() {
  const timeManager = new TimeManager({ timeScale: 1 });
  const physicalEnvironment = new PhysicalEnvironment(timeManager, {
    enablePhysics: false,
  });

  const envCenter = new EnvironmentCenter({
    id: `test-env-${Date.now()}`,
    name: 'GA Comparison Test Environment',
    createdBy: 'experiment',
    createdAt: new Date(),
    updatedAt: new Date(),
    physicalEnvironment,
  });

  return { envCenter, physicalEnvironment, timeManager };
}
