/**
 * Schema migrations v21–v40 (R22 file-budget extraction from database.ts —
 * verbatim move, registry stays in database.ts). Expansion segment: flows,
 * blueprints, replay shares, env invites, proposal kinds, data-service
 * computations, consent semantics, derived-service honesty (v36).
 */

import {
  backfillDerivedServices,
} from '../migration-backfills.js';
import type { Migration } from './types.js';

export const MIGRATIONS_V21_V40: Migration[] = [
  {
    version: 21,
    name: 'flows-and-agent-enabled',
    up: db => {
      // User-orchestrated business flows (core flows module): a user-authored
      // "when <trigger> → run <plan>" automation scoped to one environment.
      // trigger_json / plan_json hold the core FlowTrigger / {goal, nodes}
      // wire shapes verbatim (FLOW_JSON_SCHEMA is the contract); enabled=0
      // flows are validated but never fire. Rows cascade with their
      // environment.
      // flow_runs: one row per execution (triggered or manual), pruned to the
      // most recent 50 per flow by FlowStore.recordRun; cascade with the flow.
      // agent_instances.enabled: master enable switch (core
      // ScenarioAgent.enabled) — disabled agents receive no injected events
      // and are excluded from partner selection. Existing rows default to 1.
      db.exec(`
        CREATE TABLE flows (
          id             TEXT PRIMARY KEY,
          environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          name           TEXT NOT NULL,
          description    TEXT NOT NULL DEFAULT '',
          enabled        INTEGER NOT NULL DEFAULT 1,
          trigger_json   TEXT NOT NULL,
          plan_json      TEXT NOT NULL,
          created_by     TEXT REFERENCES users(id),
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        );

        CREATE INDEX idx_flows_env ON flows(environment_id);

        CREATE TABLE flow_runs (
          id                TEXT PRIMARY KEY,
          flow_id           TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
          simulation_id     TEXT,
          trigger_kind      TEXT NOT NULL,
          status            TEXT NOT NULL
                            CHECK (status IN ('success', 'partial', 'failed')),
          summary           TEXT NOT NULL DEFAULT '',
          node_results_json TEXT NOT NULL DEFAULT '{}',
          started_at        TEXT NOT NULL,
          finished_at       TEXT NOT NULL
        );

        CREATE INDEX idx_flow_runs_flow ON flow_runs(flow_id, started_at);

        ALTER TABLE agent_instances ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
      `);
    },
  },
  {
    version: 22,
    name: 'command-log-synthetic-actors',
    up: db => {
      // Fix-44h: engine-issued device commands (agent decisions, flow node
      // invocations) must land in the audit trail. The actor_id column's FK
      // to users(id) blocked synthetic actors; rebuild the table without
      // the FK on this column. actor_id now carries either a user id OR
      // 'engine:<simId>:agent' / 'engine:<simId>:flow' — the serializer
      // renders a display name from the payload's agentName/flowName.
      db.exec(`
        CREATE TABLE command_log_v22 (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          env_id      TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          actor_id    TEXT NOT NULL,
          proposal_id TEXT,
          kind        TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          sim_time    REAL,
          wall_time   TEXT NOT NULL
        );

        INSERT INTO command_log_v22 (id, env_id, actor_id, proposal_id, kind, payload_json, sim_time, wall_time)
          SELECT id, env_id, actor_id, proposal_id, kind, payload_json, sim_time, wall_time FROM command_log;

        DROP TABLE command_log;
        ALTER TABLE command_log_v22 RENAME TO command_log;

        CREATE INDEX idx_command_log_env ON command_log(env_id, wall_time);
      `);
    },
  },
  {
    version: 23,
    name: 'blueprints',
    up: db => {
      // Fix-38: App Blueprints — student "one-click" application templates.
      // A blueprint is a packed definition (devices + agents + flows) with
      // template variables (${zoneId}, ${deviceId}) resolved at install time.
      // Built-in blueprints are seeded on boot; users can create custom ones.
      // `installed_from` on device/agent/flow rows tracks lineage for
      // whole-blueprint uninstall.
      db.exec(`
        CREATE TABLE blueprints (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          description  TEXT NOT NULL DEFAULT '',
          definition_json TEXT NOT NULL,
          is_builtin   INTEGER NOT NULL DEFAULT 0,
          created_by   TEXT REFERENCES users(id),
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        );
        CREATE INDEX idx_blueprints_builtin ON blueprints(is_builtin);
        ALTER TABLE device_instances ADD COLUMN installed_from TEXT;
        ALTER TABLE agent_instances ADD COLUMN installed_from TEXT;
        ALTER TABLE flows ADD COLUMN installed_from TEXT;
      `);
    },
  },
  {
    version: 24,
    name: 'replay-shares',
    up: db => {
      // R15-B1: shareable read-only replay links. A share is a frozen
      // scenario-JSON snapshot of an environment's observation window —
      // anonymous viewers open /share/:id without an account. Deliberately
      // NOT foreign-keyed to environments: a share stays readable after its
      // environment is deleted (the snapshot is self-contained), which is
      // what demo-day audiences expect from a link.
      db.exec(`
        CREATE TABLE replay_shares (
          id            TEXT PRIMARY KEY,
          env_id        TEXT NOT NULL,
          env_name      TEXT NOT NULL DEFAULT '',
          name          TEXT NOT NULL DEFAULT '',
          description   TEXT NOT NULL DEFAULT '',
          scenario_json TEXT NOT NULL,
          event_count   INTEGER NOT NULL DEFAULT 0,
          created_by    TEXT,
          created_at    TEXT NOT NULL,
          expires_at    TEXT NOT NULL
        );
        CREATE INDEX idx_replay_shares_env ON replay_shares(env_id, created_at);
      `);
    },
  },
  {
    version: 25,
    name: 'env-invites',
    up: db => {
      // R15-D10: pending invitations for NOT-YET-REGISTERED emails. The
      // teacher imports a class roster before students have accounts; the
      // invite is accepted automatically the moment its email registers
      // (auth route) — removing the "students must register first, then be
      // added" friction. One live invite per (env, email); re-inviting
      // updates the role.
      db.exec(`
        CREATE TABLE env_invites (
          id          TEXT PRIMARY KEY,
          env_id      TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          email       TEXT NOT NULL,
          role        TEXT NOT NULL CHECK (role IN ('builder', 'viewer')),
          invited_by  TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          accepted_at TEXT
        );
        CREATE UNIQUE INDEX idx_env_invites_env_email ON env_invites(env_id, email);
      `);
    },
  },
  {
    version: 26,
    name: 'share-revoke',
    up: db => {
      // T-108: owner revocation. A revoked share must answer 410 (not the
      // 404 of an unknown link) so anonymous viewers learn the recall was
      // deliberate — tombstone instead of hard delete.
      db.exec(`ALTER TABLE replay_shares ADD COLUMN revoked_at TEXT;`);
    },
  },
  {
    version: 27,
    name: 'proposal-kind-remove-agents',
    up: db => {
      // T-209: builders may remove agents THEY own through the governance
      // pipeline. The v13 CHECK does not list 'remove-agents', so the
      // proposals table is rebuilt once more (same 12-step procedure and
      // the same foreign_keys-OFF reliance as v13).
      db.exec(`
        CREATE TABLE proposals_new (
          id              TEXT PRIMARY KEY,
          env_id          TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          author_id       TEXT NOT NULL REFERENCES users(id),
          kind            TEXT NOT NULL
                          CHECK (kind IN ('install-devices', 'install-agents', 'remove-devices',
                                          'remove-agents', 'inject-scenario', 'modify-object', 'zone-claim')),
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
    version: 28,
    name: 'derived-service-resync-backfill',
    up: db => {
      // T-047 (T-207 audit corrective): the derivation filter changed after
      // T-207 shipped — the oracle now decides FIRST (sensor telemetry
      // derives again) and type affinity moved to catalog metadata — but
      // `syncDerivedForAgent` only runs on touch points, so agents never
      // re-derived: dead-end services stayed agreeable in the market
      // (12 confirmed in the R11 retry) and pre-T-208 derived rows kept the
      // legacy 'public' default. One-shot backfill (v18 precedent): re-run
      // the CURRENT derivation over every agent — prune dead rows, restore
      // wrongly-suppressed ones, keep surviving ids stable (subscriptions
      // and references resolve, restore-by-id semantics like T-209) — then
      // apply the members-default visibility to derived rows only.
      backfillDerivedServices(db);
    },
  },
  {
    version: 29,
    name: 'agent-decision-policy',
    up: db => {
      // T-051 (T-050 core-side exposure): per-agent decisionPolicy
      // { autoActuateIndependent?, autoInitiateAC? } joins agent_instances
      // — the scenario author's default for autonomous actuation, bridged
      // into ScenarioAgent.decisionPolicy at sim construction. Nullable:
      // absent keeps the runtime-wide defaults (back-compat).
      db.exec(`ALTER TABLE agent_instances ADD COLUMN decision_policy_json TEXT;`);
    },
  },
  {
    version: 30,
    name: 'flow-run-trigger-evaluation',
    up: db => {
      // T-061: persist the trigger's evaluation detail (per-condition path,
      // evaluatedValue, threshold, matched event) on every run row — the run
      // trace answers "what did the condition actually see" instead of only
      // a boolean verdict. Nullable: legacy rows keep reading without it.
      db.exec(`ALTER TABLE flow_runs ADD COLUMN trigger_evaluation_json TEXT;`);
    },
  },
  {
    version: 31,
    name: 'proposal-kind-install-zones',
    up: db => {
      // T-055: builders may create zones through the governance pipeline
      // (the R12 dead-lock: PATCH mapData is owner-only, no proposal kind
      // created zones, zone-claim only claims EXISTING zones). The v27
      // CHECK does not list 'install-zones', so the proposals table is
      // rebuilt once more — same 12-step procedure and the same
      // foreign_keys-OFF reliance as v13/v27.
      db.exec(`
        CREATE TABLE proposals_new (
          id              TEXT PRIMARY KEY,
          env_id          TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          author_id       TEXT NOT NULL REFERENCES users(id),
          kind            TEXT NOT NULL
                          CHECK (kind IN ('install-devices', 'install-agents', 'install-zones',
                                          'remove-devices', 'remove-agents', 'inject-scenario',
                                          'modify-object', 'zone-claim')),
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
    version: 32,
    name: 'data-service-computations',
    up: db => {
      // R14 Wave-A (design-data-services.md §9, T-057 Phase 1): unbacked
      // published services become truly consumable when the provider
      // registers a declarative computation spec. Three storage pieces:
      // - service_computations: one row per service that HAS a computation
      //   (registered by the provider agent owner / env owner). Idempotent
      //   replace at the route layer (DELETE + INSERT semantics); 'flow-report'
      //   is a RESERVED kind name (Phase 2) accepted by the CHECK so Phase 2
      //   needs no second rebuild.
      // - service_data_frames: the per-service last-computed frame cache
      //   (§7 honest degradation: no running sim → serve the cached frame,
      //   flagged cached/stale — never silent fakery). Overwritten on every
      //   successful evaluation; cascades with the service.
      // - usage_records.kind CHECK widened with 'read' (§5.1: a data read is
      //   its own metering kind, unit 'reading') — SQLite cannot ALTER a
      //   CHECK, so the append-only table is rebuilt with the standard
      //   12-step procedure (v13 precedent; rows copied verbatim, ids and
      //   references untouched — it is append-only, nothing else writes it).
      db.exec(`
        CREATE TABLE service_computations (
          service_id     TEXT PRIMARY KEY REFERENCES service_instances(id) ON DELETE CASCADE,
          kind           TEXT NOT NULL
                         CHECK (kind IN ('zone-query', 'device-aggregate', 'flow-report')),
          spec_json      TEXT NOT NULL,
          schema_version INTEGER NOT NULL DEFAULT 1,
          registered_by  TEXT NOT NULL REFERENCES users(id),
          registered_at  TEXT NOT NULL
        );

        CREATE TABLE service_data_frames (
          service_id       TEXT PRIMARY KEY REFERENCES service_instances(id) ON DELETE CASCADE,
          frame_json       TEXT NOT NULL,
          computed_at_wall TEXT NOT NULL,
          simulation_id    TEXT,
          sim_time_sec     REAL
        );
      `);

      db.exec(`
        CREATE TABLE usage_records_new (
          id                TEXT PRIMARY KEY,
          agreement_id      TEXT NOT NULL REFERENCES service_agreements(id) ON DELETE CASCADE,
          env_id            TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          consumer_agent_id TEXT,
          provider_agent_id TEXT,
          kind              TEXT NOT NULL CHECK (kind IN ('invoke', 'stream', 'ac', 'read')),
          action            TEXT,
          quantity          REAL NOT NULL,
          unit              TEXT NOT NULL,
          outcome           TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'partial')),
          effect_ref        TEXT,
          started_at        TEXT NOT NULL,
          ended_at          TEXT NOT NULL
        );

        INSERT INTO usage_records_new
          (id, agreement_id, env_id, consumer_agent_id, provider_agent_id,
           kind, action, quantity, unit, outcome, effect_ref, started_at, ended_at)
        SELECT id, agreement_id, env_id, consumer_agent_id, provider_agent_id,
               kind, action, quantity, unit, outcome, effect_ref, started_at, ended_at
        FROM usage_records;

        DROP TABLE usage_records;
        ALTER TABLE usage_records_new RENAME TO usage_records;

        CREATE INDEX idx_usage_records_agreement ON usage_records(agreement_id);
        CREATE INDEX idx_usage_records_env ON usage_records(env_id);
      `);
    },
  },
  {
    version: 33,
    name: 'consent-semantics',
    up: db => {
      // R14 Wave-B (design-consent-semantics.md §4/§5/§8) — one migration for
      // the whole consent-semantics DDL (merged numbering per §8):
      // - service_access_requests: the lightweight, notification-driven
      //   request lane (§4.2) — bilateral data transactions, NOT proposals.
      //   No SLA: a request may sit pending forever (remind channel only);
      //   withdrawal (requester) or explicit rejection (provider DELETE)
      //   closes it.
      // - service_access_grants: the provider-owned door on hidden services
      //   (§4.1) — grantee × expiry × basis, one row per (service, grantee):
      //   a repeat grant EXTENDS (expires_at overwritten, UNIQUE upsert).
      //   data_subject_json carries the declarative resident label (§4.3) —
      //   the platform does not verify real-world relationships.
      // - service_agreements: countered_terms_json + the 'countered' status
      //   (§5.1, T-059 counter-offers). SQLite cannot ALTER a CHECK, so the
      //   standard 12-step rebuild (v13/v27/v31 precedent) re-lists every
      //   status; rows copied verbatim.
      db.exec(`
        CREATE TABLE service_access_requests (
          id            TEXT PRIMARY KEY,
          service_id    TEXT NOT NULL REFERENCES service_instances(id) ON DELETE CASCADE,
          requester_id  TEXT NOT NULL REFERENCES users(id),
          purpose       TEXT NOT NULL DEFAULT '',
          duration_days INTEGER,
          status        TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'granted', 'withdrawn', 'rejected')),
          created_at    TEXT NOT NULL,
          decided_at    TEXT
        );
        CREATE INDEX idx_service_access_requests_service ON service_access_requests(service_id);

        CREATE TABLE service_access_grants (
          id               TEXT PRIMARY KEY,
          service_id       TEXT NOT NULL REFERENCES service_instances(id) ON DELETE CASCADE,
          grantee_user_id  TEXT NOT NULL REFERENCES users(id),
          granted_by       TEXT NOT NULL REFERENCES users(id),
          granted_at       TEXT NOT NULL,
          expires_at       TEXT NOT NULL,
          basis            TEXT,
          data_subject_json TEXT,
          request_id       TEXT REFERENCES service_access_requests(id) ON DELETE SET NULL,
          UNIQUE(service_id, grantee_user_id)
        );
        CREATE INDEX idx_service_access_grants_service ON service_access_grants(service_id);
        CREATE INDEX idx_service_access_grants_grantee ON service_access_grants(grantee_user_id);
      `);

      db.exec(`
        CREATE TABLE service_agreements_new (
          id                 TEXT PRIMARY KEY,
          env_id             TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          service_id         TEXT NOT NULL REFERENCES service_instances(id) ON DELETE CASCADE,
          consumer_agent_id  TEXT REFERENCES agent_instances(id) ON DELETE SET NULL,
          consumer_owner_id  TEXT NOT NULL REFERENCES users(id),
          provider_agent_id  TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
          provider_owner_id  TEXT NOT NULL REFERENCES users(id),
          terms_json         TEXT NOT NULL DEFAULT '{}',
          countered_terms_json TEXT,
          status             TEXT NOT NULL DEFAULT 'proposed'
                             CHECK (status IN ('proposed', 'countered', 'active', 'rejected',
                                               'suspended', 'terminated')),
          source             TEXT NOT NULL DEFAULT 'explicit'
                             CHECK (source IN ('explicit', 'ac')),
          collaboration_id   TEXT,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL
        );

        INSERT INTO service_agreements_new
          (id, env_id, service_id, consumer_agent_id, consumer_owner_id,
           provider_agent_id, provider_owner_id, terms_json, countered_terms_json,
           status, source, collaboration_id, created_at, updated_at)
        SELECT id, env_id, service_id, consumer_agent_id, consumer_owner_id,
               provider_agent_id, provider_owner_id, terms_json, NULL,
               status, source, collaboration_id, created_at, updated_at
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
    version: 34,
    name: 'agent-derived-visibility',
    up: db => {
      // R15 (FR15-F02): per-agent default visibility for FUTURE derived
      // services ('members' | 'hidden'; NULL = T-208's 'members' default).
      // The provider declares it at agent install so per-bed vitals-style
      // services are born HIDDEN — before this, derivation always created
      // them members-visible and the provider's hide PATCH landed minutes
      // later (a real leak window observed in the R15 live round).
      db.exec(`
        ALTER TABLE agent_instances ADD COLUMN derived_service_visibility TEXT;
      `);
    },
  },
  {
    version: 35,
    name: 'agent-device-extras-t021',
    up: db => {
      // T-021 (DevLoop R17, R10 EC-F07): template→env import silently dropped
      // agent `cannotDeliverClasses` (the medical scope-of-practice blocklist
      // PartnerSelectionNegotiator consumes) and device `role` was re-inferred
      // instead of persisted (latent today, wrong the moment inference and the
      // author's declaration diverge). Both now persist on the instance rows
      // and survive the import/bridge round-trip. NULL on both = legacy
      // behavior (no restriction / infer from capabilities at the bridge).
      db.exec(`
        ALTER TABLE agent_instances ADD COLUMN cannot_deliver_classes_json TEXT;
        ALTER TABLE device_instances ADD COLUMN role TEXT;
      `);
    },
  },
  {
    version: 36,
    name: 'derived-semantic-honesty-t043',
    up: db => {
      // T-043 (DevLoop R17): derived services used to carry the device's
      // MARKETING capability as semantic_type even when the only executable
      // path on that device was power switching ('environment'/'ventilation'
      // on a plain socket → turn-on). Re-run the CURRENT derivation (now with
      // honest labels: switching-only surfaces collapse into one 'switching'
      // row, duplicates dedupe) over every agent — v28 precedent; surviving
      // rows keep their ids where the label is unchanged.
      backfillDerivedServices(db);
    },
  },
  {
    version: 37,
    name: 'flow-inputs',
    up: db => {
      // Mechanism D (design-mixed-initiative-flows.md §5.2): flows gain an
      // input-parameter surface (`inputs`, the core FlowInputSpec array —
      // NULL = pre-D flow with no surface). flow_runs record each run's
      // EFFECTIVE params (caller values after defaults) for audit.
      db.exec(`
        ALTER TABLE flows ADD COLUMN inputs_json TEXT;
        ALTER TABLE flow_runs ADD COLUMN inputs_json TEXT;
      `);
    },
  },
  {
    version: 38,
    name: 'flow-backed-services',
    up: db => {
      // Mechanism D (design-mixed-initiative-flows.md §5.1): a third service
      // origin — 'flow' — whose backing is a PUBLISHED FLOW (source_flow_id),
      // not a device. A flow-service runs in the provider's context (T-201
      // author scoping is the security model; zero new permissions). SQLite
      // cannot widen a column CHECK in place, so service_instances is
      // rebuilt (the v33 service_agreements precedent; migrations run with
      // foreign_keys OFF, so the DROP fires no referential actions). Deleting
      // the flow cascades its services (and their agreements) exactly like
      // deleting a device removes derived rows.
      db.exec(`
        CREATE TABLE service_instances_new (
          id                TEXT PRIMARY KEY,
          env_id            TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          provider_agent_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
          name              TEXT NOT NULL,
          semantic_type     TEXT NOT NULL,
          description       TEXT NOT NULL DEFAULT '',
          interface_json    TEXT NOT NULL DEFAULT '{}',
          origin            TEXT NOT NULL
                            CHECK (origin IN ('derived', 'published', 'flow')),
          source_device_id  TEXT REFERENCES device_instances(id) ON DELETE SET NULL,
          source_flow_id    TEXT REFERENCES flows(id) ON DELETE CASCADE,
          visibility        TEXT NOT NULL DEFAULT 'public'
                            CHECK (visibility IN ('public', 'members', 'hidden')),
          created_at        TEXT NOT NULL
        );

        INSERT INTO service_instances_new
          (id, env_id, provider_agent_id, name, semantic_type, description,
           interface_json, origin, source_device_id, source_flow_id, visibility, created_at)
        SELECT id, env_id, provider_agent_id, name, semantic_type, description,
               interface_json, origin, source_device_id, NULL, visibility, created_at
        FROM service_instances;

        DROP TABLE service_instances;
        ALTER TABLE service_instances_new RENAME TO service_instances;

        CREATE INDEX idx_service_instances_env ON service_instances(env_id);
        CREATE INDEX idx_service_instances_semantic_type ON service_instances(semantic_type);
        CREATE INDEX idx_service_instances_flow ON service_instances(source_flow_id);
      `);
    },
  },
  {
    version: 39,
    name: 'flow-policy-envelope',
    up: db => {
      // Mechanism C (design-mixed-initiative-flows.md §7): flows gain an
      // optional per-flow POLICY ENVELOPE (`policy`, the core
      // FlowPolicyEnvelope — NULL = pre-C flow with no envelope). The
      // envelope bounds all agent activity inside the flow (delegation
      // budget, actuation confidence gate, exhaustion escalation) whatever
      // entry point fired the run. flow_runs record the exhaustion
      // escalations a run surfaced ('escalate' mode only — the auditable
      // counterpart of the owner notification).
      db.exec(`
        ALTER TABLE flows ADD COLUMN policy_json TEXT;
        ALTER TABLE flow_runs ADD COLUMN policy_escalations_json TEXT;
      `);
    },
  },
  {
    version: 40,
    name: 'flow-agent-invocable',
    up: db => {
      // Mechanism B (design-mixed-initiative-flows.md §6): flows gain the
      // agent-invocation opt-in (`agentInvocable`, DEFAULT 0 — flows are
      // opt-in tools; only the author's T-201-scoped agents may name them
      // in decisions). flow_runs record WHO invoked an agent-triggered run
      // (the deciding agent + the in-flight event — the (agentId, eventId)
      // pair joins the run ledger back to the decision record stream).
      db.exec(`
        ALTER TABLE flows ADD COLUMN agent_invocable INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE flow_runs ADD COLUMN invoked_by_agent_id TEXT;
        ALTER TABLE flow_runs ADD COLUMN invoked_by_event_id TEXT;
      `);
    },
  },
];
