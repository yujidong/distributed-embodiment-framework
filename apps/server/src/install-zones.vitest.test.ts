/**
 * @vitest-environment node
 *
 * T-055 (DevLoop R13) — governed zone creation for builders.
 *
 * The R12 amplifier: builders could NEVER create zones (PATCH mapData is
 * owner-only, no proposal kind created zones, zone-claim only claims
 * EXISTING zones) — dead-locking shared-world building. install-zones:
 * author proposes, pipeline approves (AI review on low risk), apply merges
 * zones into mapData, revert removes only STILL-EMPTY zones.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestApp, registerUser, auth, type TestAppContext, type TestUser } from './test-utils.js';

describe('install-zones proposal kind (T-055)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let stranger: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Zone Governance Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'lobby', name: 'Lobby', bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  const submitZones = (token: string, zones: unknown[]) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(token),
      payload: { kind: 'install-zones', payload: { zones } },
    });

  const decide = (token: string, proposalId: string, decision: 'approved' | 'rejected') =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/decide`,
      headers: auth(token),
      payload: { decision },
    });

  const revert = (token: string, proposalId: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/revert`,
      headers: auth(token),
    });

  const zoneIds = async (): Promise<string[]> => {
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    return (detail.json().zones as Array<{ id: string }>).map(zone => zone.id);
  };

  it('full lifecycle: builder proposes → owner approves → zone exists → revert removes it', async () => {
    const submitted = await submitZones(builder.token, [
      { id: 'ward-101', name: 'Ward 101', type: 'ward', bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 }, adjacentZoneIds: ['lobby'] },
    ]);
    expect(submitted.statusCode).toBe(201);
    const proposal = submitted.json();
    // No LLM in tests → the fallback reviewer escalates to the owner.
    expect(proposal.status).toBe('escalated');
    expect(proposal.ruleCheck.ok).toBe(true);
    expect(proposal.riskLevel).toBe('low');

    const approved = await decide(owner.token, proposal.id, 'approved');
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('applied');
    // createdIds carries the zone ids (Fix-10 surface extended by T-055).
    expect(approved.json().createdIds).toEqual({ zones: ['ward-101'] });

    expect(await zoneIds()).toEqual(expect.arrayContaining(['lobby', 'ward-101']));
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const ward = (detail.json().zones as Array<Record<string, unknown>>).find(z => z.id === 'ward-101')!;
    expect(ward.name).toBe('Ward 101');
    expect(ward.bounds).toEqual({ minX: 0, maxX: 8, minY: 0, maxY: 6 });
    expect(ward.adjacentZoneIds).toEqual(['lobby']);

    // Revert on an EMPTY zone removes it.
    const reverted = await revert(owner.token, proposal.id);
    expect(reverted.statusCode).toBe(200);
    expect(reverted.json().status).toBe('reverted');
    expect(await zoneIds()).toEqual(['lobby']);
  });

  it('POST /api/environments/:id/zones auto-converts a builder call into the proposal', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/zones`,
      headers: auth(builder.token),
      payload: { id: 'garden', name: 'Garden', bounds: { minX: 10, maxX: 20, minY: 0, maxY: 10 } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe('install-zones');
    expect(res.json().status).toBe('escalated');
    // The zone does NOT exist yet — the proposal is the only effect.
    expect(await zoneIds()).toEqual(['lobby']);
  });

  it('the owner direct path creates the zone immediately (route unaffected by governance)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/zones`,
      headers: auth(owner.token),
      payload: { id: 'server-room', name: 'Server Room', bounds: { minX: 0, maxX: 4, minY: 0, maxY: 4 } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe('server-room');
    expect(await zoneIds()).toEqual(expect.arrayContaining(['lobby', 'server-room']));

    // Owner duplicate via the same route is a teaching 400 (same validator).
    const dup = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/zones`,
      headers: auth(owner.token),
      payload: { id: 'server-room' },
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.message).toContain('already exists');
  });

  it('bounds validation: degenerate and incomplete bounds are rule issues (rejection teaches)', async () => {
    const degenerate = await submitZones(builder.token, [
      { id: 'bad-1', bounds: { minX: 10, maxX: 2, minY: 0, maxY: 5 } },
    ]);
    expect(degenerate.statusCode).toBe(201);
    expect(degenerate.json().status).toBe('rejected');
    expect(degenerate.json().ruleCheck.issues.join(' ')).toContain('degenerate');

    const incomplete = await submitZones(builder.token, [
      { id: 'bad-2', bounds: { minX: 0, maxX: 5 } },
    ]);
    expect(incomplete.json().status).toBe('rejected');
    expect(incomplete.json().ruleCheck.issues.join(' ')).toContain('incomplete');
  });

  it('adjacency must reference known zones; duplicate/known ids are rejected', async () => {
    const unknownAdjacency = await submitZones(builder.token, [
      { id: 'annex', adjacentZoneIds: ['nowhere'] },
    ]);
    expect(unknownAdjacency.json().status).toBe('rejected');
    expect(unknownAdjacency.json().ruleCheck.issues.join(' ')).toContain('unknown zone "nowhere"');

    const duplicate = await submitZones(builder.token, [{ id: 'lobby' }]);
    expect(duplicate.json().status).toBe('rejected');
    expect(duplicate.json().ruleCheck.issues.join(' ')).toContain('"lobby" already exists');

    // Cross-proposal adjacency (zones proposed in the SAME payload) is legal.
    const coProposed = await submitZones(builder.token, [
      { id: 'wing-a' },
      { id: 'wing-b', adjacentZoneIds: ['wing-a'] },
    ]);
    expect(coProposed.json().status).toBe('escalated');
    expect(coProposed.json().ruleCheck.ok).toBe(true);
  });

  it('foreign-env callers are refused (403), not converted into proposals', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/zones`,
      headers: auth(stranger.token),
      payload: { id: 'sneaky' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('revert is REFUSED with a teaching message when a created zone became occupied', async () => {
    const submitted = await submitZones(builder.token, [{ id: 'lab', name: 'Lab' }]);
    const proposal = submitted.json();
    await decide(owner.token, proposal.id, 'approved');
    expect(await zoneIds()).toEqual(expect.arrayContaining(['lab']));

    // Occupy the zone: owner drops a device into it.
    const device = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Lab Sensor', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: 'lab' },
    });
    expect(device.statusCode).toBe(201);

    const refused = await revert(owner.token, proposal.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('PROPOSAL_NOT_REVERTIBLE');
    const message = refused.json().error.message as string;
    expect(message).toContain('"lab"');
    expect(message).toContain('no longer empty');
    // The zone survived.
    expect(await zoneIds()).toEqual(expect.arrayContaining(['lab']));
  });

  it('quota: exceeding QUOTA_MAX_ZONES_PER_ENV is a rule rejection naming the budget', async () => {
    // Fill the env to the cap via the owner direct path (default cap 100).
    const fill: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 99; i++) fill.push({ id: `fill-${i}` });
    const bulk = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: {
        mapData: {
          zones: [
            { id: 'lobby', name: 'Lobby', bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } },
            ...fill,
          ],
        },
      },
    });
    expect(bulk.statusCode).toBe(200);

    const over = await submitZones(builder.token, [{ id: 'one-too-many' }]);
    expect(over.json().status).toBe('rejected');
    expect(over.json().ruleCheck.issues.join(' ')).toContain('quota exceeded');
  });

  it('a batch of >= 20 zones is high-risk and force-escalated', async () => {
    const zones: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 20; i++) zones.push({ id: `mass-${i}` });
    const submitted = await submitZones(builder.token, zones);
    expect(submitted.json().riskLevel).toBe('high');
    expect(submitted.json().status).toBe('escalated');
  });
});
