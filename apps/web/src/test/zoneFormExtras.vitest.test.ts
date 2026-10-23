/**
 * UX-W2 zone form extras tests:
 * - floor / envelopeU / adjacency self-reference / room-row validation;
 * - HH:MM day-clock parsing and the occupant-schedule gate (count + 起<止);
 * - buildGridZone/buildGeoZone carry the new optional attributes and drop
 *   them when blank (untouched form → pre-W2 zone shape);
 * - zoneToFormFields round-trips a stored zone into the edit form (and
 *   zoneFormError's editingZoneId lets the unchanged id pass);
 * - mapDataWithZones appends a batch while preserving other mapData keys.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { EnvironmentDetail } from '../api/types';
import i18n from '../i18n/config';
import {
  adjacentZoneIdsError,
  buildGeoZone,
  buildGridZone,
  createZoneFormFields,
  dayClockToSimSec,
  envelopeUError,
  floorError,
  mapDataWithZones,
  mergeZoneEdits,
  roomRowsError,
  rowsToRooms,
  scheduleFormError,
  zoneFormError,
  zoneToFormFields,
  type ZoneFormFields,
} from '../lib/zoneForm';
import type { EnvZone } from '../api/types';

// lib/zoneForm reads the active i18next bundle at call time; pin to en-US.
beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

function validGridFields(overrides: Partial<ZoneFormFields> = {}): ZoneFormFields {
  return {
    ...createZoneFormFields(),
    id: 'ward-1',
    name: '一号病房',
    minX: '0',
    maxX: '6',
    minY: '0',
    maxY: '4',
    ...overrides,
  };
}

describe('floor / envelopeU validation', () => {
  it('accepts blank and integer storeys, rejects decimals and text', () => {
    expect(floorError('')).toBeNull();
    expect(floorError('0')).toBeNull();
    expect(floorError('3')).toBeNull();
    expect(floorError('-1')).toBeNull();
    expect(floorError('1.5')).toContain('integer');
    expect(floorError('abc')).toContain('integer');
  });

  it('accepts blank and non-negative numbers for envelopeU', () => {
    expect(envelopeUError('')).toBeNull();
    expect(envelopeUError('0.12')).toBeNull();
    expect(envelopeUError('-0.5')).not.toBeNull();
    expect(envelopeUError('abc')).not.toBeNull();
  });
});

describe('adjacency self-reference', () => {
  it('flags the zone referencing itself, accepts other zones', () => {
    expect(adjacentZoneIdsError(['ward-1'], 'ward-1')).not.toBeNull();
    expect(adjacentZoneIdsError(['ward-2'], 'ward-1')).toBeNull();
    expect(adjacentZoneIdsError([], 'ward-1')).toBeNull();
  });
});

describe('rooms rows', () => {
  it('drops blank rows, keeps name (+optional code)', () => {
    expect(rowsToRooms([])).toBeUndefined();
    expect(rowsToRooms([{ name: ' ', code: ' ' }])).toBeUndefined();
    expect(
      rowsToRooms([
        { name: '护士站', code: 'N-01' },
        { name: '配药间', code: '' },
        { name: ' ', code: ' ' },
      ]),
    ).toEqual([{ name: '护士站', code: 'N-01' }, { name: '配药间' }]);
  });

  it('requires a name when a code is given', () => {
    expect(roomRowsError([{ name: '', code: 'A-1' }])).not.toBeNull();
    expect(roomRowsError([{ name: '护士站', code: '' }])).toBeNull();
  });
});

describe('occupant schedule', () => {
  it('parses HH:MM day clocks', () => {
    expect(dayClockToSimSec('08:00')).toBe(28800);
    expect(dayClockToSimSec('8:30')).toBe(30600);
    expect(dayClockToSimSec('23:59')).toBe(86340);
    expect(dayClockToSimSec('24:00')).toBeNull();
    expect(dayClockToSimSec('8:60')).toBeNull();
    expect(dayClockToSimSec('morning')).toBeNull();
  });

  it('is skipped when disabled; requires count and 起<止 when enabled', () => {
    const base = {
      scheduleEnabled: false,
      scheduleCount: '',
      scheduleStart: '',
      scheduleEnd: '',
    };
    expect(scheduleFormError(base)).toBeNull();
    const enabled = { ...base, scheduleEnabled: true };
    expect(scheduleFormError(enabled)).toContain('count');
    expect(scheduleFormError({ ...enabled, scheduleCount: '1.5' })).toContain('count');
    expect(
      scheduleFormError({ ...enabled, scheduleCount: '4', scheduleStart: '08:00', scheduleEnd: 'xx' }),
    ).not.toBeNull();
    expect(
      scheduleFormError({ ...enabled, scheduleCount: '4', scheduleStart: '18:00', scheduleEnd: '08:00' }),
    ).toContain('start');
    expect(
      scheduleFormError({ ...enabled, scheduleCount: '4', scheduleStart: '08:00', scheduleEnd: '18:00' }),
    ).toBeNull();
  });
});

describe('zone builders carry the UX-W2 extras', () => {
  it('buildGridZone omits every extra key when the inputs are blank', () => {
    const zone = buildGridZone(validGridFields());
    expect(zone).toEqual({
      id: 'ward-1',
      name: '一号病房',
      bounds: { minX: 0, maxX: 6, minY: 0, maxY: 4 },
    });
  });

  it('buildGridZone includes building tier / consent / adjacency / envelopeU / rooms / schedule', () => {
    const zone = buildGridZone(
      validGridFields({
        buildingId: 'inpatient-bldg',
        floor: '3',
        consentClass: 'supervised',
        adjacentZoneIds: ['ward-2', 'nurse-station'],
        envelopeU: '0.3',
        roomRows: [{ name: '护士站', code: 'N-01' }],
        scheduleEnabled: true,
        scheduleCount: '4',
        scheduleStart: '08:00',
        scheduleEnd: '20:00',
        scheduleRepeatDaily: false,
      }),
    );
    expect(zone).toEqual({
      id: 'ward-1',
      name: '一号病房',
      bounds: { minX: 0, maxX: 6, minY: 0, maxY: 4 },
      buildingId: 'inpatient-bldg',
      floor: 3,
      consentClass: 'supervised',
      adjacentZoneIds: ['ward-2', 'nurse-station'],
      envelopeU: 0.3,
      rooms: [{ name: '护士站', code: 'N-01' }],
      occupantSchedule: {
        count: 4,
        startSimTimeSec: 28800,
        endSimTimeSec: 72000,
        repeatDaily: false,
      },
    });
  });

  it('buildGeoZone carries the extras alongside the polygon', () => {
    const polygon: [number, number][] = [
      [31.3, 120.6],
      [31.31, 120.6],
      [31.3, 120.61],
    ];
    const zone = buildGeoZone(validGridFields({ buildingId: 'b1', floor: '0' }), polygon);
    expect(zone.polygon).toEqual(polygon);
    expect(zone.buildingId).toBe('b1');
    expect(zone.floor).toBe(0);
    expect(zone.bounds).toBeUndefined();
  });
});

describe('zoneToFormFields (edit prefill)', () => {
  it('round-trips a stored zone and the unchanged id passes validation in edit mode', () => {
    const stored = buildGridZone(
      validGridFields({
        type: 'ward',
        buildingId: 'inpatient-bldg',
        floor: '3',
        consentClass: 'supervised',
        adjacentZoneIds: ['ward-2'],
        envelopeU: '0.3',
        roomRows: [{ name: '护士站', code: 'N-01' }],
        scheduleEnabled: true,
        scheduleCount: '4',
        scheduleStart: '08:00',
        scheduleEnd: '20:00',
      }),
    );
    const fields = zoneToFormFields(stored);
    expect(fields.id).toBe('ward-1');
    expect(fields.floor).toBe('3');
    expect(fields.scheduleStart).toBe('08:00');
    expect(fields.scheduleEnd).toBe('20:00');
    expect(fields.scheduleRepeatDaily).toBe(true);
    expect(fields.roomRows).toEqual([{ name: '护士站', code: 'N-01' }]);
    // Without editingZoneId the unchanged id is a duplicate; with it, valid.
    const existing = new Set(['ward-1', 'ward-2']);
    expect(zoneFormError(fields, { isGeo: false, existingZoneIds: existing })).toContain(
      'already exists',
    );
    expect(
      zoneFormError(fields, { isGeo: false, existingZoneIds: existing, editingZoneId: 'ward-1' }),
    ).toBeNull();
    // The rebuilt zone equals the stored one (lossless round-trip).
    expect(buildGridZone(fields)).toEqual(stored);
  });

  it('drops a legacy self-adjacency from the prefilled form', () => {
    const fields = zoneToFormFields({
      id: 'a',
      bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
      adjacentZoneIds: ['a', 'b'],
    });
    expect(fields.adjacentZoneIds).toEqual(['b']);
  });
});

describe('mergeZoneEdits (edit mode preserves runtime-owned keys)', () => {
  it('replaces form-managed keys, keeps occupancy / occupantScheduleOverlay verbatim', () => {
    const original = buildGridZone(
      validGridFields({ buildingId: 'b1', floor: '2', scheduleEnabled: true,
        scheduleCount: '4', scheduleStart: '08:00', scheduleEnd: '18:00' }),
    ) as EnvZone & { occupancy?: number; occupantScheduleOverlay?: unknown };
    original.occupancy = 3;
    original.occupantScheduleOverlay = {
      schedule: { count: 9, startSimTimeSec: 28800, endSimTimeSec: 64800, repeatDaily: true },
      startsAtSimSec: 86400,
      endsAtSimSec: 172800,
    };
    // The user clears the schedule and the building tier in the edit form.
    const rebuilt = buildGridZone(validGridFields());
    const merged = mergeZoneEdits(original, rebuilt);
    expect(merged.occupantSchedule).toBeUndefined();
    expect(merged.buildingId).toBeUndefined();
    expect(merged.floor).toBeUndefined();
    expect(merged.occupancy).toBe(3);
    expect(merged.occupantScheduleOverlay).toEqual(original.occupantScheduleOverlay);
  });
});

describe('mapDataWithZones (building generator append)', () => {
  it('appends the batch and preserves events/center', () => {
    const env = {
      id: 'env-1',
      mapType: 'geo',
      mapCenter: { lat: 31.3, lng: 120.6 },
      mapZoom: 12,
      zones: [{ id: 'old', polygon: [[31.3, 120.6], [31.31, 120.6], [31.3, 120.61]] }],
      events: [{ id: 'ev-1', type: 'storm', zoneId: 'old' }],
      devices: [],
      floorPlans: [],
      storeyHeight: null,
      mapZoomNote: null,
    } as unknown as EnvironmentDetail;
    const batch = [
      { id: 'b1-f0-ward-1', polygon: [[31.32, 120.62], [31.33, 120.62], [31.32, 120.63]] as [number, number][] },
      { id: 'b1-f0-ward-2', polygon: [[31.32, 120.63], [31.33, 120.63], [31.32, 120.64]] as [number, number][] },
    ];
    const body = mapDataWithZones(env, batch);
    expect(body.zones).toHaveLength(3);
    expect(body.events).toEqual(env.events);
    expect(body.center).toEqual({ lat: 31.3, lng: 120.6 });
    expect(body.zoom).toBe(12);
  });
});
