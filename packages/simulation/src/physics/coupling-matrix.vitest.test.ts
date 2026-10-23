/**
 * @vitest-environment node
 *
 * R30 Task 2 — the thermal coupling matrix cache (SpatialField).
 *
 * The Fix-43 pair index graduated into a full COUPLING MATRIX: pair
 * identities plus every per-edge coefficient (same-floor geometry, slab /
 * envelope factors, T-701 U·A conductances, per-side thermal masses,
 * per-(pair, parameter) entry keys), derived once per topology epoch.
 *
 * Acceptance:
 *   (a) the matrix is built ONCE per epoch — N steps with no topology
 *       change do not rebuild it (the per-tick loop is matrix × vector);
 *   (b) every topology mutation invalidates: position change, adjacency
 *       change, outdoor flip, envelopeU change, volumeM3 change,
 *       setSlabAttenuation, setEnvelopeU — while IDEMPOTENT
 *       re-registrations (PhysicsLayer.syncFieldLocations re-registers
 *       every location each pass) do NOT;
 *   (c) invalidation is CORRECT: a field whose topology changed mid-run
 *       steps to the same values as a fresh field built with the new
 *       topology;
 *   (d) determinism: two identically-built fields step identically;
 *   (e) physics invariants survive: the isolated two-zone U·A exchange
 *       conserves energy (Σ C·T) across the step.
 */

import { describe, it, expect } from 'vitest';

import { SpatialField, type FieldAttractor } from './SpatialField.js';
import { PhysicalParameter } from '../devices/types.js';

const NO_ATTRACTOR: FieldAttractor = () => undefined;

function campusField(): SpatialField {
  const field = new SpatialField();
  // 2 floors × 2 zones + one shaft + one outdoor envelope neighbor.
  field.registerZoneMetadata('room-1f-a', { floor: 0, volumeM3: 1200, adjacentZoneIds: ['shaft'] });
  field.registerZoneMetadata('room-1f-b', { floor: 0, volumeM3: 900, adjacentZoneIds: ['shaft', 'outdoor'] });
  field.registerZoneMetadata('room-2f-a', { floor: 1, volumeM3: 1200 });
  field.registerZoneMetadata('shaft', { floor: 1, adjacentZoneIds: ['room-1f-a', 'room-1f-b'] });
  field.registerZoneMetadata('outdoor', { floor: 0, outdoor: true });
  field.registerLocation('room-1f-a', { x: 0, y: 0 });
  field.registerLocation('room-1f-b', { x: 3, y: 0 }); // same-floor neighbor
  field.registerLocation('room-2f-a', { x: 0, y: 4 });
  field.registerLocation('shaft', { x: 1.5, y: 0 });
  field.registerLocation('outdoor', { x: 6, y: 0 });

  field.set(PhysicalParameter.TEMPERATURE, 'room-1f-a', 24);
  field.setBaseline(PhysicalParameter.TEMPERATURE, 'room-1f-a', 22);
  field.set(PhysicalParameter.TEMPERATURE, 'room-1f-b', 20);
  field.setBaseline(PhysicalParameter.TEMPERATURE, 'room-1f-b', 22);
  field.set(PhysicalParameter.TEMPERATURE, 'room-2f-a', 26);
  field.setBaseline(PhysicalParameter.TEMPERATURE, 'room-2f-a', 22);
  field.set(PhysicalParameter.TEMPERATURE, 'shaft', 22);
  field.setBaseline(PhysicalParameter.TEMPERATURE, 'shaft', 22);
  field.set(PhysicalParameter.TEMPERATURE, 'outdoor', 35);
  field.setBaseline(PhysicalParameter.TEMPERATURE, 'outdoor', 35);
  field.set(PhysicalParameter.CO2, 'room-1f-a', 800);
  field.setBaseline(PhysicalParameter.CO2, 'room-1f-a', 600);
  field.set(PhysicalParameter.CO2, 'room-1f-b', 500);
  field.setBaseline(PhysicalParameter.CO2, 'room-1f-b', 600);
  return field;
}

describe('R30 Task 2: the thermal coupling matrix cache', () => {
  it('builds the matrix once per epoch — stepping does not rebuild', () => {
    const field = campusField();
    field.step(1, NO_ATTRACTOR); // first step builds the matrix
    const builds = field.matrixRebuilds;
    expect(builds).toBe(1);
    for (let i = 0; i < 50; i++) field.step(1, NO_ATTRACTOR);
    expect(field.matrixRebuilds).toBe(builds);
  });

  it('idempotent location re-registration (syncFieldLocations shape) does not rebuild', () => {
    const field = campusField();
    field.step(1, NO_ATTRACTOR);
    const builds = field.matrixRebuilds;
    // PhysicsLayer re-registers every location EVERY pass.
    for (let i = 0; i < 20; i++) {
      field.registerLocation('room-1f-a', { x: 0, y: 0 });
      field.registerLocation('room-1f-b', { x: 3, y: 0 });
      field.step(1, NO_ATTRACTOR);
    }
    expect(field.matrixRebuilds).toBe(builds);
  });

  it('every topology mutation invalidates the matrix (one rebuild on the next step)', () => {
    const field = campusField();
    field.step(1, NO_ATTRACTOR);
    // The matrix is lazily rebuilt on the next couplingMatrix() read —
    // each mutation below triggers EXACTLY one rebuild on the next step,
    // and no rebuild when nothing changed.
    const stepExpecting = (expected: number): void => {
      field.step(1, NO_ATTRACTOR);
      field.step(1, NO_ATTRACTOR); // second step reuses the fresh matrix
      expect(field.matrixRebuilds).toBe(expected);
    };

    field.registerLocation('room-1f-a', { x: 0.5, y: 0 }); // position change
    stepExpecting(2);

    field.registerZoneMetadata('room-1f-a', { adjacentZoneIds: ['room-2f-a'] });
    stepExpecting(3);

    field.registerZoneMetadata('room-2f-a', { outdoor: true });
    stepExpecting(4);

    field.registerZoneMetadata('room-1f-b', { envelopeU: 0.3 });
    stepExpecting(5);

    field.registerZoneMetadata('room-1f-b', { volumeM3: 1500 });
    stepExpecting(6);

    field.setSlabAttenuation(0.2);
    stepExpecting(7);

    field.setEnvelopeU(0.25);
    stepExpecting(8);

    // Same-value re-writes are change-guarded no-ops.
    field.setSlabAttenuation(0.2);
    field.registerZoneMetadata('room-1f-b', { volumeM3: 1500 });
    field.registerLocation('room-1f-a', { x: 0.5, y: 0 });
    stepExpecting(8);
  });

  it('a mid-run topology change steps to the same values as a fresh field with the new topology', () => {
    // Arm A: build, step 10, CHANGE topology (zone moves away — edge gone),
    // step 10 more.
    const armA = campusField();
    for (let i = 0; i < 10; i++) armA.step(1, NO_ATTRACTOR);
    armA.registerLocation('room-1f-b', { x: 50, y: 50 }); // out of coupling range
    for (let i = 0; i < 10; i++) armA.step(1, NO_ATTRACTOR);

    // Arm B: a FRESH field with the post-change topology from the start,
    // stepped 20 — invalidation correctness means the coupling history of
    // the first 10 steps must match a world where the edge never existed.
    // (The first 10 steps of arm A DID have the edge, so compare against a
    // fresh field whose first 10 steps also ran with the edge: instead we
    // assert the weaker, still-meaningful property — after the change, the
    // next step uses the NEW coefficients, i.e. equals a fresh field built
    // at that moment.)
    const snapshotT = (f: SpatialField): number[] => [
      f.get(PhysicalParameter.TEMPERATURE, 'room-1f-a')!,
      f.get(PhysicalParameter.TEMPERATURE, 'room-1f-b')!,
      f.get(PhysicalParameter.TEMPERATURE, 'room-2f-a')!,
      f.get(PhysicalParameter.TEMPERATURE, 'shaft')!,
    ];

    const armC = new SpatialField();
    // Clone arm A's post-change topology + values into a fresh field.
    armC.registerZoneMetadata('room-1f-a', { floor: 0, volumeM3: 1200, adjacentZoneIds: ['shaft'] });
    armC.registerZoneMetadata('room-1f-b', { floor: 0, volumeM3: 900, adjacentZoneIds: ['shaft', 'outdoor'] });
    armC.registerZoneMetadata('room-2f-a', { floor: 1, volumeM3: 1200 });
    armC.registerZoneMetadata('shaft', { floor: 1, adjacentZoneIds: ['room-1f-a', 'room-1f-b'] });
    armC.registerZoneMetadata('outdoor', { floor: 0, outdoor: true });
    armC.registerLocation('room-1f-a', { x: 0, y: 0 });
    armC.registerLocation('room-1f-b', { x: 50, y: 50 });
    armC.registerLocation('room-2f-a', { x: 0, y: 4 });
    armC.registerLocation('shaft', { x: 1.5, y: 0 });
    armC.registerLocation('outdoor', { x: 6, y: 0 });
    for (const [loc, base] of [
      ['room-1f-a', 22], ['room-1f-b', 22], ['room-2f-a', 22], ['shaft', 22], ['outdoor', 35],
    ] as const) {
      armC.set(PhysicalParameter.TEMPERATURE, loc, armA.get(PhysicalParameter.TEMPERATURE, loc)!);
      armC.setBaseline(PhysicalParameter.TEMPERATURE, loc, base);
    }
    armC.set(PhysicalParameter.CO2, 'room-1f-a', armA.get(PhysicalParameter.CO2, 'room-1f-a')!);
    armC.setBaseline(PhysicalParameter.CO2, 'room-1f-a', 600);
    armC.set(PhysicalParameter.CO2, 'room-1f-b', armA.get(PhysicalParameter.CO2, 'room-1f-b')!);
    armC.setBaseline(PhysicalParameter.CO2, 'room-1f-b', 600);

    armA.step(1, NO_ATTRACTOR);
    armC.step(1, NO_ATTRACTOR);
    expect(snapshotT(armA)).toEqual(snapshotT(armC));
  });

  it('determinism: two identically-built fields step identically', () => {
    const a = campusField();
    const b = campusField();
    for (let i = 0; i < 40; i++) {
      a.step(1, NO_ATTRACTOR);
      b.step(1, NO_ATTRACTOR);
    }
    for (const loc of ['room-1f-a', 'room-1f-b', 'room-2f-a', 'shaft']) {
      expect(a.get(PhysicalParameter.TEMPERATURE, loc))
        .toBe(b.get(PhysicalParameter.TEMPERATURE, loc));
      expect(a.get(PhysicalParameter.CO2, loc)).toBe(b.get(PhysicalParameter.CO2, loc));
    }
  });

  it('the isolated U·A exchange conserves energy (Σ C·T constant)', () => {
    const field = new SpatialField();
    field.registerZoneMetadata('hot', { floor: 0, volumeM3: 1000 });
    field.registerZoneMetadata('cold', { floor: 0, volumeM3: 1000 });
    field.registerLocation('hot', { x: 0, y: 0 });
    field.registerLocation('cold', { x: 2, y: 0 });
    field.set(PhysicalParameter.TEMPERATURE, 'hot', 30);
    field.set(PhysicalParameter.TEMPERATURE, 'cold', 20);

    const energy = (): number =>
      (field.get(PhysicalParameter.TEMPERATURE, 'hot')! +
        field.get(PhysicalParameter.TEMPERATURE, 'cold')!) * 1000; // equal C both sides

    const before = energy();
    for (let i = 0; i < 100; i++) field.step(1, NO_ATTRACTOR);
    expect(Math.abs(energy() - before)).toBeLessThan(1e-6);
    // And the exchange actually happened (temperatures converged a bit).
    const tHot = field.get(PhysicalParameter.TEMPERATURE, 'hot')!;
    expect(tHot).toBeGreaterThan(20);
    expect(tHot).toBeLessThan(30);
  });
});
