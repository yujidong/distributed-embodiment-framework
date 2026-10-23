/**
 * R78-B guard — the quota-badge pure layer: label math, the 90% warning
 * tone, exhaustion blocking with the teaching title, and the unknown-limit
 * rule (never block on missing data — the server 429 stays the guarantee).
 */

import { describe, expect, it } from 'vitest';

import { quotaState } from '../lib/quota';

describe('quotaState (R78-B)', () => {
  it('labels usage and stays calm under 90%', () => {
    const q = quotaState('Agent', 35, 40);
    expect(q.label).toBe('35/40');
    expect(q.nearLimit).toBe(false);
    expect(q.exhausted).toBe(false);
    expect(q.title).toBeNull();
  });

  it('warns at >=90% and blocks at 100% with the teaching title', () => {
    expect(quotaState('Agent', 36, 40).nearLimit).toBe(true);
    const full = quotaState('Agent', 40, 40);
    expect(full.exhausted).toBe(true);
    expect(full.title).toContain('Agent 配额已满（40/40）');
  });

  it('unknown limit never blocks (missing data is not a quota verdict)', () => {
    const q = quotaState('Agent', 999, undefined);
    expect(q.label).toBe('999');
    expect(q.exhausted).toBe(false);
    expect(q.title).toBeNull();
  });
});
