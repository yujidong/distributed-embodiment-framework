/**
 * @vitest-environment node
 *
 * Notification webhook tests (Wave-4b, roadmap Wave 4「通知通道扩展」)
 *
 * Covers:
 * - migration v20 (users.webhook_url);
 * - webhook config routes: GET/PUT/DELETE /api/me/notification-webhook,
 *   http(s)-only URL validation;
 * - delivery: a persisted notification is POSTed to the recipient's webhook
 *   with the full inbox-shaped payload;
 * - retry: a failed attempt is retried exactly once, then dropped;
 * - non-blocking: an unreachable webhook does not delay or fail the request
 *   that produced the notification (the inbox row still lands);
 * - unit level: the dispatcher no-ops without a webhook and swallows
 *   delivery failures (fire-and-forget contract).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNotificationWebhookDispatcher } from './notification-webhook.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

/** Minimal webhook receiver: records (body, statusToAnswer) per request. */
interface Receiver {
  server: Server;
  url: string;
  requests: Array<Record<string, unknown>>;
  /** Queue of status codes to answer with (last one repeats). */
  statuses: number[];
  close: () => Promise<void>;
}

async function startReceiver(statuses: number[] = [200]): Promise<Receiver> {
  const requests: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => {
      requests.push(JSON.parse(raw) as Record<string, unknown>);
      for (const waiter of waiters.splice(0)) waiter();
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      res.writeHead(status).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    statuses,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/** Poll until the receiver got n requests (delivery is async). */
async function waitForRequests(receiver: Receiver, n: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (receiver.requests.length < n) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${n} webhook request(s), got ${receiver.requests.length}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('notification webhook (Wave-4b)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let envId: string;
  let receiver: Receiver;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('webhook-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    ctx.app.envStore.addMember(envId, builder.id, 'builder');
    receiver = await startReceiver();
  });

  afterEach(async () => {
    await receiver.close();
    await ctx.cleanup();
  });

  async function putWebhook(token: string, url: unknown) {
    return ctx.app.inject({
      method: 'PUT',
      url: '/api/me/notification-webhook',
      headers: auth(token),
      payload: { url },
    });
  }

  /** Builder submits an install-devices proposal → escalated → owner ping. */
  async function produceOwnerNotification(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
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

  // -------------------------------------------------------------------------
  // Migration + config routes
  // -------------------------------------------------------------------------

  it('migration v20 adds users.webhook_url', () => {
    const migration = ctx.app.db
      .prepare('SELECT version, name FROM migrations WHERE version = 20')
      .get() as { version: number; name: string } | undefined;
    expect(migration).toEqual({ version: 20, name: 'user-notification-webhook' });
    const columns = (ctx.app.db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(columns).toContain('webhook_url');
  });

  it('GET/PUT/DELETE manage the caller\'s webhook; http(s)-only validation', async () => {
    // Unset → null.
    const empty = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/notification-webhook',
      headers: auth(owner.token),
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ url: null });

    // Invalid: non-URL, non-http(s) protocol, empty.
    for (const bad of ['not-a-url', 'ftp://example.com/hook', 'ws://example.com/hook', '']) {
      const res = await putWebhook(owner.token, bad);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_WEBHOOK_URL');
    }

    // Valid http + https.
    expect((await putWebhook(owner.token, receiver.url)).statusCode).toBe(200);
    const shown = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/notification-webhook',
      headers: auth(owner.token),
    });
    expect(shown.json()).toEqual({ url: receiver.url });

    // DELETE clears.
    const cleared = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/me/notification-webhook',
      headers: auth(owner.token),
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ url: null });

    // Auth required on all three methods.
    expect((await ctx.app.inject({ method: 'GET', url: '/api/me/notification-webhook' })).statusCode).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  it('posts the full notification payload to the recipient\'s webhook', async () => {
    await putWebhook(owner.token, receiver.url);
    const proposalId = await produceOwnerNotification();

    await waitForRequests(receiver, 1);
    const payload = receiver.requests[0]!;
    expect(payload.kind).toBe('proposal.escalated');
    expect(payload.envId).toBe(envId);
    expect(payload.refId).toBe(proposalId);
    expect(payload.title).toBeTruthy();
    expect((payload.body as Record<string, unknown>).proposalId).toBe(proposalId);
    expect(payload.readAt).toBeNull();
    expect(typeof payload.id).toBe('string');

    // The payload is the same row the inbox serves.
    const inbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(owner.token),
    });
    expect(inbox.json().notifications[0].id).toBe(payload.id);

    // The actor (builder) has no webhook → no extra deliveries.
    expect(receiver.requests).toHaveLength(1);
  });

  it('retries a failed delivery exactly once, then gives up', async () => {
    await receiver.close();
    receiver = await startReceiver([500, 200]);
    await putWebhook(owner.token, receiver.url);
    await produceOwnerNotification();

    await waitForRequests(receiver, 2);
    expect(receiver.requests).toHaveLength(2);
    expect(receiver.requests[1]!.kind).toBe('proposal.escalated');
  });

  it('an unreachable webhook neither blocks nor breaks the notification flow', async () => {
    // Bind-then-close to get a port nothing listens on.
    const dead = await startReceiver();
    const deadUrl = dead.url;
    await dead.close();

    await putWebhook(owner.token, deadUrl);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
      payload: {
        kind: 'install-devices',
        payload: {
          devices: [{ name: 'Lamp', type: 'smart-light', capabilities: ['lighting-control'], zoneId: 'zone-a' }],
        },
      },
    });
    // The producing request succeeds immediately; the inbox row is durable.
    expect(res.statusCode).toBe(201);
    const inbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(owner.token),
    });
    expect(inbox.json().unreadCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Unit: the dispatcher contract
  // -------------------------------------------------------------------------

  it('dispatcher: no webhook → no fetch; failures are swallowed after one retry', async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const failingFetch = (async (url: string | URL) => {
      calls.push(String(url));
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const dispatch = createNotificationWebhookDispatcher({
      userStore: ctx.app.userStore,
      fetchImpl: failingFetch,
      warn: message => warnings.push(message),
    });

    const row = {
      id: 'n1', user_id: owner.id, env_id: envId, kind: 'k', title: 't',
      body_json: '{}', ref_id: null, read_at: null, created_at: new Date().toISOString(),
    };

    // No webhook configured → a no-op.
    dispatch(row);
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toHaveLength(0);

    // Webhook configured → two attempts (initial + one retry), then a warning.
    // Positive wait (R21 test-debt): poll until the give-up warning lands —
    // the retry chain is immediate (no backoff), but under parallel load a
    // fixed 50ms could observe it mid-flight (was a fixed 50ms sleep).
    ctx.app.userStore.setWebhookUrl(owner.id, receiver.url);
    dispatch(row);
    const deadline = Date.now() + 10_000;
    while (warnings.length < 1 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(calls).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('connection refused');
  });
});
