/**
 * @vitest-environment node
 *
 * Fix-19 latecomer onboarding tests (roadmap Fix-19):
 *
 * - the environment `guide` (owner-written structured world intro): owner
 *   sets/clears it via PATCH, it surfaces on the detail view to every
 *   reader (anonymous on public envs included), non-owners cannot write
 *   it, malformed shapes are rejected;
 * - the activity feed (`GET /api/environments/:id/activity`): aggregates
 *   command_log + proposal lifecycle + agreement lifecycle into one
 *   newest-first readable timeline, with limit + read access rules;
 * - `viewerNotice`: the one-line role-boundary notice present only in the
 *   viewer's perspective of the detail view.
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

const GUIDE = {
  purpose: '教学楼能耗优化试验场',
  zoneGuide: 'zone-a 是走廊，zone-b 是机房',
  roleGuide: {
    builder: '可提交设备安装提案',
    viewer: '只读浏览，可 fork 沙箱',
  },
  serviceMap: 'HVAC B: 开启 由 Owner 提供',
};

interface ActivityEntry {
  time: string;
  actor: { id: string; displayName: string } | null;
  kind: 'command' | 'proposal' | 'agreement';
  action: string;
  summary: string;
  objectType: string;
  objectId: string;
}

describe('Fix-19 environment onboarding (guide / activity / viewerNotice)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    viewer = await registerUser(ctx.app, { displayName: 'Viewer' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('onboarding-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;

    // Builder joins the public env directly; the viewer is invited as viewer.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });
    const invited = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/members`,
      headers: auth(owner.token),
      payload: { email: viewer.email, role: 'viewer' },
    });
    expect(invited.statusCode).toBe(201);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function getDetail(token?: string) {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
    });
  }

  function patchGuide(token: string, guide: unknown) {
    return ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(token),
      payload: { guide },
    });
  }

  function getActivity(token?: string, query = '') {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/activity${query}`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // guide
  // -------------------------------------------------------------------------

  it('a fresh environment carries no guide (null on the detail view)', async () => {
    const res = await getDetail(owner.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().guide).toBeNull();
  });

  it('the owner sets the guide and every reader sees it (anonymous included)', async () => {
    const patched = await patchGuide(owner.token, GUIDE);
    expect(patched.statusCode).toBe(200);
    expect(patched.json().guide).toEqual(GUIDE);

    for (const token of [owner.token, builder.token, viewer.token, undefined]) {
      const res = await getDetail(token);
      expect(res.statusCode).toBe(200);
      expect(res.json().guide).toEqual(GUIDE);
    }
  });

  it('non-owners cannot write the guide (builder / viewer / stranger → 403)', async () => {
    for (const token of [builder.token, viewer.token, stranger.token]) {
      const res = await patchGuide(token, GUIDE);
      expect(res.statusCode).toBe(403);
    }
    const anon = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      payload: { guide: GUIDE },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('malformed guide shapes are rejected (400)', async () => {
    expect((await patchGuide(owner.token, 'text')).statusCode).toBe(400);
    expect((await patchGuide(owner.token, { purpose: 42 })).statusCode).toBe(400);
    expect((await patchGuide(owner.token, { roleGuide: 'builder' })).statusCode).toBe(400);
    expect((await patchGuide(owner.token, { roleGuide: { viewer: 1 } })).statusCode).toBe(400);
  });

  it('guide: null clears the guide', async () => {
    expect((await patchGuide(owner.token, GUIDE)).statusCode).toBe(200);
    const cleared = await patchGuide(owner.token, null);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().guide).toBeNull();
  });

  // -------------------------------------------------------------------------
  // viewerNotice
  // -------------------------------------------------------------------------

  it('viewerNotice appears only in the viewer perspective', async () => {
    const viewerRes = await getDetail(viewer.token);
    expect(viewerRes.json().myRole).toBe('viewer');
    expect(typeof viewerRes.json().viewerNotice).toBe('string');
    expect(viewerRes.json().viewerNotice).toContain('viewer');

    for (const token of [owner.token, builder.token, undefined]) {
      const res = await getDetail(token);
      expect(res.statusCode).toBe(200);
      expect(res.json().viewerNotice).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // activity feed
  // -------------------------------------------------------------------------

  /** Small delay so sequential actions land on distinct ISO timestamps. */
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));

  it('aggregates command_log + proposals + agreements, newest first', async () => {
    // 1. command_log: owner direct edit.
    const edit = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: { description: 'renamed world' },
    });
    expect(edit.statusCode).toBe(200);
    await tick();

    // 2. proposal lifecycle: builder submits an install-devices proposal.
    const proposal = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
      payload: {
        kind: 'install-devices',
        payload: {
          devices: [
            {
              name: 'Corridor Sensor',
              type: 'temperature-sensor',
              capabilities: ['temperature-reading'],
              zoneId: 'zone-a',
            },
          ],
        },
      },
    });
    expect(proposal.statusCode).toBe(201);
    await tick();

    // 3. agreement lifecycle: builder signs the owner's derived service.
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const service = (services.json().services as Array<{ id: string }>)[0];
    const agreement = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${service.id}/agreements`,
      headers: auth(builder.token),
      payload: {},
    });
    expect(agreement.statusCode).toBe(201);

    const res = await getActivity(builder.token);
    expect(res.statusCode).toBe(200);
    const entries = res.json().entries as ActivityEntry[];
    const kinds = new Set(entries.map(entry => entry.kind));
    expect(kinds.has('command')).toBe(true);
    expect(kinds.has('proposal')).toBe(true);
    expect(kinds.has('agreement')).toBe(true);

    // Every entry carries the readable shape: time / actor / action /
    // summary / object.
    for (const entry of entries) {
      expect(typeof entry.time).toBe('string');
      expect(typeof entry.action).toBe('string');
      expect(typeof entry.summary).toBe('string');
      expect(typeof entry.objectType).toBe('string');
      expect(typeof entry.objectId).toBe('string');
    }
    // Actors resolve to display names.
    const commandEntry = entries.find(entry => entry.kind === 'command')!;
    expect(commandEntry.actor?.displayName).toBe('Owner');
    const proposalEntry = entries.find(
      entry => entry.kind === 'proposal' && entry.action === 'submitted',
    )!;
    expect(proposalEntry.actor?.displayName).toBe('Builder');

    // Newest first (non-increasing timestamps).
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i - 1].time >= entries[i].time).toBe(true);
    }
    // The agreement (signed last) heads the feed.
    expect(entries[0].kind).toBe('agreement');
  });

  it('honors ?limit= and rejects a bad limit', async () => {
    await patchGuide(owner.token, GUIDE); // one command_log entry
    const limited = await getActivity(owner.token, '?limit=1');
    expect(limited.statusCode).toBe(200);
    expect((limited.json().entries as ActivityEntry[]).length).toBe(1);
    expect((await getActivity(owner.token, '?limit=0')).statusCode).toBe(400);
  });

  it('summaries name their objects (Wave-1a, 小林 R8 F-16): device + service names, not bare ids', async () => {
    // Owner renames a device → a command entry scoped to that device.
    // (Imported scenario devices land with fresh ids — resolve by name.)
    const detail = await getDetail(owner.token);
    const hvac = (detail.json().devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'HVAC B')!;
    const renamed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${hvac.id}`,
      headers: auth(owner.token),
      payload: { name: '客厅空调' },
    });
    expect(renamed.statusCode).toBe(200);

    // Builder signs a derived service → an agreement entry. (The rename
    // above may have re-synced the derived service name — resolve it live.)
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const service = (services.json().services as Array<{ id: string; name: string }>)
      .find(s => s.name.endsWith('开启'))!;
    const agreement = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${service.id}/agreements`,
      headers: auth(builder.token),
      payload: {},
    });
    expect(agreement.statusCode).toBe(201);

    const entries = (await getActivity(owner.token)).json().entries as ActivityEntry[];
    const deviceEntry = entries.find(
      entry => entry.kind === 'command' && entry.objectType === 'device' && entry.objectId === hvac.id,
    )!;
    expect(deviceEntry.summary).toContain('客厅空调');
    expect(deviceEntry.summary).toContain(hvac.id);
    const agreementEntry = entries.find(entry => entry.kind === 'agreement')!;
    expect(agreementEntry.summary).toContain(service.name);
    expect(agreementEntry.summary).toContain(service.id);
  });

  it('?before= pages the feed backwards (strictly older entries); invalid cursor → 400', async () => {
    await patchGuide(owner.token, { purpose: 'first' });
    await tick();
    await patchGuide(owner.token, { purpose: 'second' });
    await tick();
    await patchGuide(owner.token, { purpose: 'third' });

    const all = (await getActivity(owner.token)).json().entries as ActivityEntry[];
    expect(all.length).toBeGreaterThanOrEqual(3);

    // Cursor = the newest entry's time → the page holds only older entries.
    const page = (await getActivity(owner.token, `?before=${encodeURIComponent(all[0].time)}`))
      .json().entries as ActivityEntry[];
    expect(page.length).toBeLessThan(all.length);
    for (const entry of page) {
      expect(entry.time < all[0].time).toBe(true);
    }
    // Paging again from the page's tail reaches the beginning.
    const rest = (await getActivity(owner.token, `?before=${encodeURIComponent(page[page.length - 1].time)}`))
      .json().entries as ActivityEntry[];
    expect(rest.length).toBeLessThan(page.length);

    expect((await getActivity(owner.token, '?before=not-a-date')).statusCode).toBe(400);
  });

  it('read access matches the detail view: anonymous reads public envs, private envs are member-only', async () => {
    // Public env: anonymous may read.
    expect((await getActivity()).statusCode).toBe(200);
    // Stranger (authenticated non-member) may read a public env too.
    expect((await getActivity(stranger.token)).statusCode).toBe(200);

    // Private env: members only.
    const privateEnv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Private World', visibility: 'private' },
    });
    expect(privateEnv.statusCode).toBe(201);
    const privateId = privateEnv.json().id as string;
    const anon = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${privateId}/activity`,
    });
    expect(anon.statusCode).toBe(403);
    const outsider = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${privateId}/activity`,
      headers: auth(stranger.token),
    });
    expect(outsider.statusCode).toBe(403);
    const member = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${privateId}/activity`,
      headers: auth(owner.token),
    });
    expect(member.statusCode).toBe(200);
  });

  it('T-308→T-060: agreement entries are bilateral (removed for non-parties, FR-F12)', async () => {
    // A hidden published service on the owner's lab agent.
    const detail = await getDetail(owner.token);
    const labAgentId = (detail.json().agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Lab Agent')!.id;
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${labAgentId}/services`,
      headers: auth(owner.token),
      payload: {
        name: '跌倒检测手表（101-2床）',
        semanticType: 'fall-detection',
        visibility: 'hidden',
      },
    });
    expect(published.statusCode).toBe(201);
    const hiddenId = published.json().id as string;

    // Builder (consumer) holds an agreement on it — the hidden visibility
    // makes the propose ENDPOINT 404 for non-providers, so the row lands
    // directly (the real-world FR-F12 case: the agreement predates the
    // service going hidden). The consumer can still terminate it (agreement
    // visibility is party-based, not service-based).
    const agreementId = ctx.app.agreementStore.createAgreement({
      envId,
      serviceId: hiddenId,
      consumerAgentId: null,
      consumerOwnerId: builder.id,
      providerAgentId: labAgentId,
      providerOwnerId: owner.id,
      terms: {},
    }).id;
    await tick(); // distinct created_at/updated_at so the transition entries appear
    const terminated = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/terminate`,
      headers: auth(builder.token),
    });
    expect(terminated.statusCode).toBe(200);

    // T-060 (design-consent-semantics.md §6.2): the VIEWER (member, not a
    // party, not the env owner) sees NO agreement entries AT ALL — the
    // bilateral lifecycle is removed, not redacted (REST says the agreement
    // does not exist for them; the feed must not rebuild it):
    const viewerFeed = (await getActivity(viewer.token)).json().entries as ActivityEntry[];
    expect(viewerFeed.filter(entry => entry.kind === 'agreement')).toHaveLength(0);
    // Nothing in the bystander's whole feed reconstructs the hidden offer
    // (neither its id nor its name rides any entry).
    expect(viewerFeed.every(entry => !entry.summary.includes('跌倒检测手表'))).toBe(true);
    expect(viewerFeed.every(entry => !entry.summary.includes(hiddenId))).toBe(true);

    // Anonymous (public env) sees no agreement entries either.
    const anonFeed = (await getActivity()).json().entries as ActivityEntry[];
    expect(anonFeed.filter(entry => entry.kind === 'agreement')).toHaveLength(0);

    // The env owner (= provider here) and the agreement consumer (party) see
    // the full bilateral audit — entries present with full labels.
    const ownerFeed = (await getActivity(owner.token)).json().entries as ActivityEntry[];
    const ownerEntry = ownerFeed.find(
      entry => entry.kind === 'agreement' && entry.action === 'terminated',
    )!;
    expect(ownerEntry.summary).toContain('跌倒检测手表');
    expect(ownerEntry.summary).toContain(hiddenId);
    const builderFeed = (await getActivity(builder.token)).json().entries as ActivityEntry[];
    const builderEntry = builderFeed.find(
      entry => entry.kind === 'agreement' && entry.action === 'terminated',
    )!;
    expect(builderEntry.summary).toContain('跌倒检测手表');

    // T-060 covers VISIBLE services too: a derived-service agreement is a
    // bilateral transaction like any other — the third-party viewer does not
    // see its entries either (FR-F12's original sample was exactly this).
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const derived = (services.json().services as Array<{ id: string; name: string }>)
      .find(s => s.name.endsWith('开启'))!;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${derived.id}/agreements`,
      headers: auth(builder.token),
      payload: {},
    });
    const afterVisible = (await getActivity(viewer.token)).json().entries as ActivityEntry[];
    expect(
      afterVisible.filter(entry => entry.kind === 'agreement' && entry.summary.includes(derived.name)),
    ).toHaveLength(0);
    // The party still sees it.
    const builderVisible = (await getActivity(builder.token)).json().entries as ActivityEntry[];
    const partyEntry = builderVisible.find(
      entry => entry.kind === 'agreement' && entry.action === 'proposed' &&
        entry.summary.includes(derived.name),
    )!;
    expect(partyEntry.summary).toContain(derived.id);
  });

  // -------------------------------------------------------------------------
  // T33 (R3 u1-F11/u2-F-09/u3-F3/u4-F10): object names, engine actor,
  // injection audit rows, kind/actor filters.
  // -------------------------------------------------------------------------

  it('T33: engine-device-command rows name their device + command and the actor reads as an engine, not "-"', async () => {
    ctx.app.commandLogStore.append({
      envId,
      actorId: 'engine:sim:sim-mu47nrde-2',
      kind: 'engine-device-command',
      payload: {
        deviceId: 'dev-x',
        deviceName: '空调机组',
        commandName: 'turn-off',
        simId: 'sim-mu47nrde-2',
      },
      simTime: 42,
    });
    const entries = (await getActivity(owner.token)).json().entries as ActivityEntry[];
    const engineRow = entries.find(
      entry => entry.kind === 'command' && entry.summary.startsWith('engine-device-command'),
    );
    expect(engineRow).toBeTruthy();
    expect(engineRow!.summary).toContain('空调机组');
    expect(engineRow!.summary).toContain('turn-off');
    expect(engineRow!.actor?.id).toBe('engine:sim:sim-mu47nrde-2');
    expect(engineRow!.actor?.displayName).toBe('引擎(sim …mu47nrde-2)');
  });

  it('T33: an injected event lands an event row with the injector + parameters; ?kind/?actor filters cut the noise', async () => {
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(started.statusCode).toBe(200);

    // The builder pulls the fire alarm (temperature spike): the feed must
    // answer "who injected this" (u3's audit question).
    const injected = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: auth(builder.token),
      payload: { type: 'temperature', zoneId: 'zone-b', parameter: 'temperature', value: 38, severity: 'high' },
    });
    expect(injected.statusCode).toBeLessThan(300);

    const eventOnly = (await getActivity(owner.token, '?kind=event')).json().entries as ActivityEntry[];
    expect(eventOnly.length).toBeGreaterThan(0);
    expect(eventOnly.every(entry => entry.kind === 'event')).toBe(true);
    const fireRow = eventOnly.find(entry => entry.summary.includes('temperature @ zone-b'));
    expect(fireRow).toBeTruthy();
    expect(fireRow!.summary).toContain('temperature=38');
    expect(fireRow!.summary).toContain('high');
    expect(fireRow!.actor?.displayName).toBe('Builder');

    // Actor substring filter (display name, case-insensitive).
    const byActor = (await getActivity(owner.token, '?kind=event&actor=build')).json().entries as ActivityEntry[];
    expect(byActor.length).toBe(eventOnly.length);
    expect(byActor.every(entry => entry.actor?.displayName === 'Builder')).toBe(true);
    const noMatch = (await getActivity(owner.token, '?actor=nobody-here')).json().entries as ActivityEntry[];
    expect(noMatch).toEqual([]);

    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/stop`,
      headers: auth(owner.token),
      payload: {},
    });
  });
});
