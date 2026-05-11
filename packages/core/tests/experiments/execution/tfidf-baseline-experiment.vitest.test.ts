/**
 * TF-IDF Baseline Experiment
 *
 * Runs the "tfidf-baseline" condition: character n-gram Jaccard similarity
 * for capability matching. No LLM is invoked. Agents use text similarity
 * between event parameters and service capabilities to make collaboration
 * decisions.
 *
 * This is a realistic non-LLM baseline using standard IR techniques.
 * Expected accuracy: 55-75% (between rule-only 23% and full-AC 93.3%).
 *
 * tfidf-baseline × N=5 × apartment × decisionOnly
 *
 * Usage:
 *   node --max-old-space-size=8192 ../../node_modules/vitest/vitest.mjs \
 *     tfidf-baseline-experiment.vitest.test.ts --run
 */

import { describe, it, expect } from 'vitest';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { PaperExperimentRunner } from '../infrastructure/paper-experiment-runner.js';
import type { PaperExperimentResult } from '../infrastructure/types.js';

const N = 5;
const BLOCK_TIMEOUT = 60 * 60 * 1000; // 1 hour — should be fast since no LLM
const RESULTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'experiment-results',
  'unified',
);
mkdirSync(RESULTS_DIR, { recursive: true });

const MODEL = 'qwen3-14b-q4:latest';
const CONDITION = 'tfidf-baseline';

function resultFilename(iter: number): string {
  return `A-${CONDITION}-iter${iter}-apartment-${MODEL.replace(/[:.]/g, '_')}.json`;
}

function saveResult(result: PaperExperimentResult): void {
  const filename = resultFilename(result.iteration);
  writeFileSync(join(RESULTS_DIR, filename), JSON.stringify(result, null, 2), 'utf-8');
}

function loadSaved(filepath: string): PaperExperimentResult | null {
  if (!existsSync(filepath)) return null;
  try { return JSON.parse(readFileSync(filepath, 'utf-8')); }
  catch { return null; }
}

const allResults: PaperExperimentResult[] = [];

describe('TF-IDF Baseline Experiment', () => {

  it(`${CONDITION} × N=${N}`, async () => {
    console.log(`\n--- TF-IDF Baseline / apartment ---`);

    for (let i = 0; i < N; i++) {
      const savedFile = join(RESULTS_DIR, resultFilename(i));
      const saved = loadSaved(savedFile);
      if (saved) {
        console.log(`  iter ${i + 1}/${N}: SKIP (already done)`);
        allResults.push(saved);
        continue;
      }

      console.log(`  iter ${i + 1}/${N}: running...`);

      const config = PaperExperimentRunner.createConfig({
        id: `tfidf-baseline-apartment`,
        name: `TF-IDF Baseline / apartment`,
        rq: 'RQ1',
        scenario: 'apartment',
        condition: CONDITION,
        iterations: 1,
        llmModel: MODEL,
        multiAgentEval: true,
        realisticRouting: true,
        decisionOnly: true,
        timeoutMs: 300000,
      });

      const runner = new PaperExperimentRunner(config);
      const results = await runner.run();

      if (results.length > 0) {
        const result = results[0];
        result.iteration = i;
        allResults.push(result);
        saveResult(result);
        console.log(
          `  [DONE] accuracy=${(result.decisionQuality.meanCorrectDecisionRate * 100).toFixed(1)}%`,
        );
      } else {
        console.log(`  [WARN] runner returned no result`);
      }
    }

    expect(allResults.length).toBeGreaterThan(0);
  }, BLOCK_TIMEOUT);

  it('summary', () => {
    console.log('\n' + '='.repeat(50));
    console.log('TF-IDF BASELINE — SUMMARY');
    console.log('='.repeat(50));
    const results = allResults.filter(
      r => r.config.condition === CONDITION,
    );
    const accs = results.map(r => r.decisionQuality.meanCorrectDecisionRate * 100);
    const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
    console.log(`  accuracy: ${mean.toFixed(1)}% (${accs.map(a => a.toFixed(1)).join(', ')})`);

    // Per-type breakdown
    const types: Record<string, { correct: number; total: number }> = {};
    results.forEach(r => {
      r.events.forEach(e => {
        if (!types[e.interactionType]) types[e.interactionType] = { correct: 0, total: 0 };
        types[e.interactionType].total++;
        if (e.correctDecision) types[e.interactionType].correct++;
      });
    });
    console.log('  Per-type:');
    for (const [t, s] of Object.entries(types)) {
      console.log(`    Type ${t}: ${(s.correct / s.total * 100).toFixed(1)}% (${s.correct}/${s.total})`);
    }

    // Decision distribution
    const decisions: Record<string, number> = {};
    results.forEach(r => {
      r.events.forEach(e => {
        const d = e.agentDecision || 'unknown';
        decisions[d] = (decisions[d] || 0) + 1;
      });
    });
    console.log('  Decision distribution:');
    for (const [d, count] of Object.entries(decisions)) {
      console.log(`    ${d}: ${count}`);
    }
  });
});
