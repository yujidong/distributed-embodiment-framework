/**
 * HeroLine（R14 P0-2 「正在发生」头条）deriveHeroLine 的优先级与格式化：
 * 决策（agent 名 + 本地化动作 + zone + reasoning）> 最新事件 summary > 空占位；
 * relativeAge 的秒/分/时分档；decisionLabel 的未知决策兜底。
 */

import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../i18n/config';
import type { EngineSnapshot, RuntimeCollaborationRecord } from '../api/types';
import type { EventLogEntry } from '../lib/eventLog';
import { decisionLabel, deriveHeroLine, relativeAge } from '../lib/happeningNow';

// 纯函数在调用时读全局 i18next；固定 en-US 以便断言精确文案。
beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

const NOW = Date.parse('2026-08-19T09:00:00.000Z');

function snapshot(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return {
    runtimeId: 'rt-1',
    scenarioId: 'sc-1',
    scenarioName: 'Test',
    state: 'running',
    simTimeSec: 100,
    simTime: '2026-08-19T09:00:00.000Z',
    speed: 60,
    tickCount: 10,
    zones: [
      { id: 'z-301', name: 'Room 301', parameters: {} },
      { id: 'z-302', parameters: {} },
    ],
    devices: [],
    agents: [
      {
        id: 'agent-1',
        name: 'Building Steward',
        capabilities: [],
        managedZoneIds: ['z-301'],
        boundDeviceIds: [],
        llmEnabled: false,
        activeACCount: 0,
        eventsProcessed: 3,
        activeCollaborations: [],
        reputation: { overallScore: 0.7, totalAttempts: 0, topCapabilities: [] },
      },
    ],
    recentDecisions: [],
    scheduledEvents: [],
    ...overrides,
  };
}

function eventEntry(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    id: 'evt-x',
    family: 'environment',
    type: 'environment.param_changed',
    at: '2026-08-19T08:59:50.000Z',
    summary: 'Environment param z-301 temperature = 31.2',
    event: { id: 'evt-x', type: 'environment.param_changed', source: 'engine' },
    ...overrides,
  };
}

describe('deriveHeroLine', () => {
  it('prefers the newest snapshot decision with agent name, verb, zone and reasoning', () => {
    const model = deriveHeroLine({
      snapshot: snapshot({
        recentDecisions: [
          {
            agentId: 'agent-1',
            eventId: 'evt-1',
            eventType: 'temperature-spike',
            decision: 'defer',
            decisionSource: 'precheck',
            reasoning: '缺少必需能力，推迟',
            at: '2026-08-19T08:59:58.000Z',
          },
        ],
      }),
      latestEvent: eventEntry(),
      scenarioEvents: [
        { id: 'evt-1', type: 'temperature-spike', zoneId: 'z-301', atSimTimeSec: 60 },
      ],
    });
    expect(model.kind).toBe('decision');
    expect(model.agentName).toBe('Building Steward');
    expect(model.verb).toBe('Defer');
    expect(model.decision).toBe('defer');
    expect(model.zoneLabel).toBe('Room 301');
    expect(model.reasoning).toBe('缺少必需能力，推迟');
    expect(model.at).toBe('2026-08-19T08:59:58.000Z');
  });

  it('falls back to the agent id and the raw decision verb when unknown', () => {
    const model = deriveHeroLine({
      snapshot: snapshot({
        agents: [],
        recentDecisions: [
          {
            agentId: 'agent-9',
            eventId: 'evt-x',
            eventType: 'smoke',
            decision: 'some_future_decision',
            decisionSource: 'llm',
            at: '2026-08-19T08:59:58.000Z',
          },
        ],
      }),
      latestEvent: null,
      scenarioEvents: [],
    });
    expect(model.agentName).toBe('agent-9');
    expect(model.verb).toBe('some_future_decision');
    expect(model.zoneLabel).toBeUndefined();
    expect(model.reasoning).toBeUndefined();
  });

  it('uses the newest decision (ring buffer: newest last)', () => {
    const model = deriveHeroLine({
      snapshot: snapshot({
        recentDecisions: [
          {
            agentId: 'agent-1',
            eventId: 'evt-1',
            eventType: 'a',
            decision: 'ignore',
            decisionSource: 'rule',
            at: '2026-08-19T08:59:00.000Z',
          },
          {
            agentId: 'agent-1',
            eventId: 'evt-2',
            eventType: 'b',
            decision: 'initiate_ac',
            decisionSource: 'llm',
            at: '2026-08-19T08:59:30.000Z',
          },
        ],
      }),
      latestEvent: null,
      scenarioEvents: [],
    });
    expect(model.decision).toBe('initiate_ac');
    expect(model.verb).toBe('Initiate collaboration');
  });

  it('resolves the zone of an injected event via triggerHints (no bus echo)', () => {
    const model = deriveHeroLine({
      snapshot: snapshot({
        recentDecisions: [
          {
            agentId: 'agent-1',
            eventId: 'evt-runtime-1',
            eventType: 'temperature-spike',
            decision: 'handle_independently',
            decisionSource: 'rule',
            at: '2026-08-19T08:59:58.000Z',
          },
        ],
      }),
      latestEvent: null,
      scenarioEvents: [],
      triggerHints: { 'evt-runtime-1': { type: 'temperature-spike', zoneId: 'z-301' } },
    });
    expect(model.zoneLabel).toBe('Room 301');
  });

  it('falls back to the latest event summary when there are no decisions', () => {
    const model = deriveHeroLine({
      snapshot: snapshot(),
      latestEvent: eventEntry(),
      scenarioEvents: [],
    });
    expect(model.kind).toBe('event');
    expect(model.eventSummary).toBe('Environment param z-301 temperature = 31.2');
    expect(model.at).toBe('2026-08-19T08:59:50.000Z');
  });

  it('yields the idle placeholder when neither decisions nor events exist', () => {
    expect(deriveHeroLine({ snapshot: null, latestEvent: null, scenarioEvents: [] }).kind).toBe('idle');
    expect(deriveHeroLine({ snapshot: snapshot(), latestEvent: null, scenarioEvents: [] }).kind).toBe('idle');
  });

  // R2-FEAT-10: an LLM-down degraded decision (T-022 rule-fallback) is a
  // deployment alert, not a decision headline — no provider-error reasoning,
  // no fake「agent decided」line.
  it('classifies a rule-llm-down decision as the llm-down deployment alert (R2-FEAT-10)', () => {
    const model = deriveHeroLine({
      snapshot: snapshot({
        recentDecisions: [
          {
            agentId: 'agent-1',
            eventId: 'evt-1',
            eventType: 'temperature-spike',
            decision: 'defer',
            decisionSource: 'rule-llm-down',
            reasoning: 'LLM provider error after 2 attempts: 404 model not found',
            reasoningCode: 'rule.llm_down',
            reasoningParams: { attempts: 2, missing: 'none' },
            zoneId: 'z-301',
            at: '2026-08-19T08:59:58.000Z',
          },
        ],
      }),
      latestEvent: eventEntry(),
      scenarioEvents: [],
    });
    expect(model.kind).toBe('llm-down');
    expect(model.agentName).toBe('Building Steward');
    expect(model.zoneLabel).toBe('Room 301');
    expect(model.at).toBe('2026-08-19T08:59:58.000Z');
    // The provider error text must NOT surface as the headline reasoning.
    expect(model.reasoning).toBeUndefined();
  });

  it('a genuine decision right after an llm-down one wins back the headline', () => {
    const model = deriveHeroLine({
      snapshot: snapshot({
        recentDecisions: [
          {
            agentId: 'agent-1',
            eventId: 'evt-1',
            eventType: 'temperature-spike',
            decision: 'defer',
            decisionSource: 'rule-llm-down',
            at: '2026-08-19T08:59:58.000Z',
          },
          {
            agentId: 'agent-1',
            eventId: 'evt-2',
            eventType: 'temperature-spike',
            decision: 'handle_independently',
            decisionSource: 'llm',
            at: '2026-08-19T08:59:59.000Z',
          },
        ],
      }),
      latestEvent: null,
      scenarioEvents: [],
    });
    expect(model.kind).toBe('decision');
    expect(model.decision).toBe('handle_independently');
  });
});

describe('deriveHeroLine — UX-06 collaboration follow-up', () => {
  const PARTNER_AGENT = {
    id: 'agent-2',
    name: 'Climate Steward',
    capabilities: [],
    managedZoneIds: ['z-302'],
    boundDeviceIds: [],
    llmEnabled: false,
    activeACCount: 1,
    eventsProcessed: 1,
    activeCollaborations: [],
    reputation: { overallScore: 0.5, totalAttempts: 0, topCapabilities: [] },
  };

  function initiateAcSnapshot(): EngineSnapshot {
    return snapshot({
      agents: [...snapshot().agents, PARTNER_AGENT],
      recentDecisions: [
        {
          agentId: 'agent-1',
          eventId: 'evt-1',
          eventType: 'smoke',
          decision: 'initiate_ac',
          decisionSource: 'llm',
          at: '2026-08-19T08:59:58.000Z',
        },
      ],
    });
  }

  function collabRow(overrides: Partial<RuntimeCollaborationRecord> = {}): RuntimeCollaborationRecord {
    return {
      id: 'ac-1',
      agentId: 'agent-1',
      role: 'initiator',
      status: 'pending',
      type: 'ac',
      initiator: 'agent-1',
      participants: ['agent-2'],
      description: 'smoke response',
      createdAt: '2026-08-19T08:59:58.500Z',
      updatedAt: '2026-08-19T08:59:58.500Z',
      history: false,
      ...overrides,
    };
  }

  it('names the partner agent (not the zone) while the handshake is in progress', () => {
    const model = deriveHeroLine({
      snapshot: initiateAcSnapshot(),
      latestEvent: null,
      scenarioEvents: [{ id: 'evt-1', type: 'smoke', zoneId: 'z-301', atSimTimeSec: 60 }],
      collaborations: [collabRow()],
    });
    expect(model.decision).toBe('initiate_ac');
    expect(model.partnerNames).toEqual(['Climate Steward']);
    expect(model.collabOutcome).toBeUndefined();
  });

  it('switches to the cancelled outcome once the handshake died (timeout ends as cancelled)', () => {
    const model = deriveHeroLine({
      snapshot: initiateAcSnapshot(),
      latestEvent: null,
      scenarioEvents: [],
      collaborations: [
        collabRow({ status: 'cancelled', history: true, updatedAt: '2026-08-19T09:02:00.000Z' }),
        collabRow({
          agentId: 'agent-2',
          role: 'participant',
          participants: [],
          status: 'cancelled',
          history: true,
        }),
      ],
    });
    expect(model.collabOutcome).toBe('cancelled');
    expect(model.partnerNames).toEqual(['Climate Steward']);
    expect(model.verb).toBe('Initiate collaboration');
  });

  it('reports failed and completed outcomes from the initiator row', () => {
    for (const status of ['failed', 'completed'] as const) {
      const model = deriveHeroLine({
        snapshot: initiateAcSnapshot(),
        latestEvent: null,
        scenarioEvents: [],
        collaborations: [collabRow({ status, history: true })],
      });
      expect(model.collabOutcome).toBe(status);
    }
  });

  it('ignores collaborations started before the decision and unrelated initiators', () => {
    const model = deriveHeroLine({
      snapshot: initiateAcSnapshot(),
      latestEvent: null,
      scenarioEvents: [{ id: 'evt-1', type: 'smoke', zoneId: 'z-301', atSimTimeSec: 60 }],
      collaborations: [
        // An older session by the same agent — not spawned by this decision.
        collabRow({ id: 'ac-old', createdAt: '2026-08-19T08:50:00.000Z', status: 'active' }),
        // A live session by ANOTHER initiator.
        collabRow({ id: 'ac-other', initiator: 'agent-2', agentId: 'agent-2', role: 'initiator' }),
      ],
    });
    expect(model.partnerNames).toBeUndefined();
    expect(model.collabOutcome).toBeUndefined();
    expect(model.zoneLabel).toBe('Room 301'); // falls back to the zone line
  });

  it('keeps the zone line when no collaborations face is supplied', () => {
    const model = deriveHeroLine({
      snapshot: initiateAcSnapshot(),
      latestEvent: null,
      scenarioEvents: [{ id: 'evt-1', type: 'smoke', zoneId: 'z-301', atSimTimeSec: 60 }],
    });
    expect(model.zoneLabel).toBe('Room 301');
    expect(model.partnerNames).toBeUndefined();
  });
});

describe('relativeAge', () => {
  it('buckets seconds / minutes / hours', () => {
    expect(relativeAge('2026-08-19T08:59:58.000Z', NOW)).toBe('2s ago');
    expect(relativeAge('2026-08-19T08:57:00.000Z', NOW)).toBe('3m ago');
    expect(relativeAge('2026-08-19T06:30:00.000Z', NOW)).toBe('2h ago');
  });

  it('clamps future timestamps to 0s and rejects unusable input', () => {
    expect(relativeAge('2026-08-19T09:00:05.000Z', NOW)).toBe('0s ago');
    expect(relativeAge('not-a-date', NOW)).toBeNull();
    expect(relativeAge(null, NOW)).toBeNull();
  });
});

describe('decisionLabel', () => {
  it('localizes the known decision verbs and passes unknown values through', () => {
    expect(decisionLabel('initiate_ac')).toBe('Initiate collaboration');
    expect(decisionLabel('handle_independently')).toBe('Handle independently');
    expect(decisionLabel('defer')).toBe('Defer');
    expect(decisionLabel('ignore')).toBe('Ignore');
    expect(decisionLabel('unknown_kind')).toBe('unknown_kind');
  });
});
