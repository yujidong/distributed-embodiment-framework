/**
 * useVisibleInterval — visibility-gated polling (R31 F12).
 *
 * The hand-rolled setInterval pollers (sim snapshot 1.5s, collaborations 3s,
 * estop 5s, observability 10s, deployment audit 5s) kept firing in
 * background tabs — browsers clamp timers to ~1Hz there, so a 1.5s poll
 * degrades into per-second churn: wasted battery/CPU and server load for an
 * invisible UI. This hook keeps the cadence while the document is visible,
 * skips ticks while `document.hidden`, and fires ONE catch-up tick on
 * visibilitychange→visible so returning to the tab refreshes immediately.
 *
 * (TanStack Query polls need none of this — v5 already gates
 * `refetchInterval` on focus unless `refetchIntervalInBackground` is set.)
 *
 * The callback runs through a ref, so callers may pass fresh closures
 * without re-subscribing the interval; the callback itself owns overlap
 * guards (inFlight flags) and staleness checks (sim id comparison).
 */

import { useEffect, useRef } from 'react';

export function useVisibleInterval(
  callback: () => void,
  intervalMs: number,
  enabled: boolean = true,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (typeof document === 'undefined' || !document.hidden) {
        void callbackRef.current();
      }
    };
    const onVisibilityChange = () => {
      if (!document.hidden) tick();
    };
    tick();
    const handle = window.setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(handle);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs, enabled]);
}
