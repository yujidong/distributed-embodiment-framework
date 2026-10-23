/**
 * @vitest-environment node
 *
 * Per-simulation trajectory capture (W8) — default directory wiring and the
 * `GET /api/simulations/:id/trajectory` read API.
 *
 * Server-side sims run rule-only in tests (no LLM backend). Since Fix-3, rule-only
 * agents resolve events via deterministic rules (decisionSource 'rule'), so a
 * live run produces real assessment records. The parse/filter/cap behaviour is
 * additionally tested against a hand-written JSONL in the sim's trajectory
 * segment (the honest seam: the file format is owned by packages/core's
 * TrajectoryRecorder).
 *
 * Living-worlds P2: the recorder writes a SIZE-SEGMENTED log
 * `<simDir>/<base>/segment-<n>.jsonl` (no eager empty file — a recorder that
 * never records leaves no artifact); the read API stitches segments.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from './server.js';
import { createUserScenario } from './test-utils.js';

/** Two-zone scenario mirroring the simulation suite fixture. */
function labScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Trajectory Lab' },
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

/** Minimal TrajectoryRecord-shaped line (recorder owns the full shape). */
function trajectoryLine(eventId: string, agentId: string, extras: Record<string, unknown> = {}) {
  return {
    recordedAt: new Date().toISOString(),
    scenario: 'sim-lab',
    condition: 'engine-runtime',
    iteration: 0,
    eventId,
    agentId,
    context: { capabilities: [], partnerServices: [], partnerServicesTotal: 0 },
    decision: 'initiate-ac',
    decisionSource: 'precheck',
    groundTruth: { correctDecision: 'unknown', interactionType: 'unknown' },
    correct: false,
    ...extras,
  };
}

describe('simulation trajectory capture + query API', () => {
  let app: FastifyInstance;
  let userDir: string;
  let trajectoryDir: string;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'sim-traj-store-'));
    trajectoryDir = mkdtempSync(join(tmpdir(), 'sim-traj-base-'));
    app = await buildServer({ userDir, trajectoryDir, logger: false, databasePath: ':memory:' });
    const res = await createUserScenario(app, labScenario('sim-lab'));
    expect(res.statusCode).toBe(201);
  });

  afterEach(async () => {
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
    rmSync(trajectoryDir, { recursive: true, force: true });
  });

  async function createSimulation(payload: Record<string, unknown> = { scenarioId: 'sim-lab' }): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/simulations', payload });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  function trajectoryFilePath(simId: string): string {
    const filePath = app.simulations.getOrThrow(simId).runtime.getTrajectoryFilePath();
    expect(filePath).not.toBeNull();
    return filePath as string;
  }

  /** The recorder creates the segment dir lazily — hand-written fixtures must. */
  function ensureSegmentDir(filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  it('defaults every new simulation to <trajectoryDir>/<simId>/ (segmented log, no eager file)', async () => {
    const id = await createSimulation();
    const filePath = trajectoryFilePath(id);
    // P2 layout: <simDir>/<base>/segment-000001.jsonl — the base dir is
    // derived (condition/iteration/scenario/model), the sim dir is the
    // default <trajectoryDir>/<simId>/.
    expect(dirname(dirname(filePath))).toBe(join(trajectoryDir, id));
    expect(dirname(filePath).endsWith('engine-runtime-iter0-sim-lab-rule-only')).toBe(true);
    expect(filePath.endsWith('segment-000001.jsonl')).toBe(true);
    // No eager empty file: no records yet -> no artifact on disk.
    expect(existsSync(filePath)).toBe(false);
  });

  it('keeps an explicit options.trajectoryDir override working', async () => {
    const overrideDir = mkdtempSync(join(tmpdir(), 'sim-traj-override-'));
    try {
      const id = await createSimulation({ scenarioId: 'sim-lab', options: { trajectoryDir: overrideDir } });
      const filePath = trajectoryFilePath(id);
      expect(dirname(dirname(filePath))).toBe(overrideDir);
      expect(existsSync(filePath)).toBe(false);
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  it('records rule decisions and stays queryable on a rule-only run', async () => {
    const id = await createSimulation();
    await app.inject({ method: 'POST', url: `/api/simulations/${id}/start`, payload: { speed: 1 } });
    await app.inject({ method: 'POST', url: `/api/simulations/${id}/step`, payload: { n: 2 } });
    const injected = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/events`,
      payload: { type: 'temperature-spike', zoneId: 'zone-a' },
    });
    expect(injected.statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/simulations/${id}/stop` });

    // Rule-only (Fix-3): deterministic rule assessments ARE recorded.
    const lines = readFileSync(trajectoryFilePath(id), 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const res = await app.inject({ method: 'GET', url: `/api/simulations/${id}/trajectory` });
    expect(res.statusCode).toBe(200);
    const records = res.json().records as Array<{ decisionSource?: string; agentId?: string }>;
    expect(records.length).toBeGreaterThan(0);
    expect(records.some(r => r.decisionSource === 'rule' && r.agentId === 'sensor-agent')).toBe(true);
  });

  it('returns an empty list (with a note pointing at /timeline) when the trajectory file has no records', async () => {
    const id = await createSimulation();
    rmSync(trajectoryFilePath(id), { force: true }); // missing = "no records" (P2)
    const res = await app.inject({ method: 'GET', url: `/api/simulations/${id}/trajectory` });
    expect(res.statusCode).toBe(200);
    // T-005: an empty decision trajectory gets a pointer to the sim-side
    // timeline endpoint instead of looking like "nothing happened".
    expect(res.json().records).toEqual([]);
    expect(res.json().note).toContain(`/api/simulations/${id}/timeline`);
  });

  it('parses records, skips a partial trailing line, and preserves order', async () => {
    const id = await createSimulation();
    const filePath = trajectoryFilePath(id);
    ensureSegmentDir(filePath);
    appendFileSync(filePath, JSON.stringify(trajectoryLine('evt-1', 'sensor-agent', {
      decisionSource: 'llm',
      rawResponse: '温度超过阈值，需要联动空调',
      model: 'mock-model',
      promptTokens: 10,
      durationMs: 42,
    })) + '\n');
    appendFileSync(filePath, JSON.stringify(trajectoryLine('evt-1', 'actuator-agent')) + '\n');
    appendFileSync(filePath, JSON.stringify(trajectoryLine('evt-2', 'sensor-agent')) + '\n');
    appendFileSync(filePath, '{"eventId":"evt-3","agentId":"sensor-age'); // truncated tail

    const res = await app.inject({ method: 'GET', url: `/api/simulations/${id}/trajectory` });
    expect(res.statusCode).toBe(200);
    const { records } = res.json();
    expect(records).toHaveLength(3);
    expect(records.map((r: { eventId: string }) => r.eventId)).toEqual(['evt-1', 'evt-1', 'evt-2']);
    expect(records[0].rawResponse).toBe('温度超过阈值，需要联动空调');
    expect(records[0].promptTokens).toBe(10);
  });

  it('filters by eventId and agentId', async () => {
    const id = await createSimulation();
    const filePath = trajectoryFilePath(id);
    ensureSegmentDir(filePath);
    for (const line of [
      trajectoryLine('evt-1', 'sensor-agent'),
      trajectoryLine('evt-1', 'actuator-agent'),
      trajectoryLine('evt-2', 'sensor-agent'),
    ]) {
      appendFileSync(filePath, JSON.stringify(line) + '\n');
    }

    const byEvent = await app.inject({ method: 'GET', url: `/api/simulations/${id}/trajectory?eventId=evt-1` });
    expect(byEvent.json().records).toHaveLength(2);
    const byAgent = await app.inject({ method: 'GET', url: `/api/simulations/${id}/trajectory?agentId=sensor-agent` });
    expect(byAgent.json().records).toHaveLength(2);
    const byBoth = await app.inject({
      method: 'GET',
      url: `/api/simulations/${id}/trajectory?eventId=evt-1&agentId=actuator-agent`,
    });
    expect(byBoth.json().records).toHaveLength(1);
    expect(byBoth.json().records[0].agentId).toBe('actuator-agent');

    const bad = await app.inject({ method: 'GET', url: `/api/simulations/${id}/trajectory?eventId=` });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('BAD_REQUEST');
  });

  it('caps at 500 records, keeping the latest', async () => {
    const id = await createSimulation();
    const filePath = trajectoryFilePath(id);
    ensureSegmentDir(filePath);
    const chunk: string[] = [];
    for (let i = 0; i < 505; i += 1) {
      chunk.push(JSON.stringify(trajectoryLine(`evt-${i}`, 'sensor-agent', { decision: `d-${i}` })));
    }
    writeFileSync(filePath, chunk.join('\n') + '\n');

    const res = await app.inject({ method: 'GET', url: `/api/simulations/${id}/trajectory` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const { records } = body;
    expect(records).toHaveLength(500);
    // Latest win: the oldest 5 are dropped, the final record survives.
    expect(records[0].decision).toBe('d-5');
    expect(records[records.length - 1].decision).toBe('d-504');
    // R81-D2 (R44-extreme-F2): the cap hit is VISIBLE — the client learns
    // the response is a 500-of-505 window, not the full view.
    expect(body.totalCount).toBe(505);
    expect(body.truncated).toBe(true);
  });

  it('R81-D2: totalCount without truncation under the cap; filtered queries mark their own cap hits', async () => {
    const id = await createSimulation();
    const filePath = trajectoryFilePath(id);
    ensureSegmentDir(filePath);
    const chunk: string[] = [];
    for (let i = 0; i < 505; i += 1) {
      chunk.push(JSON.stringify(trajectoryLine('evt-hot', 'sensor-agent', { decision: `hot-${i}` })));
    }
    chunk.push(JSON.stringify(trajectoryLine('evt-cold', 'sensor-agent')));
    chunk.push(JSON.stringify(trajectoryLine('evt-cold', 'actuator-agent')));
    writeFileSync(filePath, chunk.join('\n') + '\n');

    // Unfiltered, above the cap: truncated, and totalCount counts BOTH events.
    const all = await app.inject({ method: 'GET', url: `/api/simulations/${id}/trajectory` });
    expect(all.json().totalCount).toBe(507);
    expect(all.json().truncated).toBe(true);

    // Filtered, above the cap: the filter's own matching total is reported.
    const hot = await app.inject({ method: 'GET', url: `/api/simulations/${id}/trajectory?eventId=evt-hot` });
    expect(hot.json().records).toHaveLength(500);
    expect(hot.json().totalCount).toBe(505);
    expect(hot.json().truncated).toBe(true);

    // Filtered, under the cap: no truncation marker (field stays absent).
    const cold = await app.inject({ method: 'GET', url: `/api/simulations/${id}/trajectory?eventId=evt-cold` });
    expect(cold.json().records).toHaveLength(2);
    expect(cold.json().totalCount).toBe(2);
    expect(cold.json().truncated).toBeUndefined();
  });
});
