/**
 * @vitest-environment node
 *
 * Fix-14：回放烘焙仿真侧时序（R5-P1-2 "回放 ≠ 仿真复盘"）。
 *
 * 跑一段 env 背书的 rule-only 仿真（注入事件 → 规则决策落 trajectory；
 * 物理演进 → zone 采样落 sim-timeline.jsonl；设备命令 → DEVICE_STATE_CHANGE
 * 落 sim-timeline.jsonl + command_log），然后创建回放，断言回放产物含
 * `sim-decision` / `zone-sample` / `device-state` 事件——不再是
 * observationEvents=0 的空回放。
 *
 * 采样间隔用 zoneSampleEverySimSec=5（默认 60 仿真秒，测试等不起）；
 * 采样器是 wall-clock 轮询（200ms），断言前留足轮询窗口。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { utimesSync } from 'node:fs';

import { iterSimJsonlFiles } from './replay-service.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  until,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

/**
 * DevLoop R21 test-debt: the sampler is a 200ms wall-clock poll loop — the
 * old fixed 350ms sleeps ("the first sampler round probably happened")
 * flaked under parallel load. Poll the timeline endpoint for the exact
 * record the later assertions need instead.
 */
async function timelineHas(
  ctx: TestAppContext, owner: TestUser, simId: string,
  predicate: (records: Array<{ kind: string; deviceId?: string; service?: string }>) => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  return until(async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/simulations/${simId}/timeline`, headers: auth(owner.token),
    });
    if (res.statusCode !== 200) return false;
    return predicate(res.json().records as Array<{ kind: string; deviceId?: string; service?: string }>);
  }, timeoutMs, 50);
}

/** Poll the snapshot until the sim's recent decisions become non-empty. */
async function snapshotHasDecisions(
  ctx: TestAppContext, owner: TestUser, simId: string, timeoutMs = 10_000,
): Promise<boolean> {
  return until(async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/simulations/${simId}/snapshot`, headers: auth(owner.token),
    });
    if (res.statusCode !== 200) return false;
    return ((res.json().recentDecisions ?? []) as unknown[]).length > 0;
  }, timeoutMs, 50);
}

interface ReplayEvent {
  id: string;
  type: string;
  zoneId: string;
  atSimTimeSec?: number;
  details?: Record<string, unknown>;
}

describe('replay bakes the sim-side timeline (Fix-14)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;
  let hvacId: string;
  /** Instance id of the imported agent (import regenerates ids). */
  let agentId: string;

  beforeEach(async () => {
    // 5 仿真秒一采样（默认 60），200ms 轮询下两次 sleep 即可覆盖。
    ctx = await makeTestApp({ zoneSampleEverySimSec: 5 });
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('replay-sim-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    hvacId = (created.json().devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'HVAC B')!.id;
    agentId = (created.json().agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Lab Agent')!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('a pure simulation run replays with decision, zone-sample and device-state events', async () => {
    const from = new Date(Date.now() - 5_000).toISOString();

    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;

    // Fix-47: start/step/stop 需要创建者（或环境 owner/builder、admin）身份。
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(owner.token), payload: { speed: 1 } });
    expect(await timelineHas(ctx, owner, simId, records =>
      records.some(r => r.kind === 'zone-sample'))).toBe(true); // 采样器首轮（t≈0 基线 + 运行中采样）

    // 注入事件 → rule-only 决策落 trajectory JSONL。
    const injected = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: auth(owner.token),
      payload: { type: 'temperature-spike', zoneId: 'zone-a' },
    });
    expect(injected.statusCode).toBe(200);
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/step`, headers: auth(owner.token), payload: { n: 10 } });

    // 设备命令 → DEVICE_STATE_CHANGE 落 sim-timeline + command_log。
    const commanded = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: auth(owner.token),
      payload: { deviceId: hvacId, commandName: 'turn-on' },
    });
    expect(commanded.statusCode).toBe(200);
    expect(await timelineHas(ctx, owner, simId, records =>
      records.some(r => r.kind === 'device-state' && r.deviceId === hvacId && r.service === 'turn-on'))).toBe(true);
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(owner.token) });

    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replays`,
      headers: auth(owner.token),
      payload: { from, to: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(replay.statusCode).toBe(200);
    const report = replay.json().report;
    // R5-P1-2 的缺口闭环：纯仿真（无 manual sync-binding 观测）不再是空回放。
    expect(report.observationEvents).toBe(0);
    expect(report.decisionEvents).toBeGreaterThan(0);
    expect(report.zoneSampleEvents).toBeGreaterThan(0);
    expect(report.deviceStateEvents).toBeGreaterThan(0);
    expect(report.eventCount).toBe(
      report.observationEvents + report.commandEvents +
      report.decisionEvents + report.zoneSampleEvents + report.deviceStateEvents,
    );

    const events = replay.json().scenario.events as ReplayEvent[];
    const decisions = events.filter(event => event.type === 'sim-decision');
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0].details).toMatchObject({ agentId });
    expect(typeof decisions[0].details?.decision).toBe('string');

    const samples = events.filter(event => event.type === 'zone-sample');
    expect(samples.length).toBeGreaterThan(0);
    const parameters = samples[0].details?.parameters as Record<string, unknown>;
    expect(typeof parameters.temperature).toBe('number');
    // zone-sample 事件挂在被采样的 zone 上（含无设备的 zone 也不漂移）。
    expect(['zone-a', 'zone-b']).toContain(samples[0].zoneId);

    const deviceStates = events.filter(event => event.type === 'device-state');
    expect(deviceStates.length).toBeGreaterThan(0);
    expect(deviceStates[0].details).toMatchObject({ deviceId: hvacId, service: 'turn-on' });
    // T-039: baked device-state events keep the changed fields — the
    // record's result payload rides the replay, so a replayed world's
    // device history is auditable, not just "a command happened".
    expect(deviceStates[0].details?.result).toBeDefined();

    // 所有烘焙事件都带窗口相对时间，且整体按 atSimTimeSec 升序。
    for (const event of events) {
      expect(typeof event.atSimTimeSec).toBe('number');
    }
    const times = events.map(event => event.atSimTimeSec as number);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('ignores sim timelines of OTHER environments', async () => {
    // R73: 本 env 的世界会话在建环境时自动启动并持续自产 zone 采样——
    // 先显式冻结它（POST /stop → checkpoint），本 env 才回到"安静"前提，
    // 使"其他 env 的时间线（含其自动启动的世界会话）不得混入"仍是真阴性断言。
    expect(await until(() => ctx.app.worldSessions.statusOf(envId) !== undefined, 5_000)).toBe(true);
    const frozen = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/sim-${envId}-world-session/stop`,
      headers: auth(owner.token),
    });
    expect(frozen.statusCode).toBe(200);

    // 另一个 env 跑一段仿真，其采样/决策不得混入本 env 的回放。
    const other = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('replay-sim-other'), visibility: 'public' },
    });
    const otherEnvId = other.json().id as string;
    const otherSim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: otherEnvId },
    });
    const otherSimId = otherSim.json().id as string;
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${otherSimId}/start`, headers: auth(owner.token), payload: { speed: 1 } });
    expect(await timelineHas(ctx, owner, otherSimId, records =>
      records.some(r => r.kind === 'zone-sample'))).toBe(true);
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${otherSimId}/stop`, headers: auth(owner.token) });

    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replays`,
      headers: auth(owner.token),
      payload: {
        from: new Date(Date.now() - 5_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(replay.statusCode).toBe(200);
    const report = replay.json().report;
    expect(report.decisionEvents).toBe(0);
    expect(report.zoneSampleEvents).toBe(0);
    expect(report.deviceStateEvents).toBe(0);
    expect(report.eventCount).toBe(0);
  });

  it('R2-BUG-05: a segment whose mtime predates the window start is skipped WITHOUT being read (append-only invariant)', async () => {
    // Quiet precondition: freeze the auto-started world session (R73) so the
    // only in-window records are the ones this test produces.
    expect(await until(() => ctx.app.worldSessions.statusOf(envId) !== undefined, 5_000)).toBe(true);
    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/sim-${envId}-world-session/stop`, headers: auth(owner.token),
    });

    const from = new Date(Date.now() - 5_000).toISOString();
    const sim = await ctx.app.inject({
      method: 'POST', url: '/api/simulations', headers: auth(owner.token), payload: { environmentId: envId },
    });
    const simId = sim.json().id as string;
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(owner.token), payload: { speed: 1 } });
    expect(await timelineHas(ctx, owner, simId, records => records.some(r => r.kind === 'zone-sample'))).toBe(true);
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(owner.token) });

    // The prefilter invariant: an append-only segment's mtime ≥ every
    // record's recordedAt, so mtime < window-start ⇒ no in-window records ⇒
    // the file is not even read. Backdate every file of THIS env's sims to
    // just before the window — the bake must then find nothing, even though
    // the records' recordedAt sits inside the window.
    const backdated = new Date(Date.parse(from) - 60_000);
    let touched = 0;
    for (const filePath of iterSimJsonlFiles(ctx.trajectoryDir, envId)) {
      utimesSync(filePath, backdated, backdated);
      touched++;
    }
    expect(touched).toBeGreaterThan(0);

    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replays`,
      headers: auth(owner.token),
      payload: { from, to: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().report.zoneSampleEvents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T-019 (DevLoop R17, EC-F04): baked timeline events are observation-only —
// a replayed scenario must re-run the world WITHOUT re-triggering an agent
// decision per recorded sample (R10: 2326 spurious decisions in one window).
// ---------------------------------------------------------------------------

describe('replay baked events are observation-only (T-019)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp({ zoneSampleEverySimSec: 5 });
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Run a short sim with samples/decisions/commands, then replay the window. */
  async function replayWithBakedTimeline(): Promise<{
    envId: string;
    scenario: Record<string, unknown>;
  }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('replay-storm'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;

    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: { speed: 1 },
    });
    expect(await timelineHas(ctx, owner, simId, records =>
      records.some(r => r.kind === 'zone-sample'))).toBe(true);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: auth(owner.token),
      payload: { type: 'temperature-spike', zoneId: 'zone-a' },
    });
    expect(await snapshotHasDecisions(ctx, owner, simId)).toBe(true);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/stop`,
      headers: auth(owner.token),
    });

    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replays`,
      headers: auth(owner.token),
      payload: {
        from: new Date(Date.now() - 5_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(replay.statusCode).toBe(200);
    const report = replay.json().report;
    expect(report.zoneSampleEvents).toBeGreaterThan(0);
    expect(report.decisionEvents).toBeGreaterThan(0);
    return { envId, scenario: replay.json().scenario as Record<string, unknown> };
  }

  it('marks every baked timeline event observationOnly: true', async () => {
    const { scenario } = await replayWithBakedTimeline();
    const events = scenario.events as Array<Record<string, unknown>>;
    const baked = events.filter(event =>
      event.type === 'zone-sample' || event.type === 'device-state' || event.type === 'sim-decision');
    expect(baked.length).toBeGreaterThan(0);
    for (const event of baked) {
      expect(event.observationOnly, event.id).toBe(true);
    }
    // The validated product still loads (the loader whitelists the flag).
    const { loadScenarioFile } = await import('@active-collaboration/core');
    expect(() => loadScenarioFile(scenario)).not.toThrow();
  });

  it('simulating the replayed scenario produces ZERO decisions from baked samples', async () => {
    const { scenario } = await replayWithBakedTimeline();

    // Four-channel hop: import the replay scenario as a new environment…
    const reimport = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...scenario, visibility: 'public' },
    });
    expect(reimport.statusCode).toBe(201);
    const replayEnvId = reimport.json().id as string;

    // …and run it. Pre-fix, every baked zone-sample was injected and fanned
    // out to managing agents (one decision per recorded sample).
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: replayEnvId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: { speed: 10 },
    });
    // Run the replayed world WELL past the baked window (baked events sit
    // at sim ≲1s; poll until the sim has advanced to sim 10) — then the
    // zero-decisions assertion below is a real negative, not an
    // under-waited window (was a fixed 900ms sleep; R21 test-debt).
    const advanced = await until(async () => {
      const res = await ctx.app.inject({
        method: 'GET', url: `/api/simulations/${simId}/snapshot`, headers: auth(owner.token),
      });
      return res.statusCode === 200 && (res.json().simTimeSec as number) >= 10;
    }, 20_000, 50);
    expect(advanced).toBe(true);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/stop`,
      headers: auth(owner.token),
    });

    const snapshotRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(owner.token),
    });
    expect(snapshotRes.statusCode).toBe(200);
    const decisions = (snapshotRes.json().recentDecisions ?? []) as Array<{ eventId?: string }>;
    const fromBaked = decisions.filter(decision =>
      typeof decision.eventId === 'string' &&
      /^replay:(zone|dec|dev):/.test(decision.eventId));
    expect(fromBaked).toHaveLength(0);
  });
});
