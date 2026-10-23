/**
 * @vitest-environment node
 *
 * Import-lane API tests (UX wave-3): floorplan vision / IFC / OSM draft
 * endpoints. Fastify inject; the vision LLM and the Overpass API are NEVER
 * touched — the vision client and the Overpass fetch are injected stubs
 * (BuildServerOptions.floorplanVisionClient / overpassFetch).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { FloorplanVisionError, NLImportError, type NLImportChatClient, type VisionChatClient } from '@active-collaboration/core/scenario';

import { buildServer, type BuildServerOptions } from './server.js';
import { auth, registerUser, type TestUser } from './test-utils.js';

/** 1×1 PNG (the lane never decodes pixels — the LLM is a stub). */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const RECOGNITION = {
  rooms: [
    { ref: 'r1', name: '101 教室', type: 'classroom', x: 0, y: 0, width: 512, height: 384 },
    { ref: 'r2', name: '走廊', type: 'corridor', x: 0, y: 384, width: 1024, height: 256 },
  ],
  connections: [{ a: 'r1', b: 'r2', kind: 'door' }],
  scale: { pixelsPerMeter: 64, note: 'scale bar "0 5 10m"' },
};

function visionClientStub(content: string = JSON.stringify(RECOGNITION)): VisionChatClient {
  return {
    chat: () => Promise.resolve({ content, model: 'stub-vision' }),
  };
}

/** Minimal IFC2X3 STEP document (one building, one storey, two spaces, one door). */
const MINIMAL_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('mini.ifc','2026-07-30T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0uYwg$uR55LAAAAAAABBB1',$,'MiniProject',$,$,$,$,(#10),#11);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#12,$);
#12=IFCAXIS2PLACEMENT3D(#13,$,$,$);
#13=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCUNITASSIGNMENT((#14));
#14=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCBUILDING('0uYwg$uR55LAAAAAAABBB2',$,'MainBuilding',$,$,$,$,$,.ELEMENT.,$,$,$);
#30=IFCBUILDINGSTOREY('0uYwg$uR55LAAAAAAABBB3',$,'1F',$,$,$,$,$,.ELEMENT.,0.);
#40=IFCRELAGGREGATES('0uYwg$uR55LAAAAAAABBB5',$,$,$,#1,(#20));
#41=IFCRELAGGREGATES('0uYwg$uR55LAAAAAAABBB6',$,$,$,#20,(#30));
#100=IFCSPACE('0uYwg$uR55LAAAAAAABB10',$,'101',$,$,$,#110,$,.ELEMENT.,.INTERNAL.,$);
#110=IFCPRODUCTDEFINITIONSHAPE($,$,(#111));
#111=IFCSHAPEREPRESENTATION(#10,'Body','BoundingBox',(#112));
#112=IFCBOUNDINGBOX(#113,8.,6.,3.);
#113=IFCCARTESIANPOINT((0.,0.,0.));
#101=IFCSPACE('0uYwg$uR55LAAAAAAABB11',$,'102',$,$,$,#120,$,.ELEMENT.,.INTERNAL.,$);
#120=IFCPRODUCTDEFINITIONSHAPE($,$,(#121));
#121=IFCSHAPEREPRESENTATION(#10,'Body','BoundingBox',(#122));
#122=IFCBOUNDINGBOX(#123,8.,6.,3.);
#123=IFCCARTESIANPOINT((8.,0.,0.));
#50=IFCRELCONTAINEDINSPATIALSTRUCTURE('0uYwg$uR55LAAAAAAABB14',$,$,$,(#100,#101),#30);
#200=IFCDOOR('0uYwg$uR55LAAAAAAABB16',$,'D1',$,$,$,$,$,$,$);
#60=IFCRELSPACEBOUNDARY('0uYwg$uR55LAAAAAAABB17',$,$,$,#100,#200,$,.PHYSICAL.,.INTERNAL.);
#61=IFCRELSPACEBOUNDARY('0uYwg$uR55LAAAAAAABB18',$,$,$,#101,#200,$,.PHYSICAL.,.INTERNAL.);
ENDSEC;
END-ISO-10303-21;
`;

/** NL lane stub recognition: "3 层医院，每层 8 病房 + 护士站 + 烟感". */
const NL_RECOGNITION = {
  name: '医院',
  buildingName: '住院楼',
  floors: [
    {
      floor: 0,
      repeat: 3,
      rooms: [
        {
          ref: 'ward',
          name: '病房',
          type: 'ward',
          count: 8,
          devices: [{ type: 'smoke-sensor' }, { type: 'not-a-real-device' }],
        },
        { ref: 'nurse-station', name: '护士站', type: 'nurse-station' },
        { ref: 'corridor', name: '走廊', type: 'corridor' },
      ],
    },
  ],
  agents: [{ name: '护士', capabilities: ['patient-care'] }],
};

function nlClientStub(content: string = JSON.stringify(NL_RECOGNITION)): NLImportChatClient {
  return {
    chat: () => Promise.resolve({ content, model: 'stub-nl' }),
  };
}

const OSM_ELEMENTS = {
  elements: [
    {
      type: 'way',
      id: 1154643375,
      tags: { name: 'D栋', building: 'university', 'building:levels': '4' },
      geometry: [
        { lat: 31.45, lon: 121.1 },
        { lat: 31.45, lon: 121.101 },
        { lat: 31.451, lon: 121.101 },
        { lat: 31.451, lon: 121.1 },
        { lat: 31.45, lon: 121.1 },
      ],
    },
    {
      type: 'way',
      id: 222,
      tags: { building: 'yes' },
      geometry: [
        { lat: 31.452, lon: 121.102 },
        { lat: 31.452, lon: 121.1025 },
        { lat: 31.4525, lon: 121.1025 },
        { lat: 31.452, lon: 121.102 },
      ],
    },
  ],
};

function overpassFetchStub(body: unknown = OSM_ELEMENTS): typeof fetch {
  return (() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    })) as unknown as typeof fetch;
}

describe('environment import lanes', () => {
  let app: FastifyInstance;
  let userDir: string;
  let user: TestUser;

  async function setup(overrides: BuildServerOptions = {}) {
    userDir = mkdtempSync(join(tmpdir(), 'env-imports-test-'));
    app = await buildServer({ userDir, logger: false, databasePath: ':memory:', ...overrides });
    user = await registerUser(app);
  }

  afterEach(async () => {
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
  });

  describe('POST /api/environments/import-floorplan', () => {
    const floorplanBody = {
      image: { base64: PNG_BASE64, mimeType: 'image/png' },
      buildingId: 'main',
      floor: 0,
      pixelsPerMeter: 64,
    };

    it('requires authentication', async () => {
      await setup({ floorplanVisionClient: visionClientStub() });
      const res = await app.inject({ method: 'POST', url: '/api/environments/import-floorplan', payload: floorplanBody });
      expect(res.statusCode).toBe(401);
    });

    it('compiles a recognition into a scenario draft (never persisted)', async () => {
      await setup({ floorplanVisionClient: visionClientStub() });
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-floorplan',
        headers: auth(user.token),
        payload: floorplanBody,
      });
      expect(res.statusCode).toBe(200);
      const { draft, warnings, scaleSuggestion } = res.json();
      expect(draft.version).toBe('1.0');
      expect(draft.meta.id).toBe('main-f0');
      expect(Array.isArray(draft.zones)).toBe(true);
      expect(draft.zones.length).toBeGreaterThanOrEqual(2);
      const ids = draft.zones.map((z: { id: string }) => z.id);
      expect(ids).toContain('101-f0'); // "101 教室" → slug "101" + floor suffix
      expect(ids).toContain('r2-f0');  // "走廊" has no latin slug → ref fallback
      // The plan-image underlay rides the compiled map block (B-D).
      expect(draft.map.floorPlans).toHaveLength(1);
      expect(draft.map.floorPlans[0].image.startsWith('data:image/png;base64,')).toBe(true);
      expect(Array.isArray(warnings)).toBe(true);
      expect(scaleSuggestion).toMatchObject({ pixelsPerMeter: 64, note: 'scale bar "0 5 10m"' });
    });

    it('400s with the LLM scale suggestion as a hint when no scale is given', async () => {
      await setup({ floorplanVisionClient: visionClientStub() });
      const { pixelsPerMeter: _omit, ...body } = floorplanBody;
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-floorplan',
        headers: auth(user.token),
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
      expect(res.json().error.message).toContain('64 px/m');
    });

    it('503s honestly when the deployment has no vision LLM configured', async () => {
      await setup({
        floorplanVisionClient: () => {
          throw new FloorplanVisionError(
            'vision provider "openai-compatible" needs a base URL — set EAF_VISION_BASE_URL',
          );
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-floorplan',
        headers: auth(user.token),
        payload: floorplanBody,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('FLOORPLAN_VISION_UNAVAILABLE');
      expect(res.json().error.message).toContain('EAF_VISION_BASE_URL');
    });

    it('502s when the recognition call fails', async () => {
      await setup({
        floorplanVisionClient: {
          chat: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8000')),
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-floorplan',
        headers: auth(user.token),
        payload: floorplanBody,
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('FLOORPLAN_RECOGNITION_FAILED');
    });

    it('400s on a bad mime type / missing fields before any LLM call', async () => {
      let called = false;
      await setup({
        floorplanVisionClient: () => {
          called = true;
          return visionClientStub();
        },
      });
      const bad = await app.inject({
        method: 'POST',
        url: '/api/environments/import-floorplan',
        headers: auth(user.token),
        payload: { ...floorplanBody, image: { base64: PNG_BASE64, mimeType: 'image/gif' } },
      });
      expect(bad.statusCode).toBe(400);
      const missing = await app.inject({
        method: 'POST',
        url: '/api/environments/import-floorplan',
        headers: auth(user.token),
        payload: { image: floorplanBody.image },
      });
      expect(missing.statusCode).toBe(400);
      expect(called).toBe(false);
    });
  });

  describe('POST /api/environments/import-ifc', () => {
    it('compiles an IFC upload into a scenario draft (no LLM involved)', async () => {
      await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-ifc',
        headers: auth(user.token),
        payload: { ifc: Buffer.from(MINIMAL_IFC, 'utf-8').toString('base64') },
      });
      expect(res.statusCode).toBe(200);
      const { draft, warnings } = res.json();
      expect(draft.version).toBe('1.0');
      expect(draft.meta.id).toBe('miniproject');
      expect(draft.zones.length).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(warnings)).toBe(true);
    });

    it('422s on non-STEP input', async () => {
      await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-ifc',
        headers: auth(user.token),
        payload: { ifc: Buffer.from('not an ifc file at all', 'utf-8').toString('base64') },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('IFC_IMPORT_FAILED');
      expect(res.json().error.message).toContain('ISO-10303-21');
    });

    it('requires authentication and a body', async () => {
      await setup();
      const unauth = await app.inject({ method: 'POST', url: '/api/environments/import-ifc', payload: {} });
      expect(unauth.statusCode).toBe(401);
      const empty = await app.inject({
        method: 'POST',
        url: '/api/environments/import-ifc',
        headers: auth(user.token),
        payload: {},
      });
      expect(empty.statusCode).toBe(400);
    });
  });

  describe('POST /api/environments/import-osm', () => {
    const bbox = [31.44, 121.09, 31.46, 121.11];

    it('builds a geo draft with per-floor polygon zones from building ways', async () => {
      await setup({ overpassFetch: overpassFetchStub() });
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-osm',
        headers: auth(user.token),
        payload: { bbox },
      });
      expect(res.statusCode).toBe(200);
      const { draft } = res.json();
      expect(draft.version).toBe('1.0');
      expect(draft.map.type).toBe('geo');
      // way 1154643375 declares building:levels=4 → 4 stacked zones;
      // way 222 has no levels tag → 1 zone.
      expect(draft.zones).toHaveLength(5);
      const f2 = draft.zones.find((z: { id: string }) => z.id === 'way-1154643375-f2');
      expect(f2).toMatchObject({ buildingId: 'way-1154643375', floor: 1, name: 'D栋 · 2F' });
      expect(Array.isArray(f2.polygon)).toBe(true);
      expect(f2.polygon.length).toBe(4); // closing duplicate dropped
      const fallback = draft.zones.find((z: { id: string }) => z.id === 'way-222-f1');
      expect(fallback.name).toBe('OSM way 222 · 1F');
    });

    it('accepts a place-name query (Overpass area path)', async () => {
      let seenBody = '';
      await setup({
        overpassFetch: ((_url: string, init: { body: string }) => {
          seenBody = init.body;
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(OSM_ELEMENTS) });
        }) as unknown as typeof fetch,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-osm',
        headers: auth(user.token),
        payload: { query: '西交利物浦大学太仓校区' },
      });
      expect(res.statusCode).toBe(200);
      expect(decodeURIComponent(seenBody)).toContain('area["name"="西交利物浦大学太仓校区"]');
    });

    it('503s honestly when every Overpass mirror fails', async () => {
      await setup({
        overpassFetch: (() => Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as unknown as typeof fetch,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-osm',
        headers: auth(user.token),
        payload: { bbox },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('OSM_IMPORT_UNAVAILABLE');
    });

    it('tries the next mirror when the first answers an HTTP error', async () => {
      const calls: string[] = [];
      await setup({
        overpassFetch: ((url: string) => {
          calls.push(url);
          if (calls.length === 1) {
            return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
          }
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(OSM_ELEMENTS) });
        }) as unknown as typeof fetch,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-osm',
        headers: auth(user.token),
        payload: { bbox },
      });
      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(2);
    });

    it('404s when the area contains no usable building outlines', async () => {
      await setup({ overpassFetch: overpassFetchStub({ elements: [] }) });
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-osm',
        headers: auth(user.token),
        payload: { bbox },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('OSM_NO_BUILDINGS_FOUND');
    });

    it('400s on bad input (both lanes, inverted bbox, oversized span)', async () => {
      await setup({ overpassFetch: overpassFetchStub() });
      const both = await app.inject({
        method: 'POST',
        url: '/api/environments/import-osm',
        headers: auth(user.token),
        payload: { bbox, query: 'x' },
      });
      expect(both.statusCode).toBe(400);
      const inverted = await app.inject({
        method: 'POST',
        url: '/api/environments/import-osm',
        headers: auth(user.token),
        payload: { bbox: [31.46, 121.09, 31.44, 121.11] },
      });
      expect(inverted.statusCode).toBe(400);
      const huge = await app.inject({
        method: 'POST',
        url: '/api/environments/import-osm',
        headers: auth(user.token),
        payload: { bbox: [30, 120, 31, 121] },
      });
      expect(huge.statusCode).toBe(400);
      expect(huge.json().error.message).toContain('0.5');
    });
  });

  describe('POST /api/environments/import-nl', () => {
    const nlBody = { text: '我要一个 3 层医院，每层 8 个病房，每层配护士站和烟感' };

    it('requires authentication', async () => {
      await setup({ nlImportClient: nlClientStub() });
      const res = await app.inject({ method: 'POST', url: '/api/environments/import-nl', payload: nlBody });
      expect(res.statusCode).toBe(401);
    });

    it('compiles a recognition into a scenario draft with devices + agents (never persisted)', async () => {
      await setup({ nlImportClient: nlClientStub() });
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-nl',
        headers: auth(user.token),
        payload: nlBody,
      });
      expect(res.statusCode).toBe(200);
      const { draft, warnings } = res.json();
      expect(draft.version).toBe('1.0');
      // 3 floors × (8 wards + nurse-station + corridor) + 3 auto stairwells.
      expect(draft.zones.filter((z: { type?: string }) => z.type === 'ward')).toHaveLength(24);
      expect(draft.zones.filter((z: { type?: string }) => z.type === 'nurse-station')).toHaveLength(3);
      expect(draft.zones.filter((z: { type?: string }) => z.type === 'stairwell')).toHaveLength(3);
      // Devices resolved from the template registry (capabilities + role);
      // the bogus type was dropped with a warning instead of going in
      // capability-less.
      expect(draft.devices).toHaveLength(24);
      expect(draft.devices[0].type).toBe('smoke-sensor');
      expect(['sensor', 'actuator', 'hybrid']).toContain(draft.devices[0].role);
      expect(draft.devices[0].capabilities.length).toBeGreaterThan(0);
      expect(warnings.some((w: string) => w.includes('not-a-real-device'))).toBe(true);
      expect(draft.agents).toHaveLength(1);
      expect(draft.agents[0]).toMatchObject({ name: '护士', capabilities: ['patient-care'] });
      // The draft imports through the standing path unchanged.
      const create = await app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(user.token),
        payload: draft,
      });
      expect(create.statusCode).toBe(201);
    });

    it('503s honestly when the deployment has no LLM configured', async () => {
      await setup({
        nlImportClient: () => {
          throw new NLImportError('no LLM backend configured — set LLM_BASE_URL + LLM_MODEL');
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-nl',
        headers: auth(user.token),
        payload: nlBody,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('NL_IMPORT_UNAVAILABLE');
      expect(res.json().error.message).toContain('LLM_NL_MODEL');
    });

    it('502s when the recognition call fails', async () => {
      await setup({
        nlImportClient: {
          chat: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8000')),
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-nl',
        headers: auth(user.token),
        payload: nlBody,
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('NL_IMPORT_FAILED');
    });

    it('422s with example phrasings when the description has no building cues', async () => {
      await setup({ nlImportClient: nlClientStub('{"name":"","floors":[]}') });
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments/import-nl',
        headers: auth(user.token),
        payload: { text: '今天天气怎么样' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('NL_IMPORT_NO_BUILDING');
      expect(res.json().error.message).toContain('病房');
    });

    it('400s on a missing/overlong text before any LLM call', async () => {
      let called = false;
      await setup({
        nlImportClient: () => {
          called = true;
          return nlClientStub();
        },
      });
      const missing = await app.inject({
        method: 'POST',
        url: '/api/environments/import-nl',
        headers: auth(user.token),
        payload: {},
      });
      expect(missing.statusCode).toBe(400);
      const tooLong = await app.inject({
        method: 'POST',
        url: '/api/environments/import-nl',
        headers: auth(user.token),
        payload: { text: '楼'.repeat(2001) },
      });
      expect(tooLong.statusCode).toBe(400);
      expect(called).toBe(false);
    });
  });
});
