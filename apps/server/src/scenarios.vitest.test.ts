/**
 * @vitest-environment node
 *
 * Scenario API tests (fastify inject, no network, no LLM backend).
 *
 * Each test runs against a fresh server whose USER store is a temp dir
 * (seed dir stays the repo's real config/scenarios — read-only). The
 * bundled seed `cross-brand-home` (1 zone / 4 devices / 4 agents) is the
 * fixture for read-only and 403 paths.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from './server.js';
import { auth, registerUser, type TestUser } from './test-utils.js';

const SEED_ID = 'cross-brand-home';

function minimalScenario(id: string, name = 'Test Scenario') {
  return {
    version: '1.0',
    meta: { id, name, description: 'created by test' },
    zones: [{ id: 'zone-a', adjacentZoneIds: [] }],
    devices: [
      {
        id: 'sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'agent-a',
        name: 'Agent A',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['sensor-a'],
      },
    ],
  };
}

describe('scenario API', () => {
  let app: FastifyInstance;
  let userDir: string;
  let user: TestUser;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'scenario-store-test-'));
    app = await buildServer({ userDir, logger: false, databasePath: ':memory:' });
    user = await registerUser(app);
  });

  afterEach(async () => {
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
  });

  it('lists bundled seed scenarios with counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scenarios' });
    expect(res.statusCode).toBe(200);
    const seed = res.json().scenarios.find((s: { id: string }) => s.id === SEED_ID);
    expect(seed).toBeDefined();
    expect(seed.source).toBe('seed');
    expect(seed.counts).toEqual({ zones: 1, devices: 4, agents: 4, events: 1 });
  });

  it('returns the full scenario JSON for GET /:id', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/scenarios/${SEED_ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.id).toBe(SEED_ID);
    expect(res.json().zones).toHaveLength(1);
  });

  it('404s unknown scenario ids with the standard error shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scenarios/no-such-scenario' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SCENARIO_NOT_FOUND');
    expect(typeof res.json().error.message).toBe('string');
  });

  it('creates a user scenario (201) and serves it back', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: auth(user.token),
      payload: minimalScenario('my-scenario'),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().meta.id).toBe('my-scenario');

    const get = await app.inject({ method: 'GET', url: '/api/scenarios/my-scenario' });
    expect(get.statusCode).toBe(200);
    expect(get.json().meta.name).toBe('Test Scenario');

    const list = await app.inject({ method: 'GET', url: '/api/scenarios' });
    const entry = list.json().scenarios.find((s: { id: string }) => s.id === 'my-scenario');
    expect(entry.source).toBe('user');
    expect(entry.counts).toEqual({ zones: 1, devices: 1, agents: 1, events: 0 });
  });

  it('401s anonymous writes (Fix-6 — reads stay anonymous)', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      payload: minimalScenario('anon'),
    });
    expect(post.statusCode).toBe(401);
    const put = await app.inject({
      method: 'PUT',
      url: `/api/scenarios/${SEED_ID}`,
      payload: minimalScenario(SEED_ID),
    });
    expect(put.statusCode).toBe(401);
    const del = await app.inject({ method: 'DELETE', url: `/api/scenarios/${SEED_ID}` });
    expect(del.statusCode).toBe(401);
    // …while the legacy frontend's read path keeps working without a token.
    expect((await app.inject({ method: 'GET', url: '/api/scenarios' })).statusCode).toBe(200);
  });

  it('400s with the per-issue list on invalid bodies', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: auth(user.token),
      payload: { version: '1.0', meta: { id: 'broken' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SCENARIO_VALIDATION_FAILED');
    expect(Array.isArray(res.json().error.issues)).toBe(true);
    expect(res.json().error.issues.length).toBeGreaterThan(0);
  });

  it('409s on duplicate ids (user and seed alike)', async () => {
    await app.inject({ method: 'POST', url: '/api/scenarios', headers: auth(user.token), payload: minimalScenario('dup') });
    const dupUser = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: auth(user.token),
      payload: minimalScenario('dup'),
    });
    expect(dupUser.statusCode).toBe(409);
    expect(dupUser.json().error.code).toBe('SCENARIO_EXISTS');

    const dupSeed = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: auth(user.token),
      payload: minimalScenario(SEED_ID),
    });
    expect(dupSeed.statusCode).toBe(409);
  });

  it('400s on ids that are unsafe as file names', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: auth(user.token),
      payload: minimalScenario('../escape'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_SCENARIO_ID');
  });

  it('replaces a user scenario via PUT', async () => {
    await app.inject({ method: 'POST', url: '/api/scenarios', headers: auth(user.token), payload: minimalScenario('edit-me') });
    const res = await app.inject({
      method: 'PUT',
      headers: auth(user.token),
      url: '/api/scenarios/edit-me',
      payload: minimalScenario('edit-me', 'Renamed'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.name).toBe('Renamed');
  });

  it('403s PUT and DELETE against bundled seeds', async () => {
    const put = await app.inject({
      method: 'PUT',
      headers: auth(user.token),
      url: `/api/scenarios/${SEED_ID}`,
      payload: minimalScenario(SEED_ID),
    });
    expect(put.statusCode).toBe(403);
    expect(put.json().error.code).toBe('SCENARIO_READONLY');

    const del = await app.inject({ method: 'DELETE', url: `/api/scenarios/${SEED_ID}`, headers: auth(user.token) });
    expect(del.statusCode).toBe(403);
    expect(del.json().error.code).toBe('SCENARIO_READONLY');
  });

  it('404s PUT and DELETE for unknown ids', async () => {
    const put = await app.inject({
      method: 'PUT',
      headers: auth(user.token),
      url: '/api/scenarios/ghost',
      payload: minimalScenario('ghost'),
    });
    expect(put.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: '/api/scenarios/ghost', headers: auth(user.token) });
    expect(del.statusCode).toBe(404);
  });

  it('400s PUT when body id differs from the path id', async () => {
    await app.inject({ method: 'POST', url: '/api/scenarios', headers: auth(user.token), payload: minimalScenario('keep-id') });
    const res = await app.inject({
      method: 'PUT',
      headers: auth(user.token),
      url: '/api/scenarios/keep-id',
      payload: minimalScenario('other-id'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SCENARIO_ID_MISMATCH');
  });

  it('deletes a user scenario (204) and then 404s', async () => {
    await app.inject({ method: 'POST', url: '/api/scenarios', headers: auth(user.token), payload: minimalScenario('gone') });
    const del = await app.inject({ method: 'DELETE', url: '/api/scenarios/gone', headers: auth(user.token) });
    expect(del.statusCode).toBe(204);
    const get = await app.inject({ method: 'GET', url: '/api/scenarios/gone' });
    expect(get.statusCode).toBe(404);
  });

  // T-031 (DevLoop R17): the store persists the RAW uploaded document, not
  // the loader-normalized definition — the normalized form used to strip the
  // geo tier (map block, zone polygons, device brand/position), so a saved
  // geo scenario silently re-imported as a grid world (EC-F11).
  it('T-031: saves the raw document — geo tier survives save → GET → re-import', async () => {
    const geoScenario = {
      version: '1.0',
      meta: { id: 'geo-copy', name: 'Geo Copy', description: 'raw round-trip' },
      map: { type: 'geo', center: { lat: 22.59, lng: 114.08 }, zoom: 10 },
      zones: [
        {
          id: 'zone-bay',
          name: '海湾',
          polygon: [
            [22.62, 113.78],
            [22.62, 113.92],
            [22.72, 113.92],
            [22.72, 113.78],
          ],
          adjacentZoneIds: [],
          baseline: { temperature: 24 },
        },
      ],
      devices: [
        {
          id: 'dev-weather',
          name: '气象站',
          type: 'temperature-sensor',
          brand: 'Vaisala',
          capabilities: ['temperature-reading'],
          zoneId: 'zone-bay',
          position: { lat: 22.665, lng: 113.84 },
        },
      ],
      agents: [
        {
          id: 'agent-watch',
          name: 'Watcher',
          capabilities: ['temperature-monitoring'],
          managesZoneIds: ['zone-bay'],
          boundDeviceIds: ['dev-weather'],
        },
      ],
    };

    const post = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: auth(user.token),
      payload: geoScenario,
    });
    expect(post.statusCode).toBe(201);
    // The 201 body is the raw document — the map block is already intact.
    expect(post.json().map).toEqual(geoScenario.map);

    const get = await app.inject({ method: 'GET', url: '/api/scenarios/geo-copy' });
    expect(get.statusCode).toBe(200);
    const doc = get.json();
    expect(doc.map).toEqual(geoScenario.map);
    expect(doc.zones[0].polygon).toEqual(geoScenario.zones[0].polygon);
    expect(doc.devices[0].brand).toBe('Vaisala');
    expect(doc.devices[0].position).toEqual(geoScenario.devices[0].position);

    // The saved copy re-imports as a GEO environment (was: grid world).
    const imported = await app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(user.token),
      payload: doc,
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().mapType).toBe('geo');
    const detail = await app.inject({
      method: 'GET',
      url: `/api/environments/${imported.json().id}`,
      headers: auth(user.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().mapType).toBe('geo');
    expect(detail.json().zones[0].polygon).toEqual(geoScenario.zones[0].polygon);
    expect(detail.json().devices.find((d: { id: string }) => d.name === '气象站').brand).toBe('Vaisala');
  });
});
