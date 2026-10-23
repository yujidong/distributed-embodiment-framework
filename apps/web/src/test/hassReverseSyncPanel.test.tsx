/**
 * HIL 反向映射 P1 — DeploymentPanel 的反向同步只读状态区：
 * 策略徽标 + 当前漂移表 + 最近对齐记录渲染；「从现实对齐」按钮触发
 * align-now 并刷新（E-stop 拒绝时 toast 服务器消息）。
 */

import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    boundDevices: 1,
    drift: [
      {
        envId: 'env-1',
        deviceId: 'dev-1',
        deviceName: '客厅温度计',
        entityId: 'sensor.living_room_temperature',
        key: 'state',
        simValue: null,
        hassValue: 21.5,
      },
    ],
    recentAlignments: [
      {
        id: 'align-1',
        at: '2026-09-04T01:02:03.000Z',
        trigger: 'manual',
        actorId: 'u-1',
        envId: 'env-1',
        deviceId: 'dev-1',
        entityId: 'sensor.living_room_temperature',
        changes: [{ key: 'state', before: 20, after: 21.5 }],
      },
    ],
  })),
  alignHassReverseSyncNow: vi.fn(async () => ({
    trigger: 'manual',
    alignedDevices: 1,
    unchangedDevices: 0,
    alignments: [],
  })),
}));

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return { ...mod, ...clientMocks };
});

vi.mock('../api/hassReverseSync', () => reverseSyncMocks);

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

describe('DeploymentPanel 反向同步状态区（HIL P1）', () => {
  it('渲染策略、漂移表与最近对齐记录', async () => {
    renderWithProviders(<DeploymentPanel world={WORLD} />);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    expect(screen.getByText('反向同步（现实 → 仿真）')).toBeTruthy();
    expect(screen.getByText('策略：手动对齐')).toBeTruthy();
    // 漂移表：设备名 + 参数键 + 两侧值。
    expect(screen.getByText('客厅温度计')).toBeTruthy();
    expect(screen.getAllByText('state').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('21.5')).toBeTruthy();
    // 最近记录：实体 + 触发方式 + 变更数。
    expect(screen.getAllByText('sensor.living_room_temperature').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/1 项变更/)).toBeTruthy();
  });

  it('「从现实对齐」触发 align-now 并刷新状态', async () => {
    renderWithProviders(<DeploymentPanel world={WORLD} />);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(reverseSyncMocks.getHassReverseSync).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('从现实对齐'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    expect(reverseSyncMocks.alignHassReverseSyncNow).toHaveBeenCalledTimes(1);
    expect(reverseSyncMocks.getHassReverseSync).toHaveBeenCalledTimes(2);
    const toasts = useAppStore.getState().toasts;
    expect(toasts.some(toast => toast.text.includes('1 台已更新'))).toBe(true);
  });

  it('align-now 被拒（如 E-stop）时 toast 服务器消息', async () => {
    reverseSyncMocks.alignHassReverseSyncNow.mockRejectedValueOnce(
      new Error('Reverse sync blocked: emergency stop active'),
    );
    renderWithProviders(<DeploymentPanel world={WORLD} />);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    fireEvent.click(screen.getByText('从现实对齐'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    const toasts = useAppStore.getState().toasts;
    expect(toasts.some(toast => toast.text.includes('emergency stop active'))).toBe(true);
  });
});
