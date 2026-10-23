/**
 * UX-W4 interior live-layer tests:
 * - lib/interior3d/liveOverlay: snapshot zones → temp/co2/occupancy/alert
 *   maps (alert semantics shared with campus zoneAlertLevel), and
 *   recentDecisions → deduped toast events;
 * - lib/interior3d/roomLiveCard: devices-in-room point filtering and the
 *   E-card assembly shape.
 */

import { describe, expect, it } from 'vitest';

import {
  liveMapsFromZones,
  recentEventsFromDecisions,
} from '../lib/interior3d/liveOverlay';
import { assembleRoomCard, devicesInRoom } from '../lib/interior3d/roomLiveCard';
import type { InteriorDevice, RasterInterior } from '../components/interior/types';

describe('liveMapsFromZones', () => {
  it('extracts temperature / co2 / occupancy and flags campus-semantics alerts', () => {
    const maps = liveMapsFromZones([
      { id: 'z1', parameters: { temperature: 24.5, co2: 640, occupancy: 12 } },
      { id: 'z2', parameters: { temperature: 36 } }, // ≥ 35 °C → critical
      { id: 'z3', parameters: { smoke: true } },
      { id: 'z4', parameters: { smoke: 0.05, occupancy: 0 } }, // 低烟不告警；0 人数仍记录
      { id: 'z5' }, // 无参数 → 全部缺席（诚实，不造假 0）
    ]);
    expect(maps.tempByZone).toEqual({ z1: 24.5, z2: 36 });
    expect(maps.co2ByZone).toEqual({ z1: 640 });
    expect(maps.occupancyByZone).toEqual({ z1: 12, z4: 0 });
    expect(maps.alertByZone).toEqual({ z2: 'critical', z3: 'critical' });
  });
});

describe('recentEventsFromDecisions', () => {
  it('dedupes by eventId keeping first-seen order and zoneId', () => {
    const events = recentEventsFromDecisions([
      { eventId: 'e1', eventType: 'smoke_detected', zoneId: 'z1' },
      { eventId: 'e2', eventType: 'temperature_spike' },
      { eventId: 'e1', eventType: 'smoke_detected', zoneId: 'z1' }, // 重复决策同一事件
    ]);
    expect(events).toEqual([
      { id: 'e1', type: 'smoke_detected', zoneId: 'z1' },
      { id: 'e2', type: 'temperature_spike' },
    ]);
  });
});

describe('roomLiveCard', () => {
  const raster: Pick<RasterInterior, 'rooms'> = {
    rooms: [
      {
        code: 'A-301',
        name: '实验室',
        color: [0.8, 0.8, 0.9],
        boxes: [
          [10, 10, 8, 6],
          [20, 10, 4, 6], // L 形第二条带
        ],
        zoneId: 'bldg-a-f3',
      },
      { code: 'A-302', name: '办公', color: [0.9, 0.8, 0.8], boxes: [[40, 10, 8, 6]] },
    ],
  };
  const devices: InteriorDevice[] = [
    { id: 'd1', name: '温感 1', type: 'temperature-sensor', x: 8, z: 9, on: true },
    { id: 'd2', name: '空调 1', type: 'hvac', x: 20.5, z: 12, on: false }, // 第二条带内
    { id: 'd3', name: '温感 2', type: 'temperature-sensor', x: 40, z: 10, on: true }, // A-302
    { id: 'd4', name: '走廊灯', type: 'light', x: 30, z: 30, on: true }, // 无房间
  ];

  it('filters devices by room boxes (multi-strip rooms included)', () => {
    expect(devicesInRoom(raster, 'A-301', devices).map(d => d.id)).toEqual(['d1', 'd2']);
    expect(devicesInRoom(raster, 'A-302', devices).map(d => d.id)).toEqual(['d3']);
    expect(devicesInRoom(raster, 'NOPE', devices)).toEqual([]);
  });

  it('assembles the E-card payload (live + devices)', () => {
    const card = assembleRoomCard({
      code: 'A-301',
      raster,
      devices,
      live: { tempC: 25.5, co2: 700, occupancy: 6, alert: true },
    });
    expect(card.code).toBe('A-301');
    expect(card.live).toEqual({ tempC: 25.5, co2: 700, occupancy: 6, alert: true });
    expect(card.devices.map(d => d.id)).toEqual(['d1', 'd2']);
  });
});
