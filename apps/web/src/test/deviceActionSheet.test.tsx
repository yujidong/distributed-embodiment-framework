/**
 * UX-W1 wave-1 task B — console device action sheet:
 *
 * - lib/deviceCommands: the command face derives from capabilities exactly
 *   like the core deriveDeviceCommands — read-only capabilities (the
 *   get/read/query/check/measure/sense/detect + sensing-noun vocabulary of
 *   packages/core/src/capabilities/read-only.ts) never appear as commands;
 * - DeviceActionSheet: picking a command + optional params JSON executes via
 *   api.sendDeviceCommand with the right arguments, success refreshes the
 *   snapshot in place, failures surface the server teaching text as a toast;
 * - viewer boundary: canExecute=false hides the execute button.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SnapshotDevice } from '../api/types';
import { ApiClientError } from '../api/client';
import { DeviceActionSheet } from '../components/DeviceActionSheet';
import i18n from '../i18n/config';
import { deriveDeviceCommandFace, isReadOnlyCapabilityName } from '../lib/deviceCommands';
import type { WorldModelDevice } from '../lib/worldModel';
import { useAppStore } from '../store/useAppStore';
import { makeSnapshot } from './fixtures';

const { sendDeviceCommand, getSnapshot } = vi.hoisted(() => ({
  sendDeviceCommand: vi.fn(),
  getSnapshot: vi.fn(),
}));

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return { ...mod, sendDeviceCommand, getSnapshot };
});

const DEVICE: WorldModelDevice = {
  id: 'hvac-1',
  name: '客厅空调',
  type: 'hvac',
  role: 'hybrid',
  capabilities: ['temperature-reading', 'turn-on', 'turn-off', 'set-temperature', 'detect-fault'],
  zoneId: 'living-room',
  position: null,
  latLng: null,
  ownerId: null,
  ownerName: null,
  initialState: null,
};

const LIVE: SnapshotDevice = {
  id: 'hvac-1',
  name: '客厅空调',
  type: 'hvac',
  role: 'hybrid',
  zoneId: 'living-room',
  state: { power: 'on', targetTemperature: 24 },
};

function renderSheet(overrides: Partial<Parameters<typeof DeviceActionSheet>[0]> = {}) {
  return render(
    <DeviceActionSheet
      simulationId="sim-1"
      device={DEVICE}
      live={LIVE}
      canExecute={true}
      onClose={() => undefined}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  void i18n.changeLanguage('zh-CN');
  useAppStore.setState({ toasts: [], snapshot: null });
  sendDeviceCommand.mockResolvedValue({ success: true, result: { ok: true } });
  getSnapshot.mockResolvedValue(makeSnapshot());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('deriveDeviceCommandFace (lib/deviceCommands)', () => {
  it('filters read-only capabilities, lowercases and dedupes', () => {
    expect(deriveDeviceCommandFace(DEVICE.capabilities)).toEqual([
      'turn-on',
      'turn-off',
      'set-temperature',
    ]);
    expect(deriveDeviceCommandFace(['Turn-On', 'turn-on', 'GET-state'])).toEqual(['turn-on']);
  });

  it('mirrors the core read-only predicate vocabulary', () => {
    for (const name of [
      'get-state', 'read-temperature', 'query-status', 'check-health',
      'measure-power', 'sense-motion', 'detect-smoke', 'temperature-reading',
      'co2-monitoring', 'smoke-detection',
    ]) {
      expect(isReadOnlyCapabilityName(name)).toBe(true);
    }
    for (const name of ['turn-off', 'set-temperature', 'set-brightness', 'lock', 'unlock']) {
      expect(isReadOnlyCapabilityName(name)).toBe(false);
    }
  });
});

describe('DeviceActionSheet', () => {
  it('renders only the executable command face (read-only filtered)', () => {
    renderSheet();
    expect(screen.getByRole('button', { name: 'turn-off' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'set-temperature' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'temperature-reading' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'detect-fault' })).toBeNull();
  });

  it('shows the honest note for a pure-sensor device (zero executable commands)', () => {
    renderSheet({
      device: { ...DEVICE, role: 'sensor', capabilities: ['temperature-reading', 'detect-smoke'] },
    });
    expect(screen.getByText('只读设备 —— 能力均为观测类，没有可执行命令。')).toBeTruthy();
  });

  it('executes the picked command with parsed params and refreshes the snapshot', async () => {
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'set-temperature' }));
    fireEvent.change(screen.getByLabelText('命令参数（JSON，可空）'), {
      target: { value: '{"temperature": 20}' },
    });
    fireEvent.click(screen.getByRole('button', { name: '执行 set-temperature' }));
    await waitFor(() => {
      expect(sendDeviceCommand).toHaveBeenCalledWith('sim-1', 'hvac-1', 'set-temperature', {
        temperature: 20,
      });
    });
    // The sheet now waits ~1 tick (1200ms) before re-fetching the snapshot
    // (command lands on the next engine tick) — give waitFor headroom.
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledWith('sim-1'), { timeout: 3000 });
    const toasts = useAppStore.getState().toasts;
    expect(toasts.some(toast => toast.kind === 'success')).toBe(true);
  });

  it('sends without params when the params input is blank', async () => {
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'turn-off' }));
    fireEvent.click(screen.getByRole('button', { name: '执行 turn-off' }));
    await waitFor(() => {
      expect(sendDeviceCommand).toHaveBeenCalledWith('sim-1', 'hvac-1', 'turn-off', undefined);
    });
  });

  it('surfaces the server teaching text when the command fails', async () => {
    sendDeviceCommand.mockRejectedValue(new Error('capability "turn-off" is read-only on this device'));
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'turn-off' }));
    fireEvent.click(screen.getByRole('button', { name: '执行 turn-off' }));
    await waitFor(() => {
      const toasts = useAppStore.getState().toasts;
      expect(
        toasts.some(
          toast => toast.kind === 'error' && toast.text.includes('is read-only on this device'),
        ),
      ).toBe(true);
    });
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('rejects malformed params JSON before calling the API', async () => {
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'turn-off' }));
    fireEvent.change(screen.getByLabelText('命令参数（JSON，可空）'), {
      target: { value: '[1,2]' },
    });
    fireEvent.click(screen.getByRole('button', { name: '执行 turn-off' }));
    await waitFor(() => {
      expect(useAppStore.getState().toasts.some(toast => toast.kind === 'error')).toBe(true);
    });
    expect(sendDeviceCommand).not.toHaveBeenCalled();
  });

  it('hides the execute button for viewers (canExecute=false)', () => {
    renderSheet({ canExecute: false });
    fireEvent.click(screen.getByRole('button', { name: 'turn-off' }));
    expect(screen.queryByRole('button', { name: '执行 turn-off' })).toBeNull();
    expect(screen.getByText('viewer 角色 —— 已隐藏命令执行入口。')).toBeTruthy();
  });

  // ── UX-R2 console polish ──

  it('renders friendly command labels with the raw token as subtitle (PM batch-7)', () => {
    renderSheet();
    const button = screen.getByRole('button', { name: 'set-temperature' });
    expect(button.textContent).toContain('设定温度');
    expect(
      button.querySelector('.device-action-sheet__command-raw')?.textContent,
    ).toBe('set-temperature');
  });

  it('renders the device state as friendly key-values, not bare JSON (PM batch-7)', () => {
    renderSheet();
    expect(screen.getByTestId('device-action-state').textContent).toBe('开 · 目标温度 24°C');
  });

  it('localizes 409 DEVICE_NOT_MANAGED with binding guidance (R2-UX-03)', async () => {
    sendDeviceCommand.mockRejectedValue(
      new ApiClientError(
        409,
        'DEVICE_NOT_MANAGED',
        'Device "hvac-1" exists but no agent manages it — bind it to an agent first',
      ),
    );
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'turn-off' }));
    fireEvent.click(screen.getByRole('button', { name: '执行 turn-off' }));
    await waitFor(() => {
      const toasts = useAppStore.getState().toasts;
      expect(
        toasts.some(
          toast => toast.kind === 'error' && toast.text.includes('绑定给一个 Agent'),
        ),
      ).toBe(true);
    });
    // The raw English teaching text must NOT be what the user sees.
    expect(
      useAppStore.getState().toasts.some(toast => toast.text.includes('bind it to an agent')),
    ).toBe(false);
  });

  it('localizes the frozen-snapshot DEVICE_NOT_MANAGED variant (R2-UX-03)', async () => {
    sendDeviceCommand.mockRejectedValue(
      new ApiClientError(
        409,
        'DEVICE_NOT_MANAGED',
        'Device "hvac-1" is managed by an agent in the environment now, but this simulation is a frozen snapshot of the world at creation time — recreate the simulation',
      ),
    );
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'turn-off' }));
    fireEvent.click(screen.getByRole('button', { name: '执行 turn-off' }));
    await waitFor(() => {
      const toasts = useAppStore.getState().toasts;
      expect(
        toasts.some(toast => toast.kind === 'error' && toast.text.includes('重新创建仿真')),
      ).toBe(true);
    });
  });
});
