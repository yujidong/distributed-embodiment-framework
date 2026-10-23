/**
 * @vitest-environment node
 *
 * Per-surface device-privacy redaction tests (DevLoop S2).
 *
 * The owner-ratified model: devices are visible to members as OBJECTS
 * (structure + coarse status); detailed state/telemetry only travels the
 * service layer. This suite walks the audited read surfaces end to end for
 * the three tiers (device owner / env owner / other member) — the surfaces
 * with dedicated suites (sim snapshot/timeline in simulation-timeline,
 * observations in twin-sync, forks in sandboxes) are asserted there; here
 * are the ones that had none: env detail, device GET, world-stream device
 * frames (per-socket), replay export, and the training-export gate.
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

describe('device privacy per-surface redaction (S2)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let member: TestUser;
  let envId: string;
  let ownerDeviceId: string;
  let memberDeviceId: string;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    member = await registerUser(ctx.app, { displayName: 'Member' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Privacy Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(member.token) });

    const ownerDevice = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Owner Watch',
        type: 'wearable',
        capabilities: ['heart-rate-monitoring'],
        zoneId: 'zone-a',
        initialState: { heartRate: 82 },
      },
    });
    expect(ownerDevice.statusCode).toBe(201);
    ownerDeviceId = ownerDevice.json().id as string;

    // Member device via the governed path (install-devices proposal).
    const submitted = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(member.token),
      payload: {
        kind: 'install-devices',
        payload: {
          devices: [{
            name: 'Member Plug',
            type: 'smart-plug',
            capabilities: ['power-control'],
            zoneId: 'zone-a',
            initialState: { power: true, watt: 33 },
          }],
        },
      },
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().status).toBe('escalated');
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${submitted.json().id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.json().status).toBe('applied');
    memberDeviceId = ((decided.json().createdIds.devices as string[]) ?? [])[0] as string;
    expect(memberDeviceId).toBeTruthy();

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

  function nextWorldMessage(socket: WebSocket, timeoutMs = 4000): Promise<Record<string, unknown>> {
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

  // -------------------------------------------------------------------

  it('env detail: member sees own devices full, foreign devices coarse; owner sees all full', async () => {
    const memberDetail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(member.token),
    });
    expect(memberDetail.statusCode).toBe(200);
    const devices = memberDetail.json().devices as Array<Record<string, unknown>>;
    const foreign = devices.find(d => d.id === ownerDeviceId)!;
    expect(foreign.initialState).toBeUndefined();
    expect(foreign.stateVisibility).toBe('coarse');
    expect(foreign.status).toBe('present'); // pure sensor: presence-only
    expect(JSON.stringify(foreign)).not.toContain('heartRate');
    const own = devices.find(d => d.id === memberDeviceId)!;
    expect(own.initialState).toEqual({ power: true, watt: 33 });
    expect(own.stateVisibility).toBeUndefined();

    const ownerDetail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const ownerView = (ownerDetail.json().devices as Array<Record<string, unknown>>)
      .find(d => d.id === ownerDeviceId)!;
    expect(ownerView.initialState).toEqual({ heartRate: 82 });

    // Anonymous visitors of the public env get the coarse view too.
    const anon = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}` });
    const anonForeign = (anon.json().devices as Array<Record<string, unknown>>)
      .find(d => d.id === ownerDeviceId)!;
    expect(anonForeign.initialState).toBeUndefined();
    expect(anonForeign.stateVisibility).toBe('coarse');
  });

  it('device list GET: same per-tier projection as the detail', async () => {
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/devices`,
      headers: auth(member.token),
    });
    const devices = listed.json().devices as Array<Record<string, unknown>>;
    expect(devices.find(d => d.id === ownerDeviceId)!.stateVisibility).toBe('coarse');
    expect(devices.find(d => d.id === memberDeviceId)!.initialState).toEqual({ power: true, watt: 33 });
  });

  it('world-stream device frames project per socket (twin-sync telemetry never rides to members)', async () => {
    const ownerSocket = connect(`/api/environments/${envId}/stream`, auth(owner.token));
    const memberSocket = connect(`/api/environments/${envId}/stream`, auth(member.token));
    await Promise.all([opened(ownerSocket), opened(memberSocket)]);

    const ownerFrame = nextWorldMessage(ownerSocket);
    const memberFrame = nextWorldMessage(memberSocket);
    // Twin-sync writes an observed value into the OWNER device row and
    // broadcasts the updated device — the exact frame that used to carry
    // foreign telemetry to every subscriber.
    ctx.app.observationStore.append({
      envId,
      entityId: ownerDeviceId,
      key: 'heartRate',
      value: 91,
      wallTime: new Date().toISOString(),
    });
    const bindings = await ctx.app.inject({
      method: 'PUT',
      url: `/api/environments/${envId}/sync-bindings`,
      headers: auth(owner.token),
      payload: { bindings: [{ deviceInstanceId: ownerDeviceId, attributeKey: 'heart-rate', source: 'manual' }] },
    });
    expect(bindings.statusCode).toBe(200);
    await ctx.app.twinSync.ingestManual(envId, ownerDeviceId, 'heart-rate', 91, null);

    const [ownerMsg, memberMsg] = await Promise.all([ownerFrame, memberFrame]);
    expect(ownerMsg.objectType).toBe('device');
    expect((ownerMsg.object as Record<string, unknown>).initialState).toMatchObject({ 'heart-rate': 91 });
    const memberObject = memberMsg.object as Record<string, unknown>;
    expect(memberObject.stateVisibility).toBe('coarse');
    // The reading never rides: the coarse projection's only data carriers
    // are state/initialState, both absent. (No blunt substring checks:
    // capability names legitimately carry the metric key — e.g.
    // 'heart-rate-monitoring' is public market metadata — and ids/
    // timestamps contain arbitrary digit runs.)
    expect(memberObject.initialState).toBeUndefined();
    expect(memberObject.state).toBeUndefined();
  });

  it('replay export: member omits foreign telemetry events + strips foreign initialState; owner exports full', async () => {
    const t0 = '2026-07-01T08:00:00.000Z';
    const t1 = '2026-07-01T09:00:00.000Z';
    ctx.app.observationStore.append({ envId, entityId: ownerDeviceId, key: 'heartRate', value: 88, wallTime: t0 });
    ctx.app.observationStore.append({ envId, entityId: memberDeviceId, key: 'watt', value: 41, wallTime: t0 });

    const memberReplay = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replays`,
      headers: auth(member.token),
      payload: { from: t0, to: t1 },
    });
    expect(memberReplay.statusCode).toBe(200);
    const memberReport = memberReplay.json().report as Record<string, unknown>;
    expect(memberReport.redactedDeviceEvents).toBeGreaterThanOrEqual(1);
    const scenario = memberReplay.json().scenario as {
      devices: Array<{ id?: string; initialState?: Record<string, unknown> }>;
      events: Array<{ type: string; parameter?: string }>;
    };
    // Foreign device: entry kept (world structure), telemetry stripped.
    const foreign = scenario.devices.find(d => d.id === ownerDeviceId)!;
    expect(foreign.initialState).toBeUndefined();
    // Own device: authored initialState rides verbatim (the in-window
    // change becomes its observation-replay event, asserted below).
    const own = scenario.devices.find(d => d.id === memberDeviceId)!;
    expect(own.initialState).toEqual({ power: true, watt: 33 });
    // No observation-replay event for the foreign device's reading.
    expect(scenario.events.some(e => e.type === 'observation-replay' && e.parameter === 'heartRate')).toBe(false);
    expect(scenario.events.some(e => e.type === 'observation-replay' && e.parameter === 'watt')).toBe(true);

    const ownerReplay = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replays`,
      headers: auth(owner.token),
      payload: { from: t0, to: t1 },
    });
    expect(ownerReplay.statusCode).toBe(200);
    const ownerScenario = ownerReplay.json().scenario as {
      devices: Array<{ id?: string; initialState?: Record<string, unknown> }>;
      events: Array<{ type: string; parameter?: string }>;
    };
    expect((ownerReplay.json().report as Record<string, unknown>).redactedDeviceEvents).toBe(0);
    expect(ownerScenario.devices.find(d => d.id === ownerDeviceId)!.initialState).toMatchObject({ heartRate: 82 });
    expect(ownerScenario.events.some(e => e.type === 'observation-replay' && e.parameter === 'heartRate')).toBe(true);
  });

  it('training export stays owner-only (the full-tier lane) — members 403, owner export carries device state', async () => {
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/training-export`,
      headers: auth(member.token),
    });
    expect(denied.statusCode).toBe(403);

    const exported = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/training-export`,
      headers: auth(owner.token),
    });
    expect(exported.statusCode).toBe(200);
    const manifest = JSON.parse((exported.body as string).split('\n')[0]!) as {
      payload: { snapshot: { devices: Array<{ id?: string; initialState?: Record<string, unknown> }> } };
    };
    const ownerDevice = manifest.payload.snapshot.devices.find(d => d.id === ownerDeviceId);
    expect(ownerDevice?.initialState).toMatchObject({ heartRate: 82 });
  });
});
