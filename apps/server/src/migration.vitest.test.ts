/**
 * @vitest-environment node
 *
 * Migration robustness + SQLite backup/restore round-trip (R15-A2).
 *
 * Industry-grade data safety means two things the in-memory test suites
 * never exercise: (1) a database file written by an OLD release upgrades
 * through the whole migration chain without losing rows, and (2) the
 * documented backup procedure actually restores a working database.
 * Both run on real temp files (not :memory:) because WAL journaling and
 * the -wal/-shm side files are part of the behavior under test.
 */

import { mkdtempSync, rmSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS, openDatabase, type EafDatabase } from './db/database.js';
import { UserStore } from './db/user-store.js';

/** Apply migrations up to (and including) `version` on a raw connection. */
function applyUpTo(db: EafDatabase, version: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const record = db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.transaction(() => {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}

/** A v1-shaped user + environment + instances, inserted with v1 columns only. */
function seedV1Rows(db: EafDatabase): void {
  db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, created_at)
     VALUES ('u1', 'legacy@t.local', 'hash', 'Legacy User', '2026-01-01T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO environments (id, name, map_data_json, owner_id, created_at, updated_at)
     VALUES ('env1', 'Legacy World', '{"zones":[{"id":"z1"}]}', 'u1',
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO env_members (env_id, user_id, role) VALUES ('env1', 'u1', 'owner')`,
  ).run();
  db.prepare(
    `INSERT INTO device_instances (id, env_id, owner_id, name, type, zone_id, created_at)
     VALUES ('d1', 'env1', 'u1', 'Legacy AC', 'hvac', 'z1', '2026-01-01T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO agent_instances (id, env_id, owner_id, name, created_at)
     VALUES ('a1', 'env1', 'u1', 'Legacy Agent', '2026-01-01T00:00:00Z')`,
  ).run();
}

describe('migration chain (R15-A2)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'eaf-migration-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('versions are strictly increasing from 1 with no gaps', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(1);
    for (let i = 0; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i]!.version, `migration #${i} version`).toBe(i + 1);
    }
  });

  it('upgrades a v1 database through the whole chain without losing rows', () => {
    const path = join(dir, 'v1-upgrade.db');

    // A database as the FIRST release would have left it: v1 schema + data.
    const old = new Database(path);
    old.pragma('journal_mode = WAL');
    applyUpTo(old, 1);
    seedV1Rows(old);
    old.close();

    // Open with current code: every pending migration applies in order.
    const db = openDatabase(path);
    const versions = (db.prepare('SELECT version FROM migrations ORDER BY version').all() as { version: number }[])
      .map(row => row.version);
    expect(versions).toEqual(MIGRATIONS.map(m => m.version));

    // The v1 rows survived every rebuild/ALTER along the way.
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get('legacy@t.local') as Record<string, unknown>;
    expect(user).toBeDefined();
    expect(user.id).toBe('u1');
    expect(user.token_version).toBe(0); // v? column with DEFAULT — backfilled

    const env = db.prepare('SELECT * FROM environments WHERE id = ?').get('env1') as Record<string, unknown>;
    expect(env.name).toBe('Legacy World');
    expect(env.map_data_json).toContain('z1');

    expect((db.prepare('SELECT COUNT(*) AS n FROM device_instances').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_instances').get() as { n: number }).n).toBe(1);

    // Current store code reads the upgraded file happily.
    const userStore = new UserStore(db);
    const found = userStore.findByEmail('legacy@t.local');
    expect(found?.id).toBe('u1');

    // And new-code writes still work (the schema is genuinely current).
    db.prepare(
      `INSERT INTO blueprints (id, name, definition_json, is_builtin, created_at, updated_at)
       VALUES ('bp1', 'B', '{}', 0, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')`,
    ).run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM blueprints').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('upgrades from the previous release boundary (v22 → v23 blueprints)', () => {
    const path = join(dir, 'v22-upgrade.db');
    const old = new Database(path);
    old.pragma('journal_mode = WAL');
    applyUpTo(old, 22);
    seedV1Rows(old); // columns added after v1 are defaulted by earlier migrations
    old.close();

    const db = openDatabase(path);
    const last = MIGRATIONS.at(-1)!;
    const versions = (db.prepare('SELECT version FROM migrations').all() as { version: number }[]).map(r => r.version);
    expect(versions.at(-1)).toBe(last.version);
    // v23 additions are live…
    db.prepare('SELECT installed_from FROM device_instances LIMIT 1').all();
    db.prepare('SELECT installed_from FROM agent_instances LIMIT 1').all();
    // …and the pre-existing rows are intact.
    expect(db.prepare('SELECT id FROM users WHERE id = ?').get('u1')).toBeDefined();
    expect(db.prepare('SELECT id FROM environments WHERE id = ?').get('env1')).toBeDefined();
    db.close();
  });

  it('v28 re-runs the derivation: dead services pruned, suppressed telemetry restored, ids stable, legacy visibility flipped', () => {
    const path = join(dir, 'v27-resync.db');
    const old = new Database(path);
    old.pragma('journal_mode = WAL');
    applyUpTo(old, 27);

    // A world as the R11 retry found it: a T-207-era agent whose dead
    // services were never re-derived (sync only runs on touch points), a
    // wrongly-suppressed sensor telemetry row that was deleted by the
    // family table, pre-T-208 'public' derived visibility, plus a
    // published offer and a subscription that must survive.
    old.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, created_at)
       VALUES ('u1', 'resync@t.local', 'hash', 'Resync User', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO environments (id, name, map_data_json, owner_id, created_at, updated_at)
       VALUES ('env1', 'Resync World', '{"zones":[{"id":"z1"}]}', 'u1',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(`INSERT INTO env_members (env_id, user_id, role) VALUES ('env1', 'u1', 'owner')`).run();
    old.prepare(
      `INSERT INTO device_instances (id, env_id, owner_id, name, type, capabilities_json, zone_id, created_at)
       VALUES ('d-siren', 'env1', 'u1', 'Lobby Siren', 'siren',
               '["emergency-broadcast","turn-on"]', 'z1', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO device_instances (id, env_id, owner_id, name, type, capabilities_json, zone_id, created_at)
       VALUES ('d-lux', 'env1', 'u1', 'Atrium Lux Sensor', 'lux-sensor',
               '["brightness-reading","turn-on"]', 'z1', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO device_instances (id, env_id, owner_id, name, type, capabilities_json, zone_id, created_at)
       VALUES ('d-cam', 'env1', 'u1', 'Hall People Counter', 'crowd-monitor',
               '["people-counting"]', 'z1', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO agent_instances
         (id, env_id, owner_id, name, capabilities_json, bound_device_ids_json,
          managed_zone_ids_json, created_at)
       VALUES ('a1', 'env1', 'u1', 'Guardian', '[]',
               '["d-siren","d-lux","d-cam"]', '[]', '2026-01-01T00:00:00Z')`,
    ).run();
    const seedService = (id: string, semanticType: string, origin: string, source: string | null) =>
      old.prepare(
        `INSERT INTO service_instances
           (id, env_id, provider_agent_id, name, semantic_type, description,
            interface_json, origin, source_device_id, visibility, created_at)
         VALUES (?, 'env1', 'a1', ?, ?, '', '{}', ?, ?, 'public', '2026-01-01T00:00:00Z')`,
      ).run(id, `${id} name`, semanticType, origin, source);
    // R101 evolution: emergency-broadcast has a REAL handler now — this row
    // is no longer a dead end and must SURVIVE the re-derivation (pre-R101
    // it was the prune case).
    seedService('svc-dead', 'emergency-broadcast', 'derived', 'd-siren');
    seedService('svc-live', 'turn-on', 'derived', 'd-siren'); // survives — id must stay
    // The prune case, now exercised with a genuinely route-less name:
    // 'people-counting' has no handler and no semantic route.
    seedService('svc-ghost', 'people-counting', 'derived', 'd-cam');
    seedService('svc-pub', 'emergency-broadcast', 'published', null); // published: untouched
    old.prepare(
      `INSERT INTO service_subscriptions (user_id, service_id, env_id, created_at)
       VALUES ('u1', 'svc-live', 'env1', '2026-01-01T00:00:00Z')`,
    ).run();
    old.close();

    const db = openDatabase(path);
    const service = (id: string) =>
      db.prepare('SELECT * FROM service_instances WHERE id = ?').get(id) as
        | { id: string; visibility: string; origin: string }
        | undefined;

    // R101 evolution: the siren's derived emergency-broadcast row SURVIVES
    // — the capability is genuinely invocable now (real handler). Identity
    // is (source_device, semantic_type), so the id stays too.
    const dead = service('svc-dead');
    expect(dead).toBeDefined();
    expect(dead!.id).toBe('svc-dead');
    expect(dead!.origin).toBe('derived');

    // The prune path, exercised with a genuinely route-less name instead:
    // 'people-counting' has no handler and no semantic route.
    expect(service('svc-ghost')).toBeUndefined();

    // Surviving service keeps its id and flips to the T-208 members default.
    const live = service('svc-live');
    expect(live).toBeDefined();
    expect(live!.id).toBe('svc-live');
    expect(live!.visibility).toBe('members');
    expect(live!.origin).toBe('derived');

    // The subscription on the surviving service still resolves.
    const subscribed = db.prepare(
      `SELECT s.id FROM service_instances s
       JOIN service_subscriptions sub ON sub.service_id = s.id
       WHERE sub.user_id = 'u1'`,
    ).all() as { id: string }[];
    expect(subscribed.map(r => r.id)).toEqual(['svc-live']);

    // Published offers are untouched by both the prune and the flip.
    const pub = service('svc-pub');
    expect(pub).toBeDefined();
    expect(pub!.visibility).toBe('public');
    expect(pub!.origin).toBe('published');

    // The wrongly-suppressed sensor telemetry was restored (brightness-
    // reading on a lux sensor: the old family table killed it; the oracle
    // order now derives it) — as a NEW row at members visibility.
    const restored = db.prepare(
      `SELECT * FROM service_instances
       WHERE provider_agent_id = 'a1' AND semantic_type = 'brightness-reading'`,
    ).get() as { visibility: string; origin: string } | undefined;
    expect(restored).toBeDefined();
    expect(restored!.visibility).toBe('members');
    expect(restored!.origin).toBe('derived');

    expect(
      (db.prepare('SELECT MAX(version) AS v FROM migrations').get() as { v: number }).v,
    ).toBe(MIGRATIONS.at(-1)!.version);
    db.close();
  });

  it('v36 relabels switching-only derived services honestly and prunes collapsed duplicates', () => {
    const path = join(dir, 'v35-honest-labels.db');
    const old = new Database(path);
    old.pragma('journal_mode = WAL');
    applyUpTo(old, 35);

    // A pre-T-043 world: an exhaust fan whose only capability 'ventilation'
    // dispatched to turn-on (row labeled 'ventilation' — the overpromise),
    // and a light carrying BOTH a 'lighting-control' marketing row and the
    // direct 'turn-on' row it collapses into (the duplicate).
    old.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, created_at)
       VALUES ('u1', 'honest@t.local', 'hash', 'Honest User', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO environments (id, name, map_data_json, owner_id, created_at, updated_at)
       VALUES ('env1', 'Honest World', '{"zones":[{"id":"z1"}]}', 'u1',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(`INSERT INTO env_members (env_id, user_id, role) VALUES ('env1', 'u1', 'owner')`).run();
    old.prepare(
      `INSERT INTO device_instances (id, env_id, owner_id, name, type, capabilities_json, zone_id, created_at)
       VALUES ('d-fan', 'env1', 'u1', 'Bathroom Fan', 'exhaust-fan',
               '["ventilation"]', 'z1', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO device_instances (id, env_id, owner_id, name, type, capabilities_json, zone_id, created_at)
       VALUES ('d-light', 'env1', 'u1', 'Corridor Light', 'light',
               '["lighting-control","turn-on"]', 'z1', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO device_instances (id, env_id, owner_id, name, type, capabilities_json, zone_id, created_at)
       VALUES ('d-plug', 'env1', 'u1', 'Hall Plug', 'smart-plug',
               '["environment"]', 'z1', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO agent_instances
         (id, env_id, owner_id, name, capabilities_json, bound_device_ids_json,
          managed_zone_ids_json, created_at)
       VALUES ('a1', 'env1', 'u1', 'Facility', '[]',
               '["d-fan","d-light","d-plug"]', '[]', '2026-01-01T00:00:00Z')`,
    ).run();
    const seedService = (id: string, semanticType: string, source: string | null) =>
      old.prepare(
        `INSERT INTO service_instances
           (id, env_id, provider_agent_id, name, semantic_type, description,
            interface_json, origin, source_device_id, visibility, created_at)
         VALUES (?, 'env1', 'a1', ?, ?, '', '{}', 'derived', ?, 'members', '2026-01-01T00:00:00Z')`,
      ).run(id, `${id} name`, semanticType, source);
    seedService('svc-fan-marketing', 'ventilation', 'd-fan'); // was the overpromising label
    seedService('svc-light-marketing', 'lighting-control', 'd-light'); // collapses into…
    seedService('svc-light-on', 'turn-on', 'd-light'); // …this verbatim row (id must stay)
    seedService('svc-plug-marketing', 'environment', 'd-plug'); // overpromising label (switching-only)
    old.close();

    const db = openDatabase(path);
    const rows = db.prepare(
      `SELECT id, semantic_type, source_device_id FROM service_instances
       WHERE origin = 'derived' ORDER BY semantic_type`,
    ).all() as Array<{ id: string; semantic_type: string; source_device_id: string }>;

    // R101 evolution: the fan's 'ventilation' row is NO LONGER an
    // overpromise — the command really dispatches (R101 handler), so the
    // honest label keeps the capability verbatim instead of collapsing to
    // 'switching'.
    const fanRow = rows.find(r => r.source_device_id === 'd-fan');
    expect(fanRow).toBeDefined();
    expect(fanRow!.semantic_type).toBe('ventilation');

    // The switching-only relabel path, now exercised by the smart plug's
    // 'environment' marketing row (its only executable route is on/off).
    const plugSwitch = rows.find(r => r.source_device_id === 'd-plug');
    expect(plugSwitch).toBeDefined();
    expect(plugSwitch!.semantic_type).toBe('switching');

    // The light keeps ONLY the verbatim turn-on row, id-stable.
    const lightRows = rows.filter(r => r.source_device_id === 'd-light');
    expect(lightRows.map(r => r.semantic_type)).toEqual(['turn-on']);
    expect(lightRows[0]!.id).toBe('svc-light-on');

    expect(
      (db.prepare('SELECT MAX(version) AS v FROM migrations').get() as { v: number }).v,
    ).toBe(MIGRATIONS.at(-1)!.version);
    db.close();
  });

  it('v50 indexes service_instances.provider_agent_id — per-agent derivation lookups stop full-scanning', () => {
    const path = join(dir, 'v49-provider-index.db');
    const old = new Database(path);
    old.pragma('journal_mode = WAL');
    applyUpTo(old, 49);
    seedV1Rows(old);
    old.close();

    const db = openDatabase(path);
    // The index exists…
    const index = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'service_instances' AND name = ?",
      )
      .get('idx_service_instances_provider');
    expect(index).toBeDefined();
    // …and SQLite actually USES it for the derivation-sync lookup
    // (derivedServicesOfAgent) that drove the R44-insane import superlinear
    // (913 agents × full-table scans of the growing services table).
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM service_instances WHERE provider_agent_id = ? AND origin = 'derived'",
      )
      .all('a1') as Array<{ detail: string }>;
    expect(plan.some(step => step.detail.includes('idx_service_instances_provider'))).toBe(true);
    db.close();
  });

  it('v58 adds usage_records.origin — pre-existing rows read NULL', () => {
    const path = join(dir, 'v57-usage-origin.db');
    const old = new Database(path);
    old.pragma('journal_mode = WAL');
    applyUpTo(old, 57);
    // A pre-v58 metered row (v57 column shape) on a minimal but FK-valid
    // parent chain (better-sqlite3 enforces FKs by default).
    old.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, created_at)
       VALUES ('u1', 'origin@t.local', 'hash', 'Origin User', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO environments (id, name, map_data_json, owner_id, created_at, updated_at)
       VALUES ('env1', 'Origin World', '{"zones":[]}', 'u1',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO agent_instances (id, env_id, owner_id, name, created_at)
       VALUES ('a1', 'env1', 'u1', 'Origin Agent', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO service_instances
         (id, env_id, provider_agent_id, name, semantic_type, description,
          interface_json, origin, visibility, created_at)
       VALUES ('svc1', 'env1', 'a1', 'Origin Service', 'turn-on', '', '{}', 'derived',
               'members', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO service_agreements
         (id, env_id, service_id, consumer_owner_id, provider_agent_id, provider_owner_id,
          terms_json, status, created_at, updated_at)
       VALUES ('ag1', 'env1', 'svc1', 'u1', 'a1', 'u1', '{}', 'active',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO usage_records
         (id, agreement_id, env_id, kind, quantity, unit, outcome, started_at, ended_at)
       VALUES ('u-legacy', 'ag1', 'env1', 'invoke', 1, 'action', 'success',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')`,
    ).run();
    old.close();

    const db = openDatabase(path);
    const columns = (db.prepare('PRAGMA table_info(usage_records)').all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(columns).toContain('origin');
    // The pre-v58 row kept its data and reads a NULL origin (honest
    // "unknown" — no fabricated dimension on old evidence).
    const legacy = db.prepare('SELECT kind, outcome, origin FROM usage_records WHERE id = ?')
      .get('u-legacy') as { kind: string; outcome: string; origin: string | null };
    expect(legacy.kind).toBe('invoke');
    expect(legacy.outcome).toBe('success');
    expect(legacy.origin).toBeNull();
    db.close();
  });
});

describe('SQLite backup/restore round-trip (R15-A2)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'eaf-backup-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('backup while live (WAL) → restore over a lost file → data intact', async () => {
    const livePath = join(dir, 'live.db');
    const backupPath = join(dir, 'backup.db');

    // Live database with WAL content not yet checkpointed into the main file.
    const db = openDatabase(livePath);
    seedV1Rows(db);
    const userStore = new UserStore(db);
    expect(userStore.count()).toBe(1);

    // The documented ops path: better-sqlite3 .backup() (equivalent of the
    // sqlite3 CLI's `.backup`) takes a consistent snapshot even in WAL mode
    // with the server still running — no stop-the-world needed.
    await db.backup(backupPath);
    expect(existsSync(backupPath)).toBe(true);
    expect(statSync(backupPath).size).toBeGreaterThan(0);

    // The backup is a complete, current-schema database on its own.
    const check = openDatabase(backupPath);
    expect((check.prepare('SELECT id FROM users WHERE email = ?').get('legacy@t.local') as { id: string }).id).toBe('u1');
    expect((check.prepare('SELECT id FROM environments WHERE id = ?').get('env1') as { id: string }).id).toBe('env1');
    check.close();

    // Disaster + restore: delete the live database (all WAL side files too),
    // copy the backup in its place, open as usual.
    db.close();
    rmSync(livePath, { force: true });
    rmSync(`${livePath}-wal`, { force: true });
    rmSync(`${livePath}-shm`, { force: true });
    copyFileSync(backupPath, livePath);

    const restored = openDatabase(livePath);
    const restoredStore = new UserStore(restored);
    expect(restoredStore.findByEmail('legacy@t.local')?.id).toBe('u1');
    // Writes work after restore — the file is a fully functional database.
    restored.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, created_at)
       VALUES ('u2', 'post-restore@t.local', 'hash', 'After Restore', '2026-01-03T00:00:00Z')`,
    ).run();
    expect(restoredStore.count()).toBe(2);
    restored.close();
  });
});
