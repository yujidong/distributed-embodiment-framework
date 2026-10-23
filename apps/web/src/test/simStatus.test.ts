/**
 * W7 status header derivation: running-quiet vs waiting-for-event vs
 * stream-down vs created guidance chips, activity-age bucketing, sim-time
 * formatting, and the next-scheduled-event lookup.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../i18n/config';
import {
  activityToneOf,
  deriveSimStatus,
  formatSimTime,
  nextScheduledEventSec,
  type SimStatusInput,
} from '../lib/simStatus';

// guidanceOf() reads the active i18next bundle at call time; pin to en-US so
// guidance-chip text assertions can be exact strings.
beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

const NOW = 1_000_000_000;

function input(overrides: Partial<SimStatusInput> = {}): SimStatusInput {
  return {
    state: 'running',
    simTimeSec: 30,
    streamStatus: 'open',
    lastActivityAt: NOW - 5_000,
    nextScheduledAtSec: null,
    consoleOpenedAt: NOW - 60_000,
    now: NOW,
    ...overrides,
  };
}

describe('deriveSimStatus guidance chips', () => {
  it('running with recent activity shows no guidance chip', () => {
    const status = deriveSimStatus(input());
    expect(status.guidance).toBeNull();
    expect(status.activityAgeSec).toBe(5);
    expect(status.activityTone).toBe('fresh');
  });

  it('created state prompts to start', () => {
    const status = deriveSimStatus(input({ state: 'created', lastActivityAt: null }));
    expect(status.guidance).toEqual({ tone: 'info', text: 'Click Start to begin the simulation' });
  });

  it('stream down overrides every other state', () => {
    const status = deriveSimStatus(input({ streamStatus: 'down' }));
    expect(status.guidance).toEqual({
      tone: 'danger',
      text: 'Event stream lost (snapshots still refresh every 1.5s)',
    });
    // …including created.
    expect(deriveSimStatus(input({ streamStatus: 'down', state: 'created' })).guidance?.tone).toBe(
      'danger',
    );
  });

  it('running quiet >15s with a pending scheduled event explains the wait', () => {
    const status = deriveSimStatus(
      input({ lastActivityAt: NOW - 20_000, nextScheduledAtSec: 120, simTimeSec: 30 }),
    );
    expect(status.guidance).toEqual({
      tone: 'info',
      text: 'Running, waiting for a scenario event: next at t=120s (~90s to go)',
    });
  });

  it('running quiet >15s with nothing pending suggests injecting an event', () => {
    const status = deriveSimStatus(input({ lastActivityAt: NOW - 20_000 }));
    expect(status.guidance).toEqual({
      tone: 'warn',
      text: 'Running, no activity — inject an event from the right panel',
    });
  });

  it('running quiet exactly at/below 15s stays silent (no premature warning)', () => {
    expect(deriveSimStatus(input({ lastActivityAt: NOW - 15_000 })).guidance).toBeNull();
    expect(deriveSimStatus(input({ lastActivityAt: NOW - 15_001 })).guidance).not.toBeNull();
  });

  it('no activity yet: the quiet period is measured from console open', () => {
    // Fresh console (5s): grace period, no chip, and no fake "0s ago" age.
    const fresh = deriveSimStatus(input({ lastActivityAt: null, consoleOpenedAt: NOW - 5_000 }));
    expect(fresh.guidance).toBeNull();
    expect(fresh.activityAgeSec).toBeNull();
    // Console open 20s without a single event: quiet guidance kicks in.
    const quiet = deriveSimStatus(input({ lastActivityAt: null, consoleOpenedAt: NOW - 20_000 }));
    expect(quiet.guidance?.tone).toBe('warn');
  });

  it('paused/stopped states have no guidance chip', () => {
    expect(deriveSimStatus(input({ state: 'paused', lastActivityAt: NOW - 120_000 })).guidance).toBeNull();
    expect(deriveSimStatus(input({ state: 'stopped', lastActivityAt: NOW - 120_000 })).guidance).toBeNull();
  });
});

describe('activityToneOf bucketing', () => {
  it('green <10s, amber <60s, red beyond', () => {
    expect(activityToneOf(0)).toBe('fresh');
    expect(activityToneOf(9.9)).toBe('fresh');
    expect(activityToneOf(10)).toBe('stale');
    expect(activityToneOf(59.9)).toBe('stale');
    expect(activityToneOf(60)).toBe('quiet');
    expect(activityToneOf(3600)).toBe('quiet');
  });
});

describe('formatSimTime', () => {
  it('mm:ss under an hour, hh:mm:ss beyond', () => {
    expect(formatSimTime(0)).toBe('00:00');
    expect(formatSimTime(5)).toBe('00:05');
    expect(formatSimTime(65)).toBe('01:05');
    expect(formatSimTime(599)).toBe('09:59');
    expect(formatSimTime(3600)).toBe('01:00:00');
    expect(formatSimTime(3661)).toBe('01:01:01');
  });

  it('floors fractions and clamps negatives', () => {
    expect(formatSimTime(65.9)).toBe('01:05');
    expect(formatSimTime(-3)).toBe('00:00');
  });
});

describe('nextScheduledEventSec', () => {
  const events = [
    { id: 'e1', type: 'temperature-spike', zoneId: 'z1', atSimTimeSec: 20, fired: true },
    { id: 'e2', type: 'temperature-spike', zoneId: 'z1', atSimTimeSec: 120, fired: false },
    { id: 'e3', type: 'smoke', zoneId: 'z2', atSimTimeSec: 90, fired: false },
    { id: 'e4', type: 'manual', zoneId: 'z2', fired: false }, // no atSimTimeSec
  ];

  it('picks the earliest unfired event strictly ahead of simTime', () => {
    expect(nextScheduledEventSec(events, 30)).toBe(90);
  });

  it('ignores fired and already-due events', () => {
    expect(nextScheduledEventSec(events, 10)).toBe(90); // e1 fired, e4 untimed
    expect(nextScheduledEventSec(events, 90)).toBe(120); // e3 due now is not ahead
    expect(nextScheduledEventSec(events, 120)).toBeNull();
  });
});
