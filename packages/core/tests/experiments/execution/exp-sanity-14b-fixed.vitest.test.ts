/**
 * Infrastructure Sanity Check: Verify fixed decision pipeline with 14B model.
 * Tests: shared semantic matching, natural language extraction, decisionSource tracking,
 * prompt simplification (no TASK derived info).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { PaperExperimentRunner } from '../infrastructure/paper-experiment-runner.js';
import { savePilotResults, exportResultsCSV, getResultsBaseDir } from '../infrastructure/result-persistence.js';
import { join } from 'node:path';

const MODEL = 'qwen3-14b-q4:latest';
const SCENARIO = 'apartment';
const ITERATIONS = 1;
const TIMEOUT = 3600000; // 60 minutes

const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

describe('Infrastructure Sanity Check — 14B with fixed pipeline', () => {
  afterAll(() => {
    console.log('\n=== Infrastructure Sanity Check Results (14B) ===');
    for (const r of allResults) {
      console.log(`Model: ${r.config.llmModel}`);
      console.log(`  Accuracy: ${(r.decisionQuality.meanCorrectDecisionRate * 100).toFixed(1)}%`);
      console.log(`  Events: ${r.events.length}`);
      console.log(`  Tokens: ${r.efficiency.totalTokens}`);
      console.log(`  Wall time: ${(r.efficiency.totalWallTimeMs / 1000).toFixed(1)}s`);

      // Decision source breakdown
      const sources = {} as Record<string, { total: number; correct: number }>;
      for (const e of r.events) {
        const src = e.decisionSource ?? 'unknown';
        if (!sources[src]) sources[src] = { total: 0, correct: 0 };
        sources[src].total++;
        if (e.correctDecision) sources[src].correct++;
      }
      console.log('\n  Decision source breakdown:');
      for (const [src, data] of Object.entries(sources)) {
        const acc = data.correct / data.total;
        console.log(`    ${src}: ${data.correct}/${data.total} = ${(acc * 100).toFixed(1)}%`);
      }

      // Type breakdown with decision source
      const types = ['A', 'B', 'C', 'D', 'E'] as const;
      console.log('\n  Type + source breakdown:');
      for (const t of types) {
        const te = r.events.filter(e => e.interactionType === t);
        if (te.length === 0) continue;
        const acc = te.filter(e => e.correctDecision).length / te.length;
        const sourcesInType = {} as Record<string, number>;
        for (const e of te) {
          const src = e.decisionSource ?? 'unknown';
          sourcesInType[src] = (sourcesInType[src] || 0) + 1;
        }
        console.log(`    Type ${t}: ${(acc * 100).toFixed(1)}% (${te.length} events) — sources: ${JSON.stringify(sourcesInType)}`);
      }

      // Sample reasoning (LLM decisions only)
      console.log('\n  Sample LLM reasoning:');
      const llmSamples = r.events.filter(e => e.decisionSource === 'llm' && e.llmReasoning).slice(0, 5);
      for (const s of llmSamples) {
        console.log(`    [${s.eventId}→${s.agentId}/Type${s.interactionType}] correct=${s.correctDecision} decided=${s.decisionMade}`);
        console.log(`      ${(s.llmReasoning ?? '').substring(0, 150)}`);
      }

      // Sample preCheck reasoning
      console.log('\n  Sample preCheck reasoning:');
      const precheckSamples = r.events.filter(e => e.decisionSource === 'precheck').slice(0, 3);
      for (const s of precheckSamples) {
        console.log(`    [${s.eventId}→${s.agentId}/Type${s.interactionType}] correct=${s.correctDecision} decided=${s.decisionMade}`);
        console.log(`      ${(s.llmReasoning ?? '').substring(0, 120)}`);
      }
    }

    try {
      savePilotResults(allResults, 'exp-sanity-14b-fixed');
      const csvPath = join(getResultsBaseDir(), 'exp-sanity-14b-fixed-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`\nResults saved.`);
    } catch (err) {
      console.error('Save failed:', err);
    }
  });

  it(`full-ac / ${SCENARIO} x ${ITERATIONS} (model: ${MODEL})`, async () => {
    const config = PaperExperimentRunner.createConfig({
      id: `exp-sanity-14b-fixed`,
      name: `Sanity Check: 14B with fixed pipeline`,
      rq: 'RQ-INFRA',
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
