/**
 * @vitest-environment node
 *
 * Human-review threshold policy tests (DevLoop S1, Task 3).
 *
 * The owner-tunable rule-level risk classification: breadth classes that
 * force HUMAN review (owner escalation) beyond the existing hard markers
 * (hass://, oversized batches, supervised zones, zone claims, cross-party
 * cascades) and the always-on prompt-injection gate (Task 2).
 *
 * Classes (each 0 = disarmed, the DEFAULT):
 * - maxAgentsPerProposal: install-agents fleet breadth ("delegate-like
 *   breadth"; flows have NO proposal lane — routes/flows.ts — so agent
 *   fleets are the delegation class that rides the pipeline);
 * - maxEventsPerProposal: inject-scenario overlay breadth;
 * - maxZonesTouched: cross-zone access breadth.
 *
 * Resolution: per-env owner override (mapData.governance.humanReview,
 * owner-only PATCH lane) over deployment env vars.
 *
 * Conservative allow-list contract: a proposal still AUTO-APPLIES only when
 * rule check passed + low risk + no marker + no injection + within every
 * armed threshold. Default (all 0) = current behavior exactly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type EafDatabase } from './db/database.js';
import { EnvironmentStore } from './db/environment-store.js';
import { UserStore } from './db/user-store.js';
import {
  applyHumanReviewPolicy,
  resolveHumanReviewThresholds,
  DEFAULT_HUMAN_REVIEW_THRESHOLDS,
  type HumanReviewThresholds,
} from './proposal-human-review-policy.js';
import { checkProposalRules, type RuleCheckResult } from './proposal-rules.js';
import { auth, makeTestApp, registerUser, type TestAppContext, type TestUser } from './test-utils.js';

function emptyResult(): RuleCheckResult {
  return {
    ok: true,
    issues: [],
    warnings: [],
    riskLevel: 'low',
    forceEscalate: false,
    devices: [],
    agents: [],
    zones: [],
    removedDevices: [],
    removedAgents: [],
    modifyTarget: null,
    events: [],
    expiresAt: null,
  };
}

describe('human-review threshold policy (unit)', () => {
  let db: EafDatabase;
  let envStore: EnvironmentStore;
  let envId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    envStore = new EnvironmentStore(db);
    const owner = new UserStore(db).create('owner@example.com', 'hash', 'Owner');
    envId = envStore.createEnvironment({
      name: 'Policy Lab',
      ownerId: owner.id,
      mapData: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }, { id: 'zone-c' }] },
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  it('class (a): agent-fleet breadth forces escalated when armed', () => {
    const result = emptyResult();
    result.agents = [1, 2, 3].map(i => ({
      name: `agent-${i}`,
      capabilities: [],
      boundDeviceIds: [],
      managedZoneIds: [],
      llm: null,
      decisionPolicy: null,
      derivedServiceVisibility: null,
      zoneIds: [],
    }));
    applyHumanReviewPolicy('install-agents', {}, result, {
      ...DEFAULT_HUMAN_REVIEW_THRESHOLDS,
      maxAgentsPerProposal: 2,
    });
    expect(result.forceEscalate).toBe(true);
    expect(result.riskLevel).toBe('high');
    expect(result.escalateReason).toContain('human-review policy');
    expect(result.escalateReason).toContain('3 agents');
    expect(result.escalateReason).toContain('delegate-like breadth');
  });

  it('class (a): the same proposal stays auto-eligible at/below the threshold', () => {
    const result = emptyResult();
    result.agents = [{ name: 'agent-1', capabilities: [], boundDeviceIds: [], managedZoneIds: [], llm: null, decisionPolicy: null, derivedServiceVisibility: null, zoneIds: [] }];
    applyHumanReviewPolicy('install-agents', {}, result, {
      ...DEFAULT_HUMAN_REVIEW_THRESHOLDS,
      maxAgentsPerProposal: 2,
    });
    expect(result.forceEscalate).toBe(false);
    expect(result.riskLevel).toBe('low');
  });

  it('class (b): event-overlay breadth forces escalated when armed', () => {
    const result = emptyResult();
    result.events = [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }] as Record<string, unknown>[];
    applyHumanReviewPolicy('inject-scenario', {}, result, {
      ...DEFAULT_HUMAN_REVIEW_THRESHOLDS,
      maxEventsPerProposal: 2,
    });
    expect(result.forceEscalate).toBe(true);
    expect(result.escalateReason).toContain('3 scheduled events');
    expect(result.escalateReason).toContain('overlay breadth');
  });

  it('class (c): cross-zone access breadth forces escalated when armed', () => {
    const result = emptyResult();
    result.devices = [
      { name: 'd1', type: 'sensor', brand: null, capabilities: [], zoneId: 'zone-a', position: null, initialState: null, binding: null },
      { name: 'd2', type: 'sensor', brand: null, capabilities: [], zoneId: 'zone-b', position: null, initialState: null, binding: null },
      { name: 'd3', type: 'sensor', brand: null, capabilities: [], zoneId: 'zone-c', position: null, initialState: null, binding: null },
    ];
    applyHumanReviewPolicy('install-devices', {}, result, {
      ...DEFAULT_HUMAN_REVIEW_THRESHOLDS,
      maxZonesTouched: 2,
    });
    expect(result.forceEscalate).toBe(true);
    expect(result.escalateReason).toContain('3 zones');
    expect(result.escalateReason).toContain('cross-zone');
  });

  it('default policy: all classes disarmed — benign proposals unchanged', () => {
    const result = emptyResult();
    result.agents = new Array(30).fill(0).map((_, i) => ({
      name: `agent-${i}`, capabilities: [], boundDeviceIds: [], managedZoneIds: [],
      llm: null, decisionPolicy: null, derivedServiceVisibility: null, zoneIds: [],
    }));
    result.events = new Array(30).fill(0).map((_, i) => ({ id: `e${i}` })) as Record<string, unknown>[];
    applyHumanReviewPolicy('install-agents', {}, result, DEFAULT_HUMAN_REVIEW_THRESHOLDS);
    expect(result.forceEscalate).toBe(false);
    expect(result.riskLevel).toBe('low');
    expect(result.escalateReason).toBeUndefined();
  });

  it('OR-composes with earlier markers and names itself', () => {
    const result = emptyResult();
    result.forceEscalate = true;
    result.escalateReason = 'hass:// binding on "d1" touches a real actuator';
    result.agents = [{ name: 'a', capabilities: [], boundDeviceIds: [], managedZoneIds: [], llm: null, decisionPolicy: null, derivedServiceVisibility: null, zoneIds: [] }, { name: 'b', capabilities: [], boundDeviceIds: [], managedZoneIds: [], llm: null, decisionPolicy: null, derivedServiceVisibility: null, zoneIds: [] }];
    applyHumanReviewPolicy('install-agents', {}, result, {
      ...DEFAULT_HUMAN_REVIEW_THRESHOLDS,
      maxAgentsPerProposal: 1,
    });
    expect(result.escalateReason).toContain('hass://');
    expect(result.escalateReason).toContain('human-review policy');
  });

  it('per-env owner override wins field by field over deployment defaults', () => {
    const deployment: HumanReviewThresholds = {
      maxAgentsPerProposal: 5,
      maxEventsPerProposal: 0,
      maxZonesTouched: 4,
    };
    // No override: deployment values.
    expect(resolveHumanReviewThresholds(envStore.getEnvironment(envId), deployment))
      .toEqual(deployment);

    // Owner arms a stricter agents threshold + an events threshold; zones stays.
    envStore.updateEnvironment(envId, {
      mapData: {
        zones: [{ id: 'zone-a' }, { id: 'zone-b' }, { id: 'zone-c' }],
        governance: { humanReview: { maxAgentsPerProposal: 1, maxEventsPerProposal: 2 } },
      },
    });
    expect(resolveHumanReviewThresholds(envStore.getEnvironment(envId), deployment)).toEqual({
      maxAgentsPerProposal: 1,
      maxEventsPerProposal: 2,
      maxZonesTouched: 4,
    });
  });

  it('the rule check applies the effective policy end to end', () => {
    const ctx = {
      envStore,
      catalogStore: { get: () => undefined } as never,
      quotas: {
        maxEnvsPerUser: 5, maxDevicesPerEnv: 200, maxAgentsPerEnv: 50,
        maxZonesPerEnv: 100, maxRunningSimsPerUser: 5, maxSandboxesPerUserPerEnv: 5,
      } as never,
      humanReviewThresholds: { ...DEFAULT_HUMAN_REVIEW_THRESHOLDS, maxEventsPerProposal: 1 },
    };
    const payload = {
      events: [
        { id: 'e1', type: 'fire-drill', zoneId: 'zone-a' },
        { id: 'e2', type: 'power-outage', zoneId: 'zone-b' },
      ],
    };
    const check = checkProposalRules(ctx, envStore.getEnvironment(envId)!, 'inject-scenario', payload, 'u1');
    expect(check.ok).toBe(true);
    expect(check.forceEscalate).toBe(true);
    expect(check.escalateReason).toContain('human-review policy');

    // Same payload with the class disarmed (deployment default, no override).
    const checkDefault = checkProposalRules(
      { ...ctx, humanReviewThresholds: DEFAULT_HUMAN_REVIEW_THRESHOLDS },
      envStore.getEnvironment(envId)!,
      'inject-scenario',
      payload,
      'u1',
    );
    expect(checkDefault.forceEscalate).toBe(false);
    expect(checkDefault.riskLevel).toBe('low');
  });
});

describe('human-review threshold policy (end-to-end)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp({
      // Arm the cross-zone class at the DEPLOYMENT level for this app.
      proposalHumanReviewMaxZonesTouched: 1,
    });
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'E2E Policy Lab', visibility: 'public', mapData: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }] } },
    });
    envId = created.json().id;
    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(builder.token) });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('a cross-zone proposal escalates under an armed deployment threshold', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
      payload: {
        kind: 'install-devices',
        payload: {
          devices: [
            { name: 'Corridor Sensor', type: 'temperature-sensor', capabilities: ['temperature-sensing'], zoneId: 'zone-a' },
            { name: 'Lab Sensor', type: 'temperature-sensor', capabilities: ['temperature-sensing'], zoneId: 'zone-b' },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('escalated');
    expect(res.json().ruleCheck.escalateReason).toContain('cross-zone');
    // Nothing was installed (owner decides).
    expect(ctx.app.envStore.devicesOf(envId)).toHaveLength(0);
  });

  it('the env detail governance block surfaces the effective thresholds', async () => {
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const governance = detail.json().governance;
    expect(governance.humanReview).toEqual({
      maxAgentsPerProposal: 0,
      maxEventsPerProposal: 0,
      maxZonesTouched: 1,
    });
    expect(governance.humanReviewNote).toContain('prompt-injection');

    // The owner tightens the agents threshold via the mapData lane…
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: {
        mapData: {
          zones: [{ id: 'zone-a' }, { id: 'zone-b' }],
          governance: { humanReview: { maxAgentsPerProposal: 0, maxZonesTouched: 1, maxEventsPerProposal: 3 } },
        },
      },
    });
    expect(patched.statusCode).toBe(200);
    const after = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    })).json().governance;
    expect(after.humanReview.maxEventsPerProposal).toBe(3); // owner value wins

    // …and a malformed threshold is rejected with a teaching message.
    const bad = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: {
        mapData: {
          zones: [{ id: 'zone-a' }, { id: 'zone-b' }],
          governance: { humanReview: { maxAgentsPerProposal: 'many' } },
        },
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain('maxAgentsPerProposal');
  });

  it('default classes disarmed: a single-zone benign proposal keeps the normal funnel', async () => {
    // Fresh app WITHOUT the armed threshold (per-test override of the knob).
    const plain = await makeTestApp();
    try {
      const pOwner = await registerUser(plain.app, { displayName: 'POwner' });
      const pBuilder = await registerUser(plain.app, { displayName: 'PBuilder' });
      const created = await plain.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(pOwner.token),
        payload: { name: 'Plain Lab', visibility: 'public', mapData: { zones: [{ id: 'z1' }, { id: 'z2' }] } },
      });
      const pEnvId = created.json().id;
      await plain.app.inject({ method: 'POST', url: `/api/environments/${pEnvId}/join`, headers: auth(pBuilder.token) });
      const res = await plain.app.inject({
        method: 'POST',
        url: `/api/environments/${pEnvId}/proposals`,
        headers: auth(pBuilder.token),
        payload: {
          kind: 'install-devices',
          payload: {
            devices: [
              { name: 'Corridor Sensor', type: 'temperature-sensor', capabilities: ['temperature-sensing'], zoneId: 'z1' },
              { name: 'Lab Sensor', type: 'temperature-sensor', capabilities: ['temperature-sensing'], zoneId: 'z2' },
            ],
          },
        },
      });
      // Default (escalating) reviewer + no breadth markers: NOT force-
      // escalated by the policy — the proposal follows the normal funnel
      // (escalated here only by the no-LLM fallback reviewer, with NO
      // human-review-policy reason).
      expect(res.json().ruleCheck.forceEscalate).toBe(false);
      expect(res.json().ruleCheck.escalateReason).toBeUndefined();
      expect(res.json().ruleCheck.riskLevel).toBe('low');
    } finally {
      await plain.cleanup();
    }
  });
});
