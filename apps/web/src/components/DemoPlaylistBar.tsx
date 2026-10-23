/**
 * DemoPlaylistBar (R15-B2) — one-click「应用高光」player strip for the sim
 * console. Idle: a single play button (with a reason tooltip when the script
 * cannot run). Playing: scene counter, the scene's zone/type line and a
 * stop control; the jump/pause/dwell sequencing lives in SimulationView.
 */

import { useTranslation } from 'react-i18next';
import { MonitorPlay, Square } from 'lucide-react';

import type { DemoPlayableState, DemoScene } from '../lib/demoPlaylist';

export interface DemoPlaylistBarProps {
  scenes: DemoScene[];
  /** null = idle; otherwise the scene currently on stage. */
  currentIndex: number | null;
  /**
   * R2-UX-08: WHY the script can(not) play — drives the disabled-state
   * tooltip (无剧本 / 剧本太短 / 时刻已过) instead of one wrong「已过」.
   */
  state: DemoPlayableState;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function DemoPlaylistBar({
  scenes, currentIndex, state, busy, onStart, onStop,
}: DemoPlaylistBarProps) {
  const { t } = useTranslation('sim');
  // 'none' (zero timed events) keeps the pre-R2-UX-08 no-chrome behavior —
  // the「没有剧本」guidance lives on the world page's demo entry; the
  // console only corrects the wrong-reason tooltip of the other two states.

  if (currentIndex === null) {
    if (state === 'none') return null;
    const playable = state === 'playable';
    // The disabled button stays visible in every unplayable state so the
    // reason is discoverable (R2-UX-08 — hidden entries teach nothing).
    const hint = playable
      ? t('demoPlay.startHint')
      : state === 'tooShort'
        ? t('demoPlay.tooShortHint', { count: scenes.length })
        : t('demoPlay.elapsedHint');
    return (
      <div className="demo-playlist demo-playlist--idle">
        <button
          className="control-button"
          disabled={!playable || busy}
          title={hint}
          onClick={onStart}
        >
          <span className="button-icon" aria-hidden><MonitorPlay size={14} /></span>
          {t('demoPlay.start')}
        </button>
      </div>
    );
  }

  const scene = scenes[currentIndex];
  return (
    <div className="demo-playlist demo-playlist--playing" data-testid="demo-playlist-playing">
      <span className="demo-playlist__counter">
        {t('demoPlay.scene', { k: currentIndex + 1, n: scenes.length })}
      </span>
      {scene && (
        <span className="demo-playlist__scene">
          {t('demoPlay.sceneLine', { type: scene.type, zone: scene.zoneId, at: scene.atSimTimeSec })}
        </span>
      )}
      <span className="demo-playlist__dots" aria-hidden>
        {scenes.map((s, i) => (
          <span
            key={s.id}
            className={i === currentIndex ? 'demo-playlist__dot demo-playlist__dot--active'
              : i < currentIndex ? 'demo-playlist__dot demo-playlist__dot--done'
                : 'demo-playlist__dot'}
          />
        ))}
      </span>
      <button className="control-button" onClick={onStop}>
        <span className="button-icon" aria-hidden><Square size={12} /></span>
        {t('demoPlay.stop')}
      </button>
    </div>
  );
}
