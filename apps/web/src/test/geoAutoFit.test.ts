/**
 * UX-08 — geo 视图一次性 auto-fit 的点集并集（lib/geo.ts geoAutoFitPoints）：
 *
 * fitBounds 的输入 = zone polygon 顶点 ∪ 设备锚点（与 CircleMarker 同源）。
 * 旧实现只算 polygon 且在 mount 时跑（容器 0 尺寸 + 数据未就绪 → 视野从未
 * fit）；纯逻辑抽到 lib 后这里钉住并集语义与小面积 zone 不被过滤的纪律。
 * Leaflet 调用本身在组件 effect 里（jsdom 无法实例化矢量渲染器）。
 */

import { describe, expect, it } from 'vitest';

import { geoAutoFitPoints, type LatLng } from '../lib/geo';

const SQUARE = (lat: number, lng: number, size: number): [number, number][] => [
  [lat, lng],
  [lat, lng + size],
  [lat + size, lng + size],
  [lat + size, lng],
];

describe('geoAutoFitPoints (UX-08)', () => {
  it('并集 = polygon 顶点 + 设备锚点', () => {
    const zones = [{ polygon: SQUARE(31.28, 120.59, 0.01) }];
    const devices: LatLng[] = [{ lat: 31.4, lng: 120.7 }];
    const points = geoAutoFitPoints(zones, devices);
    expect(points).toHaveLength(5);
    expect(points.slice(0, 4)).toEqual(SQUARE(31.28, 120.59, 0.01));
    expect(points[4]).toEqual([31.4, 120.7]);
  });

  it('小面积 zone（微型 ring）不过滤——与区域同权进入 fit', () => {
    // ~1 m² 的三角形小卖部和整个街区一起进并集；视野上限由 fit 的
    // maxZoom 兜底，而不是面积阈值。
    const tinyKiosk: [number, number][] = [
      [31.281, 120.591],
      [31.281, 120.59101],
      [31.28101, 120.591],
    ];
    const zones = [
      { polygon: SQUARE(31.28, 120.59, 0.02) },
      { polygon: tinyKiosk },
    ];
    const points = geoAutoFitPoints(zones, []);
    expect(points).toHaveLength(7);
    expect(points.slice(4)).toEqual(tinyKiosk);
  });

  it('无 polygon 的 zone 不贡献点（渲染道同样跳过）', () => {
    const zones = [{ polygon: undefined }, { polygon: null }, { polygon: SQUARE(31.0, 120.0, 0.01) }];
    expect(geoAutoFitPoints(zones, [])).toHaveLength(4);
  });

  it('非有限坐标（NaN / Infinity）被剔除，不污染 bounds', () => {
    const zones = [
      {
        polygon: [
          [31.0, 120.0],
          [NaN, 120.01],
          [31.01, Infinity],
          [31.01, 120.01],
        ] as [number, number][],
      },
    ];
    const devices: LatLng[] = [{ lat: NaN, lng: 120.5 }, { lat: 31.2, lng: 120.5 }];
    const points = geoAutoFitPoints(zones, devices);
    expect(points).toEqual([
      [31.0, 120.0],
      [31.01, 120.01],
      [31.2, 120.5],
    ]);
  });

  it('空世界（无 polygon 无设备）→ 空点集（组件保持 mapData center/zoom）', () => {
    expect(geoAutoFitPoints([], [])).toEqual([]);
    expect(geoAutoFitPoints([{ polygon: undefined }], [])).toEqual([]);
  });

  it('设备锚点接受任意 Iterable（Map.values()）', () => {
    const byId = new Map<string, LatLng>([
      ['d1', { lat: 31.1, lng: 120.1 }],
      ['d2', { lat: 31.2, lng: 120.2 }],
    ]);
    expect(geoAutoFitPoints([], byId.values())).toEqual([
      [31.1, 120.1],
      [31.2, 120.2],
    ]);
  });
});
