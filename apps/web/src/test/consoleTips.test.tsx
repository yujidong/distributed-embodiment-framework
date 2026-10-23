/**
 * W2 控制台首次进入小贴士（SimulationView）：
 *
 * - 首次进入（非 present 模式）显示三点提示（速度 ×60 / 右侧抽屉注入 /
 *   底部「评估」页签）；
 * - 点击「知道了」后提示条消失，且 localStorage 写入
 *   `ac.consoleTips.dismissed=1`；
 * - 已 dismiss（localStorage 有标记）时不再渲染；
 * - 演示模式下不渲染。
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
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

const TIPS_KEY = 'ac.consoleTips.dismissed';

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

describe('SimulationView 首次进入小贴士', () => {
  it('首次进入显示三点提示，dismiss 后消失并写入 localStorage', async () => {
    renderWithProviders(<SimulationView />);

    const tips = await screen.findByTestId('console-tips');
    expect(tips.textContent).toContain('第一次来控制台？');
    expect(tips.textContent).toContain('演示 ×60');
    expect(tips.textContent).toContain('右侧抽屉');
    expect(tips.textContent).toContain('评估');

    fireEvent.click(screen.getByText('知道了'));

    expect(screen.queryByTestId('console-tips')).toBeNull();
    expect(window.localStorage.getItem(TIPS_KEY)).toBe('1');
  });

  it('localStorage 已有 dismiss 标记时不再渲染', async () => {
    window.localStorage.setItem(TIPS_KEY, '1');
    renderWithProviders(<SimulationView />);

    // 等控制台主体渲染出来后再断言提示条缺席。
    await screen.findByTestId('world-map');
    expect(screen.queryByTestId('console-tips')).toBeNull();
  });

  it('演示模式下不渲染，退出后恢复', async () => {
    renderWithProviders(<SimulationView />);

    expect(await screen.findByTestId('console-tips')).toBeTruthy();

    fireEvent.click(screen.getByText('演示模式'));
    expect(screen.queryByTestId('console-tips')).toBeNull();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(await screen.findByTestId('console-tips')).toBeTruthy();
  });
});
