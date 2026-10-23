/**
 * Server configuration — environment-driven, with repo-relative defaults
 *
 * Environment variables:
 * - `PORT`                    listen port (default 8100)
 * - `HOST`                    listen host (default 0.0.0.0)
 * - `SCENARIO_SEED_DIR`       bundled read-only scenarios
 *                             (default <repo>/config/scenarios)
 * - `SCENARIO_USER_DIR`       user scenario store, created on startup
 *                             (default <repo>/data/scenarios)
 * - `SNAPSHOT_EVERY_SIM_SEC`  WebSocket snapshot cadence in simulated
 *                             seconds (default 5)
 * - `EAF_MAX_STEP_TICKS`      per-request cap on manual step ticks
 *                             (Fix-42b, default 600 — covers "step to
 *                             08:00 at speed 60" in one call) — keeps one
 *                             oversized `POST /simulations/:id/step` from
 *                             monopolizing the process
 * - `EAF_EVENT_DELIVERY_DEADLINE_MS` wall-clock bound on the agent-delivery
 *                             wait of POST /simulations/:id/events (T-023,
 *                             default 10000) — past it the route returns
 *                             202 decisionPending and the LLM decisions
 *                             land asynchronously; 0 = wait for all agents
 * - `EAF_MAX_BODY_BYTES`      JSON request-body limit (T-111, default
 *                             32MB) — Fastify's 1MiB default rejected
 *                             real replay-window scenario imports
 * - `EAF_WORLD_SESSION_SIM_PER_WALL_SEC`
 *                             T-073: time compression of the AUTHORITATIVE
 *                             world sessions — sim-seconds per wall-second
 *                             (positive finite float; default 1 = wall-rate,
 *                             the living-worlds §5.1 mapping decision). The
 *                             trade-off is documented in §5.1: compression
 *                             makes wall-anchored contracts
 *                             (terms.read.minFreshnessSec, cadenceSec)
 *                             elapse sooner in wall time. Per-user sims keep
 *                             their own speed knobs; this is the
 *                             authoritative world's clock only.
 * - `EAF_WORLD_SESSION_CATCHUP_COARSE_MIN_GAP_SIM_SEC` /
 *   `EAF_WORLD_SESSION_CATCHUP_PRECISE_TAIL_SIM_SEC` /
 *   `EAF_WORLD_SESSION_CATCHUP_COARSE_STRIDE_SIM_SEC` /
 *   `EAF_WORLD_SESSION_CATCHUP_COARSE_SUBSTEP_SIM_SEC`
 *                             分层追平（粗精度快进）旋钮：缺口超过
 *                             MIN_GAP（默认 86400）时，目标前
 *                             PRECISE_TAIL（默认 3600）以外的远旧区段按
 *                             STRIDE（默认 3600）大步长、SUBSTEP
 *                             （默认 30）粗物理子步快进——due 时刻逐一
 *                             如实触发，只有段间物理变粗（容差见
 *                             docs/lifecycles/world-session.md）。
 * - `EAF_ZONE_SAMPLE_SIM_SEC` zone-parameter sampling cadence for replay
 *                             timelines, in simulated seconds (default 60)
 * - `LLM_PROVIDER`            backend selection: 'openai-compatible' (the
 *                             default and ONLY backend — any
 *                             OpenAI-compatible endpoint: vLLM, LM Studio,
 *                             cloud gateways…). S-vLLM (R20): 'vllm' is an
 *                             accepted alias, canonicalized at load so every
 *                             downstream consumer sees the same value.
 *                             The ollama backend was removed in R44-B;
 *                             LLM_PROVIDER=ollama now fails with a teaching
 *                             error.
 * - `LLM_BASE_URL`            OpenAI-compatible endpoint base URL (required
 *                             to enable LLM decisions; missing → the server
 *                             still boots and runs rule-only with a loud
 *                             teaching warning at startup)
 * - `LLM_API_KEY`             OpenAI-compatible API key (optional — local
 *                             servers like vLLM often run keyless)
 * - `LLM_MODEL`               model name for the provider (must match vLLM's
 *                             --served-model-name or the served HF id, else
 *                             vLLM answers 404 NotFound). Decision-path
 *                             clients normalize drifted agent/scenario
 *                             llm.model names to this value (warn + rewrite).
 * - `LLM_MODEL_STRICT`        P1 config-drift fix: '1'/'true' turns a
 *                             request-model ≠ LLM_MODEL mismatch into an
 *                             error instead of a normalized rewrite — the
 *                             future multi-model deployment mode. Default
 *                             off (normalize).
 * - `LLM_TIMEOUT_MS`          S-vLLM (R20): per-request provider timeout for
 *                             the LLM clients this server builds. Unset
 *                             keeps the provider default (30s). Set e.g.
 *                             120000 when a large vLLM-served model needs a
 *                             bigger budget.
 * - `LLM_DECISION_RETRIES`    T-022: bounded retries for TRANSIENT provider
 *                             errors in LLM-backed AC decisions (network/
 *                             timeout/429/5xx only; default 1, 0 = single
 *                             attempt)
 * - `LLM_DECISION_RETRY_BACKOFF_MS`
 *                             T-022: linear backoff between retries in ms
 *                             (default 500)
 * - `LLM_DECISION_FAILURE_POLICY`
 *                             T-022: policy after retries are exhausted —
 *                             'rule-fallback' (default) records a degraded
 *                             rule decision (decisionSource 'rule-llm-down',
 *                             provider error in the reasoning); 'drop'
 *                             leaves no decision record (T-105 counters
 *                             remain the only trace)
 * - `LLM_MAX_CONCURRENT`      global LLM request-queue concurrency limit
 *                             (default 3). R15-A4: validated at startup
 *                             together with every other knob; R15-C1: applied
 *                             to the live queue at boot.
 * - `LLM_TRIAGE_MODEL`        small-model triage (P4-2): model used for the
 *                             cheap first-pass AC decision when a simulation
 *                             is created with `options.triage` (default
 *                             'ac-decision-15b-v2')
 * - `PROPOSAL_REVIEWER`       the §5.2 semantic reviewer (P-B): 'auto'
 *                             (default) uses the LLM reviewer when
 *                             LLM_BASE_URL is set and falls back to
 *                             escalate-everything otherwise; 'llm' forces the
 *                             LLM reviewer (still degrades to escalate-all
 *                             without LLM_BASE_URL); 'escalating' forces the
 *                             P-A escalate-everything reviewer.
 * - `LLM_REVIEW_MODEL`        optional model override for the proposal
 *                             reviewer's LLM client (default LLM_MODEL, then
 *                             the provider default).
 * - `PROPOSAL_REVIEW_LLM_TIMEOUT_MS`
 *                             wall-clock budget for ONE proposal-review LLM
 *                             call (Fix-12, R5-P1-1; default 60000). The old
 *                             fixed 15s budget was tighter than a cold-start
 *                             qwen3-14b needs, timing every low-risk review
 *                             out into escalate. Timeout/failure handling:
 *                             see the next knob.
 * - `PROPOSAL_REVIEW_TIMEOUT_AUTO_APPROVE`
 *                             platform policy (default true): when the review
 *                             LLM call fails/times out on a LOW-risk proposal
 *                             that passed the rule check, auto-approve it
 *                             (audited as aiReview.source
 *                             'review-timeout-auto-approve'; the owner can
 *                             revert). 'false' restores pure escalate.
 * - `PROPOSAL_HUMAN_REVIEW_MAX_AGENTS`
 *                             S1 (Task 3) human-review breadth knob: above
 *                             this many agents in ONE install-agents proposal
 *                             (delegate-like fleet breadth) the proposal
 *                             force-escalates to the environment owner.
 *                             Default 0 = class disarmed (current behavior).
 * - `PROPOSAL_HUMAN_REVIEW_MAX_EVENTS`
 *                             same knob for inject-scenario overlay breadth:
 *                             above this many baked scheduled events in one
 *                             proposal → owner review. Default 0 = disarmed.
 * - `PROPOSAL_HUMAN_REVIEW_MAX_ZONES_TOUCHED`
 *                             same knob for cross-zone access breadth: above
 *                             this many distinct zones touched by one
 *                             proposal → owner review. Default 0 = disarmed.
 *                             Each threshold can be tightened per environment
 *                             by the owner via mapData.governance.humanReview
 *                             (PATCH /api/environments/:id). The S1 prompt-
 *                             injection gate is always on and NOT tunable
 *                             from here.
 *                             Medium/high risk is never auto-approved.
 * - `LLM_CACHE_PATH`          LLM response cache (P4-2): when set, simulation
 *                             LLM clients persist cached responses to this
 *                             SQLite file (survives restarts). Unset = shared
 *                             in-memory cache only.
 * - `LLM_LIVENESS_INTERVAL_MS` / `LLM_LIVENESS_FAILURE_THRESHOLD`
 *                             F4-4 fault-injection knobs: shorten the R74
 *                             backend-liveness probe cadence (default 30000ms)
 *                             and the consecutive-failure flip threshold
 *                             (default 2) so a kill/recover drill flips the
 *                             /api/health decision posture within seconds.
 * - `LLM_BREAKER_COOLDOWN_MS` F4-4 knob consumed by the llm-integration
 *                             client: per-backend circuit-breaker open→
 *                             half-open cooldown (default 5 minutes). Set
 *                             before boot; applies when the breaker is first
 *                             created.
 * - `LLM_MAX_CONCURRENT`      global LLM request-queue concurrency limit
 *                             (consumed by @active-collaboration/llm-integration,
 *                             default 3). R15-A4: validated at startup together
 *                             with every other knob.
 * - `EAF_DB_PATH`             SQLite database file (default <repo>/data/eaf.db;
 *                             `:memory:` for tests)
 * - `EAF_TRAJECTORY_DIR`      base directory for per-simulation trajectory
 *                             capture (default <repo>/data/trajectories; each
 *                             new simulation records to `<dir>/<simId>/`)
 * - `EAF_SIM_TIMELINE_MAX_SIZE`
 *                             per-SEGMENT cap for each simulation's
 *                             sim-timeline segmented log (T-011 disk GC →
 *                             Living-worlds P2; default 50MB, accepts a
 *                             KB/MB suffix). Zone samples alone write
 *                             ~6.8GB/day at speed 30; the active segment
 *                             ROTATES at the cap (sealed segments are never
 *                             rewritten — history survives), and segments
 *                             older than the rollup window compact to
 *                             minute aggregates. 50MB stays under the replay
 *                             source read cap (64MB) — every segment remains
 *                             fully replayable.
 * - `EAF_TRAJECTORY_SEGMENT_BYTES`
 *                             per-segment cap for the decision trajectory
 *                             segmented log (Living-worlds P2; default 50MB
 *                             — same discipline as the timeline segments).
 * - `EAF_ROLLUP_WINDOW_DAYS`  raw retention window of the timeline
 *                             compactor (Living-worlds P2; default 7,
 *                             aligned with EAF_TRAJECTORY_MAX_AGE_DAYS):
 *                             sealed segments older than the window roll up
 *                             to minute grain and the raw is deleted AFTER
 *                             the rollup exists (crash-safe). 0 disables
 *                             rollups.
 * - `EAF_ROLLUP_SWEEP_SEC`    compactor cadence (Living-worlds P2; default
 *                             3600): periodic base-dir sweep on top of the
 *                             boot sweep and the on-rotation hooks. 0
 *                             disables the periodic timer.
 * - `EAF_TRAJECTORY_MAX_AGE_DAYS`
 *                             trajectory retention (T-011): simulation dirs
 *                             under EAF_TRAJECTORY_DIR whose newest file is
 *                             older than this are deleted at server boot
 *                             (default 7; 0 disables the boot sweep). Sims
 *                             pruned from the registry always take their dir
 *                             with them, sweep or not.
 * - `EAF_ALLOW_GRANT_TIME_CONTROL`
 *                             TEST-INFRA (T-067): 1 = expose the
 *                             env-owner-only PATCH access-grants expiry
 *                             probe (shorten-only). Default off; grant
 *                             production floors are unchanged either way.
 * - `JWT_SECRET`              token signing secret. A built-in development
 *                             default is used when unset, with a loud startup
 *                             warning — set it in any real deployment.
 *                             S3 (Task 1) STRICT ENFORCEMENT: when the server
 *                             runs in strict mode — NODE_ENV=production, or
 *                             EAF_STRICT_ENV=1 from any environment — an
 *                             unset JWT_SECRET (or one equal to the built-in
 *                             development default) is a boot-refusing config
 *                             error: a deployment must never sign auth tokens
 *                             with a key printed in the public source tree.
 *                             dev/test boots keep the zero-config default.
 * - `EAF_STRICT_ENV`          force strict-mode config enforcement (S3) even
 *                             when NODE_ENV is not 'production' (bare-metal /
 *                             systemd deployments that never set NODE_ENV).
 *                             '1'/'true'/'on' → strict; see JWT_SECRET above
 *                             for the currently enforced items.
 * - `HASS_URL`                Home Assistant WebSocket API URL (P3a;
 *                             ws(s):// or http(s)://, /api/websocket appended
 *                             when missing)
 * - `HASS_TOKEN`              HA long-lived access token. Both HASS_* must be
 *                             set: then scenarios with hass:// bindings build
 *                             runtimes backed by real entities; without them
 *                             such creates fail 503 HASS_NOT_CONFIGURED.
 * - `HASS_DEFAULT_POLICY`     safety-gate fallback when no policy row matches
 *                             an entity (P3b): 'allow' | 'confirm' | 'deny',
 *                             default 'confirm' — real actuation parks for
 *                             human approval until an operator allow-lists it.
 * - `HASS_RATE_LIMIT_PER_MIN` per-entity actuation token bucket (default 6).
 * - `ADMIN_EMAILS`            comma-separated emails allowed to WRITE global
 *                             (env-less) hass policies (P3b). Env-scoped
 *                             policies are written by that env's owners.
 *                             Also gates GET /api/admin/observability (P4-4)
 *                             and the platform-invite admin API (alpha
 *                             capacity gating, schema v57).
 * - `EAF_INVITE_ONLY`         alpha capacity gating: registration requires a
 *                             platform invite code. Default ON in strict mode
 *                             (NODE_ENV=production / EAF_STRICT_ENV=1), OFF in
 *                             development; '1'/'true' or '0'/'false' overrides.
 * - `RATE_LIMIT_ENABLED`      in-process fixed-window rate limiting (P4-4):
 *                             'false'/'0'/'no'/'off' disables it entirely
 *                             (default enabled; the test harness disables it
 *                             via config override — see test-utils.ts).
 * - `RATE_LIMIT_AUTH_PER_MIN` requests/min per IP on /api/auth/* (default 30 —
 *                             widened from 10 in Fix-13: register→login in one
 *                             burst and several users sharing an IP must not 429)
 * - `RATE_LIMIT_SESSION_PER_MIN` requests/min per IP on read-only session
 *                             endpoints (GET /api/auth/me; default 300 — R76-F1:
 *                             the boot session restore must not share the
 *                             brute-force auth bucket)
 * - `RATE_LIMIT_WRITE_PER_MIN` requests/min per IP on heavy writes — sim
 *                             create + device/agent create (default 30)
 * - `RATE_LIMIT_GLOBAL_PER_MIN` requests/min per IP on everything else
 *                             (default 300)
 * - `QUOTA_MAX_ENVS_PER_USER` environments one user may own (default 20)
 * - `QUOTA_MAX_DEVICES_PER_ENV` device instances per environment (default 200)
 * - `QUOTA_MAX_AGENTS_PER_ENV` agent instances per environment (default 50)
 * - `QUOTA_MAX_ZONES_PER_ENV` zones per environment (T-055, default 100)
 * - `QUOTA_MAX_RUNNING_SIMS_PER_USER` simulations in running/paused state
 *                             created by one user (default 3)
 * - `QUOTA_MAX_SANDBOXES_PER_USER_PER_ENV` active sandboxes one user may
 *                             hold in one environment (P-C; default 3)
 * - `EAF_FORK_MAX_AGE_DAYS`   sandbox-fork retention (S3, Task 2): ACTIVE
 *                             sandbox rows whose last activity (row age or
 *                             newest trajectory-file mtime) is older than
 *                             this are swept at server boot and hourly —
 *                             the row is marked stopped (releasing its
 *                             quota slot) and its registry sim + trajectory
 *                             dir are torn down (T-011 ownership: only the
 *                             registry-managed `<EAF_TRAJECTORY_DIR>/<simId>/`
 *                             location; fork source environments are user
 *                             rows and NEVER touched). Default 7;
 *                             0 disables the sweep.
 * - `SETTLEMENT_PROVIDER`     settlement SPI selection (Fix-11 §3.4): only
 *                             'null' (default) is shipped in this
 *                             distribution — no amounts, settle archives a
 *                             receipt. External settlement backends are
 *                             independent projects assembled here.
 * - `AC_EPHEMERAL_AGREEMENTS` AC 握手成功自动落 ephemeral agreement
 *                             (Fix-11 Phase 2; default true, false 关闭)
 * - `AGREEMENT_STREAM_HEARTBEAT_MS`
 *                             ping/pong cadence in ms shared by ALL live
 *                             streams (Fix-15, F-21; default 30000): the
 *                             agreement observation stream (§3.2.2, a dead
 *                             peer's session is still metered kind='stream')
 *                             and — T-007 — the environment world stream and
 *                             the simulation state stream (a dead peer would
 *                             otherwise keep its presence entry / ws gauge
 *                             alive forever). One missed pong terminates the
 *                             socket.
 * - `EAF_EVAL_RUN_TIMEOUT_MS` wall-clock budget for ONE run inside a batch
 *                             evaluation (Wave-3a; default 300000 = 5 min).
 *                             Checked cooperatively between run phases; an
 *                             over-budget run is marked failed and the batch
 *                             continues with the next run.
 * - `WEB_DIST`                built web console directory served at `/` (P3c;
 *                             default <repo>/apps/web/dist). When the dir has
 *                             no index.html, `/` returns a JSON note instead.
 * - `LOG_LEVEL`               global log level: debug | info | warn | error |
 *                             silent (default info). Drives both the shared
 *                             framework logger (configureLogger) and the
 *                             Fastify/pino HTTP logger. 'debug' also lifts
 *                             the built-in per-tick noise suppression below.
 * - `EAF_LOG_MODULE_LEVELS`   JSON object of per-module level overrides for
 *                             the shared logger, e.g.
 *                             '{"PhysicsLayer":"warn","CognitiveAgent":"debug"}'
 *                             (keys prefix-match module names). Overrides the
 *                             built-in per-tick suppression; invalid JSON
 *                             degrades to the defaults with one startup warn.
 * - `LOG_FILE`                when set, all server logs (shared logger +
 *                             Fastify pino) tee to this file in addition to
 *                             stdout. Unset (default) keeps pure stdout —
 *                             the docker-friendly mode.
 * - `LOG_MAX_SIZE`            rotation threshold for LOG_FILE in bytes
 *                             (default 10485760 = 10MB); accepts an optional
 *                             KB/MB suffix, e.g. '50MB'.
 * - `LOG_MAX_FILES`           rotated generations to keep (default 5):
 *                             app.log → app.log.1 → …; the oldest is deleted.
 */

import { join, resolve } from 'node:path';

import { LoggerLevel } from '@active-collaboration/shared';
import { parseModelRoute, type LlmModelRoutes } from '@active-collaboration/llm-integration';

export interface ServerConfig {
  port: number;
  host: string;
  /** Bundled scenario directory (read-only seeds). */
  seedDir: string;
  /**
   * S4 (boot ordering): when true, buildServer does NOT run the
   * blueprint/template/catalog seed writes — it decorates `runBootSeeds`
   * instead, and the caller (index.ts) invokes it after a successful listen
   * so an EADDRINUSE boot fails fast without touching the DB. Not env-read;
   * set programmatically by the production entrypoint. Tests keep the
   * default (immediate seeds).
   */
  deferBootSeeds?: boolean;
  /** User scenario directory (writable; created on startup). */
  userDir: string;
  /** WebSocket snapshot cadence, in simulated seconds. */
  snapshotEverySimSec: number;
  /** Zone-parameter sampling cadence for replay timelines, in simulated seconds (Fix-14). */
  zoneSampleEverySimSec: number;
  /** SQLite database file; `:memory:` for tests. Parent dir created on boot. */
  databasePath: string;
  /**
   * Base directory for per-simulation trajectory capture (W8): every new
   * simulation records its JSONL trajectory to `<trajectoryDir>/<simId>/`
   * unless the create call passes an explicit `options.trajectoryDir`.
   */
  trajectoryDir: string;
  /**
   * Per-SEGMENT cap for each simulation's sim-timeline segmented log
   * (T-011 disk GC → Living-worlds P2; EAF_SIM_TIMELINE_MAX_SIZE, default
   * 50MB). The active segment rotates at the cap; sealed segments are never
   * rewritten. 50MB stays below the 64MB replay source read cap.
   */
  simTimelineMaxBytes: number;
  /**
   * Per-segment cap for each simulation's decision trajectory segmented log
   * (Living-worlds P2; EAF_TRAJECTORY_SEGMENT_BYTES, default 50MB — same
   * tier as the timeline segments, below the 64MB replay source read cap).
   */
  trajectorySegmentBytes: number;
  /**
   * Trajectory retention (T-011; EAF_TRAJECTORY_MAX_AGE_DAYS, default 7):
   * simulation dirs under trajectoryDir whose newest file is older than this
   * many days are swept at server boot. 0 disables the sweep.
   */
  trajectoryMaxAgeDays: number;
  /**
   * Raw retention window of the timeline compactor (Living-worlds P2;
   * EAF_ROLLUP_WINDOW_DAYS, default 7 — aligned with trajectory retention):
   * sealed segments older than the window compact to minute-grain rollups
   * and the raw is deleted afterwards (crash-safe ordering). 0 disables
   * rollups entirely (raw kept until dir-level retention removes it).
   */
  rollupWindowDays: number;
  /**
   * Compactor cadence (Living-worlds P2; EAF_ROLLUP_SWEEP_SEC, default
   * 3600): how often the periodic base-dir sweep runs on top of the boot
   * sweep and the on-rotation hooks. 0 disables the periodic timer (boot +
   * rotation still sweep).
   */
  rollupSweepSec: number;
  /** JWT signing secret (development default when JWT_SECRET is unset). */
  jwtSecret: string;
  /** True when jwtSecret is the built-in development default. */
  jwtSecretIsDefault: boolean;
  /**
   * S3 (Task 1): strict-mode enforcement. True when NODE_ENV=production or
   * EAF_STRICT_ENV is truthy — the mode whose config errors (currently: an
   * unset/default JWT_SECRET) refuse the boot instead of warning.
   */
  strictEnv: boolean;
  /**
   * R15-C2: LLM backend selection. 'openai-compatible' (vLLM et al.) is
   * the sole backend since R44-B. The registry builds its shared clients
   * from this.
   */
  llmProvider: 'openai-compatible';
  /** OpenAI-compatible endpoint base URL (enables LLM decisions when set). */
  llmBaseUrl?: string;
  /** OpenAI-compatible API key (optional — local servers run keyless). */
  llmApiKey?: string;
  /** Model name for the provider. */
  llmModel?: string;
  /**
   * R44-B teaching warning: set when the LLM backend is not fully configured
   * (LLM_BASE_URL or LLM_MODEL missing). The server still boots and runs
   * rule-only; index.ts logs this loudly at startup so the gap is never
   * silent (the R44-B successor of the old silent local-backend fallback).
   */
  llmUnconfiguredWarning?: string;
  /**
   * Per-function model routing (LLM_DECISION_MODEL / LLM_EVAL_MODEL /
   * LLM_NL_MODEL). Every slot optional; an absent slot falls back to
   * LLM_MODEL (single-backend behavior unchanged). A route is a bare model
   * name (served by LLM_BASE_URL) or `model@baseURL` pinning that function
   * to ANOTHER vLLM instance. Routed clients pin deployedModel to the route
   * model, so normalization/strict (LLM_MODEL_STRICT) applies per route.
   */
  llmRoutes?: LlmModelRoutes;
  /**
   * S-vLLM (R20): per-request provider timeout applied to every LLM client
   * this server builds (decision, triage, proposal review). Undefined when
   * LLM_TIMEOUT_MS is unset — the provider default (30s) applies.
   */
  llmTimeoutMs?: number;
  /**
   * T-022 (DevLoop R17): bounded retries for TRANSIENT provider errors in
   * LLM-backed AC decisions (network, timeout, 429/5xx). 0 = single
   * attempt. Default 1.
   */
  llmDecisionRetries: number;
  /** T-022: linear backoff between decision retries, ms. Default 500. */
  llmDecisionRetryBackoffMs: number;
  /**
   * T-022: policy after retries are exhausted — 'rule-fallback' (default):
   * the decision is recorded via the deterministic capability rule with
   * decisionSource 'rule-llm-down' and the provider error in the reasoning;
   * 'drop': the event yields no decision record (T-105 counters only).
   */
  llmDecisionFailurePolicy: 'rule-fallback' | 'drop';
  /**
   * R15-C1: global LLM request-queue concurrency limit, validated here and
   * applied to the live queue at boot.
   */
  llmMaxConcurrent: number;
  /**
   * R74 liveness probe cadence (ms) for the /api/health decision posture.
   * Default 30s (llm-liveness.ts); fault-injection harnesses (F4-4) set a
   * short cadence so a backend kill/recover is visible within seconds.
   */
  llmLivenessIntervalMs?: number;
  /**
   * R74 liveness failure threshold — consecutive probe misses before the
   * posture flips to 'llm-unreachable'. Default 2; fault injection sets 1.
   */
  llmLivenessFailureThreshold?: number;
  /**
   * R32-C: CORS allow-list (exact origins, comma-separated in
   * EAF_CORS_ORIGINS). Empty (default) = CORS disabled — the web console is
   * same-origin and needs nothing; cross-origin API consumers opt in.
   */
  corsOrigins: string[];
  /**
   * R32-C: Content-Security-Policy header (default on; EAF_CSP=off
   * disables). The policy is console-compatible ('self' + inline styles +
   * ws: connect).
   */
  contentSecurityPolicy: boolean;
  /**
   * R32-C: Strict-Transport-Security header (default off — only meaningful
   * behind a TLS terminator; EAF_HSTS=1 enables).
   */
  hsts: boolean;
  /** Small-model triage model on the same backend (P4-2). */
  llmTriageModel?: string;
  /** Semantic reviewer selection (P-B §5.2): auto | llm | escalating. */
  proposalReviewer: 'auto' | 'llm' | 'escalating';
  /** Optional model override for the proposal reviewer's LLM client (P-B). */
  llmReviewModel?: string;
  /**
   * Wall-clock budget (ms) for one proposal-review LLM call (Fix-12,
   * R5-P1-1). Default 60s; expiry degrades per proposalReviewTimeoutAutoApprove.
   */
  proposalReviewLlmTimeoutMs: number;
  /**
   * Platform policy (default true): a failed/timed-out review call on a
   * low-risk, rule-check-passing proposal auto-approves (audited) instead
   * of escalating. False restores pure escalate.
   */
  proposalReviewTimeoutAutoApprove: boolean;
  /**
   * S1 (Task 3): deployment-level human-review breadth thresholds. 0 (the
   * default) disarms each class; a per-env owner override
   * (mapData.governance.humanReview) wins field by field. Classes:
   * maxAgentsPerProposal (install-agents fleet breadth),
   * maxEventsPerProposal (inject-scenario overlay breadth),
   * maxZonesTouched (cross-zone access breadth). The prompt-injection gate
   * is NOT tunable from here (always on).
   */
  proposalHumanReviewMaxAgents: number;
  proposalHumanReviewMaxEvents: number;
  proposalHumanReviewMaxZonesTouched: number;
  /**
   * TEST-DEPLOYMENT INFRA (T-067, R16; default false): expose
   * PATCH /api/services/:id/access-grants/:userId {expiresAt} — the
   * grant-expiry boundary probe. Grant durations are provider-decided with a
   * 1-day floor, so natural expiry is untestable inside a round window; the
   * env-owner-only, shorten-only route collapses the boundary into minutes.
   * Production floors are unchanged (the route is inert unless this flag is
   * set). Set EAF_ALLOW_GRANT_TIME_CONTROL=1 to enable.
   */
  allowGrantTimeControl: boolean;
  /** Optional SQLite path for the shared LLM response cache (P4-2). */
  llmCachePath?: string;
  /** Home Assistant WebSocket URL (P3a); requires hassToken. */
  hassUrl?: string;
  /** Home Assistant long-lived access token (P3a); requires hassUrl. */
  hassToken?: string;
  /** Safety-gate fallback policy (P3b): allow | confirm | deny. */
  hassDefaultPolicy: 'allow' | 'confirm' | 'deny';
  /** Per-entity actuation rate limit (token bucket per minute, P3b). */
  hassRateLimitPerMin: number;
  /** Emails allowed to write GLOBAL hass policies (P3b; lowercase). */
  adminEmails: string[];
  /**
   * Alpha capacity gating: when true, POST /api/auth/register requires a
   * valid platform invite code (`inviteCode` body field, schema v57). Default
   * tracks strictEnv (production/EAF_STRICT_ENV=1 default ON; development
   * default OFF so the test/dev baseline stays open); EAF_INVITE_ONLY=0/1
   * overrides either way.
   */
  inviteOnly: boolean;
  /** Master switch for the in-process rate limiter (P4-4). */
  rateLimitEnabled: boolean;
  /** Requests/min per IP on /api/auth/* (P4-4). */
  rateLimitAuthPerMin: number;
  /** Requests/min per IP on read-only session endpoints (R76-F1: GET /api/auth/me). */
  rateLimitSessionPerMin: number;
  /** Requests/min per IP on heavy writes: sim/device/agent create (P4-4). */
  rateLimitWritePerMin: number;
  /** Requests/min per IP on everything else (P4-4). */
  rateLimitGlobalPerMin: number;
  /** Max environments one user may own (P4-4). */
  quotaMaxEnvsPerUser: number;
  /** Max device instances per environment (P4-4). */
  quotaMaxDevicesPerEnv: number;
  /** Max agent instances per environment (P4-4). */
  quotaMaxAgentsPerEnv: number;
  /** Max zones per environment (T-055 install-zones governance). */
  quotaMaxZonesPerEnv: number;
  /** Max running+paused simulations created by one user (P4-4). */
  quotaMaxRunningSimsPerUser: number;
  /** Max active sandboxes one user may hold in one environment (P-C). */
  quotaMaxSandboxesPerUserPerEnv: number;
  /**
   * S3 (Task 2): sandbox-fork retention (EAF_FORK_MAX_AGE_DAYS, default 7).
   * Active sandbox rows idle longer than this are swept (boot + hourly):
   * row → stopped (quota slot released), registry sim + trajectory dir →
   * torn down. 0 disables the sweep.
   */
  forkMaxAgeDays: number;
  /**
   * Fix-42b: per-request cap on manual `POST /simulations/:id/step` tick
   * counts (`n`, or the ticks derived from `toSimTimeSec`). One oversized
   * step froze the whole API for minutes (E2E 2026-08-15); the engine now
   * yields between tick chunks, and this cap bounds each request's total
   * work. 600 keeps the documented "step to 08:00 at speed 60" (480 ticks)
   * working in one call; step in chunks, or raise EAF_MAX_STEP_TICKS
   * knowingly.
   */
  maxStepTicks: number;
  /**
   * T-023: wall-clock bound on the agent-delivery wait of
   * `POST /simulations/:id/events` (EAF_EVENT_DELIVERY_DEADLINE_MS, default
   * 10s). LLM decisions can take seconds-to-minutes per agent; past the
   * bound the route returns 202 with `decisionPending: true` while the
   * decisions land in the snapshot asynchronously. 0 disables the bound
   * (the historical await-everything behavior).
   */
  eventDeliveryDeadlineMs: number;
  /**
   * T-111: JSON body limit for request bodies (Fastify `bodyLimit`).
   * Fastify's 1MiB default rejected real replay windows (a 7-minute
   * 2-zone window ≈ 1.2MB scenario JSON) with a raw framework error
   * instead of the platform envelope. 32MB accommodates large imports;
   * raise EAF_MAX_BODY_BYTES knowingly (bodies are parsed into memory).
   */
  maxBodyBytes: number;
  /**
   * Settlement SPI selection (Fix-11 §3.4): 'null' is the only implementation
   * in this distribution; any other value fails fast at boot.
   */
  settlementProvider: 'null';
  /**
   * AC ephemeral agreements (Fix-11 Phase 2, §3.1): when true (default), a
   * successful AC handshake lands a metered ephemeral agreement
   * (source='ac'). Set AC_EPHEMERAL_AGREEMENTS=false to disable.
   */
  acEphemeralAgreements: boolean;
  /**
   * Agreement stream heartbeat (Fix-15, F-21): ping cadence in ms for
   * /api/agreements/:id/stream. A killed/orphaned CLI (e.g. an npx wrapper
   * dies but the node child keeps the TCP socket open) never sends a close
   * frame — one missed pong terminates the socket so the session is metered.
   */
  agreementStreamHeartbeatMs: number;
  /**
   * R6-E-F08 full failover (agreement-failover.ts): cadence of the
   * unreachable-provider watchdog sweep (default 2 min — a ServicePublisher
   * heartbeat is 30s, the service-stale TTL 90s; the watchdog judges on a
   * slower clock than the discovery filter so a single missed beat never
   * parks a contract).
   */
  agreementFailoverScanIntervalMs: number;
  /**
   * R6-E-F08 full failover: provider silence past this budget (default 5 min)
   * parks its explicit active agreements (suspended, 'provider-unreachable');
   * a heartbeat comeback within the parked state re-signs a successor.
   */
  agreementFailoverUnreachableMs: number;
  /** Per-run wall-clock budget for batch evaluations (Wave-3a, ms). */
  evalRunTimeoutMs: number;
  /**
   * Built web console dist dir (P3c): served at `/` with SPA fallback when
   * it contains an index.html; otherwise `/` answers with a JSON note.
   */
  webDist: string;
  /** Global log level (LOG_LEVEL, default 'info') — shared logger + pino. */
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /**
   * Per-module shared-logger overrides (EAF_LOG_MODULE_LEVELS, JSON).
   * Values are numeric LoggerLevels, resolved at load; undefined when the
   * variable is unset or failed to parse (a startup warn is emitted then).
   */
  logModuleLevels?: Record<string, LoggerLevel>;
  /**
   * Log file path (LOG_FILE). When set, both the shared logger and the
   * Fastify pino logger tee to this file in addition to stdout; unset keeps
   * pure stdout (docker-friendly).
   */
  logFile?: string;
  /** Rotation threshold for logFile in bytes (LOG_MAX_SIZE, default 10MB). */
  logMaxSize: number;
  /** Rotated generations to keep (LOG_MAX_FILES, default 5). */
  logMaxFiles: number;
  /**
   * T-073 (R22, FM expectation gap): time compression of the AUTHORITATIVE
   * world sessions — sim-seconds per wall-second
   * (EAF_WORLD_SESSION_SIM_PER_WALL_SEC; default 1 = wall-rate, the design
   * §5.1 mapping decision). Positive finite float, validated at boot.
   * Trade-off (the design note in §5.1 spells it out): compression makes
   * wall-anchored contracts (terms.read minFreshnessSec deadlines,
   * cadenceSec) elapse sooner in wall time, and dues scheduled on the
   * world's own timeline fire sooner too — set it knowingly. Per-user
   * simulations keep their own speed knobs; this is the authoritative
   * world's clock only.
   */
  worldSessionSimPerWallSec?: number;
  /**
   * 分层追平（粗精度快进）旋钮（EAF_WORLD_SESSION_CATCHUP_*；缺省见
   * world-session.ts 同名常量）。缺口超过 MIN_GAP 才启用粗推层；目标前
   * PRECISE_TAIL 保持全精度；STRIDE/SUBSTEP 决定远旧段速率与容差。
   * 正有限数，启动时校验。
   */
  worldSessionCatchUpCoarseMinGapSimSec?: number;
  worldSessionCatchUpPreciseTailSimSec?: number;
  worldSessionCatchUpCoarseStrideSimSec?: number;
  worldSessionCatchUpCoarseSubstepSimSec?: number;
}

/** Development-only JWT secret; overridden by the JWT_SECRET env var. */
export const DEV_JWT_SECRET = 'eaf-dev-secret-do-not-use-in-production';

/**
 * Repo root: this file lives in `apps/server/src` (sources, tsx) or
 * `apps/server/dist` (compiled output) — both three levels below the root.
 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/**
 * One invalid environment variable (R15-A4). `source` is the variable name;
 * `message` is human-readable and self-contained.
 */
export interface ConfigIssue {
  source: string;
  message: string;
}

/**
 * Resolve config from an environment map (defaults to `process.env`).
 *
 * R15-A4: every variable is parsed eagerly and ALL invalid values are
 * reported in ONE error (older releases threw on the first bad value, so a
 * typo-fix-restart cycle surfaced issues one at a time). Empty strings count
 * as unset for every parser. Values that only exploded later at use time —
 * LLM_MAX_CONCURRENT (parsed inside the llm package with no validation) and
 * non-URL HASS_URL — are validated here too.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const issues: ConfigIssue[] = [];

  const positiveInt = (source: string, raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.length === 0) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      issues.push({ source, message: `"${raw}" is not a positive integer` });
      return fallback;
    }
    return parsed;
  };

  // Like positiveInt but 0 is VALID (its knobs use 0 = disabled, T-011).
  const nonNegativeInt = (source: string, raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.length === 0) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      issues.push({ source, message: `"${raw}" is not a non-negative integer` });
      return fallback;
    }
    return parsed;
  };

  const oneOf = <T extends string>(
    source: string,
    raw: string | undefined,
    allowed: readonly T[],
    fallback: T,
    hint?: string,
  ): T => {
    if (raw === undefined || raw.length === 0) return fallback;
    // Case-insensitive (LOG_LEVEL historically accepted 'DEBUG'); the
    // canonical allowed spelling is what gets stored.
    const canonical = allowed.find(option => option.toLowerCase() === raw!.toLowerCase());
    if (canonical !== undefined) return canonical;
    issues.push({ source, message: `"${raw}" (expected ${allowed.join(' | ')}${hint ? ` — ${hint}` : ''})` });
    return fallback;
  };

  // T-073: positive finite float (rates like 2.5 are legitimate); no
  // fallback — the caller only stores the value when the variable is set.
  const positiveFloat = (source: string, raw: string): number => {
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      issues.push({ source, message: `"${raw}" is not a positive finite number` });
      return 1;
    }
    return parsed;
  };

  const byteSize = (source: string, raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.length === 0) return fallback;
    const match = /^(\d+)\s*(kb|mb)?$/i.exec(raw.trim());
    if (!match) {
      issues.push({ source, message: `Invalid byte-size value "${raw}" (expected bytes, KB or MB)` });
      return fallback;
    }
    const value = Number.parseInt(match[1]!, 10);
    if (value <= 0) {
      issues.push({ source, message: `Invalid byte-size value "${raw}" (must be positive)` });
      return fallback;
    }
    const unit = (match[2] ?? '').toLowerCase();
    if (unit === 'kb') return value * 1024;
    if (unit === 'mb') return value * 1024 * 1024;
    return value;
  };

  const httpUrl = (source: string, raw: string | undefined): void => {
    if (raw === undefined || raw.length === 0) return;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not an HTTP(S) URL');
    } catch {
      issues.push({ source, message: `"${raw}" is not a valid http(s) URL` });
    }
  };

  const jwtSecretIsDefault =
    env.JWT_SECRET === undefined || env.JWT_SECRET.length === 0 ||
    env.JWT_SECRET === DEV_JWT_SECRET;
  // S3 (Task 1): strict mode — NODE_ENV=production, or the dedicated
  // EAF_STRICT_ENV escape hatch for deployments that never set NODE_ENV.
  const strictEnv = env.NODE_ENV === 'production' || parseBoolean(env.EAF_STRICT_ENV, false);
  const config: ServerConfig = {
    port: positiveInt('PORT', env.PORT, 8100),
    host: env.HOST ?? '0.0.0.0',
    seedDir: env.SCENARIO_SEED_DIR ?? join(REPO_ROOT, 'config', 'scenarios'),
    userDir: env.SCENARIO_USER_DIR ?? join(REPO_ROOT, 'data', 'scenarios'),
    snapshotEverySimSec: positiveInt('SNAPSHOT_EVERY_SIM_SEC', env.SNAPSHOT_EVERY_SIM_SEC, 5),
    zoneSampleEverySimSec: positiveInt('EAF_ZONE_SAMPLE_SIM_SEC', env.EAF_ZONE_SAMPLE_SIM_SEC, 60),
    databasePath: env.EAF_DB_PATH ?? join(REPO_ROOT, 'data', 'eaf.db'),
    trajectoryDir: env.EAF_TRAJECTORY_DIR ?? join(REPO_ROOT, 'data', 'trajectories'),
    // T-011 disk GC → Living-worlds P2: per-SEGMENT caps (50MB < the replay
    // source read cap of 64MB, so every segment stays a replayable source)
    // + boot-sweep retention.
    simTimelineMaxBytes: byteSize(
      'EAF_SIM_TIMELINE_MAX_SIZE', env.EAF_SIM_TIMELINE_MAX_SIZE, 50 * 1024 * 1024),
    trajectorySegmentBytes: byteSize(
      'EAF_TRAJECTORY_SEGMENT_BYTES', env.EAF_TRAJECTORY_SEGMENT_BYTES, 50 * 1024 * 1024),
    trajectoryMaxAgeDays: nonNegativeInt(
      'EAF_TRAJECTORY_MAX_AGE_DAYS', env.EAF_TRAJECTORY_MAX_AGE_DAYS, 7),
    // Living-worlds P2 rollup compactor: raw window + periodic cadence.
    rollupWindowDays: nonNegativeInt(
      'EAF_ROLLUP_WINDOW_DAYS', env.EAF_ROLLUP_WINDOW_DAYS, 7),
    rollupSweepSec: nonNegativeInt(
      'EAF_ROLLUP_SWEEP_SEC', env.EAF_ROLLUP_SWEEP_SEC, 3600),
    jwtSecret: jwtSecretIsDefault ? DEV_JWT_SECRET : (env.JWT_SECRET as string),
    jwtSecretIsDefault,
    strictEnv,
    // R44-B: openai-compatible (vLLM et al.) is the sole backend. S-vLLM
    // (R20): 'vllm' is canonicalized to 'openai-compatible' here — one
    // accepted spelling, one downstream value everywhere. The historical
    // removed-backend value fails with a teaching error instead of silently
    // downgrading the deployment.
    llmProvider: oneOf(
      'LLM_PROVIDER',
      env.LLM_PROVIDER?.trim().toLowerCase() === 'vllm' ? 'openai-compatible' : env.LLM_PROVIDER,
      ['openai-compatible'] as const,
      'openai-compatible',
      "'openai-compatible' (or the 'vllm' alias) — the ollama backend was removed in R44-B; deploy vLLM and point LLM_BASE_URL at it",
    ),
    ...(env.LLM_BASE_URL ? { llmBaseUrl: env.LLM_BASE_URL } : {}),
    ...(env.LLM_API_KEY ? { llmApiKey: env.LLM_API_KEY } : {}),
    ...(env.LLM_MODEL ? { llmModel: env.LLM_MODEL } : {}),
    ...(env.LLM_TIMEOUT_MS ? { llmTimeoutMs: positiveInt('LLM_TIMEOUT_MS', env.LLM_TIMEOUT_MS, 30_000) } : {}),
    // T-022: bounded degradation policy for LLM-backed decisions.
    llmDecisionRetries: nonNegativeInt('LLM_DECISION_RETRIES', env.LLM_DECISION_RETRIES, 1),
    llmDecisionRetryBackoffMs: positiveInt(
      'LLM_DECISION_RETRY_BACKOFF_MS', env.LLM_DECISION_RETRY_BACKOFF_MS, 500,
    ),
    llmDecisionFailurePolicy: oneOf(
      'LLM_DECISION_FAILURE_POLICY',
      env.LLM_DECISION_FAILURE_POLICY,
      ['rule-fallback', 'drop'] as const,
      'rule-fallback',
      "'rule-fallback' records a degraded rule decision (decisionSource 'rule-llm-down'); 'drop' leaves no decision record",
    ),
    llmMaxConcurrent: positiveInt('LLM_MAX_CONCURRENT', env.LLM_MAX_CONCURRENT, 3),
    // F4-4 fault-injection knobs: shorten the R74 liveness cadence/threshold
    // so a killed-and-revived backend flips the decision posture in seconds.
    ...(env.LLM_LIVENESS_INTERVAL_MS
      ? { llmLivenessIntervalMs: positiveInt('LLM_LIVENESS_INTERVAL_MS', env.LLM_LIVENESS_INTERVAL_MS, 30_000) }
      : {}),
    ...(env.LLM_LIVENESS_FAILURE_THRESHOLD
      ? { llmLivenessFailureThreshold: positiveInt('LLM_LIVENESS_FAILURE_THRESHOLD', env.LLM_LIVENESS_FAILURE_THRESHOLD, 2) }
      : {}),
    // R32-C: production readiness knobs — CORS allow-list, CSP, HSTS.
    corsOrigins: (env.EAF_CORS_ORIGINS ?? '')
      .split(',')
      .map(o => o.trim())
      .filter(o => o.length > 0),
    contentSecurityPolicy: parseBoolean(env.EAF_CSP, true),
    hsts: parseBoolean(env.EAF_HSTS, false),
    ...(env.LLM_TRIAGE_MODEL ? { llmTriageModel: env.LLM_TRIAGE_MODEL } : {}),
    proposalReviewer: oneOf('PROPOSAL_REVIEWER', env.PROPOSAL_REVIEWER, ['auto', 'llm', 'escalating'] as const, 'auto'),
    ...(env.LLM_REVIEW_MODEL ? { llmReviewModel: env.LLM_REVIEW_MODEL } : {}),
    proposalReviewLlmTimeoutMs: positiveInt('PROPOSAL_REVIEW_LLM_TIMEOUT_MS', env.PROPOSAL_REVIEW_LLM_TIMEOUT_MS, 60_000),
    proposalReviewTimeoutAutoApprove: parseBoolean(env.PROPOSAL_REVIEW_TIMEOUT_AUTO_APPROVE, true),
    // S1 (Task 3): human-review breadth thresholds (0 = class disarmed;
    // per-env owner override via mapData.governance.humanReview wins).
    proposalHumanReviewMaxAgents: nonNegativeInt('PROPOSAL_HUMAN_REVIEW_MAX_AGENTS', env.PROPOSAL_HUMAN_REVIEW_MAX_AGENTS, 0),
    proposalHumanReviewMaxEvents: nonNegativeInt('PROPOSAL_HUMAN_REVIEW_MAX_EVENTS', env.PROPOSAL_HUMAN_REVIEW_MAX_EVENTS, 0),
    proposalHumanReviewMaxZonesTouched: nonNegativeInt('PROPOSAL_HUMAN_REVIEW_MAX_ZONES_TOUCHED', env.PROPOSAL_HUMAN_REVIEW_MAX_ZONES_TOUCHED, 0),
    ...(env.LLM_CACHE_PATH ? { llmCachePath: env.LLM_CACHE_PATH } : {}),
    ...(env.HASS_URL ? { hassUrl: env.HASS_URL } : {}),
    ...(env.HASS_TOKEN ? { hassToken: env.HASS_TOKEN } : {}),
    hassDefaultPolicy: oneOf('HASS_DEFAULT_POLICY', env.HASS_DEFAULT_POLICY, ['allow', 'confirm', 'deny'] as const, 'confirm'),
    hassRateLimitPerMin: positiveInt('HASS_RATE_LIMIT_PER_MIN', env.HASS_RATE_LIMIT_PER_MIN, 6),
    adminEmails: (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map(email => email.trim().toLowerCase())
      .filter(email => email.length > 0),
    // Alpha invite gate: production/strict boots closed unless the operator
    // explicitly opens registration (EAF_INVITE_ONLY=0); development stays
    // open unless EAF_INVITE_ONLY=1.
    inviteOnly: parseBoolean(env.EAF_INVITE_ONLY, strictEnv),
    rateLimitEnabled: parseBoolean(env.RATE_LIMIT_ENABLED, true),
    rateLimitAuthPerMin: positiveInt('RATE_LIMIT_AUTH_PER_MIN', env.RATE_LIMIT_AUTH_PER_MIN, 30),
    rateLimitSessionPerMin: positiveInt('RATE_LIMIT_SESSION_PER_MIN', env.RATE_LIMIT_SESSION_PER_MIN, 300),
    rateLimitWritePerMin: positiveInt('RATE_LIMIT_WRITE_PER_MIN', env.RATE_LIMIT_WRITE_PER_MIN, 30),
    rateLimitGlobalPerMin: positiveInt('RATE_LIMIT_GLOBAL_PER_MIN', env.RATE_LIMIT_GLOBAL_PER_MIN, 300),
    quotaMaxEnvsPerUser: positiveInt('QUOTA_MAX_ENVS_PER_USER', env.QUOTA_MAX_ENVS_PER_USER, 20),
    quotaMaxDevicesPerEnv: positiveInt('QUOTA_MAX_DEVICES_PER_ENV', env.QUOTA_MAX_DEVICES_PER_ENV, 200),
    quotaMaxAgentsPerEnv: positiveInt('QUOTA_MAX_AGENTS_PER_ENV', env.QUOTA_MAX_AGENTS_PER_ENV, 50),
    quotaMaxZonesPerEnv: positiveInt('QUOTA_MAX_ZONES_PER_ENV', env.QUOTA_MAX_ZONES_PER_ENV, 100),
    quotaMaxRunningSimsPerUser: positiveInt('QUOTA_MAX_RUNNING_SIMS_PER_USER', env.QUOTA_MAX_RUNNING_SIMS_PER_USER, 3),
    quotaMaxSandboxesPerUserPerEnv: positiveInt(
      'QUOTA_MAX_SANDBOXES_PER_USER_PER_ENV', env.QUOTA_MAX_SANDBOXES_PER_USER_PER_ENV, 3),
    // S3 (Task 2): sandbox-fork retention sweep (0 = disabled).
    forkMaxAgeDays: nonNegativeInt('EAF_FORK_MAX_AGE_DAYS', env.EAF_FORK_MAX_AGE_DAYS, 7),
    maxStepTicks: positiveInt('EAF_MAX_STEP_TICKS', env.EAF_MAX_STEP_TICKS, 600),
    // T-023: bounded event-injection delivery (0 = wait for every agent).
    eventDeliveryDeadlineMs: nonNegativeInt(
      'EAF_EVENT_DELIVERY_DEADLINE_MS', env.EAF_EVENT_DELIVERY_DEADLINE_MS, 10_000),
    maxBodyBytes: positiveInt('EAF_MAX_BODY_BYTES', env.EAF_MAX_BODY_BYTES, 32 * 1024 * 1024),
    // Fix-11 §3.4: only the Null settlement provider ships here; anything
    // else fails fast rather than silently running settlement-free.
    settlementProvider: oneOf(
      'SETTLEMENT_PROVIDER', env.SETTLEMENT_PROVIDER, ['null'] as const, 'null',
      'only "null" is available in this distribution'),
    acEphemeralAgreements: parseBoolean(env.AC_EPHEMERAL_AGREEMENTS, true),
    allowGrantTimeControl: parseBoolean(env.EAF_ALLOW_GRANT_TIME_CONTROL, false),
    agreementStreamHeartbeatMs: positiveInt('AGREEMENT_STREAM_HEARTBEAT_MS', env.AGREEMENT_STREAM_HEARTBEAT_MS, 30_000),
    agreementFailoverScanIntervalMs: positiveInt('AGREEMENT_FAILOVER_SCAN_INTERVAL_MS', env.AGREEMENT_FAILOVER_SCAN_INTERVAL_MS, 120_000),
    agreementFailoverUnreachableMs: positiveInt('AGREEMENT_FAILOVER_UNREACHABLE_MS', env.AGREEMENT_FAILOVER_UNREACHABLE_MS, 300_000),
    evalRunTimeoutMs: positiveInt('EAF_EVAL_RUN_TIMEOUT_MS', env.EAF_EVAL_RUN_TIMEOUT_MS, 300_000),
    webDist: env.WEB_DIST ?? join(REPO_ROOT, 'apps', 'web', 'dist'),
    logLevel: oneOf('LOG_LEVEL', env.LOG_LEVEL, ['debug', 'info', 'warn', 'error', 'silent'] as const, 'info'),
    ...(env.EAF_LOG_MODULE_LEVELS !== undefined
      ? { logModuleLevels: parseModuleLevels(env.EAF_LOG_MODULE_LEVELS) }
      : {}),
    ...(env.LOG_FILE ? { logFile: env.LOG_FILE } : {}),
    logMaxSize: byteSize('LOG_MAX_SIZE', env.LOG_MAX_SIZE, 10 * 1024 * 1024),
    logMaxFiles: positiveInt('LOG_MAX_FILES', env.LOG_MAX_FILES, 5),
    // T-073: the authoritative world session's time-compression knob —
    // positive finite FLOAT (2.5 sim-s per wall-s is a legitimate rate).
    ...(env.EAF_WORLD_SESSION_SIM_PER_WALL_SEC !== undefined &&
        env.EAF_WORLD_SESSION_SIM_PER_WALL_SEC.length > 0
      ? {
          worldSessionSimPerWallSec: positiveFloat(
            'EAF_WORLD_SESSION_SIM_PER_WALL_SEC',
            env.EAF_WORLD_SESSION_SIM_PER_WALL_SEC,
          ),
        }
      : {}),
    // 分层追平（粗精度快进）旋钮 — 正有限数，缺省在 world-session.ts。
    ...(env.EAF_WORLD_SESSION_CATCHUP_COARSE_MIN_GAP_SIM_SEC
      ? {
          worldSessionCatchUpCoarseMinGapSimSec: positiveFloat(
            'EAF_WORLD_SESSION_CATCHUP_COARSE_MIN_GAP_SIM_SEC',
            env.EAF_WORLD_SESSION_CATCHUP_COARSE_MIN_GAP_SIM_SEC,
          ),
        }
      : {}),
    ...(env.EAF_WORLD_SESSION_CATCHUP_PRECISE_TAIL_SIM_SEC
      ? {
          worldSessionCatchUpPreciseTailSimSec: positiveFloat(
            'EAF_WORLD_SESSION_CATCHUP_PRECISE_TAIL_SIM_SEC',
            env.EAF_WORLD_SESSION_CATCHUP_PRECISE_TAIL_SIM_SEC,
          ),
        }
      : {}),
    ...(env.EAF_WORLD_SESSION_CATCHUP_COARSE_STRIDE_SIM_SEC
      ? {
          worldSessionCatchUpCoarseStrideSimSec: positiveFloat(
            'EAF_WORLD_SESSION_CATCHUP_COARSE_STRIDE_SIM_SEC',
            env.EAF_WORLD_SESSION_CATCHUP_COARSE_STRIDE_SIM_SEC,
          ),
        }
      : {}),
    ...(env.EAF_WORLD_SESSION_CATCHUP_COARSE_SUBSTEP_SIM_SEC
      ? {
          worldSessionCatchUpCoarseSubstepSimSec: positiveFloat(
            'EAF_WORLD_SESSION_CATCHUP_COARSE_SUBSTEP_SIM_SEC',
            env.EAF_WORLD_SESSION_CATCHUP_COARSE_SUBSTEP_SIM_SEC,
          ),
        }
      : {}),
  };

  // Values consumed outside config.ts that historically only failed at use
  // time — validated here so a bad .env is reported at boot, all at once.
  httpUrl('LLM_BASE_URL', env.LLM_BASE_URL);
  httpUrl('HASS_URL', env.HASS_URL);
  // Per-function model routing: LLM_DECISION_MODEL (AC decisions + triage),
  // LLM_EVAL_MODEL (proposal-response evaluation), LLM_NL_MODEL (NL intent +
  // proposal review). Value: bare model name (on LLM_BASE_URL) or
  // `model@http(s)://…` (another vLLM instance). Malformed values are boot
  // issues, like any other config typo.
  const llmRoutes: LlmModelRoutes = {};
  for (const [source, slot] of [
    ['LLM_DECISION_MODEL', 'decision'],
    ['LLM_EVAL_MODEL', 'eval'],
    ['LLM_NL_MODEL', 'nl'],
  ] as const) {
    const raw = env[source];
    if (raw === undefined || raw.trim().length === 0) continue;
    const route = parseModelRoute(raw);
    if (route === null) {
      issues.push({
        source,
        message: `"${raw}" is not a valid model route (expected a model name like "ac-decision-v6" or "model@http(s)://host:port/v1")`,
      });
      continue;
    }
    llmRoutes[slot] = route;
  }
  if (Object.keys(llmRoutes).length > 0) config.llmRoutes = llmRoutes;
  // R44-B: the OpenAI-compatible triple is no longer a boot error when
  // incomplete — the server boots rule-only and teaches at startup instead
  // (R44-B: the old behavior silently fell back to a local backend; that
  // path is gone, so the gap must be visible, never filled silently).
  if (config.llmBaseUrl === undefined || config.llmModel === undefined) {
    const missing: string[] = [];
    if (config.llmBaseUrl === undefined) missing.push('LLM_BASE_URL (the OpenAI-compatible endpoint, e.g. http://127.0.0.1:8000/v1)');
    if (config.llmModel === undefined) missing.push('LLM_MODEL (must match vLLM --served-model-name)');
    config.llmUnconfiguredWarning =
      'the LLM backend is not fully configured — missing ' + missing.join(' and ') +
      '. Every simulation and the proposal reviewer run RULE-ONLY until it is set. ' +
      'vLLM (openai-compatible) is the sole backend since R44-B; there is no local fallback.';
  }

  // S3 (Task 1): production-mode JWT enforcement. DEV_JWT_SECRET is printed
  // in the public source tree — any client that reads the repo can forge
  // auth tokens for a server running on it. Strict mode (NODE_ENV=production
  // or EAF_STRICT_ENV=1) refuses the boot with a teaching error instead of
  // the historical warn-and-continue; dev/test keep the zero-config default.
  if (strictEnv && jwtSecretIsDefault) {
    issues.push({
      source: 'JWT_SECRET',
      message:
        'not set (or equal to the built-in development default) — this server runs in strict mode ' +
        '(NODE_ENV=production or EAF_STRICT_ENV=1), and the development signing key is public ' +
        'knowledge: anyone could forge valid auth tokens. Generate a secret with at least 32 random ' +
        'bytes (e.g. `openssl rand -hex 32`), set it as JWT_SECRET in the environment or .env, and ' +
        'restart. Development and test boots keep working without it.',
    });
  }

  if (issues.length > 0) {
    const lines = issues.map(issue => `  - Invalid ${issue.source}: ${issue.message}`).join('\n');
    throw new Error(
      `Invalid configuration (${issues.length} issue${issues.length > 1 ? 's' : ''}):\n${lines}`,
    );
  }
  return config;
}

/** Truthy unless explicitly 'false'/'0'/'no'/'off'; unset keeps the fallback. */
function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.length === 0) return fallback;
  return !['false', '0', 'no', 'off'].includes(raw.toLowerCase());
}

const LOG_LEVEL_NAMES = ['debug', 'info', 'warn', 'error', 'silent'] as const;
type LogLevelName = (typeof LOG_LEVEL_NAMES)[number];

const LEVEL_NAME_TO_ENUM: Record<LogLevelName, LoggerLevel> = {
  debug: LoggerLevel.DEBUG,
  info: LoggerLevel.INFO,
  warn: LoggerLevel.WARN,
  error: LoggerLevel.ERROR,
  silent: LoggerLevel.SILENT,
};

/**
 * EAF_LOG_MODULE_LEVELS (Tier-1 env knob): a JSON object mapping module-name
 * prefixes to level names, e.g. '{"PhysicsLayer":"warn"}'. A malformed value
 * must never kill the server — degrade to no overrides and warn once.
 */
function parseModuleLevels(raw: string): Record<string, LoggerLevel> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    const out: Record<string, LoggerLevel> = {};
    for (const [module, level] of Object.entries(parsed as Record<string, unknown>)) {
      const name = String(level).toLowerCase() as LogLevelName;
      if (!(LOG_LEVEL_NAMES as readonly string[]).includes(name)) {
        throw new Error(`invalid level "${String(level)}" for module "${module}"`);
      }
      out[module] = LEVEL_NAME_TO_ENUM[name];
    }
    return out;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[config] EAF_LOG_MODULE_LEVELS is not valid JSON module levels — ignoring it ` +
        `(using built-in defaults): ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

