/**
 * T-023 (DevLoop R17) — bounded event-injection route semantics.
 *
 * `POST /api/simulations/:id/events` bounds its agent-delivery wait by
 * EAF_EVENT_DELIVERY_DEADLINE_MS (default 10s, 0 disables): a sim whose
 * decisions are still pending answers 202 with `decisionPending: true`
 * (the physical write already applied) instead of holding the HTTP request
 * for the full multi-second LLM latency. Fast (rule-only) sims keep the
 * plain 200 + full result.
 *
 * The engine-side deadline logic is covered by core's
 * EngineRuntime.inject-deadline suite; this file pins the ROUTE contract:
 * option forwarding, the 202 branch, and the fast path staying 200.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildServer } from './server.js';
import { auth, createUserScenario, registerUser } from './test-utils.js';
import type { SimulationRegistry } from './simulation-registry.js';

function labScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Event Deadline Lab' },
    zones: [{ id: 'zone-a', adjacentZoneIds: [] }],
    devices: [
      {
        id: 'temp-sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
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
    ],
    events: [],
  };
}

describe('T-023: event injection delivery deadline', () => {
  let app: FastifyInstance;
  let userDir: string;
  let trajectoryDir: string;
  let simId: string;
  let creatorToken: string;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'event-deadline-store-'));
    trajectoryDir = mkdtempSync(join(tmpdir(), 'event-deadline-traj-'));
    app = await buildServer({ userDir, trajectoryDir, logger: false, databasePath: ':memory:' });
    const { token } = (await registerUser(app));
    creatorToken = token;
    const upload = await createUserScenario(app, labScenario('event-deadline-lab'), token);
    expect(upload.statusCode).toBe(201);
    const created = await app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(token),
      payload: { scenarioId: 'event-deadline-lab' },
    });
    expect(created.statusCode).toBe(201);
    simId = created.json().id;
  });

  afterEach(async () => {
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
    rmSync(trajectoryDir, { recursive: true, force: true });
  });

  function inject() {
    return app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: auth(creatorToken),
      payload: { type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 35 },
    });
  }

  it('fast (rule-only) delivery answers 200 with the full result, no decisionPending', async () => {
    const res = await inject();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.decisionPending).toBeUndefined();
    expect(body.parameter).toBe('temperature');
    expect(body.targetAgentIds).toEqual(['sensor-agent']);
  });

  it('a decision-pending delivery answers 202 with the same shape flagged decisionPending', async () => {
    // Route-contract pin: when the runtime reports decisionPending (the
    // engine deadline fired — behavior covered in core), the route must
    // reply 202 and forward the honest result verbatim.
    const registry = (app as unknown as { simulations: SimulationRegistry }).simulations;
    const record = registry.getOrThrow(simId);
    const realInject = record.runtime.injectEvent.bind(record.runtime);
    record.runtime.injectEvent = async (input, options) => {
      // The route must forward its configured bound (default 10s).
      expect(options?.deliveryDeadlineMs).toBe(10_000);
      const result = await realInject(input, { deliveryDeadlineMs: 0 });
      return { ...result, decisionPending: true };
    };
    try {
      const res = await inject();
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.decisionPending).toBe(true);
      expect(body.parameter).toBe('temperature');
      expect(typeof body.eventId).toBe('string');
    } finally {
      record.runtime.injectEvent = realInject;
    }
  });
});
