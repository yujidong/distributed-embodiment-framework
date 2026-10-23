/**
 * Unit tests for the pure logic of the AC-decision dataset dump
 * (scripts/dataset-dump-lib.ts): binary label mapping, template reasoning
 * per interaction type, split determinism, and JSONL record schema.
 */

import { describe, it, expect } from 'vitest';

import {
  buildCompletion,
  buildReasoning,
  buildRecord,
  mapDecisionToLabel,
  mulberry32,
  splitEventIds,
  validateRecord,
} from './dataset-dump-lib.js';

// ---------------------------------------------------------------------------
// Label mapping
// ---------------------------------------------------------------------------

describe('mapDecisionToLabel', () => {
  it('maps initiate_ac to collaborate', () => {
    expect(mapDecisionToLabel('initiate_ac')).toBe('collaborate');
  });

  it('maps handle_independently, defer and ignore to independent', () => {
    expect(mapDecisionToLabel('handle_independently')).toBe('independent');
    expect(mapDecisionToLabel('defer')).toBe('independent');
    expect(mapDecisionToLabel('ignore')).toBe('independent');
  });
});

// ---------------------------------------------------------------------------
// Template reasoning per interaction type
// ---------------------------------------------------------------------------

describe('buildReasoning', () => {
  const event = { severity: 'high' as const, requiredCapabilities: ['cooling'] };

  it('Type A: direct coverage, no gap → handle independently', () => {
    const r = buildReasoning(
      { type: 'A', correctDecision: 'handle_independently', gap: [], actuatorZones: ['z1'] },
      event,
    );
    expect(r).toBe('Direct coverage and no capability gap — handle independently.');
  });

  it('Type B: direct coverage with gap → collaborate, gap listed', () => {
    const r = buildReasoning(
      { type: 'B', correctDecision: 'initiate_ac', gap: ['cooling', 'hvac-control'], actuatorZones: ['z1'] },
      event,
    );
    expect(r).toBe('Direct coverage but missing [cooling, hvac-control] — need collaboration.');
  });

  it('Type C: propagation coverage → collaborate for significant events', () => {
    const r = buildReasoning(
      { type: 'C', correctDecision: 'initiate_ac', gap: ['cooling'], actuatorZones: ['z1'] },
      event,
    );
    expect(r).toBe('Propagation-only coverage and missing [cooling] — need collaboration.');
  });

  it('Type C: low-severity propagation events defer (severity mentioned)', () => {
    const r = buildReasoning(
      { type: 'C', correctDecision: 'defer', gap: ['cooling'], actuatorZones: ['z1'] },
      { severity: 'low', requiredCapabilities: ['cooling'] },
    );
    expect(r).toContain('low-severity');
    expect(r).toContain('defer');
  });

  it('Type D sensor-only: collaborate to alert capable agents', () => {
    const r = buildReasoning(
      { type: 'D', correctDecision: 'initiate_ac', gap: ['cooling'], actuatorZones: [] },
      event,
    );
    expect(r).toContain('Sensor-only');
    expect(r).toContain('collaborate');
  });

  it('Type D low-severity: ignore with severity mentioned', () => {
    const r = buildReasoning(
      { type: 'D', correctDecision: 'ignore', gap: ['cooling'], actuatorZones: ['z1'] },
      { severity: 'low', requiredCapabilities: ['cooling'] },
    );
    expect(r).toContain('low-severity');
    expect(r).toContain('ignore');
  });

  it('Type D significant with actuators: defer', () => {
    const r = buildReasoning(
      { type: 'D', correctDecision: 'defer', gap: ['cooling'], actuatorZones: ['z1'] },
      event,
    );
    expect(r).toBe('No zone coverage and missing [cooling] — defer to agents that cover the zone.');
  });

  it('Type E: no coverage but no gap → collaborate to delegate', () => {
    const r = buildReasoning(
      { type: 'E', correctDecision: 'initiate_ac', gap: [], actuatorZones: ['z1'] },
      event,
    );
    expect(r).toBe('No zone coverage but no capability gap — collaborate to delegate to an agent with zone coverage.');
  });
});

// ---------------------------------------------------------------------------
// Split determinism
// ---------------------------------------------------------------------------

describe('splitEventIds', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `evt-${i + 1}`);

  it('same seed produces the identical split', () => {
    const a = splitEventIds(ids, 0.2, 42);
    const b = splitEventIds(ids, 0.2, 42);
    expect(a).toEqual(b);
  });

  it('test size follows the rate (round(n * rate), min 1)', () => {
    expect(splitEventIds(ids, 0.2, 42).test).toHaveLength(4);
    expect(splitEventIds(ids, 0.1, 42).test).toHaveLength(2);
    expect(splitEventIds(['only-one'], 0.5, 42).test).toHaveLength(1);
  });

  it('train and test are disjoint and cover all ids', () => {
    const { train, test } = splitEventIds(ids, 0.25, 7);
    expect(new Set([...train, ...test])).toEqual(new Set(ids));
    expect(train.filter(id => test.includes(id))).toHaveLength(0);
  });

  it('rate 0 disables the split', () => {
    const { train, test } = splitEventIds(ids, 0, 42);
    expect(test).toHaveLength(0);
    expect(train).toHaveLength(ids.length);
  });

  it('different seeds produce different splits (overwhelmingly likely)', () => {
    const a = splitEventIds(ids, 0.3, 1);
    const b = splitEventIds(ids, 0.3, 2);
    expect(a.test).not.toEqual(b.test);
  });

  it('mulberry32 is deterministic', () => {
    const r1 = mulberry32(123);
    const r2 = mulberry32(123);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });
});

// ---------------------------------------------------------------------------
// JSONL record schema
// ---------------------------------------------------------------------------

describe('validateRecord', () => {
  const sample = buildRecord(
    'system prompt text',
    'user prompt text',
    buildCompletion('collaborate', 'Direct coverage but missing [cooling] — need collaboration.'),
    {
      scenario: 'apartment',
      eventId: 'evt-apt-1',
      agentId: 'climate-agent',
      type: 'B',
      correctDecision: 'initiate_ac',
      label: 'collaborate',
    },
  );

  it('accepts a well-formed record', () => {
    expect(validateRecord(sample)).toEqual([]);
  });

  it('accepts a record after a JSON round-trip (JSONL line shape)', () => {
    expect(validateRecord(JSON.parse(JSON.stringify(sample)))).toEqual([]);
  });

  it('completion parses to the production contract {decision, reasoning}', () => {
    const parsed = JSON.parse(sample.completion);
    expect(parsed).toEqual({
      decision: 'collaborate',
      reasoning: 'Direct coverage but missing [cooling] — need collaboration.',
    });
  });

  it('rejects a record whose completion is not valid JSON', () => {
    expect(validateRecord({ ...sample, completion: 'not-json' })).toContain('completion must be valid JSON');
  });

  it('rejects an out-of-contract decision value', () => {
    const bad = { ...sample, completion: JSON.stringify({ decision: 'maybe', reasoning: 'x' }) };
    expect(validateRecord(bad)).toContain('completion.decision must be "collaborate" or "independent"');
  });

  it('rejects meta.label / completion.decision mismatch', () => {
    const bad = {
      ...sample,
      meta: { ...sample.meta, label: 'independent' as const },
    };
    expect(validateRecord(bad)).toContain('meta.label must equal completion.decision');
  });

  it('rejects missing messages and bad type', () => {
    const violations = validateRecord({ completion: sample.completion, meta: { ...sample.meta, type: 'Z' } });
    expect(violations).toContain('messages must be an array of length 2');
    expect(violations).toContain('meta.type must be one of A,B,C,D,E');
  });
});
