/**
 * @vitest-environment node
 *
 * T-015 — Fix-47 visibility extended to EVERY by-id simulation read channel.
 *
 * Pre-fix: GET /api/simulations correctly hid a PRIVATE environment's sims
 * from strangers, but /snapshot, /trajectory, /timeline, /collaborations,
 * /eval-report, /faults and /stream checked only EXISTENCE — anyone holding
 * a simId could read the full private world. The coherent rule (mirroring
 * the env read gate): env-backed sims follow their environment's visibility
 * (public = anonymous OK, private = member), the creator and admins always
 * pass, legacy scenario sims keep the Fix-47 transition semantics
 * (creator-less open, creator-owned creator-only).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
} from './test-utils.js';

const READ_CHANNELS = [
  'snapshot',
  'trajectory',
  'timeline',
  'collaborations',
  'eval-report',
  'faults',
] as const;

describe('T-015: by-id simulation reads follow Fix-47 visibility', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  type App = TestAppContext['app'];

  async function createEnv(app: App, ownerToken: string, visibility: 'public' | 'private'): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(ownerToken),
      payload: { ...importableScenario(`t015-${visibility}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`), visibility },
    });
    expect(created.statusCode).toBe(201);
    return created.json().id as string;
  }

  async function createSim(app: App, environmentId: string, token?: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/simulations',
      ...(token !== undefined ? { headers: auth(token) } : {}),
      payload: { environmentId, options: { llmClient: 'none' } },
    });
    expect(created.statusCode).toBe(201);
    return created.json().id as string;
  }

  it('PRIVATE env: anonymous and strangers get 403 on every by-id read channel', async () => {
    const owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const envId = await createEnv(ctx.app, owner.token, 'private');
    const simId = await createSim(ctx.app, envId, owner.token);

    // Anonymous: every channel 403s with the env read gate's message
    // (the same wording the env detail route answers with).
    for (const channel of READ_CHANNELS) {
      const res = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${simId}/${channel}` });
      expect(res.statusCode, `anonymous GET /${channel}`).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
      expect(res.json().error.message).toContain('is private');
    }
    // The stream rejects the upgrade with the same rule (plain 403 before ws).
    const stream = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${simId}/stream` });
    expect(stream.statusCode).toBe(403);
    expect(stream.json().error.code).toBe('FORBIDDEN');

    // An authenticated stranger hits the same wall.
    const stranger = await registerUser(ctx.app, { displayName: 'Stranger' });
    for (const channel of READ_CHANNELS) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/simulations/${simId}/${channel}`,
        headers: auth(stranger.token),
      });
      expect(res.statusCode, `stranger GET /${channel}`).toBe(403);
    }
  });

  it('PRIVATE env: members (even viewers) and the creator read every channel', async () => {
    const owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const envId = await createEnv(ctx.app, owner.token, 'private');
    const creator = await registerUser(ctx.app, { displayName: 'Sim creator' });
    ctx.app.envStore.addMember(envId, creator.id, 'viewer'); // viewer may run demos
    const simId = await createSim(ctx.app, envId, creator.token);

    // A different member (the owner) reads every channel fine.
    for (const channel of READ_CHANNELS) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/simulations/${simId}/${channel}`,
        headers: auth(owner.token),
      });
      expect(res.statusCode, `member GET /${channel}`).toBe(200);
    }
    // The creator too (attribution survives membership changes).
    const snapshot = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(creator.token),
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().scenarioId).toBe(envId);
  });

  it('PRIVATE env: a consumer who created a sim keeps reading it after losing membership', async () => {
    const owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const envId = await createEnv(ctx.app, owner.token, 'private');
    const consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    ctx.app.envStore.addMember(envId, consumer.id, 'viewer');
    const simId = await createSim(ctx.app, envId, consumer.token);

    // Membership revoked after the sim exists — the creator still reads it.
    ctx.app.envStore.removeMember(envId, consumer.id);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(consumer.token),
    });
    expect(res.statusCode).toBe(200);
    // ...but an anonymous stranger still cannot.
    const anon = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${simId}/snapshot` });
    expect(anon.statusCode).toBe(403);
  });

  it('PUBLIC env: anonymous visitors keep reading by-id (demo semantics unchanged)', async () => {
    const owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const envId = await createEnv(ctx.app, owner.token, 'public');
    const simId = await createSim(ctx.app, envId, owner.token);

    for (const channel of READ_CHANNELS) {
      const res = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${simId}/${channel}` });
      expect(res.statusCode, `anonymous GET /${channel} on public env`).toBe(200);
    }
  });

  it('admin (ADMIN_EMAILS) reads any simulation', async () => {
    const adminCtx = await makeTestApp({ adminEmails: ['t015-admin@example.com'] });
    try {
      const owner = await registerUser(adminCtx.app, { displayName: 'Owner' });
      const envId = await createEnv(adminCtx.app, owner.token, 'private');
      const simId = await createSim(adminCtx.app, envId, owner.token);
      const admin = await registerUser(adminCtx.app, { email: 't015-admin@example.com' });
      const res = await adminCtx.app.inject({
        method: 'GET',
        url: `/api/simulations/${simId}/snapshot`,
        headers: auth(admin.token),
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await adminCtx.cleanup();
    }
  });

  it('legacy scenario sims: creator-owned are creator-only, creator-less stay open', async () => {
    const owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const posted = await ctx.app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: auth(owner.token),
      payload: importableScenario('t015-legacy'),
    });
    expect(posted.statusCode).toBe(201);

    // Creator-owned: stranger 403, creator 200, anonymous 403.
    const mine = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { scenarioId: 't015-legacy' },
    });
    expect(mine.statusCode).toBe(201);
    const stranger = await registerUser(ctx.app, { displayName: 'Stranger' });
    const strangerRead = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${mine.json().id}/snapshot`,
      headers: auth(stranger.token),
    });
    expect(strangerRead.statusCode).toBe(403);
    const anonRead = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${mine.json().id}/snapshot` });
    expect(anonRead.statusCode).toBe(403);
    const creatorRead = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${mine.json().id}/snapshot`,
      headers: auth(owner.token),
    });
    expect(creatorRead.statusCode).toBe(200);

    // Creator-less (anonymous creation — transition semantics): stays open.
    const open = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 't015-legacy' },
    });
    expect(open.statusCode).toBe(201);
    const anonOpen = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${open.json().id}/snapshot` });
    expect(anonOpen.statusCode).toBe(200);
  });

  it('disk eval-report fallback: private env metrics 403 anonymously, public env open', async () => {
    const owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const privateEnvId = await createEnv(ctx.app, owner.token, 'private');
    const publicEnvId = await createEnv(ctx.app, owner.token, 'public');

    // Hand-craft post-restart disk reports (registry miss → source=disk) for
    // both envs, the way eval-report-disk.vitest.test.ts does.
    const writeDiskReport = (simId: string, environmentId: string): void => {
      const dir = join(ctx.trajectoryDir, simId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'engine-runtime-iter0-t015.jsonl'),
        [
          { eventId: 'evt-1', agentId: 'agent-1', decision: 'handle_independently', kind: 'assessment', decisionSource: 'rule', correct: true, scenario: 't015-disk' },
        ].map(r => JSON.stringify(r)).join('\n') + '\n',
      );
      writeFileSync(
        join(dir, 'sim-timeline.jsonl'),
        [
          { kind: 'zone-sample', environmentId, simId, simTimeSec: 10, recordedAt: new Date().toISOString(), zones: [] },
        ].map(r => JSON.stringify(r)).join('\n') + '\n',
      );
    };
    writeDiskReport('sim-t015-disk-private', privateEnvId);
    writeDiskReport('sim-t015-disk-public', publicEnvId);

    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/api/simulations/sim-t015-disk-private/eval-report',
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');

    const memberRead = await ctx.app.inject({
      method: 'GET',
      url: '/api/simulations/sim-t015-disk-private/eval-report',
      headers: auth(owner.token),
    });
    expect(memberRead.statusCode).toBe(200);
    expect(memberRead.json().source).toBe('disk');

    const publicRead = await ctx.app.inject({
      method: 'GET',
      url: '/api/simulations/sim-t015-disk-public/eval-report',
    });
    expect(publicRead.statusCode).toBe(200);
    expect(publicRead.json().source).toBe('disk');

    // Unattributable disk reports (no environmentId on disk — legacy runs)
    // keep the transition semantics: open.
    const legacyDir = join(ctx.trajectoryDir, 'sim-t015-disk-legacy');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'engine-runtime-iter0-t015.jsonl'),
      [{ eventId: 'evt-1', agentId: 'agent-1', decision: 'handle_independently', kind: 'assessment', decisionSource: 'rule', correct: true, scenario: 't015-disk-legacy' }].map(r => JSON.stringify(r)).join('\n') + '\n',
    );
    const legacyRead = await ctx.app.inject({
      method: 'GET',
      url: '/api/simulations/sim-t015-disk-legacy/eval-report',
    });
    expect(legacyRead.statusCode).toBe(200);
    expect(legacyRead.json().environmentId).toBeUndefined();
  });

  it('unknown sim ids still 404 (not 403) on every read channel', async () => {
    for (const channel of READ_CHANNELS) {
      const res = await ctx.app.inject({ method: 'GET', url: `/api/simulations/nope/${channel}` });
      expect(res.statusCode, `GET /${channel} unknown id`).toBe(404);
      expect(res.json().error.code).toBe('SIMULATION_NOT_FOUND');
    }
  });
});
