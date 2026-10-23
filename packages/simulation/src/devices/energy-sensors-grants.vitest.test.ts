/**
 * @vitest-environment node
 *
 * DevLoop R29 device-level physics acceptance tests.
 *
 *  T-702 — catalog physics bridges into HVAC handlers: kfr-26gw effect
 *          magnitude −2600 W; steady-state electrical draw 2600/COP(35 °C)
 *          = 812.5 W (was a flat 937.5 W class constant); a 980 W-rated
 *          purifier draws ≈980 W.
 *  T-703 — power accounting: status:'active' without power = 0 W; CO2
 *          sensor ≤5 W when powered; turn-off = exactly 0 W; purifier
 *          idle (effect disabled) <10 W standby.
 *  T-705 — sensors sample the field every tick: 38.3 °C spike → climate
 *          sensor reports temperature; CO2 646 ppm → co2 state key.
 *  T-706 — grant-temporary-access durationMin: expiresAt stored, relock
 *          within one tick of +30 sim-min, expired:true, cap 10 grants.
 *  T-709 — energy meter aggregates its zone: zonePowerW ≈ sum of sibling
 *          draws, cumulativeZoneWh grows at that rate.
 *  T-710 — duty-cycled energy at setpoint: draw alternates load/standby,
 *          time-averaged <60% of full load, zone holds 17.5–18.5 °C.
 */
import { describe, it, expect } from 'vitest';

import { TimeManager } from '../environment/TimeManager.js';
import { PhysicalEnvironment } from '../environment/PhysicalEnvironment.js';
import { SimulatedDevice } from '../devices/SimulatedDevice.js';
import { PhysicalParameter, type SimulatedDeviceConfig } from '../devices/types.js';

interface Harness {
  time: TimeManager;
  env: PhysicalEnvironment;
  advanceSimSeconds(seconds: number): void;
}

function makeWorld(startMs = Date.UTC(2026, 5, 1, 0, 0, 0)): Harness {
  const time = new TimeManager();
  time.jumpTo(new Date(startMs));
  const env = new PhysicalEnvironment(time, { environmentNoise: false });
  return {
    time,
    env,
    advanceSimSeconds(seconds: number): void {
      const base = time.getCurrentTime().getTime();
      time.jumpTo(new Date(base + seconds * 1000));
    },
  };
}

function makeDevice(world: Harness, overrides: Partial<SimulatedDeviceConfig>): SimulatedDevice {
  const device = new SimulatedDevice({
    id: overrides.id ?? 'dev-r29',
    name: 'R29 device',
    type: 'hvac',
    initialState: { zoneId: 'zone-a', status: 'active' },
    capabilities: [
      { name: 'turn-on', type: 'write', parameters: [] },
      { name: 'turn-off', type: 'write', parameters: [] },
      { name: 'set-temperature', type: 'write', parameters: [] },
      { name: 'set-mode', type: 'write', parameters: [] },
    ],
    behaviors: [],
    location: 'zone-a',
    ...overrides,
    ...(overrides.initialState !== undefined
      ? { initialState: { zoneId: 'zone-a', status: 'active', ...overrides.initialState } }
      : {}),
  } as SimulatedDeviceConfig);
  device.setPhysicalEnvironment(world.env);
  return device;
}

/** Drive `seconds` of ticks (device control + physics), 1 s per step. */
function runTicks(
  world: Harness,
  devices: SimulatedDevice[],
  seconds: number,
  hooks?: { pre?: () => void; post?: (t: number) => void },
): void {
  for (let t = 0; t < seconds; t++) {
    hooks?.pre?.();
    for (const device of devices) device.onPhysicsTick(1);
    world.env.simulate(1, 1);
    world.advanceSimSeconds(1);
    hooks?.post?.(t);
  }
}

describe('T-702 — catalog physics bridges into HVAC state', () => {
  it('kfr-26gw (cooling 2600 W) effect magnitude is −2600 W, not the 3 kW default', async () => {
    const world = makeWorld();
    const hvac = makeDevice(world, {
      id: 'hvac-kfr26',
      type: 'hvac',
      initialState: {
        // What the T-702 catalog bridge seeds from specs:
        coolingPowerW: 2600, ratedPowerW: 730, mode: 'cooling', power: false,
      },
    });
    await hvac.executeCommand('set-temperature', { temperature: 12 });
    await hvac.executeCommand('turn-on');

    const effect = world.env.getPhysicsLayer()!.getDeviceEffect('hvac-kfr26', PhysicalParameter.TEMPERATURE);
    expect(effect).toBeDefined();
    expect(effect!.effect).toBe('cooling');
    expect(effect!.magnitude).toBe(-2600);
  });

  it('steady-state electrical draw = 2600/COP(35 °C) = 812.5 W (was flat 937.5 W)', () => {
    const world = makeWorld();
    const hvac = makeDevice(world, {
      id: 'hvac-kfr26',
      type: 'hvac',
      // No targetTemperature → manual device: the thermostat loop never
      // cycles the compressor, so the meter reads the full steady draw.
      initialState: {
        coolingPowerW: 2600, ratedPowerW: 730, mode: 'cooling', power: true,
      },
    });
    runTicks(world, [hvac], 3600);
    const wh = (hvac.getState() as unknown as Record<string, unknown>).cumulativeEnergyWh as number;
    // 812.5 W × 1 h = 812.5 Wh (±0.1 rounding of the per-tick write-back).
    expect(Math.abs(wh - 812.5)).toBeLessThan(0.5);
  });

  it('a 980 W-rated purifier draws ≈980 W, not the 937.5 W HVAC bucket', () => {
    const world = makeWorld();
    const purifier = makeDevice(world, {
      id: 'purifier-980',
      type: 'air-purifier',
      initialState: { ratedPowerW: 980, power: true },
      capabilities: [
        { name: 'turn-on', type: 'write', parameters: [] },
        { name: 'turn-off', type: 'write', parameters: [] },
        { name: 'set-fan-speed', type: 'write', parameters: [] },
      ],
    });
    // Keep the zone dirty so the purifier's control loop runs it flat out.
    runTicks(world, [purifier], 60, { pre: () => world.env.setLocalParameterValue('pm2_5', 'zone-a', 30) });
    const wh = (purifier.getState() as unknown as Record<string, unknown>).cumulativeEnergyWh as number;
    expect(Math.abs(wh - (980 * 60) / 3600)).toBeLessThan(0.05);
  });
});

describe('T-703 — power accounting power-state semantics', () => {
  it("status:'active' without power draws 0 W from creation (no back-fill on later activation)", () => {
    const world = makeWorld();
    const purifier = makeDevice(world, {
      id: 'purifier-dormant',
      type: 'air-purifier',
      initialState: { ratedPowerW: 980 }, // no power flag — dormant
    });
    runTicks(world, [purifier], 3600); // a full sim hour dormant
    const state = purifier.getState() as unknown as Record<string, unknown>;
    expect(state.status).toBe('active');
    expect(state.cumulativeEnergyWh ?? 0).toBe(0);
  });

  it('a powered CO2 sensor draws ≤5 W continuous', () => {
    const world = makeWorld();
    const sensor = makeDevice(world, {
      id: 'co2-sensor',
      type: 'co2-sensor',
      initialState: { power: true },
      capabilities: [{ name: 'co2-monitoring', type: 'read', parameters: [] }],
    });
    runTicks(world, [sensor], 3600);
    const wh = (sensor.getState() as unknown as Record<string, unknown>).cumulativeEnergyWh as number;
    expect(wh).toBeLessThanOrEqual(5); // 3 W class default × 1 h
  });

  it('turn-off → exactly 0 W; Wh frozen', async () => {
    const world = makeWorld();
    const purifier = makeDevice(world, {
      id: 'purifier-off',
      type: 'air-purifier',
      initialState: { ratedPowerW: 980, power: true },
    });
    runTicks(world, [purifier], 600, { pre: () => world.env.setLocalParameterValue('pm2_5', 'zone-a', 30) });
    const before = (purifier.getState() as unknown as Record<string, unknown>).cumulativeEnergyWh as number;
    expect(before).toBeGreaterThan(100); // 10 min at 980 W → ≈163.3 Wh
    await purifier.executeCommand('turn-off');
    runTicks(world, [purifier], 3600, { pre: () => world.env.setLocalParameterValue('pm2_5', 'zone-a', 30) });
    const after = (purifier.getState() as unknown as Record<string, unknown>).cumulativeEnergyWh as number;
    expect(after).toBeCloseTo(before, 1);
  });

  it('purifier idle (PM2.5 already good, effect disabled) draws <10 W standby', async () => {
    const world = makeWorld();
    const purifier = makeDevice(world, {
      id: 'purifier-idle',
      type: 'air-purifier',
      initialState: { ratedPowerW: 980, power: true },
    });
    await purifier.executeCommand('turn-on');
    // Zone PM2.5 is already below the 12 µg/m³ "good" threshold.
    world.env.setLocalParameterValue('pm2_5', 'zone-a', 5);
    runTicks(world, [purifier], 600);
    const wh = (purifier.getState() as unknown as Record<string, unknown>).cumulativeEnergyWh as number;
    // <10 W for 10 min → <1.67 Wh (9 W standby → 1.5 Wh).
    expect(wh).toBeLessThan(1.67);
  });
});

describe('T-705 — sensors sample the field every tick', () => {
  it('climate sensor reports the 38.3 °C zone field within one tick', () => {
    const world = makeWorld();
    const sensor = makeDevice(world, {
      id: 'climate-sensor',
      type: 'climate-sensor',
      initialState: {},
      capabilities: [
        { name: 'temperature-monitoring', type: 'read', parameters: [] },
        { name: 'humidity-monitoring', type: 'read', parameters: [] },
      ],
    });
    // 45 °C spike event leaves the zone at 38.3 °C (F-PH18 repro).
    world.env.setLocalParameterValue('temperature', 'zone-a', 38.3);
    world.env.setLocalParameterValue('humidity', 'zone-a', 41);
    sensor.onPhysicsTick(1);
    const state = sensor.getState() as unknown as Record<string, unknown>;
    expect(state.temperature).toBeCloseTo(38.3, 3);
    expect(state.humidity).toBeCloseTo(41, 3);
    // fb030cf: lastReadingAt is SIM-time epoch seconds (the hibernate/
    // resume twin comparison needs deterministic values), not wall ISO.
    expect(typeof state.lastReadingAt).toBe('number');
  });

  it('CO2 sensor tracks the occupancy rise 600→646 instead of reporting nothing', () => {
    const world = makeWorld();
    const sensor = makeDevice(world, {
      id: 'co2-sensor-live',
      type: 'co2-sensor',
      initialState: {},
      capabilities: [{ name: 'co2-monitoring', type: 'read', parameters: [] }],
    });
    world.env.setLocalParameterValue('co2', 'zone-a', 646);
    sensor.onPhysicsTick(1);
    expect((sensor.getState() as unknown as Record<string, unknown>).co2).toBeCloseTo(646, 3);
  });

  // R52 (the R46 "telemetry missing" finding): flood detectors and wind
  // gauges carried EMPTY state in city worlds — wind resolved but had no
  // reading KEY, water-level didn't even resolve.
  it('R52: flood detector (water-level-monitoring) reports the water_level field', () => {
    const world = makeWorld();
    const sensor = makeDevice(world, {
      id: 'flood-detector-live',
      type: 'flood-detector',
      initialState: {},
      capabilities: [{ name: 'water-level-monitoring', type: 'read', parameters: [] }],
    });
    world.env.setLocalParameterValue('water_level', 'zone-a', 0.85);
    sensor.onPhysicsTick(1);
    const state = sensor.getState() as unknown as Record<string, unknown>;
    expect(state.water_level).toBeCloseTo(0.85, 3);
    expect(typeof state.lastReadingAt).toBe('number');
  });

  it('R52: wind gauge reports wind_speed and wind_direction keys', () => {
    const world = makeWorld();
    const sensor = makeDevice(world, {
      id: 'wind-sensor-live',
      type: 'wind-sensor',
      initialState: {},
      capabilities: [
        { name: 'wind-speed-monitoring', type: 'read', parameters: [] },
        { name: 'wind-direction-monitoring', type: 'read', parameters: [] },
      ],
    });
    world.env.setLocalParameterValue('wind_speed', 'zone-a', 17.5);
    world.env.setLocalParameterValue('wind_direction', 'zone-a', 92);
    sensor.onPhysicsTick(1);
    const state = sensor.getState() as unknown as Record<string, unknown>;
    expect(state.wind_speed).toBeCloseTo(17.5, 3);
    expect(state.wind_direction).toBeCloseTo(92, 3);
  });
});

describe('T-706 — grant-temporary-access duration + auto-relock', () => {
  async function makeLock(world: Harness): Promise<SimulatedDevice> {
    const lock = makeDevice(world, {
      id: 'door-lock',
      type: 'smart-lock',
      initialState: { locked: true },
      capabilities: [
        { name: 'lock', type: 'execute', parameters: [] },
        { name: 'unlock', type: 'execute', parameters: [] },
        { name: 'grant-temporary-access', type: 'execute', parameters: [] },
      ],
    });
    await lock.executeCommand('unlock');
    return lock;
  }

  it('durationMin is stored as durationSec + expiresAt (sim clock)', async () => {
    const world = makeWorld();
    const lock = await makeLock(world);
    await lock.executeCommand('grant-temporary-access', { to: 'contractor-1', durationMin: 30 }, { actor: 'user:ff37ce95' });
    const grants = (lock.getState() as unknown as Record<string, unknown>).temporaryGrants as Array<Record<string, unknown>>;
    expect(grants).toHaveLength(1);
    expect(grants[0].to).toBe('contractor-1');
    expect(grants[0].durationSec).toBe(1800);
    const expiresAt = Date.parse(grants[0].expiresAt as string);
    expect(expiresAt - world.time.getCurrentTime().getTime()).toBe(1800_000);
  });

  it('lock re-engages within one tick of +30 sim-min; grant marked expired; auto-relock audited', async () => {
    const world = makeWorld();
    const lock = await makeLock(world);
    await lock.executeCommand('grant-temporary-access', { durationMin: 30 });
    expect((lock.getState() as unknown as Record<string, unknown>).locked).toBe(false);

    // +29 min: still unlocked.
    runTicks(world, [lock], 29 * 60);
    expect((lock.getState() as unknown as Record<string, unknown>).locked).toBe(false);

    // +30 min ± 1 tick: auto-relock.
    runTicks(world, [lock], 61);
    const state = lock.getState() as unknown as Record<string, unknown>;
    expect(state.locked).toBe(true);
    const grants = state.temporaryGrants as Array<Record<string, unknown>>;
    expect(grants[0].expired).toBe(true);
    const log = state.accessLog as Array<Record<string, unknown>>;
    expect(log.some(entry => entry.action === 'auto-relock')).toBe(true);
  });

  it('grants list stays capped at 10', async () => {
    const world = makeWorld();
    const lock = await makeLock(world);
    for (let i = 0; i < 12; i++) {
      await lock.executeCommand('grant-temporary-access', { to: `guest-${i}`, durationMin: 5 });
    }
    const grants = (lock.getState() as unknown as Record<string, unknown>).temporaryGrants as unknown[];
    expect(grants).toHaveLength(10);
  });
});

describe('T-709 — energy meter aggregates its zone', () => {
  it('meter reports zonePowerW ≈ sum of sibling draws and accumulates zone Wh', () => {
    const world = makeWorld();
    const hvac = makeDevice(world, {
      id: 'hvac-meter-test',
      type: 'hvac',
      initialState: { coolingPowerW: 2600, mode: 'cooling', power: true, targetTemperature: 12 },
    });
    const purifier = makeDevice(world, {
      id: 'purifier-meter-test',
      type: 'air-purifier',
      initialState: { ratedPowerW: 980, power: true },
    });
    const meter = makeDevice(world, {
      id: 'zone-meter',
      type: 'energy-meter',
      initialState: {},
      capabilities: [{ name: 'energy-monitoring', type: 'read', parameters: [] }],
    });
    runTicks(world, [hvac, purifier, meter], 600, {
      // Keep the zone dirty so the purifier runs flat out alongside the HVAC.
      pre: () => world.env.setLocalParameterValue('pm2_5', 'zone-a', 30),
    });

    const state = meter.getState() as unknown as Record<string, unknown>;
    // 812.5 (HVAC electrical) + 980 (purifier) = 1792.5 W ± rounding.
    expect(state.zonePowerW as number).toBeGreaterThan(1700);
    expect(state.zonePowerW as number).toBeLessThan(1900);
    // 1792.5 W × 600 s = 298.75 Wh.
    expect(state.cumulativeZoneWh as number).toBeGreaterThan(280);
    expect(state.cumulativeZoneWh as number).toBeLessThan(320);
  });
});

describe('T-710 — duty-cycled energy at setpoint', () => {
  it('holding 18 °C in warm ambient: load/standby alternation, avg <60% full load, zone 17.5–18.5 °C', async () => {
    const world = makeWorld();
    // Warm ambient: the zone's attractor (global model) sits at 24.4 °C.
    world.env.setParameterValue('temperature', 'zone-a', 24.4);
    const hvac = makeDevice(world, {
      id: 'hvac-duty',
      type: 'hvac',
      initialState: {
        coolingPowerW: 3500, mode: 'cooling', power: true, targetTemperature: 18,
      },
    });
    await hvac.executeCommand('set-temperature', { temperature: 18 });
    await hvac.executeCommand('set-mode', { mode: 'cooling' });
    await hvac.executeCommand('turn-on');

    // Let the zone settle to the hysteresis band first (default 100 m³ mass).
    runTicks(world, [hvac], 1200);

    const draws: number[] = [];
    const temps: number[] = [];
    runTicks(world, [hvac], 1200, {
      post: () => {
        const draw = world.env.getPhysicsLayer()!.zonePowerW('zone-a');
        draws.push(draw);
        const t = world.env.getParameterValue('temperature', 'zone-a');
        if (typeof t === 'number') temps.push(t);
      },
    });

    const fullLoad = 3500 / 3.2; // 1093.75 W electrical
    const loadTicks = draws.filter(w => w > fullLoad * 0.5).length;
    const standbyTicks = draws.filter(w => w > 0 && w < fullLoad * 0.5).length;
    // Draw alternates between load and standby (both phases observed).
    expect(loadTicks).toBeGreaterThan(10);
    expect(standbyTicks).toBeGreaterThan(10);
    // Time-averaged draw < 60% of full load.
    const avg = draws.reduce((a, b) => a + b, 0) / draws.length;
    expect(avg / fullLoad).toBeLessThan(0.6);
    // Zone holds the setpoint band (hysteresis 0.5 °C).
    const settled = temps.slice(60);
    expect(Math.min(...settled)).toBeGreaterThanOrEqual(17.4);
    expect(Math.max(...settled)).toBeLessThanOrEqual(18.6);
  });
});
