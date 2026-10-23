/**
 * @vitest-environment node
 *
 * UX-11 — `eaf scenario validate` human verdict rendering. Pure fixtures
 * through the exported `renderScenarioValidation` (same discipline as
 * agreement-get.render.vitest.test.ts): the success summary line must carry
 * the entity counts + warning count (R102: same source as --json `counts`),
 * and every payload shape branch the face renders must be exercised here.
 * Registered in render-contract.render.vitest.test.ts (FACES).
 */

import { describe, expect, test } from 'vitest';

import { renderScenarioValidation, type ScenarioValidationReport } from '../commands/scenario.js';

function report(overrides: Partial<ScenarioValidationReport>): ScenarioValidationReport {
  return {
    file: 'demo.json',
    valid: true,
    counts: { zones: 2, devices: 3, agents: 4, flows: 5, events: 6 },
    errors: [],
    warnings: [],
    ...overrides,
  };
}

describe('renderScenarioValidation (UX-11 success summary)', () => {
  test('clean success keeps "no issues" AND carries the counts summary with 0 warnings', () => {
    const lines = renderScenarioValidation(report({}));
    const text = lines.join('\n');
    expect(text).toContain('✓ no issues');
    expect(text).toContain('✓ valid — 2 zones, 3 devices, 4 agents, 5 flows, 6 events; 0 warnings');
    expect(text).not.toContain('✗ ERROR');
    expect(text).not.toContain('⚠ WARN');
  });

  test('success with warnings lists them and the summary reports the warning count', () => {
    const lines = renderScenarioValidation(report({
      warnings: [
        { level: 'warning', category: 'meta-reference', message: 'meta.heroEventId "evt-x" does not match any of the 6 declared events' },
        { level: 'warning', category: 'acRationale', message: 'event "evt-1" has no acRationale' },
      ],
    }));
    const text = lines.join('\n');
    expect(text).toContain('⚠ WARN  [meta-reference] meta.heroEventId "evt-x"');
    expect(text).toContain('✓ valid — 2 zones, 3 devices, 4 agents, 5 flows, 6 events; 2 warnings');
    expect(text).toContain('0 errors, 2 warnings');
    expect(text).not.toContain('✓ no issues');
  });

  test('failure renders every error with ✗ and the totals footer, never the success summary', () => {
    const lines = renderScenarioValidation(report({
      valid: false,
      errors: [
        { level: 'error', category: 'orphan-event', message: 'event "evt-1" requiredCapabilities ["x"] match no agent\'s capabilities' },
      ],
      warnings: [
        { level: 'warning', category: 'meta-reference', message: 'meta.recommendedPlaybackRate 0 is not a finite positive number' },
      ],
    }));
    const text = lines.join('\n');
    expect(text).toContain('✗ ERROR [orphan-event] event "evt-1"');
    expect(text).toContain('⚠ WARN  [meta-reference] meta.recommendedPlaybackRate 0');
    expect(text).toContain('1 error, 1 warning');
    expect(text).not.toContain('✓ valid');
    expect(text).not.toContain('✓ no issues');
  });

  test('schema-load failure has no counts — issues still render (never a bare null)', () => {
    const lines = renderScenarioValidation(report({
      valid: false,
      counts: undefined,
      errors: [{ level: 'error', category: 'schema', message: 'zones: required' }],
    }));
    const text = lines.join('\n');
    expect(text).toContain('✗ ERROR [schema] zones: required');
    expect(text).toContain('1 error, 0 warnings');
    expect(text).not.toContain('undefined');
  });
});
