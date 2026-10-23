/**
 * Architecture guards (R21-W5) — institutionalized as tests so `npm test`
 * / CI enforces them (no eslint infra exists in this repo; the
 * programmatic-scan approach is the house-compatible equivalent of
 * no-restricted-imports).
 *
 * Guards in this file:
 *   (a) FILE-SIZE BUDGET — tracked non-test server sources stay under
 *       FILE_BUDGET_LINES; grandfathered files carry explicit ceilings
 *       (a ratchet: growth beyond the recorded ceiling fails, so the debt
 *       can only shrink).
 *   (b) IMPORT DIRECTION — nothing outside routes/ + the composition roots
 *       (server.ts, index.ts) imports routes/ (services-over-stores,
 *       routes on top — the audit §1 server-side rules; covers db/*).
 *   (d) ERROR-CODE REGISTRY — every emitted ApiError/errorBody code is
 *       listed in error-code-registry.ts, and every registry entry is
 *       still emitted (see that file for the workflow).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from './error-code-registry.js';

/** Absolute apps/server/src — vitest cwd is the package root. */
const SERVER_SRC = join(process.cwd(), 'src');

interface SourceFile {
  abs: string;
  /** repo-relative display path, forward slashes. */
  rel: string;
  text: string;
}

function walkSources(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSources(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      const text = readFileSync(full, 'utf8');
      out.push({
        abs: full,
        rel: relative(join(process.cwd(), '..', '..'), full).split(sep).join('/'),
        text,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// (a) File-size budget
// ---------------------------------------------------------------------------

const FILE_BUDGET_LINES = 2200;

/**
 * Grandfathered files (ratchet). ceiling = the size recorded when the
 * budget landed (R21-W5). A file fails when it exceeds its ceiling; shrink
 * it and lower the ceiling in the same commit. New files must fit the
 * budget outright — the failure message names this table, so entries
 * cannot appear silently.
 */
const GRANDFATHERED: Record<string, number> = {
  // (none today — R21-W1 extracted agreements.ts to ~1041; keep it that way)
};

describe('arch guard (a): file-size budget', () => {
  const sources = walkSources(SERVER_SRC);

  it('walks a non-trivial source tree', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it.each(sources.map(f => [f.rel, f] as const))(
    '%s stays within its size ceiling',
    (rel, f) => {
      const ceiling = GRANDFATHERED[rel] ?? FILE_BUDGET_LINES;
      const lines = f.text.split('\n').length;
      expect(
        lines,
        `${rel} is ${lines} lines (ceiling ${ceiling}). ` +
          'Split it (see the agreements/ service-layer pattern, R21-W1) or, ' +
          'for recorded legacy debt only, adjust GRANDFATHERED in ' +
          'apps/server/src/arch-guards.vitest.test.ts — ceilings may only go DOWN.',
      ).toBeLessThanOrEqual(ceiling);
    },
  );

  it('has no stale grandfather entries', () => {
    const paths = new Set(sources.map(f => f.rel));
    for (const rel of Object.keys(GRANDFATHERED)) {
      expect(paths, `${rel} is grandfathered but no longer exists`).toContain(rel);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Import direction
// ---------------------------------------------------------------------------

const ROUTE_IMPORT = /from\s+'[^']*\/routes\/[^']*'/;
/** Composition roots — the ONLY non-route files allowed to wire routes. */
const ROOTS = new Set(['apps/server/src/server.ts', 'apps/server/src/index.ts']);

describe('arch guard (b): import direction (server)', () => {
  const nonRoutes = walkSources(SERVER_SRC).filter(f => !f.rel.includes('/routes/'));

  it.each(nonRoutes.map(f => [f.rel, f] as const))('%s never imports routes/', (rel, f) => {
    if (ROOTS.has(rel)) return;
    expect(
      f.text,
      `${rel} imports routes/ — routes are the consumption layer, nothing may ` +
        'depend back on them (audit §1). Move the shared logic into a service module.',
    ).not.toMatch(ROUTE_IMPORT);
  });
});

// ---------------------------------------------------------------------------
// (d) Error-code registry consistency
// ---------------------------------------------------------------------------

describe('arch guard (d): error-code registry', () => {
  const emitted = new Set<string>();
  for (const f of walkSources(SERVER_SRC)) {
    // The registry's own doc comment carries the scan pattern — skip it.
    if (f.rel === 'apps/server/src/error-code-registry.ts') continue;
    for (const m of f.text.matchAll(/new ApiError\(\s*\d+\s*,\s*'([A-Z][A-Z_]+)'/g)) {
      emitted.add(m[1]);
    }
    for (const m of f.text.matchAll(/errorBody\(\s*'([A-Z][A-Z_]+)'/g)) {
      emitted.add(m[1]);
    }
  }

  it('derives a non-trivial emitted set', () => {
    expect(emitted.size).toBeGreaterThan(100);
  });

  it('every emitted code is registered', () => {
    const registered = new Set(ERROR_CODES);
    const missing = [...emitted].filter(code => !registered.has(code)).sort();
    expect(
      missing,
      'New error code(s) not in the registry. Add them to ERROR_CODES in ' +
        'apps/server/src/error-code-registry.ts — that is the explicit ' +
        'decision point for whether openapi.yaml documents them (R21-W5).',
    ).toEqual([]);
  });

  it('every registered code is still emitted (no dead entries)', () => {
    const dead = ERROR_CODES.filter(code => !emitted.has(code));
    expect(
      dead,
      'Registry entries no longer emitted — remove them so real removals ' +
        'stay visible (R21-W5).',
    ).toEqual([]);
  });
});
