/**
 * Experiment 4: Broadcast Resilience
 *
 * Tests agent-directed broadcast events in the apartment scenario.
 * With realisticRouting enabled, agent-directed events are broadcast to all
 * agents, testing the zone-coverage preCheck's defer/ignore capability for
 * Type D events (agents that lack capabilities and are outside range).
 *
 * The 3 agent-directed broadcast events:
 *   - fire-alarm-broadcast (critical, requires collaboration)
 *   - security-alert-broadcast (high, requires collaboration)
 *   - hvac-system-alert (medium, handle independently)
 *
 * Scenario: apartment (runs all events, but results table separates
 * device-originated vs agent-directed events)
 * Conditions: full-ac, rule-only, always-collaborate
 * Config: multiAgentEval: true, realisticRouting: true
 * N=3 iterations
 * Model: qwen3-14b-q4:latest
 *
 * Produces: Broadcast event accuracy table (device-originated vs agent-directed),
 *           Type D defer/ignore analysis for broadcast events
 */

import { describe, it, expect, afterAll } from 'vitest';
import type { ExperimentCondition } from '../infrastructure/types.js';
import { PaperExperimentRunner } from '../infrastructure/paper-experiment-runner.js';
import { MetricsCollector } from '../infrastructure/metrics-collector.js';
import { SCENARIOS } from '../infrastructure/scenario-definitions.js';
import {
  savePilotResults,
  exportResultsCSV,
  getResultsBaseDir,
} from '../infrastructure/result-persistence.js';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCENARIO = 'apartment';

const CONDITIONS: ExperimentCondition[] = [
  'full-ac',
  'rule-only',
  'always-collaborate',
];

const ITERATIONS = 5;
const TIMEOUT = 5400000; // 90 minutes per test
const MODEL = 'qwen3-14b-q4:latest';

const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

// ---------------------------------------------------------------------------
// Helper: Broadcast resilience analysis
// ---------------------------------------------------------------------------

function printBroadcastAnalysis(): void {
  console.log('\n========================================');
  console.log('Experiment 4: Broadcast Resilience');
  console.log(`Scenario: ${SCENARIO} | Model: ${MODEL} | Iterations: ${ITERATIONS}`);
  console.log('========================================\n');

  // Identify broadcast (agent-directed) event IDs
  const scenarioDef = SCENARIOS[SCENARIO];
  const broadcastEventIds = new Set(
    scenarioDef.events
      .filter(e => e.eventCategory === 'agent-directed')
      .map(e => e.id),
  );
  const deviceEventIds = new Set(
    scenarioDef.events
      .filter(e => e.eventCategory !== 'agent-directed')
      .map(e => e.id),
  );

  console.log(`Broadcast events: ${broadcastEventIds.size}`);
  console.log(`Device-originated events: ${deviceEventIds.size}\n`);

  // --- Per-condition summary ---
  for (const condition of CONDITIONS) {
    const results = allResults.filter(r => r.config.condition === condition);
    if (results.length === 0) continue;

    console.log(`--- ${condition} ---`);

    // Separate events by category
    const allEvents = results.flatMap(r => r.events);
    const broadcastEvents = allEvents.filter(e => broadcastEventIds.has(e.eventId));
    const deviceEvents = allEvents.filter(e => deviceEventIds.has(e.eventId));

    // Overall accuracy
    const overallAcc = allEvents.length > 0
      ? allEvents.filter(e => e.correctDecision).length / allEvents.length
      : 0;
    const broadcastAcc = broadcastEvents.length > 0
      ? broadcastEvents.filter(e => e.correctDecision).length / broadcastEvents.length
      : 0;
    const deviceAcc = deviceEvents.length > 0
      ? deviceEvents.filter(e => e.correctDecision).length / deviceEvents.length
      : 0;

    console.log(`  Overall accuracy:        ${(overallAcc * 100).toFixed(1)}% (${allEvents.length} events)`);
    console.log(`  Device-originated acc:   ${(deviceAcc * 100).toFixed(1)}% (${deviceEvents.length} events)`);
    console.log(`  Agent-directed acc:      ${(broadcastAcc * 100).toFixed(1)}% (${broadcastEvents.length} events)`);

    // Type D analysis for broadcast events
    const typeDBroadcast = broadcastEvents.filter(e => e.interactionType === 'D');
    const typeDBroadcastCorrect = typeDBroadcast.filter(e => e.correctDecision).length;
    const typeDDeferOrIgnore = typeDBroadcast.filter(
      e => e.decisionMade === 'defer' || e.decisionMade === 'ignore',
    ).length;

    console.log(`\n  Type D broadcast events:`);
    console.log(`    Total Type D: ${typeDBroadcast.length}`);
    console.log(`    Correct decision: ${typeDBroadcastCorrect} (${typeDBroadcast.length > 0 ? (typeDBroadcastCorrect / typeDBroadcast.length * 100).toFixed(1) : 'N/A'}%)`);
    console.log(`    Defer/Ignore rate: ${typeDDeferOrIgnore} (${typeDBroadcast.length > 0 ? (typeDDeferOrIgnore / typeDBroadcast.length * 100).toFixed(1) : 'N/A'}%)`);

    // Per broadcast event breakdown
    console.log(`\n  Per-event breakdown (agent-directed):`);
    for (const evtId of broadcastEventIds) {
      const evtResults = broadcastEvents.filter(e => e.eventId === evtId);
      const evtDef = scenarioDef.events.find(e => e.id === evtId);
      if (evtResults.length === 0 || !evtDef) continue;

      const acc = evtResults.filter(e => e.correctDecision).length / evtResults.length;
      const decisions: Record<string, number> = {};
      for (const er of evtResults) {
        decisions[er.decisionMade] = (decisions[er.decisionMade] ?? 0) + 1;
      }
      const decisionStr = Object.entries(decisions).map(([d, c]) => `${d}:${c}`).join(', ');

      console.log(
        `    ${evtDef.type} (${evtDef.severity}): ` +
        `acc=${(acc * 100).toFixed(1)}% [${decisionStr}]`,
      );
    }

    console.log('');
  }

  // --- Cross-condition comparison table ---
  console.log('| Condition          | Overall | Device-Originated | Agent-Directed | Type D Correct |');
  console.log('|--------------------|---------|-------------------|----------------|----------------|');

  for (const condition of CONDITIONS) {
    const results = allResults.filter(r => r.config.condition === condition);
    if (results.length === 0) continue;

    const allEvents = results.flatMap(r => r.events);
    const broadcastEvents = allEvents.filter(e => broadcastEventIds.has(e.eventId));
    const deviceEvents = allEvents.filter(e => deviceEventIds.has(e.eventId));
    const typeDBroadcast = broadcastEvents.filter(e => e.interactionType === 'D');

    const overallAcc = allEvents.length > 0
      ? allEvents.filter(e => e.correctDecision).length / allEvents.length
      : 0;
    const deviceAcc = deviceEvents.length > 0
      ? deviceEvents.filter(e => e.correctDecision).length / deviceEvents.length
      : 0;
    const broadcastAcc = broadcastEvents.length > 0
      ? broadcastEvents.filter(e => e.correctDecision).length / broadcastEvents.length
      : 0;
    const typeDCorrect = typeDBroadcast.length > 0
      ? typeDBroadcast.filter(e => e.correctDecision).length / typeDBroadcast.length
      : 0;

    console.log(
      `| ${condition.padEnd(18)} | ` +
      `${(overallAcc * 100).toFixed(1).padStart(6)}% | ` +
      `${(deviceAcc * 100).toFixed(1).padStart(16)}% | ` +
      `${(broadcastAcc * 100).toFixed(1).padStart(13)}% | ` +
      `${(typeDCorrect * 100).toFixed(1).padStart(13)}% |`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Experiment 4: Broadcast Resilience', () => {
  afterAll(() => {
    printBroadcastAnalysis();

    try {
      const savedPaths = savePilotResults(allResults, 'exp-4-broadcast');
      console.log(`\nResults saved to ${savedPaths.length} files`);

      const csvPath = join(getResultsBaseDir(), 'exp-4-broadcast-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`CSV exported to ${csvPath}`);
    } catch (err) {
      console.error('Failed to save results:', err);
    }
  });

  for (const condition of CONDITIONS) {
    it(`${condition} / ${SCENARIO} (broadcast resilience, N=${ITERATIONS})`, async () => {
      const config = PaperExperimentRunner.createConfig({
        id: `exp4-${condition}-${SCENARIO}`,
        name: `Exp 4 Broadcast: ${condition}`,
        rq: 'RQ2',
        scenario: SCENARIO,
        condition,
        iterations: ITERATIONS,
        llmModel: MODEL,
        timeoutMs: 120000,
        multiAgentEval: true,
      });
      config.realisticRouting = true;

      const runner = new PaperExperimentRunner(config);
      const results = await runner.run();

      expect(results).toHaveLength(ITERATIONS);

      for (const result of results) {
        expect(result.events.length).toBeGreaterThan(0);
        expect(Number.isFinite(result.decisionQuality.meanCorrectDecisionRate)).toBe(true);
        allResults.push(result);
      }

      // Incremental save: write CSV after each test case so data isn't lost if process hangs
      try {
        const csvPath = join(getResultsBaseDir(), 'exp-4-broadcast-summary.csv');
        exportResultsCSV(allResults, csvPath);
        console.log(`[Incremental] CSV saved (${allResults.length} results): ${csvPath}`);
      } catch (err) {
        console.error('[Incremental] Failed to save CSV:', err);
      }
    }, TIMEOUT);
  }
});
