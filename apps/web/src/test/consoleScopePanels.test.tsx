/**
 * T-027 zone-scoped console: EventInjectPanel's zone dropdown and
 * FaultPanel's device dropdown must be intersected with the sim snapshot —
 * the console scenario is rebuilt from the FULL environment, so a
 * zone-scoped simulation (zoneIds subset) would otherwise default to an
 * out-of-scope target and submit a raw UNKNOWN_ZONE / DEVICE_NOT_FOUND.
 *
 * - options: scenario ∩ snapshot only (out-of-scope targets not offered);
 * - a full-world default is re-defaulted into the scope once the snapshot
 *   arrives (attach/deep-link arrival case);
 * - submit uses the scoped target (and the send-side guards live in
 *   lib/consoleScope, covered by the lib assertions below).
 */

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineSnapshot, ScenarioDefinition } from '../api/types';
import { EventInjectPanel } from '../components/EventInjectPanel';
import { FaultPanel } from '../components/FaultPanel';
import { deviceInSnapshot, zoneInSnapshot } from '../lib/consoleScope';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { makeSnapshot } from './fixtures';
import { renderWithProviders } from './testUtils';

const { injectEvent, setDeviceFault } = vi.hoisted(() => ({
  injectEvent: vi.fn(async (_id: string, _body: unknown) => ({ eventId: 'evt-1', targetAgentIds: ['a-1'] })),
  setDeviceFault: vi.fn(async (_simId: string, _deviceId: string, _profile: unknown) => ({ deviceId: 'ac-202', fault: {} })),
}));

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return {
    ...mod,
    injectEvent,
    setDeviceFault,
  };
});

const SCENARIO: ScenarioDefinition = {
  version: '1.0',
  meta: { id: 'teaching-building', name: '教学楼', description: 'zone-scoped sim test' },
  zones: [
    { id: 'classroom-101', name: '101 教室', type: 'classroom', bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 }, adjacentZoneIds: [] },
    { id: 'classroom-202', name: '202 教室', type: 'classroom', bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 }, adjacentZoneIds: [] },
    { id: 'hallway', name: '走廊', type: 'hallway', bounds: { minX: 0, maxX: 8, minY: 0, maxY: 2 }, adjacentZoneIds: [] },
  ],
  devices: [
    { id: 'ac-101', name: '101 空调', type: 'air-conditioner', role: 'actuator', capabilities: ['cooling'], zoneId: 'classroom-101', binding: 'sim://ac-101' },
    { id: 'ac-202', name: '202 空调', type: 'air-conditioner', role: 'actuator', capabilities: ['cooling'], zoneId: 'classroom-202', binding: 'sim://ac-202' },
    { id: 'lamp-hallway', name: '走廊灯', type: 'light', role: 'actuator', capabilities: ['lighting-control'], zoneId: 'hallway', binding: 'sim://lamp-hallway' },
  ],
  agents: [],
  events: [],
};

/** A sim created with zoneIds: ['classroom-202'] — only that zone ran. */
const SCOPED_SNAPSHOT: EngineSnapshot = makeSnapshot({
  state: 'running',
  zones: [{ id: 'classroom-202', name: '202 教室', parameters: { temperature: 26 } }],
  devices: [
    { id: 'ac-202', name: '202 空调', type: 'air-conditioner', role: 'actuator', zoneId: 'classroom-202', state: {}, fault: null },
  ],
  agents: [],
});

function selectOptions(label: string): Array<{ value: string; text: string }> {
  return Array.from(screen.getByLabelText(label).querySelectorAll('option')).map(option => ({
    value: (option as HTMLOptionElement).value,
    text: option.textContent ?? '',
  }));
}

beforeEach(() => {
  void i18n.changeLanguage('zh-CN');
  useAppStore.setState({
    simulationId: 'sim-1',
    snapshot: SCOPED_SNAPSHOT,
    simulationError: null,
    eventLog: [],
    triggerHints: {},
    toasts: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EventInjectPanel zone scoping (T-027)', () => {
  it('offers only snapshot zones; the full-world default is re-defaulted into scope', () => {
    renderWithProviders(<EventInjectPanel scenario={SCENARIO} />);

    const options = selectOptions('区域');
    expect(options.map(option => option.value)).toEqual(['classroom-202']);
    // scenario.zones[0] is classroom-101 — the select must NOT sit on it.
    const select = screen.getByLabelText('区域') as HTMLSelectElement;
    expect(select.value).toBe('classroom-202');
    expect(screen.queryByText('101 教室')).toBeNull();
  });

  it('re-defaults when the snapshot arrives after mount (attach/deep-link arrival)', async () => {
    useAppStore.setState({ snapshot: null });
    renderWithProviders(<EventInjectPanel scenario={SCENARIO} />);

    // No snapshot yet: full scenario list, full-world default.
    expect(selectOptions('区域').map(option => option.value)).toEqual([
      'classroom-101',
      'classroom-202',
      'hallway',
    ]);

    act(() => {
      useAppStore.setState({ snapshot: SCOPED_SNAPSHOT });
    });
    await waitFor(() => {
      const select = screen.getByLabelText('区域') as HTMLSelectElement;
      expect(select.value).toBe('classroom-202');
    });
    expect(selectOptions('区域').map(option => option.value)).toEqual(['classroom-202']);
  });

  it('submits the scoped zone (no out-of-scope target in the payload)', async () => {
    renderWithProviders(<EventInjectPanel scenario={SCENARIO} />);
    fireEvent.click(screen.getByText('注入事件'));

    await waitFor(() => expect(injectEvent).toHaveBeenCalledTimes(1));
    expect(injectEvent.mock.calls[0][1]).toMatchObject({ zoneId: 'classroom-202' });
    expect(screen.getByText(/已注入 evt-1/)).toBeTruthy();
  });

  it('UX-13: the occupancy preset fills parameter=occupancy with the 120 example value', () => {
    renderWithProviders(<EventInjectPanel scenario={SCENARIO} />);

    const typeSelect = screen.getByLabelText('类型') as HTMLSelectElement;
    const occupancyOption = Array.from(typeSelect.options)
      .find(option => option.textContent?.includes('occupancy'));
    expect(occupancyOption).toBeDefined();

    fireEvent.change(typeSelect, { target: { value: occupancyOption!.value } });
    expect((screen.getByLabelText('参数') as HTMLInputElement).value).toBe('occupancy');
    expect((screen.getByLabelText('数值') as HTMLInputElement).value).toBe('120');
  });
});

describe('FaultPanel device scoping (T-027)', () => {
  it('offers only snapshot devices; the full-world default is re-defaulted into scope', async () => {
    renderWithProviders(<FaultPanel scenario={SCENARIO} />);

    const options = selectOptions('设备');
    expect(options.map(option => option.value)).toEqual(['ac-202']);
    const select = screen.getByLabelText('设备') as HTMLSelectElement;
    expect(select.value).toBe('ac-202');
    expect(screen.queryByText(/101 空调/)).toBeNull();

    // A fault must be enabled for serializeFaultForm to produce a profile.
    fireEvent.click(screen.getByLabelText(/离线/));
    fireEvent.click(screen.getByText('注入故障'));
    await waitFor(() => expect(setDeviceFault).toHaveBeenCalledTimes(1));
    expect(setDeviceFault.mock.calls[0][1]).toBe('ac-202');
  });

  it('re-defaults when the snapshot arrives after mount', async () => {
    useAppStore.setState({ snapshot: null });
    renderWithProviders(<FaultPanel scenario={SCENARIO} />);

    expect(selectOptions('设备').map(option => option.value)).toEqual([
      'ac-101',
      'ac-202',
      'lamp-hallway',
    ]);

    act(() => {
      useAppStore.setState({ snapshot: SCOPED_SNAPSHOT });
    });
    await waitFor(() => {
      const select = screen.getByLabelText('设备') as HTMLSelectElement;
      expect(select.value).toBe('ac-202');
    });
  });
});

describe('consoleScope send-side guards (T-027)', () => {
  it('zoneInSnapshot / deviceInSnapshot classify scope membership', () => {
    expect(zoneInSnapshot(SCOPED_SNAPSHOT, 'classroom-202')).toBe(true);
    expect(zoneInSnapshot(SCOPED_SNAPSHOT, 'classroom-101')).toBe(false);
    expect(zoneInSnapshot(null, 'classroom-202')).toBe(false);
    expect(deviceInSnapshot(SCOPED_SNAPSHOT, 'ac-202')).toBe(true);
    expect(deviceInSnapshot(SCOPED_SNAPSHOT, 'ac-101')).toBe(false);
    expect(deviceInSnapshot(null, 'ac-202')).toBe(false);
  });
});
