/**
 * Quick Layer 1 Sanity Check — 1 iteration only
 * Validates the Layer 1 pipeline works before running the full experiment.
 */

import { describe, it, expect } from 'vitest';
import { PaperExperimentRunner } from '../infrastructure/paper-experiment-runner.js';

const SCENARIO = 'apartment';
const MODEL = 'qwen3-14b-q4:latest';
const TIMEOUT = 3600000; // 60 minutes

describe('Layer 1 Sanity Check', () => {
  it(`layer1-enabled / ${SCENARIO} (1 iteration sanity)`, async () => {
    const config = PaperExperimentRunner.createConfig({
      id: `exp8-sanity-layer1-${SCENARIO}`,
      name: 'Exp 8 Layer 1 Sanity: layer1-enabled',
      rq: 'RQ3',
      scenario: SCENARIO,
      condition: 'layer1-enabled',
      iterations: 1,
      llmModel: MODEL,
      timeoutMs: 120000,
      multiAgentEval: true,
    });
    config.realisticRouting = true;

    const runner = new PaperExperimentRunner(config);
    const results = await runner.run();

    expect(results).toHaveLength(1);

    const result = results[0];
    console.log(`\n--- Layer 1 Sanity Results ---`);
    console.log(`Events: ${result.events.length}`);
    console.log(`Accuracy: ${(result.decisionQuality.meanCorrectDecisionRate * 100).toFixed(1)}%`);
    console.log(`Layer 1 filter rate: ${(result.efficiency.layer1FilterRate * 100).toFixed(1)}%`);
    console.log(`LLM calls: ${result.efficiency.llmCallCount}`);
    console.log(`Tokens: ${result.efficiency.totalTokens}`);

    const noiseStats = result.rawDualTriggerStats as Record<string, unknown>;
    console.log(`Noise events injected: ${noiseStats.noiseEventsInjected}`);
    console.log(`Noise clusters: ${noiseStats.noiseClustersTotal} total, ${noiseStats.noiseClustersFiltered} filtered`);
    console.log(`Noise cluster filter rate: ${((noiseStats.noiseFilterRate as number ?? 0) * 100).toFixed(1)}%`);

    expect(result.events.length).toBeGreaterThan(0);
    expect(Number.isFinite(result.decisionQuality.meanCorrectDecisionRate)).toBe(true);
    expect(noiseStats.noiseEventsInjected as number).toBeGreaterThan(0);
  }, TIMEOUT);

  it(`full-ac / ${SCENARIO} (1 iteration control)`, async () => {
    const config = PaperExperimentRunner.createConfig({
      id: `exp8-sanity-fullac-${SCENARIO}`,
      name: 'Exp 8 Layer 1 Sanity: full-ac control',
      rq: 'RQ3',
      scenario: SCENARIO,
      condition: 'full-ac',
      iterations: 1,
      llmModel: MODEL,
      timeoutMs: 120000,
      multiAgentEval: true,
    });
    config.realisticRouting = true;

    const runner = new PaperExperimentRunner(config);
    const results = await runner.run();

    expect(results).toHaveLength(1);

    const result = results[0];
    console.log(`\n--- Full-AC Control Results ---`);
    console.log(`Events: ${result.events.length}`);
    console.log(`Accuracy: ${(result.decisionQuality.meanCorrectDecisionRate * 100).toFixed(1)}%`);
    console.log(`Layer 1 filter rate: ${(result.efficiency.layer1FilterRate * 100).toFixed(1)}%`);
    console.log(`LLM calls: ${result.efficiency.llmCallCount}`);
    console.log(`Tokens: ${result.efficiency.totalTokens}`);

    expect(result.events.length).toBeGreaterThan(0);
    expect(Number.isFinite(result.decisionQuality.meanCorrectDecisionRate)).toBe(true);
  }, TIMEOUT);
});
