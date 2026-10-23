/**
 * Test utilities — shared fixtures for the vitest suites
 *
 * Excluded from the tsc build (tsconfig) — vitest-only.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildServer, type BuildServerOptions } from './server.js';

export interface TestAppContext {
  app: FastifyInstance;
  userDir: string;
  /** Temp per-simulation trajectory base dir (W8) — removed on cleanup. */
  trajectoryDir: string;
  cleanup: () => Promise<void>;
}

/**
 * buildServer for tests: suites assume no LLM backend
 * (environment-simulations asserts the unconfigured-LLM warning; the
 * proposal funnel escalates rather than auto-approves — see the
 * proposalReviewTimeoutAutoApprove default below). buildServer reads
 * process.env via loadConfig(), so an ambient LLM_BASE_URL (dev shell,
 * repo-root .env) would flip that behavior and make tests env-dependent —
 * scrub it for the build, then restore. Suites that want an LLM pass an
 * explicit `llmBaseUrl` override instead (e.g. the Fix-12 auto-approve
 * test points it at a dead port).
 */
export async function buildTestServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const ambientLlmBaseUrl = process.env.LLM_BASE_URL;
  const ambientLlmModel = process.env.LLM_MODEL;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  try {
    return await buildServer(options);
  } finally {
    if (ambientLlmBaseUrl !== undefined) {
      process.env.LLM_BASE_URL = ambientLlmBaseUrl;
    }
    if (ambientLlmModel !== undefined) {
      process.env.LLM_MODEL = ambientLlmModel;
    }
  }
}

/** Fresh server: temp scenario user-store + in-memory SQLite (seeded). */
export async function makeTestApp(overrides: BuildServerOptions = {}): Promise<TestAppContext> {
  const userDir = mkdtempSync(join(tmpdir(), 'eaf-test-'));
  // Keep per-sim trajectory capture (on by default since W8) out of the repo.
  const trajectoryDir = mkdtempSync(join(tmpdir(), 'eaf-traj-'));
  const app = await buildTestServer({
    userDir,
    trajectoryDir,
    logger: false,
    databasePath: ':memory:',
    // Default to a missing web dist (P3c) so suites are deterministic whether
    // or not apps/web/dist exists in the checkout; the static-web suite
    // passes an explicit fixture dist instead.
    webDist: join(userDir, 'no-web-dist'),
    // P4-4: rate limiting is OFF in tests by default (suites fire far more
    // than 300 requests per "IP"); the rate-limit suite opts back in with
    // explicit tiny limits. Production default stays enabled (config.ts).
    rateLimitEnabled: false,
    // Fix-45d: the no-LLM fallback reviewer now auto-approves low-risk
    // proposals in production (same policy as the review-timeout path).
    // Governance suites test the owner-decide lifecycle and want the pure
    // escalate funnel — default the policy OFF here; the rule-fallback suite
    // opts back in with an explicit `proposalReviewTimeoutAutoApprove: true`.
    proposalReviewTimeoutAutoApprove: false,
    ...overrides,
  });
  return {
    app,
    userDir,
    trajectoryDir,
    cleanup: async () => {
      await app.close();
      rmSync(userDir, { recursive: true, force: true });
      rmSync(trajectoryDir, { recursive: true, force: true });
    },
  };
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  displayName: string;
  token: string;
}

let userSeq = 0;

/** Register + login a fresh user; returns its Bearer token. */
export async function registerUser(
  app: FastifyInstance,
  overrides: { email?: string; password?: string; displayName?: string } = {},
): Promise<TestUser> {
  const n = ++userSeq;
  const email = overrides.email ?? `user-${Date.now()}-${n}@example.com`;
  const password = overrides.password ?? 'password-123';
  const displayName = overrides.displayName ?? `User ${n}`;

  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password, displayName },
  });
  if (registered.statusCode !== 201) {
    throw new Error(`register failed: ${registered.statusCode} ${registered.body}`);
  }
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  if (login.statusCode !== 200) {
    throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  }
  return {
    id: registered.json().id,
    email: email.toLowerCase(),
    password,
    displayName,
    token: login.json().token,
  };
}

/** Authorization header for a test user. */
export function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// Deterministic-wait helpers (DevLoop R21 test-debt: wall-clock sleep
// de-flake — see docs/testing-notes.md "flake registry" for the classes).
//
// RULE: never use a fixed `setTimeout(resolve, ms)` as a POSITIVE wait (the
// awaited effect may be slower than the guess under parallel load → flake);
// poll on an observable condition with `until` instead. A fixed window is
// only acceptable as a NEGATIVE window (proving something does NOT happen)
// via `settleWindow` — there is no positive signal for "never", so the
// window must be generously larger than the effect's worst-case latency.
// ---------------------------------------------------------------------------

/**
 * Poll every `intervalMs` until `predicate()` holds; resolves false on
 * timeout. The supported replacement for fixed positive waits.
 */
export async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

/**
 * Negative-window settle: await a bounded, deliberately GENEROUS window in
 * which a forbidden async effect must not land (class (b) — no positive
 * signal exists for "never happens"; a slow-but-present effect must still
 * be caught by the window, so err on the long side).
 */
export async function settleWindow(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait until at least `ms` wall time has elapsed since `startMs` (poll, so
 * the remainder is measured — not re-guessed). For past-grace assertions:
 * proving a timer (idle grace, TTL) did NOT fire requires really passing
 * that much wall time; measuring the remainder keeps the margin honest
 * under load instead of stacking fixed sleeps.
 */
export async function elapsedSince(startMs: number, ms: number, intervalMs = 25): Promise<void> {
  while (Date.now() - startMs < ms) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/**
 * POST a scenario to the legacy `/api/scenarios` store (deprecated write
 * path — requires auth since Fix-6). Registers a throwaway user when no
 * token is given. Returns the inject response.
 */
export async function createUserScenario(
  app: FastifyInstance,
  payload: unknown,
  token?: string,
) {
  const bearer = token ?? (await registerUser(app)).token;
  return app.inject({
    method: 'POST',
    url: '/api/scenarios',
    headers: auth(bearer),
    payload,
  });
}

/**
 * Two-zone scenario used as an environment-import fixture (mirrors the
 * simulation suite's lab scenario, plus a brand to prove it survives import).
 */
export function importableScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Importable Lab', description: 'imported by test' },
    zones: [
      { id: 'zone-a', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      {
        id: 'temp-sensor-a',
        name: 'Sensor A',
        type: 'temperature-sensor',
        brand: 'TestBrand',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
        initialState: { temperature: 20 },
      },
      {
        id: 'hvac-b',
        name: 'HVAC B',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'lab-agent',
        name: 'Lab Agent',
        capabilities: ['temperature-monitoring', 'temperature-control'],
        managesZoneIds: ['zone-a', 'zone-b'],
        boundDeviceIds: ['temp-sensor-a', 'hvac-b'],
      },
    ],
    events: [],
  };
}
