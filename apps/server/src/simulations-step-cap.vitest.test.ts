/**
 * Fix-42b: server-side step cap + liveness regression (routes/simulations).
 *
 * E2E 2026-08-15: one oversized `POST /simulations/:id/step` froze the whole
 * API for minutes (single-threaded event loop, no tick budget). The route now
 * rejects batches above EAF_MAX_STEP_TICKS (default 100) with an actionable
 * 422, and the engine yields between tick chunks — asserted here by probing
 * an unrelated endpoint WHILE a full-budget step is running.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildServer } from './server.js';
import { auth, createUserScenario, registerUser } from './test-utils.js';

function labScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Step Cap Lab' },
    zones: [
      { id: 'zone-a', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      {
        id: 'temp-sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
      {
        id: 'hvac-b',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'sensor-agent',
        name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
      },
      {
        id: 'actuator-agent',
        name: 'Actuator Agent',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-b'],
        boundDeviceIds: ['hvac-b'],
      },
    ],
    events: [],
  };
}

describe('Fix-42b: step request cap', () => {
  let app: FastifyInstance;
  let userDir: string;
  let trajectoryDir: string;
  let simId: string;
  // Fix-47: lifecycle ops require the creator (or env owner/builder/admin) —
  // the step calls below authenticate as the sim's creator.
  let creatorToken: string;

  afterEach(async () => {
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
    rmSync(trajectoryDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'step-cap-store-'));
    trajectoryDir = mkdtempSync(join(tmpdir(), 'step-cap-traj-'));
    app = await buildServer({ userDir, trajectoryDir, logger: false, databasePath: ':memory:' });
    const token = (await registerUser(app)).token;
    creatorToken = token;
    const upload = await createUserScenario(app, labScenario('step-cap-lab'), token);
    expect(upload.statusCode).toBe(201);
    const created = await app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(token),
      payload: { scenarioId: 'step-cap-lab' },
    });
    expect(created.statusCode).toBe(201);
    simId = created.json().id;
  });

  it('rejects n above the cap with an actionable 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/step`,
      headers: auth(creatorToken),
      payload: { n: 1_000_000 },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('STEP_TOO_LARGE');
    expect(body.error.message).toContain('600');
    expect(body.error.message).toContain('chunk');
  });

  it('applies the same cap to toSimTimeSec-derived tick counts', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/step`,
      headers: auth(creatorToken),
      payload: { toSimTimeSec: 999_999 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('STEP_TOO_LARGE');
  });

  it('steps normally within the cap', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/step`,
      headers: auth(creatorToken),
      payload: { n: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().simTimeSec).toBe(3);
  });

  it(
    'keeps unrelated API traffic responsive while a full-budget step runs (Fix-42a liveness regression)',
    async () => {
      // Fire a full-budget step (100 ticks) without awaiting it, then probe
      // an unrelated endpoint. With the engine yielding between tick chunks
      // the probe interleaves; pre-fix, it waited for the entire step.
      const stepping = app.inject({
        method: 'POST',
        url: `/api/simulations/${simId}/step`,
        headers: auth(creatorToken),
        payload: { n: 100 },
      });
      const probeStartedAt = Date.now();
      const probe = await app.inject({ method: 'GET', url: '/api/auth/me' });
      const probeMs = Date.now() - probeStartedAt;
      expect(probe.statusCode).toBe(401); // anonymous probe — alive and answered
      // Generous bound: catches the minutes-class freeze, not jitter.
      expect(probeMs).toBeLessThan(2000);
      const done = await stepping;
      expect(done.statusCode).toBe(200);
      expect(done.json().simTimeSec).toBe(100);
    },
    20_000,
  );
});
