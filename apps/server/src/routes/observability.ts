/**
 * Observability routes (P4-4, extended R15-A3) — metrics for machines and humans
 *
 * - `GET /api/health` (public, no auth) — liveness + a cheap database probe
 *   for container healthchecks. Deliberately minimal: no auth so orchestrators
 *   can poll it, no heavy assembly so it stays cheap under load.
 *
 * - `GET /api/metrics` (auth) — Prometheus text exposition format. Series:
 *
 *   | series | type | labels | source |
 *   |--------|------|--------|--------|
 *   | eaf_process_uptime_seconds | gauge | — | process start |
 *   | eaf_process_resident_memory_bytes | gauge | — | process.memoryUsage |
 *   | eaf_process_heap_used_bytes | gauge | — | process.memoryUsage |
 *   | eaf_http_requests_total | counter | route_class, status | onResponse hook |
 *   | eaf_ws_connections | gauge | kind (environment/simulation) | stream handlers |
 *   | eaf_ws_subscribers | gauge | — | WorldSync live listener count |
 *   | eaf_simulations | gauge | state (created/running/paused/stopped) | registry |
 *   | eaf_sim_auto_throttled | gauge | — | per-sim snapshots (running sims) |
 *   | eaf_sim_tick_wall_ms_max / _avg | gauge | — | per-sim snapshots |
 *   | eaf_llm_tokens_total | counter | kind (prompt/completion) | chat() instrumentation |
 *   | eaf_llm_chat_calls_total / _errors_total | counter | — | chat() instrumentation |
 *   | eaf_llm_chat_duration_ms | gauge | quantile (p50/p95/p99) + _avg/_max | latency reservoir |
 *   | eaf_llm_queue_depth / _active / _max_concurrent | gauge | — | global LLM request queue |
 *   | eaf_llm_fastlane_queue_depth / _active / _max_concurrent | gauge | — | fast-lane (small-model) LLM queue |
 *   | eaf_llm_cache_requests_total | counter | result (hit/miss) | shared P4-2 cache |
 *   | eaf_llm_cache_tokens_saved_total | counter | — | shared P4-2 cache estimate |
 *   | eaf_llm_triage_calls_total / _errors_total / _agreements_total /
 *     _disagreements_total / _big_model_calls_total /
 *     _big_model_calls_saved_total | counter | — | per-sim snapshots, summed |
 *   | eaf_db_size_bytes | gauge | — | database file size (0 for :memory:) |
 *   | eaf_users_registered / eaf_environments / eaf_devices / eaf_agents | gauge | — | table counts |
 *
 *   LLM token totals count tokens RETURNED by LLM clients, including
 *   cache-served responses (the cache's saved-tokens estimate approximates
 *   the subset no provider generated). LLM chat latency covers the full
 *   caller-visible duration — request-queue wait included.
 *
 * - `GET /api/admin/observability` (auth, ADMIN_EMAILS only) — the same data
 *   as one JSON document plus the per-simulation runtime health array
 *   (R15-A3) and the newest 20 server errors (5xx ring). 403 FORBIDDEN for
 *   non-admins. This is the payload behind the web console's 系统 card.
 */

import { statSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getFastLaneQueueStats, getLLMQueueStats } from '@active-collaboration/llm-integration';

import type { EnvironmentStore } from '../db/environment-store.js';
import type { UserStore } from '../db/user-store.js';
import { isAdminEmail } from '../auth/admin.js';
import { ApiError } from '../errors.js';
import type { MetricsCollector, RecentError } from '../metrics.js';
import type { SimulationRegistry } from '../simulation-registry.js';
import type { WorldSync } from '../world-sync.js';

/** R32-C: the server's package version (read once at module load). */
const SERVER_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

export interface ObservabilityRoutesContext {
  metrics: MetricsCollector;
  registry: SimulationRegistry;
  userStore: UserStore;
  envStore: EnvironmentStore;
  worldSync: WorldSync;
  /** SQLite file path (':memory:' in tests → db size reported as 0). */
  databasePath: string;
  /** Lowercase ADMIN_EMAILS — gates /api/admin/observability. */
  adminEmails: string[];
  /**
   * R74: the platform's DECISION POSTURE, resolved LIVE on every read from
   * config + LLM liveness. mode 'llm' = production posture (backend answers);
   * 'llm-unreachable' = configured but the backend is NOT answering (agents
   * are degrading to rules — posture is broken and must be loud);
   * 'rule-test' = the deterministic rule harness — explicitly a TEST-ONLY
   * posture (regression, training data, no-GPU demos), never a production
   * substitute. Surfaced on /api/health and the admin summary so no consumer
   * can mistake rule-driven behavior for production behavior.
   */
  decisionMode: () => DecisionMode;
  /** R80-FW3: capability-demand aggregation (the deployer's catalog-gap view). */
  capabilityDemand: {
    topDemand(limit?: number): Array<{
      capability: string; users: number; signals: number; sources: string;
      last_seen_at: string; catalogGap: boolean;
    }>;
  };
  /**
   * Alpha capacity gating (EAF_INVITE_ONLY, schema v57): surfaced on the
   * PUBLIC /api/health as auth.inviteOnly so the register form (and any API
   * consumer) learns whether an invite code is required before submitting.
   */
  inviteOnly: boolean;
}

// R74 wire shape lives in llm-liveness (infra) — re-exported here for the
// route consumers (import direction: routes → infra, never the reverse).
export type { DecisionMode } from '../llm-liveness.js';
import type { DecisionMode } from '../llm-liveness.js';

type HttpEntry = { routeClass: string; status: number; count: number };

/** Everything both endpoints report, assembled live from the sources. */
interface ObservabilitySummary {
  uptimeSec: number;
  startedAt: string;
  process: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number };
  http: {
    requestsTotal: number;
    entries: HttpEntry[];
    byRouteClass: Record<string, number>;
    byStatus: Record<string, number>;
    rateLimited: number;
  };
  websockets: { environment: number; simulation: number; subscribers: number };
  simulations: { total: number; byState: Record<string, number> };
  /** Per-sim runtime health (R15-A3) — JSON summary only, not per-sim Prometheus. */
  simRuntime: {
    autoThrottledCount: number;
    maxTickWallMs: number;
    avgTickWallMs: number;
    perSim: ReturnType<SimulationRegistry['runtimeHealth']>;
  };
  llm: {
    tokens: { prompt: number; completion: number; total: number };
    latency: ReturnType<MetricsCollector['llmChatStats']>;
    queue: { active: number; queued: number; maxConcurrent: number };
    /** R81-D2 (R44-dense-F4): the fast-lane (small-model) queue — same shape.
     *  plan-r84 Wave D: adaptive lanes also carry `adaptive: {min, max}`. */
    fastLaneQueue: ReturnType<typeof getFastLaneQueueStats>;
    cache: ReturnType<SimulationRegistry['llmCacheStats']>;
    triage: ReturnType<SimulationRegistry['triageTotals']>;
  };
  /** R74: decision posture (llm = production; rule-test = test-only harness). */
  decision: DecisionMode;
  /** R80-FW3: top demanded capabilities the catalog cannot supply yet. */
  capabilityDemand: Array<{
    capability: string; users: number; signals: number; sources: string;
    last_seen_at: string; catalogGap: boolean;
  }>;
  db: { sizeBytes: number };
  counts: { users: number; environments: number; devices: number; agents: number };
}

export function registerObservabilityRoutes(
  app: FastifyInstance,
  ctx: ObservabilityRoutesContext,
): void {
  // R15-A3: public liveness probe — orchestrators (docker-compose healthcheck,
  // k8s) need an unauthenticated, cheap endpoint that also proves the SQLite
  // handle still answers. R32-C: carries the deployment-identifying and
  // load-shaping facts too (version, LLM queue depth, world counts) so a
  // load balancer's decision and an operator's first curl see the same truth
  // /api/metrics would tell — still cheap (one COUNT + in-memory gauges).
  app.get('/api/health', async () => {
    let database: 'ok' | 'fail' = 'ok';
    try {
      ctx.userStore.count();
    } catch {
      database = 'fail';
    }
    const byState = ctx.registry.countsByState();
    const running = byState.running ?? 0;
    const totalSims = Object.values(byState).reduce((sum, n) => sum + n, 0);
    let environments = 0;
    try {
      environments = ctx.envStore.countAllEnvironments();
    } catch {
      environments = -1; // env store unreadable — liveness still reported
    }
    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      version: SERVER_VERSION,
      uptimeSec: Math.floor(ctx.metrics.uptimeSec()),
      startedAt: new Date(ctx.metrics.startedAtMs).toISOString(),
      worlds: { environments, sims: { total: totalSims, running, byState } },
      llmQueue: getLLMQueueStats(),
      // R81-D2 (R44-dense-F4): the fast-lane (small-model) queue gets the
      // same stats shape — the dense tier routes its whole decision load
      // through this lane while llmQueue sat at zero, making peak contention
      // look like an idle platform.
      llmFastLaneQueue: getFastLaneQueueStats(),
      // R74: public decision posture — 'rule-test' means every agent decision
      // on this server comes from the deterministic rule harness (a TEST-ONLY
      // posture), so no consumer mistakes it for production behavior.
      // 'llm-unreachable' = configured backend down; decisions are degrading.
      decision: (() => {
        const posture = ctx.decisionMode();
        return {
          mode: posture.mode,
          ...(posture.model !== undefined ? { model: posture.model } : {}),
          // UX-R2 (R2-FEAT-10): the console LLM chip shows the last probe
          // error in its tooltip when the backend is unreachable.
          ...(posture.unreachableDetail !== undefined
            ? { unreachableDetail: posture.unreachableDetail }
            : {}),
          // Per-function model routing summary (only when routes are
          // configured): which model/backend serves each call-site class.
          ...(posture.routes !== undefined ? { routes: posture.routes } : {}),
        };
      })(),
      checks: { database },
      // Alpha capacity gating: the register form reads this to decide whether
      // the invite-code field is required (EAF_INVITE_ONLY, schema v57).
      auth: { inviteOnly: ctx.inviteOnly },
    };
  });

  app.get('/api/metrics', { preHandler: app.authenticate }, async (_request, reply) => {
    return reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(renderPrometheus(collectSummary(ctx)));
  });

  app.get('/api/admin/observability', { preHandler: app.authenticate }, async request => {
    if (!isAdminEmail(request.user!.email, ctx.adminEmails)) {
      throw new ApiError(403, 'FORBIDDEN', 'Observability summary requires an admin account');
    }
    const summary = collectSummary(ctx);
    const recentErrors: RecentError[] = ctx.metrics.recentErrors();
    // `entries` is the Prometheus rendering detail — keep the JSON summary
    // at the byRouteClass/byStatus granularity humans actually read.
    const { http, ...rest } = summary;
    const { entries: _entries, ...httpSummary } = http;
    return { ...rest, http: httpSummary, recentErrors };
  });
}

/** Read every source and assemble the shared summary. */
function collectSummary(ctx: ObservabilityRoutesContext): ObservabilitySummary {
  const entries = ctx.metrics.httpRequestCounts();
  const byRouteClass: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let requestsTotal = 0;
  for (const entry of entries) {
    byRouteClass[entry.routeClass] = (byRouteClass[entry.routeClass] ?? 0) + entry.count;
    byStatus[String(entry.status)] = (byStatus[String(entry.status)] ?? 0) + entry.count;
    requestsTotal += entry.count;
  }

  const byState = ctx.registry.countsByState();
  const simTotal = Object.values(byState).reduce((sum, n) => sum + n, 0);

  const perSim = ctx.registry.runtimeHealth();
  const tickCosts = perSim
    .filter(sim => sim.state === 'running' && sim.tickWallMs !== undefined)
    .map(sim => sim.tickWallMs!);
  const autoThrottledCount = perSim.filter(sim => sim.state === 'running' && sim.autoThrottled).length;

  const memory = process.memoryUsage();

  return {
    uptimeSec: Math.floor(ctx.metrics.uptimeSec()),
    startedAt: new Date(ctx.metrics.startedAtMs).toISOString(),
    process: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
    },
    http: {
      requestsTotal,
      entries,
      byRouteClass,
      byStatus,
      rateLimited: ctx.metrics.rateLimitedCount(),
    },
    websockets: {
      ...ctx.metrics.wsConnections(),
      subscribers: ctx.worldSync.totalSubscribers(),
    },
    simulations: { total: simTotal, byState },
    simRuntime: {
      autoThrottledCount,
      maxTickWallMs: tickCosts.length > 0 ? Math.max(...tickCosts) : 0,
      avgTickWallMs: tickCosts.length > 0
        ? Math.round(tickCosts.reduce((sum, n) => sum + n, 0) / tickCosts.length)
        : 0,
      perSim,
    },
    llm: {
      tokens: ctx.metrics.llmTokenTotals(),
      latency: ctx.metrics.llmChatStats(),
      queue: getLLMQueueStats(),
      fastLaneQueue: getFastLaneQueueStats(),
      cache: ctx.registry.llmCacheStats(),
      triage: ctx.registry.triageTotals(),
    },
    decision: ctx.decisionMode(),
    capabilityDemand: ctx.capabilityDemand.topDemand(20),
    db: { sizeBytes: databaseSizeBytes(ctx.databasePath) },
    counts: {
      users: ctx.userStore.count(),
      environments: ctx.envStore.countAllEnvironments(),
      devices: ctx.envStore.countAllDevices(),
      agents: ctx.envStore.countAllAgents(),
    },
  };
}

function databaseSizeBytes(databasePath: string): number {
  if (databasePath === ':memory:') return 0;
  try {
    return statSync(databasePath).size;
  } catch {
    return 0; // file not created yet / unreadable — report 0 rather than fail
  }
}

// ---------------------------------------------------------------------------
// Prometheus text rendering (no dependencies — the exposition format is trivial)
// ---------------------------------------------------------------------------

interface PromSeries {
  help: string;
  type: 'counter' | 'gauge';
  name: string;
  value: number;
  labels?: Record<string, string>;
}

function renderPrometheus(summary: ObservabilitySummary): string {
  const series: PromSeries[] = [
    {
      help: 'Process uptime in seconds',
      type: 'gauge',
      name: 'eaf_process_uptime_seconds',
      value: summary.uptimeSec,
    },
    {
      help: 'Process resident set size in bytes',
      type: 'gauge',
      name: 'eaf_process_resident_memory_bytes',
      value: summary.process.rssBytes,
    },
    {
      help: 'V8 heap currently in use in bytes',
      type: 'gauge',
      name: 'eaf_process_heap_used_bytes',
      value: summary.process.heapUsedBytes,
    },
  ];

  for (const entry of summary.http.entries) {
    series.push({
      help: 'HTTP requests by route class and status',
      type: 'counter',
      name: 'eaf_http_requests_total',
      value: entry.count,
      labels: { route_class: entry.routeClass, status: String(entry.status) },
    });
  }

  for (const kind of ['environment', 'simulation'] as const) {
    series.push({
      help: 'Current WebSocket connections by channel kind',
      type: 'gauge',
      name: 'eaf_ws_connections',
      value: summary.websockets[kind],
      labels: { kind },
    });
  }

  series.push({
    help: 'Live environment-stream listeners across all channels (WorldSync)',
    type: 'gauge',
    name: 'eaf_ws_subscribers',
    value: summary.websockets.subscribers,
  });

  // R15-A3: per-run aggregate of the sim tick loop — per-sim detail (ids as
  // labels) would blow label cardinality, so only the aggregates are exposed
  // here; the admin JSON summary carries the full perSim array.
  series.push(
    {
      help: 'Running simulations whose tick loop is auto-throttled (degraded cadence)',
      type: 'gauge',
      name: 'eaf_sim_auto_throttled',
      value: summary.simRuntime.autoThrottledCount,
    },
    {
      help: 'Max wall-clock cost of the most recent tick across running simulations (ms)',
      type: 'gauge',
      name: 'eaf_sim_tick_wall_ms_max',
      value: summary.simRuntime.maxTickWallMs,
    },
    {
      help: 'Average wall-clock cost of the most recent tick across running simulations (ms)',
      type: 'gauge',
      name: 'eaf_sim_tick_wall_ms_avg',
      value: summary.simRuntime.avgTickWallMs,
    },
  );

  for (const state of ['created', 'running', 'paused', 'stopped'] as const) {
    series.push({
      help: 'Registered simulations by runtime state',
      type: 'gauge',
      name: 'eaf_simulations',
      value: summary.simulations.byState[state] ?? 0,
      labels: { state },
    });
  }

  series.push(
    {
      help: 'LLM tokens returned by clients (includes cache-served responses)',
      type: 'counter',
      name: 'eaf_llm_tokens_total',
      value: summary.llm.tokens.prompt,
      labels: { kind: 'prompt' },
    },
    {
      help: 'LLM tokens returned by clients (includes cache-served responses)',
      type: 'counter',
      name: 'eaf_llm_tokens_total',
      value: summary.llm.tokens.completion,
      labels: { kind: 'completion' },
    },
    {
      help: 'Shared LLM response-cache lookups by result',
      type: 'counter',
      name: 'eaf_llm_cache_requests_total',
      value: summary.llm.cache.hits,
      labels: { result: 'hit' },
    },
    {
      help: 'Shared LLM response-cache lookups by result',
      type: 'counter',
      name: 'eaf_llm_cache_requests_total',
      value: summary.llm.cache.misses,
      labels: { result: 'miss' },
    },
    {
      help: 'Estimated tokens the shared LLM cache saved (hits only)',
      type: 'counter',
      name: 'eaf_llm_cache_tokens_saved_total',
      value: summary.llm.cache.tokensSavedEstimate,
    },
    {
      help: 'LLM chat calls observed by server instrumentation (queue wait included)',
      type: 'counter',
      name: 'eaf_llm_chat_calls_total',
      value: summary.llm.latency.calls,
    },
    {
      help: 'LLM chat calls that failed (provider error or timeout)',
      type: 'counter',
      name: 'eaf_llm_chat_errors_total',
      value: summary.llm.latency.errors,
    },
    {
      help: 'LLM chat end-to-end duration over the recent-latency reservoir (ms)',
      type: 'gauge',
      name: 'eaf_llm_chat_duration_ms',
      value: summary.llm.latency.p50Ms,
      labels: { quantile: 'p50' },
    },
    {
      help: 'LLM chat end-to-end duration over the recent-latency reservoir (ms)',
      type: 'gauge',
      name: 'eaf_llm_chat_duration_ms',
      value: summary.llm.latency.p95Ms,
      labels: { quantile: 'p95' },
    },
    {
      help: 'LLM chat end-to-end duration over the recent-latency reservoir (ms)',
      type: 'gauge',
      name: 'eaf_llm_chat_duration_ms',
      value: summary.llm.latency.p99Ms,
      labels: { quantile: 'p99' },
    },
    {
      help: 'Average LLM chat end-to-end duration over the recent-latency reservoir (ms)',
      type: 'gauge',
      name: 'eaf_llm_chat_duration_ms_avg',
      value: summary.llm.latency.avgMs,
    },
    {
      help: 'Requests currently waiting in the global LLM queue',
      type: 'gauge',
      name: 'eaf_llm_queue_depth',
      value: summary.llm.queue.queued,
    },
    {
      help: 'Requests currently executing inside the global LLM queue',
      type: 'gauge',
      name: 'eaf_llm_queue_active',
      value: summary.llm.queue.active,
    },
    {
      help: 'Configured concurrency limit of the global LLM queue (LLM_MAX_CONCURRENT)',
      type: 'gauge',
      name: 'eaf_llm_queue_max_concurrent',
      value: summary.llm.queue.maxConcurrent,
    },
    {
      help: 'Requests currently waiting in the fast-lane (small-model) LLM queue',
      type: 'gauge',
      name: 'eaf_llm_fastlane_queue_depth',
      value: summary.llm.fastLaneQueue.queued,
    },
    {
      help: 'Requests currently executing inside the fast-lane (small-model) LLM queue',
      type: 'gauge',
      name: 'eaf_llm_fastlane_queue_active',
      value: summary.llm.fastLaneQueue.active,
    },
    {
      help: 'Current concurrency limit of the fast-lane LLM queue (adaptive within LLM_FAST_LANE_MIN/MAX unless pinned by LLM_FAST_LANE_CONCURRENT)',
      type: 'gauge',
      name: 'eaf_llm_fastlane_queue_max_concurrent',
      value: summary.llm.fastLaneQueue.maxConcurrent,
    },
    {
      help: 'Small-model triage calls across all simulations',
      type: 'counter',
      name: 'eaf_llm_triage_calls_total',
      value: summary.llm.triage.triageCalls,
    },
    {
      help: 'Small-model triage errors across all simulations',
      type: 'counter',
      name: 'eaf_llm_triage_errors_total',
      value: summary.llm.triage.triageErrors,
    },
    {
      help: 'Triage/big-model agreements across all simulations',
      type: 'counter',
      name: 'eaf_llm_triage_agreements_total',
      value: summary.llm.triage.agreements,
    },
    {
      help: 'Triage/big-model disagreements across all simulations',
      type: 'counter',
      name: 'eaf_llm_triage_disagreements_total',
      value: summary.llm.triage.disagreements,
    },
    {
      help: 'Big-model calls executed across all simulations',
      type: 'counter',
      name: 'eaf_llm_triage_big_model_calls_total',
      value: summary.llm.triage.bigModelCalls,
    },
    {
      help: 'Big-model calls skipped by trusted triage across all simulations',
      type: 'counter',
      name: 'eaf_llm_triage_big_model_calls_saved_total',
      value: summary.llm.triage.bigModelCallsSaved,
    },
    {
      help: 'SQLite database file size in bytes (0 for :memory:)',
      type: 'gauge',
      name: 'eaf_db_size_bytes',
      value: summary.db.sizeBytes,
    },
    {
      help: 'Registered user accounts',
      type: 'gauge',
      name: 'eaf_users_registered',
      value: summary.counts.users,
    },
    {
      help: 'Environment rows',
      type: 'gauge',
      name: 'eaf_environments',
      value: summary.counts.environments,
    },
    {
      help: 'Device instance rows',
      type: 'gauge',
      name: 'eaf_devices',
      value: summary.counts.devices,
    },
    {
      help: 'Agent instance rows',
      type: 'gauge',
      name: 'eaf_agents',
      value: summary.counts.agents,
    },
  );

  const emittedHelp = new Set<string>();
  const lines: string[] = [];
  for (const entry of series) {
    if (!emittedHelp.has(entry.name)) {
      emittedHelp.add(entry.name);
      lines.push(`# HELP ${entry.name} ${entry.help}`);
      lines.push(`# TYPE ${entry.name} ${entry.type}`);
    }
    const labels = entry.labels === undefined
      ? ''
      : `{${Object.entries(entry.labels).map(([key, value]) => `${key}="${value}"`).join(',')}}`;
    lines.push(`${entry.name}${labels} ${entry.value}`);
  }
  return lines.join('\n') + '\n';
}
