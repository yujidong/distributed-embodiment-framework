/**
 * @vitest-environment node
 *
 * SpatialField unit tests — the physics layer's per-location field store.
 * Covers point writes, localized (falloff) writes, relaxation toward
 * baselines/attractors, diffusion between nearby locations, safety-net
 * clamping, and global-write invalidation.
 */

import { describe, it, expect } from 'vitest';

import { SpatialField, clampFieldValue, type FieldAttractor } from './SpatialField.js';
import { PhysicalParameter } from '../devices/types.js';

const ZERO_ATTRACTOR: FieldAttractor = () => 0;
const NO_ATTRACTOR: FieldAttractor = () => undefined;

function makeField(): SpatialField {
  const field = new SpatialField();
  field.registerLocation('kitchen', { x: 0, y: 0 });
  field.registerLocation('dining', { x: 3, y: 0 }); // 3 m — inside coupling range
  field.registerLocation('study', { x: 10, y: 0 }); // 10 m — outside coupling range
  return field;
}

describe('SpatialField', () => {
  it('stores per-(parameter, location) values independently', () => {
    const field = makeField();
    field.set(PhysicalParameter.TEMPERATURE, 'kitchen', 31.5);
    field.set(PhysicalParameter.TEMPERATURE, 'dining', 22);

    expect(field.get(PhysicalParameter.TEMPERATURE, 'kitchen')).toBe(31.5);
    expect(field.get(PhysicalParameter.TEMPERATURE, 'dining')).toBe(22);
    expect(field.get(PhysicalParameter.TEMPERATURE, 'study')).toBeUndefined();
  });

  it('clamps values to physical ranges on write', () => {
    const field = makeField();
    field.set(PhysicalParameter.TEMPERATURE, 'kitchen', -500);
    field.set(PhysicalParameter.TEMPERATURE, 'dining', 500);
    expect(field.get(PhysicalParameter.TEMPERATURE, 'kitchen')).toBe(-60);
    expect(field.get(PhysicalParameter.TEMPERATURE, 'dining')).toBe(100);
    expect(clampFieldValue(PhysicalParameter.HUMIDITY, 140)).toBe(100);
    expect(clampFieldValue('voc', 1e9)).toBe(1e9); // unclamped parameter
  });

  it('relaxation pulls values toward the seeded per-location baseline', () => {
    const field = makeField();
    field.setBaseline(PhysicalParameter.TEMPERATURE, 'kitchen', 20);
    field.set(PhysicalParameter.TEMPERATURE, 'kitchen', 30);

    field.step(1, NO_ATTRACTOR); // rate 0.0004/s → 30 + (20-30)*0.0004
    expect(field.get(PhysicalParameter.TEMPERATURE, 'kitchen')).toBeCloseTo(29.996, 5);
  });

  it('relaxation uses the attractor when no per-location baseline exists', () => {
    // Bare field: no registered positions → no diffusion, pure relaxation.
    const field = new SpatialField();
    field.set(PhysicalParameter.SMOKE, 'kitchen', 0.75);

    field.step(1, ZERO_ATTRACTOR); // smoke rate 0.01/s toward 0
    expect(field.get(PhysicalParameter.SMOKE, 'kitchen')).toBeCloseTo(0.7425, 5);
  });

  it('localized writes spill over with distance-based falloff', () => {
    const field = makeField();
    field.setBaseline(PhysicalParameter.SMOKE, 'kitchen', 0);
    field.setBaseline(PhysicalParameter.SMOKE, 'dining', 0);
    // Source at kitchen, radius 5: dining (3 m) gets delta * (1 - 3/5).
    field.setLocalized(PhysicalParameter.SMOKE, 'kitchen', 1.0, 5, ZERO_ATTRACTOR);

    expect(field.get(PhysicalParameter.SMOKE, 'kitchen')).toBeCloseTo(1.0, 10);
    expect(field.get(PhysicalParameter.SMOKE, 'dining')).toBeCloseTo(0.4, 5);
    // Study is outside the write radius: untouched.
    expect(field.get(PhysicalParameter.SMOKE, 'study')).toBeUndefined();
  });

  it('diffusion spreads value to nearby locations but not distant ones', () => {
    const field = makeField();
    field.set(PhysicalParameter.SMOKE, 'kitchen', 1.0);

    // One 1-second step: dining (3 m, inside range) gains, study (10 m) does not.
    field.step(1, ZERO_ATTRACTOR);
    const dining = field.get(PhysicalParameter.SMOKE, 'dining');
    expect(dining).toBeDefined();
    expect(dining!).toBeGreaterThan(0);
    expect(field.get(PhysicalParameter.SMOKE, 'study')).toBeUndefined();
    // Kitchen lost what dining gained (pairwise exchange).
    expect(field.get(PhysicalParameter.SMOKE, 'kitchen')!).toBeLessThan(1.0);
  });

  it('clearParameter drops field values but keeps seeded baselines', () => {
    const field = makeField();
    field.setBaseline(PhysicalParameter.TEMPERATURE, 'kitchen', 20);
    field.set(PhysicalParameter.TEMPERATURE, 'kitchen', 30);
    field.set(PhysicalParameter.HUMIDITY, 'kitchen', 80);

    field.clearParameter(PhysicalParameter.TEMPERATURE);
    // Value reset to baseline (relaxation continues from a sane point)…
    expect(field.get(PhysicalParameter.TEMPERATURE, 'kitchen')).toBe(20);
    // …and other parameters are untouched.
    expect(field.get(PhysicalParameter.HUMIDITY, 'kitchen')).toBe(80);
  });
});

/**
 * Floor-aware coupling (building tier, B-A): two stacked storeys, same
 * floor plan. room-f1 sits directly above room-f0 (3.5 m slab); shaft-f0 /
 * shaft-f1 are the declared vertical connection.
 */
function makeStackedField(): SpatialField {
  const field = new SpatialField();
  field.registerLocation('room-f0', { x: 0, y: 0, z: 0 });
  field.registerLocation('room-f1', { x: 0, y: 0, z: 3.5 }); // directly above
  field.registerLocation('mate-f0', { x: 3, y: 0, z: 0 }); // same-floor neighbor
  field.registerLocation('shaft-f0', { x: 6, y: 0, z: 0 });
  field.registerLocation('shaft-f1', { x: 6, y: 0, z: 3.5 });
  field.registerZoneMetadata('room-f0', { floor: 0, adjacentZoneIds: ['mate-f0', 'shaft-f0'] });
  field.registerZoneMetadata('room-f1', { floor: 1, adjacentZoneIds: [] });
  field.registerZoneMetadata('mate-f0', { floor: 0, adjacentZoneIds: ['room-f0'] });
  field.registerZoneMetadata('shaft-f0', { floor: 0, adjacentZoneIds: ['room-f0', 'shaft-f1'] });
  field.registerZoneMetadata('shaft-f1', { floor: 1, adjacentZoneIds: ['shaft-f0'] });
  return field;
}

describe('SpatialField — floor-aware coupling (B-A)', () => {
  it('same-floor diffusion keeps the legacy 2D behavior (z is ignored)', () => {
    const field = makeStackedField();
    field.set(PhysicalParameter.SMOKE, 'room-f0', 1.0);

    field.step(1, ZERO_ATTRACTOR);

    // mate-f0 (3 m, same floor) gains exactly like the 2D case.
    expect(field.get(PhysicalParameter.SMOKE, 'mate-f0')!).toBeGreaterThan(0);
    // shaft-f0 is 6 m away on the same floor: outside the 5 m range (a
    // two-hop trace via mate-f0 may materialize a negligible entry).
    expect(field.get(PhysicalParameter.SMOKE, 'shaft-f0') ?? 0).toBeLessThan(0.001);
  });

  it('non-interconnected cross-floor pairs NEVER couple (slab insulates)', () => {
    const field = makeStackedField();
    field.set(PhysicalParameter.SMOKE, 'room-f0', 1.0);

    field.step(1, ZERO_ATTRACTOR);

    // room-f1 is directly above (0 m in plan, 3.5 m up): the old 3D rule
    // would have coupled them strongly; the floor rule forbids it.
    expect(field.get(PhysicalParameter.SMOKE, 'room-f1')).toBeUndefined();
  });

  it('declared shaft zones couple across floors, attenuated by the slab factor', () => {
    const field = makeStackedField();
    field.set(PhysicalParameter.TEMPERATURE, 'shaft-f0', 30);
    field.set(PhysicalParameter.TEMPERATURE, 'shaft-f1', 20);

    field.step(1, NO_ATTRACTOR);

    // temperature k = 0.0015/s, slab 0.15 → flux = 0.0015 * 10 * 0.15.
    const expectedFlux = 0.0015 * 10 * 0.15;
    expect(field.get(PhysicalParameter.TEMPERATURE, 'shaft-f0')!).toBeCloseTo(30 - expectedFlux, 8);
    expect(field.get(PhysicalParameter.TEMPERATURE, 'shaft-f1')!).toBeCloseTo(20 + expectedFlux, 8);
  });

  it('cross-floor flux is much smaller than an equivalent same-floor exchange', () => {
    // Same pair, once cross-floor (declared), once same-floor at 0 m.
    const cross = makeStackedField();
    cross.set(PhysicalParameter.TEMPERATURE, 'shaft-f0', 30);
    cross.set(PhysicalParameter.TEMPERATURE, 'shaft-f1', 20);
    cross.step(1, NO_ATTRACTOR);
    const crossGain = cross.get(PhysicalParameter.TEMPERATURE, 'shaft-f1')! - 20;

    const same = new SpatialField();
    same.registerLocation('a', { x: 0, y: 0 });
    same.registerLocation('b', { x: 0, y: 0 });
    same.set(PhysicalParameter.TEMPERATURE, 'a', 30);
    same.set(PhysicalParameter.TEMPERATURE, 'b', 20);
    same.step(1, NO_ATTRACTOR);
    const sameGain = same.get(PhysicalParameter.TEMPERATURE, 'b')! - 20;

    expect(crossGain).toBeGreaterThan(0);
    expect(crossGain).toBeLessThan(sameGain * 0.5);
  });

  it('one-sided adjacency declarations still couple (loader symmetrizes; field tolerates)', () => {
    const field = new SpatialField();
    field.registerLocation('below', { x: 0, y: 0, z: 0 });
    field.registerLocation('above', { x: 0, y: 0, z: 3.5 });
    // Only 'below' declares the connection.
    field.registerZoneMetadata('below', { floor: 0, adjacentZoneIds: ['above'] });
    field.registerZoneMetadata('above', { floor: 1, adjacentZoneIds: [] });
    field.set(PhysicalParameter.SMOKE, 'below', 1.0);

    field.step(1, ZERO_ATTRACTOR);
    expect(field.get(PhysicalParameter.SMOKE, 'above')!).toBeGreaterThan(0);
  });

  it('slab attenuation is overridable per instance and at runtime', () => {
    const viaRates = new SpatialField({ slabAttenuation: 1 });
    viaRates.registerLocation('below', { x: 0, y: 0, z: 0 });
    viaRates.registerLocation('above', { x: 0, y: 0, z: 3.5 });
    viaRates.registerZoneMetadata('below', { floor: 0, adjacentZoneIds: ['above'] });
    viaRates.registerZoneMetadata('above', { floor: 1 });
    viaRates.set(PhysicalParameter.TEMPERATURE, 'below', 30);
    viaRates.set(PhysicalParameter.TEMPERATURE, 'above', 20);
    viaRates.step(1, NO_ATTRACTOR);
    // slab = 1 → full-strength exchange: flux = 0.0015 * 10.
    expect(viaRates.get(PhysicalParameter.TEMPERATURE, 'above')!).toBeCloseTo(20 + 0.0015 * 10, 8);

    const viaSetter = makeStackedField();
    viaSetter.setSlabAttenuation(0); // perfect insulation even for shafts
    viaSetter.set(PhysicalParameter.TEMPERATURE, 'shaft-f0', 30);
    viaSetter.set(PhysicalParameter.TEMPERATURE, 'shaft-f1', 20);
    viaSetter.step(1, NO_ATTRACTOR);
    expect(viaSetter.get(PhysicalParameter.TEMPERATURE, 'shaft-f1')!).toBe(20);
  });

  it('localized spillover does not cross the slab', () => {
    const field = makeStackedField();
    field.setBaseline(PhysicalParameter.SMOKE, 'room-f0', 0);
    field.setBaseline(PhysicalParameter.SMOKE, 'room-f1', 0);
    field.setBaseline(PhysicalParameter.SMOKE, 'mate-f0', 0);

    field.setLocalized(PhysicalParameter.SMOKE, 'room-f0', 1.0, 5, ZERO_ATTRACTOR);

    // Same-floor neighbor (3 m) spills; the room directly above (0 m in
    // plan) does not, even though it is inside the radius.
    expect(field.get(PhysicalParameter.SMOKE, 'mate-f0')!).toBeCloseTo(0.4, 5);
    expect(field.get(PhysicalParameter.SMOKE, 'room-f1')).toBe(0); // baseline only
  });
});

// ---------------------------------------------------------------------------
// Outdoor boundary & envelope coupling (building tier, B-B)
// ---------------------------------------------------------------------------

/**
 * An indoor room with a declared connection to an outdoor boundary, plus an
 * interior zone that sits INSIDE the 5 m coupling range of outdoor but does
 * NOT declare adjacency (a room facing away from the weather).
 */
function makeEnvelopeField(): SpatialField {
  const field = new SpatialField();
  field.registerLocation('room', { x: 0, y: 0 });
  field.registerLocation('interior', { x: 3, y: 0 });
  field.registerLocation('outdoor', { x: 4, y: 0 });
  field.registerZoneMetadata('room', { floor: 0, adjacentZoneIds: ['outdoor', 'interior'] });
  field.registerZoneMetadata('interior', { floor: 0, adjacentZoneIds: ['room'] });
  field.registerZoneMetadata('outdoor', { outdoor: true });
  return field;
}

describe('SpatialField — outdoor boundary & envelope coupling (B-B)', () => {
  it('outdoor is never dragged by indoor diffusion (one-way envelope exchange)', () => {
    const field = makeEnvelopeField();
    field.set(PhysicalParameter.TEMPERATURE, 'room', 40);
    field.set(PhysicalParameter.TEMPERATURE, 'interior', 40);
    field.set(PhysicalParameter.TEMPERATURE, 'outdoor', 20);

    field.step(1, NO_ATTRACTOR);

    // The outdoor boundary absorbs nothing from the building.
    expect(field.get(PhysicalParameter.TEMPERATURE, 'outdoor')).toBe(20);
    // The adjacent room loses heat through the envelope:
    // flux = 0.0015 * (20 - 40) * 0.1 = -0.003.
    expect(field.get(PhysicalParameter.TEMPERATURE, 'room')!).toBeCloseTo(40 - 0.003, 5);
  });

  it('a declared indoor↔outdoor pair couples at the envelope factor (default 0.1)', () => {
    const field = makeEnvelopeField();
    field.set(PhysicalParameter.TEMPERATURE, 'room', 20);
    field.set(PhysicalParameter.TEMPERATURE, 'interior', 20);
    field.set(PhysicalParameter.TEMPERATURE, 'outdoor', 35);

    field.step(1, NO_ATTRACTOR);

    // flux = k * ΔT * envelopeU = 0.0015 * 15 * 0.1.
    const envelopeGain = 0.0015 * 15 * 0.1;
    expect(field.get(PhysicalParameter.TEMPERATURE, 'room')!).toBeCloseTo(20 + envelopeGain, 5);
    // …far slower than an open same-floor doorway at distance 0 (k * ΔT).
    expect(envelopeGain).toBeLessThan(0.0015 * 15 * 0.5);
  });

  it('a non-adjacent indoor zone never exchanges with outdoor — even inside the 5 m range', () => {
    // interior is 1 m from outdoor (distance-based coupling would hit it
    // hard) but declares no adjacency: the envelope seals it off.
    const field = new SpatialField();
    field.registerLocation('interior', { x: 3, y: 0 });
    field.registerLocation('outdoor', { x: 4, y: 0 });
    field.registerZoneMetadata('interior', { floor: 0, adjacentZoneIds: [] });
    field.registerZoneMetadata('outdoor', { outdoor: true });
    field.set(PhysicalParameter.TEMPERATURE, 'interior', 20);
    field.set(PhysicalParameter.TEMPERATURE, 'outdoor', 35);

    field.step(1, NO_ATTRACTOR);

    expect(field.get(PhysicalParameter.TEMPERATURE, 'interior')).toBe(20);
    expect(field.get(PhysicalParameter.TEMPERATURE, 'outdoor')).toBe(35);
  });

  it('two outdoor boundaries never exchange with each other', () => {
    const field = new SpatialField();
    field.registerLocation('outdoor-a', { x: 0, y: 0 });
    field.registerLocation('outdoor-b', { x: 1, y: 0 });
    field.registerZoneMetadata('outdoor-a', { outdoor: true, adjacentZoneIds: ['outdoor-b'] });
    field.registerZoneMetadata('outdoor-b', { outdoor: true });
    field.set(PhysicalParameter.TEMPERATURE, 'outdoor-a', 35);
    field.set(PhysicalParameter.TEMPERATURE, 'outdoor-b', 20);

    field.step(1, NO_ATTRACTOR);

    expect(field.get(PhysicalParameter.TEMPERATURE, 'outdoor-a')).toBe(35);
    expect(field.get(PhysicalParameter.TEMPERATURE, 'outdoor-b')).toBe(20);
  });

  it('envelope factor override chain: zone metadata > runtime override > default', () => {
    // Runtime override (scenario meta) applies when the zone has none.
    const viaRuntime = makeEnvelopeField();
    viaRuntime.setEnvelopeU(0.5);
    viaRuntime.set(PhysicalParameter.TEMPERATURE, 'room', 20);
    viaRuntime.set(PhysicalParameter.TEMPERATURE, 'outdoor', 35);
    viaRuntime.step(1, NO_ATTRACTOR);
    expect(viaRuntime.get(PhysicalParameter.TEMPERATURE, 'room')!).toBeCloseTo(20 + 0.0015 * 15 * 0.5, 8);

    // Per-zone metadata wins over the runtime override.
    const viaZone = makeEnvelopeField();
    viaZone.setEnvelopeU(0.5);
    viaZone.registerZoneMetadata('room', { envelopeU: 0.02 });
    viaZone.set(PhysicalParameter.TEMPERATURE, 'room', 20);
    viaZone.set(PhysicalParameter.TEMPERATURE, 'outdoor', 35);
    viaZone.step(1, NO_ATTRACTOR);
    expect(viaZone.get(PhysicalParameter.TEMPERATURE, 'room')!).toBeCloseTo(20 + 0.0015 * 15 * 0.02, 8);
  });

  it('localized writes on outdoor do not spill into adjacent indoor zones', () => {
    const field = makeEnvelopeField();
    field.setBaseline(PhysicalParameter.SMOKE, 'room', 0);
    field.setBaseline(PhysicalParameter.SMOKE, 'interior', 0);

    // A 5 m write on outdoor covers both indoor zones geometrically, but
    // spillover only travels same-floor — envelope pairs are excluded.
    field.setLocalized(PhysicalParameter.SMOKE, 'outdoor', 1.0, 5, ZERO_ATTRACTOR);

    expect(field.get(PhysicalParameter.SMOKE, 'outdoor')).toBe(1.0);
    expect(field.get(PhysicalParameter.SMOKE, 'room')).toBe(0); // baseline only
    expect(field.get(PhysicalParameter.SMOKE, 'interior')).toBe(0);
  });

  // UX-15: occupancy counters are LATCHED — a headcount is a fact, not a
  // concentration; field entries for occupancy/people_count never relax
  // toward a baseline/attractor.
  it('occupancy and people_count entries never relax (latched headcounts)', () => {
    const field = new SpatialField();
    // Baseline-declared occupancy (300) above the attractor (2): without
    // the latch it decayed exponentially at the generic 0.005/s rate.
    field.setBaseline(PhysicalParameter.OCCUPANCY, 'gym', 300);
    field.set(PhysicalParameter.OCCUPANCY, 'gym', 300);
    field.set(PhysicalParameter.PEOPLE_COUNT, 'hall', 150);
    // Control: an ordinary parameter at the same offset DOES relax.
    field.set(PhysicalParameter.CO2, 'gym', 300);

    for (let t = 0; t < 400; t++) field.step(1, ZERO_ATTRACTOR);

    expect(field.get(PhysicalParameter.OCCUPANCY, 'gym')).toBe(300);
    expect(field.get(PhysicalParameter.PEOPLE_COUNT, 'hall')).toBe(150);
    // Control decayed 400 s × 0.005/s toward 0 (≈13.5% left).
    expect(field.get(PhysicalParameter.CO2, 'gym')!).toBeLessThan(100);
  });

  it('a runtime relaxation-rate override wins over module constants (FEAT-03)', () => {
    const field = new SpatialField();
    field.setRelaxationRate('gas', 0.01);
    field.set('gas', 'lab', 100);
    field.step(1, ZERO_ATTRACTOR); // 100 + (0-100)*0.01*1
    expect(field.get('gas', 'lab')).toBeCloseTo(99, 8);
  });
});
