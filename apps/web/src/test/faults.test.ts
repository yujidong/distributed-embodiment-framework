/**
 * Fault helpers (P3d): form-state → FaultProfile serialization and
 * profile → badge derivation, plus the event-log fault summary line.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { SystemEventDto } from '../api/types';
import i18n from '../i18n/config';
import { summarizeEvent } from '../lib/eventLog';
import {
  EMPTY_FAULT_FORM,
  faultBadges,
  serializeFaultForm,
  summarizeFaultProfile,
} from '../lib/faults';

// faultBadges / summarizeFaultProfile read the active i18next bundle; pin to
// en-US so assertions are exact strings.
beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

describe('serializeFaultForm', () => {
  it('returns null when nothing is enabled (no fault to inject)', () => {
    expect(serializeFaultForm(EMPTY_FAULT_FORM)).toBeNull();
    expect(
      serializeFaultForm({ ...EMPTY_FAULT_FORM, failureRatePct: 0, latencyMsText: '0' }),
    ).toBeNull();
  });

  it('serializes the offline toggle', () => {
    expect(serializeFaultForm({ ...EMPTY_FAULT_FORM, offline: true })).toEqual({ offline: true });
  });

  it('maps the failure-rate slider percent onto 0-1', () => {
    expect(serializeFaultForm({ ...EMPTY_FAULT_FORM, failureRatePct: 30 })).toEqual({
      failureRate: 0.3,
    });
  });

  it('serializes latency only when positive and validates the text', () => {
    expect(serializeFaultForm({ ...EMPTY_FAULT_FORM, latencyMsText: '500' })).toEqual({
      latencyMs: 500,
    });
    // Not a number / negative → invalid (null), even with other fields unset.
    expect(serializeFaultForm({ ...EMPTY_FAULT_FORM, latencyMsText: 'abc' })).toBeNull();
    expect(serializeFaultForm({ ...EMPTY_FAULT_FORM, latencyMsText: '-5' })).toBeNull();
    // Whitespace-only = disabled.
    expect(serializeFaultForm({ ...EMPTY_FAULT_FORM, latencyMsText: '   ' })).toBeNull();
  });

  it('combines all four fault modes', () => {
    expect(
      serializeFaultForm({
        offline: true,
        failureRatePct: 25,
        latencyMsText: '250',
        staleState: true,
      }),
    ).toEqual({ offline: true, failureRate: 0.25, latencyMs: 250, staleState: true });
  });
});

describe('faultBadges / summarizeFaultProfile', () => {
  it('derives one badge per active mode', () => {
    expect(
      faultBadges({ offline: true, failureRate: 0.3, latencyMs: 500, staleState: true }),
    ).toEqual([
      { key: 'offline', label: 'Offline' },
      { key: 'failureRate', label: 'Intermittent 30%' },
      { key: 'latencyMs', label: 'Latency 500ms' },
      { key: 'staleState', label: 'Stale state' },
    ]);
  });

  it('omits zero-valued modes and rounds percentages', () => {
    expect(faultBadges({ failureRate: 0, latencyMs: 0 })).toEqual([]);
    expect(faultBadges({ failureRate: 0.333 })).toEqual([
      { key: 'failureRate', label: 'Intermittent 33%' },
    ]);
  });

  it('summarizes profiles (null → No fault)', () => {
    expect(summarizeFaultProfile(null)).toBe('No fault');
    expect(summarizeFaultProfile({})).toBe('No fault');
    expect(summarizeFaultProfile({ offline: true, latencyMs: 100 })).toBe('Offline · Latency 100ms');
  });
});

describe('event log fault summary', () => {
  function event(type: string, payload?: unknown): SystemEventDto {
    return { id: `evt-${type}`, type, source: 'test', payload };
  }

  it('narrates fault injection and clearing', () => {
    expect(
      summarizeEvent(
        event('device.fault_changed', {
          deviceId: 'hvac-b',
          profile: { offline: true, failureRate: 0.3, latencyMs: 500, staleState: true },
        }),
      ),
    ).toBe('Fault injected hvac-b: offline · intermittent 30% · latency 500ms · stale state');

    expect(
      summarizeEvent(event('device.fault_changed', { deviceId: 'hvac-b', profile: null })),
    ).toBe('Fault cleared hvac-b');
  });
});
