/**
 * UX-W5 子任务 A 测试：世界页头部减负 + 会话概念引导 + 旧版场景页降级。
 *
 * - 核心动作（进入世界仿真 / 运行仿真）是头部唯一 primary 大按钮；
 * - 业务流深链 / LLM 选择器 / zone 范围 / 演示模式收进「⋯ 更多」菜单，
 *   菜单项保留原功能与深链语义（demo 字段门控不变）；
 * - 会话概念人话引导：运行按钮旁一句情境说明 + 「区别？」popover；
 * - App 页脚：旧版场景浏览器收进「高级 / Legacy」折叠，不在主导航裸链。
 */

import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '../App';
import type { EnvironmentDetail } from '../api/types';
import { WorldViewPage } from '../pages/WorldViewPage';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { makeSnapshot } from './fixtures';
import { renderWithProviders } from './testUtils';

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return {
    ...mod,
    createSimulationForEnvironment: vi.fn(async () => ({ id: 'sim-new' })),
    getSnapshot: vi.fn(async () => SNAP),
    getSimulationSnapshot: vi.fn(async () => ({ state: 'running', simTimeSec: 0 })),
    listSimulations: vi.fn(async () => []),
    startSimulation: vi.fn(async () => ({ id: 'sim-new', state: 'running' })),
    stopSimulation: vi.fn(async () => ({ id: 'sim-new', state: 'stopped' })),
    injectEvent: vi.fn(async () => ({ eventId: 'e-1' })),
  };
});

// reactflow / leaflet / babylon 画布在 jsdom 里无法挂载——与世界视图其他
// 测试一样换成桩组件。
vi.mock('../components/worldmap/WorldMap', () => ({
  WorldMap: () => <div data-testid="world-map" />,
}));
vi.mock('../components/worldmap/GeoWorldMap', () => ({
  GeoWorldMap: () => <div data-testid="geo-map" />,
}));
vi.mock('../components/campus/CampusScene', () => ({
  CampusScene: () => <div data-testid="building-3d" />,
}));

const SNAP = makeSnapshot({ state: 'running', simTimeSec: 0 });

const BASE_WORLD = {
  id: 'env-1',
  name: '头部测试世界',
  description: '',
  visibility: 'public',
  myRole: 'owner',
  mapType: 'grid',
  mapCenter: null,
  demo: null,
  events: [],
  zones: [{ id: 'z-1', name: '一楼', bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 } }],
  devices: [],
  agents: [],
  services: [],
  members: [],
  mySubscriptions: [],
} as unknown as EnvironmentDetail;

const DEMO_WORLD = {
  ...BASE_WORLD,
  demo: { tagline: { zh: '演示', en: 'Demo' }, heroEventId: null, recommendedPlaybackRate: 10 },
} as unknown as EnvironmentDetail;

const SESSION_WORLD = {
  ...BASE_WORLD,
  worldSession: { status: 'idle', simTimeSec: 0, simulationId: 'sim-ws', driftWarning: [] },
} as unknown as EnvironmentDetail;

function seedStore(world: EnvironmentDetail) {
  useAppStore.setState({
    user: { id: 'u-1', email: 'u@x', displayName: 'U', createdAt: '2026-01-01T00:00:00.000Z' },
    world,
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

function headerElement(): HTMLElement {
  const header = document.querySelector('header.detail-header');
  expect(header).not.toBeNull();
  return header as HTMLElement;
}

describe('UX-W5 世界页头部减负', () => {
  it('无世界会话：「运行仿真」是头部唯一 primary；次级能力默认不进头部', async () => {
    seedStore(BASE_WORLD);
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });

    await screen.findByRole('button', { name: '运行仿真' });
    const header = headerElement();
    expect(header.querySelectorAll('.primary-button')).toHaveLength(1);
    // 次级能力藏进 ⋯ 菜单：未展开时头部看不到。
    expect(within(header).queryByRole('link', { name: '业务流' })).toBeNull();
    expect(within(header).queryByText('LLM 模式')).toBeNull();
    expect(within(header).queryByText('区域 1/1')).toBeNull();
    // 室内漫游是穿越入口，保留在头部。
    expect(within(header).getByRole('link', { name: /步行进入建筑/ })).toBeTruthy();
  });

  it('有世界会话：「进入世界仿真」为唯一 primary，新建私有仿真是次级链接', async () => {
    seedStore(SESSION_WORLD);
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });

    await screen.findByRole('button', { name: '进入世界仿真' });
    const header = headerElement();
    expect(header.querySelectorAll('.primary-button')).toHaveLength(1);
    const privateSim = within(header).getByRole('button', { name: '新建私有仿真' });
    expect(privateSim.classList.contains('primary-button')).toBe(false);
  });

  it('⋯ 菜单展开：业务流深链 + LLM 选择器 + zone 范围 + 演示模式', async () => {
    seedStore(DEMO_WORLD);
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });

    await screen.findByRole('button', { name: '运行仿真' });
    fireEvent.click(screen.getByRole('button', { name: '更多' }));

    const menu = screen.getByRole('menu', { name: '世界页更多选项' });
    // 深链语义不变。
    const flows = within(menu).getByRole('link', { name: '业务流' });
    expect(flows.getAttribute('href')).toBe('/environments/env-1/flows');
    // LLM 选择器原功能保留（rule-only 选项在）。
    expect(within(menu).getByText('LLM 模式')).toBeTruthy();
    expect(within(menu).getByRole('combobox')).toBeTruthy();
    expect(within(menu).getByText(/rule-only/)).toBeTruthy();
    // zone 范围 toggle + 展开清单。
    fireEvent.click(within(menu).getByRole('button', { name: '区域 1/1' }));
    expect(within(menu).getByRole('checkbox')).toBeTruthy();
    // demo 门控不变：有 demo 字段的世界菜单里有演示模式。
    expect(within(menu).getByRole('button', { name: /演示模式/ })).toBeTruthy();
  });

  it('会话概念引导：一句情境说明 + 「区别？」popover 两形态解释', async () => {
    seedStore(SESSION_WORLD);
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });

    await screen.findByRole('button', { name: '进入世界仿真' });
    expect(screen.getByText('世界会话是大家的常开世界；私有仿真是你的个人沙盒。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '两者有什么区别？' }));
    expect(screen.getByText(/世界会话：所有成员共享的常开世界/)).toBeTruthy();
    expect(screen.getByText(/私有仿真：只属于你的沙盒/)).toBeTruthy();
  });
});

describe('UX-W5 旧版场景页降级', () => {
  it('页脚的旧版场景浏览器收进「高级 / Legacy」折叠，不裸链', async () => {
    useAppStore.setState({ user: null, authChecked: false, simulationId: null, toasts: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/auth/me') {
          return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'nope' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `unexpected: ${url}` } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    renderWithProviders(<App />, { initialEntries: ['/'] });
    await screen.findByText('邮箱');

    const footer = document.querySelector('footer.app-footer');
    expect(footer).not.toBeNull();
    const details = footer!.querySelector('details.app-footer__legacy') as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.querySelector('summary')?.textContent).toBe('高级 / Legacy');
    // 链接在折叠内部（深链语义不变），页脚不再有折叠外的裸链。
    const legacyLink = within(details!).getByRole('link', { name: '旧版场景浏览器' });
    expect(legacyLink.getAttribute('href')).toBe('/scenarios');
    expect(within(footer as HTMLElement).getAllByRole('link')).toHaveLength(1);

    fireEvent.click(details!.querySelector('summary')!);
    expect(details!.open).toBe(true);
  });
});
