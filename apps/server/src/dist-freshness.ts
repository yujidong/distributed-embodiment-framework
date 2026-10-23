/**
 * Stale-dist self-check (Fix-6, usability P1-8).
 *
 * The repository ships a prebuilt apps/server/dist, and the root build used
 * to compile only packages/ — so a user following the README could end up
 * running a server dist older than the sources, hitting ROUTE_NOT_FOUND on
 * routes that only exist in newer code with no hint why. On boot we compare
 * the running file's mtime against the newest source file and warn loudly
 * when the dist looks stale.
 *
 * The check is a no-op unless this module itself was loaded from a `dist/`
 * directory — under tsx/vitest (running from src/) there is nothing to
 * compare.
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

/** Newest mtime (ms) of non-test .ts files under a directory; 0 when unreadable. */
function newestSourceMtimeMs(dir: string): number {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtimeMs(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      try {
        newest = Math.max(newest, statSync(path).mtimeMs);
      } catch {
        // Unreadable file — ignore; the check is best-effort.
      }
    }
  }
  return newest;
}

/**
 * Newest mtime (ms) of any file under the dist tree (D2-F6): incremental
 * builds (tsc --build / turbo) only rewrite CHANGED outputs, so a single
 * entry-point mtime says nothing — comparing dist/index.js alone produced
 * false STALE warnings on perfectly fresh incremental builds. The newest
 * written output is the honest "when was this build last touched" signal.
 */
function newestDistMtimeMs(dir: string): number {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestDistMtimeMs(path));
    } else if (entry.isFile()) {
      try {
        newest = Math.max(newest, statSync(path).mtimeMs);
      } catch {
        // best-effort
      }
    }
  }
  return newest;
}

/**
 * Warn on stderr (the Fastify logger does not exist yet at the call site)
 * when the running dist is older than the sources. Exported seam: pass
 * `selfFile` to point the check at another tree (tests).
 */
export function warnIfDistStale(selfFile: string = __filename): void {
  const dir = dirname(selfFile);
  if (!dir.endsWith(`${sep}dist`)) return; // not a compiled build — nothing to check
  // D2-F6: compare the NEWEST dist output, not this file — incremental
  // builds leave unchanged outputs (index.js among them) at their old mtimes.
  const distMtime = newestDistMtimeMs(dir);
  if (distMtime === 0) return;
  const srcDir = join(dirname(dir), 'src');
  if (newestSourceMtimeMs(srcDir) > distMtime) {
    // eslint-disable-next-line no-console
    console.error(
      '[eaf-server] WARNING: apps/server/dist is older than apps/server/src — ' +
        'you are running a STALE build; routes or fixes added since the last build will be missing ' +
        '(symptom: ROUTE_NOT_FOUND for documented endpoints). ' +
        'Rebuild with: npm run build (repo root) or npm run build -w @active-collaboration/server.',
    );
  }
}
