/**
 * @vitest-environment node
 *
 * R80-FW3 guard — capability-demand telemetry:
 *  ① write-time dedup (repeat signal bumps count, not rows — the ×N lesson)
 *  ② top-N aggregation with per-capability user/signal counts
 *  ③ catalogGap: capabilities no active catalog model provides are flagged
 *     (the actionable rows for a deployer)
 */

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type EafDatabase } from './db/database.js';
import { seedCatalogModels } from './db/catalog-seed.js';
import { CatalogStore } from './db/catalog-store.js';
import { CapabilityDemandStore } from './db/capability-demand-store.js';

// Track opened databases so afterEach can close them: a leaked native
// better-sqlite3 handle can access-violate (0xC0000005) at worker-thread
// teardown and kill the whole threads-pool runner.
const dbs: EafDatabase[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function fresh() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  seedCatalogModels(new CatalogStore(db), null);
  // Real users/env rows — the table carries FKs (signals are attributable).
  db.prepare(`INSERT INTO users (id, email, password_hash, display_name, created_at)
              VALUES ('u1', 'u1@t.local', 'x', 'U1', ?)`).run(new Date().toISOString());
  db.prepare(`INSERT INTO users (id, email, password_hash, display_name, created_at)
              VALUES ('u2', 'u2@t.local', 'x', 'U2', ?)`).run(new Date().toISOString());
  db.prepare(`INSERT INTO environments (id, name, description, map_type, map_data_json, owner_id, visibility, created_at, updated_at)
              VALUES ('e1', 'E1', '', 'grid', '{}', 'u1', 'private', ?, ?)`).run(new Date().toISOString(), new Date().toISOString());
  return { db, store: new CapabilityDemandStore(db) };
}

describe('capability-demand telemetry (R80-FW3)', () => {
  it('dedups repeat signals at write time (count++, not new rows)', () => {
    const { store } = fresh();
    store.record({ userId: 'u1', envId: 'e1', capability: 'crowd-monitoring', source: 'wizard-unbacked-chip' });
    store.record({ userId: 'u1', envId: 'e1', capability: 'crowd-monitoring', source: 'wizard-unbacked-chip' });
    store.record({ userId: 'u2', envId: 'e1', capability: 'crowd-monitoring', source: 'catalog-zero-hit' });
    const top = store.topDemand();
    const crowd = top.find(t => t.capability === 'crowd-monitoring');
    expect(crowd).toBeDefined();
    expect(crowd!.users).toBe(2); // distinct users
    expect(crowd!.signals).toBe(3); // summed counts
    expect(crowd!.sources).toContain('wizard-unbacked-chip');
    expect(crowd!.sources).toContain('catalog-zero-hit');
  });

  it('catalogGap flags capabilities no active model provides', () => {
    const { store } = fresh();
    // temperature-control IS provided by active seeds (Gree etc.) — no gap.
    store.record({ userId: 'u1', envId: null, capability: 'temperature-control', source: 'wizard-unbacked-chip' });
    // nobody provides antimatter-containment — a gap.
    store.record({ userId: 'u1', envId: null, capability: 'antimatter-containment', source: 'catalog-zero-hit' });
    const top = store.topDemand();
    expect(top.find(t => t.capability === 'temperature-control')!.catalogGap).toBe(false);
    expect(top.find(t => t.capability === 'antimatter-containment')!.catalogGap).toBe(true);
  });
});
