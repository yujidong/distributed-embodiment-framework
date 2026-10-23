/**
 * @vitest-environment node
 *
 * T-058a (DevLoop R14, design-consent-semantics.md §3) — supervised zones:
 * zone consentClass metadata (owner-authored via mapData), the
 * proposalConsentFootprint gate (install-* / inject-scenario / modify-object /
 * zone-claim), force-escalation with AI as ADVISOR, and the derived
 * governance block on env detail.
 *
 * The headline replay is FR-F05: a family member installing hardware into a
 * care facility's ward. With the auto-approve policy ON (the exact condition
 * under which the original finding fired — AI "semantic consistency"
 * auto-applied in seconds), a supervised ward still escalates to the
 * facility owner; the same proposal in a standard zone auto-applies.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, makeTestApp, registerUser, type TestAppContext, type TestUser } from './test-utils.js';

describe('T-058a supervised zones (consent semantics §3)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let family: TestUser;
  let envId: string;

  beforeEach(async () => {
    // proposalReviewTimeoutAutoApprove: true = the platform AUTO-APPLIES
    // low-risk proposals when the reviewer is unavailable — the strongest
    // baseline: the supervised gate must hold even under auto-approve.
    ctx = await makeTestApp({ proposalReviewTimeoutAutoApprove: true });
    owner = await registerUser(ctx.app, { displayName: 'Facility Owner' });
    family = await registerUser(ctx.app, { displayName: 'Family Member' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Eldercare Facility',
        visibility: 'public',
        mapData: {
          zones: [
            { id: 'ward-101', consentClass: 'supervised' },
            { id: 'ward-102', consentClass: 'supervised' },
            { id: 'hall', consentClass: 'standard' },
          ],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(family.token),
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function submit(token: string, kind: string, payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(token),
      payload: { kind, payload },
    });
  }

  function wardDevices(zoneId: string, count = 1) {
    return Array.from({ length: count }, (_, i) => ({
      name: `Ward Device ${i + 1}`,
      type: 'camera',
      capabilities: ['motion-detection'],
      zoneId,
    }));
  }

  // -----------------------------------------------------------------------
  // §3.1 zone consentClass metadata (mapData authoring + validation)
  // -----------------------------------------------------------------------

  it('creates zones with consentClass via mapData and validates the enum', async () => {
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(family.token),
    });
    const zones = detail.json().zones as Array<{ id: string; consentClass?: string }>;
    expect(zones.find(z => z.id === 'ward-102')?.consentClass).toBe('supervised');
    expect(zones.find(z => z.id === 'hall')?.consentClass).toBe('standard');

    // Typo → 400 teaching error (a silent 'standard' fallback would keep
    // auto-applying installs into a ward someone MEANT to supervise).
    const bad = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: {
        mapData: {
          zones: [
            { id: 'ward-101', consentClass: 'supervised' },
            { id: 'ward-102', consentClass: 'supervised' },
            { id: 'hall', consentClass: 'supervized' },
          ],
        },
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain('consentClass');
    expect(bad.json().error.message).toContain('supervised');

    // Owner can mark a zone supervised after the fact (mapData PATCH is the
    // authoring channel — FR-F02 owner-only).
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: {
        mapData: {
          zones: [
            { id: 'ward-101', consentClass: 'supervised' },
            { id: 'ward-102', consentClass: 'supervised' },
            { id: 'hall' },
          ],
        },
      },
    });
    expect(patched.statusCode).toBe(200);
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    expect(after.json().zones.find((z: { id: string }) => z.id === 'hall').consentClass).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // §3.2 the gate — supervised footprint forces escalation
  // -----------------------------------------------------------------------

  it('FR-F05 replay: install-devices in a supervised ward escalates even under auto-approve', async () => {
    const submitted = await submit(family.token, 'install-devices', { devices: wardDevices('ward-102', 2) });
    expect(submitted.statusCode).toBe(201);
    const proposal = submitted.json();
    // NOT applied: the consent gate held under the auto-approve policy.
    expect(proposal.status).toBe('escalated');
    expect(proposal.ruleCheck.forceEscalate).toBe(true);
    expect(proposal.ruleCheck.escalateReason).toContain("supervised");
    expect(proposal.ruleCheck.escalateReason).toContain("'ward-102'");

    // The owner is notified (the existing escalation channel).
    const notifications = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(owner.token),
    });
    expect(
      notifications.json().notifications.some(
        (n: { kind: string; refId: string }) =>
          n.kind === 'proposal.escalated' && n.refId === proposal.id,
      ),
    ).toBe(true);

    // Owner decides: approve applies the install (human consent).
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('applied');
    const devices = ctx.app.envStore.devicesOf(envId);
    expect(devices.filter(d => d.zone_id === 'ward-102')).toHaveLength(2);
  });

  it('FR-F05 control: the same proposal in a standard zone auto-applies (regression guard)', async () => {
    const submitted = await submit(family.token, 'install-devices', { devices: wardDevices('hall') });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().status).toBe('applied');
    expect(submitted.json().ruleCheck.forceEscalate).toBe(false);
  });

  it('install-agents managing a supervised zone escalates (footprint via managed zones)', async () => {
    const submitted = await submit(family.token, 'install-agents', {
      agents: [{ name: 'Ward Watcher', capabilities: [], managedZoneIds: ['ward-101'] }],
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().status).toBe('escalated');
    expect(submitted.json().ruleCheck.escalateReason).toContain("'ward-101'");
  });

  it('install-agents in a standard zone keeps the auto-apply baseline', async () => {
    const submitted = await submit(family.token, 'install-agents', {
      agents: [{ name: 'Hall Watcher', capabilities: [], managedZoneIds: ['hall'] }],
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().status).toBe('applied');
  });

  it('inject-scenario events in a supervised zone escalate (event zone footprint)', async () => {
    const submitted = await submit(family.token, 'inject-scenario', {
      events: [{ id: 'drill', type: 'occupancy', zoneId: 'ward-101', parameter: 'headcount', value: 3 }],
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().status).toBe('escalated');
    expect(submitted.json().ruleCheck.escalateReason).toContain("'ward-101'");
  });

  it('modify-object moving a device INTO a supervised zone escalates (patch zone change)', async () => {
    // Seed a family-owned device in the standard hall first (auto-applies).
    const seeded = await submit(family.token, 'install-devices', { devices: wardDevices('hall') });
    expect(seeded.json().status).toBe('applied');
    const deviceId = ctx.app.envStore.devicesOf(envId).find(d => d.zone_id === 'hall')!.id;

    const submitted = await submit(family.token, 'modify-object', {
      targetId: deviceId,
      patch: { zoneId: 'ward-102' },
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().status).toBe('escalated');
    expect(submitted.json().ruleCheck.escalateReason).toContain("'ward-102'");
  });

  it('modify-object rebinding an agent onto a supervised-ward device escalates (FR-F05 rebind shape)', async () => {
    // Facility owner installs a bed camera in ward-102 directly (owner route).
    const ownerDevice = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Bed Camera', type: 'camera', capabilities: ['motion-detection'], zoneId: 'ward-102' },
    });
    expect(ownerDevice.statusCode).toBe(201);
    const deviceId = ownerDevice.json().id;
    // Family seeds their own agent + device in the hall (auto-applies).
    const seeded = await submit(family.token, 'install-devices', { devices: wardDevices('hall') });
    expect(seeded.json().status).toBe('applied');
    const familyDeviceId = ctx.app.envStore.devicesOf(envId).find(d => d.zone_id === 'hall')!.id;
    const agent = await submit(family.token, 'install-agents', {
      agents: [{
        name: 'Family Agent',
        capabilities: [],
        boundDeviceIds: [familyDeviceId],
      }],
    });
    expect(agent.json().status).toBe('applied');
    const agentId = ctx.app.envStore.agentsOf(envId).find(a => a.owner_id === family.id)!.id;

    // Rebinding onto the facility's ward device: the patch's bound-device
    // zone (ward-102) is in the consent footprint — even though the agent
    // itself carries no zone. 设备私有 rejects FOREIGN devices, so this is
    // expressed through the footprint rule only when allowed — here the
    // device is foreign and the rule-check rejection fires FIRST. To probe
    // the footprint, the family must own a device in the ward: install one
    // (escalated → owner approves), then rebind.
    expect(agentId).toBeTruthy();
    const rebinding = await submit(family.token, 'modify-object', {
      targetId: agentId,
      patch: { boundDeviceIds: [deviceId] },
    });
    // Foreign device → 设备私有 rejection wins (footprint never reached).
    expect(rebinding.statusCode).toBe(201);
    expect(rebinding.json().status).toBe('rejected');

    // The consent-governed path: family gets their OWN ward device in first.
    const wardInstall = await submit(family.token, 'install-devices', { devices: wardDevices('ward-102') });
    expect(wardInstall.json().status).toBe('escalated');
    await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${wardInstall.json().id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    const familyWardDevice = ctx.app
      .envStore.devicesOf(envId)
      .find(d => d.zone_id === 'ward-102' && d.owner_id === family.id)!;
    const rebind = await submit(family.token, 'modify-object', {
      targetId: agentId,
      patch: { boundDeviceIds: [familyWardDevice.id] },
    });
    expect(rebind.statusCode).toBe(201);
    expect(rebind.json().status).toBe('escalated');
    expect(rebind.json().ruleCheck.escalateReason).toContain("'ward-102'");
  });

  it('zone-claim on a supervised zone names BOTH rules (supervised + §5.3)', async () => {
    const submitted = await submit(family.token, 'zone-claim', { zoneId: 'ward-101' });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().status).toBe('escalated');
    const reason = submitted.json().ruleCheck.escalateReason as string;
    expect(reason).toContain("'ward-101'");
    expect(reason).toContain('supervised');
    expect(reason).toContain('§5.3');
  });

  it('a hass:// binding AND a supervised zone stack — each reason names itself (T-302)', async () => {
    const submitted = await submit(family.token, 'install-devices', {
      devices: [{
        name: 'Real Hardware',
        type: 'camera',
        capabilities: ['motion-detection'],
        zoneId: 'ward-102',
        binding: 'hass://real.camera.ward102',
      }],
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().status).toBe('escalated');
    const reason = submitted.json().ruleCheck.escalateReason as string;
    expect(reason).toContain('hass://');
    expect(reason).toContain("'ward-102'");
  });

  // -----------------------------------------------------------------------
  // §3.3 the derived governance block (T-309 → T-058a)
  // -----------------------------------------------------------------------

  it('env detail derives supervisedZones from the map data (visible before installing)', async () => {
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(family.token),
    });
    const governance = detail.json().governance as {
      proposalReview: string;
      notes: string;
      supervisedZones: Array<{ zoneId: string; consentClass: string }>;
      supervisedZoneNote: string;
    };
    // T-309 fields unchanged (the honest description stays).
    expect(governance.proposalReview).toBe('ai-assisted-auto-apply');
    expect(governance.notes).toContain('auto-applied');
    // T-058a derivation.
    expect(governance.supervisedZones.map(z => z.zoneId).sort()).toEqual(['ward-101', 'ward-102']);
    expect(governance.supervisedZoneNote).toContain('never auto-applies');
  });

  it('an env without supervised zones lists an empty gate (T-309 shape preserved)', async () => {
    const plain = await registerUser(ctx.app);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(plain.token),
      payload: { name: 'Plain World', mapData: { zones: [{ id: 'room-1' }] } },
    });
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${created.json().id}`,
      headers: auth(plain.token),
    });
    const governance = detail.json().governance as { supervisedZones: unknown[] };
    expect(governance.supervisedZones).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Scenario JSON channel (four-channel consistency)
  // -----------------------------------------------------------------------

  it('scenario zones carry consentClass into the imported environment', async () => {
    // The import path: POST /api/environments with a full scenario JSON body.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        meta: { id: 'clinic', name: 'Clinic' },
        zones: [
          { id: 'exam-room', consentClass: 'supervised', adjacentZoneIds: ['lobby'] },
          { id: 'lobby', adjacentZoneIds: ['exam-room'] },
        ],
        devices: [],
        agents: [],
        events: [],
      },
    });
    expect(created.statusCode).toBe(201);
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${created.json().id}`,
      headers: auth(owner.token),
    });
    const zones = detail.json().zones as Array<{ id: string; consentClass?: string }>;
    expect(zones.find(z => z.id === 'exam-room')?.consentClass).toBe('supervised');
    const governance = detail.json().governance as { supervisedZones: Array<{ zoneId: string }> };
    expect(governance.supervisedZones).toEqual([{ zoneId: 'exam-room', consentClass: 'supervised' }]);
  });

  // -----------------------------------------------------------------------
  // R15 (CP-F01/DB-F01/FR15-F01) — arming the gate on the zone-create
  // channel: the bootstrap path POST /zones used to SILENTLY DROP
  // consentClass, so a ward named "(supervised)" was never actually
  // supervised and third-party installs auto-applied all round.
  // -----------------------------------------------------------------------

  it('R15: owner arms consentClass on POST /zones → governance lists it → touching installs escalate (FR-F05 replay BLOCKED)', async () => {
    // Fresh env WITHOUT supervised zones (the R15 bootstrap shape).
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Harbor Care Home',
        visibility: 'public',
        mapData: { zones: [{ id: 'lobby' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    const harborEnv = created.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${harborEnv}/join`,
      headers: auth(family.token),
    });
    const before = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${harborEnv}`,
      headers: auth(family.token),
    });
    expect((before.json().governance as { supervisedZones: unknown[] }).supervisedZones).toEqual([]);

    // The owner creates the ward WITH its consent class — same channel the
    // R15 bootstrap used, which silently dropped the field.
    const zone = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${harborEnv}/zones`,
      headers: auth(owner.token),
      payload: { id: 'ward-101', name: 'Ward 101 (supervised)', consentClass: 'supervised' },
    });
    expect(zone.statusCode).toBe(201);
    expect(zone.json().consentClass).toBe('supervised');

    // The buyer-visible signal flips: the governance block lists the ward.
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${harborEnv}`,
      headers: auth(family.token),
    });
    const governance = after.json().governance as {
      supervisedZones: Array<{ zoneId: string; consentClass: string }>;
    };
    expect(governance.supervisedZones).toEqual([{ zoneId: 'ward-101', consentClass: 'supervised' }]);

    // The exact FR-F05 replay (family hardware into the ward) now BLOCKS:
    // escalated, not auto-applied — even under the auto-approve policy.
    const submitted = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${harborEnv}/proposals`,
      headers: auth(family.token),
      payload: {
        kind: 'install-devices',
        payload: { devices: wardDevices('ward-101') },
      },
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().status).toBe('escalated');
    expect(submitted.json().ruleCheck.forceEscalate).toBe(true);
    expect(submitted.json().ruleCheck.escalateReason).toContain("'ward-101'");
  });

  it('R15: a builder arming consentClass via POST /zones is rejected with a teaching error (never silently dropped)', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Plain Home', visibility: 'public', mapData: { zones: [{ id: 'lobby' }] } },
    });
    const plainEnv = created.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${plainEnv}/join`,
      headers: auth(family.token),
    });

    const rejected = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${plainEnv}/zones`,
      headers: auth(family.token),
      payload: { id: 'ward-202', consentClass: 'supervised' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('CONSENT_CLASS_NOT_PROPOSABLE');
    const message = rejected.json().error.message as string;
    expect(message).toContain('owner');
    expect(message).toContain('mapData');
    // Nothing landed — the ward does not exist.
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${plainEnv}`,
      headers: auth(owner.token),
    });
    expect(after.json().zones).toEqual([{ id: 'lobby' }]);
  });

  it('R15: an install-zones PROPOSAL carrying consentClass is rule-check rejected with the same teaching', async () => {
    const submitted = await submit(family.token, 'install-zones', {
      zones: [{ id: 'ward-202', consentClass: 'supervised' }],
    });
    expect(submitted.statusCode).toBe(201);
    const proposal = submitted.json();
    expect(proposal.status).toBe('rejected');
    const issues = (proposal.ruleCheck.issues ?? []) as string[];
    expect(issues.some(issue => issue.includes('consentClass') && issue.includes('owner'))).toBe(true);
  });

  it('R15: owner POST /zones with an invalid consentClass lists the enum (no silent standard fallback)', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Typo Home', visibility: 'public', mapData: { zones: [{ id: 'lobby' }] } },
    });
    const typoEnv = created.json().id as string;
    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${typoEnv}/zones`,
      headers: auth(owner.token),
      payload: { id: 'ward-202', consentClass: 'supervized' },
    });
    expect(bad.statusCode).toBe(400);
    const message = bad.json().error.message as string;
    expect(message).toContain('"standard" | "supervised" | "restricted"');
    expect(message).toContain('supervized');
  });
});
