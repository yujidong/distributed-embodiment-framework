/**
 * @vitest-environment node
 *
 * Actuation safety gates (P3b) — policy evaluation order + safe default
 * ('confirm'), the pending queue lifecycle (park → approve/reject/expire),
 * per-entity rate limits, the emergency stop (blocks EVERYTHING, approved
 * re-dispatch included), audit coverage for every path, policy-write authz
 * (ADMIN_EMAILS for global, env-owner for scoped), and the env device
 * binding editor path (PATCH binding → next sim run actuates for real).
 * MockHassServer only — no real Home Assistant anywhere.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { MockHassServer } from './hass/mock-hass.js';
import {
  auth,
  createUserScenario,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

/** One zone pair, one sim sensor, one HA light, one agent driving both. */
function mixedScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Safety Lab' },
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
        initialState: { temperature: 20 },
      },
      {
        id: 'ha-light-b',
        type: 'light',
        capabilities: ['lighting-control', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
        binding: 'hass://light.living_room',
      },
    ],
    agents: [
      {
        id: 'lab-agent',
        name: 'Lab Agent',
        capabilities: ['temperature-monitoring', 'lighting-control'],
        managesZoneIds: ['zone-a', 'zone-b'],
        boundDeviceIds: ['temp-sensor-a', 'ha-light-b'],
      },
    ],
    events: [],
  };
}

interface SafetyFixture {
  ctx: TestAppContext;
  mock: MockHassServer;
  simId: string;
  /** Fix-1: device commands require an authenticated caller. */
  commander: TestUser;
}

/** Mock HA + app + uploaded mixed scenario + created simulation. */
async function makeSafetyFixture(
  overrides: Record<string, unknown> = {},
): Promise<SafetyFixture> {
  const mock = await MockHassServer.start();
  const ctx = await makeTestApp({ hassUrl: mock.url, hassToken: 'test-token', ...overrides });
  const upload = await createUserScenario(ctx.app, mixedScenario('safety-lab'));
  expect(upload.statusCode).toBe(201);
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/simulations',
    payload: { scenarioId: 'safety-lab' },
  });
  expect(created.statusCode).toBe(201);
  const commander = await registerUser(ctx.app, { displayName: 'Commander' });
  return { ctx, mock, simId: created.json().id as string, commander };
}

/** Fire turn-on at the HA light through the manual command endpoint. */
function commandLight(fixture: SafetyFixture, user: TestUser = fixture.commander) {
  return fixture.ctx.app.inject({
    method: 'POST',
    url: `/api/simulations/${fixture.simId}/commands`,
    headers: auth(user.token),
    payload: { deviceId: 'ha-light-b', commandName: 'turn-on' },
  });
}

/**
 * Normalize a command response to the device-level outcome. Fix-1 flattened
 * execution failures to a single layer (`{success:false, error, code?}`);
 * S3 flattened the executed-SUCCESS body the same way (the device result is
 * spread to the top level, one `success: true`, the device's own `result`
 * payload at `body.result`). The 202 pending path keeps the ENGINE shape
 * (T70: the coordinator's own verdict — `{success:false, result:{…}}` —
 * plus the pending markers), so the gate's `code` rides `result.result.code`
 * there; the single-layer failure path carries it at `body.code`.
 */
function outcomeOf(body: Record<string, unknown>): {
  success: boolean;
  error?: string;
  code?: string;
} {
  const engineWrapCode = (() => {
    const coordinatorResult = body.result as { result?: { code?: unknown } } | undefined;
    const code = coordinatorResult?.result?.code;
    return typeof code === 'string' ? code : undefined;
  })();
  if (body.success === false) {
    return {
      success: false,
      error: body.error as string | undefined,
      code: (body.code as string | undefined) ?? engineWrapCode,
    };
  }
  const inner = (body.result ?? {}) as {
    success?: boolean;
    error?: string;
    code?: string;
    result?: { code?: string };
  };
  // 202 pending: inner is the device-level `{success:false, result:{code}}`
  // soft-block marker.
  if (inner.success === false) {
    return { success: false, error: inner.error, code: inner.result?.code };
  }
  // S3 executed success: single layer — `body.result` IS the command payload.
  return { success: body.success === true, code: inner.code };
}

describe('hass actuation safety gates (P3b)', () => {
  let fixture: SafetyFixture | undefined;
  let ctx: TestAppContext | undefined;

  afterEach(async () => {
    await fixture?.ctx.cleanup();
    fixture = undefined;
    await ctx?.cleanup();
    ctx = undefined;
  });

  // -------------------------------------------------------------------------
  // Policy evaluation
  // -------------------------------------------------------------------------

  it('DEFAULT POLICY is confirm: a command parks with 202 + pending id and never reaches HA', async () => {
    fixture = await makeSafetyFixture();

    const res = await commandLight(fixture);
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.pending).toBe(true);
    expect(typeof body.pendingId).toBe('string');
    // Soft-block, distinguishable at the device level too.
    const inner = outcomeOf(body);
    expect(inner.success).toBe(false);
    expect(inner.code).toBe('PENDING_CONFIRMATION');
    // Nothing reached the socket.
    expect(fixture.mock.serviceCalls).toEqual([]);
  });

  it('evaluation order: explicit deny > confirm > allow > default', async () => {
    const adminEmail = 'gate-admin@example.com';
    fixture = await makeSafetyFixture({ adminEmails: [adminEmail] });
    const admin = await registerUser(fixture.ctx.app, { email: adminEmail });

    const create = (effect: string, pattern = 'light.living_room') =>
      fixture!.ctx.app.inject({
        method: 'POST',
        url: '/api/hass/policies',
        headers: auth(admin.token),
        payload: { entityPattern: pattern, effect },
      });

    // allow + confirm both match → confirm wins (parks, does not execute).
    expect((await create('allow')).statusCode).toBe(201);
    expect((await create('confirm')).statusCode).toBe(201);
    let res = await commandLight(fixture);
    expect(res.statusCode).toBe(202);
    expect(fixture.mock.serviceCalls).toEqual([]);

    // deny on top → hard block, 200 with a device-level failure.
    expect((await create('deny')).statusCode).toBe(201);
    res = await commandLight(fixture);
    expect(res.statusCode).toBe(200);
    const inner = outcomeOf(res.json());
    expect(inner.success).toBe(false);
    expect(inner.code).toBe('POLICY_DENIED');
    expect(inner.error).toMatch(/blocked by safety policy/);
    expect(fixture.mock.serviceCalls).toEqual([]);
  });

  it('prefix patterns match (light.*) and an allow policy executes + audits', async () => {
    const adminEmail = 'gate-admin@example.com';
    fixture = await makeSafetyFixture({ adminEmails: [adminEmail] });
    const admin = await registerUser(fixture.ctx.app, { email: adminEmail });

    const created = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/hass/policies',
      headers: auth(admin.token),
      payload: { entityPattern: 'light.*', effect: 'allow' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      envId: null,
      entityPattern: 'light.*',
      effect: 'allow',
      createdBy: admin.id,
    });

    const res = await commandLight(fixture);
    expect(res.statusCode).toBe(200);
    expect(outcomeOf(res.json()).success).toBe(true);
    expect(fixture.mock.serviceCalls).toEqual([
      { domain: 'light', service: 'turn_on', target: { entity_id: 'light.living_room' } },
    ]);

    // Audit: one 'allowed' row naming the basis + outcome.
    const audit = await fixture.ctx.app.inject({
      method: 'GET',
      url: '/api/hass/audit?entity=light.living_room',
      headers: auth(admin.token),
    });
    const rows = audit.json().audit as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      simId: fixture.simId,
      entityId: 'light.living_room',
      command: 'turn-on',
      decision: 'allowed',
    });
    expect(rows[0].reason).toMatch(/allowed by policy .* executed: success/);
  });

  // -------------------------------------------------------------------------
  // Pending queue lifecycle
  // -------------------------------------------------------------------------

  it('park → approve → executes through the engine; re-approve is 409', async () => {
    fixture = await makeSafetyFixture();
    const user = await registerUser(fixture.ctx.app);

    const parked = await commandLight(fixture);
    const pendingId = parked.json().pendingId as string;

    const list = await fixture.ctx.app.inject({
      method: 'GET',
      url: '/api/hass/pending',
      headers: auth(user.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().pending).toEqual([
      expect.objectContaining({
        id: pendingId,
        simId: fixture.simId,
        deviceId: 'ha-light-b',
        entityId: 'light.living_room',
        commandName: 'turn-on',
        status: 'pending',
        // Fix-1: commands are always authenticated, so the caller is attributed.
        requestedBy: fixture.commander.id,
      }),
    ]);

    const approved = await fixture.ctx.app.inject({
      method: 'POST',
      url: `/api/hass/pending/${pendingId}/approve`,
      headers: auth(user.token),
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('approved');
    expect(fixture.mock.serviceCalls).toEqual([
      { domain: 'light', service: 'turn_on', target: { entity_id: 'light.living_room' } },
    ]);

    const again = await fixture.ctx.app.inject({
      method: 'POST',
      url: `/api/hass/pending/${pendingId}/approve`,
      headers: auth(user.token),
    });
    expect(again.statusCode).toBe(409);

    // Audit tells the whole story: pending → approved → allowed(executed).
    const audit = await fixture.ctx.app.inject({
      method: 'GET',
      url: `/api/hass/audit?sim=${fixture.simId}`,
      headers: auth(user.token),
    });
    expect((audit.json().audit as Array<{ decision: string }>).map(r => r.decision).sort())
      .toEqual(['allowed', 'approved', 'pending']);
  });

  it('park → reject → never executes', async () => {
    fixture = await makeSafetyFixture();
    const user = await registerUser(fixture.ctx.app);

    const pendingId = (await commandLight(fixture)).json().pendingId as string;
    const rejected = await fixture.ctx.app.inject({
      method: 'POST',
      url: `/api/hass/pending/${pendingId}/reject`,
      headers: auth(user.token),
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe('rejected');
    expect(fixture.mock.serviceCalls).toEqual([]);

    const list = await fixture.ctx.app.inject({
      method: 'GET',
      url: '/api/hass/pending',
      headers: auth(user.token),
    });
    expect(list.json().pending).toEqual([]);
  });

  it('parked commands expire after the TTL and become unactionable', async () => {
    fixture = await makeSafetyFixture();
    const user = await registerUser(fixture.ctx.app);

    const pendingId = (await commandLight(fixture)).json().pendingId as string;
    // Age the row past the 5-minute TTL directly (lazy expiry does the rest).
    fixture.ctx.app.db
      .prepare('UPDATE hass_pending SET requested_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), pendingId);

    const list = await fixture.ctx.app.inject({
      method: 'GET',
      url: '/api/hass/pending',
      headers: auth(user.token),
    });
    expect(list.json().pending).toEqual([]);

    const approved = await fixture.ctx.app.inject({
      method: 'POST',
      url: `/api/hass/pending/${pendingId}/approve`,
      headers: auth(user.token),
    });
    expect(approved.statusCode).toBe(409);
    expect(approved.json().error.code).toBe('PENDING_EXPIRED');
    expect(fixture.mock.serviceCalls).toEqual([]);
  });

  it('manual commands attribute the caller; engine-initiated actuation stays user-less', async () => {
    fixture = await makeSafetyFixture();
    const user = await registerUser(fixture.ctx.app);

    // Authenticated manual command → pending row + audit carry the user id.
    const pendingId = (await commandLight(fixture, user)).json().pendingId as string;
    const row = fixture.ctx.app.db
      .prepare('SELECT requested_by FROM hass_pending WHERE id = ?')
      .get(pendingId) as { requested_by: string | null };
    expect(row.requested_by).toBe(user.id);

    // Engine-side dispatch (no HTTP caller) → requested_by / user_id NULL.
    const runtime = fixture.ctx.app.simulations.getOrThrow(fixture.simId).runtime;
    const engineOutcome = await runtime.executeDeviceCommand('ha-light-b', 'turn-off');
    const engineDevice = (engineOutcome as { result?: { result?: { code?: string } } }).result;
    expect(engineDevice?.result?.code).toBe('PENDING_CONFIRMATION');

    const audit = fixture.ctx.app.db
      .prepare(`SELECT user_id FROM hass_audit WHERE sim_id = ? AND decision = 'pending' ORDER BY id`)
      .all(fixture.simId) as Array<{ user_id: string | null }>;
    expect(audit.map(r => r.user_id)).toEqual([user.id, null]);
  });

  // -------------------------------------------------------------------------
  // Rate limit + emergency stop
  // -------------------------------------------------------------------------

  it('rate limits per entity (token bucket)', async () => {
    fixture = await makeSafetyFixture({ hassDefaultPolicy: 'allow', hassRateLimitPerMin: 2 });
    const user = await registerUser(fixture.ctx.app);

    expect(outcomeOf((await commandLight(fixture)).json()).success).toBe(true);
    expect(outcomeOf((await commandLight(fixture)).json()).success).toBe(true);

    const third = await commandLight(fixture);
    const inner = outcomeOf(third.json());
    expect(inner.success).toBe(false);
    expect(inner.code).toBe('RATE_LIMITED');
    expect(inner.error).toMatch(/rate limited/);
    expect(fixture.mock.serviceCalls).toHaveLength(2);

    const audit = await fixture.ctx.app.inject({
      method: 'GET',
      url: '/api/hass/audit?entity=light.living_room',
      headers: auth(user.token),
    });
    expect((audit.json().audit as Array<{ decision: string }>).map(r => r.decision))
      .toEqual(['rate-limited', 'allowed', 'allowed']); // newest first
  });

  it('emergency stop blocks EVERY actuation (allowed and approved) until cleared', async () => {
    fixture = await makeSafetyFixture({ hassDefaultPolicy: 'allow' });
    const user = await registerUser(fixture.ctx.app);

    // Allowed path works, then the E-stop kills it.
    expect(outcomeOf((await commandLight(fixture)).json()).success).toBe(true);
    const engage = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/hass/estop',
      headers: auth(user.token),
    });
    expect(engage.statusCode).toBe(200);
    expect(engage.json()).toMatchObject({ active: true, by: user.id });

    const blocked = await commandLight(fixture);
    const inner = outcomeOf(blocked.json());
    expect(inner.success).toBe(false);
    expect(inner.code).toBe('ESTOP_ACTIVE');
    expect(inner.error).toMatch(/emergency stop active/);
    expect(fixture.mock.serviceCalls).toHaveLength(1); // nothing new reached HA

    // …and even an approved parked command cannot execute under the E-stop.
    fixture.ctx.app.db
      .prepare(
        `INSERT INTO hass_pending
         (id, sim_id, device_id, entity_id, command_name, params_json, requested_by, requested_at, status)
         VALUES ('parked-1', ?, 'ha-light-b', 'light.living_room', 'turn-off', '{}', NULL, ?, 'pending')`,
      )
      .run(fixture.simId, new Date().toISOString());
    const approved = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/hass/pending/parked-1/approve',
      headers: auth(user.token),
    });
    expect(approved.statusCode).toBe(200);
    const execution = (approved.json().execution as { result?: { result?: { code?: string } } });
    expect(execution.result?.result?.code).toBe('ESTOP_ACTIVE');
    expect(fixture.mock.serviceCalls).toHaveLength(1);

    // Clear → actuation flows again.
    const cleared = await fixture.ctx.app.inject({
      method: 'DELETE',
      url: '/api/hass/estop',
      headers: auth(user.token),
    });
    expect(cleared.json().active).toBe(false);
    expect(outcomeOf((await commandLight(fixture)).json()).success).toBe(true);

    const audit = await fixture.ctx.app.inject({
      method: 'GET',
      url: '/api/hass/audit',
      headers: auth(user.token),
    });
    const decisions = (audit.json().audit as Array<{ decision: string }>).map(r => r.decision);
    expect(decisions.filter(d => d === 'estopped')).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Policy write authz + API auth
  // -------------------------------------------------------------------------

  it('global policy writes require ADMIN_EMAILS; reads are open to any user', async () => {
    fixture = await makeSafetyFixture({ adminEmails: ['the-admin@example.com'] });
    const admin = await registerUser(fixture.ctx.app, { email: 'the-admin@example.com' });
    const other = await registerUser(fixture.ctx.app);

    const forbidden = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/hass/policies',
      headers: auth(other.token),
      payload: { entityPattern: 'light.*', effect: 'deny' },
    });
    expect(forbidden.statusCode).toBe(403);

    const created = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/hass/policies',
      headers: auth(admin.token),
      payload: { entityPattern: 'light.*', effect: 'deny' },
    });
    expect(created.statusCode).toBe(201);

    // Any authenticated user READS the policy list.
    const list = await fixture.ctx.app.inject({
      method: 'GET',
      url: '/api/hass/policies',
      headers: auth(other.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().policies).toHaveLength(1);

    // DELETE follows the same rule.
    const deniedDelete = await fixture.ctx.app.inject({
      method: 'DELETE',
      url: `/api/hass/policies/${created.json().id}`,
      headers: auth(other.token),
    });
    expect(deniedDelete.statusCode).toBe(403);
    const okDelete = await fixture.ctx.app.inject({
      method: 'DELETE',
      url: `/api/hass/policies/${created.json().id}`,
      headers: auth(admin.token),
    });
    expect(okDelete.statusCode).toBe(204);
  });

  it('env-scoped policies require the env OWNER and apply to env-backed sims', async () => {
    fixture = await (async () => {
      const mock = await MockHassServer.start();
      const appCtx = await makeTestApp({ hassUrl: mock.url, hassToken: 'test-token' });
      return { ctx: appCtx, mock, simId: '' };
    })();
    const owner = await registerUser(fixture.ctx.app);
    const intruder = await registerUser(fixture.ctx.app);

    // Import a world, then bind its HVAC to the mock HA light (deployment).
    const env = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: importableScenario('safety-env'),
    });
    expect(env.statusCode).toBe(201);
    const envId = env.json().id as string;
    const hvac = (env.json().devices as Array<{ id: string; name: string }>)
      .find(d => d.name === 'HVAC B')!;

    // A non-owner cannot write the env's policies.
    const forbidden = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/hass/policies',
      headers: auth(intruder.token),
      payload: { envId, entityPattern: 'light.living_room', effect: 'allow' },
    });
    expect(forbidden.statusCode).toBe(403);

    // The owner allow-lists exactly one entity, scoped to this env.
    const policy = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/hass/policies',
      headers: auth(owner.token),
      payload: { envId, entityPattern: 'light.living_room', effect: 'allow' },
    });
    expect(policy.statusCode).toBe(201);
    expect(policy.json().envId).toBe(envId);

    // Bind the HVAC → hass://light.living_room via the device PATCH path.
    const patch = await fixture.ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${hvac.id}`,
      headers: auth(owner.token),
      payload: { binding: 'hass://light.living_room' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().binding).toBe('hass://light.living_room');

    // Next sim run from this environment actuates the REAL entity (allow).
    const sim = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const res = await fixture.ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sim.json().id}/commands`,
      headers: auth(owner.token),
      payload: { deviceId: hvac.id, commandName: 'turn-on' },
    });
    expect(res.statusCode).toBe(200);
    expect(outcomeOf(res.json()).success).toBe(true);
    expect(fixture.mock.serviceCalls).toEqual([
      { domain: 'light', service: 'turn_on', target: { entity_id: 'light.living_room' } },
    ]);
  });

  it('device binding PATCH validates the scheme and resets on null', async () => {
    ctx = await makeTestApp();
    const owner = await registerUser(ctx.app);
    const env = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: importableScenario('binding-env'),
    });
    const hvacId = (env.json().devices as Array<{ id: string; name: string }>)
      .find(d => d.name === 'HVAC B')!.id;
    const bad = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${hvacId}`,
      headers: auth(owner.token),
      payload: { binding: 'mqtt://light.living_room' },
    });
    expect(bad.statusCode).toBe(400);

    const set = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${hvacId}`,
      headers: auth(owner.token),
      payload: { binding: 'hass://light.living_room' },
    });
    expect(set.json().binding).toBe('hass://light.living_room');

    const reset = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${hvacId}`,
      headers: auth(owner.token),
      payload: { binding: null },
    });
    expect(reset.json().binding).toBe(`sim://${hvacId}`);
    void env;
  });

  it('requires authentication on every safety endpoint', async () => {
    ctx = await makeTestApp();
    const endpoints: Array<[string, string]> = [
      ['GET', '/api/hass/policies'],
      ['POST', '/api/hass/policies'],
      ['DELETE', '/api/hass/policies/x'],
      ['GET', '/api/hass/pending'],
      ['POST', '/api/hass/pending/x/approve'],
      ['POST', '/api/hass/pending/x/reject'],
      ['GET', '/api/hass/audit'],
      ['GET', '/api/hass/estop'],
      ['POST', '/api/hass/estop'],
      ['DELETE', '/api/hass/estop'],
    ];
    for (const [method, url] of endpoints) {
      const res = await ctx.app.inject({ method: method as 'GET', url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
