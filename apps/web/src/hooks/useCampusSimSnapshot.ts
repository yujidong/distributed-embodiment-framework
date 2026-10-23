/**
 * useCampusSimSnapshot — polls the active world-session snapshot for the
 * campus 3D overlay (zone heat tints, device status colors, advisory AC
 * edges). Same data-source discipline as the interior walk
 * (useInteriorSimSnapshot): the world session is always running, so the
 * overlay works WITHOUT an open sim console — the console's stream
 * (zone-delta/device-delta frames) only exists while the console page is
 * mounted, which never coincides with the world view's 3D slot.
 *
 * Source selection lives in lib/simSnapshotSource (world session first — a
 * leftover demo sim must not hijack the overlay). A stopped sim's snapshot
 * endpoint still answers 200 with frozen data, so after
 * SNAPSHOT_STOPPED_FALLBACK_STRIKES consecutive stopped reads the sim list
 * is re-fetched and the picker falls back. Polls every 4 s; silent on
 * errors (the overlay is additive — the campus renders fine without live
 * data).
 */

import { useEffect, useRef, useState } from 'react';

import * as api from '../api/client';
import type { EngineSnapshot, SimulationListEntry } from '../api/types';
import { SNAPSHOT_STOPPED_FALLBACK_STRIKES, pickSnapshotSim } from '../lib/simSnapshotSource';
import { useAppStore } from '../store/useAppStore';

export const CAMPUS_SNAPSHOT_POLL_MS = 4000;

export function useCampusSimSnapshot(envId: string | undefined): EngineSnapshot | null {
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [sims, setSims] = useState<SimulationListEntry[] | null>(null);
  const stoppedStrikesRef = useRef(0);
  // During a live demo run the overlay follows the DEMO sim (the hero event
  // lands there, not in the world session); afterwards the picker falls back
  // to the world session — the demo sim is stopped on exit (DemoModeBanner).
  const demoSimId = useAppStore(s => (s.demoRun && !s.demoRun.done ? s.demoRun.simId : null));

  useEffect(() => {
    if (!envId) return;
    let alive = true;
    api
      .listSimulations()
      .then(list => alive && setSims(list))
      .catch(() => alive && setSims(null));
    return () => {
      alive = false;
    };
    // demoSimId dep: a demo starting MID-VIEW creates its sim after the first
    // list — re-list so the preferred source is actually in the candidates.
  }, [envId, demoSimId]);

  useEffect(() => {
    if (!envId || !sims) return;
    const simId = pickSnapshotSim(sims, envId, demoSimId)?.id;
    if (!simId) {
      setSnapshot(null);
      return;
    }
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const snap = (await api.getSimulationSnapshot(simId)) as EngineSnapshot;
        if (!alive) return;
        if (snap.state === 'stopped') {
          // Dead sim, live endpoint — don't surface the frozen frame; re-list
          // after a couple of strikes so the picker falls back to the world
          // session (the strike count absorbs a transient stop/pause flap).
          stoppedStrikesRef.current += 1;
          if (stoppedStrikesRef.current >= SNAPSHOT_STOPPED_FALLBACK_STRIKES) {
            stoppedStrikesRef.current = 0;
            try {
              const list = await api.listSimulations();
              if (alive) setSims(list);
            } catch {
              // Re-list failed — keep polling; the next tick retries.
            }
          }
          return;
        }
        stoppedStrikesRef.current = 0;
        setSnapshot(snap);
      } catch {
        if (alive) setSnapshot(null);
      }
    };
    void poll();
    timer = window.setInterval(poll, CAMPUS_SNAPSHOT_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [envId, sims, demoSimId]);

  return snapshot;
}
