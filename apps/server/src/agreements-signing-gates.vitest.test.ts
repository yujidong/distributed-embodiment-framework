/**
 * @vitest-environment node
 *
 * Signing-time deliverability gates (R6-B-F01 / R6-C-F02 — the T-310
 * earliest-boundary principle at the contract drafting entries).
 *
 * R6-B-F01 (track-b): an aggregate semantic offer (「新风换气调度」) signed an
 * explicit agreement fine but every invoke answered 409 SERVICE_NOT_BACKED —
 * two defects: the invoke lane resolved the offer rule against the BUILT-IN
 * table only (the mint side merges mapData.semanticOfferRules), and no
 * signing gate checked the actuation backing (the provider's bound devices
 * holding the rule's actuation capabilities). The merged-table fix makes
 * scenario-rule offers invocable; the gate refuses signable-but-undeliverable
 * offers at propose/counter/accept (409 SERVICE_NOT_BACKED, remedy named).
 * Runtime drift after signing stays with the invoke lane.
 *
 * R6-C-F02 (track-c): the hotel signed 7 "borrow the guest-room AC to cool
 * the restaurant" contracts that metered fine and delivered nothing — the
 * signing layer never checked physical reachability. The gate fires only on
 * an explicit terms.targetZoneId claim: same zone is direct, declared zone
 * adjacency is the SpatialField propagation lane, anything else 422s
 * SERVICE_ZONE_UNREACHABLE. Zone-less contracts (incl. trigger.zoneId — the
 * watched EVENT's zone, T-064's cross-zone escalation shape) are untouched;
 * terms.delivery='propagation' is the declared system-level exemption;
 * mapData governance.contractReachabilityCheck=false disarms env-wide.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

/** Scenario with a custom offer rule and two qualifying agents: one grounded
 * (bound HVAC), one declared-only (the signable-but-undeliverable class). */
function aggregateLabScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Signing Gates Lab' },
    zones: [{ id: 'zone-a', adjacentZoneIds: [] as string[] }],
    devices: [
      {
        id: 'hvac-a',
        name: 'HVAC A',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'climate-agent',
        name: 'Climate Agent',
        capabilities: ['temperature-monitoring', 'cooling'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['hvac-a'],
      },
      {
        id: 'ghost-agent',
        name: 'Ghost Agent',
        capabilities: ['temperature-monitoring', 'cooling'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: [] as string[],
      },
    ],
    events: [] as unknown[],
    semanticOfferRules: [
      {
        semanticType: 'lobby-climate-dispatch',
        label: '大堂气候调度',
        description: '温度监测联动制冷调度。',
        requires: ['temperature-monitoring', 'cooling'],
        actuates: ['cooling'],
      },
    ],
  };
}

/** Three-zone world for the reachability gate: a↔b adjacent, c isolated. */
function reachabilityLabScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Reachability Lab' },
    zones: [
      { id: 'zone-a', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', adjacentZoneIds: ['zone-a'] },
      { id: 'zone-c', adjacentZoneIds: [] as string[] },
    ],
    devices: [
      {
        id: 'hvac-a',
        name: 'HVAC A',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'climate-agent',
        name: 'Climate Agent',
        capabilities: ['temperature-monitoring', 'cooling'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['hvac-a'],
      },
    ],
    events: [] as unknown[],
  };
}

describe('R6-B-F01: aggregate offer signing-time deliverability gate', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let hvacId: string;
  let climateAgentId: string;
  let climateOfferId: string;
  let ghostOfferId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...aggregateLabScenario('agg-signing-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    hvacId = (created.json().devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'HVAC A')!.id;
    climateAgentId = (created.json().agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Climate Agent')!.id;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });

    const services = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    })).json().services as Array<{ id: string; name: string; origin: string; provider: { id: string } }>;
    const offers = services.filter(
      service => service.origin === 'aggregate' && service.name === '大堂气候调度',
    );
    expect(offers).toHaveLength(2);
    climateOfferId = offers.find(offer => offer.provider.id === climateAgentId)!.id;
    ghostOfferId = offers.find(offer => offer.provider.id !== climateAgentId)!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function propose(token: string, serviceId: string, terms: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(token),
      payload: { terms },
    });
  }

  it('scenario-rule aggregate signs AND invokes (merged rule table — the 可签不可调 root fix)', async () => {
    const proposed = await propose(consumer.token, climateOfferId, {
      action: { command: 'set-mode', params: { mode: 'cooling' } },
    });
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('active');

    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });

    // Pre-fix this answered 409 SERVICE_NOT_BACKED "no longer matches a
    // semantic offer rule" — the invoke lane read the built-in table only.
    const invoked = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'set-mode', params: { mode: 'cooling' }, simulationId: simId },
    });
    expect(invoked.statusCode, JSON.stringify(invoked.json()).slice(0, 300)).toBe(200);
    expect(invoked.json().deviceId).toBe(hvacId);
  });

  it('propose on a declared-only aggregate (no actuation backing) 409s at the boundary', async () => {
    const proposed = await propose(consumer.token, ghostOfferId);
    expect(proposed.statusCode).toBe(409);
    expect(proposed.json().error.code).toBe('SERVICE_NOT_BACKED');
    expect(proposed.json().error.message).toContain('no actuation backing');
    expect(proposed.json().error.message).toContain('cooling');
    // No row landed — the refusal is not a lifecycle state.
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}&role=consumer`,
      headers: auth(consumer.token),
    });
    expect(list.json().agreements).toHaveLength(0);
  });

  it('accept re-runs the gate: backing lost after propose → 409, agreement stays proposed', async () => {
    const proposed = await propose(consumer.token, climateOfferId);
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;

    // The provider ungrounds the offer: delete the only backing device. The
    // offer row SURVIVES (the agent's declared capabilities still qualify the
    // rule) but its actuation backing is now empty.
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/devices/${hvacId}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBeLessThan(300);
    expect(ctx.app.serviceStore.getService(climateOfferId)).toBeDefined();

    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(409);
    expect(decided.json().error.code).toBe('SERVICE_NOT_BACKED');
    expect(ctx.app.agreementStore.getAgreement(agreementId)!.status).toBe('proposed');
  });

  // -------------------------------------------------------------------------
  // T31 (R3 u2-F-04): the catalog face (service get/list) speaks the SAME
  // aggregate-backing verdict as the signing gate — the detail page used to
  // hardcode backed for every aggregate while propose answered 409.
  // -------------------------------------------------------------------------

  function getService(token: TestUser['token'], serviceId: string) {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/services/${serviceId}`,
      headers: auth(token),
    });
  }

  it('T31: service get carries the rule-lane backing view for a BACKED aggregate (same judgment as the gate)', async () => {
    const got = await getService(consumer.token, climateOfferId);
    expect(got.statusCode).toBe(200);
    expect(got.json().unbacked).toBe(false);
    expect(got.json().consumable).toBe(true);
    // The rule view: kind/rule/actuates/devices/callableActions — the same
    // shape the agreement detail's `backing` field carries.
    expect(got.json().backing).toMatchObject({
      kind: 'rule',
      rule: 'lobby-climate-dispatch',
      actuates: ['cooling'],
    });
    expect(got.json().backing.devices).toEqual([{ id: hvacId, name: 'HVAC A' }]);
    expect(Array.isArray(got.json().backing.callableActions)).toBe(true);
    expect(got.json().backing.callableActions.length).toBeGreaterThan(0);
    expect(got.json().backingMissing).toBeUndefined();
    // The gate agrees: propose goes through.
    expect((await propose(consumer.token, climateOfferId)).statusCode).toBe(201);
  });

  it('T31: a declared-only aggregate reads unbacked:true with the missing diagnosis, and the propose 409 says the SAME thing', async () => {
    const got = await getService(consumer.token, ghostOfferId);
    expect(got.statusCode).toBe(200);
    expect(got.json().unbacked).toBe(true);
    expect(got.json().consumable).toBe(false);
    expect(got.json().backing).toBeUndefined();
    expect(got.json().backingMissing.ruleResolved).toBe(true);
    expect(got.json().backingMissing.actuates).toEqual(['cooling']);
    expect(got.json().backingMissing.boundDevices).toEqual([]);
    // Same remedy the 409 teaching carries (shared constant).
    expect(got.json().backingMissing.remedy).toContain('PATCH /api/agents/:id boundDeviceIds');
    expect(got.json().consumableNote).toContain('no actuation backing');
    expect(got.json().consumableNote).toContain('cooling');
    expect(got.json().consumableNote).toContain('PATCH /api/agents/:id boundDeviceIds');

    // Consistency: the gate's verdict — same service, same moment.
    const refused = await propose(consumer.token, ghostOfferId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('SERVICE_NOT_BACKED');
    expect(refused.json().error.message).toContain('no actuation backing');
    expect(refused.json().error.message).toContain('PATCH /api/agents/:id boundDeviceIds');
  });

  it('T31: the env service LIST flags unbacked aggregates the same way (rule-backed offer exempt from the old hardcode stays backed)', async () => {
    const listed = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(consumer.token),
    })).json().services as Array<{ id: string; unbacked: boolean }>;
    const byId = new Map(listed.map(row => [row.id, row.unbacked]));
    expect(byId.get(climateOfferId)).toBe(false);
    expect(byId.get(ghostOfferId)).toBe(true);
  });

  it('T31: a STALE aggregate (rule withdrawn from the world) reads unbacked with the missing-rule diagnosis', async () => {
    // Withdraw the scenario rule: the aggregate rows survive (mint-time
    // artifacts) but no longer resolve in the merged table.
    const env = ctx.app.envStore.getEnvironment(envId)!;
    const mapData = JSON.parse(env.map_data_json) as { semanticOfferRules?: unknown[] };
    delete mapData.semanticOfferRules;
    ctx.app.envStore.updateEnvironment(envId, { mapData: mapData as never });

    const got = await getService(consumer.token, climateOfferId);
    expect(got.statusCode).toBe(200);
    expect(got.json().unbacked).toBe(true);
    expect(got.json().backing).toBeUndefined();
    expect(got.json().backingMissing.ruleResolved).toBe(false);
    expect(got.json().backingMissing.actuates).toEqual([]);
    expect(got.json().consumableNote).toContain('no semantic offer rule');

    // The gate's verdict on the same stale offer — the missing-rule 409.
    const refused = await propose(consumer.token, climateOfferId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('SERVICE_NOT_BACKED');
    expect(refused.json().error.message).toContain('matches no semantic offer rule');
  });
});

describe('R6-C-F02: contract zone reachability gate', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let serviceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...reachabilityLabScenario('reachability-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    const agentId = (created.json().agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Climate Agent')!.id;

    // A published offer backed by the zone-a HVAC — deterministic handle for
    // the gate (derived rows work the same; the published row is named).
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agentId}/services`,
      headers: auth(owner.token),
      payload: {
        name: 'lobby-cooling',
        semanticType: 'cooling',
        description: '制冷服务',
      },
    });
    expect(published.statusCode).toBe(201);
    serviceId = published.json().id as string;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function propose(terms: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms },
    });
  }

  function decide(token: string, agreementId: string, decision: 'accept' | 'reject') {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(token),
      payload: { decision },
    });
  }

  it('same zone: direct reachability signs and activates', async () => {
    const proposed = await propose({ targetZoneId: 'zone-a' });
    expect(proposed.statusCode).toBe(201);
    const decided = await decide(owner.token, proposed.json().id as string, 'accept');
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('active');
  });

  it('adjacent zone: physical propagation through declared adjacency signs', async () => {
    const proposed = await propose({ targetZoneId: 'zone-b' });
    expect(proposed.statusCode, JSON.stringify(proposed.json()).slice(0, 300)).toBe(201);
    const decided = await decide(owner.token, proposed.json().id as string, 'accept');
    expect(decided.statusCode).toBe(200);
  });

  it('unreachable zone: 422 SERVICE_ZONE_UNREACHABLE with the teaching remedies', async () => {
    const proposed = await propose({ targetZoneId: 'zone-c' });
    expect(proposed.statusCode).toBe(422);
    expect(proposed.json().error.code).toBe('SERVICE_ZONE_UNREACHABLE');
    const message = proposed.json().error.message as string;
    expect(message).toContain('cannot');
    expect(message).toContain('"zone-c"');
    expect(message).toContain('zone-a'); // names where the backing actually sits
    expect(message).toContain('propagation'); // the exemption pointer
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}&role=consumer`,
      headers: auth(consumer.token),
    });
    expect(list.json().agreements).toHaveLength(0);
  });

  it('a zone-less contract is untouched — trigger.zoneId is the EVENT zone (T-064 shape preserved)', async () => {
    const proposed = await propose({
      notes: 'cross-zone observation → action, no physical-target claim',
      trigger: { eventType: 'patient-call', zoneId: 'zone-c' },
      action: { command: 'turn-on' },
    });
    expect(proposed.statusCode, JSON.stringify(proposed.json()).slice(0, 300)).toBe(201);
    const decided = await decide(owner.token, proposed.json().id as string, 'accept');
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('active');
  });

  it('terms.delivery="propagation" is the declared system-level exemption (central HVAC)', async () => {
    const proposed = await propose({ targetZoneId: 'zone-c', delivery: 'propagation' });
    expect(proposed.statusCode, JSON.stringify(proposed.json()).slice(0, 300)).toBe(201);
  });

  it('mapData governance.contractReachabilityCheck=false disarms the gate env-wide', async () => {
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: { mapData: { governance: { contractReachabilityCheck: false } } },
    });
    expect(patched.statusCode, JSON.stringify(patched.json()).slice(0, 300)).toBe(200);
    const proposed = await propose({ targetZoneId: 'zone-c' });
    expect(proposed.statusCode).toBe(201);
    // …and true re-arms it.
    const rearmed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: { mapData: { governance: { contractReachabilityCheck: true } } },
    });
    expect(rearmed.statusCode).toBe(200);
    const refused = await propose({ targetZoneId: 'zone-c' });
    expect(refused.statusCode).toBe(422);
  });

  it('a non-boolean governance.contractReachabilityCheck is a teaching 400', async () => {
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: { mapData: { governance: { contractReachabilityCheck: 'off' } } },
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().error.message).toContain('contractReachabilityCheck');
  });

  it('the counter entry runs the gate — a counter may not smuggle an unreachable target zone in', async () => {
    const proposed = await propose({ notes: 'plain proposal' });
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;
    const countered = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/counter`,
      headers: auth(owner.token),
      payload: { terms: { targetZoneId: 'zone-c', notes: 'counter with unreachable target' } },
    });
    expect(countered.statusCode).toBe(422);
    expect(countered.json().error.code).toBe('SERVICE_ZONE_UNREACHABLE');
    expect(ctx.app.agreementStore.getAgreement(agreementId)!.status).toBe('proposed');
  });

  it('the accept entry re-checks against the CURRENT world — adjacency removed after propose → 422', async () => {
    const proposed = await propose({ targetZoneId: 'zone-b' });
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;

    // The world owner rewrites the zone list WITHOUT the a↔b adjacency.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: {
        mapData: {
          zones: [
            { id: 'zone-a', adjacentZoneIds: [] },
            { id: 'zone-b', adjacentZoneIds: [] },
            { id: 'zone-c', adjacentZoneIds: [] },
          ],
        },
      },
    });
    expect(patched.statusCode).toBe(200);

    const decided = await decide(owner.token, agreementId, 'accept');
    expect(decided.statusCode).toBe(422);
    expect(decided.json().error.code).toBe('SERVICE_ZONE_UNREACHABLE');
    expect(ctx.app.agreementStore.getAgreement(agreementId)!.status).toBe('proposed');
  });

  it('an unknown target zone 422s naming the known zones', async () => {
    const proposed = await propose({ targetZoneId: 'zone-nope' });
    expect(proposed.statusCode).toBe(422);
    expect(proposed.json().error.code).toBe('SERVICE_ZONE_UNREACHABLE');
    expect(proposed.json().error.message).toContain('names no zone');
  });

  it('a computation-backed data service is exempt — bytes travel, physics does not', async () => {
    const registered = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        inputs: {
          zones: ['zone-a'],
          metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }],
        },
        interface: { dataSchema: { fields: [{ name: 'avgTemperature', type: 'number' }] } },
      },
    });
    expect(registered.statusCode, JSON.stringify(registered.json()).slice(0, 300)).toBe(201);
    const proposed = await propose({ targetZoneId: 'zone-c' });
    expect(proposed.statusCode, JSON.stringify(proposed.json()).slice(0, 300)).toBe(201);
  });

  it('terms schema stays closed: malformed targetZoneId / delivery are teaching 400s', async () => {
    const empty = await propose({ targetZoneId: '' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.message).toContain('terms.targetZoneId');
    const bogusDelivery = await propose({ targetZoneId: 'zone-a', delivery: 'magic' });
    expect(bogusDelivery.statusCode).toBe(400);
    expect(bogusDelivery.json().error.message).toContain('terms.delivery');
  });
});
