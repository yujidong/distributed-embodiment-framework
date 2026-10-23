/**
 * Trajectory disk GC (T-011, R21-W4 extraction from simulation-registry.ts;
 * pure move, zero semantic change).
 *
 * Two GC paths bound trajectory-dir growth (a speed-30 campus sim writes
 * ~6.8GB/day of zone samples):
 * - per-file: sim-timeline.jsonl is capped (see sim-timeline.ts);
 * - per-dir: a record LEAVING the registry takes its registry-managed
 *   `<trajectoryBaseDir>/<simId>/` dir with it (deleteTrajectoryDir —
 *   explicit options.trajectoryDir overrides are caller-owned and never
 *   touched); `cleanupOldTrajectories` additionally sweeps stale dirs at
 *   server boot (records are in-memory, so every dir on disk at boot is an
 *   orphan from a previous process).
 */

import { readdirSync, rmSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/**
 * T-011 disk GC: remove the registry-managed trajectory dir of a record
 * that just left the registry. Only the DEFAULT location
 * `<trajectoryBaseDir>/<simId>/` is touched — explicit options.trajectoryDir
 * overrides are caller-owned (eval harnesses pass their own dirs) and must
 * survive registry churn. Failures only warn: a stuck dir is reaped by the
 * next boot sweep (cleanupOldTrajectories).
 */
export function deleteTrajectoryDir(baseDir: string | undefined, simId: string): void {
  if (baseDir === undefined) return;
  try {
    rmSync(join(baseDir, simId), { recursive: true, force: true });
  } catch (error) {
    console.warn(`SimulationRegistry: trajectory dir cleanup for sim ${simId} failed:`, error);
  }
}

/**
 * S3 (Task 2): the newest mtime under the registry-managed trajectory dir
 * of a sim id (`<trajectoryBaseDir>/<simId>/`, direct entries included —
 * dir mtime alone ignores appends, the T-011 lesson). 0 when the base dir
 * is unset or the dir does not exist. The fork-retention sweep reads this
 * as the fork's LAST ACTIVITY signal; ownership of the dir stays here
 * (callers never build registry-managed paths themselves).
 */
export function lastDiskActivityMs(baseDir: string | undefined, simId: string): number {
  if (baseDir === undefined) return 0;
  return newestMtimeMs(join(baseDir, simId));
}

/**
 * Boot-time sweep of the trajectory base dir (T-011): delete every
 * `sim-*` directory whose newest content (dir or file mtime — dir mtime
 * alone ignores appends to an existing file) is older than maxAgeMs.
 * Registry records are in-memory, so every dir present at boot belongs to a
 * simulation of a PREVIOUS process — sweeping them is safe. Runs
 * synchronously at startup; a base dir that cannot be read (missing, no
 * permission) is treated as empty. Never throws.
 *
 * @returns counts for boot logging; `kept` includes dirs that failed to
 * delete (they get another chance on the next boot).
 */
export function cleanupOldTrajectories(
  baseDir: string,
  maxAgeMs: number,
  now: number = Date.now(),
): { removed: number; kept: number } {
  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return { removed: 0, kept: 0 }; // missing/unreadable base dir — nothing to do
  }
  const cutoff = now - maxAgeMs;
  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    // Same convention as the replay scanner (iterSimJsonlFiles): only
    // simulation dirs are registry-managed; anything else in the base dir
    // belongs to someone else and is left alone.
    if (!entry.isDirectory() || !entry.name.startsWith('sim-')) continue;
    const dirPath = join(baseDir, entry.name);
    if (newestMtimeMs(dirPath) >= cutoff) {
      kept += 1;
      continue;
    }
    try {
      rmSync(dirPath, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      kept += 1; // retry on the next boot
      console.warn(`SimulationRegistry: trajectory sweep could not remove ${dirPath}:`, error);
    }
  }
  return { removed, kept };
}

/**
 * Newest mtime across a sim dir and its entries, RECURSING into subdirectories
 * (bounded depth — trajectory dirs are `sim-…/<baseName>/segment-….jsonl`,
 * two levels). A long-running sim's dir mtime stays at creation time (appends
 * don't touch dir mtime on all platforms), and Living-worlds P2 moved the
 * append targets into segment SUBDIRS (`sim-timeline/segment-000002.jsonl`) —
 * checking only direct entries would miss an actively-appended segment the
 * same way the pre-T-011 sweep missed actively-appended files. Unreadable
 * entries contribute 0 (oldest possible — sweep reaps it).
 */
function newestMtimeMs(dirPath: string, depth: number = 2): number {
  let newest = 0;
  try {
    newest = statSync(dirPath).mtimeMs;
  } catch {
    return 0;
  }
  if (depth <= 0) return newest;
  try {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      try {
        const full = join(dirPath, entry.name);
        const mtime = entry.isDirectory() ? newestMtimeMs(full, depth - 1) : statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        // Half-deleted entry — the dir mtime above already covers it
      }
    }
  } catch {
    // Unreadable dir — the dir mtime above already covers it
  }
  return newest;
}
