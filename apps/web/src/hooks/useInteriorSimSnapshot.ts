/**
 * useInteriorSimSnapshot — R82: polls the active world-session snapshot and
 * exposes live per-zone parameters for the interior walk.
 *
 * UX-W4 live layer: beyond the floor temperature (room tinting), the
 * overlay now carries co2 / occupancy (E card + label readouts), the
 * alert map (campus zoneAlertLevel semantics — red pulse in-scene, toast
 * on transition), and deduped recent events (snapshot.recentDecisions →
 * HUD toasts). Mapping is pure (lib/interior3d/liveOverlay).
 *
 * Source selection lives in lib/simSnapshotSource (world session first — a
 * leftover demo sim must not hijack the overlay). A stopped sim's snapshot
 * endpoint still answers 200 with frozen data, so after
 * SNAPSHOT_STOPPED_FALLBACK_STRIKES consecutive stopped reads the sim list
 * is re-fetched and the picker falls back. Polls every 4s; silent on
 * errors (the overlay is additive — the walk works without it).
 */

import { useEffect, useRef, useState } from 'react';

import * as api from '../api/client';
import type { SimulationListEntry } from '../api/types';
import {
  liveMapsFromZones,
  recentEventsFromDecisions,
  type InteriorRecentEvent,
} from '../lib/interior3d/liveOverlay';
import { SNAPSHOT_STOPPED_FALLBACK_STRIKES, pickSnapshotSim } from '../lib/simSnapshotSource';
import { useAppStore } from '../store/useAppStore';

export interface SimOverlay {
  /** zone id → live temperature (°C). */
  tempByZone: Record<string, number>;
  /** zone id → live CO₂ (ppm). */
  co2ByZone: Record<string, number>;
  /** zone id → live occupancy (headcount). */
  occupancyByZone: Record<string, number>;
  /** zone id → 'critical' (campus alert semantics: temp ≥ 35 °C / smoke). */
  alertByZone: Record<string, 'critical'>;
  /** Deduped recent events (from snapshot.recentDecisions) for HUD toasts. */
  recentEvents: InteriorRecentEvent[];
  simTime: string | null;
  /** 仿真 Agent 花名册（在场化身用）：引擎没有个体坐标，只有静态职责分区。 */
  agents: Array<{ id: string; name: string; managedZoneIds: string[] }>;
}

const EMPTY_OVERLAY: SimOverlay = {
  tempByZone: {},
  co2ByZone: {},
  occupancyByZone: {},
  alertByZone: {},
  recentEvents: [],
  simTime: null,
  agents: [],
};

export function useInteriorSimSnapshot(envId: string | undefined): SimOverlay {
  const [overlay, setOverlay] = useState<SimOverlay>(EMPTY_OVERLAY);
  const [sims, setSims] = useState<SimulationListEntry[] | null>(null);
  const stoppedStrikesRef = useRef(0);
  // A live demo run's sim is the overlay source (hero events land there);
  // the picker falls back to the world session when the demo ends.
  const demoSimId = useAppStore(s => (s.demoRun && !s.demoRun.done ? s.demoRun.simId : null));

  useEffect(() => {
    if (!envId) return;
    let alive = true;
    api
      .listSimulations()
      .then(s => alive && setSims(s))
      .catch(() => alive && setSims(null));
    return () => {
      alive = false;
    };
    // demoSimId dep: same mid-view demo-sim creation gap as the campus hook.
  }, [envId, demoSimId]);

  useEffect(() => {
    if (!envId || !sims) return;
    const simId = pickSnapshotSim(sims, envId, demoSimId)?.id;
    if (!simId) {
      setOverlay(EMPTY_OVERLAY);
      return;
    }
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const snap = (await api.getSimulationSnapshot(simId)) as {
          state?: string;
          zones?: Array<{ id: string; parameters?: Record<string, number | boolean> }>;
          agents?: Array<{ id: string; name: string; managedZoneIds?: string[] }>;
          recentDecisions?: Array<{ eventId: string; eventType: string; zoneId?: string }>;
          simTime?: string;
        };
        if (!alive) return;
        if (snap.state === 'stopped') {
          // Dead sim, live endpoint — re-list after a couple of strikes so
          // the picker falls back to the world session (same discipline as
          // the campus overlay).
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
        const maps = liveMapsFromZones(snap.zones ?? []);
        const agents = (snap.agents ?? []).map(a => ({
          id: a.id,
          name: a.name,
          managedZoneIds: a.managedZoneIds ?? [],
        }));
        setOverlay({
          ...maps,
          recentEvents: recentEventsFromDecisions(snap.recentDecisions ?? []),
          simTime: snap.simTime ?? null,
          agents,
        });
      } catch {
        if (alive) setOverlay(EMPTY_OVERLAY);
      }
    };
    void poll();
    timer = window.setInterval(poll, 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [envId, sims, demoSimId]);

  return overlay;
}
