/**
 * @vitest-environment node
 *
 * T-105 (DevLoop R32, F-PH05) — interior/exterior distinction for
 * non-baseline zones.
 *
 * R29 measured lab-b / atrium / roof-garden bitwise IDENTICAL to full float
 * precision — every non-baseline zone was a slave of the one global ambient
 * (no envelope, no solar gain for the "Glass Atrium", no adjacency mixing).
 *
 * The distinction now has three author-declarable levers:
 *   - `ambientBuffer` (0..1): a buffered INTERIOR zone relaxes toward its
 *     ambient attractor at a fraction of the generic rate (the shell
 *     low-passes the weather); exterior/outdoor zones stay direct.
 *   - `glassAreaM2`: a glass zone gains heat from the CURRENT solar
 *     radiation (W = solar × area × g 0.45) — warm in afternoon sun,
 *     inert at night.
 *   - `envelopeU` (pre-existing B-B): per-zone coupling to an adjacent
 *     outdoor boundary.
 */

import { describe, it, expect } from 'vitest';

import { SpatialField } from './SpatialField.js';
import { PhysicalParameter } from '../devices/types.js';
import { TimeManager } from '../environment/TimeManager.js';
import { PhysicalEnvironment } from '../environment/PhysicalEnvironment.js';

const ATTRACTOR_25 = () => 25;

describe('T-105 — SpatialField ambient coupling buffer', () => {
  it('a buffered interior zone relaxes toward the ambient SLOWER than a direct twin', () => {
    const field = new SpatialField();
    for (const id of ['direct', 'buffered']) field.registerLocation(id, { x: 0, y: 0 });
    field.registerZoneMetadata('direct', { floor: 0, ambientBuffer: 1 });
    field.registerZoneMetadata('buffered', { floor: 0, ambientBuffer: 0.2 });
    // Both start far from the 25 attractor.
    field.set(PhysicalParameter.HUMIDITY, 'direct', 80);
    field.set(PhysicalParameter.HUMIDITY, 'buffered', 80);

    for (let i = 0; i < 600; i++) field.step(1, ATTRACTOR_25); // 10 sim-min

    const direct = field.get(PhysicalParameter.HUMIDITY, 'direct')!;
    const buffered = field.get(PhysicalParameter.HUMIDITY, 'buffered')!;
    expect(direct).toBeLessThan(80);            // it relaxes...
    expect(buffered).toBeGreaterThan(direct);   // ...but the buffered twin lags
    expect(buffered).toBeLessThan(80);
  });

  it('an outdoor location ignores the buffer (direct weather tracking always)', () => {
    const field = new SpatialField();
    field.registerLocation('roof', { x: 0, y: 0 });
    // Register the buffer FIRST, then flip the zone outdoor — outdoor wins.
    field.registerZoneMetadata('roof', { floor: 0, ambientBuffer: 0.1 });
    field.registerZoneMetadata('roof', { floor: 0, outdoor: true, ambientBuffer: 0.1 });
    field.set(PhysicalParameter.HUMIDITY, 'roof', 80);
    for (let i = 0; i < 600; i++) field.step(1, ATTRACTOR_25);
    const roof = field.get(PhysicalParameter.HUMIDITY, 'roof')!;
    // Direct humidity rate (0.003/s): exponential approach to 25 over 600 s.
    const expectedDirect = 80 + (25 - 80) * (1 - Math.exp(-0.003 * 600));
    // Euler-discrete relaxation (600 × 1 s steps) sits within ~0.03 of the
    // closed form — compare at 1-decimal precision.
    expect(roof).toBeCloseTo(expectedDirect, 1);
  });

  it('the buffer does NOT slow a volume-registered zone\'s physical thermal rate', () => {
    const field = new SpatialField();
    field.registerLocation('core', { x: 0, y: 0 });
    field.registerLocation('buf', { x: 5, y: 0 });
    // Both 1200 m³; buffered declares ambientBuffer 0.1 — irrelevant for
    // the T-701 thermal lane (that rate IS the envelope).
    field.registerZoneMetadata('core', { floor: 0, volumeM3: 1200 });
    field.registerZoneMetadata('buf', { floor: 0, volumeM3: 1200, ambientBuffer: 0.1 });
    field.set(PhysicalParameter.TEMPERATURE, 'core', 30);
    field.set(PhysicalParameter.TEMPERATURE, 'buf', 30);
    for (let i = 0; i < 600; i++) field.step(1, ATTRACTOR_25);
    expect(field.get(PhysicalParameter.TEMPERATURE, 'buf')!)
      .toBeCloseTo(field.get(PhysicalParameter.TEMPERATURE, 'core')!, 6);
  });

  it('glass zones are enumerable for the solar-gain source lane', () => {
    const field = new SpatialField();
    field.registerLocation('atrium', { x: 0, y: 0 });
    field.registerLocation('lab', { x: 9, y: 0 });
    field.registerZoneMetadata('atrium', { floor: 0, glassAreaM2: 120 });
    field.registerZoneMetadata('lab', { floor: 0 });
    expect(field.glassZones()).toEqual([{ locationKey: 'atrium', glassAreaM2: 120 }]);
    expect(field.glassAreaM2Of('lab')).toBeUndefined();
  });
});

describe('T-105 — solar gain for glass zones (PhysicsLayer wiring)', () => {
  function makeGlassWorld(hourOfDay: number): PhysicalEnvironment {
    const time = new TimeManager();
    // peakHour 12 of the solar model; the model reads LOCAL wall hour
    // (Date.getHours), so construct a LOCAL date — Date.UTC would make the
    // mapped hour TZ-dependent (passes in UTC+8, breaks on UTC CI runners).
    time.jumpTo(new Date(2026, 5, 1, hourOfDay, 0, 0));
    const env = new PhysicalEnvironment(time, { environmentNoise: false });
    // Zone locations enter the spatial manager through device-effect areas
    // (the runtime registers zones this way via device placement) — a
    // 0-magnitude probe registers each zone without driving anything.
    for (const zone of ['atrium', 'lab']) {
      env.registerDeviceEffect({
        deviceId: `probe-${zone}`,
        parameter: PhysicalParameter.TEMPERATURE,
        effect: 'heating',
        magnitude: 0,
        affectedArea: { location: zone, radius: 5, position: { x: zone === 'atrium' ? 0 : 9, y: 0 } },
      });
    }
    env.setParameterValue('temperature', 'atrium', 24);
    env.setParameterValue('temperature', 'lab', 24);
    // Two zones at the SAME ambient; only the atrium is glass.
    env.getPhysicsLayer()?.registerZonePhysics('atrium', {
      floor: 0, glassAreaM2: 120, volumeM3: 2000, ambientBuffer: 0.1,
    });
    env.getPhysicsLayer()?.registerZonePhysics('lab', {
      floor: 0, volumeM3: 2000, ambientBuffer: 0.1,
    });
    return env;
  }

  it('midday sun: the glass atrium warms ABOVE its identical non-glass twin', () => {
    const env = makeGlassWorld(12);
    for (let i = 0; i < 10; i++) env.simulate(60, 1); // 10 sim-min
    const atrium = env.getParameterValue('temperature', 'atrium') as number;
    const lab = env.getParameterValue('temperature', 'lab') as number;
    expect(atrium).toBeGreaterThan(lab);
    // No longer bitwise-identical ambient slaves (F-PH05).
    expect(atrium - lab).toBeGreaterThan(0.01);
  });

  it('night: solar gain collapses (glass zone ≈ its twin; far below the midday gap)', () => {
    // Note: the global solar model carries a small night floor, so the
    // night gap is not exactly 0 — it must simply collapse vs midday.
    const run = (hour: number): number => {
      const env = makeGlassWorld(hour);
      for (let i = 0; i < 10; i++) env.simulate(60, 1);
      return Math.abs(
        (env.getParameterValue('temperature', 'atrium') as number) -
        (env.getParameterValue('temperature', 'lab') as number),
      );
    };
    const nightGap = run(1);
    const middayGap = run(12);
    expect(nightGap).toBeLessThan(0.5);
    expect(nightGap).toBeLessThan(middayGap / 2);
  });
});
