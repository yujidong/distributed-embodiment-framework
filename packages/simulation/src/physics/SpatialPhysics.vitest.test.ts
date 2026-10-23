/**
 * @vitest-environment node
 *
 * Spatial physics integration tests (no LLM, no network).
 *
 * Exercises the full stack — PhysicalEnvironment → PhysicsLayer →
 * SpatialField + SimulatedDevice control loops — for the three behaviors
 * that make the simulation spatially real and behaviorally bounded:
 *   (a) localized injection: a disturbance starts in one zone, spreads
 *       slightly to nearby zones over ticks, and leaves distant zones
 *       untouched;
 *   (b) thermostat control: an HVAC cools its room to ~target, cycles off,
 *       the room then relaxes back up — no runaway over long horizons;
 *   (c) safety-net clamping: absurdly strong effects cannot push the field
 *       outside physically possible ranges.
 */

import { describe, it, expect } from 'vitest';

import { TimeManager } from '../environment/TimeManager.js';
import { PhysicalEnvironment } from '../environment/PhysicalEnvironment.js';
import { SimulatedDevice } from '../devices/SimulatedDevice.js';
import type { PhysicsLayer } from './PhysicsLayer.js';
import { PhysicalParameter } from '../devices/types.js';
import type { DeviceCapability } from '@active-collaboration/shared';

function makeWorld(): { env: PhysicalEnvironment; physics: PhysicsLayer } {
  const timeManager = new TimeManager({ timeScale: 1 });
  const env = new PhysicalEnvironment(timeManager, {});
  const physics = env.getPhysicsLayer();
  if (!physics) throw new Error('physics layer expected to be enabled');
  return { env, physics };
}

function registerZone(physics: PhysicsLayer, id: string, x: number, y: number): void {
  physics.getSpatialManager().registerLocation({ id, name: id, path: id, position: { x, y } });
}

function capabilities(...names: string[]): DeviceCapability[] {
  return names.map(name => ({ name, type: 'execute' as const, parameters: [] }));
}

describe('Spatial physics (localized field behavior)', () => {
  it('(a) localized injection: kitchen high, adjacent slightly elevated after ticks, distant unchanged', () => {
    const { env, physics } = makeWorld();
    registerZone(physics, 'kitchen', 0, 0);
    registerZone(physics, 'dining', 3, 0); // adjacent, inside diffusion range
    registerZone(physics, 'study', 10, 0); // distant, outside diffusion range

    // Deterministic global attractor (legacy global write), then the event.
    env.setParameterValue('smoke', 'kitchen', 0);
    env.setLocalParameterValue('smoke', 'kitchen', 0.75, 2);

    // Immediately after injection: only the kitchen field holds the spike.
    expect(env.getParameterValue('smoke', 'kitchen') as number).toBeCloseTo(0.75, 5);
    expect(env.getParameterValue('smoke', 'study')).toBe(0); // global fallback

    env.simulate(60, 1); // 60 simulated seconds

    const kitchen = env.getParameterValue('smoke', 'kitchen') as number;
    const dining = env.getParameterValue('smoke', 'dining') as number;
    const study = env.getParameterValue('smoke', 'study') as number;

    // Kitchen still elevated (relaxation drains slowly), dining picked up a
    // small share through diffusion, distant study exactly untouched.
    expect(kitchen).toBeGreaterThan(0.15);
    expect(dining).toBeGreaterThan(0.005);
    expect(dining).toBeLessThan(kitchen);
    expect(study).toBe(0);
  });

  it('(b) thermostat: cools to ~target, cycles off, relaxes up, never runs away', async () => {
    const { env, physics } = makeWorld();
    registerZone(physics, 'room', 0, 0);
    // Hot room: 35°C environmental baseline (the attractor).
    env.setParameterBaseline('temperature', 'room', 35);

    const hvac = new SimulatedDevice({
      id: 'hvac-1',
      name: 'Test HVAC',
      type: 'hvac',
      initialState: { power: false, mode: 'off', targetTemperature: 26 },
      capabilities: capabilities('set-temperature', 'turn-on', 'turn-off', 'cooling'),
      behaviors: [],
      location: 'room',
    });
    hvac.setPhysicalEnvironment(env);

    const readRoom = () => env.getParameterValue('temperature', 'room') as number;
    expect(readRoom()).toBeCloseTo(35, 5);

    const result = await hvac.executeCommand('set-temperature', { targetTemperature: 25 });
    expect(result.success).toBe(true);
    // The device registered a COOLING effect (sensed 35°C > target 25°C).
    const effect = physics.getDeviceEffect('hvac-1', PhysicalParameter.TEMPERATURE);
    expect(effect).toBeDefined();
    expect(effect!.magnitude).toBeLessThan(0);

    const step = (seconds: number, watch?: (t: number) => void) => {
      for (let i = 0; i < seconds; i++) {
        hvac.onPhysicsTick(1);
        env.simulate(1, 1);
        watch?.(readRoom());
      }
    };

    let sawEffectOff = false;
    step(15 * 60, () => {
      const e = physics.getDeviceEffect('hvac-1', PhysicalParameter.TEMPERATURE);
      if (e && !e.enabled) sawEffectOff = true;
    });

    const afterCool = readRoom();
    expect(afterCool).toBeGreaterThan(23.5);
    expect(afterCool).toBeLessThan(26.5);
    expect(sawEffectOff).toBe(true); // thermostat reached target−0.5 and stopped

    // Long horizon (30 more sim-minutes): the room oscillates in the
    // hysteresis band instead of integrating to unphysical values.
    let min = Infinity;
    let max = -Infinity;
    step(30 * 60, t => {
      min = Math.min(min, t);
      max = Math.max(max, t);
    });
    expect(min).toBeGreaterThan(22); // the old bug reached −78°C here
    expect(max).toBeLessThan(31);

    // turn-off disables the effect; the room relaxes back toward 35°C.
    await hvac.executeCommand('turn-off', {});
    expect(physics.getDeviceEffect('hvac-1', PhysicalParameter.TEMPERATURE)).toBeUndefined();
    step(10 * 60);
    expect(readRoom()).toBeGreaterThan(afterCool + 1);
  });

  it('(b2) F-24 regression: a lost effect is rebuilt — the thermostat keeps cooling after clearAllDeviceEffects', async () => {
    // The AC feedback pipeline (PhysicalEnvironment.simulateWithFeedback)
    // clears device effects when its goal is reached (Fix-21 scoped this to
    // the goal zone; this test still exercises the explicit global clear);
    // the thermostat
    // loop could only toggle an EXISTING effect, so the AC stayed "on" with
    // zero cooling forever (room pinned at its no-cooling equilibrium).
    const { env, physics } = makeWorld();
    registerZone(physics, 'room', 0, 0);
    env.setParameterBaseline('temperature', 'room', 35);

    const hvac = new SimulatedDevice({
      id: 'hvac-1',
      name: 'Test HVAC',
      type: 'hvac',
      initialState: { power: false, mode: 'off', targetTemperature: 26 },
      capabilities: capabilities('set-temperature', 'turn-on', 'turn-off', 'cooling'),
      behaviors: [],
      location: 'room',
    });
    hvac.setPhysicalEnvironment(env);

    const readRoom = () => env.getParameterValue('temperature', 'room') as number;
    const step = (seconds: number) => {
      for (let i = 0; i < seconds; i++) {
        hvac.onPhysicsTick(1);
        env.simulate(1, 1);
      }
    };

    await hvac.executeCommand('set-temperature', { targetTemperature: 25 });
    step(15 * 60);
    const afterCool = readRoom();
    expect(afterCool).toBeLessThan(26.5);

    // Explicit global clear: the device state still says power=on / target=25.
    physics.clearAllDeviceEffects();
    expect(physics.getDeviceEffect('hvac-1', PhysicalParameter.TEMPERATURE)).toBeUndefined();

    // Long free run: the room relaxes up, crosses the hysteresis band, and
    // the rebuilt effect cools it back — it must NOT pin at equilibrium.
    let max = -Infinity;
    let sawRebuiltEffect = false;
    for (let i = 0; i < 60 * 60; i++) {
      hvac.onPhysicsTick(1);
      env.simulate(1, 1);
      max = Math.max(max, readRoom());
      if (physics.getDeviceEffect('hvac-1', PhysicalParameter.TEMPERATURE) !== undefined) {
        sawRebuiltEffect = true;
      }
    }
    expect(sawRebuiltEffect).toBe(true);
    expect(max).toBeLessThan(31); // equilibrium with no cooling is ~35
    expect(readRoom()).toBeLessThan(26.5);
  });

  it('(b3) Fix-21 regression: AC feedback clears only the GOAL zone — the other zone\'s thermostat keeps working', async () => {
    // Two zones, one HVAC each. The AC closed-loop monitor
    // (PhysicalEnvironment.simulateWithFeedback) reaches its goal in zone A
    // and stops zone A's device effects. Before Fix-21 it called
    // clearAllDeviceEffects(), wiping zone B's thermostat effect too; the
    // zone-B device state still said power=on but produced zero cooling.
    const { env, physics } = makeWorld();
    registerZone(physics, 'room-a', 0, 0);
    registerZone(physics, 'room-b', 100, 0); // far away: no propagation overlap (effect radius 4)
    env.setParameterBaseline('temperature', 'room-a', 30);
    env.setParameterBaseline('temperature', 'room-b', 35);

    const hvacA = new SimulatedDevice({
      id: 'hvac-a',
      name: 'HVAC A',
      type: 'hvac',
      initialState: { power: false, mode: 'off', targetTemperature: 24 },
      capabilities: capabilities('set-temperature', 'turn-on', 'turn-off', 'cooling'),
      behaviors: [],
      location: 'room-a',
    });
    hvacA.setPhysicalEnvironment(env);

    const hvacB = new SimulatedDevice({
      id: 'hvac-b',
      name: 'HVAC B',
      type: 'hvac',
      initialState: { power: false, mode: 'off', targetTemperature: 25 },
      capabilities: capabilities('set-temperature', 'turn-on', 'turn-off', 'cooling'),
      behaviors: [],
      location: 'room-b',
    });
    hvacB.setPhysicalEnvironment(env);

    await hvacA.executeCommand('set-temperature', { targetTemperature: 24 });
    await hvacB.executeCommand('set-temperature', { targetTemperature: 25 });
    expect(physics.getDeviceEffect('hvac-a', PhysicalParameter.TEMPERATURE)).toBeDefined();
    expect(physics.getDeviceEffect('hvac-b', PhysicalParameter.TEMPERATURE)).toBeDefined();

    // AC feedback loop achieves the zone-A goal (raw effects; the device
    // control loops do not tick inside simulateWithFeedback).
    const result = env.simulateWithFeedback(
      15 * 60,
      { parameter: 'temperature', location: 'room-a', targetValue: 24, tolerance: 1, direction: 'below' },
      1,
      2,
    );
    expect(result.goalAchieved).toBe(true);

    // Zone A's effect is stopped (AC precise control)...
    expect(physics.getDeviceEffect('hvac-a', PhysicalParameter.TEMPERATURE)).toBeUndefined();
    // ...but zone B's thermostat effect MUST survive.
    expect(physics.getDeviceEffect('hvac-b', PhysicalParameter.TEMPERATURE)).toBeDefined();

    // Zone B keeps cooling toward its own target afterwards.
    const beforeB = env.getParameterValue('temperature', 'room-b') as number;
    for (let i = 0; i < 10 * 60; i++) {
      hvacB.onPhysicsTick(1);
      env.simulate(1, 1);
    }
    const afterB = env.getParameterValue('temperature', 'room-b') as number;
    expect(afterB).toBeLessThan(beforeB);
  });

  it('(c) clamp: an absurdly strong cooling effect cannot break physical bounds', () => {
    const { env, physics } = makeWorld();
    registerZone(physics, 'room', 0, 0);
    env.setParameterBaseline('temperature', 'room', 20);

    env.registerDeviceEffect({
      deviceId: 'freezer',
      parameter: PhysicalParameter.TEMPERATURE,
      effect: 'cooling',
      magnitude: -1_000_000, // physically absurd on purpose
      affectedArea: { location: 'room', radius: 10, position: { x: 0, y: 0 } },
    });

    env.simulate(600, 1);
    const t = env.getParameterValue('temperature', 'room') as number;
    expect(t).toBeGreaterThanOrEqual(-60); // safety-net floor
    expect(t).toBeLessThan(-50); // it really did crash toward the floor
  });

  it('legacy global setParameterValue overrides the spatial field (reset semantics)', () => {
    const { env, physics } = makeWorld();
    registerZone(physics, 'room', 0, 0);
    env.setLocalParameterValue('temperature', 'room', 33, 0);
    expect(env.getParameterValue('temperature', 'room')).toBeCloseTo(33, 5);

    // A global write installs a zone-agnostic model AND clears the field
    // for that parameter — this is what the experiment runner's reset does.
    env.setParameterValue('temperature', 'room', 22);
    expect(env.getParameterValue('temperature', 'room')).toBe(22);
    expect(env.getParameterValue('temperature', 'anywhere-else')).toBe(22);
  });
});

// ---------------------------------------------------------------------------
// Floor-aware coupling (building tier, B-A)
// ---------------------------------------------------------------------------

const STOREY = 3.5;

function registerZoneOnFloor(
  physics: PhysicsLayer,
  id: string,
  x: number,
  y: number,
  floor: number,
  adjacentZoneIds: string[] = [],
): void {
  physics.getSpatialManager().registerLocation({
    id,
    name: id,
    path: id,
    position: { x, y, z: floor * STOREY },
  });
  physics.registerZonePhysics(id, { floor, adjacentZoneIds });
}

describe('Spatial physics — floor-aware coupling (B-A)', () => {
  it('a downstairs HVAC does not touch the non-shaft room directly above (core B-A acceptance)', () => {
    const { env, physics } = makeWorld();
    registerZoneOnFloor(physics, 'room-101', 0, 0, 0, ['room-102']);
    registerZoneOnFloor(physics, 'room-102', 3, 0, 0, ['room-101']); // same-floor neighbor in range
    registerZoneOnFloor(physics, 'room-201', 0, 0, 1, []); // directly above, NOT a shaft
    env.setParameterBaseline('temperature', 'room-101', 35);
    env.setParameterBaseline('temperature', 'room-102', 35);
    env.setParameterBaseline('temperature', 'room-201', 35);

    // Strong cooler in room-101, radius 4 m: under the old 3D rule the room
    // above (3.5 m up) sat inside the radius and got cooled too.
    env.registerDeviceEffect({
      deviceId: 'hvac-101',
      parameter: PhysicalParameter.TEMPERATURE,
      effect: 'cooling',
      magnitude: -3000,
      affectedArea: { location: 'room-101', radius: 4, position: { x: 0, y: 0, z: 0 } },
    });

    env.simulate(300, 1);

    const downstairs = env.getParameterValue('temperature', 'room-101') as number;
    const neighbor = env.getParameterValue('temperature', 'room-102') as number;
    const upstairs = env.getParameterValue('temperature', 'room-201') as number;

    expect(downstairs).toBeLessThan(33); // the HVAC really cools its own room
    expect(neighbor).toBeLessThan(35); // same-floor spillover still works
    expect(neighbor).toBeGreaterThan(downstairs); // falloff: less than the source room
    expect(upstairs).toBe(35); // the slab insulates: exactly untouched
  });

  it('declared stairwell zones exchange heat across floors — slowly (slab attenuation)', () => {
    const { env, physics } = makeWorld();
    registerZoneOnFloor(physics, 'shaft-f0', 0, 0, 0, ['shaft-f1']);
    registerZoneOnFloor(physics, 'shaft-f1', 0, 0, 1, ['shaft-f0']);
    registerZoneOnFloor(physics, 'room-f1-far', 10, 0, 1, []); // distant same-floor control
    env.setParameterBaseline('temperature', 'shaft-f0', 20);
    env.setParameterBaseline('temperature', 'shaft-f1', 30);
    env.setParameterBaseline('temperature', 'room-f1-far', 25);

    env.simulate(600, 1);

    const below = env.getParameterValue('temperature', 'shaft-f0') as number;
    const above = env.getParameterValue('temperature', 'shaft-f1') as number;
    const control = env.getParameterValue('temperature', 'room-f1-far') as number;

    // Coupling happened: the cool shaft warmed, the warm shaft cooled…
    expect(below).toBeGreaterThan(20.3);
    expect(above).toBeLessThan(29.7);
    // …but far less than an open same-floor doorway would give (both would
    // have converged much further over 10 minutes).
    expect(below).toBeLessThan(26);
    expect(above).toBeGreaterThan(24);
    // A same-floor room 10 m away (outside the 5 m range) is untouched.
    expect(control).toBe(25);
  });
});

describe('Spatial physics — envelope & occupancy (B-B)', () => {
  it('outdoor holds its baseline while an adjacent room is dragged toward it through the envelope', () => {
    const { env, physics } = makeWorld();
    registerZoneOnFloor(physics, 'room', 0, 0, 0, ['outdoor']);
    registerZoneOnFloor(physics, 'interior', 20, 0, 0, []); // far + not adjacent to outdoor
    physics.getSpatialManager().registerLocation({
      id: 'outdoor', name: 'outdoor', path: 'outdoor', position: { x: 4, y: 0 },
    });
    physics.registerZonePhysics('outdoor', { outdoor: true });
    env.setParameterBaseline('temperature', 'room', 20);
    env.setParameterBaseline('temperature', 'interior', 20);
    env.setParameterBaseline('temperature', 'outdoor', 35);

    env.simulate(600, 1);

    const room = env.getParameterValue('temperature', 'room') as number;
    const interior = env.getParameterValue('temperature', 'interior') as number;
    const outdoor = env.getParameterValue('temperature', 'outdoor') as number;

    // Envelope leak: the room warmed toward the outside…
    expect(room).toBeGreaterThan(20.5);
    // …but slowly — the 15°C gap is nowhere near closed after 10 minutes…
    expect(room).toBeLessThan(26);
    // …the outdoor boundary itself never absorbed the building's influence…
    expect(outdoor).toBe(35);
    // …and the non-adjacent interior zone is exactly untouched.
    expect(interior).toBe(20);
  });

  it('an occupancy-style CO2 source accumulates CO2 over time without touching PM2.5', () => {
    const { env, physics } = makeWorld();
    registerZone(physics, 'classroom', 0, 0);
    env.setParameterBaseline('co2', 'classroom', 600);
    env.setParameterBaseline('pm2_5', 'classroom', 30);

    // 40 people × 0.03 ppm/s — the shape EngineRuntime mounts for occupancy.
    env.registerDeviceEffect({
      deviceId: 'occupancy:classroom',
      parameter: PhysicalParameter.CO2,
      effect: 'pollutant',
      magnitude: 1.2,
      affectedArea: { location: 'classroom', radius: 4, position: { x: 0, y: 0 } },
    });

    env.simulate(60, 1);

    const co2 = env.getParameterValue('co2', 'classroom') as number;
    const pm25 = env.getParameterValue('pm2_5', 'classroom') as number;

    // 60 s × 1.2 ppm/s = +72 ppm gross, minus relaxation — clearly rising.
    expect(co2).toBeGreaterThan(630);
    // The CO2 source must NOT leak into the legacy PM2.5 pollutant path.
    expect(pm25).toBe(30);
  });
});
