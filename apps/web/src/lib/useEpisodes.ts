/**
 * Shared simulation-episode derivation (R14 P1-3).
 *
 * The drawer-header counter in SimulationView and the EpisodesPanel timeline
 * must count the SAME thing, or the console contradicts itself. Injected
 * scenario events are delivered straight to the managing agents and never
 * echo on the WS bus (EngineRuntime.injectEvent — "routed mode"), so the raw
 * event log can stay EMPTY while decisions (snapshot.recentDecisions) keep
 * flowing — the suzhou-city review showed「最近 0 条事件」next to「距上次
 * 活动 8s」. Episodes seed from decisions, so an episode count stays truthful
 * in exactly that case; this hook runs the aggregation once for both
 * consumers (header count + timeline rows).
 */

import { useMemo } from 'react';

import { useAppStore } from '../store/useAppStore';
import { aggregateEpisodes, type Episode, type EpisodeNames } from './episodes';
import type { WorldModel } from './worldModel';

export interface SimulationEpisodes {
  episodes: Episode[];
  names: EpisodeNames;
}

export function useSimulationEpisodes(model: WorldModel | null): SimulationEpisodes {
  const eventLog = useAppStore(s => s.eventLog);
  const triggerHints = useAppStore(s => s.triggerHints);
  const replayBuffer = useAppStore(s => s.replayBuffer);
  const snapshot = useAppStore(s => s.snapshot);

  const names = useMemo<EpisodeNames>(() => ({
    agentName: id =>
      model?.agents.find(a => a.id === id)?.name ??
      snapshot?.agents.find(a => a.id === id)?.name,
    deviceName: id =>
      model?.devices.find(d => d.id === id)?.name ??
      snapshot?.devices.find(d => d.id === id)?.name,
    zoneName: id =>
      model?.zones.find(z => z.id === id)?.name ??
      snapshot?.zones.find(z => z.id === id)?.name,
  }), [model, snapshot]);

  // Pause-safe: episodes derive from the FULL buffers, never the rendered
  // (replay-cursor) snapshot — the cursor only highlights.
  const episodes = useMemo(
    () =>
      aggregateEpisodes({
        // The store log is newest-first; aggregation expects chronological.
        events: [...eventLog.map(e => e.event)].reverse(),
        snapshots: replayBuffer,
        decisions: snapshot?.recentDecisions ?? [],
        triggerHints,
        names,
      }),
    [eventLog, replayBuffer, snapshot, triggerHints, names],
  );

  return { episodes, names };
}
