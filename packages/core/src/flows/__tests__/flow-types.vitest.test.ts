/**
 * @vitest-environment node
 *
 * Flow definition validation tests (no LLM backend, no runtime):
 *   - shape validation (FLOW_JSON_SCHEMA via ajv)
 *   - trigger-kind required fields + schedule semantics
 *   - condition mini-language parseability
 *   - embedded plan shape + semantics (duplicate ids, cycles, bad conditions)
 *   - assignment satisfiability against a scenario (UNSAT, ambiguity warning)
 */

import { describe, it, expect } from 'vitest';

import { loadScenarioFile, type ScenarioDefinition } from '../../scenario/index.js';
import {
  resolveFlowAssignments,
  validateFlow,
  type FlowDefinition,
} from '../index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validFlow(): FlowDefinition {
  return {
    id: 'flow-cool-down',
    name: 'Cool down zone A',
    enabled: true,
    trigger: { kind: 'event', eventType: 'temperature-spike', zoneId: 'zone-a' },
    plan: {
      goal: 'Bring zone A back to comfort',
      nodes: [
        { id: 'n1', capability: 'cooling' },
      ],
    },
  };
}

function scenario(): ScenarioDefinition {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'flow-test', name: 'Flow Test' },
    zones: [
      { id: 'zone-a', adjacentZoneIds: [] },
      { id: 'zone-b', adjacentZoneIds: [] },
    ],
    devices: [
      { id: 'hvac-a', type: 'hvac', capabilities: ['cooling', 'temperature-control'], zoneId: 'zone-a' },
    ],
    agents: [
      {
        id: 'hvac-agent', name: 'HVAC Agent',
        capabilities: ['facility-management'],
        managesZoneIds: ['zone-a'], boundDeviceIds: ['hvac-a'],
      },
      {
        id: 'watcher', name: 'Watcher',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-b'], boundDeviceIds: [],
      },
    ],
    events: [],
  });
}

const errorsOf = (flow: unknown, sc?: ScenarioDefinition) =>
  validateFlow(flow, sc).filter(i => i.level === 'error');

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

describe('validateFlow — shape', () => {
  it('accepts a valid flow', () => {
    expect(validateFlow(validFlow())).toEqual([]);
  });

  it('rejects missing required fields', () => {
    const issues = errorsOf({ id: 'x', name: 'X' });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some(i => i.message.includes('schema'))).toBe(true);
  });

  it('rejects an unknown trigger kind', () => {
    const flow = { ...validFlow(), trigger: { kind: 'webhook' } };
    expect(errorsOf(flow).length).toBeGreaterThan(0);
  });

  it('rejects additional properties (strict artifact)', () => {
    const flow = { ...validFlow(), bogus: true };
    expect(errorsOf(flow).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Trigger semantics
// ---------------------------------------------------------------------------

describe('validateFlow — triggers', () => {
  it('condition trigger requires zoneId + conditions', () => {
    const flow = { ...validFlow(), trigger: { kind: 'condition' } };
    expect(errorsOf(flow).length).toBeGreaterThan(0);
  });

  it('schedule trigger requires atSimTimeSec or everySimSec', () => {
    const flow = { ...validFlow(), trigger: { kind: 'schedule' } };
    const issues = errorsOf(flow);
    expect(issues.some(i => i.message.includes('atSimTimeSec'))).toBe(true);
  });

  it('accepts one-shot and periodic schedules', () => {
    const oneShot = { ...validFlow(), trigger: { kind: 'schedule', atSimTimeSec: 60 } };
    const periodic = { ...validFlow(), trigger: { kind: 'schedule', everySimSec: 300, endAtSimTimeSec: 3600 } };
    expect(errorsOf(oneShot)).toEqual([]);
    expect(errorsOf(periodic)).toEqual([]);
  });

  it('rejects end < start on schedules', () => {
    const flow = {
      ...validFlow(),
      trigger: { kind: 'schedule', everySimSec: 10, startAtSimTimeSec: 100, endAtSimTimeSec: 50 },
    };
    expect(errorsOf(flow).some(i => i.message.includes('endAtSimTimeSec'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FEAT-01: time-semantics fields (atTimeOfDaySec / activeWindowSimSec / relativeToOccupancy)
// ---------------------------------------------------------------------------

describe('validateFlow — FEAT-01 time semantics', () => {
  it('accepts a daily time-of-day schedule (23:30 就寝 = 84600)', () => {
    const flow = { ...validFlow(), trigger: { kind: 'schedule', atTimeOfDaySec: 84600 } };
    expect(errorsOf(flow)).toEqual([]);
  });

  it('rejects an out-of-range atTimeOfDaySec', () => {
    const flow = { ...validFlow(), trigger: { kind: 'schedule', atTimeOfDaySec: 86400 } };
    expect(errorsOf(flow).length).toBeGreaterThan(0);
    const negative = { ...validFlow(), trigger: { kind: 'schedule', atTimeOfDaySec: -5 } };
    expect(errorsOf(negative).length).toBeGreaterThan(0);
  });

  it('accepts a condition active window incl. the crossing-midnight form', () => {
    const base = {
      ...validFlow(),
      trigger: {
        kind: 'condition', zoneId: 'zone-a',
        conditions: [{ path: 'power', op: '>', value: 800 }],
      },
    };
    expect(errorsOf({ ...base, trigger: { ...base.trigger, activeWindowSimSec: [25200, 84600] } })).toEqual([]);
    expect(errorsOf({ ...base, trigger: { ...base.trigger, activeWindowSimSec: [79200, 21600] } })).toEqual([]);
  });

  it('rejects an empty (start === end) active window with a teaching error', () => {
    const flow = {
      ...validFlow(),
      trigger: {
        kind: 'condition', zoneId: 'zone-a',
        conditions: [{ path: 'power', op: '>', value: 800 }],
        activeWindowSimSec: [12000, 12000],
      },
    };
    expect(errorsOf(flow).some(i => i.message.includes('activeWindowSimSec'))).toBe(true);
  });

  it('rejects malformed activeWindowSimSec shapes (schema)', () => {
    const base = {
      ...validFlow(),
      trigger: {
        kind: 'condition', zoneId: 'zone-a',
        conditions: [{ path: 'power', op: '>', value: 800 }],
      },
    };
    expect(errorsOf({ ...base, trigger: { ...base.trigger, activeWindowSimSec: [100] } }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...base, trigger: { ...base.trigger, activeWindowSimSec: [100, 200, 300] } }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...base, trigger: { ...base.trigger, activeWindowSimSec: [100, 90000] } }).length).toBeGreaterThan(0);
  });

  it('accepts an occupancy-relative schedule (到馆前 30 分钟预冷)', () => {
    const flow = {
      ...validFlow(),
      trigger: {
        kind: 'schedule',
        relativeToOccupancy: { zoneId: 'zone-a', before: 'arrive', offsetSec: 1800 },
      },
    };
    const sc = loadScenarioFile({
      version: '1.0',
      meta: { id: 'occ-sc', name: 'Occ' },
      zones: [{ id: 'zone-a', adjacentZoneIds: [], occupantSchedule: { count: 10, startSimTimeSec: 28800, endSimTimeSec: 64800 } }],
      devices: [
        { id: 'hvac-a', type: 'hvac', capabilities: ['cooling', 'temperature-control'], zoneId: 'zone-a' },
      ],
      agents: [
        {
          id: 'hvac-agent', name: 'HVAC Agent',
          capabilities: ['facility-management'],
          managesZoneIds: ['zone-a'], boundDeviceIds: ['hvac-a'],
        },
      ],
      events: [],
    });
    expect(errorsOf(flow, sc)).toEqual([]);
  });

  it('rejects relativeToOccupancy pinned to a zone without occupantSchedule', () => {
    const flow = {
      ...validFlow(),
      trigger: {
        kind: 'schedule',
        relativeToOccupancy: { zoneId: 'zone-a', before: 'arrive', offsetSec: 1800 },
      },
    };
    // The stock scenario() fixture has no occupantSchedule on zone-a.
    expect(errorsOf(flow, scenario()).some(i => i.message.includes('occupantSchedule'))).toBe(true);
  });

  it('rejects relativeToOccupancy pinned to a ghost zone', () => {
    const flow = {
      ...validFlow(),
      trigger: {
        kind: 'schedule',
        relativeToOccupancy: { zoneId: 'zone-zzz', before: 'depart', offsetSec: 60 },
      },
    };
    expect(errorsOf(flow, scenario()).some(i => i.message.includes("zone-zzz"))).toBe(true);
  });

  it('warns (never 422s) when no zone carries an occupantSchedule and none is pinned', () => {
    const flow = {
      ...validFlow(),
      trigger: {
        kind: 'schedule',
        relativeToOccupancy: { before: 'arrive', offsetSec: 1800 },
      },
    };
    const issues = validateFlow(flow, scenario());
    expect(issues.some(i => i.level === 'error')).toBe(false);
    expect(issues.some(i => i.level === 'warning' && i.message.includes('occupantSchedule'))).toBe(true);
  });

  it('rejects unknown keys inside relativeToOccupancy (strict sub-object)', () => {
    const flow = {
      ...validFlow(),
      trigger: {
        kind: 'schedule',
        relativeToOccupancy: { before: 'arrive', offsetSec: 1800, offest: 17 },
      },
    };
    expect(errorsOf(flow).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

describe('validateFlow — conditions', () => {
  it('rejects a bad condition path', () => {
    const flow = {
      ...validFlow(),
      trigger: {
        kind: 'event',
        conditions: [{ path: '9bad path!', op: '>', value: 30 }],
      },
    };
    expect(errorsOf(flow).length).toBeGreaterThan(0);
  });

  it('rejects an unknown operator', () => {
    const flow = {
      ...validFlow(),
      trigger: { kind: 'event', conditions: [{ path: 'temperature', op: '≈', value: 30 }] },
    };
    expect(errorsOf(flow).length).toBeGreaterThan(0);
  });

  it('accepts dotted zone paths and every value type', () => {
    const flow = {
      ...validFlow(),
      trigger: {
        kind: 'event',
        conditions: [
          { path: 'zone-a.temperature', op: '>', value: 30 },
          { path: 'zone-a.motion', op: '==', value: true },
          { path: 'zone-a.mode', op: '!=', value: 'off' },
        ],
      },
    };
    expect(errorsOf(flow)).toEqual([]);
  });
});

describe('validateFlow — T-606 condition-path lint (runtime-injected parameters)', () => {
  function scenarioWithBaseline(): ScenarioDefinition {
    return loadScenarioFile({
      version: '1.0',
      meta: { id: 'flow-lint-test', name: 'Flow Lint Test' },
      zones: [
        { id: 'zone-a', adjacentZoneIds: [], baseline: { temperature: 22, pvOutputW: 8000 } },
      ],
      devices: [
        { id: 'hvac-a', type: 'hvac', capabilities: ['cooling', 'temperature-control'], zoneId: 'zone-a' },
      ],
      agents: [
        {
          id: 'hvac-agent', name: 'HVAC Agent',
          // T1 (R2): declares what its device provides — the capability-drift
          // warning would otherwise fire here and pollute this T-606 lint
          // fixture (the agent's device carries 'cooling').
          capabilities: ['facility-management', 'cooling'],
          managesZoneIds: ['zone-a'], boundDeviceIds: ['hvac-a'],
        },
      ],
      events: [],
    });
  }

  it('warns — never errors — for a path neither standard nor baseline-declared', () => {
    const flow = {
      ...validFlow(),
      trigger: {
        kind: 'condition',
        zoneId: 'zone-a',
        conditions: [{ path: 'badge-anomaly-count', op: '>', value: 2 }],
      },
    };
    const issues = validateFlow(flow, scenarioWithBaseline());
    expect(issues.filter(i => i.level === 'error')).toEqual([]);
    const warning = issues.find(
      i => i.level === 'warning' && /'badge-anomaly-count'/.test(i.message),
    );
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('injects it at runtime');
    expect(warning!.message).toContain('zone baseline');
  });

  it('stays quiet for standard parameters, occupancy, and baseline-declared keys (dotted or bare)', () => {
    const flow = {
      ...validFlow(),
      trigger: {
        kind: 'condition',
        zoneId: 'zone-a',
        conditions: [
          { path: 'temperature', op: '>', value: 30 },
          { path: 'occupancy', op: '>', value: 10 },
          { path: 'zone-a.pvOutputW', op: '>', value: 6000 },
        ],
      },
    };
    const warnings = validateFlow(flow, scenarioWithBaseline())
      .filter(i => i.level === 'warning');
    expect(warnings).toEqual([]);
  });

  it('skips the lint entirely without a scenario (no baseline truth to compare against)', () => {
    const flow = {
      ...validFlow(),
      trigger: {
        kind: 'condition',
        zoneId: 'zone-a',
        conditions: [{ path: 'badge-anomaly-count', op: '>', value: 2 }],
      },
    };
    expect(validateFlow(flow).filter(i => i.level === 'warning')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Embedded plan
// ---------------------------------------------------------------------------

describe('validateFlow — plan', () => {
  it('flags duplicate node ids', () => {
    const flow = validFlow();
    flow.plan.nodes.push({ id: 'n1', capability: 'cooling' });
    expect(errorsOf(flow).some(i => i.message.includes('duplicate node id'))).toBe(true);
  });

  it('flags dependency cycles', () => {
    const flow = validFlow();
    flow.plan.nodes = [
      { id: 'a', capability: 'cooling', dependsOn: ['b'] },
      { id: 'b', capability: 'cooling', dependsOn: ['a'] },
    ];
    expect(errorsOf(flow).some(i => i.message.includes('cycle'))).toBe(true);
  });

  it('flags unparseable node conditions', () => {
    const flow = validFlow();
    flow.plan.nodes[0].condition = 'temperature >> 30';
    expect(errorsOf(flow).some(i => i.message.includes('not parseable'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Assignment satisfiability (scenario-aware)
// ---------------------------------------------------------------------------

describe('validateFlow — assignments with scenario', () => {
  it('auto-matches an agent whose bound device provides the capability', () => {
    expect(errorsOf(validFlow(), scenario())).toEqual([]);
  });

  it('errors when no agent can deliver the capability (UNSAT)', () => {
    const flow = validFlow();
    flow.plan.nodes = [{ id: 'n1', capability: 'teleportation' }];
    const issues = errorsOf(flow, scenario());
    expect(issues.some(i => i.nodeId === 'n1' && i.message.includes('UNSAT'))).toBe(true);
  });

  it('errors on an unknown explicit assignee', () => {
    const flow = validFlow();
    flow.plan.nodes = [{ id: 'n1', capability: 'cooling', assigneeAgentId: 'ghost' }];
    expect(errorsOf(flow, scenario()).some(i => i.message.includes("'ghost'"))).toBe(true);
  });

  it('errors when the explicit assignee cannot deliver', () => {
    const flow = validFlow();
    flow.plan.nodes = [{ id: 'n1', capability: 'cooling', assigneeAgentId: 'watcher' }];
    expect(errorsOf(flow, scenario()).some(i => i.message.includes('cannot deliver'))).toBe(true);
  });

  it('warns (not errors) on ambiguous auto-assignment', () => {
    const sc = scenario();
    sc.agents.push({
      id: 'hvac-agent-2', name: 'Second HVAC Agent',
      capabilities: [], managesZoneIds: ['zone-a'], boundDeviceIds: ['hvac-a'],
    });
    const issues = validateFlow(validFlow(), sc);
    expect(issues.some(i => i.level === 'warning' && i.message.includes('ambiguous'))).toBe(true);
    expect(issues.filter(i => i.level === 'error')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Device-level executability (T-002 — the isExecutableCapability oracle)
// ---------------------------------------------------------------------------

/**
 * Stand-in for simulation's isCapabilityExecutable (core cannot depend on
 * the simulation package): mirrors the default CommandHandlerRegistry's
 * vocabulary plus the read/query heuristic from the capability contract.
 */
function registryOracle(name: string): boolean {
  const n = name.toLowerCase().replace(/[-_]/g, '');
  if (/^(get|read|query|check|measure|sense)/.test(n)) return true;
  if (/(reading|sensing|monitoring|detection)/.test(name.toLowerCase())) return true;
  return [
    'turnon', 'turnoff', 'setpower', 'toggle', 'poweron', 'poweroff',
    'settemperature', 'settargettemperature', 'adjusttemperature', 'settemp',
    'temperaturecontrol', 'cooling', 'heating', 'setmode',
    'setsignal', 'setmessage', 'triggeralert', 'getstatus',
    'open', 'close', 'stop', 'lock', 'unlock', 'activate', 'deactivate', 'playalert',
  ].includes(n) || n.startsWith('set');
}

/** T-002 fixture: a switch that only DECLARES 'switch' + a working lamp. */
function executabilityScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'exec-test', name: 'Executability Test' },
    zones: [{ id: 'zone-a', adjacentZoneIds: [] }],
    devices: [
      // The trap: agent + device both declare 'switch', but no command
      // handler is registered for it — runtime fails with
      // "no handler / no effect for command switch".
      { id: 'sw-a', type: 'light-switch', capabilities: ['switch'], zoneId: 'zone-a' },
      { id: 'lamp-a', type: 'light', capabilities: ['lighting-control', 'turn-on', 'turn-off', 'set-brightness'], zoneId: 'zone-a' },
    ],
    agents: [
      {
        id: 'switch-agent', name: 'Switch Agent',
        capabilities: ['switch'],
        managesZoneIds: ['zone-a'], boundDeviceIds: ['sw-a'],
      },
      {
        id: 'lamp-agent', name: 'Lamp Agent',
        capabilities: ['lighting-control'],
        managesZoneIds: ['zone-a'], boundDeviceIds: ['lamp-a'],
      },
    ],
    events: [],
  });
}

describe('validateFlow — device-level executability (T-002)', () => {
  it('rejects a declared-but-unexecutable capability on an explicit assignee, naming alternatives', () => {
    const flow = validFlow();
    flow.plan.nodes = [{ id: 'n1', capability: 'switch', assigneeAgentId: 'switch-agent' }];
    const issues = validateFlow(flow, executabilityScenario(), {
      isExecutableCapability: registryOracle,
    }).filter(i => i.level === 'error');
    expect(issues).toHaveLength(1);
    expect(issues[0].nodeId).toBe('n1');
    // Diagnoses the real gap (declared, not executable) and teaches the fix.
    expect(issues[0].message).toContain("'switch' is declared by agent 'switch-agent'");
    expect(issues[0].message).toContain('no bound device provides an executable command for it');
    expect(issues[0].message).toContain('turn-on'); // executable alternatives listed
  });

  it('rejects a declared-but-unexecutable capability on auto-assignment', () => {
    const flow = validFlow();
    flow.plan.nodes = [{ id: 'n1', capability: 'switch' }];
    const issues = validateFlow(flow, executabilityScenario(), {
      isExecutableCapability: registryOracle,
    }).filter(i => i.level === 'error');
    expect(issues.some(i =>
      i.nodeId === 'n1' && i.message.includes('a bound device declares it') &&
      i.message.includes('no registered command handler executes it') &&
      i.message.includes('turn-on'),
    )).toBe(true);
  });

  it('still accepts capabilities that dispatch directly (cooling, turn-on)', () => {
    const sc = executabilityScenario();
    const cooling = validFlow(); // 'cooling' auto-matched → needs an hvac; use lamp caps instead
    const direct = {
      ...cooling,
      plan: {
        goal: 'light the room',
        nodes: [{ id: 'n1', capability: 'turn-on', assigneeAgentId: 'lamp-agent' }],
      },
    };
    expect(validateFlow(direct, sc, { isExecutableCapability: registryOracle })
      .filter(i => i.level === 'error')).toEqual([]);
  });

  it('accepts a semantic capability the device expands at runtime (lighting-control on a light)', () => {
    // 'lighting-control' has no direct handler, but DeviceResource expands it
    // into turn-on + set-brightness for light devices — the wizard offers
    // raw device capabilities, so this MUST NOT be a false rejection.
    const flow = validFlow();
    flow.plan.nodes = [{ id: 'n1', capability: 'lighting-control', assigneeAgentId: 'lamp-agent' }];
    expect(validateFlow(flow, executabilityScenario(), {
      isExecutableCapability: registryOracle,
    }).filter(i => i.level === 'error')).toEqual([]);
  });

  it('accepts a bare capability that falls back to a matching declared executable (temperature → temperature-reading)', () => {
    const sc = executabilityScenario();
    sc.devices.push({ id: 'sensor-a', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: 'zone-a' });
    sc.agents.push({
      id: 'sensor-agent', name: 'Sensor Agent', capabilities: [],
      managesZoneIds: [], boundDeviceIds: ['sensor-a'],
    });
    const flow = validFlow();
    flow.plan.nodes = [{ id: 'n1', capability: 'temperature', assigneeAgentId: 'sensor-agent' }];
    expect(validateFlow(flow, sc, { isExecutableCapability: registryOracle })
      .filter(i => i.level === 'error')).toEqual([]);
  });

  it('keeps legacy behavior without the oracle: declared = executable', () => {
    const flow = validFlow();
    flow.plan.nodes = [{ id: 'n1', capability: 'switch', assigneeAgentId: 'switch-agent' }];
    expect(validateFlow(flow, executabilityScenario()).filter(i => i.level === 'error')).toEqual([]);
  });

  it('exempts hass-bound devices — the simulation registry cannot speak for real hardware', () => {
    const sc = executabilityScenario();
    const sw = sc.devices.find(d => d.id === 'sw-a')!;
    sw.binding = 'hass://light.corridor_switch';
    const flow = validFlow();
    flow.plan.nodes = [{ id: 'n1', capability: 'switch', assigneeAgentId: 'switch-agent' }];
    expect(validateFlow(flow, sc, { isExecutableCapability: registryOracle })
      .filter(i => i.level === 'error')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T-201 — author scoping + device pinning + device ambiguity
// ---------------------------------------------------------------------------

/**
 * Two tenants' agents bound in one zone (HF-F01 topology): the health
 * partner's agent (hvac + PA) and the security partner's agent (lock), both
 * zone-local in clinic.
 */
function tenantScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'tenant-test', name: 'Tenant Test' },
    zones: [
      { id: 'clinic', adjacentZoneIds: [] },
      { id: 'lobby', adjacentZoneIds: [] },
    ],
    devices: [
      { id: 'pa-1', name: 'Clinic PA Column', type: 'speaker', capabilities: ['broadcast', 'turn-on', 'set-volume'], zoneId: 'clinic' },
      { id: 'lock-1', name: 'Clinic Door Lock', type: 'lock', capabilities: ['lock-control', 'unlock', 'lock'], zoneId: 'clinic' },
      { id: 'siren-1', name: 'Lobby Siren', type: 'siren', capabilities: ['emergency-broadcast', 'turn-on', 'turn-off'], zoneId: 'lobby' },
    ],
    agents: [
      {
        id: 'health-agent', name: 'Health Agent', ownerUserId: 'user-health',
        capabilities: [], managesZoneIds: ['clinic'], boundDeviceIds: ['pa-1'],
      },
      {
        id: 'security-agent', name: 'SEC Guardian Agent', ownerUserId: 'user-sec',
        capabilities: [], managesZoneIds: ['clinic', 'lobby'], boundDeviceIds: ['lock-1', 'siren-1'],
      },
    ],
    events: [],
  });
}

describe('validateFlow — T-201 author scoping', () => {
  const healthFlow = (): FlowDefinition => ({
    ...validFlow(),
    authorUserId: 'user-health',
    trigger: { kind: 'event', eventType: 'emergency', zoneId: 'clinic' },
    plan: { goal: 'announce', nodes: [{ id: 'n1', capability: 'turn-on' }] },
  });

  it("auto-matches only the author's agent even when a foreign agent is zone-local", () => {
    const { assignments, issues } = resolveFlowAssignments(healthFlow(), tenantScenario());
    expect(assignments.get('n1')).toBe('health-agent');
    expect(issues.filter(i => i.level === 'error')).toEqual([]);
  });

  it('rejects an explicit cross-tenant assignee with the governance message', () => {
    const flow = healthFlow();
    flow.plan.nodes = [{ id: 'n1', capability: 'unlock', assigneeAgentId: 'security-agent' }];
    const issues = validateFlow(flow, tenantScenario()).filter(i => i.level === 'error');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("assignee 'security-agent' is owned by another tenant");
    expect(issues[0].message).toContain('agreement invocation (provider-executed, metered)');
  });

  it('auto-match with only foreign providers teaches the agreement path', () => {
    const flow = healthFlow();
    flow.plan.nodes = [{ id: 'n1', capability: 'unlock' }];
    const issues = validateFlow(flow, tenantScenario()).filter(i => i.level === 'error');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('no agent owned by the flow author');
    expect(issues[0].message).toContain("'security-agent'");
  });

  it('agents without owner attribution stay eligible (file-world compatibility)', () => {
    const sc = tenantScenario();
    sc.agents.push({
      id: 'legacy-agent', name: 'Legacy', capabilities: [],
      managesZoneIds: [], boundDeviceIds: ['pa-1'],
    });
    const flow = healthFlow();
    flow.plan.nodes = [{ id: 'n1', capability: 'turn-on' }];
    // Both health-agent and the unattributed legacy agent qualify; the
    // shared device pa-1 is the single qualifying device → deterministic.
    const issues = validateFlow(flow, sc).filter(i => i.level === 'error');
    expect(issues).toEqual([]);
  });

  it('flows without authorUserId keep unrestricted semantics (env owner)', () => {
    const flow = healthFlow();
    delete flow.authorUserId;
    flow.plan.nodes = [{ id: 'n1', capability: 'unlock', assigneeAgentId: 'security-agent' }];
    expect(validateFlow(flow, tenantScenario()).filter(i => i.level === 'error')).toEqual([]);
  });
});

describe('validateFlow — T-201 device pinning + ambiguity', () => {
  it('errors on an ambiguous capability, naming the candidate devices', () => {
    // security-agent owns siren-1 (lobby) AND — in this variant — a lobby
    // PA providing the same capability: two devices, no pin → error.
    const sc = tenantScenario();
    sc.devices.push({ id: 'pa-2', name: 'Lobby PA Column', type: 'speaker', capabilities: ['turn-on', 'turn-off', 'set-volume'], zoneId: 'lobby' });
    const secAgent = sc.agents.find(a => a.id === 'security-agent')!;
    secAgent.boundDeviceIds = [...secAgent.boundDeviceIds, 'pa-2'];
    const flow: FlowDefinition = {
      ...validFlow(),
      authorUserId: 'user-sec',
      trigger: { kind: 'event', eventType: 'intrusion', zoneId: 'lobby' },
      plan: { goal: 'shut down lobby outputs', nodes: [{ id: 'n1', capability: 'turn-off' }] },
    };
    const issues = validateFlow(flow, sc).filter(i => i.level === 'error');
    expect(issues).toHaveLength(1);
    expect(issues[0].nodeId).toBe('n1');
    expect(issues[0].message).toContain("capability 'turn-off' is ambiguous");
    expect(issues[0].message).toContain('2 devices provide it');
    expect(issues[0].message).toContain('Lobby Siren');
    expect(issues[0].message).toContain('Lobby PA Column');
    expect(issues[0].message).toContain('pin one with node.deviceId');
  });

  it('a pinned deviceId resolves the ambiguity deterministically', () => {
    const sc = tenantScenario();
    sc.devices.push({ id: 'pa-2', name: 'Lobby PA Column', type: 'speaker', capabilities: ['turn-on', 'turn-off', 'set-volume'], zoneId: 'lobby' });
    const secAgent = sc.agents.find(a => a.id === 'security-agent')!;
    secAgent.boundDeviceIds = [...secAgent.boundDeviceIds, 'pa-2'];
    const flow: FlowDefinition = {
      ...validFlow(),
      authorUserId: 'user-sec',
      trigger: { kind: 'event', eventType: 'intrusion', zoneId: 'lobby' },
      plan: { goal: 'silence the PA only', nodes: [{ id: 'n1', capability: 'turn-off', deviceId: 'pa-2' }] },
    };
    const { assignments, issues } = resolveFlowAssignments(flow, sc);
    expect(assignments.get('n1')).toBe('security-agent');
    expect(issues.filter(i => i.level === 'error')).toEqual([]);
  });

  it('rejects an unknown pinned device', () => {
    const flow = healthFlowBody();
    flow.plan.nodes = [{ id: 'n1', capability: 'turn-on', deviceId: 'ghost-device' }];
    const issues = validateFlow(flow, tenantScenario()).filter(i => i.level === 'error');
    expect(issues.some(i =>
      i.message.includes("deviceId 'ghost-device' does not exist in this simulation's world snapshot"),
    )).toBe(true);
  });

  it('rejects a pin on a device bound to another agent, naming the holder', () => {
    const flow = healthFlowBody();
    flow.plan.nodes = [{ id: 'n1', capability: 'unlock', assigneeAgentId: 'security-agent', deviceId: 'lock-1' }];
    const issues = validateFlow(flow, tenantScenario()).filter(i => i.level === 'error');
    // The cross-tenant guard fires first (assignee before device).
    expect(issues.some(i => i.message.includes('owned by another tenant'))).toBe(true);

    // Env-owner variant: no author stamp, so the binding check is reached.
    const ownerFlow = healthFlowBody();
    delete ownerFlow.authorUserId;
    ownerFlow.plan.nodes = [{ id: 'n1', capability: 'turn-on', assigneeAgentId: 'health-agent', deviceId: 'lock-1' }];
    const binding = validateFlow(ownerFlow, tenantScenario()).filter(i => i.level === 'error');
    expect(binding.some(i =>
      i.message.includes("deviceId 'lock-1'") &&
      i.message.includes("not bound to assignee 'health-agent'"),
    )).toBe(true);
  });

  it('rejects a pin on a device that does not provide the capability', () => {
    const flow = healthFlowBody();
    flow.plan.nodes = [{ id: 'n1', capability: 'set-volume', assigneeAgentId: 'health-agent', deviceId: 'pa-1' }];
    // pa-1 DOES provide set-volume — swap to a capability it lacks.
    flow.plan.nodes[0].capability = 'cooling';
    const issues = validateFlow(flow, tenantScenario()).filter(i => i.level === 'error');
    expect(issues.some(i =>
      i.message.includes('does not provide capability') && i.message.includes('Clinic PA Column'),
    )).toBe(true);
  });

  it('T-312: pinned declared-but-unexecutable capability names the handler gap, not a self-contradiction', () => {
    // EO-F04's probe: "device '床头呼叫器' does not provide capability
    // 'emergency-call' (it provides: emergency-call)" — the device DECLARES
    // it; the gap is the handler registry. With an oracle that rejects the
    // capability, the message must say exactly that and teach alternatives.
    const flow = healthFlowBody();
    flow.plan.nodes = [{ id: 'n1', capability: 'set-volume', assigneeAgentId: 'health-agent', deviceId: 'pa-1' }];
    const issues = validateFlow(flow, tenantScenario(), {
      isExecutableCapability: name => name !== 'set-volume',
    }).filter(i => i.level === 'error');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some(i =>
      i.message.includes("capability 'set-volume' is declared by pinned device") &&
      i.message.includes('Clinic PA Column') &&
      i.message.includes('no registered command handler executes it') &&
      i.message.includes('valid executable capabilities include'),
    )).toBe(true);
    // Never the contradictory wording for a declared capability.
    expect(issues.some(i => i.message.includes('does not provide capability'))).toBe(false);

    // The undeclared variant keeps the classic "does not provide" wording.
    const undeclared = healthFlowBody();
    undeclared.plan.nodes = [{ id: 'n1', capability: 'cooling', assigneeAgentId: 'health-agent', deviceId: 'pa-1' }];
    const undeclaredIssues = validateFlow(undeclared, tenantScenario(), {
      isExecutableCapability: () => true,
    }).filter(i => i.level === 'error');
    expect(undeclaredIssues.some(i => i.message.includes('does not provide capability'))).toBe(true);
  });

  it('rejects a pin outside the trigger zone (zoned flow)', () => {
    const flow: FlowDefinition = {
      ...validFlow(),
      authorUserId: 'user-sec',
      trigger: { kind: 'event', eventType: 'intrusion', zoneId: 'clinic' },
      plan: { goal: 'siren?', nodes: [{ id: 'n1', capability: 'turn-on', deviceId: 'siren-1' }] },
    };
    const issues = validateFlow(flow, tenantScenario()).filter(i => i.level === 'error');
    expect(issues.some(i =>
      i.message.includes("sits in zone 'lobby' but the trigger zone is 'clinic'"),
    )).toBe(true);
  });

  it('accepts authorUserId on the shape schema (server-stamped flows round-trip)', () => {
    const flow = healthFlowBody();
    expect(validateFlow(flow).filter(i => i.level === 'error')).toEqual([]);
  });

  /** validFlow body with the tenant fixture's health-authored defaults. */
  function healthFlowBody(): FlowDefinition {
    return {
      ...validFlow(),
      authorUserId: 'user-health',
      trigger: { kind: 'event', eventType: 'emergency', zoneId: 'clinic' },
    };
  }
});


// ---------------------------------------------------------------------------
// R13 (CB-F01) — authoring-time param-shape check (acceptedParameterNames)
// ---------------------------------------------------------------------------

/**
 * Stand-in for simulation's acceptedParameterNames (same injection pattern
 * as registryOracle): the accepted param spellings for known commands only.
 */
function acceptedParamsOracle(commandName: string): readonly string[] | undefined {
  const table: Record<string, readonly string[]> = {
    'set-fan-speed': ['speed', 'fanSpeed'],
    'set-temperature': ['targetTemperature', 'temperature', 'target', 'value'],
  };
  return table[commandName.toLowerCase()];
}

function purifierScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'purifier-test', name: 'Purifier Test' },
    zones: [{ id: 'clinic-ward', adjacentZoneIds: [] }],
    devices: [
      {
        id: 'purifier-1', name: 'Ward Purifier', type: 'air-purifier',
        capabilities: ['air-purification', 'set-fan-speed', 'turn-on'], zoneId: 'clinic-ward',
      },
    ],
    agents: [
      {
        id: 'clinic-agent', name: 'ClinicDuty Agent',
        capabilities: [], managesZoneIds: ['clinic-ward'], boundDeviceIds: ['purifier-1'],
      },
    ],
    events: [],
  });
}

describe('validateFlow — R13 param-shape check (all-unrecognized params = dead node)', () => {
  const purgeFlow = (params: Record<string, unknown>) => {
    const flow = validFlow();
    flow.trigger = { kind: 'event', eventType: 'patient-call', zoneId: 'clinic-ward' };
    flow.plan = {
      goal: 'purge ward air',
      nodes: [{
        id: 'purge', capability: 'set-fan-speed',
        assigneeAgentId: 'clinic-agent', deviceId: 'purifier-1', params,
      }],
    };
    return flow;
  };

  it('rejects an unrecognized spelling ({fan_speed}) with a rename hint', () => {
    const issues = validateFlow(purgeFlow({ fan_speed: 3 }), purifierScenario(), {
      isExecutableCapability: registryOracle,
      acceptedParameterNames: acceptedParamsOracle,
    }).filter(i => i.level === 'error');
    expect(issues).toHaveLength(1);
    expect(issues[0].nodeId).toBe('purge');
    expect(issues[0].message).toContain("command 'set-fan-speed' accepts params (speed, fanSpeed)");
    expect(issues[0].message).toContain('fan_speed → speed');
    expect(issues[0].message).toContain('would execute with no effect');
  });

  it('accepts the canonical {speed} AND the state-property alias {fanSpeed} (runtime honors both)', () => {
    // The round-13 clinic flow's exact payload ({fanSpeed: 3}) now works
    // end-to-end: the handler accepts the alias and the hints table lists
    // it, so validation must NOT flag it.
    for (const params of [{ speed: 60 }, { fanSpeed: 3 }]) {
      const issues = validateFlow(purgeFlow(params), purifierScenario(), {
        isExecutableCapability: registryOracle,
        acceptedParameterNames: acceptedParamsOracle,
      }).filter(i => i.level === 'error');
      expect(issues).toEqual([]);
    }
  });

  it('never flags empty params (values may be injected at run time) or unknown commands', () => {
    const sc = purifierScenario();
    const empty = validateFlow(purgeFlow({}), sc, {
      isExecutableCapability: registryOracle,
      acceptedParameterNames: acceptedParamsOracle,
    }).filter(i => i.level === 'error');
    expect(empty).toEqual([]);

    // turn-on has NO accepted-spelling entry — an arbitrary params key must
    // not be a false rejection (hints are not the executability contract).
    const flow = validFlow();
    flow.trigger = { kind: 'event', eventType: 'patient-call', zoneId: 'clinic-ward' };
    flow.plan = {
      goal: 'announce',
      nodes: [{
        id: 'n1', capability: 'turn-on',
        assigneeAgentId: 'clinic-agent', deviceId: 'purifier-1', params: { anything: 1 },
      }],
    };
    const unknown = validateFlow(flow, sc, {
      isExecutableCapability: registryOracle,
      acceptedParameterNames: acceptedParamsOracle,
    }).filter(i => i.level === 'error');
    expect(unknown).toEqual([]);
  });

  it('matches param keys case-insensitively and stays silent without the oracle', () => {
    const sc = purifierScenario();
    const caseMatch = validateFlow(purgeFlow({ SPEED: 60 }), sc, {
      isExecutableCapability: registryOracle,
      acceptedParameterNames: acceptedParamsOracle,
    }).filter(i => i.level === 'error');
    expect(caseMatch).toEqual([]);

    // Without the injected oracle (core-only consumers) the check is off.
    const noOracle = validateFlow(purgeFlow({ fan_speed: 3 }), sc, {
      isExecutableCapability: registryOracle,
    }).filter(i => i.level === 'error');
    expect(noOracle).toEqual([]);
  });
});
