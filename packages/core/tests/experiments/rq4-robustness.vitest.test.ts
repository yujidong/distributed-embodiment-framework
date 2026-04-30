/**
 * RQ4: Robustness — Graceful Degradation Under Failure Conditions
 *
 * Research Question: Does the system degrade gracefully under failure conditions?
 *
 * This experiment evaluates RQ4 by injecting three types of failures into the
 * apartment scenario under the full-ac condition, then measuring robustness
 * metrics that capture how well the system continues to operate:
 *
 * Failure Types:
 *   - device-unresponsive:  A device's physical environment reference is
 *                           nullified, simulating hardware failure.
 *   - agent-withdrawal:     One agent's DualTriggerACManager is stopped,
 *                           simulating an agent leaving the collaboration.
 *   - communication-timeout: Processing timeouts simulate network partitions
 *                           that prevent timely agent responses.
 *
 * Additionally, a baseline (no-failure) run establishes the system's normal
 * correct-decision rate so we can confirm that failure conditions degrade
 * performance relative to the baseline but do not collapse it entirely.
 *
 * Robustness Metrics (per iteration):
 *   - gracefulDegradationCount: Number of events handled gracefully under failure
 *   - gracefulDegradationRate:  Fraction of events handled gracefully (0-1)
 *   - systemAvailability:       Whether the system remained operational (0-1)
 *   - avgRecoveryTimeMs:        Average time to detect and adapt to failure
 *
 * Paper Section: Results — RQ4 Robustness
 *
 * CLAUDE.md compliance:
 *   - NO mocks, NO fallbacks — real Ollama LLM (qwen3-14b-q4:latest)
 *   - Real PhysicalEnvironment, CognitiveAgent, SimulatedDevice instances
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LLMClient, initializeLLM } from '@active-collaboration/llm-integration';
import { PaperExperimentRunner } from './infrastructure/paper-experiment-runner.js';
import type { RobustnessFailureType, PaperExperimentResult } from './infrastructure/types.js';

// ---------------------------------------------------------------------------
// Experiment parameters
// ---------------------------------------------------------------------------

const failureTypes: RobustnessFailureType[] = [
  'device-unresponsive',
  'agent-withdrawal',
  'communication-timeout',
];

const LLM_MODEL = 'qwen3-14b-q4:latest';

/** Storage for cross-test comparisons (baseline vs failure conditions). */
let baselineResult: PaperExperimentResult | null = null;
const failureResults: Map<RobustnessFailureType, PaperExperimentResult> = new Map();

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('RQ4: Robustness — Graceful Degradation Under Failure', () => {

  // =========================================================================
  // Shared LLM initialization
  // =========================================================================

  let sharedLLMClient: LLMClient;

  beforeAll(async () => {
    console.log('\n============================================================');
    console.log('[RQ4] Robustness Experiment — Graceful Degradation');
    console.log('============================================================\n');

    const initResult = await initializeLLM({
      preferredModels: [LLM_MODEL],
      allowFallback: false,
    });

    if (!initResult.success) {
      throw new Error(`LLM initialization failed: ${initResult.error}`);
    }

    sharedLLMClient = new LLMClient('ollama', { model: initResult.selectedModel });

    console.log(`[RQ4] Using model: ${initResult.selectedModel}`);
    console.log(`[RQ4] Scenario: apartment (3 agents, 5 zones)`);
    console.log(`[RQ4] Condition: full-ac`);
    console.log(`[RQ4] Failure types: ${failureTypes.join(', ')}`);
    console.log(`[RQ4] Test cases: 1 baseline + ${failureTypes.length} failure conditions = ${failureTypes.length + 1} total`);
  }, 120000);

  // =========================================================================
  // Baseline: no failure injection
  // =========================================================================

  it('apartment / full-ac / no-failure (baseline)', async () => {
    console.log('\n[RQ4] Running baseline (no failure) for apartment / full-ac');

    const config = PaperExperimentRunner.createConfig({
      id: 'rq4-apartment-full-ac-baseline',
      name: 'RQ4 Baseline apartment full-ac no-failure',
      rq: 'RQ4',
      scenario: 'apartment',
      condition: 'full-ac',
      iterations: 1,
      llmModel: LLM_MODEL,
      timeoutMs: 120000,
      // No failureType — baseline run
    });

    const runner = new PaperExperimentRunner(config);
    const results = await runner.run();

    // Structural assertions
    expect(results).toHaveLength(1);
    expect(results[0].events.length).toBeGreaterThan(0);

    // Decision quality metrics should be present and valid
    const dq = results[0].decisionQuality;
    expect(dq.meanZoneTargetingAccuracy).toBeGreaterThanOrEqual(0);
    expect(dq.meanCapabilityAppropriateness).toBeGreaterThanOrEqual(0);
    expect(dq.meanSideEffectAwareness).toBeGreaterThanOrEqual(0);
    expect(dq.meanPhysicalPlausibility).toBeGreaterThanOrEqual(0);
    expect(dq.meanCorrectDecisionRate).toBeGreaterThanOrEqual(0);

    // Bounded to [0, 1] (except sideEffectAwareness, 0-3)
    expect(dq.meanZoneTargetingAccuracy).toBeLessThanOrEqual(1);
    expect(dq.meanCapabilityAppropriateness).toBeLessThanOrEqual(1);
    expect(dq.meanPhysicalPlausibility).toBeLessThanOrEqual(1);
    expect(dq.meanCorrectDecisionRate).toBeLessThanOrEqual(1);

    // Baseline should NOT have robustness metrics (no failureType set)
    expect(results[0].robustness).toBeUndefined();

    // Store baseline for cross-test comparison
    baselineResult = results[0];

    // Comprehensive logging for paper data collection
    console.log('\n=== RQ4 Baseline (apartment / full-ac / no-failure) ===');
    console.log(`Decision Quality:\n${JSON.stringify(dq, null, 2)}`);
    console.log(`Collaboration:\n${JSON.stringify(results[0].collaboration, null, 2)}`);
    console.log(`Efficiency:\n${JSON.stringify(results[0].efficiency, null, 2)}`);

    // Per-event detail logging
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
  }, 300000);

  // =========================================================================
  // Failure conditions: each failure type × apartment scenario
  // =========================================================================

  for (const failureType of failureTypes) {
    it(`apartment / full-ac / ${failureType}`, async () => {
      console.log(`\n[RQ4] Running failure injection: ${failureType}`);

      const config = PaperExperimentRunner.createConfig({
        id: `rq4-apartment-full-ac-${failureType}`,
        name: `RQ4 apartment full-ac ${failureType}`,
        rq: 'RQ4',
        scenario: 'apartment',
        condition: 'full-ac',
        iterations: 1,
        llmModel: LLM_MODEL,
        timeoutMs: 120000,
        failureType,
      });

      const runner = new PaperExperimentRunner(config);
      const results = await runner.run();

      // -----------------------------------------------------------------
      // Structural assertions
      // -----------------------------------------------------------------

      // Should produce exactly one result
      expect(results).toHaveLength(1);

      // Events should be present — the system must not crash entirely
      expect(results[0].events.length).toBeGreaterThan(0);

      // -----------------------------------------------------------------
      // Robustness metrics assertions
      // -----------------------------------------------------------------

      // When rq === 'RQ4' and failureType is set, robustness must be populated
      const robustness = results[0].robustness;
      expect(robustness).toBeDefined();
      expect(robustness).not.toBeNull();

      // The recorded failure type must match what was configured
      expect(robustness!.failureType).toBe(failureType);

      // gracefulDegradationRate must be a valid fraction [0, 1]
      expect(robustness!.gracefulDegradationRate).toBeGreaterThanOrEqual(0);
      expect(robustness!.gracefulDegradationRate).toBeLessThanOrEqual(1);

      // gracefulDegradationCount must be non-negative and <= total events
      expect(robustness!.gracefulDegradationCount).toBeGreaterThanOrEqual(0);
      expect(robustness!.gracefulDegradationCount).toBeLessThanOrEqual(
        results[0].events.length,
      );

      // systemAvailability must be between 0 and 1
      expect(robustness!.systemAvailability).toBeGreaterThanOrEqual(0);
      expect(robustness!.systemAvailability).toBeLessThanOrEqual(1);

      // avgRecoveryTimeMs must be a non-negative number
      expect(robustness!.avgRecoveryTimeMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(robustness!.avgRecoveryTimeMs)).toBe(true);

      // -----------------------------------------------------------------
      // Decision quality should still be present (degraded, not absent)
      // -----------------------------------------------------------------

      const dq = results[0].decisionQuality;
      expect(Number.isFinite(dq.meanCorrectDecisionRate)).toBe(true);
      expect(Number.isFinite(dq.meanZoneTargetingAccuracy)).toBe(true);
      expect(Number.isFinite(dq.meanCapabilityAppropriateness)).toBe(true);

      // -----------------------------------------------------------------
      // Store for cross-test comparison
      // -----------------------------------------------------------------

      failureResults.set(failureType, results[0]);

      // -----------------------------------------------------------------
      // Comprehensive logging for paper data collection
      // -----------------------------------------------------------------

      console.log(`\n=== RQ4 ${failureType} (apartment / full-ac) ===`);
      console.log(`Robustness:\n${JSON.stringify(robustness, null, 2)}`);
      console.log(`Decision Quality:\n${JSON.stringify(dq, null, 2)}`);
      console.log(`Collaboration:\n${JSON.stringify(results[0].collaboration, null, 2)}`);
      console.log(`Efficiency:\n${JSON.stringify(results[0].efficiency, null, 2)}`);

      // Per-event detail logging
      for (const eventResult of results[0].events) {
        console.log(
          `  Event ${eventResult.eventId}: ` +
          `decision=${eventResult.decisionMade}, ` +
          `zoneAccuracy=${eventResult.zoneTargetingAccuracy.toFixed(2)}, ` +
          `capAppropriateness=${eventResult.capabilityAppropriateness.toFixed(2)}, ` +
          `sideEffect=${eventResult.sideEffectAwareness}, ` +
          `physicalPlausibility=${eventResult.physicalPlausibility.toFixed(2)}, ` +
          `correct=${eventResult.correctDecision}, ` +
          `assessmentTime=${eventResult.assessmentTimeMs}ms`,
        );
      }
    }, 300000);
  }

  // =========================================================================
  // Cross-test comparison: baseline vs failure conditions
  // =========================================================================

  it('baseline should have higher correct-decision rate than failure conditions', () => {
    console.log('\n=== RQ4 Cross-Test Comparison ===');

    expect(baselineResult).not.toBeNull();
    const baselineRate = baselineResult!.decisionQuality.meanCorrectDecisionRate;

    console.log(`Baseline correct-decision rate: ${baselineRate.toFixed(3)}`);

    for (const failureType of failureTypes) {
      const failureResult = failureResults.get(failureType);

      if (!failureResult) {
        console.warn(
          `[RQ4] WARNING: No result stored for failure type "${failureType}". ` +
          `Skipping comparison.`,
        );
        continue;
      }

      const failureRate = failureResult.decisionQuality.meanCorrectDecisionRate;
      const robustness = failureResult.robustness;

      console.log(`\n--- ${failureType} ---`);
      console.log(`  Correct-decision rate: ${failureRate.toFixed(3)}`);
      console.log(`  Degradation from baseline: ${((baselineRate - failureRate) * 100).toFixed(1)}%`);
      console.log(`  Graceful degradation rate: ${robustness?.gracefulDegradationRate?.toFixed(3) ?? 'N/A'}`);
      console.log(`  System availability: ${robustness?.systemAvailability?.toFixed(3) ?? 'N/A'}`);
      console.log(`  Avg recovery time: ${robustness?.avgRecoveryTimeMs?.toFixed(0) ?? 'N/A'}ms`);

      // The baseline (no failure) should have a higher or equal correct
      // decision rate compared to any failure condition. In rare cases,
      // randomness could cause a failure run to match or slightly exceed the
      // baseline, so we assert >= rather than strictly >.
      expect(failureRate).toBeLessThanOrEqual(baselineRate);
    }

    // At least one failure type must have been tested
    expect(failureResults.size).toBeGreaterThan(0);

    console.log('\n[RQ4] Cross-test comparison complete.');
  });

  // =========================================================================
  // Summary
  // =========================================================================

  afterAll(() => {
    console.log('\n============================================================');
    console.log('[RQ4] Robustness Experiment Complete');
    console.log('============================================================');
    console.log(
      '\nSummary of findings:\n' +
      '  The system should demonstrate graceful degradation under all three\n' +
      '  failure types. Key indicators:\n' +
      '    - gracefulDegradationRate > 0: System handles some events correctly\n' +
      '    - systemAvailability = 1: System does not crash under failure\n' +
      '    - Baseline correct-decision rate > failure correct-decision rate\n' +
      '\n' +
      '  If systemAvailability drops to 0, the system crashed rather than\n' +
      '  degrading gracefully — a robustness failure.\n' +
      '  If gracefulDegradationRate is 0 under failure, the system did not\n' +
      '  handle any events correctly — indicating no graceful degradation.\n',
    );
  });
});
