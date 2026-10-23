/**
 * @vitest-environment node
 *
 * Presence tests — presence frames on `GET /api/environments/:id/stream`.
 *
 * Wire contract (world-sync.ts):
 * - on connect the new client receives a private
 *   `{kind:'presence', action:'snapshot', users:[{id,displayName}], anonymousCount}`;
 * - a user's FIRST connection broadcasts `{...action:'online', user}` to the
 *   other subscribers; their LAST disconnect broadcasts `'offline'`;
 * - anonymous viewers of public environments only move `anonymousCount` —
 *   they never broadcast.
 *
 * "No frame was broadcast" is asserted by publishing a world change right
 * after the event: the observer's next world-OR-presence frame must be that
 * world message (any pending presence frame would arrive first; R73's
 * 'world-session' status frames share the channel and are skipped).
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

type Frame = Record<string, unknown>;

/** Buffered per-socket frame reader (attached before 'open' — no frame lost). */
function collector(socket: WebSocket) {
  const buffer: Frame[] = [];
  const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  socket.on('message', raw => {
    const frame = JSON.parse(raw.toString()) as Frame;
    const index = waiters.findIndex(w => w.pred(frame));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(frame);
    else buffer.push(frame);
  });
  return {
    next(pred: (f: Frame) => boolean = () => true, timeoutMs = 4000): Promise<Frame> {
      const index = buffer.findIndex(pred);
      if (index >= 0) return Promise.resolve(buffer.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          pred,
          resolve: (frame: Frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error('timed out waiting for stream frame'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

const isPresence = (action?: string) => (frame: Frame) =>
  frame.kind === 'presence' && (action === undefined || frame.action === action);

// R73 (worlds auto-start and never hibernate) interleaves 'world-session'
// status frames on this same channel. The "no presence frame in between"
// invariant is therefore asserted on the first world-OR-presence frame:
// session-status frames are skipped, an unexpected presence frame still
// fails the test.
const isWorldOrPresence = (frame: Frame) => frame.kind === 'world' || frame.kind === 'presence';

describe('environment presence', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let observer: TestUser;
  let envId: string;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    observer = await registerUser(ctx.app, { displayName: 'Observer' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Presence Lab',
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

  function connect(user?: TestUser): { socket: WebSocket; frames: ReturnType<typeof collector> } {
    const socket = new WebSocket(`${baseUrl}/api/environments/${envId}/stream`, {
      headers: user ? { authorization: `Bearer ${user.token}` } : {},
    });
    sockets.push(socket);
    return { socket, frames: collector(socket) };
  }

  function opened(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
  }

  function closed(socket: WebSocket): Promise<void> {
    return new Promise(resolve => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once('close', () => resolve());
    });
  }

  /** Publish a world change the observer can use as an ordering tick. */
  async function publishWorldChange(): Promise<void> {
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: { description: `tick ${Date.now()}` },
    });
    expect(response.statusCode).toBe(200);
  }

  it('sends a snapshot on join and broadcasts online/offline to the others', async () => {
    const a = connect(observer);
    await opened(a.socket);
    const snapshotA = await a.frames.next(isPresence('snapshot'));
    expect(snapshotA.users).toEqual([{ id: observer.id, displayName: 'Observer' }]);
    expect(snapshotA.anonymousCount).toBe(0);

    const b = connect(owner);
    await opened(b.socket);
    const onlineB = await a.frames.next(isPresence('online'));
    expect(onlineB.user).toEqual({ id: owner.id, displayName: 'Owner' });
    // The new client itself gets exactly one frame: the roster including it.
    const snapshotB = await b.frames.next(isPresence('snapshot'));
    expect(snapshotB.users).toEqual(
      expect.arrayContaining([
        { id: observer.id, displayName: 'Observer' },
        { id: owner.id, displayName: 'Owner' },
      ]),
    );

    b.socket.close();
    const offlineB = await a.frames.next(isPresence('offline'));
    expect(offlineB.user).toEqual({ id: owner.id, displayName: 'Owner' });
  });

  it('keeps a multi-tab user online until the last connection closes', async () => {
    const a = connect(observer);
    await opened(a.socket);
    await a.frames.next(isPresence('snapshot'));

    const tab1 = connect(owner);
    await opened(tab1.socket);
    await tab1.frames.next(isPresence('snapshot'));
    expect((await a.frames.next(isPresence('online'))).user).toMatchObject({ id: owner.id });

    // Second tab: no new 'online' broadcast — the snapshot carries the user once.
    const tab2 = connect(owner);
    await opened(tab2.socket);
    const snapshotTab2 = await tab2.frames.next(isPresence('snapshot'));
    expect((snapshotTab2.users as unknown[]).length).toBe(2);
    await publishWorldChange();
    expect((await a.frames.next(isWorldOrPresence)).kind).toBe('world'); // no presence frame in between

    // Closing one tab keeps the user online…
    tab1.socket.close();
    await closed(tab1.socket);
    await publishWorldChange();
    expect((await a.frames.next(isWorldOrPresence)).kind).toBe('world');

    // …closing the last one broadcasts 'offline'.
    tab2.socket.close();
    const offline = await a.frames.next(isPresence('offline'));
    expect(offline.user).toMatchObject({ id: owner.id });
  });

  it('counts anonymous viewers in snapshots without broadcasting them', async () => {
    const a = connect(observer);
    await opened(a.socket);
    await a.frames.next(isPresence('snapshot'));

    const anon = connect();
    await opened(anon.socket);
    const snapshotAnon = await anon.frames.next(isPresence('snapshot'));
    expect(snapshotAnon.anonymousCount).toBe(1);
    expect(snapshotAnon.users).toEqual([{ id: observer.id, displayName: 'Observer' }]);

    // No 'online' frame for the anonymous viewer…
    await publishWorldChange();
    expect((await a.frames.next(isWorldOrPresence)).kind).toBe('world');

    // …and no 'offline' frame when they leave; the counter drops for joiners.
    anon.socket.close();
    await closed(anon.socket);
    await publishWorldChange();
    expect((await a.frames.next(isWorldOrPresence)).kind).toBe('world');
    expect(ctx.app.worldSync.presenceOf(envId).anonymousCount).toBe(0);
  });
});
