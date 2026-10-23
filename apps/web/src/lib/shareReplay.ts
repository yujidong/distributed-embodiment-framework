/**
 * Share replay helpers (R15-B1) — pure functions turning a share's scenario
 * events into the shapes the existing panels consume.
 *
 * A replay share freezes the environment's observation window as a scenario
 * JSON whose events include the Fix-14 sim timeline (`sim-decision`,
 * `zone-sample`, `device-state`). The share page has no live simulation, so
 * the physics curves are rebuilt from the baked `zone-sample` records into
 * the same EnvTimeseries EnvSeriesPanel renders live.
 */

import type { ScenarioDefinition, ScenarioEvent } from '../api/types';
import { asRecord, str } from './eventLog';
import type { ReplayNameMaps } from './replayEvents';
import { createEnvTimeseries, type EnvMetric, type EnvTimeseries } from './timeseries';

/** Replay zone-sample details (apps/server replay-service/sim-timeline). */
interface ZoneSampleDetails {
  parameters?: Record<string, unknown>;
  occupancy?: number;
}

const SAMPLE_METRICS: readonly EnvMetric[] = ['temperature', 'co2', 'humidity', 'occupancy'];

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Fold a share's `zone-sample` events into an EnvTimeseries. Samples are
 * ordered by atSimTimeSec (stable insertion keeps event order for ties);
 * unknown zones appear in first-seen order; non-numeric parameters are
 * skipped. Marks stay empty — event marks come from the scheduled-event
 * stream, which a frozen share replays as plain lines instead.
 */
export function replayEventsToTimeseries(
  events: readonly ScenarioEvent[],
  zoneNames: Record<string, string> = {},
): EnvTimeseries {
  const series = createEnvTimeseries();
  series.zoneNames = { ...zoneNames };
  const seen = new Set<string>();
  const samples: Record<string, EnvTimeseries['samples'][string]> = {};

  const ordered = [...events]
    .filter(event => event.type === 'zone-sample')
    .sort((a, b) => (a.atSimTimeSec ?? 0) - (b.atSimTimeSec ?? 0));

  for (const event of ordered) {
    const zoneId = event.zoneId;
    if (typeof zoneId !== 'string' || zoneId.length === 0) continue;
    const t = event.atSimTimeSec ?? 0;
    const details = (event.details ?? {}) as ZoneSampleDetails;
    const values: Partial<Record<EnvMetric, number>> = {};
    for (const metric of SAMPLE_METRICS) {
      const direct = num(details.parameters?.[metric]);
      if (direct !== undefined) values[metric] = direct;
    }
    const occupancy = num(details.occupancy);
    if (occupancy !== undefined) values.occupancy = occupancy;
    if (Object.keys(values).length === 0) continue;

    if (!seen.has(zoneId)) {
      seen.add(zoneId);
      series.zoneIds.push(zoneId);
      samples[zoneId] = [];
    }
    samples[zoneId]!.push({ t, values });
  }
  series.samples = samples;
  return series;
}

/** Counts per replay event kind, for the share page's summary chips. */
export function replayEventCounts(events: readonly ScenarioEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== 'sim-decision' && event.type !== 'zone-sample' && event.type !== 'device-state') {
      continue;
    }
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// UX-07: share-page decision-chain / event-log readability
// ---------------------------------------------------------------------------

/** The three baked sim-timeline kinds (never name-resolved as trigger events). */
const BAKED_TIMELINE_TYPES = new Set(['sim-decision', 'zone-sample', 'device-state']);

/**
 * UX-07: id → display-name maps for a replay scenario, so the share page
 * renders agent / flow / event NAMES instead of raw ids:
 * - agents: scenario agent id → display name;
 * - flows: flow id → flow name (the replay JSON's embedded flows keep their
 *   runtime ids — the loader passes flow objects through shape-wise);
 * - events: trigger-event id → "type · zone name" label, for the ORIGINAL
 *   scenario events only (baked timeline rows get synthetic replay:* ids
 *   that never join a trajectory eventId anyway);
 * - zones (R2-FEAT-12): zone id → display name, so zone-sample lines and
 *   the curves panel's zone list stop showing bare ids.
 */
export function shareNameMaps(
  scenario: Pick<ScenarioDefinition, 'agents' | 'events' | 'zones' | 'flows'>,
): ReplayNameMaps {
  const zoneNames: Record<string, string> = {};
  for (const zone of scenario.zones) {
    zoneNames[zone.id] = zone.name ?? zone.id;
  }
  const agents: Record<string, string> = {};
  for (const agent of scenario.agents) {
    agents[agent.id] = agent.name;
  }
  const flows: Record<string, string> = {};
  for (const flow of scenario.flows ?? []) {
    const id = (flow as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) flows[id] = flow.name;
  }
  const events: Record<string, string> = {};
  for (const event of scenario.events) {
    if (BAKED_TIMELINE_TYPES.has(event.type)) continue;
    const zone = typeof event.zoneId === 'string' ? zoneNames[event.zoneId] : undefined;
    events[event.id] = zone !== undefined ? `${event.type} · ${zone}` : event.type;
  }
  return { agents, flows, events, zones: zoneNames };
}

/** One row of the share page's event log after UX-07 noise folding. */
export type ShareLogRow =
  | { kind: 'single'; event: ScenarioEvent }
  /** Consecutive engine execution receipts, collapsed into one group. */
  | { kind: 'executions'; events: ScenarioEvent[] };

/** True for a baked device-execution receipt (the "executed (engine)" rows). */
export function isExecutionReceipt(event: ScenarioEvent): boolean {
  return event.type === 'sim-decision' && str(asRecord(event.details).kind) === 'device-execution';
}

/**
 * UX-07: fold the share event log (newest-first) into display rows — runs of
 * consecutive device-execution receipts collapse into one expandable group;
 * everything else stays a single row, order preserved.
 */
export function buildShareLogRows(events: readonly ScenarioEvent[]): ShareLogRow[] {
  const rows: ShareLogRow[] = [];
  for (const event of events) {
    const last = rows[rows.length - 1];
    if (isExecutionReceipt(event) && last?.kind === 'executions') {
      last.events.push(event);
    } else if (isExecutionReceipt(event)) {
      rows.push({ kind: 'executions', events: [event] });
    } else {
      rows.push({ kind: 'single', event });
    }
  }
  return rows;
}

/**
 * UX-07: the errorMessage a baked sim-decision row carries (llm-failure
 * records, fallback handshake answers) — the share page renders it as the
 * row's drill-down. Undefined when the row has none.
 */
export function replayRowErrorMessage(event: ScenarioEvent): string | undefined {
  return str(asRecord(event.details).errorMessage);
}
