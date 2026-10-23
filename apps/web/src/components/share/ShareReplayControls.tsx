/**
 * ShareReplayControls (UX-W5 子任务 C) — the share page's playback bar.
 *
 * Purely client-side: a 100 ms interval drives the tickShareReplay reducer
 * (lib/shareReplayClock) while playing; the parent (ShareViewPage) owns the
 * state and derives the current event / zone flash from the position. The
 * native range slider doubles as the progress bar and a seek control. 1×
 * compresses the whole baked window into ~60 wall seconds (4×/16× faster).
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, RotateCcw } from 'lucide-react';

import {
  isShareReplayFinished,
  tickShareReplay,
  type ShareReplaySpeed,
  type ShareReplayState,
  type ShareReplayTimeline,
} from '../../lib/shareReplayClock';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';

const TICK_MS = 100;

export interface ShareReplayControlsProps {
  timeline: ShareReplayTimeline;
  /** null = replay not started (the page shows its static, fully-lit view). */
  state: ShareReplayState | null;
  onChange: (next: ShareReplayState | null) => void;
}

export function ShareReplayControls({ timeline, state, onChange }: ShareReplayControlsProps) {
  const { t } = useTranslation('share');

  // The interval reads the freshest state through a ref so a mid-flight
  // speed change applies on the next tick instead of after a restart.
  const stateRef = useRef(state);
  stateRef.current = state;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const playing = state?.playing ?? false;
  useEffect(() => {
    if (!playing) return;
    const handle = window.setInterval(() => {
      const current = stateRef.current;
      if (current === null) return;
      const next = tickShareReplay(current, timeline, TICK_MS);
      // Advance the ref synchronously too: several ticks can fire inside one
      // batched update (fake timers, background tab catch-up), and each must
      // build on the previous position rather than the last rendered state.
      stateRef.current = next;
      onChangeRef.current(next);
    }, TICK_MS);
    return () => window.clearInterval(handle);
  }, [playing, timeline]);

  if (timeline.items.length < 2) return null;

  const finished = state !== null && isShareReplayFinished(timeline, state.positionSec);
  const positionSec = state?.positionSec ?? timeline.startSec;

  const togglePlay = () => {
    if (state === null || finished) {
      // First play (or replay after the end): start from the window start.
      onChange({ positionSec: timeline.startSec, playing: true, speed: state?.speed ?? 1 });
    } else {
      onChange({ ...state, playing: !state.playing });
    }
  };

  return (
    <div className="share-replay-bar" data-testid="share-replay-bar">
      <Button
        variant="secondary"
        size="sm"
        onClick={togglePlay}
        aria-label={playing ? t('replay.pause') : finished ? t('replay.again') : t('replay.play')}
      >
        <Icon icon={playing ? Pause : finished ? RotateCcw : Play} />
        {playing ? t('replay.pause') : finished ? t('replay.again') : t('replay.play')}
      </Button>
      <input
        className="share-replay-bar__slider"
        type="range"
        min={timeline.startSec}
        max={timeline.endSec}
        step="any"
        value={positionSec}
        aria-label={t('replay.progressAria')}
        onChange={event => {
          const next = Number(event.target.value);
          onChange({
            positionSec: next,
            playing: state?.playing ?? false,
            speed: state?.speed ?? 1,
          });
        }}
      />
      <span className="share-replay-bar__time">
        {t('replay.time', {
          current: Math.round(positionSec),
          total: Math.round(timeline.endSec),
        })}
      </span>
      <select
        className="share-replay-bar__speed"
        value={state?.speed ?? 1}
        aria-label={t('replay.speed')}
        onChange={event =>
          onChange({
            positionSec,
            playing,
            speed: Number(event.target.value) as ShareReplaySpeed,
          })
        }
      >
        <option value={1}>1×</option>
        <option value={4}>4×</option>
        <option value={16}>16×</option>
      </select>
    </div>
  );
}
