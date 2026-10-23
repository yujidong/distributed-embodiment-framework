/**
 * R31 QW2 — setSnapshot 新鲜度守卫（F6）：
 *
 * REST 轮询与 WS 常投递同一 tick（WS 先到）。修复前 setSnapshot 无条件
 * 替换：内容相同、identity 全新（两条路径都 JSON.parse）⇒ 整个控制台
 * 重渲染一遍。守卫语义：
 *
 * - 同 tick + 同 state ⇒ 跳过（引用不变，replayBuffer 不追加）；
 * - 更新 tick（或同 tick 更晚 simTimeSec）⇒ 应用；
 * - 更旧 tick（迟到轮询）⇒ 跳过，防倒退；
 * - 同 tick 但 state 变化（pause/stop 在冻结 tickCount 下落地）⇒ 应用。
 */

import { afterEach, describe, expect, it } from 'vitest';

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

describe('setSnapshot freshness guard (R31 QW2)', () => {
  it('首包（当前为空）无条件应用', () => {
    resetStore();
    const first = makeSnapshot({ tickCount: 5, simTimeSec: 50 });
    useAppStore.getState().setSnapshot(first);
    expect(useAppStore.getState().snapshot).toBe(first);
    expect(useAppStore.getState().replayBuffer).toHaveLength(1);
  });

  it('同 tick 同 state：跳过（WS 已交付该 tick 的轮询重复包）', () => {
    resetStore();
    const ws = makeSnapshot({ tickCount: 5, simTimeSec: 50, state: 'running' });
    useAppStore.getState().setSnapshot(ws);

    // 模拟 REST 轮询返回同一 tick：全新对象图（JSON.parse），同内容。
    const poll = makeSnapshot({ tickCount: 5, simTimeSec: 50, state: 'running' });
    useAppStore.getState().setSnapshot(poll);

    const state = useAppStore.getState();
    expect(state.snapshot).toBe(ws); // 引用未替换 ⇒ 无重渲染
    expect(state.replayBuffer).toHaveLength(1); // 缓冲也未追加
  });

  it('更新 tick：应用并进 replayBuffer', () => {
    resetStore();
    useAppStore.getState().setSnapshot(makeSnapshot({ tickCount: 5, simTimeSec: 50 }));
    const next = makeSnapshot({ tickCount: 6, simTimeSec: 60 });
    useAppStore.getState().setSnapshot(next);

    const state = useAppStore.getState();
    expect(state.snapshot).toBe(next);
    expect(state.replayBuffer).toHaveLength(2);
  });

  it('同 tick 更晚 simTimeSec：应用（speed 变化合法）', () => {
    resetStore();
    useAppStore.getState().setSnapshot(makeSnapshot({ tickCount: 5, simTimeSec: 50 }));
    const next = makeSnapshot({ tickCount: 5, simTimeSec: 55 });
    useAppStore.getState().setSnapshot(next);
    expect(useAppStore.getState().snapshot).toBe(next);
  });

  it('更旧 tick（迟到轮询）：跳过，不倒退', () => {
    resetStore();
    const fresh = makeSnapshot({ tickCount: 7, simTimeSec: 70 });
    useAppStore.getState().setSnapshot(fresh);
    useAppStore.getState().setSnapshot(makeSnapshot({ tickCount: 6, simTimeSec: 60 }));
    expect(useAppStore.getState().snapshot).toBe(fresh);
  });

  it('同 tick 但 state 变化（pause/stop 冻结 tick）：应用', () => {
    resetStore();
    useAppStore.getState().setSnapshot(makeSnapshot({ tickCount: 5, simTimeSec: 50, state: 'running' }));
    const paused = makeSnapshot({ tickCount: 5, simTimeSec: 50, state: 'paused' });
    useAppStore.getState().setSnapshot(paused);
    expect(useAppStore.getState().snapshot).toBe(paused);
  });
});
