/**
 * T94 (R14, u4-P1) — the `eaf env activity` human render lane. Pure render
 * fixtures — no server boot (T22 discipline: every output change ships with
 * a render-lane assertion).
 *
 * The u4 regression: the walker ran this face with EMPTY anchors, so a
 * human face that rendered a bare header with zero data rows could never go
 * red. These fixtures pin the row contract: one row per feed entry, header
 * vocabulary intact, engine actors / CJK / actor-less rows all render.
 * The fixture shape mirrors the server's real feed entries
 * (`GET /api/environments/:id/activity` → `{entries:[...]}`, see
 * r14-activity.json from the finding).
 */

import { describe, expect, test } from 'vitest';

import { envActivityRowsOf, ENV_ACTIVITY_COLUMNS, type EnvActivityEntry } from '../commands/env.js';

const ENTRIES: EnvActivityEntry[] = [
  {
    time: '2026-09-18T01:55:45.800Z',
    actor: { id: 'user-wang', displayName: '王盾' },
    kind: 'command',
    action: 'executed',
    summary: 'agent-nl-command: WD-值守-M栋 处理烟雾事件',
    objectType: 'agent',
    objectId: 'agent-wd-1',
  },
  {
    time: '2026-09-18T01:50:15.366Z',
    actor: { id: 'engine:sim:sim-a6a43ee5-mu6ax19a-5', displayName: '引擎(sim …mu6ax19a-5)' },
    kind: 'command',
    action: 'executed',
    summary: 'engine-device-command: A栋（四学院联合） 智能照明 set-brightness',
    objectType: 'device',
    objectId: '2231dc8e-ade3-454d-bb0c-62961c5d5904',
  },
  {
    time: '2026-09-18T01:45:00.000Z',
    actor: null, // user row gone — the dash face
    kind: 'proposal',
    action: 'applied',
    summary: 'proposal applied: 空气净化器 · 模式设置',
    objectType: 'proposal',
    objectId: '2acd55c9',
  },
];

describe('envActivityRowsOf (T94, R14 u4-P1 — the header-only regression)', () => {
  test('one row per feed entry — never a bare header', () => {
    const rows = envActivityRowsOf(ENTRIES);
    expect(rows).toHaveLength(ENTRIES.length);
    // The header vocabulary the u4 report quoted is intact — and rows exist
    // to follow it.
    expect([...ENV_ACTIVITY_COLUMNS]).toEqual(['time', 'actor', 'kind', 'action', 'summary']);
    expect(rows[0]).toEqual({
      time: '2026-09-18T01:55:45.800Z',
      actor: '王盾',
      kind: 'command',
      action: 'executed',
      summary: 'agent-nl-command: WD-值守-M栋 处理烟雾事件',
    });
  });

  test('engine actors and CJK summaries render verbatim; a missing actor renders as "-"', () => {
    const rows = envActivityRowsOf(ENTRIES);
    expect(rows[1]!.actor).toBe('引擎(sim …mu6ax19a-5)');
    expect(rows[1]!.summary).toContain('智能照明 set-brightness');
    expect(rows[2]!.actor).toBe('-');
  });

  test('empty feed → zero rows (the caller then renders the empty message, not a table)', () => {
    expect(envActivityRowsOf([])).toEqual([]);
  });
});
