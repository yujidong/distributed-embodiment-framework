/**
 * Eval-run store — batch evaluation jobs (Wave-3a)
 *
 * One row per submitted batch: the validated spec at creation, the
 * aggregated result when the run finishes. Status moves
 * pending → running → done | failed; a server restart mid-batch leaves
 * rows stuck in pending/running, which `failInterrupted()` sweeps to
 * 'failed' at boot (the in-process executor died with the old process).
 */

import { randomUUID } from 'node:crypto';

import type { EafDatabase } from './database.js';

export type EvalRunStatus = 'pending' | 'running' | 'done' | 'failed';

export interface EvalRunRow {
  id: string;
  env_id: string;
  created_by: string;
  status: EvalRunStatus;
  spec_json: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export class EvalRunStore {
  constructor(private readonly db: EafDatabase) {}

  create(input: { envId: string; createdBy: string; spec: unknown }): EvalRunRow {
    const id = `evalrun-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO eval_runs (id, env_id, created_by, status, spec_json, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, input.envId, input.createdBy, JSON.stringify(input.spec), new Date().toISOString());
    return this.getOrThrow(id);
  }

  get(id: string): EvalRunRow | undefined {
    return this.db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(id) as
      | EvalRunRow
      | undefined;
  }

  getOrThrow(id: string): EvalRunRow {
    const row = this.get(id);
    if (!row) throw new Error(`EvalRunStore: row "${id}" disappeared`);
    return row;
  }

  /**
   * T-016: list a environment's runs, NEWEST first. Tiebreak on rowid so two
   * rows sharing an ISO millisecond keep insertion order (newest last insert
   * first) — the list panel shows "what did I run lately" without a cursor.
   */
  listForEnv(envId: string): EvalRunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM eval_runs WHERE env_id = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(envId) as EvalRunRow[];
  }

  markRunning(id: string): void {
    this.db
      .prepare(`UPDATE eval_runs SET status = 'running', started_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  markDone(id: string, result: unknown): void {
    this.db
      .prepare(
        `UPDATE eval_runs SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(result), new Date().toISOString(), id);
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE eval_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
      )
      .run(error, new Date().toISOString(), id);
  }

  /**
   * Boot recovery: rows left pending/running by a dead process can never
   * finish (the executor is in-memory) — fail them honestly. Returns the
   * number of rows swept.
   */
  failInterrupted(): number {
    const result = this.db
      .prepare(
        `UPDATE eval_runs SET status = 'failed',
           error = 'server restarted while the batch was pending/running',
           finished_at = ?
         WHERE status IN ('pending', 'running')`,
      )
      .run(new Date().toISOString());
    return result.changes;
  }
}
