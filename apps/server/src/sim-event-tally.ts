/**
 * Per-sim injected-event tally — the countSince window for ComputationSpec
 * evaluation (R14 Wave-A, design-data-services.md §3.1)
 *
 * Injected events are delivered to managing agents DIRECTLY by the engine
 * (routed mode) — they never ride the event bus, so the only external
 * surface that sees them as a history is EngineRuntime.onInjectedEvent
 * (added for this feature). This module keeps one bounded, in-memory ring
 * per simulation: the registry attaches it at sim creation, read/push
 * evaluation queries the window.
 *
 * Window math is SIM-CLOCK anchored (events record simTimeSec) so
 * `countSince windowSec` means the same thing at any speed — deterministic
 * under replay. The tally lives and dies with the process + sim: a stopped
 * sim's tally is dropped (its cached frame is the honest fallback, §7).
 *
 * Cap discipline (lessons.md T-011): the ring is capped AT BIRTH and trims
 * to HALF the cap — a trim landing just under the limit would re-trigger a
 * full-array rewrite on every subsequent append. 4096 entries per sim is
 * ~years of injections at realistic rates.
 */

import { type EngineRuntime, type InjectedEventRecord } from '@active-collaboration/core';

const MAX_ENTRIES_PER_SIM = 4096;
const TRIM_TO = MAX_ENTRIES_PER_SIM >> 1;

export interface WindowedEvent {
  eventType: string;
  zoneId: string;
  simTimeSec: number;
}

export class SimEventTallies {
  private readonly bySim = new Map<string, WindowedEvent[]>();
  private readonly unsubscribes = new Map<string, () => void>();

  /**
   * Registry creation hook (the agreementBridge pattern): record every
   * injection of one simulation. Idempotent per sim id.
   */
  attach(simId: string, runtime: EngineRuntime): void {
    if (this.bySim.has(simId)) return;
    const events: WindowedEvent[] = [];
    this.bySim.set(simId, events);
    this.unsubscribes.set(
      simId,
      runtime.onInjectedEvent(record => {
        events.push({
          eventType: record.type,
          zoneId: record.zoneId,
          simTimeSec: record.simTimeSec,
        });
        if (events.length > MAX_ENTRIES_PER_SIM) events.splice(0, events.length - TRIM_TO);
      }),
    );
  }

  /** Events of one sim inside [simTimeSec - windowSec, now] (sim clock). */
  windowOf(simId: string, simTimeSec: number, windowSec: number): WindowedEvent[] {
    const cutoff = simTimeSec - windowSec;
    return (this.bySim.get(simId) ?? []).filter(event => event.simTimeSec >= cutoff);
  }

  /** Every recorded event of one sim (the evaluator slices per-metric windows). */
  eventsOf(simId: string): WindowedEvent[] {
    return this.bySim.get(simId) ?? [];
  }

  /** Registry stop/removal hook: drop the ring + unsubscribe. */
  detach(simId: string): void {
    this.bySim.delete(simId);
    const unsubscribe = this.unsubscribes.get(simId);
    if (unsubscribe !== undefined) {
      this.unsubscribes.delete(simId);
      try {
        unsubscribe();
      } catch {
        // runtime already stopped — nothing to release
      }
    }
  }

  /**
   * Living-worlds P0: resume hook — attach to the REBUILT runtime of a
   * hibernated sim and seed the ring with the checkpointed events, so
   * countSince windows span the hibernate boundary exactly (a plain attach
   * would either skip the new runtime's listener — the ring survived — or
   * start empty and lose the pre-freeze history; both diverge data-service
   * frames from the continuous run).
   */
  reseed(simId: string, runtime: EngineRuntime, events: WindowedEvent[]): void {
    this.detach(simId);
    this.attach(simId, runtime);
    const ring = this.bySim.get(simId);
    if (ring === undefined || events.length === 0) return;
    for (const event of events) ring.push(event);
    if (ring.length > MAX_ENTRIES_PER_SIM) ring.splice(0, ring.length - TRIM_TO);
  }
}
