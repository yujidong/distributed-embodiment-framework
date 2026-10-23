/**
 * Phase 1 Sanity Check: Verify qwen2.5-7b-q4 works with the experiment infrastructure.
 * Runs N=1, full-ac only, apartment. Quick validation before committing to long runs.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { PaperExperimentRunner } from '../infrastructure/paper-experiment-runner.js';
import { savePilotResults, exportResultsCSV, getResultsBaseDir } from '../infrastructure/result-persistence.js';
import { join } from 'node:path';

const MODEL = 'qwen2.5-7b-q4:latest';
const SCENARIO = 'apartment';
const ITERATIONS = 1;
const TIMEOUT = 3600000; // 60 minutes

const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

describe('Phase 1: Sanity Check — qwen2.5-7b-q4', () => {
  afterAll(() => {
    console.log('\n=== Phase 1 Sanity Check Results ===');
    for (const r of allResults) {
      console.log(`Model: ${r.config.llmModel}`);
      console.log(`  Accuracy: ${(r.decisionQuality.meanCorrectDecisionRate * 100).toFixed(1)}%`);
      console.log(`  Events: ${r.events.length}`);
      console.log(`  Tokens: ${r.efficiency.totalTokens}`);
      console.log(`  Wall time: ${(r.efficiency.totalWallTimeMs / 1000).toFixed(1)}s`);

      // Type breakdown
      const types = ['A', 'B', 'C', 'D', 'E'] as const;
      for (const t of types) {
        const te = r.events.filter(e => e.interactionType === t);
        if (te.length === 0) continue;
        const acc = te.filter(e => e.correctDecision).length / te.length;
        console.log(`  Type ${t}: ${(acc * 100).toFixed(1)}% (${te.length} events)`);
      }

      // Sample reasoning
      console.log('  Sample reasoning:');
      const samples = r.events.filter(e => e.llmReasoning).slice(0, 3);
      for (const s of samples) {
        console.log(`    [${s.eventId}→${s.agentId}] correct=${s.correctDecision} decided=${s.decisionMade}: ${(s.llmReasoning ?? '').substring(0, 120)}`);
      }
    }

    try {
      savePilotResults(allResults, 'exp-7a-sanity-7b');
      const csvPath = join(getResultsBaseDir(), 'exp-7a-sanity-7b-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`\nResults saved.`);
    } catch (err) {
      console.error('Save failed:', err);
    }
  });

  it(`full-ac / ${SCENARIO} x ${ITERATIONS} (model: ${MODEL})`, async () => {
    const config = PaperExperimentRunner.createConfig({
      id: `exp7a-sanity-7b`,
      name: `Exp 7a Sanity Check: 7B`,
      rq: 'RQ-M1',
      scenario: SCENARIO,
      condition: 'full-ac',
      iterations: ITERATIONS,
      llmModel: MODEL,
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
  }, TIMEOUT);
});
