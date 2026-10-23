/**
 * LLM circuit breaker (R40-A5).
 *
 * Why: with a dead/absent LLM backend, every agent event waited out the
 * provider timeout (historically up to 120s on the local backend) racing
 * the caller's delivery deadline (~10s) before degrading — a gallery demo
 * measured 115 wall seconds to step 120 sim-seconds (R39 live probe). The
 * graceful rule fallback already exists (assessor `rule.llm_down`); what
 * was missing is FAST-FAIL so the second and later events skip the wait
 * entirely.
 *
 * Semantics (classic three-state):
 * - CLOSED: calls pass through. `threshold` consecutive failures open it.
 * - OPEN: calls reject immediately with LlmCircuitOpenError (non-transient
 *   by classification — the assessor's bounded retry must not backoff on it).
 * - HALF_OPEN: after `cooldownMs`, exactly ONE probe passes; success closes,
 *   failure re-opens for another cooldown.
 *
 * Caller-canceled requests (AbortError) never count — the caller gave up,
 * the backend is not thereby proven dead. Neither do CLIENT errors (4xx:
 * unknown model, bad request, auth) — the backend ANSWERED, so it is not
 * down; counting them let a stale per-agent model name (a config error)
 * open the breaker and degrade every LLM decision for a full cooldown
 * (P1 config-drift incident). Classification reuses isTransientLLMError:
 * only transient failures (network errors, 5xx, timeouts) count.
 *
 * One breaker per BACKEND (provider + baseURL), held in a module-level
 * registry: the decision client, the triage client and any later clients
 * on the same dead backend share the open state instead of each paying the
 * timeout price.
 */

import { isTransientLLMError } from './types.js';

const DEFAULT_THRESHOLD = 2;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;

/** Thrown while the breaker is OPEN — check {@link isCircuitOpenError}. */
export class LlmCircuitOpenError extends Error {
  readonly openMsRemaining: number;

  constructor(openMsRemaining: number, key: string) {
    super(
      `LLM backend "${key}" is circuit-open (degraded mode): ${Math.ceil(openMsRemaining / 1000)}s ` +
      'until the next health probe — failing fast so callers take their rule fallback now',
    );
    this.name = 'LlmCircuitOpenError';
    this.openMsRemaining = openMsRemaining;
  }
}

export function isCircuitOpenError(error: unknown): error is LlmCircuitOpenError {
  return error instanceof LlmCircuitOpenError;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening (default 2). */
  threshold?: number;
  /** Open duration before the half-open probe (default 5 minutes). */
  cooldownMs?: number;
}

type State = 'closed' | 'open' | 'half-open';

function isAbortError(error: unknown): boolean {
  // The raw AbortError (name check) — and its WRAPPED forms. The provider
  // rethrows a caller abort as LLMError("…aborted by the caller…", cause:
  // AbortError) and the request queue rejects a still-queued task with
  // "…aborted before dispatch (caller AbortSignal)"; both are the CALLER
  // giving up (evaluation/review budget), not backend evidence. Without the
  // chain walk the wrapper defeated this exemption and caller-side
  // timeouts counted as backend failures — two consecutive evaluation
  // timeouts would open the breaker for every caller on the backend
  // (R5-F10: a slow large model silently knocking the platform back to
  // rules is exactly what the breaker must not amplify).
  //
  // Timeout-vs-abort disambiguation (fault-injection 'slow LLM' row): an
  // AbortSignal.timeout budget fires with reason name 'TimeoutError' — the
  // caller's budget expired against a SLOW backend, which is precisely the
  // evidence the breaker exists to accumulate. Explicit controller.abort()
  // (reason 'AbortError') means the caller gave up deliberately and stays
  // exempt. The chain walk therefore checks TimeoutError BEFORE honoring
  // the AbortError/message links.
  let sawCallerAbortMessage = false;
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (current.name === 'TimeoutError') return false;
    if (current.name === 'AbortError') return true;
    if (/aborted by the caller|aborted before dispatch/i.test(current.message)) {
      sawCallerAbortMessage = true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return sawCallerAbortMessage;
}

export class LlmCircuitBreaker {
  private static readonly registry = new Map<string, LlmCircuitBreaker>();

  private state: State = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probing = false;

  private readonly threshold: number;
  private readonly cooldownMs: number;

  private constructor(options: CircuitBreakerOptions) {
    this.threshold = Math.max(1, options.threshold ?? DEFAULT_THRESHOLD);
    this.cooldownMs = Math.max(1, options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  }

  /** The singleton breaker for one backend key (provider + baseURL). */
  static for(key: string, options?: CircuitBreakerOptions): LlmCircuitBreaker {
    let breaker = LlmCircuitBreaker.registry.get(key);
    if (breaker === undefined) {
      breaker = new LlmCircuitBreaker(options ?? {});
      breaker.key = key;
      LlmCircuitBreaker.registry.set(key, breaker);
    }
    return breaker;
  }

  /** Test seam: drop every registered breaker. */
  static resetRegistry(): void {
    LlmCircuitBreaker.registry.clear();
  }

  private msRemaining(now: number): number {
    return this.state === 'open' ? Math.max(0, this.cooldownMs - (now - this.openedAt)) : 0;
  }

  /**
   * Run `fn` under the breaker. Fast-fails with LlmCircuitOpenError while
   * open (and while a half-open probe is in flight); counts successes,
   * backend failures and half-open probe outcomes.
   */
  async guard<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (this.state === 'open') {
      const remaining = this.msRemaining(now);
      if (remaining > 0) throw new LlmCircuitOpenError(remaining, this.describe());
      this.state = 'half-open';
      this.probing = true;
    } else if (this.state === 'half-open' && this.probing) {
      // Another caller's probe is already in flight — fail fast like open.
      throw new LlmCircuitOpenError(this.msRemaining(now) || 1, this.describe());
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      if (isAbortError(error)) {
        // Caller canceled: not a backend signal. An aborted half-open probe
        // is inconclusive — release the probe slot instead of wedging it.
        if (this.state === 'half-open') this.probing = false;
      } else if (isTransientLLMError(error)) {
        // Network error / 5xx / timeout — the backend failure signature.
        this.recordFailure();
      } else if (this.state === 'half-open' && this.probing) {
        // A PERMANENT error (4xx — unknown model, bad request) means the
        // backend ANSWERED: liveness is proven, close the breaker. The
        // client error itself still reaches the caller.
        this.recordSuccess();
      }
      // Permanent 4xx while CLOSED: not counted, breaker stays closed.
      throw error;
    }
  }

  private recordSuccess(): void {
    this.state = 'closed';
    this.probing = false;
    this.consecutiveFailures = 0;
  }

  private recordFailure(): void {
    if (this.state === 'half-open') {
      // The probe failed — re-open for another full cooldown.
      this.open();
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.threshold) this.open();
  }

  private open(): void {
    this.state = 'open';
    this.probing = false;
    this.openedAt = Date.now();
    this.consecutiveFailures = 0;
  }

  /** Registry key (retained for teaching-quality error messages). */
  private describe(): string {
    return this.key;
  }

  private key = '';
}
