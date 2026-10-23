/**
 * Data services (R14 Wave-A, design-data-services.md) — computation specs,
 * the consumable flip, the read/push lanes and their metering.
 *
 * Task-1 scope (this block): migration v32, the pure evaluator, computation
 * registration/revoke routes, and the propose gate flip. Read/push lane
 * coverage lives in the later describe blocks.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  evaluateComputation,
  parseComputationSpec,
  type ComputationInputs,
} from './computation-evaluator.js';
import { SimEventTallies } from './sim-event-tally.js';
import { parseMapData } from './db/environment-store.js';
import { makeTestApp, registerUser, auth, type TestAppContext, type TestUser } from './test-utils.js';

// ---------------------------------------------------------------------------
// Pure evaluator — unit tests (no app)
// ---------------------------------------------------------------------------

describe('computation-evaluator (pure)', () => {
  const inputs = (overrides: Partial<ComputationInputs> = {}): ComputationInputs => ({
    zones: [
      { id: 'ward-101', parameters: { temperature: 24, humidity: 50, motion: true } },
      { id: 'ward-102', parameters: { temperature: 26, humidity: 60 } },
      { id: 'other', parameters: { temperature: 99 } },
    ],
    devices: [
      { id: 'd1', capabilities: ['fall-detection'], state: { active: true, battery: 80 } },
      { id: 'd2', capabilities: ['fall-detection'], state: { active: false, battery: 60 } },
      { id: 'd3', capabilities: ['fall-detection'], state: { active: true, battery: 40 } },
      { id: 'meter', capabilities: ['energy-monitoring'], state: { power: 100 } },
    ],
    events: [
      { eventType: 'fall-detected', simTimeSec: 100 },
      { eventType: 'fall-detected', simTimeSec: 500 },
      { eventType: 'fall-detected', simTimeSec: 3600 },
      { eventType: 'other-type', simTimeSec: 600 },
    ],
    simTimeSec: 3700,
    ...overrides,
  });

  it('parses the design-doc example spec and reports its as-names', () => {
    const { spec, asNames, schemaVersion } = parseComputationSpec({
      kind: 'zone-query',
      refreshSec: 60,
      inputs: {
        zones: ['ward-101', 'ward-102'],
        metrics: [
          { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
          { source: 'zone', path: 'motion', fn: 'max', as: 'activityPeak' },
          { source: 'device', capability: 'fall-detection', fn: 'countActive', as: 'activeFallAlerts' },
          { source: 'event', eventType: 'fall-detected', fn: 'countSince', windowSec: 3600, as: 'fallsLastHour' },
        ],
      },
      excludes: ['per-resident vitals'],
    });
    expect(spec.kind).toBe('zone-query');
    expect(spec.zones).toEqual(['ward-101', 'ward-102']);
    expect(asNames).toEqual(['avgTemperature', 'activityPeak', 'activeFallAlerts', 'fallsLastHour']);
    expect(schemaVersion).toBe(1); // default
    expect(spec.excludes).toEqual(['per-resident vitals']);
  });

  it('aggregates zone parameters over the selected zones (booleans never fake numbers)', () => {
    const { spec } = parseComputationSpec({
      kind: 'zone-query',
      refreshSec: 60,
      inputs: {
        zones: ['ward-101', 'ward-102'],
        metrics: [
          { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemp' },
          { source: 'zone', path: 'temperature', fn: 'max', as: 'maxTemp' },
          { source: 'zone', path: 'motion', fn: 'avg', as: 'motionAvg' }, // booleans → no usable values
        ],
      },
    });
    const result = evaluateComputation(spec, inputs());
    expect(result.data).toEqual({ avgTemp: 25, maxTemp: 26, motionAvg: null });
    expect(result.inputsSummary).toEqual({ zones: 2, devices: 4, eventsWindowed: 0 });
  });

  it('aggregates provider devices without ever projecting one device', () => {
    const { spec } = parseComputationSpec({
      kind: 'device-aggregate',
      refreshSec: 30,
      inputs: {
        zones: '*',
        metrics: [
          { source: 'device', capability: 'fall-detection', fn: 'count', as: 'fallSensors' },
          { source: 'device', capability: 'fall-detection', fn: 'countActive', as: 'activeFallAlerts' },
          { source: 'device', capability: 'fall-detection', path: 'battery', fn: 'avg', as: 'avgBattery' },
          { source: 'device', capability: 'no-such-cap', path: 'x', fn: 'avg', as: 'nothing' },
        ],
      },
    });
    const result = evaluateComputation(spec, inputs());
    expect(result.data).toEqual({ fallSensors: 3, activeFallAlerts: 2, avgBattery: 60, nothing: null });
  });

  // T54 (R6, u4-F1): the never-written-state oracle. A value aggregated
  // entirely off scenario-initialState paths is flagged (fields + zoneEcho
  // cross-face contrast); one real write among the devices clears the flag;
  // an unknown written-set keeps the gate silent (honest-unknown).
  it('T54: value metrics over NEVER-WRITTEN state paths are flagged with the zone echo; any real write clears them', () => {
    const { spec } = parseComputationSpec({
      kind: 'device-aggregate',
      refreshSec: 30,
      inputs: {
        zones: ['zone-a'],
        metrics: [
          { source: 'device', capability: 'energy-monitoring', path: 'power', fn: 'avg', as: 'avgPower' },
          { source: 'zone', path: 'power', fn: 'avg', as: 'zonePower' },
        ],
      },
    });
    const zoneA = [{ id: 'zone-a', parameters: { power: 500, temperature: 24 } }];
    // All matching devices known + the path absent from every written set →
    // flagged, with the zone-parameter cross-face contrast attached.
    const flagged = evaluateComputation(spec, inputs({
      zones: zoneA,
      devices: [
        { id: 'meter-1', capabilities: ['energy-monitoring'], state: { power: 0 } },
      ],
      writtenDeviceStatePaths: { 'meter-1': [] },
    }));
    expect(flagged.inputsSummary.deviceStateUnwritten).toEqual({
      fields: ['avgPower'],
      zoneEcho: [{ field: 'avgPower', parameter: 'power', zoneId: 'zone-a', value: 500 }],
    });

    // A real write (command / tick effect / checkpoint restore) clears it —
    // the value is now a measurement.
    const written = evaluateComputation(spec, inputs({
      zones: zoneA,
      devices: [
        { id: 'meter-1', capabilities: ['energy-monitoring'], state: { power: 480 } },
      ],
      writtenDeviceStatePaths: { 'meter-1': ['power', 'status'] },
    }));
    expect(written.inputsSummary.deviceStateUnwritten).toBeUndefined();

    // Partial knowledge (a device whose written-set is unknown) stays
    // silent — the platform never fabricates an unwritten verdict.
    const unknown = evaluateComputation(spec, inputs({
      zones: zoneA,
      devices: [
        { id: 'meter-1', capabilities: ['energy-monitoring'], state: { power: 0 } },
        { id: 'meter-2', capabilities: ['energy-monitoring'], state: { power: 10 } },
      ],
      writtenDeviceStatePaths: { 'meter-1': [] }, // meter-2 unknown
    }));
    expect(unknown.inputsSummary.deviceStateUnwritten).toBeUndefined();

    // No written-map at all (legacy runtime) → silent.
    const legacy = evaluateComputation(spec, inputs({
      zones: zoneA,
      devices: [{ id: 'meter-1', capabilities: ['energy-monitoring'], state: { power: 0 } }],
    }));
    expect(legacy.inputsSummary.deviceStateUnwritten).toBeUndefined();
  });

  // T-065 (R16, CP-F10): inputs.devices — the per-bed lane. The evaluator
  // filters to the DECLARED set here (the one truth): a device outside the
  // declaration never enters a metric and never enters inputsSummary.
  it('T-065: a device-scoped spec reads exactly the declared devices (inputsSummary.devices = the scoped count)', () => {
    const { spec } = parseComputationSpec({
      kind: 'device-aggregate',
      refreshSec: 30,
      inputs: {
        zones: '*',
        devices: ['d1'],
        metrics: [
          // avg over a declared 1-device scope IS that bed's honest value —
          // the scope is explicit and provider-validated, not an arbitrary
          // newest-device pick (the refused `latest` semantics).
          { source: 'device', capability: 'fall-detection', path: 'battery', fn: 'avg', as: 'bedBattery' },
          { source: 'device', capability: 'fall-detection', fn: 'count', as: 'bedSensors' },
        ],
      },
    });
    expect(spec.devices).toEqual(['d1']);
    const result = evaluateComputation(spec, inputs());
    // d1 alone (battery 80) — d2/d3 (60/40, avg 50) and the meter never touch it.
    expect(result.data).toEqual({ bedBattery: 80, bedSensors: 1 });
    expect(result.inputsSummary.devices).toBe(1);

    // Multi-device scopes count exactly their members…
    const two = parseComputationSpec({
      kind: 'device-aggregate', refreshSec: 30,
      inputs: {
        zones: '*', devices: ['d1', 'd3'],
        metrics: [{ source: 'device', capability: 'fall-detection', path: 'battery', fn: 'avg', as: 'x' }],
      },
    }).spec;
    const twoResult = evaluateComputation(two, inputs());
    expect(twoResult.data.x).toBe(60); // avg(80, 40)
    expect(twoResult.inputsSummary.devices).toBe(2);

    // …and a scope whose device is absent from the gathered inputs (unbound
    // after registration) degrades honestly: no usable values, count 0.
    const ghost = parseComputationSpec({
      kind: 'device-aggregate', refreshSec: 30,
      inputs: {
        zones: '*', devices: ['ghost-device'],
        metrics: [{ source: 'device', capability: 'fall-detection', path: 'battery', fn: 'avg', as: 'x' }],
      },
    }).spec;
    const ghostResult = evaluateComputation(ghost, inputs());
    expect(ghostResult.data.x).toBeNull();
    expect(ghostResult.inputsSummary.devices).toBe(0);
  });

  it('T-065: inputs.devices is closed-schema validated (empty/duplicate/alone-without-device-metric/unknown sibling keys)', () => {
    const rejectsWith = (raw: unknown, pattern: RegExp): void => {
      let message: string | null = null;
      try {
        parseComputationSpec(raw);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, `spec should have been rejected: ${JSON.stringify(raw)}`).toMatch(pattern);
    };
    const base = (devices: unknown, extra: Record<string, unknown> = {}) => ({
      kind: 'device-aggregate', refreshSec: 30,
      inputs: {
        zones: '*', devices,
        metrics: [{ source: 'device', capability: 'c', path: 'p', fn: 'avg', as: 'x' }],
        ...extra,
      },
    });
    rejectsWith(base([]), /inputs\.devices.*non-empty array/);
    rejectsWith(base(['d1', 'd1']), /must not repeat/);
    rejectsWith(base(['d1', '']), /devices\[1\].*non-empty string/);
    rejectsWith(base(['d1'], { bogus: 1 }), /inputs\.bogus/);
    // A device scope with nothing to scope reads nothing — refused with teaching.
    rejectsWith({
      kind: 'zone-query', refreshSec: 30,
      inputs: {
        zones: '*', devices: ['d1'],
        metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 't' }],
      },
    }, /inputs\.devices.*source "device"/);
  });

  it('counts injected events inside the SIM-CLOCK window only', () => {
    const { spec } = parseComputationSpec({
      kind: 'zone-query',
      refreshSec: 60,
      inputs: {
        zones: ['ward-101'],
        metrics: [
          { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemp' },
          { source: 'event', eventType: 'fall-detected', fn: 'countSince', windowSec: 3600, as: 'fallsLastHour' },
        ],
      },
    });
    // simTime 3700, window 3600 → cutoff 100: events at 100, 500, 3600 count.
    const result = evaluateComputation(spec, inputs());
    expect(result.data.fallsLastHour).toBe(3);
    expect(result.inputsSummary.eventsWindowed).toBe(3);

    const later = evaluateComputation(spec, inputs({ simTimeSec: 5000 })); // cutoff 1400
    expect(later.data.fallsLastHour).toBe(1);
  });

  it('unknown fields at every nesting level are named in a 400 (never silently dropped)', () => {
    expect(() => parseComputationSpec({ kind: 'zone-query', refreshSec: 60, bogus: 1, inputs: { zones: '*', metrics: [{ source: 'zone', path: 't', fn: 'avg', as: 'x' }] } }))
      .toThrowError(/body\.bogus.*allowed/);
    expect(() => parseComputationSpec({ kind: 'zone-query', refreshSec: 60, inputs: { zones: '*', metrics: [{ source: 'zone', path: 't', fn: 'avg', as: 'x', nope: 1 }] } }))
      .toThrowError(/metrics\[0\]\.nope/);
    expect(() => parseComputationSpec({ kind: 'zone-query', refreshSec: 60, inputs: { zones: '*', metrics: [{ source: 'quantum', path: 't', fn: 'avg', as: 'x' }] } }))
      .toThrowError(/source.*zone.*device.*event/);
  });

  it('closed fn vocabulary, kind/metric fit, duplicate as and reserved kinds are refused', () => {
    // try/catch + toMatch: sequential expect(fn).toThrowError(pattern) proved
    // flaky in this file under vitest 1.6 (the matcher saw a thrown
    // `undefined`); the direct form is stable and asserts the same thing.
    const rejectsWith = (raw: unknown, pattern: RegExp): void => {
      let message: string | null = null;
      try {
        parseComputationSpec(raw);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, `spec should have been rejected: ${JSON.stringify(raw)}`).toMatch(pattern);
    };
    const base = (metric: Record<string, unknown>, kind = 'zone-query') => ({
      kind, refreshSec: 60, inputs: { zones: '*', metrics: [metric] },
    });
    rejectsWith(base({ source: 'zone', path: 't', fn: 'latest', as: 'x' }), /fn.*avg.*min.*max.*sum/);
    rejectsWith(base({ source: 'device', capability: 'c', fn: 'project', as: 'x' }, 'device-aggregate'), /aggregate functions/);
    rejectsWith(base({ source: 'zone', path: 't', fn: 'avg', as: 'x' }, 'device-aggregate'), /device-aggregate.*source "device"/);
    rejectsWith(base({ source: 'device', capability: 'c', fn: 'count', as: 'x' }), /zone-query.*source "zone"/);
    rejectsWith({ kind: 'flow-report', refreshSec: 60, inputs: { zones: '*', metrics: [] } }, /reserved for Phase 2/);
    rejectsWith({
      kind: 'zone-query', refreshSec: 60,
      inputs: { zones: '*', metrics: [
        { source: 'zone', path: 't', fn: 'avg', as: 'x' },
        { source: 'zone', path: 'u', fn: 'avg', as: 'x' },
      ] },
    }, /unique/);
    // avg/min/max over devices REQUIRE the state path.
    rejectsWith(base({ source: 'device', capability: 'c', fn: 'avg', as: 'x' }, 'device-aggregate'), /path.*required/);
  });

  it('T132 (R20-F, u2-F1): a "*" element inside the zones array is a 400 teaching error; the bare "*" parse is untouched', () => {
    const rejectsWith = (raw: unknown, pattern: RegExp): void => {
      let message: string | null = null;
      try {
        parseComputationSpec(raw);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, `spec should have been rejected: ${JSON.stringify(raw)}`).toMatch(pattern);
    };
    const zoneSpec = (zones: unknown) => ({
      kind: 'zone-query', refreshSec: 60,
      inputs: { zones, metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'x' }] },
    });
    // ["*"] — u2's exact shape — and a wildcard mixed into an enumeration.
    rejectsWith(zoneSpec(['*']), /inputs\.zones\[0\].*\*.*bare string/);
    rejectsWith(zoneSpec(['bldg-x', '*']), /inputs\.zones\[1\]/);
    rejectsWith(zoneSpec([' * ']), /inputs\.zones\[0\]/); // trimmed wildcard counts too
    // The legal forms are untouched: bare "*" and concrete ids.
    const bare = parseComputationSpec(zoneSpec('*'));
    expect(bare.spec.zones).toBe('*');
    const explicit = parseComputationSpec(zoneSpec(['ward-101']));
    expect(explicit.spec.zones).toEqual(['ward-101']);
  });
});

// ---------------------------------------------------------------------------
// SimEventTallies — unit
// ---------------------------------------------------------------------------

describe('SimEventTallies', () => {
  it('records injections via onInjectedEvent and slices sim-clock windows', () => {
    const tallies = new SimEventTallies();
    const listeners: Array<(record: { type: string; zoneId: string; parameter: string; value: number | boolean; simTimeSec: number }) => void> = [];
    tallies.attach('sim-1', {
      onInjectedEvent(listener) {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    } as never);
    listeners[0]({ type: 'fall-detected', zoneId: 'z', parameter: 'motion', value: true, simTimeSec: 100 });
    listeners[0]({ type: 'fall-detected', zoneId: 'z', parameter: 'motion', value: true, simTimeSec: 200 });

    expect(tallies.windowOf('sim-1', 250, 100)).toHaveLength(1); // only t=200
    expect(tallies.eventsOf('sim-1')).toHaveLength(2);
    expect(tallies.eventsOf('sim-unknown')).toEqual([]);

    tallies.detach('sim-1');
    expect(tallies.eventsOf('sim-1')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Migration + routes (app fixtures)
// ---------------------------------------------------------------------------

describe('data services: spec registration + consumable flip (R14 Wave-A)', () => {
  let ctx: TestAppContext;
  let owner: TestUser; // env owner + provider agent owner
  let consumer: TestUser;
  let envId: string;
  let providerAgentId: string;
  let unbackedServiceId: string;
  let derivedServiceId: string;

  const CARE_SPEC = (overrides: Record<string, unknown> = {}) => ({
    kind: 'zone-query',
    refreshSec: 60,
    inputs: {
      zones: ['zone-a', 'zone-b'],
      metrics: [
        { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
        // T-075: explicit path — the bare countActive default ('active') is
        // exactly the misspelling the parse layer now warns about.
        { source: 'device', capability: 'fall-detection', fn: 'countActive', path: 'power', as: 'activeFallAlerts' },
      ],
    },
    ...overrides,
  });
  const CARE_INTERFACE = {
    dataSchema: {
      fields: [
        { name: 'avgTemperature', type: 'number', unit: '°C' },
        { name: 'activeFallAlerts', type: 'integer' },
      ],
    },
  };

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'ElderCare Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Energy Contractor' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        visibility: 'public',
        meta: { id: 'care-home', name: 'Care Home', description: 'R14 data-service fixture' },
        zones: [
          { id: 'zone-a', adjacentZoneIds: ['zone-b'] },
          { id: 'zone-b', adjacentZoneIds: ['zone-a'] },
        ],
        devices: [
          {
            id: 'fall-sensor-1',
            name: 'Fall Sensor 1',
            type: 'sensor',
            capabilities: ['fall-detection'],
            zoneId: 'zone-a',
            initialState: { active: false },
          },
          {
            id: 'hvac-b',
            name: 'HVAC B',
            type: 'hvac',
            capabilities: ['turn-on', 'turn-off'],
            zoneId: 'zone-b',
          },
        ],
        agents: [
          {
            id: 'care-bot',
            name: 'Care Bot',
            capabilities: ['care-status'],
            managesZoneIds: ['zone-a', 'zone-b'],
            boundDeviceIds: ['fall-sensor-1', 'hvac-b'],
          },
        ],
        events: [],
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;

    const detail = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    })).json();
    providerAgentId = (detail.agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Care Bot')!.id;

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(owner.token),
      payload: {
        name: 'care-status-aggregate',
        semanticType: 'care-status-aggregate',
        description: '照护区聚合状态（明确排除逐床生命体征）',
      },
    });
    expect(published.statusCode).toBe(201);
    unbackedServiceId = published.json().id as string;

    const derived = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    })).json().services as Array<{ id: string; name: string; origin: string }>;
    derivedServiceId = derived.find(service => service.origin === 'derived')!.id;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function registerComputation(token: string, serviceId: string, body: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/computation`,
      headers: auth(token),
      payload: body,
    });
  }

  it('migration v32 creates the computation tables and widens usage_records.kind', () => {
    const migration = ctx.app.db
      .prepare('SELECT version, name FROM migrations WHERE version = 32')
      .get() as { version: number; name: string } | undefined;
    expect(migration).toEqual({ version: 32, name: 'data-service-computations' });

    const columns = (table: string) =>
      (ctx.app.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map(column => column.name);
    expect(columns('service_computations')).toEqual([
      'service_id', 'kind', 'spec_json', 'schema_version', 'registered_by', 'registered_at',
    ]);
    expect(columns('service_data_frames')).toEqual([
      'service_id', 'frame_json', 'computed_at_wall', 'simulation_id', 'sim_time_sec',
    ]);
    // kind='read' now INSERTs (the widened CHECK):
    const agreement = ctx.app.agreementStore.createAgreement({
      envId, serviceId: unbackedServiceId, consumerAgentId: null,
      consumerOwnerId: consumer.id, providerAgentId, providerOwnerId: owner.id,
      terms: {},
    });
    const usage = ctx.app.agreementStore.appendUsage({
      agreementId: agreement.id, envId, consumerAgentId: null, providerAgentId,
      kind: 'read', quantity: 1, unit: 'reading', outcome: 'success',
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    });
    expect(usage.kind).toBe('read');
  });

  it('an unbacked published service starts consumable:false with the teaching note (T-310 baseline)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${unbackedServiceId}`,
      headers: auth(consumer.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().unbacked).toBe(true);
    expect(res.json().consumable).toBe(false);
    expect(res.json().consumableNote).toContain('computation');
  });

  it('register: provider owner only; derived services refused; validation closes the schema', async () => {
    expect((await registerComputation(consumer.token, unbackedServiceId, { ...CARE_SPEC(), interface: CARE_INTERFACE })).statusCode).toBe(403);

    const derived = await registerComputation(owner.token, derivedServiceId, { ...CARE_SPEC(), interface: CARE_INTERFACE });
    expect(derived.statusCode).toBe(409);
    expect(derived.json().error.code).toBe('SERVICE_DERIVED_READONLY');

    const badSpec = await registerComputation(owner.token, unbackedServiceId, { kind: 'zone-query', refreshSec: 60, inputs: { zones: '*', metrics: [{ source: 'zone', path: 't', fn: 'avg', as: 'x' }] }, hack: true });
    expect(badSpec.statusCode).toBe(400);
    expect(badSpec.json().error.message).toContain('hack');

    // dataSchema must match the spec's as-names exactly (§9).
    const mismatch = await registerComputation(owner.token, unbackedServiceId, {
      ...CARE_SPEC(),
      interface: { dataSchema: { fields: [{ name: 'avgTemperature', type: 'number' }] } },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe('DATA_SCHEMA_MISMATCH');
    expect(mismatch.json().error.message).toContain('activeFallAlerts');

    // missing dataSchema entirely → same teaching error
    const none = await registerComputation(owner.token, unbackedServiceId, CARE_SPEC());
    expect(none.statusCode).toBe(400);
    expect(none.json().error.message).toContain('dataSchema');
  });

  it('T-406: a qualified zone path ("atrium.temperature") is 400 with the bare-name teaching; the bare path registers clean', async () => {
    const qualified = await registerComputation(owner.token, unbackedServiceId, {
      ...CARE_SPEC({
        inputs: {
          zones: ['zone-a', 'zone-b'],
          metrics: [
            { source: 'zone', path: 'atrium.temperature', fn: 'avg', as: 'avgTemperature' },
            { source: 'device', capability: 'fall-detection', fn: 'countActive', as: 'activeFallAlerts' },
          ],
        },
      }),
      interface: CARE_INTERFACE,
    });
    expect(qualified.statusCode).toBe(400);
    const message: string = qualified.json().error.message;
    expect(message).toContain('atrium.temperature');
    expect(message).toContain('BARE');
    expect(message).toContain('flow-condition');

    // The bare path registers fine (201) with no warnings.
    const bare = await registerComputation(owner.token, unbackedServiceId, {
      ...CARE_SPEC(),
      interface: CARE_INTERFACE,
    });
    expect(bare.statusCode).toBe(201);
    expect(bare.json().warnings).toBeUndefined();
  });

  it('T-406: a qualified DEVICE path stays permissive but carries the warning on the 201', async () => {
    const res = await registerComputation(owner.token, unbackedServiceId, {
      ...CARE_SPEC({
        inputs: {
          zones: ['zone-a', 'zone-b'],
          metrics: [
            { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
            {
              source: 'device', capability: 'fall-detection', fn: 'avg',
              path: 'deviceA.battery', as: 'activeFallAlerts',
            },
          ],
        },
      }),
      interface: CARE_INTERFACE,
    });
    expect(res.statusCode).toBe(201);
    const warnings = res.json().warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.join(' ')).toContain('deviceA.battery');
    expect(warnings!.join(' ')).toContain('LITERAL');
  });

  it('T132 (R20-F, u2-F1): a wildcard inside the zones ARRAY is refused at registration; the bare "*" stays the only wildcard spelling', async () => {
    // u2's shape: `zones: ["*"]` registered fine (the array branch only checked
    // non-empty strings), then every read honestly 409ed NO_READING — the
    // array form filters zones by LITERAL id, so ["*"] selected zero zones.
    // Same write-time teaching refusal as the T-406 dotted path.
    const wildcardArray = await registerComputation(owner.token, unbackedServiceId, {
      kind: 'zone-query', refreshSec: 60,
      inputs: {
        zones: ['*'],
        metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }],
      },
      interface: { dataSchema: { fields: [{ name: 'avgTemperature', type: 'number' }] } },
    });
    expect(wildcardArray.statusCode).toBe(400);
    const wildcardMessage: string = wildcardArray.json().error.message;
    expect(wildcardMessage).toContain('inputs.zones[0]');
    expect(wildcardMessage).toContain('"*"');
    expect(wildcardMessage).toContain('bare string'); // the one legal wildcard spelling
    expect(wildcardMessage).toContain('zone ids');

    // A wildcard MIXED into a concrete enumeration is the same refusal, named
    // at its own position.
    const mixed = await registerComputation(owner.token, unbackedServiceId, {
      kind: 'zone-query', refreshSec: 60,
      inputs: {
        zones: ['zone-a', '*'],
        metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }],
      },
      interface: { dataSchema: { fields: [{ name: 'avgTemperature', type: 'number' }] } },
    });
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json().error.message).toContain('inputs.zones[1]');

    // The bare "*" (the WHOLE inputs.zones) still registers — the legal form.
    const bare = await registerComputation(owner.token, unbackedServiceId, {
      kind: 'zone-query', refreshSec: 60,
      inputs: {
        zones: '*',
        metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }],
      },
      interface: { dataSchema: { fields: [{ name: 'avgTemperature', type: 'number' }] } },
    });
    expect(bare.statusCode).toBe(201);
  });

  it('register flips consumable, drops the note, surfaces computation + excludes into the interface', async () => {
    const res = await registerComputation(owner.token, unbackedServiceId, {
      ...CARE_SPEC(),
      excludes: ['per-resident vitals'],
      interface: CARE_INTERFACE,
    });
    expect(res.statusCode).toBe(201);
    const service = res.json();
    expect(service.unbacked).toBe(true); // still no backing device — an honest fact
    expect(service.consumable).toBe(true); // …but now deliverable
    expect(service.consumableNote).toBeUndefined();
    expect(service.computation).toMatchObject({ kind: 'zone-query', refreshSec: 60, schemaVersion: 1 });
    expect(service.interface.dataSchema.fields.map((field: { name: string }) => field.name))
      .toEqual(['avgTemperature', 'activeFallAlerts']);
    expect(service.interface.excludes).toEqual(['per-resident vitals']);

    // GET the spec back (same visibility as the service).
    const got = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${unbackedServiceId}/computation`,
      headers: auth(consumer.token),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().computation.spec.metrics).toHaveLength(2);
    expect(got.json().computation.registeredBy).toBe(owner.id);

    // the env list surface agrees (the market flips live)
    const listed = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(consumer.token),
    })).json().services as Array<{ id: string; consumable: boolean }>;
    expect(listed.find(service => service.id === unbackedServiceId)!.consumable).toBe(true);

    // re-register replaces idempotently (schemaVersion bump survives)
    const replaced = await registerComputation(owner.token, unbackedServiceId, {
      ...CARE_SPEC({ schemaVersion: 2 }),
      interface: CARE_INTERFACE,
    });
    expect(replaced.statusCode).toBe(201);
    expect(replaced.json().computation.schemaVersion).toBe(2);
  });

  it('propose gate: 409 SERVICE_NOT_BACKED without a computation (T-310 intact), 201 with one', async () => {
    const before = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${unbackedServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(before.statusCode).toBe(409);
    expect(before.json().error.code).toBe('SERVICE_NOT_BACKED');
    expect(before.json().error.message).toContain('computation');

    await registerComputation(owner.token, unbackedServiceId, {
      ...CARE_SPEC(), interface: CARE_INTERFACE,
    });

    const after = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${unbackedServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(after.statusCode).toBe(201);
    expect(after.json().status).toBe('proposed');
    expect(after.json().backingDeviceId).toBeNull(); // a data service has no device
  });

  it('revoke: flips consumable back, 404s a second revoke, notifies active agreement parties', async () => {
    await registerComputation(owner.token, unbackedServiceId, { ...CARE_SPEC(), interface: CARE_INTERFACE });
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${unbackedServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    const agreementId = proposed.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${unbackedServiceId}/computation`,
      headers: auth(owner.token),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().consumable).toBe(false);
    expect(revoked.json().computation).toBeUndefined();

    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${unbackedServiceId}/computation`,
      headers: auth(owner.token),
    });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe('COMPUTATION_NOT_REGISTERED');

    // R15 (CP-F11): agreement.compute-dropped reaches BOTH parties — the
    // design (§7) promises "双方各收到一条". The recipient===actor echo rule
    // used to drop the revoking provider's copy (and on a self-agreement,
    // BOTH copies — the live-round zero-notification case); allowSelf now
    // delivers it because the provider's copy names WHICH active agreement
    // the revoke hit.
    const consumerNotifications = (await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(consumer.token),
    })).json().notifications as Array<{ kind: string; refId: string }>;
    const dropped = consumerNotifications.filter(n => n.kind === 'agreement.compute-dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].refId).toBe(agreementId);

    const providerNotifications = (await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(owner.token),
    })).json().notifications as Array<{ kind: string; refId: string }>;
    const providerDropped = providerNotifications.filter(n => n.kind === 'agreement.compute-dropped');
    expect(providerDropped).toHaveLength(1);
    expect(providerDropped[0].refId).toBe(agreementId);

    // CP-F11 exact replay: a SELF-agreement (provider==consumer==the actor
    // revoking) still receives exactly one notification — zero rows was the
    // live-round defect.
    const reRegistered = await registerComputation(owner.token, unbackedServiceId, {
      ...CARE_SPEC(), interface: CARE_INTERFACE,
    });
    expect(reRegistered.statusCode).toBe(201);
    const selfProposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${unbackedServiceId}/agreements`,
      headers: auth(owner.token),
      payload: { consumerAgentId: providerAgentId, terms: {} },
    });
    expect(selfProposed.statusCode).toBe(201);
    const selfId = selfProposed.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${selfId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    const selfRevoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${unbackedServiceId}/computation`,
      headers: auth(owner.token),
    });
    expect(selfRevoked.statusCode).toBe(200);
    const selfNotifications = (await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(owner.token),
    })).json().notifications as Array<{ kind: string; refId: string }>;
    const selfDropped = selfNotifications.filter(
      n => n.kind === 'agreement.compute-dropped' && n.refId === selfId,
    );
    expect(selfDropped).toHaveLength(1);

    // propose is refused again (T-310 boundary restored)
    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${unbackedServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(refused.statusCode).toBe(409);
  });

  // T78 (R8, u4-P1-3): the computation face of the ghost-event-type oracle —
  // a countSince metric on a type the world never declares would read zero
  // forever while looking like a legitimate series. Registration warns (and
  // the warning names the declared types); a declared type stays quiet.
  it('T78: an undeclared countSince eventType warns at registration; a declared one stays quiet', async () => {
    // Declare 'fall-detected' in the world (this fixture's own vocabulary —
    // its sims inject exactly this type).
    const env = ctx.app.envStore.getEnvironment(envId)!;
    const mapData = parseMapData(env);
    mapData.events = [{ id: 'evt-fall', type: 'fall-detected', zoneId: 'zone-a' }];
    ctx.app.envStore.updateEnvironment(envId, { mapData });

    const registered = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${unbackedServiceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        inputs: {
          zones: ['zone-a'],
          metrics: [
            { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
            { source: 'event', eventType: 'fall-detected', fn: 'countSince', windowSec: 600, as: 'falls' },
          ],
        },
        interface: {
          dataSchema: {
            fields: [
              { name: 'avgTemperature', type: 'number', unit: '°C' },
              { name: 'falls', type: 'integer', unit: '次' },
            ],
          },
        },
      },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().warnings).toBeUndefined(); // declared → quiet

    const ghost = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${unbackedServiceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        inputs: {
          zones: ['zone-a'],
          metrics: [
            { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
            { source: 'event', eventType: 'zombie-invasion', fn: 'countSince', windowSec: 600, as: 'zombieReads' },
          ],
        },
        interface: {
          dataSchema: {
            fields: [
              { name: 'avgTemperature', type: 'number', unit: '°C' },
              { name: 'zombieReads', type: 'integer', unit: '次' },
            ],
          },
        },
      },
    });
    expect(ghost.statusCode).toBe(201); // non-blocking: legal to author
    const warnings = ghost.json().warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.join(' ')).toContain('zombie-invasion');
    expect(warnings!.join(' ')).toContain('zombieReads');
    expect(warnings!.join(' ')).toContain('fall-detected');

    // T81 (R9, u2-F2): the ghost warning REPLAYS on the get face, recomputed
    // against the CURRENT world — a provider who missed the registration
    // moment no longer carries a ghost metric invisibly (both faces).
    const replay = await ctx.app.inject({
      method: 'GET', url: `/api/services/${unbackedServiceId}/computation`, headers: auth(owner.token),
    });
    expect(replay.statusCode).toBe(200);
    const replayed = (replay.json().computation as { warnings?: string[] }).warnings;
    expect(replayed).toBeDefined();
    expect(replayed!.join(' ')).toContain('zombie-invasion');
  });
});

// ---------------------------------------------------------------------------
// Pull lane (R14 Wave-A Task 2): POST /reads + GET /reads/latest
// ---------------------------------------------------------------------------

describe('data services: the read lane (pull)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let providerAgentId: string;
  let serviceId: string;
  let agreementId: string;

  const SPEC = {
    kind: 'zone-query',
    refreshSec: 60,
    inputs: {
      zones: ['zone-a', 'zone-b'],
      metrics: [
        { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
        { source: 'device', capability: 'fall-detection', fn: 'countActive', as: 'activeFallAlerts' },
      ],
    },
  };
  const IFACE = {
    dataSchema: {
      fields: [
        { name: 'avgTemperature', type: 'number', unit: '°C' },
        { name: 'activeFallAlerts', type: 'integer' },
      ],
    },
  };

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'ElderCare Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Energy Contractor' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        visibility: 'public',
        meta: { id: 'care-home-read', name: 'Care Home (read lane)', description: 'fixture' },
        zones: [
          { id: 'zone-a', adjacentZoneIds: ['zone-b'] },
          { id: 'zone-b', adjacentZoneIds: ['zone-a'] },
        ],
        devices: [
          {
            id: 'fall-sensor-1', name: 'Fall Sensor 1', type: 'sensor',
            capabilities: ['fall-detection'], zoneId: 'zone-a', initialState: { active: false },
          },
          {
            id: 'hvac-b', name: 'HVAC B', type: 'hvac',
            capabilities: ['turn-on', 'turn-off'], zoneId: 'zone-b',
          },
        ],
        agents: [{
          id: 'care-bot', name: 'Care Bot', capabilities: ['care-status'],
          managesZoneIds: ['zone-a', 'zone-b'], boundDeviceIds: ['fall-sensor-1', 'hvac-b'],
        }],
        events: [],
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    const detail = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
    })).json();
    providerAgentId = (detail.agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Care Bot')!.id;

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'care-status-aggregate', semanticType: 'care-status-aggregate' },
    });
    expect(published.statusCode).toBe(201);
    serviceId = published.json().id as string;

    const registered = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
      payload: { ...SPEC, interface: IFACE },
    });
    expect(registered.statusCode).toBe(201);

    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(consumer.token) });

    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          read: { fields: ['avgTemperature', 'activeFallAlerts'] },
        },
      },
    });
    expect(proposed.statusCode).toBe(201);
    agreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().termsEnforced).toBe(true); // terms.read is a binding clause
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function read(token: string | undefined, body: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/reads`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
      payload: body,
    });
  }

  async function runningSim(token: string): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/simulations', headers: auth(token),
      payload: { environmentId: envId },
    });
    expect(created.statusCode).toBe(201);
    const simId = created.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(token), payload: {},
    });
    expect(started.statusCode).toBe(200);
    return simId;
  }

  async function usageRows(): Promise<Array<Record<string, unknown>>> {
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}/usage`, headers: auth(consumer.token),
    });
    return res.json().usage as Array<Record<string, unknown>>;
  }

  it('a live read evaluates, meters kind=read unit=reading, settles a receipt and filters fields', async () => {
    const simId = await runningSim(consumer.token);

    // T51 (R5, u4-P1-1): the AUTO-targeted read evaluates against the
    // CALLER'S OWN RUNNING sim — the world she is actually watching (u4:
    // fresh power=0 from the idle world session while her accelerated sim
    // carried the action). The env's authoritative world session stays the
    // default only when she has NO running sim (the on-demand test below);
    // explicit-simId reads keep their legacy targeting.
    const res = await read(consumer.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.simulationId).toBe(simId);
    expect(body.frame.kind).toBe('data');
    expect(body.frame.schemaVersion).toBe(1);
    expect(body.frame.provenance.cached).toBe(false);
    expect(body.frame.provenance.simulationId).toBe(simId);
    expect(body.frame.provenance.computationKind).toBe('zone-query');
    expect(body.frame.provenance.providerAgentId).toBe(providerAgentId);
    expect(body.frame.freshnessSec).toBe(0);
    expect(body.frame.stale).toBe(false);
    expect(typeof body.frame.data.avgTemperature).toBe('number');
    expect(body.frame.data.activeFallAlerts).toBe(0); // both sensors inactive
    expect(body.applied.fields).toEqual(['avgTemperature', 'activeFallAlerts']);
    expect(body.applied.meteringUnit).toBe('reading');
    expect(body.termsEnforced).toBe(true);
    expect(body.usage.kind).toBe('read');
    expect(body.usage.unit).toBe('reading');
    expect(body.usage.quantity).toBe(1);
    expect(body.usage.outcome).toBe('success');
    expect(body.receiptId).toBeTruthy();

    const receipts = (await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}/receipts`, headers: auth(consumer.token),
    })).json().receipts as Array<{ usageRecordIds: string[] }>;
    expect(receipts.some(r => r.usageRecordIds.includes(body.usage.id))).toBe(true);
  });

  it('T122 (R17-u3/R19-u4): the env default-simulation binding answers the default READ lane — bound/stale both disclosed, explicit simId wins', async () => {
    // The consumer runs THREE own sims → the unbound default read is the
    // honest SIMULATION_AMBIGUOUS (the pre-T122 answer, unchanged).
    const simA = await runningSim(consumer.token);
    const simB = await runningSim(consumer.token);
    const simC = await runningSim(consumer.token);
    const ambiguous = await read(consumer.token);
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json().error.code).toBe('SIMULATION_AMBIGUOUS');
    expect(ambiguous.json().error.message).not.toContain('set-default-sim');

    // The owner binds simA as the env default → the default read answers
    // from it and DISCLOSES the binding (the binding outranks the caller's
    // own-sim tie — the owner's world decision is the highest priority leg).
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: { defaultSimulationId: simA },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().defaultSimulationId).toBe(simA);
    const boundRead = await read(consumer.token);
    expect(boundRead.statusCode).toBe(200);
    expect(boundRead.json().simulationId).toBe(simA);
    expect(boundRead.json().defaultSimNote).toContain('使用环境默认仿真');

    // The explicit simulationId still wins over the binding — no note.
    const explicit = await read(consumer.token, { simulationId: simB });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json().simulationId).toBe(simB);
    expect(explicit.json().defaultSimNote).toBeUndefined();

    // The bound sim STOPS → the binding is inert: the default read falls
    // back to the ambiguity it would have had anyway (two own sims left),
    // WITH the honest stale annotation pointing at the rebind/clear command
    // — never a silent switch to another world.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simA}/stop`,
      headers: auth(consumer.token),
      payload: {},
    });
    const stale = await read(consumer.token);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('SIMULATION_AMBIGUOUS');
    expect(stale.json().error.message).toContain('已停止运行');
    expect(stale.json().error.message).toContain('set-default-sim');

    // sanity: the untouched sims stay targetable explicitly.
    const simCRead = await read(consumer.token, { simulationId: simC });
    expect(simCRead.statusCode).toBe(200);
  });

  it('T127 (R20-u2 F2): a stale binding falling through to the reader\'s single own sim still DISCLOSES — never a silent world switch', async () => {
    // One own sim, no binding → the T51 lane answers from it with NO note
    // (unchanged when no binding is involved).
    const simMine = await runningSim(consumer.token);
    const noBinding = await read(consumer.token);
    expect(noBinding.statusCode).toBe(200);
    expect(noBinding.json().simulationId).toBe(simMine);
    expect(noBinding.json().defaultSimNote).toBeUndefined();

    // The owner binds HER (second) running sim → the read rides the binding
    // with its disclosure — the world the reader's answers come from changed
    // and she was TOLD.
    const simBound = await runningSim(owner.token);
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: { defaultSimulationId: simBound },
    });
    expect(patched.statusCode).toBe(200);
    const boundRead = await read(consumer.token);
    expect(boundRead.statusCode).toBe(200);
    expect(boundRead.json().simulationId).toBe(simBound);
    expect(boundRead.json().defaultSimNote).toContain('使用环境默认仿真');

    // The bound sim STOPS → the read falls back to the reader's own sim and
    // MUST say so: the dead binding named, the world that answered named,
    // and the rebind/clear command. This is the exact r20 u2 shape — the
    // fall-back was 200-with-different-world and completely silent.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simBound}/stop`,
      headers: auth(owner.token),
      payload: {},
    });
    const stale = await read(consumer.token);
    expect(stale.statusCode).toBe(200);
    expect(stale.json().simulationId).toBe(simMine);
    const note = stale.json().defaultSimNote as string;
    expect(note).toContain(simBound);
    expect(note).toContain('已停止运行');
    expect(note).toContain(simMine);
    expect(note).toContain('set-default-sim');
    // The frame's own provenance agrees with the note.
    expect(stale.json().frame.provenance.simulationId).toBe(simMine);
  });

  it('T46 (u4-P2-3): the read carries the METADATA face — platform units per field + what was actually read', async () => {
    await runningSim(consumer.token);
    const res = await read(consumer.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Units come from the shared PARAM_UNITS single source: a declared unit
    // for temperature, and null (never an invented unit) for the rest.
    expect(body.frame.units).toEqual({ avgTemperature: '°C', activeFallAlerts: null });
    // The provenance face names the inputs actually read (the consumer can
    // reconcile the reading against the world instead of trusting a number).
    expect(body.frame.provenance.inputsSummary.devices).toBeGreaterThanOrEqual(1);
    expect(typeof body.frame.provenance.simTimeSec).toBe('number');
  });

  it('T46 (u4-P2-3): a device-input computation with an EMPTY provider binding refuses (never a fabricated 0)', async () => {
    await runningSim(consumer.token);
    // Device churn (remove-devices / re-installs) unlinks the provider's
    // bindings — u4's meter then served power=0 against a 500 W world.
    ctx.app.envStore.updateAgent(providerAgentId, { boundDeviceIds: [] });

    const res = await read(consumer.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('COMPUTATION_DEVICE_INPUTS_EMPTY');
    expect(res.json().error.message).toContain('0 devices');

    // Metered as an execution-level failure (audit trail, no quota burn).
    const rows = await usageRows();
    const last = rows[rows.length - 1];
    expect(last.outcome).toBe('failure');
    expect(String(last.failureReason)).toContain('binding');
  });

  it('T50 (R5, u2-F1): the device stays bound but its capability is re-declared away → the value metric reads null and the read REFUSES (never a null-into-success delivery)', async () => {
    const simId = await runningSim(consumer.token);

    // Baseline: temperature reads fine, then the provider strips the zone
    // metric's parameter source — u2's shape was the device twin (capability
    // re-declared away with the device still in the world and bound); the
    // zone-path variant exercises the same evaluator null without device
    // churn. Strip the parameter by re-registering with a path no zone has.
    const okRead = await read(consumer.token, { simulationId: simId });
    expect(okRead.statusCode).toBe(200);
    expect(typeof okRead.json().frame.data.avgTemperature).toBe('number');

    const reregistered = await ctx.app.inject({
      method: 'POST', url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        schemaVersion: 2,
        inputs: {
          zones: ['zone-a', 'zone-b'],
          metrics: [
            // 'rainfall' exists on no zone in this world → null every frame.
            { source: 'zone', path: 'rainfall', fn: 'avg', as: 'avgTemperature' },
            { source: 'device', capability: 'fall-detection', fn: 'countActive', as: 'activeFallAlerts' },
          ],
        },
        interface: IFACE,
      },
    });
    expect(reregistered.statusCode).toBe(201);

    const refused = await read(consumer.token, { simulationId: simId });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('COMPUTATION_METRIC_NO_READING');
    expect(refused.json().error.fields).toEqual(['avgTemperature']);
    expect(refused.json().error.message).toContain('NOT terminated');

    // Metered failure (no receipt, no quota burn), the agreement alive.
    const rows = await usageRows();
    const last = rows[rows.length - 1];
    expect(last.outcome).toBe('failure');
    expect(last.kind).toBe('read');
    expect(String(last.failureReason)).toContain('avgTemperature');
    // The count-type field still being fine is WHY the refusal names only
    // the dead metric — counts cannot be null, so the gate never touches them.
  });

  it('T132 (R20-F, u2-F1): a LEGACY wildcard-in-array spec reads 409 with the re-registration teaching (the write-time fix cannot reach stored rows)', async () => {
    const simId = await runningSim(consumer.token);

    // The write-time refusal now blocks `["*"]` at registration, so the only
    // way to reach the read gate is the legacy row itself — seed it directly
    // (same shape u2's 09-17 registration produced in the live DB).
    ctx.app.serviceStore.registerComputation({
      serviceId,
      kind: 'zone-query',
      specJson: JSON.stringify({
        kind: 'zone-query',
        refreshSec: 60,
        zones: ['*'],
        metrics: [
          { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
          { source: 'device', capability: 'fall-detection', fn: 'countActive', as: 'activeFallAlerts' },
        ],
      }),
      schemaVersion: 2,
      registeredBy: owner.id,
    });

    const refused = await read(consumer.token, { simulationId: simId });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('COMPUTATION_METRIC_NO_READING');
    const message: string = refused.json().error.message;
    // The teaching names the wildcard-in-array form, its consequence, and the
    // two legal re-registration shapes — NOT the generic "zones lack the
    // parameter" copy (no zone was ever selected here).
    expect(message).toContain('*');
    expect(message).toContain('no longer accepted');
    expect(message).toContain('BARE string');
    expect(message).toContain('concrete zone ids');
    expect(message).not.toContain('the selected zones lack the parameter');
    // Only the zone-source VALUE metric is poisoned by the empty selection.
    expect(refused.json().error.fields).toEqual(['avgTemperature']);

    // Metered as an execution-level failure (audit trail), agreement alive.
    const rows = await usageRows();
    const last = rows[rows.length - 1];
    expect(last.outcome).toBe('failure');
    expect(last.kind).toBe('read');
    expect(String(last.failureReason)).toContain('wildcard');
  });

  it('T51 (R5, u4-P1-1): auto-targeting prefers the caller\'s own running sim; with none it falls back to the world session', async () => {
    // No own sim → the authoritative world session materializes (P1W).
    const sessionRead = await read(consumer.token);
    expect(sessionRead.statusCode).toBe(200);
    expect(sessionRead.json().simulationId).toBe(`sim-${envId}-world-session`);

    // Own sim running → THE SIM wins (the world the consumer is watching),
    // not the idle 1x session.
    const simId = await runningSim(consumer.token);
    const ownRead = await read(consumer.token);
    expect(ownRead.statusCode).toBe(200);
    expect(ownRead.json().simulationId).toBe(simId);
    expect(ownRead.json().frame.provenance.simulationId).toBe(simId);
    expect(ownRead.json().frame.provenance.cached).toBe(false);
  });

  it('T96 (R14, u4-P2): a foreign running sim — the env owner\'s included — is never the default read target', async () => {
    // u4's r14 shape: with no own sim her meter read fell to the world
    // session, then SILENTLY switched worlds the moment the env owner
    // started exactly one sim (provenance named a sim she never created;
    // at a second foreign sim the same command turned into a 409). The
    // default candidates are the caller's OWN sims now: no own sim → the
    // authoritative world session, whoever else happens to be running.
    const foreignSimId = await runningSim(owner.token);
    const autoRead = await read(consumer.token);
    expect(autoRead.statusCode).toBe(200);
    expect(autoRead.json().simulationId).toBe(`sim-${envId}-world-session`);
    expect(autoRead.json().frame.provenance.simulationId).toBe(`sim-${envId}-world-session`);
    // Reading the foreign world stays possible — EXPLICITLY (the env-owner
    // carve-out lives on the explicit simulationId lanes, unchanged).
    const explicit = await read(consumer.token, { simulationId: foreignSimId });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json().simulationId).toBe(foreignSimId);
  });

  it('T51 (R5, u4-P1-1): an event-metric spec with an EMPTY window flags emptyEventWindow (the CLI teaches "0 = 无事件")', async () => {
    // A peak-watcher spec over the injected-event tally: zero power-peak
    // events in the window → power=0 STRUCTURALLY, and the frame says so.
    const peakService = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'peak-watcher', semanticType: 'power-peak-watcher' },
    });
    expect(peakService.statusCode).toBe(201);
    const peakServiceId = peakService.json().id as string;
    const registered = await ctx.app.inject({
      method: 'POST', url: `/api/services/${peakServiceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'device-aggregate',
        refreshSec: 60,
        inputs: {
          zones: ['zone-a'],
          metrics: [
            { source: 'event', eventType: 'power-peak', fn: 'countSince', windowSec: 3600, as: 'power' },
            // kind discipline: a device-aggregate carries ≥1 device metric —
            // the count is never null, so the T50 gate never touches it.
            { source: 'device', capability: 'fall-detection', fn: 'count', as: 'deviceCount' },
          ],
        },
        interface: {
          dataSchema: {
            fields: [
              { name: 'power', type: 'integer', unit: 'W' },
              { name: 'deviceCount', type: 'integer' },
            ],
          },
        },
      },
    });
    expect(registered.statusCode).toBe(201);
    const proposed = await ctx.app.inject({
      method: 'POST', url: `/api/services/${peakServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { fields: ['power'] } } },
    });
    expect(proposed.statusCode).toBe(201);
    const peakAgreementId = proposed.json().id as string;
    await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${peakAgreementId}/decide`,
      headers: auth(owner.token), payload: { decision: 'accept' },
    });

    const simId = await runningSim(consumer.token);
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${peakAgreementId}/reads`,
      headers: auth(consumer.token), payload: { simulationId: simId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.frame.data.power).toBe(0); // zero matched events — a count, not a reading
    expect(body.frame.emptyEventWindow).toBe(true); // the honesty flag the human face explains
    expect(body.frame.provenance.inputsSummary.eventsWindowed).toBe(0);
    // This fixture's env declares NO events, so 'power-peak' is a ghost —
    // the read frame carries the T83 annotation (and its empty vocabulary).
    expect(body.frame.undeclaredEventTypes).toEqual(['power-peak']);
    expect(body.frame.declaredEventTypes).toEqual([]);
  });

  // T83 (R9, u4-F1): the read face of the ghost-event-type oracle — a read
  // whose spec references a type this world never produces says so, because
  // "widen windowSec" is PERMANENTLY useless advice for a ghost.
  it('T83: a ghost event metric read carries undeclaredEventTypes; declaring the type cleans it', async () => {
    // A fresh service whose event metric references 'meteor-strike' — a type
    // this world never declares (its vocabulary is empty until we edit it).
    const ghostService = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'ghost-watcher', semanticType: 'ghost-watcher' },
    });
    expect(ghostService.statusCode).toBe(201);
    const ghostServiceId = ghostService.json().id as string;
    const registered = await ctx.app.inject({
      method: 'POST', url: `/api/services/${ghostServiceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'device-aggregate',
        refreshSec: 60,
        inputs: {
          zones: ['zone-a'],
          metrics: [
            { source: 'event', eventType: 'meteor-strike', fn: 'countSince', windowSec: 3600, as: 'meteors' },
            { source: 'device', capability: 'fall-detection', fn: 'count', as: 'deviceCount' },
          ],
        },
        interface: {
          dataSchema: {
            fields: [
              { name: 'meteors', type: 'integer' },
              { name: 'deviceCount', type: 'integer' },
            ],
          },
        },
      },
    });
    expect(registered.statusCode).toBe(201);
    const proposed = await ctx.app.inject({
      method: 'POST', url: `/api/services/${ghostServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { fields: ['meteors'] } } },
    });
    expect(proposed.statusCode).toBe(201);
    const ghostAgreementId = proposed.json().id as string;
    await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${ghostAgreementId}/decide`,
      headers: auth(owner.token), payload: { decision: 'accept' },
    });

    const simId = await runningSim(consumer.token);
    const ghostRead = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${ghostAgreementId}/reads`,
      headers: auth(consumer.token), payload: { simulationId: simId },
    });
    expect(ghostRead.statusCode).toBe(200);
    const ghostFrame = ghostRead.json().frame;
    expect(ghostFrame.emptyEventWindow).toBe(true);
    // THE annotation: this world never produced 'meteor-strike' — the read
    // says so (and names the empty vocabulary) instead of suggesting a
    // window widening that can never help.
    expect(ghostFrame.undeclaredEventTypes).toEqual(['meteor-strike']);
    expect(ghostFrame.declaredEventTypes).toEqual([]);

    // Metamorphic twin: declare the type in the world's vocabulary (the SAME
    // table the register warning and the inject lane speak) — the annotation
    // disappears entirely (an honest empty window, no ghost claim).
    const env = ctx.app.envStore.getEnvironment(envId)!;
    const mapData = parseMapData(env);
    mapData.events = [{ id: 'evt-meteor', type: 'meteor-strike', zoneId: 'zone-a' }];
    ctx.app.envStore.updateEnvironment(envId, { mapData });

    const declaredRead = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${ghostAgreementId}/reads`,
      headers: auth(consumer.token), payload: { simulationId: simId },
    });
    expect(declaredRead.statusCode).toBe(200);
    const declaredFrame = declaredRead.json().frame;
    expect(declaredFrame.emptyEventWindow).toBe(true);
    expect(declaredFrame.undeclaredEventTypes).toBeUndefined();
    expect(declaredFrame.declaredEventTypes).toBeUndefined();
  });

  // T85 (R10, u4-F1): the ghost verdict is PER DELIVERED FIELD — on a mixed
  // ghost+declared spec the delivered field decides the annotation (the
  // declared field's empty window keeps the T57a advice) and the types of
  // metrics OUTSIDE the delivery never leak into the frame.
  it('T85: a mixed ghost+declared spec classifies per delivered field; terms-outside ghosts stay unleaked', async () => {
    const mixedService = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'mixed-watcher', semanticType: 'mixed-watcher' },
    });
    expect(mixedService.statusCode).toBe(201);
    const mixedServiceId = mixedService.json().id as string;
    const registered = await ctx.app.inject({
      method: 'POST', url: `/api/services/${mixedServiceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'device-aggregate',
        refreshSec: 60,
        inputs: {
          zones: ['zone-a'],
          metrics: [
            // ghost #1 — the field a dedicated agreement will deliver
            { source: 'event', eventType: 'zzz-ghost-a', fn: 'countSince', windowSec: 3600, as: 'ghostHits' },
            // declared — empty-window honest, NOT a ghost
            { source: 'event', eventType: 'power-peak', fn: 'countSince', windowSec: 3600, as: 'peaks' },
            // ghost #2 — deliberately OUTSIDE every terms.read.fields below
            { source: 'event', eventType: 'zzz-ghost-b', fn: 'countSince', windowSec: 3600, as: 'secretGhost' },
            // kind discipline: device-aggregate carries >=1 device metric
            { source: 'device', capability: 'fall-detection', fn: 'count', as: 'deviceCount' },
          ],
        },
        interface: {
          dataSchema: {
            fields: [
              { name: 'ghostHits', type: 'integer' },
              { name: 'peaks', type: 'integer' },
              { name: 'secretGhost', type: 'integer' },
              { name: 'deviceCount', type: 'integer' },
            ],
          },
        },
      },
    });
    expect(registered.statusCode).toBe(201);

    // Declare ONLY 'power-peak' in the world's vocabulary (the same
    // declaration table the register warning and the inject lane speak).
    const env = ctx.app.envStore.getEnvironment(envId)!;
    const mapData = parseMapData(env);
    mapData.events = [{ id: 'evt-peak', type: 'power-peak', zoneId: 'zone-a' }];
    ctx.app.envStore.updateEnvironment(envId, { mapData });

    const simId = await runningSim(consumer.token);
    const proposeAndRead = async (fields: string[]): Promise<Record<string, unknown>> => {
      const proposed = await ctx.app.inject({
        method: 'POST', url: `/api/services/${mixedServiceId}/agreements`,
        headers: auth(consumer.token),
        payload: { terms: { read: { fields } } },
      });
      expect(proposed.statusCode).toBe(201);
      const id = proposed.json().id as string;
      const decided = await ctx.app.inject({
        method: 'POST', url: `/api/agreements/${id}/decide`,
        headers: auth(owner.token), payload: { decision: 'accept' },
      });
      expect(decided.statusCode).toBe(200);
      const res = await ctx.app.inject({
        method: 'POST', url: `/api/agreements/${id}/reads`,
        headers: auth(consumer.token), payload: { simulationId: simId },
      });
      expect(res.statusCode).toBe(200);
      return res.json().frame;
    };

    // (a) the DECLARED field delivered alone: no ghost claim at all (the
    // R10 bug had the whole-spec ghost copy swallow exactly this case).
    const declaredFrame = await proposeAndRead(['peaks']);
    expect(declaredFrame.emptyEventWindow).toBe(true);
    expect(declaredFrame.undeclaredEventTypes).toBeUndefined();
    expect(declaredFrame.ghostEventFields).toBeUndefined();
    expect(declaredFrame.declaredEmptyEventFields).toEqual(['peaks']);

    // (b) the GHOST field delivered alone: the T83 annotation names exactly
    // the delivered ghost's type — and never the terms-outside zzz-ghost-b.
    const ghostFrame = await proposeAndRead(['ghostHits']);
    expect(ghostFrame.emptyEventWindow).toBe(true);
    expect(ghostFrame.undeclaredEventTypes).toEqual(['zzz-ghost-a']);
    expect(ghostFrame.ghostEventFields).toEqual(['ghostHits']);
    expect(ghostFrame.declaredEmptyEventFields).toBeUndefined();
    expect(JSON.stringify(ghostFrame)).not.toContain('zzz-ghost-b');

    // (c) the MIXED delivery: both classifications ride together — the CLI
    // renders the ghost copy for ghostHits and the T57a plain-window advice
    // for peaks.
    const mixedFrame = await proposeAndRead(['ghostHits', 'peaks']);
    expect(mixedFrame.undeclaredEventTypes).toEqual(['zzz-ghost-a']);
    expect(mixedFrame.ghostEventFields).toEqual(['ghostHits']);
    expect(mixedFrame.declaredEmptyEventFields).toEqual(['peaks']);
    expect(JSON.stringify(mixedFrame)).not.toContain('zzz-ghost-b');
  });

  it('provider and strangers cannot read; non-active agreements refuse', async () => {
    const providerAttempt = await read(owner.token);
    expect(providerAttempt.statusCode).toBe(403);
    expect((await read(undefined)).statusCode).toBe(401);

    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/suspend`,
      headers: auth(owner.token),
      payload: {},
    });
    const suspended = await read(consumer.token);
    expect(suspended.statusCode).toBe(409);
    expect(suspended.json().error.code).toBe('AGREEMENT_NOT_ACTIVE');
    expect(await usageRows()).toHaveLength(0); // precondition rejections meter nothing
  });

  it('no user sim and no cache → the authoritative world session is created on demand (P1W) and the read evaluates against it', async () => {
    // Living-worlds P1W: the auto-targeted read materializes the env's
    // authoritative world session — the old "no sim and no cache → 409
    // SIMULATION_NOT_RUNNING" degradation is superseded for bridged envs
    // (the 409 remains the honest fallback when the session cannot exist).
    const res = await read(consumer.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().simulationId).toBe(`sim-${envId}-world-session`);
    expect(res.json().frame.provenance.cached).toBe(false);
    expect(res.json().usage.outcome).toBe('success');
    expect(await usageRows()).toHaveLength(1); // the live authoritative read metered
  });

  it('terms.read.fields scopes delivery; requesting outside the clause is a metered 422', async () => {
    await runningSim(consumer.token);
    // A second, narrower agreement: only avgTemperature is contracted.
    const narrow = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { fields: ['avgTemperature'] } } },
    });
    expect(narrow.statusCode).toBe(201);
    const narrowId = narrow.json().id as string;
    await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${narrowId}/decide`,
      headers: auth(owner.token), payload: { decision: 'accept' },
    });

    const ok = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${narrowId}/reads`, headers: auth(consumer.token), payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(Object.keys(ok.json().frame.data)).toEqual(['avgTemperature']);
    expect(ok.json().applied.fields).toEqual(['avgTemperature']);

    // Narrowing within the clause is the consumer's choice:
    const narrower = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${narrowId}/reads`, headers: auth(consumer.token),
      payload: { fields: ['avgTemperature'] },
    });
    expect(narrower.statusCode).toBe(200);
    expect(Object.keys(narrower.json().frame.data)).toEqual(['avgTemperature']);

    // Widening is refused with a metered failure row (T-205 semantics):
    const wide = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${narrowId}/reads`, headers: auth(consumer.token),
      payload: { fields: ['activeFallAlerts'] },
    });
    expect(wide.statusCode).toBe(422);
    expect(wide.json().error.code).toBe('AGREEMENT_TERMS_VIOLATION');
    expect(wide.json().error.allowedFields).toEqual(['avgTemperature']);
    expect(wide.json().error.requestedFields).toEqual(['activeFallAlerts']);
    const narrowUsage = (await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${narrowId}/usage`, headers: auth(consumer.token),
    })).json().usage as Array<{ outcome: string; failureReason?: string }>;
    // Same-ms reads tie on started_at (id is a random UUID) — assert the
    // MULTISET and identify the failure by its reason, not row position.
    expect([...narrowUsage.map(u => u.outcome)].sort()).toEqual(['failure', 'success', 'success']);
    // T35 (R3 u2-F-07): the failure row names WHY — same text as the 422.
    const violationRow = narrowUsage.find(u => u.outcome === 'failure');
    expect(violationRow?.failureReason).toBe(wide.json().error.message);
  });

  it('the read quota is a separate budget counted by kind (T-307 generalization)', async () => {
    // Re-propose with quota 1 per day.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { quotaPerWindow: 1, windowSec: 86400 } } },
    });
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${id}/decide`,
      headers: auth(owner.token), payload: { decision: 'accept' },
    });
    await runningSim(consumer.token);

    const first = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${id}/reads`, headers: auth(consumer.token), payload: {},
    });
    expect(first.statusCode).toBe(200);
    const second = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${id}/reads`, headers: auth(consumer.token), payload: {},
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('QUOTA_EXCEEDED');
    expect(second.json().error.quota).toBe('agreement_read_per_window');
    const usage = (await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${id}/usage`, headers: auth(consumer.token),
    })).json().usage as Array<{ kind: string }>;
    expect(usage).toHaveLength(1); // the 429 executed and metered nothing
  });

  it('honest degradation: cached frame after the sim stops, DATA_STALE beyond minFreshnessSec, stale flag without the clause', async () => {
    const simId = await runningSim(consumer.token);
    // Living-worlds P1W: explicit simId throughout the degradation arms —
    // the auto-targeted read would materialize the authoritative world
    // session (see the on-demand test), and THIS test pins the cached-frame
    // honesty of the per-user-sim lane.
    const live = await read(consumer.token, { simulationId: simId });
    expect(live.statusCode).toBe(200);

    // Stop the sim — the world only lives in the runtime.
    const stopped = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(consumer.token), payload: {},
    });
    expect(stopped.statusCode).toBe(200);

    const cachedRead = await read(consumer.token, { simulationId: simId });
    expect(cachedRead.statusCode).toBe(200);
    expect(cachedRead.json().frame.provenance.cached).toBe(true);
    // T57b: the cached frame keeps its computation-time provenance (the sim
    // that computed it — now stopped, but still a fact). T68c (R7): the
    // top-level simulationId carries that computing sim too — the human face
    // reads "cached, computed from sim X", so --json must not be less
    // traceable (R102); `cached: true` keeps naming the mode.
    expect(cachedRead.json().frame.provenance.simulationId).toBe(simId);
    expect(cachedRead.json().simulationId).toBe(simId);
    expect(cachedRead.json().frame.stale).toBe(false); // fresh enough vs refreshSec=60
    expect(cachedRead.json().usage.outcome).toBe('success'); // a delivered cache hit burns quota

    // latest: cache-first, same behavior, no recompute (sim is stopped).
    const latest = await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}/reads/latest`, headers: auth(consumer.token),
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().frame.provenance.cached).toBe(true);

    // Age the cache row beyond any reasonable freshness — with the current
    // (clause-less) agreement the frame is delivered but flagged stale.
    ctx.app.db
      .prepare('UPDATE service_data_frames SET computed_at_wall = ? WHERE service_id = ?')
      .run(new Date(Date.now() - 3600_000).toISOString(), serviceId);
    const staleRead = await read(consumer.token, { simulationId: simId });
    expect(staleRead.statusCode).toBe(200);
    expect(staleRead.json().frame.stale).toBe(true);
    expect(staleRead.json().frame.freshnessSec).toBeGreaterThanOrEqual(3600);

    // With a minFreshnessSec clause the aged cache is REFUSED (409,
    // unmetered) on the user-sim lane — and the AUTO-targeted read lands on
    // the authoritative world session the clause materialized (P1W: the
    // freshness obligation is a standing wall due), recomputing FRESH.
    const strict = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { minFreshnessSec: 60 } } },
    });
    expect(strict.statusCode).toBe(201);
    const strictId = strict.json().id as string;
    await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${strictId}/decide`,
      headers: auth(owner.token), payload: { decision: 'accept' },
    });
    // P1W: the accept materialized the world session (the floor obligation),
    // whose post-advance recompute overwrote the aged cache at the deadline
    // (§8.5's platform half). Wait for that refresh, then age the row AGAIN
    // to prove the DATA_STALE refusal still guards the cached lane when the
    // world has not recomputed since.
    const freshAgain = await (async (): Promise<boolean> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const row = ctx.app.serviceStore.latestFrameOf(serviceId);
        if (row !== undefined && Date.parse(row.computed_at_wall) > Date.now() - 10_000) {
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return false;
    })();
    expect(freshAgain).toBe(true);
    ctx.app.db
      .prepare('UPDATE service_data_frames SET computed_at_wall = ? WHERE service_id = ?')
      .run(new Date(Date.now() - 3600_000).toISOString(), serviceId);
    const refused = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${strictId}/reads`, headers: auth(consumer.token),
      payload: { simulationId: simId },
    });
    expect(refused.statusCode).toBe(409);
    // T97 (R15, u1-F1): the session's §8.5 deadline recompute OVERWROTE the
    // cache row, so it no longer belongs to `simId` — the explicit stopped-sim
    // read is now refused at TARGETING (honest state error) instead of being
    // handed another world's frame and only catching it at the freshness gate
    // (the old DATA_STALE here rode exactly u1's cross-sim substitution).
    expect(refused.json().error.code).toBe('SIMULATION_NOT_RUNNING');
    expect(refused.json().error.message).toContain('stopped');
    const strictUsage = (await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${strictId}/usage`, headers: auth(consumer.token),
    })).json().usage as Array<unknown>;
    expect(strictUsage).toHaveLength(0);
    // The auto-targeted read: fresh against the session (§8.5's platform half).
    const refreshed = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${strictId}/reads`, headers: auth(consumer.token), payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().frame.provenance.cached).toBe(false);
    expect(refreshed.json().frame.stale).toBe(false);
    expect(refreshed.json().simulationId).toBe(`sim-${envId}-world-session`);

    // T97: the DATA_STALE refusal still guards the cached lane when the aged
    // frame IS the requested sim's own — re-establish a same-sim cache, stop
    // the sim, age the row, and the freshness clause refuses (unmetered).
    const simB = await runningSim(consumer.token);
    const liveB = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${strictId}/reads`, headers: auth(consumer.token),
      payload: { simulationId: simB },
    });
    expect(liveB.statusCode).toBe(200);
    expect(liveB.json().frame.provenance.cached).toBe(false);
    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simB}/stop`, headers: auth(consumer.token), payload: {},
    });
    ctx.app.db
      .prepare('UPDATE service_data_frames SET computed_at_wall = ? WHERE service_id = ?')
      .run(new Date(Date.now() - 3600_000).toISOString(), serviceId);
    const usageBeforeRefusal = (await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${strictId}/usage`, headers: auth(consumer.token),
    })).json().usage as Array<unknown>;
    const staleRefused = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${strictId}/reads`, headers: auth(consumer.token),
      payload: { simulationId: simB },
    });
    expect(staleRefused.statusCode).toBe(409);
    expect(staleRefused.json().error.code).toBe('DATA_STALE');
    expect(staleRefused.json().error.minFreshnessSec).toBe(60);
    expect(staleRefused.json().error.message).toContain('/start');
    // The refusal added nothing: the ledger holds only the live deliveries
    // (liveB + the refreshed auto read), never the DATA_STALE rejection.
    const strictUsageAfter = (await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${strictId}/usage`, headers: auth(consumer.token),
    })).json().usage as Array<unknown>;
    expect(strictUsageAfter).toHaveLength(usageBeforeRefusal.length);
  });

  it('CP-F04 (R15): auto-targeting falls back to the cached frame when only FOREIGN sims run', async () => {
    // The live-round shape: the consumer's own sim stopped while OTHER
    // stakeholders' sims keep running. The auto-targeted read used to hit
    // the foreign-sims 403 instead of §7's promised cached frame.
    // Living-worlds P1W: the reads here are EXPLICIT so the degradation
    // arms exercise the user-sim lane (an auto read materializes the
    // authoritative world session — see the on-demand test above).
    const simId = await runningSim(consumer.token);
    const live = await read(consumer.token, { simulationId: simId });
    expect(live.statusCode).toBe(200); // cache row established
    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(consumer.token), payload: {},
    });

    // Another stakeholder's sim runs in the same env.
    const stranger = await registerUser(ctx.app, { displayName: 'Other Stakeholder' });
    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(stranger.token) });
    const foreignSim = await runningSim(stranger.token);

    // Degraded read on the stopped own sim: cached frame, honest labels,
    // metered success (the explicit stopped sim falls back to cache).
    const cachedRead = await read(consumer.token, { simulationId: simId });
    expect(cachedRead.statusCode).toBe(200);
    expect(cachedRead.json().frame.provenance.cached).toBe(true);
    // T68c (R7): the cached delivery keeps the computing sim on the top
    // level (the targeted sim is gone; the frame's origin is the fact).
    expect(cachedRead.json().simulationId).toBe(simId);
    expect(cachedRead.json().frame.stale).toBe(false); // fresh vs refreshSec=60
    expect(cachedRead.json().usage.outcome).toBe('success');

    // An EXPLICIT foreign simulationId stays a hard, actionable 403 — the
    // caller asked for that sim specifically; no silent substitution.
    const explicit = await read(consumer.token, { simulationId: foreignSim });
    expect(explicit.statusCode).toBe(403);
    expect(explicit.json().error.message).toContain('another user');
  });

  it('T97 (R15, u1-F1): an EXPLICIT simulationId is never answered by another sim\'s cached frame — honest 409, unmetered, even when the cache is STALE', async () => {
    // u1's repro: read own running sim (cache established), then read with
    // `--simulation <teammate's stopped sim>` — the §7 fallback served the
    // OTHER sim's cached frame (exit 0, metered success), and once the cache
    // aged past refreshSec it served a 244s STALE cross-sim frame, still
    // success. The cache lookup is now keyed to the requested sim.
    const ownSim = await runningSim(consumer.token);
    const live = await read(consumer.token, { simulationId: ownSim });
    expect(live.statusCode).toBe(200); // cache row established (computed from ownSim)
    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${ownSim}/stop`, headers: auth(consumer.token), payload: {},
    });

    // A teammate's sim — created by another member, then stopped (u1's exact
    // target: a foreign sim in a terminal state).
    const teammate = await registerUser(ctx.app, { displayName: 'Teammate' });
    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(teammate.token) });
    const teammateSim = await runningSim(teammate.token);
    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${teammateSim}/stop`, headers: auth(teammate.token), payload: {},
    });

    const rowsBefore = (await usageRows()).length;

    // The cross-sim request gets the honest targeting error — NOT the cache
    // of ownSim, NOT the world session, nothing metered.
    const wrong = await read(consumer.token, { simulationId: teammateSim });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe('SIMULATION_NOT_RUNNING');
    expect(wrong.json().error.message).toContain('stopped');

    // Age the cache past refreshSec — the STALE cross-sim frame must STILL
    // not be served (u1's 244s STALE success was the worst shape of the bug).
    ctx.app.db
      .prepare('UPDATE service_data_frames SET computed_at_wall = ? WHERE service_id = ?')
      .run(new Date(Date.now() - 3600_000).toISOString(), serviceId);
    const staleWrong = await read(consumer.token, { simulationId: teammateSim });
    expect(staleWrong.statusCode).toBe(409);
    expect(staleWrong.json().error.code).toBe('SIMULATION_NOT_RUNNING');

    // An explicit id that names NO sim at all stays a 404 — the cache never
    // answers for a world that does not exist.
    const ghost = await read(consumer.token, { simulationId: 'sim-does-not-exist' });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error.code).toBe('SIMULATION_NOT_FOUND');

    // Neither refusal executed anything: the usage ledger gained zero rows
    // (precondition rejections meter nothing), the cross-sim frames were
    // never billed as success.
    expect(await usageRows()).toHaveLength(rowsBefore);

    // §7 preserved: the SAME-sim cached fallback still serves the frame that
    // world computed (labeled stale now, and honestly metered as a delivery).
    const sameSim = await read(consumer.token, { simulationId: ownSim });
    expect(sameSim.statusCode).toBe(200);
    expect(sameSim.json().frame.provenance.cached).toBe(true);
    expect(sameSim.json().frame.provenance.simulationId).toBe(ownSim);
    expect(sameSim.json().frame.stale).toBe(true);
    expect(sameSim.json().usage.outcome).toBe('success');
  });

  it('revoked computation: reads 409 COMPUTATION_UNREGISTERED with a failure row (not silent)', async () => {
    await runningSim(consumer.token);
    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
    });
    expect(revoked.statusCode).toBe(200);

    const res = await read(consumer.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('COMPUTATION_UNREGISTERED');
    const usage = await usageRows();
    expect(usage).toHaveLength(1);
    expect(usage[0].outcome).toBe('failure');
    expect(usage[0].kind).toBe('read');
    // T35 (R3 u2-F-07, R102): the read failure row carries the reason — the
    // invoke/reboot lanes already did; the read lane no longer lags.
    expect((usage[0] as { failureReason?: string }).failureReason).toBe(res.json().error.message);
  });

  it('propose validates terms.read against dataSchema; missing read clause warns', async () => {
    const badFields = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { fields: ['nonexistentField'] } } },
    });
    expect(badFields.statusCode).toBe(400);
    expect(badFields.json().error.message).toContain('nonexistentField');

    const warned = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(warned.statusCode).toBe(201);
    expect(warned.json().warnings).toHaveLength(1);
    expect(warned.json().warnings[0]).toContain('terms.read');

    // Unknown read keys are named, not dropped:
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { fields: ['avgTemperature'], bogus: 1 } } },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toContain('terms.read.bogus');
  });

  it('retentionSec echoes per frame (declarative, documented as not enforced)', async () => {
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { retentionSec: 2592000, cadenceSec: 300 } } },
    });
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${id}/decide`,
      headers: auth(owner.token), payload: { decision: 'accept' },
    });
    await runningSim(consumer.token);
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${id}/reads`, headers: auth(consumer.token), payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied.retentionSec).toBe(2592000);
  });

  // -------------------------------------------------------------------------
  // T57 (R6): the read honesty family — window clock, cached provenance,
  // event-unit declaration, activatedAt exposure.
  // -------------------------------------------------------------------------

  it('T57a+b: an empty event window carries the sim-second window and the rate; the cached fallback keeps its provenance', async () => {
    // Re-register with an EVENT metric (declared unit '次' — T57c's face) so
    // the window semantics ride the frame.
    const simId = await runningSim(consumer.token);
    const reRegistered = await ctx.app.inject({
      method: 'POST', url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        schemaVersion: 5,
        inputs: {
          zones: ['zone-a', 'zone-b'],
          metrics: [
            { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
            { source: 'event', eventType: 'fall-detected', fn: 'countSince', windowSec: 600, as: 'falls' },
          ],
        },
        interface: {
          dataSchema: {
            fields: [
              { name: 'avgTemperature', type: 'number', unit: '°C' },
              { name: 'falls', type: 'integer', unit: '次' },
            ],
          },
        },
      },
    });
    expect(reRegistered.statusCode).toBe(201);

    // The old agreement's scope (avgTemperature + activeFallAlerts) has
    // drifted — a fresh agreement contracts onto the new field set.
    const fresh = await ctx.app.inject({
      method: 'POST', url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { fields: ['avgTemperature', 'falls'] } } },
    });
    expect(fresh.statusCode).toBe(201);
    const freshId = fresh.json().id as string;
    await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${freshId}/decide`,
      headers: auth(owner.token), payload: { decision: 'accept' },
    });

    // The event window matched nothing → emptyEventWindow + the clock faces.
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${freshId}/reads`,
      headers: auth(consumer.token), payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.frame.emptyEventWindow).toBe(true);
    expect(body.frame.eventWindowSec).toBe(600); // SIMULATED seconds
    expect(typeof body.frame.effectiveSpeedPerSec).toBe('number');
    expect(body.frame.effectiveSpeedPerSec).toBeGreaterThan(0);
    // T57c: the event field's unit is the REGISTERED declaration, not null.
    expect(body.frame.units.falls).toBe('次');

    // T57b: stop the sim → the §7 cached fallback serves the origin sim's
    // provenance (computation-time fact), and `cached` names the mode.
    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(consumer.token), payload: {},
    });
    const latest = await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${freshId}/reads/latest`, headers: auth(consumer.token),
    });
    expect(latest.statusCode).toBe(200);
    const cachedBody = latest.json();
    expect(cachedBody.frame.provenance.cached).toBe(true);
    // The frame was computed by the (now stopped) sim — provenance survives.
    expect(cachedBody.frame.provenance.simulationId).toBe(simId);
    // T68c (R7): the --latest cached delivery carries the computing sim on
    // the top level too — the human face's "cached, computed from sim X"
    // has its json counterpart (no targeted sim runs; the origin is the
    // traceability fact, `cached: true` names the mode).
    expect(cachedBody.simulationId).toBe(simId);
  });

  // T81 (R8, u2-F4): re-registration is an ATOMIC spec swap — the cached
  // frame of the old generation must never be served afterwards. The u2
  // timeline: provider fixes the spec, the consumer's `--latest` kept
  // replaying the old error/value for up to refreshSec.
  it('T81: re-registration invalidates the cached frame — --latest immediately computes from the NEW spec', async () => {
    const simId = await runningSim(consumer.token);
    // First read computes and fills the cache.
    const first = await read(consumer.token, { simulationId: simId });
    expect(first.statusCode).toBe(200);
    expect(first.json().frame.provenance.cached).toBe(false);
    expect(first.json().frame.schemaVersion).toBe(1);
    // The --latest face now serves the cached generation.
    const cached = await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}/reads/latest`, headers: auth(consumer.token),
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.json().frame.provenance.cached).toBe(true);

    // The provider re-registers (same field names — an active agreement stays
    // readable; a different computation generation, schema_version 3).
    const reRegistered = await ctx.app.inject({
      method: 'POST', url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        schemaVersion: 3,
        inputs: {
          zones: ['zone-a', 'zone-b'],
          metrics: [
            { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
            { source: 'device', capability: 'fall-detection', fn: 'countActive', as: 'activeFallAlerts' },
            { source: 'event', eventType: 'fall-detected', fn: 'countSince', windowSec: 3600, as: 'fallsLastHour' },
          ],
        },
        interface: {
          dataSchema: {
            fields: [
              { name: 'avgTemperature', type: 'number', unit: '°C' },
              { name: 'activeFallAlerts', type: 'integer' },
              { name: 'fallsLastHour', type: 'integer' },
            ],
          },
        },
      },
    });
    expect(reRegistered.statusCode).toBe(201);

    // --latest with the sim STILL RUNNING: the cold path recomputes from the
    // NEW spec (the cache was invalidated) — no old-generation replay.
    const latest = await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}/reads/latest`, headers: auth(consumer.token),
    });
    expect(latest.statusCode).toBe(200);
    const body = latest.json();
    expect(body.frame.provenance.cached).toBe(false);
    expect(body.frame.schemaVersion).toBe(3);
    expect(typeof body.frame.data.avgTemperature).toBe('number');
  });

  it('T57e: the agreement detail carries activatedAt (v59) — null before accept, stamped after', async () => {
    const before = await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}`, headers: auth(consumer.token),
    });
    expect(before.statusCode).toBe(200);
    // This fixture's agreement is accepted in beforeEach — active rows carry
    // the activation stamp.
    expect(typeof before.json().activatedAt).toBe('string');

    // A still-proposed row has NEVER been active → honest null.
    const proposed = await ctx.app.inject({
      method: 'POST', url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token), payload: {},
    });
    expect(proposed.statusCode).toBe(201);
    expect(proposed.json().activatedAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // T-407 (DevLoop R19, FM-F02): read-field schema drift — honest 409
  // -------------------------------------------------------------------------

  it('T-407: renamed fields under an active read agreement → 409 COMPUTATION_SCHEMA_DRIFT with the missing list + schema version; a fresh agreement on the new names reads fine; a null VALUE now refuses (T50)', async () => {
    // Baseline: the agreement reads cleanly before the rename.
    await runningSim(consumer.token);
    expect((await read(consumer.token)).statusCode).toBe(200);

    // The provider re-registers with renames (sv3 → avgTempC) + a
    // legitimately-null metric (avg over a state key no device writes).
    const renamed = await ctx.app.inject({
      method: 'POST', url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        schemaVersion: 3,
        inputs: {
          zones: ['zone-a', 'zone-b'],
          metrics: [
            { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTempC' },
            { source: 'device', capability: 'fall-detection', fn: 'countActive', as: 'activeFallAlerts' },
            { source: 'device', capability: 'fall-detection', fn: 'avg', path: 'neverWrittenKey', as: 'avgNeverWritten' },
          ],
        },
        interface: {
          dataSchema: {
            fields: [
              { name: 'avgTempC', type: 'number', unit: '°C' },
              { name: 'activeFallAlerts', type: 'integer' },
              { name: 'avgNeverWritten', type: 'number' },
            ],
          },
        },
      },
    });
    expect(renamed.statusCode).toBe(201);

    // The still-active agreement's next read is an honest 409 naming the
    // missing fields + the current schema version + the action path.
    const drifted = await read(consumer.token);
    expect(drifted.statusCode).toBe(409);
    expect(drifted.json().error.code).toBe('COMPUTATION_SCHEMA_DRIFT');
    const message: string = drifted.json().error.message;
    expect(message).toContain('avgTemperature');
    expect(message).toContain('schema_version 3');
    // T57d (R6, u4-F6): the remedy names only paths that EXIST — an ACTIVE
    // agreement cannot counter (AGREEMENT_NOT_PROPOSED), so the message
    // teaches the real renegotiation: terminate + re-propose.
    expect(message).not.toContain('counter');
    expect(message).toContain('POST /api/agreements/:id/terminate');
    expect(message).toContain('POST /api/services/:id/agreements');
    expect(drifted.json().error).toMatchObject({
      missingFields: ['avgTemperature'],
      schemaVersion: 3,
    });
    // Metered as a failure row (audit trail), like COMPUTATION_UNREGISTERED.
    const usage = ctx.app.agreementStore.usageOf(agreementId);
    expect(usage.some(row => row.outcome === 'failure' && row.kind === 'read')).toBe(true);

    // A fresh agreement on the NEW names reads the live metric — and T50
    // (R5, u2-F1): a field whose VALUE is null (avgNeverWritten: the state
    // key no device writes) is an EMPTY DELIVERY now, not a servable null —
    // 409 COMPUTATION_METRIC_NO_READING, metered as failure, agreement
    // alive. Narrowing to the live field reads fine.
    const proposed = await ctx.app.inject({
      method: 'POST', url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { fields: ['avgTempC', 'avgNeverWritten'] } } },
    });
    expect(proposed.statusCode).toBe(201);
    const freshId = proposed.json().id as string;
    await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${freshId}/decide`,
      headers: auth(owner.token), payload: { decision: 'accept' },
    });
    const emptyDelivery = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${freshId}/reads`, headers: auth(consumer.token), payload: {},
    });
    expect(emptyDelivery.statusCode).toBe(409);
    expect(emptyDelivery.json().error.code).toBe('COMPUTATION_METRIC_NO_READING');
    expect(emptyDelivery.json().error.fields).toEqual(['avgNeverWritten']);
    expect(emptyDelivery.json().error.message).toContain('NOT terminated');
    const emptyRows = (await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${freshId}/usage`, headers: auth(consumer.token),
    })).json().usage as Array<{ outcome: string; kind: string; failureReason?: string }>;
    const emptyFailure = emptyRows.find(row => row.kind === 'read');
    expect(emptyFailure?.outcome).toBe('failure');
    expect(String(emptyFailure?.failureReason)).toContain('avgNeverWritten');

    // Count-type fields are NEVER null (count/countActive/event) — a read
    // narrowed to a live value field + a count delivers honestly.
    const narrowed = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${freshId}/reads`,
      headers: auth(consumer.token),
      payload: { fields: ['avgTempC'] },
    });
    expect(narrowed.statusCode).toBe(200);
    expect(narrowed.json().frame.data.avgTempC).toEqual(expect.any(Number));
  });
});

// ---------------------------------------------------------------------------
// Push lane (R14 Wave-A Task 3): data frames on the agreement stream socket
// ---------------------------------------------------------------------------

describe('data services: the push lane (stream frames)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let providerAgentId: string;
  let serviceId: string;
  let agreementId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'ElderCare Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Family Member' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        visibility: 'public',
        meta: { id: 'care-home-push', name: 'Care Home (push lane)', description: 'fixture' },
        zones: [
          { id: 'zone-a', adjacentZoneIds: ['zone-b'] },
          { id: 'zone-b', adjacentZoneIds: ['zone-a'] },
        ],
        devices: [
          {
            id: 'fall-sensor-1', name: 'Fall Sensor 1', type: 'sensor',
            capabilities: ['fall-detection'], zoneId: 'zone-a', initialState: { active: false },
          },
          {
            id: 'hvac-b', name: 'HVAC B', type: 'hvac',
            capabilities: ['turn-on', 'turn-off'], zoneId: 'zone-b',
          },
        ],
        agents: [{
          id: 'care-bot', name: 'Care Bot', capabilities: ['care-status'],
          managesZoneIds: ['zone-a', 'zone-b'], boundDeviceIds: ['fall-sensor-1', 'hvac-b'],
        }],
        events: [],
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    const detail = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
    })).json();
    providerAgentId = (detail.agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Care Bot')!.id;

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'care-status-aggregate', semanticType: 'care-status-aggregate' },
    });
    expect(published.statusCode).toBe(201);
    serviceId = published.json().id as string;

    const registered = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        inputs: {
          zones: ['zone-a', 'zone-b'],
          metrics: [
            { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
            { source: 'device', capability: 'fall-detection', fn: 'countActive', as: 'activeFallAlerts' },
            { source: 'event', eventType: 'fall-detected', fn: 'countSince', windowSec: 3600, as: 'fallsLastHour' },
          ],
        },
        interface: {
          dataSchema: {
            fields: [
              { name: 'avgTemperature', type: 'number' },
              { name: 'activeFallAlerts', type: 'integer' },
              { name: 'fallsLastHour', type: 'integer' },
            ],
          },
        },
      },
    });
    expect(registered.statusCode).toBe(201);

    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(consumer.token) });

    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { fields: ['avgTemperature', 'fallsLastHour'] } } },
    });
    expect(proposed.statusCode).toBe(201);
    agreementId = proposed.json().id as string;
    await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token), payload: { decision: 'accept' },
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function runningSim(): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/simulations', headers: auth(consumer.token),
      payload: { environmentId: envId },
    });
    expect(created.statusCode).toBe(201);
    const simId = created.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(consumer.token), payload: {},
    });
    expect(started.statusCode).toBe(200);
    return simId;
  }

  async function listen(): Promise<string> {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    if (typeof address === 'object' && address !== null) {
      return `ws://127.0.0.1:${address.port}`;
    }
    throw new Error('listen failed');
  }

  function collect(socket: WebSocket): Array<Record<string, unknown>> {
    const frames: Array<Record<string, unknown>> = [];
    socket.on('message', data => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    return frames;
  }

  function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (predicate()) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() - started > ms) {
          clearInterval(poll);
          reject(new Error('waitFor timed out'));
        }
      }, 10);
    });
  }

  it('subscribes with a computation summary, pushes an immediate data frame and recomputes on injections; session meters kind=stream', async () => {
    const baseUrl = await listen();
    await runningSim();

    // Living-worlds P1W: with no ?simulationId the data stream targets the
    // env's authoritative world session (created on demand). The injection
    // must therefore land IN the authoritative world — the env owner acts
    // on the shared world (owner/builder role required).
    const socket = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream`, {
      headers: auth(consumer.token),
    });
    const frames = collect(socket);
    await waitFor(() => frames.some(frame => frame.kind === 'subscribed'));
    expect(frames[0]).toMatchObject({
      kind: 'subscribed',
      agreementId,
      deviceId: null, // a data service has no backing device
      computation: { kind: 'zone-query', refreshSec: 60, schemaVersion: 1 },
    });
    expect((frames[0] as { simulationId?: string }).simulationId)
      .toBe(`sim-${envId}-world-session`);

    // The immediate frame is scoped to the read clause (activeFallAlerts excluded).
    await waitFor(() => frames.some(frame => frame.kind === 'data'));
    const first = frames.find(frame => frame.kind === 'data')!;
    expect(first).toMatchObject({
      agreementId,
      serviceId,
      schemaVersion: 1,
      freshnessSec: 0,
      stale: false,
    });
    expect(Object.keys(first.data as object)).toEqual(['avgTemperature', 'fallsLastHour']);
    expect((first.provenance as Record<string, unknown>).cached).toBe(false);
    expect(first.fallsLastHour).toBeUndefined(); // it lives in data, not on the frame
    expect((first.data as Record<string, unknown>).fallsLastHour).toBe(0);

    // Inject a fall event into the spec's zone → recompute + push.
    const injected = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/sim-${envId}-world-session/events`,
      headers: auth(owner.token),
      payload: { type: 'fall-detected', zoneId: 'zone-a', severity: 'high' },
    });
    expect(injected.statusCode).toBe(200);
    await waitFor(() =>
      frames.filter(frame => frame.kind === 'data').length >= 2 &&
      ((frames.filter(frame => frame.kind === 'data')[1].data as Record<string, unknown>).fallsLastHour as number) === 1,
    );
    const second = frames.filter(frame => frame.kind === 'data')[1];
    expect((second.provenance as Record<string, unknown>).inputsSummary).toMatchObject({ eventsWindowed: 1 });

    socket.close();
    await waitFor(() => ctx.app.agreementStore.usageOf(agreementId)
      .some(record => record.kind === 'stream'));
    const streamUsage = ctx.app.agreementStore.usageOf(agreementId)
      .filter(record => record.kind === 'stream');
    expect(streamUsage).toHaveLength(1);
    expect(streamUsage[0].unit).toBe('message');
    expect(streamUsage[0].outcome).toBe('success');
    expect(streamUsage[0].quantity).toBeGreaterThanOrEqual(2); // immediate + injection recompute
  });

  it('?params is refused with teaching on the data lane (no silent filter drop)', async () => {
    const baseUrl = await listen();
    await runningSim();

    const socket = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream?params=temperature`, {
      headers: auth(consumer.token),
    });
    const rejected = await new Promise<{ code: number; body: string }>(resolve => {
      socket.on('unexpected-response', (_request, response) => {
        let body = '';
        response.on('data', chunk => { body += String(chunk); });
        response.on('end', () => resolve({ code: response.statusCode, body }));
      });
    });
    expect(rejected.code).toBe(400);
    expect(rejected.body).toContain('data service');
  });

  it('revoking the computation mid-stream closes the socket with reason "computation unregistered"', async () => {
    const baseUrl = await listen();
    await runningSim();

    const socket = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream`, {
      headers: auth(consumer.token),
    });
    const frames = collect(socket);
    await waitFor(() => frames.some(frame => frame.kind === 'data'));

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
    });
    expect(revoked.statusCode).toBe(200);

    // The next trigger (an injection) sees the revoke and closes the session.
    // P1W: the stream (no ?simulationId) is pinned to the authoritative
    // world session — the injection must land there (owner acts on the
    // shared world).
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/sim-${envId}-world-session/events`,
      headers: auth(owner.token),
      payload: { type: 'fall-detected', zoneId: 'zone-a' },
    });
    await waitFor(() => frames.some(frame => frame.kind === 'closed'));
    const closed = frames.find(frame => frame.kind === 'closed')!;
    expect(closed.reason).toBe('computation unregistered');

    await waitFor(() => ctx.app.agreementStore.usageOf(agreementId)
      .some(record => record.kind === 'stream'));
    expect(ctx.app.agreementStore.usageOf(agreementId)
      .filter(record => record.kind === 'stream')).toHaveLength(1);
    socket.close();
  });

  it('T-407: read-field drift mid-stream closes the socket with reason "read fields drifted" (metered as the session end)', async () => {
    const baseUrl = await listen();
    await runningSim();

    const socket = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream`, {
      headers: auth(consumer.token),
    });
    const frames = collect(socket);
    await waitFor(() => frames.some(frame => frame.kind === 'data'));

    // The provider re-registers with a rename — the agreement's
    // terms.read.fields no longer resolve against the current schema.
    const renamed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        schemaVersion: 2,
        inputs: {
          zones: ['zone-a', 'zone-b'],
          metrics: [
            { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTempC' },
            { source: 'event', eventType: 'fall-detected', fn: 'countSince', windowSec: 3600, as: 'fallsLastHour' },
          ],
        },
        interface: {
          dataSchema: {
            fields: [
              { name: 'avgTempC', type: 'number' },
              { name: 'fallsLastHour', type: 'integer' },
            ],
          },
        },
      },
    });
    expect(renamed.statusCode).toBe(201);

    // The next trigger (an injection) sees the drift and closes the session.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/sim-${envId}-world-session/events`,
      headers: auth(owner.token),
      payload: { type: 'fall-detected', zoneId: 'zone-a' },
    });
    await waitFor(() => frames.some(frame => frame.kind === 'closed'));
    const closed = frames.find(frame => frame.kind === 'closed')!;
    expect(closed.reason).toBe('read fields drifted');
    expect(closed.missingFields).toEqual(['avgTemperature']);
    expect(closed.schemaVersion).toBe(2);

    // The close metered the stream session (quantity = frames pushed).
    await waitFor(() => ctx.app.agreementStore.usageOf(agreementId)
      .some(record => record.kind === 'stream'));
    const streamUsage = ctx.app.agreementStore.usageOf(agreementId)
      .filter(record => record.kind === 'stream');
    expect(streamUsage).toHaveLength(1);
    expect(streamUsage[0].quantity).toBeGreaterThanOrEqual(1);
    socket.close();
  });
});

// ---------------------------------------------------------------------------
// T-065 (R16, CP-F10): the PER-BED reads lane. R15 found the structural gap:
// derived per-device services cannot carry computations (409) and a
// zone+capability scope cannot express ONE bed's metric without aggregating
// the other resident's device in the same scope. The lane: the provider
// PUBLISHES a per-bed service (hidden from birth) whose computation declares
// inputs.devices = exactly that bed's device — one consumption model
// (terms.read + reads/stream), the aggregate-privacy invariant generalized:
// inputsSummary shows exactly the scoped devices.
// ---------------------------------------------------------------------------

describe('per-bed data services: device-scoped computations (T-065, CP-F10)', () => {
  let ctx: TestAppContext;
  let operator: TestUser; // env owner + provider agent owner (the data fiduciary)
  let family: TestUser; // consumer — family of resident in bed 1
  let envId: string;
  let providerAgentId: string;
  let watchBed1Id: string; // resolved post-import: rows get fresh ids (T-110)
  let watchBed2Id: string;
  let lobbyCamId: string; // exists in the env, NOT bound to the provider agent
  let callPanelId: string; // bound, executable capability (turn-on/turn-off)
  let serviceId: string; // "Bed 1 heart rate" — published, hidden, computation-backed
  let agreementId: string;
  let simId: string;

  const BED1_SPEC = (devices: string[] = [watchBed1Id]) => ({
    kind: 'device-aggregate',
    refreshSec: 30,
    inputs: {
      zones: '*',
      devices,
      metrics: [
        { source: 'device', capability: 'heart-rate', path: 'heartRate', fn: 'avg', as: 'heartRate' },
        { source: 'device', capability: 'heart-rate', fn: 'countActive', as: 'monitoring' },
      ],
    },
    interface: {
      dataSchema: {
        fields: [
          { name: 'heartRate', type: 'number', unit: 'bpm' },
          { name: 'monitoring', type: 'integer' },
        ],
      },
    },
  });

  const register = (token: string, body: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/computation`,
      headers: auth(token),
      payload: body,
    });

  beforeEach(async () => {
    ctx = await makeTestApp();
    operator = await registerUser(ctx.app, { displayName: 'Eldercare Operator' });
    family = await registerUser(ctx.app, { displayName: 'Family of Bed 1' });

    // Two beds in one ward, watches bound to the SAME provider agent (the
    // exact CP-F10 topology: capability scoping alone cannot separate them),
    // a bound call panel (an executable capability — it derives a service row
    // for the derived-409 probe), and an unbound lobby camera.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(operator.token),
      payload: {
        version: '1.0',
        visibility: 'public',
        meta: { id: 'care-home-perbed', name: 'Care Home (per-bed lane)', description: 'T-065 fixture' },
        zones: [
          { id: 'ward-101', adjacentZoneIds: ['hall'] },
          { id: 'hall', adjacentZoneIds: ['ward-101'] },
        ],
        devices: [
          {
            id: 'watch-bed-1', name: 'Heart Watch (Bed 1)', type: 'sensor',
            capabilities: ['heart-rate'], zoneId: 'ward-101',
            initialState: { heartRate: 72, active: true },
          },
          {
            id: 'watch-bed-2', name: 'Heart Watch (Bed 2)', type: 'sensor',
            capabilities: ['heart-rate'], zoneId: 'ward-101',
            initialState: { heartRate: 88, active: true },
          },
          {
            id: 'call-panel', name: 'Nurse Call Panel', type: 'hvac',
            capabilities: ['turn-on', 'turn-off'], zoneId: 'ward-101',
          },
          {
            id: 'lobby-cam', name: 'Lobby Camera', type: 'camera',
            capabilities: ['motion-detection'], zoneId: 'hall',
          },
        ],
        agents: [{
          id: 'care-bot', name: 'Care Bot', capabilities: ['care-status'],
          managesZoneIds: ['ward-101'], boundDeviceIds: ['watch-bed-1', 'watch-bed-2', 'call-panel'],
        }],
        events: [],
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    const detail = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(operator.token),
    })).json();
    providerAgentId = (detail.agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Care Bot')!.id;
    const deviceId = (name: string): string =>
      (detail.devices as Array<{ id: string; name: string }>).find(device => device.name === name)!.id;
    watchBed1Id = deviceId('Heart Watch (Bed 1)');
    watchBed2Id = deviceId('Heart Watch (Bed 2)');
    lobbyCamId = deviceId('Lobby Camera');
    callPanelId = deviceId('Nurse Call Panel');

    // The per-bed data product: PUBLISHED (interface is provider-managed —
    // the derivation sync never touches it), hidden from birth.
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(operator.token),
      payload: {
        name: '床 1 心率（Bed 1 heart rate）',
        semanticType: 'heart-rate-bed-1',
        description: 'T-065 per-bed data product — scoped to Bed 1\'s watch only',
        visibility: 'hidden',
      },
    });
    expect(published.statusCode).toBe(201);
    serviceId = published.json().id as string;

    const registered = await register(operator.token, BED1_SPEC());
    expect(registered.statusCode).toBe(201);
    expect(registered.json().consumable).toBe(true); // unbacked → computation flips it

    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(family.token) });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Grant → propose(terms.read) → accept → running sim. */
  async function establishedAgreement(): Promise<void> {
    const grant = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-grants`,
      headers: auth(operator.token),
      payload: {
        userId: family.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        basis: 'family of resident bed-1',
        dataSubject: { ref: 'resident-bed-1' },
      },
    });
    expect(grant.statusCode).toBe(201);

    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(family.token),
      payload: { terms: { read: { fields: ['heartRate', 'monitoring'] } } },
    });
    expect(proposed.statusCode).toBe(201);
    agreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/decide`,
      headers: auth(operator.token), payload: { decision: 'accept' },
    });
    expect(decided.json().status).toBe('active');

    const sim = await ctx.app.inject({
      method: 'POST', url: '/api/simulations', headers: auth(family.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    simId = sim.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(family.token), payload: {},
    });
    expect(started.statusCode).toBe(200);
  }

  it('a per-bed metric returns only that device\'s values — the COUNT field proves the scope; the never-written heartRate VALUE refuses (T54)', async () => {
    // Hidden from birth: the family sees nothing until the grant opens the door.
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}`, headers: auth(family.token),
    })).statusCode).toBe(404);

    await establishedAgreement();

    // The grant opened the door; the agreement is the contract.
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}`, headers: auth(family.token),
    })).statusCode).toBe(200);

    // T54 (R6, u4-F1): heartRate has sat at the scenario initialState (72)
    // since the runtime built the watch — no write ever touched it. The
    // VALUE-metric read refuses (placeholder, not measurement) — the same
    // honesty u4's power=0 meter got.
    const refused = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/reads`,
      headers: auth(family.token), payload: { simulationId: simId, fields: ['heartRate'] },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('COMPUTATION_DEVICE_STATE_UNWRITTEN');
    expect(refused.json().error.fields).toEqual(['heartRate']);

    // The COUNT field is never gated (the T50 boundary): the scope proof
    // survives — exactly Bed 1's watch answered (monitoring=1, devices=1);
    // the other resident is absent from the frame's inputs.
    const counted = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/reads`,
      headers: auth(family.token), payload: { simulationId: simId, fields: ['monitoring'] },
    });
    expect(counted.statusCode).toBe(200);
    const body = counted.json();
    expect(body.frame.data.monitoring).toBe(1);
    expect(body.frame.provenance.computationKind).toBe('device-aggregate');
    // THE invariant: the summary shows exactly the scoped devices.
    expect(body.frame.provenance.inputsSummary.devices).toBe(1);
    expect(body.usage.kind).toBe('read');
    expect(body.usage.outcome).toBe('success');

    // The registered spec round-trips with its device scope (GET, same
    // visibility as the service).
    const spec = (await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}/computation`, headers: auth(family.token),
    })).json().computation;
    // The stored spec flattens inputs.* to the top level (zones/metrics/devices).
    expect(spec.spec.devices).toEqual([watchBed1Id]);
  });

  it('hidden + grant + agreement end-to-end INCLUDING revoke → reads 409 ACCESS_GRANT_REVOKED (the R15-unreachable path)', async () => {
    await establishedAgreement();
    // The count field delivers honestly (never gated — the T50/T54 boundary).
    expect((await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/reads`,
      headers: auth(family.token), payload: { simulationId: simId, fields: ['monitoring'] },
    })).statusCode).toBe(200);

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${serviceId}/access-grants/${family.id}`,
      headers: auth(operator.token),
    });
    expect(revoked.statusCode).toBe(204);

    // The door closed: 404 again, the market list hides the row — visibility
    // untouched by the computation (hidden stays hidden).
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}`, headers: auth(family.token),
    })).statusCode).toBe(404);
    const listed = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}/services`, headers: auth(family.token),
    })).json().services as Array<{ id: string }>;
    expect(listed.map(service => service.id)).not.toContain(serviceId);

    // The contract does not silently die: reads answer 409, metered failure.
    const refused = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/reads`,
      headers: auth(family.token), payload: { simulationId: simId },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('ACCESS_GRANT_REVOKED');
    const usage = (await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}/usage`, headers: auth(family.token),
    })).json().usage as Array<{ kind: string; outcome: string }>;
    expect(usage.filter(row => row.kind === 'read' && row.outcome === 'failure')).toHaveLength(1);
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}`, headers: auth(family.token),
    })).json().status).toBe('active'); // termination stays bilateral
  });

  it('privacy guard: a computation scoping foreign/unowned devices is rejected with teaching', async () => {
    // lobby-cam EXISTS in the env but is not bound to the provider agent.
    const foreign = await register(operator.token, BED1_SPEC([watchBed2Id, lobbyCamId]));
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json().error.code).toBe('DEVICE_SCOPE_INVALID');
    expect(foreign.json().error.message).toContain(lobbyCamId);
    expect(foreign.json().error.message).toContain('Care Bot');
    expect(foreign.json().error.invalidDevices).toEqual([lobbyCamId]);
    expect(foreign.json().error.boundDevices).toEqual([watchBed1Id, watchBed2Id, callPanelId]);
    // Unknown ids are the same refusal (nothing leaks about foreign devices).
    const ghost = await register(operator.token, BED1_SPEC(['no-such-device']));
    expect(ghost.statusCode).toBe(409);
    expect(ghost.json().error.code).toBe('DEVICE_SCOPE_INVALID');

    // Scoping any OWN device is legitimate — the provider may offer Bed 2's
    // product too (it is the fiduciary for both; the point is it cannot scope
    // devices it does not hold).
    const bed2 = await register(operator.token, BED1_SPEC([watchBed2Id]));
    expect(bed2.statusCode).toBe(201);
  });

  it('closed schema: device-scope violations are 400s that name the field and the allowed shape', async () => {
    const empty = await register(operator.token, BED1_SPEC([] as unknown as string[]));
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.message).toMatch(/inputs\.devices.*non-empty/);

    const unknownSibling = await register(operator.token, {
      ...BED1_SPEC(),
      inputs: { ...BED1_SPEC().inputs, nope: 1 },
    });
    expect(unknownSibling.statusCode).toBe(400);
    expect(unknownSibling.json().error.message).toMatch(/inputs\.nope.*allowed/);

    // The derived lane still teaches the per-bed path (CP-F10's 409 message)
    // — the call panel's executable capabilities guarantee derived rows.
    const derived = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}/services`, headers: auth(operator.token),
    })).json().services as Array<{ id: string; origin: string }>;
    const derivedRow = derived.find(service => service.origin === 'derived');
    expect(derivedRow).toBeDefined();
    const attempt = await ctx.app.inject({
      method: 'POST', url: `/api/services/${derivedRow!.id}/computation`,
      headers: auth(operator.token), payload: BED1_SPEC(),
    });
    expect(attempt.statusCode).toBe(409);
    expect(attempt.json().error.code).toBe('SERVICE_DERIVED_READONLY');
    expect(attempt.json().error.message).toContain('inputs.devices');
  });
});

// ---------------------------------------------------------------------------
// Stakeholder scenario (R12 EN-F11/FR-F04 replayed with the fix): the
// eldercare operator's unbacked care-status aggregate becomes a truly
// consumable data product, end to end — publish → register → contract with
// terms.read → live reads (metered + receipts) → quota → sim stops → stale
// honesty → revoke notification. One narrative, every guarantee asserted.
// ---------------------------------------------------------------------------

describe('stakeholder scenario: care-status-aggregate becomes consumable (R14 Wave-A)', () => {
  let ctx: TestAppContext;
  let operator: TestUser; // eldercare operator (env owner + provider agent owner)
  let contractor: TestUser; // energy contractor (the consumer)

  beforeEach(async () => {
    ctx = await makeTestApp();
    operator = await registerUser(ctx.app, { displayName: 'ElderCare Operator' });
    contractor = await registerUser(ctx.app, { displayName: 'Energy Contractor' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('the full chain: publish → register → propose(terms.read) → accept → reads metered with receipts → quota → stale honesty → revoke notify', async () => {
    // --- The world (R12 eldercare, minimal): two wards, fall sensors, one bot.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(operator.token),
      payload: {
        version: '1.0',
        visibility: 'public',
        meta: { id: 'eldercare', name: 'Sunset Care Home', description: 'R12 replay' },
        zones: [
          { id: 'ward-101', adjacentZoneIds: ['ward-102'] },
          { id: 'ward-102', adjacentZoneIds: ['ward-101'] },
        ],
        devices: [
          {
            id: 'fall-101', name: 'Fall Sensor 101', type: 'sensor',
            capabilities: ['fall-detection'], zoneId: 'ward-101', initialState: { active: false },
          },
          {
            id: 'fall-102', name: 'Fall Sensor 102', type: 'sensor',
            capabilities: ['fall-detection'], zoneId: 'ward-102', initialState: { active: false },
          },
          {
            id: 'hvac-101', name: 'Ward HVAC', type: 'hvac',
            capabilities: ['turn-on', 'turn-off'], zoneId: 'ward-101',
          },
        ],
        agents: [{
          id: 'care-bot', name: 'Care Bot', capabilities: ['fall-detection'],
          managesZoneIds: ['ward-101', 'ward-102'],
          boundDeviceIds: ['fall-101', 'fall-102', 'hvac-101'],
        }],
        events: [],
      },
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;
    const detail = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(operator.token),
    })).json();
    const careBotId = (detail.agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Care Bot')!.id;

    // --- EO publishes the aggregate — unbacked, consumable:false (T-310).
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${careBotId}/services`,
      headers: auth(operator.token),
      payload: {
        name: 'care-status-aggregate',
        semanticType: 'care-status-aggregate',
        description: '照护区聚合状态（排除逐床生命体征）',
      },
    });
    expect(published.statusCode).toBe(201);
    const serviceId = published.json().id as string;
    expect(published.json().consumable).toBe(false);

    // --- The contractor cannot even contract it yet (the R12 gap, honestly).
    const premature = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(contractor.token),
      payload: {},
    });
    expect(premature.statusCode).toBe(409);

    // --- EO registers the computation: the privacy boundary in code.
    const registered = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/computation`,
      headers: auth(operator.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        excludes: ['per-resident vitals'],
        inputs: {
          zones: ['ward-101', 'ward-102'],
          metrics: [
            { source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' },
            { source: 'device', capability: 'fall-detection', fn: 'countActive', as: 'activeFallAlerts' },
            { source: 'event', eventType: 'fall-detected', fn: 'countSince', windowSec: 3600, as: 'fallsLastHour' },
          ],
        },
        interface: {
          dataSchema: {
            fields: [
              { name: 'avgTemperature', type: 'number', unit: '°C' },
              { name: 'activeFallAlerts', type: 'integer' },
              { name: 'fallsLastHour', type: 'integer' },
            ],
          },
        },
      },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().consumable).toBe(true);

    // --- The contractor signs with terms.read: fields subset + 3 reads/day.
    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(contractor.token) });
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(contractor.token),
      payload: {
        terms: {
          read: { fields: ['avgTemperature', 'fallsLastHour'], quotaPerWindow: 3, windowSec: 86400 },
        },
      },
    });
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/decide`,
      headers: auth(operator.token), payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().termsEnforced).toBe(true);

    // --- Night-shift dispatch: the contractor runs its own sim and reads.
    const sim = await ctx.app.inject({
      method: 'POST', url: '/api/simulations', headers: auth(contractor.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;
    expect((await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(contractor.token), payload: {},
    })).statusCode).toBe(200);

    // A fall happens in ward-101 — the aggregate must count it, not name the bed.
    const injected = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/events`,
      headers: auth(contractor.token),
      payload: { type: 'fall-detected', zoneId: 'ward-101', severity: 'high' },
    });
    expect(injected.statusCode).toBe(200);

    const readOnce = async () => ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/reads`, headers: auth(contractor.token),
      // Living-worlds P1W: explicit simId — the contractor's own sim lane
      // (auto-targeted reads land on the authoritative world session, which
      // did not receive this sim's injection; covered by the read-lane tests).
      payload: { simulationId: simId },
    });

    const first = await readOnce();
    expect(first.statusCode).toBe(200);
    const frame1 = first.json().frame;
    expect(Object.keys(frame1.data)).toEqual(['avgTemperature', 'fallsLastHour']); // fields clause honored
    expect(frame1.data.fallsLastHour).toBe(1); // the injected fall, aggregated
    expect(frame1.provenance.inputsSummary).toMatchObject({ zones: 2, devices: 3 });
    expect(frame1.data.avgTemperature).toEqual(expect.any(Number));
    expect(first.json().usage).toMatchObject({ kind: 'read', unit: 'reading', quantity: 1, outcome: 'success' });

    const second = await readOnce();
    expect(second.statusCode).toBe(200);
    expect(second.json().usage.outcome).toBe('success');

    // --- Quota: 3/day — the 4th read is refused before execution or metering.
    const third = await readOnce();
    expect(third.statusCode).toBe(200);
    const fourth = await readOnce();
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error.quota).toBe('agreement_read_per_window');

    // --- Every successful read settled a receipt (Null provider: archived).
    const receipts = (await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}/receipts`, headers: auth(contractor.token),
    })).json().receipts as Array<{ status: string; usageRecordIds: string[] }>;
    expect(receipts).toHaveLength(3);
    expect(receipts.every(receipt => receipt.status === 'recorded')).toBe(true);

    const usage = (await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}/usage`, headers: auth(contractor.token),
    })).json().usage as Array<{ kind: string; outcome: string }>;
    expect(usage).toHaveLength(3); // exactly the delivered reads — the 429 metered nothing
    expect(usage.every(record => record.kind === 'read' && record.outcome === 'success')).toBe(true);

    // --- The shift ends; the sim stops. Reads keep working — from cache,
    // --- honestly marked. Age the cache past refreshSec to see the stale flag.
    expect((await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(contractor.token), payload: {},
    })).statusCode).toBe(200);
    ctx.app.db
      .prepare('UPDATE service_data_frames SET computed_at_wall = ? WHERE service_id = ?')
      .run(new Date(Date.now() - 7200_000).toISOString(), serviceId);

    // A fresh quota window: propose a second agreement without minFreshnessSec
    // (the lenient family member) — the aged frame is delivered, flagged stale.
    const familyPropose = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(contractor.token),
      payload: { terms: { read: { fields: ['avgTemperature'] } } },
    });
    expect(familyPropose.statusCode).toBe(201);
    const familyId = familyPropose.json().id as string;
    await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${familyId}/decide`,
      headers: auth(operator.token), payload: { decision: 'accept' },
    });
    const staleRead = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${familyId}/reads`, headers: auth(contractor.token),
      // P1W: explicit stopped-sim targeting — the cached-lane honesty arm
      // (an auto read would materialize the authoritative world session).
      payload: { simulationId: simId },
    });
    expect(staleRead.statusCode).toBe(200);
    expect(staleRead.json().frame.provenance.cached).toBe(true);
    expect(staleRead.json().frame.stale).toBe(true);
    expect(staleRead.json().frame.freshnessSec).toBeGreaterThanOrEqual(7200);
    expect(staleRead.json().frame.data).toEqual({ avgTemperature: expect.any(Number) });

    // --- EO revokes the computation (the pilot ends): both parties hear it,
    // --- the agreement is NOT silently terminated, reads answer honestly.
    const revoked = await ctx.app.inject({
      method: 'DELETE', url: `/api/services/${serviceId}/computation`, headers: auth(operator.token),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().consumable).toBe(false);

    // (The quota agreement would 429 first — quota precedes the computation
    // check by design — so the revoke is asserted on the unquotad family one.)
    const refused = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${familyId}/reads`, headers: auth(contractor.token), payload: {},
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('COMPUTATION_UNREGISTERED');
    const refusedUsage = (await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${familyId}/usage`, headers: auth(contractor.token),
    })).json().usage as Array<{ outcome: string }>;
    expect(refusedUsage.map(record => record.outcome)).toEqual(['success', 'failure']); // the stale cache hit, then the revoked read

    const notifications = (await ctx.app.inject({
      method: 'GET', url: '/api/notifications', headers: auth(contractor.token),
    })).json().notifications as Array<{ kind: string; refId: string }>;
    expect(notifications.filter(n => n.kind === 'agreement.compute-dropped').map(n => n.refId))
      .toEqual(expect.arrayContaining([agreementId, familyId]));

    // The contract itself survives — termination stays bilateral.
    const agreement = (await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}`, headers: auth(contractor.token),
    })).json();
    expect(agreement.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// T54 (R6, u4-F1): the never-written device-state gate — the static-0 meter.
// u4's replay: a device-aggregate over a meter whose state holds the scenario
// initialState `power: 0` delivered a "successful" 0 W while the ZONE
// parameter face said 500 W. The gate refuses (metered failure, agreement
// alive) with the cross-face contrast named; the taught remedy (zone-metric
// re-registration, or a real device write) recovers honest success.
// ---------------------------------------------------------------------------

describe('T54: never-written device state → 409 COMPUTATION_DEVICE_STATE_UNWRITTEN (u4-F1 replay)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let providerAgentId: string;
  let serviceId: string;
  let registerWarnings: string[];

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Campus Ops' });
    consumer = await registerUser(ctx.app, { displayName: 'Energy Analyst' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        visibility: 'public',
        meta: { id: 'meter-static-zero', name: 'M栋能耗 (static 0)', description: 'T54 fixture' },
        zones: [
          // u4's cross face: the zone parameter face carries the REAL power.
          { id: 'zone-a', baseline: { power: 500 } },
        ],
        devices: [
          {
            id: 'meter-1', name: 'M栋电表', type: 'sensor',
            capabilities: ['energy-monitoring'], zoneId: 'zone-a',
            // The trap: the scenario-initialized placeholder.
            initialState: { power: 0 },
          },
        ],
        agents: [{
          id: 'meter-bot', name: 'Meter Bot', capabilities: ['power-reading'],
          managesZoneIds: ['zone-a'], boundDeviceIds: ['meter-1'],
        }],
        events: [],
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    const detail = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
    })).json();
    providerAgentId = (detail.agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Meter Bot')!.id;
    const meterId = (detail.devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'M栋电表')!.id;

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'M栋能耗电表', semanticType: 'power-reading' },
    });
    expect(published.statusCode).toBe(201);
    serviceId = published.json().id as string;

    const registered = await ctx.app.inject({
      method: 'POST', url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'device-aggregate',
        refreshSec: 60,
        inputs: {
          zones: '*',
          devices: [meterId],
          metrics: [
            { source: 'device', capability: 'energy-monitoring', path: 'power', fn: 'avg', as: 'power' },
          ],
        },
        interface: { dataSchema: { fields: [{ name: 'power', type: 'number', unit: 'W' }] } },
      },
    });
    expect(registered.statusCode).toBe(201);
    registerWarnings = (registered.json().warnings as string[] | undefined) ?? [];

    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(consumer.token) });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function proposeAndAccept(fields: string[]): Promise<string> {
    const proposed = await ctx.app.inject({
      method: 'POST', url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { fields } } },
    });
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${id}/decide`,
      headers: auth(owner.token), payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);
    return id;
  }

  async function runningSim(token: string): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/simulations', headers: auth(token),
      payload: { environmentId: envId },
    });
    expect(created.statusCode).toBe(201);
    const simId = created.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(token), payload: {},
    });
    expect(started.statusCode).toBe(200);
    return simId;
  }

  it('registration warns about the two faces; the static-0 read refuses 409 with the zone contrast, failure-metered, receipt-less', async () => {
    // The world-aware registration advisory (non-blocking).
    expect(registerWarnings.some(w => w.includes('COMPUTATION_DEVICE_STATE_UNWRITTEN') && w.includes('"power"'))).toBe(true);

    const agreementId = await proposeAndAccept(['power']);
    await runningSim(consumer.token);
    const read = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/reads`,
      headers: auth(consumer.token), payload: {},
    });
    expect(read.statusCode).toBe(409);
    expect(read.json().error.code).toBe('COMPUTATION_DEVICE_STATE_UNWRITTEN');
    expect(read.json().error.fields).toEqual(['power']);
    const message: string = read.json().error.message;
    expect(message).toContain('NEVER written');
    expect(message).toContain('placeholder');
    // The cross-face contrast: the zone parameter face carries the reading.
    expect(message).toContain('`power` = 500 (zone "zone-a")');
    expect(message).toContain('source:"zone"');
    expect(message).toContain('NOT terminated');
    // Failure metered, NO receipt, agreement alive.
    const usage = (await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}/usage`, headers: auth(consumer.token),
    })).json().usage as Array<{ kind: string; outcome: string }>;
    expect(usage).toEqual([expect.objectContaining({ kind: 'read', outcome: 'failure' })]);
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}`, headers: auth(consumer.token),
    })).json().status).toBe('active');
  });

  it('the §7 cached fallback carries the same verdict — the cached frame refuses like the fresh one', async () => {
    const agreementId = await proposeAndAccept(['power']);
    await runningSim(consumer.token);
    // The first (fresh) read evaluates + caches the frame, then the gate
    // refuses — the cached row now carries the never-written verdict.
    expect((await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/reads`,
      headers: auth(consumer.token), payload: {},
    })).statusCode).toBe(409);
    // The cached lane (GET latest) serves the SAME verdict, never a fake 0.
    const latest = await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}/reads/latest`,
      headers: auth(consumer.token),
    });
    expect(latest.statusCode).toBe(409);
    expect(latest.json().error.code).toBe('COMPUTATION_DEVICE_STATE_UNWRITTEN');
  });

  it('the taught remedy recovers: re-register as a zone metric → the same world reads success at the zone face value', async () => {
    const agreementId = await proposeAndAccept(['power']);
    const simId = await runningSim(consumer.token);
    expect((await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/reads`,
      headers: auth(consumer.token), payload: {},
    })).statusCode).toBe(409);

    // Remedy A: point the metric at the zone parameter (the face this world
    // actually maintains).
    const reregistered = await ctx.app.inject({
      method: 'POST', url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        schemaVersion: 2,
        inputs: {
          zones: ['zone-a'],
          metrics: [{ source: 'zone', path: 'power', fn: 'avg', as: 'zonePower' }],
        },
        interface: { dataSchema: { fields: [{ name: 'zonePower', type: 'number', unit: 'W' }] } },
      },
    });
    expect(reregistered.statusCode).toBe(201);
    expect(reregistered.json().warnings).toBeUndefined(); // no two-faces trap on the zone lane

    const fresh = await proposeAndAccept(['zonePower']);
    // FEAT-02 (wave 3): a zone with ANY device power report reads `power`
    // as the device-ledger sum, not the static baseline — meter-1 reports
    // 0 W (never powered), so zone-a's face is 0 once one physics pass has
    // run. Step one tick explicitly: the wall-clock tick loop (10 ms) makes
    // the pre-ledger 500 vs post-ledger 0 outcome timing-dependent.
    expect((await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/step`,
      headers: auth(consumer.token), payload: { n: 1 },
    })).statusCode).toBe(200);
    const read = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${fresh}/reads`,
      headers: auth(consumer.token), payload: { simulationId: simId },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().frame.data.zonePower).toBe(0);
    expect(read.json().usage.outcome).toBe('success');
    expect(read.json().receiptId).not.toBeNull();

    // T64: this read-type service now shows the口径 note — trackRecord
    // 'none' (reads don't score reputation) beside a real usage row.
    const card = (await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}`, headers: auth(consumer.token),
    })).json();
    expect(card.trackRecord).toBe('none');
    expect(card.usageSummary.invocations).toBeGreaterThan(0);
    expect(card.trackRecordNote).toContain('INVOKE');
  });
});
