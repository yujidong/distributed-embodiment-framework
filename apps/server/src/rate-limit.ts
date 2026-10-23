/**
 * Rate limiting (P4-4) — in-process fixed-window limiter, no dependencies
 *
 * One window per (client IP × route class), 60 s wide. Four classes:
 *
 * - `auth`   — credential endpoints under `/api/auth/*` (login/register/
 *              change-password/logout-all — the brute-force surface): default
 *              30 req/min (`RATE_LIMIT_AUTH_PER_MIN`; widened from 10 in
 *              Fix-13 — register→login bursts and office-NAT sharing must
 *              not trip it).
 * - `session`— read-only session-state endpoints (`GET /api/auth/me`): a
 *              separate, looser bucket (default 300 req/min,
 *              `RATE_LIMIT_SESSION_PER_MIN`). R76-F1: /me fires on every page
 *              load — sharing the auth bucket let concurrent users 429 each
 *              other's boot session restore, which the web client used to
 *              swallow as "logged out" (half-logged-in UI).
 * - `write`  — heavy writes: simulation create, device create (incl. catalog
 *              instantiate), agent create: default 30 req/min
 *              (`RATE_LIMIT_WRITE_PER_MIN`).
 * - `global` — everything else (including non-API/static traffic): default
 *              300 req/min (`RATE_LIMIT_GLOBAL_PER_MIN`).
 *
 * Over-limit requests get 429 `{ error: { code: 'RATE_LIMITED', retryAfterSec,
 * message } }` plus a `Retry-After` header. The limiter is per-process and
 * in-memory (state resets on restart) — sufficient for the single-process
 * deployment topology; a shared store is documented future work.
 *
 * Tests: the hook installs only when `config.rateLimitEnabled` is true
 * (`RATE_LIMIT_ENABLED=false` disables); the suite harness disables it by
 * default (test-utils.ts) and the rate-limit suite re-enables it with tiny
 * limits. `RateLimiter` takes an injectable clock so windows are testable
 * without sleeping.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type RateLimitClass = 'auth' | 'session' | 'write' | 'global';

export interface RateLimitOptions {
  enabled: boolean;
  authPerMin: number;
  sessionPerMin: number;
  writePerMin: number;
  globalPerMin: number;
}

const WINDOW_MS = 60_000;

interface Window {
  /** Epoch ms at which the current window started. */
  start: number;
  count: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the current window resets (only when blocked). */
  retryAfterSec?: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly options: RateLimitOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Consume one request for `key` (IP) in `routeClass`. Fixed window: the
   * counter resets 60 s after the first request of the window.
   */
  check(key: string, routeClass: RateLimitClass): RateLimitVerdict {
    const limit = this.limitFor(routeClass);
    const now = this.now();
    const mapKey = `${routeClass}|${key}`;
    let window = this.windows.get(mapKey);
    if (window === undefined || now - window.start >= WINDOW_MS) {
      window = { start: now, count: 0 };
      this.windows.set(mapKey, window);
    }
    window.count += 1;
    // Bound memory: windows live at most WINDOW_MS past their start.
    if (this.windows.size > 10_000) this.sweep(now);
    if (window.count <= limit) return { allowed: true };
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((window.start + WINDOW_MS - now) / 1000)),
    };
  }

  private limitFor(routeClass: RateLimitClass): number {
    switch (routeClass) {
      case 'auth':
        return this.options.authPerMin;
      case 'session':
        return this.options.sessionPerMin;
      case 'write':
        return this.options.writePerMin;
      case 'global':
        return this.options.globalPerMin;
    }
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= WINDOW_MS) this.windows.delete(key);
    }
  }
}

/**
 * Map a request onto its rate-limit class. Path-only — params are irrelevant
 * (`/api/environments/:id/devices` and `:instantiate` share the shape).
 */
export function classifyRequest(method: string, url: string): RateLimitClass {
  const path = url.split('?', 1)[0] ?? url;
  // R76-F1: the session-state read gets its own loose bucket — it fires on
  // every page load and must not compete with the brute-force auth bucket.
  if (path === '/api/auth/me' && method === 'GET') return 'session';
  if (path.startsWith('/api/auth/')) return 'auth';
  if (method === 'POST') {
    if (path === '/api/simulations') return 'write';
    if (/^\/api\/environments\/[^/]+\/(devices|devices:instantiate|agents)$/.test(path)) {
      return 'write';
    }
  }
  return 'global';
}

/**
 * Install the onRequest hook enforcing the limiter. Disabled config → no
 * hook at all (zero per-request cost), which is how the test harness runs.
 */
export function registerRateLimit(app: FastifyInstance, options: RateLimitOptions): void {
  if (!options.enabled) return;
  const limiter = new RateLimiter(options);
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const routeClass = classifyRequest(request.method, request.url);
    const verdict = limiter.check(request.ip, routeClass);
    if (verdict.allowed) return;
    const retryAfterSec = verdict.retryAfterSec ?? 60;
    return reply
      .code(429)
      .header('retry-after', String(retryAfterSec))
      .send({
        error: {
          code: 'RATE_LIMITED',
          message: `Rate limit exceeded for ${routeClass} requests — retry in ${retryAfterSec}s`,
          retryAfterSec,
        },
      });
  });
}
