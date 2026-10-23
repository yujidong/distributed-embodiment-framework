/**
 * R31 SF10 — WS delta 帧消费端：
 *
 * - parseStreamMessage 解析扁平 zone-delta / device-delta 帧（拒收畸形）；
 * - store.applyZoneDelta / applyDeviceDelta 作用域更新：只动受影响的
 *   zone/device 对象，其余条目与 devices/zones 数组引用保留 ⇒ buildGraph
 *   的 per-node data 缓存只重渲染受影响节点；
 * - 同值帧、未知 id、无基线快照 ⇒ no-op（identity 不变，零重渲染）；
 * - 投影快照推进 simTimeSec 且进 replayBuffer（同 tick 同时间去重）；
 * - 与 REST 轮询协同：delta 投影后，同 tick 更旧/相等的轮询包被 F6 守卫
 *   跳过。
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { DeviceDeltaFrame, ZoneDeltaFrame } from '../api/types';
import { parseStreamMessage } from '../lib/stream';
import { useAppStore } from '../store/useAppStore';
import { makeSnapshot } from './fixtures';

function resetStore() {
  useAppStore.setState({
    snapshot: null,
    replayBuffer: [],
    replayTimes: [],
    replayActive: false,
    replayCursor: 0,
    replayPlaying: false,
    replaySpeed: 1,
  });
}

afterEach(() => resetStore());

const ZONE_DELTA: ZoneDeltaFrame = {
  kind: 'zone-delta',
  zoneId: 'zone-a',
  param: 'temperature',
  oldValue: 26,
  newValue: 27,
  simTimeSec: 55,
};

const DEVICE_DELTA: DeviceDeltaFrame = {
  kind: 'device-delta',
  deviceId: 'dev-1',
  changedFields: { power: { from: 10, to: 42 } },
  simTimeSec: 56,
};

describe('parseStreamMessage delta lane (R31 SF10)', () => {
  it('解析扁平 zone-delta 帧并归一化到 data 包装', () => {
    const message = parseStreamMessage(ZONE_DELTA);
    expect(message).toEqual({ kind: 'zone-delta', data: ZONE_DELTA });
  });

  it('解析扁平 device-delta 帧', () => {
    const message = parseStreamMessage(DEVICE_DELTA);
    expect(message).toEqual({ kind: 'device-delta', data: DEVICE_DELTA });
  });

  it('畸形 delta 帧返回 null（缺字段 / 错类型）', () => {
    expect(parseStreamMessage({ kind: 'zone-delta', zoneId: 'z', param: 't', simTimeSec: 1 })).toBeNull();
    expect(
      parseStreamMessage({ kind: 'zone-delta', zoneId: 'z', param: 't', oldValue: 1, newValue: 'x', simTimeSec: 1 }),
    ).toBeNull();
    expect(parseStreamMessage({ kind: 'device-delta', deviceId: 'd', simTimeSec: 1 })).toBeNull();
    expect(parseStreamMessage({ kind: 'device-delta', deviceId: 'd', changedFields: [], simTimeSec: 1 })).toBeNull();
    expect(parseStreamMessage({ kind: 'nonsense' })).toBeNull();
  });

  it('snapshot / event 帧照旧解析（向后兼容）', () => {
    const snap = makeSnapshot();
    expect(parseStreamMessage({ kind: 'snapshot', data: snap })).toEqual({
      kind: 'snapshot',
      data: snap,
    });
    expect(
      parseStreamMessage({ kind: 'event', data: [{ id: 'e1', type: 'device.command', source: 'x' }] }),
    ).toEqual({
      kind: 'event',
      data: [{ id: 'e1', type: 'device.command', source: 'x' }],
    });
  });
});

describe('store.applyZoneDelta (R31 SF10)', () => {
  it('更新单个参数；其余 zone/device 引用全部保留', () => {
    resetStore();
    const base = makeSnapshot({
      tickCount: 5,
      simTimeSec: 50,
      zones: [
        { id: 'zone-a', parameters: { temperature: 26 } },
        { id: 'zone-b', parameters: { temperature: 20 } },
      ],
      devices: [{ id: 'dev-1', name: '灯', type: 'light', role: 'actuator', zoneId: 'zone-a', state: { power: 10 } }],
    });
    useAppStore.getState().setSnapshot(base);

    useAppStore.getState().applyZoneDelta(ZONE_DELTA);

    const next = useAppStore.getState().snapshot!;
    expect(next).not.toBe(base);
    expect(next.simTimeSec).toBe(55);
    expect(next.zones[0]!.parameters.temperature).toBe(27);
    expect(next.zones[0]).not.toBe(base.zones[0]);
    expect(next.zones[1]).toBe(base.zones[1]); // 未触碰 zone 引用保留
    expect(next.devices).toBe(base.devices); // devices 数组原样
    expect(useAppStore.getState().replayBuffer).toHaveLength(2); // 投影进回放缓冲
  });

  it('同值帧与未知 zone ⇒ no-op（identity 不变）', () => {
    resetStore();
    useAppStore.getState().setSnapshot(
      makeSnapshot({
        tickCount: 5,
        simTimeSec: 50,
        zones: [{ id: 'zone-a', parameters: { temperature: 27 } }],
      }),
    );
    const before = useAppStore.getState().snapshot!;
    useAppStore.getState().applyZoneDelta(ZONE_DELTA); // newValue 已是 27
    expect(useAppStore.getState().snapshot).toBe(before);
    useAppStore.getState().applyZoneDelta({ ...ZONE_DELTA, zoneId: 'missing' });
    expect(useAppStore.getState().snapshot).toBe(before);
  });

  it('无基线快照 ⇒ no-op（等初始全量帧）', () => {
    resetStore();
    useAppStore.getState().applyZoneDelta(ZONE_DELTA);
    expect(useAppStore.getState().snapshot).toBeNull();
  });
});

describe('store.applyDeviceDelta (R31 SF10)', () => {
  const BASE_DEVICES = [
    { id: 'dev-1', name: '灯', type: 'light', role: 'actuator', zoneId: 'zone-a', state: { power: 10 } },
    { id: 'dev-2', name: '空调', type: 'ac', role: 'actuator', zoneId: 'zone-a', state: { mode: 'cool' } },
  ];

  function seed() {
    resetStore();
    const base = makeSnapshot({
      tickCount: 5,
      simTimeSec: 50,
      devices: BASE_DEVICES,
    });
    useAppStore.getState().setSnapshot(base);
    return base;
  }

  it('只克隆受影响 device；其余 device 与 zones 引用保留', () => {
    const base = seed();
    useAppStore.getState().applyDeviceDelta(DEVICE_DELTA);

    const next = useAppStore.getState().snapshot!;
    expect(next.devices[0]!.state.power).toBe(42);
    expect(next.devices[0]).not.toBe(base.devices[0]);
    expect(next.devices[0]!.state).not.toBe(base.devices[0]!.state);
    expect(next.devices[1]).toBe(base.devices[1]); // 引用保留 ⇒ 缓存命中
    expect(next.zones).toBe(base.zones);
    expect(next.simTimeSec).toBe(56);
  });

  it('fault 字段走专列；state 字段同值跳过', () => {
    seed();
    useAppStore.getState().applyDeviceDelta({
      kind: 'device-delta',
      deviceId: 'dev-2',
      changedFields: {
        fault: { from: null, to: { kind: 'stuck' } },
        mode: { from: 'cool', to: 'cool' }, // 同值
      },
      simTimeSec: 57,
    } as DeviceDeltaFrame);

    const next = useAppStore.getState().snapshot!;
    expect(next.devices[1]!.fault).toEqual({ kind: 'stuck' });
    expect(next.devices[1]!.state).toBe(BASE_DEVICES[1]!.state); // state 未克隆
  });

  it('全同值帧 ⇒ no-op', () => {
    seed();
    const before = useAppStore.getState().snapshot!;
    useAppStore.getState().applyDeviceDelta({
      kind: 'device-delta',
      deviceId: 'dev-1',
      changedFields: { power: { from: 99, to: 10 } }, // to 与当前相等
      simTimeSec: 58,
    } as DeviceDeltaFrame);
    expect(useAppStore.getState().snapshot).toBe(before);
  });
});

describe('delta 与 REST 轮询协同 (R31 SF10+F6)', () => {
  it('delta 投影后：同 tick 同 simTime 的轮询包被跳过', () => {
    resetStore();
    useAppStore.getState().setSnapshot(
      makeSnapshot({
        tickCount: 5,
        simTimeSec: 50,
        zones: [{ id: 'zone-a', parameters: { temperature: 26 } }],
      }),
    );
    useAppStore.getState().applyZoneDelta(ZONE_DELTA); // → tick 5, simTime 55

    // 轮询回来的还是 tick 5 的旧投影（simTime 50）：非 fresher ⇒ 跳过。
    useAppStore.getState().setSnapshot(
      makeSnapshot({
        tickCount: 5,
        simTimeSec: 50,
        zones: [{ id: 'zone-a', parameters: { temperature: 26 } }],
      }),
    );

    const state = useAppStore.getState();
    expect(state.snapshot!.simTimeSec).toBe(55); // 未被轮询回退
    expect(state.snapshot!.zones[0]!.parameters.temperature).toBe(27);
    expect(state.replayBuffer).toHaveLength(2);
  });

  it('新 tick 的轮询包照常应用（轮询仍是 ground truth）', () => {
    resetStore();
    useAppStore.getState().setSnapshot(
      makeSnapshot({ tickCount: 5, simTimeSec: 50, zones: [{ id: 'zone-a', parameters: { temperature: 26 } }] }),
    );
    useAppStore.getState().applyZoneDelta(ZONE_DELTA);
    const nextTick = makeSnapshot({
      tickCount: 6,
      simTimeSec: 60,
      zones: [{ id: 'zone-a', parameters: { temperature: 28 } }],
    });
    useAppStore.getState().setSnapshot(nextTick);
    expect(useAppStore.getState().snapshot).toBe(nextTick);
  });
});
