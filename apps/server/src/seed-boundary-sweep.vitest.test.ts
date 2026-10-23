/**
 * @vitest-environment node
 *
 * Localized-text boundary sweep (RC-2 recurrence guard, 2026-08-16).
 *
 * Incident: bundled scenarios migrated `meta.name`/`meta.description` to
 * `{zh, en}` objects, but seed.ts' geo-template gate still required a plain
 * string — three city templates silently stopped seeding, and the red tests
 * went unnoticed for weeks (no CI). The import boundary itself was already
 * normalized; the gap was a second, older string-typed consumer.
 *
 * This sweep pins the invariant at the SOURCE: every scenario file shipped in
 * config/scenarios must survive the full name-bearing pipeline —
 * loadScenarioFile → importScenarioAsEnvironment — landing a non-empty,
 * plain-string zh-canonical environment name. Any future file that breaks a
 * name boundary fails here, at the boundary, instead of silently skipping.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importScenarioAsEnvironment } from './environment-import.js';
import { instantiateTemplate } from './scenario-template-vars.js';
import { makeTestApp, registerUser, type TestAppContext } from './test-utils.js';
import { loadScenarioFile } from '@active-collaboration/core';

const SEED_DIR = join(__dirname, '../../../config/scenarios');

describe('localized-text boundary sweep (seed/import name pipeline)', () => {
  let ctx: TestAppContext;
  let ownerId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    ownerId = (await registerUser(ctx.app)).id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('every bundled scenario lands a non-empty string env name (string or {zh,en} meta)', () => {
    const files = readdirSync(SEED_DIR).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(10); // guard the guard: the dir must stay populated
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(SEED_DIR, file), 'utf-8'));
      // Parameterized templates (UX wave-3 meta.vars) are not loadable
      // scenarios until instantiated — expand with declared defaults before
      // the pipeline (same default expansion as GET /api/scenario-templates/:id).
      const scenario = raw !== null && typeof raw === 'object' &&
        Array.isArray((raw as { meta?: { vars?: unknown } }).meta?.vars)
        ? instantiateTemplate(raw, {})
        : raw;
      // Loader accepts the union shape…
      const definition = loadScenarioFile(scenario);
      // …and the import boundary serializes it to the zh-canonical string.
      const env = importScenarioAsEnvironment(ctx.app.envStore, scenario, {
        ownerId,
        visibility: 'private',
      });
      expect(typeof env.name, `${file}: env.name must be a plain string`).toBe('string');
      expect(env.name.trim().length, `${file}: env.name must be non-empty`).toBeGreaterThan(0);
      expect(env.name, `${file}: env.name should be the zh-canonical form`).toBe(localizedZh(definition.meta.name));
      expect(typeof env.description).toBe('string');
    }
  });
});

/** zh-canonical form, mirroring environment-import's serialization. */
function localizedZh(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const v = value as { zh?: unknown; en?: unknown };
    if (typeof v.zh === 'string' && v.zh.trim().length > 0) return v.zh;
    if (typeof v.en === 'string' && v.en.trim().length > 0) return v.en;
  }
  return '';
}
