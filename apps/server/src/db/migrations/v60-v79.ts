/**
 * Schema migrations v60–v79 (R22 file-budget split — v41-v59 filled its
 * segment). Same discipline as the earlier segments: append-only, one
 * object per version, bodies run inside the runner's transaction with
 * foreign_keys OFF.
 */

import type { Migration } from './types.js';

export const MIGRATIONS_V60_V79: Migration[] = [
  {
    version: 60,
    name: 'agreement-provider-retire',
    up: db => {
      // R6-E-F08 (data/usertest-r6/track-e-capability.md §3): provider-agent
      // deletion must no longer PHYSICALLY DESTROY the agreement ledger —
      // the direct DELETE route and the remove-agents proposal now RETIRE
      // the rows first (active/held → suspended, pending offers → rejected,
      // ephemeral AC → terminated, all with status_reason
      // 'provider-unavailable') and UNLINK them (service_id /
      // provider_agent_id → NULL) before the agent row goes, so the FK
      // cascades have nothing to match. Terminated/rejected history (with
      // its append-only usage_records and receipts) survives.
      //
      // The FK ACTIONS stay ON DELETE CASCADE on purpose: the derivation-sync
      // lane (T-403) still relies on service-row deletion destroying the
      // agreements riding a regenerated derived row — only the nullability
      // changes, so every pre-v60 path behaves byte-identically.
      //
      // CHECK expansion ⇒ 12-step rebuild (the v33/v45 pattern; FK-text of
      // usage_records/settlement_receipts is untouched because migrations
      // run with foreign_keys OFF).
      db.exec(`
        CREATE TABLE service_agreements_new (
          id                 TEXT PRIMARY KEY,
          env_id             TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          service_id         TEXT REFERENCES service_instances(id) ON DELETE CASCADE,
          consumer_agent_id  TEXT REFERENCES agent_instances(id) ON DELETE SET NULL,
          consumer_owner_id  TEXT NOT NULL REFERENCES users(id),
          provider_agent_id  TEXT REFERENCES agent_instances(id) ON DELETE CASCADE,
          provider_owner_id  TEXT NOT NULL REFERENCES users(id),
          terms_json         TEXT NOT NULL DEFAULT '{}',
          countered_terms_json TEXT,
          status             TEXT NOT NULL DEFAULT 'proposed'
                             CHECK (status IN ('proposed', 'countered', 'active', 'held',
                                               'rejected', 'suspended', 'terminated')),
          source             TEXT NOT NULL DEFAULT 'explicit'
                             CHECK (source IN ('explicit', 'ac')),
          collaboration_id   TEXT,
          hold_expires_at    TEXT,
          activated_at       TEXT,
          status_reason      TEXT,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL
        );

        INSERT INTO service_agreements_new
          (id, env_id, service_id, consumer_agent_id, consumer_owner_id,
           provider_agent_id, provider_owner_id, terms_json, countered_terms_json,
           status, source, collaboration_id, hold_expires_at, activated_at, status_reason,
           created_at, updated_at)
        SELECT id, env_id, service_id, consumer_agent_id, consumer_owner_id,
               provider_agent_id, provider_owner_id, terms_json, countered_terms_json,
               status, source, collaboration_id, hold_expires_at, activated_at, NULL,
               created_at, updated_at
        FROM service_agreements;

        DROP TABLE service_agreements;
        ALTER TABLE service_agreements_new RENAME TO service_agreements;

        CREATE INDEX idx_service_agreements_env ON service_agreements(env_id);
        CREATE INDEX idx_service_agreements_service ON service_agreements(service_id);
        CREATE INDEX idx_service_agreements_consumer ON service_agreements(consumer_owner_id);
        CREATE INDEX idx_service_agreements_provider ON service_agreements(provider_owner_id);
        CREATE INDEX idx_service_agreements_collaboration
          ON service_agreements(collaboration_id);
      `);
    },
  },
  {
    version: 61,
    name: 'agent-experiences',
    up: db => {
      // R6-E-F15 (data/usertest-r6/track-e-capability.md §3): per-agent
      // PRIVATE experience — the learned meta-cognition subset of the
      // cognition checkpoint (decision-quality ring + private partner
      // trust) — persisted per (env, agent) so learning survives sim
      // rebuilds, complementing the platform reputation (v7). One opaque
      // versioned JSON snapshot per row (core owns the snapshot schema);
      // FK CASCADE mirrors agent_reputation — deleting the agent destroys
      // its private experience with it.
      db.exec(`
        CREATE TABLE agent_experiences (
          env_id          TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          agent_id        TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
          experience_json TEXT NOT NULL,
          updated_at      INTEGER NOT NULL DEFAULT 0,
          UNIQUE (env_id, agent_id)
        );

        CREATE INDEX idx_agent_experiences_env ON agent_experiences(env_id);
      `);
    },
  },
  {
    version: 62,
    name: 'flow-run-capability-drift',
    up: db => {
      // T1 (R2, u3-F1): flow-run capability-drift annotations — when a run's
      // node executed on a capability the assignee no longer DECLARES (the
      // execution truth is the device surface, so the node still ran), the
      // run record carries the structured annotation (nodeId / capability /
      // assigneeAgentId / declaredCapabilities). Serialized FlowCapabilityDrift
      // array; NULL = the run executed within declared authority (or predates
      // the annotation). Honest-degradation audit line, never a status change.
      db.exec(`ALTER TABLE flow_runs ADD COLUMN capability_drift_json TEXT;`);
    },
  },
  {
    version: 63,
    name: 'agreement-remind-marks',
    up: db => {
      // T9 (R2, u2-F5 / u4-F7): the remind trace ON the agreement row —
      // `agreement remind` used to leave no observable mark (a notification
      // to the decider only), so a consumer could not tell "reminded and
      // waiting" from "never reminded" and u4 read the unchanged
      // status/updatedAt as the reminder having no effect. Two additive
      // columns (no CHECK change, no table rebuild): last_reminded_at is
      // the newest reminder stamp, remind_count the running total. Reminders
      // are NOT lifecycle transitions — updated_at stays untouched; these
      // fields are the trace. Plain ALTERs, matching the v58/v60 column
      // discipline.
      db.exec(`
        ALTER TABLE service_agreements ADD COLUMN last_reminded_at TEXT;
        ALTER TABLE service_agreements ADD COLUMN remind_count INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 64,
    name: 'reputation-event-buckets',
    up: db => {
      // T71 (R8, u1-F3): the reputation ACCOUNT face must count EVENTS, not
      // WEIGHTS. successes/failures stay weight sums (success=1, partial=0.5,
      // failure=0 — the scoring quantity); the three new integer columns are
      // the per-outcome EVENT buckets the eval report and account faces
      // aggregate. NULL = legacy row written before the buckets existed —
      // readers integerize from the weight sums (exact for integer sums,
      // approximated for half-integer partials, per the core
      // `integerizeReputationEvents` helper). Plain ALTERs (v63 discipline).
      db.exec(`
        ALTER TABLE agent_reputation ADD COLUMN success_events INTEGER;
        ALTER TABLE agent_reputation ADD COLUMN partial_events INTEGER;
        ALTER TABLE agent_reputation ADD COLUMN failure_events INTEGER;
      `);
    },
  },
  {
    version: 65,
    name: 'environment-default-simulation',
    up: db => {
      // T122 (R17-u3 / R19-u4): the environment owner's DEFAULT SIMULATION
      // binding — shared multi-sim environments hit AGENT_AMBIGUOUS /
      // SIMULATION_AMBIGUOUS on every default-lane call. The owner may bind
      // one sim of the env as the default world; ask/what-if/read default
      // lanes honor it (with disclosure) ahead of the own-sim/session
      // adjudication. NULL = no binding. Honest-boundary: the binding is
      // honored ONLY while the bound sim is RUNNING — a stopped/deleted sim
      // makes the binding inert and the lanes disclose the fall-back and
      // point at `eaf env set-default-sim <env> --clear` (never a silent
      // world switch). Plain ALTER (v63 discipline).
      db.exec(`ALTER TABLE environments ADD COLUMN default_simulation_id TEXT;`);
    },
  },
  {
    version: 66,
    name: 'usage-simulation-id',
    up: db => {
      // FEAT-08 (pm-dev-backlog, energy-carbon D6): the ledger could not tell
      // WHICH simulation metered a row — an env-backed private sim and the
      // authoritative world session auto-fulfill the SAME agreement
      // concurrently (shared quota window) and their rows were
      // indistinguishable. The invoke core (manual + trigger lanes) now
      // stamps its target sim. Nullable: pre-v66 rows and the lanes without
      // a sim attribution (ac collaboration closes, reads, streams) stay
      // null. Plain ALTER (v58/v63 discipline — no rebuild).
      db.exec(`ALTER TABLE usage_records ADD COLUMN simulation_id TEXT;`);
    },
  },
  {
    version: 67,
    name: 'usage-source',
    up: db => {
      // UX-04 (pm-dev-backlog, energy-carbon D8): the invoke lane's entry
      // kind on the ledger — 'manual' (consumer POST), 'autoTrigger'
      // (terms.trigger auto-exec, incl. the metered quota-skip refusal row),
      // 'autoReset' (the T-070 un-peg). Null for pre-v67 rows and lanes the
      // vocabulary does not cover (ac/stream/read). Plain ALTER.
      db.exec(`ALTER TABLE usage_records ADD COLUMN source TEXT;`);
    },
  },
];
