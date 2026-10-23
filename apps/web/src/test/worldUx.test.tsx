/**
 * T-713 (R29, orchestrator findings) — world-view UX gaps:
 * 1. map hit-testing: device dots / agent markers must stack ABOVE the zone
 *    layer (zones zIndex 1) so an overlapping zone no longer swallows device
 *    clicks; the selected dot jumps to the front;
 * 2. driftWarning (WorldSessionStatus) — typed since T-037, never rendered:
 *    the env detail now shows a dismissible banner;
 * 3. flows count badge — the sidebar tab bar gains a 业务流 quick link with
 *    the env's flow count + per-author split tooltip.
 */

import { cleanup, fireEvent, screen, waitFor, within, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentDetail } from '../api/types';
import type { MapColors } from '../lib/theme';
import type { WorldModel } from '../lib/worldModel';
import { buildGraph } from '../components/worldmap/WorldMap';
import { WorldSidebar } from '../components/world/WorldSidebar';
import { WorldViewPage } from '../pages/WorldViewPage';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

// reactflow (grid canvas) needs measurement APIs jsdom lacks — stub the
// component, keep the pure buildGraph export real for the layering tests.
vi.mock('../components/worldmap/WorldMap', async importOriginal => {
  const actual = await importOriginal<typeof import('../components/worldmap/WorldMap')>();
  return { ...actual, WorldMap: () => <div data-testid="world-map" /> };
});
vi.mock('../components/worldmap/GeoWorldMap', () => ({
  GeoWorldMap: () => <div data-testid="geo-map" />,
}));
// 3D slot: Babylon CampusScene (replaced the three.js Building3DView).
vi.mock('../components/campus/CampusScene', () => ({
  CampusScene: () => <div data-testid="building-3d" />,
}));

// T-713(c): stub the flows list (same module the sidebar queries).
const listFlowsMock = vi.fn();
vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    listFlows: (...args: Parameters<typeof actual.listFlows>) => listFlowsMock(...args),
  };
});

function makeModel(): WorldModel {
  return {
    zones: [
      { id: 'zone-a', name: '实验室A', bounds: { minX: 0, maxX: 80, minY: 0, maxY: 60 } },
      // Overlapping zone: its rectangle covers zone-a's device area — before
      // T-713 it stacked ABOVE the dots (zone zIndex 1 vs dot default 0).
      { id: 'zone-b', name: '实验室B', bounds: { minX: 60, maxX: 140, minY: 0, maxY: 60 } },
    ],
    devices: [
      {
        id: 'dev-1',
        name: '排风扇',
        type: 'exhaust-fan',
        role: 'actuator',
        capabilities: ['set-fan-speed'],
        zoneId: 'zone-a',
        position: null,
        latLng: null,
        ownerId: null,
        ownerName: null,
        initialState: {},
      },
    ],
    agents: [
      {
        id: 'agent-1',
        name: 'LabOps',
        capabilities: [],
        boundDeviceIds: ['dev-1'],
        managedZoneIds: ['zone-a'],
        llm: null,
        ownerId: null,
        ownerName: null,
      },
    ],
  };
}

const GRAPH_OPTIONS = {
  snapshot: null,
  highlightZoneIds: new Set<string>(),
  bubbles: [],
  layers: { zones: true, devices: true, agents: true, edges: true },
  selection: null,
  activeDeviceIds: new Set<string>(),
  memberColorById: new Map<string, string>(),
  focusedZoneIds: new Set<string>(),
  focusOwnerId: null,
  dragOverrides: new Map<string, { x: number; y: number }>(),
  editable: false,
  collabEdges: [],
  colors: {
    bgPanel: '#111',
    text: '#eee',
    textDim: '#999',
    border: '#333',
  } as unknown as MapColors,
  crossFloorLinks: new Map<string, string[]>(),
};

describe('T-713(a): map layering — devices/agents above zones', () => {
  it('device dots and agent markers stack above the zone layer', () => {
    const { nodes } = buildGraph(makeModel(), GRAPH_OPTIONS);
    const byId = new Map(nodes.map(node => [node.id, node]));
    expect(byId.get('zone-a')?.zIndex).toBe(1);
    expect(byId.get('zone-b')?.zIndex).toBe(1);
    // The fix: dots default ABOVE zones (3 > 1) so overlapping zones cannot
    // swallow clicks; markers share the layer.
    expect(byId.get('dev-1')?.zIndex).toBe(3);
    expect(byId.get('agent-1')?.zIndex).toBe(3);
  });

  it('the selected device jumps above door gaps and edge labels', () => {
    const { nodes } = buildGraph(makeModel(), {
      ...GRAPH_OPTIONS,
      selection: { objectType: 'device', id: 'dev-1' },
    });
    const selected = nodes.find(node => node.id === 'dev-1');
    expect(selected?.zIndex).toBe(7);
  });
});

describe('T-713(b): driftWarning banner in the env detail', () => {
  function worldWithDrift(driftWarning: string[] | undefined) {
    return {
      id: 'env-1',
      name: '漂移测试环境',
      description: '',
      visibility: 'public',
      myRole: 'builder',
      mapData: null,
      zones: [],
      devices: [],
      agents: [],
      services: [],
      members: [],
      mySubscriptions: [],
      ...(driftWarning !== undefined
        ? { worldSession: { status: 'active', simTimeSec: 10, simulationId: 'sim-1', driftWarning } }
        : {}),
    } as unknown as EnvironmentDetail;
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
    useAppStore.setState({
      user: { id: 'u-1', email: 'u@x', displayName: 'U', createdAt: '2026-01-01T00:00:00.000Z' },
      world: worldWithDrift(['+ 设备 cam-1（新增）', '- 设备 old-2（已删除）']),
      worldLoading: false,
      worldError: null,
      worldStreamStatus: 'idle',
      simulationId: null,
      simulationError: null,
      selection: null,
      layers: { zones: true, devices: true, agents: true, edges: true },
      onlineUsers: [],
      onlineAnonymousCount: 0,
      geoPlacement: null,
      devicePick: null,
      zoneDraw: null,
      toasts: [],
    });
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('renders every drift line and dismisses', async () => {
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('拓扑已漂移');
    expect(banner.textContent).toContain('+ 设备 cam-1（新增）');
    expect(banner.textContent).toContain('- 设备 old-2（已删除）');

    // UX-W1: 漂移横幅迁入 BannerStack——行内「知道了」dismiss 移除，关闭
    // 走栈条目的关闭钮（与 banner 同级的兄弟节点，故向上取 stack item 再查）。
    const stackItem = banner.closest('.banner-stack__item');
    expect(stackItem).not.toBeNull();
    fireEvent.click(within(stackItem as HTMLElement).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('no banner without drift warnings', async () => {
    useAppStore.setState({ world: worldWithDrift(undefined) });
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });

    // The sidebar tab strip renders (page mounted) but no alert banner exists.
    await screen.findAllByText('设备');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('R82: world-session frame while the page is open surfaces 进入世界仿真', () => {
  // The R82 live bug: the page opened BEFORE the session existed (self-heal
  // creation on a world mutation), so world.worldSession was undefined at
  // load and the world-session stream frame was never applied — the button
  // stayed missing until a reload.
  const SESSION_LESS_WORLD = {
    id: 'env-1',
    name: '自愈环境',
    description: '',
    visibility: 'public',
    myRole: 'builder',
    mapData: null,
    zones: [],
    devices: [],
    agents: [],
    services: [],
    members: [],
    mySubscriptions: [],
  } as unknown as EnvironmentDetail;

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
    useAppStore.setState({
      user: { id: 'u-1', email: 'u@x', displayName: 'U', createdAt: '2026-01-01T00:00:00.000Z' },
      world: SESSION_LESS_WORLD,
      worldLoading: false,
      worldError: null,
      worldStreamStatus: 'idle',
      simulationId: null,
      simulationError: null,
      selection: null,
      layers: { zones: true, devices: true, agents: true, edges: true },
      onlineUsers: [],
      onlineAnonymousCount: 0,
      geoPlacement: null,
      devicePick: null,
      zoneDraw: null,
      toasts: [],
    });
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('the button appears when the session-creation frame arrives (no reload)', async () => {
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });

    // Page mounted, session-less: only the private-sim fallback is offered.
    await screen.findAllByText('设备');
    expect(screen.queryByRole('button', { name: '进入世界仿真' })).toBeNull();

    // The self-heal creation broadcast lands on the env stream.
    act(() => {
      useAppStore.getState().applyWorldSessionMessage({
        kind: 'world-session',
        envId: 'env-1',
        status: 'idle',
        simTimeSec: 7,
        simulationId: 'sim-env-1-world-session',
      });
    });

    const button = await screen.findByRole('button', { name: '进入世界仿真' });
    expect(button).toBeDefined();
    expect(useAppStore.getState().world?.worldSession?.simulationId).toBe(
      'sim-env-1-world-session',
    );
  });
});

describe('T-713(c): sidebar 业务流 quick link with flow count', () => {
  const WORLD = {
    id: 'env-1',
    name: 'flows-badge',
    description: '',
    visibility: 'public',
    myRole: 'builder',
    mapData: null,
    zones: [],
    devices: [],
    agents: [],
    services: [],
    members: [{ userId: 'u-biz', displayName: 'biz', role: 'builder' }],
    mySubscriptions: [],
  } as unknown as EnvironmentDetail;

  function flow(id: string, createdBy: string | null) {
    return {
      id,
      envId: 'env-1',
      name: id,
      description: '',
      enabled: true,
      trigger: { kind: 'event', event: { eventType: 'x' } },
      plan: { nodes: [] },
      createdBy,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  beforeEach(() => {
    void i18n.changeLanguage('zh-CN');
    useAppStore.setState({
      user: { id: 'u-1', email: 'u@x', displayName: 'U', createdAt: '2026-01-01T00:00:00.000Z' },
      selection: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the count badge and the per-author split tooltip', async () => {
    listFlowsMock.mockResolvedValue([
      ...Array.from({ length: 6 }, (_, i) => flow(`f-biz-${i}`, 'u-biz')),
      ...Array.from({ length: 4 }, (_, i) => flow(`f-other-${i}`, 'u-choreo')),
    ]);
    renderWithProviders(
      <WorldSidebar world={WORLD} tab="devices" onTabChange={() => {}} />,
    );

    const link = await screen.findByRole('link', { name: /业务流/ });
    expect(link.getAttribute('href')).toBe('/environments/env-1/flows');
    // The badge + tooltip land once the cached list resolves.
    await waitFor(() => expect(link.textContent).toContain('10'));
    // '6 biz + 4 choreo' — author not in the member list falls back to the id.
    await waitFor(() => expect(link.getAttribute('title')).toContain('biz 6'));
    expect(link.getAttribute('title')).toContain('u-choreo 4');
    expect(listFlowsMock).toHaveBeenCalledWith('env-1');
  });

  it('no badge and an empty tooltip when the list is empty', async () => {
    listFlowsMock.mockResolvedValue([]);
    renderWithProviders(
      <WorldSidebar world={WORLD} tab="devices" onTabChange={() => {}} />,
    );

    const link = await screen.findByRole('link', { name: /业务流/ });
    await waitFor(() => expect(link.getAttribute('title')).toContain('尚无业务流'));
    expect(link.textContent).not.toMatch(/\d/);
  });

  it('hidden for anonymous visitors (flows page requires login)', async () => {
    useAppStore.setState({ user: null });
    listFlowsMock.mockResolvedValue([flow('f-1', 'u-biz')]);
    renderWithProviders(
      <WorldSidebar world={WORLD} tab="devices" onTabChange={() => {}} />,
    );

    await screen.findByText('设备');
    expect(screen.queryByRole('link', { name: /业务流/ })).toBeNull();
    expect(listFlowsMock).not.toHaveBeenCalled();
  });
});
