/**
 * 演示模式 + ScenarioSummary 演示字段消费测试（Wave-2 收尾批次）：
 *
 * - ScenarioListPage：tagline 按 navigator.language 取 zh/en；heroEventId
 *   卡片显示 hero 星标；
 * - ControlBar「高光时刻」：pause → stepSimulationTo（CLI `sim step --to`
 *   语义）的调用序列与参数；事件已过 → 禁用 + 提示；
 * - SimulationView 演示模式：进入后管理 UI（侧栏注入面板、专注切换、停止/
 *   步进等高级控件）隐藏、大字号读数条出现，Esc 退出后恢复。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../api/client';
import type { EnvironmentDetail, ScenarioDefinition, ScenarioSummary } from '../api/types';
import { ControlBar } from '../components/ControlBar';
import { DemoModeBanner } from '../components/DemoModeBanner';
import { ScenarioListPage } from '../pages/ScenarioListPage';
import { SimulationView } from '../pages/SimulationView';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { makeSnapshot } from './fixtures';
import { renderWithProviders } from './testUtils';

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return {
    ...mod,
    listScenarios: vi.fn(async () => SCENARIOS),
    getSnapshot: vi.fn(async () => SNAP),
    pauseSimulation: vi.fn(async () => ({ id: 'sim-1', state: 'paused' })),
    stepSimulationTo: vi.fn(async () => ({ id: 'sim-1', state: 'paused', simTimeSec: 180 })),
    stopSimulation: vi.fn(async () => ({ id: 'sim-demo', state: 'stopped' })),
    getSimulationSnapshot: vi.fn(async () => ({ id: 'sim-demo', simTimeSec: 0 })),
    getSimulationCollaborations: vi.fn(async () => []),
  };
});

// reactflow（WorldMap 画布）在 jsdom 里需要测量 API——演示模式测试不断言
// 地图本身，直接换成桩组件。
vi.mock('../components/worldmap/WorldMap', () => ({
  WorldMap: () => <div data-testid="world-map" />,
}));

// EnvSeriesPanel 的 echarts 挂载在 jsdom 无意义，同 envSeriesPanel.test。
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

const SCENARIOS: ScenarioSummary[] = [
  {
    id: 'starter-home',
    name: '十分钟最小世界',
    description: '最小的可跑世界',
    source: 'seed',
    counts: { zones: 3, devices: 3, agents: 1, events: 4, derivedServices: 0 },
    tagline: { zh: '回家、升温、开空调', en: 'Come home, heat spikes, AC kicks in' },
    heroEventId: 'heat-demo',
    recommendedPlaybackRate: 60,
  },
  {
    id: 'plain-world',
    name: '无演示字段场景',
    description: '没有 tagline / hero',
    source: 'user',
    counts: { zones: 1, devices: 1, agents: 1, events: 0, derivedServices: 0 },
  },
];

const SCENARIO: ScenarioDefinition = {
  version: '1.0',
  meta: {
    id: 'starter-home',
    name: '十分钟最小世界',
    description: '最小的可跑世界',
    heroEventId: 'heat-demo',
    recommendedPlaybackRate: 4,
    tagline: { zh: '回家、升温、开空调', en: 'Come home, heat spikes, AC kicks in' },
  },
  zones: [
    {
      id: 'living-room',
      name: '客厅',
      type: 'living-room',
      bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 },
      adjacentZoneIds: [],
    },
  ],
  devices: [
    {
      id: 'lr-hvac',
      name: '客厅空调',
      type: 'hvac',
      role: 'actuator',
      capabilities: ['temperature-control'],
      zoneId: 'living-room',
      binding: 'sim://hvac',
    },
  ],
  agents: [
    {
      id: 'butler',
      name: '小管家',
      capabilities: ['temperature-control'],
      managesZoneIds: ['living-room'],
      boundDeviceIds: ['lr-hvac'],
    },
  ],
  events: [
    {
      id: 'heat-demo',
      type: 'temperature-spike',
      zoneId: 'living-room',
      parameter: 'temperature',
      value: 34,
      atSimTimeSec: 180,
    },
  ],
};

const SNAP = makeSnapshot({
  state: 'paused',
  simTimeSec: 0,
  zones: [
    { id: 'living-room', name: '客厅', parameters: { temperature: 31.2, co2: 980, occupancy: 2 } },
  ],
  agents: [],
});

const getSnapshotMock = vi.mocked(api.getSnapshot);
const pauseMock = vi.mocked(api.pauseSimulation);
const stepToMock = vi.mocked(api.stepSimulationTo);

function setLanguage(lang: string) {
  // Both `navigator.language` (legacy signal) and i18next (Phase 4 source of
  // truth) must be driven: lib/locale.ts reads i18next, while older tests may
  // still inspect navigator.language directly.
  Object.defineProperty(window.navigator, 'language', { value: lang, configurable: true });
  void i18n.changeLanguage(lang);
}

/** SimulationView / ControlBar 共用的 store 底座（legacy 场景仿真上下文）。 */
function seedSimulationStore() {
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  setLanguage('zh-CN');
  useAppStore.setState({ currentScenario: null, simulationId: null, snapshot: null });
});

// ---------------------------------------------------------------------------
// 场景卡片：tagline 语言选择 + hero 星标
// ---------------------------------------------------------------------------

describe('ScenarioListPage 演示字段', () => {
  it('中文环境显示中文 tagline，有 heroEventId 的卡片显示 hero 星标', async () => {
    setLanguage('zh-CN');
    useAppStore.setState({ scenarios: [], scenariosLoading: false, scenariosError: null });
    renderWithProviders(<ScenarioListPage />);

    expect(await screen.findByText('回家、升温、开空调')).toBeTruthy();
    expect(screen.queryByText('Come home, heat spikes, AC kicks in')).toBeNull();
    // hero 星标只出现在有 heroEventId 的卡片上。
    expect(screen.getByText('hero')).toBeTruthy();
  });

  it('英文环境显示英文 tagline', async () => {
    setLanguage('en-US');
    useAppStore.setState({ scenarios: [], scenariosLoading: false, scenariosError: null });
    renderWithProviders(<ScenarioListPage />);

    expect(await screen.findByText('Come home, heat spikes, AC kicks in')).toBeTruthy();
    expect(screen.queryByText('回家、升温、开空调')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ControlBar「高光时刻」
// ---------------------------------------------------------------------------

describe('ControlBar 高光时刻', () => {
  beforeEach(seedSimulationStore);

  it('暂停态点击：直接 stepSimulationTo 到 hero 事件的 atSimTimeSec（不 pause）', async () => {
    render(
      <ControlBar snapshot={SNAP} heroEvent={{ id: 'heat-demo', atSimTimeSec: 180 }} />,
    );

    fireEvent.click(screen.getByText('高光时刻'));

    await waitFor(() => expect(stepToMock).toHaveBeenCalledWith('sim-1', 180));
    expect(pauseMock).not.toHaveBeenCalled();
    // 动作后拉一次新快照（server-authoritative）。
    expect(getSnapshotMock).toHaveBeenCalledWith('sim-1');
  });

  it('运行中点击：先 pause 再 step-to', async () => {
    const running = makeSnapshot({ ...SNAP, state: 'running' });
    useAppStore.setState({ snapshot: running });
    render(
      <ControlBar snapshot={running} heroEvent={{ id: 'heat-demo', atSimTimeSec: 180 }} />,
    );

    fireEvent.click(screen.getByText('高光时刻'));

    await waitFor(() => expect(stepToMock).toHaveBeenCalledWith('sim-1', 180));
    expect(pauseMock).toHaveBeenCalledWith('sim-1');
    expect(pauseMock.mock.invocationCallOrder[0]).toBeLessThan(
      stepToMock.mock.invocationCallOrder[0],
    );
  });

  it('事件已发生：按钮禁用并在 title 里提示', () => {
    const late = makeSnapshot({ ...SNAP, simTimeSec: 200 });
    render(
      <ControlBar snapshot={late} heroEvent={{ id: 'heat-demo', atSimTimeSec: 180 }} />,
    );

    const button = screen.getByText('高光时刻').closest('button')!;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('已发生');
    fireEvent.click(button);
    expect(stepToMock).not.toHaveBeenCalled();
  });

  it('无 heroEvent 上下文时不渲染按钮', () => {
    render(<ControlBar snapshot={SNAP} />);
    expect(screen.queryByText('高光时刻')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SimulationView 演示模式
// ---------------------------------------------------------------------------

describe('SimulationView 演示模式', () => {
  beforeEach(seedSimulationStore);

  it('进入后隐藏管理 UI、显示大字号读数条；Esc 退出后恢复', async () => {
    // A5: the right drawer defaults to collapsed — open it so the management
    // panels are present in the normal state this test contrasts against.
    // (UX-W1: 布局键早已升 v3——v2 写入是死代码；且 jsdom 1024 视口下无
    // 持久化布局会默认收起抽屉，这里必须落在生效的 v3 键上。)
    window.localStorage.setItem('ac.consoleLayout.v3', JSON.stringify({ rightOpen: true }));
    renderWithProviders(<SimulationView />);

    // 常规态：管理 UI 在场（专注切换、注入面板、高级控件）。
    expect(await screen.findByText('专注模式')).toBeTruthy();
    expect(screen.getByText('停止')).toBeTruthy();
    expect(screen.getByText('事件注入')).toBeTruthy();
    expect(screen.queryByTestId('present-readout')).toBeNull();

    fireEvent.click(screen.getByText('演示模式'));

    // 演示态：读数条出现（温度/CO₂/人数），管理 UI 全部隐藏。
    const readout = await screen.findByTestId('present-readout');
    expect(readout.textContent).toContain('31.2');
    expect(readout.textContent).toContain('980');
    expect(readout.textContent).toContain('客厅');
    expect(screen.queryByText('专注模式')).toBeNull();
    expect(screen.queryByText('停止')).toBeNull();
    expect(screen.queryByText('步进 +1')).toBeNull();
    expect(screen.queryByText('事件注入')).toBeNull();
    // 最小控制仍在：暂停/速度。
    expect(screen.getByText('暂停')).toBeTruthy();
    expect(screen.getByText('退出演示')).toBeTruthy();
    // 地图保留。
    expect(screen.getByTestId('world-map')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });

    // 退出后恢复常规控制台。
    expect(await screen.findByText('专注模式')).toBeTruthy();
    expect(screen.queryByTestId('present-readout')).toBeNull();
    expect(screen.getByText('停止')).toBeTruthy();
  });

  it('「退出演示」按钮同样退出演示模式', async () => {
    renderWithProviders(<SimulationView />);

    fireEvent.click(await screen.findByText('演示模式'));
    expect(await screen.findByTestId('present-readout')).toBeTruthy();

    fireEvent.click(screen.getByText('退出演示'));
    expect(await screen.findByText('专注模式')).toBeTruthy();
    expect(screen.queryByTestId('present-readout')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DemoModeBanner Esc (R2-UX-07)
// ---------------------------------------------------------------------------

describe('DemoModeBanner Esc 退出 (R2-UX-07)', () => {
  const stopMock = vi.mocked(api.stopSimulation);

  /** Banner 渲染所需的最小 world（id/events/tagline 之外不读）。 */
  const DEMO_WORLD = {
    id: 'env-1',
    name: '演示环境',
    events: [],
  } as unknown as EnvironmentDetail;

  function seedDemoStore(done = false) {
    useAppStore.setState({
      world: DEMO_WORLD,
      demoRun: {
        simId: 'sim-demo',
        envId: 'env-1',
        rate: 60,
        heroEventId: null,
        endsAtSimTimeSec: 600,
        done,
      },
      simulationId: null,
      snapshot: null,
    });
  }

  beforeEach(() => {
    setLanguage('zh-CN');
  });

  afterEach(() => {
    useAppStore.setState({ demoRun: null, world: null });
    document.querySelectorAll('.confirm-backdrop').forEach(node => node.remove());
  });

  it('播放中 Esc 退出演示：停止演示仿真并摘下横幅', async () => {
    seedDemoStore();
    renderWithProviders(<DemoModeBanner />, { initialEntries: ['/environments/env-1'] });

    expect(await screen.findByTestId('demo-run-banner')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(stopMock).toHaveBeenCalledWith('sim-demo'));
    expect(useAppStore.getState().demoRun).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('demo-run-banner')).toBeNull());
  });

  it('对话框打开时 Esc 不抢——演示继续', async () => {
    seedDemoStore();
    renderWithProviders(<DemoModeBanner />, { initialEntries: ['/environments/env-1'] });
    expect(await screen.findByTestId('demo-run-banner')).toBeTruthy();

    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    document.body.append(backdrop);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(stopMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().demoRun).not.toBeNull();
  });

  it('已结束的演示 Esc 不再重复停止（横幅留待手动关闭）', async () => {
    seedDemoStore(true);
    renderWithProviders(<DemoModeBanner />, { initialEntries: ['/environments/env-1'] });
    expect(await screen.findByTestId('demo-run-banner')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(stopMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().demoRun).not.toBeNull();
  });

  it('退出按钮带 Esc 键位提示', async () => {
    seedDemoStore();
    renderWithProviders(<DemoModeBanner />, { initialEntries: ['/environments/env-1'] });

    const exitButton = (await screen.findByTestId('demo-run-banner')).querySelector(
      '.demo-run-banner__exit',
    );
    expect(exitButton?.getAttribute('title')).toBe('退出演示（Esc）');
  });
});

// ---------------------------------------------------------------------------
// T-114: chunked step-to (no single >600-tick jump)
// ---------------------------------------------------------------------------

describe('ControlBar 高光时刻 — 分块步进 (T-114)', () => {
  beforeEach(seedSimulationStore);

  it('a >600-tick hero target produces multiple cap-sized step calls, not one 422-bound jump', async () => {
    // The mock lands exactly on each requested target (server may overshoot
    // by < speed; the helper paces off the landed time either way).
    stepToMock.mockImplementation(async (_id: string, target: number) => ({
      id: 'sim-1',
      state: 'paused',
      simTimeSec: target,
    }));

    render(
      <ControlBar snapshot={SNAP} heroEvent={{ id: 'demo-bell', atSimTimeSec: 28800 }} />,
    );
    fireEvent.click(screen.getByText('高光时刻'));

    await waitFor(() => expect(stepToMock).toHaveBeenCalledTimes(48));
    const targets = stepToMock.mock.calls.map(([, to]) => to as number);
    expect(targets[0]).toBe(600);
    expect(targets[targets.length - 1]).toBe(28800);
    let prev = 0;
    for (const target of targets) {
      expect(target - prev).toBeLessThanOrEqual(600);
      expect(target).toBeGreaterThan(prev);
      prev = target;
    }
  });
});
