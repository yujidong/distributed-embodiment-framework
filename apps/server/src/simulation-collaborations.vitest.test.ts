/**
 * @vitest-environment node
 *
 * `GET /api/simulations/:id/collaborations` (Fix-8) — the AC collaboration
 * query endpoint. Server-side sims run rule-only in tests (no LLM backend), and
 * rule-only agents never initiate AC execution, so the honest coverage here
 * is the endpoint plumbing: shape, filters, 404. Row content (pending →
 * accepted → executed) is covered by packages/core's ac-handshake e2e.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CollaborationPriority, type CollaborationManager } from '@active-collaboration/core';

import { buildServer } from './server.js';
import { createUserScenario } from './test-utils.js';

function labScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Collaborations Lab' },
    zones: [{ id: 'zone-a' }],
    devices: [
      {
        id: 'temp-sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
      {
        id: 'hvac-a',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
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
      {
        id: 'actuator-agent',
        name: 'Actuator Agent',
        capabilities: ['temperature-control', 'cooling'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['hvac-a'],
      },
    ],
    events: [],
  };
}

describe('GET /api/simulations/:id/collaborations (Fix-8)', () => {
  let app: FastifyInstance;
  let userDir: string;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'sim-collab-store-'));
    app = await buildServer({ userDir, logger: false, databasePath: ':memory:' });
    const res = await createUserScenario(app, labScenario('sim-lab'));
    expect(res.statusCode).toBe(201);
  });

  afterEach(async () => {
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
  });

  async function createSimulation(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'sim-lab' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  it('returns an empty collaboration list for a fresh simulation', async () => {
    const id = await createSimulation();

    const res = await app.inject({ method: 'GET', url: `/api/simulations/${id}/collaborations` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ collaborations: [] });
  });

  it('accepts agentId and status filters', async () => {
    const id = await createSimulation();

    const byAgent = await app.inject({
      method: 'GET',
      url: `/api/simulations/${id}/collaborations?agentId=sensor-agent`,
    });
    expect(byAgent.statusCode).toBe(200);
    expect(byAgent.json()).toEqual({ collaborations: [] });

    const byStatus = await app.inject({
      method: 'GET',
      url: `/api/simulations/${id}/collaborations?status=pending`,
    });
    expect(byStatus.statusCode).toBe(200);
    expect(byStatus.json()).toEqual({ collaborations: [] });
  });

  it('404s for an unknown simulation', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/simulations/sim-nope/collaborations' });
    expect(res.statusCode).toBe(404);
  });

  it('rows exclude the initiator from participants and carry no duplicates (Fix-10, R4 F-18)', async () => {
    const id = await createSimulation();

    // Rule-only agents never run a real AC handshake (autoInitiateAC is off
    // without an LLM), so seed the session the way the initiator-side
    // handshake creates it (CollaborationCoordinator): participants INCLUDE
    // the initiator — the exact shape R4 F-18 reported — plus a repeated id.
    // The endpoint must normalize both away.
    const runtime = app.simulations.getOrThrow(id).runtime;
    const agents = (
      runtime as unknown as {
        agents: Map<string, { collaborationManager: CollaborationManager }>;
      }
    ).agents;
    agents.get('sensor-agent')!.collaborationManager.createSessionWithId(
      'collab-fix10',
      'service-composition',
      ['sensor-agent', 'actuator-agent', 'actuator-agent'],
      'sensor-agent',
      CollaborationPriority.HIGH,
      'cool the corridor',
      [],
    );

    const res = await app.inject({ method: 'GET', url: `/api/simulations/${id}/collaborations` });
    expect(res.statusCode).toBe(200);
    const rows = res.json().collaborations as Array<{
      id: string;
      agentId: string;
      role: string;
      initiator: string;
      participants: string[];
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'collab-fix10',
      agentId: 'sensor-agent',
      role: 'initiator',
      initiator: 'sensor-agent',
    });
    // The initiator is named by its own field — never duplicated inside
    // participants; partner ids appear at most once.
    expect(rows[0].participants).toEqual(['actuator-agent']);
  });
});
