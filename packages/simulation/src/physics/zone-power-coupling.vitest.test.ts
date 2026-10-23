/**
 * @vitest-environment node
 *
 * FEAT-02 acceptance tests — zone power ↔ device-state coupling and
 * ventilation-class device effects.
 *
 *  ① The T-709 per-device power ledger (zonePowerSums) is written into the
 *    zone field `power` every physics tick: a zone with reporting devices
 *    reads the SUM of their draws (switching 8 chargers off visibly drops
 *    the zone power — was a static 500 W global model no matter what ran).
 *  ② An exhaust fan registers the T-707 `air_flow` effect alongside its
 *    humidity effect (zone CO2 decays toward outdoor while it runs), and
 *    `set-mode {mode:'ventilation'}` on a ventilation-capable device takes
 *    the same effect path as the `ventilation` command.
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
    id: overrides.id ?? 'dev-feat02',
    name: 'FEAT-02 device',
    type: 'ev-charger',
    initialState: { status: 'active' },
    capabilities: [
      { name: 'turn-on', type: 'write', parameters: [] },
      { name: 'turn-off', type: 'write', parameters: [] },
      { name: 'set-mode', type: 'write', parameters: [] },
    ],
    behaviors: [],
    location: 'zone-a',
    ...overrides,
    ...(overrides.initialState !== undefined
      ? { initialState: { status: 'active', ...overrides.initialState } }
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
): void {
  for (let t = 0; t < seconds; t++) {
    for (const device of devices) device.onPhysicsTick(1);
    world.env.simulate(1, 1);
    world.advanceSimSeconds(1);
  }
}

describe('FEAT-02 ① — zone power follows the device power ledger', () => {
  it('8 chargers on: zone power = sum of draws; all off: zone power drops to ~0', async () => {
    const world = makeWorld();
    const chargers: SimulatedDevice[] = [];
    for (let i = 0; i < 8; i++) {
      chargers.push(makeDevice(world, {
        id: `charger-${i}`,
        type: 'ev-charger',
        initialState: { ratedPowerW: 7000, power: true },
      }));
    }

    // Before any tick the zone reads the deterministic global model (500 W).
    expect(world.env.getParameterValue('power', 'zone-a')).toBe(500);

    runTicks(world, chargers, 10);
    // 8 × 7000 W — the field power is the ledger sum, not the static model.
    expect(world.env.getParameterValue('power', 'zone-a')).toBe(56000);

    // Switch every charger off: the zone power visibly drops.
    for (const charger of chargers) await charger.executeCommand('turn-off');
    runTicks(world, chargers, 3);
    expect(world.env.getParameterValue('power', 'zone-a')).toBe(0);
  });

  it('a zone without device reports keeps its global-model power', () => {
    const world = makeWorld();
    const charger = makeDevice(world, {
      id: 'charger-only',
      type: 'ev-charger',
      initialState: { ratedPowerW: 7000, power: true },
    });
    runTicks(world, [charger], 5);
    // zone-b never saw a report: untouched by the ledger.
    expect(world.env.getParameterValue('power', 'zone-b')).toBe(500);
  });
});

describe('FEAT-02 ② — ventilation-class devices exchange air', () => {
  it('exhaust-fan turn-on registers air_flow; zone CO2 decays toward outdoor', async () => {
    const world = makeWorld();
    // Occupied bathroom: CO2 baseline pinned high (800 ppm).
    world.env.setParameterBaseline('co2', 'bath', 800);
    const fan = makeDevice(world, {
      id: 'bath-fan',
      type: 'exhaust-fan',
      location: 'bath',
      initialState: { speed: 80 },
      capabilities: [
        { name: 'turn-on', type: 'write', parameters: [] },
        { name: 'turn-off', type: 'write', parameters: [] },
      ],
    });

    await fan.executeCommand('turn-on');
    const layer = world.env.getPhysicsLayer()!;
    const airFlow = layer.getDeviceEffect('bath-fan', PhysicalParameter.CO2);
    expect(airFlow).toBeDefined();
    expect(airFlow!.effect).toBe('air_flow');
    // The legacy humidity effect is still there too.
    expect(layer.getDeviceEffect('bath-fan', PhysicalParameter.HUMIDITY)).toBeDefined();

    const before = world.env.getParameterValue('co2', 'bath') as number;
    runTicks(world, [fan], 600);
    const after = world.env.getParameterValue('co2', 'bath') as number;
    // Gradual ACH decay toward outdoor (~420), well below the 800 baseline.
    expect(after).toBeLessThan(before - 100);
    expect(after).toBeGreaterThanOrEqual(420);
  });

  it('set-mode ventilation on a ventilation-capable device registers the same air_flow effect', async () => {
    const world = makeWorld();
    world.env.setParameterBaseline('co2', 'lab', 900);
    const hood = makeDevice(world, {
      id: 'fume-hood',
      type: 'fume-hood',
      location: 'lab',
      capabilities: [
        { name: 'turn-on', type: 'write', parameters: [] },
        { name: 'turn-off', type: 'write', parameters: [] },
        { name: 'set-mode', type: 'write', parameters: [] },
        { name: 'ventilation', type: 'write', parameters: [] },
      ],
    });

    await hood.executeCommand('set-mode', { mode: 'ventilation' });
    // Selecting the ventilation mode powers the unit on (same state shape as
    // the ventilation command) …
    const state = hood.getState() as unknown as Record<string, unknown>;
    expect(state.mode).toBe('ventilation');
    expect(state.power).toBe(true);
    // … and registers the identical T-707 air_flow effect.
    const airFlow = world.env.getPhysicsLayer()!.getDeviceEffect('fume-hood', PhysicalParameter.CO2);
    expect(airFlow).toBeDefined();
    expect(airFlow!.effect).toBe('air_flow');

    const before = world.env.getParameterValue('co2', 'lab') as number;
    runTicks(world, [hood], 600);
    expect(world.env.getParameterValue('co2', 'lab') as number).toBeLessThan(before - 100);
  });

  it('set-mode ventilation on a NON-ventilation device stays physically inert', async () => {
    const world = makeWorld();
    world.env.setParameterBaseline('co2', 'hall', 700);
    const speaker = makeDevice(world, {
      id: 'hall-speaker',
      type: 'speaker',
      location: 'hall',
      capabilities: [
        { name: 'turn-on', type: 'write', parameters: [] },
        { name: 'set-mode', type: 'write', parameters: [] },
        { name: 'play-alert', type: 'write', parameters: [] },
      ],
    });

    await speaker.executeCommand('set-mode', { mode: 'ventilation' });
    expect(world.env.getPhysicsLayer()!.getDeviceEffect('hall-speaker', PhysicalParameter.CO2))
      .toBeUndefined();

    runTicks(world, [speaker], 60);
    // CO2 holds at its baseline (no phantom air exchange).
    expect(world.env.getParameterValue('co2', 'hall') as number).toBeCloseTo(700, 0);
  });
});
