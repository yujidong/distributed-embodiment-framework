/**
 * LLM backend liveness probe (R74) — the truth source for the platform's
 * DECISION POSTURE. Config presence alone lies: a server with LLM_BASE_URL
 * set but a dead vLLM reports "production" while every decision actually
 * degrades to the rule harness (rule-llm-down). The probe answers the only
 * question that matters: is the configured backend answering RIGHT NOW?
 *
 * Design: one background timer (30s) while the LLM is configured; the probe
 * is a cheap GET /v1/models with a short timeout — never an inference call.
 * Failures need `failureThreshold` consecutive misses to flip the posture
 * (a single blip during vLLM startup must not flap the banner); a single
 * success flips it back immediately.
 */

import { createLogger } from '@active-collaboration/shared';
import { formatModelRoute, type LlmModelRoutes } from '@active-collaboration/llm-integration';

const logger = createLogger('LlmLiveness');

/**
 * R74: the decision-posture wire shape. Lives HERE (infra) not in routes/ —
 * the import direction guard requires low layers never reach into routes.
 */
export interface DecisionMode {
  mode: 'llm' | 'llm-unreachable' | 'rule-test';
  /** The served model name (configured LLM, any liveness state). */
  model?: string;
  /**
   * Per-function model routing summary (LLM_DECISION_MODEL / LLM_EVAL_MODEL
   * / LLM_NL_MODEL), each in its canonical `model` or `model@baseURL` form.
   * Absent when no routes are configured.
   */
  routes?: { decision?: string; eval?: string; nl?: string };
  /** The boot-time teaching message naming the missing LLM knobs. */
  unconfiguredReason?: string;
  /** Liveness detail when the configured backend is not answering. */
  unreachableDetail?: string;
}

/**
 * The R74 posture resolver — config presence + RUNTIME liveness, never
 * config alone. A configured-but-unreachable backend is 'llm-unreachable'
 * (the server is degrading to the rule harness per decision; that must be
 * loud, not dressed up as production). Until the first probe lands
 * (reachable === null) a configured backend optimistically reads 'llm' —
 * the probe cadence (30s, immediate first probe) closes that window fast.
 */
export function resolveDecisionMode(
  config: {
    llmBaseUrl?: string;
    llmModel?: string;
    llmUnconfiguredWarning?: string;
    llmRoutes?: LlmModelRoutes;
  },
  liveness?: LlmLivenessSnapshot,
): DecisionMode {
  // Per-function routing summary rides every posture — the route table is
  // config truth, independent of backend liveness.
  const routes = config.llmRoutes !== undefined
    ? Object.fromEntries(
        Object.entries(config.llmRoutes).map(([slot, route]) => [slot, formatModelRoute(route)]),
      ) as { decision?: string; eval?: string; nl?: string }
    : undefined;
  const routesPart = routes !== undefined && Object.keys(routes).length > 0 ? { routes } : {};
  const configured = config.llmBaseUrl !== undefined && config.llmModel !== undefined;
  if (!configured) {
    return {
      mode: 'rule-test',
      ...routesPart,
      ...(config.llmUnconfiguredWarning !== undefined
        ? { unconfiguredReason: config.llmUnconfiguredWarning }
        : {}),
    };
  }
  if (liveness?.reachable === false) {
    return {
      mode: 'llm-unreachable',
      model: config.llmModel,
      ...routesPart,
      unreachableDetail: liveness.lastError ?? 'backend not answering',
    };
  }
  return { mode: 'llm', model: config.llmModel, ...routesPart };
}

export interface LlmLivenessConfig {
  baseURL: string;
  apiKey?: string;
  /** Poll interval ms (default 30_000). */
  intervalMs?: number;
  /** Per-probe timeout ms (default 2_500 — liveness, not inference). */
  timeoutMs?: number;
  /** Consecutive failures before reachable=false (default 2). */
  failureThreshold?: number;
}

export interface LlmLivenessSnapshot {
  /** true = backend answered; false = failing; null = no probe result yet. */
  reachable: boolean | null;
  checkedAtMs: number | null;
  /** Last successful probe latency (ms). */
  latencyMs: number | null;
  consecutiveFailures: number;
  /** Last error message (failing posture detail). */
  lastError?: string;
}

const INITIAL: LlmLivenessSnapshot = {
  reachable: null,
  checkedAtMs: null,
  latencyMs: null,
  consecutiveFailures: 0,
};

export class LlmLivenessProbe {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private snap: LlmLivenessSnapshot = { ...INITIAL };
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly failureThreshold: number;

  constructor(private readonly config: LlmLivenessConfig) {
    this.intervalMs = config.intervalMs ?? 30_000;
    this.timeoutMs = config.timeoutMs ?? 2_500;
    this.failureThreshold = config.failureThreshold ?? 2;
  }

  /** Fire the first probe and start the poll loop. Never throws. */
  start(): void {
    if (this.timer !== null) return;
    void this.probe();
    this.timer = setInterval(() => void this.probe(), this.intervalMs);
    // The poll loop must never hold the process open on shutdown.
    this.timer.unref?.();
    logger.info(`probing ${this.config.baseURL}/models every ${Math.round(this.intervalMs / 1000)}s`);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  snapshot(): LlmLivenessSnapshot {
    return this.snap;
  }

  private async probe(): Promise<void> {
    if (this.inFlight) return; // a hung probe must not pile up
    this.inFlight = true;
    const startedAt = Date.now();
    try {
      const response = await fetch(`${this.config.baseURL}/models`, {
        method: 'GET',
        headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.snap = {
        reachable: true,
        checkedAtMs: Date.now(),
        latencyMs: Date.now() - startedAt,
        consecutiveFailures: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failures = this.snap.consecutiveFailures + 1;
      this.snap = {
        ...this.snap,
        reachable: failures >= this.failureThreshold ? false : this.snap.reachable,
        checkedAtMs: Date.now(),
        consecutiveFailures: failures,
        lastError: message,
      };
      if (failures === this.failureThreshold) {
        logger.warn(`LLM backend UNREACHABLE (${failures} consecutive failures): ${message}`);
      }
    } finally {
      this.inFlight = false;
    }
  }
}
