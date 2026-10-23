/**
 * R31 QW1/QW3 — 协作边数组 identity 稳定性（SimulationView）：
 *
 * - QW1：`renderedCollabEdges` 必须是 useMemo —— 无关状态重渲染（专注模
 *   式开关、抽屉开关等）不得改变传给地图层的 collabEdges 引用，否则
 *   buildGraph 的 memo 失效、geo 覆盖层全量重建；
 * - QW3：1s 墙钟 ticker 只在派生边集真正变化（age-out）时推进
 *   `collabNow` —— 无变化的秒针不得触发任何重渲染（captures 不增）。
 */

import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScenarioDefinition, SystemEventDto } from '../api/types';
import { SimulationView } from '../pages/SimulationView';
import i18n from '../i18n/config';
import type { CollabEdge } from '../lib/collabGraph';
import { toLogEntry } from '../lib/eventLog';
import { useAppStore } from '../store/useAppStore';
import { makeSnapshot } from './fixtures';
import { renderWithProviders } from './testUtils';

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return {
    ...mod,
    getSnapshot: vi.fn(async () => SNAP),
    pauseSimulation: vi.fn(async () => ({ id: 'sim-1', state: 'paused' })),
    getSimulationCollaborations: vi.fn(async () => []),
  };
});

/** 捕获每次渲染传给 WorldMap 的 collabEdges 引用。 */
const captures: Array<readonly CollabEdge[]> = [];
vi.mock('../components/worldmap/WorldMap', () => ({
  WorldMap: (props: { collabEdges?: readonly CollabEdge[] }) => {
    captures.push(props.collabEdges ?? []);
    return <div data-testid="world-map" />;
  },
}));

vi.mock('../lib/echarts', () => ({
  useECharts: vi.fn(() => () => undefined),
  chartPalette: () => ({
    text: '#fff',
    textDim: '#999',
    axisLine: '#333',
    splitLine: '#333',
    panelBg: '#111',
    border: '#333',
    accent: '#4cc2ff',
    ok: '#3fb950',
    danger: '#f2555a',
    actuator: '#f5a524',
    series: ['#f2555a'],
  }),
}));

const SCENARIO: ScenarioDefinition = {
  version: '1.0',
  meta: { id: 'starter-home', name: '十分钟最小世界', description: '最小的可跑世界' },
  zones: [
    {
      id: 'living-room',
      name: '客厅',
      type: 'living-room',
      bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 },
      adjacentZoneIds: [],
    },
  ],
  devices: [],
  agents: [
    {
      id: 'butler',
      name: '小管家',
      capabilities: ['temperature-control'],
      managesZoneIds: ['living-room'],
      boundDeviceIds: [],
    },
  ],
  events: [],
};

const SNAP = makeSnapshot({
  state: 'paused',
  simTimeSec: 0,
  zones: [{ id: 'living-room', name: '客厅', parameters: { temperature: 26 } }],
  agents: [],
});

/** 一条刚发生的协作事件（wall now）——派生出 forming 边 a→b。 */
function collabEvent(now: number): SystemEventDto {
  return {
    id: 'evt-1',
    type: 'collaboration.started',
    source: 'ac',
    timestamp: new Date(now).toISOString(),
    payload: { collaborationId: 'ac-1', initiatorId: 'agent-a', participantIds: ['agent-b'] },
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'WebSocket',
    class {
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close() {}
    },
  );
  window.localStorage.clear();
  captures.length = 0;
  void i18n.changeLanguage('zh-CN');
  const entry = toLogEntry(collabEvent(Date.now()));
  useAppStore.setState({
    user: null,
    world: null,
    currentScenario: SCENARIO,
    simulationId: 'sim-1',
    simulationInfo: null,
    simulationSource: 'scenario',
    simulationError: null,
    snapshot: SNAP,
    streamStatus: 'idle',
    eventLog: [entry],
    triggerHints: {},
    replayBuffer: [],
    replayTimes: [],
    replayActive: false,
    replayCursor: 0,
    replayPlaying: false,
    replaySpeed: 1,
    selectedAgentId: null,
    toasts: [],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  useAppStore.setState({ currentScenario: null, simulationId: null, snapshot: null, eventLog: [] });
});

describe('SimulationView 协作边 memoization (R31)', () => {
  it('QW1: 无关重渲染不改变 collabEdges 引用（focus 切换）', async () => {
    renderWithProviders(<SimulationView />);
    await screen.findByTestId('world-map');

    const first = captures[0];
    expect(first).toBeDefined();
    expect(first.length).toBe(1);
    expect(first[0]!.source).toBe('agent-a');
    const rendersBefore = captures.length;

    // 无关状态变化：专注模式（'f'）——布局切换，协作数据完全不变。
    fireEvent.keyDown(window, { key: 'f' });
    await screen.findByTestId('world-map');

    expect(captures.length).toBeGreaterThan(rendersBefore); // 确实重渲染了
    for (const captured of captures) {
      expect(captured).toBe(first); // 引用稳定
    }
  });

  it('QW1: 回放模式下传递空数组且引用稳定', async () => {
    useAppStore.setState({ replayActive: true });
    renderWithProviders(<SimulationView />);
    await screen.findByTestId('world-map');

    const first = captures[0];
    expect(first).toBeDefined();
    expect(first.length).toBe(0);
    fireEvent.keyDown(window, { key: 'f' });
    await screen.findByTestId('world-map');
    for (const captured of captures) {
      expect(captured).toBe(first);
    }
  });

  it('QW3: 无变化的秒针零重渲染；边 age-out 后清空并停表', () => {
    vi.useFakeTimers();
    const now = Date.now();
    // 一条 29.5s 前的 started 事件：forming 边还在 30s ACTIVE_KEEP 窗口内
    // （beforeEach 里那条“刚发生”的事件被替换掉）。
    useAppStore.setState({ eventLog: [toLogEntry(collabEvent(now - 29_500))] });
    renderWithProviders(<SimulationView />);
    // 假定时器下 RTL 的 findBy 会挂起——同步断言（首帧即渲染地图）。
    expect(screen.getByTestId('world-map')).toBeTruthy();

    const first = captures[0];
    expect(first).toBeDefined();
    expect(first.length).toBe(1);
    const rendersWithEdge = captures.length;

    // 第 1 秒：边仍在窗口内（30.5s > 30s？不——29.5+1=30.5s 已出窗）。
    // 先推进 400ms：边龄 29.9s，仍在窗口 ⇒ 派生集无变化 ⇒ 零重渲染。
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(captures.length).toBe(rendersWithEdge);

    // 再推进 600ms（合计 1s）：边龄 30.5s，越过 keep 窗口 ⇒ 集合清空，
    // 恰好一次重渲染，传递空集。
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(captures.length).toBe(rendersWithEdge + 1);
    expect(captures[captures.length - 1]!.length).toBe(0);

    // 之后边集已空 ⇒ ticker 卸载；再走几秒也没有任何渲染。
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(captures.length).toBe(rendersWithEdge + 1);
  });
});
