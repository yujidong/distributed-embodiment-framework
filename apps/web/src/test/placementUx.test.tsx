/**
 * F4/F7 回归（世界视图）：
 *
 * - F4：拖拽移动命中提案转换时按 status 分文案——rule 模式 low-risk 提案是
 *   `applied`（已生效），不能再显示「审批通过后设备才会移动」；pending 保留
 *   原文案；创建设备道（DeviceForm）此前已分，不再重复。
 * - F7：grid 档下 catalog 放置 / devicePick armed 也渲染 placement banner
 *   （此前仅 geo/3D 渲染，grid 下 armed 无提示无出口）。
 */

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../api/client';
import type { EnvironmentDetail } from '../api/types';
import { WorldViewPage } from '../pages/WorldViewPage';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return { ...mod, patchDevice: vi.fn() };
});

// reactflow / leaflet / babylon 画布在 jsdom 里无法挂载——换成桩组件；
// WorldMap 桩捕获 props 以便直接触发拖拽回调。
let worldMapProps: {
  onDeviceDragStop?: (deviceId: string, position: { x: number; y: number }) => void;
} | null = null;
vi.mock('../components/worldmap/WorldMap', () => ({
  WorldMap: (props: Record<string, unknown>) => {
    worldMapProps = props as typeof worldMapProps;
    return <div data-testid="world-map" />;
  },
}));
vi.mock('../components/worldmap/GeoWorldMap', () => ({
  GeoWorldMap: () => <div data-testid="geo-map" />,
}));
vi.mock('../components/campus/CampusScene', () => ({
  CampusScene: () => <div data-testid="building-3d" />,
}));

const patchDeviceMock = vi.mocked(api.patchDevice);

const GRID_WORLD = {
  id: 'env-1',
  name: '网格世界',
  description: '',
  visibility: 'public',
  myRole: 'builder',
  mapType: 'grid',
  mapCenter: null,
  demo: null,
  events: [],
  zones: [{ id: 'living-room', name: '客厅', bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 } }],
  devices: [],
  agents: [],
  services: [],
  members: [],
  mySubscriptions: [],
} as unknown as EnvironmentDetail;

function seedStore(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    user: { id: 'u-1', email: 'u@x', displayName: 'U', createdAt: '2026-01-01T00:00:00.000Z' },
    world: GRID_WORLD,
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
    ...overrides,
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
  worldMapProps = null;
  useAppStore.setState({ world: null, user: null, geoPlacement: null, devicePick: null, toasts: [] });
});

describe('F4：提案转换 toast 区分 applied / pending', () => {
  async function dragAndReadToast(status: string): Promise<string> {
    patchDeviceMock.mockResolvedValueOnce({ kind: 'proposal', id: 'p-1', status } as never);
    seedStore();
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });
    await screen.findByTestId('world-map');
    expect(worldMapProps?.onDeviceDragStop).toBeTypeOf('function');
    await act(async () => {
      worldMapProps?.onDeviceDragStop?.('dev-1', { x: 1, y: 2 });
    });
    await waitFor(() => expect(useAppStore.getState().toasts.length).toBeGreaterThan(0));
    cleanup();
    return useAppStore.getState().toasts.map(t => t.text).join('\n');
  }

  it('status=applied（rule 模式已生效）：提示已通过并生效，不再谎称待审批', async () => {
    const text = await dragAndReadToast('applied');
    expect(text).toContain('已通过并生效');
    expect(text).not.toContain('审批通过后设备才会移动');
  });

  it('status=pending：保留「审批通过后设备才会移动」原文案', async () => {
    const text = await dragAndReadToast('pending');
    expect(text).toContain('审批通过后设备才会移动');
  });
});

describe('F7：grid 档渲染 placement banner', () => {
  it('catalog 放置 armed：grid 档也显示放置横幅', async () => {
    seedStore({ geoPlacement: { modelId: 'model-1', zoneId: 'living-room' } });
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });

    await screen.findByTestId('world-map');
    expect(await screen.findByText(/点击地图放置设备/)).toBeTruthy();
  });

  it('devicePick armed：grid 档显示点选横幅，「取消」可退出', async () => {
    seedStore({ devicePick: { armed: true, point: null } });
    renderWithProviders(<WorldViewPage />, { initialEntries: ['/environments/env-1'] });

    await screen.findByTestId('world-map');
    expect(await screen.findByText(/点选模式：点击地图设置设备位置/)).toBeTruthy();
    fireEvent.click(screen.getByText('取消'));
    expect(useAppStore.getState().devicePick).toBeNull();
  });
});
