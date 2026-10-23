/**
 * @vitest-environment node
 *
 * Device-catalog tests (P2b, product_design.md §11.3)
 *
 * Covers: the v2 migration shape, idempotent catalog seeding, the list /
 * filter / detail endpoints, community submissions (auth-required, land as
 * 'pending', invisible in the active list), and instantiate-into-world
 * (builder+ creates a device pre-filled from the model, world-change
 * broadcast, and the 404/400/403 rejection matrix).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CATALOG_SEED_MODELS, seedCatalogModels } from './db/catalog-seed.js';
import { CatalogStore } from './db/catalog-store.js';
import { openDatabase, type EafDatabase } from './db/database.js';
import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('device_models migration (v2)', () => {
  let db: EafDatabase;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates the device_models table with the catalog columns and indexes', () => {
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'device_models'`)
      .get();
    expect(table).toBeDefined();

    const columns = (db.pragma('table_info(device_models)') as { name: string }[]).map(c => c.name);
    expect(columns).toEqual([
      'id', 'vendor', 'model', 'name', 'device_type', 'capabilities_json',
      'physics_json', 'specs_json', 'purchase_url', 'price_cny', 'source',
      'status', 'created_by', 'created_at', 'tier',
    ]);

    const indexes = (db.pragma('index_list(device_models)') as { name: string }[]).map(i => i.name);
    expect(indexes).toContain('idx_device_models_type');
    expect(indexes).toContain('idx_device_models_vendor');
  });

  it('records the migration so it never re-runs', () => {
    const row = db.prepare('SELECT name FROM migrations WHERE version = 2').get() as
      | { name: string }
      | undefined;
    expect(row?.name).toBe('device-models-catalog');
  });
});

describe('device_models migration (v3): deployment tier', () => {
  let db: EafDatabase;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('adds a tier column defaulting to consumer, plus its index', () => {
    const tier = (db.pragma('table_info(device_models)') as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[]).find(c => c.name === 'tier');
    expect(tier).toBeDefined();
    expect(tier?.notnull).toBe(1);
    expect(tier?.dflt_value).toBe("'consumer'");

    const indexes = (db.pragma('index_list(device_models)') as { name: string }[]).map(i => i.name);
    expect(indexes).toContain('idx_device_models_tier');

    const row = db.prepare('SELECT name FROM migrations WHERE version = 3').get() as
      | { name: string }
      | undefined;
    expect(row?.name).toBe('device-models-tier');
  });

  it('existing rows keep the consumer default; the CHECK rejects other tiers', () => {
    const store = new CatalogStore(db);
    seedCatalogModels(store, null);
    // Every pre-v3 seed (no explicit tier) reads back as 'consumer'.
    const consumerCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM device_models WHERE tier = 'consumer'`).get() as
      { n: number }
    ).n;
    expect(consumerCount).toBeGreaterThan(0);

    expect(() =>
      db.prepare(`UPDATE device_models SET tier = 'orbital' WHERE id = ?`).run('seed-gree-kfr-35gw-yunjia'),
    ).toThrow(/CHECK/i);
  });
});

describe('catalog seed', () => {
  let db: EafDatabase;
  let store: CatalogStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new CatalogStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('seeds the curated models as active seed rows', () => {
    const inserted = seedCatalogModels(store, null);
    expect(inserted).toBe(CATALOG_SEED_MODELS.length);
    expect(inserted).toBeGreaterThanOrEqual(20);
    expect(store.count()).toBe(CATALOG_SEED_MODELS.length);

    for (const row of store.listActive()) {
      expect(row.source).toBe('seed');
      expect(row.status).toBe('active');
      expect(JSON.parse(row.capabilities_json).length).toBeGreaterThan(0);
    }
  });

  it('is idempotent across reboots (re-seeding is a no-op)', () => {
    expect(seedCatalogModels(store, null)).toBe(CATALOG_SEED_MODELS.length);
    expect(seedCatalogModels(store, null)).toBe(0);
    expect(store.count()).toBe(CATALOG_SEED_MODELS.length);
  });

  it('is idempotent across reopening the same database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eaf-catalog-'));
    try {
      const path = join(dir, 'test.db');
      const first = openDatabase(path);
      seedCatalogModels(new CatalogStore(first), null);
      first.close();

      const second = openDatabase(path);
      const secondStore = new CatalogStore(second);
      expect(seedCatalogModels(secondStore, null)).toBe(0);
      expect(secondStore.count()).toBe(CATALOG_SEED_MODELS.length);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('seeds the municipal/industrial tier with real smart-city vendors', () => {
    seedCatalogModels(store, null);
    const rows = store.listActive();
    const municipal = rows.filter(r => r.tier === 'municipal');
    const industrial = rows.filter(r => r.tier === 'industrial');
    expect(municipal.length).toBeGreaterThanOrEqual(9);
    expect(industrial.length).toBeGreaterThanOrEqual(2);
    expect(municipal.length + industrial.length).toBe(
      CATALOG_SEED_MODELS.filter(m => m.tier !== undefined).length,
    );

    // Spot-check the headline models (vendor/model/tier/type).
    expect(store.get('seed-fpi-aqms1000')).toMatchObject({
      vendor: 'FPI', model: 'AQMS-1000', device_type: 'air-quality-sensor', tier: 'municipal',
    });
    expect(store.get('seed-hisense-hsc100')).toMatchObject({
      vendor: 'Hisense', device_type: 'smart-plug', tier: 'municipal',
    });
    expect(store.get('seed-wasion-dtsd342')).toMatchObject({
      vendor: 'Wasion', device_type: 'energy-meter', tier: 'industrial',
    });

    // The original consumer seeds keep their default tier.
    expect(store.get('seed-gree-kfr-35gw-yunjia')?.tier).toBe('consumer');

    // Every tiered seed marks stand-in type mappings in its specs note.
    const standIns = rows.filter(
      r => r.tier !== 'consumer' && JSON.parse(r.specs_json).note !== undefined,
    );
    expect(standIns.length).toBeGreaterThan(0);
    for (const row of standIns) {
      expect(JSON.parse(row.specs_json).note).toContain('catalog type');
    }
  });
});

describe('catalog API', () => {
  let ctx: TestAppContext;
  let user: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    user = await registerUser(ctx.app, { displayName: 'Catalogger' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('GET /api/catalog lists the seeded active models (summary fields)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/catalog' });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Record<string, unknown>[];
    expect(rows.length).toBe(CATALOG_SEED_MODELS.length);

    const gree = rows.find(r => r.id === 'seed-gree-kfr-35gw-yunjia');
    expect(gree).toMatchObject({
      vendor: 'Gree',
      model: 'KFR-35GW',
      deviceType: 'hvac',
      source: 'seed',
      tier: 'consumer',
    });
    expect(gree?.capabilities).toContain('temperature-control');
    // Summary shape excludes the heavy detail payloads.
    expect(gree).not.toHaveProperty('physics');
    expect(gree).not.toHaveProperty('specs');
  });

  it('flags non-executable capabilities per model (R13 CB-F09 + R101: catalog honesty)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/catalog' });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Record<string, unknown>[];

    // R101 gave `emergency-broadcast` a real handler (EmergencyStoryCommand-
    // Handler), so the shared executability oracle now reports it EXECUTABLE
    // and the catalog must stop flagging it. The still-dead `power-control`
    // (no handler, not read-only) stays flagged — the SAME live contract
    // flow validation uses.
    const pa = rows.find(r => r.id === 'seed-emergency-pa-column');
    expect(pa).toBeDefined();
    expect(pa?.nonExecutableCapabilities).toContain('power-control');
    expect(pa?.nonExecutableCapabilities).not.toContain('emergency-broadcast');
    expect(pa?.nonExecutableCapabilities).not.toContain('turn-on');

    // A fully executable model carries an honest empty list, and the field
    // is present on EVERY model (additive, optional in the contract).
    const gree = rows.find(r => r.id === 'seed-gree-kfr-35gw-yunjia');
    expect(gree?.nonExecutableCapabilities).toEqual([]);

    // Detail view carries the same flag.
    const detail = await ctx.app.inject({ method: 'GET', url: '/api/catalog/seed-emergency-pa-column' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().nonExecutableCapabilities).toContain('power-control');
    expect(detail.json().nonExecutableCapabilities).not.toContain('emergency-broadcast');
  });

  it('GET /api/catalog filters by device_type, vendor, and q', async () => {
    const byType = await ctx.app.inject({ method: 'GET', url: '/api/catalog?device_type=hvac' });
    expect(byType.statusCode).toBe(200);
    expect((byType.json() as unknown[]).length).toBe(2);
    for (const row of byType.json() as { deviceType: string }[]) {
      expect(row.deviceType).toBe('hvac');
    }

    const byVendor = await ctx.app.inject({ method: 'GET', url: '/api/catalog?vendor=Gree' });
    expect((byVendor.json() as unknown[]).length).toBe(2);

    const byQ = await ctx.app.inject({ method: 'GET', url: '/api/catalog?q=KFR-35' });
    const qRows = byQ.json() as { id: string }[];
    expect(qRows.length).toBe(1);
    expect(qRows[0]!.id).toBe('seed-gree-kfr-35gw-yunjia');

    const empty = await ctx.app.inject({
      method: 'GET',
      url: '/api/catalog?device_type=toaster',
    });
    expect(empty.json()).toEqual([]);
  });

  it('GET /api/catalog?q= expands zh keywords via aliases (R15-D5)', async () => {
    // 「温度」shares no substring with 「小米温湿度传感器2」and the model id
    // is English — before R15-D5 this found nothing.
    const byTemp = await ctx.app.inject({ method: 'GET', url: '/api/catalog?q=温度' });
    const tempRows = byTemp.json() as { name: string }[];
    expect(tempRows.length).toBeGreaterThan(0);
    expect(tempRows.some(row => row.name.includes('温湿度'))).toBe(true);

    // 「湿度」likewise reaches the combined sensor through the 温湿 alias.
    const byHumidity = await ctx.app.inject({ method: 'GET', url: '/api/catalog?q=湿度' });
    expect(((byHumidity.json()) as { name: string }[]).some(row => row.name.includes('温湿度'))).toBe(true);

    // Unmatched queries still return empty (aliases only widen, never invent).
    const none = await ctx.app.inject({ method: 'GET', url: '/api/catalog?q=全息投影' });
    expect(none.json()).toEqual([]);
  });

  it('GET /api/catalog?q= covers the R80-3 residual zero-hit keywords (R84)', async () => {
    // API 层复测驱动：每个词在补别名前都是 0 行（见 docs/usability-findings
    // R80-3）；断言锚定具体设备，防别名表漂移回零命中。
    const cases: Array<{ q: string; expectName: string }> = [
      { q: '水浸', expectName: '水位' },     // 雷达水位计（窨井/河道监测）
      { q: '漏水', expectName: '水位' },
      { q: '新风', expectName: '空气净化' },  // 米家空气净化器4Pro
      { q: '地暖', expectName: '空调' },     // 格力云佳空调（heating 能力）
      { q: '暖气', expectName: '空调' },
      { q: '除湿', expectName: '加湿' },     // 米家加湿器2
      { q: '摄像头', expectName: '摄像' },   // R80 已补，回归锚
      { q: '烟感', expectName: '烟雾' },     // R15-D5 已补，回归锚
    ];
    for (const { q, expectName } of cases) {
      const res = await ctx.app.inject({ method: 'GET', url: `/api/catalog?q=${encodeURIComponent(q)}` });
      expect(res.statusCode).toBe(200);
      const rows = res.json() as { name: string }[];
      expect(rows.length, `q=${q} 仍零命中`).toBeGreaterThan(0);
      expect(rows.some(row => row.name.includes(expectName)), `q=${q} 未见「${expectName}」`).toBe(true);
    }

    // 目录里确实没有的设备类保持诚实的空结果（别名只放宽不发明）。
    const doorContact = await ctx.app.inject({ method: 'GET', url: `/api/catalog?q=${encodeURIComponent('门磁')}` });
    expect(doorContact.json()).toEqual([]);
  });

  it('GET /api/catalog filters by tier; unknown tier values are ignored', async () => {
    const municipal = await ctx.app.inject({ method: 'GET', url: '/api/catalog?tier=municipal' });
    expect(municipal.statusCode).toBe(200);
    const municipalRows = municipal.json() as { tier: string; id: string }[];
    expect(municipalRows.length).toBe(
      CATALOG_SEED_MODELS.filter(m => m.tier === 'municipal').length,
    );
    for (const row of municipalRows) {
      expect(row.tier).toBe('municipal');
    }
    expect(municipalRows.some(r => r.id === 'seed-fpi-aqms1000')).toBe(true);

    const industrial = await ctx.app.inject({ method: 'GET', url: '/api/catalog?tier=industrial' });
    const industrialRows = industrial.json() as { tier: string }[];
    expect(industrialRows.length).toBe(
      CATALOG_SEED_MODELS.filter(m => m.tier === 'industrial').length,
    );
    for (const row of industrialRows) {
      expect(row.tier).toBe('industrial');
    }

    const consumer = await ctx.app.inject({ method: 'GET', url: '/api/catalog?tier=consumer' });
    for (const row of consumer.json() as { tier: string }[]) {
      expect(row.tier).toBe('consumer');
    }

    // Composes with the other filters.
    const combo = await ctx.app.inject({
      method: 'GET',
      url: '/api/catalog?tier=municipal&device_type=motion-sensor',
    });
    const comboRows = combo.json() as { tier: string; deviceType: string }[];
    expect(comboRows.length).toBeGreaterThan(0);
    for (const row of comboRows) {
      expect(row.tier).toBe('municipal');
      expect(row.deviceType).toBe('motion-sensor');
    }

    // Garbage tier is not a 400 — it just falls back to no tier filter.
    const bogus = await ctx.app.inject({ method: 'GET', url: '/api/catalog?tier=orbital' });
    expect(bogus.statusCode).toBe(200);
    expect((bogus.json() as unknown[]).length).toBe(CATALOG_SEED_MODELS.length);
  });

  it('GET /api/catalog/:id returns full detail; 404 on unknown id', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/catalog/seed-gree-kfr-35gw-yunjia',
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.physics).toMatchObject({ powerW: 3000, hysteresisC: 0.5 });
    expect(detail.specs).toHaveProperty('protocol');
    expect(detail.purchaseUrl).toContain('http');
    expect(detail.status).toBe('active');
    expect(detail.tier).toBe('consumer');

    const missing = await ctx.app.inject({ method: 'GET', url: '/api/catalog/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('MODEL_NOT_FOUND');
  });

  it('POST /api/catalog requires auth and lands as a pending community submission', async () => {
    const payload = {
      vendor: 'Sonoff',
      model: 'SNZB-02',
      name: 'Sonoff温湿度传感器',
      deviceType: 'temp-humidity-sensor',
      capabilities: ['temperature-monitoring', 'humidity-monitoring'],
      physics: { temperatureNoiseC: 0.5 },
      specs: { protocol: 'Zigbee 3.0' },
      priceCny: 35,
    };

    const anon = await ctx.app.inject({ method: 'POST', url: '/api/catalog', payload });
    expect(anon.statusCode).toBe(401);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/catalog',
      headers: auth(user.token),
      payload,
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.status).toBe('pending');
    expect(body.source).toBe('community');
    expect(body.createdBy).toBe(user.id);
    expect(body.physics).toEqual({ temperatureNoiseC: 0.5 });

    // Pending submissions are NOT part of the public active listing.
    const list = await ctx.app.inject({ method: 'GET', url: '/api/catalog?vendor=Sonoff' });
    expect(list.json()).toEqual([]);

    // …but the detail endpoint returns them (for the future approval flow).
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/catalog/${body.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().status).toBe('pending');
  });

  it('POST /api/catalog validates the body (capabilities non-empty, required fields)', async () => {
    const base = {
      vendor: 'Sonoff',
      model: 'SNZB-02',
      name: 'X',
      deviceType: 'temp-humidity-sensor',
    };
    const emptyCaps = await ctx.app.inject({
      method: 'POST',
      url: '/api/catalog',
      headers: auth(user.token),
      payload: { ...base, capabilities: [] },
    });
    expect(emptyCaps.statusCode).toBe(400);

    const noVendor = await ctx.app.inject({
      method: 'POST',
      url: '/api/catalog',
      headers: auth(user.token),
      payload: { model: 'M', name: 'N', deviceType: 't', capabilities: ['c'] },
    });
    expect(noVendor.statusCode).toBe(400);

    const badPrice = await ctx.app.inject({
      method: 'POST',
      url: '/api/catalog',
      headers: auth(user.token),
      payload: { ...base, capabilities: ['c'], priceCny: -5 },
    });
    expect(badPrice.statusCode).toBe(400);
  });
});

describe('instantiate from catalog', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let viewer: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    viewer = await registerUser(ctx.app, { displayName: 'Viewer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Catalog Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }] },
      },
    });
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });
    ctx.app.envStore.addMember(envId, viewer.id, 'viewer');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function instantiate(token: string, overrides: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices:instantiate`,
      headers: auth(token),
      payload: { modelId: 'seed-gree-kfr-35gw-yunjia', zoneId: 'zone-a', ...overrides },
    });
  }

  it('T-702 (DevLoop R29): catalog physics bridges into initialState', async () => {
    const res = await instantiate(owner.token);
    expect(res.statusCode).toBe(201);
    const device = res.json();
    // specs.coolingCapacityW / heatingCapacityW / ratedPowerW ride the
    // install: the simulation's HVAC handlers and energy meter consume
    // them (pre-fix every HVAC fell back to the 3 kW class default and
    // metered 3000/COP W regardless of model).
    expect(device.initialState).toMatchObject({
      coolingPowerW: 3500,
      heatingPowerW: 4600,
      ratedPowerW: 980,
    });
    // An explicit author initialState key wins over the catalog default
    // (owner-direct path; the builder path funnels through the same
    // catalogPhysicsInitialState merge inside proposal normalizeDevices).
    const overridden = await instantiate(owner.token, {
      initialState: { coolingPowerW: 2000 },
    });
    expect(overridden.statusCode).toBe(201);
    expect(overridden.json().initialState).toMatchObject({
      coolingPowerW: 2000, // author override
      heatingPowerW: 4600, // catalog default still applies
    });
  });

  it('owner instantiates a device pre-filled from the model (audited)', async () => {
    const res = await instantiate(owner.token);
    expect(res.statusCode).toBe(201);
    const device = res.json();
    expect(device.envId).toBe(envId);
    expect(device.name).toBe('格力云佳空调（1.5匹）');
    expect(device.type).toBe('hvac');
    expect(device.brand).toBe('Gree');
    expect(device.capabilities).toEqual(
      expect.arrayContaining(['temperature-control', 'cooling', 'turn-on', 'turn-off']),
    );
    expect(device.zoneId).toBe('zone-a');
    expect(device.owner).toEqual({ id: owner.id, displayName: 'Owner' });

    // Fix-1: the direct instantiate lands in command_log as env-direct-edit.
    const log = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log?kind=env-direct-edit`,
      headers: auth(owner.token),
    });
    expect(log.json().entries[0].payload).toMatchObject({
      objectType: 'device',
      action: 'created',
      objectId: device.id,
      before: null,
    });

    // The instance is a real world object — visible in the env detail.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const devices = detail.json().devices as { id: string }[];
    expect(devices.some(d => d.id === device.id)).toBe(true);
  });

  it('builder instantiation becomes an install-devices proposal (modelId rides the payload)', async () => {
    const res = await instantiate(builder.token, { name: '客厅空调' });
    expect(res.statusCode).toBe(201);
    const proposal = res.json();
    // Fix-1: no device until the pipeline approves; the proposal references
    // the same catalog model.
    expect(proposal.kind).toBe('install-devices');
    expect(proposal.status).toBe('escalated');
    expect(proposal.author.id).toBe(builder.id);
    expect(proposal.payload.devices[0]).toMatchObject({
      modelId: 'seed-gree-kfr-35gw-yunjia',
      name: '客厅空调',
      zoneId: 'zone-a',
    });
    expect(ctx.app.envStore.devicesOf(envId)).toHaveLength(0);

    // Approval installs the device (owner = the proposing builder), with the
    // model's type/brand/capabilities resolved by the rule check.
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.json().status).toBe('applied');
    const devices = ctx.app.envStore.devicesOf(envId);
    expect(devices).toHaveLength(1);
    expect(devices[0].owner_id).toBe(builder.id);
    expect(devices[0].name).toBe('客厅空调');
    expect(devices[0].type).toBe('hvac');
  });

  it('honors a custom name and position', async () => {
    const res = await instantiate(owner.token, {
      name: '客厅空调',
      zoneId: 'zone-b',
      position: { x: 1.5, y: 2.5 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('客厅空调');
    expect(res.json().zoneId).toBe('zone-b');
    expect(res.json().position).toEqual({ x: 1.5, y: 2.5 });
  });

  it('publishes a world-change broadcast (with actor) on instantiate', async () => {
    const seen: unknown[] = [];
    const unsubscribe = ctx.app.worldSync.subscribe(envId, message => seen.push(message));
    try {
      const res = await instantiate(owner.token);
      expect(res.statusCode).toBe(201);
      expect(seen.length).toBe(1);
      const message = seen[0] as {
        kind: string;
        action: string;
        objectType: string;
        object: { id: string };
        actor?: { id: string; displayName: string };
      };
      expect(message.kind).toBe('world');
      expect(message.action).toBe('created');
      expect(message.objectType).toBe('device');
      expect(message.object.id).toBe(res.json().id);
      // Fix-1: broadcasts name the acting user.
      expect(message.actor).toEqual({ id: owner.id, displayName: 'Owner' });
    } finally {
      unsubscribe();
    }
  });

  it('404 unknown model / unknown env; 400 unknown zone; 403 viewer; 401 anon', async () => {
    const badModel = await instantiate(builder.token, { modelId: 'no-such-model' });
    expect(badModel.statusCode).toBe(404);
    expect(badModel.json().error.code).toBe('MODEL_NOT_FOUND');

    const badZone = await instantiate(builder.token, { zoneId: 'zone-nope' });
    expect(badZone.statusCode).toBe(400);
    expect(badZone.json().error.code).toBe('UNKNOWN_ZONE');

    const badEnv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments/no-such-env/devices:instantiate',
      headers: auth(builder.token),
      payload: { modelId: 'seed-gree-kfr-35gw-yunjia', zoneId: 'zone-a' },
    });
    expect(badEnv.statusCode).toBe(404);

    expect((await instantiate(viewer.token)).statusCode).toBe(403);

    const anon = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices:instantiate`,
      payload: { modelId: 'seed-gree-kfr-35gw-yunjia', zoneId: 'zone-a' },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('rejects instantiating a pending community model', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/catalog',
      headers: auth(builder.token),
      payload: {
        vendor: 'Sonoff',
        model: 'SNZB-02',
        name: 'Pending Sensor',
        deviceType: 'temp-humidity-sensor',
        capabilities: ['temperature-monitoring'],
      },
    });
    expect(created.statusCode).toBe(201);

    const res = await instantiate(builder.token, { modelId: created.json().id });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MODEL_NOT_FOUND');
  });
});

describe('R78-D crowd/people counting (R77 F2)', () => {
  let db: EafDatabase;
  let store: CatalogStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new CatalogStore(db);
    seedCatalogModels(store, null);
  });

  afterEach(() => {
    db.close();
  });

  it('seeds people-counter models with people-counting capabilities', () => {
    const counters = store.listActive({ deviceType: 'people-counter' });
    expect(counters.length).toBeGreaterThanOrEqual(2);
    for (const row of counters) {
      const caps = JSON.parse(row.capabilities_json) as string[];
      expect(caps).toContain('people-counting');
      expect(caps).toContain('crowd-monitoring');
    }
  });

  it('the mind-vocabulary search 「人流/客流/人群」 finds them (alias widening)', () => {
    // R77 F2: 搜「人流」0 行 —— the alias table had no crowd family and no
    // model carried the capability; both halves are fixed together.
    for (const q of ['人流', '客流', '人群']) {
      const hits = store.listActive({ q });
      expect(hits.length).toBeGreaterThanOrEqual(2, `query ${q}`);
      expect(hits.some(r => r.id === 'seed-milesight-vs121')).toBe(true);
    }
  });
});

describe('R80 camera catalog (FW3 demand-board driven)', () => {
  let db: import('better-sqlite3').Database;
  let store: CatalogStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new CatalogStore(db);
    seedCatalogModels(store, null);
  });

  afterEach(() => {
    db.close();
  });

  it('seeds camera models covering camera-monitoring (the demand-board gap)', () => {
    const cams = store.listActive().filter(r =>
      JSON.parse(r.capabilities_json).includes('camera-monitoring'));
    expect(cams.length).toBeGreaterThanOrEqual(2);
  });

  it('「摄像头/监控/安防」mind-vocabulary searches find them', () => {
    for (const q of ['摄像头', '监控', '安防']) {
      expect(store.listActive({ q }).length).toBeGreaterThanOrEqual(2, q);
    }
  });
});
