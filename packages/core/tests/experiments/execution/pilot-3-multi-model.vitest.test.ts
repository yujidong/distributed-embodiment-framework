/**
 * Pilot 3: Multi-Model Cross-Validation — PAPER_DESIGN_V5 (Sprint P33)
 *
 * Validates that core findings from Pilot 1-2 hold across different LLMs.
 * Runs key conditions (full-ac, rule-only) on apartment with all available
 * models discovered from Ollama at runtime.
 *
 * Produces: Model comparison data for Fig 7
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ExperimentCondition } from '../infrastructure/types.js';
import { PaperExperimentRunner } from '../infrastructure/paper-experiment-runner.js';
import {
  savePilotResults,
  exportResultsCSV,
  getResultsBaseDir,
} from '../infrastructure/result-persistence.js';
import { ExperimentModelDiscovery } from '../infrastructure/experiment-model-discovery.js';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONDITIONS: ExperimentCondition[] = [
  'full-ac',
  'rule-only',
];

const SCENARIO = 'apartment';
const ITERATIONS = 1;
const TIMEOUT = 5400000; // 90 minutes per test

// Populated dynamically in beforeAll via Ollama model discovery
let MODELS: string[] = [];
let discovery: ExperimentModelDiscovery;

const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

// ---------------------------------------------------------------------------
// Helper: Model comparison table
// ---------------------------------------------------------------------------

function printModelComparison(): void {
  console.log('\n========================================');
  console.log('Pilot 3: Multi-Model Cross-Validation');
  console.log(`Scenario: ${SCENARIO} | Iterations: ${ITERATIONS}`);
  console.log(`Models discovered: ${MODELS.join(', ')}`);
  console.log('========================================\n');

  console.log('| Model | Condition | Accuracy | Tokens | Wall(s) |');
  console.log('|-------|-----------|----------|--------|---------|');

  for (const model of MODELS) {
    for (const condition of CONDITIONS) {
      const results = allResults.filter(
        r => r.config.llmModel === model && r.config.condition === condition,
      );
      if (results.length === 0) continue;

      const avgAcc = results.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / results.length;
      const avgTokens = results.reduce((s, r) => s + r.efficiency.totalTokens, 0) / results.length;
      const avgWall = results.reduce((s, r) => s + r.efficiency.totalWallTimeMs, 0) / results.length / 1000;

      console.log(
        `| ${model.padEnd(22)} | ${condition.padEnd(9)} | ${(avgAcc * 100).toFixed(1).padStart(6)}% | ` +
        `${avgTokens.toFixed(0).padStart(6)} | ${avgWall.toFixed(1).padStart(7)} |`,
      );
    }
  }

  // Cross-model comparison for full-ac
  console.log('\n--- Cross-Model Comparison (full-ac) ---');
  for (const model of MODELS) {
    const results = allResults.filter(
      r => r.config.llmModel === model && r.config.condition === 'full-ac',
    );
    if (results.length === 0) continue;

    const avgAcc = results.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / results.length;

    // Type-wise accuracy
    const types = ['A', 'B', 'C', 'D', 'E'] as const;
    console.log(`  ${model}: overall=${(avgAcc * 100).toFixed(1)}%`);
    for (const type of types) {
      const typeEvents = results.flatMap(r => r.events).filter(e => e.interactionType === type);
      if (typeEvents.length === 0) continue;
      const typeAcc = typeEvents.filter(e => e.correctDecision).length / typeEvents.length;
      console.log(`    Type ${type}: ${(typeAcc * 100).toFixed(1)}% (${typeEvents.length})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: Run one model+condition combination
// ---------------------------------------------------------------------------

async function runExperiment(model: string, condition: ExperimentCondition) {
  const config = PaperExperimentRunner.createConfig({
    id: `pilot3-${model}-${condition}-${SCENARIO}`,
    name: `Pilot 3: ${model} ${condition}`,
    rq: 'RQ2',
    scenario: SCENARIO,
    condition,
    iterations: ITERATIONS,
    llmModel: model,
    timeoutMs: 120000,
    multiAgentEval: true,
  });

  const runner = new PaperExperimentRunner(config);
  const results = await runner.run();

  expect(results).toHaveLength(ITERATIONS);

  for (const result of results) {
    expect(result.events.length).toBeGreaterThan(0);
    expect(Number.isFinite(result.decisionQuality.meanCorrectDecisionRate)).toBe(true);
    allResults.push(result);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skip('LEGACY: Pilot 3: Multi-Model Cross-Validation', () => {
  beforeAll(async () => {
    // Dynamic model discovery from Ollama
    discovery = await ExperimentModelDiscovery.create();
    MODELS = discovery.getSuitableModelNames();

    if (MODELS.length === 0) {
      throw new Error(
        'No suitable models found in Ollama for Pilot 3 experiments. ' +
        'Ensure Ollama is running and has models >= 7B parameters installed.',
      );
    }

    console.log(`Pilot 3 will run with ${MODELS.length} model(s): ${MODELS.join(', ')}`);
  }, 30000);

  afterAll(() => {
    printModelComparison();

    try {
      const savedPaths = savePilotResults(allResults, 'pilot-3-multi-model');
      console.log(`\nResults saved to ${savedPaths.length} files`);

      const csvPath = join(getResultsBaseDir(), 'pilot-3-multi-model-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`CSV exported to ${csvPath}`);
    } catch (err) {
      console.error('Failed to save results:', err);
    }
  });

  // Primary model: full-ac + rule-only
  it('primary model full-ac', async () => {
    const model = MODELS[0]; // Primary model (best available)
    await runExperiment(model, 'full-ac');
  }, TIMEOUT);

  it('primary model rule-only', async () => {
    const model = MODELS[0];
    await runExperiment(model, 'rule-only');
  }, TIMEOUT);

  // Secondary model: full-ac + rule-only
  it('secondary model full-ac', async () => {
    if (!MODELS[1]) return;
    await runExperiment(MODELS[1], 'full-ac');
  }, TIMEOUT);

  it('secondary model rule-only', async () => {
    if (!MODELS[1]) return;
    await runExperiment(MODELS[1], 'rule-only');
  }, TIMEOUT);

  // Tertiary model: full-ac + rule-only
  it('tertiary model full-ac', async () => {
    if (!MODELS[2]) return;
    await runExperiment(MODELS[2], 'full-ac');
  }, TIMEOUT);

  it('tertiary model rule-only', async () => {
    if (!MODELS[2]) return;
    await runExperiment(MODELS[2], 'rule-only');
  }, TIMEOUT);

  // Quaternary model: full-ac + rule-only
  it('quaternary model full-ac', async () => {
    if (!MODELS[3]) return;
    await runExperiment(MODELS[3], 'full-ac');
  }, TIMEOUT);

  it('quaternary model rule-only', async () => {
    if (!MODELS[3]) return;
    await runExperiment(MODELS[3], 'rule-only');
  }, TIMEOUT);
});
