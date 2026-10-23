/**
 * R31 QW7 — 活动环序列化缓存（SimulationView F11）：
 *
 * 设备 state 引用未变（WS delta 路径只克隆受影响设备）⇒ 复用缓存序列化，
 * 不触发活动环；引用变了但内容相等 ⇒ 也不触发；内容变化 ⇒ 触发脉冲环。
 */

import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineSnapshot, ScenarioDefinition } from '../api/types';
import { SimulationView } from '../pages/SimulationView';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { makeSnapshot } from './fixtures';
import { renderWithProviders } from './testUtils';

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return {
    ...mod,
    getSnapshot: vi.fn(async () => useAppStore.getState().snapshot ?? SNAP_BASE),
    pauseSimulation: vi.fn(async () => ({ id: 'sim-1', state: 'paused' })),
    getSimulationCollaborations: vi.fn(async () => []),
  };
});

/** 捕获每次渲染的 activeDeviceIds。 */
const captures: Array<ReadonlySet<string>> = [];
vi.mock('../components/worldmap/WorldMap', () => ({
  WorldMap: (props: { activeDeviceIds?: ReadonlySet<string> }) => {
    captures.push(props.activeDeviceIds ?? new Set());
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
  agents: [],
  events: [],
};

function snapshotWith(
  tick: number,
  d1State: Record<string, unknown>,
  d2State: { mode: string },
): EngineSnapshot {
  return makeSnapshot({
    tickCount: tick,
    simTimeSec: tick * 10,
    state: 'running',
    zones: [{ id: 'living-room', name: '客厅', parameters: { temperature: 26 } }],
    devices: [
      { id: 'dev-1', name: '灯', type: 'light', role: 'actuator', zoneId: 'living-room', state: d1State },
      { id: 'dev-2', name: '面板', type: 'panel', role: 'sensor', zoneId: 'living-room', state: d2State },
    ],
    agents: [],
  });
}

const D1_BASE = { power: 10 } as const;
const D2_BASE = { mode: 'auto' };
const SNAP_BASE = snapshotWith(1, D1_BASE, D2_BASE);

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
  useAppStore.setState({
    user: null,
    world: null,
    currentScenario: SCENARIO,
    simulationId: 'sim-1',
    simulationInfo: null,
    simulationSource: 'scenario',
    simulationError: null,
    snapshot: SNAP_BASE,
    streamStatus: 'idle',
    eventLog: [],
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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  useAppStore.setState({ currentScenario: null, simulationId: null, snapshot: null });
});

describe('活动环序列化缓存 (R31 QW7)', () => {
  it('引用未变 / 内容相等的替换都不触发；内容变化触发', async () => {
    renderWithProviders(<SimulationView />);
    await screen.findByTestId('world-map');
    expect(captures[0]).toBeDefined();
    expect(captures[0].size).toBe(0); // 首帧无环

    // tick 2：dev-1 state 引用复用（delta 路径），dev-2 新对象但内容相等。
    act(() => {
      useAppStore.setState({ snapshot: snapshotWith(2, D1_BASE, { mode: 'auto' }) });
    });
    await screen.findByTestId('world-map');
    expect(captures[captures.length - 1].size).toBe(0);

    // tick 3：dev-1 换新引用且内容变化 ⇒ 脉冲环点亮。
    act(() => {
      useAppStore.setState({ snapshot: snapshotWith(3, { power: 42 }, { mode: 'auto' }) });
    });
    await screen.findByTestId('world-map');
    expect(captures[captures.length - 1].has('dev-1')).toBe(true);
  });
});
