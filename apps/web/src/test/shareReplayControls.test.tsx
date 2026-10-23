/**
 * ShareReplayControls (UX-W5 子任务 C): the share page's playback bar —
 * play/pause toggle, interval-driven position advance, slider seek and
 * speed select, auto-pause + replay-from-start at the window end.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShareReplayControls } from '../components/share/ShareReplayControls';
import i18n from '../i18n/config';
import {
  buildShareReplayTimeline,
  type ShareReplayState,
  type ShareReplayTimeline,
} from '../lib/shareReplayClock';

const TIMELINE: ShareReplayTimeline = buildShareReplayTimeline([
  { id: 'a', type: 'sim-decision', zoneId: 'z-a', atSimTimeSec: 0, details: {} },
  { id: 'b', type: 'sim-decision', zoneId: 'z-a', atSimTimeSec: 600, details: {} },
]);
// 600 s window → 1× rate = 10 sim-s per wall-s.

function Harness({ timeline = TIMELINE }: { timeline?: ShareReplayTimeline }) {
  const [state, setState] = useState<ShareReplayState | null>(null);
  return <ShareReplayControls timeline={timeline} state={state} onChange={setReplay => setState(setReplay)} />;
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ShareReplayControls', () => {
  it('renders nothing when the timeline has fewer than two items', () => {
    const { container } = render(
      <Harness
        timeline={buildShareReplayTimeline([
          { id: 'a', type: 'sim-decision', zoneId: 'z-a', atSimTimeSec: 0, details: {} },
        ])}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('play starts the clock; the slider and time label track the advance', () => {
    render(<Harness />);
    const slider = screen.getByLabelText('回放进度') as HTMLInputElement;
    expect(slider.value).toBe('0');

    fireEvent.click(screen.getByRole('button', { name: '播放' }));
    act(() => {
      vi.advanceTimersByTime(1000); // 10 ticks × 0.1 s × 10 sim-s/s = 10 sim-s
    });
    expect(slider.value).toBe('10');
    expect(screen.getByText('t = 10 s / 600 s')).toBeTruthy();
  });

  it('pause freezes the position; play resumes from it', () => {
    render(<Harness />);
    const slider = screen.getByLabelText('回放进度') as HTMLInputElement;

    fireEvent.click(screen.getByRole('button', { name: '播放' }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(slider.value).toBe('10'); // 暂停期间不动

    fireEvent.click(screen.getByRole('button', { name: '播放' }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(slider.value).toBe('20'); // 从暂停点继续
  });

  it('seeking the slider jumps the position', () => {
    render(<Harness />);
    const slider = screen.getByLabelText('回放进度') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '300' } });
    expect(screen.getByText('t = 300 s / 600 s')).toBeTruthy();
  });

  it('speed select applies the multiplier on the next ticks', () => {
    render(<Harness />);
    const slider = screen.getByLabelText('回放进度') as HTMLInputElement;
    fireEvent.change(screen.getByLabelText('倍速'), { target: { value: '16' } });
    fireEvent.click(screen.getByRole('button', { name: '播放' }));
    act(() => {
      vi.advanceTimersByTime(1000); // 10 × 0.1 s × 10 × 16 = 160 sim-s
    });
    expect(slider.value).toBe('160');
  });

  it('auto-pauses at the window end and offers replay-from-start', () => {
    render(<Harness />);
    const slider = screen.getByLabelText('回放进度') as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: '播放' }));
    act(() => {
      vi.advanceTimersByTime(120000); // far past the 60 s 1× playback length
    });
    expect(slider.value).toBe('600');
    const again = screen.getByRole('button', { name: '重新播放' });
    fireEvent.click(again);
    expect(slider.value).toBe('0'); // 从头再播
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(slider.value).toBe('10');
  });
});
