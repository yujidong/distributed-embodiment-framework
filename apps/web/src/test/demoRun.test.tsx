/**
 * plan-r81 B1+B2 测试：
 *
 * - lib/demoRun：演示弧 stepper 纯函数（排序/终点/当前阶段，含 hero 提前注入）；
 * - DemoModeBanner：stepper 渲染、弧结束自动停止演示仿真（F2）、手动退出
 *   也停止、实测速率与 ETA 展示（F6）；
 * - WorldViewPage：demo 字段门控「演示模式」入口（有 demo 才显示）、一键
 *   启动序列（新建私有仿真 → N× 播放 → 注入 heat-demo → demoRun 入 store）；
 * - WorldViewPage 匿名访客（plan-r81 B1）：公开世界只读——访客徽标 + 登录
 *   提示，运行仿真/演示模式按钮不出现。
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../api/client';
import type { EnvironmentDetail, ScenarioEvent } from '../api/types';
import { DemoModeBanner } from '../components/DemoModeBanner';
import {
  DEMO_END_DWELL_SEC,
  activeDemoPhaseIndex,
  demoEndSimTimeSec,
  demoEtaSeconds,
  demoPhases,
  smoothDemoRate,
} from '../lib/demoRun';
import { WorldViewPage } from '../pages/WorldViewPage';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { makeSnapshot } from './fixtures';
import { renderWithProviders } from './testUtils';

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return {
    ...mod,
    createSimulationForEnvironment: vi.fn(async () => ({ id: 'sim-demo' })),
    getSnapshot: vi.fn(async () => SNAP),
    // Banner self-poll path (console NOT attached): default frozen at t=0,
    // tests override per case.
    getSimulationSnapshot: vi.fn(async () => ({ state: 'running', simTimeSec: 0 })),
    startSimulation: vi.fn(async () => ({ id: 'sim-demo', state: 'running' })),
    stopSimulation: vi.fn(async () => ({ id: 'sim-demo', state: 'stopped' })),
    injectEvent: vi.fn(async () => ({ eventId: 'heat-demo', parameter: 'temperature', value: 34, targetAgentIds: ['butler'] })),
  };
});

// reactflow / leaflet / three 画布在 jsdom 里无法挂载——与世界视图其他测试
// 一样换成桩组件。
vi.mock('../components/worldmap/WorldMap', () => ({
  WorldMap: () => <div data-testid="world-map" />,
}));
vi.mock('../components/worldmap/GeoWorldMap', () => ({
  GeoWorldMap: () => <div data-testid="geo-map" />,
}));
// 3D slot: Babylon CampusScene (replaced the three.js Building3DView).
vi.mock('../components/campus/CampusScene', () => ({
  CampusScene: () => <div data-testid="building-3d" />,
}));

// web 端 ScenarioEvent 补丁类型不含 severity（wire 的 EnvMapEvent 有）——
// 测试世界沿用 wire 形状。
const EVENTS: Array<ScenarioEvent & { severity?: 'low' | 'medium' | 'high' | 'critical' }> = [
  { id: 'evening-dim', type: 'light-change', zoneId: 'living-room', parameter: 'light', value: 120, atSimTimeSec: 720 },
  { id: 'homecoming', type: 'occupancy', zoneId: 'living-room', parameter: 'occupancy', value: 2, atSimTimeSec: 60 },
  { id: 'heat-demo', type: 'temperature-spike', zoneId: 'living-room', parameter: 'temperature', value: 34, atSimTimeSec: 180, severity: 'medium' },
  { id: 'no-schedule', type: 'note', zoneId: 'living-room' },
];

const SNAP = makeSnapshot({ state: 'running', simTimeSec: 0 });

const DEMO_WORLD = {
  id: 'env-1',
  name: '演示世界',
  description: '',
  visibility: 'public',
  myRole: 'owner',
  mapType: 'grid',
  mapCenter: null,
  demo: {
    tagline: { zh: '回家、升温、开空调', en: 'Come home, heat spikes, AC kicks in' },
    heroEventId: 'heat-demo',
    recommendedPlaybackRate: 10,
  },
  events: EVENTS,
  zones: [
    { id: 'living-room', name: '客厅', bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 } },
  ],
  devices: [],
  agents: [],
  services: [],
  members: [],
  mySubscriptions: [],
} as unknown as EnvironmentDetail;

const PLAIN_WORLD = {
  ...DEMO_WORLD,
  demo: null,
} as unknown as EnvironmentDetail;

const startSimulationMock = vi.mocked(api.startSimulation);
const stopSimulationMock = vi.mocked(api.stopSimulation);
const injectEventMock = vi.mocked(api.injectEvent);
const createSimMock = vi.mocked(api.createSimulationForEnvironment);

function seedStore(user: { id: string; email: string; displayName: string; createdAt: string } | null) {
  useAppStore.setState({
    user,
    world: DEMO_WORLD,
    worldLoading: false,
    worldError: null,
    worldStreamStatus: 'idle',
    simulationId: null,
    simulationError: null,
    demoRun: null,
    snapshot: null,
    selection: null,
    layers: { zones: true, devices: true, agents: true, edges: true },
    onlineUsers: [],
    onlineAnonymousCount: 0,
    geoPlacement: null,
    devicePick: null,
    zoneDraw: null,
    toasts: [],
  });
}

beforeEach(() => {
  void i18n.changeLanguage('zh-CN');
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  useAppStore.setState({ world: null, simulationId: null, snapshot: null, demoRun: null, user: null });
});

// ---------------------------------------------------------------------------
// lib/demoRun
// ---------------------------------------------------------------------------

describe('lib/demoRun', () => {
  it('demoPhases 按 atSimTimeSec 排序并过滤无调度的条目', () => {
    const phases = demoPhases(EVENTS);
    expect(phases.map(p => p.id)).toEqual(['homecoming', 'heat-demo', 'evening-dim']);
    expect(phases[1].type).toBe('temperature-spike');
  });

  it('demoEndSimTimeSec = 最后一个事件 + 收尾驻留', () => {
    expect(demoEndSimTimeSec(EVENTS)).toBe(720 + DEMO_END_DWELL_SEC);
    expect(demoEndSimTimeSec([])).toBe(DEMO_END_DWELL_SEC);
  });

  it('activeDemoPhaseIndex：首个未触发事件为当前阶段；全部触发后为 -1（回落）', () => {
    const phases = demoPhases(EVENTS);
    expect(activeDemoPhaseIndex(phases, 0, null)).toBe(0);
    expect(activeDemoPhaseIndex(phases, 60, null)).toBe(1);
    expect(activeDemoPhaseIndex(phases, 720, null)).toBe(-1);
  });

  it('hero 提前注入后视作已触发（atSimTimeSec 还在未来也跳过）', () => {
    const phases = demoPhases(EVENTS);
    // t=0：homecoming 未触发，heat-demo 已注入 → 当前阶段仍是 homecoming；
    // t=60 后跳过已注入的 heat-demo，直指 evening-dim。
    expect(activeDemoPhaseIndex(phases, 0, 'heat-demo')).toBe(0);
    expect(activeDemoPhaseIndex(phases, 60, 'heat-demo')).toBe(2);
  });

  it('smoothDemoRate：由两次采样算实测速率并做 EMA 平滑；无进展样本保持原估计', () => {
    const a = { simTimeSec: 100, atMs: 1_000 };
    const b = { simTimeSec: 300, atMs: 3_000 };
    // 200 sim 秒 / 2 墙钟秒 = 100×。
    expect(smoothDemoRate(null, a, b)).toBe(100);
    const c = { simTimeSec: 340, atMs: 4_000 };
    // 瞬时 40×，EMA：100×0.6 + 40×0.4 = 76×。
    expect(smoothDemoRate(100, b, c)).toBe(76);
    // 同一轮 poll 重复采样（simTime 没动）不污染估计。
    expect(smoothDemoRate(76, c, { simTimeSec: 340, atMs: 5_000 })).toBe(76);
  });

  it('demoEtaSeconds：按实测速率折算剩余墙钟秒；无估计时为 null', () => {
    expect(demoEtaSeconds(960, 300, 100)).toBe(7);
    expect(demoEtaSeconds(960, 960, 100)).toBe(0);
    expect(demoEtaSeconds(960, 300, null)).toBeNull();
    expect(demoEtaSeconds(960, 300, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DemoModeBanner
// ---------------------------------------------------------------------------

describe('DemoModeBanner', () => {
  // The banner is page-scoped now (demo-on-world-page): it renders over the
  // world page WITHOUT the console attached. These seeds keep the console
  // attached (simulationId === demoRun.simId) only where the test drives the
  // sim time through the store snapshot (console channel, 1 s cadence).
  function seedDemoRun(overrides?: Partial<NonNullable<ReturnType<typeof currentDemo>>>) {
    useAppStore.setState({
      simulationId: 'sim-demo',
      world: DEMO_WORLD,
      demoRun: {
        simId: 'sim-demo',
        envId: 'env-1',
        rate: 10,
        heroEventId: 'heat-demo',
        endsAtSimTimeSec: 720 + DEMO_END_DWELL_SEC,
        done: false,
        ...overrides,
      },
    });
  }
  const currentDemo = () => useAppStore.getState().demoRun;

  it('demoRun 为空或世界不匹配时不渲染；世界页上无需挂 console', () => {
    const { container, rerender } = renderWithProviders(<DemoModeBanner />, {
      initialEntries: ['/environments/env-1'],
    });
    expect(container.firstChild).toBeNull();

    // demoRun without console attach (simulationId stays null) → the banner
    // renders over the world page (demo-on-world-page architecture).
    useAppStore.setState({
      simulationId: null,
      world: DEMO_WORLD,
      demoRun: {
        simId: 'sim-demo',
        envId: 'env-1',
        rate: 10,
        heroEventId: 'heat-demo',
        endsAtSimTimeSec: 720 + DEMO_END_DWELL_SEC,
        done: false,
      },
    });
    rerender(<DemoModeBanner />);
    expect(screen.getByTestId('demo-run-banner')).toBeTruthy();

    // World mismatch (another env's page) → hidden.
    useAppStore.setState({ world: { ...DEMO_WORLD, id: 'env-2' } as EnvironmentDetail });
    rerender(<DemoModeBanner />);
    expect(screen.queryByTestId('demo-run-banner')).toBeNull();
  });

  it('渲染 tagline、弧步骤与速率说明；当前阶段高亮', () => {
    seedDemoRun();
    useAppStore.setState({ snapshot: makeSnapshot({ state: 'running', simTimeSec: 100 }) });
    renderWithProviders(<DemoModeBanner />, { initialEntries: ['/environments/env-1'] });

    const banner = screen.getByTestId('demo-run-banner');
    expect(banner.textContent).toContain('回家、升温、开空调');
    expect(banner.textContent).toContain('家人回家');
    expect(banner.textContent).toContain('高温来袭，空调自启');
    expect(banner.textContent).toContain('回落收尾');
    expect(banner.textContent).toContain('10×');
  });

  it('弧结束（simTime ≥ 终点）自动停止演示仿真并翻转到结束态（F2）', async () => {
    seedDemoRun();
    useAppStore.setState({
      snapshot: makeSnapshot({ state: 'running', simTimeSec: 720 + DEMO_END_DWELL_SEC }),
    });
    renderWithProviders(<DemoModeBanner />, { initialEntries: ['/environments/env-1'] });

    await waitFor(() => expect(stopSimulationMock).toHaveBeenCalledWith('sim-demo'));
    await waitFor(() => expect(useAppStore.getState().demoRun?.done).toBe(true));
    expect(await screen.findByText('演示结束，演示仿真已停止')).toBeTruthy();
  });

  it('世界页语义：不挂 console——banner 自轮询 demo sim 到终点即停（F2）', async () => {
    vi.mocked(api.getSimulationSnapshot).mockResolvedValue({
      state: 'running',
      simTimeSec: 720 + DEMO_END_DWELL_SEC,
    } as never);
    useAppStore.setState({
      simulationId: null,
      world: DEMO_WORLD,
      demoRun: {
        simId: 'sim-demo',
        envId: 'env-1',
        rate: 10,
        heroEventId: 'heat-demo',
        endsAtSimTimeSec: 720 + DEMO_END_DWELL_SEC,
        done: false,
      },
    });
    renderWithProviders(<DemoModeBanner />, { initialEntries: ['/environments/env-1'] });

    expect(await screen.findByTestId('demo-run-banner')).toBeTruthy();
    await waitFor(() => expect(stopSimulationMock).toHaveBeenCalledWith('sim-demo'));
    await waitFor(() => expect(useAppStore.getState().demoRun?.done).toBe(true));
  });

  it('离开演示环境且未挂 console：自动停止并清理 demoRun（防泄漏，F2）', async () => {
    useAppStore.setState({
      simulationId: null,
      world: DEMO_WORLD,
      demoRun: {
        simId: 'sim-demo',
        envId: 'env-1',
        rate: 10,
        heroEventId: null,
        endsAtSimTimeSec: 960,
        done: false,
      },
    });
    renderWithProviders(<DemoModeBanner />, { initialEntries: ['/'] });

    await waitFor(() => expect(stopSimulationMock).toHaveBeenCalledWith('sim-demo'));
    await waitFor(() => expect(useAppStore.getState().demoRun).toBeNull());
  });

  it('未到终点不停止；手动「退出演示」停止演示仿真并关闭横幅（F2）', () => {
    seedDemoRun();
    useAppStore.setState({ snapshot: makeSnapshot({ state: 'running', simTimeSec: 100 }) });
    renderWithProviders(<DemoModeBanner />, { initialEntries: ['/environments/env-1'] });

    expect(stopSimulationMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('退出演示'));

    expect(stopSimulationMock).toHaveBeenCalledWith('sim-demo');
    expect(useAppStore.getState().demoRun).toBeNull();
  });

  it('F6：两轮采样后显示实测速率与预计剩余时间（autoThrottle 降速不撒谎）', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      seedDemoRun();
      useAppStore.setState({ snapshot: makeSnapshot({ state: 'running', simTimeSec: 100 }) });
      const { rerender } = renderWithProviders(<DemoModeBanner />, {
        initialEntries: ['/environments/env-1'],
      });
      // 首轮只有配置速率。
      expect(screen.getByTestId('demo-run-banner').textContent).toContain('10×');

      // 墙钟 +2s、simTime +200 → 实测 100×；ETA = (960-300)/100 ≈ 7 秒。
      vi.setSystemTime(1_002_000);
      useAppStore.setState({ snapshot: makeSnapshot({ state: 'running', simTimeSec: 300 }) });
      rerender(<DemoModeBanner />);

      const text = screen.getByTestId('demo-run-banner').textContent ?? '';
      expect(text).toContain('约 100×');
      expect(text).toContain('预计还需约 7 秒');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// WorldViewPage：demo 入口 + 匿名只读
// ---------------------------------------------------------------------------

describe('WorldViewPage 演示模式入口 (B2)', () => {
  beforeEach(() => {
    seedStore({ id: 'u-1', email: 'u@x', displayName: 'U', createdAt: '2026-01-01T00:00:00.000Z' });
  });

  it('有 demo 字段的世界显示「演示模式」按钮；点击后建私有仿真、10× 播放、注入 heat-demo', async () => {
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });

    // UX-W5: 演示模式入口收进「⋯ 更多」菜单——先开菜单再点。
    await screen.findByRole('button', { name: '运行仿真' });
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    const button = await screen.findByRole('button', { name: /演示模式/ });
    fireEvent.click(button);

    await waitFor(() => expect(createSimMock).toHaveBeenCalledWith('env-1', { llmClient: 'auto' }, undefined));
    await waitFor(() => expect(startSimulationMock).toHaveBeenCalledWith('sim-demo', 10));
    await waitFor(() =>
      expect(injectEventMock).toHaveBeenCalledWith('sim-demo', {
        id: 'heat-demo',
        type: 'temperature-spike',
        zoneId: 'living-room',
        parameter: 'temperature',
        value: 34,
        severity: 'medium',
      }),
    );
    await waitFor(() => {
      const run = useAppStore.getState().demoRun;
      expect(run).not.toBeNull();
      expect(run?.simId).toBe('sim-demo');
      expect(run?.rate).toBe(10);
      expect(run?.endsAtSimTimeSec).toBe(720 + DEMO_END_DWELL_SEC);
    });
    // Demo-on-world-page: the demo sim is created WITHOUT attaching the
    // console — simulationId stays null, the route tree never swaps.
    expect(useAppStore.getState().simulationId).toBeNull();
  });

  it('再次启动演示：先停掉上一个未结束的演示仿真（F2，不再累积永跑 sim）', async () => {
    useAppStore.setState({
      demoRun: {
        simId: 'sim-old-demo',
        envId: 'env-1',
        rate: 10,
        heroEventId: null,
        endsAtSimTimeSec: 960,
        done: false,
      },
    });
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });

    await screen.findByRole('button', { name: '运行仿真' });
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(await screen.findByRole('button', { name: /演示模式/ }));

    await waitFor(() => expect(stopSimulationMock).toHaveBeenCalledWith('sim-old-demo'));
    await waitFor(() => expect(createSimMock).toHaveBeenCalled());
    await waitFor(() => expect(useAppStore.getState().demoRun?.simId).toBe('sim-demo'));
  });

  it('无 demo 字段的世界显示灰置入口 + 空态说明（R2-UX-08）', async () => {
    useAppStore.setState({ world: PLAIN_WORLD });
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });

    await screen.findByRole('button', { name: '运行仿真' });
    // R2-UX-08: 入口不再整条隐藏——灰置 + tooltip 说明原因（隐藏入口教不会用户）。
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    const entry = screen.getByRole('button', { name: /演示模式/ });
    expect(entry.hasAttribute('disabled')).toBe(true);
    expect(entry.getAttribute('title')).toContain('未配置演示剧本');
    // 灰置入口不可触发 startDemo（不新建仿真）。
    expect(createSimMock).not.toHaveBeenCalled();
  });
});

describe('WorldViewPage 匿名访客只读 (B1)', () => {
  beforeEach(() => {
    seedStore(null);
  });

  it('公开世界：访客徽标 + 登录提示；运行仿真/演示模式/LLM 选择均不出现', async () => {
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });

    expect(await screen.findByText('访客只读')).toBeTruthy();
    expect(screen.getByText(/登录后可运行仿真/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '运行仿真' })).toBeNull();
    expect(screen.queryByRole('button', { name: /演示模式/ })).toBeNull();
    // 只读内容仍在：画布与图层开关照常渲染。
    expect(await screen.findByTestId('world-map')).toBeTruthy();
  });

  it('登录用户不受影响：运行仿真与演示模式入口照常', async () => {
    seedStore({ id: 'u-1', email: 'u@x', displayName: 'U', createdAt: '2026-01-01T00:00:00.000Z' });
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });

    expect(await screen.findByRole('button', { name: '运行仿真' })).toBeTruthy();
    // UX-W5: 演示模式收进「⋯ 更多」菜单。
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    expect(screen.getByRole('button', { name: /演示模式/ })).toBeTruthy();
    expect(screen.queryByText('访客只读')).toBeNull();
  });
});
