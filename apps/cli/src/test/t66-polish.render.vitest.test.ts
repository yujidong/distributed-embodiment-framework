/**
 * T66 (R6) — the human-reading polish pack, render-lane assertions.
 * (b) full-precision readings round on the human face; (e) the eval row's
 * counts stop reading like a success split.
 */

import { describe, expect, test } from 'vitest';

import { formatReading } from '../commands/agreement.js';

describe('T66b: formatReading rounds the human face, JSON keeps full precision', () => {
  test('a 24.363222… °C reading renders 24.36', () => {
    expect(formatReading(24.36322227)).toBe('24.36');
  });

  test('integers stay bare (no fake decimals), negatives keep the sign', () => {
    expect(formatReading(500)).toBe('500');
    expect(formatReading(-2.129)).toBe('-2.13');
  });
});
