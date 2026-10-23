/**
 * @vitest-environment node
 *
 * Fix-5 (RC-5) physics initialization & thermal calibration tests.
 *
 * P1-7 regression: a new rule-only world without any smoke/CO2 source must
 * start CLEAN — undeclared parameters sit at 0 or their explicit baseline
 * (smoke = 0, co2 = 400 ppm, pm2_5 = 10), deterministically: two runtimes
 * built back-to-back produce identical snapshots. Before the fix, the
 * built-in value models injected Math.random noise per read, so t=0 showed
 * phantom smoke ≈1.5 (different every run) and drifting CO2.
 *
 * P1-3 calibration: a 40-person classroom (40 × 75 W = 3 kW sensible heat,
 * 8×6 m × 3.5 m = 168 m³) must heat at a physically sane rate and reach a
 * sane equilibrium — no more runaway to 45–70 °C:
 *   - without AC: ~0.78 °C/min initial (3 kW into 207 kJ/K of air), ≈ +12 °C
 *     after 20 min, bounded well below the old runaway;
 *   - with one 3 kW AC holding 24 °C: the thermostat balances occupancy
 *     heat and the room settles in the mid-20s (≤ 28–30 °C target band).
 * The driver is per-zone thermal mass (zone volume × ρ·c) replacing the
 * global 100 m³ constant.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime } from './index.js';

const runtimes: EngineRuntime[] = [];

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop()!.stop();
});

function buildRuntime(scenarioJson: Parameters<typeof loadScenarioFile>[0]): EngineRuntime {
  const rt = new EngineRuntime(loadScenarioFile(scenarioJson));
  runtimes.push(rt);
  return rt;
}

function apartmentScenario(id: string) {
  return {
    version: '1.0' as const,
    meta: { id, name: 'P1-7 regression' },
    zones: [
      {
        id: 'living-room',
        name: 'Living Room',
        bounds: { minX: 0, maxX: 5, minY: 0, maxY: 4 },
        adjacentZoneIds: ['bedroom'],
      },
      {
        id: 'bedroom',
        name: 'Bedroom',
        bounds: { minX: 5, maxX: 9, minY: 0, maxY: 4 },
        adjacentZoneIds: ['living-room'],
      },
    ],
    devices: [],
    agents: [],
    events: [],
  };
}

function classroomScenario(withAC: boolean) {
  return {
    version: '1.0' as const,
    meta: { id: `p13-${withAC}`, name: 'P1-3 calibration' },
    zones: [
      {
        id: 'classroom',
        name: 'Classroom 101',
        bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 },
        baseline: { temperature: 22 },
        occupancy: 40,
        adjacentZoneIds: ['outdoor'],
      },
      {
        id: 'outdoor',
        name: 'Outdoor',
        type: 'outdoor',
        bounds: { minX: -10, maxX: -5, minY: 0, maxY: 8 },
        baseline: { temperature: 30 },
        adjacentZoneIds: ['classroom'],
      },
    ],
    devices: withAC
      ? [{
          id: 'hvac-1',
          name: 'Classroom AC',
          type: 'hvac',
          capabilities: ['temperature-control'],
          zoneId: 'classroom',
          role: 'actuator',
          binding: 'sim://hvac-1',
          initialState: { power: true, mode: 'cooling', targetTemperature: 24 },
        }]
      : [],
    agents: withAC
      ? [{
          id: 'agent-1',
          name: 'Classroom Agent',
          capabilities: ['temperature-control'],
          managesZoneIds: ['classroom'],
          boundDeviceIds: ['hvac-1'],
        }]
      : [],
    events: [],
  };
}

function zoneTemp(rt: EngineRuntime, zoneId: string): number {
  const zone = rt.getSnapshot().zones.find(z => z.id === zoneId);
  const value = zone?.parameters.temperature;
  if (typeof value !== 'number') throw new Error(`no temperature for zone ${zoneId}`);
  return value;
}

describe('P1-7: clean world initialization (no phantom smoke/co2)', () => {
  it('t=0 snapshot: undeclared parameters are 0 or baseline, identical across two runs', () => {
    const snapA = buildRuntime(apartmentScenario('p17-a')).getSnapshot();
    const snapB = buildRuntime(apartmentScenario('p17-b')).getSnapshot();

    for (const snap of [snapA, snapB]) {
      for (const zone of snap.zones) {
        // Phantom-source parameters: exactly 0 / atmospheric baseline.
        expect(zone.parameters.smoke).toBe(0);
        expect(zone.parameters.co2).toBe(400);
        expect(zone.parameters.pm2_5).toBe(10);
      }
    }

    // Determinism across instances: contaminant parameters match exactly,
    // cycle-driven parameters (time-of-day models) match within a second's
    // worth of drift between the two constructions.
    for (const zoneId of ['living-room', 'bedroom']) {
      const a = snapA.zones.find(z => z.id === zoneId)!.parameters;
      const b = snapB.zones.find(z => z.id === zoneId)!.parameters;
      for (const param of ['smoke', 'co2', 'pm2_5', 'motion']) {
        expect(a[param]).toBe(b[param]);
      }
      for (const param of ['temperature', 'humidity', 'light']) {
        expect(Math.abs((a[param] as number) - (b[param] as number))).toBeLessThan(0.05);
      }
    }
  });

  it('t=0 stays clean after physics ticks: no smoke materializes without a source', async () => {
    const rt = buildRuntime(apartmentScenario('p17-c'));
    await rt.step(300); // 5 simulated minutes
    for (const zone of rt.getSnapshot().zones) {
      expect(zone.parameters.smoke).toBe(0);
      expect(zone.parameters.co2).toBe(400);
    }
  });
});

describe('P1-3: classroom thermal calibration (40 people, 3 kW)', () => {
  it('without AC: heats at ~0.8 °C/min initially, ≈ +12 °C after 20 min — no runaway', async () => {
    const rt = buildRuntime(classroomScenario(false));
    const t0 = zoneTemp(rt, 'classroom');
    expect(t0).toBeCloseTo(22, 1);

    await rt.step(60);
    const rise60 = zoneTemp(rt, 'classroom') - t0;
    // 3 kW × 0.9 / 207 kJ·K⁻¹ ≈ 0.78 °C/min (old global 100 m³ constant
    // gave ≈ 1.3 °C/min and a runaway toward 70 °C+).
    expect(rise60).toBeGreaterThan(0.4);
    expect(rise60).toBeLessThan(1.2);

    await rt.step(1140); // t = 20 min
    const rise20min = zoneTemp(rt, 'classroom') - t0;
    expect(rise20min).toBeGreaterThan(6);
    expect(rise20min).toBeLessThan(16);
  });

  it('with one 3 kW AC at 24 °C: balances occupancy heat, settles ≤ 28 °C', async () => {
    const rt = buildRuntime(classroomScenario(true));
    const commanded = await rt.executeDeviceCommand('hvac-1', 'temperature-control', { target: 24 });
    expect(commanded.success).toBe(true);

    await rt.step(1800); // 30 simulated minutes — thermostat has cycled
    const t = zoneTemp(rt, 'classroom');
    expect(t).toBeGreaterThan(22);
    expect(t).toBeLessThanOrEqual(28);

    await rt.step(1800); // t = 60 min — still bounded, no slow runaway
    expect(zoneTemp(rt, 'classroom')).toBeLessThanOrEqual(28);
  });
});
