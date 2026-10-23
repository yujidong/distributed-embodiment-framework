/**
 * FEAT-07: zone-detail occupantSchedule display helpers.
 * - simDayClock renders sim-day seconds as HH:MM (28800 → "08:00");
 * - FEAT-07 phase-2: simAbsDayClock renders absolute sim seconds as
 *   "D<day> HH:MM" (the overlay window), occupantOverlayStatus derives the
 *   overlay's active/pending/expired status against the world clock;
 * - the zoneDetail i18n keys exist in BOTH locales (a missing key would
 *   render the raw key on the zone detail row).
 */

import { describe, expect, it } from 'vitest';

import { occupantOverlayStatus, simAbsDayClock, simDayClock } from '../lib/zoneForm';
import { zhCN } from '../i18n/zh-CN';
import { enUS } from '../i18n/en-US';

describe('simDayClock (FEAT-07)', () => {
  it('renders sim-day seconds as HH:MM', () => {
    expect(simDayClock(0)).toBe('00:00');
    expect(simDayClock(28800)).toBe('08:00');
    expect(simDayClock(64800)).toBe('18:00');
    expect(simDayClock(28740)).toBe('07:59');
  });
});

describe('simAbsDayClock (FEAT-07 phase-2)', () => {
  it('renders absolute sim seconds as D<day> HH:MM', () => {
    expect(simAbsDayClock(0)).toBe('D0 00:00');
    expect(simAbsDayClock(28800)).toBe('D0 08:00');
    expect(simAbsDayClock(86400)).toBe('D1 00:00');
    expect(simAbsDayClock(7 * 86400 - 1)).toBe('D6 23:59');
  });
});

describe('occupantOverlayStatus (FEAT-07 phase-2)', () => {
  const overlay = { startsAtSimSec: 86400, endsAtSimSec: 691200 };
  it('pending before the window, active inside [start, end), expired at/after the end', () => {
    expect(occupantOverlayStatus(overlay, 0)).toBe('pending');
    expect(occupantOverlayStatus(overlay, 86399)).toBe('pending');
    expect(occupantOverlayStatus(overlay, 86400)).toBe('active');
    expect(occupantOverlayStatus(overlay, 691199)).toBe('active');
    expect(occupantOverlayStatus(overlay, 691200)).toBe('expired');
  });
  it('no live clock → undefined (the row makes no status claim)', () => {
    expect(occupantOverlayStatus(overlay, undefined)).toBeUndefined();
  });
});

describe('zoneDetail occupantSchedule i18n (FEAT-07)', () => {
  const KEYS = [
    'occupantSchedule',
    'occupantScheduleValue',
    'occupantScheduleDaily',
    'occupantScheduleOneShot',
    // FEAT-07 phase-2 (calendar overlay).
    'occupantScheduleOverlay',
    'occupantScheduleOverlayValue',
    'occupantOverlayActive',
    'occupantOverlayPending',
    'occupantOverlayExpired',
  ] as const;

  it('both locales carry every key', () => {
    const zh = zhCN.world.zoneDetail as Record<string, unknown>;
    const en = enUS.world.zoneDetail as Record<string, unknown>;
    for (const key of KEYS) {
      expect(typeof zh[key], `zh-CN zoneDetail.${key}`).toBe('string');
      expect(typeof en[key], `en-US zoneDetail.${key}`).toBe('string');
    }
  });
});
