/**
 * @vitest-environment node
 *
 * Scenario-template API tests (fastify inject, no network, no LLM backend).
 *
 * The templates are the repo's real config/scenarios/*.json (read-only);
 * `starter-home` is the stable fixture. Both endpoints require auth.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from './server.js';
import { auth, registerUser, type TestUser } from './test-utils.js';

const TEMPLATE_ID = 'starter-home';
const TEMPLATE_FILE = join(__dirname, '../../../config/scenarios/starter-home.json');

describe('scenario-templates API', () => {
  let app: FastifyInstance;
  let userDir: string;
  let user: TestUser;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'scenario-templates-test-'));
    app = await buildServer({ userDir, logger: false, databasePath: ':memory:' });
    user = await registerUser(app);
  });

  afterEach(async () => {
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
  });

  it('requires authentication on both endpoints', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/scenario-templates' });
    expect(list.statusCode).toBe(401);
    const show = await app.inject({
      method: 'GET',
      url: `/api/scenario-templates/${TEMPLATE_ID}`,
    });
    expect(show.statusCode).toBe(401);
  });

  it('lists the bundled templates with counts and mapType', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/scenario-templates',
      headers: auth(user.token),
    });
    expect(res.statusCode).toBe(200);
    const { templates } = res.json();
    expect(Array.isArray(templates)).toBe(true);

    const starter = templates.find((t: { id: string }) => t.id === TEMPLATE_ID);
    expect(starter).toBeDefined();
    expect(typeof starter.name).toBe('string');
    expect(starter.name.length).toBeGreaterThan(0);
    expect(typeof starter.description).toBe('string');
    expect(starter.counts).toMatchObject({ zones: 3, devices: 3, agents: 1, events: 4 });
    expect(starter.mapType).toBe('grid');

    // The geo-tier template is tagged accordingly.
    const geo = templates.find((t: { id: string }) => t.id === 'suzhou-city');
    expect(geo?.mapType).toBe('geo');
  });

  it('localizes name/description by request language (query > Accept-Language > zh-CN)', async () => {
    // starter-home's meta carries both sides; assert on its known strings.
    const ZH_NAME = '十分钟最小世界（新手 onboarding）';
    const EN_NAME = 'Ten-minute minimal world (newcomer onboarding)';

    const nameOf = (body: { templates: { id: string; name: string }[] }) =>
      body.templates.find(t => t.id === TEMPLATE_ID)?.name;

    // Default (no query, no header): zh-CN — the platform default.
    const plain = await app.inject({
      method: 'GET',
      url: '/api/scenario-templates',
      headers: auth(user.token),
    });
    expect(nameOf(plain.json())).toBe(ZH_NAME);

    // Accept-Language: en-US → English side.
    const enHeader = await app.inject({
      method: 'GET',
      url: '/api/scenario-templates',
      headers: { ...auth(user.token), 'accept-language': 'en-US,en;q=0.9' },
    });
    expect(nameOf(enHeader.json())).toBe(EN_NAME);

    // Accept-Language: zh* → Chinese side.
    const zhHeader = await app.inject({
      method: 'GET',
      url: '/api/scenario-templates',
      headers: { ...auth(user.token), 'accept-language': 'zh-TW,zh;q=0.8' },
    });
    expect(nameOf(zhHeader.json())).toBe(ZH_NAME);

    // ?lang= wins over the header.
    const query = await app.inject({
      method: 'GET',
      url: '/api/scenario-templates?lang=en-US',
      headers: { ...auth(user.token), 'accept-language': 'zh-CN' },
    });
    expect(nameOf(query.json())).toBe(EN_NAME);
  });

  it('returns the full scenario JSON for a template', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/scenario-templates/${TEMPLATE_ID}`,
      headers: auth(user.token),
    });
    expect(res.statusCode).toBe(200);
    const scenario = res.json();
    expect(scenario.meta.id).toBe(TEMPLATE_ID);
    expect(scenario.zones).toHaveLength(3);
    // Exactly the file content — ready to POST to /api/environments.
    expect(scenario).toEqual(JSON.parse(readFileSync(TEMPLATE_FILE, 'utf-8')));
  });

  it('404s for an unknown template id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/scenario-templates/no-such-template',
      headers: auth(user.token),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('400s on path-traversal-ish ids', async () => {
    // NB: a literal ".." segment is resolved by URL normalization before
    // routing (404 at the router); encoded separators reach the handler and
    // must be rejected by the id pattern.
    for (const raw of ['..%2F..%2Fpackage', 'a%2Fb', 'a..b', 'a b']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/scenario-templates/${raw}`,
        headers: auth(user.token),
      });
      expect(res.statusCode, raw).toBe(400);
      expect(res.json().error.code).toBe('INVALID_TEMPLATE_ID');
    }
  });
});
