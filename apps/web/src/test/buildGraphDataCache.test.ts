/**
 * R31 QW8 — buildGraph 节点 data 缓存（F4/F13）：
 *
 * - 相同输入（model 对象引用、live snapshot 对象引用、覆盖标志、语言）
 *   两次构建 ⇒ 未变化节点的 `data` 引用稳定 ⇒ reactflow 内部 memo 可跳过
 *   这些节点组件的重渲染；
 * - 仅一个 device 的 state 换新引用 ⇒ 只有该 device 的 data 重建，zone 与
 *   其他 device 的 data 复用；
 * - zone 参数换新引用（live zone 对象换新）⇒ 只有该 zone 的 data 重建；
 * - 选择变化只影响被选节点的 data。
 */

import { describe, expect, it, beforeEach } from 'vitest';

import type { EngineSnapshot } from '../api/types';
import { buildGraph, clearGraphNodeDataCaches } from '../components/worldmap/WorldMap';
import { mapColors } from '../lib/theme';
import type { WorldModel } from '../lib/worldModel';

const MODEL: WorldModel = {
  zones: [
    {
      id: 'zone-a',
      name: '客厅',
      type: 'living-room',
      bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 },
      adjacentZoneIds: [],
    },
    {
      id: 'zone-b',
      name: '卧室',
      type: 'bedroom',
      bounds: { minX: 8, maxX: 12, minY: 0, maxY: 5 },
      adjacentZoneIds: [],
    },
  ],
  devices: [
    {
      id: 'dev-1',
      name: '灯',
      type: 'light',
      role: 'actuator',
      capabilities: [],
      zoneId: 'zone-a',
      position: null,
      latLng: null,
      ownerId: null,
      ownerName: null,
      initialState: {},
    },
    {
      id: 'dev-2',
      name: '空调',
      type: 'ac',
      role: 'actuator',
      capabilities: [],
      zoneId: 'zone-b',
      position: null,
      latLng: null,
      ownerId: null,
      ownerName: null,
      initialState: {},
    },
  ],
  agents: [
    {
      id: 'agent-1',
      name: '小管家',
      capabilities: [],
      managedZoneIds: ['zone-a'],
      boundDeviceIds: ['dev-1'],
      llm: null,
      ownerId: null,
      ownerName: null,
    },
  ],
};

function snapshotWith(
  zoneAParams: Record<string, number | boolean>,
  dev1State: Record<string, unknown>,
): EngineSnapshot {
  return {
    runtimeId: 'rt',
    scenarioId: 'sc',
    scenarioName: 's',
    state: 'running',
    simTimeSec: 10,
    simTime: new Date(0).toISOString(),
    speed: 1,
    tickCount: 1,
    zones: [
      { id: 'zone-a', parameters: zoneAParams },
      { id: 'zone-b', parameters: { temperature: 24 } },
    ],
    devices: [
      { id: 'dev-1', name: '灯', type: 'light', role: 'actuator', zoneId: 'zone-a', state: dev1State },
      { id: 'dev-2', name: '空调', type: 'ac', role: 'actuator', zoneId: 'zone-b', state: { power: 1 } },
    ],
    agents: [],
    recentDecisions: [],
    scheduledEvents: [],
  };
}

function options(snapshot: EngineSnapshot) {
  return {
    snapshot,
    highlightZoneIds: new Set<string>(),
    bubbles: [],
    layers: { zones: true, devices: true, agents: true, edges: true },
    selection: null,
    activeDeviceIds: new Set<string>(),
    memberColorById: new Map<string, string>(),
    focusedZoneIds: new Set<string>(),
    focusOwnerId: null,
    dragOverrides: new Map(),
    editable: false,
    collabEdges: [],
    colors: mapColors('dark'),
    crossFloorLinks: new Map<string, string[]>(),
  };
}

function dataById(nodes: ReturnType<typeof buildGraph>['nodes']): Map<string, unknown> {
  return new Map(nodes.map(node => [node.id, node.data]));
}

beforeEach(() => {
  clearGraphNodeDataCaches();
});

describe('buildGraph 节点 data 缓存 (R31 QW8)', () => {
  it('相同输入：全部节点 data 引用稳定', () => {
    const snap = snapshotWith({ temperature: 26 }, { power: 10 });
    const first = buildGraph(MODEL, options(snap));
    const second = buildGraph(MODEL, options(snap));

    const a = dataById(first.nodes);
    const b = dataById(second.nodes);
    expect(first.nodes.length).toBe(5); // 2 zones + 2 devices + 1 agent
    for (const id of ['zone-a', 'zone-b', 'dev-1', 'dev-2', 'agent-1']) {
      expect(b.get(id)).toBe(a.get(id));
    }
  });

  it('单个 device state 换引用：只有该 device 的 data 重建', () => {
    const snap1 = snapshotWith({ temperature: 26 }, { power: 10 });
    const first = buildGraph(MODEL, options(snap1));
    // delta 路径的对象图：只有 dev-1 换新引用，zone 等其余对象全部复用。
    const snap2 = {
      ...snap1,
      devices: [
        { ...snap1.devices[0]!, state: { power: 99 } },
        snap1.devices[1]!,
      ],
    };
    const second = buildGraph(MODEL, options(snap2));

    const a = dataById(first.nodes);
    const b = dataById(second.nodes);
    expect(b.get('dev-1')).not.toBe(a.get('dev-1')); // 变化的重建
    expect((b.get('dev-1') as { tooltipLines: string[] }).tooltipLines).toBeDefined();
    expect(b.get('dev-2')).toBe(a.get('dev-2')); // 其余全部复用
    expect(b.get('zone-a')).toBe(a.get('zone-a'));
    expect(b.get('zone-b')).toBe(a.get('zone-b'));
    expect(b.get('agent-1')).toBe(a.get('agent-1'));
  });

  it('单个 zone 参数换引用：只有该 zone 的 data 重建', () => {
    const snap1 = snapshotWith({ temperature: 26 }, { power: 10 });
    const first = buildGraph(MODEL, options(snap1));
    // delta 路径：只换 zone-a 的 parameters 对象引用。
    const snap2 = {
      ...snap1,
      zones: [{ id: 'zone-a', parameters: { temperature: 30 } }, snap1.zones[1]!],
    };
    const second = buildGraph(MODEL, options(snap2));

    const a = dataById(first.nodes);
    const b = dataById(second.nodes);
    expect(b.get('zone-a')).not.toBe(a.get('zone-a'));
    expect((b.get('zone-a') as { parameters: string[] }).parameters.length).toBeGreaterThan(0);
    expect(b.get('zone-b')).toBe(a.get('zone-b'));
    expect(b.get('dev-1')).toBe(a.get('dev-1'));
    expect(b.get('dev-2')).toBe(a.get('dev-2'));
  });

  it('选择变化只影响被选 device 的 data', () => {
    const snap = snapshotWith({ temperature: 26 }, { power: 10 });
    const base = options(snap);
    const first = buildGraph(MODEL, base);
    const second = buildGraph(MODEL, { ...base, selection: { objectType: 'device', id: 'dev-1' } });

    const a = dataById(first.nodes);
    const b = dataById(second.nodes);
    expect(b.get('dev-1')).not.toBe(a.get('dev-1'));
    expect((b.get('dev-1') as { selected: boolean }).selected).toBe(true);
    expect(b.get('dev-2')).toBe(a.get('dev-2'));
    expect(b.get('zone-a')).toBe(a.get('zone-a'));
  });

  it('消失的 id 被清出缓存（环境切换不留驻留项）', () => {
    const snap = snapshotWith({ temperature: 26 }, { power: 10 });
    buildGraph(MODEL, options(snap));
    const smaller: WorldModel = {
      zones: [MODEL.zones[0]!],
      devices: [MODEL.devices[0]!],
      agents: [],
    };
    const { nodes } = buildGraph(smaller, options(snap));
    expect(nodes.map(n => n.id).sort()).toEqual(['dev-1', 'zone-a']);
  });
});
