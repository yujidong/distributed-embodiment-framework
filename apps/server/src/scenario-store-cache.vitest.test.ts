/**
 * @vitest-environment node
 *
 * T-033 (DevLoop R17, EC-F12): the scenario store's per-file
 * (path, mtime, size) cache.
 *
 * GET /api/scenarios re-read + re-validated every user file on every
 * anonymous request (~130 ms with one 2 MB saved replay, and replay
 * mode=save makes multi-MB files routine). These tests pin the cache
 * contract directly on the store class:
 *
 * 1. the second list is a cache hit (sub-parse latency);
 * 2. invalidating ONE file (store write or out-of-band edit) reloads that
 *    file only, and the next list is correct;
 * 3. invalid files are skipped AND warned about exactly once per version.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ScenarioStore } from './scenario-store.js';

/** A scenario big enough that parse+ajv-validate is measurable (~0.4 MB). */
function bigScenario(id: string, name: string) {
  return {
    version: '1.0',
    meta: { id, name, description: 'generated load fixture '.repeat(80) },
    zones: Array.from({ length: 40 }, (_, i) => ({
      id: `z-${i}`,
      name: `Zone ${i}`,
      adjacentZoneIds: [] as string[],
    })),
    devices: [
      {
        id: 'sensor-0',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'z-0',
      },
    ],
    agents: [
      {
        id: 'agent-0',
        name: 'Watcher',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['z-0'],
        boundDeviceIds: ['sensor-0'],
      },
    ],
    events: Array.from({ length: 1200 }, (_, i) => ({
      id: `e-${i}`,
      type: 'noise',
      zoneId: 'z-0',
      details: { blob: 'y'.repeat(140) },
    })),
  };
}

function minimalScenario(id: string, name: string) {
  const s = bigScenario(id, name);
  return { ...s, events: [] };
}

describe('scenario store per-file cache (T-033)', () => {
  let seedDir: string;
  let userDir: string;
  let warnings: string[];
  let store: ScenarioStore;

  beforeEach(() => {
    seedDir = mkdtempSync(join(tmpdir(), 'scenario-cache-seed-'));
    userDir = mkdtempSync(join(tmpdir(), 'scenario-cache-user-'));
    warnings = [];
    store = new ScenarioStore(seedDir, userDir, {
      warn: (_obj, msg) => warnings.push(msg),
    });
  });

  afterEach(() => {
    rmSync(seedDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  it('cache hits serve the SAME parsed object — no re-read, no re-parse', () => {
    store.create(bigScenario('big-1', 'Big One'));
    store.create(bigScenario('big-2', 'Big Two'));
    store.create(bigScenario('big-3', 'Big Three'));
    // One file written OUT OF BAND (an external editor): the first get must
    // genuinely parse it, so the identity check below is meaningful.
    writeFileSync(
      join(userDir, 'outside.json'),
      `${JSON.stringify(minimalScenario('outside', 'Outside Write'), null, 2)}\n`,
      'utf-8',
    );

    // A cache hit returns the SAME in-memory document object (reference
    // identity); a re-reading implementation would build a fresh deep-equal
    // copy on every call. This is deterministic — unlike wall-clock timing,
    // which flakes under a full parallel suite.
    const first = store.get('outside');
    expect(first).not.toBeNull();
    expect(first!.source).toBe('user');
    const second = store.get('outside');
    expect(second!.document).toBe(first!.document);
    expect(second!.definition).toBe(first!.definition);

    // list() is stable too, and store-created (primed) files hit the cache
    // the same way.
    const listOne = store.list();
    const listTwo = store.list();
    expect(listOne.map(s => s.id).sort()).toEqual(['big-1', 'big-2', 'big-3', 'outside']);
    expect(listTwo.map(s => s.name)).toEqual(listOne.map(s => s.name));
    expect(store.get('big-1')!.document).toBe(store.get('big-1')!.document);

    // And the flip side: an out-of-band write (mtime/size change) makes the
    // next get return a NEWLY parsed object with the new content.
    writeFileSync(
      join(userDir, 'outside.json'),
      `${JSON.stringify(minimalScenario('outside', 'Outside Rewrite'), null, 2)}\n`,
      'utf-8',
    );
    const third = store.get('outside');
    expect(third!.document).not.toBe(first!.document);
    expect((third!.document as { meta: { name: string } }).meta.name).toBe('Outside Rewrite');
  });

  it('saving a file invalidates just that entry — list reflects it immediately', () => {
    store.create(minimalScenario('stay', 'Stays'));
    store.create(minimalScenario('edit-me', 'Before'));
    expect(store.list().map(s => `${s.id}:${s.name}`).sort()).toEqual([
      'edit-me:Before',
      'stay:Stays',
    ]);

    // Store-mediated replace (the replay mode=save / PUT path).
    store.replace('edit-me', minimalScenario('edit-me', 'After'));
    const names = () => store.list().map(s => `${s.id}:${s.name}`).sort();
    expect(names()).toEqual(['edit-me:After', 'stay:Stays']);

    // Out-of-band edit (an external editor touching the file directly) is
    // caught by the per-file mtime/size key — dir mtime never moved.
    writeFileSync(
      join(userDir, 'stay.json'),
      `${JSON.stringify(minimalScenario('stay', 'Edited Externally'), null, 2)}\n`,
      'utf-8',
    );
    expect(names()).toEqual(['edit-me:After', 'stay:Edited Externally']);
  });

  it('a deleted file leaves the list (cache entry dropped)', () => {
    store.create(minimalScenario('gone', 'Gone'));
    expect(store.list()).toHaveLength(1);
    store.remove('gone');
    expect(store.list()).toHaveLength(0);
    // And it stays gone (no stale cache resurrection).
    expect(store.get('gone')).toBeNull();
  });

  it('invalid files are skipped and warned about ONCE per file version', () => {
    store.create(minimalScenario('valid', 'Valid'));
    writeFileSync(join(userDir, 'broken.json'), '{ not json', 'utf-8');

    const first = store.list();
    expect(first.map(s => s.id)).toEqual(['valid']);
    const second = store.list();
    expect(second.map(s => s.id)).toEqual(['valid']);

    const brokenWarnings = warnings.filter(w => w.includes('broken.json'));
    expect(brokenWarnings).toHaveLength(1);

    // Repairing the file (mtime/size change) reloads it into the list.
    writeFileSync(
      join(userDir, 'broken.json'),
      `${JSON.stringify(minimalScenario('broken', 'Fixed'), null, 2)}\n`,
      'utf-8',
    );
    expect(store.list().map(s => s.id).sort()).toEqual(['broken', 'valid']);
  });

  it('GET (store.get) rides the same cache — raw document served verbatim', () => {
    const raw = bigScenario('geo-raw', 'Raw Doc');
    store.create(raw);
    const stored = store.get('geo-raw');
    expect(stored).not.toBeNull();
    // T-031 semantics preserved under the cache: the raw document, verbatim.
    expect(stored!.document).toEqual(raw);
    expect(store.get('geo-raw')!.document).toEqual(raw);
    expect(warnings).toHaveLength(0);
  });
});
