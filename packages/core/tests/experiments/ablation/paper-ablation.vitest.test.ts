/**
 * Paper Ablation Experiment — PAPER_DESIGN_V5 (Sprint P33)
 *
 * Runs all V5 experimental conditions across the apartment scenario with
 * multi-agent evaluation enabled. Collects comparable metrics including
 * precision/recall/F1 classification metrics and type-wise breakdown.
 *
 * Conditions (V5):
 *   1. full-ac             — Complete AC system (LLM)
 *   2. vague-spatial       — Imprecise spatial descriptions (LLM)
 *   3. no-propagation      — No effect propagation info (LLM)
 *   4. no-service          — No service discovery (LLM)
 *   5. central-planner     — Greedy-optimal baseline (no LLM)
 *   6. random-planner      — Random baseline (no LLM)
 *   7. always-collaborate  — Always triggers (LLM)
 *   8. never-collaborate   — Never triggers (no LLM)
 *   9. rule-only           — Layer 1 only (no LLM)
 *  10. oracle              — Perfect information (LLM)
 *
 * CLAUDE.md compliance:
 *   - NO mocks, NO fallbacks — real Ollama LLM for LLM conditions
 *   - Baseline conditions use real planner algorithms, no LLM
 *   - Fail-early: throws if Ollama or model unavailable
 */

import { describe, it, expect } from 'vitest';
import type { ExperimentCondition } from '../infrastructure/types.js';
import { PaperExperimentRunner } from '../infrastructure/paper-experiment-runner.js';

const ABLATION_CONDITIONS: ExperimentCondition[] = [
  'full-ac',
  'vague-spatial',
  'no-propagation',
  'no-service',
  'central-planner',
  'random-planner',
  'always-collaborate',
  'never-collaborate',
  'rule-only',
  'oracle',
];

const SCENARIO = 'apartment';
const TIMEOUT = 300000; // 5 minutes per test (LLM conditions ~30-90s, non-LLM ~5s)

// Helper to print classification metrics
function printClassification(condition: string, result: any): void {
  const dq = result.decisionQuality;
  const cls = result.classification;
  const eff = result.efficiency;

  console.log(`\n=== Ablation: ${condition} / ${SCENARIO} ===`);
  console.log(`  correctDecisionRate: ${(dq.meanCorrectDecisionRate * 100).toFixed(1)}%`);
  console.log(`  zoneTargetingAccuracy: ${dq.meanZoneTargetingAccuracy.toFixed(3)}`);
  console.log(`  capabilityAppropriateness: ${dq.meanCapabilityAppropriateness.toFixed(3)}`);
  console.log(`  totalTokens: ${eff.totalTokens}`);
  console.log(`  wallTimeMs: ${eff.totalWallTimeMs.toFixed(0)}`);

  if (cls) {
    console.log(`  --- Classification Metrics ---`);
    console.log(`  Macro Precision: ${(cls.macroPrecision * 100).toFixed(1)}%`);
    console.log(`  Macro Recall:    ${(cls.macroRecall * 100).toFixed(1)}%`);
    console.log(`  Macro F1:        ${(cls.macroF1 * 100).toFixed(1)}%`);
    console.log(`  AC-Trigger Precision: ${(cls.collaborationTriggerF1.precision * 100).toFixed(1)}%`);
    console.log(`  AC-Trigger Recall:    ${(cls.collaborationTriggerF1.recall * 100).toFixed(1)}%`);
    console.log(`  AC-Trigger F1:        ${(cls.collaborationTriggerF1.f1 * 100).toFixed(1)}%`);
    console.log(`  Partner Selection F1: ${(cls.partnerSelection.partnerF1 * 100).toFixed(1)}%`);
    console.log(`  Capability Match F1:  ${(cls.capabilityMatch.f1 * 100).toFixed(1)}%`);

    console.log(`  --- Per-Class ---`);
    for (const pc of cls.perClass) {
      if (pc.support > 0) {
        console.log(
          `    ${pc.className}: P=${(pc.precision * 100).toFixed(1)}% ` +
          `R=${(pc.recall * 100).toFixed(1)}% F1=${(pc.f1 * 100).toFixed(1)}% ` +
          `(support=${pc.support})`,
        );
      }
    }

    console.log(`  --- Confusion Matrix ---`);
    const classes = ['initiate_ac', 'handle_ind', 'defer', 'ignore'];
    console.log(`                 ${classes.map(c => c.padStart(12)).join(' ')}`);
    for (let i = 0; i < 4; i++) {
      console.log(
        `    ${classes[i].padEnd(12)} ${cls.confusionMatrix[i].map((v: number) => String(v).padStart(12)).join(' ')}`,
      );
    }
  }
}

describe('Paper Ablation: All V5 Conditions (Multi-Agent)', () => {
  for (const condition of ABLATION_CONDITIONS) {
    it(`${condition} / ${SCENARIO}`, async () => {
      const config = PaperExperimentRunner.createConfig({
        id: `ablation-${condition}-${SCENARIO}`,
        name: `Ablation ${condition} ${SCENARIO}`,
        rq: 'RQ2',
        scenario: SCENARIO,
        condition,
        iterations: 1,
        llmModel: 'qwen3-14b-q4:latest',
        timeoutMs: 120000,
        multiAgentEval: true,
      });

      const runner = new PaperExperimentRunner(config);
      const results = await runner.run();

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.events.length).toBeGreaterThan(0);

      // Print all metrics
      printClassification(condition, result);

      // Structural assertions
      const dq = result.decisionQuality;
      expect(Number.isFinite(dq.meanCorrectDecisionRate)).toBe(true);

      const cls = result.classification;
      expect(cls).toBeDefined();
      expect(Number.isFinite(cls.macroF1)).toBe(true);
      expect(Number.isFinite(cls.collaborationTriggerF1.f1)).toBe(true);
      expect(Number.isFinite(cls.partnerSelection.partnerF1)).toBe(true);
      expect(Number.isFinite(cls.capabilityMatch.f1)).toBe(true);

      // Confusion matrix dimensions
      expect(cls.confusionMatrix.length).toBe(4);
      for (const row of cls.confusionMatrix) {
        expect(row.length).toBe(4);
      }
    }, TIMEOUT);
  }
});
