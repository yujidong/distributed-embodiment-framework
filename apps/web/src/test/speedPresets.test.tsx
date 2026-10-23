/**
 * A4 speed presets: the ControlBar renders three semantic steps
 * (实时 ×1 / 演示 ×60 / 极速 ×400) in both the normal and present bars, and
 * changing the preset while running re-calls start() with the new speed.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../api/client';
import { ControlBar, SpeedSelect } from '../components/ControlBar';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { makeSnapshot } from './fixtures';

const SNAP = makeSnapshot({ state: 'running' });

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return {
    ...mod,
    getSnapshot: vi.fn(async () => SNAP),
    startSimulation: vi.fn(async () => ({ id: 'sim-1', state: 'running' })),
  };
});

const startMock = vi.mocked(api.startSimulation);

beforeEach(async () => {
  // The i18n language leaks across test files in a worker; pin it.
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAppStore.setState({ simulationId: null, snapshot: null, simulationError: null });
});

function seedStore() {
  useAppStore.setState({
    simulationId: 'sim-1',
    simulationInfo: null,
    simulationError: null,
    snapshot: SNAP,
    streamStatus: 'idle',
    eventLog: [],
  });
}

describe('ControlBar speed presets (A4)', () => {
  it('renders the three semantic presets in the normal bar', () => {
    seedStore();
    render(<ControlBar snapshot={SNAP} />);
    const options = screen.getAllByRole('option');
    expect(options.map(o => o.textContent)).toEqual(['实时 ×1', '演示 ×60', '极速 ×400']);
    expect(options.map(o => (o as HTMLOptionElement).value)).toEqual(['1', '60', '400']);
  });

  it('renders the same presets in the present bar', () => {
    seedStore();
    render(<ControlBar snapshot={SNAP} present />);
    const options = screen.getAllByRole('option');
    expect(options.map(o => o.textContent)).toEqual(['实时 ×1', '演示 ×60', '极速 ×400']);
  });

  it('re-calls start() with the preset speed when changed while running', async () => {
    seedStore();
    render(<ControlBar snapshot={SNAP} />);
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: '60' } });
    await waitFor(() => expect(startMock).toHaveBeenCalledWith('sim-1', 60));
  });

  it('T-028/EA-F03: adopts snapshot.speed on attach/deep-link (select shows the real pace)', async () => {
    // A sim started elsewhere at ×400: the select used to stay at 1× until
    // the user touched it (pause+开始 then silently retargeted to 1×).
    const fast = makeSnapshot({ state: 'running', speed: 400 });
    useAppStore.setState({
      simulationId: 'sim-1',
      simulationInfo: null,
      simulationError: null,
      snapshot: fast,
      streamStatus: 'idle',
      eventLog: [],
    });
    render(<ControlBar snapshot={fast} />);
    await waitFor(() => {
      expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('400');
    });
  });

  it('T-028/EA-F03: adopts a later snapshot speed change (CLI / another browser)', async () => {
    seedStore();
    const { rerender } = render(<ControlBar snapshot={SNAP} />);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('1');

    const faster = makeSnapshot({ state: 'running', speed: 60 });
    rerender(<ControlBar snapshot={faster} />);
    await waitFor(() => {
      expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('60');
    });
  });
});

describe('SpeedSelect non-preset value (R14)', () => {
  it('appends a temporary option showing the actual value instead of blank', () => {
    render(<SpeedSelect speed={100} disabled={false} onChange={() => {}} />);
    const options = screen.getAllByRole('option');
    expect(options.map(o => o.textContent)).toEqual(['实时 ×1', '演示 ×60', '极速 ×400', '自定义 ×100']);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('100');
  });

  it('does not duplicate the option for a preset value', () => {
    render(<SpeedSelect speed={60} disabled={false} onChange={() => {}} />);
    const options = screen.getAllByRole('option');
    expect(options.map(o => o.textContent)).toEqual(['实时 ×1', '演示 ×60', '极速 ×400']);
  });
});
