/**
 * @vitest-environment node
 *
 * Scenario schema + loader tests (no LLM, no network).
 *
 * Covers: valid files load with defaults applied; structural violations
 * (missing version, bad device) and semantic violations (unknown zone
 * references, duplicate ids, unsupported bindings) produce descriptive
 * errors; the shipped demo scenario (config/scenarios/cross-brand-home.json)
 * loads cleanly.
 */

import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

import {
  ScenarioFlowValidationError,
  ScenarioValidationError,
  loadScenarioFile,
  loadScenarioFromFile,
  inferDeviceRole,
} from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function minimalValidScenario(): Record<string, unknown> {
  return {
    version: '1.0',
    meta: { id: 'test-scenario', name: 'Test Scenario' },
    zones: [{ id: 'room-1' }],
    devices: [],
    agents: [],
  };
}

function fullValidScenario(): Record<string, unknown> {
  return {
    version: '1.0',
    meta: { id: 'home', name: 'Smart Home', description: 'Two-room home' },
    zones: [
      {
        id: 'living-room',
        name: 'Living Room',
        type: 'living-room',
        bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 },
        adjacentZoneIds: ['kitchen'],
      },
      { id: 'kitchen', type: 'kitchen', adjacentZoneIds: ['living-room'] },
    ],
    devices: [
      {
        id: 'temp-1',
        name: 'Temperature Sensor',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'living-room',
      },
      {
        id: 'hvac-1',
        type: 'hvac',
        role: 'actuator',
        capabilities: ['temperature-control', 'cooling'],
        zoneId: 'living-room',
        binding: 'sim://hvac-1',
        initialState: { power: false },
      },
    ],
    agents: [
      {
        id: 'climate-agent',
        name: 'Climate Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['living-room'],
        boundDeviceIds: ['temp-1'],
        llm: { provider: 'openai-compatible', model: 'qwen3:8b', params: { num_ctx: 8192 } },
      },
      {
        id: 'advisor-agent',
        name: 'Advisor Agent',
        capabilities: ['advice'],
      },
    ],
    events: [
      {
        id: 'evt-heat',
        type: 'temperature-spike',
        zoneId: 'living-room',
        parameter: 'temperature',
        value: 33,
        atSimTimeSec: 10,
      },
    ],
  };
}

function expectValidationError(fn: () => unknown, match: RegExp): void {
  try {
    fn();
    expect.unreachable('expected loadScenarioFile to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(ScenarioValidationError);
    const issues = (error as ScenarioValidationError).issues;
    expect(
      issues.some(issue => match.test(issue)),
      `expected an issue matching ${match}, got:\n${issues.join('\n')}`,
    ).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Valid scenarios
// ---------------------------------------------------------------------------

describe('loadScenarioFile — valid scenarios', () => {
  it('loads a minimal scenario and applies defaults', () => {
    const scenario = loadScenarioFile(minimalValidScenario());

    expect(scenario.version).toBe('1.0');
    expect(scenario.meta.id).toBe('test-scenario');
    expect(scenario.meta.description).toBe('');
    expect(scenario.zones).toHaveLength(1);
    expect(scenario.zones[0].adjacentZoneIds).toEqual([]);
    expect(scenario.devices).toEqual([]);
    expect(scenario.agents).toEqual([]);
    expect(scenario.events).toEqual([]);
  });

  it('loads a full scenario preserving explicit values', () => {
    const scenario = loadScenarioFile(fullValidScenario());

    expect(scenario.meta.description).toBe('Two-room home');
    expect(scenario.zones[0].bounds).toEqual({ minX: 0, maxX: 6, minY: 0, maxY: 5 });
    expect(scenario.zones[0].adjacentZoneIds).toEqual(['kitchen']);

    const [sensor, hvac] = scenario.devices;
    expect(sensor.role).toBe('sensor'); // inferred from temperature-reading
    expect(sensor.binding).toBe('sim://temp-1'); // default binding
    expect(hvac.role).toBe('actuator'); // explicit role wins
    expect(hvac.binding).toBe('sim://hvac-1');
    expect(hvac.initialState).toEqual({ power: false });

    const [climate, advisor] = scenario.agents;
    expect(climate.managesZoneIds).toEqual(['living-room']);
    expect(climate.boundDeviceIds).toEqual(['temp-1']);
    expect(climate.llm).toEqual({
      provider: 'openai-compatible',
      model: 'qwen3:8b',
      params: { num_ctx: 8192 },
    });
    expect(advisor.managesZoneIds).toEqual([]);
    expect(advisor.boundDeviceIds).toEqual([]);

    expect(scenario.events[0]).toMatchObject({
      id: 'evt-heat',
      type: 'temperature-spike',
      zoneId: 'living-room',
      parameter: 'temperature',
      value: 33,
      atSimTimeSec: 10,
    });
  });

  it('tolerates unknown extra fields (forward compatibility)', () => {
    const scenario = minimalValidScenario();
    scenario.futureTopLevelField = { anything: true };
    (scenario.zones as Array<Record<string, unknown>>)[0].futureZoneField = 42;

    expect(() => loadScenarioFile(scenario)).not.toThrow();
  });

  it('preserves per-agent decisionPolicy (T-050) and stays absent when omitted', () => {
    const scenario = minimalValidScenario();
    scenario.agents = [
      {
        id: 'agent-1',
        name: 'Agent One',
        capabilities: ['lighting-control'],
        decisionPolicy: { autoActuateIndependent: false, autoInitiateAC: true },
      } as Record<string, unknown>,
      { id: 'agent-2', name: 'Agent Two', capabilities: ['monitoring'] },
    ];

    const loaded = loadScenarioFile(scenario);
    // The loader whitelists the policy additively (cloned, not shared).
    expect(loaded.agents[0].decisionPolicy).toEqual({
      autoActuateIndependent: false,
      autoInitiateAC: true,
    });
    // Backward compatibility: old files keep the field undefined → the
    // runtime-wide defaults apply.
    expect(loaded.agents[1].decisionPolicy).toBeUndefined();
  });

  it('preserves precheckPassThrough policy fields (R43-B/lever-b) verbatim', () => {
    const scenario = minimalValidScenario();
    scenario.agents = [
      {
        id: 'agent-1',
        name: 'Agent One',
        capabilities: ['lighting-control'],
        decisionPolicy: { precheckPassThrough: 'sample', precheckPassThroughRate: 0.5 },
      } as Record<string, unknown>,
    ];

    const loaded = loadScenarioFile(scenario);
    expect(loaded.agents[0].decisionPolicy).toEqual({
      precheckPassThrough: 'sample',
      precheckPassThroughRate: 0.5,
    });
  });

  it('infers hybrid role for devices with read + control capabilities', () => {
    const scenario = minimalValidScenario();
    scenario.devices = [
      {
        id: 'plug-1',
        type: 'smart-plug',
        capabilities: ['energy-monitoring', 'energy-control'],
        zoneId: 'room-1',
      },
    ];

    const loaded = loadScenarioFile(scenario);
    expect(loaded.devices[0].role).toBe('hybrid');
  });
});

describe('loadScenarioFile — baselines and event metadata extensions', () => {
  it('preserves per-zone baseline conditions', () => {
    const scenario = minimalValidScenario();
    (scenario.zones as Array<Record<string, unknown>>)[0].baseline = {
      temperature: 31.5,
      humidity: 68,
      co2: 550,
      motion: false,
    };

    const loaded = loadScenarioFile(scenario);
    expect(loaded.zones[0].baseline).toEqual({
      temperature: 31.5,
      humidity: 68,
      co2: 550,
      motion: false,
    });
  });

  it('leaves baseline undefined when not declared (backward compatible)', () => {
    const loaded = loadScenarioFile(minimalValidScenario());
    expect(loaded.zones[0].baseline).toBeUndefined();
  });

  it('rejects non-numeric/non-boolean baseline values', () => {
    const scenario = minimalValidScenario();
    (scenario.zones as Array<Record<string, unknown>>)[0].baseline = {
      temperature: 'hot',
    };

    expectValidationError(() => loadScenarioFile(scenario), /baseline/i);
  });

  it('preserves declarative zone rooms (R82 interior metadata)', () => {
    const scenario = minimalValidScenario();
    (scenario.zones as Array<Record<string, unknown>>)[0].rooms = [
      { code: 'A-0001', name: '食堂 Life & Hope', type: 'canteen', hours: 'Mon-Fri 11:00-13:00' },
      { name: '讨论间' },
    ];

    const loaded = loadScenarioFile(scenario);
    expect(loaded.zones[0].rooms).toEqual([
      { code: 'A-0001', name: '食堂 Life & Hope', type: 'canteen', hours: 'Mon-Fri 11:00-13:00' },
      { name: '讨论间' },
    ]);
  });

  it('leaves zone rooms undefined when not declared (backward compatible)', () => {
    const loaded = loadScenarioFile(minimalValidScenario());
    expect(loaded.zones[0].rooms).toBeUndefined();
  });

  it('rejects a room without a name', () => {
    const scenario = minimalValidScenario();
    (scenario.zones as Array<Record<string, unknown>>)[0].rooms = [{ code: 'X-1' }];

    expectValidationError(() => loadScenarioFile(scenario), /rooms/i);
  });

  it('rejects non-string room codes', () => {
    const scenario = minimalValidScenario();
    (scenario.zones as Array<Record<string, unknown>>)[0].rooms = [
      { name: 'room', code: 42 },
    ];

    expectValidationError(() => loadScenarioFile(scenario), /rooms/i);
  });

  it('preserves event severity and requiredCapabilities', () => {
    const scenario = minimalValidScenario();
    scenario.events = [
      {
        id: 'evt-smoke',
        type: 'smoke-detected',
        zoneId: 'room-1',
        parameter: 'smoke',
        value: 0.75,
        atSimTimeSec: 30,
        severity: 'critical',
        requiredCapabilities: ['air-purification', 'ventilation'],
      },
    ];

    const loaded = loadScenarioFile(scenario);
    expect(loaded.events[0].severity).toBe('critical');
    expect(loaded.events[0].requiredCapabilities).toEqual(['air-purification', 'ventilation']);
  });

  it('leaves event severity/requiredCapabilities undefined when omitted (backward compatible)', () => {
    const loaded = loadScenarioFile(fullValidScenario());
    expect(loaded.events[0].severity).toBeUndefined();
    expect(loaded.events[0].requiredCapabilities).toBeUndefined();
  });

  it('rejects an unknown event severity', () => {
    const scenario = minimalValidScenario();
    scenario.events = [
      { id: 'evt-bad', type: 'smoke-detected', zoneId: 'room-1', severity: 'catastrophic' },
    ];

    expectValidationError(() => loadScenarioFile(scenario), /severity/i);
  });

  it('rejects empty requiredCapabilities entries', () => {
    const scenario = minimalValidScenario();
    scenario.events = [
      { id: 'evt-bad', type: 'smoke-detected', zoneId: 'room-1', requiredCapabilities: [''] },
    ];

    expectValidationError(() => loadScenarioFile(scenario), /requiredCapabilities/i);
  });
});

// ---------------------------------------------------------------------------
// Invalid scenarios
// ---------------------------------------------------------------------------

describe('loadScenarioFile — validation errors', () => {
  it('rejects a missing version', () => {
    const scenario = minimalValidScenario();
    delete scenario.version;

    expectValidationError(() => loadScenarioFile(scenario), /version/i);
  });

  it('rejects an unsupported version', () => {
    const scenario = { ...minimalValidScenario(), version: '2.0' };

    expectValidationError(() => loadScenarioFile(scenario), /version/i);
  });

  it('rejects a device missing required fields', () => {
    const scenario = minimalValidScenario();
    scenario.devices = [{ id: 'dev-1', zoneId: 'room-1' }]; // no type/capabilities

    expectValidationError(() => loadScenarioFile(scenario), /devices\[0\].*type/i);
  });

  it('rejects a device referencing an unknown zone', () => {
    const scenario = minimalValidScenario();
    scenario.devices = [
      { id: 'dev-1', type: 'hvac', capabilities: ['cooling'], zoneId: 'nowhere' },
    ];

    expectValidationError(() => loadScenarioFile(scenario), /dev-1.*unknown zone "nowhere"/);
  });

  it('rejects an agent referencing an unknown zone or device', () => {
    const scenario = minimalValidScenario();
    scenario.agents = [
      {
        id: 'agent-1',
        name: 'Agent',
        capabilities: [],
        managesZoneIds: ['ghost-zone'],
        boundDeviceIds: ['ghost-device'],
      },
    ];

    expectValidationError(() => loadScenarioFile(scenario), /managesZoneIds.*unknown zone "ghost-zone"/);
    expectValidationError(() => loadScenarioFile(scenario), /boundDeviceIds.*unknown device "ghost-device"/);
  });

  it('rejects an event referencing an unknown zone', () => {
    const scenario = minimalValidScenario();
    scenario.events = [{ id: 'evt-1', type: 'temperature-spike', zoneId: 'ghost' }];

    expectValidationError(() => loadScenarioFile(scenario), /evt-1.*unknown zone "ghost"/);
  });

  it('rejects duplicate zone ids', () => {
    const scenario = minimalValidScenario();
    scenario.zones = [{ id: 'room-1' }, { id: 'room-1' }];

    expectValidationError(() => loadScenarioFile(scenario), /duplicate id "room-1"/);
  });

  it('rejects a zone adjacent to an unknown zone', () => {
    const scenario = minimalValidScenario();
    scenario.zones = [{ id: 'room-1', adjacentZoneIds: ['room-2'] }];

    expectValidationError(() => loadScenarioFile(scenario), /adjacentZoneIds.*unknown zone "room-2"/);
  });

  it('accepts hass:// bindings (resolved later via a runtime deviceFactory)', () => {
    const scenario = minimalValidScenario();
    scenario.devices = [
      {
        id: 'dev-1',
        type: 'light',
        capabilities: ['lighting-control'],
        zoneId: 'room-1',
        binding: 'hass://light.living_room',
      },
    ];

    const loaded = loadScenarioFile(scenario);
    expect(loaded.devices[0].binding).toBe('hass://light.living_room');
  });

  it('rejects an empty hass:// entity id', () => {
    const scenario = minimalValidScenario();
    scenario.devices = [
      {
        id: 'dev-1',
        type: 'light',
        capabilities: ['lighting-control'],
        zoneId: 'room-1',
        binding: 'hass://',
      },
    ];

    expectValidationError(() => loadScenarioFile(scenario), /hass:\/\/.*entity/i);
  });

  it('rejects bindings with unknown schemes at the schema level', () => {
    const scenario = minimalValidScenario();
    scenario.devices = [
      {
        id: 'dev-1',
        type: 'light',
        capabilities: ['lighting-control'],
        zoneId: 'room-1',
        binding: 'mqtt://broker/device',
      },
    ];

    expectValidationError(() => loadScenarioFile(scenario), /binding/i);
  });

  it('rejects non-object input', () => {
    expectValidationError(() => loadScenarioFile('not a scenario'), /object/i);
    expectValidationError(() => loadScenarioFile(null), /object|null/i);
  });
});

// ---------------------------------------------------------------------------
// BUG-06 — host-injected flow-validation oracles (ScenarioLoadOptions)
// ---------------------------------------------------------------------------

/** A minimal scenario whose embedded flow actuates a speaker via set-volume. */
function speakerScenarioWithFlow(params: Record<string, unknown>): Record<string, unknown> {
  return {
    ...minimalValidScenario(),
    devices: [
      { id: 'spk-1', type: 'speaker', capabilities: ['set-volume'], zoneId: 'room-1' },
    ],
    agents: [
      {
        id: 'agent-1', name: 'PA Agent', capabilities: [],
        managesZoneIds: ['room-1'], boundDeviceIds: ['spk-1'],
      },
    ],
    flows: [
      {
        id: 'quiet-flow',
        name: 'Quiet Flow',
        enabled: true,
        trigger: { kind: 'event', eventType: 'loud-noise', zoneId: 'room-1' },
        plan: {
          goal: 'lower the volume',
          nodes: [
            {
              id: 'n1', capability: 'set-volume',
              assigneeAgentId: 'agent-1', deviceId: 'spk-1', params,
            },
          ],
        },
      },
    ],
  };
}

/**
 * Stand-in for simulation's acceptedParameterNames (the server injects the
 * real oracle; same pattern as flow-types' R13 tests).
 */
function volumeParamsOracle(commandName: string): readonly string[] | undefined {
  return commandName.toLowerCase() === 'set-volume' ? ['volume', 'value'] : undefined;
}

describe('loadScenarioFile — BUG-06 injected flow validation oracles', () => {
  it('without options, an all-unrecognized param spelling still loads (legacy: oracles defaulted off)', () => {
    const loaded = loadScenarioFile(speakerScenarioWithFlow({ vol: 30 }));
    expect(loaded.flows).toHaveLength(1);
  });

  it('with acceptedParameterNames injected, the same file fails the LOAD with the rename hint', () => {
    try {
      loadScenarioFile(speakerScenarioWithFlow({ vol: 30 }), {
        flowValidation: {
          isExecutableCapability: () => true,
          acceptedParameterNames: volumeParamsOracle,
        },
      });
      expect.unreachable('expected loadScenarioFile to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioFlowValidationError);
      const issues = (error as ScenarioFlowValidationError).issues;
      expect(
        issues.some(issue =>
          issue.includes('flows[quiet-flow]') &&
          issue.includes("command 'set-volume' accepts params (volume, value)") &&
          issue.includes('vol → volume') &&
          issue.includes('would execute with no effect')),
        `expected the REST-lane rename hint, got:\n${issues.join('\n')}`,
      ).toBe(true);
    }
  });

  it('with isExecutableCapability injected, a declared-but-unexecutable capability fails the LOAD (T-002)', () => {
    expectValidationError(
      () => loadScenarioFile(speakerScenarioWithFlow({ volume: 30 }), {
        flowValidation: { isExecutableCapability: name => name !== 'set-volume' },
      }),
      /no registered command handler executes it/,
    );
  });

  it('a well-spelled flow passes the injected gate', () => {
    const loaded = loadScenarioFile(speakerScenarioWithFlow({ volume: 30 }), {
      flowValidation: {
        isExecutableCapability: () => true,
        acceptedParameterNames: volumeParamsOracle,
      },
    });
    expect(loaded.flows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Device role inference
// ---------------------------------------------------------------------------

describe('inferDeviceRole', () => {
  it('classifies read-only devices as sensors', () => {
    expect(inferDeviceRole(['temperature-reading', 'humidity-monitoring'])).toBe('sensor');
  });

  it('classifies control-only devices as actuators', () => {
    expect(inferDeviceRole(['temperature-control', 'cooling'])).toBe('actuator');
  });

  it('classifies mixed devices as hybrids', () => {
    expect(inferDeviceRole(['energy-monitoring', 'energy-control'])).toBe('hybrid');
  });

  it('defaults capability-less devices to sensors', () => {
    expect(inferDeviceRole([])).toBe('sensor');
  });

  // BUG-01: verb-prefixed read-only names (the dorm-life misclassification —
  // 58 such devices persisted role='actuator' while the actuation planner
  // treated them as observation) now classify as sensors via the shared
  // read-only predicate (capabilities/read-only.ts).
  it('classifies verb-prefixed read-only names as sensors (BUG-01)', () => {
    expect(inferDeviceRole(['read-occupancy'])).toBe('sensor');
    expect(inferDeviceRole(['detect-smoke'])).toBe('sensor');
    expect(inferDeviceRole(['read-power'])).toBe('sensor');
    expect(inferDeviceRole(['query-status', 'measure-flow'])).toBe('sensor');
  });

  it('a verb-prefixed read plus an actuation command is still a hybrid (BUG-01)', () => {
    expect(inferDeviceRole(['read-power', 'turn-off'])).toBe('hybrid');
  });

  it('legacy noun forms keep their read verdict (tracking/surveillance/imaging)', () => {
    expect(inferDeviceRole(['motion-tracking'])).toBe('sensor');
    expect(inferDeviceRole(['area-surveillance'])).toBe('sensor');
  });
});

// ---------------------------------------------------------------------------
// Building tier (B-A): floor metadata, adjacency symmetrization, warnings
// ---------------------------------------------------------------------------

describe('loadScenarioFile — building tier (B-A)', () => {
  function buildingScenario(): Record<string, unknown> {
    return {
      version: '1.0',
      meta: { id: 'building', name: 'Building', storeyHeight: 3, slabAttenuation: 0.2 },
      zones: [
        {
          id: 'room-f0',
          buildingId: 'main',
          floor: 0,
          bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 },
          adjacentZoneIds: ['shaft-f0'],
        },
        { id: 'shaft-f0', buildingId: 'main', floor: 0, adjacentZoneIds: ['shaft-f1'] },
        // One-sided declaration: shaft-f1 does NOT list shaft-f0.
        { id: 'shaft-f1', buildingId: 'main', floor: 1, adjacentZoneIds: ['room-f1'] },
        { id: 'room-f1', buildingId: 'main', floor: 1 },
      ],
      devices: [],
      agents: [],
    };
  }

  it('preserves zone buildingId/floor and meta storeyHeight/slabAttenuation', () => {
    const loaded = loadScenarioFile(buildingScenario());

    expect(loaded.meta.storeyHeight).toBe(3);
    expect(loaded.meta.slabAttenuation).toBe(0.2);
    expect(loaded.zones[0].buildingId).toBe('main');
    expect(loaded.zones[0].floor).toBe(0);
    expect(loaded.zones[2].floor).toBe(1);
  });

  it('leaves buildingId/floor/storeyHeight/slabAttenuation undefined when omitted', () => {
    const loaded = loadScenarioFile(minimalValidScenario());

    expect(loaded.meta.storeyHeight).toBeUndefined();
    expect(loaded.meta.slabAttenuation).toBeUndefined();
    expect(loaded.zones[0].buildingId).toBeUndefined();
    expect(loaded.zones[0].floor).toBeUndefined();
  });

  it('auto-symmetrizes one-sided adjacency declarations', () => {
    const loaded = loadScenarioFile(buildingScenario());
    const byId = new Map(loaded.zones.map(zone => [zone.id, zone.adjacentZoneIds]));

    // Declared shaft-f0 → shaft-f1 implies shaft-f1 → shaft-f0.
    expect(byId.get('shaft-f1')).toContain('shaft-f0');
    // Declared shaft-f1 → room-f1 implies room-f1 → shaft-f1.
    expect(byId.get('room-f1')).toEqual(['shaft-f1']);
    // Declarations themselves survive.
    expect(byId.get('shaft-f0')).toEqual(['room-f0', 'shaft-f1']);
  });

  it('accepts explicitly bidirectional declarations without duplicating', () => {
    const scenario = minimalValidScenario();
    scenario.zones = [
      { id: 'a', adjacentZoneIds: ['b'] },
      { id: 'b', adjacentZoneIds: ['a'] },
    ];

    const loaded = loadScenarioFile(scenario);
    expect(loaded.zones[0].adjacentZoneIds).toEqual(['b']);
    expect(loaded.zones[1].adjacentZoneIds).toEqual(['a']);
  });

  it('warns (without failing) when an adjacency spans more than one floor', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scenario = minimalValidScenario();
      scenario.zones = [
        { id: 'ground', floor: 0, adjacentZoneIds: ['penthouse'] },
        { id: 'penthouse', floor: 3 },
      ];

      const loaded = loadScenarioFile(scenario);

      expect(loaded.zones[1].adjacentZoneIds).toEqual(['ground']); // still symmetrized
      expect(
        warnSpy.mock.calls.some(call =>
          String(call[0]).includes('ground') && String(call[0]).includes('penthouse'),
        ),
        `expected a floor-jump warning, got:\n${warnSpy.mock.calls.map(c => String(c[0])).join('\n')}`,
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn for same-floor or one-floor-apart adjacency', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      loadScenarioFile(buildingScenario());
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rejects a non-integer floor at the schema level', () => {
    const scenario = minimalValidScenario();
    (scenario.zones as Array<Record<string, unknown>>)[0].floor = 1.5;

    expectValidationError(() => loadScenarioFile(scenario), /floor/i);
  });

  it('rejects an out-of-range slabAttenuation at the schema level', () => {
    const scenario = minimalValidScenario();
    (scenario.meta as Record<string, unknown>).slabAttenuation = 1.5;

    expectValidationError(() => loadScenarioFile(scenario), /slabAttenuation/i);
  });
});

// ---------------------------------------------------------------------------
// Shipped demo scenario
// ---------------------------------------------------------------------------

describe('config/scenarios/cross-brand-home.json', () => {
  const scenarioPath = join(__dirname, '..', '..', '..', '..', 'config', 'scenarios', 'cross-brand-home.json');

  it('loads cleanly via loadScenarioFromFile', () => {
    const scenario = loadScenarioFromFile(scenarioPath);

    expect(scenario.version).toBe('1.0');
    expect(scenario.meta.id).toBe('cross-brand-home');
    expect(scenario.zones.length).toBeGreaterThanOrEqual(1);
    expect(scenario.devices.length).toBe(4);
    expect(scenario.agents.length).toBe(4);

    // Every agent binds to a device that exists, in a zone that exists.
    const zoneIds = new Set(scenario.zones.map(z => z.id));
    for (const device of scenario.devices) {
      expect(zoneIds.has(device.zoneId)).toBe(true);
      expect(device.binding.startsWith('sim://')).toBe(true);
    }
  });
});

describe('config/scenarios/teaching-building.json (B-A seed)', () => {
  const scenarioPath = join(__dirname, '..', '..', '..', '..', 'config', 'scenarios', 'teaching-building.json');

  it('loads cleanly with floor metadata and symmetrized shaft adjacency', () => {
    const scenario = loadScenarioFromFile(scenarioPath);

    expect(scenario.meta.id).toBe('teaching-building');
    expect(scenario.meta.storeyHeight).toBe(3.5);
    expect(scenario.zones).toHaveLength(13); // 4 zones × 3 floors + outdoor

    const byId = new Map(scenario.zones.map(zone => [zone.id, zone]));
    // Stairwell chain is bidirectional after symmetrization (the file only
    // declares f0→f1 and f1→f2).
    expect(byId.get('stairwell-f0')!.adjacentZoneIds).toContain('stairwell-f1');
    expect(byId.get('stairwell-f1')!.adjacentZoneIds).toContain('stairwell-f0');
    expect(byId.get('stairwell-f1')!.adjacentZoneIds).toContain('stairwell-f2');
    expect(byId.get('stairwell-f2')!.adjacentZoneIds).toContain('stairwell-f1');

    // Floors stack as declared; indoor zones carry the building id.
    expect(byId.get('classroom-101')!.floor).toBe(0);
    expect(byId.get('classroom-201')!.floor).toBe(1);
    expect(byId.get('classroom-301')!.floor).toBe(2);
    expect(byId.get('classroom-101')!.buildingId).toBe('main');
    expect(byId.get('outdoor')!.type).toBe('outdoor');

    // One hvac per floor; sensors reference existing zones.
    const zoneIds = new Set(scenario.zones.map(z => z.id));
    for (const device of scenario.devices) {
      expect(zoneIds.has(device.zoneId)).toBe(true);
    }
    expect(scenario.devices.filter(d => d.type === 'hvac')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Building tier (B-B): occupancy, envelopeU, outdoor boundary metadata
// ---------------------------------------------------------------------------

describe('loadScenarioFile — building tier (B-B)', () => {
  it('preserves zone occupancy/envelopeU and meta envelopeU/occupancy rates', () => {
    const loaded = loadScenarioFile({
      version: '1.0',
      meta: {
        id: 'building-bb',
        name: 'Building B-B',
        envelopeU: 0.2,
        occupancyHeatW: 80,
        occupancyCo2Rate: 0.05,
      },
      zones: [
        {
          id: 'classroom',
          bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 },
          occupancy: 40,
          envelopeU: 0.05,
          adjacentZoneIds: ['outdoor'],
        },
        { id: 'outdoor', type: 'outdoor' },
      ],
      devices: [],
      agents: [],
    });

    expect(loaded.meta.envelopeU).toBe(0.2);
    expect(loaded.meta.occupancyHeatW).toBe(80);
    expect(loaded.meta.occupancyCo2Rate).toBe(0.05);
    expect(loaded.zones[0].occupancy).toBe(40);
    expect(loaded.zones[0].envelopeU).toBe(0.05);
    expect(loaded.zones[1].type).toBe('outdoor');
  });

  it('leaves occupancy/envelopeU undefined when omitted', () => {
    const loaded = loadScenarioFile(minimalValidScenario());

    expect(loaded.meta.envelopeU).toBeUndefined();
    expect(loaded.meta.occupancyHeatW).toBeUndefined();
    expect(loaded.meta.occupancyCo2Rate).toBeUndefined();
    expect(loaded.zones[0].occupancy).toBeUndefined();
    expect(loaded.zones[0].envelopeU).toBeUndefined();
  });

  it('rejects negative occupancy and out-of-range envelopeU', () => {
    const scenario = minimalValidScenario();
    (scenario.zones as Array<Record<string, unknown>>)[0].occupancy = -1;
    expectValidationError(() => loadScenarioFile(scenario), /occupancy/i);

    const scenario2 = minimalValidScenario();
    (scenario2.zones as Array<Record<string, unknown>>)[0].envelopeU = 1.5;
    expectValidationError(() => loadScenarioFile(scenario2), /envelopeU/i);
  });
});

// ---------------------------------------------------------------------------
// R40-B1: what-if quota (meta.whatIfQuota)
// ---------------------------------------------------------------------------

describe('loadScenarioFile — meta.whatIfQuota (R40-B1)', () => {
  it('passes the quota through verbatim (and leaves it absent when omitted)', () => {
    const scenario = minimalValidScenario();
    (scenario.meta as Record<string, unknown>).whatIfQuota = {
      maxDurationSec: 300,
      maxForksPerDay: 50,
    };
    const loaded = loadScenarioFile(scenario);
    expect(loaded.meta.whatIfQuota).toEqual({ maxDurationSec: 300, maxForksPerDay: 50 });

    expect(loadScenarioFile(minimalValidScenario()).meta.whatIfQuota).toBeUndefined();
  });

  it('rejects a quota beyond the 7200s ceiling, non-integers, and unknown fields', () => {
    const over = minimalValidScenario();
    (over.meta as Record<string, unknown>).whatIfQuota = { maxDurationSec: 7201 };
    expectValidationError(() => loadScenarioFile(over), /whatIfQuota|7200/i);

    const fractional = minimalValidScenario();
    (fractional.meta as Record<string, unknown>).whatIfQuota = { maxDurationSec: 300.5 };
    expectValidationError(() => loadScenarioFile(fractional), /integer/i);

    const unknown = minimalValidScenario();
    (unknown.meta as Record<string, unknown>).whatIfQuota = { maxDurationSec: 300, maxForkPerDay: 5 };
    expectValidationError(() => loadScenarioFile(unknown), /additional|fork/i);
  });

  it('requires maxDurationSec (the optional field is maxForksPerDay only)', () => {
    const missing = minimalValidScenario();
    (missing.meta as Record<string, unknown>).whatIfQuota = { maxForksPerDay: 5 };
    expectValidationError(() => loadScenarioFile(missing), /maxDurationSec|required/i);
  });
});

// ---------------------------------------------------------------------------
// P3 — semantic service authoring channels
// ---------------------------------------------------------------------------

describe('P3 — semanticOfferRules / agent services / capabilitySynonyms', () => {
  const campusRule = {
    semanticType: 'library-quiet-guard',
    label: '图书馆静音保障',
    description: '噪声监测联动情报板播控提醒。',
    requires: ['noise-monitoring', 'content-display'],
    actuates: ['set-message'],
  };

  function scenarioWithP3(): Record<string, unknown> {
    return {
      ...minimalValidScenario(),
      semanticOfferRules: [campusRule],
      capabilitySynonyms: [['noise-sensing-p3l', 'noise-monitoring']],
      agents: [
        {
          id: 'librarian',
          name: 'Librarian',
          capabilities: ['noise-monitoring'],
          services: [
            {
              semanticType: 'night-patrol-campus',
              label: '夜间巡更',
              description: '闭馆后巡更调度。',
              requires: ['patrol-tracking'],
              actuates: ['patrol-dispatch'],
            },
          ],
        },
      ],
    };
  }

  it('loads the new fields verbatim into the definition', () => {
    const definition = loadScenarioFile(scenarioWithP3());
    expect(definition.semanticOfferRules).toEqual([campusRule]);
    expect(definition.capabilitySynonyms).toEqual([['noise-sensing-p3l', 'noise-monitoring']]);
    expect(definition.agents[0]!.services).toEqual([
      {
        semanticType: 'night-patrol-campus',
        label: '夜间巡更',
        description: '闭馆后巡更调度。',
        requires: ['patrol-tracking'],
        actuates: ['patrol-dispatch'],
      },
    ]);
  });

  it('scenarios without the new fields leave them absent (legacy unchanged)', () => {
    const definition = loadScenarioFile(minimalValidScenario());
    expect(definition.semanticOfferRules).toBeUndefined();
    expect(definition.capabilitySynonyms).toBeUndefined();
    expect(definition.agents.every(a => a.services === undefined)).toBe(true);
  });

  it('rejects a rule with empty requires', () => {
    const raw = scenarioWithP3();
    raw.semanticOfferRules = [{ ...campusRule, requires: [] }];
    expectValidationError(() => loadScenarioFile(raw), /requires|minItems|NOT fewer than/i);
  });

  it('rejects a declared service with empty actuates', () => {
    const raw = scenarioWithP3();
    (raw.agents as Array<{ services: unknown[] }>)[0]!.services = [
      {
        semanticType: 'night-patrol-campus',
        label: '夜间巡更',
        description: '闭馆后巡更调度。',
        requires: ['patrol-tracking'],
        actuates: [],
      },
    ];
    expectValidationError(() => loadScenarioFile(raw), /actuates|minItems|NOT fewer than/i);
  });

  it('rejects duplicate semanticTypes within one rule set / one agent', () => {
    const raw = scenarioWithP3();
    raw.semanticOfferRules = [campusRule, { ...campusRule, label: '重复规则' }];
    expectValidationError(() => loadScenarioFile(raw), /duplicate id "library-quiet-guard"/);

    const raw2 = scenarioWithP3();
    (raw2.agents as Array<{ services: unknown[] }>)[0]!.services = [
      {
        semanticType: 'night-patrol-campus',
        label: '夜间巡更',
        description: 'a',
        requires: ['patrol-tracking'],
        actuates: ['patrol-dispatch'],
      },
      {
        semanticType: 'night-patrol-campus',
        label: '夜间巡更·改',
        description: 'b',
        requires: ['patrol-tracking'],
        actuates: ['patrol-dispatch'],
      },
    ];
    expectValidationError(() => loadScenarioFile(raw2), /duplicate id "night-patrol-campus"/);
  });

  it('registers capabilitySynonyms into the process-level matcher at load', async () => {
    const { capabilityMatches } = await import('../utils/capabilityMatching.js');
    // Distinct group from scenarioWithP3's — earlier tests already loaded it.
    const raw = { ...minimalValidScenario(), capabilitySynonyms: [['p3l-quiet-a', 'p3l-quiet-b']] };
    expect(capabilityMatches('p3l-quiet-a', 'p3l-quiet-b')).toBe(false);
    loadScenarioFile(raw);
    expect(capabilityMatches('p3l-quiet-a', 'p3l-quiet-b')).toBe(true);
  });

  it('an invalid scenario registers NOTHING (validation precedes registration)', async () => {
    const { capabilityMatches } = await import('../utils/capabilityMatching.js');
    const raw = scenarioWithP3();
    raw.capabilitySynonyms = [['unregistered-p3l-x', 'unregistered-p3l-y']];
    (raw.zones as unknown[]).length = 0; // zones minItems: 1 → schema failure
    expectValidationError(() => loadScenarioFile(raw), /zones/i);
    expect(capabilityMatches('unregistered-p3l-x', 'unregistered-p3l-y')).toBe(false);
  });
});
