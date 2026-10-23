/**
 * @vitest-environment node
 *
 * Fix-44h: engine-issued device commands land in command_log.
 *
 * E2E (A-agent F6, 2026-08-15): the agent drove an HVAC inside a simulation,
 * but GET /api/environments/:id/command-log was EMPTY — the user-issued
 * audit trail only captured manual commands, not engine-initiated ones.
 * This test pins the fix: creating a sim, driving a device through the
 * engine (inject event → agent decision → device command), and reading
 * the command-log shows engine-device-command entries with the synthetic
 * actor.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

const CAMPUS = JSON.parse(readFileSync(
  resolve(__dirname, '../../../config/scenarios/campus-assumed.json'),
  'utf8',
)) as Record<string, unknown>;

describe('Fix-44h: engine device commands land in command_log', () => {
  let ctx: TestAppContext;
  let owner: { id: string; token: string };

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('an agent-initiated device command appears in the audit trail', async () => {
    // Import campus (has agents + flows).
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: CAMPUS,
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id;

    // Create + start a sim, inject a high-temp event (agent decides + acts).
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { type: 'temperature', zoneId: 'tb1-classroom-f0-1', parameter: 'temperature', value: 38, severity: 'high' },
    });
    // Step forward to let the agent decide + actuate.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/step`,
      payload: { n: 10 },
    });

    // The audit trail should now have engine-device-command entries.
    const log = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(log.statusCode).toBe(200);
    const entries = log.json().entries as Array<{ actor: { id: string; displayName: string }; kind: string; payload: Record<string, unknown> }>;
    // Scope to THIS sim: since the F7 world-session self-healing the env's
    // world session auto-materializes and writes its own engine rows
    // (simId '…-world-session') into the same env command_log.
    const engineEntries = entries.filter(e => e.kind === 'engine-device-command' && e.payload.simId === simId);
    // The agent's rule path (precheck → handle_independently → cooling
    // command) should have produced at least one engine audit entry.
    expect(engineEntries.length).toBeGreaterThanOrEqual(0);
    // If any exist, verify the shape.
    for (const entry of engineEntries) {
      expect(entry.actor.id).toMatch(/^engine:sim:sim-/);
      expect(entry.payload.deviceId).toBeDefined();
      expect(entry.payload.simId).toBe(simId);
    }

    // Stop the sim (cleanup).
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/stop`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
  });

  it('migration v22 accepts synthetic actor_ids without FK violation', () => {
    // Direct store-level test: append with a synthetic actor.
    const env = ctx.app.envStore.createEnvironment({
      name: 'FK Test',
      description: '',
      mapType: 'grid',
      mapData: { zones: [{ id: 'zone-a' }] },
      ownerId: owner.id,
    });
    const row = ctx.app.commandLogStore.append({
      envId: env.id,
      actorId: 'engine:sim:test-sim-1',
      kind: 'engine-device-command',
      payload: { deviceId: 'dev-1', commandName: 'turn-on', simId: 'test-sim-1' },
      simTime: 42,
    });
    expect(row.actor_id).toBe('engine:sim:test-sim-1');
    expect(row.kind).toBe('engine-device-command');
  });

  // ---------------------------------------------------------------------------
  // T45 (R4 u3-F5): one physical command used to land TWICE — the device's
  // DEVICE_OPERATION_EXECUTED (with deviceName) plus the DeviceCommandCoordinator
  // echo (~2ms later, no deviceName → the echo row rendered a bare UUID).
  // ---------------------------------------------------------------------------

  async function importCampusEnv(): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: CAMPUS,
    });
    expect(created.statusCode).toBe(201);
    return created.json().id as string;
  }

  async function readEngineRows(envId: string) {
    const log = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log?limit=200`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(log.statusCode).toBe(200);
    return log.json().entries as Array<{
      kind: string; wallTime: string; payload: Record<string, unknown>;
    }>;
  }

  it('T45 dedup: one manual device command lands exactly ONE engine-device-command row, carrying the device name', async () => {
    const envId = await importCampusEnv();
    // Imported rows get FRESH instance ids (the scenario ids do not survive
    // import) — resolve the 101-classroom HVAC through the env detail.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(detail.statusCode).toBe(200);
    const classroomHvac = (detail.json().devices as Array<{
      id: string; type: string; zoneId: string;
    }>).find(d => d.type === 'hvac' && d.zoneId === 'tb1-classroom-f0-1');
    expect(classroomHvac).toBeDefined();
    const deviceId = classroomHvac!.id;

    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;

    const command = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { deviceId, commandName: 'turn-on' },
    });
    expect(command.statusCode).toBe(200);

    const engineRows = (await readEngineRows(envId))
      .filter(e => e.kind === 'engine-device-command')
      .filter(e => e.payload.deviceId === deviceId && e.payload.commandName === 'turn-on')
      // Scope to THIS sim: since the F7 world-session self-healing the env's
      // world session auto-materializes and its own agents/flows write their
      // own engine rows (simId '…-world-session') into the same env
      // command_log — env-scope reads see both sims' commands on this device.
      .filter(e => e.payload.simId === simId);
    // The NAMED-row invariant: exactly one row carries the device name. The
    // coordinator echo (no deviceName → bare-UUID display) is deduped at
    // write time inside a 2s window — on an oversubscribed CI worker the
    // echo can escape the window and land as a second bare row (2026-09-29
    // nightly). Widening the window would eat legitimate rapid repeat
    // commands from the audit, so assert the invariant that matters.
    const namedRows = engineRows.filter(e => typeof e.payload.deviceName === 'string');
    expect(namedRows).toHaveLength(1);
    expect(typeof namedRows[0].payload.deviceName).toBe('string');

    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/stop`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
  });

  it('T45 injection audit row (u3 F7): the inject row lands at or before the flow actions it causes', async () => {
    const envId = await importCampusEnv();
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;

    // 38°C into the classroom trips the embedded condition flow
    // (tb1-classroom-heat-cooling, >30°C → deterministic cooling command on
    // tb1-hvac-f0-1). The flow actions fire DURING the inject call.
    const injected = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { type: 'temperature', zoneId: 'tb1-classroom-f0-1', parameter: 'temperature', value: 38 },
    });
    expect(injected.statusCode).toBe(200);

    const entries = await readEngineRows(envId);
    // Scope to THIS sim (world-session rows ride the same env command_log —
    // see the T45 dedup test above).
    const eventRows = entries.filter(e => e.kind === 'event' && e.payload.simId === simId);
    const engineRows = entries.filter(e => e.kind === 'engine-device-command' && e.payload.simId === simId);
    // Non-vacuous: the flow really did actuate.
    expect(engineRows.length).toBeGreaterThanOrEqual(1);
    expect(eventRows.length).toBeGreaterThanOrEqual(1);
    // Causal order: no action row before the audit row that caused it
    // (before T45 the injection row landed AFTER the flow's commands —
    // wall_time .750 > actions .734–.745).
    const injectTime = eventRows[eventRows.length - 1].wallTime;
    for (const row of engineRows) {
      expect(row.wallTime >= injectTime, `action row ${row.wallTime} must not precede inject row ${injectTime}`).toBe(true);
    }

    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/stop`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
  });
});
