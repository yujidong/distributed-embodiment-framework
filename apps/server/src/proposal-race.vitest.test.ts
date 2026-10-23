/**
 * @vitest-environment node
 *
 * R33 (DevLoop, Smart F1) — sequential proposal submissions must not race.
 *
 * The finding: under auto-apply, install-agents submitted right after
 * install-devices was rule-checked BEFORE the device proposals applied →
 * "boundDeviceIds references unknown device" → REJECTED (3x; the builder
 * had to resubmit by hand). Root cause: submit() is async — the reviewer
 * await splits the rule check from the apply across ticks, so two rapid
 * submissions interleave. Fix: the whole per-env pipeline (check → review
 * → apply) is serialized in submission order; a proposal submitted after
 * another one lands against the world the earlier one already wrote.
 *
 * The repro mirrors the finding's shape with explicit-ids objects (zones):
 * an install-devices referencing a zone whose install-zones proposal is
 * still in flight — pre-fix the devices proposal was rule-checked against
 * a world without the zone and REJECTED.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';
import { ProposalService } from './proposal-service.js';
import { openDatabase } from './db/database.js';
import { ProposalStore } from './db/proposal-store.js';
import type { ProposalReviewer } from './proposal-reviewer.js';
import type { EnvironmentRow } from './db/environment-store.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

describe('R33 proposal submission race (Smart F1)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let envId: string;

  beforeEach(async () => {
    // autoApproveLowRisk: the auto-apply funnel the finding raced under.
    ctx = await makeTestApp({ proposalReviewTimeoutAutoApprove: true });
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Race Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'lobby' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function submit(payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
      payload,
    });
  }

  it('a proposal submitted behind an in-flight one lands against its APPLIED world (serialized pipeline)', async () => {
    // Fire both submissions WITHOUT awaiting the first — the devices
    // proposal references zone 'lab-1', which only exists once the zones
    // proposal ahead of it applies.
    const [zonesRes, devicesRes] = await Promise.all([
      submit({ kind: 'install-zones', payload: { zones: [{ id: 'lab-1' }] } }),
      submit({
        kind: 'install-devices',
        payload: {
          devices: [{ name: 'Lab Sensor', type: 'sensor', capabilities: ['temperature-monitoring'], zoneId: 'lab-1' }],
        },
      }),
    ]);

    expect(zonesRes.statusCode).toBe(201);
    expect(devicesRes.statusCode).toBe(201);
    // Submission order is honored: the zones proposal applies first…
    expect(zonesRes.json().status).toBe('applied');
    // …and the devices proposal is then rule-checked against the world the
    // zones proposal already wrote — NOT rejected with "references unknown
    // zone" (the pre-fix race outcome, same shape as the finding's
    // "boundDeviceIds references unknown device").
    expect(devicesRes.json().status).toBe('applied');
    expect(JSON.stringify(devicesRes.json().ruleCheck)).not.toContain('unknown zone');
    expect(devicesRes.json().createdIds).toMatchObject({ devices: [expect.any(String)] });

    // The world actually holds both artifacts.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(builder.token),
    });
    const zones = detail.json().zones as Array<{ id: string }>;
    expect(zones.some(zone => zone.id === 'lab-1')).toBe(true);
  });

  it('a predecessor FAILURE does not stall the queue — the follower still runs (and judges the world honestly)', async () => {
    // The serialized chain must not poison: a rejected submission ahead of
    // a valid one still lets the follower through.
    const [badRes, goodRes] = await Promise.all([
      submit({ kind: 'install-zones', payload: { zones: [{ id: '' }] } }), // invalid → rejected
      submit({ kind: 'install-zones', payload: { zones: [{ id: 'lab-2' }] } }),
    ]);
    expect(badRes.json().status).toBe('rejected');
    expect(goodRes.json().status).toBe('applied');
    expect(goodRes.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Deterministic unit level: a GATED reviewer recreates the production race
// window (the LLM reviewer's latency) — with the per-env serialization the
// second submission's rule check cannot run inside the first's await window.
// ---------------------------------------------------------------------------

describe('R33 proposal pipeline serialization (unit)', () => {
  it('a follower submission waits for the in-flight pipeline before its rule check', async () => {
    const db = openDatabase(':memory:');
    const proposalStore = new ProposalStore(db);
    const now = new Date().toISOString();
    // The proposals table foreign-keys env_id → environments and
    // author_id → users; seed the minimal rows the store inserts against.
    db.prepare(
      'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('builder-1', 'builder@race.test', 'x', 'Builder', now);
    db.prepare(
      'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('owner-1', 'owner@race.test', 'x', 'Owner', now);
    const env: EnvironmentRow = {
      id: 'env-1',
      name: 'Lab',
      description: '',
      map_type: 'grid',
      map_data_json: JSON.stringify({ zones: [{ id: 'lobby' }] }),
      owner_id: 'owner-1',
      visibility: 'public',
      guide_json: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.prepare(
      `INSERT INTO environments (id, name, description, map_type, map_data_json, owner_id, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(env.id, env.name, env.description, env.map_type, env.map_data_json, env.owner_id, env.visibility, env.created_at, env.updated_at);
    let mapData = JSON.parse(env.map_data_json) as { zones: Array<{ id: string }> };

    // The ORDER the rule checks observe the world in (the assertion core).
    const checkOrder: string[] = [];
    const gate = deferred<{ outcome: 'allow'; reason: string; source: string }>();
    let reviewCount = 0;
    const reviewer: ProposalReviewer = {
      review: () => {
        reviewCount += 1;
        // First submission's review BLOCKS (the production LLM latency that
        // opened the race window); later reviews resolve immediately.
        return reviewCount === 1 ? gate.promise : Promise.resolve({
          outcome: 'allow', reason: 'auto', source: 'test',
        });
      },
    };

    const service = new ProposalService({
      envStore: {
        getEnvironment: (id: string) => (id === env.id ? env : undefined),
        // The world the follower's rule check reads: zones applied by the
        // predecessor become visible — recording WHEN each check saw them.
        getDevice: () => undefined,
        devicesOf: () => [],
        agentsOf: () => [],
        getAgent: () => undefined,
        countDevicesIn: () => 0,
        countAgentsIn: () => 0,
        createDevice: (input: { envId: string; ownerId: string; name: string; type: string; capabilities: string[]; zoneId: string }) => ({
          id: `dev-${input.name}`,
          env_id: input.envId,
          name: input.name,
          type: input.type,
          brand: null,
          capabilities_json: JSON.stringify(input.capabilities),
          zone_id: input.zoneId,
          position_json: null,
          initial_state_json: null,
          binding: null,
          owner_id: input.ownerId,
          created_at: new Date().toISOString(),
        }) as never,
        updateEnvironment: (_id: string, patch: { mapData?: { zones: Array<{ id: string }> } }) => {
          if (patch.mapData !== undefined) {
            mapData = patch.mapData;
            env.map_data_json = JSON.stringify(patch.mapData); // the world the NEXT check reads
          }
          return env;
        },
      } as never,
      catalogStore: { get: () => undefined } as never,
      proposalStore,
      commandLogStore: {
        findApplyEntry: () => undefined,
        listForEnv: () => [],
      } as never,
      userStore: { findById: () => undefined } as never,
      serviceStore: {
        syncDerivedForAgent: () => [],
        syncDerivedForDevice: () => [],
        deleteDerivedForDevice: () => [],
        servicesOfAgent: () => [],
      } as never,
      reputationStore: {} as never,
      pipeline: {
        publishProposal: () => {},
        publish: () => {},
        publishAgreement: () => {},
        log: () => ({ id: 1 }),
      } as never,
      quotas: {
        maxDevicesPerProposal: 50,
        maxAgentsPerProposal: 20,
        maxEventsPerProposal: 100,
        maxZonesPerEnv: 50,
      } as never,
      zoneClaimStore: { isClaimedBy: () => false, grant: () => {}, revoke: () => {} } as never,
      notificationStore: {
        create: (input: { userId: string }) => ({ id: `n-${input.userId}`, ...input }) as never,
        hasUnread: () => false,
      } as never,
      reviewer,
    });

    const author = { id: 'builder-1' } as never;
    // Interpose the ordering probe: patch getEnvironment to record when the
    // world still lacks 'lab-1' (pre-apply) vs has it (post-apply).
    const envStoreProbe = (service as unknown as { deps: { envStore: {
      getEnvironment: (id: string) => EnvironmentRow | undefined;
    } } }).deps.envStore;
    const originalGet = envStoreProbe.getEnvironment.bind(envStoreProbe);
    envStoreProbe.getEnvironment = (id: string): EnvironmentRow | undefined => {
      const row = originalGet(id);
      if (row !== undefined) {
        checkOrder.push(mapData.zones.some(zone => zone.id === 'lab-1') ? 'after-lab-1' : 'before-lab-1');
      }
      return row;
    };

    // Submission 1 (install-zones lab-1): blocks inside its review.
    const first = service.submit(env, author, 'install-zones', { zones: [{ id: 'lab-1' }] });
    // Let it reach the reviewer gate.
    await new Promise(resolve => setImmediate(resolve));
    expect(reviewCount).toBe(1);

    // Submission 2 (install-devices INTO lab-1) while #1 is gated: pre-fix,
    // its rule check ran NOW and saw no 'lab-1' (the Smart F1 rejection).
    const second = service.submit(env, author, 'install-devices', {
      devices: [{ name: 'Lab Sensor', type: 'sensor', capabilities: ['temperature-monitoring'], zoneId: 'lab-1' }],
    });
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    // The follower is STILL pending (its check has not run against a
    // lab-1-less world)…
    let secondSettled = false;
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(secondSettled).toBe(false);
    // …and the world checks so far all ran BEFORE lab-1 existed (only the
    // first submission's own checks).
    expect(checkOrder.every(entry => entry === 'before-lab-1')).toBe(true);

    // Release the first pipeline: zones apply, THEN the follower's check
    // runs against the world that has lab-1 — and it applies too.
    gate.resolve({ outcome: 'allow', reason: 'released', source: 'test' });
    const [firstRow, secondRow] = await Promise.all([first, second]);
    expect(firstRow.status).toBe('applied');
    expect(secondRow.status).toBe('applied');
    // The follower's check observed the predecessor's applied world.
    expect(checkOrder[checkOrder.length - 1]).toBe('after-lab-1');

    db.close();
  });
});
