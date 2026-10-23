/**
 * R2-UX-14: HH:MM ↔ sec-of-day helpers behind the flow trigger's clock
 * inputs (lib/timeOfDay.ts).
 */

import { describe, expect, it } from 'vitest';

import { hhmmToSecOfDay, secOfDayToHhmm } from '../lib/timeOfDay';

describe('timeOfDay helpers', () => {
  it('formats sec-of-day as HH:MM', () => {
    expect(secOfDayToHhmm(0)).toBe('00:00');
    expect(secOfDayToHhmm(84600)).toBe('23:30');
    expect(secOfDayToHhmm(3661)).toBe('01:01'); // sub-minute precision dropped
  });

  it('clamps out-of-range input into [0, 86400)', () => {
    expect(secOfDayToHhmm(86400)).toBe('00:00');
    expect(secOfDayToHhmm(-60)).toBe('23:59');
  });

  it('parses HH:MM back to sec-of-day', () => {
    expect(hhmmToSecOfDay('00:00')).toBe(0);
    expect(hhmmToSecOfDay('23:30')).toBe(84600);
    expect(hhmmToSecOfDay('8:05')).toBe(8 * 3600 + 5 * 60);
  });

  it('rejects non-clock text and out-of-range components', () => {
    expect(hhmmToSecOfDay('')).toBeUndefined();
    expect(hhmmToSecOfDay('24:00')).toBeUndefined();
    expect(hhmmToSecOfDay('12:60')).toBeUndefined();
    expect(hhmmToSecOfDay('abc')).toBeUndefined();
  });

  it('round-trips every minute of the day', () => {
    for (const sec of [0, 540, 84600, 86340]) {
      expect(hhmmToSecOfDay(secOfDayToHhmm(sec))).toBe(sec);
    }
  });
});
