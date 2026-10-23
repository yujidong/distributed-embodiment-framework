/**
 * @vitest-environment node
 *
 * Notification & todo layer tests (Fix-16, roadmap Fix-16)
 *
 * Covers:
 * - migration v16 (notifications table);
 * - every producer: proposal escalate → env owner, proposal verdicts →
 *   author (approved stays transient — applied carries it), agreement
 *   propose/decide/suspend/terminate → the other party, invoke failure →
 *   provider with unread dedupe, AC join-response → initiator owner;
 * - noise control: no self-echo (recipient === actor), no duplicate unread
 *   invoke-failure;
 * - inbox permissions: strictly private (list shows only mine, reading
 *   someone else's id 404s);
 * - read flow: read one (idempotent), read-all, unreadCount, ?unread=
 *   filter;
 * - overview todos: pendingProposals / pendingAgreements /
 *   unreadNotifications;
 * - WS broadcast: agreement lifecycle events on the environment stream.
 */

import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { EventType, type EngineRuntime, type SystemEvent } from '@active-collaboration/core';

import { AcAgreementBridge } from './ac-agreement-bridge.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

interface NotificationJson {
  id: string;
  envId: string;
  kind: string;
  title: string;
  body: Record<string, unknown>;
  refId: string | null;
  readAt: string | null;
  createdAt: string;
}

describe('notifications & todos (Fix-16)', () => {
  let ctx: TestAppContext;
  let owner: TestUser; // env owner AND provider (owns the imported lab-agent)
  let consumer: TestUser; // builder member
  let stranger: TestUser;
  let envId: string;
  let turnOnServiceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('notifications-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    ctx.app.envStore.addMember(envId, consumer.id, 'builder');

    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    turnOnServiceId = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启')!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function inbox(token: string, query = ''): Promise<{ notifications: NotificationJson[]; unreadCount: number }> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/notifications${query}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function overview(token: string) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/overview',
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  /** Consumer submits an install-devices proposal; the default reviewer escalates. */
  async function submitEscalatedProposal(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(consumer.token),
      payload: {
        kind: 'install-devices',
        payload: {
          devices: [{ name: 'Lamp', type: 'smart-light', capabilities: ['lighting-control'], zoneId: 'zone-a' }],
        },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('escalated');
    return res.json().id as string;
  }

  /** propose → returns the proposed agreement id. */
  async function proposeAgreement(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${turnOnServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function decideAgreement(id: string, decision: 'accept' | 'reject') {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${id}/decide`,
      headers: auth(owner.token),
      payload: { decision },
    });
    expect(res.statusCode).toBe(200);
    return res;
  }

  // -------------------------------------------------------------------------
  // Migration
  // -------------------------------------------------------------------------

  it('migration v16 creates the notifications table', () => {
    const migration = ctx.app.db
      .prepare('SELECT version, name FROM migrations WHERE version = 16')
      .get() as { version: number; name: string } | undefined;
    expect(migration).toEqual({ version: 16, name: 'notifications' });

    const columns = (ctx.app.db.prepare('PRAGMA table_info(notifications)').all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(columns).toEqual([
      'id', 'user_id', 'env_id', 'kind', 'title', 'body_json', 'ref_id', 'read_at', 'created_at',
      'repeat_count', // R68 aggregation (migration v54)
    ]);
  });

  // -------------------------------------------------------------------------
  // Proposal producers
  // -------------------------------------------------------------------------

  it('escalation pings the env owner; the owner verdict pings the author (approved → one applied row)', async () => {
    const proposalId = await submitEscalatedProposal();

    // The owner's doorbell: one escalated notification about the proposal.
    const ownerInbox = await inbox(owner.token);
    expect(ownerInbox.unreadCount).toBe(1);
    const escalated = ownerInbox.notifications[0];
    expect(escalated.kind).toBe('proposal.escalated');
    expect(escalated.refId).toBe(proposalId);
    expect(escalated.envId).toBe(envId);
    expect(escalated.body).toMatchObject({ proposalId, status: 'escalated' });
    // The author gets NO echo of their own submission.
    expect((await inbox(consumer.token)).notifications).toHaveLength(0);

    // Owner approves → the author learns the verdict. `approved` is
    // transient: exactly ONE notification (applied), never two.
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('applied');

    const consumerInbox = await inbox(consumer.token);
    expect(consumerInbox.notifications).toHaveLength(1);
    expect(consumerInbox.notifications[0].kind).toBe('proposal.applied');
    // T59: the env-aggregated family key (per-proposal detail in the body).
    expect(consumerInbox.notifications[0].refId).toBe(`proposals-applied:${envId}`);

    // Owner reverts → the author is told too.
    const reverted = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/revert`,
      headers: auth(owner.token),
    });
    expect(reverted.statusCode).toBe(200);
    const kinds = (await inbox(consumer.token)).notifications.map(n => n.kind);
    expect(kinds).toEqual(['proposal.reverted', 'proposal.applied']);
  });

  it('rejection by the owner pings the author; a rule-check rejection pings the author too (Fix-18)', async () => {
    const proposalId = await submitEscalatedProposal();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'rejected' },
    });
    const consumerInbox = await inbox(consumer.token);
    expect(consumerInbox.notifications).toHaveLength(1);
    expect(consumerInbox.notifications[0].kind).toBe('proposal.rejected');

    // Fix-18 (R7 F-16): a rule-check rejection lands with the AUTHOR as
    // actor, but the verdict is the platform's — the author is notified
    // (allowSelf). The owner stays out of it (no auto-escalation happened).
    const before = (await inbox(owner.token)).unreadCount;
    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(consumer.token),
      payload: {
        kind: 'install-devices',
        payload: {
          devices: [{ name: 'Ghost', type: 'smart-light', capabilities: ['lighting-control'], zoneId: 'no-such-zone' }],
        },
      },
    });
    expect(bad.statusCode).toBe(201);
    expect(bad.json().status).toBe('rejected');
    const after = await inbox(consumer.token);
    expect(after.notifications).toHaveLength(2);
    expect(after.notifications[0].kind).toBe('proposal.rejected');
    expect(after.notifications[0].refId).toBe(bad.json().id);
    expect((await inbox(owner.token)).unreadCount).toBe(before);
  });

  it('Fix-18 (R7 F-16): an AUTO-APPLIED proposal (zone-claim autonomy) pings the author', async () => {
    // The consumer stewards zone-a, so their low-risk install-devices
    // proposal skips AI review and auto-applies — actor === author.
    ctx.app.zoneClaimStore.grant({
      envId,
      zoneId: 'zone-a',
      granteeId: consumer.id,
      grantedBy: owner.id,
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(consumer.token),
      payload: {
        kind: 'install-devices',
        payload: {
          devices: [{ name: 'Lamp', type: 'smart-light', capabilities: ['lighting-control'], zoneId: 'zone-a' }],
        },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('applied');
    expect(res.json().aiReview.source).toBe('zone-claim');

    // The author still hears the verdict: exactly ONE notification
    // (approved stays transient — applied carries it).
    const consumerInbox = await inbox(consumer.token);
    expect(consumerInbox.notifications).toHaveLength(1);
    expect(consumerInbox.notifications[0].kind).toBe('proposal.applied');
    // T59: the env-aggregated family key (the per-proposal detail lives in
    // the body; the row merges repeats for this env).
    expect(consumerInbox.notifications[0].refId).toBe(`proposals-applied:${envId}`);
    // T-004: no ESCALATION ping, but the auto-apply itself now reaches the
    // env owner — their world changed without a human verdict.
    const ownerInbox = await inbox(owner.token);
    expect(ownerInbox.notifications).toHaveLength(1);
    expect(ownerInbox.notifications[0].kind).toBe('proposal.auto_applied');
    expect(ownerInbox.notifications[0].refId).toBe(`proposals-applied:${envId}`);
    expect(ownerInbox.notifications[0].body).toMatchObject({
      proposalId: res.json().id,
      authorId: consumer.id,
    });
  });

  // -------------------------------------------------------------------------
  // Agreement producers
  // -------------------------------------------------------------------------

  it('agreement propose/decide/suspend/terminate ping the other party', async () => {
    const id = await proposeAgreement();

    // Provider's owner: 有待 accept 的合约。
    const ownerInbox = await inbox(owner.token);
    expect(ownerInbox.notifications).toHaveLength(1);
    expect(ownerInbox.notifications[0].kind).toBe('agreement.proposed');
    expect(ownerInbox.notifications[0].refId).toBe(id);
    expect((await inbox(consumer.token)).notifications).toHaveLength(0);

    await decideAgreement(id, 'accept');
    expect((await inbox(consumer.token)).notifications.map(n => n.kind)).toEqual(['agreement.accepted']);

    const suspended = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${id}/suspend`,
      headers: auth(owner.token),
    });
    expect(suspended.statusCode).toBe(200);
    expect((await inbox(consumer.token)).notifications.map(n => n.kind)).toEqual([
      'agreement.suspended',
      'agreement.accepted',
    ]);

    // The consumer terminates → the OTHER party (provider) is notified.
    const terminated = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${id}/terminate`,
      headers: auth(consumer.token),
    });
    expect(terminated.statusCode).toBe(200);
    const ownerAfter = await inbox(owner.token);
    expect(ownerAfter.notifications[0].kind).toBe('agreement.terminated');
    expect(ownerAfter.notifications[0].refId).toBe(id);

    // Reject path: a second proposal the provider turns down.
    const rejectedId = await proposeAgreement();
    await decideAgreement(rejectedId, 'reject');
    expect((await inbox(consumer.token)).notifications[0].kind).toBe('agreement.rejected');
  });

  it('agreement.proposed body names the consumer and digests the terms (Wave-1a, 陈工 R8)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${turnOnServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          quotaPerWindow: 10,
          windowSec: 3600,
          notes: '晚高峰温控'.padEnd(120, 'x'),
        },
      },
    });
    expect(res.statusCode).toBe(201);

    const ownerInbox = await inbox(owner.token);
    expect(ownerInbox.notifications).toHaveLength(1);
    const proposed = ownerInbox.notifications[0];
    expect(proposed.kind).toBe('agreement.proposed');
    expect(proposed.body.serviceName).toBe('HVAC B: 开启');
    expect(proposed.body.consumerName).toBe('Consumer');
    const summary = proposed.body.termsSummary as string;
    expect(summary).toContain('quota 10/3600s');
    expect(summary).toContain('notes: 晚高峰温控');
    // Notes are truncated (80 chars + …), not the full 120-char brief.
    expect(summary.length).toBeLessThan(110);
    expect(summary).toContain('…');

    // No terms → an explicit "unlimited" digest, not a missing field.
    await proposeAgreement();
    const after = await inbox(owner.token);
    expect(after.notifications[0].body.termsSummary).toBe('无附加条款（不限）');
  });

  it('a failed invoke pings the provider once per unread (dedupe), again after it is read', async () => {
    const id = await proposeAgreement();
    await decideAgreement(id, 'accept');

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

    // T-109: a CONSUMER-side error (typo'd action) is not the provider's
    // fault and must NOT ring the provider's bell — only genuine provider
    // failures do. (T-303: the typo'd action is refused pre-execution by
    // the device gate — 422, no provider ping.)
    const probe = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${id}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'no-such-command' },
    });
    expect(probe.statusCode).toBe(422);
    expect(probe.json().error.code).toBe('DEVICE_COMMAND_NOT_EXECUTABLE');
    const failures = () =>
      inbox(owner.token).then(box =>
        box.notifications.filter(n => n.kind === 'agreement.invoke-failed' && n.readAt === null),
      );
    expect(await failures()).toHaveLength(0);

    // A GENUINE execution failure (fault-injected device) pings the provider.
    const hvacId = (ctx.app.envStore.devicesOf(envId).find(d => d.name === 'HVAC B')!).id;
    const fault = await ctx.app.inject({
      method: 'PUT',
      url: `/api/simulations/${simId}/faults/${hvacId}`,
      headers: auth(consumer.token),
      payload: { offline: true },
    });
    expect(fault.statusCode).toBe(200);
    const invoke = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${id}/invocations`,
        headers: auth(consumer.token),
        // T-501: pin the faulted private sim — the omitted-simulationId
        // default is the authoritative world session now (its HVAC B is
        // healthy, so the fault story needs the explicit target).
        payload: { action: 'turn-on', simulationId: simId },
      });

    const first = await invoke();
    expect(first.json().success).toBe(false);
    expect(await failures()).toHaveLength(1);
    expect((await failures())[0].refId).toBe(id);

    // A retry-loop does not flood the provider's inbox.
    await invoke();
    expect(await failures()).toHaveLength(1);

    // Once read, the bell may ring again.
    const unreadId = (await failures())[0].id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/notifications/${unreadId}/read`,
      headers: auth(owner.token),
    });
    await invoke();
    expect(await failures()).toHaveLength(1);
    expect((await failures())[0].id).not.toBe(unreadId);
  });

  // -------------------------------------------------------------------------
  // Permissions + read flow
  // -------------------------------------------------------------------------

  it('the inbox is strictly private: lists show only mine, foreign ids 404', async () => {
    await proposeAgreement();
    const ownerInbox = await inbox(owner.token);
    expect(ownerInbox.notifications).toHaveLength(1);
    const foreignId = ownerInbox.notifications[0].id;

    // The stranger's inbox is empty; the consumer sees none of the owner's.
    expect((await inbox(stranger.token)).notifications).toHaveLength(0);
    expect((await inbox(consumer.token)).notifications).toHaveLength(0);

    for (const token of [consumer.token, stranger.token]) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/notifications/${foreignId}/read`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(404);
    }
    // Unknown id → 404 too.
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/api/notifications/no-such-id/read',
      headers: auth(owner.token),
    });
    expect(missing.statusCode).toBe(404);

    // Auth required.
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/notifications' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('read one (idempotent) / read-all / unread filter / unreadCount', async () => {
    const proposalId = await submitEscalatedProposal();
    await decideAgreement(await proposeAgreement(), 'reject');
    // Owner: 2 (escalated + agreement.proposed). Consumer: 1 (agreement.rejected).
    expect((await inbox(owner.token)).unreadCount).toBe(2);
    expect((await inbox(consumer.token)).unreadCount).toBe(1);

    // Read one of the owner's (idempotent — readAt does not change twice).
    const ownerRow = (await inbox(owner.token)).notifications[0];
    const read1 = await ctx.app.inject({
      method: 'POST',
      url: `/api/notifications/${ownerRow.id}/read`,
      headers: auth(owner.token),
    });
    expect(read1.statusCode).toBe(200);
    expect(read1.json().readAt).not.toBeNull();
    const read2 = await ctx.app.inject({
      method: 'POST',
      url: `/api/notifications/${ownerRow.id}/read`,
      headers: auth(owner.token),
    });
    expect(read2.json().readAt).toBe(read1.json().readAt);
    expect((await inbox(owner.token)).unreadCount).toBe(1);

    // The read row still appears unfiltered; ?unread=true shows the rest.
    expect((await inbox(owner.token)).notifications).toHaveLength(2);
    expect((await inbox(owner.token, '?unread=true')).notifications).toHaveLength(1);

    // Consumer: decide the proposal so there are 2 rows, then read-all.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect((await inbox(consumer.token)).unreadCount).toBe(2);
    const readAll = await ctx.app.inject({
      method: 'POST',
      url: '/api/notifications/read-all',
      headers: auth(consumer.token),
    });
    expect(readAll.statusCode).toBe(200);
    expect(readAll.json().marked).toBe(2);
    const after = await inbox(consumer.token);
    expect(after.unreadCount).toBe(0);
    expect(after.notifications.every(n => n.readAt !== null)).toBe(true);

    // Invalid query params are 400.
    for (const query of ['?unread=yes', '?limit=0', '?limit=abc']) {
      const bad = await ctx.app.inject({
        method: 'GET',
        url: `/api/notifications${query}`,
        headers: auth(owner.token),
      });
      expect(bad.statusCode).toBe(400);
    }
  });

  it('T-030 (R10 EB-F10): ?before= pages backwards past the newest-200 clamp', async () => {
    // Seed 205 rows with DISTINCT millisecond timestamps. Raw SQL, not
    // store.create(): the store stamps created_at=now(), and same-ms rows
    // would make the strictly-older cursor boundary ambiguous (rows sharing
    // the cursor's timestamp are skipped by design — same contract as the
    // activity feed).
    const base = Date.parse('2026-08-01T00:00:00.000Z');
    const insert = ctx.app.db.prepare(
      `INSERT INTO notifications
       (id, user_id, env_id, kind, title, body_json, ref_id, read_at, created_at)
       VALUES (?, ?, ?, 'test.seed', 'seed row', '{}', NULL, NULL, ?)`,
    );
    for (let i = 0; i < 205; i += 1) {
      insert.run(`seed-${i}`, owner.id, envId, new Date(base + i).toISOString());
    }

    // Page 1 — the newest 100; the unread doorbell rides on every page.
    const page1 = await inbox(owner.token, '?limit=100');
    expect(page1.notifications).toHaveLength(100);
    expect(page1.notifications[0].id).toBe('seed-204'); // newest first
    expect(page1.notifications[99].id).toBe('seed-105');
    expect(page1.unreadCount).toBe(205);

    // Page 2 — strictly older than the last row of page 1.
    const cursor2 = encodeURIComponent(page1.notifications[99].createdAt);
    const page2 = await inbox(owner.token, `?limit=100&before=${cursor2}`);
    expect(page2.notifications).toHaveLength(100);
    expect(page2.notifications[0].id).toBe('seed-104');
    expect(page2.notifications[99].id).toBe('seed-5');

    // Page 3 — the 5-remainder tail.
    const cursor3 = encodeURIComponent(page2.notifications[99].createdAt);
    const page3 = await inbox(owner.token, `?limit=100&before=${cursor3}`);
    expect(page3.notifications.map(n => n.id)).toEqual([
      'seed-4', 'seed-3', 'seed-2', 'seed-1', 'seed-0',
    ]);

    // The union covers all 205 rows exactly once, globally descending.
    const ids = [...page1.notifications, ...page2.notifications, ...page3.notifications]
      .map(n => n.id);
    expect(new Set(ids).size).toBe(205);

    // A cursor older than the oldest row → empty page (end of history), 200.
    const beyond = await inbox(owner.token, `?before=${encodeURIComponent('2026-07-01T00:00:00.000Z')}`);
    expect(beyond.notifications).toHaveLength(0);
    expect(beyond.unreadCount).toBe(205);

    // Invalid cursor is the teachable 400, not a silently ignored param.
    const bad = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications?before=not-a-date',
      headers: auth(owner.token),
    });
    expect(bad.statusCode).toBe(400);

    // The cursor is still just a filter: ?unread= composes with paging.
    // Mark seed-99..seed-90 (10 rows) read: the strictly-older window holds
    // 105 rows (seed-104..seed-0), so an unread-only page carries 95 of
    // them, newest unread (seed-104) on top.
    await ctx.app.db
      .prepare("UPDATE notifications SET read_at = '2026-08-02T00:00:00.000Z' WHERE id LIKE 'seed-9_'")
      .run();
    const unreadPage = await inbox(owner.token, `?unread=true&limit=100&before=${cursor2}`);
    expect(unreadPage.notifications).toHaveLength(95);
    expect(unreadPage.notifications[0].id).toBe('seed-104');
    expect(unreadPage.notifications.every(n => n.readAt === null)).toBe(true);
    expect(unreadPage.unreadCount).toBe(195);
  });

  // -------------------------------------------------------------------------
  // Overview todos
  // -------------------------------------------------------------------------

  it('overview todos count owner approvals, provider decides and the unread bell', async () => {
    expect((await overview(owner.token)).todos).toEqual({
      pendingProposals: 0,
      pendingAgreements: 0,
      unreadNotifications: 0,
    });

    await submitEscalatedProposal();
    await proposeAgreement();

    const ownerTodos = (await overview(owner.token)).todos;
    expect(ownerTodos).toEqual({
      pendingProposals: 1, // escalated, awaiting the owner's decision
      pendingAgreements: 1, // proposed, awaiting the provider's accept
      unreadNotifications: 2, // escalate ping + agreement proposal ping
    });

    // The author's side of the loop is the inbox, not pendingProposals.
    const consumerTodos = (await overview(consumer.token)).todos;
    expect(consumerTodos.pendingProposals).toBe(0);
    expect(consumerTodos.pendingAgreements).toBe(0);
  });

  // -------------------------------------------------------------------------
  // AC handshake answers
  // -------------------------------------------------------------------------

  it('an AC join-response pings the initiator owner (accepted + rejected)', () => {
    const listeners: Array<{ types: string[] | undefined; listener: (event: SystemEvent) => void }> = [];
    const runtime = {
      subscribe(listener: (event: SystemEvent) => void, types?: unknown) {
        listeners.push({ types: (Array.isArray(types) ? types : [types]) as string[], listener });
        return () => undefined;
      },
      fire(type: string, payload: Record<string, unknown>, source = 'test') {
        for (const entry of listeners) {
          if (entry.types === undefined || entry.types.includes(type)) {
            entry.listener({ type, source, payload } as unknown as SystemEvent);
          }
        }
      },
    };
    const bridge = new AcAgreementBridge({
      envStore: ctx.app.envStore,
      serviceStore: ctx.app.serviceStore,
      agreementStore: ctx.app.agreementStore,
      notificationStore: ctx.app.notificationStore,
    });
    bridge.attach(envId, runtime as unknown as EngineRuntime);

    const initiatorAgentId = ctx.app.envStore.createAgent({
      envId,
      ownerId: consumer.id,
      name: 'Buyer Agent',
      capabilities: [],
      boundDeviceIds: [],
    }).id;
    const providerAgentId = ctx.app.envStore.agentsOf(envId)
      .find(agent => agent.owner_id === owner.id)!.id;

    // accept → 发起方 owner 收到 accepted。
    runtime.fire(EventType.COLLABORATION_MESSAGE, {
      type: 'ac-proposal',
      collaborationId: 'ac-n1',
      initiatorId: initiatorAgentId,
      requiredCapabilities: ['turn-on'],
    });
    runtime.fire(EventType.COLLABORATION_MESSAGE, {
      type: 'join-response',
      acDecision: 'accept',
      agentId: providerAgentId,
      collaborationId: 'ac-n1',
    });

    // reject → 发起方 owner 收到 rejected。
    runtime.fire(EventType.COLLABORATION_MESSAGE, {
      type: 'ac-proposal',
      collaborationId: 'ac-n2',
      initiatorId: initiatorAgentId,
      requiredCapabilities: ['turn-on'],
    });
    runtime.fire(EventType.COLLABORATION_MESSAGE, {
      type: 'join-response',
      acDecision: 'reject',
      agentId: providerAgentId,
      collaborationId: 'ac-n2',
    });

    return inbox(consumer.token).then(box => {
      const kinds = box.notifications.map(n => [n.kind, n.refId]);
      expect(kinds).toEqual([
        ['collaboration.rejected', 'ac-n2'],
        ['collaboration.accepted', 'ac-n1'],
      ]);
      // The responder's owner gets no echo of their own answer.
      return inbox(owner.token).then(ownerBox => {
        expect(ownerBox.notifications).toHaveLength(0);
      });
    });
  });

  // -------------------------------------------------------------------------
  // WS broadcast (agreement lifecycle on the environment stream)
  // -------------------------------------------------------------------------

  it('broadcasts agreement lifecycle events on the environment stream', async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;
    // T-060 (R14 bilateral privacy): agreement frames reach only the two
    // parties + the env owner — connect as the owner (party here: the
    // provider agent's owner) instead of anonymously.
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/environments/${envId}/stream`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });

      const nextAgreementMessage = (action: string, timeoutMs = 4000): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`timed out waiting for agreement "${action}" message`)),
            timeoutMs,
          );
          const onMessage = (raw: WebSocket.RawData) => {
            const parsed = JSON.parse(raw.toString()) as { kind?: string; action?: string };
            if (parsed.kind !== 'agreement' || parsed.action !== action) return;
            clearTimeout(timer);
            socket.off('message', onMessage);
            resolve(parsed as Record<string, unknown>);
          };
          socket.on('message', onMessage);
        });

      const proposedPromise = nextAgreementMessage('proposed');
      const id = await proposeAgreement();
      const proposedMsg = await proposedPromise;
      expect(proposedMsg).toMatchObject({
        kind: 'agreement',
        action: 'proposed',
        agreementId: id,
        envId,
        actor: { id: consumer.id, displayName: 'Consumer' },
      });

      const acceptedPromise = nextAgreementMessage('accepted');
      await decideAgreement(id, 'accept');
      expect((await acceptedPromise).actor).toEqual({ id: owner.id, displayName: 'Owner' });

      const terminatedPromise = nextAgreementMessage('terminated');
      await ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${id}/terminate`,
        headers: auth(consumer.token),
      });
      expect((await terminatedPromise).actor).toEqual({ id: consumer.id, displayName: 'Consumer' });
    } finally {
      socket.close();
    }
  });
});
