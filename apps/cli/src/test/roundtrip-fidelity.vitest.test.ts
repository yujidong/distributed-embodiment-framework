/**
 * Fix-2 (RC-2) CLI fidelity e2e: `eaf env export` → `eaf apply` round-trip
 * of the teaching-building fixture against the REAL apps/server.
 *
 * Pins the whole export chain — environment detail → world document
 * (export.ts) → validation (validate.ts) → apply (apply.ts) → environment
 * detail again — on the fixture's full field set: per-zone
 * buildingId/floor/occupancy/bounds/baseline, map storeyHeight, and all 19
 * scheduled events. A field dropped in any layer fails here.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { bootServer, makeCli, type CliRunner, type TestServer } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const FIXTURE_PATH = join(REPO_ROOT, 'config', 'scenarios', 'teaching-building.json');

let server: TestServer;
let eaf: CliRunner;
const stamp = Date.now().toString(36);

interface FixtureZone {
  id: string;
  name?: string;
  type?: string;
  buildingId?: string;
  floor?: number;
  occupancy?: number;
  bounds?: Record<string, number>;
  baseline?: Record<string, number | boolean>;
  adjacentZoneIds?: string[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  meta: { name: string; storeyHeight?: number };
  zones: FixtureZone[];
  events: Array<Record<string, unknown>>;
};

beforeAll(async () => {
  server = await bootServer();
  eaf = makeCli(server.baseUrl);
  const registered = await eaf.cli(
    'auth', 'register',
    '--email', `rt-${stamp}@example.com`,
    '--password', 'password-123',
    '--name', 'RoundTrip Tester',
  );
  expect(registered.code).toBe(0);
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

function sessionToken(): string {
  const config = JSON.parse(readFileSync(join(eaf.home, 'config.json'), 'utf8')) as { token?: string };
  expect(config.token).toBeTruthy();
  return config.token!;
}

function expectZoneFidelity(detailZones: Array<Record<string, unknown>>, where: string) {
  const byId = new Map(detailZones.map(zone => [zone.id as string, zone]));
  expect(detailZones.length, where).toBe(fixture.zones.length);
  for (const raw of fixture.zones) {
    const actual = byId.get(raw.id);
    expect(actual, `${where}: zone ${raw.id}`).toBeDefined();
    if (raw.name !== undefined) expect(actual!.name).toBe(raw.name);
    if (raw.type !== undefined) expect(actual!.type).toBe(raw.type);
    if (raw.buildingId !== undefined) expect(actual!.buildingId).toBe(raw.buildingId);
    if (raw.floor !== undefined) expect(actual!.floor).toBe(raw.floor);
    if (raw.occupancy !== undefined) expect(actual!.occupancy).toBe(raw.occupancy);
    if (raw.bounds !== undefined) expect(actual!.bounds).toEqual(raw.bounds);
    if (raw.baseline !== undefined) expect(actual!.baseline).toEqual(raw.baseline);
    const adj = new Set((actual!.adjacentZoneIds ?? []) as string[]);
    for (const declared of raw.adjacentZoneIds ?? []) {
      expect(adj.has(declared), `${where}: adjacency ${raw.id}→${declared}`).toBe(true);
    }
  }
}

function expectEventFidelity(detailEvents: Array<Record<string, unknown>>, where: string) {
  const byId = new Map(detailEvents.map(event => [event.id as string, event]));
  expect(detailEvents.length, where).toBe(fixture.events.length);
  for (const raw of fixture.events) {
    expect(byId.get(raw.id as string), `${where}: event ${raw.id}`).toMatchObject(raw);
  }
}

describe('teaching-building export → apply round-trip (Fix-2)', () => {
  test(
    'import → export → apply → detail preserves floors, occupancy and events',
    async () => {
      // Import the fixture straight through the API (same body a user POSTs).
      const imported = await fetch(`${server.baseUrl}/api/environments`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sessionToken()}`,
        },
        body: JSON.stringify(fixture),
      });
      expect(imported.status).toBe(201);
      const original = (await imported.json()) as { id: string };
      expectZoneFidelity((original as never as { zones: [] }).zones, 'imported detail');
      expectEventFidelity((original as never as { events: [] }).events, 'imported detail');

      // Export the environment as a world document.
      const exported = await eaf.cli('env', 'export', original.id, '--json');
      expect(exported.code).toBe(0);
      const document = exported.json();
      expect(document.environment.map.storeyHeight).toBe(fixture.meta.storeyHeight);
      expect(document.environment.map.zones).toHaveLength(fixture.zones.length);
      expect(document.events).toHaveLength(fixture.events.length);

      // Apply the exported document under a new name.
      document.environment.name = `roundtrip-copy-${stamp}`;
      writeFileSync(join(eaf.home, 'world.json'), JSON.stringify(document));
      const applied = await eaf.cli('apply', '-f', 'world.json', '--json');
      expect(applied.stderr).toBe('');
      expect(applied.code).toBe(0);
      expect(applied.json().ok).toBe(true);

      // The copy's detail matches the fixture's full field set.
      const copy = (
        await eaf.cli('env', 'get', `roundtrip-copy-${stamp}`, '--json')
      ).json();
      expect(copy.storeyHeight).toBe(fixture.meta.storeyHeight);
      expectZoneFidelity(copy.zones, 'round-tripped detail');
      expectEventFidelity(copy.events, 'round-tripped detail');

      // Re-applying is idempotent (the canonical comparison sees no drift).
      const reapplied = await eaf.cli('apply', '-f', 'world.json', '--json');
      expect(reapplied.code).toBe(0);
      expect(reapplied.json().envAction).toBe('unchanged');
    },
    90_000,
  );
});
