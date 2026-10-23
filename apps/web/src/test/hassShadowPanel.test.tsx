/**
 * HIL 反向映射 P2 — DeploymentPanel 的影子环境状态区：
 * 无影子时的创建入口；有影子时的徽标 + 设备观测/丢弃表 + 最近观测残差
 * 渲染；「重新 fork」/「销毁」动作触发对应 API 并刷新。
 */

import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../api/client';
import type { EnvironmentDetail } from '../api/types';
import { DeploymentPanel } from '../components/world/DeploymentPanel';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

const clientMocks = vi.hoisted(() => ({
  getDeployment: vi.fn(async () => ({
    envId: 'env-1',
    environment: { id: 'env-1', name: '部署测试环境' },
    myAgents: [],
    devicesToDeploy: [],
    servicesToOffer: [],
    servicesConsumed: [],
    notes: [],
    generatedAt: '2026-09-04T00:00:00.000Z',
  })),
  listSimulations: vi.fn(async () => []),
  listHassAudit: vi.fn(async () => []),
  listHassPending: vi.fn(async () => []),
  listHassPolicies: vi.fn(async () => []),
  getHassEstop: vi.fn(async () => ({ active: false })),
  getHassStatus: vi.fn(async () => ({ configured: true, state: 'ready', entityCount: 3 })),
  listHassEntities: vi.fn(async () => []),
}));

const reverseSyncMocks = vi.hoisted(() => ({
  getHassReverseSync: vi.fn(async () => ({
    policy: 'manual',
    estopActive: false,
    hass: { configured: true, state: 'ready' },
    boundDevices: 0,
    drift: [],
    recentAlignments: [],
  })),
  alignHassReverseSyncNow: vi.fn(),
}));

const SHADOW_STATUS = {
  envId: 'env-1',
  sandboxId: 'fork-1',
  simulationId: 'sim-fork-1',
  state: 'paused',
  simTimeSec: 12.34,
  fromCheckpoint: false,
  createdBy: 'u-1',
  createdAt: '2026-09-04T00:00:00.000Z',
  anchor: { wallMs: 1788000000000, simTimeSec: 0 },
  estopActive: false,
  hass: { configured: true, state: 'ready' },
  boundDevices: [
    {
      deviceId: 'dev-1',
      deviceName: '客厅温度计',
      entityId: 'sensor.living_room_temperature',
      observations: 3,
      discardedCommands: 1,
    },
  ],
  observationCount: 3,
  discardedCommandCount: 1,
  lastObservationAt: '2026-09-04T01:02:03.000Z',
  recentObservations: [
    {
      id: 'obs-1',
      at: '2026-09-04T01:02:03.000Z',
      deviceId: 'dev-1',
      deviceName: '客厅温度计',
      entityId: 'sensor.living_room_temperature',
      simTimeSec: 12.3,
      changes: [{ key: 'state', predicted: 21.5, observed: 23.7 }],
    },
  ],
};

const shadowMocks = vi.hoisted(() => ({
  getHassShadow: vi.fn(async () => SHADOW_STATUS),
  createHassShadow: vi.fn(async () => SHADOW_STATUS),
  deleteHassShadow: vi.fn(async () => undefined),
}));

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return { ...mod, ...clientMocks };
});

vi.mock('../api/hassReverseSync', () => reverseSyncMocks);
vi.mock('../api/hassShadow', () => shadowMocks);

const WORLD = {
  id: 'env-1',
  name: '部署测试环境',
  visibility: 'public',
  myRole: 'owner',
  zones: [],
  devices: [],
  agents: [],
  services: [],
  members: [],
} as unknown as EnvironmentDetail;

beforeEach(() => {
  void i18n.changeLanguage('zh-CN');
  useAppStore.setState({
    user: { id: 'u-1', email: 'u@x', displayName: 'U', createdAt: '2026-01-01T00:00:00.000Z' },
    toasts: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DeploymentPanel 影子环境状态区（HIL P2）', () => {
  it('渲染徽标、设备观测/丢弃表与最近观测残差', async () => {
    renderWithProviders(<DeploymentPanel world={WORLD} />);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    expect(screen.getByText('影子环境（观测驱动的 fork）')).toBeTruthy();
    expect(screen.getByText('影子 · fork 自基座层')).toBeTruthy();
    // 设备表：观测 3 次、致动丢弃 1 次。
    expect(screen.getByText('客厅温度计')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    // 最近观测：实体 + 残差（预测 → 观测）。
    expect(screen.getAllByText('sensor.living_room_temperature').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/21\.5 → 23\.7/)).toBeTruthy();
  });

  it('「重新 fork」与「销毁」触发对应 API 并刷新', async () => {
    renderWithProviders(<DeploymentPanel world={WORLD} />);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(shadowMocks.getHassShadow).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('重新 fork'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(shadowMocks.createHassShadow).toHaveBeenCalledWith('env-1', true);

    fireEvent.click(screen.getByText('销毁'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(shadowMocks.deleteHassShadow).toHaveBeenCalledWith('env-1');
  });

  it('SHADOW_NOT_FOUND 时显示创建入口，「创建影子」触发 create', async () => {
    shadowMocks.getHassShadow.mockRejectedValueOnce(
      new ApiClientError(404, 'SHADOW_NOT_FOUND', 'no shadow'),
    );
    renderWithProviders(<DeploymentPanel world={WORLD} />);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    expect(screen.getByText(/暂无影子环境/)).toBeTruthy();
    fireEvent.click(screen.getByText('创建影子'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(shadowMocks.createHassShadow).toHaveBeenCalledWith('env-1');
  });
});
