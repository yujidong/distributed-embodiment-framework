/**
 * @vitest-environment node
 *
 * FEAT-03 — scenario-level declarations for custom zone-parameter field
 * dynamics (stage 1 wiring: `meta.parameterPhysics`) and device coupling
 * (stage 2: `meta.parameterEffects`).
 *
 * Validation is TEACHING: a coupling onto an undeclared custom key would
 * silently never move anything (T-304 static semantics), and a coupling onto
 * a standard (enum) parameter would fight its dedicated physics — both fail
 * the load with the fix spelled out. The end-to-end test pins the runtime
 * wiring: scenario meta → EngineRuntime → PhysicalEnvironment → SimulatedDevice
 * effect registration.
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  loadScenarioFile,
  ScenarioValidationError,
} from './scenario-loader.js';
import { EngineRuntime } from '../runtime/index.js';

function baseScenario() {
  return {
    version: '1.0' as const,
    meta: { id: 'lab-safety-test', name: 'Lab Safety Test' },
    zones: [{ id: 'lab-a', name: 'Lab A', baseline: { gas: 0 } }],
    devices: [
      {
        id: 'hood-1',
        type: 'fume-hood',
        capabilities: ['turn-on', 'turn-off', 'ventilation'],
        zoneId: 'lab-a',
      },
    ],
    agents: [
      {
        id: 'lab-agent',
        name: 'Lab Agent',
        capabilities: ['gas-monitoring'],
        managesZoneIds: ['lab-a'],
        boundDeviceIds: ['hood-1'],
        llm: null,
      },
    ],
    events: [],
  };
}

const FEAT03_META = {
  parameterPhysics: { gas: { relaxRatePerSec: 0.003, relaxToBaseline: true } },
  parameterEffects: [{ capability: 'ventilation', zoneParameter: 'gas', ratePerSec: -1 }],
};

describe('FEAT-03 scenario declarations — load and validation', () => {
  it('a valid parameterPhysics + parameterEffects declaration loads and rides the scenario meta', () => {
    const scenario = loadScenarioFile({
      ...baseScenario(),
      meta: { ...baseScenario().meta, ...FEAT03_META },
    });
    expect(scenario.meta.parameterPhysics).toEqual({
      gas: { relaxRatePerSec: 0.003, relaxToBaseline: true },
    });
    expect(scenario.meta.parameterEffects).toEqual([
      { capability: 'ventilation', zoneParameter: 'gas', ratePerSec: -1 },
    ]);
  });

  it('rejects a parameterEffects target that is NOT declared in parameterPhysics (teaching)', () => {
    let error: ScenarioValidationError | undefined;
    try {
      loadScenarioFile({
        ...baseScenario(),
        meta: {
          ...baseScenario().meta,
          parameterEffects: [{ capability: 'ventilation', zoneParameter: 'gas', ratePerSec: -1 }],
        },
      });
    } catch (e) {
      error = e as ScenarioValidationError;
    }
    expect(error).toBeInstanceOf(ScenarioValidationError);
    expect(error!.issues.join('\n')).toContain('meta.parameterEffects[0]');
    expect(error!.issues.join('\n')).toContain('"gas" is not declared in meta.parameterPhysics');
    expect(error!.issues.join('\n')).toContain('static (T-304)');
  });

  it('rejects a parameterEffects target that is a STANDARD parameter (dedicated physics)', () => {
    let error: ScenarioValidationError | undefined;
    try {
      loadScenarioFile({
        ...baseScenario(),
        meta: {
          ...baseScenario().meta,
          parameterEffects: [{ capability: 'cooling', zoneParameter: 'temperature', ratePerSec: -0.5 }],
        },
      });
    } catch (e) {
      error = e as ScenarioValidationError;
    }
    expect(error).toBeInstanceOf(ScenarioValidationError);
    expect(error!.issues.join('\n')).toContain('"temperature" is a standard parameter');
    expect(error!.issues.join('\n')).toContain('dedicated physics');
  });

  it('rejects parameterPhysics declared on a STANDARD parameter key', () => {
    let error: ScenarioValidationError | undefined;
    try {
      loadScenarioFile({
        ...baseScenario(),
        meta: {
          ...baseScenario().meta,
          parameterPhysics: { temperature: { relaxRatePerSec: 0.01 } },
        },
      });
    } catch (e) {
      error = e as ScenarioValidationError;
    }
    expect(error).toBeInstanceOf(ScenarioValidationError);
    expect(error!.issues.join('\n')).toContain('meta.parameterPhysics["temperature"]');
  });

  it('rejects a coupling with no device selector (schema: capability or deviceType required)', () => {
    let error: ScenarioValidationError | undefined;
    try {
      loadScenarioFile({
        ...baseScenario(),
        meta: {
          ...baseScenario().meta,
          ...FEAT03_META,
          parameterEffects: [{ zoneParameter: 'gas', ratePerSec: -1 }],
        },
      });
    } catch (e) {
      error = e as ScenarioValidationError;
    }
    expect(error).toBeInstanceOf(ScenarioValidationError);
  });

  it('rejects a typo\'d field inside a parameterPhysics entry (additionalProperties: false)', () => {
    let error: ScenarioValidationError | undefined;
    try {
      loadScenarioFile({
        ...baseScenario(),
        meta: {
          ...baseScenario().meta,
          parameterPhysics: { gas: { relaxRatePerSecond: 0.003 } },
        },
      });
    } catch (e) {
      error = e as ScenarioValidationError;
    }
    expect(error).toBeInstanceOf(ScenarioValidationError);
  });
});

describe('FEAT-03 — EngineRuntime wiring (scenario meta → device coupling)', () => {
  const runtimes: EngineRuntime[] = [];
  afterEach(() => {
    while (runtimes.length > 0) runtimes.pop()!.stop();
  });

  function makeRuntime(withEffects: boolean): EngineRuntime {
    const scenario = loadScenarioFile({
      ...baseScenario(),
      meta: {
        ...baseScenario().meta,
        parameterPhysics: FEAT03_META.parameterPhysics,
        ...(withEffects ? { parameterEffects: FEAT03_META.parameterEffects } : {}),
      },
    });
    // Default speed (1 sim-s per manual step) — `speed` is a start() argument,
    // not a constructor option.
    const runtime = new EngineRuntime(scenario, {});
    runtimes.push(runtime);
    return runtime;
  }

  function zoneGas(runtime: EngineRuntime): number {
    const zone = runtime.getSnapshot().zones.find(z => z.id === 'lab-a');
    return zone?.parameters.gas as number;
  }

  function injectGas(runtime: EngineRuntime, value: number): void {
    (runtime as unknown as {
      physicalEnv: { setLocalParameterValue: (p: string, l: string, v: number) => void };
    }).physicalEnv.setLocalParameterValue('gas', 'lab-a', value);
  }

  it('a fume-hood turn-on accelerates the declared gas decay (end-to-end)', async () => {
    const off = makeRuntime(false);
    const on = makeRuntime(true);

    injectGas(off, 800);
    injectGas(on, 800);
    expect(zoneGas(off)).toBe(800);
    expect(zoneGas(on)).toBe(800);

    const turnedOn = await on.executeDeviceCommand('hood-1', 'turn-on');
    expect(turnedOn.success).toBe(true);

    // 300 manual steps = 300 sim-seconds of physics in both worlds.
    await off.step(300);
    await on.step(300);

    const offValue = zoneGas(off);
    const onValue = zoneGas(on);
    // Relax-only ≈ 325; the coupled world drains visibly faster (≈ 127).
    expect(offValue).toBeGreaterThan(250);
    expect(onValue).toBeLessThan(offValue - 100);
    expect(onValue).toBeGreaterThan(0);
  });
});
