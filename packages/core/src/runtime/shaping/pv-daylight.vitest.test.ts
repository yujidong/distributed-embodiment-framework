/**
 * @vitest-environment node
 *
 * T-704 (DevLoop R29, F-PH13) — PV day/night model.
 *
 *  - pvDaylightFactor: sinusoidal, zero at night (06:00/18:00), peak 1.0 at
 *    solar noon; 02:17 local → 0 (≤5% of an 8800 W rated array = ≤440 W).
 *  - EngineRuntime drives `pvOutputW` every tick for zones declaring PV
 *    capacity as `baseline.pvOutputW` (the declared baseline stays the
 *    PEAK capacity; the live parameter tracks the daylight curve).
 *  - T-708 companion: event injections for field-diffused pollutants
 *    (pm2_5/smoke/co2) are point writes; temperature keeps its radius.
 */
import { describe, it, expect, afterEach } from 'vitest';

import { loadScenarioFile } from '../../scenario/index.js';
import { EngineRuntime } from '../index.js';
import { pvDaylightFactor, zoneWriteRadius } from './world.js';

const runtimes: EngineRuntime[] = [];

async function makeRuntime(simTimeSec: number): Promise<EngineRuntime> {
  const scenario = loadScenarioFile({
    version: '1.0',
    meta: { id: 'pv-daylight-test', name: 'PV Daylight Test' },
    zones: [
      { id: 'roof', name: 'Roof Garden', baseline: { temperature: 25, pvOutputW: 8800 } },
      { id: 'lobby', name: 'Lobby', baseline: { temperature: 24 } },
    ],
    devices: [],
    agents: [],
    events: [],
  });
  const runtime = new EngineRuntime(scenario);
  runtimes.push(runtime);
  // Walk the world to the requested sim time (each tick drives the PV model).
  await runtime.advanceTo(simTimeSec);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop()!.stop();
});

describe('T-704 — pvDaylightFactor', () => {
  it('is zero through the night (02:17 → 0, i.e. ≤5% of rated 8800 W)', () => {
    const at0217 = 2 * 3600 + 17 * 60;
    expect(pvDaylightFactor(at0217)).toBe(0);
    expect(8800 * pvDaylightFactor(at0217)).toBeLessThanOrEqual(8800 * 0.05);
    // Pre-dawn and post-dusk edges.
    expect(pvDaylightFactor(5 * 3600)).toBe(0);
    expect(pvDaylightFactor(19 * 3600)).toBe(0);
  });

  it('peaks at solar noon and tracks light monotonically through the day', () => {
    expect(pvDaylightFactor(12 * 3600)).toBeCloseTo(1, 10);
    // Rising 07:00 → 11:00, falling 13:00 → 17:00.
    let prev = pvDaylightFactor(7 * 3600);
    for (let h = 7.5; h <= 11; h += 0.5) {
      const next = pvDaylightFactor(h * 3600);
      expect(next).toBeGreaterThan(prev);
      prev = next;
    }
    prev = pvDaylightFactor(13 * 3600);
    for (let h = 13.5; h <= 17; h += 0.5) {
      const next = pvDaylightFactor(h * 3600);
      expect(next).toBeLessThan(prev);
      prev = next;
    }
  });
});

describe('T-704 — EngineRuntime PV drive', () => {
  it('a zone declaring pvOutputW tracks the daylight curve (night ≈ 0, noon ≈ rated)', async () => {
    // Night: walk to 02:00.
    const night = await makeRuntime(2 * 3600);
    const nightPv = night.getSnapshot().zones.find(z => z.id === 'roof')?.parameters.pvOutputW;
    expect(nightPv as number).toBeLessThanOrEqual(8800 * 0.05);

    // Noon.
    const noon = await makeRuntime(12 * 3600);
    const noonPv = noon.getSnapshot().zones.find(z => z.id === 'roof')?.parameters.pvOutputW;
    expect(noonPv as number).toBeGreaterThan(8800 * 0.9);

    // Zones without PV never gain the parameter.
    const lobby = noon.getSnapshot().zones.find(z => z.id === 'lobby');
    expect(lobby?.parameters.pvOutputW).toBeUndefined();
  });
});

describe('T-708 — injection write radius semantics', () => {
  const zone = { bounds: { minX: 0, maxX: 20, minY: 0, maxY: 10 } };

  it('diffusing pollutants are point writes; temperature keeps the radius', () => {
    expect(zoneWriteRadius(zone, 'pm2_5')).toBe(0);
    expect(zoneWriteRadius(zone, 'smoke')).toBe(0);
    expect(zoneWriteRadius(zone, 'co2')).toBe(0);
    expect(zoneWriteRadius(zone, 'temperature')).toBeCloseTo(Math.sqrt(400 + 100) / 2, 10);
    // No parameter (legacy call sites) keeps the radius behavior.
    expect(zoneWriteRadius(zone)).toBeCloseTo(Math.sqrt(400 + 100) / 2, 10);
  });
});
