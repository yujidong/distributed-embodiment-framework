/**
 * UX-W2 building generator tests (lib/buildingGenerator):
 * - naming pattern expansion + slug discipline;
 * - batch size / building tier / deterministic grid layout (floors stack
 *   vertically, zones side by side) and geo footprint strip splitting;
 * - adjacency declaration: same-floor chains and cross-floor links, both
 *   directions, disabled cleanly by the switches;
 * - batch validation (counts, blank building id, in-batch duplicates,
 *   collisions with existing zones);
 * - preset packs produce their zone type.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../i18n/config';
import {
  BUILDING_PRESETS,
  DEFAULT_GRID_LAYOUT,
  DEFAULT_NAMING_PATTERN,
  buildingGeneratorError,
  defaultGeoFootprintHalfDeg,
  expandNamingPattern,
  generateBuildingZones,
  generatedZoneId,
  type BuildingGeneratorConfig,
} from '../lib/buildingGenerator';

beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

function gridConfig(overrides: Partial<BuildingGeneratorConfig> = {}): BuildingGeneratorConfig {
  return {
    buildingId: 'b1',
    floors: 3,
    zonesPerFloor: 2,
    namingPattern: DEFAULT_NAMING_PATTERN,
    zoneNamePrefix: 'ward',
    type: 'ward',
    linkSameFloor: true,
    linkAdjacentFloors: true,
    grid: { ...DEFAULT_GRID_LAYOUT },
    ...overrides,
  };
}

describe('naming', () => {
  it('expands every placeholder', () => {
    expect(
      expandNamingPattern('{bldg}-f{floor}-{name}#{index}', {
        bldg: 'b1',
        floor: 2,
        index: 1,
        name: 'ward-2',
      }),
    ).toBe('b1-f2-ward-2#1');
  });

  it('generated ids obey the zone slug discipline', () => {
    expect(
      generatedZoneId('{bldg} {floor} {name}', { bldg: 'Bldg A', floor: 0, index: 0, name: 'ward-1' }),
    ).toBe('bldg-a-0-ward-1');
  });
});

describe('generateBuildingZones (grid)', () => {
  it('produces floors × zonesPerFloor zones with the building tier', () => {
    const zones = generateBuildingZones(gridConfig());
    expect(zones).toHaveLength(6);
    for (const zone of zones) {
      expect(zone.buildingId).toBe('b1');
      expect(zone.type).toBe('ward');
    }
    expect(zones.map(zone => zone.id)).toEqual([
      'b1-f0-ward-1',
      'b1-f0-ward-2',
      'b1-f1-ward-1',
      'b1-f1-ward-2',
      'b1-f2-ward-1',
      'b1-f2-ward-2',
    ]);
    expect(zones[2].floor).toBe(1);
    // R2-FEAT-05: the naming pattern applies to display names too, with
    // human 1-based {floor} — second storey (floor 1) ward-1 reads 'b1-f2-ward-1'.
    expect(zones[2].name).toBe('b1-f2-ward-1');
  });

  it('R2-FEAT-05: a pattern without {floor} gets a storey prefix on names', () => {
    const zones = generateBuildingZones(
      gridConfig({ namingPattern: '一号厂房-{name}', zoneNamePrefix: '车间' }),
    );
    // Names keep the CJK原文 and stay floor-distinguishable…
    expect(zones[0].name).toBe('1F 一号厂房-车间-1');
    expect(zones[2].name).toBe('2F 一号厂房-车间-1');
    // …while ids fall back to a discriminating slug instead of deadlocking
    // on the generic 'zone' fallback (CJK strips to nothing).
    expect(new Set(zones.map(zone => zone.id)).size).toBe(zones.length);
    expect(zones[0].id).toBe('1-f0-0');
  });

  it('lays floors out in vertical bands, zones side by side', () => {
    const zones = generateBuildingZones(gridConfig());
    // ward-1 on f0: origin; ward-2 on f0: shifted by (width + gapX).
    expect(zones[0].bounds).toEqual({ minX: 0, maxX: 6, minY: 0, maxY: 4 });
    expect(zones[1].bounds).toEqual({ minX: 7, maxX: 13, minY: 0, maxY: 4 });
    // f1 ward-1: same x, one storeyPitch up.
    expect(zones[2].bounds).toEqual({ minX: 0, maxX: 6, minY: 6, maxY: 10 });
  });

  it('declares same-floor + cross-floor adjacency in both directions', () => {
    const zones = generateBuildingZones(gridConfig());
    const byId = new Map(zones.map(zone => [zone.id, zone]));
    expect(byId.get('b1-f0-ward-1')!.adjacentZoneIds).toEqual(['b1-f0-ward-2', 'b1-f1-ward-1']);
    expect(byId.get('b1-f0-ward-2')!.adjacentZoneIds).toEqual(['b1-f0-ward-1', 'b1-f1-ward-2']);
    // Middle floor links both ways vertically.
    expect(byId.get('b1-f1-ward-1')!.adjacentZoneIds).toEqual([
      'b1-f0-ward-1',
      'b1-f1-ward-2',
      'b1-f2-ward-1',
    ]);
  });

  it('the switches drop their adjacency kinds cleanly', () => {
    const flat = generateBuildingZones(gridConfig({ linkAdjacentFloors: false }));
    expect(flat[0].adjacentZoneIds).toEqual(['b1-f0-ward-2']);
    const silo = generateBuildingZones(gridConfig({ linkSameFloor: false, linkAdjacentFloors: false }));
    expect(silo.every(zone => zone.adjacentZoneIds === undefined)).toBe(true);
  });

  it('applies the baseline / occupantSchedule template to every zone', () => {
    const zones = generateBuildingZones(
      gridConfig({
        baseline: { temperature: 24 },
        occupantSchedule: { count: 4, startSimTimeSec: 28800, endSimTimeSec: 72000 },
      }),
    );
    expect(zones[0].baseline).toEqual({ temperature: 24 });
    expect(zones[5].occupantSchedule).toEqual({
      count: 4,
      startSimTimeSec: 28800,
      endSimTimeSec: 72000,
      // The wire schema requires the flag (server default = true).
      repeatDaily: true,
    });
  });
});

describe('generateBuildingZones (geo)', () => {
  const config = gridConfig({
    zonesPerFloor: 2,
    floors: 2,
    geo: { minLat: 31.3, maxLat: 31.31, minLng: 120.6, maxLng: 120.62 },
  });

  it('splits the footprint into lng strips copied per floor, no bounds', () => {
    const zones = generateBuildingZones(config);
    expect(zones).toHaveLength(4);
    expect(zones[0].polygon).toEqual([
      [31.3, 120.6],
      [31.31, 120.6],
      [31.31, 120.61],
      [31.3, 120.61],
    ]);
    expect(zones[1].polygon).toEqual([
      [31.3, 120.61],
      [31.31, 120.61],
      [31.31, 120.62],
      [31.3, 120.62],
    ]);
    // Same footprint on the next floor (floor is the discriminator).
    expect(zones[2].polygon).toEqual(zones[0].polygon);
    expect(zones[2].floor).toBe(1);
    expect(zones.every(zone => zone.bounds === undefined)).toBe(true);
  });
});

describe('buildingGeneratorError', () => {
  it('accepts a valid batch against an empty world', () => {
    expect(buildingGeneratorError(gridConfig(), new Set())).toBeNull();
  });

  it('rejects blank building ids and non-positive counts', () => {
    expect(buildingGeneratorError(gridConfig({ buildingId: ' ' }), new Set())).not.toBeNull();
    expect(buildingGeneratorError(gridConfig({ floors: 0 }), new Set())).not.toBeNull();
    expect(buildingGeneratorError(gridConfig({ zonesPerFloor: 1.5 }), new Set())).not.toBeNull();
    expect(buildingGeneratorError(gridConfig({ zoneNamePrefix: '' }), new Set())).not.toBeNull();
  });

  it('names the first collision with an existing zone', () => {
    expect(buildingGeneratorError(gridConfig(), new Set(['b1-f1-ward-2']))).toContain('b1-f1-ward-2');
  });

  it('catches in-batch id duplicates from a colliding pattern', () => {
    // Pattern without {floor}/{index}: every slot generates the same id.
    expect(
      buildingGeneratorError(gridConfig({ namingPattern: '{bldg}-zone' }), new Set()),
    ).toContain('b1-zone');
  });
});

describe('presets', () => {
  it('hospital / hotel / office produce their zone types and counts', () => {
    const expected = { hospital: 'ward', hotel: 'guestroom', office: 'office' } as const;
    for (const preset of BUILDING_PRESETS) {
      const zones = generateBuildingZones(gridConfig({
        type: preset.type,
        zoneNamePrefix: preset.zoneNamePrefix,
        floors: preset.floors,
        zonesPerFloor: preset.zonesPerFloor,
        baseline: preset.baseline,
        occupantSchedule: preset.occupantSchedule,
      }));
      expect(zones).toHaveLength(preset.floors * preset.zonesPerFloor);
      expect(zones[0].type).toBe(expected[preset.id]);
    }
  });
});

// R2-UX-24: the default geo footprint scales with the floor count — the
// legacy fixed ±0.0005° (≈110×95 m) made low buildings render as pancakes.
describe('defaultGeoFootprintHalfDeg (R2-UX-24)', () => {
  it('keeps the full default for tall buildings and shrinks for low ones', () => {
    expect(defaultGeoFootprintHalfDeg(6)).toBeCloseTo(0.0005, 10);
    expect(defaultGeoFootprintHalfDeg(12)).toBeCloseTo(0.0005, 10); // capped at 1×
    expect(defaultGeoFootprintHalfDeg(3)).toBeCloseTo(0.00025, 10);
    expect(defaultGeoFootprintHalfDeg(1)).toBeCloseTo(0.0005 * 0.4, 10); // 40% floor
  });

  it('treats junk input as a single storey (40% floor), never NaN', () => {
    expect(defaultGeoFootprintHalfDeg(Number.NaN)).toBeCloseTo(0.0005 * 0.4, 10);
    expect(defaultGeoFootprintHalfDeg(0)).toBeCloseTo(0.0005 * 0.4, 10);
  });
});
