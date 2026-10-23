/**
 * Schema migrations v1–v20 (R22 file-budget extraction from database.ts —
 * verbatim move, registry stays in database.ts). Foundation segment:
 * users/environments/instances, device catalog, service layer, proposals,
 * agreements/usage, notifications, eval, first backfill (v18).
 */

import {
  backfillDerivedServiceInterfaces,
} from '../migration-backfills.js';
import type { Migration } from './types.js';

export const MIGRATIONS_V1_V20: Migration[] = [
  /**
   * Schema v1 — multi-user shared worlds (P2a, product_design.md §11.1).
   *
   * Ownership is first-class: every device/agent instance carries `owner_id`
   * (its creator), environments carry an owner plus a member roster with
   * roles. Cascades keep world cleanup in the database: deleting an
   * environment removes its members and instances.
   */
  {
    version: 1,
    name: 'users-environments-instances',
    up: db => {
      db.exec(`
        CREATE TABLE users (
          id            TEXT PRIMARY KEY,
          email         TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          display_name  TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );

        CREATE TABLE environments (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          description   TEXT NOT NULL DEFAULT '',
          map_type      TEXT NOT NULL DEFAULT 'grid',
          map_data_json TEXT NOT NULL DEFAULT '{"zones":[]}',
          owner_id      TEXT NOT NULL REFERENCES users(id),
          visibility    TEXT NOT NULL DEFAULT 'private'
                        CHECK (visibility IN ('public', 'private')),
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );

        CREATE TABLE env_members (
          env_id  TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id),
          role    TEXT NOT NULL CHECK (role IN ('owner', 'builder', 'viewer')),
          UNIQUE (env_id, user_id)
        );

        CREATE TABLE device_instances (
          id                 TEXT PRIMARY KEY,
          env_id             TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          owner_id           TEXT NOT NULL REFERENCES users(id),
          name               TEXT NOT NULL,
          type               TEXT NOT NULL,
          brand              TEXT,
          capabilities_json  TEXT NOT NULL DEFAULT '[]',
          zone_id            TEXT NOT NULL,
          position_json      TEXT,
          initial_state_json TEXT,
          created_at         TEXT NOT NULL
        );

        CREATE TABLE agent_instances (
          id                     TEXT PRIMARY KEY,
          env_id                 TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          owner_id               TEXT NOT NULL REFERENCES users(id),
          name                   TEXT NOT NULL,
          capabilities_json      TEXT NOT NULL DEFAULT '[]',
          bound_device_ids_json  TEXT NOT NULL DEFAULT '[]',
          managed_zone_ids_json  TEXT NOT NULL DEFAULT '[]',
          llm_json               TEXT,
          created_at             TEXT NOT NULL
        );

        CREATE INDEX idx_env_members_user ON env_members(user_id);
        CREATE INDEX idx_device_instances_env ON device_instances(env_id);
        CREATE INDEX idx_agent_instances_env ON agent_instances(env_id);
      `);
    },
  },
  {
    version: 2,
    name: 'device-models-catalog',
    up: db => {
      // Real-hardware device catalog (product_design.md §11.3). `physics_json`
      // carries simulation-relevant parameters (hvac power, sensor noise…);
      // `specs_json` is free-form real-world data (protocol, power supply…).
      // `status` exists for the future community-approval flow: seed rows are
      // 'active', community submissions land as 'pending'.
      db.exec(`
        CREATE TABLE device_models (
          id                TEXT PRIMARY KEY,
          vendor            TEXT NOT NULL,
          model             TEXT NOT NULL,
          name              TEXT NOT NULL,
          device_type       TEXT NOT NULL,
          capabilities_json TEXT NOT NULL DEFAULT '[]',
          physics_json      TEXT NOT NULL DEFAULT '{}',
          specs_json        TEXT NOT NULL DEFAULT '{}',
          purchase_url      TEXT,
          price_cny         REAL,
          source            TEXT NOT NULL DEFAULT 'community'
                            CHECK (source IN ('seed', 'community')),
          status            TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('active', 'pending', 'rejected')),
          created_by        TEXT REFERENCES users(id),
          created_at        TEXT NOT NULL
        );

        CREATE INDEX idx_device_models_type ON device_models(device_type);
        CREATE INDEX idx_device_models_vendor ON device_models(vendor);
      `);
    },
  },
  {
    version: 3,
    name: 'device-models-tier',
    up: db => {
      // Deployment tier (product_design.md §11.4): the original consumer
      // catalog (smart-home hardware) is joined by municipal/industrial
      // smart-city gear (air-quality stations, traffic detectors, smart
      // poles…). Existing rows default to 'consumer'.
      db.exec(`
        ALTER TABLE device_models
          ADD COLUMN tier TEXT NOT NULL DEFAULT 'consumer'
          CHECK (tier IN ('consumer', 'industrial', 'municipal'));

        CREATE INDEX idx_device_models_tier ON device_models(tier);
      `);
    },
  },
  {
    version: 4,
    name: 'service-instances',
    up: db => {
      // The service layer (W3): services are the public, cross-owner
      // visibility boundary — other users discover what an agent OFFERS, not
      // necessarily what it HAS. `origin='derived'` rows are managed by the
      // derivation engine (one per bound device × capability, kept in sync
      // with bindings); `origin='published'` rows are explicit offers.
      // `source_device_id` survives device deletion as NULL (SET NULL), the
      // derivation sync is what actually removes derived rows on unbind.
      db.exec(`
        CREATE TABLE service_instances (
          id                TEXT PRIMARY KEY,
          env_id            TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          provider_agent_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
          name              TEXT NOT NULL,
          semantic_type     TEXT NOT NULL,
          description       TEXT NOT NULL DEFAULT '',
          interface_json    TEXT NOT NULL DEFAULT '{}',
          origin            TEXT NOT NULL
                            CHECK (origin IN ('derived', 'published')),
          source_device_id  TEXT REFERENCES device_instances(id) ON DELETE SET NULL,
          visibility        TEXT NOT NULL DEFAULT 'public'
                            CHECK (visibility IN ('public', 'members', 'hidden')),
          created_at        TEXT NOT NULL
        );

        CREATE INDEX idx_service_instances_env ON service_instances(env_id);
        CREATE INDEX idx_service_instances_semantic_type ON service_instances(semantic_type);
      `);
    },
  },
  {
    version: 5,
    name: 'service-subscriptions',
    up: db => {
      // The user perspective (W5): "我依赖的服务" bookmarks. A subscription
      // is a user's declared dependency on a service offer — it feeds the
      // workbench overview, the marketplace stars, and the deployment
      // manifest's servicesConsumed section. `env_id` denormalizes the
      // service's environment so per-env projections stay a one-column
      // filter; all three FKs cascade with their targets.
      db.exec(`
        CREATE TABLE service_subscriptions (
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          service_id TEXT NOT NULL REFERENCES service_instances(id) ON DELETE CASCADE,
          env_id     TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          UNIQUE (user_id, service_id)
        );

        CREATE INDEX idx_service_subscriptions_user ON service_subscriptions(user_id);
        CREATE INDEX idx_service_subscriptions_env ON service_subscriptions(env_id);
      `);
    },
  },
  {
    version: 6,
    name: 'hass-safety-gates',
    up: db => {
      // Real-actuation safety (P3b):
      // - device_instances.binding: the deployment target URI ('sim://…'
      //   default when NULL, 'hass://<entity-id>' for a real HA entity).
      //   Consumed by the environment bridge at sim-create time.
      // - hass_policies: per-entity-pattern actuation policy. env_id NULL =
      //   global (server-wide); otherwise scoped to one environment.
      // - hass_pending: commands parked by 'confirm' policies awaiting an
      //   approve/reject decision (device_id denormalized for re-dispatch).
      // - hass_estop: singleton emergency-stop flag (id pinned to 1).
      // - hass_audit: append-only log of EVERY actuation attempt + outcome.
      db.exec(`
        ALTER TABLE device_instances ADD COLUMN binding TEXT;

        CREATE TABLE hass_policies (
          id             TEXT PRIMARY KEY,
          env_id         TEXT REFERENCES environments(id) ON DELETE CASCADE,
          entity_pattern TEXT NOT NULL,
          effect         TEXT NOT NULL CHECK (effect IN ('allow', 'confirm', 'deny')),
          created_by     TEXT,
          created_at     TEXT NOT NULL
        );

        CREATE INDEX idx_hass_policies_env ON hass_policies(env_id);

        CREATE TABLE hass_pending (
          id           TEXT PRIMARY KEY,
          sim_id       TEXT NOT NULL,
          device_id    TEXT NOT NULL,
          entity_id    TEXT NOT NULL,
          command_name TEXT NOT NULL,
          params_json  TEXT NOT NULL DEFAULT '{}',
          requested_by TEXT,
          requested_at TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected', 'expired'))
        );

        CREATE INDEX idx_hass_pending_status ON hass_pending(status);

        CREATE TABLE hass_estop (
          id      INTEGER PRIMARY KEY CHECK (id = 1),
          active  INTEGER NOT NULL DEFAULT 0,
          by_user TEXT,
          at      TEXT
        );

        INSERT INTO hass_estop (id, active) VALUES (1, 0);

        CREATE TABLE hass_audit (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          sim_id    TEXT,
          entity_id TEXT NOT NULL,
          command   TEXT NOT NULL,
          decision  TEXT NOT NULL,
          reason    TEXT NOT NULL DEFAULT '',
          user_id   TEXT,
          at        TEXT NOT NULL
        );

        CREATE INDEX idx_hass_audit_entity ON hass_audit(entity_id);
        CREATE INDEX idx_hass_audit_sim ON hass_audit(sim_id);
      `);
    },
  },
  {
    version: 7,
    name: 'agent-reputation',
    up: db => {
      // Service/agent reputation learned from collaboration history (P4-1):
      // one row per (env, agent, capability = service semantic type),
      // persisted from the engine's ReputationTracker when an
      // environment-backed simulation runs. `successes`/`failures` are REAL
      // because partial outcomes count 0.5; `last_at` is the engine's sim
      // clock (ms epoch) of the last update and drives recency decay.
      db.exec(`
        CREATE TABLE agent_reputation (
          env_id     TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          agent_id   TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
          capability TEXT NOT NULL,
          attempts   REAL NOT NULL DEFAULT 0,
          successes  REAL NOT NULL DEFAULT 0,
          failures   REAL NOT NULL DEFAULT 0,
          last_at    INTEGER NOT NULL DEFAULT 0,
          UNIQUE (env_id, agent_id, capability)
        );

        CREATE INDEX idx_agent_reputation_env ON agent_reputation(env_id);
        CREATE INDEX idx_agent_reputation_agent ON agent_reputation(agent_id);
      `);
    },
  },
  {
    version: 8,
    name: 'user-token-version',
    up: db => {
      // Session invalidation for stateless JWTs (P4-4): tokens embed the
      // issuer's `token_version` (`tv` claim); auth rejects a token whose tv
      // no longer matches the row. POST /api/auth/logout-all increments it,
      // invalidating every token issued so far. Existing users default to 0,
      // which invalidates pre-v8 tokens (they carry no tv claim) on deploy.
      db.exec(`
        ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 9,
    name: 'proposals-command-log',
    up: db => {
      // Governance kernel (P-A, multi-user-simulation-design.md §4 + §9):
      // - proposals: every shared-world change is a Proposal moving through
      //   the submitted → rule_check → ai_review → approved/escalated →
      //   applied → reverted state machine. `rule_check_json`/`ai_review_json`
      //   hold the deterministic check result and the (AI or human) review
      //   verdict; `reviewer_id` is the owner who decided an escalation.
      // - command_log: append-only audit of every APPLIED change (plus its
      //   revert), payload carrying {before, after} so a revert is the apply
      //   entry's inverse operation. proposal_id survives proposal deletion
      //   (SET NULL) — the audit outlives the ticket.
      // Both tables cascade with their environment.
      db.exec(`
        CREATE TABLE proposals (
          id              TEXT PRIMARY KEY,
          env_id          TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          author_id       TEXT NOT NULL REFERENCES users(id),
          kind            TEXT NOT NULL
                          CHECK (kind IN ('install-devices', 'inject-scenario', 'modify-object', 'zone-claim')),
          payload_json    TEXT NOT NULL DEFAULT '{}',
          risk_level      TEXT NOT NULL DEFAULT 'low'
                          CHECK (risk_level IN ('low', 'medium', 'high')),
          status          TEXT NOT NULL DEFAULT 'submitted'
                          CHECK (status IN ('submitted', 'rule_check', 'ai_review', 'approved',
                                            'rejected', 'escalated', 'applied', 'reverted')),
          rule_check_json TEXT,
          ai_review_json  TEXT,
          reviewer_id     TEXT REFERENCES users(id),
          created_at      TEXT NOT NULL,
          decided_at      TEXT,
          applied_at      TEXT,
          expires_at      TEXT
        );

        CREATE INDEX idx_proposals_env ON proposals(env_id);
        CREATE INDEX idx_proposals_author ON proposals(author_id);

        CREATE TABLE command_log (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          env_id       TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          actor_id     TEXT NOT NULL REFERENCES users(id),
          proposal_id  TEXT REFERENCES proposals(id) ON DELETE SET NULL,
          kind         TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          sim_time     REAL,
          wall_time    TEXT NOT NULL
        );

        CREATE INDEX idx_command_log_env ON command_log(env_id);
        CREATE INDEX idx_command_log_proposal ON command_log(proposal_id);
      `);
    },
  },
  {
    version: 10,
    name: 'zone-claims',
    up: db => {
      // Zone-level autonomy (P-B, multi-user-simulation-design.md §5.3): a
      // zone-claim proposal, once approved by the environment owner, grants
      // the author stewardship of one zone — their low-risk proposals fully
      // inside that zone skip AI review. One row per (env, zone, grantee);
      // several grantees may steward the same zone (a group). Rows cascade
      // with their environment.
      db.exec(`
        CREATE TABLE zone_claims (
          env_id     TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          zone_id    TEXT NOT NULL,
          grantee_id TEXT NOT NULL REFERENCES users(id),
          granted_by TEXT NOT NULL REFERENCES users(id),
          granted_at TEXT NOT NULL,
          UNIQUE (env_id, zone_id, grantee_id)
        );

        CREATE INDEX idx_zone_claims_env ON zone_claims(env_id);
        CREATE INDEX idx_zone_claims_grantee ON zone_claims(grantee_id);
      `);
    },
  },
  {
    version: 11,
    name: 'sandboxes',
    up: db => {
      // Sandbox forks (P-C, multi-user-simulation-design.md §3 Layer 0 +
      // §11): each row is one isolated in-memory world forked from an
      // environment's base layer (+ selected applied inject-scenario
      // overlays). `fork_base_json` records the fork parameters (overlays[]);
      // `simulation_id` points at the registry's EngineRuntime instance.
      // Rows cascade with their environment (the runtime is stopped first,
      // see onEnvironmentDeleted in server.ts).
      db.exec(`
        CREATE TABLE sandboxes (
          id             TEXT PRIMARY KEY,
          env_id         TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          owner_id       TEXT NOT NULL REFERENCES users(id),
          fork_base_json TEXT NOT NULL DEFAULT '{}',
          status         TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'stopped')),
          simulation_id  TEXT,
          created_at     TEXT NOT NULL
        );

        CREATE INDEX idx_sandboxes_env ON sandboxes(env_id);
        CREATE INDEX idx_sandboxes_owner ON sandboxes(owner_id);
      `);
    },
  },
  {
    version: 12,
    name: 'twin-sync',
    up: db => {
      // Twin sync (P-D, multi-user-simulation-design.md §6 + §11): real-world
      // perception data flows into the base layer automatically.
      // - observations: append-only time series of every synced/pushed
      //   observation (envId, entityId, key, value, simTime?, wallTime) — the
      //   replay material for P-E. `value_json` holds any JSON scalar
      //   (number/boolean/string); sim_time is NULL for wall-clock sources.
      // - sync_bindings: owner-declared bindings of one device instance's
      //   sensory attribute to a data source ('manual' push or
      //   'hass:<entity_id>' subscription). min_interval_sec throttles state
      //   application + broadcast (observations are never throttled); status
      //   'unavailable' marks hass: bindings whose HA side is unreachable —
      //   the binding persists, the sync just stays off.
      // Both tables cascade with their environment; bindings also cascade
      // with their device instance.
      db.exec(`
        CREATE TABLE observations (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          env_id     TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          entity_id  TEXT NOT NULL,
          key        TEXT NOT NULL,
          value_json TEXT NOT NULL,
          sim_time   REAL,
          wall_time  TEXT NOT NULL
        );

        CREATE INDEX idx_observations_env_entity_time
          ON observations(env_id, entity_id, wall_time);

        CREATE TABLE sync_bindings (
          id                 TEXT PRIMARY KEY,
          env_id             TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          device_instance_id TEXT NOT NULL REFERENCES device_instances(id) ON DELETE CASCADE,
          attribute_key      TEXT NOT NULL,
          source             TEXT NOT NULL,
          min_interval_sec   REAL NOT NULL DEFAULT 60,
          status             TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'unavailable')),
          created_by         TEXT NOT NULL REFERENCES users(id),
          created_at         TEXT NOT NULL,
          UNIQUE (env_id, device_instance_id, attribute_key)
        );

        CREATE INDEX idx_sync_bindings_env ON sync_bindings(env_id);
      `);
    },
  },
  {
    version: 13,
    name: 'proposal-kinds-install-agents-remove-devices',
    up: db => {
      // Fix-7: new proposal kinds `install-agents` / `remove-devices` so
      // builders can install agents (the derived-service layer) and remove
      // their own mis-installed devices through the governance pipeline.
      // SQLite cannot ALTER a CHECK constraint, so the proposals table is
      // rebuilt following the 12-step procedure: create under a temp name →
      // copy → drop the original → rename. This relies on migrations running
      // with foreign_keys OFF (see openDatabase): the DROP would otherwise
      // fire command_log's ON DELETE SET NULL, and the rename of the
      // original would rewrite command_log's FK text to the old name.
      db.exec(`
        CREATE TABLE proposals_new (
          id              TEXT PRIMARY KEY,
          env_id          TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          author_id       TEXT NOT NULL REFERENCES users(id),
          kind            TEXT NOT NULL
                          CHECK (kind IN ('install-devices', 'install-agents', 'remove-devices',
                                          'inject-scenario', 'modify-object', 'zone-claim')),
          payload_json    TEXT NOT NULL DEFAULT '{}',
          risk_level      TEXT NOT NULL DEFAULT 'low'
                          CHECK (risk_level IN ('low', 'medium', 'high')),
          status          TEXT NOT NULL DEFAULT 'submitted'
                          CHECK (status IN ('submitted', 'rule_check', 'ai_review', 'approved',
                                            'rejected', 'escalated', 'applied', 'reverted')),
          rule_check_json TEXT,
          ai_review_json  TEXT,
          reviewer_id     TEXT REFERENCES users(id),
          created_at      TEXT NOT NULL,
          decided_at      TEXT,
          applied_at      TEXT,
          expires_at      TEXT
        );

        INSERT INTO proposals_new
          (id, env_id, author_id, kind, payload_json, risk_level, status,
           rule_check_json, ai_review_json, reviewer_id,
           created_at, decided_at, applied_at, expires_at)
        SELECT id, env_id, author_id, kind, payload_json, risk_level, status,
               rule_check_json, ai_review_json, reviewer_id,
               created_at, decided_at, applied_at, expires_at
        FROM proposals;

        DROP TABLE proposals;
        ALTER TABLE proposals_new RENAME TO proposals;

        CREATE INDEX idx_proposals_env ON proposals(env_id);
        CREATE INDEX idx_proposals_author ON proposals(author_id);
      `);
    },
  },
  {
    version: 14,
    name: 'service-agreements-usage-settlement',
    up: db => {
      // Service consumption chain (Fix-11, service-consumption-design.md §3,
      // Phase 1 §6):
      // - service_agreements: the bilateral contract between a consumer
      //   (user, optionally naming one of their agents) and a service offer.
      //   Lifecycle: proposed → active | rejected; active → suspended |
      //   terminated; suspended → terminated (the design's `accepted` is
      //   transient — a provider accept lands directly in `active`, §3.1).
      //   `terms_json` holds the all-optional metering/settlement terms
      //   (unit-neutral; the core never interprets price fields).
      // - usage_records: APPEND-ONLY metering evidence — one row per
      //   consumption act (Phase 1: kind='invoke', quantity=1, unit='action').
      //   `effect_ref` points at the command_log entry of the executed
      //   device command when one exists. The store exposes no update/delete
      //   for this table.
      // - settlement_receipts: SettlementProvider output (§3.4). The default
      //   NullSettlementProvider archives one receipt per settled batch with
      //   status 'recorded' — no amounts, no fund movement.
      // Agreements and usage rows cascade with their environment and service;
      // consumer_agent_id survives agent deletion as NULL (the contract is
      // between owners; the agent is an optional execution hint).
      db.exec(`
        CREATE TABLE service_agreements (
          id                 TEXT PRIMARY KEY,
          env_id             TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          service_id         TEXT NOT NULL REFERENCES service_instances(id) ON DELETE CASCADE,
          consumer_agent_id  TEXT REFERENCES agent_instances(id) ON DELETE SET NULL,
          consumer_owner_id  TEXT NOT NULL REFERENCES users(id),
          provider_agent_id  TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
          provider_owner_id  TEXT NOT NULL REFERENCES users(id),
          terms_json         TEXT NOT NULL DEFAULT '{}',
          status             TEXT NOT NULL DEFAULT 'proposed'
                             CHECK (status IN ('proposed', 'active', 'rejected',
                                               'suspended', 'terminated')),
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL
        );

        CREATE INDEX idx_service_agreements_env ON service_agreements(env_id);
        CREATE INDEX idx_service_agreements_service ON service_agreements(service_id);
        CREATE INDEX idx_service_agreements_consumer ON service_agreements(consumer_owner_id);
        CREATE INDEX idx_service_agreements_provider ON service_agreements(provider_owner_id);

        CREATE TABLE usage_records (
          id                TEXT PRIMARY KEY,
          agreement_id      TEXT NOT NULL REFERENCES service_agreements(id) ON DELETE CASCADE,
          env_id            TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          consumer_agent_id TEXT,
          provider_agent_id TEXT,
          kind              TEXT NOT NULL CHECK (kind IN ('invoke', 'stream', 'ac')),
          action            TEXT,
          quantity          REAL NOT NULL,
          unit              TEXT NOT NULL,
          outcome           TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'partial')),
          effect_ref        TEXT,
          started_at        TEXT NOT NULL,
          ended_at          TEXT NOT NULL
        );

        CREATE INDEX idx_usage_records_agreement ON usage_records(agreement_id);
        CREATE INDEX idx_usage_records_env ON usage_records(env_id);

        CREATE TABLE settlement_receipts (
          id                    TEXT PRIMARY KEY,
          agreement_id          TEXT NOT NULL REFERENCES service_agreements(id) ON DELETE CASCADE,
          env_id                TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          provider              TEXT NOT NULL,
          status                TEXT NOT NULL CHECK (status IN ('recorded')),
          usage_record_ids_json TEXT NOT NULL DEFAULT '[]',
          quote_json            TEXT,
          created_at            TEXT NOT NULL
        );

        CREATE INDEX idx_settlement_receipts_agreement ON settlement_receipts(agreement_id);
      `);
    },
  },
  {
    version: 15,
    name: 'agreement-source-ac-ephemeral',
    up: db => {
      // Fix-11 Phase 2 (service-consumption-design.md §3.1): agreements gain
      // a `source` — 'explicit' (marketplace proposal, the default every
      // pre-v15 row keeps) or 'ac' (ephemeral agreement landed automatically
      // when an AC handshake succeeds; it terminates with the collaboration).
      // `collaboration_id` links an ephemeral agreement back to its AC so the
      // completion/cancel event can find and close it.
      db.exec(`
        ALTER TABLE service_agreements
          ADD COLUMN source TEXT NOT NULL DEFAULT 'explicit'
          CHECK (source IN ('explicit', 'ac'));
        ALTER TABLE service_agreements
          ADD COLUMN collaboration_id TEXT;
        CREATE INDEX idx_service_agreements_collaboration
          ON service_agreements(collaboration_id);
      `);
    },
  },
  {
    version: 16,
    name: 'notifications',
    up: db => {
      // Notification inbox (Fix-16, roadmap): the persistent doorbell for
      // events a user would otherwise have to poll for — proposal verdicts
      // and escalations, agreement proposals/decisions, AC handshake
      // answers. `read_at` NULL = unread; `ref_id` points at the object the
      // notification is about (proposal / agreement / collaboration id) so
      // clients can deep-link and producers can dedupe. Rows cascade with
      // their user and their environment.
      db.exec(`
        CREATE TABLE notifications (
          id         TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          env_id     TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          kind       TEXT NOT NULL,
          title      TEXT NOT NULL,
          body_json  TEXT NOT NULL DEFAULT '{}',
          ref_id     TEXT,
          read_at    TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX idx_notifications_user_read
          ON notifications(user_id, read_at);
        CREATE INDEX idx_notifications_env ON notifications(env_id);
      `);
    },
  },
  {
    version: 17,
    name: 'environment-guide',
    up: db => {
      // Latecomer onboarding (Fix-19, roadmap): the owner's structured world
      // guide — purpose / zone tour / per-role directions / service map —
      // stored as one JSON column (all fields optional text; NULL = no
      // guide). Surfaced on the environment detail to everyone who can read
      // the world, anonymous visitors of public envs included.
      db.exec(`
        ALTER TABLE environments ADD COLUMN guide_json TEXT;
      `);
    },
  },
  {
    version: 18,
    name: 'derived-service-interface-backfill',
    up: db => {
      // Fix-20 (Fix-15 leftover): derived services created BEFORE Fix-15
      // carry an empty interface ('{}') — the derivation sync only rewrites
      // the interface when the device changes, so legacy rows never caught
      // up. One-shot backfill: recompute the callable surface from the
      // backing device's capabilities (the same serviceInterfaceForCapabilities
      // the live derivation uses). Rows whose source device is gone are left
      // alone — the sync deletes them on the next trigger.
      backfillDerivedServiceInterfaces(db);
    },
  },
  {
    version: 19,
    name: 'eval-runs',
    up: db => {
      // Batch evaluation (Wave-3a, roadmap Wave 3 "AI 训练场"): one row per
      // submitted batch — N runs of the same environment + event script with
      // per-run LLM model/prompt variants. spec_json is the validated
      // submission; result_json lands when the batch finishes (per-run
      // eval-report summaries + the cross-run comparison). Rows cascade with
      // their environment; a server restart mid-batch is swept to 'failed'
      // on boot (EvalRunStore.failInterrupted).
      db.exec(`
        CREATE TABLE eval_runs (
          id          TEXT PRIMARY KEY,
          env_id      TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          created_by  TEXT NOT NULL REFERENCES users(id),
          status      TEXT NOT NULL
                      CHECK (status IN ('pending', 'running', 'done', 'failed')),
          spec_json   TEXT NOT NULL,
          result_json TEXT,
          error       TEXT,
          created_at  TEXT NOT NULL,
          started_at  TEXT,
          finished_at TEXT
        );

        CREATE INDEX idx_eval_runs_env ON eval_runs(env_id);
      `);
    },
  },
  {
    version: 20,
    name: 'user-notification-webhook',
    up: db => {
      // Outbound notification webhook (Wave-4b, roadmap Wave 4「通知通道
      // 扩展」): the user's HTTP(S) endpoint that receives every persisted
      // notification of theirs as a JSON POST (the pull-only inbox stays the
      // fallback). NULL = no webhook.
      db.exec(`
        ALTER TABLE users ADD COLUMN webhook_url TEXT;
      `);
    },
  },
];
