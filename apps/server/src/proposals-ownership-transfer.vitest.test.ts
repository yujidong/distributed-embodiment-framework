/**
 * @vitest-environment node
 *
 * ownership-transfer proposal suites (C3, R42-B — devloop-r41-a1 §8):
 * the governance-plane ownership handover that fixes D2-F8 / R41-F5 —
 * template imports land every agent/device on the importer, so members hit
 * "owned by another user" rejections and 403s naming their own agents as
 * agreement consumers. Covered: the funnel (submit → forced escalation →
 * owner decide → applied), the apply semantics (owner_id columns + bound
 * devices), revert (reverse transfer), the submitter/toUser gates, the
 * members-plan claim path, the boundary (provider_agent_id/reputation
 * untouched), and the R41-F5 reproduction path going green.
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

describe('ownership-transfer proposals (C3, R42-B)', () => {
  let ctx: TestAppContext;
  let owner: TestUser; // env owner + importer (owns every imported object)
  let member: TestUser; // builder member — the claimant / recipient
  let viewer: TestUser; // viewer member — never a valid toUser
  let outsider: TestUser; // registered, NOT a member — never a valid toUser
  let envId: string;
  let labAgentId: string;
  let sensorId: string;
  let hvacId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    member = await registerUser(ctx.app, { displayName: 'Member' });
    viewer = await registerUser(ctx.app, { displayName: 'Viewer' });
    outsider = await registerUser(ctx.app, { displayName: 'Outsider' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('ownership-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    const agents = created.json().agents as Array<{ id: string; name: string }>;
    labAgentId = agents.find(agent => agent.name === 'Lab Agent')!.id;
    const devices = created.json().devices as Array<{ id: string; name: string }>;
    sensorId = devices.find(device => device.name === 'Sensor A')!.id;
    hvacId = devices.find(device => device.name === 'HVAC B')!.id;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(member.token),
    });
    ctx.app.envStore.addMember(envId, viewer.id, 'viewer');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function submit(
    token: string,
    transfers: Array<Record<string, unknown>>,
  ) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(token),
      payload: { kind: 'ownership-transfer', payload: { transfers } },
    });
  }

  /** Submit (as `author`) → decide (as owner) → applied proposal id. */
  async function approveTransfer(
    author: TestUser,
    transfers: Array<Record<string, unknown>>,
  ): Promise<{ proposalId: string; submitted: Record<string, any>; decided: Record<string, any> }> {
    const submitted = await submit(author.token, transfers);
    expect(submitted.statusCode).toBe(201);
    const row = submitted.json();
    expect(row.status).toBe('escalated');
    expect(row.riskLevel).toBe('medium');
    expect(row.ruleCheck.forceEscalate).toBe(true);
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${row.id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('applied');
    return { proposalId: row.id, submitted: row, decided: decided.json() };
  }

  function agentRow(id: string) {
    return ctx.app.envStore.getAgent(id)!;
  }
  function deviceRow(id: string) {
    return ctx.app.envStore.getDevice(id)!;
  }

  // -------------------------------------------------------------------------
  // The funnel + apply semantics
  // -------------------------------------------------------------------------

  it('always escalates at medium risk and applies the owner handover (agent + bound devices)', async () => {
    await approveTransfer(owner, [
      { kind: 'agent', id: labAgentId, toUser: member.email, devices: 'bound' },
    ]);
    // 归属变更生效: agent + carried bound devices now belong to the member.
    expect(agentRow(labAgentId).owner_id).toBe(member.id);
    expect(deviceRow(sensorId).owner_id).toBe(member.id);
    expect(deviceRow(hvacId).owner_id).toBe(member.id);
  });

  it("devices:'keep' moves only the agent — the bound devices stay with the current owner", async () => {
    await approveTransfer(owner, [
      { kind: 'agent', id: labAgentId, toUser: member.id, devices: 'keep' },
    ]);
    expect(agentRow(labAgentId).owner_id).toBe(member.id);
    expect(deviceRow(sensorId).owner_id).toBe(owner.id);
    expect(deviceRow(hvacId).owner_id).toBe(owner.id);
  });

  it('transfers standalone devices (userId recipient)', async () => {
    await approveTransfer(owner, [
      { kind: 'device', id: hvacId, toUser: member.id },
    ]);
    expect(deviceRow(hvacId).owner_id).toBe(member.id);
  });

  it('is governance-plane only: provider_agent_id + service rows untouched, command_log carries before/after', async () => {
    const servicesBefore = ctx.app.serviceStore
      .servicesOfAgent(labAgentId)
      .map(row => ({ id: row.id, provider: row.provider_agent_id }));
    expect(servicesBefore.length).toBeGreaterThan(0);

    await approveTransfer(owner, [
      { kind: 'agent', id: labAgentId, toUser: member.id, devices: 'keep' },
    ]);

    // §8.4 boundary: derived services keep pointing at the SAME provider agent.
    const servicesAfter = ctx.app.serviceStore
      .servicesOfAgent(labAgentId)
      .map(row => ({ id: row.id, provider: row.provider_agent_id }));
    expect(servicesAfter).toEqual(servicesBefore);

    // command_log: the apply entry records the previous owner (revert source).
    const log = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log`,
      headers: auth(owner.token),
    });
    const entry = (log.json().entries as Array<{ kind: string; payload: Record<string, any> }>)
      .find(item => item.kind === 'ownership-transfer');
    expect(entry).toBeTruthy();
    expect(entry!.payload.after.transfers[0]).toMatchObject({
      kind: 'agent',
      id: labAgentId,
      fromUserId: owner.id,
      toUserId: member.id,
      devices: 'keep',
    });
  });

  it('revert restores every recorded owner (reverse transfer)', async () => {
    await approveTransfer(owner, [
      { kind: 'agent', id: labAgentId, toUser: member.email, devices: 'bound' },
      { kind: 'device', id: sensorId, toUser: member.email },
    ]);
    expect(agentRow(labAgentId).owner_id).toBe(member.id);

    const reverted = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${(await lastProposalId('applied'))}/revert`,
      headers: auth(owner.token),
    });
    expect(reverted.statusCode).toBe(200);
    expect(reverted.json().status).toBe('reverted');
    expect(agentRow(labAgentId).owner_id).toBe(owner.id);
    expect(deviceRow(sensorId).owner_id).toBe(owner.id);
    expect(deviceRow(hvacId).owner_id).toBe(owner.id);
  });

  async function lastProposalId(status: string): Promise<string> {
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/proposals?status=${status}`,
      headers: auth(owner.token),
    });
    const rows = list.json().proposals as Array<{ id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    return rows[0].id;
  }

  // -------------------------------------------------------------------------
  // Rule-check gates
  // -------------------------------------------------------------------------

  it('rejects a non-holder member transferring the owner\'s object (importer plan)', async () => {
    const res = await submit(member.token, [
      { kind: 'agent', id: labAgentId, toUser: member.email },
    ]);
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('rejected');
    expect(res.json().ruleCheck.issues.join(' ')).toMatch(/only the environment owner or the current holder/i);
  });

  it('rejects transfers to non-members and viewer members (builder+ gate)', async () => {
    const toOutsider = await submit(owner.token, [
      { kind: 'agent', id: labAgentId, toUser: outsider.email },
    ]);
    expect(toOutsider.json().status).toBe('rejected');
    expect(toOutsider.json().ruleCheck.issues.join(' ')).toMatch(/not a member of this environment/);

    const toViewer = await submit(owner.token, [
      { kind: 'device', id: hvacId, toUser: viewer.id },
    ]);
    expect(toViewer.json().status).toBe('rejected');
    expect(toViewer.json().ruleCheck.issues.join(' ')).toMatch(/a viewer member/);
  });

  it('rejects unknown recipients, no-op transfers, and malformed device options', async () => {
    const unknown = await submit(owner.token, [
      { kind: 'agent', id: labAgentId, toUser: 'ghost@example.com' },
    ]);
    expect(unknown.json().status).toBe('rejected');
    expect(unknown.json().ruleCheck.issues.join(' ')).toMatch(/does not match any registered user/);

    const noOp = await submit(owner.token, [
      { kind: 'agent', id: labAgentId, toUser: owner.id },
    ]);
    expect(noOp.json().status).toBe('rejected');
    expect(noOp.json().ruleCheck.issues.join(' ')).toMatch(/already belongs to/);

    const deviceWithBound = await submit(owner.token, [
      { kind: 'device', id: hvacId, toUser: member.id, devices: 'bound' },
    ]);
    expect(deviceWithBound.json().status).toBe('rejected');
    expect(deviceWithBound.json().ruleCheck.issues.join(' ')).toMatch(/only valid on agent transfers/);

    const badMode = await submit(owner.token, [
      { kind: 'agent', id: labAgentId, toUser: member.id, devices: 'take-all' },
    ]);
    expect(badMode.json().status).toBe('rejected');
    expect(badMode.json().ruleCheck.issues.join(' ')).toMatch(/"bound" \| "keep"/);
  });

  it('rejects duplicates, unknown targets, and empty transfer lists at the rule check', async () => {
    const dup = await submit(owner.token, [
      { kind: 'device', id: hvacId, toUser: member.id },
      { kind: 'device', id: hvacId, toUser: member.id },
    ]);
    expect(dup.json().status).toBe('rejected');
    expect(dup.json().ruleCheck.issues.join(' ')).toMatch(/appears twice/);

    const missing = await submit(owner.token, [
      { kind: 'agent', id: 'no-such-agent', toUser: member.id },
    ]);
    expect(missing.json().status).toBe('rejected');

    const empty = await submit(owner.token, []);
    expect(empty.statusCode).toBe(201);
    expect(empty.json().status).toBe('rejected');
    expect(empty.json().ruleCheck.issues.join(' ')).toMatch(/non-empty array/);
  });

  it('keeps the author gate: viewers and strangers cannot even submit', async () => {
    expect((await submit(viewer.token, [{ kind: 'agent', id: labAgentId, toUser: viewer.id }])).statusCode).toBe(403);
    expect((await submit(outsider.token, [{ kind: 'agent', id: labAgentId, toUser: outsider.id }])).statusCode).toBe(403);
  });

  it('lets the CURRENT HOLDER give an object away (not just the env owner)', async () => {
    await approveTransfer(owner, [
      { kind: 'agent', id: labAgentId, toUser: member.email, devices: 'keep' },
    ]);
    // The member now holds the agent and may hand it to... the owner back.
    const back = await submit(member.token, [
      { kind: 'agent', id: labAgentId, toUser: owner.email },
    ]);
    expect(back.statusCode).toBe(201);
    expect(back.json().status).toBe('escalated');
  });

  // -------------------------------------------------------------------------
  // Members-plan import + the claim path (§8.3)
  // -------------------------------------------------------------------------

  describe('members-plan worlds', () => {
    it('stamps governance.ownershipPlan on import and surfaces it on the detail', async () => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(owner.token),
        payload: {
          ...importableScenario('members-lab'),
          visibility: 'public',
          ownershipPlan: 'members',
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().governance.ownershipPlan).toBe('members');
      expect(created.json().governance.ownershipPlanNote).toMatch(/claim/i);

      // Default import stays 'importer'.
      const plain = await ctx.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(owner.token),
        payload: importableScenario('importer-lab'),
      });
      expect(plain.statusCode).toBe(201);
      expect(plain.json().governance.ownershipPlan).toBe('importer');
    });

    it('400s on a typo\'d plan instead of silently dropping it', async () => {
      const bad = await ctx.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(owner.token),
        payload: { ...importableScenario('bad-plan-lab'), ownershipPlan: 'everyone' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.message).toMatch(/"importer" \| "members"/);
    });

    it('lets a builder member CLAIM an unassigned agent (proposal-gated) and go green on R41-F5', async () => {
      // Flip the world to members mode (owner PATCH lane) — proves the
      // non-import authoring path too.
      const mapData = JSON.parse(ctx.app.envStore.getEnvironment(envId)!.map_data_json) as {
        zones: unknown[];
      };
      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/environments/${envId}`,
        headers: auth(owner.token),
        payload: {
          mapData: { ...mapData, governance: { ownershipPlan: 'members' } },
        },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().governance.ownershipPlan).toBe('members');

      // R41-F5 RED: the member cannot yet name the (owner-owned) agent as an
      // agreement consumer — 403.
      const services = await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/services`,
        headers: auth(member.token),
      });
      const labService = (services.json().services as Array<{ id: string; name: string; provider: { id: string } }>)
        .find(service => service.provider.id === labAgentId)!;
      const forbidden = await ctx.app.inject({
        method: 'POST',
        url: `/api/services/${labService.id}/agreements`,
        headers: auth(member.token),
        payload: { consumerAgentId: labAgentId },
      });
      expect(forbidden.statusCode).toBe(403);

      // CLAIM: member submits (self as toUser) → escalate → owner decides.
      await approveTransfer(member, [
        { kind: 'agent', id: labAgentId, toUser: member.email, devices: 'keep' },
      ]);
      expect(agentRow(labAgentId).owner_id).toBe(member.id);

      // R41-F5 GREEN: the same propose now passes the consumer-agent gate.
      const ok = await ctx.app.inject({
        method: 'POST',
        url: `/api/services/${labService.id}/agreements`,
        headers: auth(member.token),
        payload: { consumerAgentId: labAgentId },
      });
      expect(ok.statusCode).toBe(201);
    });

    it('a claim naming anyone but the submitter stays rejected (no proxy claims)', async () => {
      await ctx.app.envStore.updateEnvironment(envId, {
        mapData: {
          ...JSON.parse(ctx.app.envStore.getEnvironment(envId)!.map_data_json),
          governance: { ownershipPlan: 'members' },
        },
      });
      // toUser = another builder member (valid recipient) but the submitter
      // is neither the env owner nor the current holder — a members-plan
      // claim must name the CLAIMANT themselves.
      ctx.app.envStore.addMember(envId, outsider.id, 'builder');
      const proxy = await submit(member.token, [
        { kind: 'agent', id: labAgentId, toUser: outsider.email },
      ]);
      expect(proxy.json().status).toBe('rejected');
      expect(proxy.json().ruleCheck.issues.join(' ')).toMatch(/only the environment owner or the current holder/);
    });
  });

  // -------------------------------------------------------------------------
  // The install-agents binding 403 goes green (D2-F8 reproduction)
  // -------------------------------------------------------------------------

  it('after a devices:"bound" claim the member binds the carried devices to a NEW agent without the foreign-device rejection', async () => {
    // RED: with the devices still owner-owned, the member's install-agents
    // proposal is rule-check REJECTED ("owned by another user").
    const before = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(member.token),
      payload: {
        kind: 'install-agents',
        payload: {
          agents: [{
            name: 'Member Agent',
            capabilities: ['cooling'],
            boundDeviceIds: [hvacId],
          }],
        },
      },
    });
    expect(before.json().status).toBe('rejected');
    expect(before.json().ruleCheck.issues.join(' ')).toMatch(/owned by another user/);

    // Claim the agent WITH its bound devices.
    await approveTransfer(owner, [
      { kind: 'agent', id: labAgentId, toUser: member.email, devices: 'bound' },
    ]);
    expect(deviceRow(hvacId).owner_id).toBe(member.id);

    // GREEN: the same proposal passes the rule check now (escalates for the
    // owner as usual — the point is it is NOT rejected).
    const after = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(member.token),
      payload: {
        kind: 'install-agents',
        payload: {
          agents: [{
            name: 'Member Agent',
            capabilities: ['cooling'],
            boundDeviceIds: [hvacId],
          }],
        },
      },
    });
    expect(after.statusCode).toBe(201);
    expect(after.json().status).not.toBe('rejected');
    expect(after.json().ruleCheck.ok).toBe(true);
  });
});
