/**
 * @vitest-environment node
 *
 * T-106 (DevLoop R32, F-PH02b) — multi-HVAC weighted setpoints.
 *
 * Competing units in one zone used to cycle blindly against their own
 * targets and average out through the field. Semantics now:
 *   1. net direction = larger total capacity side (tie keeps own);
 *   2. effective setpoint = capacity-weighted average of the ALIGNED units;
 *   3. a unit opposing the majority capacity YIELDS (effect disabled).
 */

import { describe, it, expect } from 'vitest';

import { effectiveZoneSetpointC } from './controllers.js';
import { SimulatedDevice } from './SimulatedDevice.js';
import { TimeManager } from '../environment/TimeManager.js';
import { PhysicalEnvironment } from '../environment/PhysicalEnvironment.js';
import { PhysicalParameter } from './types.js';

describe('T-106 — effectiveZoneSetpointC (pure policy)', () => {
  it('single unit: unchanged (no peers → own target/direction)', () => {
    const r = effectiveZoneSetpointC({ targetTemperature: 18, capacityW: 2600, heating: false }, []);
    expect(r).toEqual({ targetC: 18, heating: false, yields: false });
  });

  it('aligned units blend CAPACITY-weighted (not a plain average)', () => {
    const r = effectiveZoneSetpointC(
      { targetTemperature: 18, capacityW: 3000, heating: false },
      [{ targetTemperature: 24, capacityW: 1000, heating: false }],
    );
    // (3000·18 + 1000·24)/4000 = 19.5 — not the unweighted 21.
    expect(r.targetC).toBeCloseTo(19.5, 6);
    expect(r.yields).toBe(false);
    expect(r.heating).toBe(false);
  });

  it('a unit opposing the majority capacity yields; aligned side sets the target', () => {
    // 1 kW heater vs two coolers totalling 4 kW → cooling wins; heater yields.
    const heater = effectiveZoneSetpointC(
      { targetTemperature: 26, capacityW: 1000, heating: true },
      [
        { targetTemperature: 18, capacityW: 2600, heating: false },
        { targetTemperature: 20, capacityW: 1400, heating: false },
      ],
    );
    expect(heater.yields).toBe(true);
    expect(heater.heating).toBe(false);
    // Aligned coolers' weighted target: (2600·18 + 1400·20)/4000 = 18.7.
    expect(heater.targetC).toBeCloseTo(18.7, 6);

    // One of the winning coolers keeps running, around the same blend.
    const cooler = effectiveZoneSetpointC(
      { targetTemperature: 18, capacityW: 2600, heating: false },
      [
        { targetTemperature: 20, capacityW: 1400, heating: false },
        { targetTemperature: 26, capacityW: 1000, heating: true },
      ],
    );
    expect(cooler.yields).toBe(false);
    expect(cooler.targetC).toBeCloseTo(18.7, 6);
  });

  it('an exact capacity tie keeps the unit\'s own direction (no majority)', () => {
    const r = effectiveZoneSetpointC(
      { targetTemperature: 20, capacityW: 2000, heating: true },
      [{ targetTemperature: 22, capacityW: 2000, heating: false }],
    );
    expect(r.yields).toBe(false);
    expect(r.heating).toBe(true); // own side wins the tie
    expect(r.targetC).toBeCloseTo(20, 6);
  });
});

describe('T-106 — two HVAC units in one zone (integration)', () => {
  function makeZone(): { env: PhysicalEnvironment; big: SimulatedDevice; small: SimulatedDevice } {
    const time = new TimeManager();
    time.jumpTo(new Date(Date.UTC(2026, 5, 1)));
    const env = new PhysicalEnvironment(time, { environmentNoise: false });
    env.setParameterValue('temperature', 'lab-a', 24);

    const big = new SimulatedDevice({
      id: 'hvac-big',
      name: 'Big HVAC',
      type: 'hvac',
      capabilities: [{ name: 'temperature-control', type: 'write', parameters: [] }],
      initialState: { power: true, targetTemperature: 18, mode: 'cooling' },
      behaviors: [],
      location: 'lab-a',
    });
    big.setPhysicalEnvironment(env);
    const small = new SimulatedDevice({
      id: 'hvac-small',
      name: 'Small HVAC',
      type: 'hvac',
      capabilities: [{ name: 'temperature-control', type: 'write', parameters: [] }],
      initialState: { power: true, targetTemperature: 24, mode: 'cooling' },
      behaviors: [],
      location: 'lab-a',
    });
    small.setPhysicalEnvironment(env);
    return { env, big, small };
  }

  it('both units publish intents and blend capacity-weighted (no unweighted average)', async () => {
    const { env, big, small } = makeZone();
    // Command the units so their effects register (the real path).
    await big.executeCommand('set-temperature', { temperature: 18 });
    await small.executeCommand('set-temperature', { temperature: 24 });
    // T-702 catalog capacities ride the effect magnitude (thermal W); the
    // command's class default is overridden to the units' real ratings.
    const layer = env.getPhysicsLayer()!;
    layer.getDeviceEffect('hvac-big', PhysicalParameter.TEMPERATURE)!.magnitude = -3000;
    layer.getDeviceEffect('hvac-small', PhysicalParameter.TEMPERATURE)!.magnitude = -1000;
    (big.getState() as unknown as Record<string, unknown>).coolingPowerW = 3000;
    (small.getState() as unknown as Record<string, unknown>).coolingPowerW = 1000;
    // One control tick: both publish intents, both decide on the blend.
    big.onPhysicsTick(1);
    small.onPhysicsTick(1);
    // Second tick so each sees the other's published intent.
    big.onPhysicsTick(1);
    small.onPhysicsTick(1);

    const intents = layer.zoneHvacIntents('lab-a', 'nobody');
    expect(intents).toHaveLength(2);
    // Capacity-weighted blend of the PUBLISHED intents is 19.5 (not 21).
    const blend = intents.reduce((acc, i) => acc + i.capacityW * i.targetTemperature, 0)
      / intents.reduce((acc, i) => acc + i.capacityW, 0);
    expect(blend).toBeCloseTo(19.5, 6);

    // The zone settles toward 19.5 (capacity-weighted), NOT 21: after the
    // blend takes over, both units cycle around 19.5.
    for (let i = 0; i < 30; i++) {
      env.simulate(60, 1);
    }
    const t = env.getParameterValue('temperature', 'lab-a') as number;
    expect(t).toBeLessThan(24);
    // With the blend at 19.5 ± 0.5, the zone must land below the old
    // unweighted-average plateau (21).
    expect(t).toBeLessThanOrEqual(21);
  });

  it('a heater opposing a stronger cooling majority yields (effect disabled)', async () => {
    const { env, big, small } = makeZone();
    await big.executeCommand('set-temperature', { temperature: 18 });
    await small.executeCommand('set-temperature', { temperature: 26 });
    // small is a 1 kW heater vs big's 3 kW cooler.
    (big.getState() as unknown as Record<string, unknown>).coolingPowerW = 3000;
    (small.getState() as unknown as Record<string, unknown>).heatingPowerW = 1000;
    // One env pass first so the field knows the zone (the control loop's
    // readLocal must see a temperature, or the policy no-ops).
    env.simulate(1, 1);
    // Small unit becomes a heater at its real 1 kW rating (positive sign).
    const layer = env.getPhysicsLayer()!;
    const smallEffect = layer.getDeviceEffect('hvac-small', PhysicalParameter.TEMPERATURE)!;
    smallEffect.magnitude = 1000;

    big.onPhysicsTick(1);
    small.onPhysicsTick(1);
    big.onPhysicsTick(1);
    small.onPhysicsTick(1);

    const smallAfter = layer.getDeviceEffect('hvac-small', PhysicalParameter.TEMPERATURE)!;
    expect(smallAfter.enabled).toBe(false); // yielded to the cooling majority
    const bigAfter = layer.getDeviceEffect('hvac-big', PhysicalParameter.TEMPERATURE)!;
    expect(bigAfter.enabled).toBe(true); // majority keeps running
  });
});
