/**
 * @vitest-environment node
 *
 * Living-worlds P2 — retention coupling at the REPLAY seam:
 *
 * INVARIANT (documented in replay-service iterSimJsonlFiles): the rollup
 * grain must NEVER enter replay. A fixture sim dir carries raw SEGMENTS
 * (inside the window) and minute-grain ROLLUP files (beyond the window);
 * a replay over a range covering both bakes events ONLY from the raw
 * segments — the rollups' aggregate values appear nowhere in the product,
 * and the out-of-window raw is simply absent (compacted away).
 *
 * Also pins the route-level grain labels: /timeline serves raw with grain
 * 'raw' until history beyond the raw window is topped up from minute
 * aggregates — then 'raw+rollup', with rollup records (kind 'rollup-1m')
 * clearly labeled and a note explaining the degradation.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';
import { sweepTrajectoryDir } from './sim-registry/timeline-compactor.js';
import { simTimelineLog } from './sim-timeline.js';

function writeJsonl(path: string, records: unknown[]): void {
  writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

/** One zone-sample record at an exact wall time. */
function sampleAt(environmentId: string, iso: string, seq: number, temp: number) {
  return {
    kind: 'zone-sample',
    environmentId,
    simId: 'sim-grain-1',
    simTimeSec: seq * 60,
    recordedAt: iso,
    zones: [{ zoneId: 'zone-a', parameters: { temperature: temp } }],
  };
}

/**
 * Fixture env (one zone + one agent) + a sim dir with stale/fresh minutes.
 * The env is imported under the OWNER (the replay + timeline reads run as
 * them) with a SELF-CONSISTENT scenario — the devices carry no zone refs
 * beyond the single zone (an inherited hvac-b → zone-b would 400).
 */
async function setupEnv(ctx: TestAppContext, owner: TestUser): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/environments',
    headers: auth(owner.token),
    payload: {
      version: '1.0',
      meta: { id: 'env-grain', name: 'Grain Lab', description: 'grain fixture' },
      zones: [{ id: 'zone-a' }],
      devices: [],
      agents: [{
        id: 'agent-1', name: 'Agent One',
        capabilities: ['temperature-monitoring'], managesZoneIds: ['zone-a'],
      }],
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** Build the segmented timeline fixture: 2 stale sealed + 1 fresh active. */
function buildTimelineFixture(simDir: string, now: number, environmentId: string): void {
  const segDir = simTimelineLog(simDir).segmentDir;
  mkdirSync(segDir, { recursive: true });
  writeJsonl(join(segDir, 'segment-000001.jsonl'), [
    sampleAt(environmentId, new Date(now - 10 * 24 * 3600 * 1000).toISOString(), 0, 30), // STALE
  ]);
  writeJsonl(join(segDir, 'segment-000002.jsonl'), [
    sampleAt(environmentId, new Date(now - 9 * 24 * 3600 * 1000).toISOString(), 1, 31), // STALE
  ]);
  writeJsonl(join(segDir, 'segment-000003.jsonl'), [
    sampleAt(environmentId, new Date(now - 60_000).toISOString(), 2, 22), // FRESH raw
  ]);
  // Staleness is keyed on mtimes (the T-033 lesson): backdate the sealed.
  const staleStamp = new Date(now - 10 * 24 * 3600 * 1000);
  utimesSync(join(segDir, 'segment-000001.jsonl'), staleStamp, staleStamp);
  utimesSync(join(segDir, 'segment-000002.jsonl'), staleStamp, staleStamp);
}

describe('replay never bakes rollups (LW-P2 invariant)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('bakes in-window raw segments only; rollup aggregates appear nowhere in the product', async () => {
    const envId = await setupEnv(ctx, owner);
    const NOW = Date.now();
    const simDir = join(ctx.trajectoryDir, 'sim-grain-1');
    buildTimelineFixture(simDir, NOW, envId);

    const sweep = sweepTrajectoryDir(simDir, {
      rollupWindowMs: 7 * 24 * 3600 * 1000,
      now: () => NOW,
    });
    expect(sweep.rolledSegments).toBe(2);
    const segDir = simTimelineLog(simDir).segmentDir;
    expect(existsSync(join(segDir, 'rollup-1m-000001.jsonl'))).toBe(true);
    expect(existsSync(join(segDir, 'segment-000003.jsonl'))).toBe(true);

    // The replay window deliberately covers the stale minutes too — the
    // compacted raw is gone and the rollup grain is excluded; only the
    // fresh raw minute can bake.
    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replays`,
      headers: auth(owner.token),
      payload: {
        from: new Date(NOW - 12 * 24 * 3600 * 1000).toISOString(),
        to: new Date(NOW + 60_000).toISOString(),
      },
    });
    expect(replay.statusCode).toBe(200);
    const body = replay.json();
    expect(body.report.zoneSampleEvents).toBe(1);
    const zoneEvents = (body.scenario.events as Array<{
      type: string; details?: { parameters?: Record<string, number> };
    }>).filter(e => e.type === 'zone-sample');
    expect(zoneEvents).toHaveLength(1);
    expect(zoneEvents[0]!.details!.parameters!.temperature).toBe(22); // raw, not 30/31
    for (const event of body.scenario.events as unknown[]) {
      const text = JSON.stringify(event);
      expect(text).not.toContain('rollup');
      expect(text).not.toContain('"avg"');
      expect(text).not.toContain('"min"');
    }
  });
});

describe('route reads label the served grain (LW-P2)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('/timeline serves raw with grain "raw"; flips to "raw+rollup" beyond the window', async () => {
    const envId = await setupEnv(ctx, owner);
    const NOW = Date.now();
    const simDir = mkdtempSync(join(tmpdir(), 'lwp2-grain-'));
    buildTimelineFixture(simDir, NOW, envId);
    sweepTrajectoryDir(simDir, { rollupWindowMs: 7 * 24 * 3600 * 1000, now: () => NOW });

    // Registry-visible sim whose trajectory dir IS the fixture.
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/simulations', headers: auth(owner.token),
      payload: { environmentId: envId, options: { trajectoryDir: simDir } },
    });
    expect(created.statusCode).toBe(201);
    const simId = created.json().id as string;

    const res = await ctx.app.inject({
      method: 'GET', url: `/api/simulations/${simId}/timeline`, headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.grain).toBe('raw+rollup');
    expect(body.note).toContain('rollup');
    const kinds = (body.records as Array<{ kind: string }>).map(r => r.kind);
    expect(kinds).toContain('rollup-1m'); // beyond-window aggregate, labeled
    expect(kinds).toContain('zone-sample'); // in-window raw tail
    rmSync(simDir, { recursive: true, force: true });
  });
});
