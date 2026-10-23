/**
 * T52 (R6, u1-F6) — the `eaf sim list --env` roster render lane. Pure render
 * fixtures — no server boot (T22 discipline: every output change ships with
 * a render-lane assertion).
 */

import { describe, expect, test } from 'vitest';

import { renderSimListHumanLines, type SimListRow } from '../commands/sim.js';

const ROWS: SimListRow[] = [
  {
    id: 'sim-campus-1',
    state: 'running',
    simTimeSec: 3600,
    llm: 'llm',
    createdBy: 'user-9f2a',
    creatorName: '陈功',
  },
  {
    id: 'sim-campus-2',
    state: 'stopped',
    simTimeSec: 725,
    llm: 'rule-only',
    createdBy: 'user-11bb',
    creatorName: '林曦',
  },
  {
    id: 'sim-campus-env-world-session',
    state: 'hibernated',
    simTimeSec: 90,
    llm: 'rule-only',
    platformOwned: true,
    // T82 (R9, u3-F1): the server marks the authoritative session row by
    // TYPE — the roster renders ` [world-session]` and creator=platform.
    kind: 'world-session',
  },
];

describe('renderSimListHumanLines (T52, R6 u1-F6)', () => {
  test('one line per sim with id / state / simTime / creator / llm — dead sims included', () => {
    const lines = renderSimListHumanLines(ROWS);
    expect(lines[0]).toContain('3 simulation(s)');
    expect(lines[0]).toContain('stopped/hibernated included');
    expect(lines[1]).toContain('sim-campus-1');
    expect(lines[1]).toContain('state=running');
    expect(lines[1]).toContain('simTime=3600s');
    expect(lines[1]).toContain('creator=陈功');
    expect(lines[1]).toContain('llm=llm');
    // A STOPPED row renders as itself — the roster must show the dead sims
    // to explain the live ones (u1's blind `sim status` probing).
    expect(lines[2]).toContain('sim-campus-2');
    expect(lines[2]).toContain('state=stopped');
    expect(lines[2]).toContain('creator=林曦');
  });

  test('the world session row is marked by TYPE ([world-session], creator=platform) — never "creator=unknown"', () => {
    const lines = renderSimListHumanLines(ROWS);
    expect(lines[3]).toContain('sim-campus-env-world-session');
    expect(lines[3]).toContain('state=hibernated');
    // T82 (R9, u3-F1): the authoritative session is named for WHAT it is —
    // the same "platform world-session" wording the AGENT_AMBIGUOUS
    // candidates use — instead of a mystery "created by unknown [platform]".
    expect(lines[3]).toContain('[world-session]');
    expect(lines[3]).toContain('creator=platform');
    expect(lines[3]).not.toContain('creator=unknown');
    expect(lines[3]).not.toContain('[platform]');
  });

  test('T82: a platformOwned row WITHOUT the kind marker still renders [platform] (legacy tolerance)', () => {
    const lines = renderSimListHumanLines([
      { id: 'sim-legacy', state: 'running', simTimeSec: 1, llm: 'rule-only', platformOwned: true },
    ]);
    expect(lines[1]).toContain('[platform]');
    expect(lines[1]).toContain('creator=unknown');
  });

  test('T79 hygiene: a fractional sim-time renders at 2-decimal display precision, never raw 3+ decimals', () => {
    const lines = renderSimListHumanLines([
      { id: 'sim-fresh', state: 'running', simTimeSec: 2.179, llm: 'rule-only', createdBy: 'u', creatorName: 'W' },
    ]);
    expect(lines[1]).toContain('simTime=2.18s');
    expect(lines[1]).not.toContain('2.179');
  });

  test('the empty roster teaches the create command instead of printing an empty table', () => {
    const lines = renderSimListHumanLines([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no simulations');
    expect(lines[0]).toContain('eaf sim create --env');
  });
});
