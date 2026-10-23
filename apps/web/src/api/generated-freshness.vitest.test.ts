/**
 * Generated-types freshness guard (R21-W5 c) — apps/web/src/api/generated.ts
 * must be byte-identical to what `npm run sync-types` produces from
 * apps/server/openapi.yaml.
 *
 * Why: the generated layer is the web's contract base (api/types.ts
 * hand-written views sit on top of it). An openapi.yaml edit committed
 * without re-running sync-types ships a stale contract silently — this
 * test turns that red at CI time. Same code path as the sync script
 * (openapi-typescript CLI, --empty-objects-unknown, stdout compare).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Repo root (this test runs with cwd = apps/web). */
const REPO_ROOT = join(process.cwd(), '..', '..');

describe('arch guard (c): generated-types freshness (sync-types committed)', () => {
  it('apps/web/src/api/generated.ts matches a fresh openapi-typescript run', () => {
    const bin = join(REPO_ROOT, 'node_modules', 'openapi-typescript', 'bin', 'cli.js');
    const spec = join(REPO_ROOT, 'apps', 'server', 'openapi.yaml');
    const fresh = execFileSync(process.execPath, [bin, spec, '--empty-objects-unknown'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // The CLI prints its banner to stderr; only stdout is the artifact.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const committed = readFileSync(join(process.cwd(), 'src', 'api', 'generated.ts'), 'utf8');
    expect(
      committed === fresh,
      'apps/web/src/api/generated.ts is STALE against apps/server/openapi.yaml. ' +
        'Run `npm run sync-types -w @active-collaboration/web` and commit the ' +
        'regenerated file with the spec change (one commit, one contract — R21-W5).',
    ).toBe(true);
  });
});
