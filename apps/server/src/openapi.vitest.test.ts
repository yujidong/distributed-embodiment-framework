/**
 * @vitest-environment node
 *
 * OpenAPI contract tests — apps/server/openapi.yaml is hand-curated, so the
 * risk is drift, not syntax. These tests pin it to reality:
 *
 * 1. the YAML parses as an OpenAPI 3.1 document and carries the core wire
 *    shapes (the {error:{...}} envelope, both auth schemes);
 * 2. every route the server ACTUALLY registers appears in the spec, and the
 *    spec documents nothing the server does not serve (both directions —
 *    extracted from Fastify's route table via printRoutes);
 * 3. GET /api/openapi.yaml serves the raw file with a yaml content type and
 *    GET /api/docs renders the grouped endpoint page.
 */

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { makeTestApp, type TestAppContext } from './test-utils.js';

const SPEC_FILE = new URL('../openapi.yaml', import.meta.url);
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

interface SpecDoc {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, { type: string; scheme?: string; in?: string; name?: string }>;
    schemas: Record<string, unknown>;
  };
}

/**
 * Load (and memoize) the parsed spec. Memoized deliberately: repeated full
 * parses of this 5000-line document inside the vitest worker destabilize
 * native teardown on Windows (better-sqlite3 exit segfault); one parse is
 * shared by every test in the file.
 */
let cachedSpec: SpecDoc | undefined;
function loadSpec(): SpecDoc {
  cachedSpec ??= parseYaml(readFileSync(SPEC_FILE, 'utf-8')) as SpecDoc;
  return cachedSpec;
}

/** path → set of lowercase methods, as declared in the spec. */
function specRoutes(doc: SpecDoc): Map<string, Set<string>> {
  const routes = new Map<string, Set<string>>();
  for (const [path, item] of Object.entries(doc.paths)) {
    routes.set(
      path,
      new Set(Object.keys(item).filter(key => HTTP_METHODS.includes(key))),
    );
  }
  return routes;
}

/**
 * path → set of lowercase methods, as registered in Fastify. Parses the
 * segment tree from printRoutes (with commonPrefix:false, each line is one
 * path SEGMENT whose depth encodes its parent prefix; leaves carry
 * ` (METHOD[, HEAD])`). The implicit HEAD of GET routes is dropped.
 */
function serverRoutes(app: { printRoutes: (o?: object) => string }): Map<string, Set<string>> {
  const routes = new Map<string, Set<string>>();
  const tree = app.printRoutes({ commonPrefix: false, includeMeta: false });
  const segments: string[] = [];
  for (const line of tree.split('\n')) {
    const lineMatch = line.match(/^((?:│   |    )*)(?:├── |└── )(.+)$/);
    if (!lineMatch) continue;
    const depth = lineMatch[1].length / 4;
    let label = lineMatch[2];
    let methods: string[] = [];
    const leaf = label.match(/^(.*?) \(([A-Z, ]+)\)$/);
    if (leaf) {
      label = leaf[1];
      methods = leaf[2].split(', ');
    }
    if (label === '(empty root node)') label = '';
    segments[depth] = label;
    segments.length = depth + 1;
    if (methods.length === 0) continue;
    // /api/environments/:id/devices → /api/environments/{id}/devices
    // (only ':' at a segment start is a param — 'devices:instantiate' stays).
    const openApiPath = segments.join('').replaceAll(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, '/{$1}');
    const existing = routes.get(openApiPath) ?? new Set<string>();
    for (const method of methods) {
      const lower = method.toLowerCase();
      if (lower !== 'head') existing.add(lower);
    }
    routes.set(openApiPath, existing);
  }
  return routes;
}

describe('openapi.yaml', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('parses as OpenAPI 3.1 with the error envelope and both auth schemes', () => {
    const doc = loadSpec();
    expect(doc.openapi).toMatch(/^3\.1\./);

    // The uniform error shape is documented.
    const error = doc.components.schemas.Error as {
      properties: { error: { properties: Record<string, unknown>; required: string[] } };
    };
    expect(error.properties.error.required).toEqual(['code', 'message']);
    expect(Object.keys(error.properties.error.properties)).toEqual(
      expect.arrayContaining(['code', 'message', 'issues']),
    );

    // Bearer JWT + the eaf_token cookie are the two ways in.
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(doc.components.securitySchemes.cookieAuth).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'eaf_token',
    });
  });

  it('pins the governance + invocation contract shapes (T-205/T-209 sync)', () => {
    const doc = loadSpec();
    const schemas = doc.components.schemas as Record<string, {
      required?: string[];
      properties?: Record<string, { enum?: string[]; required?: string[]; description?: string }>;
    }>;

    // The proposal kind enums carry every kind the rule engine accepts —
    // T-209 added remove-agents to the prose but the SCHEMAS lagged, so
    // typed consumers could not express the kind without casts. C3 (R42-B)
    // adds ownership-transfer.
    const kinds = [
      'install-devices', 'install-agents', 'install-zones', 'remove-devices', 'remove-agents',
      'inject-scenario', 'modify-object', 'zone-claim', 'adopt-config', 'ownership-transfer',
    ];
    expect(schemas.SubmitProposalBody!.properties!.kind!.enum).toEqual(kinds);
    expect(schemas.Proposal!.properties!.kind!.enum).toEqual(kinds);

    // The modify-object payload documents the full agent patch whitelist —
    // `enabled` (T-209) and `decisionPolicy` (T-051) must not drift out of
    // the field list again.
    const payloadDoc = schemas.SubmitProposalBody!.properties!.payload!.description ?? '';
    expect(payloadDoc).toContain('Agent: name/capabilities/boundDeviceIds/managedZoneIds/llm/enabled（T-209，布尔——停用的 Agent 不再接收注入事件）/decisionPolicy（T-051，或 null 清除）');
    expect(payloadDoc).toContain('remove-agents');

    // T-051: the actuation options are contract surface, not prose — the
    // create-simulation body documents the sim-level switch (and acMode's
    // observe-only shadow semantics), and the scenario agent carries
    // decisionPolicy.
    const simOptions = (schemas.CreateSimulationBody!.properties!.options as {
      properties: Record<string, unknown>;
    }).properties;
    expect(simOptions.autoActuateIndependent).toMatchObject({ type: 'boolean' });
    expect(simOptions.acMode).toMatchObject({ enum: ['enabled', 'disabled', 'shadow'] });
    expect(schemas.AgentDecisionPolicy!.properties!.autoActuateIndependent).toMatchObject({ type: 'boolean' });
    expect(schemas.AgentDecisionPolicy!.properties!.autoInitiateAC).toMatchObject({ type: 'boolean' });
    expect(schemas.ScenarioAgent!.properties!.decisionPolicy).toBeDefined();

    // T-205: the invoke response always echoes what was applied — the shape
    // is part of the contract, not an optional extra.
    const invocation = schemas.InvocationResult!;
    expect(invocation.required).toContain('applied');
    // MI-D: applied keeps action+params; deviceId (device lanes) or flow
    // (flow-service lanes) carry the delivery target — one of the two is
    // always present at runtime.
    expect(Object.keys(invocation.properties!.applied!.properties!)).toEqual(
      expect.arrayContaining(['action', 'params', 'deviceId', 'flow']));

    // T-052: the unrestricted-legacy marker is REQUIRED on both the
    // agreement and the invocation result — a prose-only agreement must
    // never masquerade as an enforced one.
    expect(invocation.required).toContain('termsEnforced');
    expect(invocation.properties!.termsEnforced).toMatchObject({ type: 'boolean' });
    expect(schemas.ServiceAgreement!.required).toContain('termsEnforced');
    expect(schemas.ServiceAgreement!.properties!.termsEnforced).toMatchObject({ type: 'boolean' });

    // T-049: the remove-agents cascade (agreements destroyed with the agent,
    // restored on revert) is part of the documented payload contract.
    expect(payloadDoc).toContain('T-049');

    // T-205 error detail keys are declared on the Error schema, not prose-only.
    const errorProps = (schemas.Error!.properties!.error as {
      properties: Record<string, unknown>;
    }).properties;
    for (const key of ['simulations', 'agreedCommand', 'requestedAction']) {
      expect(errorProps[key], `Error.error.${key}`).toBeDefined();
    }
  });

  it('pins the NL/what-if teaching error envelopes (F0-3: R76-F5 + R83-F1)', () => {
    const doc = loadSpec();
    const schemas = doc.components.schemas as Record<string, {
      required?: string[];
      properties?: Record<string, {
        required?: string[];
        properties?: Record<string, {
          const?: string;
          not?: { pattern?: string };
          examples?: string[];
        }>;
      }>;
    }>;

    // The two teaching envelopes exist with a pinned code and the no-bare-UUID
    // red line on message (a raw id teaches nothing — R44-F2/R83-F1), each
    // carrying a zh AND an en example (locale-following is contract surface).
    const NO_BARE_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-';
    const foreign = schemas.ForeignDeviceTeachingError!;
    expect(foreign.properties!.error!.required).toEqual(['code', 'message']);
    expect(foreign.properties!.error!.properties!.code!.const).toBe('FORBIDDEN');
    expect(foreign.properties!.error!.properties!.message!.not!.pattern).toBe(NO_BARE_UUID);
    const foreignExamples = foreign.properties!.error!.properties!.message!.examples!;
    expect(foreignExamples.some(m => m.includes('发起合约'))).toBe(true);
    // R99 requester-accurate wording (was the agent-voice "belongs to").
    expect(foreignExamples.some(m => m.includes('private device'))).toBe(true);

    const unmapped = schemas.WhatIfUnmappedError!;
    expect(unmapped.properties!.error!.required).toEqual(['code', 'message']);
    expect(unmapped.properties!.error!.properties!.code!.const).toBe('BAD_REQUEST');
    expect(unmapped.properties!.error!.properties!.message!.not!.pattern).toBe(NO_BARE_UUID);
    const unmappedExamples = unmapped.properties!.error!.properties!.message!.examples!;
    expect(unmappedExamples.some(m => m.includes('已知设备'))).toBe(true);
    expect(unmappedExamples.some(m => m.includes('Known devices'))).toBe(true);

    // … and the routes actually reference them (not orphan schemas): the NL
    // command 403 and the what-if 400 admit the teaching shape alongside the
    // generic envelope.
    const command403 = (doc.paths['/api/agents/{id}/command']!.post as {
      responses: Record<string, { content: { 'application/json': { schema: { anyOf: Array<{ $ref: string }> } } } }>;
    }).responses['403'];
    expect(command403.content['application/json'].schema.anyOf.map(s => s.$ref)).toEqual([
      '#/components/schemas/ForeignDeviceTeachingError',
      '#/components/schemas/Error',
    ]);
    const whatIf400 = (doc.paths['/api/agents/{id}/what-if']!.post as {
      responses: Record<string, { content: { 'application/json': { schema: { anyOf: Array<{ $ref: string }> } } } }>;
    }).responses['400'];
    expect(whatIf400.content['application/json'].schema.anyOf.map(s => s.$ref)).toEqual([
      '#/components/schemas/WhatIfUnmappedError',
      '#/components/schemas/Error',
    ]);
  });

  it('documents the /activity kind/actor filters the 400 message advertises (T45, u3 F6)', () => {
    const doc = loadSpec();
    const get = doc.paths['/api/environments/{id}/activity']!.get as {
      parameters?: Array<{ name: string; in: string; schema?: { type?: string; enum?: string[] } }>;
    };
    const params = get.parameters ?? [];
    const byName = (name: string) => params.find(p => p.name === name && p.in === 'query');

    // ?kind: enum identical to the route's 400 teaching message word list
    // ("command" | "proposal" | "agreement" | "event" | "flow") — the
    // contract and the error text must never drift apart again. T74 (R8
    // u3-F3): `flow` = flow lifecycle audit rows.
    const kind = byName('kind');
    expect(kind).toBeDefined();
    expect(kind!.schema).toMatchObject({
      type: 'string',
      enum: ['command', 'proposal', 'agreement', 'event', 'flow'],
    });

    // ?actor: case-insensitive substring over actor id / display name.
    const actor = byName('actor');
    expect(actor).toBeDefined();
    expect(actor!.schema).toMatchObject({ type: 'string' });
  });

  it('covers exactly the routes the server registers', async () => {
    await ctx.app.ready();
    const fromServer = serverRoutes(ctx.app);
    const fromSpec = specRoutes(loadSpec());

    // Every registered route is documented (method by method).
    const undocumented: string[] = [];
    for (const [path, methods] of fromServer) {
      for (const method of methods) {
        if (!fromSpec.get(path)?.has(method)) {
          undocumented.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(undocumented, 'routes registered but missing from openapi.yaml').toEqual([]);

    // … and the spec documents nothing the server does not serve.
    const phantom: string[] = [];
    for (const [path, methods] of fromSpec) {
      for (const method of methods) {
        if (!fromServer.get(path)?.has(method)) {
          phantom.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(phantom, 'routes documented but not registered by the server').toEqual([]);

    // Sanity: the extraction really saw the whole stable surface, per group.
    for (const prefix of [
      '/api/auth/',
      '/api/environments',
      '/api/devices/',
      '/api/agents/',
      '/api/catalog',
      '/api/simulations',
      '/api/scenarios',
    ]) {
      expect(
        [...fromServer.keys()].some(path => path.startsWith(prefix)),
        `no extracted route under ${prefix}`,
      ).toBe(true);
    }
  });

  it('serves the raw spec at /api/openapi.yaml and a docs page at /api/docs', async () => {
    const yaml = await ctx.app.inject({ method: 'GET', url: '/api/openapi.yaml' });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.headers['content-type']).toContain('yaml');
    expect(parseYaml(yaml.body)).toEqual(loadSpec());

    const docs = await ctx.app.inject({ method: 'GET', url: '/api/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
    expect(docs.body).toContain('/api/openapi.yaml');
    expect(docs.body).toContain('/api/environments/{id}/stream');
  });
});
