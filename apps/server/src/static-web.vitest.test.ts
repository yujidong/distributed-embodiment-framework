/**
 * @vitest-environment node
 *
 * Production static-web serving tests (P3c) — the built web console dist
 * (WEB_DIST) served at `/` with SPA fallback:
 *
 * - `GET /` and real asset files come from the dist;
 * - non-API GETs that match no file fall back to index.html (client-side
 *   view switching), while `/api/*` keeps its JSON contract — including the
 *   JSON 404 shape for unknown API paths;
 * - the WebSocket stream paths (`/api/simulations/:id/stream`,
 *   `/api/environments/:id/stream`) must still upgrade, i.e. the wildcard
 *   static route must not shadow them;
 * - a missing dist degrades `/` to a JSON note instead of crashing.
 *
 * Fixture dist is a two-file temp directory; the WS clients connect to an
 * in-process listener on 127.0.0.1:0 (no external network).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  auth,
  createUserScenario,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

const INDEX_HTML = '<!doctype html><html><body><div id="root">eaf-fixture</div></body></html>';
const BUNDLE_JS = 'console.log("fixture bundle");\n';

/** Minimal stand-in for `vite build` output: index.html + one asset file. */
function makeFixtureDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eaf-web-dist-'));
  writeFileSync(join(dir, 'index.html'), INDEX_HTML);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), BUNDLE_JS);
  return dir;
}

describe('static web console serving (dist present)', () => {
  let ctx: TestAppContext;
  let fixtureDist: string;

  beforeEach(async () => {
    fixtureDist = makeFixtureDist();
    ctx = await makeTestApp({ webDist: fixtureDist });
  });

  afterEach(async () => {
    await ctx.cleanup();
    rmSync(fixtureDist, { recursive: true, force: true });
  });

  it('serves index.html at /', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toBe(INDEX_HTML);
  });

  it('serves real asset files from the dist', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(BUNDLE_JS);
  });

  it('falls back to index.html for non-API GETs that match no file (SPA)', async () => {
    for (const path of ['/some/spa/path', '/worlds/abc/stream']) {
      const res = await ctx.app.inject({ method: 'GET', url: path });
      expect(res.statusCode, path).toBe(200);
      expect(res.body, path).toBe(INDEX_HTML);
    }
  });

  it('keeps the /api contract untouched (list + JSON 404)', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/api/scenarios' });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json().scenarios)).toBe(true);

    const missing = await ctx.app.inject({ method: 'GET', url: '/api/definitely-missing' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('ROUTE_NOT_FOUND');
  });

  // R1 (B1-7 / P-02): the contract entry the docs advertise — /openapi.yaml
  // must serve the YAML itself, never the SPA HTML all four R1 testers got.
  it('serves the contract aliases at the root (openapi.yaml / openapi.json / docs)', async () => {
    const yaml = await ctx.app.inject({ method: 'GET', url: '/openapi.yaml' });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.headers['content-type']).toContain('yaml');
    expect(yaml.body).toContain('openapi:');

    const json = await ctx.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toContain('application/json');
    const parsed = json.json();
    expect(String(parsed.openapi)).toMatch(/^3\.1\./);

    const docs = await ctx.app.inject({ method: 'GET', url: '/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
    expect(docs.body).toContain('/api/openapi.yaml');

    // The alias carries the SAME document as the /api face (one truth).
    const apiYaml = await ctx.app.inject({ method: 'GET', url: '/api/openapi.yaml' });
    expect(yaml.body).toBe(apiYaml.body);
  });

  it('a file-looking miss is an honest 404, not the SPA index', async () => {
    for (const { url, headers } of [
      { url: '/openapi.xml', headers: {} as Record<string, string> },
      { url: '/docs/old-version.html', headers: {} as Record<string, string> },
      { url: '/definitely-not-a-route', headers: { accept: 'application/json' } },
      { url: '/definitely-not-a-route', headers: { accept: 'text/yaml' } },
    ]) {
      const res = await ctx.app.inject({ method: 'GET', url, headers });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code, url).toBe('ROUTE_NOT_FOUND');
    }
  });

  it('extension-less view paths still fall back to the SPA (unchanged)', async () => {
    for (const path of ['/env/some-env', '/simulations/sim-1/stream-view']) {
      const res = await ctx.app.inject({ method: 'GET', url: path });
      expect(res.statusCode, path).toBe(200);
      expect(res.body, path).toBe(INDEX_HTML);
    }
  });
});

describe('static serving does not shadow WebSocket upgrade paths', () => {
  let ctx: TestAppContext;
  let fixtureDist: string;
  let owner: TestUser;
  let simId: string;
  let envId: string;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    fixtureDist = makeFixtureDist();
    ctx = await makeTestApp({ webDist: fixtureDist, snapshotEverySimSec: 1 });
    owner = await registerUser(ctx.app, { displayName: 'Streamer' });

    await createUserScenario(ctx.app, importableScenario('static-lab'), owner.token);
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'static-lab' },
    });
    simId = sim.json().id;

    const env = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Static Stream Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    envId = env.json().id;

    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      try { socket.close(); } catch { /* already closed */ }
    }
    await ctx.cleanup();
    rmSync(fixtureDist, { recursive: true, force: true });
  });

  function connect(path: string, headers?: Record<string, string>): Promise<WebSocket> {
    const socket = new WebSocket(`${baseUrl}${path}`, { headers });
    sockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });
  }

  it('GET /api/simulations/:id/stream still upgrades', async () => {
    const socket = new WebSocket(`${baseUrl}/api/simulations/${simId}/stream`);
    sockets.push(socket);
    // The server pushes the first snapshot immediately on upgrade — capture
    // it from socket creation so an open+message same-tick flush can't slip
    // past a listener attached after `await open`.
    const firstMessage = new Promise<{ kind?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for snapshot')), 4000);
      socket.once('message', raw => {
        clearTimeout(timer);
        resolve(JSON.parse(raw.toString()));
      });
      socket.once('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const first = await firstMessage;
    expect(first.kind).toBe('snapshot');
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop` });
  });

  it('GET /api/environments/:id/stream still upgrades', async () => {
    // 'open' alone proves the upgrade; no need to wait for a world frame.
    await connect(`/api/environments/${envId}/stream`, auth(owner.token));
  });
});

describe('static web console serving (dist missing)', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    // makeTestApp defaults webDist to a path that does not exist.
    ctx = await makeTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('answers / with a JSON note instead of crashing', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json().note).toContain('frontend not built');
  });

  it('keeps the API working and non-API GETs on the JSON 404 contract', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/api/scenarios' });
    expect(list.statusCode).toBe(200);

    const spa = await ctx.app.inject({ method: 'GET', url: '/some/spa/path' });
    expect(spa.statusCode).toBe(404);
    expect(spa.json().error.code).toBe('ROUTE_NOT_FOUND');
  });

  // R1 (B1-7): the contract aliases exist even without a web console dist —
  // a contract is useless behind a build artifact.
  it('serves the root contract aliases without the SPA', async () => {
    const yaml = await ctx.app.inject({ method: 'GET', url: '/openapi.yaml' });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.headers['content-type']).toContain('yaml');
    expect(yaml.body).toContain('openapi:');

    const docs = await ctx.app.inject({ method: 'GET', url: '/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
  });
});

/**
 * Real-dist production smoke (Wave-6, UI 真实验证的轻量替代): serve the
 * ACTUAL built web console (apps/web/dist — the same artifact the Docker
 * image ships) and check the pages a browser would load: the SPA entry,
 * a deep link (client-side views fall back to index.html), the hashed
 * bundle the entry references, and the API docs page. Skipped when the
 * frontend has not been built (`npm run build` first).
 */
const REAL_WEB_DIST = resolve(__dirname, '..', '..', 'web', 'dist');
const realDistReady = existsSync(join(REAL_WEB_DIST, 'index.html'));

describe('production web dist smoke (real apps/web/dist)', () => {
  let ctx: TestAppContext;
  let indexHtml: string;

  beforeEach(async () => {
    if (!realDistReady) return;
    indexHtml = readFileSync(join(REAL_WEB_DIST, 'index.html'), 'utf-8');
    ctx = await makeTestApp({ webDist: REAL_WEB_DIST });
  });

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it.skipIf(!realDistReady)('serves the real SPA entry at /', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toBe(indexHtml);
    expect(res.body).toContain('<div id="root">');
  });

  it.skipIf(!realDistReady)('serves the SPA entry on deep links (client-side views)', async () => {
    for (const path of ['/env/some-env-id', '/simulations/sim-1', '/?env=some-env-id']) {
      const res = await ctx.app.inject({ method: 'GET', url: path });
      expect(res.statusCode, path).toBe(200);
      expect(res.body, path).toBe(indexHtml);
    }
  });

  it.skipIf(!realDistReady)('serves the hashed bundle the entry references', async () => {
    const assetPath = indexHtml.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    expect(assetPath, 'index.html references a module bundle').toBeTruthy();
    const res = await ctx.app.inject({ method: 'GET', url: assetPath! });
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(1000); // the real bundle, not a fallback
  });

  it.skipIf(!realDistReady)('serves /api/docs and /api/openapi.yaml alongside the SPA', async () => {
    const docs = await ctx.app.inject({ method: 'GET', url: '/api/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
    expect(docs.body).toContain('/api/openapi.yaml');

    const spec = await ctx.app.inject({ method: 'GET', url: '/api/openapi.yaml' });
    expect(spec.statusCode).toBe(200);
    expect(spec.body).toContain('openapi:');

    // API misses keep the JSON contract even with the real dist mounted.
    const missing = await ctx.app.inject({ method: 'GET', url: '/api/definitely-missing' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('ROUTE_NOT_FOUND');
  });
});
