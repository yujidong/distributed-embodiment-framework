/**
 * FEAT-07 — the `eaf env set-occupant-schedule` human render lane. Pure
 * render fixtures — no server boot (T22 discipline: every output change
 * ships with a render-lane assertion). The fixture shape mirrors the
 * server's real response
 * (`PATCH /api/environments/:id/zones/:zoneId/occupant-schedule` →
 * `{envId, zoneId, occupantSchedule, cleared, appliedRuntimes}`).
 */

import { describe, expect, test } from 'vitest';

import { renderOccupantScheduleLines, type OccupantSchedulePatchResult } from '../commands/env.js';

describe('renderOccupantScheduleLines (FEAT-07)', () => {
  test('install/update face: schedule + live-push note (R102: human carries what --json carries)', () => {
    const lines = renderOccupantScheduleLines({
      envId: 'env-1',
      zoneId: 'library',
      occupantSchedule: { count: 40, startSimTimeSec: 28800, endSimTimeSec: 64800 },
      cleared: false,
      appliedRuntimes: 1,
    });
    const text = lines.join('\n');
    expect(text).toContain('library');
    expect(text).toContain('40 people');
    expect(text).toContain('28800s → 64800s');
    expect(text).toContain('(daily)');
    expect(text).toContain('applied to 1 live runtime(s)');
  });

  test('one-shot + no-live-session face: honest "stored only" note', () => {
    const lines = renderOccupantScheduleLines({
      envId: 'env-1',
      zoneId: 'library',
      occupantSchedule: { count: 12, startSimTimeSec: 0, endSimTimeSec: 3600, repeatDaily: false },
      cleared: false,
      appliedRuntimes: 0,
    });
    const text = lines.join('\n');
    expect(text).toContain('(one-shot)');
    expect(text).toContain('no live world session — stored');
  });

  test('cleared face: says the headcount is untouched, never fabricates a schedule', () => {
    const payload: OccupantSchedulePatchResult = {
      envId: 'env-1',
      zoneId: 'library',
      occupantSchedule: null,
      cleared: true,
      appliedRuntimes: 2,
    };
    const text = renderOccupantScheduleLines(payload).join('\n');
    expect(text).toContain('cleared');
    expect(text).toContain('current headcount untouched');
    expect(text).not.toContain('people');
    expect(text).toContain('applied to 2 live runtime(s)');
  });

  // FEAT-07 phase-2 (calendar overlay) — the human face carries the overlay
  // fields exactly as --json does (R102).

  test('overlay install face: overlay schedule + absolute window, base line kept', () => {
    const lines = renderOccupantScheduleLines({
      envId: 'env-1',
      zoneId: 'library',
      occupantSchedule: { count: 40, startSimTimeSec: 28800, endSimTimeSec: 82800 },
      occupantScheduleOverlay: {
        schedule: { count: 60, startSimTimeSec: 21600, endSimTimeSec: 86400 },
        startsAtSimSec: 86400,
        endsAtSimSec: 691200,
      },
      cleared: false,
      overlayCleared: false,
      appliedRuntimes: 1,
    });
    const text = lines.join('\n');
    expect(text).toContain('40 people 28800s → 82800s');
    expect(text).toContain('overlay — 60 people 21600s → 86400s (daily), window [86400s, 691200s)');
    expect(text).toContain('applied to 1 live runtime(s)');
  });

  test('overlay-only install on a baseless zone: honest "no base schedule" + overlay line', () => {
    const text = renderOccupantScheduleLines({
      envId: 'env-1',
      zoneId: 'library',
      occupantSchedule: null,
      occupantScheduleOverlay: {
        schedule: { count: 12, startSimTimeSec: 0, endSimTimeSec: 86400 },
        startsAtSimSec: 0,
        endsAtSimSec: 604800,
      },
      cleared: false,
      overlayCleared: false,
      appliedRuntimes: 0,
    }).join('\n');
    expect(text).toContain('no base occupant schedule (unchanged)');
    expect(text).toContain('overlay — 12 people 0s → 86400s (daily), window [0s, 604800s)');
    expect(text).not.toContain('current headcount untouched');
  });

  test('overlay cleared face: says the base schedule governs again', () => {
    const text = renderOccupantScheduleLines({
      envId: 'env-1',
      zoneId: 'library',
      occupantSchedule: { count: 40, startSimTimeSec: 28800, endSimTimeSec: 82800 },
      occupantScheduleOverlay: null,
      cleared: false,
      overlayCleared: true,
      appliedRuntimes: 1,
    }).join('\n');
    expect(text).toContain('overlay cleared — the base schedule governs again immediately');
    expect(text).not.toContain('window [');
  });
});
