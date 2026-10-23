/**
 * Episode aggregation (W8) — grouping (eventId / acId / agent+time window),
 * the outcome-heuristic matrix, ongoing→success re-aggregation, physical
 * delta annotation, trigger reconstruction, filters (incl. 只看我参与的) and
 * the replay-cursor derivation. Pure derivation only — no DOM.
 */

import { describe, expect, it, beforeAll } from 'vitest';

import type { RuntimeDecisionRecord, SystemEventDto } from '../api/types';
import i18n from '../i18n/config';
import {
  aggregateEpisodes,
  episodeAgents,
  episodeIdAtTime,
  filterEpisodes,
  formatTrigger,
  ownedAgentIds,
  type Episode,
  type EpisodeNames,
  type TriggerHint,
} from '../lib/episodes';
import { makeSnapshot } from './fixtures';

// lib/episodes reads the active i18next bundle at call time; pin to en-US so
// assertions can be exact English strings.
beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-07-21T09:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function decision(
  agentId: string,
  eventId: string,
  at: string,
  overrides: Partial<RuntimeDecisionRecord> = {},
): RuntimeDecisionRecord {
  return {
    agentId,
    eventId,
    eventType: 'environment.param_changed',
    decision: 'initiate_ac',
    decisionSource: 'llm',
    at,
    ...overrides,
  };
}

function frame(
  type: string,
  payload: unknown,
  at: string,
  metadata?: Record<string, unknown>,
): SystemEventDto {
  return {
    id: `f-${type}-${at}`,
    type,
    source: 'test',
    timestamp: at,
    payload,
    ...(metadata ? { metadata } : {}),
  };
}

const NAMES: EpisodeNames = {
  agentName: id =>
    ({
      'agent-sensor': '感知员',
      'agent-appliance': '家电管家',
      'agent-climate': '气候管家',
    })[id],
  deviceName: id => ({ 'dev-hood': '油烟机', 'dev-ac': '空调' })[id],
  zoneName: id => ({ 'zone-kitchen': '厨房' })[id],
};

const HINT_SMOKE: TriggerHint = {
  type: 'smoke-detected',
  zoneId: 'zone-kitchen',
  parameter: 'smoke',
  value: 0.9,
  at: iso(0),
};

/** The mission's example: sensor agent initiates an AC with two partners. */
function smokeEpisodeFrames(): SystemEventDto[] {
  return [
    frame('collaboration.started', {
      collaborationId: 'ac-1',
      initiator: 'agent-sensor',
      participants: ['agent-appliance', 'agent-climate'],
      purpose: '排烟降温',
    }, iso(1000)),
    frame('custom', {
      customType: 'AC_STATE_CHANGED',
      collaborationId: 'ac-1',
      from: 'forming',
      to: 'running',
    }, iso(2000)),
    frame('device.operation_executed', {
      agentId: 'agent-appliance',
      deviceId: 'dev-hood',
      commandName: 'turn-on',
      result: { success: true },
    }, iso(3000)),
    frame('device.operation_executed', {
      agentId: 'agent-climate',
      deviceId: 'dev-ac',
      commandName: 'turn-on',
      result: { success: true },
    }, iso(4000)),
    frame('custom', {
      customType: 'AC_STATE_CHANGED',
      collaborationId: 'ac-1',
      from: 'running',
      to: 'completed',
    }, iso(5000)),
  ];
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

describe('aggregateEpisodes · grouping', () => {
  it('groups decisions by eventId (one episode per event, deduped across snapshots)', () => {
    const d1 = decision('agent-sensor', 'evt-1', iso(0));
    const d2 = decision('agent-appliance', 'evt-1', iso(500));
    const other = decision('agent-sensor', 'evt-2', iso(60000));
    const snapshots = [
      makeSnapshot({ recentDecisions: [d1] }),
      makeSnapshot({ recentDecisions: [d1, d2] }), // d1 repeats in the ring
    ];
    const episodes = aggregateEpisodes({ snapshots, decisions: [other], names: NAMES });
    expect(episodes).toHaveLength(2);
    const evt1 = episodes.find(e => e.trigger.eventId === 'evt-1');
    expect(evt1?.decisions).toHaveLength(2); // d1 deduped
    expect(episodes.find(e => e.trigger.eventId === 'evt-2')?.decisions).toHaveLength(1);
    // Newest first.
    expect(episodes[0].trigger.eventId).toBe('evt-2');
  });

  it('reconstructs the trigger from a client-recorded injection hint', () => {
    const episodes = aggregateEpisodes({
      decisions: [decision('agent-sensor', 'evt-1', iso(0))],
      triggerHints: { 'evt-1': HINT_SMOKE },
      names: NAMES,
    });
    expect(episodes[0].trigger).toMatchObject({
      eventId: 'evt-1',
      type: 'smoke-detected',
      zoneId: 'zone-kitchen',
      parameter: 'smoke',
      value: 0.9,
    });
    expect(formatTrigger(episodes[0].trigger, NAMES)).toBe('厨房 Smoke = 0.9');
  });

  it('reconstructs the trigger from scheduledEvents (scenario events)', () => {
    const episodes = aggregateEpisodes({
      decisions: [decision('agent-sensor', 'evt-fire-1', iso(0))],
      snapshots: [
        makeSnapshot({
          scheduledEvents: [
            { id: 'evt-fire-1', type: 'smoke-detected', zoneId: 'zone-kitchen', atSimTimeSec: 30, fired: true },
          ],
        }),
      ],
      names: NAMES,
    });
    expect(episodes[0].trigger).toMatchObject({
      type: 'smoke-detected',
      zoneId: 'zone-kitchen',
      atSimTimeSec: 30,
    });
  });

  it('groups collaboration frames by acId and attaches the AC via participant overlap', () => {
    const episodes = aggregateEpisodes({
      decisions: [decision('agent-sensor', 'evt-1', iso(0))],
      events: smokeEpisodeFrames(),
      triggerHints: { 'evt-1': HINT_SMOKE },
      names: NAMES,
    });
    expect(episodes).toHaveLength(1);
    const episode = episodes[0];
    expect(episode.collaboration).toMatchObject({
      acId: 'ac-1',
      state: 'completed',
      initiator: 'agent-sensor',
    });
    expect(episode.collaboration?.participants).toEqual(
      expect.arrayContaining(['agent-sensor', 'agent-appliance', 'agent-climate']),
    );
    expect(episode.actions).toHaveLength(2);
    expect(episode.outcome.status).toBe('success');
    expect(episode.outcome.summary).toBe('感知员initiated → 家电管家+气候管家 → 油烟机✓ 空调✓');
    expect(episode.startAt).toBe(iso(0));
    expect(episode.lastAt).toBe(iso(5000));
  });

  it('anchors an AC with no matching decisions as its own episode (rule-only path)', () => {
    const episodes = aggregateEpisodes({
      events: smokeEpisodeFrames(),
      names: NAMES,
    });
    expect(episodes).toHaveLength(1);
    const episode = episodes[0];
    expect(episode.id).toBe('ac:ac-1');
    expect(episode.trigger.type).toBe('collaboration');
    expect(episode.decisions).toHaveLength(0);
    // Device ops attach to the AC episode via its participants.
    expect(episode.actions).toHaveLength(2);
    expect(episode.outcome.status).toBe('success');
  });

  it('links device ops via payload params.eventId when present', () => {
    const episodes = aggregateEpisodes({
      decisions: [decision('agent-sensor', 'evt-1', iso(0))],
      events: [
        frame('device.operation_executed', {
          deviceId: 'dev-hood',
          commandName: 'turn-on',
          params: { eventId: 'evt-1' },
          result: { success: true },
        }, iso(1000)),
      ],
      names: NAMES,
    });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].actions).toHaveLength(1);
  });

  it('keeps unrelated device ops as standalone action episodes', () => {
    const episodes = aggregateEpisodes({
      decisions: [decision('agent-sensor', 'evt-1', iso(0))],
      events: [
        frame('device.operation_executed', {
          agentId: 'agent-other',
          deviceId: 'dev-hood',
          commandName: 'turn-off',
          error: 'timeout',
          success: false,
        }, iso(1000)),
        frame('device.operation_executed', {
          agentId: 'agent-other',
          deviceId: 'dev-ac',
          commandName: 'turn-off',
          result: { success: true },
        }, iso(2000)),
      ],
      names: NAMES,
    });
    expect(episodes).toHaveLength(2);
    const standalone = episodes.find(e => e.trigger.type === 'device-operation');
    // Both ops by the same unknown agent within the merge window → one episode.
    expect(standalone?.actions).toHaveLength(2);
    expect(standalone?.outcome.status).toBe('partial');
  });

  it('attributes concurrent ops to the latest-starting episode of the same agent', () => {
    const episodes = aggregateEpisodes({
      decisions: [
        decision('agent-sensor', 'evt-1', iso(0)),
        decision('agent-sensor', 'evt-2', iso(10000)),
      ],
      events: [
        frame('device.operation_executed', {
          agentId: 'agent-sensor',
          deviceId: 'dev-hood',
          commandName: 'turn-on',
          result: { success: true },
        }, iso(11000)),
      ],
      names: NAMES,
    });
    expect(episodes.find(e => e.trigger.eventId === 'evt-1')?.actions).toHaveLength(0);
    expect(episodes.find(e => e.trigger.eventId === 'evt-2')?.actions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Outcome heuristic matrix
// ---------------------------------------------------------------------------

describe('aggregateEpisodes · outcome heuristic', () => {
  const base = {
    decisions: [decision('agent-sensor', 'evt-1', iso(0))],
    names: NAMES,
  };
  const op = (success: boolean, at = iso(1000)) =>
    frame('device.operation_executed', {
      agentId: 'agent-sensor',
      deviceId: 'dev-hood',
      commandName: 'turn-on',
      ...(success ? { result: { success: true } } : { error: 'boom', success: false }),
    }, at);

  it('all actions succeeded → success', () => {
    const episodes = aggregateEpisodes({ ...base, events: [op(true), op(true, iso(2000))] });
    expect(episodes[0].outcome.status).toBe('success');
  });

  it('some actions failed → partial', () => {
    const episodes = aggregateEpisodes({ ...base, events: [op(true), op(false, iso(2000))] });
    expect(episodes[0].outcome.status).toBe('partial');
  });

  it('all actions failed → failed', () => {
    const episodes = aggregateEpisodes({ ...base, events: [op(false)] });
    expect(episodes[0].outcome.status).toBe('failed');
  });

  it('no actions and AC still running → ongoing', () => {
    const episodes = aggregateEpisodes({
      ...base,
      events: [
        frame('collaboration.started', {
          collaborationId: 'ac-1',
          initiator: 'agent-sensor',
          participants: ['agent-appliance'],
        }, iso(1000)),
      ],
    });
    expect(episodes[0].outcome.status).toBe('ongoing');
  });

  it('no actions and AC completed → success (pure coordination)', () => {
    const episodes = aggregateEpisodes({
      ...base,
      events: [
        frame('collaboration.started', {
          collaborationId: 'ac-1',
          initiator: 'agent-sensor',
          participants: ['agent-appliance'],
        }, iso(1000)),
        frame('collaboration.completed', { collaborationId: 'ac-1', result: 'ok' }, iso(2000)),
      ],
    });
    expect(episodes[0].outcome.status).toBe('success');
  });

  it('no actions and AC failed → failed', () => {
    const episodes = aggregateEpisodes({
      ...base,
      events: [
        frame('collaboration.started', {
          collaborationId: 'ac-1',
          initiator: 'agent-sensor',
          participants: ['agent-appliance'],
        }, iso(1000)),
        frame('collaboration.completed', { collaborationId: 'ac-1', success: false }, iso(2000)),
      ],
    });
    expect(episodes[0].outcome.status).toBe('failed');
  });

  it('ignore/defer decisions need no action → success', () => {
    const episodes = aggregateEpisodes({
      decisions: [decision('agent-sensor', 'evt-1', iso(0), { decision: 'ignore' })],
      names: NAMES,
    });
    expect(episodes[0].outcome.status).toBe('success');
  });

  it('decision without collaboration or actions stays ongoing', () => {
    const episodes = aggregateEpisodes(base);
    expect(episodes[0].outcome.status).toBe('ongoing');
  });

  it('re-aggregation moves an episode from ongoing to success as frames arrive', () => {
    const early = aggregateEpisodes({
      ...base,
      events: [
        frame('collaboration.started', {
          collaborationId: 'ac-1',
          initiator: 'agent-sensor',
          participants: ['agent-appliance'],
        }, iso(1000)),
      ],
    });
    expect(early[0].outcome.status).toBe('ongoing');
    const later = aggregateEpisodes({
      ...base,
      events: [
        ...smokeEpisodeFrames(),
      ],
      triggerHints: { 'evt-1': HINT_SMOKE },
    });
    expect(later[0].outcome.status).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// Physical delta annotation
// ---------------------------------------------------------------------------

describe('aggregateEpisodes · physical delta', () => {
  it('annotates the trigger parameter change into the summary tail', () => {
    const d = decision('agent-sensor', 'evt-1', iso(0));
    const episodes = aggregateEpisodes({
      decisions: [d],
      triggerHints: { 'evt-1': HINT_SMOKE },
      snapshots: [
        makeSnapshot({
          recentDecisions: [d],
          zones: [{ id: 'zone-kitchen', parameters: { smoke: 0.75 } }],
        }),
        makeSnapshot({ zones: [{ id: 'zone-kitchen', parameters: { smoke: 0.12 } }] }),
      ],
      names: NAMES,
    });
    expect(episodes[0].outcome.summary).toContain('Smoke 0.75→0.12');
  });

  it('stays silent when the parameter did not change', () => {
    const d = decision('agent-sensor', 'evt-1', iso(0));
    const episodes = aggregateEpisodes({
      decisions: [d],
      triggerHints: { 'evt-1': { ...HINT_SMOKE, value: 0.5 } },
      snapshots: [
        makeSnapshot({
          recentDecisions: [d],
          zones: [{ id: 'zone-kitchen', parameters: { smoke: 0.5 } }],
        }),
        makeSnapshot({ zones: [{ id: 'zone-kitchen', parameters: { smoke: 0.5 } }] }),
      ],
      names: NAMES,
    });
    expect(episodes[0].outcome.summary).not.toContain('→');
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe('filterEpisodes (+ 只看我参与的)', () => {
  const episodes = aggregateEpisodes({
    decisions: [
      decision('agent-sensor', 'evt-1', iso(0)),
      decision('agent-climate', 'evt-2', iso(1000)),
    ],
    events: smokeEpisodeFrames(),
    triggerHints: {
      'evt-1': HINT_SMOKE,
      'evt-2': { type: 'temperature-spike', zoneId: 'zone-bedroom', parameter: 'temperature', value: 33 },
    },
    names: NAMES,
  });

  it('filters by involved agent (decisions, AC participants, action agents)', () => {
    const visible = filterEpisodes(episodes, { agentIds: new Set(['agent-appliance']) });
    expect(visible).toHaveLength(1);
    expect(visible[0].trigger.eventId).toBe('evt-1');
    expect(episodeAgents(visible[0])).toContain('agent-appliance');
  });

  it('filters by trigger zone', () => {
    const visible = filterEpisodes(episodes, { zoneIds: new Set(['zone-bedroom']) });
    expect(visible.map(e => e.trigger.eventId)).toEqual(['evt-2']);
  });

  it('filters by outcome', () => {
    const visible = filterEpisodes(episodes, { outcomes: new Set(['ongoing']) });
    expect(visible.map(e => e.trigger.eventId)).toEqual(['evt-2']);
    expect(
      filterEpisodes(episodes, { outcomes: new Set(['success']) }).map(e => e.trigger.eventId),
    ).toEqual(['evt-1']);
  });

  it('combines filters (AND across dimensions)', () => {
    const visible = filterEpisodes(episodes, {
      agentIds: new Set(['agent-appliance']),
      outcomes: new Set(['success']),
    });
    expect(visible).toHaveLength(1);
    expect(
      filterEpisodes(episodes, {
        agentIds: new Set(['agent-appliance']),
        outcomes: new Set(['failed']),
      }),
    ).toHaveLength(0);
  });

  it('ownedAgentIds powers the「只看我参与的」quick chip', () => {
    const mine = ownedAgentIds(
      [
        { id: 'agent-sensor', ownerId: 'u-1' },
        { id: 'agent-appliance', ownerId: 'u-2' },
        { id: 'agent-climate', ownerId: null },
      ],
      'u-1',
    );
    expect(mine).toEqual(['agent-sensor']);
    const visible = filterEpisodes(episodes, { agentIds: new Set(mine) });
    // evt-1 involves agent-sensor (initiator), evt-2 does not.
    expect(visible.map(e => e.trigger.eventId)).toEqual(['evt-1']);
    expect(ownedAgentIds([{ id: 'a', ownerId: 'u-1' }], null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Replay-cursor derivation
// ---------------------------------------------------------------------------

describe('episodeIdAtTime (replay cursor highlight)', () => {
  const episodes: Episode[] = aggregateEpisodes({
    decisions: [
      decision('agent-sensor', 'evt-1', iso(0)),
      decision('agent-sensor', 'evt-2', iso(10000)),
    ],
    events: [
      frame('device.operation_executed', {
        agentId: 'agent-sensor',
        deviceId: 'dev-hood',
        commandName: 'turn-on',
        result: { success: true },
      }, iso(2000)),
    ],
    names: NAMES,
  });

  it('finds the episode whose [startAt, lastAt] contains the time', () => {
    expect(episodeIdAtTime(episodes, T0 + 1500)).toBe('evt-1');
  });

  it('returns null outside every episode and for null input', () => {
    expect(episodeIdAtTime(episodes, T0 + 8000)).toBeNull();
    expect(episodeIdAtTime(episodes, null)).toBeNull();
  });

  it('prefers the latest-starting episode when ranges overlap', () => {
    const overlapping: Episode[] = [
      {
        id: 'a',
        trigger: { type: 't' },
        decisions: [],
        actions: [],
        outcome: { status: 'ongoing', summary: '' },
        startAt: iso(0),
        lastAt: iso(20000),
      },
      {
        id: 'b',
        trigger: { type: 't' },
        decisions: [],
        actions: [],
        outcome: { status: 'ongoing', summary: '' },
        startAt: iso(10000),
        lastAt: iso(30000),
      },
    ];
    expect(episodeIdAtTime(overlapping, T0 + 15000)).toBe('b');
  });
});
