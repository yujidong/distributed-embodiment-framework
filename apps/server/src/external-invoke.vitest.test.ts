/**
 * @vitest-environment node
 *
 * R55 — the external service invocation channel.
 *
 * POST /api/services/:id/invoke + API keys + the per-service OpenAPI
 * fragment: the opening of the ecosystem to plain-HTTP outside callers.
 *
 * - the provider's owner invokes their OWN service directly (device
 *   effect, audited, lane 'service-direct-invoke');
 * - an API key (eak_…, Bearer or X-API-Key) resolves to its user — the
 *   same route works with a classic credential and no platform session;
 * - a key scoped to ONE service cannot invoke another (403 API_KEY_SCOPE);
 * - a revoked key stops authenticating (401);
 * - a stranger with an ACTIVE agreement is delegated to the metered
 *   agreement lane; without one, the 403 teaches the lane;
 * - GET /api/services/:id/openapi.json emits an importable fragment
 *   (action enum, both security schemes).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, makeTestApp, registerUser, type TestAppContext, type TestUser } from './test-utils.js';
import { importableScenario } from './test-utils.js';

describe('R55 external service invocation channel', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let stranger: TestUser;
  let envId: string;
  let hvacServiceId: string;
  let hvacId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('ext-invoke-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    hvacId = (created.json().devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'HVAC B')!.id;

    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(consumer.token) });

    const services = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    })).json().services as Array<{ id: string; name: string }>;
    hvacServiceId = services.find(service => service.name === 'HVAC B: 开启')!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function runningSim(): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/simulations', headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    const simId = created.json().id as string;
    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(owner.token), payload: {},
    });
    return simId;
  }

  it('the provider owner invokes their own service directly — device effect + audited lane', async () => {
    const simId = await runningSim();
    const invoked = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${hvacServiceId}/invoke`,
      headers: auth(owner.token),
      payload: { action: 'turn-on', simulationId: simId },
    });
    expect(invoked.statusCode).toBe(200);
    expect(invoked.json().lane).toBe('direct');
    expect(invoked.json().success).toBe(true);
    expect(invoked.json().deviceId).toBe(hvacId);

    const audit = ctx.app.db
      .prepare(
        `SELECT payload_json FROM command_log
         WHERE env_id = ? AND kind = 'device-command' AND payload_json LIKE '%service-direct-invoke%'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(envId) as { payload_json: string } | undefined;
    expect(audit).toBeDefined();
    expect(JSON.parse(audit!.payload_json).serviceId).toBe(hvacServiceId);
  });

  it('an API key is a first-class credential for the same route (Bearer or X-API-Key)', async () => {
    const minted = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/api-keys`,
      headers: auth(owner.token),
      payload: { name: 'building-automation' },
    });
    expect(minted.statusCode).toBe(201);
    const key = minted.json().key as string;
    expect(key.startsWith('eak_')).toBe(true);

    const simId = await runningSim();
    const viaHeader = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${hvacServiceId}/invoke`,
      headers: { 'x-api-key': key },
      payload: { action: 'turn-on', simulationId: simId },
    });
    expect(viaHeader.statusCode).toBe(200);
    expect(viaHeader.json().lane).toBe('direct');

    // The key shows up in the owner's list with usage bookkeeping.
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/api-keys`,
      headers: auth(owner.token),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().keys).toHaveLength(1);
    expect(listed.json().keys[0].lastUsedAt).not.toBeNull();
  });

  it('a key scoped to ONE service cannot invoke another (403 API_KEY_SCOPE)', async () => {
    // A second service to cross-scope against.
    const other = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    })).json().services as Array<{ id: string; name: string }>;
    const otherService = other.find(service => service.id !== hvacServiceId)!;

    const minted = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/api-keys`,
      headers: auth(owner.token),
      payload: { name: 'scoped', serviceId: hvacServiceId },
    });
    const key = minted.json().key as string;
    await runningSim();
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${otherService.id}/invoke`,
      headers: { authorization: `Bearer ${key}` },
      payload: { action: 'turn-on' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('API_KEY_SCOPE');
  });

  it('a revoked key stops authenticating (401)', async () => {
    const minted = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/api-keys`,
      headers: auth(owner.token),
      payload: { name: 'short-lived' },
    });
    const keyId = minted.json().id as string;
    const key = minted.json().key as string;

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/api-keys/${keyId}`,
      headers: auth(owner.token),
    });
    expect(revoked.statusCode).toBe(204);

    const after = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${hvacServiceId}/invoke`,
      headers: { 'x-api-key': key },
      payload: { action: 'turn-on' },
    });
    expect(after.statusCode).toBe(401);
  });

  it('an agreement holder is delegated to the metered lane; a stranger is taught the lane', async () => {
    const simId = await runningSim();

    // Stranger without an agreement: 403 with the teaching message.
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${hvacServiceId}/invoke`,
      headers: auth(stranger.token),
      payload: { action: 'turn-on', simulationId: simId },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toContain('agreement');

    // Consumer proposes + owner accepts → delegated invocation succeeds.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${hvacServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });

    const delegated = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${hvacServiceId}/invoke`,
      headers: auth(consumer.token),
      payload: { action: 'turn-on', simulationId: simId },
    });
    expect(delegated.statusCode).toBe(200);
    expect(delegated.json().lane).toBe('agreement');
    expect(delegated.json().agreementId).toBe(agreementId);
  });

  it('the per-service OpenAPI fragment is importable (action enum + both security schemes)', async () => {
    const fragment = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${hvacServiceId}/openapi.json`,
      headers: auth(owner.token),
    });
    expect(fragment.statusCode).toBe(200);
    const doc = fragment.json() as {
      openapi: string;
      paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: object }> } }>>;
      components: { securitySchemes: Record<string, object> };
    };
    expect(doc.openapi).toBe('3.1.0');
    const operation = doc.paths[`/api/services/${hvacServiceId}/invoke`]!.post!;
    const schema = operation.requestBody!.content['application/json']!.schema as {
      properties: { action: { enum?: string[] } };
    };
    expect(schema.properties.action.enum).toContain('turn-on');
    expect(Object.keys(doc.components.securitySchemes)).toEqual(expect.arrayContaining(['ApiKeyAuth', 'bearerAuth']));
  });

describe('R56 inbound webhook events (external systems push into the world)', () => {
  it('an env-scoped API key pushes an event — agents targeted, audited as webhook-event', async () => {
    const minted = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/api-keys`,
      headers: auth(owner.token),
      payload: { name: 'weather-upstream' },
    });
    const key = minted.json().key as string;

    const simId = await runningSim();
    const pushed = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/webhook-events`,
      headers: { 'x-api-key': key },
      payload: {
        type: 'gale', zoneId: 'zone-a', parameter: 'wind_speed', value: 41,
        severity: 'high', description: '外部气象上游：大风红色预警', simulationId: simId,
      },
    });
    expect(pushed.statusCode).toBeLessThan(300);
    expect(pushed.json().eventId).toBeDefined();
    expect(Array.isArray(pushed.json().targetAgentIds)).toBe(true);

    const audit = ctx.app.db
      .prepare(`SELECT payload_json FROM command_log WHERE env_id = ? AND kind = 'webhook-event' ORDER BY rowid DESC LIMIT 1`)
      .get(envId) as { payload_json: string } | undefined;
    expect(audit).toBeDefined();
    expect(JSON.parse(audit!.payload_json).type).toBe('gale');
    expect(JSON.parse(audit!.payload_json).lane).toBe('api-key');
  });

  it('a SERVICE-scoped key is refused for world writes (403 API_KEY_SCOPE)', async () => {
    const minted = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/api-keys`,
      headers: auth(owner.token),
      payload: { name: 'svc-only', serviceId: hvacServiceId },
    });
    const key = minted.json().key as string;
    await runningSim();
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/webhook-events`,
      headers: { 'x-api-key': key },
      payload: { type: 'gale', zoneId: 'zone-a' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('API_KEY_SCOPE');
  });

  it('a non-member JWT is refused with the minting guidance', async () => {
    await runningSim();
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/webhook-events`,
      headers: auth(stranger.token),
      payload: { type: 'gale', zoneId: 'zone-a' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toContain('api-keys');
  });
});
});
