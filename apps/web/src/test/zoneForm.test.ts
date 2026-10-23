/**
 * Zone management tests (W6-2):
 * - slug default + id format/uniqueness validation;
 * - grid bounds validation (finite, min < max);
 * - baseline rows (number/boolean parsing, dup keys, blank-row dropping);
 * - the geo polygon builder (append vertex, consecutive-dup merge, min-3
 *   finish gate, closing-repeat drop);
 * - mapData PATCH assembly — appending/removing a zone preserves every
 *   other key (geo center/zoom, scheduled events, demo metadata, floor
 *   plans, governance and the building physics meta);
 * - zone deletion blockers (devices / events still referencing the zone).
 */

import { describe, expect, it, beforeAll } from 'vitest';

import type { EnvironmentDetail } from '../api/types';
import i18n from '../i18n/config';
import {
  appendPolygonVertex,
  baselineError,
  boundsError,
  buildGeoZone,
  buildGridZone,
  canFinishPolygon,
  createZoneFormFields,
  finishPolygon,
  mapDataWithZone,
  mapDataWithoutZone,
  parseBaselineValue,
  rowsToBaseline,
  slugifyZoneId,
  zoneDeleteBlocker,
  zoneFormError,
  zoneIdError,
  type ZoneFormFields,
} from '../lib/zoneForm';

// lib/zoneForm reads the active i18next bundle at call time; pin to en-US so
// the assertions can be exact English strings.
beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

function makeEnv(overrides: Partial<EnvironmentDetail> = {}): EnvironmentDetail {
  // The fixture models a governance-free blank world: governance is required
  // by the contract type but deliberately ABSENT at runtime, so the
  // "no invented keys" blank-env assertion stays meaningful while the
  // preservation tests set it explicitly.
  return {
    id: 'env-1',
    name: '测试环境',
    description: '',
    mapType: 'grid',
    mapCenter: null,
    mapZoom: null,
    storeyHeight: null,
    floorPlans: [],
    visibility: 'private',
    owner: { id: 'user-a', displayName: '小A' },
    zones: [],
    events: [],
    devices: [],
    agents: [],
    services: [],
    members: [],
    myRole: 'owner',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  } as unknown as EnvironmentDetail;
}

function validGridFields(overrides: Partial<ZoneFormFields> = {}): ZoneFormFields {
  return {
    ...createZoneFormFields(),
    id: 'living',
    name: '客厅',
    minX: '0',
    maxX: '6',
    minY: '0',
    maxY: '4',
    ...overrides,
  };
}

describe('slugifyZoneId', () => {
  it('derives a slug from the name', () => {
    expect(slugifyZoneId('Living Room')).toBe('living-room');
    expect(slugifyZoneId('  Bed_Room 2 ')).toBe('bed-room-2');
  });

  it('falls back to "zone" when nothing slug-able remains (CJK names)', () => {
    expect(slugifyZoneId('客厅')).toBe('zone');
    expect(slugifyZoneId('   ')).toBe('zone');
  });
});

describe('zoneIdError', () => {
  it('accepts a fresh slug', () => {
    expect(zoneIdError('living-room_2', new Set(['bed']))).toBeNull();
  });

  it('rejects empty, non-slug and duplicate ids', () => {
    expect(zoneIdError('', new Set())).toContain('zone id');
    expect(zoneIdError('-bad', new Set())).toContain('lowercase');
    expect(zoneIdError('Has Upper', new Set())).toContain('lowercase');
    expect(zoneIdError('living', new Set(['living']))).toContain('already exists');
  });
});

describe('boundsError', () => {
  const base = { minX: '0', maxX: '6', minY: '0', maxY: '4' };

  it('accepts finite bounds with min < max', () => {
    expect(boundsError(base)).toBeNull();
  });

  it('rejects blank/non-numeric inputs', () => {
    expect(boundsError({ ...base, minX: '' })).toContain('minX');
    expect(boundsError({ ...base, maxY: 'abc' })).toContain('maxY');
  });

  it('requires min strictly below max on both axes', () => {
    expect(boundsError({ ...base, minX: '6', maxX: '6' })).toContain('minX < maxX');
    expect(boundsError({ ...base, minY: '5', maxY: '4' })).toContain('minY < maxY');
  });
});

describe('baseline rows', () => {
  it('parses numbers and booleans, rejects anything else', () => {
    expect(parseBaselineValue('26')).toBe(26);
    expect(parseBaselineValue('-1.5')).toBe(-1.5);
    expect(parseBaselineValue('true')).toBe(true);
    expect(parseBaselineValue('false')).toBe(false);
    expect(parseBaselineValue('high')).toBeNull();
    expect(parseBaselineValue('')).toBeNull();
  });

  it('serializes keyed rows, drops blank rows, undefined when empty', () => {
    expect(rowsToBaseline([])).toBeUndefined();
    expect(rowsToBaseline([{ key: ' ', value: ' ' }])).toBeUndefined();
    expect(
      rowsToBaseline([
        { key: 'temperature', value: '26' },
        { key: ' ', value: '' },
        { key: 'occupied', value: 'true' },
      ]),
    ).toEqual({ temperature: 26, occupied: true });
  });

  it('flags value-less keys, unparseable values and duplicate keys', () => {
    expect(baselineError([{ key: '', value: '26' }])).toContain('parameter name');
    expect(baselineError([{ key: 'temperature', value: 'warm' }])).toContain('temperature');
    expect(
      baselineError([
        { key: 'co2', value: '400' },
        { key: 'co2', value: '500' },
      ]),
    ).toContain('duplicated');
    expect(baselineError([{ key: 'co2', value: '400' }])).toBeNull();
  });
});

describe('zoneFormError', () => {
  it('passes a valid grid form', () => {
    expect(zoneFormError(validGridFields(), { isGeo: false, existingZoneIds: new Set() })).toBeNull();
  });

  it('requires a name and validates bounds on grid', () => {
    expect(
      zoneFormError(validGridFields({ name: ' ' }), { isGeo: false, existingZoneIds: new Set() }),
    ).toContain('zone name');
    expect(
      zoneFormError(validGridFields({ minX: '9' }), { isGeo: false, existingZoneIds: new Set() }),
    ).toContain('minX < maxX');
  });

  it('skips bounds on geo (the polygon comes from the map)', () => {
    expect(zoneFormError(validGridFields({ minX: '' }), { isGeo: true, existingZoneIds: new Set() })).toBeNull();
  });
});

describe('zone builders', () => {
  it('buildGridZone omits optional type/baseline when blank', () => {
    expect(buildGridZone(validGridFields())).toEqual({
      id: 'living',
      name: '客厅',
      bounds: { minX: 0, maxX: 6, minY: 0, maxY: 4 },
    });
  });

  it('buildGridZone includes type and baseline when set', () => {
    expect(
      buildGridZone(
        validGridFields({ type: 'residential', baselineRows: [{ key: 'temperature', value: '26' }] }),
      ),
    ).toEqual({
      id: 'living',
      name: '客厅',
      type: 'residential',
      bounds: { minX: 0, maxX: 6, minY: 0, maxY: 4 },
      baseline: { temperature: 26 },
    });
  });

  it('buildGeoZone attaches the drawn polygon', () => {
    const polygon: [number, number][] = [
      [31.3, 120.6],
      [31.31, 120.6],
      [31.3, 120.61],
    ];
    expect(buildGeoZone(validGridFields(), polygon)).toEqual({
      id: 'living',
      name: '客厅',
      polygon,
    });
  });
});

describe('geo polygon builder', () => {
  const A: [number, number] = [31.3, 120.6];
  const B: [number, number] = [31.31, 120.6];
  const C: [number, number] = [31.3, 120.61];

  it('appends vertices and merges consecutive (near-)duplicates', () => {
    let vertices = appendPolygonVertex([], A);
    vertices = appendPolygonVertex(vertices, B);
    expect(vertices).toEqual([A, B]);
    // The second click of a finishing dblclick lands on the same spot.
    expect(appendPolygonVertex(vertices, [31.31, 120.6])).toEqual([A, B]);
    expect(appendPolygonVertex(vertices, C)).toEqual([A, B, C]);
  });

  it('gates finishing on at least 3 vertices', () => {
    expect(canFinishPolygon([])).toBe(false);
    expect(canFinishPolygon([A, B])).toBe(false);
    expect(canFinishPolygon([A, B, C])).toBe(true);
  });

  it('finishPolygon drops a closing repeat and enforces the min-3 ring', () => {
    expect(finishPolygon([A, B])).toBeNull();
    expect(finishPolygon([A, B, C])).toEqual([A, B, C]);
    expect(finishPolygon([A, B, C, A])).toEqual([A, B, C]);
    // Two distinct points + a closing repeat still is not a ring.
    expect(finishPolygon([A, B, A])).toBeNull();
  });
});

describe('mapData assembly', () => {
  const newZone = { id: 'yard', name: '院子', bounds: { minX: 0, maxX: 8, minY: 0, maxY: 5 } };

  it('appends a zone to a blank grid env (no extra keys invented)', () => {
    expect(mapDataWithZone(makeEnv(), newZone)).toEqual({ zones: [newZone] });
  });

  it('grid: preserves existing zones and scheduled events', () => {
    const env = makeEnv({
      zones: [{ id: 'living', bounds: { minX: 0, maxX: 6, minY: 0, maxY: 4 } }],
      events: [{ id: 'ev-1', type: 'heatwave', zoneId: 'living', value: 38 }],
    });
    const body = mapDataWithZone(env, newZone);
    expect(body.zones).toHaveLength(2);
    expect(body.events).toEqual(env.events);
  });

  it('geo: preserves center/zoom/events alongside the zones', () => {
    const drawn = {
      id: 'new',
      polygon: [[31.32, 120.62], [31.33, 120.62], [31.32, 120.63]] as [number, number][],
    };
    const env = makeEnv({
      mapType: 'geo',
      mapCenter: { lat: 31.3, lng: 120.6 },
      mapZoom: 12,
      zones: [{ id: 'old', polygon: [[31.3, 120.6], [31.31, 120.6], [31.3, 120.61]] }],
      events: [{ id: 'ev-1', type: 'storm', zoneId: 'old' }],
    });
    const body = mapDataWithZone(env, drawn);
    expect(body.center).toEqual({ lat: 31.3, lng: 120.6 });
    expect(body.zoom).toBe(12);
    expect(body.events).toEqual(env.events);
    expect(body.zones).toEqual([env.zones[0], drawn]);
  });

  it('preserves demo metadata, floor plans, governance and physics meta (P0 regression)', () => {
    const demo = {
      tagline: { zh: '先跑起来', en: 'Run first' },
      heroEventId: 'hero-1',
      recommendedPlaybackRate: 10,
    };
    const floorPlans = [{ floor: 0, image: 'data:image/svg+xml;base64,x', pixelsPerMeter: 64 }];
    const env = makeEnv({
      demo,
      derivedServiceVisibility: 'public',
      floorPlans,
      storeyHeight: 3.5,
      governance: {
        proposalReview: 'ai-assisted-auto-apply',
        notes: '',
        supervisedZones: [],
        supervisedZoneNote: '',
        humanReview: { maxAgentsPerProposal: 0, maxEventsPerProposal: 0, maxZonesTouched: 0 },
        humanReviewNote: '',
      },
      // Untyped-on-contract physics fields still ride on the wire — the
      // defensive reader must carry them through.
      ...({
        slabAttenuation: 0.15,
        envelopeU: 0.12,
        occupancyHeatW: 90,
        occupancyCo2Rate: 0.0052,
      } as Partial<EnvironmentDetail>),
    });
    const body = mapDataWithZone(env, buildGridZone(validGridFields()));
    expect(body.demo).toEqual(demo);
    expect(body.derivedServiceVisibility).toBe('public');
    expect(body.floorPlans).toEqual(floorPlans);
    expect(body.storeyHeight).toBe(3.5);
    expect(body.slabAttenuation).toBe(0.15);
    expect(body.envelopeU).toBe(0.12);
    expect(body.occupancyHeatW).toBe(90);
    expect(body.occupancyCo2Rate).toBe(0.0052);
    const removed = mapDataWithoutZone(env, 'nope');
    expect(removed.demo).toEqual(demo);
    expect(removed.floorPlans).toEqual(floorPlans);
  });

  it('mapDataWithoutZone removes only that zone and keeps the rest', () => {
    const env = makeEnv({
      mapType: 'geo',
      mapCenter: { lat: 31.3, lng: 120.6 },
      mapZoom: 12,
      zones: [
        { id: 'a', polygon: [[31.3, 120.6], [31.31, 120.6], [31.3, 120.61]] },
        { id: 'b', polygon: [[31.32, 120.62], [31.33, 120.62], [31.32, 120.63]] },
      ],
      events: [{ id: 'ev-1', type: 'storm', zoneId: 'a' }],
    });
    const body = mapDataWithoutZone(env, 'b');
    expect(body.zones).toEqual([env.zones[0]]);
    expect(body.center).toEqual({ lat: 31.3, lng: 120.6 });
    expect(body.zoom).toBe(12);
    expect(body.events).toEqual(env.events);
  });
});

describe('zoneDeleteBlocker', () => {
  const zone = { id: 'living', bounds: { minX: 0, maxX: 6, minY: 0, maxY: 4 } };

  it('is null for an unreferenced zone', () => {
    expect(zoneDeleteBlocker(makeEnv({ zones: [zone] }), 'living')).toBeNull();
  });

  it('blocks while devices point at the zone', () => {
    const env = makeEnv({
      zones: [zone],
      devices: [
        {
          id: 'dev-1',
          envId: 'env-1',
          name: '灯',
          type: 'lamp',
          brand: null,
          capabilities: ['switch'],
          zoneId: 'living',
          position: null,
          initialState: null,
          binding: 'sim://dev-1',
          owner: { id: 'user-a', displayName: '小A' },
          createdAt: new Date(0).toISOString(),
        },
      ],
    });
    expect(zoneDeleteBlocker(env, 'living')).toContain('1 device(s)');
  });

  it('blocks while scheduled events reference the zone', () => {
    const env = makeEnv({
      zones: [zone],
      events: [{ id: 'ev-1', type: 'heatwave', zoneId: 'living' }],
    });
    expect(zoneDeleteBlocker(env, 'living')).toContain('scheduled event(s)');
  });
});
