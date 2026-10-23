/**
 * Migration backfill helpers (R21-W5 file-budget extraction from
 * database.ts, verbatim move) — the data-corrective bodies migrations call
 * (v18/v28/v46), exported for tests. Re-exported from database.ts so
 * existing import sites keep working.
 */

import { serviceInterfaceForCapabilities } from '@active-collaboration/simulation';

import { EnvironmentStore } from './environment-store.js';
import { ServiceStore } from './service-store.js';
import type { EafDatabase } from './database.js';

/**
 * NF2701 (DevLoop R27, from T-601) — migration v46's body. The HONEST
 * ASSESSMENT, in full:
 *
 * 1. THE LIVE PATH IS ALREADY CORRECT. Post-T-601 the four-link chain
 *    treats SQL NULL exactly as "never authored": environment-bridge omits
 *    the llm key, and core's resolveAgentLlmClient falls through to the
 *    shared client (pinned: agent-llm-null.vitest.test.ts link 2 +
 *    EngineRuntime.llm-null suite). An explicit JSON 'null' string is the
 *    opt-out. Nothing about v46 changes runtime behavior.
 *
 * 2. THE LEGACY DAMAGE CANNOT BE FULLY REVERSED. Pre-T-601, createAgent /
 *    updateAgent collapsed an author's explicit `llm: null` to SQL NULL
 *    (`input.llm != null ? ... : null`) — destroying the distinction the
 *    fix later made first-class. In agent_instances alone, "author wrote
 *    null" and "author never specified" are byte-identical. No snapshot of
 *    llmEnabled lives in a table a migration may read, so "llmEnabled:false
 *    was never observed" cannot be checked from the database either.
 *
 * 3. WHAT IS RECOVERABLE: the PROPOSAL pipeline preserves the author's
 *    exact payload (proposals.payload_json). Positive evidence of null
 *    intent exists where an APPLIED proposal carried it:
 *      - modify-object with payload.patch.llm === null (targetId names the
 *        agent — the R27-verified re-assertion path, which post-T-601
 *        already persists 'null'; this recovers the pre-fix applies);
 *      - install-agents whose payload.agents[] entries declare llm === null
 *        (the created agent ids resolve through the apply's command_log
 *        after-payload, kind = 'install-agents', proposal_id set).
 *
 * 4. WHAT IS DELIBERATELY LEFT AS-IS: every SQL NULL row without proposal
 *    evidence. Bulk-flipping them to 'null' would force rule-only on agents
 *    whose authors simply never authored an llm block — a behavior change
 *    masquerading as data normalization (and the wrong direction: the
 *    shared fall-through is the platform default). Owners who DID intend
 *    null on an evidence-less row can still re-assert it — modify-object
 *    llm:null works and persists explicitly (R27 acceptance, T-601).
 *
 * Idempotent (a re-run finds nothing left to flip); returns per-source
 * counts for the migration audit trail.
 */
export interface AgentLlmNullRecoveryStats {
  /** Rows flipped via applied modify-object patch.llm === null evidence. */
  modifyObject: number;
  /** Rows flipped via applied install-agents agents[].llm === null evidence. */
  installAgents: number;
}

export function normalizeAgentLlmNullIntent(db: EafDatabase): AgentLlmNullRecoveryStats {
  const flip = db.prepare(
    "UPDATE agent_instances SET llm_json = 'null' WHERE id = ? AND llm_json IS NULL",
  );
  const stats: AgentLlmNullRecoveryStats = { modifyObject: 0, installAgents: 0 };
  const proposals = db
    .prepare(
      `SELECT id, kind, payload_json FROM proposals WHERE status = 'applied' AND kind IN ('modify-object', 'install-agents')`,
    )
    .all() as Array<{ id: string; kind: string; payload_json: string }>;
  const applyLog = db.prepare(
    'SELECT payload_json FROM command_log WHERE proposal_id = ? AND kind = ? LIMIT 1',
  );

  for (const proposal of proposals) {
    let payload: unknown;
    try {
      payload = JSON.parse(proposal.payload_json);
    } catch {
      continue; // corrupt payload — leave every row untouched (never guess)
    }
    if (payload === null || typeof payload !== 'object') continue;

    if (proposal.kind === 'modify-object') {
      const { targetId, patch } = payload as { targetId?: unknown; patch?: { llm?: unknown } };
      if (typeof targetId !== 'string' || patch === null || typeof patch !== 'object') continue;
      if (patch.llm !== null) continue; // only explicit null intent
      if (flip.run(targetId).changes > 0) stats.modifyObject += 1;
      continue;
    }

    // install-agents: payload.agents[] authored llm === null; the CREATED
    // agent ids live only in the apply's command_log after-payload. The two
    // arrays are INDEX-PARALLEL (installAgents creates in payload order) —
    // only the entries whose AUTHORED payload declared llm === null flip.
    const agents = (payload as { agents?: unknown }).agents;
    if (!Array.isArray(agents) || agents.length === 0) continue;
    const nullIntent = agents.map(
      a => a !== null && typeof a === 'object' && (a as { llm?: unknown }).llm === null,
    );
    if (!nullIntent.some(Boolean)) continue;
    const logRow = applyLog.get(proposal.id, 'install-agents') as { payload_json?: string } | undefined;
    if (logRow === undefined) continue;
    let after: unknown;
    try {
      after = (JSON.parse(logRow.payload_json ?? '{}') as { after?: unknown }).after;
    } catch {
      continue;
    }
    const created = (after as { agents?: unknown } | null | undefined)?.agents;
    if (!Array.isArray(created)) continue;
    for (let i = 0; i < created.length && i < nullIntent.length; i++) {
      if (!nullIntent[i]) continue;
      const id = (created[i] as { id?: unknown } | null)?.id;
      if (typeof id !== 'string') continue;
      if (flip.run(id).changes > 0) stats.installAgents += 1;
    }
  }
  return stats;
}

/**
 * Fix-20 (Fix-15 leftover): recompute the interface of derived services whose
 * stored interface is empty ('{}') from their backing device's capabilities —
 * the same `serviceInterfaceForCapabilities` derivation Fix-15 applies to new
 * rows. Exported for tests; migration v18 is its only caller. Returns the
 * number of rows updated.
 */
export function backfillDerivedServiceInterfaces(db: EafDatabase): number {  const legacy = db
    .prepare(
      `SELECT id, source_device_id FROM service_instances
       WHERE origin = 'derived' AND interface_json = '{}'`,
    )
    .all() as Array<{ id: string; source_device_id: string | null }>;
  const deviceStmt = db.prepare(
    'SELECT capabilities_json FROM device_instances WHERE id = ?',
  );
  const update = db.prepare('UPDATE service_instances SET interface_json = ? WHERE id = ?');
  let updated = 0;
  for (const row of legacy) {
    if (row.source_device_id === null) continue;
    const device = deviceStmt.get(row.source_device_id) as
      | { capabilities_json: string }
      | undefined;
    if (!device) continue;
    let capabilities: string[];
    try {
      const parsed = JSON.parse(device.capabilities_json) as unknown;
      if (!Array.isArray(parsed)) continue;
      capabilities = parsed as string[];
    } catch {
      continue;
    }
    update.run(JSON.stringify(serviceInterfaceForCapabilities(capabilities)), row.id);
    updated += 1;
  }
  return updated;
}

/** What the v28 derived-service resync backfill did (returned for tests). */
export interface DerivedServiceBackfillStats {
  /** Dead-end derived rows pruned (deviceExecutesCapability now false). */
  pruned: number;
  /** Wrongly-suppressed capabilities whose services were (re-)created. */
  created: number;
  /** Surviving rows whose name/interface was refreshed. */
  updated: number;
  /** Derived rows flipped from the legacy 'public' default to 'members'. */
  visibilityFlipped: number;
}

/**
 * T-047 (T-207 audit corrective): re-run the CURRENT derivation logic
 * (`ServiceStore.syncDerivedForAgent` — one truth, no duplicated reconcile)
 * over every existing agent, then apply the T-208 members-default to
 * derived rows still carrying the legacy 'public' default. Surviving
 * services keep their ids (the sync matches by source device × semantic
 * type and updates in place — restore-by-id semantics like T-209's
 * restoreService), so subscriptions and references never break. Published
 * offers are untouched by both passes. Exported for tests; migration v28
 * is its only caller.
 */
export function backfillDerivedServices(db: EafDatabase): DerivedServiceBackfillStats {
  const envStore = new EnvironmentStore(db);
  const serviceStore = new ServiceStore(db, envStore);
  const stats: DerivedServiceBackfillStats = {
    pruned: 0,
    created: 0,
    updated: 0,
    visibilityFlipped: 0,
  };
  const agents = db.prepare('SELECT id FROM agent_instances').all() as Array<{ id: string }>;
  for (const agent of agents) {
    for (const change of serviceStore.syncDerivedForAgent(agent.id)) {
      if (change.action === 'deleted') stats.pruned += 1;
      else if (change.action === 'created') stats.created += 1;
      else stats.updated += 1;
    }
  }
  // T-208 leftover: derived rows created before the members-default change
  // (and never re-touched) still expose telemetry cross-owner. Flip derived
  // rows only — published offers keep their explicit body-supplied value.
  // A provider who DELIBERATELY set a derived service public before this
  // migration must re-PATCH it (documented in the R11-corrective notes).
  stats.visibilityFlipped = db
    .prepare(
      "UPDATE service_instances SET visibility = 'members' WHERE origin = 'derived' AND visibility = 'public'",
    )
    .run().changes;
  return stats;
}
