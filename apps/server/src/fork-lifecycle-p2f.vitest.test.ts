/**
 * @vitest-environment node
 *
 * P2F (living-worlds §10) fork lifecycle acceptance:
 *
 * - 便宜 fork（§10.1 create-from-checkpoint）：live 权威会话 → 一调用
 *   fork，副本从世界的此刻开始（sim-time 延续，物理场复制），权威世界
 *   不受影响（继续跑、sim-time 前进）；无检查点时 409 教学。
 * - membership join（§10.2）：owner 邀请 builder/viewer；成员看到并读取
 *   副本世界；viewer 只读（start 403）；未加入的 env 成员不可见/不可读；
 *   退出自助；加入不消耗加入者的 fork 配额。
 * - lineage（§10.4）：fork 运行产生 timeline 记录 → 训练导出 manifest
 *   携带 forks lineage + ?simId= 时 window.forkId + 记录信封带 forkId；
 *   回放报告携带 forks。GC 之后行元数据（lineage）仍可查。
 * - 到期旋钮（§10.3）：行的显式 expires_at 到期即被清扫（即使磁盘活动
 *   仍新鲜）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  auth,
  makeTestApp,
  registerUser,
  until,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';
import { worldSessionSimIdOf } from './sandbox-service.js';

function isoOffset(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

describe('P2F fork lifecycle (§10): cheap fork, join, lineage, expiry', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let joiner: TestUser;
  let stranger: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp({ zoneSampleEverySimSec: 1 });
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    joiner = await registerUser(ctx.app, { displayName: 'Joiner' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Fork Lifecycle Lab',
        visibility: 'public',
        mapData: {
          zones: [{ id: 'zone-a', bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 } }],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    for (const user of [builder, joiner]) {
      const joined = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/join`,
        headers: auth(user.token),
      });
      expect(joined.statusCode).toBe(200);
    }
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function fork(token: string, payload: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/sandboxes`,
      headers: auth(token),
      payload,
    });
  }

  it('cheap fork copies the live world\'s moment (sim-time continues, source untouched)', async () => {
    // Wake the authoritative world and advance it on its own timeline.
    const session = await ctx.app.worldSessions.targetFor(envId);
    expect(session).toBeDefined();
    const sessionSimId = worldSessionSimIdOf(envId);
    const record = ctx.app.simulations.get(sessionSimId)!;
    await record.runtime.advanceTo(42);
    const zoneBefore = record.runtime.getSnapshot().zones[0]!.parameters;

    const response = await fork(builder.token, { fromCheckpoint: true });
    expect(response.statusCode).toBe(201);
    const sandbox = response.json();
    expect(sandbox.status).toBe('active');
    expect(sandbox.lineage.forkId).toBe(sandbox.id);
    expect(sandbox.lineage.envId).toBe(envId);
    expect(sandbox.lineage.checkpointId).toContain(sessionSimId);
    expect(sandbox.lineage.checkpointId).toContain('42');
    expect(sandbox.lineage.policy).toEqual({ scheduling: 'tick', fromCheckpoint: true });
    expect(sandbox.lineage.scenarioFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The fork continues from the world's moment, with the copied physics.
    const forkRecord = ctx.app.simulations.get(sandbox.simulationId)!;
    expect(forkRecord.runtime.getSimTimeSec()).toBeGreaterThanOrEqual(42);
    const forkZone = forkRecord.runtime.getSnapshot().zones.find(z => z.id === 'zone-a')!;
    for (const [key, value] of Object.entries(zoneBefore)) {
      if (typeof value === 'number') {
        expect(forkZone.parameters[key]).toBeCloseTo(value, 6);
      }
    }

    // One-way copy: the authoritative world keeps running, untouched.
    expect(ctx.app.simulations.get(sessionSimId)).toBeDefined();
    expect(record.runtime.getState()).toBe('running');
    expect(record.runtime.getSimTimeSec()).toBeGreaterThanOrEqual(42);
  });

  it('fromCheckpoint on an env whose world never started fails 409 with the teaching fallback', async () => {
    // R73: env creation AUTO-STARTS the world session, so a simulatable env
    // always has world state to fork from (the live-export lane). The
    // NO_WORLD_CHECKPOINT lane now covers envs whose session creation
    // legitimately failed — a blank 0-zone env (R76-F2: legal to create,
    // not simulatable; session creation fails ENVIRONMENT_INVALID by design
    // and the failure is warn-only).
    const blank = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Blank Fork Lab',
        visibility: 'public',
        mapData: { zones: [] },
      },
    });
    expect(blank.statusCode).toBe(201);
    const blankEnvId = blank.json().id as string;
    // The auto-start failed: no session, no checkpoint on disk.
    expect(ctx.app.worldSessions.statusOf(blankEnvId)).toBeUndefined();

    const joined = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${blankEnvId}/join`,
      headers: auth(builder.token),
    });
    expect(joined.statusCode).toBe(200);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${blankEnvId}/sandboxes`,
      headers: auth(builder.token),
      payload: { fromCheckpoint: true },
    });
    expect(response.statusCode).toBe(409);
    const error = response.json().error;
    expect(error.code).toBe('NO_WORLD_CHECKPOINT');
    expect(error.message).toContain('frozen scenario');
  });

  it('membership join: invite → member sees/reads the fork; viewer read-only; leave; quota untouched', async () => {
    const created = await fork(builder.token);
    expect(created.statusCode).toBe(201);
    const sandbox = created.json();
    const simId = sandbox.simulationId;

    // A fellow env member who has NOT joined sees neither the fork list…
    const listBefore = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/sandboxes`,
      headers: auth(joiner.token),
    });
    expect(listBefore.statusCode).toBe(200);
    expect(listBefore.json().sandboxes.map((row: { id: string }) => row.id)).not.toContain(sandbox.id);
    // …nor the fork world's read surfaces.
    const snapshotBefore = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(joiner.token),
    });
    expect(snapshotBefore.statusCode).toBe(403);

    // Non-owner cannot invite.
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/api/sandboxes/${sandbox.id}/members`,
      headers: auth(stranger.token),
      payload: { userId: joiner.id, role: 'builder' },
    });
    expect(denied.statusCode).toBe(403);

    // The fork owner invites the joiner as a builder (upsert semantics: the
    // roster returns owner-first with the invite appended).
    const invited = await ctx.app.inject({
      method: 'POST',
      url: `/api/sandboxes/${sandbox.id}/members`,
      headers: auth(builder.token),
      payload: { userId: joiner.id, role: 'builder' },
    });
    expect(invited.statusCode).toBe(201);
    const roster = invited.json().members as Array<{ userId: string; role: string }>;
    expect(roster[0]).toEqual(expect.objectContaining({ userId: builder.id, role: 'owner' }));
    expect(roster).toContainEqual(expect.objectContaining({ userId: joiner.id, role: 'builder' }));

    // Joined: the fork appears in the member's list and the world is readable.
    const listAfter = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/sandboxes`,
      headers: auth(joiner.token),
    });
    expect(listAfter.json().sandboxes.map((row: { id: string }) => row.id)).toContain(sandbox.id);
    const snapshotAfter = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(joiner.token),
    });
    expect(snapshotAfter.statusCode).toBe(200);

    // Joining consumes none of the joiner's fork quota.
    expect(ctx.app.sandboxStore.countActiveForUser(envId, joiner.id)).toBe(0);

    // A viewer member reads but cannot operate (start 403 in their own terms).
    const asViewer = await ctx.app.inject({
      method: 'POST',
      url: `/api/sandboxes/${sandbox.id}/members`,
      headers: auth(builder.token),
      payload: { userId: joiner.id, role: 'viewer' },
    });
    expect(asViewer.statusCode).toBe(201);
    const viewSnapshot = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(joiner.token),
    });
    expect(viewSnapshot.statusCode).toBe(200);
    const startDenied = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(joiner.token),
      payload: {},
    });
    expect(startDenied.statusCode).toBe(403);
    // …while a builder member may operate the fork world.
    const asBuilder = await ctx.app.inject({
      method: 'POST',
      url: `/api/sandboxes/${sandbox.id}/members`,
      headers: auth(builder.token),
      payload: { userId: joiner.id, role: 'builder' },
    });
    expect(asBuilder.statusCode).toBe(201);
    const startOk = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(joiner.token),
      payload: { speed: 1 },
    });
    expect(startOk.statusCode).toBe(200);

    // Inviting someone who is not an env member teaches the join order.
    const notMember = await ctx.app.inject({
      method: 'POST',
      url: `/api/sandboxes/${sandbox.id}/members`,
      headers: auth(builder.token),
      payload: { userId: stranger.id, role: 'viewer' },
    });
    expect(notMember.statusCode).toBe(409);
    expect(notMember.json().error.code).toBe('NOT_AN_ENV_MEMBER');

    // Self-leave is always allowed; the fork disappears from the list again.
    const left = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/sandboxes/${sandbox.id}/members/${joiner.id}`,
      headers: auth(joiner.token),
    });
    expect(left.statusCode).toBe(200);
    const listLeft = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/sandboxes`,
      headers: auth(joiner.token),
    });
    expect(listLeft.json().sandboxes.map((row: { id: string }) => row.id)).not.toContain(sandbox.id);
  });

  it('fork lineage round-trip: run the fork → training export + replay carry machine-checkable lineage', async () => {
    const created = await fork(builder.token);
    expect(created.statusCode).toBe(201);
    const sandbox = created.json();

    const started = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sandbox.simulationId}/start`,
      headers: auth(builder.token),
      payload: { speed: 30 },
    });
    expect(started.statusCode).toBe(200);

    // Zone samples (forkId-stamped timeline records) must land on disk.
    const timelineFile = join(ctx.trajectoryDir, sandbox.simulationId, 'sim-timeline');
    await until(() => existsSync(join(timelineFile, 'segment-000001.jsonl')), 5000);
    const sampled = readFileSync(join(timelineFile, 'segment-000001.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { forkId?: string; environmentId?: string; kind: string });
    expect(sampled.length).toBeGreaterThan(0);
    for (const record of sampled) {
      expect(record.forkId).toBe(sandbox.id);
      expect(record.environmentId).toBe(envId);
    }

    // Training export (owner): manifest.forks + per-window forkId + envelopes.
    const exportResponse = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/training-export?simId=${sandbox.simulationId}`,
      headers: auth(owner.token),
    });
    expect(exportResponse.statusCode).toBe(200);
    const exportLines = String(exportResponse.body).trim().split('\n');
    const scopedManifest = JSON.parse(exportLines[0]!) as {
      payload: {
        window: { forkId?: string };
        forks?: Array<{ forkId: string; envId: string; policy: Record<string, unknown> }>;
      };
    };
    expect(scopedManifest.payload.window.forkId).toBe(sandbox.id);
    expect(scopedManifest.payload.forks).toEqual([
      expect.objectContaining({
        forkId: sandbox.id,
        envId,
        policy: { scheduling: 'tick' },
      }),
    ]);
    const dataLines = exportLines.slice(1).map(l => JSON.parse(l) as { forkId?: string; kind: string });
    const forkRecords = dataLines.filter(line => line.forkId !== undefined);
    expect(forkRecords.length).toBeGreaterThan(0);
    for (const line of forkRecords) expect(line.forkId).toBe(sandbox.id);

    // Replay over the window: the report names the contributing fork.
    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replays`,
      headers: auth(owner.token),
      payload: { from: isoOffset(-60 * 60 * 1000), to: isoOffset(60 * 60 * 1000) },
    });
    expect(replay.statusCode).toBe(200); // download mode answers 200
    const report = replay.json().report as {
      forks: Array<{ forkId: string; envId: string; window: { from: string; to: string } }>;
    };
    expect(report.forks).toEqual([
      expect.objectContaining({ forkId: sandbox.id, envId }),
    ]);

    // Lineage survives teardown: stop the fork (runtime + dir gone), the row
    // — and therefore the lineage — remains queryable.
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/api/sandboxes/${sandbox.id}/stop`,
      headers: auth(builder.token),
    });
    expect(stopped.statusCode).toBe(200);
    const row = ctx.app.sandboxStore.get(sandbox.id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('stopped');
  });

  it('row-level expiry (§10.3): a fork past its own expires_at is swept even with fresh disk activity', async () => {
    const small = await makeTestApp({ forkMaxAgeDays: 0 });
    try {
      const ownerToken = (await registerUser(small.app)).token;
      const created = await small.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(ownerToken),
        payload: {
          name: 'Expiry Lab',
          visibility: 'public',
          mapData: { zones: [{ id: 'zone-a' }] },
        },
      });
      const envId2 = created.json().id;
      const forked = await small.app.inject({
        method: 'POST',
        url: `/api/environments/${envId2}/sandboxes`,
        headers: auth(ownerToken),
        payload: {},
      });
      expect(forked.statusCode).toBe(201);
      const sandbox = forked.json();
      expect(sandbox.expiresAt).not.toBeNull();

      // expiresAt = creation + 0 → the row is past its own ceiling; the sweep
      // takes it regardless of the (fresh) disk activity.
      const sweep = small.app.sandboxService.sweepStaleForks({
        maxAgeMs: 24 * 60 * 60 * 1000,
      });
      expect(sweep.swept).toBe(1);
      expect(small.app.sandboxStore.get(sandbox.id)!.status).toBe('stopped');
    } finally {
      await small.cleanup();
    }
  });
});
