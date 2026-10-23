/**
 * DOC-02 — `sim start` / `sim resume` human-mode speed echo. The payload's
 * pace face (speed sim-s/tick + nominalSpeedPerSec sim-s/wall-s) must ride
 * the human line too (R102 output discipline: human never thinner than
 * --json), and a pace-less payload (pause/stop, lazy sims) must degrade to
 * the bare action line without dangling separators.
 *
 * Pure rendering fixtures — no server boot — so the file lives in the CLI
 * fast lane (same discipline as sim-status.render.vitest.test.ts).
 */

import { describe, expect, test } from 'vitest';

import { renderSimActionLine } from '../commands/sim.js';

describe('renderSimActionLine (DOC-02 speed echo)', () => {
  test('start with a pace echo renders speed sim-s/tick AND the nominal wall multiplier', () => {
    const line = renderSimActionLine(
      { id: 'sim-1', state: 'running', speed: 5, nominalSpeedPerSec: 500 },
      'start',
    );
    expect(line).toContain('running sim-1 (start)');
    expect(line).toContain('speed=5 sim-s/tick');
    expect(line).toContain('≈ 500 sim-s/wall-s');
    expect(line).toContain('nominal ×500 wall');
  });

  test('fractional rates round to one decimal (speed 0.05 ≈ ×5 wall)', () => {
    const line = renderSimActionLine(
      { id: 'sim-1', state: 'running', speed: 0.05, nominalSpeedPerSec: 5 },
      'resume',
    );
    expect(line).toContain('speed=0.05 sim-s/tick');
    expect(line).toContain('≈ 5 sim-s/wall-s');
  });

  test('no pace face (pause/stop/lazy) degrades to the bare action line — no dangling separator', () => {
    const line = renderSimActionLine({ id: 'sim-1', state: 'paused' }, 'pause');
    expect(line).toBe('paused sim-1 (pause)');
    expect(line).not.toContain('sim-s');
  });

  test('R2-BUG-04: a world-session /start echoes the real caught-up simTimeSec (human keeps pace with --json)', () => {
    const line = renderSimActionLine(
      { id: 'sim-env-1-world-session', state: 'running', speed: 1, simTimeSec: 728612 },
      'start',
    );
    expect(line).toContain('running sim-env-1-world-session (start)');
    expect(line).toContain('simTime=728612s');
  });

  test('simTimeSec absent (legacy/private sims) renders no clock segment', () => {
    const line = renderSimActionLine({ id: 'sim-1', state: 'running', speed: 1 }, 'start');
    expect(line).toBe('running sim-1 (start)');
  });
});
