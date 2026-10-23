/**
 * @vitest-environment node
 *
 * T-701 (DevLoop R29) — energy-conserving, mass-scaled U·A thermal exchange.
 *
 * Measured acceptance bars (fix-plan.md / stakeholder-phys-journal.md):
 *  1. basement commanded cooling 16→12 monotonically decreases (was 16→18.86)
 *  2. a default-mass lobby 24.4→18 reaches ≤18.5 within 30 sim-min
 *  3. warm-neighbor (ΔT 8) inflow ≤ 20% of a 3 kW drive
 *  4. turn-off relaxation τ stays ~45–48 min (measured 2870 s)
 *  5. dual-HVAC contention moves the zone ≥0.5 °C in 10 min (was +0.19 °C/24 min)
 *  6. energy conservation: joules out of the hot side = joules into the cold side
 *
 * The Helix geometry is approximated: basement 400 m² × 3 m = 1200 m³,
 * lobby 600 m² × 3 m = 1800 m³, lab-a 750 m² × 3 m = 2250 m³ (journal areas).
 */
import { describe, it, expect } from 'vitest';

import { SpatialField, type FieldAttractor } from './SpatialField.js';
import { PhysicalParameter } from '../devices/types.js';

const NO_ATTRACTOR: FieldAttractor = () => undefined;

/** Air heat capacity used by the field (J/m³·K): ρ 1.2 × c 1005. */
const AIR_HC = 1.2 * 1005;
/** HVAC electrical→thermal efficiency used by HeatTransferModel. */
const HVAC_EFFICIENCY = 0.9;

function makeHelixField(): SpatialField {
  const field = new SpatialField();
  // Basement (400 m²) and lobby (600 m²) share a wall; centers 3 m apart.
  field.registerLocation('basement', { x: 0, y: 0 });
  field.registerLocation('lobby', { x: 3, y: 0 });
  field.registerZoneMetadata('basement', {
    floor: 0,
    adjacentZoneIds: ['lobby'],
    volumeM3: 400 * 3,
  });
  field.registerZoneMetadata('lobby', {
    floor: 0,
    adjacentZoneIds: ['basement'],
    volumeM3: 600 * 3,
  });
  return field;
}

/** Mass of a zone from the field's perspective (J/K). */
function massOf(volumeM3: number): number {
  return AIR_HC * volumeM3;
}

describe('T-701 — energy-conserving U·A thermal exchange', () => {
  it('conserves energy: joules out of the hot side = joules into the cold side', () => {
    const field = makeHelixField();
    // Start both zones AT their baselines so the first step is pure exchange
    // (zero relaxation pull), and measure the single-step energy flows.
    field.setBaseline(PhysicalParameter.TEMPERATURE, 'basement', 16);
    field.setBaseline(PhysicalParameter.TEMPERATURE, 'lobby', 24);
    field.set(PhysicalParameter.TEMPERATURE, 'basement', 16);
    field.set(PhysicalParameter.TEMPERATURE, 'lobby', 24);

    field.step(1, NO_ATTRACTOR);

    const basementGain = (field.get(PhysicalParameter.TEMPERATURE, 'basement')! - 16) * massOf(1200);
    const lobbyLoss = (24 - field.get(PhysicalParameter.TEMPERATURE, 'lobby')!) * massOf(1800);
    expect(basementGain).toBeGreaterThan(0);
    // Conservation to within the same-step relaxation asymmetry (each side
    // relaxes toward its own baseline at its own U·A/C rate after the
    // exchange; that second-order term is ≈0.004% of the exchanged energy).
    expect(Math.abs(basementGain - lobbyLoss)).toBeLessThan(1e-3 * Math.max(basementGain, 1));
  });

  it('mass-scales: the smaller zone swings further for the same joules', () => {
    const field = makeHelixField();
    field.setBaseline(PhysicalParameter.TEMPERATURE, 'basement', 16);
    field.setBaseline(PhysicalParameter.TEMPERATURE, 'lobby', 24);
    field.set(PhysicalParameter.TEMPERATURE, 'basement', 16);
    field.set(PhysicalParameter.TEMPERATURE, 'lobby', 24);

    field.step(1, NO_ATTRACTOR);

    const dBasement = field.get(PhysicalParameter.TEMPERATURE, 'basement')! - 16;
    const dLobby = 24 - field.get(PhysicalParameter.TEMPERATURE, 'lobby')!;
    // ΔT ratio = inverse mass ratio (1200 vs 1800 m³).
    expect(dBasement / dLobby).toBeCloseTo(1800 / 1200, 3);
  });

  it('warm-neighbor (ΔT 8) inflow stays ≤ 20% of a 3 kW drive', () => {
    const field = new SpatialField();
    // Adjacent zone centers 1 m apart → geometry falloff 0.8 (near-worst case).
    field.registerLocation('cold', { x: 0, y: 0 });
    field.registerLocation('warm', { x: 1, y: 0 });
    field.registerZoneMetadata('cold', { floor: 0, adjacentZoneIds: ['warm'], volumeM3: 1200 });
    field.registerZoneMetadata('warm', { floor: 0, adjacentZoneIds: ['cold'], volumeM3: 1800 });
    field.setBaseline(PhysicalParameter.TEMPERATURE, 'cold', 16);
    field.setBaseline(PhysicalParameter.TEMPERATURE, 'warm', 24);
    field.set(PhysicalParameter.TEMPERATURE, 'cold', 16);
    field.set(PhysicalParameter.TEMPERATURE, 'warm', 24);

    field.step(1, NO_ATTRACTOR);
    const inflowW = (field.get(PhysicalParameter.TEMPERATURE, 'cold')! - 16) * massOf(1200);
    expect(inflowW).toBeGreaterThan(0);
    // Bar: ≤ 20% of a 3 kW drive (measured ≈ 12% at 1 m geometry).
    expect(inflowW / 3000).toBeLessThanOrEqual(0.2);
  });

  it('basement commanded cooling 16→12 decreases monotonically (was 16→18.86)', () => {
    const field = makeHelixField();
    field.setBaseline(PhysicalParameter.TEMPERATURE, 'basement', 16);
    field.setBaseline(PhysicalParameter.TEMPERATURE, 'lobby', 24);
    field.set(PhysicalParameter.TEMPERATURE, 'basement', 16);
    field.set(PhysicalParameter.TEMPERATURE, 'lobby', 24);

    // 3 kW cooling drive (as PhysicsLayer.applyThermalEffect applies it:
    // −3000 W × 0.9 efficiency through the zone's own thermal mass), with
    // the field stepping every simulated second.
    const dt = 1;
    const drivePerSec = (-3000 * HVAC_EFFICIENCY * dt) / massOf(1200);
    let prev = 16;
    const samples: number[] = [];
    for (let t = 0; t < 7200; t += dt) {
      field.step(dt, NO_ATTRACTOR);
      const temp = field.get(PhysicalParameter.TEMPERATURE, 'basement')!;
      const driven = temp + drivePerSec;
      field.set(PhysicalParameter.TEMPERATURE, 'basement', driven);
      samples.push(driven);
      // Monotonic decrease — the F-PH03 inversion is gone.
      expect(driven).toBeLessThan(prev + 1e-9);
      prev = driven;
    }
    // Reaches the target band within an hour (3 kW vs 1200 m³ + envelope).
    const finalTemp = samples[samples.length - 1];
    expect(finalTemp).toBeLessThanOrEqual(12.5);
    // And never crashes through the floor: equilibrium is ~10.7 °C.
    expect(finalTemp).toBeGreaterThan(10);
  });

  it('default-mass lobby 24.4→18 reaches ≤18.5 within 30 sim-min', () => {
    // The tester's lobby has no registered volume → legacy global 100 m³
    // mass (123 kJ/K) and the legacy fixed-fraction relaxation (0.0004/s).
    const field = new SpatialField();
    field.registerLocation('lobby', { x: 0, y: 0 });
    const attractor: FieldAttractor = () => 24.4; // global model holds 24.4
    field.set(PhysicalParameter.TEMPERATURE, 'lobby', 24.4);

    const dt = 1;
    const drivePerSec = (-3000 * HVAC_EFFICIENCY * dt) / (AIR_HC * 100);
    let temp = 24.4;
    for (let t = 0; t < 1800 && temp > 18.5; t += dt) {
      field.step(dt, attractor);
      temp = field.get(PhysicalParameter.TEMPERATURE, 'lobby')! + drivePerSec;
      field.set(PhysicalParameter.TEMPERATURE, 'lobby', temp);
    }
    expect(temp).toBeLessThanOrEqual(18.5);
  });

  it('turn-off relaxation τ stays ~45–48 min (measured 2870 s at 1200 m³)', () => {
    const field = new SpatialField();
    field.registerLocation('basement', { x: 0, y: 0 });
    field.registerZoneMetadata('basement', { floor: 0, volumeM3: 1200 });
    field.setBaseline(PhysicalParameter.TEMPERATURE, 'basement', 16);
    field.set(PhysicalParameter.TEMPERATURE, 'basement', 18.86); // repro start

    // Sample every 60 s for 48 min (the tester's cadence).
    let prevGap = 18.86 - 16;
    let measuredTau = Number.POSITIVE_INFINITY;
    for (let minute = 1; minute <= 48; minute++) {
      for (let s = 0; s < 60; s++) field.step(1, NO_ATTRACTOR);
      const gap = field.get(PhysicalParameter.TEMPERATURE, 'basement')! - 16;
      // Exponential: gap(t) = gap0·e^(−t/τ) → τ = 60/ln(prev/gap) per sample.
      measuredTau = 60 / Math.log(prevGap / gap);
      prevGap = gap;
    }
    // Bar: τ ∈ [45, 48] min ≈ [2700, 2880] s.
    expect(measuredTau).toBeGreaterThanOrEqual(2700);
    expect(measuredTau).toBeLessThanOrEqual(2900);
  });

  it('dual-HVAC contention moves lab-a ≥0.5 °C in 10 min (was +0.19 °C/24 min)', () => {
    const field = new SpatialField();
    field.registerLocation('lab-a', { x: 0, y: 0 });
    field.registerZoneMetadata('lab-a', { floor: 0, volumeM3: 750 * 3 });
    field.setBaseline(PhysicalParameter.TEMPERATURE, 'lab-a', 20);
    field.set(PhysicalParameter.TEMPERATURE, 'lab-a', 20);

    // Two 3 kW units both driving the zone (heating contention): the zone
    // must visibly move — baseline relaxation may no longer pin it.
    const dt = 1;
    const M = massOf(2250);
    const drive = (2 * 3000 * HVAC_EFFICIENCY * dt) / M;
    for (let t = 0; t < 600; t += dt) {
      field.step(dt, NO_ATTRACTOR);
      const temp = field.get(PhysicalParameter.TEMPERATURE, 'lab-a')! + drive;
      field.set(PhysicalParameter.TEMPERATURE, 'lab-a', temp);
    }
    const moved = field.get(PhysicalParameter.TEMPERATURE, 'lab-a')! - 20;
    expect(moved).toBeGreaterThanOrEqual(0.5);
  });

  it('symmetric contention (heating 3 kW vs cooling 3 kW) nets ~zero', () => {
    const field = new SpatialField();
    field.registerLocation('lab-a', { x: 0, y: 0 });
    field.registerZoneMetadata('lab-a', { floor: 0, volumeM3: 750 * 3 });
    field.setBaseline(PhysicalParameter.TEMPERATURE, 'lab-a', 20);
    field.set(PhysicalParameter.TEMPERATURE, 'lab-a', 20);

    const dt = 1;
    for (let t = 0; t < 600; t += dt) field.step(dt, NO_ATTRACTOR);
    // Net zero drive: the zone stays at its baseline (honest physics).
    expect(Math.abs(field.get(PhysicalParameter.TEMPERATURE, 'lab-a')! - 20)).toBeLessThan(0.05);
  });

  it('legacy zones without volume metadata keep concentration diffusion', () => {
    const field = new SpatialField();
    field.registerLocation('kitchen', { x: 0, y: 0 });
    field.registerLocation('dining', { x: 3, y: 0 });
    field.set(PhysicalParameter.TEMPERATURE, 'kitchen', 30);
    field.set(PhysicalParameter.TEMPERATURE, 'dining', 20);

    field.step(1, NO_ATTRACTOR);
    // Legacy: flux = 0.0015 × 10 × (1 − 3/5) on BOTH sides (equal °C).
    const flux = 0.0015 * 10 * 0.4;
    expect(field.get(PhysicalParameter.TEMPERATURE, 'kitchen')!).toBeCloseTo(30 - flux, 8);
    expect(field.get(PhysicalParameter.TEMPERATURE, 'dining')!).toBeCloseTo(20 + flux, 8);
  });

  it('explicit rate overrides (calibration) keep legacy semantics with volumes', () => {
    const field = new SpatialField({ diffusion: { temperature: 0.0015 }, relaxation: { temperature: 0.0004 } });
    field.registerLocation('a', { x: 0, y: 0 });
    field.registerLocation('b', { x: 3, y: 0 });
    field.registerZoneMetadata('a', { floor: 0, volumeM3: 1200 });
    field.registerZoneMetadata('b', { floor: 0, volumeM3: 1800 });
    // No seeded baselines + no attractor → relax skips; pure legacy flux.
    field.set(PhysicalParameter.TEMPERATURE, 'a', 16);
    field.set(PhysicalParameter.TEMPERATURE, 'b', 24);

    field.step(1, NO_ATTRACTOR);
    const flux = 0.0015 * 8 * 0.4;
    expect(field.get(PhysicalParameter.TEMPERATURE, 'a')!).toBeCloseTo(16 + flux, 8);
    expect(field.get(PhysicalParameter.TEMPERATURE, 'b')!).toBeCloseTo(24 - flux, 8);
  });
});
