/**
 * @vitest-environment node
 *
 * T-005 — `GET /api/simulations/:id/timeline`（仿真侧时间线读 API）。
 *
 * 跑一段 env 背书的 rule-only 仿真（zone 采样 + 设备命令），断言 /timeline
 * 返回 zone-sample 与 device-state 记录；hand-written JSONL 覆盖读侧边界
 * （500 上限取最新、半行跳过、无文件=空）；/trajectory 空结果带指向
 * /timeline 的 note。采样间隔 zoneSampleEverySimSec=5（默认 60 等不起）。
 */

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  createUserScenario,
  importableScenario,
  makeTestApp,
  registerUser,
  until,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';
import { deviceStateDataFields, readSimTimelineRecords } from './sim-timeline.js';

/**
 * DevLoop R21 test-debt: the sampler is a 200ms wall-clock poll loop —
 * waiting a FIXED 350ms for "the first sampler round probably happened" was
 * the documented flake shape (under parallel load the round lands later).
 * Poll the observable condition instead: the timeline endpoint itself.
 */
async function timelineHas(
  ctx: TestAppContext, owner: TestUser, simId: string,
  predicate: (records: TimelineRecord[]) => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  return until(async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/simulations/${simId}/timeline`, headers: auth(owner.token),
    });
    if (res.statusCode !== 200) return false;
    return predicate(res.json().records as TimelineRecord[]);
  }, timeoutMs, 50);
}

interface TimelineRecord {
  kind: 'zone-sample' | 'device-state';
  simId: string;
  simTimeSec: number;
  recordedAt: string;
  deviceId?: string;
  service?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  /** R17 params-purity: top-level invocation-context actor (device-state). */
  actor?: string;
  zones?: Array<{
    zoneId: string;
    parameters: Record<string, number | boolean>;
    baseline?: Record<string, number | boolean>;
  }>;
}

/** Minimal device-state-shaped line (sim-timeline.ts owns the full shape). */
function deviceStateLine(simId: string, i: number) {
  return {
    kind: 'device-state',
    environmentId: 'env-x',
    simId,
    simTimeSec: i * 10,
    recordedAt: new Date(2026, 7, 22, 0, 0, i).toISOString(),
    deviceId: `device-${i}`,
    service: 'turn-on',
  };
}

describe('simulation timeline API (T-005)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;
  let hvacId: string;

  beforeEach(async () => {
    // 5 仿真秒一采样（默认 60），200ms 轮询下两次 sleep 即可覆盖。
    ctx = await makeTestApp({ zoneSampleEverySimSec: 5 });
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('timeline-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    hvacId = (created.json().devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'HVAC B')!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('serves zone-sample + device-state records from an env-backed run', async () => {
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;

    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(owner.token), payload: { speed: 1 } });
    // 采样器首轮（t≈0 基线）——轮询到基线 zone-sample 真正可读为止。
    expect(await timelineHas(ctx, owner, simId, records =>
      records.some(r => r.kind === 'zone-sample'))).toBe(true);
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/step`, headers: auth(owner.token), payload: { n: 10 } });
    const commanded = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: auth(owner.token),
      payload: { deviceId: hvacId, commandName: 'turn-on' },
    });
    expect(commanded.statusCode).toBe(200);
    // T-039: a parameterized command must land in the timeline WITH its
    // changed fields — params (intent) + result (observed effect).
    const setTemp = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: auth(owner.token),
      payload: { deviceId: hvacId, commandName: 'set-temperature', params: { temperature: 18 } },
    });
    expect(setTemp.statusCode).toBe(200);
    // T-039 取证记录就位（命令路径写入）后再继续。
    expect(await timelineHas(ctx, owner, simId, records =>
      records.some(r => r.kind === 'device-state' && r.deviceId === hvacId && r.service === 'set-temperature'))).toBe(true);
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(owner.token) });

    // S2 (device privacy): read the timeline as the env OWNER — the T-039
    // forensics assertions (params/result) hold at the full tier. An
    // anonymous reader gets the redacted view (asserted at the end).
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/timeline`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);
    const records = res.json().records as TimelineRecord[];
    expect(records.length).toBeGreaterThan(0);
    expect(records.every(r => r.simId === simId)).toBe(true);

    const samples = records.filter(r => r.kind === 'zone-sample');
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0]!.zones!.length).toBeGreaterThan(0);
    expect(Object.keys(samples[0]!.zones![0]!.parameters).length).toBeGreaterThan(0);

    const deviceStates = records.filter(r => r.kind === 'device-state');
    expect(deviceStates.some(r => r.deviceId === hvacId)).toBe(true);
    // T-039 (FF-F10 residue): the set-temperature record carries the command
    // arguments verbatim and the executed result's data payload — physical
    // forensics off the timeline, not just off /snapshot at call time.
    const setTempRecord = deviceStates.find(
      r => r.deviceId === hvacId && r.service === 'set-temperature',
    );
    expect(setTempRecord).toBeDefined();
    expect(setTempRecord!.params).toEqual({ temperature: 18 });
    expect(setTempRecord!.result).toMatchObject({
      capability: expect.any(String),
      params: { temperature: 18 },
    });
    // R17 params-purity (T-034×T-039 regression): attribution rides the
    // record's TOP-LEVEL `actor` field — `params` must stay the command's
    // pure semantic arguments (the commands route stamped `actor: 'Owner'`
    // into params before, breaking the T-019 replay hygiene contract).
    expect(setTempRecord!.actor).toBe('Owner');
    // Bare commands (turn-on) at least carry the executed result payload.
    const turnOnRecord = deviceStates.find(
      r => r.deviceId === hvacId && r.service === 'turn-on',
    );
    expect(turnOnRecord).toBeDefined();
    expect(turnOnRecord!.result).toBeDefined();

    // S2 (device privacy): an ANONYMOUS reader of the same public-env sim
    // gets the coarse timeline — the device-state records keep their history
    // markers (device/service/time) but params/result are stripped and the
    // record self-labels; zone-samples (world ambient) pass untouched.
    const anon = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/timeline`,
    });
    expect(anon.statusCode).toBe(200);
    const anonRecords = anon.json().records as Array<Record<string, unknown>>;
    const anonSamples = anonRecords.filter(r => r.kind === 'zone-sample');
    expect(anonSamples.length).toBe(samples.length);
    const anonDevice = anonRecords.find(
      r => r.kind === 'device-state' && r.service === 'set-temperature',
    ) as Record<string, unknown>;
    expect(anonDevice).toBeDefined();
    expect(anonDevice.redacted).toBe(true);
    expect(anonDevice.params).toBeUndefined();
    expect(anonDevice.result).toBeUndefined();
    expect(anonDevice.deviceId).toBe(hvacId);
  });

  it('T-061: zone-samples carry declared custom baseline params + the declared baseline', async () => {
    // Same fixture with a custom-baseline zone: a declared domain quantity
    // (powerW) must be VISIBLE in the sampled parameters and the declared
    // baseline must ride along — threshold authoring off timeline data.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        ...importableScenario('timeline-custom-baseline'),
        visibility: 'public',
        zones: [
          {
            id: 'zone-a', adjacentZoneIds: ['zone-b'],
            baseline: { temperature: 21, powerW: 4200 },
          },
          { id: 'zone-b', adjacentZoneIds: ['zone-a'] },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const envWithCustom = created.json().id as string;

    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envWithCustom },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(owner.token), payload: { speed: 1 } });
    expect(await timelineHas(ctx, owner, simId, records =>
      records.some(r => r.kind === 'zone-sample'))).toBe(true);
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(owner.token) });

    const res = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${simId}/timeline` });
    const samples = (res.json().records as TimelineRecord[]).filter(r => r.kind === 'zone-sample');
    expect(samples.length).toBeGreaterThan(0);
    const zoneA = samples[0]!.zones!.find(z => z.zoneId === 'zone-a')!;
    expect(zoneA.parameters.powerW).toBe(4200); // custom param sampled
    expect(zoneA.baseline).toEqual({ temperature: 21, powerW: 4200 }); // declared, verbatim
    const zoneB = samples[0]!.zones!.find(z => z.zoneId === 'zone-b')!;
    expect(zoneB.parameters.powerW).toBeUndefined();
    expect(zoneB.baseline).toBeUndefined();
  });

  it('404s on an unknown simulation', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/simulations/sim-nope/timeline' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SIMULATION_NOT_FOUND');
  });

  it('answers an honest { records: [] } when the sim never wrote a timeline (legacy scenario sim)', async () => {
    // Legacy scenario sims get a trajectory dir but no sim-timeline writer.
    const created = await createUserScenario(
      ctx.app,
      {
        version: '1.0',
        meta: { id: 'timeline-legacy', name: 'Legacy' },
        zones: [{ id: 'zone-a' }],
        devices: [],
        agents: [],
        events: [],
      },
      owner.token,
    );
    expect(created.statusCode).toBe(201);
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { scenarioId: 'timeline-legacy' },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;

    // And /trajectory on the same untouched sim points at /timeline.
    // T-015: the legacy sim was created by `owner` — read it as the creator.
    const trajectory = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${simId}/trajectory`, headers: auth(owner.token) });
    expect(trajectory.statusCode).toBe(200);
    expect(trajectory.json().records).toEqual([]);
    expect(trajectory.json().note).toContain(`/api/simulations/${simId}/timeline`);

    const res = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${simId}/timeline`, headers: auth(owner.token) });
    expect(res.statusCode).toBe(200);
    // P2 grain label rides every timeline answer (none = nothing served).
    expect(res.json()).toEqual({ records: [], grain: 'none' });
  });

  it('caps at 500 records (latest win), skipping a partial trailing line', async () => {
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;

    const record = ctx.app.simulations.getOrThrow(simId);
    expect(record.trajectoryDir).toBeDefined();
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(owner.token) });

    const chunk: string[] = [];
    for (let i = 0; i < 505; i += 1) chunk.push(JSON.stringify(deviceStateLine(simId, i)));
    writeFileSync(join(record.trajectoryDir!, 'sim-timeline.jsonl'), chunk.join('\n') + '\n');
    appendFileSync(join(record.trajectoryDir!, 'sim-timeline.jsonl'), '{"kind":"device-state","simId":"trunc'); // 尾部半行

    const res = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${simId}/timeline` });
    expect(res.statusCode).toBe(200);
    const records = res.json().records as TimelineRecord[];
    expect(records).toHaveLength(500);
    expect(records[0]!.simTimeSec).toBe(5 * 10); // 最旧的 5 条被裁掉
    expect(records[records.length - 1]!.simTimeSec).toBe(504 * 10);
  });
});

describe('readSimTimelineRecords unit (missing dir / non-record lines)', () => {
  it('returns [] for a directory without a timeline file and skips non-record lines', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'sim-timeline-unit-'));
    try {
      await expect(readSimTimelineRecords(emptyDir)).resolves.toEqual([]);

      writeFileSync(
        join(emptyDir, 'sim-timeline.jsonl'),
        JSON.stringify(deviceStateLine('sim-u', 0)) + '\n' +
        JSON.stringify({ kind: 'zone-sample', nope: true }) + '\n', // 结构不符——跳过
      );
      const records = await readSimTimelineRecords(emptyDir);
      expect(records).toHaveLength(1);
      expect((records[0] as { deviceId?: string }).deviceId).toBe('device-0');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// T-039 (DevLoop R17, FF-F10 residue): device-state records carry their data
// payloads — the extraction + bounding rules live in deviceStateDataFields.
describe('deviceStateDataFields unit (T-039)', () => {
  it('unwraps the DEVICE_OPERATION_EXECUTED result wrapper and echoes params', () => {
    const fields = deviceStateDataFields({
      deviceId: 'd1',
      commandName: 'set-temperature',
      params: { temperature: 18 },
      result: {
        success: true,
        result: { timestamp: new Date(0), value: 18, capability: 'temperature-control', temperature: 18 },
        executionTime: 3,
      },
    });
    expect(fields.params).toEqual({ temperature: 18 });
    // JSON-clone: the Date inside the device result serializes to ISO.
    expect(fields.result).toEqual({
      timestamp: '1970-01-01T00:00:00.000Z',
      value: 18,
      capability: 'temperature-control',
      temperature: 18,
    });
  });

  it('reads the DEVICE_STATE_CHANGE spelling (parameters + top-level result)', () => {
    const fields = deviceStateDataFields({
      deviceId: 'd1',
      service: 'turn-on',
      parameters: { level: 2 },
      result: { state: { on: true } },
      timestamp: new Date(),
    });
    expect(fields.params).toEqual({ level: 2 });
    expect(fields.result).toEqual({ state: { on: true } });
  });

  it('omits empty params, non-JSON payloads and over-budget clones entirely', () => {
    expect(deviceStateDataFields({ deviceId: 'd1', params: {} })).toEqual({});
    // Circular structure is not JSON-safe — omitted, not thrown.
    const circular: Record<string, unknown> = { self: null };
    circular.self = circular;
    expect(deviceStateDataFields({ deviceId: 'd1', result: circular })).toEqual({});
    // Over the 4KB result budget → the field is omitted (never truncated).
    expect(
      deviceStateDataFields({ deviceId: 'd1', result: { blob: 'x'.repeat(5000) } }),
    ).toEqual({});
  });
});
