/**
 * R14 P1-3 回归：抽屉头条计数与活动指示同口径。
 *
 * 注入的场景事件由 EngineRuntime 定向投递给管理 Agent、从不上事件总线
 * （routed mode），因此 eventLog 可能为空而 snapshot.recentDecisions 持续
 * 刷新 —— 苏州实测出现「最近 0 条事件」与「距上次活动 8s」并存。修复后
 * 头条数的是剧集（由决策播种）+ 显式标注的原始事件数，二者都与活动指示
 * 的数据源一致，不再自相矛盾。
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeDecisionRecord, ScenarioDefinition } from '../api/types';
import { SimulationView } from '../pages/SimulationView';
import i18n from '../i18n/config';
import { toLogEntry } from '../lib/eventLog';
import { useAppStore } from '../store/useAppStore';
import { makeSnapshot } from './fixtures';
import { renderWithProviders } from './testUtils';

const DECISION_AT = new Date().toISOString();

const DECISION: RuntimeDecisionRecord = {
  agentId: 'butler',
  eventId: 'evt-rush-hour',
  eventType: 'environment.param_changed',
  decision: 'initiate_ac',
  decisionSource: 'precheck',
  at: DECISION_AT,
};

const SNAP = makeSnapshot({
  state: 'running',
  simTimeSec: 19200,
  recentDecisions: [DECISION],
  scheduledEvents: [
    { id: 'evt-rush-hour', type: 'traffic-surge', zoneId: 'living-room', atSimTimeSec: 30, fired: true },
  ],
});

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

function setConsoleState(eventLog: ReturnType<typeof toLogEntry>[]): void {
  useAppStore.setState({
    user: null,
    world: null,
    currentScenario: SCENARIO,
    simulationId: 'sim-1',
    simulationInfo: null,
    simulationSource: 'scenario',
    simulationError: null,
    snapshot: SNAP,
    streamStatus: 'open',
    eventLog,
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
}

function headerText(): string {
  const header = document.querySelector('.event-drawer__header');
  expect(header).not.toBeNull();
  return header!.textContent ?? '';
}

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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  useAppStore.setState({ currentScenario: null, simulationId: null, snapshot: null });
});

describe('R14 P1-3 叙事抽屉头条计数口径', () => {
  it('eventLog 为空但决策活跃：头条数剧集而非原始事件（苏州矛盾回归）', async () => {
    setConsoleState([]);
    renderWithProviders(<SimulationView />);
    await screen.findByTestId('world-map');

    const text = headerText();
    // 修复前这里显示「最近 0 条事件」，与控制条「距上次活动 Xs」矛盾。
    expect(text).toContain('1 个剧集');
    expect(text).toContain('0 条原始事件');
  });

  it('总线事件与决策并存：两个计数分别显式标注', async () => {
    setConsoleState([
      toLogEntry({
        id: 'bus-1',
        type: 'custom',
        source: 'test',
        timestamp: DECISION_AT,
        payload: { customType: 'UNRELATED' },
      }),
    ]);
    renderWithProviders(<SimulationView />);
    await screen.findByTestId('world-map');

    const text = headerText();
    expect(text).toContain('1 个剧集');
    expect(text).toContain('1 条原始事件');
  });
});
