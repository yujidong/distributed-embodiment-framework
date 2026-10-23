/**
 * @vitest-environment node
 *
 * T-071 (DevLoop R22, FM-F06 / async UX) — the arrival briefing digest.
 *
 * The arriving stakeholder used to reconstruct the day from activity-feed
 * archaeology. GET /api/environments/:id/digest groups the SAME read-model
 * into a per-day briefing: proposals decided / agreements changed / devices
 * installed & operated / world & governance. Read-model only: the FIRST
 * read of a UTC day freezes ONE digest per viewer; a second arrival the
 * same day gets the SAME briefing (no divergent recounts); ?since= computes
 * a fresh windowed digest on demand.
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

interface DigestView {
  date: string;
  since: string;
  until: string;
  generatedAt: string;
  frozen: boolean;
  title: string;
  categories: Record<
    'proposals' | 'agreements' | 'devices' | 'world',
    { label: string; count: number; entries: Array<{ summary: string }> }
  >;
  completedCollaborations: Array<{ agreementId: string; outcome: string; terminatedAt: string }>;
  total: number;
}

describe('arrival briefing digest (T-071)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let member: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    member = await registerUser(ctx.app, { displayName: 'Member' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('digest-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(member.token),
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function getDigest(token: string, query = ''): Promise<{ status: number; body: DigestView }> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/digest${query}`,
      headers: auth(token),
    });
    return { status: res.statusCode, body: res.json() as DigestView };
  }

  /** Drive one event per digest category. */
  async function driveTheDay(): Promise<void> {
    // devices: owner direct-creates a device (env-direct-edit command row).
    const device = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Lobby Light',
        type: 'smart-light',
        capabilities: ['turn-on'],
        zoneId: 'zone-a',
      },
    });
    expect(device.statusCode).toBe(201);

    // proposals: a zone-claim submitted by the member (escalates → decided
    // rows exist even before the owner rules).
    const proposal = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(member.token),
      payload: { kind: 'zone-claim', payload: { zoneId: 'zone-b' } },
    });
    expect(proposal.statusCode).toBe(201);
    const proposalId = proposal.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.statusCode).toBe(200);

    // agreements: propose + accept on a derived service.
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const service = (services.json().services as Array<{ id: string; name: string }>)
      .find(row => row.name.includes('HVAC'));
    const agreement = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${service!.id}/agreements`,
      headers: auth(member.token),
      payload: { terms: { notes: 'digest fixture' } },
    });
    expect(agreement.statusCode).toBe(201);
    const agreementId = agreement.json().id as string;
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(accepted.statusCode).toBe(200);
  }

  it('covers the categories: proposals, agreements, devices, world', async () => {
    await driveTheDay();
    const first = await getDigest(owner.token);
    expect(first.status).toBe(200);
    expect(first.body.categories.proposals.count).toBeGreaterThanOrEqual(1);
    expect(first.body.categories.agreements.count).toBeGreaterThanOrEqual(1);
    expect(first.body.categories.devices.count).toBeGreaterThanOrEqual(1);
    expect(first.body.categories.world.count).toBeGreaterThanOrEqual(1);
    expect(first.body.total).toBe(
      first.body.categories.proposals.count +
      first.body.categories.agreements.count +
      first.body.categories.devices.count +
      first.body.categories.world.count,
    );
    // The title is localized (zh default of the test harness request).
    expect(first.body.title.length).toBeGreaterThan(0);
    // First read computed it fresh.
    expect(first.body.frozen).toBe(false);
  });

  it('two arrivals the same day get ONE digest (first read freezes the window)', async () => {
    await driveTheDay();
    const first = await getDigest(owner.token);
    expect(first.status).toBe(200);

    // MORE world events land between the two arrivals…
    const late = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Late Sensor',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-b',
      },
    });
    expect(late.statusCode).toBe(201);

    const second = await getDigest(owner.token);
    expect(second.status).toBe(200);
    // Same briefing: frozen, same generation stamp, same content.
    expect(second.body.frozen).toBe(true);
    expect(second.body.generatedAt).toBe(first.body.generatedAt);
    expect(second.body.total).toBe(first.body.total);
    expect(second.body.categories.devices.count).toBe(first.body.categories.devices.count);

    // A DIFFERENT member gets their own memo (per-viewer key), and it sees
    // the late event (their first read is later than the owner's).
    const other = await getDigest(member.token);
    expect(other.status).toBe(200);
    expect(other.body.frozen).toBe(false);
    expect(other.body.categories.devices.count).toBeGreaterThan(first.body.categories.devices.count);
  });

  it('?since= computes a fresh windowed digest that bypasses the day memo', async () => {
    await driveTheDay();
    const first = await getDigest(owner.token);
    // Window from just after the first digest's freeze → only the late event.
    const late = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Windowed Sensor',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
    });
    expect(late.statusCode).toBe(201);

    const since = encodeURIComponent(first.body.until);
    const windowed = await getDigest(owner.token, `?since=${since}`);
    expect(windowed.status).toBe(200);
    expect(windowed.body.frozen).toBe(false);
    expect(windowed.body.since).toBe(decodeURIComponent(since));
    // The windowed digest contains ONLY the post-freeze event — the late
    // device is in it even though the day memo (frozen earlier) is not.
    expect(windowed.body.categories.devices.count).toBe(1);
    expect(windowed.body.categories.devices.entries[0]!.summary).toContain('Windowed Sensor');
  });

  it('unknown query parameters are rejected with teaching (T-063 discipline)', async () => {
    const res = await getDigest(owner.token, '?offset=10');
    expect(res.status).toBe(400);
  });

  it('private envs keep the digest member-gated (same read gate as the feed)', async () => {
    const stranger = await registerUser(ctx.app, { displayName: 'Stranger' });
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: { visibility: 'private' },
    });
    expect(patched.statusCode).toBe(200);
    const denied = await getDigest(stranger.token);
    expect(denied.status).toBe(403);
    const allowed = await getDigest(member.token);
    expect(allowed.status).toBe(200);
  });

  it('R5-F07: a newly terminated agreement expires the frozen day memo', async () => {
    // One completed collaboration lands, then the owner reads (and freezes)
    // today's briefing.
    const collaborate = async (notes: string): Promise<void> => {
      const services = await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/services`,
        headers: auth(owner.token),
      });
      const service = (services.json().services as Array<{ id: string; name: string }>)
        .find(row => row.name.includes('HVAC'));
      const proposed = await ctx.app.inject({
        method: 'POST',
        url: `/api/services/${service!.id}/agreements`,
        headers: auth(member.token),
        payload: { terms: { notes } },
      });
      expect(proposed.statusCode).toBe(201);
      const agreementId = proposed.json().id as string;
      const accepted = await ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${agreementId}/decide`,
        headers: auth(owner.token),
        payload: { decision: 'accept' },
      });
      expect(accepted.statusCode).toBe(200);
      const terminated = await ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${agreementId}/terminate`,
        headers: auth(member.token),
      });
      expect(terminated.statusCode).toBe(200);
    };

    await collaborate('first collab');
    const first = await getDigest(owner.token);
    expect(first.status).toBe(200);
    expect(first.body.frozen).toBe(false);
    expect(first.body.completedCollaborations).toHaveLength(1);

    // A second collaboration completes AFTER the freeze — the memo key's
    // termination signal moved, so the same reader gets a fresh digest that
    // includes BOTH terminated agreements (not yesterday's frozen view).
    await collaborate('second collab');
    const second = await getDigest(owner.token);
    expect(second.status).toBe(200);
    expect(second.body.frozen).toBe(false);
    expect(second.body.completedCollaborations).toHaveLength(2);

    // …and with no further terminations the memo freezes again.
    const third = await getDigest(owner.token);
    expect(third.body.frozen).toBe(true);
    expect(third.body.generatedAt).toBe(second.body.generatedAt);
  });
});
