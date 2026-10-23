/**
 * @vitest-environment node
 *
 * Observability tests (P4-4): the MetricsCollector unit behavior (HTTP
 * counting, WS gauges with a floor at zero, the 20-entry error ring, LLM
 * token accumulation, chat instrumentation), the /api/metrics Prometheus
 * surface (required series present, request counts show up by route
 * class × status), and /api/admin/observability gating (ADMIN_EMAILS).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { instrumentLLMClient, MetricsCollector, metricsRouteClass } from './metrics.js';
import { auth, makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

describe('MetricsCollector (unit)', () => {
  it('counts requests by route class × status and sums 429s', () => {
    const metrics = new MetricsCollector();
    metrics.recordHttpRequest('auth', 200);
    metrics.recordHttpRequest('auth', 200);
    metrics.recordHttpRequest('auth', 429);
    metrics.recordHttpRequest('simulations', 201);

    expect(metrics.httpRequestCounts()).toEqual([
      { routeClass: 'auth', status: 200, count: 2 },
      { routeClass: 'auth', status: 429, count: 1 },
      { routeClass: 'simulations', status: 201, count: 1 },
    ]);
    expect(metrics.rateLimitedCount()).toBe(1);
  });

  it('tracks WS gauges with a floor of zero', () => {
    const metrics = new MetricsCollector();
    metrics.wsOpened('environment');
    metrics.wsOpened('environment');
    metrics.wsOpened('simulation');
    metrics.wsClosed('environment');
    metrics.wsClosed('environment');
    metrics.wsClosed('environment'); // over-close: stays at zero
    expect(metrics.wsConnections()).toEqual({ environment: 0, simulation: 1 });
  });

  it('keeps only the newest 20 errors, newest first', () => {
    const metrics = new MetricsCollector();
    for (let i = 0; i < 25; i++) {
      metrics.recordError({ method: 'GET', url: `/x/${i}`, statusCode: 500, code: 'E', message: `m${i}` });
    }
    const errors = metrics.recentErrors();
    expect(errors).toHaveLength(20);
    expect(errors[0]!.message).toBe('m24');
    expect(errors[19]!.message).toBe('m5');
    expect(errors[0]!.at).toBeTruthy();
  });

  it('accumulates LLM token usage', () => {
    const metrics = new MetricsCollector();
    metrics.recordLlmTokens({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    metrics.recordLlmTokens({ promptTokens: 3 }); // missing fields count as 0
    expect(metrics.llmTokenTotals()).toEqual({ prompt: 13, completion: 5, total: 18 });
  });

  it('summarizes LLM chat latency with bounded percentiles (R15-A3)', () => {
    const metrics = new MetricsCollector();
    // No calls yet: all zeros.
    expect(metrics.llmChatStats()).toEqual({
      calls: 0, errors: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0,
    });

    for (let i = 0; i < 100; i++) metrics.recordLlmChat(i, i % 10 !== 0); // every 10th fails
    const stats = metrics.llmChatStats();
    expect(stats.calls).toBe(100);
    expect(stats.errors).toBe(10);
    expect(stats.p50Ms).toBe(50);
    expect(stats.p95Ms).toBe(95);
    expect(stats.p99Ms).toBe(99);
    expect(stats.maxMs).toBe(99);
    expect(stats.avgMs).toBeGreaterThanOrEqual(49);
    expect(stats.avgMs).toBeLessThanOrEqual(50);
  });

  it('keeps the latency reservoir bounded', () => {
    const metrics = new MetricsCollector();
    for (let i = 0; i < 2000; i++) metrics.recordLlmChat(i, true);
    // Reservoir is 512 — the max must come from the newest entries, not i=1999
    // alone being dropped... (newest kept, oldest evicted).
    const stats = metrics.llmChatStats();
    expect(stats.calls).toBe(2000);
    expect(stats.maxMs).toBe(1999);
    expect(stats.p50Ms).toBeGreaterThanOrEqual(1488); // oldest retained ≈ 1488
  });

  it('instrumentLLMClient forwards chat() token usage to the sink', async () => {
    const seen: { promptTokens?: number; completionTokens?: number }[] = [];
    const fakeClient = {
      chat: async (_params: unknown) => ({
        content: 'ok',
        usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
      }),
    };
    // The helper only needs the chat method — cast around the full LLMClient type.
    instrumentLLMClient(fakeClient as never, usage => seen.push(usage));
    const response = await fakeClient.chat({});
    expect(response.content).toBe('ok');
    expect(seen).toEqual([{ promptTokens: 7, completionTokens: 2, totalTokens: 9 }]);
  });

  it('instrumentLLMClient reports latency for success and failure (R15-A3)', async () => {
    const latencies: Array<[number, boolean]> = [];
    let fail = false;
    const fakeClient = {
      chat: async (_params: unknown) => {
        if (fail) throw new Error('boom');
        return { content: 'ok', usage: {} };
      },
    };
    instrumentLLMClient(fakeClient as never, () => {}, (ms, ok) => latencies.push([ms, ok]));
    await fakeClient.chat({});
    fail = true;
    await expect(fakeClient.chat({})).rejects.toThrow('boom');
    expect(latencies).toHaveLength(2);
    expect(latencies[0]![1]).toBe(true);
    expect(latencies[1]![1]).toBe(false);
  });

  it('metricsRouteClass bounds label cardinality', () => {
    expect(metricsRouteClass('/api/auth/login')).toBe('auth');
    expect(metricsRouteClass('/api/simulations/sim-1/stream?x=1')).toBe('simulations');
    expect(metricsRouteClass('/api/admin/observability')).toBe('admin');
    expect(metricsRouteClass('/api/metrics')).toBe('metrics');
    expect(metricsRouteClass('/api/totally-unknown')).toBe('other');
    expect(metricsRouteClass('/')).toBe('web');
    expect(metricsRouteClass('/assets/index.js')).toBe('web');
  });
});

describe('observability endpoints', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    ctx = await makeTestApp({ adminEmails: ['admin@example.com'] });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('GET /api/health is public and reports liveness + db probe (R15-A3)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ database: 'ok' });
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    // R32-C: worlds/worlds.sims replace the flat sims field.
    expect(body.worlds.sims.running).toBe(0);
    expect(body.worlds.environments).toBeGreaterThanOrEqual(0);
    // R81-D2 (R44-dense-F4): the fast-lane (small-model) queue is observable
    // with the same field shape as the global lane — the dense tier routes
    // its whole decision load through it while llmQueue sat at zero.
    expect(body.llmQueue).toMatchObject({ active: expect.any(Number), queued: expect.any(Number) });
    expect(body.llmFastLaneQueue).toMatchObject({
      active: expect.any(Number),
      queued: expect.any(Number),
      maxConcurrent: expect.any(Number),
      waitCount: expect.any(Number),
    });
  });

  it('GET /api/metrics requires auth and exposes the required series', async () => {
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/metrics' });
    expect(anon.statusCode).toBe(401);

    const user = await registerUser(ctx.app);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/metrics',
      headers: auth(user.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const body = res.body;

    for (const required of [
      'eaf_process_uptime_seconds',
      'eaf_process_resident_memory_bytes',
      'eaf_process_heap_used_bytes',
      'eaf_http_requests_total',
      'eaf_ws_connections{kind="environment"}',
      'eaf_ws_connections{kind="simulation"}',
      'eaf_ws_subscribers',
      'eaf_simulations{state="created"}',
      'eaf_simulations{state="running"}',
      'eaf_simulations{state="paused"}',
      'eaf_simulations{state="stopped"}',
      'eaf_sim_auto_throttled',
      'eaf_sim_tick_wall_ms_max',
      'eaf_sim_tick_wall_ms_avg',
      'eaf_llm_tokens_total{kind="prompt"}',
      'eaf_llm_tokens_total{kind="completion"}',
      'eaf_llm_chat_calls_total',
      'eaf_llm_chat_errors_total',
      'eaf_llm_chat_duration_ms{quantile="p50"}',
      'eaf_llm_chat_duration_ms{quantile="p95"}',
      'eaf_llm_chat_duration_ms{quantile="p99"}',
      'eaf_llm_chat_duration_ms_avg',
      'eaf_llm_queue_depth',
      'eaf_llm_queue_active',
      'eaf_llm_queue_max_concurrent',
      'eaf_llm_fastlane_queue_depth',
      'eaf_llm_fastlane_queue_active',
      'eaf_llm_fastlane_queue_max_concurrent',
      'eaf_llm_cache_requests_total{result="hit"}',
      'eaf_llm_cache_requests_total{result="miss"}',
      'eaf_llm_cache_tokens_saved_total',
      'eaf_llm_triage_calls_total',
      'eaf_llm_triage_errors_total',
      'eaf_llm_triage_agreements_total',
      'eaf_llm_triage_disagreements_total',
      'eaf_llm_triage_big_model_calls_total',
      'eaf_llm_triage_big_model_calls_saved_total',
      'eaf_db_size_bytes',
      'eaf_users_registered',
      'eaf_environments',
      'eaf_devices',
      'eaf_agents',
    ]) {
      expect(body, `missing series: ${required}`).toContain(required);
    }

    // The register+login traffic is counted under route_class="auth".
    expect(body).toMatch(/eaf_http_requests_total\{route_class="auth",status="201"\} 1/);
    expect(body).toMatch(/eaf_http_requests_total\{route_class="auth",status="200"\} 1/);
    // At least the seeded system user exists.
    expect(body).toMatch(/eaf_users_registered [1-9]\d*/);
  });

  it('GET /api/admin/observability gates on ADMIN_EMAILS and returns the JSON summary', async () => {
    const admin = await registerUser(ctx.app, { email: 'admin@example.com' });
    const plain = await registerUser(ctx.app, { email: 'plain@example.com' });

    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/observability',
      headers: auth(plain.token),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('FORBIDDEN');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/observability',
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(body.startedAt).toBeTruthy();
    expect(body.process.rssBytes).toBeGreaterThan(0);
    expect(body.process.heapUsedBytes).toBeGreaterThan(0);
    expect(body.http.requestsTotal).toBeGreaterThan(0);
    expect(body.http.rateLimited).toBe(0);
    expect(body.websockets).toEqual({ environment: 0, simulation: 0, subscribers: 0 });
    expect(body.simulations).toEqual({ total: 0, byState: {} });
    expect(body.simRuntime).toMatchObject({ autoThrottledCount: 0, maxTickWallMs: 0, avgTickWallMs: 0, perSim: [] });
    expect(body.llm.tokens).toEqual({ prompt: 0, completion: 0, total: 0 });
    expect(body.llm.latency).toMatchObject({ calls: 0, errors: 0 });
    expect(body.llm.queue.maxConcurrent).toBeGreaterThanOrEqual(1);
    expect(body.llm.cache).toMatchObject({ hits: 0, misses: 0 });
    expect(body.db.sizeBytes).toBe(0); // :memory: database
    expect(body.counts.users).toBeGreaterThanOrEqual(3); // system + 2 registered
    expect(body.recentErrors).toEqual([]);
  });

  it('no ADMIN_EMAILS configured → nobody is an admin', async () => {
    await ctx.cleanup();
    ctx = await makeTestApp();
    const user = await registerUser(ctx.app);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/observability',
      headers: auth(user.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/admin/backup gates on admin, rejects :memory:, writes a real snapshot', async () => {
    await ctx.cleanup();
    ctx = await makeTestApp({ adminEmails: ['admin@example.com'] }); // :memory: db
    const anon = await ctx.app.inject({ method: 'POST', url: '/api/admin/backup' });
    expect(anon.statusCode).toBe(401);

    const plain = await registerUser(ctx.app, { email: 'plain@example.com' });
    const forbidden = await ctx.app.inject({
      method: 'POST', url: '/api/admin/backup', headers: auth(plain.token),
    });
    expect(forbidden.statusCode).toBe(403);

    const admin = await registerUser(ctx.app, { email: 'admin@example.com' });
    const memory = await ctx.app.inject({
      method: 'POST', url: '/api/admin/backup', headers: auth(admin.token),
    });
    expect(memory.statusCode).toBe(400);
    expect(memory.json().error.code).toBe('BACKUP_NOT_SUPPORTED');

    // File-backed database: a real, openable snapshot lands next to it.
    await ctx.cleanup();
    const dbDir = mkdtempSync(join(tmpdir(), 'eaf-backup-api-'));
    ctx = await makeTestApp({
      adminEmails: ['admin@example.com'],
      databasePath: join(dbDir, 'live.db'),
    });
    const fileAdmin = await registerUser(ctx.app, { email: 'admin@example.com' });
    const ok = await ctx.app.inject({
      method: 'POST', url: '/api/admin/backup', headers: auth(fileAdmin.token),
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.path).toContain(join(dbDir, 'backups'));
    expect(body.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(body.path)).toBe(true);
    await ctx.cleanup();
    rmSync(dbDir, { recursive: true, force: true });
  });
});
