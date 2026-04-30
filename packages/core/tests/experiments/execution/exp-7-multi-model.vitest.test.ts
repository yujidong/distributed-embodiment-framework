/**
 * Experiment 7: Multi-Model Cross-Validation
 *
 * Validates that core findings hold across model families and scales.
 * Three research questions:
 *   RQ-M1: Does distribution cost scale with model capability?
 *   RQ-M2: Are findings robust across model families?
 *   RQ-M3: Does Type A over-collaboration decrease with model size?
 *
 * Runs oracle + full-ac + rule-only on apartment with N=3 iterations per model.
 * The qwen3-14b-q4 data is loaded from existing exp-1/3 results.
 *
 * Phased execution:
 *   Phase 1: Sanity check (7B, N=1, full-ac + rule-only)
 *   Phase 2: Full sweep (7B, 8B, 32B × 3 conditions × N=3)
 *   Phase 3: Cross-family validation (DeepSeek-32B)
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import type { ExperimentCondition, PaperExperimentConfig, AgentEventType } from '../infrastructure/types.js';
import { PaperExperimentRunner } from '../infrastructure/paper-experiment-runner.js';
import {
  savePilotResults,
  exportResultsCSV,
  getResultsBaseDir,
  loadLatestPilotResults,
} from '../infrastructure/result-persistence.js';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Model Configuration
// ---------------------------------------------------------------------------

interface ModelConfig {
  name: string;       // Ollama model name
  family: string;     // Model family for reporting
  params: number;     // Parameter count in billions
  skip?: boolean;     // Skip this model (e.g., load from existing data)
}

const MODELS: ModelConfig[] = [
  { name: 'qwen2.5-7b-q4:latest', family: 'Qwen2.5', params: 7 },
  { name: 'llama3.1-8b-q4:latest', family: 'Llama3.1', params: 8.1 },
  { name: 'qwen3-14b-q4:latest', family: 'Qwen3', params: 14, skip: true }, // Load existing
  { name: 'qwen3-32b-q4:latest', family: 'Qwen3', params: 32 },
  { name: 'ds-32b:latest', family: 'DeepSeek', params: 32 },
];

// ---------------------------------------------------------------------------
// Experiment Configuration
// ---------------------------------------------------------------------------

const CONDITIONS: ExperimentCondition[] = ['full-ac', 'oracle', 'rule-only'];
const SCENARIO = 'apartment';
const ITERATIONS = 3;
const TIMEOUT = 5400000; // 90 minutes per test
const COOLDOWN_MS = 30000; // 30s cooldown between models for Ollama VRAM

// Accumulator for all results
const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getModelTag(model: ModelConfig): string {
  return `${model.family}-${model.params}B`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printMultiModelTable(): void {
  console.log('\n================================================================');
  console.log('Experiment 7: Multi-Model Cross-Validation');
  console.log(`Scenario: ${SCENARIO} | Conditions: ${CONDITIONS.join(', ')} | N: ${ITERATIONS}`);
  console.log('================================================================\n');

  for (const model of MODELS) {
    const tag = getModelTag(model);
    const modelResults = allResults.filter(r => r.config.llmModel === model.name);

    if (modelResults.length === 0 && !model.skip) {
      console.log(`[${tag}] No results`);
      continue;
    }

    console.log(`\n--- ${tag} (${model.name}) ---`);
    console.log('| Condition  | Accuracy | AC-F1  | Tokens  | Wall(s) |');
    console.log('|------------|----------|--------|---------|---------|');

    for (const condition of CONDITIONS) {
      const condResults = modelResults.filter(r => r.config.condition === condition);
      if (condResults.length === 0) continue;

      const avgAcc = condResults.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / condResults.length;
      const avgACF1 = condResults.reduce((s, r) => s + (r.classification?.collaborationTriggerF1.f1 ?? 0), 0) / condResults.length;
      const avgTokens = condResults.reduce((s, r) => s + r.efficiency.totalTokens, 0) / condResults.length;
      const avgWall = condResults.reduce((s, r) => s + r.efficiency.totalWallTimeMs, 0) / condResults.length / 1000;

      console.log(
        `| ${condition.padEnd(10)} | ${(avgAcc * 100).toFixed(1).padStart(6)}% | ` +
        `${(avgACF1 * 100).toFixed(1).padStart(4)}% | ` +
        `${avgTokens.toFixed(0).padStart(7)} | ` +
        `${avgWall.toFixed(1).padStart(7)} |`,
      );
    }

    // Type-wise breakdown
    const fullAcResults = modelResults.filter(r => r.config.condition === 'full-ac');
    if (fullAcResults.length > 0) {
      const allEvents = fullAcResults.flatMap(r => r.events);
      const types: AgentEventType[] = ['A', 'B', 'C', 'D', 'E'];

      console.log('  Type-wise (full-ac):');
      for (const t of types) {
        const typeEvents = allEvents.filter(e => e.interactionType === t);
        if (typeEvents.length === 0) continue;
        const acc = typeEvents.filter(e => e.correctDecision).length / typeEvents.length;
        console.log(`    Type ${t}: ${(acc * 100).toFixed(1)}% (${typeEvents.length} events)`);
      }
    }

    // Distribution cost
    const oracleResults = modelResults.filter(r => r.config.condition === 'oracle');
    if (fullAcResults.length > 0 && oracleResults.length > 0) {
      const fullAcAcc = fullAcResults.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / fullAcResults.length;
      const oracleAcc = oracleResults.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / oracleResults.length;
      console.log(`  Distribution cost: ${((oracleAcc - fullAcAcc) * 100).toFixed(1)}pp`);
    }
  }

  // Summary comparison table
  console.log('\n=== CROSS-MODEL SUMMARY ===');
  console.log('| Model          | Family   | Params | Full-AC  | Oracle   | Dist.Cost | Type A   |');
  console.log('|----------------|----------|--------|----------|----------|-----------|----------|');

  for (const model of MODELS) {
    const modelResults = allResults.filter(r => r.config.llmModel === model.name);
    const tag = getModelTag(model);

    const fullAc = modelResults.filter(r => r.config.condition === 'full-ac');
    const oracle = modelResults.filter(r => r.config.condition === 'oracle');

    if (fullAc.length === 0 && oracle.length === 0) {
      console.log(`| ${tag.padEnd(14)} | ${model.family.padEnd(8)} | ${String(model.params).padEnd(6)} | —        | —        | —         | —        |`);
      continue;
    }

    const fullAcAcc = fullAc.length > 0
      ? fullAc.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / fullAc.length
      : NaN;
    const oracleAcc = oracle.length > 0
      ? oracle.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / oracle.length
      : NaN;

    // Type A accuracy for full-ac
    const fullAcEvents = fullAc.flatMap(r => r.events);
    const typeAEvents = fullAcEvents.filter(e => e.interactionType === 'A');
    const typeAAcc = typeAEvents.length > 0
      ? typeAEvents.filter(e => e.correctDecision).length / typeAEvents.length
      : NaN;

    const distCost = Number.isFinite(fullAcAcc) && Number.isFinite(oracleAcc)
      ? ((oracleAcc - fullAcAcc) * 100).toFixed(1) + 'pp'
      : '—';

    console.log(
      `| ${tag.padEnd(14)} | ${model.family.padEnd(8)} | ${String(model.params).padEnd(6)} | ` +
      `${Number.isFinite(fullAcAcc) ? (fullAcAcc * 100).toFixed(1) + '%' : '—'.padEnd(8)} | ` +
      `${Number.isFinite(oracleAcc) ? (oracleAcc * 100).toFixed(1) + '%' : '—'.padEnd(8)} | ` +
      `${distCost.padEnd(9)} | ` +
      `${Number.isFinite(typeAAcc) ? (typeAAcc * 100).toFixed(0) + '%' : '—'.padEnd(8)} |`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests: Run sequentially per model, per condition
// ---------------------------------------------------------------------------

describe('Experiment 7: Multi-Model Cross-Validation', () => {
  afterAll(() => {
    printMultiModelTable();

    // Save all results
    try {
      const savedPaths = savePilotResults(allResults, 'exp-7-multi-model');
      console.log(`\nResults saved to ${savedPaths.length} files`);

      const csvPath = join(getResultsBaseDir(), 'exp-7-multi-model-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`CSV exported to ${csvPath}`);
    } catch (err) {
      console.error('Failed to save results:', err);
    }
  });

  // Load existing qwen3-14b-q4 data
  beforeAll(async () => {
    try {
      const existingResults = loadLatestPilotResults('exp-1-rq1-effectiveness');
      const filtered = existingResults.filter(r =>
        CONDITIONS.includes(r.config.condition as ExperimentCondition) &&
        r.config.scenario === SCENARIO,
      );
      for (const r of filtered) {
        allResults.push(r);
      }
      console.log(`Loaded ${filtered.length} existing qwen3-14b-q4 results from exp-1`);
    } catch (err) {
      console.warn('Could not load existing 14B data:', (err as Error).message);
    }
  });

  // Run each non-skipped model
  for (const model of MODELS) {
    if (model.skip) continue;

    describe(`${getModelTag(model)} (${model.name})`, () => {
      for (const condition of CONDITIONS) {
        it(`${condition} / ${SCENARIO} x ${ITERATIONS} iterations`, async () => {
          // Cooldown between models (skip for first test in a model group)
          const existingForModel = allResults.filter(r => r.config.llmModel === model.name);
          if (existingForModel.length === 0 && allResults.length > 0) {
            console.log(`Cooldown: waiting ${COOLDOWN_MS / 1000}s for Ollama to unload previous model...`);
            await sleep(COOLDOWN_MS);
          }

          const config = PaperExperimentRunner.createConfig({
            id: `exp7-${getModelTag(model)}-${condition}-${SCENARIO}`,
            name: `Exp 7 Multi-Model: ${getModelTag(model)} / ${condition}`,
            rq: 'RQ-M1',
            scenario: SCENARIO,
            condition,
            iterations: ITERATIONS,
            llmModel: model.name,
            timeoutMs: 120000,
            multiAgentEval: true,
            realisticRouting: true,
          });

          const runner = new PaperExperimentRunner(config);
          const results = await runner.run();

          expect(results).toHaveLength(ITERATIONS);

          for (const result of results) {
            expect(result.events.length).toBeGreaterThan(0);
            expect(Number.isFinite(result.decisionQuality.meanCorrectDecisionRate)).toBe(true);
            allResults.push(result);
          }

          // Incremental save after each condition
          const csvPath = join(getResultsBaseDir(), 'exp-7-multi-model-summary.csv');
          exportResultsCSV(allResults, csvPath);
          console.log(`[Incremental save] ${allResults.length} results saved to CSV`);
        }, TIMEOUT);
      }
    });
  }
});
