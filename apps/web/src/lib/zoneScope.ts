/**
 * Zone scoping (A2) — the sim-start zone multi-select, kept as pure helpers
 * so the "all selected → omit zoneIds" rule stays unit-testable.
 *
 * Semantics: the server reads `zoneIds` at the TOP LEVEL of the create body
 * (not inside `options`) and prunes the bridged world to those zones. All
 * zones selected == no scoping == omit the field entirely.
 */

/**
 * Resolve the zoneIds payload from the full zone list and the set of zones
 * the user UNCHECKED. Returns undefined when nothing is excluded (server
 * receives no zoneIds), otherwise the ids that remain selected — possibly an
 * empty array (UI disables start in that case).
 */
export function resolveScopedZoneIds(
  allZoneIds: readonly string[],
  excluded: ReadonlySet<string>,
): string[] | undefined {
  if (excluded.size === 0) return undefined;
  return allZoneIds.filter(id => !excluded.has(id));
}

/** Toggle one id in an exclusion set (immutable update). */
export function toggleZoneExclusion(excluded: ReadonlySet<string>, zoneId: string): Set<string> {
  const next = new Set(excluded);
  if (next.has(zoneId)) next.delete(zoneId);
  else next.add(zoneId);
  return next;
}
