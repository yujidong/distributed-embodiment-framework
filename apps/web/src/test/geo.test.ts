/**
 * Geo map tier unit tests (§11.4): the projection helpers mirror
 * apps/server/src/geo.ts — the fixture values below are the SAME ones the
 * server suite asserts, so both sides agree on the math.
 */

import { describe, expect, it } from 'vitest';

import type { EnvironmentDetail, EnvZone, WorldDevice } from '../api/types';
import {
  AGENT_FAN_OUT_DEG,
  METERS_PER_DEG_LAT,
  agentLatLng,
  fanOutCoAnchored,
  pointInPolygon,
  polygonCentroid,
  projectToMeters,
  readLatLng,
} from '../lib/geo';
import { scenarioFromEnvironment, worldModelFromEnvironment } from '../lib/worldModel';

const CENTER = { lat: 31.268, lng: 120.6615 };

const SQUARE: [number, number][] = [
  [31.288, 120.598],
  [31.288, 120.646],
  [31.326, 120.646],
  [31.326, 120.598],
];

describe('geo projection (mirrors server geo.ts)', () => {
  it('projects the center onto the origin', () => {
    expect(projectToMeters(CENTER, CENTER.lat, CENTER.lng)).toEqual({ x: 0, y: 0 });
  });

  it('projects a known offset to expected meters', () => {
    // Same fixture as the server suite: 0.001° lng east at 31.268°N ≈ 95.15 m.
    const east = projectToMeters(CENTER, CENTER.lat, CENTER.lng + 0.001);
    expect(east.x).toBeCloseTo(95.15, 1);
    expect(east.y).toBe(0);
    // 0.001° lat north: y points SOUTH, so north of center is negative y.
    const north = projectToMeters(CENTER, CENTER.lat + 0.001, CENTER.lng);
    expect(north.y).toBeCloseTo(-METERS_PER_DEG_LAT * 0.001, 6);
  });
});

describe('polygon helpers', () => {
  it('computes the centroid as the mean of vertices', () => {
    const centroid = polygonCentroid(SQUARE);
    expect(centroid.lat).toBeCloseTo(31.307, 6);
    expect(centroid.lng).toBeCloseTo(120.622, 6);
  });

  it('point-in-polygon: inside, outside, and edge-ish cases', () => {
    expect(pointInPolygon(31.307, 120.622, SQUARE)).toBe(true);
    expect(pointInPolygon(31.2, 120.622, SQUARE)).toBe(false);
    expect(pointInPolygon(31.307, 120.7, SQUARE)).toBe(false);
  });

  it('readLatLng: defensive position parsing', () => {
    expect(readLatLng({ lat: 31.3, lng: 120.6 })).toEqual({ lat: 31.3, lng: 120.6 });
    expect(readLatLng({ lat: 91, lng: 120.6 })).toBeNull();
    expect(readLatLng({ lat: 31.3 })).toBeNull();
    expect(readLatLng({ x: 1, y: 2 })).toBeNull();
    expect(readLatLng(null)).toBeNull();
  });
});

describe('agentLatLng anchor fallback chain', () => {
  const zone: EnvZone = { id: 'z1', name: '姑苏老城', polygon: SQUARE };

  it('anchors at the managed-zone centroid', () => {
    const anchor = agentLatLng([zone], [], CENTER);
    expect(anchor.lat).toBeCloseTo(31.307, 6);
    expect(anchor.lng).toBeCloseTo(120.622, 6);
  });

  it('falls back to bound-device positions, then the map center', () => {
    const fromDevices = agentLatLng([], [{ lat: 31.3, lng: 120.6 }], CENTER);
    expect(fromDevices).toEqual({ lat: 31.3, lng: 120.6 });
    expect(agentLatLng([], [], CENTER)).toEqual(CENTER);
  });
});

describe('fanOutCoAnchored (de-stacking co-anchored agent markers)', () => {
  const ANCHOR = { lat: 22.6, lng: 114.1 };

  it('keeps the first agent at the anchor and spirals its siblings outward', () => {
    const positions = fanOutCoAnchored(
      [
        { id: 'a1', anchor: ANCHOR },
        { id: 'a2', anchor: ANCHOR },
        { id: 'a3', anchor: ANCHOR },
      ],
      AGENT_FAN_OUT_DEG,
    );
    expect(positions.get('a1')).toEqual(ANCHOR);
    // Sibling distances from the anchor grow with √k (sunflower spiral) so a
    // district's cluster reads as a cluster instead of one stacked dot.
    const d2 = Math.hypot(
      positions.get('a2')!.lat - ANCHOR.lat,
      positions.get('a2')!.lng - ANCHOR.lng,
    );
    const d3 = Math.hypot(
      positions.get('a3')!.lat - ANCHOR.lat,
      positions.get('a3')!.lng - ANCHOR.lng,
    );
    expect(d2).toBeCloseTo(AGENT_FAN_OUT_DEG, 8);
    expect(d3).toBeCloseTo(AGENT_FAN_OUT_DEG * Math.sqrt(2), 8);
    // Siblings must not collide with each other.
    const separation = Math.hypot(
      positions.get('a2')!.lat - positions.get('a3')!.lat,
      positions.get('a2')!.lng - positions.get('a3')!.lng,
    );
    expect(separation).toBeGreaterThan(AGENT_FAN_OUT_DEG * 0.8);
  });

  it('leaves agents with a unique anchor untouched', () => {
    const other = { lat: 22.7, lng: 114.3 };
    const positions = fanOutCoAnchored(
      [
        { id: 'a1', anchor: ANCHOR },
        { id: 'b1', anchor: other },
      ],
      AGENT_FAN_OUT_DEG,
    );
    expect(positions.get('b1')).toEqual(other);
    expect(positions.get('a1')).toEqual(ANCHOR);
  });

  it('clamps the spiral radius at maxRadiusDeg while the angle keeps advancing', () => {
    // City scale: unclamped k=19 × 0.002° ≈ 0.0087° (~1 km); cap at 2 units.
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, anchor: ANCHOR }));
    const cap = AGENT_FAN_OUT_DEG * 2;
    const positions = fanOutCoAnchored(items, AGENT_FAN_OUT_DEG, cap);
    for (const [, pos] of positions) {
      const d = Math.hypot(pos.lat - ANCHOR.lat, pos.lng - ANCHOR.lng);
      expect(d).toBeLessThanOrEqual(cap + 1e-12);
    }
    // The golden angle keeps advancing — clamped siblings don't collapse
    // into one dot on the clamp ring.
    const distinct = new Set([...positions.values()].map(p => `${p.lat},${p.lng}`));
    expect(distinct.size).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// World-model adaptation of a geo environment
// ---------------------------------------------------------------------------

function geoDevice(overrides: Partial<WorldDevice> = {}): WorldDevice {
  return {
    id: 'dev-1',
    envId: 'env-1',
    name: '空气质量监测站',
    type: 'air-quality-sensor',
    brand: 'Sailhero',
    capabilities: ['air-quality-monitoring', 'pm25-monitoring'],
    zoneId: 'z1',
    position: { lat: 31.307, lng: 120.622 },
    initialState: { pm2_5: 38 },
    binding: 'sim://dev-1',
    owner: { id: 'user-a', displayName: '系统' },
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function geoDetail(overrides: Partial<EnvironmentDetail> = {}): EnvironmentDetail {
  return {
    id: 'env-1',
    name: '苏州智慧城市',
    description: 'geo demo',
    mapType: 'geo',
    mapCenter: CENTER,
    mapZoom: 11,
    storeyHeight: null,
    floorPlans: [],
    semanticOfferRules: [],
    capabilitySynonyms: [],
    visibility: 'public',
    owner: { id: 'user-a', displayName: '系统' },
    zones: [{ id: 'z1', name: '姑苏老城', type: 'historic-district', polygon: SQUARE }],
    events: [
      { id: 'evt-1', type: 'pm25-anomaly', zoneId: 'z1', parameter: 'pm2_5', value: 158, atSimTimeSec: 60 },
    ],
    devices: [geoDevice()],
    agents: [
      {
        id: 'agent-1',
        envId: 'env-1',
        name: '苏州市环境监测中心',
        capabilities: ['air-quality-monitoring'],
        boundDeviceIds: ['dev-1'],
        managedZoneIds: ['z1'],
        llm: null,
        enabled: true,
        owner: { id: 'user-a', displayName: '系统' },
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    services: [],
    members: [],
    governance: {
      proposalReview: 'ai-assisted-auto-apply',
      notes: '',
      supervisedZones: [],
      supervisedZoneNote: '',
      humanReview: { maxAgentsPerProposal: 0, maxEventsPerProposal: 0, maxZonesTouched: 0 },
      humanReviewNote: '',
    },
    myRole: 'owner',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('world model adaptation of geo environments', () => {
  it('keeps zone polygons and parses device lat/lng positions', () => {
    const model = worldModelFromEnvironment(geoDetail());
    expect(model.zones[0]!.polygon).toEqual(SQUARE);
    expect(model.devices[0]!.latLng).toEqual({ lat: 31.307, lng: 120.622 });
    // Grid-style position is null for geo devices (no {x, y}).
    expect(model.devices[0]!.position).toBeNull();
    expect(model.devices[0]!.role).toBe('sensor');
    expect(model.agents[0]!.managedZoneIds).toEqual(['z1']);
  });

  it('scenarioFromEnvironment carries baked events and polygon-less zones', () => {
    const scenario = scenarioFromEnvironment(geoDetail());
    expect(scenario.events).toHaveLength(1);
    expect(scenario.events[0]).toMatchObject({ id: 'evt-1', zoneId: 'z1', atSimTimeSec: 60 });
    expect(scenario.zones[0]!.bounds).toBeUndefined();
    expect(scenario.zones[0]!.adjacentZoneIds).toEqual([]);
  });
});
