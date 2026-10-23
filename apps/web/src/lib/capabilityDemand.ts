/**
 * R80-FW3 — capability-demand telemetry, client side.
 *
 * Pure fire-and-forget: a failed/absent report must NEVER block or annoy the
 * UI (this is an observability signal, not a user action). The server
 * dedups per (user, env, capability, source) — the client may report the
 * same fact repeatedly without cost.
 */

let inflight = new Set<string>();

export type DemandSource =
  | 'wizard-unbacked-chip'
  | 'wizard-rejected-declaration'
  | 'catalog-zero-hit';

/** Report one demand signal (deduped client-side per session too). */
export function reportCapabilityDemand(
  capability: string,
  source: DemandSource,
  envId?: string,
): void {
  const key = `${source}:${envId ?? '-'}:${capability}`;
  if (inflight.has(key)) return; // one report per signal per page session
  inflight.add(key);
  void fetch('/api/me/capability-demand', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capability, source, ...(envId !== undefined ? { envId } : {}) }),
  }).catch(() => {
    // Observability only — swallow. Anonymous users simply don't report.
  });
}
