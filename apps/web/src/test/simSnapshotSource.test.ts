/**
 * F2/F3 回归：快照数据源选择与 stopped 回落。
 *
 * - lib/simSnapshotSource.pickSnapshotSim：world-session 恒优先（demo sim
 *   id 更短也不得劫持），其后 running > created/paused，id 长度兜底；
 * - useCampusSimSnapshot / useInteriorSimSnapshot：选源接 picker；快照返回
 *   state:'stopped' 连续 N 次后重取 sim 列表回落 world-session。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../api/client';
import type { SimulationListEntry } from '../api/types';
import { useCampusSimSnapshot } from '../hooks/useCampusSimSnapshot';
import { useInteriorSimSnapshot } from '../hooks/useInteriorSimSnapshot';
import { pickSnapshotSim } from '../lib/simSnapshotSource';
import { makeSnapshot } from './fixtures';

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return { ...mod, listSimulations: vi.fn(), getSimulationSnapshot: vi.fn() };
});

const listSimsMock = vi.mocked(api.listSimulations);
const snapshotMock = vi.mocked(api.getSimulationSnapshot);

function sim(overrides: Partial<SimulationListEntry> & { id: string }): SimulationListEntry {
  return {
    scenarioId: 'sc',
    environmentId: 'env-1',
    state: 'running',
    simTimeSec: 0,
    llm: 'rule-only',
    ...overrides,
  } as SimulationListEntry;
}

// 实测形态：demo sim id（51 字符）比 world-session id（54）短，旧排序必输。
const DEMO_SIM = sim({ id: 'x'.repeat(51) });
const WORLD_SESSION = sim({ id: 'sim-env-1-world-session-' + 'y'.repeat(24), kind: 'world-session' });

describe('pickSnapshotSim (F2)', () => {
  it('world-session 恒优先，哪怕 demo sim id 更短且同样 running', () => {
    expect(pickSnapshotSim([DEMO_SIM, WORLD_SESSION], 'env-1')?.id).toBe(WORLD_SESSION.id);
    expect(pickSnapshotSim([WORLD_SESSION, DEMO_SIM], 'env-1')?.id).toBe(WORLD_SESSION.id);
  });

  it('无 world-session 时 running 优先于 created/paused，其余按 id 长度稳定排序', () => {
    const created = sim({ id: 'a'.repeat(10), state: 'created' });
    const running = sim({ id: 'b'.repeat(30), state: 'running' });
    expect(pickSnapshotSim([created, running], 'env-1')?.id).toBe(running.id);
  });

  it('过滤其它环境与 stopped 条目；无候选返回 null', () => {
    const otherEnv = sim({ id: 'c'.repeat(20), environmentId: 'env-2' });
    const stopped = sim({ id: 'd'.repeat(20), state: 'stopped' });
    expect(pickSnapshotSim([otherEnv, stopped], 'env-1')).toBeNull();
  });

  it('进行中的 demoRun 优先于 world-session（hero 事件在 demo sim 里）；结束后回落', () => {
    expect(pickSnapshotSim([DEMO_SIM, WORLD_SESSION], 'env-1', DEMO_SIM.id)?.id).toBe(DEMO_SIM.id);
    // preferredId 不在候选（已停止/其它环境）时不影响排序
    expect(pickSnapshotSim([WORLD_SESSION, DEMO_SIM], 'env-1', 'sim-gone')?.id).toBe(
      WORLD_SESSION.id,
    );
  });
});

describe('useCampusSimSnapshot (F2/F3)', () => {
  beforeEach(() => {
    snapshotMock.mockImplementation(async id => makeSnapshot({ runtimeId: id }) as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('选源优先 world-session：demo sim 在场也不劫持 3D 快照', async () => {
    listSimsMock.mockResolvedValue([DEMO_SIM, WORLD_SESSION]);
    const { result } = renderHook(() => useCampusSimSnapshot('env-1'));

    await waitFor(() => expect(result.current?.runtimeId).toBe(WORLD_SESSION.id));
    expect(snapshotMock).toHaveBeenCalledWith(WORLD_SESSION.id);
    expect(snapshotMock).not.toHaveBeenCalledWith(DEMO_SIM.id);
  });

  it('快照连续 stopped 后重取列表并回落到 world-session（F3）', async () => {
    vi.useFakeTimers();
    try {
      // 初次列表只有 demo sim（world-session 尚未入列）；它的快照已 stopped。
      listSimsMock.mockResolvedValue([DEMO_SIM]);
      snapshotMock.mockImplementation(async id =>
        makeSnapshot({
          runtimeId: id,
          state: id === DEMO_SIM.id ? 'stopped' : 'running',
        }) as never,
      );

      const { result } = renderHook(() => useCampusSimSnapshot('env-1'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // 第一次 stopped：不回落、不渲染死数据。
      expect(snapshotMock).toHaveBeenCalledWith(DEMO_SIM.id);
      expect(result.current).toBeNull();
      expect(listSimsMock).toHaveBeenCalledTimes(1);

      // 第二次轮询（4s 后）达到阈值 → 重取列表，world-session 出现即回落。
      listSimsMock.mockResolvedValue([{ ...DEMO_SIM, state: 'stopped' }, WORLD_SESSION]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(snapshotMock).toHaveBeenCalledWith(WORLD_SESSION.id);
      expect(result.current?.runtimeId).toBe(WORLD_SESSION.id);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useInteriorSimSnapshot (F2)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('选源优先 world-session，overlay 温度来自权威会话', async () => {
    listSimsMock.mockResolvedValue([DEMO_SIM, WORLD_SESSION]);
    snapshotMock.mockImplementation(async id =>
      ({
        runtimeId: id,
        zones: [{ id: 'living-room', parameters: { temperature: 26.5 } }],
        agents: [{ id: 'butler', name: '管家', managedZoneIds: ['living-room'] }],
        simTime: '2026-01-01T00:00:00.000Z',
      }) as never,
    );

    const { result } = renderHook(() => useInteriorSimSnapshot('env-1'));

    await waitFor(() => expect(result.current.tempByZone['living-room']).toBe(26.5));
    expect(snapshotMock).toHaveBeenCalledWith(WORLD_SESSION.id);
    expect(result.current.agents).toEqual([
      { id: 'butler', name: '管家', managedZoneIds: ['living-room'] },
    ]);
  });
});
