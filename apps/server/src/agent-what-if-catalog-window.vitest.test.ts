/**
 * T41 (R4, u1-F1) — the catalog-change-window CLASSIFIER truth table.
 *
 * During u1's demo a batch of remove-devices auto-applies overlapped the
 * what-if window: five perfectly worded questions died in the unmapped
 * teaching 400 ("reword your question") while the directory was mid-churn.
 * The fix classifies BEFORE the 400: a question that literally names a
 * device the DB still has while the parse views lack it (or empty views on
 * a non-empty DB — the rehydration shape) is a 503 WORLD_CATALOG_CHANGING,
 * never a wording lesson. These are PURE fixtures over
 * `diagnoseCatalogChangingWindow` (apps/server/src/routes/agent-nl.ts) —
 * no app boot. The route-level healthy-window behavior (the teaching 400
 * unchanged, byte for byte) is guarded by the existing anchors in
 * agent-what-if.vitest.test.ts (R83/T25 unmapped cases), which exercise the
 * same wire-in on a calm world where the classifier must never fire.
 */

import { describe, expect, test } from 'vitest';

import { diagnoseCatalogChangingWindow } from './routes/agent-nl.js';

const DB = [
  { id: 'bldg-d-hvac', name: 'D栋（AI与物联网·图书馆） 空调机组', type: 'hvac' },
  { id: 'bldg-m-hvac', name: 'M栋（多功能厅） 空调机组', type: 'hvac' },
];

const VIEWS = [
  { deviceId: 'bldg-d-hvac', name: 'D栋（AI与物联网·图书馆） 空调机组', type: 'hvac' },
  { deviceId: 'bldg-m-hvac', name: 'M栋（多功能厅） 空调机组', type: 'hvac' },
];

describe('diagnoseCatalogChangingWindow (T41): honest 503 vs honest teaching', () => {
  test('DB hit + views miss → catalog window (the u1 shape: name mention)', () => {
    const text = 'D栋（AI与物联网·图书馆） 空调机组 调到 26 度会怎样';
    expect(diagnoseCatalogChangingWindow(text, [VIEWS[1]], DB)).toBe(true);
  });

  test('DB hit + views miss → catalog window (id mention works too)', () => {
    expect(diagnoseCatalogChangingWindow('what if bldg-d-hvac fails?', [VIEWS[1]], DB)).toBe(true);
  });

  test('empty parse views on a non-empty DB → the rehydration-window shape', () => {
    expect(diagnoseCatalogChangingWindow('空调机组 调到 26 度会怎样', [], DB)).toBe(true);
  });

  test('views carry the named device → NOT a window (a mapping question, taught honestly)', () => {
    const text = 'D栋（AI与物联网·图书馆） 空调机组 调到 26 度会怎样';
    expect(diagnoseCatalogChangingWindow(text, VIEWS, DB)).toBe(false);
  });

  test('the DB has no such device → NOT a window (a genuine wording problem stays the teaching 400)', () => {
    const text = 'E栋 空调机组 调到 26 度会怎样';
    expect(diagnoseCatalogChangingWindow(text, [VIEWS[0]], DB)).toBe(false);
  });

  test('no device named at all → NOT a window', () => {
    expect(diagnoseCatalogChangingWindow('如果明天下雨会怎样', [VIEWS[0]], DB)).toBe(false);
  });

  test('no DB rows (file-scenario record) → never classified (nothing to be mid-change about)', () => {
    expect(diagnoseCatalogChangingWindow('空调机组 调到 26 度会怎样', [], [])).toBe(false);
    expect(diagnoseCatalogChangingWindow('空调机组 调到 26 度会怎样', VIEWS, [])).toBe(false);
  });

  test('folded matching tolerates punctuation/case the way the parser does (one normalization shape)', () => {
    // bldg_d_hvac folds to the same token as the id (dash/underscore/case
    // stripped) — a mention is a mention however it was spelled.
    expect(
      diagnoseCatalogChangingWindow(
        'what if bldg_d_hvac fails?',
        [VIEWS[1]],
        DB,
      ),
    ).toBe(true);
  });
});
