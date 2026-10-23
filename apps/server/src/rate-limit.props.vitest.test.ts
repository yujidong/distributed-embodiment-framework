/**
 * @vitest-environment node
 *
 * Wave F2-1 (docs/plan-r84-verification-framework.md): fast-check property
 * tests for the rate limiter (apps/server/src/rate-limit.ts).
 *
 *   P1 classifier determinism + totality (R76-F1 taxonomy): for ANY method/
 *      path, classifyRequest returns one of the four classes, the same input
 *      always classifies the same, and the query string never changes the
 *      class. Structural rules hold for arbitrary ids/query: GET
 *      /api/auth/me → session, other /api/auth/* → auth, heavy POSTs →
 *      write, everything else → global.
 *   P2 bucket model equivalence: for ANY interleaved request sequence over
 *      arbitrary (class × key) pairs and arbitrary clock advances, the
 *      limiter's verdict equals a reference fixed-window model — which
 *      subsumes the Wave-A session-bucket split: exhausting the auth bucket
 *      can never touch the session bucket (the model keys per class).
 *   P3 R76-F1 regression: with the auth bucket fully spent, /me session
 *      reads stay allowed up to their own (looser) limit.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  RateLimiter,
  classifyRequest,
  type RateLimitClass,
  type RateLimitOptions,
  type RateLimitVerdict,
} from './rate-limit.js';

// ---------------------------------------------------------------------------
// P1 — classifier
// ---------------------------------------------------------------------------

const methodArb = fc.oneof(
  fc.constantFrom('GET', 'POST', 'PUT', 'DELETE', 'PATCH'),
  fc.string({ maxLength: 8 }),
);

const segmentArb = fc.string({
  unit: fc.constantFrom(...'abcdefghij0123456789-'.split('')),
  minLength: 1,
  maxLength: 10,
});

const pathArb: fc.Arbitrary<string> = fc.oneof(
  // Structured shapes the classifier special-cases.
  fc.constant('/api/auth/me'),
  fc.tuple(segmentArb).map(([s]) => `/api/auth/${s}`),
  fc.tuple(segmentArb, segmentArb).map(([a, b]) => `/api/auth/${a}/${b}`),
  fc.constant('/api/simulations'),
  fc.tuple(segmentArb, fc.constantFrom('devices', 'devices:instantiate', 'agents', 'state'))
    .map(([id, tail]) => `/api/environments/${id}/${tail}`),
  // Arbitrary paths.
  fc.array(segmentArb, { maxLength: 5 }).map(segs => `/${segs.join('/')}`),
  fc.string({ maxLength: 40 }),
);

const queryArb = fc.string({
  unit: fc.constantFrom(...'abc=&?0123'.split('')),
  maxLength: 20,
});

const CLASSES: readonly RateLimitClass[] = ['auth', 'session', 'write', 'global'];

describe('classifyRequest properties', () => {
  it('deterministic, total, and query-insensitive', () => {
    fc.assert(
      fc.property(methodArb, pathArb, queryArb, (method, path, query) => {
        const a = classifyRequest(method, path);
        const b = classifyRequest(method, path);
        expect(b).toBe(a);
        expect(CLASSES).toContain(a);
        expect(classifyRequest(method, `${path}?${query}`)).toBe(a);
      }),
      { numRuns: 300 },
    );
  });

  it('structural rules hold for arbitrary ids and queries', () => {
    fc.assert(
      fc.property(segmentArb, queryArb, (id, query) => {
        const q = query.length > 0 ? `?${query}` : '';
        // R76-F1: the session-state read has its own bucket.
        expect(classifyRequest('GET', `/api/auth/me${q}`)).toBe('session');
        // …but ONLY that exact read — POST /me and every other auth path are
        // the brute-force surface.
        expect(classifyRequest('POST', `/api/auth/me${q}`)).toBe('auth');
        expect(classifyRequest('GET', `/api/auth/${id}x${q}`)).toBe('auth');
        expect(classifyRequest('DELETE', `/api/auth/${id}${q}`)).toBe('auth');
        // Heavy writes.
        expect(classifyRequest('POST', `/api/simulations${q}`)).toBe('write');
        expect(classifyRequest('POST', `/api/environments/${id}/devices${q}`)).toBe('write');
        expect(classifyRequest('POST', `/api/environments/${id}/devices:instantiate${q}`)).toBe('write');
        expect(classifyRequest('POST', `/api/environments/${id}/agents${q}`)).toBe('write');
        // Reads of the same shapes are plain global traffic.
        expect(classifyRequest('GET', `/api/environments/${id}/devices${q}`)).toBe('global');
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// P2 — limiter vs reference fixed-window model
// ---------------------------------------------------------------------------

interface ModelWindow {
  start: number;
  count: number;
}

/** Reference implementation of the documented fixed-window semantics. */
class ModelLimiter {
  private readonly windows = new Map<string, ModelWindow>();
  now = 0;

  constructor(private readonly options: RateLimitOptions) {}

  check(key: string, routeClass: RateLimitClass): RateLimitVerdict {
    const limit = this.options[`${routeClass}PerMin`];
    const mapKey = `${routeClass}|${key}`;
    let window = this.windows.get(mapKey);
    if (window === undefined || this.now - window.start >= 60_000) {
      window = { start: this.now, count: 0 };
      this.windows.set(mapKey, window);
    }
    window.count += 1;
    if (window.count <= limit) return { allowed: true };
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((window.start + 60_000 - this.now) / 1000)),
    };
  }
}

interface LimitOp {
  advanceMs: number;
  cls: RateLimitClass;
  key: string;
}

const optionsArb: fc.Arbitrary<RateLimitOptions> = fc
  .tuple(
    fc.integer({ min: 1, max: 4 }),
    fc.integer({ min: 1, max: 4 }),
    fc.integer({ min: 1, max: 4 }),
    fc.integer({ min: 1, max: 4 }),
  )
  .map(([authPerMin, sessionPerMin, writePerMin, globalPerMin]) => ({
    enabled: true,
    authPerMin,
    sessionPerMin,
    writePerMin,
    globalPerMin,
  }));

const opsArb: fc.Arbitrary<LimitOp[]> = fc.array(
  fc.record({
    advanceMs: fc.integer({ min: 0, max: 70_000 }),
    cls: fc.constantFrom<RateLimitClass>('auth', 'session', 'write', 'global'),
    key: fc.constantFrom('1.1.1.1', '2.2.2.2', '::1'),
  }),
  { minLength: 1, maxLength: 40 },
);

describe('RateLimiter fixed-window properties', () => {
  it('any request sequence matches the reference model (bucket isolation included)', () => {
    fc.assert(
      fc.property(optionsArb, opsArb, (options, ops) => {
        let now = 0;
        const limiter = new RateLimiter(options, () => now);
        const model = new ModelLimiter(options);
        for (const op of ops) {
          now += op.advanceMs;
          model.now = now;
          const actual = limiter.check(op.key, op.cls);
          const expected = model.check(op.key, op.cls);
          expect(actual.allowed).toBe(expected.allowed);
          if (!expected.allowed) {
            expect(actual.retryAfterSec).toBe(expected.retryAfterSec);
            expect(actual.retryAfterSec!).toBeGreaterThanOrEqual(1);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('R76-F1 regression: a spent auth bucket never throttles the session bucket', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 2, max: 20 }),
        (authPerMin, authStorm) => {
          let now = 0;
          const limiter = new RateLimiter(
            { enabled: true, authPerMin, sessionPerMin: 300, writePerMin: 30, globalPerMin: 300 },
            () => now,
          );
          const ip = '9.9.9.9';
          const authVerdicts = Array.from({ length: authPerMin + authStorm }, () =>
            limiter.check(ip, classifyRequest('POST', '/api/auth/login')),
          );
          expect(authVerdicts.filter(v => v.allowed)).toHaveLength(authPerMin);
          expect(authVerdicts.filter(v => !v.allowed)).toHaveLength(authStorm);
          // The /me boot-restore reads keep flowing under their own bucket.
          for (let i = 0; i < 50; i++) {
            now += 100;
            expect(limiter.check(ip, classifyRequest('GET', '/api/auth/me')).allowed).toBe(true);
          }
          // …and auth is STILL spent (same fixed window).
          expect(limiter.check(ip, 'auth').allowed).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
