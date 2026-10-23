/**
 * @vitest-environment node
 *
 * T28 (R3 u3-F1): the catalog + agreement faces of DECLARATION drift.
 *
 * u3's sequence: withdraw an agent's declared capability → the flow side
 * annotates (R2 T1) but the catalog (`service get`/`list`) and the contract
 * face (`agreement` payloads) stayed silent while the derived service row
 * survived and stayed signable — three ledgers, no shared sentence. The
 * rows intentionally do NOT shrink (identity stability, the R2 ruling) and
 * stay consumable (the bound device still executes) — so the fix is the
 * honest ANNOTATION, never a refusal:
 *
 *   - catalog: `declaredByProvider: false` on capability-minted rows
 *     (derived / aggregate) whose provider's declared set no longer covers
 *     the semantic capability; the marker DISAPPEARS on re-declaration;
 *   - contract: propose / accept / agreement-get carry the same drift hint
 *     (declaredByProvider + declarationDrift{capability, note}) — the
 *     lifecycle state machine is untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

import { declaredOfferDriftForEnv } from './db/service-store.js';

interface ServiceJson {
  id: string;
  name: string;
  semanticType: string;
  origin: string;
  unbacked: boolean;
  consumable?: boolean;
  declaredByProvider?: false;
}

describe('T28 (R3 u3-F1): catalog + agreement declaration-drift annotation', () => {
  let ctx: TestAppContext;
  let owner: TestUser; // env owner + provider (owns lab-agent)
  let consumer: TestUser;
  let envId: string;
  let labAgentId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('catalog-drift-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    labAgentId = (created.json().agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Lab Agent')!.id;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function listServices(): Promise<ServiceJson[]> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().services as ServiceJson[];
  }

  function getService(serviceId: string) {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/services/${serviceId}`,
      headers: auth(owner.token),
    });
  }

  /** The derived HVAC row for a given semantic type (turn-on / temperature-control …). */
  async function derivedRow(semanticType: string): Promise<ServiceJson> {
    const row = (await listServices())
      .find(service => service.origin === 'derived' && service.semanticType === semanticType);
    expect(row, `derived row ${semanticType} should exist`).toBeTruthy();
    return row!;
  }

  it('a derived row whose declaration covers the semantic type carries NO marker', async () => {
    const row = await derivedRow('temperature-control'); // lab-agent declares it
    const got = await getService(row.id);
    expect(got.statusCode).toBe(200);
    expect(got.json().declaredByProvider).toBeUndefined();
    expect((await listServices()).find(s => s.id === row.id)?.declaredByProvider).toBeUndefined();
  });

  it('withdrawing the declaration flags get+list (row stays, consumable stays true); re-declaring clears it', async () => {
    const row = await derivedRow('temperature-control');

    // Withdraw 'temperature-control' from the agent's DECLARED set. The
    // derived row survives (derivation follows the DEVICE surface) and the
    // device still executes — only the declaration face drifted.
    ctx.app.envStore.updateAgent(labAgentId, { capabilities: ['temperature-monitoring'] });

    const got = await getService(row.id);
    expect(got.statusCode).toBe(200);
    expect(got.json().declaredByProvider).toBe(false);
    // Honest annotation, never a refusal: the offer stays consumable.
    expect(got.json().consumable).toBe(true);
    expect(got.json().unbacked).toBe(false);
    expect((await listServices()).find(s => s.id === row.id)?.declaredByProvider).toBe(false);

    // Capability restored → the marker disappears (bidirectional, like the
    // flow side's live probe).
    ctx.app.envStore.updateAgent(labAgentId, {
      capabilities: ['temperature-monitoring', 'temperature-control'],
    });
    expect((await getService(row.id)).json().declaredByProvider).toBeUndefined();
    expect((await listServices()).find(s => s.id === row.id)?.declaredByProvider).toBeUndefined();
  });

  it('propose + agreement get surface the same drift hint — annotate, never refuse', async () => {
    // 'turn-on' is device-derived but NEVER in the lab agent's declared set —
    // drifted from birth (the u3 shape, pre-withdrawal even).
    const row = await derivedRow('turn-on');
    const propose = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${row.id}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(propose.statusCode).toBe(201);
    expect(propose.json().declaredByProvider).toBe(false);
    expect(propose.json().declarationDrift.capability).toBe('turn-on');
    expect(propose.json().declarationDrift.note).toContain('does not declare');
    // BUG-08②: 'turn-on' was NEVER declared — the note must not assert a
    // withdrawal that never happened (timeless wording, the flow side's T36).
    expect(propose.json().declarationDrift.note).not.toContain('no longer');

    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${propose.json().id as string}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().declaredByProvider).toBe(false);

    const got = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${propose.json().id as string}`,
      headers: auth(consumer.token),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().declaredByProvider).toBe(false);
    expect(got.json().declarationDrift.note).toContain('still');

    // The agreement stays fully invocable-grade: drift is annotation only.
    expect(got.json().status).toBe('active');
  });

  it('a declaration-covered service proposes WITHOUT the drift hint (marker only on drift)', async () => {
    const row = await derivedRow('temperature-control');
    const propose = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${row.id}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(propose.statusCode).toBe(201);
    expect(propose.json().declaredByProvider).toBeUndefined();
    expect(propose.json().declarationDrift).toBeUndefined();
  });
});

// ============================================================================
// T53 (R6 u2-F-1-1): PUBLISHED rows join the declaration-drift judgment —
// the publish lane never cross-checked semantic type against the declaring
// agent, so the same withdrawal event used to flag the derived face while
// the published face (same provider, same capability family) stayed silent.
// FLOW rows stay exempt (backed by the flow, not the agent's declaration).
// ============================================================================

describe('T53 (R6 u2-F-1-1): published rows drift with the same event as derived rows', () => {
  let ctx: TestAppContext;
  let owner: TestUser; // env owner + provider (owns lab-agent)
  let envId: string;
  let labAgentId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('catalog-drift-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    labAgentId = (created.json().agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Lab Agent')!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function listServices(): Promise<Array<Record<string, any>>> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().services as Array<Record<string, any>>;
  }

  async function publishOffer(semanticType: string): Promise<Record<string, any>> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${labAgentId}/services`,
      headers: auth(owner.token),
      payload: {
        name: `Published ${semanticType}`,
        semanticType,
        description: 'u2 replay: an explicitly published offer of a declared capability',
        interface: {},
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as Record<string, any>;
  }

  it('withdraw → published + derived flag TOGETHER (get/list/agreement propose); re-declare → both clear', async () => {
    // u2's shape: the published offer's semantic type IS the declared
    // capability family → no marker from birth.
    const published = await publishOffer('temperature-control');
    expect(published.declaredByProvider).toBeUndefined();

    // Same withdrawal event for both faces.
    ctx.app.envStore.updateAgent(labAgentId, { capabilities: ['temperature-monitoring'] });

    // list: BOTH rows carry the marker — one event, one verdict per face.
    const listed = await listServices();
    expect(listed.find(s => s.id === published.id)?.declaredByProvider).toBe(false);
    const derived = listed.find(s => s.origin === 'derived' && s.semanticType === 'temperature-control');
    expect(derived?.declaredByProvider).toBe(false);

    // get: published row flagged, still consumable (annotation, never refusal).
    const got = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${published.id}`,
      headers: auth(owner.token),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().declaredByProvider).toBe(false);
    expect(got.json().consumable).toBe(true);

    // agreement face: propose on the PUBLISHED row carries the same hint.
    const propose = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${published.id}/agreements`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(propose.statusCode).toBe(201);
    expect(propose.json().declaredByProvider).toBe(false);
    expect(propose.json().declarationDrift.capability).toBe('temperature-control');

    // Re-declaration clears BOTH faces (bidirectional, u2's reversibility).
    ctx.app.envStore.updateAgent(labAgentId, {
      capabilities: ['temperature-monitoring', 'temperature-control'],
    });
    expect((await listServices()).find(s => s.id === published.id)?.declaredByProvider).toBeUndefined();
    expect((await listServices()).find(s => s.origin === 'derived' && s.semanticType === 'temperature-control')?.declaredByProvider)
      .toBeUndefined();
  });

  it('a published offer of a NEVER-declared type is drifted from birth (honest face, not noise)', async () => {
    // 'turn-on' is executable on the device but NOT in the lab agent's
    // declared set — the published row says so from the start.
    const published = await publishOffer('turn-on');
    expect(published.declaredByProvider).toBe(false);
    expect((await listServices()).find(s => s.id === published.id)?.declaredByProvider).toBe(false);
  });

  it('a FLOW row stays exempt from the capability judgment (backed by the flow)', () => {
    // Unit anchor: origin='flow' rows never drift here regardless of the
    // provider's declared set — the flow's T-201 backing is not a capability
    // declaration.
    const flowRow = ctx.app.serviceStore.createService({
      envId,
      providerAgentId: labAgentId,
      name: 'Flow-backed',
      semanticType: 'never-declared-anywhere',
      description: '',
      interface: {},
      origin: 'flow',
    });
    expect(flowRow.origin).toBe('flow');
    expect(declaredOfferDriftForEnv(ctx.app.envStore, [flowRow]).get(flowRow.id)).toBe(false);
  });
});

// ============================================================================
// BUG-08 ①: AGGREGATE rows judge against the runtime bridge's declaration
// surface (stored ∪ rule types from the capability union), not the stored
// declaration alone — a rule-backed aggregate no longer drifts from birth,
// while a genuinely lapsed rule still reads drifted.
// ============================================================================

describe('BUG-08①: aggregate rows align with the bridge declaration surface', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;
  let agentId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });

    const scenario = {
      ...importableScenario('aggregate-drift-lab'),
      devices: [
        {
          id: 'hvac-b',
          name: 'HVAC B',
          type: 'hvac',
          capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
          zoneId: 'zone-b',
        },
        {
          id: 'meter-a',
          name: 'Power Meter A',
          type: 'power-meter',
          capabilities: ['energy-monitoring', 'power-monitoring'],
          zoneId: 'zone-a',
        },
      ],
      agents: [
        {
          id: 'energy-agent',
          name: 'Energy Agent',
          capabilities: ['energy-monitoring', 'temperature-control'],
          managesZoneIds: ['zone-a', 'zone-b'],
          boundDeviceIds: ['hvac-b', 'meter-a'],
        },
      ],
      semanticOfferRules: [
        {
          semanticType: 'peak-shaving',
          label: '削峰调度',
          description: '能耗监视联动温控执行削峰。',
          requires: ['energy-monitoring', 'temperature-control'],
          actuates: ['temperature-control'],
        },
      ],
    };
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...scenario, visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    agentId = (created.json().agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Energy Agent')!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function aggregateRow(): Promise<ServiceJson> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);
    const row = (res.json().services as ServiceJson[])
      .find(service => service.origin === 'aggregate' && service.semanticType === 'peak-shaving');
    expect(row, 'aggregate row peak-shaving should exist').toBeTruthy();
    return row!;
  }

  it('a rule-backed aggregate row is NOT drifted (declaredByProvider stays true/absent)', async () => {
    // The rule resolves from the capability union (declared energy-monitoring
    // + temperature-control, device-backed actuation) — the bridge face
    // treats the agent as declaring 'peak-shaving', so the catalog face must
    // agree (was: drifted from birth, unwashable).
    const row = await aggregateRow();
    expect(row.declaredByProvider).toBeUndefined();

    const got = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${row.id}`,
      headers: auth(owner.token),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().declaredByProvider).toBeUndefined();
  });

  it('a genuinely LAPSED rule still reads drifted (no blanket aggregate exemption)', async () => {
    const row = await aggregateRow();

    // Unbind the HVAC and drop the declaration — the union loses
    // 'temperature-control', so the rule no longer resolves. The direct
    // store patch bypasses the aggregate sync on purpose: the lingering row
    // must read drifted, not silently wash clean.
    ctx.app.envStore.updateAgent(agentId, {
      capabilities: ['energy-monitoring'],
      boundDeviceIds: ['meter-a'],
    });

    const got = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${row.id}`,
      headers: auth(owner.token),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().declaredByProvider).toBe(false);
    // Timeless wording (BUG-08②): no "no longer" anywhere on the drift face.
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    expect((res.json().services as ServiceJson[])
      .find(service => service.id === row.id)?.declaredByProvider).toBe(false);
  });
});
