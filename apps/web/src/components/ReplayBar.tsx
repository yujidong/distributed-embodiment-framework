/**
 * ReplayBar — timeline replay controls.
 *
 * Entering replay freezes nothing: REST polling keeps appending to the ring
 * buffer in the background; only the render selector switches from the live
 * snapshot to `replayBuffer[cursor]`. Play advances the cursor through
 * buffered entries (1× = 1 entry / 250 ms tick, 4× = 4 entries); reaching
 * the live edge pauses playback. Exiting snaps back to live instantly.
 *
 * Active replay also shows an echarts timeline above the controls
 * (ReplayTimeline): buffered temperature curve as area background, baked
 * sim-decision / device-state events as seek-able scatter dots, and a
 * markLine at the cursor — two-way synced with the native range slider
 * (kept for a11y / fallback) via the store's replayCursor.
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Rewind, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';

import type { ScenarioEvent } from '../api/types';
import { selectRenderedSnapshot } from '../lib/replay';
import { useAppStore, type ReplaySpeed } from '../store/useAppStore';
import { ReplayTimeline } from './ReplayTimeline';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';

const PLAY_TICK_MS = 250;

export interface ReplayBarProps {
  /** 场景事件（烘焙的 sim-decision / device-state 供时间轴散点）。 */
  events?: readonly ScenarioEvent[];
  /**
   * Wave-2 demo hint (scenario meta recommendedPlaybackRate): seeded as the
   * initial playback speed when replay activates; the select stays editable.
   */
  recommendedRate?: number;
}

export function ReplayBar({ events = [], recommendedRate }: ReplayBarProps) {
  const replayActive = useAppStore(s => s.replayActive);
  const replayPlaying = useAppStore(s => s.replayPlaying);
  const replaySpeed = useAppStore(s => s.replaySpeed);
  const replayCursor = useAppStore(s => s.replayCursor);
  const bufferLength = useAppStore(s => s.replayBuffer.length);
  const rendered = useAppStore(selectRenderedSnapshot);
  const enterReplay = useAppStore(s => s.enterReplay);
  const exitReplay = useAppStore(s => s.exitReplay);
  const setReplayCursor = useAppStore(s => s.setReplayCursor);
  const setReplayPlaying = useAppStore(s => s.setReplayPlaying);
  const setReplaySpeed = useAppStore(s => s.setReplaySpeed);
  const { t } = useTranslation('replay');

  // Playback: advance the cursor through the buffer; pause at the live edge.
  useEffect(() => {
    if (!replayActive || !replayPlaying) return;
    const handle = window.setInterval(() => {
      const state = useAppStore.getState();
      const next = state.replayCursor + state.replaySpeed;
      if (next >= state.replayBuffer.length - 1) {
        state.setReplayCursor(state.replayBuffer.length - 1);
        state.setReplayPlaying(false);
      } else {
        state.setReplayCursor(next);
      }
    }, PLAY_TICK_MS);
    return () => window.clearInterval(handle);
  }, [replayActive, replayPlaying]);

  const max = Math.max(bufferLength - 1, 0);

  // Entering replay seeds the scenario's recommended rate (when any) as the
  // initial speed; the user can still change it via the select below.
  const onEnterReplay = () => {
    enterReplay();
    if (recommendedRate !== undefined && Number.isFinite(recommendedRate) && recommendedRate >= 1) {
      setReplaySpeed(Math.floor(recommendedRate));
    }
  };

  if (!replayActive) {
    return (
      <div className="replay-bar">
        <Button onClick={onEnterReplay} disabled={bufferLength < 2} title={t('enterTitle')}>
          <Icon icon={Rewind} /> {t('enter')}
        </Button>
        <span className="replay-bar__hint">{t('cached', { count: bufferLength })}</span>
      </div>
    );
  }

  return (
    <div className="replay-bar replay-bar--active">
      <ReplayTimeline events={events} />
      <span className="replay-bar__badge">{t('activeBadge', { sec: rendered?.simTimeSec ?? 0 })}</span>
      <Button
        variant="ghost"
        aria-label={t('back10')}
        onClick={() => setReplayCursor(replayCursor - 10)}
        disabled={replayCursor <= 0}
      >
        <Icon icon={SkipBack} /> -10
      </Button>
      <Button
        variant="ghost"
        aria-label={t('back1')}
        onClick={() => setReplayCursor(replayCursor - 1)}
        disabled={replayCursor <= 0}
      >
        <Icon icon={StepBack} /> -1
      </Button>
      <Button
        variant="ghost"
        aria-label={replayPlaying ? t('pause') : t('play')}
        onClick={() => setReplayPlaying(!replayPlaying)}
        disabled={bufferLength === 0}
      >
        <Icon icon={replayPlaying ? Pause : Play} /> {replayPlaying ? t('pause') : t('play')}
      </Button>
      <Button
        variant="ghost"
        aria-label={t('forward1')}
        onClick={() => setReplayCursor(replayCursor + 1)}
        disabled={replayCursor >= max}
      >
        +1 <Icon icon={StepForward} />
      </Button>
      <Button
        variant="ghost"
        aria-label={t('forward10')}
        onClick={() => setReplayCursor(replayCursor + 10)}
        disabled={replayCursor >= max}
      >
        +10 <Icon icon={SkipForward} />
      </Button>
      <input
        className="replay-bar__slider"
        type="range"
        min={0}
        max={max}
        value={Math.min(replayCursor, max)}
        onChange={event => setReplayCursor(Number(event.target.value))}
      />
      <span className="replay-bar__position">
        {Math.min(replayCursor, max) + 1}/{bufferLength}
      </span>
      <select
        value={replaySpeed}
        onChange={event => setReplaySpeed(Number(event.target.value) as ReplaySpeed)}
      >
        {/* A seeded recommended rate that is not 1×/4× stays selectable. */}
        {replaySpeed !== 1 && replaySpeed !== 4 && (
          <option value={replaySpeed}>{t('speedRecommended', { n: replaySpeed })}</option>
        )}
        <option value={1}>1×</option>
        <option value={4}>4×</option>
      </select>
      <Button variant="link" onClick={exitReplay}>
        {t('exit')}
      </Button>
    </div>
  );
}
