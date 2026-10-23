/**
 * Agent experience store — persisted PRIVATE cognition experience (R6-E-F15)
 *
 * One row per (env, agent) carrying the agent's learned meta-cognition
 * snapshot (decision-quality ring + private partner trust) as an opaque,
 * versioned JSON document — core owns the snapshot schema
 * (`MetaCognitionCheckpoint`, formatVersion 1), this store never interprets
 * it. Environment-backed simulations load their env's rows into the
 * runtime's agents at start and upsert them back as collaboration outcomes
 * arrive (and on stop/hibernate) — the same discipline as P4-1 reputation
 * (reputation-store.ts), with two additions:
 *
 *  - PRIVACY: the snapshot is private experience — it is only ever
 *    re-injected into its OWN agent's meta-cognition (decision prompt);
 *    no API serializer reads this table (the env's shared face must never
 *    expose it).
 *  - Forks/sandboxes have no env backing, so they never write back (S2
 *    privacy contract, same as reputation).
 *
 * Persistence faults must never break a simulation — callers wrap every
 * method in try/catch (see sim-registry/seams.ts).
 */

import type { EafDatabase } from './database.js';

export interface AgentExperienceRow {
  env_id: string;
  agent_id: string;
  /** Opaque versioned JSON snapshot (core's MetaCognitionCheckpoint). */
  experience_json: string;
  /** ms epoch of the last write (wall clock — diagnostics only). */
  updated_at: number;
}

/** One agent's snapshot as accepted from the runtime (no env id — scoped per env). */
export interface AgentExperienceInput {
  agentId: string;
  experienceJson: string;
}

export class AgentExperienceStore {
  constructor(private readonly db: EafDatabase) {}

  /** All experience rows of an environment (sim-start load path). */
  rowsForEnv(envId: string): AgentExperienceRow[] {
    return this.db
      .prepare('SELECT * FROM agent_experiences WHERE env_id = ?')
      .all(envId) as AgentExperienceRow[];
  }

  /**
   * Persist the runtime's learned experience for an environment: upsert
   * every snapshot. Rows the runtime does not hold are left untouched —
   * the runtime was loaded from these very rows at sim start, so its
   * contents are a superset of what was there (plus anything learned
   * since). Same upsert-only discipline as ReputationStore.saveForEnv.
   */
  saveForEnv(envId: string, entries: AgentExperienceInput[], nowMs: number = Date.now()): void {
    const upsert = this.db.prepare(
      `INSERT INTO agent_experiences (env_id, agent_id, experience_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (env_id, agent_id)
       DO UPDATE SET experience_json = excluded.experience_json,
                     updated_at = excluded.updated_at`,
    );
    const run = this.db.transaction((rows: AgentExperienceInput[]) => {
      for (const entry of rows) {
        upsert.run(envId, entry.agentId, entry.experienceJson, Math.round(nowMs));
      }
    });
    run(entries);
  }
}
