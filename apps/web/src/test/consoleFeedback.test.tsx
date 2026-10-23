/**
 * T-028 console feedback debts:
 * - EA-F05: a transient snapshot-poll failure stamps the 操作失败 line, and
 *   the poll's own next SUCCESS clears it (it used to survive for the rest
 *   of the session — only a control click cleared it);
 * - EA-F08: openSimulationConsole failures (workbench 运行中仿真 attach,
 *   stale cached sim id) surface a toast — the click used to be dead
 *   because the console that renders simulationError never mounts.
 */

import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScenarioDefinition } from '../api/types';
import { SimulationView } from '../pages/SimulationView';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { makeSnapshot } from './fixtures';
import { renderWithProviders } from './testUtils';

const SCENARIO: ScenarioDefinition = {
  version: '1.0',
  meta: { id: 'starter-home', name: '最小世界', description: '' },
  zones: [
    { id: 'living-room', name: '客厅', type: 'living-room', bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 }, adjacentZoneIds: [] },
  ],
  devices: [],
  agents: [
    { id: 'butler', name: '小管家', capabilities: [], managesZoneIds: ['living-room'], boundDeviceIds: [] },
  ],
  events: [],
};

const SNAP = makeSnapshot({
  state: 'running',
  zones: [{ id: 'living-room', name: '客厅', parameters: { temperature: 26 } }],
  agents: [],
});

const { getSnapshot, getEnvironment } = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  getEnvironment: vi.fn(),
}));

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return {
    ...mod,
    getSnapshot,
    getEnvironment,
    getSimulationCollaborations: vi.fn(async () => []),
  };
});

// reactflow (WorldMap canvas) needs measurement APIs jsdom lacks.
vi.mock('../components/worldmap/WorldMap', () => ({
  WorldMap: () => <div data-testid="world-map" />,
}));

// echarts mounting is meaningless in jsdom.
vi.mock('../lib/echarts', () => ({
  useECharts: vi.fn(() => () => undefined),
  chartPalette: () => ({
    text: '#fff', textDim: '#999', axisLine: '#333', splitLine: '#333',
    panelBg: '#111', border: '#333', accent: '#4cc2ff', ok: '#3fb950',
    danger: '#f2555a', actuator: '#f5a524', series: ['#f2555a'],
  }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  void i18n.changeLanguage('zh-CN');
  // jsdom has no WebSocket — a stub that never opens is fine (the stream
  // status degrades; the REST poll is the ground truth under test).
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
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('transient snapshot-poll errors clear on recovery (T-028/EA-F05)', () => {
  it('shows the error after a failed poll, clears it once polling recovers', async () => {
    // First poll (mount) succeeds via the seeded snapshot; the next poll
    // fails once (network blip), then recovers.
    let calls = 0;
    getSnapshot.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('network blip');
      return SNAP;
    });

    renderWithProviders(<SimulationView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    // The failed poll stamped the persistent error line.
    expect(screen.getByText(/操作失败：network blip/)).toBeTruthy();

    // Next poll succeeds → the line clears instead of surviving the session.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(screen.queryByText(/操作失败/)).toBeNull();
  });
});

describe('openSimulationConsole failure surfaces a toast (T-028/EA-F08)', () => {
  it('pushes a toast instead of a dead click', async () => {
    getEnvironment.mockRejectedValue(
      Object.assign(new Error('env gone'), { code: 'ENVIRONMENT_NOT_FOUND', status: 404 }),
    );

    await useAppStore.getState().openSimulationConsole('sim-x', 'env-x');

    const state = useAppStore.getState();
    expect(state.simulationError).toContain('env gone');
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0].text).toContain('打开仿真控制台失败');
    expect(state.toasts[0].text).toContain('env gone');
  });
});
