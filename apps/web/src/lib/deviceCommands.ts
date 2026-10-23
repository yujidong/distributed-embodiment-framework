/**
 * Console device command face (UX-W1 wave-1 task B) — derives the actuation
 * commands a device offers in the console action sheet from its declared
 * capabilities.
 *
 * TWO deliberate mirrors, each with ONE server-side source of truth — if the
 * core predicate/surface changes, change these copies too:
 *
 * - `isReadOnlyCapabilityName` mirrors
 *   `packages/core/src/capabilities/read-only.ts` (the BUG-04 union
 *   predicate: observation verbs/nouns name queries, never commands). The
 *   read-only capabilities must NOT appear in the console's command face —
 *   offering them would die server-side with the "read-only capability"
 *   teaching error.
 * - `deriveDeviceCommandFace` mirrors `deriveDeviceCommands` in
 *   `packages/core/src/cognition/world-model-builder.ts` (lowercase, dedupe,
 *   read-only filter) so the sheet offers exactly the actuation surface the
 *   agent prompt / deviceActions bridge validates against.
 *
 * Parameter entry reuses the DeploymentPanel command-test conventions
 * (`parseParamsJson` / `commandFeedback` in lib/hass.ts): params are an
 * optional JSON object — the sim's per-device handlers own the real
 * parameter keys (e.g. set-temperature takes `temperature` on some device
 * types, `targetTemperature` on others), so a typed form would guess.
 */

/**
 * MIRROR of packages/core/src/capabilities/read-only.ts — the single source
 * of truth for "this capability names an observation, not an actuation".
 * Keep the vocabulary in sync with the core file.
 */
export function isReadOnlyCapabilityName(name: string): boolean {
  const lower = name.toLowerCase();
  if (
    lower.includes('reading') || lower.includes('sensing') ||
    lower.includes('monitoring') || lower.includes('detection') ||
    lower.includes('detect')
  ) {
    return true;
  }
  const normalized = lower.replace(/[-_]/g, '');
  return /^(get|read|query|check|measure|sense)/.test(normalized);
}

/**
 * MIRROR of deriveDeviceCommands (packages/core/src/cognition/
 * world-model-builder.ts): the device's executable command surface —
 * declared capabilities lowercased, deduped, with read-only (observation)
 * capabilities filtered out.
 */
export function deriveDeviceCommandFace(capabilities: readonly string[]): string[] {
  return [...new Set(
    capabilities
      .map(cap => (typeof cap === 'string' ? cap.toLowerCase() : ''))
      .filter(cap => cap.length > 0 && !isReadOnlyCapabilityName(cap)),
  )];
}
