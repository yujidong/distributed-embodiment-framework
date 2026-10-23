import { describe, it, expect } from 'vitest';
import { EngineRuntime } from './EngineRuntime.js';
import { loadScenarioFile } from '../scenario/scenario-loader.js';

/**
 * R101-capability-command-handler-gap (P0, chen-15): `ventilation` and
 * `emergency-broadcast` were DECLARED on real devices but dispatched to
 * nothing — AC fulfillment actuated them and every command came back
 * "no handler / no effect" while the collaboration reported success.
 * The handlers now exist (EmergencyStoryCommandHandler) and the
 * ventilation command drives a real T-707 air_flow effect.
 */
describe('EngineRuntime — R101 emergency-story actuation (chen-15, P0)', () => {
  const runtimes: EngineRuntime[] = [];

  function ventScenario() {
    return loadScenarioFile({
      version: '1.0',
      meta: { id: 'runtime-emergency-story', name: 'Runtime Emergency Story' },
      zones: [
        // Bounds-less on purpose — the simtest building (chen-15) declares
        // no zone bounds; the ventilation effect must not depend on geometry.
        { id: 'lab-102', baseline: { temperature: 25, co2: 800 } },
      ],
      devices: [
        { id: 'fresh-air-1', name: '新风空调', type: 'hvac', capabilities: ['ventilation', 'cooling'], zoneId: 'lab-102' },
        { id: 'speaker-1', name: '应急广播音箱', type: 'speaker', capabilities: ['emergency-broadcast'], zoneId: 'lab-102' },
      ],
      agents: [
        {
          id: 'steward',
          name: 'Steward',
          capabilities: ['ventilation', 'emergency-broadcast'],
          managesZoneIds: ['lab-102'],
          boundDeviceIds: ['fresh-air-1', 'speaker-1'],
        },
      ],
      events: [
        { id: 'ev-co2', type: 'air-quality', zoneId: 'lab-102', parameter: 'co2', value: 1500, atSimTimeSec: 10 },
      ],
    });
  }

  const zoneCo2 = (runtime: EngineRuntime) =>
    runtime.getSnapshot().zones.find(z => z.id === 'lab-102')!.parameters.co2 as number;
  const deviceState = (runtime: EngineRuntime, id: string) =>
    runtime.getSnapshot().devices.find(d => d.id === id)!.state;

  it('the ventilation command EXECUTES and physically clears CO2 below its baseline toward outdoor', async () => {
    const ventilated = new EngineRuntime(ventScenario());
    runtimes.push(ventilated);
    const control = new EngineRuntime(ventScenario());
    runtimes.push(control);

    await ventilated.step(20);
    await control.step(20);
    expect(zoneCo2(ventilated)).toBeGreaterThan(1200); // the event landed

    // The chen-15 fulfillment command — previously "no handler / no effect".
    const result = await ventilated.executeDeviceCommand('fresh-air-1', 'ventilation');
    expect(result.success).toBe(true);
    expect(deviceState(ventilated, 'fresh-air-1').mode).toBe('ventilation');

    await ventilated.step(3600);
    await control.step(3600);

    // The ventilated zone exchanges air toward OUTDOOR (420) — far below
    // the zone's own 800 baseline the control relaxes back to. Before the
    // handler this was a silent no-op and both arms read ~800.
    expect(zoneCo2(control)).toBeGreaterThan(700);
    expect(zoneCo2(ventilated)).toBeLessThan(600);
    expect(zoneCo2(ventilated)).toBeLessThan(zoneCo2(control));

    // turn-off unregisters the air exchange (standard effect-disable path).
    await ventilated.executeDeviceCommand('fresh-air-1', 'turn-off');
    await ventilated.step(1800);
    expect(zoneCo2(ventilated)).toBeGreaterThan(420); // no infinite flush
  }, 30_000);

  it('the emergency-broadcast command EXECUTES and raises an auditable alert on the device', async () => {
    const runtime = new EngineRuntime(ventScenario());
    runtimes.push(runtime);

    const result = await runtime.executeDeviceCommand('speaker-1', 'emergency-broadcast', {
      message: 'smoke in lab-102',
    });
    expect(result.success).toBe(true);
    const state = deviceState(runtime, 'speaker-1');
    expect(state.alert).toBe(true);
    expect(state.broadcasting).toBe(true);
    expect((state.lastBroadcast as Record<string, unknown>).message).toBe('smoke in lab-102');
  });
});
