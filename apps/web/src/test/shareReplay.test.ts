/**
 * Share replay helpers (R15-B1): folding a share's baked zone-sample events
 * into EnvTimeseries, and the summary chip counts. Pure functions — no
 * rendering, no i18n.
 */

import { describe, expect, it } from 'vitest';

import type { ScenarioDefinition, ScenarioEvent } from '../api/types';
import {
  buildShareLogRows,
  isExecutionReceipt,
  replayEventCounts,
  replayEventsToTimeseries,
  replayRowErrorMessage,
  shareNameMaps,
} from '../lib/shareReplay';

function sample(id: string, zoneId: string, t: number, parameters: Record<string, unknown>): ScenarioEvent {
  return { id, type: 'zone-sample', zoneId, atSimTimeSec: t, details: { parameters } };
}

describe('replayEventsToTimeseries', () => {
  it('folds zone-sample events per zone in sim-time order', () => {
    const events = [
      sample('s2', 'z-a', 60, { temperature: 25 }),
      sample('s1', 'z-a', 0, { temperature: 20, humidity: 55 }),
      sample('s3', 'z-b', 30, { co2: 600 }),
    ];
    const series = replayEventsToTimeseries(events);
    expect(series.zoneIds).toEqual(['z-a', 'z-b']); // z-a seen first at t=0 after sort
    expect(series.samples['z-a']).toEqual([
      { t: 0, values: { temperature: 20, humidity: 55 } },
      { t: 60, values: { temperature: 25 } },
    ]);
    expect(series.samples['z-b']).toEqual([{ t: 30, values: { co2: 600 } }]);
  });

  it('ignores non-sample events, junk values and zone-less records', () => {
    const events: ScenarioEvent[] = [
      { id: 'd1', type: 'sim-decision', zoneId: 'z-a', atSimTimeSec: 5, details: {} },
      { id: 'd2', type: 'device-state', zoneId: 'z-a', atSimTimeSec: 6, details: {} },
      sample('s1', 'z-a', 10, { temperature: 'NaN-ish', smoke: 3 }), // smoke untracked; temp not numeric
      { id: 's2', type: 'zone-sample', zoneId: '', atSimTimeSec: 10, details: { parameters: { temperature: 1 } } },
      sample('s3', 'z-a', 20, { occupancy: 4 }),
    ];
    const series = replayEventsToTimeseries(events);
    expect(series.zoneIds).toEqual(['z-a']);
    expect(series.samples['z-a']).toEqual([{ t: 20, values: { occupancy: 4 } }]);
  });

  it('maps occupancy from details and zone names when provided', () => {
    const events = [
      { id: 's1', type: 'zone-sample', zoneId: 'z-a', atSimTimeSec: 1, details: { occupancy: 7 } },
    ] as ScenarioEvent[];
    const series = replayEventsToTimeseries(events, { 'z-a': '大厅' });
    expect(series.zoneNames['z-a']).toBe('大厅');
    expect(series.samples['z-a']).toEqual([{ t: 1, values: { occupancy: 7 } }]);
  });
});

describe('replayEventCounts', () => {
  it('counts only the three baked timeline kinds', () => {
    const events: ScenarioEvent[] = [
      { id: '1', type: 'sim-decision', zoneId: 'z' },
      { id: '2', type: 'sim-decision', zoneId: 'z' },
      { id: '3', type: 'zone-sample', zoneId: 'z' },
      { id: '4', type: 'device-state', zoneId: 'z' },
      { id: '5', type: 'temperature', zoneId: 'z' }, // injected physics event — not a chip
    ];
    expect(replayEventCounts(events)).toEqual({
      'sim-decision': 2,
      'zone-sample': 1,
      'device-state': 1,
    });
  });
});

// ---------------------------------------------------------------------------
// UX-07: name maps, execution folding, llm-error drill-down
// ---------------------------------------------------------------------------

function scenarioFixture(): Pick<ScenarioDefinition, 'agents' | 'events' | 'zones' | 'flows'> {
  return {
    zones: [
      { id: 'z-301', name: 'Room 301', adjacentZoneIds: [] },
      { id: 'z-302', adjacentZoneIds: [] },
    ],
    agents: [
      { id: 'agent-1', name: 'Building Steward', capabilities: [], managesZoneIds: [], boundDeviceIds: [] },
    ],
    // The replay JSON's embedded flows keep their runtime ids (the loader
    // passes flow objects through shape-wise).
    flows: [
      { id: 'flow-uuid-1', name: '课后关机', trigger: {}, plan: {} },
    ] as unknown as ScenarioDefinition['flows'],
    events: [
      { id: 'evt-1', type: 'temperature-spike', zoneId: 'z-301', atSimTimeSec: 5 },
      { id: 'evt-2', type: 'smoke', zoneId: 'z-302' },
      // Baked timeline rows never join a trajectory eventId — excluded.
      { id: 'replay:dec:1', type: 'sim-decision', zoneId: 'z-301', details: {} },
    ],
  };
}

describe('shareNameMaps (UX-07)', () => {
  it('resolves agent / flow / event names from the replay scenario', () => {
    const maps = shareNameMaps(scenarioFixture());
    expect(maps.agents).toEqual({ 'agent-1': 'Building Steward' });
    expect(maps.flows).toEqual({ 'flow-uuid-1': '课后关机' });
    expect(maps.events).toEqual({
      'evt-1': 'temperature-spike · Room 301',
      // Zone without a name falls back to the zone id.
      'evt-2': 'smoke · z-302',
    });
  });

  it('tolerates a scenario without flows or zone names', () => {
    const maps = shareNameMaps({
      zones: [],
      agents: [],
      events: [{ id: 'evt-9', type: 'co2-spike', zoneId: 'z-x' }],
    });
    expect(maps.flows).toEqual({});
    expect(maps.events).toEqual({ 'evt-9': 'co2-spike' });
  });

  // R2-FEAT-12: the zones map is exposed (previously computed then dropped) —
  // the share page's timeseries zone list and zone-sample lines need it.
  it('exposes the zone display-name map (R2-FEAT-12)', () => {
    const maps = shareNameMaps(scenarioFixture());
    expect(maps.zones).toEqual({ 'z-301': 'Room 301', 'z-302': 'z-302' });
  });
});

function executionReceipt(id: string, t: number): ScenarioEvent {
  return {
    id,
    type: 'sim-decision',
    zoneId: 'z-301',
    atSimTimeSec: t,
    details: {
      kind: 'device-execution',
      agentId: 'agent-1',
      decision: 'executed',
      decisionSource: 'engine',
      deviceExecution: { deviceId: 'ac-9', command: 'turn-off', success: true },
    },
  };
}

describe('buildShareLogRows (UX-07)', () => {
  it('folds consecutive engine execution receipts into one group, order preserved', () => {
    const rows = buildShareLogRows([
      executionReceipt('e3', 30),
      executionReceipt('e2', 20),
      { id: 'd1', type: 'sim-decision', zoneId: 'z-301', atSimTimeSec: 15, details: { decision: 'initiate_ac' } },
      executionReceipt('e1', 10),
      { id: 's1', type: 'zone-sample', zoneId: 'z-301', atSimTimeSec: 5, details: {} },
    ]);
    expect(rows.map(row => row.kind)).toEqual(['executions', 'single', 'executions', 'single']);
    expect(rows[0]).toMatchObject({ kind: 'executions' });
    expect((rows[0] as { events: ScenarioEvent[] }).events.map(e => e.id)).toEqual(['e3', 'e2']);
    expect((rows[2] as { events: ScenarioEvent[] }).events.map(e => e.id)).toEqual(['e1']);
  });

  it('recognizes execution receipts defensively', () => {
    expect(isExecutionReceipt(executionReceipt('e1', 1))).toBe(true);
    expect(
      isExecutionReceipt({ id: 'x', type: 'sim-decision', zoneId: 'z', details: { kind: 'assessment' } }),
    ).toBe(false);
    expect(isExecutionReceipt({ id: 'x', type: 'device-state', zoneId: 'z' })).toBe(false);
    expect(isExecutionReceipt({ id: 'x', type: 'sim-decision', zoneId: 'z' })).toBe(false); // no details
  });
});

describe('replayRowErrorMessage (UX-07)', () => {
  it('surfaces the baked llm-failure errorMessage for the drill-down', () => {
    const event: ScenarioEvent = {
      id: 'replay:dec:9',
      type: 'sim-decision',
      zoneId: 'z-301',
      details: {
        kind: 'llm-failure',
        agentId: 'agent-1',
        decision: 'error',
        decisionSource: 'llm-error',
        errorMessage: 'connect ECONNREFUSED 127.0.0.1:11434',
      },
    };
    expect(replayRowErrorMessage(event)).toBe('connect ECONNREFUSED 127.0.0.1:11434');
  });

  it('is undefined for rows without an errorMessage', () => {
    expect(replayRowErrorMessage(executionReceipt('e1', 1))).toBeUndefined();
    expect(replayRowErrorMessage({ id: 'x', type: 'sim-decision', zoneId: 'z' })).toBeUndefined();
  });
});
