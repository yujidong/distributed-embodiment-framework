import { describe, expect, it } from 'vitest';

import type { EnvZone } from '../../api/types';
import {
  buildInteriorFloor,
  footprintBounds,
  projectPolygon,
  spawnPose,
  wallSegments,
} from './projection';

// 100m x 80m rectangle, north edge at max lat.
const RECT: Array<[number, number]> = [
  [31.0, 121.0],
  [31.0, 121.000898], // ~+100m east
  [30.99928, 121.000898], // ~-80m south
  [30.99928, 121.0],
];

const zone: EnvZone = {
  id: 'bldg-d-f4',
  name: 'D栋 4F',
  polygon: RECT,
  rooms: [
    { code: 'D-4021', name: '办公室', type: 'office', pos: [0.5, 0.5] },
    { code: 'D-4013', name: '会议室', pos: [0.0, 0.0] },
    { name: '无定位房间' }, // skipped
  ],
};

describe('projectPolygon', () => {
  it('projects a lat/lng ring to local meters with the right spans', () => {
    const pts = projectPolygon(RECT);
    const b = footprintBounds(pts);
    // at lat 31 deg, cos(31) shrinks the lng axis
    const eastM = 0.000898 * 111320 * Math.cos((31 * Math.PI) / 180);
    expect(b.maxX - b.minX).toBeCloseTo(eastM, 0);
    expect(b.maxZ - b.minZ).toBeCloseTo(80, -1);
    // x = east, z = south: max-lat maps to min z (north edge)
    const north = pts.filter(p => p.z === b.minZ);
    expect(north.length).toBeGreaterThan(0);
  });
});

describe('buildInteriorFloor', () => {
  it('maps positioned rooms into footprint-local meters', () => {
    const data = buildInteriorFloor(zone)!;
    expect(data.rooms).toHaveLength(2); // unpositioned room dropped
    const center = data.rooms.find(r => r.code === 'D-4021')!;
    expect(center.x).toBeCloseTo((data.bounds.minX + data.bounds.maxX) / 2, 6);
    expect(center.z).toBeCloseTo((data.bounds.minZ + data.bounds.maxZ) / 2, 6);
  });

  it('returns null for zones without a polygon', () => {
    expect(buildInteriorFloor({ ...zone, polygon: undefined })).toBeNull();
  });
});

describe('spawnPose', () => {
  it('spawns at the hinted room and faces the footprint center', () => {
    const data = buildInteriorFloor(zone)!;
    // D-4013 sits at the min corner (u=v=0): center is due southeast; the
    // spans are unequal (85.5m east vs 80m south), so the yaw is atan2 of
    // the half-spans.
    const spawn = spawnPose(data, 'D-4013');
    const halfX = (data.bounds.maxX - data.bounds.minX) / 2;
    const halfZ = (data.bounds.maxZ - data.bounds.minZ) / 2;
    expect(spawn.yaw).toBeCloseTo(Math.atan2(halfX, halfZ), 6);
    const room = data.rooms.find(r => r.code === 'D-4013')!;
    expect(spawn.position.x).toBeGreaterThan(room.x);
  });

  it('falls back to the bbox center without a hint', () => {
    const data = buildInteriorFloor(zone)!;
    const spawn = spawnPose(data);
    expect(spawn.position.x).toBeCloseTo((data.bounds.minX + data.bounds.maxX) / 2, 6);
  });
});

describe('wallSegments', () => {
  it('builds one segment per edge with correct yaw and length', () => {
    const outline = projectPolygon(RECT);
    const segments = wallSegments(outline);
    expect(segments).toHaveLength(4);
    const east = segments[0]; // first edge runs east
    expect(east.length).toBeCloseTo(85.5, 0);
    expect(east.yaw).toBeCloseTo(Math.PI / 2, 5);
  });
});
