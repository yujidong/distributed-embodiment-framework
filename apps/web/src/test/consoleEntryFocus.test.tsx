/**
 * R84-F6 (P2):「进入世界仿真」在专注模式遗留下的静默失败。
 *
 * 专注模式（focus）持久化在 localStorage；用户在控制台开了专注模式 → 返回
 * 世界视图 → 再点「进入世界仿真」时，控制台以双抽屉隐藏的状态重开——Agent
 * 对话面板（世界会话的主 NL 入口）不在 DOM，且全程无任何提示，探索者两轮
 * 都读作"按钮静默无效"（退出专注后"自愈"）。
 *
 * 修复：新鲜控制台挂载不再以专注模式起步（loadConsoleLayoutForEntry 剥离
 * focus 并回写收敛存储）。本测试断言：即使 localStorage 里存着 focus:true，
 * SimulationView 挂载后右抽屉（含 Agent 对话 section）照常渲染、专注开关
 * 显示「专注模式」而非「退出专注」、存储被收敛为 focus:false。
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScenarioDefinition } from '../api/types';
import { SimulationView } from '../pages/SimulationView';
import i18n from '../i18n/config';
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

// reactflow（WorldMap 画布）在 jsdom 里需要测量 API——本测试不断言地图本身。
vi.mock('../components/worldmap/WorldMap', () => ({
  WorldMap: () => <div data-testid="world-map" />,
}));

// EnvSeriesPanel 的 echarts 挂载在 jsdom 无意义。
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

const LAYOUT_KEY = 'ac.consoleLayout.v3';

beforeEach(() => {
  // jsdom 无 WebSocket——事件流允许失败，这里给个立即关闭的桩。
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
  // UX-W1: jsdom 默认视口 1024 命中抽屉断点（无持久化布局时右抽屉默认收起）
  // ——本套件断言右抽屉/Agent 对话默认在场，钉宽视口。
  vi.stubGlobal('innerWidth', 1440);
  window.localStorage.clear();
  void i18n.changeLanguage('zh-CN');
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

describe('R84-F6: 控制台重进不再以专注模式起步', () => {
  it('localStorage 存了 focus:true 时，挂载后抽屉/对话面板照常渲染', async () => {
    window.localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ rightOpen: true, eventOpen: false, focus: true, panels: { chat: true } }),
    );

    const { container } = renderWithProviders(<SimulationView />);
    await screen.findByTestId('world-map');

    // 根节点不带 focus class，专注开关回到「专注模式」（未激活态）。
    expect(container.querySelector('.simulation-view--focus')).toBeNull();
    expect(screen.getByRole('button', { name: '专注模式' })).toBeTruthy();
    // 右抽屉与 Agent 对话 section（世界会话主 NL 入口）在 DOM 中。
    expect(container.querySelector('.console-drawer')).not.toBeNull();
    expect(screen.getByText('Agent 对话')).toBeTruthy();
    // 存储被收敛：后续普通 load 不会再武装专注模式。
    expect(window.localStorage.getItem(LAYOUT_KEY)).toContain('"focus":false');
  });

  it('未持久化专注模式时行为不变（默认布局）', async () => {
    const { container } = renderWithProviders(<SimulationView />);
    await screen.findByTestId('world-map');

    expect(container.querySelector('.simulation-view--focus')).toBeNull();
    expect(container.querySelector('.console-drawer')).not.toBeNull();
    expect(screen.getByText('Agent 对话')).toBeTruthy();
  });
});
