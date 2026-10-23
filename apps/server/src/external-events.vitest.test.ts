/**
 * @vitest-environment node
 *
 * R58 — external event sources (the subscription direction).
 *
 * - mapping.ts: pure template mapping (itemsPath, {field} interpolation,
 *   value coercion, severity validation, dedupe hashing, malformed-item skip)
 * - end to end over a REAL local upstream (node:http serving a weather
 *   feed): register → poll-now → event lands in the running sim + audited
 *   (lane=poller) → re-poll dedupes → disable stops the source.
 */

import { createServer, type Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, makeTestApp, registerUser, importableScenario, type TestAppContext, type TestUser } from './test-utils.js';
import { mapPayload, itemsOf, fillTemplate } from './external-events/mapping.js';

describe('R58 mapping (pure)', () => {
  it('itemsOf walks the dot path; passthrough for bare arrays', () => {
    expect(itemsOf({ data: { alerts: [1, 2] } }, 'data.alerts')).toEqual([1, 2]);
    expect(itemsOf([1], undefined)).toEqual([1]);
    expect(itemsOf({ data: {} }, 'data.alerts')).toEqual([]);
  });

  it('fillTemplate interpolates and reports missing fields as null', () => {
    expect(fillTemplate('wind {wind} m/s', { wind: 43 })).toBe('wind 43 m/s');
    expect(fillTemplate('{missing}', {})).toBeNull();
  });

  it('mapPayload coerces values, validates severity, skips malformed items', () => {
    const out = mapPayload(
      {
        items: [
          { id: 'w1', alertType: 'gale', zone: 'yan-hub', wind: '43.5', level: 'high', text: 'gust' },
          { id: 'w2', alertType: 'gale', zone: 'yan-hub', wind: '12', level: 'bogus' },
          'not-an-object',
        ],
      },
      {
        itemsPath: 'items',
        type: '{alertType}',
        zoneId: '{zone}',
        parameter: 'wind_speed',
        value: '{wind}',
        severity: '{level}',
        description: '{text}',
        dedupeBy: '{id}',
      },
    );
    expect(out.events).toHaveLength(2);
    expect(out.events[0]).toMatchObject({ type: 'gale', zoneId: 'yan-hub', value: 43.5, severity: 'high', description: 'gust', dedupeKey: 'w1' });
    expect(out.events[1]!.severity).toBeUndefined(); // bogus severity dropped, event kept
    expect(out.events[1]!.value).toBe(12);
    expect(out.skipped).toBe(1);
  });

  it('R60: a plain OBJECT at the itemsPath wraps into a single item (Open-Meteo current)', () => {
    expect(itemsOf({ current: { time: 'T', wind_speed_10m: 12 } }, 'current')).toEqual([{ time: 'T', wind_speed_10m: 12 }]);
    expect(itemsOf({ temperature_2m: 31 }, undefined)).toEqual([{ temperature_2m: 31 }]);
    expect(itemsOf(42, undefined)).toEqual([]);
  });

  it('R60: templates walk nested dot paths (USGS GeoJSON properties)', () => {
    expect(fillTemplate('M{properties.mag} {properties.place}', { properties: { mag: 4.7, place: 'Shenzhen' } })).toBe('M4.7 Shenzhen');
    expect(fillTemplate('{properties.deep.nested}', { properties: { mag: 1 } })).toBeNull();
    // End-to-end over a USGS-shaped payload.
    const out = mapPayload(
      { features: [{ properties: { mag: 5.2, place: 'off the coast', code: 'us7008abc' } }] },
      { itemsPath: 'features', type: 'earthquake', zoneId: 'sz-city-command', value: '{properties.mag}', description: '{properties.place}', dedupeBy: '{properties.code}' },
    );
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({ value: 5.2, description: 'off the coast', dedupeKey: 'us7008abc' });
  });

  it('dedupe keys hash the item when no template is given', () => {
    const out = mapPayload([{ a: 1 }], { type: 't', zoneId: 'z' });
    expect(out.events[0]!.dedupeKey).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe('R58 external event sources (end to end)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let stranger: TestUser;
  let envId: string;
  let upstream: Server;
  let upstreamUrl: string;
  let feed: unknown;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('sources-lab'), visibility: 'public' },
    });
    envId = created.json().id as string;

    feed = { items: [{ id: 'w-001', alertType: 'heatwave', zone: 'zone-a', temp: '38.5', level: 'high', text: '高温红色预警' }] };
    upstream = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(feed));
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/feed`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await ctx.cleanup();
  });

  async function runningSim(): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/simulations', headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    const simId = created.json().id as string;
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(owner.token), payload: {} });
    return simId;
  }

  it('register → poll-now → event lands in the sim + audited; re-poll dedupes; disable stops', async () => {
    const simId = await runningSim();

    const registered = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/event-sources`,
      headers: auth(owner.token),
      payload: {
        name: '气象上游',
        url: upstreamUrl,
        pollIntervalSec: 60,
        mapping: {
          itemsPath: 'items', type: '{alertType}', zoneId: '{zone}', parameter: 'temperature',
          value: '{temp}', severity: '{level}', description: '{text}', dedupeBy: '{id}',
        },
      },
    });
    expect(registered.statusCode).toBe(201);
    const sourceId = registered.json().id as string;

    const polled = await ctx.app.inject({
      method: 'POST',
      url: `/api/event-sources/${sourceId}/poll-now`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().status).toBe('ok');
    expect(polled.json().injected).toBe(1);
    expect(polled.json().fetchedItems).toBe(1);

    // The poller targets the AUTHORITATIVE world session (by design), not
    // whichever sim the test started — assert the physics on the runtime
    // the audit row says it hit.
    const audit = ctx.app.db
      .prepare(`SELECT payload_json FROM command_log WHERE env_id = ? AND kind = 'webhook-event' ORDER BY rowid DESC LIMIT 1`)
      .get(envId) as { payload_json: string } | undefined;
    expect(audit).toBeDefined();
    const auditPayload = JSON.parse(audit!.payload_json) as { simulationId: string; lane: string; source: string; type: string };
    expect(auditPayload.lane).toBe('poller');
    expect(auditPayload.source).toBe('气象上游');
    const snap = (await ctx.app.inject({
      method: 'GET', url: `/api/simulations/${auditPayload.simulationId}/snapshot`, headers: auth(owner.token),
    })).json();
    const zoneA = (snap.zones as Array<{ id: string; parameters: Record<string, unknown> }>)
      .find(z => z.id === 'zone-a');
    expect(zoneA).toBeDefined();
    expect(Number(zoneA!.parameters.temperature ?? 0)).toBeGreaterThan(30);

    // Same feed again → deduped, nothing new injected.
    const repolled = await ctx.app.inject({
      method: 'POST', url: `/api/event-sources/${sourceId}/poll-now`, headers: auth(owner.token), payload: {},
    });
    expect(repolled.json().injected).toBe(0);
    expect(repolled.json().deduped).toBe(1);

    // A NEW upstream alert id flows (the seen ledger keys by dedupe id).
    (feed as { items: Array<Record<string, string>> }).items.push(
      { id: 'w-002', alertType: 'heatwave', zone: 'zone-a', temp: '40.5', level: 'critical', text: '更强热浪' },
    );
    const third = await ctx.app.inject({
      method: 'POST', url: `/api/event-sources/${sourceId}/poll-now`, headers: auth(owner.token), payload: {},
    });
    expect(third.json().injected).toBe(1);
    expect(third.json().deduped).toBe(1);

    // Disabled sources are invisible to the due scan.
    await ctx.app.inject({
      method: 'PATCH', url: `/api/event-sources/${sourceId}`, headers: auth(owner.token),
      payload: { enabled: false },
    });
    expect(ctx.app.db.prepare('SELECT COUNT(*) AS n FROM external_event_sources WHERE enabled = 0').get().n).toBe(1);

    // Strangers cannot register sources against someone else's env.
    const denied = await ctx.app.inject({
      method: 'POST', url: `/api/environments/${envId}/event-sources`, headers: auth(stranger.token),
      payload: { name: 'x', url: upstreamUrl },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('a dead upstream records the error honestly (lastError, status=error)', async () => {
    await runningSim();
    const registered = await ctx.app.inject({
      method: 'POST', url: `/api/environments/${envId}/event-sources`, headers: auth(owner.token),
      payload: { name: 'dead', url: 'http://127.0.0.1:1/nope', pollIntervalSec: 60, mapping: { type: '{a}', zoneId: '{b}' } },
    });
    expect(registered.statusCode).toBe(201);
    const polled = await ctx.app.inject({
      method: 'POST', url: `/api/event-sources/${registered.json().id}/poll-now`, headers: auth(owner.token), payload: {},
    });
    expect(polled.json().status).toBe('error');
    expect(polled.json().error).toContain('fetch failed');
    const listed = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}/event-sources`, headers: auth(owner.token),
    })).json().sources as Array<{ lastStatus: string; lastError: string }>;
    expect(listed[0]!.lastStatus).toBe('error');
    expect(listed[0]!.lastError).toContain('fetch failed');
  });
});
