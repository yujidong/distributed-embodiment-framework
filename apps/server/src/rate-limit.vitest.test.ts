/**
 * @vitest-environment node
 *
 * Rate limiting tests (P4-4): the fixed-window RateLimiter unit behavior
 * (windows, per-class limits, retryAfterSec, IP×class keying), the request
 * classifier, the 429 wire shape (`{error:{code:'RATE_LIMITED',
 * retryAfterSec}}` + Retry-After header), and the disable flag the rest of
 * the suite relies on (test-utils.ts runs with rateLimitEnabled:false).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyRequest, RateLimiter } from './rate-limit.js';
import { auth, makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

const LIMITS = { enabled: true, authPerMin: 2, sessionPerMin: 4, writePerMin: 3, globalPerMin: 5 };

describe('RateLimiter (unit)', () => {
  it('allows up to the class limit, then blocks with a retryAfterSec inside the window', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(LIMITS, () => now);

    expect(limiter.check('1.2.3.4', 'auth')).toEqual({ allowed: true });
    expect(limiter.check('1.2.3.4', 'auth')).toEqual({ allowed: true });
    const blocked = limiter.check('1.2.3.4', 'auth');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(60); // window started at t=0 of the 60s window

    now += 30_000; // mid-window: still blocked, retryAfter shrinks
    const midWindow = limiter.check('1.2.3.4', 'auth');
    expect(midWindow.allowed).toBe(false);
    expect(midWindow.retryAfterSec).toBe(30);
  });

  it('resets the counter when the fixed window rolls over', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(LIMITS, () => now);
    limiter.check('1.2.3.4', 'auth');
    limiter.check('1.2.3.4', 'auth');
    expect(limiter.check('1.2.3.4', 'auth').allowed).toBe(false);

    now += 61_000;
    expect(limiter.check('1.2.3.4', 'auth')).toEqual({ allowed: true });
  });

  it('keys windows per IP × route class, and classes have their own limits', () => {
    const limiter = new RateLimiter(LIMITS, () => 1_000_000);
    // Exhaust the auth limit for one IP…
    limiter.check('1.2.3.4', 'auth');
    limiter.check('1.2.3.4', 'auth');
    expect(limiter.check('1.2.3.4', 'auth').allowed).toBe(false);
    // …another class on the same IP is unaffected…
    expect(limiter.check('1.2.3.4', 'global').allowed).toBe(true);
    // …and the same class on another IP is unaffected.
    expect(limiter.check('5.6.7.8', 'auth').allowed).toBe(true);
    // Write class allows its own (higher) count.
    expect(limiter.check('1.2.3.4', 'write').allowed).toBe(true);
    limiter.check('1.2.3.4', 'write');
    limiter.check('1.2.3.4', 'write');
    expect(limiter.check('1.2.3.4', 'write').allowed).toBe(false);
  });

  it('session bucket (R76-F1): /auth/me is independent of — and looser than — auth', () => {
    const limiter = new RateLimiter(LIMITS, () => 1_000_000);
    // Exhaust the auth limit for one IP…
    limiter.check('1.2.3.4', 'auth');
    limiter.check('1.2.3.4', 'auth');
    expect(limiter.check('1.2.3.4', 'auth').allowed).toBe(false);
    // …the session read still passes (page loads must not 429).
    expect(limiter.check('1.2.3.4', 'session').allowed).toBe(true);
    // The session bucket allows its own (higher) count…
    limiter.check('1.2.3.4', 'session');
    limiter.check('1.2.3.4', 'session');
    limiter.check('1.2.3.4', 'session');
    expect(limiter.check('1.2.3.4', 'session').allowed).toBe(false);
    // …and windows stay keyed per IP.
    expect(limiter.check('5.6.7.8', 'session').allowed).toBe(true);
  });
});

describe('classifyRequest', () => {
  it('maps auth endpoints, heavy writes, and the global fallback', () => {
    expect(classifyRequest('POST', '/api/auth/login')).toBe('auth');
    expect(classifyRequest('POST', '/api/auth/register')).toBe('auth');
    // R76-F1: the session-state read is its own class…
    expect(classifyRequest('GET', '/api/auth/me')).toBe('session');
    // …but only as a read — other /api/auth/* stays in the auth bucket.
    expect(classifyRequest('POST', '/api/auth/logout')).toBe('auth');
    expect(classifyRequest('POST', '/api/simulations')).toBe('write');
    expect(classifyRequest('POST', '/api/environments/env-1/devices')).toBe('write');
    expect(classifyRequest('POST', '/api/environments/env-1/devices:instantiate')).toBe('write');
    expect(classifyRequest('POST', '/api/environments/env-1/agents')).toBe('write');
    expect(classifyRequest('POST', '/api/environments/env-1/devices?x=1')).toBe('write');
    // Non-create methods/paths fall through to global.
    expect(classifyRequest('GET', '/api/simulations')).toBe('global');
    expect(classifyRequest('POST', '/api/environments')).toBe('global');
    expect(classifyRequest('PATCH', '/api/devices/dev-1')).toBe('global');
    expect(classifyRequest('GET', '/index.html')).toBe('global');
  });
});

describe('rate limiting over HTTP', () => {
  let ctx: TestAppContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('429s auth endpoints past the limit with the RATE_LIMITED shape + Retry-After', async () => {
    ctx = await makeTestApp({ rateLimitEnabled: true, rateLimitAuthPerMin: 3 });
    const hit = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'nobody@example.com', password: 'whatever-1' },
      });

    for (let i = 0; i < 3; i++) {
      expect((await hit()).statusCode).toBe(401); // bad credentials, but allowed through
    }
    const limited = await hit();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(limited.json().error.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(limited.json().error.retryAfterSec).toBeLessThanOrEqual(60);
    expect(Number(limited.headers['retry-after'])).toBe(limited.json().error.retryAfterSec);
  });

  it('session bucket over HTTP (R76-F1): a 429ed auth bucket never blocks GET /auth/me', async () => {
    ctx = await makeTestApp({ rateLimitEnabled: true, rateLimitAuthPerMin: 2, rateLimitSessionPerMin: 3 });
    const hit = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'nobody@example.com', password: 'whatever-1' },
      });
    const me = () => ctx.app.inject({ method: 'GET', url: '/api/auth/me' });

    expect((await hit()).statusCode).toBe(401);
    expect((await hit()).statusCode).toBe(401);
    expect((await hit()).statusCode).toBe(429); // auth bucket exhausted
    // The boot session restore rides its own looser bucket: 401, not 429.
    expect((await me()).statusCode).toBe(401);
    expect((await me()).statusCode).toBe(401);
    expect((await me()).statusCode).toBe(401);
    // …until its own limit trips — while login stays limited on its own.
    expect((await me()).statusCode).toBe(429);
  });

  it('429s heavy writes at the write limit while global traffic still passes', async () => {
    ctx = await makeTestApp({ rateLimitEnabled: true, rateLimitWritePerMin: 2, rateLimitGlobalPerMin: 100 });
    const user = await registerUser(ctx.app);
    const create = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/simulations',
        headers: auth(user.token),
        payload: { scenarioId: 'no-such-scenario' },
      });

    expect((await create()).statusCode).toBe(404); // quota/limit NOT hit; scenario missing
    expect((await create()).statusCode).toBe(404);
    const limited = await create();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');

    const other = await ctx.app.inject({ method: 'GET', url: '/api/scenarios' });
    expect(other.statusCode).toBe(200); // global class unaffected
  });

  it('disabled flag: no 429s at any volume (the default the rest of the suite uses)', async () => {
    ctx = await makeTestApp({ rateLimitEnabled: false, rateLimitAuthPerMin: 1 });
    for (let i = 0; i < 10; i++) {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(res.statusCode).toBe(401); // never 429
    }
  });
});
