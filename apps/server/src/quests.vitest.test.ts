/**
 * @vitest-environment node
 *
 * R6-D-M1 (gamification-design.md §2): the L1-L6 quest backbone.
 *
 * - deriveQuests (quests.ts) is a pure function — full state coverage here:
 *   empty world → stepwise unlock → locked-but-achieved (a later condition
 *   met while an earlier quest is missing) → all six clear.
 * - GET /api/environments/:id/quest-state assembles the facts from the
 *   digest/eval-report store口径; the route tests pin the contract shape and
 *   the L1/L2 transitions a fresh world walks through.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveQuests, type QuestFacts, type QuestId } from './quests.js';
import { makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

function facts(overrides: Partial<QuestFacts> = {}): QuestFacts {
  return {
    zones: 0,
    devices: 0,
    boundAgents: 0,
    cognitiveDecisions: 0,
    handshakesSucceeded: 0,
    completedAgreements: 0,
    enabledFlows: 0,
    successfulFlowRuns: 0,
    usageRecords: 0,
    ...overrides,
  };
}

function questOf(state: ReturnType<typeof deriveQuests>, id: QuestId) {
  return state.quests.find(q => q.id === id)!;
}

describe('deriveQuests (pure, R6-D-M1)', () => {
  it('empty world: L1 current, everything else locked, nothing achieved', () => {
    const state = deriveQuests(facts());
    expect(state.quests.map(q => q.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
    expect(state.current).toBe('L1');
    expect(questOf(state, 'L1')).toMatchObject({ achieved: false, locked: false, hint: 'import-building' });
    for (const id of ['L2', 'L3', 'L4', 'L5', 'L6'] as const) {
      expect(questOf(state, id)).toMatchObject({ achieved: false, locked: true });
    }
  });

  it('unlocks step by step as each condition lands', () => {
    let state = deriveQuests(facts({ zones: 2 }));
    expect(state.current).toBe('L2');
    expect(questOf(state, 'L1').achieved).toBe(true);
    expect(questOf(state, 'L2').locked).toBe(false);

    state = deriveQuests(facts({ zones: 2, devices: 1 }));
    expect(state.current).toBe('L3');

    // A bound agent alone is not staffed — the engine must have decided once.
    state = deriveQuests(facts({ zones: 2, devices: 1, boundAgents: 1 }));
    expect(questOf(state, 'L3').achieved).toBe(false);
    expect(state.current).toBe('L3');

    state = deriveQuests(facts({ zones: 2, devices: 1, boundAgents: 1, cognitiveDecisions: 1 }));
    expect(questOf(state, 'L3').achieved).toBe(true);
    expect(state.current).toBe('L4');

    state = deriveQuests(
      facts({ zones: 2, devices: 1, boundAgents: 1, cognitiveDecisions: 1, handshakesSucceeded: 1 }),
    );
    expect(state.current).toBe('L5');

    // L5 needs a TERMINATED agreement with outcome completed — a bare
    // handshake does not clear it.
    expect(questOf(state, 'L5').achieved).toBe(false);
    state = deriveQuests(
      facts({
        zones: 2, devices: 1, boundAgents: 1, cognitiveDecisions: 1,
        handshakesSucceeded: 1, completedAgreements: 1,
      }),
    );
    expect(state.current).toBe('L6');

    // L6: either an enabled flow with a successful run, or metered usage.
    state = deriveQuests(
      facts({
        zones: 2, devices: 1, boundAgents: 1, cognitiveDecisions: 1,
        handshakesSucceeded: 1, completedAgreements: 1,
        enabledFlows: 1, successfulFlowRuns: 1,
      }),
    );
    expect(state.current).toBe(null);
    expect(state.quests.every(q => q.achieved)).toBe(true);

    state = deriveQuests(
      facts({
        zones: 2, devices: 1, boundAgents: 1, cognitiveDecisions: 1,
        handshakesSucceeded: 1, completedAgreements: 1, usageRecords: 1,
      }),
    );
    expect(state.current).toBe(null);
  });

  it('an enabled flow without a successful run does not clear L6', () => {
    const state = deriveQuests(
      facts({
        zones: 1, devices: 1, boundAgents: 1, cognitiveDecisions: 1,
        handshakesSucceeded: 1, completedAgreements: 1, enabledFlows: 1,
      }),
    );
    expect(questOf(state, 'L6').achieved).toBe(false);
    expect(state.current).toBe('L6');
  });

  it('a later condition met early stays LOCKED until the chain catches up', () => {
    // A completed agreement exists, but the world has no devices — L5's fact
    // is true yet the quest is locked behind L2.
    const state = deriveQuests(
      facts({ zones: 1, handshakesSucceeded: 1, completedAgreements: 1 }),
    );
    expect(questOf(state, 'L5')).toMatchObject({ achieved: true, locked: true });
    expect(state.current).toBe('L2');
  });
});

describe('GET /api/environments/:id/quest-state (R6-D-M1)', () => {
  let ctx: TestAppContext;
  let owner: { id: string; token: string };
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Teacher' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'Quest Lab', visibility: 'public', mapData: { zones: [{ id: 'zone-a' }] } },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });
  afterEach(async () => { await ctx.cleanup(); });

  interface QuestStateBody {
    quests: Array<{ id: QuestId; achieved: boolean; locked: boolean; hint: string }>;
    current: QuestId | null;
  }

  async function questState(id: string = envId, token?: string): Promise<QuestStateBody> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${id}/quest-state`,
      ...(token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as QuestStateBody;
  }

  it('fresh world with zones: L1 achieved, L2 current, L3-L6 locked', async () => {
    const state = await questState();
    expect(state.quests.map(q => q.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
    expect(state.quests[0]).toMatchObject({ id: 'L1', achieved: true, locked: false });
    expect(state.quests[1]).toMatchObject({ id: 'L2', achieved: false, locked: false });
    expect(state.current).toBe('L2');
    for (const q of state.quests.slice(2)) {
      expect(q.locked).toBe(true);
    }
  });

  it('installing a blueprint clears L2 and advances to L3 (no decision yet)', async () => {
    const install = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/blueprints/co2-monitor/install`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { zoneId: 'zone-a' },
    });
    expect(install.statusCode).toBe(201);

    const state = await questState();
    expect(questOf(state, 'L1').achieved).toBe(true);
    expect(questOf(state, 'L2').achieved).toBe(true);
    // The pair card binds an agent to the sensor, but no cognitive decision
    // has been recorded for it yet — L3 stays open as the current quest.
    expect(questOf(state, 'L3').achieved).toBe(false);
    expect(state.current).toBe('L3');
  });

  it('is readable anonymously on a public env and 404s on an unknown env', async () => {
    // Public env: no auth header needed (same read gate as the digest).
    const state = await questState(envId);
    expect(state.current).toBe('L2');

    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments/no-such-env/quest-state',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(missing.statusCode).toBe(404);
  });
});
