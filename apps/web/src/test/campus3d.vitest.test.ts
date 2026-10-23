/**
 * campus3d — pure view-model tests for the Babylon campus renderer; the
 * component itself needs WebGL and is only covered by tsc.
 */

import { describe, expect, it } from 'vitest';

import type { EnvZone } from '../api/types';
import {
  ZONE_CATEGORY_COLORS,
  arcPoseFromPose,
  arcPoseOffset,
  buildingEntryZoneId,
  campusGroundPlan,
  computeSceneBoundsWithExtrusions,
  computeZoneBoxes,
  computeZoneExtrusions,
  groupZonesByBuilding,
  hashSeed,
  hslaToRgb,
  initialCameraPose,
  placementFloorY,
} from '../lib/campus3d';

function zone(partial: Partial<EnvZone> & { id: string }): EnvZone {
  return { ...partial };
}

/** ~110 m square ring (WGS-84), like a Taicang building outline. */
const RING_A: [number, number][] = [
  [31.0, 120.0],
  [31.0, 120.001],
  [31.001, 120.001],
  [31.001, 120.0],
];
const RING_B: [number, number][] = [
  [31.005, 120.005],
  [31.005, 120.006],
  [31.006, 120.006],
  [31.006, 120.005],
];

describe('groupZonesByBuilding', () => {
  it('stacks polygon floors of one building and dedupes the shared outline', () => {
    const zones = [0, 1, 2].map(floor =>
      zone({
        id: `a-f${floor}`,
        name: `A栋-${floor + 1}01`,
        buildingId: 'building-a',
        floor,
        polygon: RING_A,
      }),
    );
    const buildings = groupZonesByBuilding(zones, { storeyHeight: 3.5 });
    expect(buildings).toHaveLength(1);
    const building = buildings[0];
    expect(building.buildingId).toBe('building-a');
    // Each floor keeps exactly ONE extrusion though every zone repeats the ring.
    expect(building.floors).toHaveLength(3);
    for (const slab of building.floors) {
      expect(slab.extrusions).toHaveLength(1);
      expect(slab.boxes).toHaveLength(0);
    }
    expect(building.maxFloor).toBe(2);
    // Common name prefix「A栋」wins over the raw buildingId.
    expect(building.name).toBe('A栋');
    // Real footprint (~96 m × ~110 m), not a unit bbox.
    expect(building.bbox.maxX - building.bbox.minX).toBeGreaterThan(80);
    expect(building.bbox.maxZ - building.bbox.minZ).toBeGreaterThan(90);
    expect(building.centroid.x).toBeCloseTo(
      (building.bbox.minX + building.bbox.maxX) / 2,
      6,
    );
  });

  it('keeps both rings when one floor carries two distinct footprints', () => {
    const buildings = groupZonesByBuilding([
      zone({ id: 'z1', name: '翼楼-1', buildingId: 'b', floor: 0, polygon: RING_A }),
      zone({ id: 'z2', name: '翼楼-2', buildingId: 'b', floor: 0, polygon: RING_B }),
    ]);
    expect(buildings).toHaveLength(1);
    expect(buildings[0].floors[0].extrusions).toHaveLength(2);
  });

  it('groups bbox zones per building and keeps zones without buildingId solo', () => {
    const buildings = groupZonesByBuilding([
      zone({
        id: 'z1',
        name: '101 教室',
        buildingId: 'b1',
        floor: 0,
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 8 },
      }),
      zone({
        id: 'z2',
        name: '201 教室',
        buildingId: 'b1',
        floor: 1,
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 8 },
      }),
      zone({
        id: 'z3',
        name: '独立门卫室',
        bounds: { minX: 30, maxX: 36, minY: 30, maxY: 34 },
      }),
    ]);
    expect(buildings).toHaveLength(2);
    const b1 = buildings.find(b => b.buildingId === 'b1')!;
    expect(b1.floors.map(f => f.floor)).toEqual([0, 1]);
    expect(b1.floors[0].boxes).toHaveLength(1);
    expect(b1.floors[0].extrusions).toHaveLength(0);
    const solo = buildings.find(b => b.buildingId !== 'b1')!;
    expect(solo.name).toBe('独立门卫室');
    expect(solo.bbox).toEqual({ minX: 30, maxX: 36, minZ: 30, maxZ: 34 });
  });

  it('falls back to the buildingId when zone names share no stem', () => {
    const buildings = groupZonesByBuilding([
      zone({ id: 'z1', name: '大厅', buildingId: 'lib-01', floor: 0, polygon: RING_A }),
      zone({ id: 'z2', name: '阅览室', buildingId: 'lib-01', floor: 1, polygon: RING_A }),
    ]);
    expect(buildings[0].name).toBe('lib-01');
  });
});

describe('arcPoseFromPose', () => {
  it('roundtrips through the Babylon spherical mapping', () => {
    const extrusions = computeZoneExtrusions([
      zone({ id: 'z1', name: 'A栋-101', buildingId: 'a', polygon: RING_A }),
      zone({ id: 'z2', name: 'B栋-101', buildingId: 'b', polygon: RING_B }),
    ]);
    const bounds = computeSceneBoundsWithExtrusions([], extrusions)!;
    const pose = initialCameraPose(bounds);
    const arc = arcPoseFromPose(pose);
    const offset = arcPoseOffset(arc);
    expect(arc.target).toEqual(pose.target);
    expect(offset.x).toBeCloseTo(pose.position.x - pose.target.x, 6);
    expect(offset.y).toBeCloseTo(pose.position.y - pose.target.y, 6);
    expect(offset.z).toBeCloseTo(pose.position.z - pose.target.z, 6);
    // Elevated diagonal view: beta comfortably inside (0, π/2).
    expect(arc.beta).toBeGreaterThan(0.2);
    expect(arc.beta).toBeLessThan(Math.PI / 2);
  });
});

describe('campusGroundPlan', () => {
  const extrusions = computeZoneExtrusions([
    zone({ id: 'z1', name: 'A栋-101', buildingId: 'a', polygon: RING_A }),
    zone({ id: 'z2', name: 'B栋-101', buildingId: 'b', polygon: RING_B }),
  ]);
  const bounds = computeSceneBoundsWithExtrusions([], extrusions)!;
  const buildings = groupZonesByBuilding([
    zone({ id: 'z1', name: 'A栋-101', buildingId: 'a', polygon: RING_A }),
    zone({ id: 'z2', name: 'B栋-101', buildingId: 'b', polygon: RING_B }),
  ]);

  it('is deterministic for a given seed and differs across seeds', () => {
    const planA = campusGroundPlan(bounds, buildings, 'seed-1');
    const planB = campusGroundPlan(bounds, buildings, 'seed-1');
    const planC = campusGroundPlan(bounds, buildings, 'seed-2');
    expect(planA.trees).toEqual(planB.trees);
    expect(planA.trees).not.toEqual(planC.trees);
  });

  it('scales the ground disc past the scene and keeps trees off buildings', () => {
    const plan = campusGroundPlan(bounds, buildings);
    expect(plan.radius).toBeCloseTo(bounds.radius * 1.8, 6);
    expect(plan.trees.length).toBeGreaterThan(0);
    for (const tree of plan.trees) {
      const distance = Math.hypot(tree.x - plan.center.x, tree.z - plan.center.z);
      expect(distance).toBeLessThanOrEqual(plan.radius);
      for (const building of buildings) {
        const inside =
          tree.x >= building.bbox.minX - 2 &&
          tree.x <= building.bbox.maxX + 2 &&
          tree.z >= building.bbox.minZ - 2 &&
          tree.z <= building.bbox.maxZ + 2;
        expect(inside).toBe(false);
      }
    }
  });

  it('adds a ring road only when the scene is large enough', () => {
    expect(campusGroundPlan(bounds, buildings).roadRing).not.toBeNull();
    const tinyBounds = {
      center: { x: 0, y: 0, z: 0 },
      size: { x: 10, y: 4, z: 10 },
      radius: 8,
    };
    expect(campusGroundPlan(tinyBounds, []).roadRing).toBeNull();
  });
});

describe('hashSeed', () => {
  it('is stable and order-sensitive', () => {
    expect(hashSeed('campus')).toBe(hashSeed('campus'));
    expect(hashSeed('ab')).not.toBe(hashSeed('ba'));
  });
});

describe('hslaToRgb', () => {
  it('parses the zoneVisual heat fill format', () => {
    // Cold end of the temperature scale: hsla(215, 80%, 55%, 0.32).
    const rgb = hslaToRgb('hsla(215, 80%, 55%, 0.32)')!;
    expect(rgb.b).toBeGreaterThan(rgb.r);
    expect(rgb.g).toBeGreaterThan(rgb.r);
    for (const channel of [rgb.r, rgb.g, rgb.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });

  it('handles grey (zero saturation) and rejects non-hsl input', () => {
    const grey = hslaToRgb('hsl(0, 0%, 50%)')!;
    expect(grey.r).toBeCloseTo(0.5, 6);
    expect(grey.r).toBeCloseTo(grey.g, 6);
    expect(grey.g).toBeCloseTo(grey.b, 6);
    expect(hslaToRgb('#fff')).toBeNull();
    expect(hslaToRgb('rgb(1,2,3)')).toBeNull();
  });
});

describe('re-exports', () => {
  it('mirrors building3d primitives (single source of truth)', () => {
    const [box] = computeZoneBoxes([
      zone({
        id: 'z1',
        name: '101 教室',
        bounds: { minX: 0, maxX: 8, minY: 0, maxY: 8 },
      }),
    ]);
    expect(box.color).toBe(ZONE_CATEGORY_COLORS.classroom);
    expect(box.position).toEqual({ x: 4, y: 1.75, z: 4 });
  });
});

// ---------------------------------------------------------------------------
// Phase 2: marker placement / live-channel mapping
// ---------------------------------------------------------------------------

import {
  DEVICE_FAN_OUT_M,
  DEVICE_HOVER_M,
  DEVICE_OFF_COLOR,
  DEVICE_FAULT_COLOR,
  DEVICE_ROLE_COLORS,
  agentPlacements,
  collabEdgesFromSnapshot,
  computePolygonAnchor,
  deviceMarkerColorHex,
  deviceMarkerKind,
  devicePlacements,
  projectGeoPoint,
  sunflowerOffset,
  unprojectGeoPoint,
  zoneCentroidMeters,
  zoneSlabTop,
  type CampusDevicePlacement,
} from '../lib/campus3d';
import type { WorldModelAgent, WorldModelDevice } from '../lib/worldModel';

function device(partial: Partial<WorldModelDevice> & { id: string }): WorldModelDevice {
  return {
    name: partial.id,
    type: 'sensor.temp',
    role: 'sensor',
    capabilities: [],
    zoneId: 'z1',
    position: null,
    latLng: null,
    ownerId: null,
    ownerName: null,
    initialState: null,
    ...partial,
  };
}

function agent(partial: Partial<WorldModelAgent> & { id: string }): WorldModelAgent {
  return {
    name: partial.id,
    capabilities: [],
    boundDeviceIds: [],
    managedZoneIds: [],
    llm: null,
    ownerId: null,
    ownerName: null,
    ...partial,
  };
}

describe('geo marker projection', () => {
  it('anchors a lat/lng marker exactly on the projected footprint centroid', () => {
    const zones = [
      zone({ id: 'z1', name: 'A栋-101', buildingId: 'a', floor: 0, polygon: RING_A }),
    ];
    const anchor = computePolygonAnchor(zones)!;
    // Vertex mean of RING_A — same convention as polygonCentroidOf.
    const centroidLat = RING_A.reduce((s, p) => s + p[0], 0) / RING_A.length;
    const centroidLng = RING_A.reduce((s, p) => s + p[1], 0) / RING_A.length;
    const projected = projectGeoPoint(anchor, centroidLat, centroidLng);
    const [ext] = computeZoneExtrusions(zones);
    expect(projected.x).toBeCloseTo((ext.bbox.minX + ext.bbox.maxX) / 2, 6);
    expect(projected.z).toBeCloseTo((ext.bbox.minZ + ext.bbox.maxZ) / 2, 6);
  });

  it('unprojectGeoPoint roundtrips projectGeoPoint (< 1e-6°)', () => {
    const zones = [zone({ id: 'z1', name: 'A', buildingId: 'a', polygon: RING_A })];
    const anchor = computePolygonAnchor(zones)!;
    for (const [lat, lng] of [...RING_A, [31.0005, 120.0007] as [number, number]]) {
      const meters = projectGeoPoint(anchor, lat, lng);
      const back = unprojectGeoPoint(anchor, meters.x, meters.z);
      expect(Math.abs(back.lat - lat)).toBeLessThan(1e-6);
      expect(Math.abs(back.lng - lng)).toBeLessThan(1e-6);
    }
  });
});

describe('zoneSlabTop', () => {
  it('stacks by floor and honours bounds minZ/maxZ', () => {
    expect(zoneSlabTop(zone({ id: 'z', floor: 2 }), 3.5)).toBe(2 * 3.5 + 3.5);
    expect(
      zoneSlabTop(
        zone({ id: 'z', floor: 1, bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0.5, maxZ: 2 } }),
        3.5,
      ),
    ).toBe(3.5 + 2);
    expect(zoneSlabTop(undefined, 3.5)).toBe(3.5);
  });
});

describe('sunflowerOffset', () => {
  it('keeps the first marker on the anchor and grows the spiral by √k', () => {
    expect(sunflowerOffset(0, DEVICE_FAN_OUT_M)).toEqual({ dx: 0, dz: 0 });
    const first = sunflowerOffset(1, 2);
    const fourth = sunflowerOffset(4, 2);
    expect(Math.hypot(first.dx, first.dz)).toBeCloseTo(2, 6);
    expect(Math.hypot(fourth.dx, fourth.dz)).toBeCloseTo(4, 6);
  });
});

describe('devicePlacements', () => {
  const zones = [
    zone({ id: 'z1', name: 'A栋-101', buildingId: 'a', floor: 0, polygon: RING_A }),
    zone({ id: 'z2', name: 'A栋-201', buildingId: 'a', floor: 1, polygon: RING_A }),
  ];

  it('prefers persisted lat/lng and floats above the zone slab top', () => {
    const [placed] = devicePlacements(
      [device({ id: 'd1', zoneId: 'z2', latLng: { lat: 31.0005, lng: 120.0005 } })],
      zones,
      { storeyHeight: 3.5 },
    );
    expect(placed.centroidFallback).toBe(false);
    // z2 is floor 1, the top floor of building 'a': rooftop = 2 × 3.5.
    expect(placed.position.y).toBeCloseTo(2 * 3.5 + DEVICE_HOVER_M, 6);
    // The lat/lng is the ring center → projected marker sits at the ring center.
    const anchor = computePolygonAnchor(zones)!;
    const expected = projectGeoPoint(anchor, 31.0005, 120.0005);
    expect(placed.position.x).toBeCloseTo(expected.x, 6);
    expect(placed.position.z).toBeCloseTo(expected.z, 6);
  });

  it('hovers low-floor devices above the building ROOFTOP, not their slab top', () => {
    // z1 is floor 0 of the same two-storey building — a per-slab placement
    // (3.5 + hover) would bury the marker inside the opaque stack.
    const [placed] = devicePlacements([device({ id: 'd1', zoneId: 'z1' })], zones, {
      storeyHeight: 3.5,
    });
    expect(placed.position.y).toBeCloseTo(2 * 3.5 + DEVICE_HOVER_M, 6);
  });

  it('maps a persisted builder position from world units (y → z)', () => {
    const [placed] = devicePlacements(
      [device({ id: 'd1', zoneId: 'z1', position: { x: 12, y: 34 } })],
      zones,
    );
    expect(placed.position.x).toBe(12);
    expect(placed.position.z).toBe(34);
  });

  it('fans out co-anchored centroid devices instead of stacking them', () => {
    const placed = devicePlacements(
      [device({ id: 'd1' }), device({ id: 'd2' }), device({ id: 'd3' })],
      zones,
    );
    expect(placed).toHaveLength(3);
    expect(placed.every(p => p.centroidFallback)).toBe(true);
    const distinct = new Set(placed.map(p => `${p.position.x},${p.position.z}`));
    expect(distinct.size).toBe(3);
    // First sibling keeps the exact centroid.
    const anchor = computePolygonAnchor(zones)!;
    const centroid = projectGeoPoint(anchor, 31.0005, 120.0005);
    expect(placed[0].position.x).toBeCloseTo(centroid.x, 6);
    expect(placed[0].position.z).toBeCloseTo(centroid.z, 6);
  });

  it('skips devices whose zone carries no geometry', () => {
    const placed = devicePlacements(
      [device({ id: 'd1', zoneId: 'ghost' })],
      zones,
    );
    expect(placed).toHaveLength(0);
  });

  it('uses bounds centers for non-geo zones', () => {
    const boundsZones = [
      zone({ id: 'z9', floor: 0, bounds: { minX: 10, maxX: 20, minY: 4, maxY: 14 } }),
    ];
    const [placed] = devicePlacements([device({ id: 'd1', zoneId: 'z9' })], boundsZones);
    expect(placed.position.x).toBe(15);
    expect(placed.position.z).toBe(9);
    // No buildingId → falls back to the zone's own slab top.
    expect(placed.position.y).toBeCloseTo(3.5 + DEVICE_HOVER_M, 6);
  });
});

describe('agentPlacements', () => {
  const zones = [
    zone({ id: 'z1', name: 'A栋-101', buildingId: 'a', floor: 0, polygon: RING_A }),
    zone({ id: 'z2', name: 'A栋-201', buildingId: 'a', floor: 1, polygon: RING_A }),
  ];
  const devices = devicePlacements(
    [
      device({ id: 'd1', zoneId: 'z1', latLng: { lat: 31.0002, lng: 120.0002 } }),
      device({ id: 'd2', zoneId: 'z1', latLng: { lat: 31.0008, lng: 120.0008 } }),
    ],
    zones,
  );
  const devicePos = new Map<string, CampusDevicePlacement['position']>(
    devices.map(d => [d.id, d.position]),
  );

  it('anchors at the bound-device centroid (device identity beats zone watch-list)', () => {
    const [placed] = agentPlacements(
      [agent({ id: 'a1', boundDeviceIds: ['d1', 'd2'], managedZoneIds: ['z2'] })],
      devicePos,
      zones,
    );
    const expectedX = (devicePos.get('d1')!.x + devicePos.get('d2')!.x) / 2;
    expect(placed.position.x).toBeCloseTo(expectedX, 6);
    // Mid-storey of the FIRST managed zone (z2, floor 1): 3.5 + 1.75.
    expect(placed.position.y).toBeCloseTo(3.5 + 3.5 / 2, 6);
  });

  it('falls back to managed-zone centroids, then to the scene fallback', () => {
    const [byZone] = agentPlacements([agent({ id: 'a1', managedZoneIds: ['z1'] })], new Map(), zones);
    const anchor = computePolygonAnchor(zones)!;
    const centroid = projectGeoPoint(anchor, 31.0005, 120.0005);
    expect(byZone.position.x).toBeCloseTo(centroid.x, 6);
    const [byFallback] = agentPlacements([agent({ id: 'a2' })], new Map(), zones, {
      fallback: { x: 1, z: 2 },
    });
    expect(byFallback.position.x).toBe(1);
    expect(byFallback.position.z).toBe(2);
    // No fallback and no anchor → honest absence.
    expect(agentPlacements([agent({ id: 'a3' })], new Map(), zones)).toHaveLength(0);
  });

  it('fans out co-anchored agents', () => {
    const placed = agentPlacements(
      [agent({ id: 'a1', managedZoneIds: ['z1'] }), agent({ id: 'a2', managedZoneIds: ['z1'] })],
      new Map(),
      zones,
    );
    expect(placed[0].position.x).not.toBeCloseTo(placed[1].position.x, 6);
  });
});

describe('collabEdgesFromSnapshot', () => {
  it('links agents sharing one active collaboration and maps the status', () => {
    const edges = collabEdgesFromSnapshot([
      { id: 'a1', activeCollaborations: [{ id: 'ac-1', status: 'forming', name: '降温' }] },
      { id: 'a2', activeCollaborations: [{ id: 'ac-1', status: 'forming' }] },
      { id: 'a3', activeCollaborations: [{ id: 'ac-2', status: 'running' }] },
      { id: 'a4', activeCollaborations: [{ id: 'ac-2', status: 'ready' }] },
    ]);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ from: 'a1', to: 'a2', status: 'forming', name: '降温' });
    expect(edges[1]).toMatchObject({ from: 'a3', to: 'a4', status: 'running' });
  });

  it('drops terminal collaborations and agents without peers', () => {
    const edges = collabEdgesFromSnapshot([
      { id: 'a1', activeCollaborations: [{ id: 'ac-1', status: 'completed' }] },
      { id: 'a2', activeCollaborations: [{ id: 'ac-1', status: 'terminated' }] },
      { id: 'a3', activeCollaborations: [{ id: 'ac-9', status: 'running' }] },
    ]);
    expect(edges).toHaveLength(0);
  });

  it('dedupes a self-listing and promotes mixed member states to running', () => {
    const edges = collabEdgesFromSnapshot([
      { id: 'a1', activeCollaborations: [{ id: 'ac-1', status: 'forming' }, { id: 'ac-1', status: 'forming' }] },
      { id: 'a2', activeCollaborations: [{ id: 'ac-1', status: 'running' }] },
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].status).toBe('running');
  });
});

describe('deviceMarkerKind / deviceMarkerColorHex', () => {
  it('maps roles to low-poly kinds', () => {
    expect(deviceMarkerKind('sensor')).toBe('sphere');
    expect(deviceMarkerKind('actuator')).toBe('box');
    expect(deviceMarkerKind('hybrid')).toBe('disc');
    expect(deviceMarkerKind('mystery')).toBe('disc');
  });

  it('fault and off override the role color (2D palette semantics)', () => {
    expect(deviceMarkerColorHex({ role: 'sensor' })).toBe(DEVICE_ROLE_COLORS.sensor);
    expect(deviceMarkerColorHex({ role: 'sensor', fault: true })).toBe(DEVICE_FAULT_COLOR);
    expect(deviceMarkerColorHex({ role: 'actuator', status: 'off' })).toBe(DEVICE_OFF_COLOR);
    expect(deviceMarkerColorHex({ role: 'mystery' })).toBe(DEVICE_ROLE_COLORS.other);
  });
});

// ---------------------------------------------------------------------------
// Phase 5: visual tuning + alert channel
// ---------------------------------------------------------------------------

import {
  ZONE_ALERT_SMOKE,
  ZONE_ALERT_TEMP_C,
  alertingZoneIds,
  saturateHex,
  zoneAlertLevel,
} from '../lib/campus3d';

function hslSaturation(hex: number): number {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  const lightness = (max + min) / 2;
  return delta / (1 - Math.abs(2 * lightness - 1));
}

describe('saturateHex', () => {
  it('lifts saturation without changing hue family or lightness sign', () => {
    const base = ZONE_CATEGORY_COLORS.corridor; // 0x6b7686 — greyish, headroom to lift
    const lifted = saturateHex(base, 0.15);
    expect(hslSaturation(lifted)).toBeGreaterThan(hslSaturation(base));
    // Classroom blue is already at S=1 — saturating is a no-op clamp.
    expect(hslSaturation(saturateHex(ZONE_CATEGORY_COLORS.classroom, 0.15))).toBeCloseTo(1, 6);
  });

  it('leaves greys unchanged and clamps at full saturation', () => {
    expect(saturateHex(0x808080, 0.15)).toBe(0x808080);
    const saturated = saturateHex(0xff0000, 0.15);
    expect(hslSaturation(saturated)).toBeCloseTo(1, 1);
  });
});

describe('zoneAlertLevel / alertingZoneIds', () => {
  it('flags temperature beyond the heat scale top and smoke truthy', () => {
    expect(zoneAlertLevel({ temperature: ZONE_ALERT_TEMP_C })).toBe('critical');
    expect(zoneAlertLevel({ temperature: 34.9 })).toBeNull();
    expect(zoneAlertLevel({ smoke: true })).toBe('critical');
    expect(zoneAlertLevel({ smoke: 0.8 })).toBe('critical');
    expect(zoneAlertLevel({ smoke: false })).toBeNull();
    expect(zoneAlertLevel(undefined)).toBeNull();
    expect(zoneAlertLevel({ occupancy: 12 })).toBeNull();
  });

  it('collects only the alerting zone ids', () => {
    const ids = alertingZoneIds([
      { id: 'z1', parameters: { temperature: 38 } },
      { id: 'z2', parameters: { smoke: true } },
      { id: 'z3', parameters: { temperature: 22 } },
    ]);
    expect([...ids].sort()).toEqual(['z1', 'z2']);
  });
});

// ---------------------------------------------------------------------------
// Adversarial regression — probe-x-campus3d-adversarial.mts findings F1–F7
// ---------------------------------------------------------------------------

/** ~9.5 m × 11 m ring — small enough that the fan-out clamp must bite. */
const RING_SMALL: [number, number][] = [
  [31.0, 120.0],
  [31.0, 120.0001],
  [31.0001, 120.0001],
  [31.0001, 120.0],
];
/** Campus-spanning outdoor envelope ring (~2 km), like campus-assumed 校园室外. */
const RING_OUTDOOR: [number, number][] = [
  [30.99, 119.99],
  [30.99, 120.01],
  [31.01, 120.01],
  [31.01, 119.99],
];
/** Dirty rings: one NaN vertex / string coordinates (server validation bypassed). */
const NAN_RING = [
  [31.002, 120.002],
  [NaN, 120.003],
  [31.003, 120.002],
] as [number, number][];
const STRING_RING = [
  ['31.002', 120.002],
  [31.003, 120.003],
  [31.002, 120.003],
] as unknown as [number, number][];

function poseDistance(pose: { position: Vec3Like; target: Vec3Like }): number {
  return Math.hypot(
    pose.position.x - pose.target.x,
    pose.position.y - pose.target.y,
    pose.position.z - pose.target.z,
  );
}
interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

describe('F1: outdoor envelope zones never extrude', () => {
  it('skips a polygon outdoor zone (same exclusion as computeZoneBoxes)', () => {
    const zones = [
      zone({ id: 'out', name: '校园室外', type: 'outdoor', polygon: RING_OUTDOOR }),
      zone({ id: 'z1', name: 'A栋-101', buildingId: 'a', floor: 0, polygon: RING_A }),
    ];
    // Before the fix the 校园室外 envelope extruded into a campus-wide 3.5 m
    // slab that buried every ground floor and hijacked ground clicks.
    expect(computeZoneExtrusions(zones).map(e => e.zoneId)).toEqual(['z1']);
    // It must not become a pseudo-building either.
    const buildings = groupZonesByBuilding(zones);
    expect(buildings).toHaveLength(1);
    expect(buildings[0].buildingId).toBe('a');
  });
});

describe('F2: initialCameraPose fits the projected scene extent', () => {
  // Opening view direction (1, 0.7, 1): ground diagonal foreshortens by sin θ.
  const SIN_ELEV = 0.7 / Math.hypot(1, 0.7, 1);
  const COS_ELEV = Math.hypot(1, 1) / Math.hypot(1, 0.7, 1);
  const projectedExtent = (size: { x: number; y: number; z: number }) =>
    Math.hypot(size.x, size.z) * SIN_ELEV + size.y * COS_ELEV;

  it('frames a single-building scene fully at the Babylon default fov (0.8 rad)', () => {
    const bounds = { center: { x: 0, y: 2, z: 0 }, size: { x: 40, y: 7, z: 36 }, radius: 27 };
    const distance = poseDistance(initialCameraPose(bounds));
    // The whole projected silhouette fits inside the frame height...
    expect(2 * distance * Math.tan(0.8 / 2)).toBeGreaterThanOrEqual(
      projectedExtent(bounds.size),
    );
    // ...without collapsing to a rooftop close-up.
    expect(distance).toBeGreaterThan(bounds.radius * 1.2);
  });

  it('opens a wide flat campus close enough to read (Taicang scale)', () => {
    // Taicang campus scale: scene radius ~548 m, ground diagonal ~1414 m.
    const bounds = { center: { x: 0, y: 10, z: 0 }, size: { x: 1000, y: 20, z: 1000 }, radius: 548 };
    const distance = poseDistance(initialCameraPose(bounds));
    // Projected-extent fit lands a flat campus at ~1.6× radius; the retired
    // raw-diameter fit (≈2.6× radius, 1430 m) opened past fogStart and shrank
    // 80 m slabs to illegible specks.
    const ratio = distance / bounds.radius;
    expect(ratio).toBeGreaterThan(1.3);
    expect(ratio).toBeLessThan(2);
    expect(2 * distance * Math.tan(0.8 / 2)).toBeGreaterThanOrEqual(
      projectedExtent(bounds.size),
    );
  });
});

describe('F3: smoke alert threshold tracks the engine smoke model', () => {
  it('fires on the measured zone peak of an injected 0.55 event (~0.14)', () => {
    // Engine smoke model (SpatialField): relaxation 0.010/s (~69 s half-life)
    // + diffusion 0.02/s — an injected 0.55 peaks at ~0.14 in the zone reading.
    expect(ZONE_ALERT_SMOKE).toBe(0.08);
    expect(zoneAlertLevel({ smoke: 0.1 })).toBe('critical');
    expect(zoneAlertLevel({ smoke: ZONE_ALERT_SMOKE })).toBe('critical');
    expect(zoneAlertLevel({ smoke: 0.05 })).toBeNull();
    // Boolean smoke events keep firing; temperature semantics unchanged.
    expect(zoneAlertLevel({ smoke: true })).toBe('critical');
    expect(zoneAlertLevel({ temperature: 36 })).toBe('critical');
  });
});

describe('F4: sunflower fan-out is clamped', () => {
  it('clamps the radius at maxRadiusM while the angle keeps advancing', () => {
    const clamped = sunflowerOffset(100, 1.6, 8);
    expect(Math.hypot(clamped.dx, clamped.dz)).toBeCloseTo(8, 6);
    const prev = sunflowerOffset(99, 1.6, 8);
    // The golden angle keeps turning — clamped siblings spread along the ring
    // instead of stacking into one dot.
    expect(Math.hypot(clamped.dx - prev.dx, clamped.dz - prev.dz)).toBeGreaterThan(1);
    // No cap argument → legacy unclamped behavior.
    expect(Math.hypot(...Object.values(sunflowerOffset(4, 2)))).toBeCloseTo(4, 6);
  });

  it('keeps a crowded zone’s devices inside the footprint cap', () => {
    const zones = [zone({ id: 'zs', name: '门卫室', floor: 0, polygon: RING_SMALL })];
    const placed = devicePlacements(
      Array.from({ length: 20 }, (_, i) => device({ id: `d${i}`, zoneId: 'zs' })),
      zones,
    );
    expect(placed).toHaveLength(20);
    const anchor = computePolygonAnchor(zones)!;
    const centroid = projectGeoPoint(anchor, 31.00005, 120.00005);
    for (const p of placed) {
      const d = Math.hypot(p.position.x - centroid.x, p.position.z - centroid.z);
      // cap = max(0.4 × half-diagonal ≈ 2.9 m, 2 × 1.6 m) = 3.2 m; the
      // unclamped spiral would reach 1.6·√19 ≈ 7 m — off the ~11 m slab.
      expect(d).toBeLessThanOrEqual(3.2 + 1e-6);
    }
    const distinct = new Set(placed.map(p => `${p.position.x},${p.position.z}`));
    expect(distinct.size).toBe(20);
  });

  it('clamps co-anchored agents to the managed zone footprint', () => {
    const zones = [zone({ id: 'zs', name: '门卫室', floor: 0, polygon: RING_SMALL })];
    const placed = agentPlacements(
      Array.from({ length: 30 }, (_, i) => agent({ id: `a${i}`, managedZoneIds: ['zs'] })),
      new Map(),
      zones,
    );
    expect(placed).toHaveLength(30);
    const anchor = computePolygonAnchor(zones)!;
    const centroid = projectGeoPoint(anchor, 31.00005, 120.00005);
    for (const p of placed) {
      const d = Math.hypot(p.position.x - centroid.x, p.position.z - centroid.z);
      // cap = max(0.4 × half-diagonal ≈ 2.9 m, 2 × 3.0 m) = 6 m; unclamped
      // k=29 would sit at 3·√29 ≈ 16 m — hovering over the neighbour roof.
      expect(d).toBeLessThanOrEqual(6 + 1e-6);
    }
  });
});

describe('F5: dirty polygons fail safe, not deadly', () => {
  it('a NaN vertex does not poison the shared anchor, bboxes or camera pose', () => {
    const zones = [
      zone({ id: 'bad', name: '脏数据区', polygon: NAN_RING }),
      zone({ id: 'z1', name: 'A栋-101', buildingId: 'a', floor: 0, polygon: RING_A }),
    ];
    const anchor = computePolygonAnchor(zones)!;
    expect(anchor.lat).toBeCloseTo(31.0005, 6);
    expect(anchor.lng).toBeCloseTo(120.0005, 6);
    expect(computeZoneExtrusions(zones).map(e => e.zoneId)).toEqual(['z1']);
    const bounds = computeSceneBoundsWithExtrusions(
      [],
      computeZoneExtrusions(zones),
    )!;
    expect(Number.isFinite(bounds.radius)).toBe(true);
    expect(Object.values(initialCameraPose(bounds).position).every(Number.isFinite)).toBe(true);
  });

  it('string coordinates are rejected the same way', () => {
    const zones = [
      zone({ id: 'bad', name: '脏数据区', polygon: STRING_RING }),
      zone({ id: 'z1', name: 'A栋-101', buildingId: 'a', floor: 0, polygon: RING_A }),
    ];
    expect(computeZoneExtrusions(zones).map(e => e.zoneId)).toEqual(['z1']);
    expect(computePolygonAnchor(zones)!.lat).toBeCloseTo(31.0005, 6);
  });

  it('zoneCentroidMeters falls back to bounds instead of returning NaN', () => {
    const dirty = zone({
      id: 'bad',
      polygon: NAN_RING,
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 8 },
    });
    expect(zoneCentroidMeters(dirty, { lat: 31.0005, lng: 120.0005 })).toEqual({ x: 5, z: 4 });
  });
});

describe('F6: hslaToRgb contract', () => {
  it('returns null for degenerate-but-regex-matching channels', () => {
    expect(hslaToRgb('hsl(120, .%, 50%)')).toBeNull();
    expect(hslaToRgb('hsl(., 50%, 50%)')).toBeNull();
    expect(hslaToRgb('hsl(120, 50%, 50%)')).not.toBeNull();
  });
});

describe('F7: devicePlacements coordinate defense', () => {
  const zones = [zone({ id: 'z1', name: 'A栋-101', buildingId: 'a', floor: 0, polygon: RING_A })];

  it('a string position.x falls back to the zone centroid instead of throwing', () => {
    const [placed] = devicePlacements(
      [device({ id: 'd1', zoneId: 'z1', position: { x: '12' as unknown as number, y: 34 } })],
      zones,
    );
    expect(placed.centroidFallback).toBe(true);
    const anchor = computePolygonAnchor(zones)!;
    const centroid = projectGeoPoint(anchor, 31.0005, 120.0005);
    expect(placed.position.x).toBeCloseTo(centroid.x, 6);
    expect(placed.position.z).toBeCloseTo(centroid.z, 6);
  });

  it('a NaN latLng falls back to the zone centroid', () => {
    const [placed] = devicePlacements(
      [device({ id: 'd1', zoneId: 'z1', latLng: { lat: NaN, lng: 120.0005 } })],
      zones,
    );
    expect(placed.centroidFallback).toBe(true);
    expect(Number.isFinite(placed.position.x)).toBe(true);
    expect(Number.isFinite(placed.position.z)).toBe(true);
  });

  it('a device anchored on a dirty-polygon zone is skipped, not NaN', () => {
    const dirtyZones = [zone({ id: 'bad', name: '脏数据区', polygon: NAN_RING }), ...zones];
    expect(devicePlacements([device({ id: 'd1', zoneId: 'bad' })], dirtyZones)).toHaveLength(0);
  });
});

describe('UX-W4: buildingEntryZoneId (进入室内 1F 规则)', () => {
  const tower = [
    zone({ id: 'a-f2', name: 'A栋-301', buildingId: 'building-a', floor: 2, polygon: RING_A }),
    zone({ id: 'a-f0', name: 'A栋-101', buildingId: 'building-a', floor: 0, polygon: RING_A }),
    zone({ id: 'a-f1', name: 'A栋-201', buildingId: 'building-a', floor: 1, polygon: RING_A }),
  ];

  it('picks the minimum-floor zone of the same building (geo polygon zones)', () => {
    expect(buildingEntryZoneId(tower, 'building-a', 'a-f2')).toBe('a-f0');
  });

  it('applies the same rule to grid/bounds zones (no polygon)', () => {
    const grid = [
      zone({ id: 'g-f1', name: '楼-2F', buildingId: 'g', floor: 1, bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 } }),
      zone({ id: 'g-f0', name: '楼-1F', buildingId: 'g', floor: 0, bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 } }),
    ];
    expect(buildingEntryZoneId(grid, 'g', 'g-f1')).toBe('g-f0');
  });

  it('falls back to the clicked zone when no zone declares that buildingId (solo pseudo-building)', () => {
    const solo = [zone({ id: 'z1', name: '独栋', floor: 3, polygon: RING_A })];
    expect(buildingEntryZoneId(solo, '__solo__:z1', 'z1')).toBe('z1');
  });

  it('ignores zones of other buildings', () => {
    const zones = [
      ...tower,
      zone({ id: 'b-f0', name: 'B栋-101', buildingId: 'building-b', floor: 0, polygon: RING_B }),
    ];
    expect(buildingEntryZoneId(zones, 'building-b', 'b-f0')).toBe('b-f0');
  });
});

describe('UX-W4: placementFloorY (楼层 raycast 平面高度)', () => {
  it('floor 0 raycasts the ground plane (today\'s behavior degenerates naturally)', () => {
    expect(placementFloorY(0, 3.5)).toBe(0);
  });

  it('floor N raycasts that storey\'s walking surface = N × storeyHeight', () => {
    expect(placementFloorY(2, 3.5)).toBe(7);
    expect(placementFloorY(3, 4.2)).toBeCloseTo(12.6, 10);
  });
});
