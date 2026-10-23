/**
 * @vitest-environment node
 *
 * DevLoop R32 Lane C — production-readiness server hardening:
 *   - security headers on every response (helmet-equivalent, no dependency)
 *   - response compression registered (@fastify/compress shipped with Lane
 *     C's ETag commit but was never wired into the app)
 *   - opt-in CORS allow-list (EAF_CORS_ORIGINS) with preflight
 *   - enriched /api/health (version, uptime, startedAt, worlds, LLM queue)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { makeTestApp, type TestAppContext } from './test-utils.js';

describe('R32-C: security headers on every response', () => {
  let ctx: TestAppContext;
  beforeEach(async () => {
    ctx = await makeTestApp();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('API responses carry the helmet-equivalent header set', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain('ws:');
    // HSTS stays OFF by default (only meaningful behind a TLS terminator).
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('R32-C: CORS is opt-in via EAF_CORS_ORIGINS', () => {
  it('no CORS headers and no interference when unconfigured (default)', async () => {
    const ctx = await makeTestApp();
    try {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { origin: 'https://partner.example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await ctx.cleanup();
    }
  });

  it('an allow-listed origin gets CORS headers; preflight answers 204', async () => {
    const ctx = await makeTestApp({
      corsOrigins: ['https://partner.example.com'],
    });
    try {
      const simple = await ctx.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { origin: 'https://partner.example.com' },
      });
      expect(simple.headers['access-control-allow-origin']).toBe('https://partner.example.com');
      expect(simple.headers['access-control-allow-credentials']).toBe('true');

      const pre = await ctx.app.inject({
        method: 'OPTIONS',
        url: '/api/simulations',
        headers: {
          origin: 'https://partner.example.com',
          'access-control-request-method': 'POST',
        },
      });
      expect(pre.statusCode).toBe(204);
      expect(pre.headers['access-control-allow-methods']).toContain('POST');
      expect(pre.headers['access-control-allow-headers']).toContain('Authorization');

      // A NON-listed origin gets nothing (no wildcard-with-credentials).
      const stranger = await ctx.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { origin: 'https://evil.example.com' },
      });
      expect(stranger.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('R32-C: enriched /api/health', () => {
  let ctx: TestAppContext;
  beforeEach(async () => {
    ctx = await makeTestApp();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('reports version, uptime, startedAt, worlds, and the LLM queue gauges', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    // Version from apps/server/package.json (semver-ish non-empty string).
    expect(typeof body.version).toBe('string');
    expect(body.version).toMatch(/\d+\.\d+\.\d+/);
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(typeof body.startedAt).toBe('string');
    expect(body.worlds.sims.running).toBe(0);
    expect(body.worlds.sims.byState).toBeTypeOf('object');
    // The same queue gauges /api/metrics exposes (all in-memory).
    expect(body.llmQueue).toMatchObject({
      active: expect.any(Number),
      queued: expect.any(Number),
      maxConcurrent: expect.any(Number),
    });
    expect(body.checks).toEqual({ database: 'ok' });
  });
});
