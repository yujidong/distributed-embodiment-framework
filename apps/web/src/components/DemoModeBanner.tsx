/**
 * DemoModeBanner (plan-r81 B2 / demo-on-world-page) — narration strip for an
 * active demo run, overlaid on WHATEVER surface is up (world page with the
 * 3D campus included, or the sim console when the user opens it mid-demo):
 *
 * - the demo tagline (or a generic title) plus the scripted-arc stepper
 *   (回家 → 高温 → … → 回落收尾), marking fired steps done and the current
 *   one active;
 * - a live speed note: once two samples give a measurement it shows the
 *   OBSERVED effective rate + ETA (autoThrottle can drag the requested rate
 *   far below the configured one — the banner must not lie), falling back to
 *   the configured rate until then;
 * - the demo sim is STOPPED when the arc completes (sim time ≥ last
 *   scripted event + dwell), on manual「退出演示」, and when the user leaves
 *   the demo's environment pages without attaching its console (F2 — the
 *   banner is a demo sim's only stop path);
 * - the banner stays after completion (flipped to the done state) until
 *   dismissed, so the ending is announced.
 *
 * Mounted by App above the route tree (page-scoped, NOT console-scoped).
 * simTime source: the console's store snapshot when the console is attached
 * to the demo sim; otherwise the banner polls the demo sim itself (2 s).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MonitorPlay, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';

import * as api from '../api/client';
import {
  activeDemoPhaseIndex,
  demoEtaSeconds,
  demoPhases,
  smoothDemoRate,
  type DemoRateSample,
} from '../lib/demoRun';
import { localizedText } from '../lib/locale';
import { useAppStore } from '../store/useAppStore';

/** Self-poll cadence when the console is not attached to the demo sim. */
const DEMO_TIME_POLL_MS = 2000;
/**
 * Hero-window slowdown: with the cinematography override the demo runs at the
 * scenario's hero rate for this long (wall), then restores the configured
 * rate — smoke injected at 0.55 stays above the 0.08 alert threshold ~34
 * wall-s at 5×, so 90 s covers the visible window with margin.
 */
const HERO_OVERRIDE_WINDOW_MS = 90_000;

export function DemoModeBanner() {
  const demoRun = useAppStore(s => s.demoRun);
  const simulationId = useAppStore(s => s.simulationId);
  const snapshot = useAppStore(s => s.snapshot);
  const world = useAppStore(s => s.world);
  const markDemoRunDone = useAppStore(s => s.markDemoRunDone);
  const clearDemoRun = useAppStore(s => s.clearDemoRun);
  const { t } = useTranslation('world');
  const location = useLocation();
  // Guards against duplicate stop calls while the first is in flight.
  const stopIssuedRef = useRef(false);
  // Effective-rate measurement: last sample + EMA-smoothed rate.
  const measureRef = useRef<{ sample: DemoRateSample; rate: number | null } | null>(null);

  const attachedToDemo = demoRun !== null && simulationId === demoRun.simId;
  const matches = demoRun !== null && world !== null && world.id === demoRun.envId;
  // The demo is page-scoped: alive on its environment's pages (world / walk /
  // flows) or when its console is attached; anything else ends it.
  const onDemoPage =
    demoRun !== null &&
    (location.pathname.startsWith(`/environments/${demoRun.envId}`) || attachedToDemo);

  // simTime source: the console's store snapshot when attached (1 s cadence),
  // else a self-poll of the demo sim (the banner renders over the world page
  // now, where the console's snapshot stream does not exist).
  const [polledSimTimeSec, setPolledSimTimeSec] = useState<number | null>(null);
  const demoSimId = demoRun?.simId ?? null;
  useEffect(() => {
    if (demoSimId === null || attachedToDemo) return;
    let alive = true;
    const poll = async () => {
      try {
        const snap = (await api.getSimulationSnapshot(demoSimId)) as { simTimeSec?: number };
        if (alive && typeof snap.simTimeSec === 'number') setPolledSimTimeSec(snap.simTimeSec);
      } catch {
        // Keep the last reading — the stop paths retry on the next tick.
      }
    };
    void poll();
    const timer = window.setInterval(poll, DEMO_TIME_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [demoSimId, attachedToDemo]);
  const consoleSimTimeSec = attachedToDemo ? (snapshot?.simTimeSec ?? null) : null;
  const simTimeSec = consoleSimTimeSec ?? polledSimTimeSec;

  // Hero-window slowdown (cinematography.playbackRateOverride): the demo
  // starts AT the hero rate (WorldViewPage.startDemo); the banner restores the
  // configured rate once the window elapses. Speed changes ride the
  // pause/resume channel (server contract: speed settable at start/resume).
  const heroSlowdownRef = useRef(false);
  useEffect(() => {
    if (!matches || !demoRun || demoRun.done || heroSlowdownRef.current) return;
    const override = demoRun.heroPlaybackRateOverride;
    if (override === undefined || override === demoRun.rate) return;
    heroSlowdownRef.current = true;
    let alive = true;
    const restoreTimer = window.setTimeout(() => {
      if (!alive) return;
      const run = useAppStore.getState().demoRun;
      if (run && !run.done) {
        void api
          .pauseSimulation(run.simId)
          .then(() => api.resumeSimulation(run.simId, run.rate))
          .catch(() => undefined);
      }
    }, HERO_OVERRIDE_WINDOW_MS);
    return () => {
      alive = false;
      window.clearTimeout(restoreTimer);
    };
  }, [matches, demoRun]);

  // Arc complete → stop the demo sim once, then flip to the done state (the
  // banner stays until dismissed so the ending is announced).
  useEffect(() => {
    if (!matches || !demoRun || demoRun.done || stopIssuedRef.current) return;
    if (simTimeSec === null || simTimeSec < demoRun.endsAtSimTimeSec) return;
    stopIssuedRef.current = true;
    void api
      .stopSimulation(demoRun.simId)
      .catch(() => undefined) // best-effort: the sim may already be stopped
      .finally(() => markDemoRunDone());
  }, [matches, demoRun, simTimeSec, markDemoRunDone]);

  // Nav-away cleanup: leaving the demo's pages without its console attached
  // ends the run — otherwise the sped-up sim would leak (F2).
  useEffect(() => {
    if (!demoRun || onDemoPage) return;
    if (!demoRun.done && !stopIssuedRef.current) {
      stopIssuedRef.current = true;
      void api.stopSimulation(demoRun.simId).catch(() => undefined);
    }
    clearDemoRun();
  }, [demoRun, onDemoPage, clearDemoRun]);

  // Hoisted above the early return so the Esc handler and the exit button
  // share one stop path (hooks may not live below a conditional return).
  const exit = useCallback(() => {
    if (demoRun === null) return;
    if (!demoRun.done && !stopIssuedRef.current) {
      stopIssuedRef.current = true;
      void api.stopSimulation(demoRun.simId).catch(() => undefined);
    }
    clearDemoRun();
  }, [demoRun, clearDemoRun]);

  // R2-UX-07: Esc exits a PLAYING demo — the console's present mode, the
  // walk view and ConfirmDialog all take Esc already; the banner was the odd
  // one out. An open dialog keeps Esc priority (no stealing its cancel).
  useEffect(() => {
    if (!matches || demoRun === null || demoRun.done) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (
        document.querySelector('[role="alertdialog"], [role="dialog"], .confirm-backdrop') !==
        null
      ) {
        return;
      }
      exit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [matches, demoRun, exit]);

  if (!matches || demoRun === null || world === null) return null;

  const phases = demoPhases(world.events);
  const currentIndex = activeDemoPhaseIndex(phases, simTimeSec ?? 0, demoRun.heroEventId);
  const tagline = localizedText(world.demo?.tagline);

  // Measured playback (F6): EMA over consecutive samples.
  if (simTimeSec !== null) {
    const sample: DemoRateSample = { simTimeSec, atMs: Date.now() };
    const prev = measureRef.current;
    measureRef.current = {
      sample,
      rate: prev === null ? null : smoothDemoRate(prev.rate, prev.sample, sample),
    };
  }
  const measuredRate = demoRun.done ? null : (measureRef.current?.rate ?? null);
  const etaSec =
    simTimeSec === null ? null : demoEtaSeconds(demoRun.endsAtSimTimeSec, simTimeSec, measuredRate);
  const progress =
    simTimeSec === null
      ? 0
      : Math.min(100, Math.round((simTimeSec / demoRun.endsAtSimTimeSec) * 100));
  const speedText = demoRun.done
    ? t('demoMode.done')
    : measuredRate !== null
      ? `${t('demoMode.playingLive', { rate: Math.round(measuredRate), progress })}${
          etaSec !== null
            ? ` · ${
                etaSec < 90
                  ? t('demoMode.etaSeconds', { seconds: etaSec })
                  : t('demoMode.etaMinutes', { minutes: Math.ceil(etaSec / 60) })
              }`
            : ''
        }`
      : t('demoMode.playing', { rate: demoRun.rate });

  return (
    <div className="demo-run-banner" data-testid="demo-run-banner" role="status">
      <span className="demo-run-banner__icon" aria-hidden>
        <MonitorPlay size={14} />
      </span>
      <div className="demo-run-banner__body">
        <span className="demo-run-banner__title">{tagline ?? t('demoMode.bannerTitle')}</span>
        {phases.length > 0 && (
          <span className="demo-run-banner__steps">
            {phases.map((phase, index) => (
              <span
                key={phase.id}
                className={
                  index === currentIndex
                    ? 'demo-run-banner__step demo-run-banner__step--active'
                    : currentIndex === -1 || index < currentIndex
                      ? 'demo-run-banner__step demo-run-banner__step--done'
                      : 'demo-run-banner__step'
                }
              >
                {t(`demoMode.event.${phase.id}`, { defaultValue: phase.type })}
              </span>
            ))}
            <span
              className={
                currentIndex === -1
                  ? 'demo-run-banner__step demo-run-banner__step--active'
                  : 'demo-run-banner__step'
              }
            >
              {t('demoMode.recovery')}
            </span>
          </span>
        )}
        <span className="demo-run-banner__speed">{speedText}</span>
      </div>
      <button
        type="button"
        className="demo-run-banner__exit"
        title={t('demoMode.exitHint')}
        onClick={exit}
      >
        <X size={12} aria-hidden /> {t('demoMode.exit')}
      </button>
    </div>
  );
}
