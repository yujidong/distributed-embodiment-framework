/**
 * RQ1: World Model Effectiveness
 *
 * Research Question: Does the physical simulation world model improve
 * multi-zone IoT decision quality?
 *
 * This experiment evaluates RQ1 by running the PaperExperimentRunner across
 * 4 experimental conditions x 2 scenario scales = 8 test cases. The world
 * model's contribution is isolated by comparing the full-ac condition (which
 * includes physical context, spatial reasoning, and effect propagation) against
 * ablated conditions that progressively remove these capabilities.
 *
 * Conditions:
 *   - full-ac:          Complete AC with physical simulation world model
 *   - text-only:        No physical context, no spatiotemporal reasoning, no AC history
 *   - no-spatial:       Physical context disabled (zone adjacency unknown)
 *   - no-propagation:   Effect propagation disabled (no cross-zone reasoning)
 *
 * Scenarios:
 *   - apartment:        Five-room apartment with three agents
 *   - campus:           Nine-building campus with six agents
 *
 * Metrics collected (per-event and aggregated):
 *   - Zone Targeting Accuracy:       Are devices in the correct zone selected?
 *   - Capability Appropriateness:    Are the right capabilities requested?
 *   - Side-Effect Awareness:         Does the agent reason about adjacent-zone propagation?
 *   - Physical Plausibility:         Are proposed actions physically feasible?
 *   - Correct Decision Rate:         Does the agent choose the right collaboration strategy?
 *
 * Paper Section: Results - RQ1 World Model Effectiveness
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LLMClient, initializeLLM } from '@active-collaboration/llm-integration';
import { PaperExperimentRunner } from './infrastructure/paper-experiment-runner.js';
import type { ScenarioType, ExperimentCondition } from './infrastructure/types.js';

// ---------------------------------------------------------------------------
// Experiment parameters
// ---------------------------------------------------------------------------

const conditions: ExperimentCondition[] = [
  'full-ac',
  'text-only',
  'no-spatial',
  'no-propagation',
];

const scenarios: ScenarioType[] = ['apartment', 'campus'];

const LLM_MODEL = 'qwen3-14b-q4:latest';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('RQ1: World Model Effectiveness', () => {
  // Shared LLM initialization -- verify connectivity once before all tests
  let sharedLLMClient: LLMClient;

  beforeAll(async () => {
    console.log('\n========================================');
    console.log('[RQ1] World Model Effectiveness Experiment');
    console.log('========================================\n');

    const initResult = await initializeLLM({
      preferredModels: [LLM_MODEL],
      allowFallback: false,
    });

    if (!initResult.success) {
      throw new Error(`LLM initialization failed: ${initResult.error}`);
    }

    sharedLLMClient = new LLMClient('ollama', { model: initResult.selectedModel });

    console.log(`[RQ1] Using model: ${initResult.selectedModel}`);
    console.log(`[RQ1] Conditions: ${conditions.join(', ')}`);
    console.log(`[RQ1] Scenarios: ${scenarios.join(', ')}`);
    console.log(`[RQ1] Total test cases: ${conditions.length * scenarios.length}`);
  }, 120000);

  // -----------------------------------------------------------------------
  // Cross-product: scenario x condition
  // -----------------------------------------------------------------------

  for (const scenario of scenarios) {
    for (const condition of conditions) {
      it(`${scenario} / ${condition}`, async () => {
        console.log(`\n[RQ1] Running: ${scenario} / ${condition}`);

        // Build the experiment configuration
        const config = PaperExperimentRunner.createConfig({
          id: `rq1-${scenario}-${condition}`,
          name: `RQ1 ${scenario} ${condition}`,
          rq: 'RQ1',
          scenario,
          condition,
          iterations: 1,
          llmModel: LLM_MODEL,
          timeoutMs: 120000,
        });

        // Execute the experiment -- real LLM, real simulation, no mocks
        const runner = new PaperExperimentRunner(config);
        const results = await runner.run();

        // -----------------------------------------------------------------
        // Structural assertions
        // -----------------------------------------------------------------

        // One result per iteration (we configured iterations: 1)
        expect(results).toHaveLength(1);

        // The result should contain events from the scenario
        expect(results[0].events.length).toBeGreaterThan(0);

        // -----------------------------------------------------------------
        // Decision quality metric assertions (basic sanity bounds)
        // -----------------------------------------------------------------

        const dq = results[0].decisionQuality;

        // All metric values must be non-negative numbers
        expect(dq.meanZoneTargetingAccuracy).toBeGreaterThanOrEqual(0);
        expect(dq.meanCapabilityAppropriateness).toBeGreaterThanOrEqual(0);
        expect(dq.meanSideEffectAwareness).toBeGreaterThanOrEqual(0);
        expect(dq.meanPhysicalPlausibility).toBeGreaterThanOrEqual(0);
        expect(dq.meanCorrectDecisionRate).toBeGreaterThanOrEqual(0);

        // Metrics bounded to [0, 1] (except sideEffectAwareness which is 0-3)
        expect(dq.meanZoneTargetingAccuracy).toBeLessThanOrEqual(1);
        expect(dq.meanCapabilityAppropriateness).toBeLessThanOrEqual(1);
        expect(dq.meanPhysicalPlausibility).toBeLessThanOrEqual(1);
        expect(dq.meanCorrectDecisionRate).toBeLessThanOrEqual(1);

        // -----------------------------------------------------------------
        // Collaboration statistics assertions
        // -----------------------------------------------------------------

        const collab = results[0].collaboration;
        expect(collab.initiationRate).toBeGreaterThanOrEqual(0);
        expect(collab.initiationRate).toBeLessThanOrEqual(1);

        // -----------------------------------------------------------------
        // Log metrics for paper data collection
        // -----------------------------------------------------------------

        console.log(`\n=== RQ1 ${scenario}/${condition} ===`);
        console.log(JSON.stringify(dq, null, 2));
        console.log(`Collaboration: ${JSON.stringify(collab, null, 2)}`);
        console.log(`Efficiency: ${JSON.stringify(results[0].efficiency, null, 2)}`);

        // Log per-event details for deeper analysis
        for (const eventResult of results[0].events) {
          console.log(
            `  Event ${eventResult.eventId}: ` +
            `decision=${eventResult.decisionMade}, ` +
            `zoneAccuracy=${eventResult.zoneTargetingAccuracy.toFixed(2)}, ` +
            `capAppropriateness=${eventResult.capabilityAppropriateness.toFixed(2)}, ` +
            `sideEffect=${eventResult.sideEffectAwareness}, ` +
            `physicalPlausibility=${eventResult.physicalPlausibility.toFixed(2)}, ` +
            `correct=${eventResult.correctDecision}`,
          );
        }
      }, 300000); // 5-minute timeout per test (LLM calls are slow)
    }
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------

  afterAll(() => {
    console.log('\n========================================');
    console.log('[RQ1] World Model Effectiveness Experiment Complete');
    console.log('========================================');
    console.log(
      '\nCompare decision quality across conditions:\n' +
      '  full-ac (world model enabled) vs. text-only / no-spatial / no-propagation (ablated)\n' +
      'Expectation: full-ac should show higher zone targeting accuracy, side-effect awareness,\n' +
      'and physical plausibility than ablated conditions, especially in campus (multi-zone).\n',
    );
  });
});
