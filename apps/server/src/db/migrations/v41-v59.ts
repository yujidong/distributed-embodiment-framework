/**
 * Schema migrations v41–v59 (R22 file-budget extraction from database.ts —
 * verbatim move, registry stays in database.ts). Platform segment: adopt-config
 * proposals, fork lifecycle, standing asks, env-claim delegations, api keys,
 * external event sources, platform invites, usage origin, agreement
 * activated_at; agent-llm null-intent recovery (v46).
 */

import {
  normalizeAgentLlmNullIntent,
} from '../migration-backfills.js';
import type { Migration } from './types.js';

export const MIGRATIONS_V41_V59: Migration[] = [
  {
    version: 41,
    name: 'proposal-kind-adopt-config',
    up: db => {
      // P2F (design-living-worlds.md §11, promote-from-fork): the
      // `adopt-config` proposal kind — adopting fork-VALIDATED declarative
      // configuration (flow definitions / agent policies / computation
      // specs) into the authoritative world through the standard governance
      // pipeline. The v31 CHECK does not list 'adopt-config', so the
      // proposals table is rebuilt once more — same 12-step procedure and
      // the same foreign_keys-OFF reliance as v13/v27/v31 (see the
      // openDatabase note: the pragma is flipped OUTSIDE the per-migration
      // transactions precisely so these rebuilds never fire referential
      // actions on the DROP).
      db.exec(`
        CREATE TABLE proposals_new (
          id              TEXT PRIMARY KEY,
          env_id          TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          author_id       TEXT NOT NULL REFERENCES users(id),
          kind            TEXT NOT NULL
                          CHECK (kind IN ('install-devices', 'install-agents', 'install-zones',
                                          'remove-devices', 'remove-agents', 'inject-scenario',
                                          'modify-object', 'zone-claim', 'adopt-config')),
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
    version: 42,
    name: 'fork-lifecycle-p2f',
    up: db => {
      // P2F (design-living-worlds.md §10): fork lifecycle completion.
      // - sandbox_members: §10.2 membership join — a fork is a joinable
      //   world context reusing the env_members role vocabulary
      //   (owner/builder/viewer; the fork OWNER is implicit in the
      //   sandboxes row, this table carries invited builders/viewers).
      //   Joining changes only WHERE you experiment, never anyone's rights
      //   in the authoritative world. Rows cascade with the sandbox.
      // - sandboxes.expires_at: §10.3's explicit per-row retention stamp
      //   (computed at fork time from the deployment retention knob; the
      //   S3 sweep honors it as an upper bound on top of the age rule).
      db.exec(`
        CREATE TABLE sandbox_members (
          sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
          user_id    TEXT NOT NULL REFERENCES users(id),
          role       TEXT NOT NULL CHECK (role IN ('builder', 'viewer')),
          invited_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          UNIQUE (sandbox_id, user_id)
        );

        CREATE INDEX idx_sandbox_members_user ON sandbox_members(user_id);

        ALTER TABLE sandboxes ADD COLUMN expires_at TEXT;
      `);
    },
  },
  {
    version: 43,
    name: 'standing-asks',
    up: db => {
      // T-069 (DevLoop R23, R19 NW-F04 — design-data-services.md §11): the
      // async-market cold-start gap — an agreement/access-request can only
      // target an EXISTING service and every notification channel reaches
      // only the env owner or an existing bilateral counterparty. A
      // standing ask is a member's persisted demand for a FUTURE
      // counterpart asset: {semanticType, zone?, desiredTerms, note?,
      // autoPropose, expiry}. Service 'created' events (explicit publish +
      // derivation sync) match open asks and deliver ask.matched
      // notifications (+ an optional pre-filled PROPOSED agreement).
      // New table (no rebuild — the 12-step discipline applies to table
      // REBUILDS only); FK discipline: rows cascade with the environment,
      // the asker reference is a plain FK (user deletion is not a cascade
      // path — same as proposals.author_id).
      db.exec(`
        CREATE TABLE standing_asks (
          id                 TEXT PRIMARY KEY,
          env_id             TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          asker_id           TEXT NOT NULL REFERENCES users(id),
          semantic_type      TEXT NOT NULL,
          zone_id            TEXT,
          desired_terms_json TEXT NOT NULL DEFAULT '{}',
          note               TEXT NOT NULL DEFAULT '',
          auto_propose       INTEGER NOT NULL DEFAULT 0,
          status             TEXT NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open', 'matched', 'withdrawn', 'expired')),
          matched_service_id TEXT,
          matched_at         TEXT,
          expires_at         TEXT NOT NULL,
          created_at         TEXT NOT NULL
        );

        CREATE INDEX idx_standing_asks_env ON standing_asks(env_id);
        CREATE INDEX idx_standing_asks_asker ON standing_asks(env_id, asker_id);
      `);
    },
  },
  {
    version: 44,
    name: 'env-claim-delegations',
    up: db => {
      // T-072 (DevLoop R23, design-consent-semantics.md §3 / D-1 decide
      // half): zone-claim DECISION delegation — the env owner may hand the
      // decide right for zone-claim proposals to ONE member per scope at a
      // time (PK (env_id, scope)), optionally narrowed to specific zones
      // (zones_json NULL = all zones). Revocation deletes the row; the audit
      // trail lives in command_log (kind 'delegation-change'), so no history
      // columns are kept here. v1 ships exactly one scope ('zone-claims'):
      // supervised-zone CONSENT stays owner-only (the scope CHECK pins the
      // boundary — widening it is a migration, not a payload).
      db.exec(`
        CREATE TABLE env_claim_delegations (
          env_id      TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          scope       TEXT NOT NULL CHECK (scope IN ('zone-claims')),
          delegate_id TEXT NOT NULL REFERENCES users(id),
          zones_json  TEXT,
          granted_by  TEXT NOT NULL REFERENCES users(id),
          granted_at  TEXT NOT NULL,
          PRIMARY KEY (env_id, scope)
        );

        CREATE INDEX idx_env_claim_delegations_delegate ON env_claim_delegations(delegate_id);
      `);
    },
  },
  {
    version: 45,
    name: 'usage-failure-reason',
    up: db => {
      // C3 (R25-NF4, DevLoop R28): triggered-execution failures surfaced only
      // as outcome='failure' — the REASON (device absent, command rejected,
      // quota window spent, param vocabulary) lived in server logs the
      // consumer cannot read. A nullable text column on the APPEND-ONLY
      // ledger carries it (ALTER ADD COLUMN, no rebuild — the 12-step
      // discipline applies to rebuilds only). Null = success or pre-C3 rows.
      db.exec(`
        ALTER TABLE usage_records ADD COLUMN failure_reason TEXT;
      `);
    },
  },
  {
    version: 46,
    name: 'agent-llm-null-intent-recovery',
    up: db => {
      // NF2701 (DevLoop R27, from T-601): pre-fix rows that stored SQL NULL
      // when the author INTENDED explicit llm:null. Honest assessment —
      // see normalizeAgentLlmNullIntent for the full rationale; summary:
      // the LIVE path is already correct (resolveAgentLlmClient treats SQL
      // NULL as "use shared", pinned by agent-llm-null + EngineRuntime
      // llm-null suites), and agent_instances alone carries NO evidence
      // distinguishing "author wrote llm:null" from "author never specified"
      // — the pre-T-601 `!= null` collapse destroyed it. This migration is
      // DATA NORMALIZATION for consistency, not a behavior fix: it flips a
      // row to explicit 'null' ONLY where the proposal pipeline preserved
      // the author's exact intent (applied modify-object patch.llm === null;
      // applied install-agents agents[].llm === null, created ids resolved
      // through the apply's command_log after-payload). Every other SQL NULL
      // row stays as-is BY DESIGN — bulk-flipping would force rule-only on
      // agents whose authors simply never authored an llm block.
      normalizeAgentLlmNullIntent(db);
    },
  },
  {
    version: 47,
    name: 'service-zone-declaration',
    up: db => {
      // D2 (DevLoop R28, T-079): providers of published/flow services MAY
      // declare a zoneId at publish (§11.2(6) amended — closes the structural
      // unmatchability of zone-pinned standing asks against non-derived
      // services). Nullable: undeclared stays zone-less (matches zone-less
      // asks only); derived rows keep deriving their zone from the source
      // device. ALTER ADD COLUMN, no rebuild.
      db.exec(`
        ALTER TABLE service_instances ADD COLUMN zone_id TEXT;
      `);
    },
  },
  {
    version: 48,
    name: 'agreement-hold',
    up: db => {
      // D3 (DevLoop R28, T-080): the consumer-side bounded consumption pause
      // — status 'held' (CHECK expansion ⇒ 12-step rebuild, the v33 pattern;
      // usage_records/settlement_receipts FK-text is untouched by a rebuild
      // since migrations run with foreign_keys OFF) + hold_expires_at (the
      // lazy-expiry deadline; NULL unless held). 'held' suspends auto-trigger
      // execution and manual invokes for THAT agreement only; quota is not
      // burned during the hold; terminate stays terminal.
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
                             CHECK (status IN ('proposed', 'countered', 'active', 'held',
                                               'rejected', 'suspended', 'terminated')),
          source             TEXT NOT NULL DEFAULT 'explicit'
                             CHECK (source IN ('explicit', 'ac')),
          collaboration_id   TEXT,
          hold_expires_at    TEXT,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL
        );

        INSERT INTO service_agreements_new
          (id, env_id, service_id, consumer_agent_id, consumer_owner_id,
           provider_agent_id, provider_owner_id, terms_json, countered_terms_json,
           status, source, collaboration_id, hold_expires_at, created_at, updated_at)
        SELECT id, env_id, service_id, consumer_agent_id, consumer_owner_id,
               provider_agent_id, provider_owner_id, terms_json, countered_terms_json,
               status, source, collaboration_id, NULL, created_at, updated_at
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
    version: 49,
    name: 'proposal-kind-ownership-transfer',
    up: db => {
      // C3 (R42-B, devloop-r41-a1 §8): the `ownership-transfer` proposal
      // kind — the governance-plane agent/device ownership handover that
      // fixes D2-F8 / R41-F5 (template imports land everything on the
      // importer; members could never own "their" agents). The v41 CHECK
      // does not list it, so the proposals table is rebuilt once more —
      // same 12-step procedure and foreign_keys-OFF reliance as
      // v13/v27/v31/v41 (see the openDatabase note).
      db.exec(`
        CREATE TABLE proposals_new (
          id              TEXT PRIMARY KEY,
          env_id          TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          author_id       TEXT NOT NULL REFERENCES users(id),
          kind            TEXT NOT NULL
                          CHECK (kind IN ('install-devices', 'install-agents', 'install-zones',
                                          'remove-devices', 'remove-agents', 'inject-scenario',
                                          'modify-object', 'zone-claim', 'adopt-config',
                                          'ownership-transfer')),
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
    version: 50,
    name: 'service-instances-provider-index',
    up: db => {
      // R44-scale (insane 档导入超线性修复): every derivation sync reads a
      // provider's derived rows with `WHERE provider_agent_id = ? AND
      // origin = 'derived'` (derivedServicesOfAgent), and servicesOfAgent
      // selects the same key — but provider_agent_id was UNINDEXED, so each
      // lookup full-scanned service_instances. A 913-agent import ran one
      // scan per agent over the growing table and measured ×7.3 superlinear
      // (11.1s, dense→extreme→insane 1.1→1.5→11.1s); with the index the same
      // import is ~1s flat (benchmarked on a production-shaped DB with 8.4k
      // pre-existing service rows). Plain CREATE INDEX, no rebuild.
      db.exec(`
        CREATE INDEX idx_service_instances_provider ON service_instances(provider_agent_id);
      `);
    },
  },
  {
    version: 51,
    name: 'service-origin-aggregate',
    up: db => {
      // R53 (semantic offers): the AGENT-level service face — rows derived
      // from an agent's capability BUNDLE (core semantic-offers.ts), not
      // from a single device. CHECK expansion ⇒ 12-step rebuild (the v13
      // pattern; migrations run with foreign_keys OFF so the DROP fires no
      // referential actions). zone_id (v47) rides along; every index is
      // recreated (env / semantic_type / flow / provider-v50).
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
                            CHECK (origin IN ('derived', 'published', 'flow', 'aggregate')),
          source_device_id  TEXT REFERENCES device_instances(id) ON DELETE SET NULL,
          source_flow_id    TEXT REFERENCES flows(id) ON DELETE CASCADE,
          visibility        TEXT NOT NULL DEFAULT 'public'
                            CHECK (visibility IN ('public', 'members', 'hidden')),
          created_at        TEXT NOT NULL,
          zone_id           TEXT
        );

        INSERT INTO service_instances_new
          (id, env_id, provider_agent_id, name, semantic_type, description,
           interface_json, origin, source_device_id, source_flow_id, visibility, created_at, zone_id)
        SELECT id, env_id, provider_agent_id, name, semantic_type, description,
               interface_json, origin, source_device_id, source_flow_id, visibility, created_at, zone_id
        FROM service_instances;

        DROP TABLE service_instances;
        ALTER TABLE service_instances_new RENAME TO service_instances;

        CREATE INDEX idx_service_instances_env ON service_instances(env_id);
        CREATE INDEX idx_service_instances_semantic_type ON service_instances(semantic_type);
        CREATE INDEX idx_service_instances_flow ON service_instances(source_flow_id);
        CREATE INDEX idx_service_instances_provider ON service_instances(provider_agent_id);
      `);
    },
  },
  {
    version: 52,
    name: 'api-keys',
    up: db => {
      // R55 (external callers): service-scoped API keys — the credential
      // for the OUTSIDE world (scripts, existing services, other
      // platforms) to consume environment services over plain HTTP.
      // SHA-256 storage; a key acts as its owning user (permission
      // inheritance) narrowed to env_id (+ optional single service_id).
      db.exec(`
        CREATE TABLE api_keys (
          id          TEXT PRIMARY KEY,
          user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          env_id      TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          service_id  TEXT REFERENCES service_instances(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          key_hash    TEXT NOT NULL UNIQUE,
          created_at  TEXT NOT NULL,
          last_used_at TEXT,
          expires_at  TEXT,
          revoked_at  TEXT
        );
        CREATE INDEX idx_api_keys_user ON api_keys(user_id);
        CREATE INDEX idx_api_keys_env ON api_keys(env_id);
      `);
    },
  },
  {
    version: 53,
    name: 'external-event-sources',
    up: db => {
      // R58 (subscription direction): the platform CONSUMES external event
      // streams — a source is polled on an interval, its payload mapped
      // into world events (template mapping), deduped, and injected through
      // the same lane as webhook pushes. Seen-keys persist across restarts
      // so a re-poll never double-fires an alert.
      db.exec(`
        CREATE TABLE external_event_sources (
          id               TEXT PRIMARY KEY,
          env_id           TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          name             TEXT NOT NULL,
          url              TEXT NOT NULL,
          poll_interval_sec INTEGER NOT NULL DEFAULT 60,
          auth_headers_json TEXT NOT NULL DEFAULT '{}',
          mapping_json     TEXT NOT NULL DEFAULT '{}',
          enabled          INTEGER NOT NULL DEFAULT 1,
          last_poll_at     TEXT,
          last_status      TEXT,
          last_error       TEXT,
          last_injected    INTEGER NOT NULL DEFAULT 0,
          created_at       TEXT NOT NULL
        );
        CREATE INDEX idx_event_sources_env ON external_event_sources(env_id);
        CREATE INDEX idx_event_sources_due ON external_event_sources(enabled, poll_interval_sec);

        CREATE TABLE external_event_seen (
          source_id TEXT NOT NULL REFERENCES external_event_sources(id) ON DELETE CASCADE,
          dedupe_key TEXT NOT NULL,
          seen_at   TEXT NOT NULL,
          PRIMARY KEY (source_id, dedupe_key)
        );
      `);
    },
  },
  {
    version: 54,
    name: 'notification-aggregation',
    up: db => {
      // R68 (notification governance): collaboration storms produced up to
      // 15 identical unread rows per (user, kind, ref) — 891 of 1031 total
      // rows were collaboration.accepted repeats. repeat_count carries the
      // merge; create() now aggregates same-key UNREAD rows into one (xN)
      // instead of inserting, and prunes stale read rows per user.
      db.exec(`
        ALTER TABLE notifications ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1;
        CREATE INDEX IF NOT EXISTS idx_notifications_user_kind_ref
          ON notifications(user_id, kind, ref_id, read_at);
      `);
      // One-time backfill: merge unread duplicate groups into their newest
      // row (sum the counts), then drop the older duplicates.
      db.exec(`
        UPDATE notifications SET repeat_count = (
          SELECT COUNT(*) FROM notifications AS d
          WHERE d.user_id = notifications.user_id
            AND d.kind = notifications.kind
            AND d.ref_id = notifications.ref_id
            AND d.read_at IS NULL
        )
        WHERE read_at IS NULL
          AND ref_id IS NOT NULL
          AND id = (
            SELECT id FROM notifications AS d2
            WHERE d2.user_id = notifications.user_id
              AND d2.kind = notifications.kind
              AND d2.ref_id = notifications.ref_id
              AND d2.read_at IS NULL
            ORDER BY created_at DESC, rowid DESC LIMIT 1
          );
      `);
      db.exec(`
        DELETE FROM notifications
        WHERE read_at IS NULL AND ref_id IS NOT NULL
          AND id NOT IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (
                PARTITION BY user_id, kind, ref_id
                ORDER BY created_at DESC, rowid DESC
              ) AS rn
              FROM notifications
              WHERE read_at IS NULL AND ref_id IS NOT NULL
            ) WHERE rn = 1
          );
      `);
    },
  },

  {
    version: 55,
    name: 'capability-demand-telemetry',
    up: db => {
      // R80-FW3: durable demand signals for capabilities users wanted but
      // the platform could not supply (wizard ⚠ chips, rejected free-text
      // declarations, zero-hit catalog searches). Dedup key is applied at
      // write time (user, env, capability, source); aggregation is a plain
      // GROUP BY for the admin top-N view.
      db.exec(`
        CREATE TABLE capability_demand (
          id            TEXT PRIMARY KEY,
          user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          env_id        TEXT REFERENCES environments(id) ON DELETE CASCADE,
          capability    TEXT NOT NULL,
          source        TEXT NOT NULL CHECK (source IN
                        ('wizard-unbacked-chip', 'wizard-rejected-declaration', 'catalog-zero-hit')),
          first_seen_at TEXT NOT NULL,
          last_seen_at  TEXT NOT NULL,
          count         INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX idx_capability_demand_capability
          ON capability_demand(capability);
        CREATE INDEX idx_capability_demand_env
          ON capability_demand(env_id);
      `);
    },
  },

  {
    version: 56,
    name: 'hass-reverse-sync',
    up: db => {
      // HIL reverse mapping P1 (design-hil-reverse-mapping.md §2-P1): snapshot
      // alignment of hass://-bound device state from reality into the base
      // layer. Singleton policy row (id pinned to 1, mirroring hass_estop):
      //   disabled — no subscriptions, align-now rejected;
      //   manual   — alignment only on explicit API trigger (safe default);
      //   live     — state_changed pushes align the bound device (throttled).
      // The alignment WRITES ride the existing world-mutation channel
      // (device_instances row update + world-sync broadcast + command_log
      // kind 'hass-reverse-sync') — no new table needed for the audit trail.
      db.exec(`
        CREATE TABLE hass_reverse_sync_state (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          policy     TEXT NOT NULL DEFAULT 'manual'
                     CHECK (policy IN ('disabled', 'manual', 'live')),
          updated_by TEXT,
          updated_at TEXT
        );

        INSERT INTO hass_reverse_sync_state (id, policy) VALUES (1, 'manual');
      `);
    },
  },

  {
    version: 57,
    name: 'platform-invites',
    up: db => {
      // Alpha capacity gating (EAF_INVITE_ONLY): platform-level registration
      // invites — DISTINCT from env_invites (which park an email for env
      // membership). `code` is the primary key (high-entropy, shown to the
      // admin exactly once at creation); `used_count` is incremented
      // atomically inside the registration transaction (conditional UPDATE
      // `used_count < max_uses`) so concurrent registrations cannot overspend
      // the remaining uses. `expires_at`/`revoked_at` are NULL = open.
      db.exec(`
        CREATE TABLE platform_invites (
          code       TEXT PRIMARY KEY,
          max_uses   INTEGER NOT NULL CHECK (max_uses >= 1),
          used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          revoked_at TEXT
        );
      `);
    },
  },
  {
    version: 58,
    name: 'usage-origin',
    up: db => {
      // Metering gains the service ORIGIN dimension (the funnel no longer
      // depends on the trajectory face): a nullable column on the
      // APPEND-ONLY ledger snapshots the hit service's
      // service_instances.origin at write time (ALTER ADD COLUMN, no
      // rebuild — the v45 precedent; no CHECK — a widened origin vocabulary
      // must not force a ledger rebuild). Null = pre-v58 rows or a service
      // row already gone at metering time.
      db.exec(`
        ALTER TABLE usage_records ADD COLUMN origin TEXT;
      `);
    },
  },
  {
    version: 59,
    name: 'agreement-activated-at',
    up: db => {
      // R5-F09: whether an agreement EVER reached 'active' — the terminated-
      // outcome 口径 (arrival digest completedCollaborations + the F08
      // restricted view, one shared rule: terminatedAgreementOutcome)
      // distinguishes "was in effect, then ended" ('completed') from "never
      // in effect" ('cancelled'). Null = never activated. Backfill: rows in
      // an active-family state were certainly activated (updated_at is the
      // nearest known stamp); pre-v59 TERMINATED rows are unknowable — they
      // keep the pre-v59 display 口径 (treated as having been active) instead
      // of flipping every historical 'completed' to 'cancelled' wholesale.
      // Rows still proposed/countered/rejected stay NULL — never activated,
      // exactly right.
      db.exec(`
        ALTER TABLE service_agreements ADD COLUMN activated_at TEXT;
        UPDATE service_agreements
           SET activated_at = updated_at
         WHERE status IN ('active', 'held', 'suspended', 'terminated');
      `);
    },
  },
];
