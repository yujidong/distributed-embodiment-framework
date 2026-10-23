/**
 * R1 fix (B1-1 / P-03) — `sim eval` human-mode rendering regression.
 *
 * The old renderer crashed with `TypeError: Cannot read properties of
 * undefined (reading 'join')` whenever a metaAgents entry lacked
 * `capabilityBoundary` (u1/u2/u4 all hit it; empty rule-only sims crashed
 * too). These are PURE rendering fixtures — no server boot — so the file
 * lives in the CLI fast lane (vitest.fast.config.ts); the booting e2e
 * suites stay in the full lane only.
 */

import { describe, expect, test } from 'vitest';

import { renderEvalReportHuman } from '../commands/sim.js';

function render(report: unknown): string[] {
  const lines: string[] = [];
  renderEvalReportHuman(report, text => lines.push(text));
  return lines;
}

describe('renderEvalReportHuman (B1-1)', () => {
  test('u4 scenario: rule-only, zero decisions, empty metaAgents — exit-shape complete', () => {
    const lines = render({
      simId: 'sim-u4',
      scenarioId: 'campus',
      source: 'disk',
      state: 'stopped',
      decisions: { total: 0, accuracy: null },
      handshakes: { initiated: 0, successRate: null },
      metaAgents: [],
    });
    expect(lines[0]).toContain('eval: campus | source=disk state=stopped');
    expect(lines[2]).toContain('decisions: 0 (accuracy —)');
    expect(lines[2]).toContain('handshakes: 0 (—)');
    expect(lines.some(l => l.includes('metacognition: — (no live agent state'))).toBe(true);
  });

  test('u1 scenario: LLM decisions, trust partners empty — full sections render', () => {
    const lines = render({
      simId: 'sim-u1',
      scenarioId: 'campus',
      source: 'live',
      state: 'running',
      decisions: { total: 12, accuracy: 0.75 },
      handshakes: {
        initiated: 3,
        successRate: 0.3333,
        cancelledByCoordinator: 0,
        negotiationSuccessRate: 0.5,
      },
      metaAgents: [
        {
          agentName: 'hvac-keeper',
          calibrationScore: 0.8,
          evaluatedDecisions: 8,
          decisionCount: 12,
          successRate: 0.75,
          capabilityBoundary: { strong: ['hvac-control'], weak: [], mustEscalate: ['fire-response'] },
        },
      ],
    });
    expect(lines[2]).toContain('decisions: 12 (accuracy 75%)');
    expect(lines[2]).toContain('handshakes: 3 (33%)');
    expect(lines[2]).toContain('negotiation: 50% (dedup-cancelled 0)');
    expect(lines.some(l => l.includes('hvac-keeper: calibration 80% | success 75% · 评估 8/12'))).toBe(true);
    expect(lines.some(l => l.includes('strong: hvac-control | weak: — | must-escalate: fire-response'))).toBe(true);
  });

  test('metaAgents entry missing capabilityBoundary renders — instead of crashing (was the P-03 crash)', () => {
    const lines = render({
      simId: 'sim-broken',
      scenarioId: 'campus',
      source: 'live',
      state: 'running',
      decisions: { total: 1, accuracy: null },
      handshakes: { initiated: 1, successRate: 0 },
      metaAgents: [{ agentName: 'partial-agent', calibrationScore: null, successRate: null }],
    });
    // T19 added effectChecks/recordKinds sections — the entry line is found
    // by content, not position.
    expect(lines.some(l => l.includes('partial-agent'))).toBe(true);
    expect(lines.some(l => l.includes('strong: — | weak: — | must-escalate: —'))).toBe(true);
    expect(lines.some(l => l.includes('(boundary/trust missing when'))).toBe(true);
  });

  test('one block missing renders that side as — (pre-R5 server / rebuilt report)', () => {
    const lines = render({
      simId: 'sim-old',
      source: 'disk',
      state: 'stopped',
      decisions: { total: 4, accuracy: 0.5 },
    });
    expect(lines[2]).toContain('decisions: 4 (accuracy 50%)');
    expect(lines[2]).toContain('handshakes: — (no handshakes data in this report)');
  });

  test('both blocks missing prints the single honest empty line', () => {
    const lines = render({ simId: 'sim-empty' });
    expect(lines[2]).toBe('decisions/handshakes: — (this report carries no metrics data)');
  });

  test('degenerate inputs — null report, null entries, non-array metaAgents — never throw', () => {
    expect(() => render(null)).not.toThrow();
    expect(() => render(undefined)).not.toThrow();
    expect(() => render({ metaAgents: [null, 42, 'x'] })).not.toThrow();
    const lines = render({ metaAgents: [null, 42] });
    expect(lines.some(l => l === 'metacognition (per agent):')).toBe(true);
    expect(lines.some(l => l.includes('—: calibration — | success — · 评估 —/—'))).toBe(true);
  });

  test('NaN/Infinity rates render as — not NaN%', () => {
    const lines = render({
      decisions: { total: 1, accuracy: NaN },
      handshakes: { initiated: Number.POSITIVE_INFINITY, successRate: null },
    });
    expect(lines[2]).toContain('accuracy —');
    expect(lines[2]).toContain('handshakes: — (—)');
  });
});

// ============================================================================
// T40f (R4, u4-P1-1): the eval human face declares its WINDOWS — decisions
// (report window) vs metacognition (all history) must be readable as two
// different sources, and each metaAgents row carries the T29 markers
// ([全历史]/[本窗口]/（样本量小）) the JSON face already carries. Wording is
// quoted from the report's own methodology — no third formulation.
// ============================================================================

describe('renderEvalReportHuman scope + window markers (T40f, R4)', () => {
  test('u4 shape: decisions 28 (61%) beside metacognition 13% (8/19) — the human face names both windows', () => {
    const lines = render({
      simId: 'sim-u4',
      scenarioId: 'campus',
      source: 'live',
      state: 'running',
      decisions: { total: 28, accuracy: 0.61 },
      handshakes: { initiated: 6, successRate: 0.5 },
      metaAgents: [
        {
          agentName: 'hvac-keeper',
          calibrationScore: 0.8,
          successRate: 0.13,
          evaluatedDecisions: 8,
          decisionCount: 19,
          window: 'all-history',
          windowDecisionCount: 2,
          capabilityBoundary: { strong: ['hvac-control'], weak: [], mustEscalate: [] },
        },
      ],
      methodology: ['decisions: …', 'metaAgents: …', 'reputation: …', 'handshakes.failures: …'],
    });
    // The scope line sits in the header, verbatim from the JSON methodology.
    expect(lines[1]).toContain('decisions=本报告窗口');
    expect(lines[1]).toContain('metacognition=跨仿真全历史——不同源不可相加');
    expect(lines[1]).toContain('样本量小');
    expect(lines[1]).toContain('methodology，共 4 条');
    // The all-history row carries its marker + the report-window count.
    const row = lines.find(l => l.includes('hvac-keeper'))!;
    expect(row).toContain('[全历史]');
    expect(row).toContain('success 13%');
    expect(row).toContain('· 评估 8/19');
    expect(row).not.toContain('(8/19 evaluated'); // T66e: no success-split misreading
    expect(row).toContain('本窗口决策 2 条');
  });

  test('a synthesized report-window row shows [本窗口]; a small-sample rate carries （样本量小）', () => {
    const lines = render({
      simId: 'sim-u4b',
      decisions: { total: 2, accuracy: 1 },
      metaAgents: [
        {
          agentName: 'smoke-warden',
          calibrationScore: null,
          successRate: 1,
          evaluatedDecisions: 2,
          decisionCount: 2,
          window: 'report-window',
          smallSample: true,
          capabilityBoundary: { strong: [], weak: [], mustEscalate: [] },
        },
      ],
    });
    const row = lines.find(l => l.includes('smoke-warden'))!;
    expect(row).toContain('[本窗口]');
    expect(row).toContain('· 评估 2/2（样本量小）');
  });

  test('pre-T29 rows without window fields render byte-identically (no invented markers)', () => {
    const lines = render({
      simId: 'sim-old',
      decisions: { total: 12, accuracy: 0.75 },
      metaAgents: [
        {
          agentName: 'hvac-keeper',
          calibrationScore: 0.8,
          evaluatedDecisions: 8,
          decisionCount: 12,
          successRate: 0.75,
          capabilityBoundary: { strong: ['hvac-control'], weak: [], mustEscalate: ['fire-response'] },
        },
      ],
    });
    const row = lines.find(l => l.includes('hvac-keeper'))!;
    expect(row).toContain('hvac-keeper: calibration 80% | success 75% · 评估 8/12');
    expect(row).not.toContain('[全历史]');
    expect(row).not.toContain('[本窗口]');
    expect(row).not.toContain('样本量小');
  });
});
