/**
 * F1 回归：catalog 放置（geo/3D 共用 completeGeoPlacement）双击竞态——
 * 发起请求前必须同步解除 armed，否则第二次 pointerup 在首个 POST in-flight
 * 期间仍看到 armed 态，双击 = 两建设备；失败时恢复 armed 允许重试。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../api/client';
import type { EnvironmentDetail, WorldDevice } from '../api/types';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return { ...mod, instantiateDevice: vi.fn() };
});

const instantiateMock = vi.mocked(api.instantiateDevice);

const WORLD = {
  id: 'env-1',
  name: '世界',
  devices: [],
  agents: [],
  zones: [],
  services: [],
  members: [],
} as unknown as EnvironmentDetail;

const PLACEMENT = { modelId: 'model-1', zoneId: 'zone-1' };
const DEVICE = { id: 'dev-1', name: '新设备', zoneId: 'zone-1' } as WorldDevice;

beforeEach(() => {
  void i18n.changeLanguage('zh-CN');
  useAppStore.setState({ world: WORLD, geoPlacement: { ...PLACEMENT }, toasts: [], user: null });
});

afterEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ world: null, geoPlacement: null, toasts: [] });
});

describe('completeGeoPlacement 双击竞态 (F1)', () => {
  it('请求发出前同步解除 armed：双击只建一台设备', async () => {
    let resolveFirst!: (device: WorldDevice) => void;
    instantiateMock.mockImplementation(
      () => new Promise<WorldDevice>(resolve => (resolveFirst = resolve)),
    );

    const first = useAppStore.getState().completeGeoPlacement({ lat: 31, lng: 121 });
    // In-flight 期间已解除 armed —— 第二次 pointerup 是 no-op。
    expect(useAppStore.getState().geoPlacement).toBeNull();
    await useAppStore.getState().completeGeoPlacement({ lat: 31, lng: 121 });

    resolveFirst(DEVICE);
    await first;

    expect(instantiateMock).toHaveBeenCalledTimes(1);
    expect(instantiateMock).toHaveBeenCalledWith('env-1', {
      modelId: 'model-1',
      zoneId: 'zone-1',
      position: { lat: 31, lng: 121 },
    });
    expect(useAppStore.getState().world?.devices).toHaveLength(1);
  });

  it('放置失败恢复 armed 态，用户可点击重试或取消', async () => {
    instantiateMock.mockRejectedValueOnce(new Error('boom'));

    await useAppStore.getState().completeGeoPlacement({ lat: 31, lng: 121 });

    expect(useAppStore.getState().geoPlacement).toEqual(PLACEMENT);
    expect(useAppStore.getState().toasts.map(t => t.text).join('\n')).toContain('放置失败');

    // 重试成功即正常落设备、解除 armed。
    instantiateMock.mockResolvedValueOnce(DEVICE);
    await useAppStore.getState().completeGeoPlacement({ lat: 32, lng: 122 });
    expect(useAppStore.getState().geoPlacement).toBeNull();
    expect(useAppStore.getState().world?.devices).toHaveLength(1);
  });
});
