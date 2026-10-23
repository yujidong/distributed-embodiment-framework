/**
 * Fork lineage / provenance (living-worlds P2F, design-living-worlds.md §10.4)
 *
 * The machine-checkable lineage every knowledge product out of a fork must
 * carry — replays, training exports (sft/dpo), sim-timeline reads. The
 * durable source is the `sandboxes` row itself (`fork_base_json` records
 * the fork parameters + policy + checkpoint identity, the row carries the
 * ids and stamps), so the chain survives runtime teardown and the S3
 * retention sweep (rows are kept, only runtimes/dirs go).
 *
 * 缺口二 fix (§10.4): lineage is EXPLICIT — a `forkId` field on the sim's
 * timeline records and the export manifests — never the accident of two
 * implicit keys (`scenario === env.id` vs `environmentId === env.id`)
 * agreeing.
 */

import { createHash } from 'node:crypto';

import type { SandboxRow } from './db/sandbox-store.js';

/**
 * §10.4's lineage record. `window` carries the OUTPUT's own export/replay
 * window (from 含 to 不含, replay semantics); `policy` is what the fork's
 * runtime actually ran with (recorded at fork time — honest about the tick
 * scheduler, never fabricated lazy knobs).
 */
export interface ForkLineage {
  forkId: string;
  envId: string;
  forkedAt: string;
  window: { from: string | null; to: string | null };
  /** Fork-time runtime policy, e.g. `{scheduling: 'tick'}` (+ checkpoint fork facts). */
  policy: Record<string, unknown>;
  /** Present on checkpoint forks: `<session sim id>@<simTimeSec>` — the copied boundary. */
  checkpointId?: string;
  /** Present when recorded at fork time: sha256 of the forked scenario JSON. */
  scenarioFingerprint?: string;
}

/** The parsed shape of `sandboxes.fork_base_json` (P2F extension of v11's `{overlays}`). */
export interface ForkBase {
  /** null = "the world as it was at fork time" (no event filtering). */
  overlays: string[] | null;
  policy?: Record<string, unknown>;
  checkpointId?: string;
  scenarioFingerprint?: string;
}

export function parseForkBase(
  row: Pick<SandboxRow, 'fork_base_json'>,
): ForkBase {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.fork_base_json);
  } catch {
    parsed = {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { overlays: null };
  }
  const base = parsed as Record<string, unknown>;
  const overlays = Array.isArray(base.overlays)
    ? base.overlays.every(item => typeof item === 'string')
      ? (base.overlays as string[])
      : null
    : null;
  return {
    overlays,
    ...(isPlainObject(base.policy) ? { policy: base.policy } : {}),
    ...(typeof base.checkpointId === 'string' ? { checkpointId: base.checkpointId } : {}),
    ...(typeof base.scenarioFingerprint === 'string'
      ? { scenarioFingerprint: base.scenarioFingerprint }
      : {}),
  };
}

/**
 * The §10.4 lineage record for one fork row. Degrades honestly: a swept or
 * foreign row still yields its ids (the row is the audit trail); a missing
 * row yields the caller's fallback id (or '(unresolved)') with empty facts.
 */
export function forkLineageOf(
  row: Pick<SandboxRow, 'id' | 'env_id' | 'created_at' | 'fork_base_json'> | undefined,
  window: { from: string | null; to: string | null } = { from: null, to: null },
  fallbackId?: string,
): ForkLineage {
  if (row === undefined) {
    // Unresolvable row (deleted env cascade swept the lineage with it) — the
    // known fork id stays so downstream consumers can still flag provenance.
    return { forkId: fallbackId ?? '(unresolved)', envId: '', forkedAt: '', window, policy: {} };
  }
  const base = parseForkBase(row);
  return {
    forkId: row.id,
    envId: row.env_id,
    forkedAt: row.created_at,
    window,
    policy: base.policy ?? {},
    ...(base.checkpointId !== undefined ? { checkpointId: base.checkpointId } : {}),
    ...(base.scenarioFingerprint !== undefined
      ? { scenarioFingerprint: base.scenarioFingerprint }
      : {}),
  };
}

/** sha256 of a scenario's canonical JSON — the fork-moment fingerprint (§10.4). */
export function scenarioFingerprintOf(scenario: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(scenario)).digest('hex')}`;
}

/** Structural plain-object guard (shared with the fork-base parser). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
