/**
 * @vitest-environment node
 *
 * World-change stream tests — `GET /api/environments/:id/stream` (WebSocket).
 *
 * Subscribers (any member, or anyone for public environments) receive
 * `{kind:'world', action, objectType, object}` messages for every mutation
 * in the environment. Access checks happen BEFORE the upgrade, mirroring
 * the simulation stream's 404 pattern.
 */

import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('environment world stream', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Stream Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    envId = created.json().id;
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      try { socket.close(); } catch { /* already closed */ }
    }
    await ctx.cleanup();
  });

  function connect(path: string, headers?: Record<string, string>): WebSocket {
    const socket = new WebSocket(`${baseUrl}${path}`, { headers });
    sockets.push(socket);
    return socket;
  }

  function opened(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
  }

  function nextMessage(socket: WebSocket, timeoutMs = 4000): Promise<Record<string, unknown>> {
    // Presence frames (snapshot on connect, online/offline) share the socket;
    // this helper only cares about world changes and skips the rest.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for world message')), timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString()) as { kind?: string };
        if (parsed.kind !== 'world') return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(parsed as Record<string, unknown>);
      };
      socket.on('message', onMessage);
      socket.once('error', err => {
        clearTimeout(timer);
        socket.off('message', onMessage);
        reject(err);
      });
    });
  }

  it('broadcasts device/agent/environment mutations to subscribers', async () => {
    // Public environment: an ANONYMOUS subscriber is allowed.
    const socket = connect(`/api/environments/${envId}/stream`);
    await opened(socket);

    const devicePromise = nextMessage(socket);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Lamp', type: 'smart-light', capabilities: ['lighting-control'], zoneId: 'zone-a' },
    });
    expect(created.statusCode).toBe(201);
    const deviceMsg = await devicePromise;
    expect(deviceMsg.kind).toBe('world');
    expect(deviceMsg.action).toBe('created');
    expect(deviceMsg.objectType).toBe('device');
    expect((deviceMsg.object as { name: string }).name).toBe('Lamp');
    expect((deviceMsg.object as { owner: { displayName: string } }).owner.displayName).toBe('Owner');
    // Fix-1: world-change broadcasts name the acting user.
    expect(deviceMsg.actor).toEqual({ id: owner.id, displayName: 'Owner' });

    const agentPromise = nextMessage(socket);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Light Agent', capabilities: [] },
    });
    const agentMsg = await agentPromise;
    expect(agentMsg.objectType).toBe('agent');
    expect(agentMsg.action).toBe('created');

    const patchPromise = nextMessage(socket);
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: { description: 'updated description' },
    });
    const patchMsg = await patchPromise;
    expect(patchMsg.objectType).toBe('environment');
    expect(patchMsg.action).toBe('updated');
    expect(patchMsg.actor).toEqual({ id: owner.id, displayName: 'Owner' });

    const deletePromise = nextMessage(socket);
    const deviceId = created.json().id;
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/devices/${deviceId}`,
      headers: auth(owner.token),
    });
    const deleteMsg = await deletePromise;
    expect(deleteMsg).toMatchObject({
      kind: 'world',
      action: 'deleted',
      objectType: 'device',
      object: { id: deviceId },
    });

    socket.close();
  });

  it('rejects unknown environments (404) and private strangers (403) before the upgrade', async () => {
    const unknown = await ctx.app.inject({ method: 'GET', url: '/api/environments/nope/stream' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('ENVIRONMENT_NOT_FOUND');

    const priv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Private', visibility: 'private' },
    });
    const privId = priv.json().id;
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${privId}/stream`,
    });
    expect(forbidden.statusCode).toBe(403);

    // … and a real upgrade attempt against the private env fails to open,
    // while a member (Bearer on the upgrade request) connects fine.
    const strangerSocket = connect(`/api/environments/${privId}/stream`);
    await new Promise<void>(resolve => {
      strangerSocket.on('error', () => resolve());
      strangerSocket.on('close', () => resolve());
    });

    const memberSocket = connect(`/api/environments/${privId}/stream`, {
      authorization: `Bearer ${owner.token}`,
    });
    await opened(memberSocket);
    memberSocket.close();
  });

  // ---------------------------------------------------------------------------
  // Governance events (Fix-4): proposal lifecycle on the stream
  // ---------------------------------------------------------------------------

  /** Wait for a proposal message with the given action (skips other kinds). */
  function nextProposalMessage(
    socket: WebSocket,
    action: string,
    timeoutMs = 4000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for proposal "${action}" message`)),
        timeoutMs,
      );
      const onMessage = (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString()) as { kind?: string; action?: string };
        if (parsed.kind !== 'proposal' || parsed.action !== action) return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(parsed as Record<string, unknown>);
      };
      socket.on('message', onMessage);
      socket.once('error', err => {
        clearTimeout(timer);
        socket.off('message', onMessage);
        reject(err);
      });
    });
  }

  it('broadcasts proposal lifecycle transitions with actor + proposalId', async () => {
    // A builder member (default reviewer escalates everything).
    const builder = await registerUser(ctx.app, { displayName: 'Builder' });
    ctx.app.envStore.addMember(envId, builder.id, 'builder');

    const socket = connect(`/api/environments/${envId}/stream`);
    await opened(socket);

    // Submit → submitted + escalated (the owner's "todo"), actor = author.
    const submittedPromise = nextProposalMessage(socket, 'submitted');
    const escalatedPromise = nextProposalMessage(socket, 'escalated');
    const submitted = await ctx.app.inject({
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
    expect(submitted.statusCode).toBe(201);
    const proposalId = submitted.json().id as string;

    const submittedMsg = await submittedPromise;
    expect(submittedMsg).toMatchObject({
      kind: 'proposal',
      action: 'submitted',
      proposalId,
      envId,
      actor: { id: builder.id, displayName: 'Builder' },
    });
    expect((await escalatedPromise).proposalId).toBe(proposalId);

    // Owner approves → approved + applied, actor = owner (the decider).
    const approvedPromise = nextProposalMessage(socket, 'approved');
    const appliedPromise = nextProposalMessage(socket, 'applied');
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.statusCode).toBe(200);
    expect((await approvedPromise).actor).toEqual({ id: owner.id, displayName: 'Owner' });
    expect((await appliedPromise).actor).toEqual({ id: owner.id, displayName: 'Owner' });

    // Revert by the author → reverted.
    const revertedPromise = nextProposalMessage(socket, 'reverted');
    const reverted = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/revert`,
      headers: auth(builder.token),
    });
    expect(reverted.statusCode).toBe(200);
    expect((await revertedPromise).actor).toEqual({ id: builder.id, displayName: 'Builder' });

    // Rule-check failure → submitted + rejected.
    const submitted2Promise = nextProposalMessage(socket, 'submitted');
    const rejectedPromise = nextProposalMessage(socket, 'rejected');
    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
      payload: {
        kind: 'install-devices',
        payload: {
          devices: [{ name: 'Ghost', type: 'smart-light', capabilities: ['lighting-control'], zoneId: 'no-such-zone' }],
        },
      },
    });
    expect(bad.statusCode).toBe(201);
    expect(bad.json().status).toBe('rejected');
    expect((await submitted2Promise).proposalId).toBe(bad.json().id);
    expect((await rejectedPromise).actor).toEqual({ id: builder.id, displayName: 'Builder' });

    socket.close();
  });

  // ---------------------------------------------------------------------------
  // T-007 lifecycle regressions: deletion ends the stream, client data gets
  // a teaching error frame, and the heartbeat reaps dead peers (presence
  // hygiene — a dead connection used to keep its user "online" forever).
  // ---------------------------------------------------------------------------

  it('closes subscribers with 1001 "environment deleted" after broadcasting the deletion', async () => {
    const socket = connect(`/api/environments/${envId}/stream`);
    await opened(socket);

    const deletedPromise = nextMessage(socket);
    const closed = new Promise<{ code: number; reason: string }>(resolve => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(204);

    const deletedMsg = await deletedPromise;
    expect(deletedMsg).toMatchObject({
      kind: 'world',
      action: 'deleted',
      objectType: 'environment',
      object: { id: envId },
    });
    const close = await closed;
    expect(close.code).toBe(1001);
    expect(close.reason).toBe('environment deleted');
  });

  it('answers client-sent data with a STREAM_READ_ONLY error frame and stays open', async () => {
    const socket = connect(`/api/environments/${envId}/stream`);
    await opened(socket);

    socket.send('hello?');
    const errorFrame = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for error frame')), 4000);
      const onMessage = (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString()) as { kind?: string };
        if (parsed.kind !== 'error') return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(parsed as Record<string, unknown>);
      };
      socket.on('message', onMessage);
    });
    expect(errorFrame.code).toBe('STREAM_READ_ONLY');
    expect(errorFrame.message).toMatch(/receive-only/);
    expect(errorFrame.message).toMatch(/\/api\/environments/);

    // The stream survives: a world mutation still arrives on the same socket.
    const devicePromise = nextMessage(socket);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Lamp 2', type: 'smart-light', capabilities: ['lighting-control'], zoneId: 'zone-a' },
    });
    expect((await devicePromise).action).toBe('created');
    socket.close();
  });
});

// ---------------------------------------------------------------------------
// T-007: heartbeat — a peer that dies without a FIN must be terminated
// within ~2 heartbeat cycles, releasing its presence entry and ws gauge.
// ---------------------------------------------------------------------------
describe('environment world stream heartbeat', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    ctx = await makeTestApp({ agreementStreamHeartbeatMs: 100 });
    owner = await registerUser(ctx.app, { displayName: 'HB Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'HB Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    envId = created.json().id;
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      try { socket.close(); } catch { /* already closed */ }
    }
    await ctx.cleanup();
  });

  it('reaps a dead peer and drops it from the presence roster + ws gauge', async () => {
    const gauge = () =>
      (ctx.app as unknown as { metrics: { wsConnections: () => { environment: number } } })
        .metrics.wsConnections().environment;

    /** Resolve on the next presence frame with the given action. */
    const nextPresence = (socket: WebSocket, action: string): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for presence "${action}"`)),
          4000,
        );
        const onMessage = (raw: WebSocket.RawData) => {
          const parsed = JSON.parse(raw.toString()) as { kind?: string; action?: string };
          if (parsed.kind !== 'presence' || parsed.action !== action) return;
          clearTimeout(timer);
          socket.off('message', onMessage);
          resolve(parsed as Record<string, unknown>);
        };
        socket.on('message', onMessage);
      });

    // A healthy anonymous observer (public env) + the soon-dead owner socket.
    // NB: the presence snapshot is sent the instant the upgrade completes, so
    // the listeners must be armed BEFORE awaiting 'open' (a frame arriving
    // between open and listener-attach would otherwise be dropped).
    const observer = new WebSocket(`${baseUrl}/api/environments/${envId}/stream`);
    sockets.push(observer);
    const snapshotPromise = nextPresence(observer, 'snapshot');
    await new Promise<void>(resolve => observer.once('open', resolve));
    await snapshotPromise;

    const dead = new WebSocket(`${baseUrl}/api/environments/${envId}/stream`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    sockets.push(dead);
    const onlinePromise = nextPresence(observer, 'online');
    await new Promise<void>(resolve => dead.once('open', resolve));
    const online = await onlinePromise;
    expect(online.user).toEqual({ id: owner.id, displayName: 'HB Owner' });
    expect(gauge()).toBe(2);

    // Pause the underlying TCP: the server's pings get no pong back.
    (dead as unknown as { _socket: { pause(): void } })._socket.pause();
    const offline = await nextPresence(observer, 'offline'); // within ~2 cycles
    expect(offline.user).toEqual({ id: owner.id, displayName: 'HB Owner' });
    expect(gauge()).toBe(1); // the dead peer's gauge slot was released
    observer.close();
  });
});
