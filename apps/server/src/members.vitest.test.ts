/**
 * @vitest-environment node
 *
 * Member management API tests (Fix-4, RC-4 / P0-1 / P1-6).
 *
 * - CRUD matrix: owner invites by email/userId (immediate-effect membership,
 *   no accept step — the env appears in the invitee's list), changes roles,
 *   removes members; members remove themselves; everyone else is 403/404.
 * - REDACTION: the member list is serialized by perspective (memberToJson) —
 *   owner/builder see userId + email, viewers and non-members/anonymous see
 *   displayName + role only (Fix-13, R5 F-04), on BOTH the REST detail and
 *   the GET /members paths.
 * - VIEWER read-only end to end: reads pass, every write (device create,
 *   proposal submit, observations push, env patch, sim device command) is
 *   403; sandbox fork stays allowed (isolated read-only experimentation).
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

describe('member management (Fix-4)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  /** Private env (owner only until invited). */
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
      payload: {
        name: 'Private Lab',
        visibility: 'private',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function invite(token: string | undefined, id: string, payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${id}/members`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
      payload,
    });
  }

  // -------------------------------------------------------------------------
  // Invite (POST /members)
  // -------------------------------------------------------------------------

  it('owner invites by email — membership is immediate, invitee sees the private env', async () => {
    const res = await invite(owner.token, envId, { email: builder.email, role: 'builder' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      userId: builder.id,
      role: 'builder',
      displayName: 'Builder',
      email: builder.email,
    });

    // No accept step: the env simply appears in the invitee's list…
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments',
      headers: auth(builder.token),
    });
    const mine = (list.json().environments as Array<{ id: string; myRole: string | null }>)
      .find(env => env.id === envId);
    expect(mine?.myRole).toBe('builder');

    // …and its (private) detail becomes readable.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(builder.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().myRole).toBe('builder');
  });

  it('the added user is notified (member.added) on BOTH the invite and batch paths', async () => {
    // Single invite path (POST /members).
    await invite(owner.token, envId, { userId: builder.id, role: 'builder' });
    // Batch path (POST /members:batch): builder is now an already_member row
    // (must NOT notify again), viewer is added, the ghost email is not_found.
    const batch = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/members:batch`,
      headers: auth(owner.token),
      payload: { emails: [builder.email, viewer.email, 'ghost@example.com'], role: 'viewer' },
    });
    expect(batch.statusCode).toBe(200);

    const inboxOf = async (token: string) => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/notifications',
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
      return res.json().notifications as Array<{
        kind: string;
        title: string;
        body: Record<string, unknown>;
        refId: string | null;
      }>;
    };

    const builderAdded = (await inboxOf(builder.token)).filter(n => n.kind === 'member.added');
    expect(builderAdded).toHaveLength(1); // the already_member batch row did not re-notify
    expect(builderAdded[0]).toMatchObject({ refId: envId });
    expect(builderAdded[0]!.body).toMatchObject({
      envId,
      envName: 'Private Lab',
      role: 'builder',
      inviterName: 'Owner',
    });
    expect(builderAdded[0]!.title).toContain('Private Lab');

    const viewerAdded = (await inboxOf(viewer.token)).filter(n => n.kind === 'member.added');
    expect(viewerAdded).toHaveLength(1);
    expect(viewerAdded[0]!.body).toMatchObject({ envId, role: 'viewer' });

    // No self-echo for the inviter (notify() drops recipient === actor).
    const ownerAdded = (await inboxOf(owner.token)).filter(n => n.kind === 'member.added');
    expect(ownerAdded).toHaveLength(0);
  });

  it('owner invites by userId; email lookup is case-insensitive', async () => {
    const byId = await invite(owner.token, envId, { userId: viewer.id, role: 'viewer' });
    expect(byId.statusCode).toBe(201);
    expect(byId.json()).toMatchObject({ userId: viewer.id, role: 'viewer' });

    const byEmail = await invite(owner.token, envId, {
      email: builder.email.toUpperCase(),
      role: 'builder',
    });
    expect(byEmail.statusCode).toBe(201);
    expect(byEmail.json().userId).toBe(builder.id);
  });

  it('invite validation: role, identifier exclusivity, unknown users, duplicates, authz', async () => {
    // 'owner' is not assignable; role is required and enumerated.
    expect((await invite(owner.token, envId, { userId: builder.id, role: 'owner' })).statusCode).toBe(400);
    expect((await invite(owner.token, envId, { userId: builder.id })).statusCode).toBe(400);
    expect((await invite(owner.token, envId, { userId: builder.id, role: 'admin' })).statusCode).toBe(400);

    // Exactly one of email / userId.
    expect((await invite(owner.token, envId, { role: 'viewer' })).statusCode).toBe(400);
    expect(
      (await invite(owner.token, envId, { email: builder.email, userId: builder.id, role: 'viewer' })).statusCode,
    ).toBe(400);

    // Unknown targets → 404 USER_NOT_FOUND.
    const unknownEmail = await invite(owner.token, envId, { email: 'nobody@example.com', role: 'viewer' });
    expect(unknownEmail.statusCode).toBe(404);
    expect(unknownEmail.json().error.code).toBe('USER_NOT_FOUND');
    const unknownId = await invite(owner.token, envId, { userId: 'no-such-user', role: 'viewer' });
    expect(unknownId.statusCode).toBe(404);
    expect(unknownId.json().error.code).toBe('USER_NOT_FOUND');

    // Duplicate membership → 409 ALREADY_MEMBER (PATCH is the upgrade path).
    expect((await invite(owner.token, envId, { userId: builder.id, role: 'builder' })).statusCode).toBe(201);
    const dup = await invite(owner.token, envId, { userId: builder.id, role: 'viewer' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('ALREADY_MEMBER');
    // Inviting the owner is a duplicate too.
    expect((await invite(owner.token, envId, { userId: owner.id, role: 'viewer' })).statusCode).toBe(409);

    // Non-owner members and strangers cannot invite; anonymous → 401.
    expect((await invite(builder.token, envId, { userId: viewer.id, role: 'viewer' })).statusCode).toBe(403);
    expect((await invite(stranger.token, envId, { userId: viewer.id, role: 'viewer' })).statusCode).toBe(403);
    expect((await invite(undefined, envId, { userId: viewer.id, role: 'viewer' })).statusCode).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Role change (PATCH /members/:userId)
  // -------------------------------------------------------------------------

  it('owner changes roles; the owner role is immutable; non-member 404', async () => {
    await invite(owner.token, envId, { userId: viewer.id, role: 'viewer' });

    const promoted = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}/members/${viewer.id}`,
      headers: auth(owner.token),
      payload: { role: 'builder' },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ userId: viewer.id, role: 'builder' });
    expect(ctx.app.envStore.roleOf(envId, viewer.id)).toBe('builder');

    // The owner role itself cannot be changed.
    const ownerPatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}/members/${owner.id}`,
      headers: auth(owner.token),
      payload: { role: 'viewer' },
    });
    expect(ownerPatch.statusCode).toBe(400);
    expect(ownerPatch.json().error.code).toBe('OWNER_ROLE_IMMUTABLE');

    // Unknown membership → 404; invalid role → 400; non-owner caller → 403.
    const notMember = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}/members/${stranger.id}`,
      headers: auth(owner.token),
      payload: { role: 'viewer' },
    });
    expect(notMember.statusCode).toBe(404);
    expect(notMember.json().error.code).toBe('MEMBER_NOT_FOUND');
    expect(
      (await ctx.app.inject({
        method: 'PATCH',
        url: `/api/environments/${envId}/members/${viewer.id}`,
        headers: auth(owner.token),
        payload: { role: 'owner' },
      })).statusCode,
    ).toBe(400);
    expect(
      (await ctx.app.inject({
        method: 'PATCH',
        url: `/api/environments/${envId}/members/${viewer.id}`,
        headers: auth(builder.token),
        payload: { role: 'viewer' },
      })).statusCode,
    ).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Remove (DELETE /members/:userId)
  // -------------------------------------------------------------------------

  it('owner removes a member (access is lost); members remove themselves; matrix', async () => {
    await invite(owner.token, envId, { userId: builder.id, role: 'builder' });
    await invite(owner.token, envId, { userId: viewer.id, role: 'viewer' });

    // A non-owner member cannot remove someone else.
    const thirdParty = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/members/${viewer.id}`,
      headers: auth(builder.token),
    });
    expect(thirdParty.statusCode).toBe(403);

    // A member removes themselves (= leave)…
    const selfRemove = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/members/${viewer.id}`,
      headers: auth(viewer.token),
    });
    expect(selfRemove.statusCode).toBe(204);
    // …and immediately loses private-env access.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(viewer.token),
    });
    expect(detail.statusCode).toBe(403);

    // The owner removes the builder.
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/members/${builder.id}`,
      headers: auth(owner.token),
    });
    expect(removed.statusCode).toBe(204);
    expect(ctx.app.envStore.roleOf(envId, builder.id)).toBeUndefined();

    // Removing a non-member → 404; removing the owner → 400.
    const gone = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/members/${builder.id}`,
      headers: auth(owner.token),
    });
    expect(gone.statusCode).toBe(404);
    const removeOwner = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/members/${owner.id}`,
      headers: auth(owner.token),
    });
    expect(removeOwner.statusCode).toBe(400);
    expect(removeOwner.json().error.code).toBe('OWNER_CANNOT_LEAVE');
  });

  // -------------------------------------------------------------------------
  // Redaction (P1-6 + Fix-13): owner/builder see userId+email, others do not
  // -------------------------------------------------------------------------

  it('member list is redacted by perspective on BOTH /members and the env detail', async () => {
    const pub = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Public Lab', visibility: 'public', mapData: { zones: [{ id: 'zone-a' }] } },
    });
    const pubId = pub.json().id as string;
    await invite(owner.token, pubId, { userId: builder.id, role: 'builder' });
    await invite(owner.token, pubId, { userId: viewer.id, role: 'viewer' });

    // Member view (owner): full rows.
    const asOwner = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${pubId}/members`,
      headers: auth(owner.token),
    });
    expect(asOwner.statusCode).toBe(200);
    const ownerRow = (asOwner.json().members as Array<Record<string, unknown>>)
      .find(m => m.userId === owner.id);
    expect(ownerRow).toMatchObject({ role: 'owner', displayName: 'Owner', email: owner.email });

    // Builder member: same full view (coordination needs the contacts).
    const asBuilder = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${pubId}/members`,
      headers: auth(builder.token),
    });
    expect(asBuilder.statusCode).toBe(200);
    expect(JSON.stringify(asBuilder.json())).toContain(owner.email);

    // Viewer member (Fix-13, R5 F-04): a read-only observer gets the SAME
    // redacted view as an outsider — no emails, no userIds.
    const asViewer = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${pubId}/members`,
      headers: auth(viewer.token),
    });
    expect(asViewer.statusCode).toBe(200);
    for (const member of asViewer.json().members as Array<Record<string, unknown>>) {
      expect(member.userId).toBeUndefined();
      expect(member.email).toBeUndefined();
      expect(typeof member.displayName).toBe('string');
      expect(typeof member.role).toBe('string');
    }
    expect(JSON.stringify(asViewer.json())).not.toContain(owner.email);
    expect(JSON.stringify(asViewer.json())).not.toContain(builder.email);
    // …and the env detail embeds the same redacted rows for the viewer.
    const detailViewer = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${pubId}`,
      headers: auth(viewer.token),
    });
    expect(detailViewer.statusCode).toBe(200);
    expect(JSON.stringify(detailViewer.json().members)).not.toContain(owner.email);

    // Non-member authenticated user on a public env: redacted.
    const asStranger = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${pubId}/members`,
      headers: auth(stranger.token),
    });
    expect(asStranger.statusCode).toBe(200);
    for (const member of asStranger.json().members as Array<Record<string, unknown>>) {
      expect(member.userId).toBeUndefined();
      expect(member.email).toBeUndefined();
      expect(typeof member.displayName).toBe('string');
      expect(typeof member.role).toBe('string');
    }
    expect(JSON.stringify(asStranger.json())).not.toContain(owner.email);
    expect(JSON.stringify(asStranger.json())).not.toContain(builder.id);

    // Anonymous on a public env: same redaction; detail path agrees.
    const asAnon = await ctx.app.inject({ method: 'GET', url: `/api/environments/${pubId}/members` });
    expect(asAnon.statusCode).toBe(200);
    expect(JSON.stringify(asAnon.json())).not.toContain(owner.email);

    const detailAnon = await ctx.app.inject({ method: 'GET', url: `/api/environments/${pubId}` });
    expect(detailAnon.statusCode).toBe(200);
    expect(JSON.stringify(detailAnon.json().members)).not.toContain(owner.email);
    expect(JSON.stringify(detailAnon.json().members)).not.toContain(builder.id);
    // …while the member-facing detail keeps the full rows.
    const detailOwner = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${pubId}`,
      headers: auth(owner.token),
    });
    expect(JSON.stringify(detailOwner.json().members)).toContain(owner.email);

    // Private env: /members follows detail access (403 for outsiders).
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}/members` })).statusCode,
    ).toBe(403);
    expect(
      (await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/members`,
        headers: auth(stranger.token),
      })).statusCode,
    ).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Viewer read-only end to end
  // -------------------------------------------------------------------------

  it('viewer: reads pass, every write is 403, sandbox fork stays allowed', async () => {
    // Env with a device + managing agent so sim commands are meaningful.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('viewer-lab'), visibility: 'private' },
    });
    expect(created.statusCode).toBe(201);
    const labId = created.json().id as string;
    const hvacId = (created.json().devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'HVAC B')!.id;
    await invite(owner.token, labId, { userId: viewer.id, role: 'viewer' });

    // Reads: detail, member list, proposals list — all 200.
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/environments/${labId}`, headers: auth(viewer.token) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/environments/${labId}/members`, headers: auth(viewer.token) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/environments/${labId}/proposals`, headers: auth(viewer.token) }))
        .statusCode,
    ).toBe(200);

    // Writes: device create, proposal submit, observation push, env patch,
    // sync-bindings replace — all 403 with a role-aware message.
    const writes: Array<[string, string, Record<string, unknown>?]> = [
      ['POST', `/api/environments/${labId}/devices`, {}],
      ['POST', `/api/environments/${labId}/proposals`, {}],
      ['POST', `/api/environments/${labId}/observations`, {}],
      ['PATCH', `/api/environments/${labId}`, { description: 'vandalism' }],
      ['PUT', `/api/environments/${labId}/sync-bindings`, { bindings: [] }],
    ];
    for (const [method, url, payload] of writes) {
      const res = await ctx.app.inject({
        method: method as 'POST',
        url,
        headers: auth(viewer.token),
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }

    // Viewer may create + watch a simulation (read access)…
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(viewer.token),
      payload: { environmentId: labId },
    });
    expect(sim.statusCode).toBe(201);
    // …but device commands inside it are 403 (Fix-4 read-only).
    const command = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sim.json().id}/commands`,
      headers: auth(viewer.token),
      payload: { deviceId: hvacId, commandName: 'turn-on' },
    });
    expect(command.statusCode).toBe(403);
    expect(command.json().error.message).toContain('read-only');

    // Event injection is aligned with commands (Fix-13, R5 F-05): viewers
    // get the same 403, while a builder may inject into the same sim.
    const viewerInject = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sim.json().id}/events`,
      headers: auth(viewer.token),
      payload: { type: 'heatwave', zoneId: 'zone-a' },
    });
    expect(viewerInject.statusCode).toBe(403);
    expect(viewerInject.json().error.message).toContain('read-only');
    await invite(owner.token, labId, { userId: builder.id, role: 'builder' });
    const builderInject = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sim.json().id}/events`,
      headers: auth(builder.token),
      payload: { type: 'heatwave', zoneId: 'zone-a' },
    });
    expect(builderInject.statusCode).toBe(200);

    // Sandbox fork stays allowed: it is isolated experimentation — the fork
    // never writes back to the shared world (sandbox-service.ts).
    const fork = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${labId}/sandboxes`,
      headers: auth(viewer.token),
      payload: {},
    });
    expect(fork.statusCode).toBe(201);
    expect(fork.json().status).toBe('active');
  });
});

describe('pending invites for unregistered emails (R15-D10)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Teacher' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Classroom D10', visibility: 'private' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('roster import parks unknown emails as invites; registration auto-joins', async () => {
    const studentEmail = `student-${Date.now()}@d10.test`;
    const batch = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/members:batch`,
      headers: auth(owner.token),
      payload: { emails: [studentEmail], role: 'builder' },
    });
    expect(batch.statusCode).toBe(200);
    const body = batch.json();
    expect(body.summary.invited).toBe(1);
    expect(body.results[0]).toMatchObject({ email: studentEmail, status: 'invited' });

    // Owner sees the pending invite.
    const invites = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/invites`,
      headers: auth(owner.token),
    });
    expect(invites.statusCode).toBe(200);
    expect(invites.json().invites).toHaveLength(1);
    expect(invites.json().invites[0]).toMatchObject({ email: studentEmail, role: 'builder' });

    // The student registers AFTER the import — membership lands immediately.
    const student = await registerUser(ctx.app, { email: studentEmail, displayName: 'Student' });
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments',
      headers: auth(student.token),
    });
    const mine = list.json().environments.find((e: { id: string }) => e.id === envId);
    expect(mine?.myRole).toBe('builder');

    // Accepted invites leave the pending list; the private env is readable.
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/invites`,
      headers: auth(owner.token),
    });
    expect(after.json().invites).toHaveLength(0);
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(student.token),
    });
    expect(detail.statusCode).toBe(200);
  });

  it('re-inviting updates the pending role; revoking cancels it', async () => {
    const email = `later-${Date.now()}@d10.test`;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/members:batch`,
      headers: auth(owner.token),
      payload: { emails: [email], role: 'builder' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/members:batch`,
      headers: auth(owner.token),
      payload: { emails: [email], role: 'viewer' },
    });
    const invites = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/invites`,
      headers: auth(owner.token),
    });
    expect(invites.json().invites).toHaveLength(1); // upsert, not duplicate
    expect(invites.json().invites[0].role).toBe('viewer');

    const inviteId = invites.json().invites[0].id;
    const revoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/invites/${inviteId}`,
      headers: auth(owner.token),
    });
    expect(revoke.statusCode).toBe(204);
    // Revoked: registration no longer joins the env.
    const student = await registerUser(ctx.app, { email, displayName: 'Late Student' });
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments',
      headers: auth(student.token),
    });
    expect(list.json().environments.some((e: { id: string }) => e.id === envId)).toBe(false);
  });

  it('non-owners cannot list invites', async () => {
    const stranger = await registerUser(ctx.app, { displayName: 'Stranger' });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/invites`,
      headers: auth(stranger.token),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('membership-change notifications (T-026, R10 EB-F07)', () => {
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
      payload: {
        name: 'Notify Lab',
        visibility: 'private',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    const invited = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/members`,
      headers: auth(owner.token),
      payload: { userId: member.id, role: 'builder' },
    });
    expect(invited.statusCode).toBe(201);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function inboxOf(token: string) {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/notifications', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    return res.json().notifications as Array<{
      id: string;
      kind: string;
      title: string;
      body: Record<string, unknown>;
      refId: string | null;
      repeatCount: number;
    }>;
  }

  it('role change (both directions) notifies the affected member with before/after', async () => {
    // Demotion builder → viewer.
    const demoted = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}/members/${member.id}`,
      headers: auth(owner.token),
      payload: { role: 'viewer' },
    });
    expect(demoted.statusCode).toBe(200);
    // Promotion viewer → builder.
    const promoted = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}/members/${member.id}`,
      headers: auth(owner.token),
      payload: { role: 'builder' },
    });
    expect(promoted.statusCode).toBe(200);

    const rows = (await inboxOf(member.token)).filter(n => n.kind === 'member.role_changed');
    // R68 aggregation: a same-key (recipient, kind, refId) UNREAD row absorbs
    // the repeat — repeatCount climbs and title/body refresh to the LATEST
    // change instead of inserting a twin row.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refId: envId, repeatCount: 2 });
    expect(rows[0].body).toMatchObject({
      envId,
      envName: 'Notify Lab',
      userId: member.id,
      before: 'viewer',
      after: 'builder',
      changedByName: 'Owner',
    });
    expect(rows[0].title).toContain('Notify Lab');

    // Read state is the aggregation boundary: once the row is read, the
    // next change inserts a fresh row — and the demotion direction keeps
    // its own before/after.
    const ack = await ctx.app.inject({
      method: 'POST',
      url: `/api/notifications/${rows[0].id}/read`,
      headers: auth(member.token),
    });
    expect(ack.statusCode).toBe(200);
    const demotedAgain = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}/members/${member.id}`,
      headers: auth(owner.token),
      payload: { role: 'viewer' },
    });
    expect(demotedAgain.statusCode).toBe(200);
    const after = (await inboxOf(member.token)).filter(n => n.kind === 'member.role_changed');
    expect(after).toHaveLength(2);
    expect(after[0].body).toMatchObject({ before: 'builder', after: 'viewer' }); // newest first
    // The actor gets no self-echo.
    expect((await inboxOf(owner.token)).filter(n => n.kind === 'member.role_changed')).toHaveLength(0);
  });

  it('removal notifies the removed member; self-leave stays silent', async () => {
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/members/${member.id}`,
      headers: auth(owner.token),
    });
    expect(removed.statusCode).toBe(204);
    const rows = (await inboxOf(member.token)).filter(n => n.kind === 'member.removed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refId: envId });
    expect(rows[0].body).toMatchObject({
      envId,
      envName: 'Notify Lab',
      userId: member.id,
      removedRole: 'builder',
      removedByName: 'Owner',
    });
    expect(rows[0].title).toContain('Notify Lab');

    // Self-leave (member removes themselves): recipient === actor → the
    // funnel drops the echo; no member.removed row for the leaver.
    const invited = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/members`,
      headers: auth(owner.token),
      payload: { userId: member.id, role: 'viewer' },
    });
    expect(invited.statusCode).toBe(201);
    const before = (await inboxOf(member.token)).filter(n => n.kind === 'member.removed').length;
    const left = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/members/${member.id}`,
      headers: auth(member.token),
    });
    expect(left.statusCode).toBe(204);
    expect((await inboxOf(member.token)).filter(n => n.kind === 'member.removed')).toHaveLength(before);
  });

  it('zh/en titles both interpolate the env name and roles', async () => {
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}/members/${member.id}`,
      headers: { ...auth(owner.token), 'accept-language': 'zh-CN' },
      payload: { role: 'viewer' },
    });
    // R68 aggregation: an UNREAD same-key row would absorb the second change
    // (and its en title would overwrite the zh one) — acknowledge the zh row
    // first so each locale gets its own row.
    const first = (await inboxOf(member.token)).filter(n => n.kind === 'member.role_changed');
    expect(first).toHaveLength(1);
    const ack = await ctx.app.inject({
      method: 'POST',
      url: `/api/notifications/${first[0].id}/read`,
      headers: auth(member.token),
    });
    expect(ack.statusCode).toBe(200);
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}/members/${member.id}`,
      headers: { ...auth(owner.token), 'accept-language': 'en-US' },
      payload: { role: 'builder' },
    });
    const rows = (await inboxOf(member.token)).filter(n => n.kind === 'member.role_changed');
    expect(rows.some(row => row.title.includes('角色由 builder 变更为 viewer'))).toBe(true);
    expect(rows.some(row => /from builder to viewer|from viewer to builder/.test(row.title))).toBe(true);
  });
});
