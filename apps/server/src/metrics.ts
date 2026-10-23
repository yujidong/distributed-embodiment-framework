/**
 * Metrics collector (P4-4) — tiny dependency-free counters behind
 * GET /api/metrics (Prometheus text) and GET /api/admin/observability (JSON)
 *
 * What lives here (process-lifetime, in-memory):
 * - HTTP request counts by route class × status (middleware hook in server.ts)
 * - current WebSocket connections per channel kind (environment / simulation)
 * - a 20-entry ring of recent 5xx errors (for the admin summary)
 * - cumulative LLM token usage (prompt/completion) fed by instrumenting the
 *   LLM clients the simulation registry builds
 * - LLM chat latency (R15-A3): call/error counters + a bounded reservoir of
 *   recent durations (queue wait + provider time, as observed by callers),
 *   rendered as avg/p50/p95/p99/max
 *
 * Everything else the endpoints report (uptime, sims by state, cache/triage
 * stats, DB size, row counts) is read live from its source at render time.
 * Deliberately NOT built: full histograms, per-route latency, external push.
 */

import type { LLMClient } from '@active-collaboration/llm-integration';

/** WebSocket channel kinds tracked as gauges. */
export type WsKind = 'environment' | 'simulation';

export interface RecentError {
  at: string;
  method: string;
  url: string;
  statusCode: number;
  code: string;
  message: string;
}

/** Structural subset of the LLM client's TokenUsage (all fields optional). */
export interface LlmTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

const ERROR_RING_SIZE = 20;

/**
 * Bounded reservoir of recent LLM chat durations (R15-A3). Latency
 * attribution only needs the tail of the distribution; a full histogram
 * would be overkill for p50/p95/p99 rendering.
 */
const LLM_LATENCY_RESERVOIR = 512;

/**
 * Bounded label set for the route-class dimension: the second /api segment
 * when recognized, else 'other'; non-API (static web console) is 'web'.
 */
const KNOWN_ROUTE_CLASSES = new Set([
  'auth',
  'environments',
  'devices',
  'agents',
  'services',
  'catalog',
  'me',
  'proposals',
  'sandboxes',
  'simulations',
  'scenarios',
  'hass',
  'metrics',
  'health',
  'admin',
  'docs',
  'openapi.yaml',
]);

/** Map a request URL onto its metrics route class (label cardinality is bounded). */
export function metricsRouteClass(url: string): string {
  const path = url.split('?', 1)[0] ?? url;
  const segments = path.split('/').filter(segment => segment.length > 0);
  if (segments[0] !== 'api') return 'web';
  const segment = segments[1];
  if (segment === undefined) return 'api';
  return KNOWN_ROUTE_CLASSES.has(segment) ? segment : 'other';
}

export class MetricsCollector {
  readonly startedAtMs: number;
  private readonly httpRequests = new Map<string, number>();
  private readonly ws = new Map<WsKind, number>([
    ['environment', 0],
    ['simulation', 0],
  ]);
  private readonly errors: RecentError[] = [];
  private llmPromptTokens = 0;
  private llmCompletionTokens = 0;
  private llmChatCalls = 0;
  private llmChatErrors = 0;
  private readonly llmLatencies: number[] = [];

  constructor(now: () => number = Date.now) {
    this.startedAtMs = now();
  }

  uptimeSec(): number {
    return (Date.now() - this.startedAtMs) / 1000;
  }

  // ------------------------------------------------------------------ HTTP

  recordHttpRequest(routeClass: string, status: number): void {
    const key = `${routeClass}|${status}`;
    this.httpRequests.set(key, (this.httpRequests.get(key) ?? 0) + 1);
  }

  /** Flat snapshot: `{ routeClass, status, count }` entries, stable order. */
  httpRequestCounts(): { routeClass: string; status: number; count: number }[] {
    return [...this.httpRequests.entries()]
      .map(([key, count]) => {
        const [routeClass, status] = key.split('|');
        return { routeClass: routeClass ?? 'other', status: Number(status), count };
      })
      .sort((a, b) =>
        a.routeClass === b.routeClass ? a.status - b.status : a.routeClass < b.routeClass ? -1 : 1,
      );
  }

  /** Total requests that ended 429 (rate limited) — surfaced on the admin card. */
  rateLimitedCount(): number {
    return this.httpRequestCounts()
      .filter(entry => entry.status === 429)
      .reduce((sum, entry) => sum + entry.count, 0);
  }

  // ------------------------------------------------------------- WebSockets

  wsOpened(kind: WsKind): void {
    this.ws.set(kind, (this.ws.get(kind) ?? 0) + 1);
  }

  wsClosed(kind: WsKind): void {
    this.ws.set(kind, Math.max(0, (this.ws.get(kind) ?? 0) - 1));
  }

  wsConnections(): Record<WsKind, number> {
    return { environment: this.ws.get('environment') ?? 0, simulation: this.ws.get('simulation') ?? 0 };
  }

  // ----------------------------------------------------------------- errors

  /** Record a server error (5xx); the ring keeps the newest 20, newest first. */
  recordError(entry: Omit<RecentError, 'at'>): void {
    this.errors.unshift({ at: new Date().toISOString(), ...entry });
    if (this.errors.length > ERROR_RING_SIZE) this.errors.length = ERROR_RING_SIZE;
  }

  recentErrors(): RecentError[] {
    return [...this.errors];
  }

  // -------------------------------------------------------------------- LLM

  /**
   * Accumulate token usage of one completed chat call. NB: cache-served
   * responses carry the cached entry's usage, so these totals count tokens
   * RETURNED to callers — the cache's tokensSavedEstimate approximates the
   * subset no provider had to generate.
   */
  recordLlmTokens(usage: LlmTokenUsage): void {
    this.llmPromptTokens += usage.promptTokens ?? 0;
    this.llmCompletionTokens += usage.completionTokens ?? 0;
  }

  llmTokenTotals(): { prompt: number; completion: number; total: number } {
    return {
      prompt: this.llmPromptTokens,
      completion: this.llmCompletionTokens,
      total: this.llmPromptTokens + this.llmCompletionTokens,
    };
  }

  /**
   * Record one completed chat call (R15-A3). `durationMs` is the end-to-end
   * wall time the caller observed — request-queue wait included — which is
   * exactly the number latency triage (C3) needs to attribute.
   */
  recordLlmChat(durationMs: number, success: boolean): void {
    this.llmChatCalls += 1;
    if (!success) this.llmChatErrors += 1;
    this.llmLatencies.push(Math.max(0, Math.round(durationMs)));
    if (this.llmLatencies.length > LLM_LATENCY_RESERVOIR) {
      this.llmLatencies.splice(0, this.llmLatencies.length - LLM_LATENCY_RESERVOIR);
    }
  }

  /** Latency summary over the reservoir; all zeros before the first call. */
  llmChatStats(): {
    calls: number;
    errors: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  } {
    if (this.llmLatencies.length === 0) {
      return { calls: this.llmChatCalls, errors: this.llmChatErrors, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
    }
    const sorted = [...this.llmLatencies].sort((a, b) => a - b);
    const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    return {
      calls: this.llmChatCalls,
      errors: this.llmChatErrors,
      avgMs: Math.round(sorted.reduce((sum, n) => sum + n, 0) / sorted.length),
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      p99Ms: at(0.99),
      maxMs: sorted[sorted.length - 1]!,
    };
  }
}

/**
 * Wrap an LLMClient's `chat()` so every completed call's token usage and
 * latency flow into `sink` (P4-4 + R15-A3). `quickChat()` delegates to
 * `chat`, so one wrap covers both. Instance-level monkey-patch: the engine
 * keeps its own `setLoggingCallback` wiring (trajectory recorder) untouched.
 */
export function instrumentLLMClient(
  client: LLMClient,
  sink: (usage: LlmTokenUsage) => void,
  latencySink?: (durationMs: number, success: boolean) => void,
): void {
  const originalChat = client.chat.bind(client);
  client.chat = async (params: Parameters<LLMClient['chat']>[0]): ReturnType<LLMClient['chat']> => {
    const startedAt = Date.now();
    try {
      const response = await originalChat(params);
      sink(response.usage ?? {});
      latencySink?.(Date.now() - startedAt, true);
      return response;
    } catch (error) {
      latencySink?.(Date.now() - startedAt, false);
      throw error;
    }
  };
}
