/**
 * @vitest-environment node
 *
 * Governance kernel tests (P-A, multi-user-simulation-design.md §4/§11).
 *
 * Covers the two acceptance paths:
 * - submit → rule-check REJECTION (unknown zone, forbidden capability,
 *   spatial conflict, quota, bad scenario fragment) — the proposal lands as
 *   `rejected` with the full issue list;
 * - submit → escalate (P-A default reviewer) → owner approve → applied →
 *   command_log queryable → revert rolls the world back.
 *
 * Plus the permission matrix (viewer/stranger/non-owner), hass:// high-risk
 * escalation, apply-time revalidation, and zone-claim. Fix-7 coverage:
 * install-agents (agent + derived services land, revert cleans both, 设备私有
 * binding rules, zone-claim autonomy), remove-devices (delete/restore
 * lifecycle, foreign + agent-bound rejections, DELETE route conversion), and
 * modify-object's REAL apply (before/after audit, revert restores, no more
 * applied-but-noop on unsupported targets/fields).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseMapData } from './db/environment-store.js';
import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('proposals (P-A governance kernel)', () => {
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
      payload: {
        name: 'Governance Lab',
        visibility: 'public',
        mapData: {
          zones: [
            { id: 'zone-a', bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 } },
            { id: 'zone-b' },
          ],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });
    ctx.app.envStore.addMember(envId, viewer.id, 'viewer');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function submitProposal(
    token: string,
    kind: string,
    payload: Record<string, unknown>,
  ) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(token),
      payload: { kind, payload },
    });
  }

  function installPayload(overrides: Record<string, unknown> = {}) {
    return {
      devices: [
        {
          name: 'Corridor Sensor',
          type: 'temperature-sensor',
          capabilities: ['temperature-reading'],
          zoneId: 'zone-a',
        },
      ],
      ...overrides,
    };
  }

  function decide(token: string, proposalId: string, decision: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/decide`,
      headers: auth(token),
      payload: { decision },
    });
  }

  function revert(token: string, proposalId: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/revert`,
      headers: auth(token),
    });
  }

  function commandLog(token: string) {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log`,
      headers: auth(token),
    });
  }

  // -------------------------------------------------------------------------
  // Submission + access
  // -------------------------------------------------------------------------

  it('rejects malformed submissions and non-builder authors', async () => {
    const badKind = await submitProposal(builder.token, 'nuke-world', {});
    expect(badKind.statusCode).toBe(400);

    const noPayload = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
      payload: { kind: 'install-devices' },
    });
    expect(noPayload.statusCode).toBe(400);

    expect((await submitProposal(viewer.token, 'install-devices', installPayload())).statusCode).toBe(403);
    expect((await submitProposal(stranger.token, 'install-devices', installPayload())).statusCode).toBe(403);

    const anon = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      payload: { kind: 'install-devices', payload: installPayload() },
    });
    expect(anon.statusCode).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Rule-check rejections
  // -------------------------------------------------------------------------

  it('rule check rejects an unknown zone with the issue recorded', async () => {
    const res = await submitProposal(
      builder.token,
      'install-devices',
      installPayload({ devices: [{ ...installPayload().devices[0], zoneId: 'zone-nope' }] }),
    );
    expect(res.statusCode).toBe(201);
    const proposal = res.json();
    expect(proposal.status).toBe('rejected');
    expect(proposal.ruleCheck.ok).toBe(false);
    expect(proposal.ruleCheck.issues.join(' ')).toContain('zone-nope');
  });

  it('rule check rejects the real-actuator capability and unknown catalog models', async () => {
    const capability = await submitProposal(
      builder.token,
      'install-devices',
      installPayload({
        devices: [{ ...installPayload().devices[0], capabilities: ['controls-real-actuator'] }],
      }),
    );
    expect(capability.json().status).toBe('rejected');
    expect(capability.json().ruleCheck.issues.join(' ')).toContain('controls-real-actuator');

    const model = await submitProposal(
      builder.token,
      'install-devices',
      installPayload({ devices: [{ zoneId: 'zone-a', modelId: 'no-such-model' }] }),
    );
    expect(model.json().status).toBe('rejected');
    expect(model.json().ruleCheck.issues.join(' ')).toContain('no-such-model');
  });

  it('rule check rejects spatial conflicts (zone bounds + existing device overlap)', async () => {
    // An existing device occupying [10,20]×[10,20] in zone-a.
    const device = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Existing',
        type: 'hvac',
        capabilities: ['temperature-control'],
        zoneId: 'zone-a',
        position: { minX: 10, maxX: 20, minY: 10, maxY: 20 },
      },
    });
    expect(device.statusCode).toBe(201);

    const overlapping = await submitProposal(
      builder.token,
      'install-devices',
      installPayload({
        devices: [
          {
            ...installPayload().devices[0],
            position: { minX: 15, maxX: 25, minY: 15, maxY: 25 },
          },
        ],
      }),
    );
    expect(overlapping.json().status).toBe('rejected');
    expect(overlapping.json().ruleCheck.issues.join(' ')).toContain('overlap');

    const outsideZone = await submitProposal(
      builder.token,
      'install-devices',
      installPayload({
        devices: [
          {
            ...installPayload().devices[0],
            position: { minX: 150, maxX: 160, minY: 0, maxY: 10 },
          },
        ],
      }),
    );
    expect(outsideZone.json().status).toBe('rejected');
    expect(outsideZone.json().ruleCheck.issues.join(' ')).toContain('zone-a');
  });

  it('rule check rejects a scenario fragment that fails the scenario schema', async () => {
    const res = await submitProposal(builder.token, 'inject-scenario', {
      events: [{ id: 'evt-1', type: 'fire', zoneId: 'zone-nope' }],
    });
    const proposal = res.json();
    expect(proposal.status).toBe('rejected');
    expect(proposal.ruleCheck.issues.join(' ')).toContain('zone-nope');

    const empty = await submitProposal(builder.token, 'inject-scenario', {});
    expect(empty.json().status).toBe('rejected');
  });

  it('rule check enforces the devices_per_env quota as a rejection', async () => {
    const small = await makeTestApp({ quotaMaxDevicesPerEnv: 2 });
    try {
      const qOwner = await registerUser(small.app, { displayName: 'QOwner' });
      const env = await small.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(qOwner.token),
        payload: { name: 'Quota Lab', mapData: { zones: [{ id: 'zone-a' }] } },
      });
      const qEnvId = env.json().id;
      const res = await small.app.inject({
        method: 'POST',
        url: `/api/environments/${qEnvId}/proposals`,
        headers: auth(qOwner.token),
        payload: {
          kind: 'install-devices',
          payload: {
            devices: [1, 2, 3].map(n => ({
              name: `D${n}`,
              type: 'sensor',
              capabilities: ['temperature-reading'],
              zoneId: 'zone-a',
            })),
          },
        },
      });
      expect(res.json().status).toBe('rejected');
      expect(res.json().ruleCheck.issues.join(' ')).toContain('devices_per_env');
    } finally {
      await small.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Full lifecycle: escalate → approve → applied → command_log → revert
  // -------------------------------------------------------------------------

  it('runs the acceptance lifecycle: submit → escalate → owner approve → applied → revert', async () => {
    const submitted = await submitProposal(builder.token, 'install-devices', installPayload());
    expect(submitted.statusCode).toBe(201);
    const proposal = submitted.json();
    // P-A default reviewer escalates everything that passed the rule check.
    expect(proposal.status).toBe('escalated');
    expect(proposal.riskLevel).toBe('low');
    expect(proposal.ruleCheck.ok).toBe(true);

    // Visibility: the author sees their own, the owner sees all, strangers nothing.
    const asBuilder = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
    });
    expect(asBuilder.json().proposals).toHaveLength(1);
    const asStranger = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(stranger.token),
    });
    expect(asStranger.json().proposals).toHaveLength(0);
    const asOwner = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/proposals?status=escalated`,
      headers: auth(owner.token),
    });
    expect(asOwner.json().proposals).toHaveLength(1);

    // A non-owner cannot decide; a bad decision value is a 400.
    expect((await decide(builder.token, proposal.id, 'approved')).statusCode).toBe(403);
    expect((await decide(owner.token, proposal.id, 'maybe')).statusCode).toBe(400);

    // Owner approves → applied; the world changed.
    const approved = await decide(owner.token, proposal.id, 'approved');
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('applied');
    expect(approved.json().reviewerId).toBe(owner.id);
    const devices = ctx.app.envStore.devicesOf(envId);
    expect(devices).toHaveLength(1);
    expect(devices[0].owner_id).toBe(builder.id);

    // The command log records the apply (Fix-9: the owner sees the full log,
    // other members a scoped view — the builder sees their own action here).
    const builderLog = await commandLog(builder.token);
    expect(builderLog.statusCode).toBe(200);
    expect(builderLog.json().entries).toHaveLength(1);
    const log = await commandLog(owner.token);
    expect(log.statusCode).toBe(200);
    expect(log.json().entries).toHaveLength(1);
    const applyEntry = log.json().entries[0];
    expect(applyEntry.kind).toBe('install-devices');
    expect(applyEntry.proposalId).toBe(proposal.id);
    // Fix-1 attribution: the actor is the proposal AUTHOR; the approver is
    // recorded as payload.decidedBy.
    expect(applyEntry.actor.id).toBe(builder.id);
    expect(applyEntry.payload.decidedBy).toBe(owner.id);
    expect(applyEntry.payload.after.devices).toHaveLength(1);

    // Revert (the author may revert) → device gone, revert logged.
    const reverted = await revert(builder.token, proposal.id);
    expect(reverted.statusCode).toBe(200);
    expect(reverted.json().status).toBe('reverted');
    expect(ctx.app.envStore.devicesOf(envId)).toHaveLength(0);

    const logAfter = await commandLog(owner.token);
    expect(logAfter.json().entries).toHaveLength(2);
    expect(logAfter.json().entries[0].kind).toBe('revert:install-devices');

    // Terminal states are sticky: re-revert / re-decide are conflicts.
    expect((await revert(owner.token, proposal.id)).statusCode).toBe(409);
    expect((await decide(owner.token, proposal.id, 'approved')).statusCode).toBe(409);
  });

  it('owner rejection of an escalated proposal leaves the world untouched', async () => {
    const submitted = await submitProposal(builder.token, 'install-devices', installPayload());
    const rejected = await decide(owner.token, submitted.json().id, 'rejected');
    expect(rejected.json().status).toBe('rejected');
    expect(ctx.app.envStore.devicesOf(envId)).toHaveLength(0);
    expect((await commandLog(owner.token)).json().entries).toHaveLength(0);
  });

  it('hass:// bindings escalate as high-risk and apply with the binding persisted', async () => {
    const submitted = await submitProposal(
      builder.token,
      'install-devices',
      installPayload({
        devices: [{ ...installPayload().devices[0], binding: 'hass://sensor.corridor_temp' }],
      }),
    );
    const proposal = submitted.json();
    expect(proposal.status).toBe('escalated');
    expect(proposal.riskLevel).toBe('high');
    expect(proposal.ruleCheck.forceEscalate).toBe(true);

    const approved = await decide(owner.token, proposal.id, 'approved');
    expect(approved.json().status).toBe('applied');
    const device = ctx.app.envStore.devicesOf(envId)[0];
    expect(device.binding).toBe('hass://sensor.corridor_temp');
  });

  it('inject-scenario applies devices + map events, and revert removes both', async () => {
    const submitted = await submitProposal(builder.token, 'inject-scenario', {
      devices: [
        {
          name: 'Drill Smoke Detector',
          type: 'smoke-detector',
          capabilities: ['smoke-detection'],
          zoneId: 'zone-a',
        },
      ],
      events: [
        { id: 'fire-drill', type: 'fire-alarm', zoneId: 'zone-a', severity: 'high', atSimTimeSec: 60 },
      ],
      effectiveUntil: '2026-08-01T00:00:00.000Z',
    });
    const proposal = submitted.json();
    expect(proposal.status).toBe('escalated');
    expect(proposal.expiresAt).toBe('2026-08-01T00:00:00.000Z');

    const approved = await decide(owner.token, proposal.id, 'approved');
    expect(approved.json().status).toBe('applied');
    expect(ctx.app.envStore.devicesOf(envId)).toHaveLength(1);

    const env = ctx.app.envStore.getEnvironment(envId)!;
    const events = parseMapData(env).events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(`${proposal.id}:fire-drill`);

    const reverted = await revert(owner.token, proposal.id);
    expect(reverted.json().status).toBe('reverted');
    expect(ctx.app.envStore.devicesOf(envId)).toHaveLength(0);
    const envAfter = ctx.app.envStore.getEnvironment(envId)!;
    expect(parseMapData(envAfter).events ?? []).toHaveLength(0);
  });

  it('apply revalidates against the current world: a stale approval is rejected', async () => {
    // Two proposals with the same bounds pass the rule check independently…
    const bounds = { minX: 30, maxX: 40, minY: 30, maxY: 40 };
    const first = await submitProposal(
      builder.token,
      'install-devices',
      installPayload({ devices: [{ ...installPayload().devices[0], position: bounds }] }),
    );
    const second = await submitProposal(
      builder.token,
      'install-devices',
      installPayload({ devices: [{ ...installPayload().devices[0], position: bounds }] }),
    );
    expect(first.json().status).toBe('escalated');
    expect(second.json().status).toBe('escalated');

    // …but once the first applies, approving the second fails the re-check.
    expect((await decide(owner.token, first.json().id, 'approved')).json().status).toBe('applied');
    const stale = await decide(owner.token, second.json().id, 'approved');
    expect(stale.json().status).toBe('rejected');
    expect(stale.json().ruleCheck.issues.join(' ')).toContain('overlap');
  });

  // -------------------------------------------------------------------------
  // modify-object (Fix-7: real apply) + zone-claim
  // -------------------------------------------------------------------------

  it('modify-object applies the patch for real and revert restores the before-state', async () => {
    // T-402 (R19): the target must be the author's OWN object — install the
    // builder's device through the pipeline first.
    const targetId = (await installBuilderDevice()).id;

    const modify = await submitProposal(builder.token, 'modify-object', {
      targetId,
      patch: { name: 'Renamed HVAC' },
    });
    expect(modify.json().status).toBe('escalated');
    const approved = await decide(owner.token, modify.json().id, 'approved');
    expect(approved.json().status).toBe('applied');
    // Fix-7: real apply — the world changed, the audit entry carries before/after.
    expect(ctx.app.envStore.getDevice(targetId)!.name).toBe('Renamed HVAC');
    const log = await commandLog(owner.token);
    const applyEntry = log.json().entries[0];
    expect(applyEntry.kind).toBe('modify-object');
    expect(applyEntry.payload.after.before.name).toBe('Corridor Sensor');
    expect(applyEntry.payload.after.after.name).toBe('Renamed HVAC');

    const reverted = await revert(builder.token, modify.json().id);
    expect(reverted.json().status).toBe('reverted');
    expect(ctx.app.envStore.getDevice(targetId)!.name).toBe('Corridor Sensor');
  });

  it('modify-object rejects unsupported targets and patch fields (no applied-but-noop)', async () => {
    const targetId = (await installBuilderDevice()).id;

    // Unknown target (an environment id is not a device/agent).
    const badTarget = await submitProposal(builder.token, 'modify-object', {
      targetId: 'no-such-device',
      patch: { name: 'X' },
    });
    expect(badTarget.json().status).toBe('rejected');

    // Unsupported patch fields — previously these "applied" with zero effect.
    const badField = await submitProposal(builder.token, 'modify-object', {
      targetId,
      patch: { ownerId: builder.id, description: 'hijack' },
    });
    expect(badField.json().status).toBe('rejected');
    const issues = badField.json().ruleCheck.issues.join(' ');
    expect(issues).toContain('ownerId');
    expect(issues).toContain('description');
    expect(ctx.app.envStore.getDevice(targetId)!.name).toBe('Corridor Sensor');

    // Field values are validated with PATCH semantics (unknown zone).
    const badZone = await submitProposal(builder.token, 'modify-object', {
      targetId,
      patch: { zoneId: 'zone-nope' },
    });
    expect(badZone.json().status).toBe('rejected');
  });

  // -------------------------------------------------------------------------
  // T-402 (DevLoop R19, CC-F02): modify-object target ownership
  // -------------------------------------------------------------------------

  it('T-402: modify-object on ANOTHER user\'s device is hard-rejected with the owner-direct PATCH hint', async () => {
    const ownerDevice = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/devices`,
        headers: auth(owner.token),
        payload: {
          name: 'Office AHU-1',
          type: 'hvac',
          capabilities: ['temperature-control'],
          zoneId: 'zone-a',
        },
      })
    ).json();

    const foreign = await submitProposal(builder.token, 'modify-object', {
      targetId: ownerDevice.id,
      patch: { brand: 'Semantically Neutral Co' },
    });
    expect(foreign.json().status).toBe('rejected');
    const issues = foreign.json().ruleCheck.issues.join(' ');
    expect(issues).toContain('owned by another user');
    expect(issues).toContain('Office AHU-1');
    expect(issues).toContain('PATCH /api/devices/:id');
    // The world did not change.
    expect(ctx.app.envStore.getDevice(ownerDevice.id)!.brand).toBeNull();
  });

  it('T-402: modify-object on ANOTHER user\'s AGENT is hard-rejected with the owner-direct PATCH hint', async () => {
    // An owner-owned agent (owner-direct install).
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Owner Agent',
        capabilities: [],
        managedZoneIds: ['zone-a'],
      },
    });
    const ownerAgent = ctx.app.envStore.agentsOf(envId).find(a => a.name === 'Owner Agent')!;

    const foreign = await submitProposal(builder.token, 'modify-object', {
      targetId: ownerAgent.id,
      patch: { capabilities: ['temperature-control'] },
    });
    expect(foreign.json().status).toBe('rejected');
    const issues = foreign.json().ruleCheck.issues.join(' ');
    expect(issues).toContain('owned by another user');
    expect(issues).toContain('Owner Agent');
    expect(issues).toContain('PATCH /api/agents/:id');
  });

  it('modify-object boundDeviceIds may only bind the author\'s own devices (Fix-9, 设备私有)', async () => {
    const ownersDevice = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/devices`,
        headers: auth(owner.token),
        payload: {
          name: 'Owner HVAC',
          type: 'hvac',
          capabilities: ['temperature-control'],
          zoneId: 'zone-a',
        },
      })
    ).json();
    // The builder's own device + agent, installed through the pipeline.
    const device = await installBuilderDevice();
    const agentInstall = await submitProposal(builder.token, 'install-agents', {
      agents: [
        {
          name: 'Binder',
          capabilities: ['temperature-monitoring'],
          boundDeviceIds: [device.id],
        },
      ],
    });
    expect((await decide(owner.token, agentInstall.json().id, 'approved')).json().status).toBe('applied');
    const agentId = ctx.app.envStore.agentsOf(envId)[0].id;

    // Rebinding the agent to someone ELSE's device → rule-check rejection
    // (symmetric with install-agents; previously only existence was checked).
    const foreign = await submitProposal(builder.token, 'modify-object', {
      targetId: agentId,
      patch: { boundDeviceIds: [device.id, ownersDevice.id] },
    });
    expect(foreign.json().status).toBe('rejected');
    const issues = foreign.json().ruleCheck.issues.join(' ');
    expect(issues).toContain('owned by another user');
    expect(issues).toContain(ownersDevice.id);

    // Binding only the author's own device passes the rule check.
    const own = await submitProposal(builder.token, 'modify-object', {
      targetId: agentId,
      patch: { boundDeviceIds: [device.id] },
    });
    expect(own.json().ruleCheck.ok).toBe(true);
    expect(own.json().status).toBe('escalated');
  });

  it('zone-claim runs the generic pipeline and always escalates', async () => {
    const claim = await submitProposal(builder.token, 'zone-claim', { zoneId: 'zone-b' });
    expect(claim.json().status).toBe('escalated');
    const unknownZone = await submitProposal(builder.token, 'zone-claim', { zoneId: 'zone-nope' });
    expect(unknownZone.json().status).toBe('rejected');
  });

  // -------------------------------------------------------------------------
  // T-404 (DevLoop R19): member proposal visibility + single-proposal GET
  // -------------------------------------------------------------------------

  it('T-404: members see ALL env proposals (the affected party can read the zone-claim); strangers stay author-scoped', async () => {
    const claim = await submitProposal(builder.token, 'zone-claim', { zoneId: 'zone-b' });
    expect(claim.json().status).toBe('escalated');
    const proposalId = claim.json().id as string;

    // A SECOND builder (the affected party of the claim) lists the env's
    // proposals and finally SEES the pending ask with its payload.
    const builder2 = await registerUser(ctx.app, { displayName: 'Builder Two' });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder2.token),
    });
    const asMember = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder2.token),
    });
    expect(asMember.json().proposals).toHaveLength(1);
    expect(asMember.json().proposals[0].kind).toBe('zone-claim');
    expect(asMember.json().proposals[0].payload.zoneId).toBe('zone-b');
    // Viewers are members too (read-only role, read surface).
    const asViewer = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(viewer.token),
    });
    expect(asViewer.json().proposals).toHaveLength(1);

    // Strangers keep the author-scoped view (their own submissions only).
    const asStranger = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(stranger.token),
    });
    expect(asStranger.json().proposals).toHaveLength(0);

    // Single-proposal GET: member 200 with the payload.
    const byId = await ctx.app.inject({
      method: 'GET',
      url: `/api/proposals/${proposalId}`,
      headers: auth(builder2.token),
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().id).toBe(proposalId);
    expect(byId.json().payload.zoneId).toBe('zone-b');

    // Deciding stays OWNER-ONLY (design §5.3) — even for the affected
    // builder who can now finally see the ask.
    const decidedByBuilder = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/decide`,
      headers: auth(builder2.token),
      payload: { decision: 'approved' },
    });
    expect(decidedByBuilder.statusCode).toBe(403);

    // Reads write no audit rows.
    expect((await commandLog(owner.token)).json().entries).toHaveLength(0);
  });

  it('T-404: GET /api/proposals/:id on a PRIVATE env 403s strangers with the teaching error', async () => {
    // A private env with one proposal (owner-submitted install-devices).
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Private Governance Lab',
        visibility: 'private',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    const privateEnvId = created.json().id as string;
    const submitted = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${privateEnvId}/proposals`,
      headers: auth(owner.token),
      payload: {
        kind: 'install-devices',
        payload: {
          devices: [{ name: 'Private Sensor', type: 'sensor', capabilities: ['temperature-reading'], zoneId: 'zone-a' }],
        },
      },
    });
    const proposalId = submitted.json().id as string;

    const asStranger = await ctx.app.inject({
      method: 'GET',
      url: `/api/proposals/${proposalId}`,
      headers: auth(stranger.token),
    });
    expect(asStranger.statusCode).toBe(403);
    expect(asStranger.json().error.message).toContain('private');

    const asOwner = await ctx.app.inject({
      method: 'GET',
      url: `/api/proposals/${proposalId}`,
      headers: auth(owner.token),
    });
    expect(asOwner.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Fix-7: install-agents
  // -------------------------------------------------------------------------

  /** Install a builder-owned device through the pipeline; returns its id. */
  async function installBuilderDevice(overrides: Record<string, unknown> = {}) {
    const submitted = await submitProposal(
      builder.token,
      'install-devices',
      installPayload(overrides),
    );
    expect(submitted.json().status).toBe('escalated');
    const approved = await decide(owner.token, submitted.json().id, 'approved');
    expect(approved.json().status).toBe('applied');
    const devices = ctx.app.envStore.devicesOf(envId);
    return devices[devices.length - 1];
  }

  it('install-agents: builder proposal → approval → agent + derived services land → revert cleans both', async () => {
    const device = await installBuilderDevice();

    const submitted = await submitProposal(builder.token, 'install-agents', {
      agents: [
        {
          name: 'Corridor Brain',
          capabilities: ['temperature-monitoring'],
          boundDeviceIds: [device.id],
          managedZoneIds: ['zone-a'],
        },
      ],
    });
    const proposal = submitted.json();
    expect(proposal.status).toBe('escalated');

    const approved = await decide(owner.token, proposal.id, 'approved');
    expect(approved.json().status).toBe('applied');

    // The agent landed, owned by the builder…
    const agents = ctx.app.envStore.agentsOf(envId);
    expect(agents).toHaveLength(1);
    expect(agents[0].owner_id).toBe(builder.id);
    // …and its device-derived services were generated (one per capability).
    const services = ctx.app.serviceStore.servicesOfAgent(agents[0].id);
    expect(services).toHaveLength(1);
    expect(services[0].origin).toBe('derived');
    expect(services[0].semantic_type).toBe('temperature-reading');
    expect(services[0].source_device_id).toBe(device.id);

    // Revert removes the agent and cascades its services away.
    const reverted = await revert(builder.token, proposal.id);
    expect(reverted.json().status).toBe('reverted');
    expect(ctx.app.envStore.agentsOf(envId)).toHaveLength(0);
    expect(ctx.app.serviceStore.servicesOf(envId)).toHaveLength(0);
    // The bound device survives the revert (it came from another proposal).
    expect(ctx.app.envStore.getDevice(device.id)).toBeDefined();
  });

  // The revert of install-agents/install-devices deletes rows via the raw
  // envStore DELETE — the FK cascade (agents) / SET NULL (devices) touches
  // service rows without any store write method, so the revert must notify
  // the catalog explicitly (same discipline as removeDevices/removeAgents)
  // or the live-runtime world: mirror would hold ghost registrations.
  it('revert install-agents/install-devices: cascaded service rows notify the catalog', async () => {
    const deviceProposalSubmitted = await submitProposal(builder.token, 'install-devices', installPayload());
    const deviceProposalId = deviceProposalSubmitted.json().id as string;
    await decide(owner.token, deviceProposalId, 'approved');
    const device = ctx.app.envStore.devicesOf(envId).at(-1)!;

    const agentProposalSubmitted = await submitProposal(builder.token, 'install-agents', {
      agents: [
        {
          name: 'Corridor Brain',
          capabilities: ['temperature-monitoring'],
          boundDeviceIds: [device.id],
          managedZoneIds: ['zone-a'],
        },
      ],
    });
    const agentProposalId = agentProposalSubmitted.json().id as string;
    await decide(owner.token, agentProposalId, 'approved');

    // Spy AFTER the applies (the apply lanes notify through the store write
    // methods) — what is measured is the REVERT's own notify.
    const spy = vi.spyOn(ctx.app.serviceStore, 'notifyCatalogChange');

    const revertedAgents = await revert(builder.token, agentProposalId);
    expect(revertedAgents.json().status).toBe('reverted');
    expect(spy).toHaveBeenCalledWith(envId);

    spy.mockClear();
    const revertedDevices = await revert(builder.token, deviceProposalId);
    expect(revertedDevices.json().status).toBe('reverted');
    expect(spy).toHaveBeenCalledWith(envId);

    spy.mockRestore();
  });

  // T-604 (R26, HO26-F01): the scope-of-practice blocklist is reachable from
  // the GOVERNED authoring path — at birth (install-agents) and via
  // modify-object on the author's own agent (the owner PATCH lane already
  // had it; the pharmacy persona had no path).
  it('T-604: cannotDeliverClasses at install-agents AND via modify-object on the own agent (revert restores)', async () => {
    const device = await installBuilderDevice();

    // Birth: install-agents accepts the blocklist.
    const installed = await submitProposal(builder.token, 'install-agents', {
      agents: [
        {
          name: 'Pharmacy Agent',
          capabilities: ['temperature-monitoring'],
          boundDeviceIds: [device.id],
          managedZoneIds: ['zone-a'],
          cannotDeliverClasses: ['controlled-substance-dispense'],
        },
      ],
    });
    expect(installed.json().status).toBe('escalated');
    expect((await decide(owner.token, installed.json().id, 'approved')).json().status).toBe('applied');
    const agent = ctx.app.envStore.agentsOf(envId)[0];
    expect(JSON.parse(agent.cannot_deliver_classes_json!)).toEqual(['controlled-substance-dispense']);

    // Governed edit: the builder's OWN agent, through modify-object.
    const modify = await submitProposal(builder.token, 'modify-object', {
      targetId: agent.id,
      patch: { cannotDeliverClasses: ['controlled-substance-dispense', 'tPA-administration'] },
    });
    expect(modify.json().status).toBe('escalated');
    expect((await decide(owner.token, modify.json().id, 'approved')).json().status).toBe('applied');
    expect(JSON.parse(ctx.app.envStore.getAgent(agent.id)!.cannot_deliver_classes_json!))
      .toEqual(['controlled-substance-dispense', 'tPA-administration']);

    // env GET shows it (the surface PartnerSelectionNegotiator ultimately
    // feeds from through the bridge).
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    expect(
      (detail.json().agents as Array<{ id: string; cannotDeliverClasses?: string[] }>)
        .find(a => a.id === agent.id)!.cannotDeliverClasses,
    ).toEqual(['controlled-substance-dispense', 'tPA-administration']);

    // Revert restores the before state (the birth list).
    expect((await revert(builder.token, modify.json().id)).json().status).toBe('reverted');
    expect(JSON.parse(ctx.app.envStore.getAgent(agent.id)!.cannot_deliver_classes_json!))
      .toEqual(['controlled-substance-dispense']);

    // Validation parity: empty-string class → rule-check rejection.
    const bad = await submitProposal(builder.token, 'modify-object', {
      targetId: agent.id,
      patch: { cannotDeliverClasses: [''] },
    });
    expect(bad.json().status).toBe('rejected');
    expect(bad.json().ruleCheck.issues.join(' ')).toContain('cannotDeliverClasses');
  });

  // T-610 (R26, RT26-F02): install-devices warns (never 422s) when a device
  // lands with no executable commands — POS-1 applied at low risk with
  // commands: [] and the dead-end was visible only by inspecting the row.
  it('T-610: zero-executable install carries the warning; executable mixed / hass:// exempt; warning rides the applied proposal', async () => {
    // POS-1 shape: telemetry-ish names nothing can dispatch.
    const deadEnd = await submitProposal(builder.token, 'install-devices', installPayload({
      devices: [
        {
          name: 'POS-1',
          type: 'pos-terminal',
          capabilities: ['log-sale', 'power-control'],
          zoneId: 'zone-a',
        },
      ],
    }));
    // Non-blocking: the proposal is NOT rejected.
    expect(deadEnd.json().status).not.toBe('rejected');
    const warnings = (deadEnd.json().ruleCheck.warnings as string[]).join(' ');
    expect(warnings).toContain('POS-1');
    expect(warnings).toContain('log-sale');
    expect(warnings).toContain('power-control');
    expect(warnings).toContain('commands: []');
    expect(warnings).toContain('handler-backed');

    // At least one executable capability → no warning for the device.
    const mixed = await submitProposal(builder.token, 'install-devices', installPayload({
      devices: [
        {
          name: 'Metered Switch',
          type: 'smart-plug',
          capabilities: ['energy-logging', 'turn-on'],
          zoneId: 'zone-a',
        },
      ],
    }));
    expect(mixed.json().status).not.toBe('rejected');
    // C2 note: the agent-BINDING hint legitimately names every capable
    // device — the T-610 silence here is about EXECUTABILITY only.
    expect(
      ((mixed.json().ruleCheck.warnings as string[]) ?? []).join(' '),
    ).not.toContain('none of its declared capabilities');
    expect(
      ((mixed.json().ruleCheck.warnings as string[]) ?? []).join(' '),
    ).not.toContain('commands: []');

    // hass://-bound devices are real hardware — exempt.
    const real = await submitProposal(builder.token, 'install-devices', installPayload({
      devices: [
        {
          name: 'Real Relay',
          type: 'relay',
          capabilities: ['vendor-proprietary-pulse'],
          zoneId: 'zone-a',
          binding: 'hass://relay_1',
        },
      ],
    }));
    expect(
      ((real.json().ruleCheck.warnings as string[]) ?? []).join(' '),
    ).not.toContain('none of its declared capabilities');

    // The warning rides the applied proposal (the deciding owner sees it).
    const applied = await decide(owner.token, deadEnd.json().id, 'approved');
    expect(applied.json().status).toBe('applied');
    expect(
      (applied.json().ruleCheck.warnings as string[]).join(' '),
    ).toContain('POS-1');
  });

  // C2 (R25-NF3, DevLoop R28): installing a device alone publishes nothing —
  // derived services mint only when an agent binds it (agent capabilities ∩
  // bound devices). The R25 provider story (device applied → no service → no
  // hint) gets the hint at install time, riding the T-610 warnings pattern.
  it('C2: install-devices warns the device has no bound agent (derived service mints on binding)', async () => {
    const proposal = await submitProposal(builder.token, 'install-devices', installPayload({
      devices: [
        { name: 'AQ Sensor', type: 'air-quality-sensor', capabilities: ['air-quality-reading'], zoneId: 'zone-a' },
      ],
    }));
    expect(proposal.json().status).not.toBe('rejected');
    const warnings = (proposal.json().ruleCheck.warnings as string[]).join(' ');
    expect(warnings).toContain('AQ Sensor');
    expect(warnings).toContain('no bound agent');
    expect(warnings).toContain('mints when an agent BINDS it');
    expect(warnings).toContain('POST /api/environments/:id/agents');
    expect(warnings).toContain('install-agents');

    // The hint rides the applied proposal too (the deciding owner sees it).
    const applied = await decide(owner.token, proposal.json().id, 'approved');
    expect(applied.json().status).toBe('applied');
    expect(
      (applied.json().ruleCheck.warnings as string[]).join(' '),
    ).toContain('no bound agent');

    // Zero-capability devices carry no binding hint (nothing to derive — the
    // T-610 no-capabilities teaching owns that case).
    const bare = await submitProposal(builder.token, 'install-devices', installPayload({
      devices: [{ name: 'Bare Beacon', type: 'beacon', capabilities: [], zoneId: 'zone-a' }],
    }));
    expect(
      (bare.json().ruleCheck.warnings as string[]).join(' '),
    ).not.toContain('Bare Beacon has no bound agent');
  });

  // C7 (T-089, SC26-F04 — DevLoop R28): single GET vs list shape parity.
  // The R26 probe claimed fields (status/kind) were missing on
  // GET /api/proposals/:id vs the env list; both routes serialize through
  // the SAME proposalToJson + youCanDecide — this pins that parity across
  // statuses (escalated, applied-with-createdIds, zone-claim-with-rationale)
  // so a serializer fork cannot regress silently.
  it('C7: single GET and the list entry serialize byte-identically (shape parity)', async () => {
    const ids: string[] = [];

    // (a) escalated install-devices (the default reviewer's verdict).
    const escalated = await submitProposal(builder.token, 'install-devices', installPayload());
    ids.push(escalated.json().id as string);

    // (b) applied install-devices — carries createdIds.devices.
    const applied = await submitProposal(builder.token, 'install-devices', installPayload({
      devices: [{ name: 'Parity HVAC', type: 'hvac', capabilities: ['cooling'], zoneId: 'zone-a' }],
    }));
    await decide(owner.token, applied.json().id as string, 'approved');
    ids.push(applied.json().id as string);

    // (c) zone-claim — carries the T-077 rationale field.
    const claim = await submitProposal(builder.token, 'zone-claim', {
      zoneId: 'zone-a',
      rationale: 'parity probe',
    });
    ids.push(claim.json().id as string);

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(owner.token),
    });
    expect(list.statusCode).toBe(200);
    for (const id of ids) {
      const single = await ctx.app.inject({
        method: 'GET',
        url: `/api/proposals/${id}`,
        headers: auth(owner.token),
      });
      expect(single.statusCode).toBe(200);
      const listRow = (list.json().proposals as Array<Record<string, unknown>>)
        .find(row => row.id === id);
      expect(listRow, `list carries ${id}`).toBeDefined();
      // Same keys AND same values — status/kind included by construction.
      expect(Object.keys(single.json()).sort()).toEqual(Object.keys(listRow!).sort());
      expect(single.json()).toEqual(listRow);
    }
  });

  it('install-agents rule check rejects bindings to devices the author does not own', async () => {
    // The OWNER's device — the builder may not bind it (设备私有原则).
    const ownersDevice = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Owner HVAC',
        type: 'hvac',
        capabilities: ['temperature-control'],
        zoneId: 'zone-a',
      },
    });
    const foreign = await submitProposal(builder.token, 'install-agents', {
      agents: [
        {
          name: 'Hijack Agent',
          capabilities: ['temperature-monitoring'],
          boundDeviceIds: [ownersDevice.json().id],
        },
      ],
    });
    expect(foreign.json().status).toBe('rejected');
    expect(foreign.json().ruleCheck.issues.join(' ')).toContain('owned by another user');

    const ghost = await submitProposal(builder.token, 'install-agents', {
      agents: [
        { name: 'Ghost Agent', capabilities: [], boundDeviceIds: ['ghost-device'] },
      ],
    });
    expect(ghost.json().status).toBe('rejected');
    expect(ghost.json().ruleCheck.issues.join(' ')).toContain('ghost-device');

    const malformed = await submitProposal(builder.token, 'install-agents', { agents: [] });
    expect(malformed.json().status).toBe('rejected');
  });

  it('install-agents inside the author\'s claimed zone auto-approves (§5.3)', async () => {
    // Grant the builder stewardship of zone-a.
    const claim = await submitProposal(builder.token, 'zone-claim', { zoneId: 'zone-a' });
    expect((await decide(owner.token, claim.json().id, 'approved')).json().status).toBe('applied');

    // The builder's device install auto-approves inside the claim…
    const deviceInstall = await submitProposal(builder.token, 'install-devices', installPayload());
    expect(deviceInstall.json().status).toBe('applied');
    const device = ctx.app.envStore.devicesOf(envId)[0];

    // …and so does the agent install whose footprint stays inside zone-a.
    const agentInstall = await submitProposal(builder.token, 'install-agents', {
      agents: [
        {
          name: 'Steward Agent',
          capabilities: ['temperature-monitoring'],
          boundDeviceIds: [device.id],
          managedZoneIds: ['zone-a'],
        },
      ],
    });
    expect(agentInstall.json().status).toBe('applied');
    expect(agentInstall.json().aiReview.source).toBe('zone-claim');
    expect(ctx.app.envStore.agentsOf(envId)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Fix-7: remove-devices
  // -------------------------------------------------------------------------

  it('remove-devices: full lifecycle (delete → revert restores the same row)', async () => {
    const device = await installBuilderDevice();

    const submitted = await submitProposal(builder.token, 'remove-devices', {
      deviceIds: [device.id],
    });
    const proposal = submitted.json();
    expect(proposal.status).toBe('escalated');

    const approved = await decide(owner.token, proposal.id, 'approved');
    expect(approved.json().status).toBe('applied');
    expect(ctx.app.envStore.getDevice(device.id)).toBeUndefined();

    const reverted = await revert(owner.token, proposal.id);
    expect(reverted.json().status).toBe('reverted');
    const restored = ctx.app.envStore.getDevice(device.id);
    expect(restored).toBeDefined();
    expect(restored!.owner_id).toBe(builder.id);
    expect(restored!.name).toBe(device.name);
    expect(restored!.created_at).toBe(device.created_at);
  });

  it('remove-devices rule check rejects foreign and agent-bound devices', async () => {
    const ownersDevice = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/devices`,
        headers: auth(owner.token),
        payload: {
          name: 'Owner HVAC',
          type: 'hvac',
          capabilities: ['temperature-control'],
          zoneId: 'zone-a',
        },
      })
    ).json();

    // Someone else's device → rejected.
    const foreign = await submitProposal(builder.token, 'remove-devices', {
      deviceIds: [ownersDevice.id],
    });
    expect(foreign.json().status).toBe('rejected');
    expect(foreign.json().ruleCheck.issues.join(' ')).toContain('owned by another user');

    // The builder's own device, but bound to their agent → rejected with an
    // unbind hint (removal never silently breaks bindings).
    const device = await installBuilderDevice();
    const agentInstall = await submitProposal(builder.token, 'install-agents', {
      agents: [
        {
          name: 'Binder',
          capabilities: ['temperature-monitoring'],
          boundDeviceIds: [device.id],
        },
      ],
    });
    expect((await decide(owner.token, agentInstall.json().id, 'approved')).json().status).toBe('applied');

    const bound = await submitProposal(builder.token, 'remove-devices', {
      deviceIds: [device.id],
    });
    expect(bound.json().status).toBe('rejected');
    expect(bound.json().ruleCheck.issues.join(' ')).toContain('unbind it first');
    expect(ctx.app.envStore.getDevice(device.id)).toBeDefined();
  });

  it('DELETE /api/devices/:id converts a builder\'s own-device delete into a remove-devices proposal', async () => {
    const device = await installBuilderDevice();

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/devices/${device.id}`,
      headers: auth(builder.token),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe('remove-devices');
    expect(res.json().status).toBe('escalated');
    expect(ctx.app.envStore.getDevice(device.id)).toBeDefined(); // not gone yet

    const approved = await decide(owner.token, res.json().id, 'approved');
    expect(approved.json().status).toBe('applied');
    expect(ctx.app.envStore.getDevice(device.id)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // T-209: remove-agents
  // -------------------------------------------------------------------------

  it('remove-agents: full lifecycle (delete → cascade services → revert restores rows verbatim)', async () => {
    const device = await installBuilderDevice();
    const agentInstall = await submitProposal(builder.token, 'install-agents', {
      agents: [
        { name: 'Doomed Agent', capabilities: ['temperature-monitoring'], boundDeviceIds: [device.id] },
      ],
    });
    await decide(owner.token, agentInstall.json().id, 'approved');
    const agent = ctx.app.envStore.agentsOf(envId).find(row => row.name === 'Doomed Agent')!;
    expect(agent).toBeDefined();
    expect(ctx.app.serviceStore.servicesOfAgent(agent.id).length).toBeGreaterThan(0);

    const submitted = await submitProposal(builder.token, 'remove-agents', {
      agentIds: [agent.id],
    });
    expect(submitted.json().status).toBe('escalated');

    const appliedProposal = await decide(owner.token, submitted.json().id, 'approved');
    expect(appliedProposal.json().status).toBe('applied');
    expect(ctx.app.envStore.getAgent(agent.id)).toBeUndefined();
    expect(ctx.app.serviceStore.servicesOfAgent(agent.id)).toHaveLength(0);

    const reverted = await revert(owner.token, submitted.json().id);
    expect(reverted.json().status).toBe('reverted');
    const restored = ctx.app.envStore.getAgent(agent.id);
    expect(restored).toBeDefined();
    expect(restored!.owner_id).toBe(builder.id);
    expect(restored!.name).toBe('Doomed Agent');
    expect(restored!.created_at).toBe(agent.created_at);
    expect(ctx.app.serviceStore.servicesOfAgent(agent.id).length).toBeGreaterThan(0);
  });

  it('remove-agents rule check rejects foreign agents and unknown ids', async () => {
    // An agent owned by the ENV OWNER is untouchable through the builder's pipeline.
    const ownersAgent = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/agents`,
        headers: auth(owner.token),
        payload: { name: 'Owner Agent', capabilities: [], boundDeviceIds: [] },
      })
    ).json();

    const foreign = await submitProposal(builder.token, 'remove-agents', {
      agentIds: [ownersAgent.id],
    });
    expect(foreign.json().status).toBe('rejected');
    expect(foreign.json().ruleCheck.issues.join(' ')).toContain('owned by another user');

    const ghost = await submitProposal(builder.token, 'remove-agents', {
      agentIds: ['ghost-agent'],
    });
    expect(ghost.json().status).toBe('rejected');
    expect(ghost.json().ruleCheck.issues.join(' ')).toContain('unknown agent');
  });

  it('remove-agents: agreement retire warned, unlinked, relinked on revert (T-049 + v60/R6-E-F08)', async () => {
    // Provider agent (builder) with a derived service; the viewer is the
    // consumer: an active agreement + a marketplace subscription on it.
    const device = await installBuilderDevice();
    const agentInstall = await submitProposal(builder.token, 'install-agents', {
      agents: [
        { name: 'Cascading Provider', capabilities: ['temperature-monitoring'], boundDeviceIds: [device.id] },
      ],
    });
    await decide(owner.token, agentInstall.json().id, 'approved');
    const agent = ctx.app.envStore.agentsOf(envId).find(row => row.name === 'Cascading Provider')!;
    const service = ctx.app.serviceStore.servicesOfAgent(agent.id).at(-1)!;
    expect(service).toBeDefined();

    const subscribed = await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${service.id}/subscribe`,
      headers: auth(viewer.token),
    });
    expect(subscribed.statusCode).toBe(201);

    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${service.id}/agreements`,
      headers: auth(viewer.token),
      payload: {},
    });
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(builder.token),
      payload: { decision: 'accept' },
    });
    expect(accepted.json().status).toBe('active');

    // Rule check names the blast radius BEFORE anything lands.
    const submitted = await submitProposal(builder.token, 'remove-agents', {
      agentIds: [agent.id],
    });
    const warnings = (submitted.json().ruleCheck.warnings as string[]).join(' ');
    expect(submitted.json().status).toBe('escalated');
    expect(warnings).toContain('RETIRES 1 service agreement');
    expect(warnings).toContain('1 still live');
    expect(warnings).toContain('marketplace subscription');

    // Apply (v60): the agreement is RETIRED (suspended + provider-unavailable)
    // and UNLINKED — never destroyed; the consumer owner is notified.
    const appliedProposal = await decide(owner.token, submitted.json().id, 'approved');
    expect(appliedProposal.json().status).toBe('applied');
    const retiredRow = ctx.app.agreementStore.getAgreement(agreementId);
    expect(retiredRow).toBeDefined();
    expect(retiredRow!.status).toBe('suspended');
    expect(retiredRow!.status_reason).toBe('provider-unavailable');
    expect(retiredRow!.service_id).toBeNull();
    expect(retiredRow!.provider_agent_id).toBeNull();

    const inbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(viewer.token),
    });
    const providerRemoved = (inbox.json().notifications as Array<{ kind: string; refId: string }>)
      .find(n => n.kind === 'agreement.provider-removed' && n.refId === agreementId);
    expect(providerRemoved).toBeDefined();

    // Revert: the agent + services come back by their ORIGINAL ids and the
    // agreement is RE-LINKED to them — but its status stays retired
    // (suspended; there is no suspended → active edge anywhere).
    const reverted = await revert(owner.token, submitted.json().id);
    expect(reverted.json().status).toBe('reverted');
    const restoredAgreement = ctx.app.agreementStore.getAgreement(agreementId);
    expect(restoredAgreement).toBeDefined();
    expect(restoredAgreement!.status).toBe('suspended');
    expect(restoredAgreement!.consumer_owner_id).toBe(viewer.id);
    expect(restoredAgreement!.provider_agent_id).toBe(agent.id);
    expect(restoredAgreement!.service_id).toBe(service.id);
  });

  it('DELETE /api/agents/:id converts a builder\'s own-agent delete into a remove-agents proposal', async () => {
    const device = await installBuilderDevice();
    const agentInstall = await submitProposal(builder.token, 'install-agents', {
      agents: [
        { name: 'Stub To Remove', capabilities: ['temperature-monitoring'], boundDeviceIds: [device.id] },
      ],
    });
    await decide(owner.token, agentInstall.json().id, 'approved');
    const agent = ctx.app.envStore.agentsOf(envId).find(row => row.name === 'Stub To Remove')!;

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/agents/${agent.id}`,
      headers: auth(builder.token),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe('remove-agents');
    expect(res.json().status).toBe('escalated');
    expect(ctx.app.envStore.getAgent(agent.id)).toBeDefined(); // not gone yet

    const approved = await decide(owner.token, res.json().id, 'approved');
    expect(approved.json().status).toBe('applied');
    expect(ctx.app.envStore.getAgent(agent.id)).toBeUndefined();

    // Someone else's agent stays a hard 403 (no proposal conversion).
    const ownersAgent = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/agents`,
        headers: auth(owner.token),
        payload: { name: 'Owner Agent 2', capabilities: [], boundDeviceIds: [] },
      })
    ).json();
    const forbidden = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/agents/${ownersAgent.id}`,
      headers: auth(builder.token),
    });
    expect(forbidden.statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Fix-10: createdIds on applied proposals
  // -------------------------------------------------------------------------

  it('install-devices: the applied response carries createdIds.devices matching the world', async () => {
    const submitted = await submitProposal(builder.token, 'install-devices', installPayload());
    expect(submitted.json().status).toBe('escalated');
    expect(submitted.json().createdIds).toBeUndefined(); // not applied yet

    const approved = await decide(owner.token, submitted.json().id, 'approved');
    expect(approved.json().status).toBe('applied');
    expect(approved.json().createdIds).toEqual({
      devices: [expect.any(String)],
    });
    // The ids are the world's devices — no follow-up list call needed.
    const envDevices = ctx.app.envStore.devicesOf(envId);
    expect(envDevices.map(d => d.id)).toEqual(approved.json().createdIds.devices);

    // The list endpoint serializes the same field.
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
    });
    const row = listed.json().proposals.find((p: { id: string }) => p.id === submitted.json().id);
    expect(row.createdIds).toEqual(approved.json().createdIds);
  });

  it('install-agents: the applied response carries createdIds.agents matching the world', async () => {
    const device = await installBuilderDevice();

    const submitted = await submitProposal(builder.token, 'install-agents', {
      agents: [
        {
          name: 'Corridor Brain',
          capabilities: ['temperature-monitoring'],
          boundDeviceIds: [device.id],
        },
      ],
    });
    const approved = await decide(owner.token, submitted.json().id, 'approved');
    expect(approved.json().status).toBe('applied');
    expect(approved.json().createdIds).toEqual({ agents: [expect.any(String)] });
    const envAgents = ctx.app.envStore.agentsOf(envId);
    expect(envAgents.map(a => a.id)).toEqual(approved.json().createdIds.agents);
  });

  it('non-creating kinds carry no createdIds even when applied', async () => {
    const device = await installBuilderDevice();

    const submitted = await submitProposal(builder.token, 'remove-devices', {
      deviceIds: [device.id],
    });
    const approved = await decide(owner.token, submitted.json().id, 'approved');
    expect(approved.json().status).toBe('applied');
    expect(approved.json().createdIds).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // T-206 — capability honesty at agent authoring
  // -------------------------------------------------------------------------

  describe('T-206: declared capabilities must be device-backed', () => {
    /** Builder-owned devices: an air-quality station + an HVAC unit. */
    async function builderDevices(): Promise<{ aqStationId: string; hvacId: string }> {
      const aq = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/devices`,
        headers: auth(owner.token),
        payload: {
          name: 'Air Quality Station', type: 'air-quality-sensor',
          capabilities: ['air-quality-reading', 'pm2_5-reading'], zoneId: 'zone-a',
        },
      });
      expect(aq.statusCode).toBe(201);
      const hvac = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/devices`,
        headers: auth(owner.token),
        payload: {
          name: 'Clinic HVAC', type: 'hvac',
          capabilities: ['temperature-control', 'cooling', 'turn-on'], zoneId: 'zone-a',
        },
      });
      expect(hvac.statusCode).toBe(201);
      return { aqStationId: aq.json().id as string, hvacId: hvac.json().id as string };
    }

    it('install-agents rejects an unbacked capability, naming it and the alternatives (HF-F02)', async () => {
      const { aqStationId } = await builderDevices();
      const res = await submitProposal(owner.token, 'install-agents', {
        agents: [{
          name: 'Health HVAC Agent',
          capabilities: ['hvac-control'],
          boundDeviceIds: [aqStationId],
          managedZoneIds: ['zone-a'],
        }],
      });
      // Rule-check rejections land as status 'rejected' + ruleCheck.issues
      // (the proposal route's convention), not a 422.
      expect(res.json().status).toBe('rejected');
      const issues = res.json().ruleCheck.issues.join(' ');
      expect(issues).toContain('"hvac-control"');
      expect(issues).toContain('not provided by any bound device');
      expect(issues).toContain('air-quality-reading');
      expect(issues).toContain('hass://');
    });

    it('install-agents accepts capabilities backed by bound devices', async () => {
      const { hvacId } = await builderDevices();
      const res = await submitProposal(owner.token, 'install-agents', {
        agents: [{
          name: 'Facility Agent',
          capabilities: ['temperature-control'],
          boundDeviceIds: [hvacId],
          managedZoneIds: ['zone-a'],
        }],
      });
      // Pending/escalated is fine — the RULE check passed (not 'rejected').
      expect(res.statusCode).toBe(201);
      expect(res.json().status).not.toBe('rejected');
    });

    it('an agent with no bound devices may declare no capabilities', async () => {
      const res = await submitProposal(owner.token, 'install-agents', {
        agents: [{ name: 'Bare Agent', capabilities: ['surveillance'], boundDeviceIds: [], managedZoneIds: ['zone-a'] }],
      });
      expect(res.json().status).toBe('rejected');
      expect(res.json().ruleCheck.issues.join(' ')).toContain('the agent has no bound devices');
    });

    // R98 (simtest-r1 wang-01/zhao-03): the rejection must teach the fix in
    // Chinese — the tutorial's pure-software play is create-deviceless-agent +
    // publish-service (⚠无支撑), NOT declaring unbacked capabilities.
    it('the deviceless rejection carries an actionable Chinese remedy (R98)', async () => {
      const res = await submitProposal(owner.token, 'install-agents', {
        agents: [{
          name: '实验室环境管家',
          capabilities: ['temperature-monitoring', 'co2-monitoring', 'ventilation', 'cooling'],
          boundDeviceIds: [],
          managedZoneIds: ['zone-a'],
        }],
      });
      expect(res.json().status).toBe('rejected');
      const issues = res.json().ruleCheck.issues.join(' ');
      expect(issues).toContain('修改建议');
      expect(issues).toContain('发布服务');
    });

    // R98: the tutorial's rewritten play — a deviceless agent with an EMPTY
    // capability list passes the rule check (publish-service is the
    // commitment lane for pure-software providers).
    it('a deviceless agent with an empty capability list is not rule-rejected (R98 tutorial play)', async () => {
      const res = await submitProposal(owner.token, 'install-agents', {
        agents: [{ name: '星夜出行运力中心', capabilities: [], boundDeviceIds: [], managedZoneIds: ['zone-a'] }],
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().status).not.toBe('rejected');
    });

    it('modify-object capability patches check the resulting bound set', async () => {
      const { aqStationId, hvacId } = await builderDevices();
      const install = await submitProposal(owner.token, 'install-agents', {
        agents: [{
          name: 'Air Agent',
          capabilities: ['air-quality-reading'],
          boundDeviceIds: [aqStationId],
          managedZoneIds: ['zone-a'],
        }],
      });
      expect(install.statusCode).toBe(201);
      // Approve so the agent lands in the world.
      const decided = await decide(owner.token, install.json().id, 'approved');
      expect(decided.json().status).toBe('applied');
      const agentId = ctx.app.envStore.agentsOf(envId).find(a => a.name === 'Air Agent')!.id;

      // Patching in an unbacked capability is rejected…
      const bad = await submitProposal(owner.token, 'modify-object', {
        targetId: agentId,
        patch: { capabilities: ['air-quality-reading', 'hvac-control'] },
      });
      expect(bad.json().status).toBe('rejected');
      expect(bad.json().ruleCheck.issues.join(' ')).toContain('"hvac-control"');

      // …but rebinding to the HVAC in the SAME patch backs it.
      const good = await submitProposal(owner.token, 'modify-object', {
        targetId: agentId,
        patch: { capabilities: ['air-quality-reading', 'hvac-control'], boundDeviceIds: [aqStationId, hvacId] },
      });
      expect(good.statusCode).toBe(201);
      expect(good.json().status).not.toBe('rejected');
    });

    it('hass://-bound devices are exempt (real hardware backs its declarations)', async () => {
      const hass = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/devices`,
        headers: auth(owner.token),
        payload: {
          name: 'Real Light', type: 'light',
          capabilities: ['turn-on'], zoneId: 'zone-a', binding: 'hass://light.living_room',
        },
      });
      expect(hass.statusCode).toBe(201);
      const res = await submitProposal(owner.token, 'install-agents', {
        agents: [{
          name: 'Light Keeper',
          capabilities: ['lighting-control'],
          boundDeviceIds: [hass.json().id as string],
          managedZoneIds: ['zone-a'],
        }],
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().status).not.toBe('rejected');
    });
  });

});

/**
 * Fix-12 timeout auto-approve policy, end to end: the review LLM is pointed
 * at a dead address (connection refused — a failed call, the same catch
 * branch as a timeout), the proposal is low-risk and passes the rule check,
 * so platform policy auto-approves it: applied immediately with the audit
 * marker, and the owner can still revert afterwards.
 */
describe('proposals — review-timeout auto-approve (Fix-12 policy)', () => {
  it('LLM failure + low-risk + ruleCheck.ok → applied with audit marker, owner can revert', async () => {
    const ctx = await makeTestApp({
      proposalReviewer: 'llm',
      // Nothing listens on port 1: the review call fails instantly.
      llmProvider: 'openai-compatible',
      llmBaseUrl: 'http://127.0.0.1:1/v1',
      llmModel: 'review-model',
      proposalReviewLlmTimeoutMs: 2000,
      // test-utils defaults this OFF (governance suites); this suite tests
      // the timeout policy itself — opt back into the production default.
      proposalReviewTimeoutAutoApprove: true,
    });
    try {
      const owner = await registerUser(ctx.app, { displayName: 'Owner' });
      const builder = await registerUser(ctx.app, { displayName: 'Builder' });
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(owner.token),
        payload: {
          name: 'Policy Lab',
          visibility: 'public',
          mapData: { zones: [{ id: 'zone-a' }] },
        },
      });
      const envId = created.json().id as string;
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/join`,
        headers: auth(builder.token),
      });

      const submitted = await ctx.app.inject({
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
      expect(submitted.statusCode).toBe(201);
      const proposal = submitted.json();
      expect(proposal.status).toBe('applied');
      expect(proposal.ruleCheck.ok).toBe(true);
      expect(proposal.aiReview.outcome).toBe('allow');
      expect(proposal.aiReview.source).toBe('review-timeout-auto-approve');
      expect(proposal.aiReview.reason).toContain('自动通过'); // T-063(e): localized audit note

      // The world actually changed (auto-approve goes through the same
      // apply path as any allow — including the applied WS broadcast).
      expect(ctx.app.envStore.devicesOf(envId)).toHaveLength(1);

      // The owner can still revert the auto-approved proposal.
      const reverted = await ctx.app.inject({
        method: 'POST',
        url: `/api/proposals/${proposal.id}/revert`,
        headers: auth(owner.token),
      });
      expect(reverted.statusCode).toBe(200);
      expect(reverted.json().status).toBe('reverted');
      expect(ctx.app.envStore.devicesOf(envId)).toHaveLength(0);
    } finally {
      await ctx.cleanup();
    }
  });

});
