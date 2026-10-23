/**
 * @vitest-environment node
 *
 * Template parameterization tests (UX wave-3): meta.vars declarations,
 * $var.*$ placeholder substitution, $repeat expansion, and the
 * POST /api/scenario-templates/:id/instantiate endpoint. The parameterized
 * fixtures are the repo's real config/scenarios/*-flex / vertical templates.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from './server.js';
import { auth, registerUser, type TestUser } from './test-utils.js';
import {
  TemplateVarValuesError,
  TemplateVarsError,
  instantiateTemplate,
  parseTemplateVars,
} from './scenario-template-vars.js';

const FLEX_ID = 'teaching-building-flex';

// ---------------------------------------------------------------------------
// Pure-function unit tests
// ---------------------------------------------------------------------------

describe('scenario-template-vars (pure)', () => {
  it('parses a valid vars declaration and rejects malformed ones', () => {
    const decl = parseTemplateVars({
      meta: { vars: [{ name: 'floors', label: { zh: '楼层数' }, type: 'int', min: 1, max: 10, default: 3 }] },
    });
    expect(decl).toHaveLength(1);
    expect(decl![0]).toMatchObject({ name: 'floors', min: 1, max: 10, default: 3 });

    expect(parseTemplateVars({ meta: {} })).toBeUndefined();
    expect(() => parseTemplateVars({ meta: { vars: [{ name: 'x', type: 'string', min: 0, max: 1, default: 0 }] } }))
      .toThrow(TemplateVarsError);
    expect(() => parseTemplateVars({ meta: { vars: [{ name: 'x', type: 'int', min: 5, max: 1, default: 3 }] } }))
      .toThrow(TemplateVarsError);
    expect(() => parseTemplateVars({ meta: { vars: [{ name: 'x', type: 'int', min: 1, max: 5, default: 9 }] } }))
      .toThrow(TemplateVarsError);
  });

  it('substitutes full-string placeholders as numbers, embedded as text', () => {
    const out = instantiateTemplate(
      {
        meta: { id: 't', name: 't', vars: [{ name: 'n', type: 'int', min: 1, max: 10, default: 4 }] },
        zones: [{ id: 'z', name: '第 $var.n$ 区', bounds: { minX: 0, maxX: '$var.n*8$' }, floor: '$var.n-1$' }],
      },
      {},
    ) as { zones: Array<{ name: string; bounds: { maxX: number }; floor: number }>; meta: Record<string, unknown> };
    expect(out.zones[0].name).toBe('第 4 区');
    expect(out.zones[0].bounds.maxX).toBe(32);
    expect(out.zones[0].floor).toBe(3);
    expect(out.meta.vars).toBeUndefined();
  });

  it('expands nested $repeat blocks and prunes loop-edge adjacency', () => {
    const out = instantiateTemplate(
      {
        meta: { id: 't', name: 't', vars: [{ name: 'floors', type: 'int', min: 1, max: 5, default: 2 }] },
        zones: [
          {
            $repeat: {
              var: 'floors',
              as: 'f',
              body: [
                { id: 'a-f$var.f$', adjacentZoneIds: ['a-f$var.f+1$'] },
              ],
            },
          },
        ],
      },
      { floors: 3 },
    ) as { zones: Array<{ id: string; adjacentZoneIds: string[] }> };
    expect(out.zones.map(z => z.id)).toEqual(['a-f0', 'a-f1', 'a-f2']);
    expect(out.zones[2].adjacentZoneIds).toEqual([]); // a-f3 dangles → pruned
    expect(out.zones[1].adjacentZoneIds).toEqual(['a-f2']);
  });

  it('is loud on unknown placeholder names and bad caller values', () => {
    expect(() =>
      instantiateTemplate(
        { meta: { id: 't', name: 't', vars: [] }, zones: [{ id: '$var.nope$' }] },
        {},
      ),
    ).toThrow(TemplateVarsError);

    const template = {
      meta: { id: 't', name: 't', vars: [{ name: 'n', type: 'int', min: 1, max: 5, default: 2 }] },
      zones: [],
    };
    expect(() => instantiateTemplate(template, { nope: 1 })).toThrow(TemplateVarValuesError);
    expect(() => instantiateTemplate(template, { n: 99 })).toThrow(TemplateVarValuesError);
    expect(() => instantiateTemplate(template, { n: 2.5 })).toThrow(TemplateVarValuesError);
    try {
      instantiateTemplate(template, { nope: 1, n: 99 });
      expect.unreachable();
    } catch (error) {
      expect((error as TemplateVarValuesError).issues).toHaveLength(2);
    }
  });

  it('defaults fill omitted values', () => {
    const out = instantiateTemplate(
      {
        meta: { id: 't', name: 't', vars: [{ name: 'n', type: 'int', min: 1, max: 5, default: 3 }] },
        zones: [{ id: 'z-$var.n$' }],
      },
      {},
    ) as { zones: Array<{ id: string }> };
    expect(out.zones[0].id).toBe('z-3');
  });
});

// ---------------------------------------------------------------------------
// Route tests against the real bundled templates
// ---------------------------------------------------------------------------

describe('scenario-template parameterization API', () => {
  let app: FastifyInstance;
  let userDir: string;
  let user: TestUser;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'template-vars-test-'));
    app = await buildServer({ userDir, logger: false, databasePath: ':memory:' });
    user = await registerUser(app);
  });

  afterEach(async () => {
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
  });

  it('lists vars on parameterized templates (localized label), omitted elsewhere', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scenario-templates', headers: auth(user.token) });
    expect(res.statusCode).toBe(200);
    const { templates } = res.json();

    const flex = templates.find((t: { id: string }) => t.id === FLEX_ID);
    expect(flex).toBeDefined();
    expect(flex.vars.map((v: { name: string }) => v.name)).toEqual(['floors', 'classroomsPerFloor', 'classSize']);
    const floors = flex.vars[0];
    expect(floors).toMatchObject({ label: '楼层数', type: 'int', min: 1, max: 10, default: 3 });
    // Counts come from the DEFAULT expansion (3 floors × 2 classrooms).
    expect(flex.counts.zones).toBe(12);
    expect(flex.counts.devices).toBe(12);

    for (const id of ['hospital-ward', 'factory-floor', 'shopping-mall']) {
      const t = templates.find((x: { id: string }) => x.id === id);
      expect(t, id).toBeDefined();
      expect(Array.isArray(t.vars), id).toBe(true);
      expect(t.counts.zones, id).toBeGreaterThan(0);
    }

    const starter = templates.find((t: { id: string }) => t.id === 'starter-home');
    expect(starter.vars).toBeUndefined();
  });

  it('GET /:id on a parameterized template returns the DEFAULT expansion (importable)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/scenario-templates/${FLEX_ID}`,
      headers: auth(user.token),
    });
    expect(res.statusCode).toBe(200);
    const scenario = res.json();
    expect(scenario.meta.id).toBe(FLEX_ID);
    expect(scenario.meta.vars).toBeUndefined();
    expect(JSON.stringify(scenario)).not.toContain('$var.');
    expect(scenario.zones).toHaveLength(12); // 3 floors × (2 classrooms + corridor + stairwell)
    // Non-parameterized templates are still returned verbatim.
    const raw = JSON.parse(readFileSync(join(__dirname, '../../../config/scenarios/starter-home.json'), 'utf-8'));
    const plain = await app.inject({
      method: 'GET',
      url: '/api/scenario-templates/starter-home',
      headers: auth(user.token),
    });
    expect(plain.json()).toEqual(raw);
  });

  it('instantiates with caller values and expands deterministically', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/scenario-templates/${FLEX_ID}/instantiate`,
      headers: auth(user.token),
      payload: { values: { floors: 2, classroomsPerFloor: 3, classSize: 25 } },
    });
    expect(res.statusCode).toBe(200);
    const scenario = res.json();
    expect(scenario.zones).toHaveLength(10); // 2 × (3 + corridor + stairwell)
    const ids = scenario.zones.map((z: { id: string }) => z.id);
    expect(ids).toContain('classroom-f1-r2');
    expect(ids).toContain('stairwell-f1');
    const classroom = scenario.zones.find((z: { id: string }) => z.id === 'classroom-f1-r2');
    expect(classroom.name).toBe('203 教室');
    expect(classroom.bounds).toEqual({ minX: 16, maxX: 24, minY: 0, maxY: 6 });
    expect(classroom.occupantSchedule.count).toBe(25);
    // Top-floor stairwell's f+1 adjacency dangled and was pruned.
    const top = scenario.zones.find((z: { id: string }) => z.id === 'stairwell-f1');
    expect(top.adjacentZoneIds).toEqual(['corridor-f1', 'stairwell-f0']);
    // The after-class flow covers every HVAC (2 floors × 3 classrooms).
    const shutdown = scenario.flows.find((f: { id: string }) => f.id === 'after-class-hvac-off');
    expect(shutdown.plan.nodes).toHaveLength(6);
    expect(JSON.stringify(scenario)).not.toContain('$var.');
  });

  it('instantiate with no body expands the defaults', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/scenario-templates/${FLEX_ID}/instantiate`,
      headers: auth(user.token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().zones).toHaveLength(12);
  });

  it('400 TEMPLATE_VARS_INVALID names the problem and the declared ranges', async () => {
    for (const [values, fragment] of [
      [{ floors: 99 }, '[1, 10]'],
      [{ floors: 2.5 }, 'integer'],
      [{ nope: 1 }, 'unknown var'],
    ] as Array<[Record<string, unknown>, string]>) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/scenario-templates/${FLEX_ID}/instantiate`,
        headers: auth(user.token),
        payload: { values },
      });
      expect(res.statusCode, JSON.stringify(values)).toBe(400);
      expect(res.json().error.code).toBe('TEMPLATE_VARS_INVALID');
      expect(JSON.stringify(res.json().error)).toContain(fragment);
    }
  });

  it('400s on instantiate for a non-parameterized template and 404s unknown ids', async () => {
    const plain = await app.inject({
      method: 'POST',
      url: '/api/scenario-templates/starter-home/instantiate',
      headers: auth(user.token),
      payload: { values: {} },
    });
    expect(plain.statusCode).toBe(400);
    expect(plain.json().error.code).toBe('BAD_REQUEST');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/scenario-templates/no-such-template/instantiate',
      headers: auth(user.token),
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('TEMPLATE_NOT_FOUND');

    const traversal = await app.inject({
      method: 'POST',
      url: '/api/scenario-templates/a%2Fb/instantiate',
      headers: auth(user.token),
      payload: {},
    });
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json().error.code).toBe('INVALID_TEMPLATE_ID');
  });

  it('the instantiated draft actually imports into an environment', async () => {
    const instantiate = await app.inject({
      method: 'POST',
      url: `/api/scenario-templates/${FLEX_ID}/instantiate`,
      headers: auth(user.token),
      payload: { values: { floors: 2, classroomsPerFloor: 2 } },
    });
    expect(instantiate.statusCode).toBe(200);
    const created = await app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(user.token),
      payload: instantiate.json(),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().zones).toHaveLength(8); // 2 × (2 + corridor + stairwell)
  });

  it('requires authentication on instantiate', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/scenario-templates/${FLEX_ID}/instantiate`,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});
