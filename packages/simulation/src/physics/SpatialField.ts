/**
 * Spatial Field
 *
 * Persistent per-(parameter, location) field state owned by the physics
 * layer. This is the single source of truth for WHERE physical parameter
 * values live: instead of one global value per parameter, each location
 * (zone, room, grid cell) carries its own value.
 *
 * The field knows NOTHING about devices: no "hvac", no "thermostat", no
 * commands. It only provides field mathematics:
 *   1. Point writes (`set`) — a value at a location.
 *   2. Localized writes (`setLocalized`) — a value at a location plus a
 *      delta-based, falloff-attenuated spillover to nearby locations.
 *   3. Diffusion (`step`) — neighboring locations exchange value over time
 *      (smoke/CO2 spread, heat leaks through doorways).
 *   4. Relaxation (`step`) — every location drifts back toward its
 *      environmental baseline (per-location baseline when one was seeded,
 *      otherwise a caller-supplied attractor such as the global value
 *      model's current value).
 *   5. Clamping (`step`) — a short safety net that keeps field values
 *      inside physically possible ranges regardless of what wrote them.
 *
 * Dynamics model (all per physics tick of `dt` seconds):
 *   diffuse:  v_i += k(P) * (v_j - v_i) * (1 - d/R) * dt   for d < R
 *   relax:    v   += (baseline - v) * rate(P) * dt
 *   clamp:    v    = min(max(v, lo(P)), hi(P))
 *
 * T-701 exception (temperature, zones with registered volumeM3): the
 * exchange is ENERGY-based instead of concentration-based —
 *   q = U·A·(T_j - T_i) [W];  ΔT_i = +q·dt/C_i;  ΔT_j = -q·dt/C_j
 * with each side's own thermal mass C = ρ·V·c, and the relaxation rate
 * becomes the physical aggregate envelope U·A/C (see THERMAL_* constants).
 * Explicit rate overrides (calibration tooling) restore legacy semantics.
 *
 * Chosen constants (documented per requirement; tune freely, they are
 * physics-taste numbers, not API):
 *
 *   Relaxation rates (1/s, i.e. fraction of the gap closed per second):
 *     temperature 0.0004 (~42 min time constant — a well-insulated room;
 *       slow enough that a 3 kW HVAC (~0.022 °C/s) wins decisively and the
 *       thermostat actually reaches its target, fast enough that a room
 *       visibly drifts back within minutes after the HVAC stops)
 *     humidity    0.003  (~5.5 min — moisture equalizes through air)
 *     light       0.100  (~10 s — light stabilizes almost instantly)
 *     co2         0.005  (~3.3 min — air exchange)
 *     pm2_5       0.008  (~2 min — settling + ventilation)
 *     smoke       0.010  (~1.7 min — smoke clears fastest)
 *     default     0.005
 *
 *   Diffusion coefficients (1/s at zero distance, linear falloff to the
 *   coupling range R = 5 m — roughly "open doorways within a home"):
 *     smoke/co2/pm2_5 0.02 (airborne pollutants spread fastest)
 *     humidity        0.008
 *     temperature     0.005 (heat conducts slowly between rooms)
 *     default         0.005
 *
 *   Floor-aware coupling (building tier, B-A): locations may carry floor
 *   metadata (`registerZoneMetadata`). Two locations on the SAME floor (or
 *   without any floor metadata — legacy single-storey worlds) couple by 2D
 *   center distance exactly as before; the z coordinate never feeds the
 *   distance, so stacking floors cannot create phantom strong coupling.
 *   Two locations on DIFFERENT floors couple ONLY when their declared
 *   adjacency interconnects them (stairwell/shaft zones), with the flux
 *   scaled by the slab attenuation (default 0.15 — a slab is a good
 *   insulator); non-interconnected cross-floor pairs never exchange value.
 *   The same floor rule gates `setLocalized` spillover.
 *
 *   Outdoor boundary (building tier, B-B): a location registered with
 *   `outdoor: true` is an infinite environmental boundary, not a room. It
 *   NEVER participates in the distance-based same-floor coupling — an
 *   indoor zone exchanges with it only when the declared adjacency
 *   interconnects the pair (a window/wall to the outside), and that flux
 *   is scaled by the envelope factor (U-value semantics, default 0.1,
 *   overridable per zone / per instance / at runtime). The exchange is
 *   ONE-WAY: the indoor side gains or loses value, the outdoor location
 *   does not absorb anything from the building — it relaxes to its own
 *   (externally driven) baseline, so indoor conditions can never drag the
 *   weather. Non-adjacent indoor zones are fully insulated from outdoor.
 *
 *   Safety-net clamps (physically possible ranges; simulation sanity,
 *   NOT device control):
 *     temperature [-60, 100] °C, humidity [0, 100] %, light [0, 200000] lux,
 *     co2 [0, 50000] ppm, pm2_5 [0, 5000] µg/m³, smoke [0, 1000]
 *   Everything else is unclamped.
 */

import { SpatialUtils, type Coordinate2D, type Coordinate3D } from '../spatial/index.js';
import type { PhysicalParameter } from '../devices/types.js';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('SpatialField');

export type FieldPosition = Coordinate2D | Coordinate3D;

/**
 * R30 Task 2 (coupling-matrix cache): one PRECOMPUTED coupling edge — the
 * pair identity plus every coefficient the dynamics lanes need, derived
 * ONCE per topology epoch instead of per pair × parameter × tick:
 *   - `geometry` / `factor`: the concentration-diffusion lane (identical
 *     expressions to the per-tick derivation, so per-tick float order is
 *     unchanged: flux = k·Δv·geometry·factor·dt);
 *   - `thermalConductanceWPerK` (+ `thermalFactor`): the T-701 U·A lane —
 *     U·A = envelope U·wallM2 (envelope pairs, ABSOLUTE U) or
 *     partition U·wallM2·geometry·factor (interior/slab pairs, factor
 *     already carries the missing-floor attenuation);
 *   - `massA/massB` (J/K): each side's cached thermal mass.
 * Invalidated with the pair index (any registration/metadata/rate change).
 */
interface CoupledPair {
  a: string;
  b: string;
  kind: 'same-floor' | 'cross-floor' | 'envelope';
  /** Concentration-lane geometry falloff (same-floor distance only). */
  geometry: number;
  /** Concentration-lane factor (slab / envelope / 1). */
  factor: number;
  /** Thermal-lane conductance U·A (W/K), precomputed. */
  thermalConductanceWPerK: number;
  /** Envelope pairs: the indoor side (the only side that moves). */
  indoorKey: 'a' | 'b' | undefined;
  /** Cached thermal masses (J/K) of sides a and b. */
  massA: number;
  massB: number;
  /**
   * T-701 lane gate (per pair): false when NEITHER side registered a
   * volume — such pairs never exchange temperature as energy (the legacy
   * per-tick `continue`), keeping the concentration semantics.
   */
  thermalEligible: boolean;
  /**
   * R30: lazily built per-parameter ENTRY KEYS (`param:a` / `param:b`) —
   * the per-tick loop used to derive both strings per pair × parameter ×
   * tick; cached keys turn the step into a pure matrix × value-vector
   * pass. Rebuilt with the matrix (the pair object is recreated).
   */
  keys?: Map<string, [string, string]>;
}

/** One field sample: a value at a location, optionally with a local baseline. */
interface FieldEntry {
  value: number;
  /** Per-location relaxation attractor (seeded baseline). */
  baseline?: number;
}

/** Relaxation rate per parameter (1/s). See header for rationale. */
const RELAXATION_RATES: Record<string, number> = {
  temperature: 0.0004,
  humidity: 0.003,
  light: 0.1,
  co2: 0.005,
  pm2_5: 0.008,
  smoke: 0.01,
};
const DEFAULT_RELAXATION_RATE = 0.005;

/**
 * UX-15: occupancy counters are LATCHED — a headcount is a fact (people are
 * present until something writes otherwise), not a concentration that drifts
 * back to an ambient level. Field entries for these parameters skip
 * relaxation entirely (a baseline-declared occupancy used to decay
 * exponentially at the generic 0.005/s rate toward its own baseline/attractor).
 */
const OCCUPANCY_LATCH_PARAMETERS: ReadonlySet<string> = new Set(['occupancy', 'people_count']);

/** Diffusion coefficient per parameter (1/s at distance 0). */
const DIFFUSION_RATES: Record<string, number> = {
  smoke: 0.02,
  co2: 0.02,
  pm2_5: 0.02,
  humidity: 0.008,
  // 0.0015 keeps room-to-room heat exchange visible over minutes without
  // homogenizing the whole apartment (0.005 washed inter-zone gradients out).
  temperature: 0.0015,
};
const DEFAULT_DIFFUSION_RATE = 0.005;

/**
 * Optional per-instance rate overrides (P3d calibration tooling): a fitted
 * field can run with measured relaxation/diffusion rates while every other
 * field keeps the module defaults. Missing parameters fall back to the
 * module constants, so `new SpatialField()` behaves exactly as before.
 */
export interface SpatialFieldRates {
  relaxation?: Record<string, number>;
  diffusion?: Record<string, number>;
  /** Cross-floor flux multiplier (0..1); falls back to SLAB_ATTENUATION_DEFAULT. */
  slabAttenuation?: number;
  /** Envelope flux multiplier (0..1); falls back to ENVELOPE_U_DEFAULT. */
  envelopeU?: number;
}

/**
 * Floor/adjacency metadata for a location (building tier, B-A). Registered
 * by the runtime when it knows the zone's storey and its declared vertical
 * connections; the field uses it to gate cross-floor coupling.
 */
export interface ZonePhysicsMetadata {
  /** Storey number (0 = ground floor). */
  floor?: number;
  /** Declared neighbors; a cross-floor pair couples only when connected. */
  adjacentZoneIds?: string[];
  /**
   * Outdoor boundary (B-B): this location is the outside world. It never
   * joins distance-based coupling; adjacent indoor zones exchange with it
   * one-way through the envelope factor.
   */
  outdoor?: boolean;
  /**
   * Per-zone envelope flux multiplier override (U-value semantics, B-B).
   * Wins over the runtime/instance envelope factor for exchanges between
   * this zone and an outdoor location.
   */
  envelopeU?: number;
  /**
   * T-105 (F-PH05): interior ambient coupling buffer, 0..1. The zone's
   * relaxation toward its ambient attractor is scaled by it — a buffered
   * interior zone (0.2, say) tracks the building mix slowly, while an
   * exterior zone keeps the direct rate (1). Default 1 (unchanged
   * behavior). Does NOT apply to the T-701 physical thermal-envelope rate
   * of volume-registered zones (that rate IS the envelope — scaling it
   * would double-count the shell). Outdoor locations are always 1.
   */
  ambientBuffer?: number;
  /**
   * T-105 (F-PH05): the zone's solar aperture in m² (glass zones — an
   * atrium's skylights, a roof-garden's glazing). The physics layer drives
   * a per-tick solar-gain heat source from it: W = solar_radiation ×
   * glassArea × g-value. Stored here for checkpoint fidelity; the LAYER
   * owns the live source registration.
   */
  glassAreaM2?: number;
  /**
   * Zone air volume in m³ (RC-5 calibration): the physics layer derives the
   * zone's thermal mass from it (ρ·V·c) instead of the global 100 m³
   * constant, so heating/cooling power produces a per-zone realistic ΔT.
   * Absent = legacy global thermal mass.
   *
   * T-701 (DevLoop R29): a zone with a registered volume ALSO switches the
   * field's temperature exchange to the energy-conserving U·A model (see
   * THERMAL_* constants below) — flux in watts, applied as q·dt/C through
   * each side's own thermal mass, so HVAC drives (W) and inter-zone
   * exchange (W) finally share one unit system and can compete honestly.
   */
  volumeM3?: number;
}

/** Max distance (m) over which two locations exchange value. */
const DIFFUSION_COUPLING_RANGE_M = 5;

/**
 * Cross-floor diffusion flux multiplier: a concrete slab is a good thermal
 * insulator, so declared vertical connections (stairwells, shafts) exchange
 * far less than open doorways on the same floor. Overridable per instance
 * (SpatialFieldRates) or at runtime (`setSlabAttenuation`).
 */
const SLAB_ATTENUATION_DEFAULT = 0.15;

/**
 * Envelope flux multiplier (B-B): a declared indoor↔outdoor connection
 * (windows/walls facing outside) exchanges far less than open doorways —
 * the envelope is a thermal barrier. U-value semantics borrowed from
 * ZoneTransferModel, simplified to one scalar per zone. Overridable per
 * zone (ZonePhysicsMetadata.envelopeU), per instance (SpatialFieldRates),
 * or at runtime (`setEnvelopeU`).
 */
const ENVELOPE_U_DEFAULT = 0.1;

// ---------------------------------------------------------------------------
// T-701 (DevLoop R29): energy-conserving, mass-scaled U·A thermal exchange.
//
// Pre-fix the field moved raw °C between zones (k·ΔT concentration
// diffusion, equal °C on both sides regardless of zone mass) while device
// drives converted W→°C/s through per-zone thermal mass — a unit mismatch
// that let field exchange dominate HVAC drives (measured: a basement
// "cooling" warmed +0.72 °C/min toward its warm neighbor while the 3 kW
// unit pulled −0.11 °C/min). Zones registered with `volumeM3` now exchange
// heat as ENERGY:
//
//   q = U · A_shared · geometry · factor · (T_hot − T_cold)   [W]
//   ΔT_i = +q·dt / C_i ,  ΔT_j = −q·dt / C_j                  [°C]
//
// with C = ρ·V·c (air) per side — energy-conserving (q·dt out of the hot
// side enters the cold side), mass-scaled, and in the SAME unit (W) as the
// HVAC effect magnitudes, so a 3 kW drive overpowers a modest warm inflow.
//
// Calibration (Helix R29 acceptance bars):
//   - interior partition U = 0.5 W/m²·K over the shared-wall area
//     (min(V)^(2/3), capped) → a ΔT-8 neighbor injects ≈450 W into a
//     1200 m³ zone — ≤ 20% of a 3 kW drive (bar: warm-neighbor inflow);
//   - aggregate-envelope relaxation U = 4.5 W/m²·K → turn-off time
//     constant τ = C/(U·A) ≈ 268·V^(1/3) s ≈ 2850 s at 1200 m³,
//     matching the measured 2870 s decay (bar: τ stays ~45–48 min).
//
// Zones WITHOUT a registered volume keep the exact legacy concentration
// dynamics (calibration tooling passes explicit rate overrides; those win
// over the U·A model for every zone).
// ---------------------------------------------------------------------------

/** Air volumetric heat capacity (J/m³·K): ρ 1.2 kg/m³ × c 1005 J/kg·K. */
const AIR_HEAT_CAPACITY_J_PER_M3K = 1.2 * 1005;
/** Interior partition U-value (W/m²·K) for inter-zone heat exchange. */
const THERMAL_PARTITION_U_W_M2K = 0.5;
/**
 * Aggregate-envelope U-value (W/m²·K) for the mass-scaled temperature
 * relaxation of volume-registered zones (the zone drifts back toward its
 * baseline at U·A/C per second — the physical form of the legacy 0.0004/s
 * constant, now scaled by the zone's own mass and envelope area).
 */
const THERMAL_ENVELOPE_U_W_M2K = 4.5;
/**
 * T-701: indoor↔outdoor envelope U-value for the U·A exchange path, in
 * ABSOLUTE W/m²·K (the building tier authors real U-values — building-
 * compiler maps facade entries straight onto zone.envelopeU). Default 1.0
 * = a typical exterior wall; a declared per-zone / runtime / instance
 * envelopeU overrides it with the same absolute meaning. The LEGACY
 * (non-volume) path keeps the dimensionless 0.1 relative factor.
 */
const THERMAL_ENVELOPE_PAIR_U_W_M2K = 1.0;
/** Cap on the derived shared-wall area between two zones (m²). */
const THERMAL_MAX_WALL_M2 = 200;
/** Default zone volume when only one side of a pair registered one (m³). */
const THERMAL_DEFAULT_VOLUME_M3 = 100;
/**
 * Attenuation for thermal pairs where either side has no floor metadata:
 * floor-unaware placements couple at reduced strength (T-701: make floor
 * metadata mandatory-ish — warn + attenuate when missing).
 */
const THERMAL_MISSING_FLOOR_FACTOR = 0.5;

/** Safety-net clamps: physically possible ranges per parameter. */
const FIELD_CLAMPS: Record<string, { min: number; max: number }> = {
  temperature: { min: -60, max: 100 },
  humidity: { min: 0, max: 100 },
  light: { min: 0, max: 200000 },
  co2: { min: 0, max: 50000 },
  pm2_5: { min: 0, max: 5000 },
  smoke: { min: 0, max: 1000 },
};

/** Clamp a single value if its parameter has a safety-net range. */
export function clampFieldValue(parameter: PhysicalParameter | string, value: number): number {
  const clamp = FIELD_CLAMPS[String(parameter)];
  if (!clamp) return value;
  return Math.min(clamp.max, Math.max(clamp.min, value));
}

/**
 * Attractor lookup: the value a location relaxes toward when it has no
 * per-location baseline. Typically the global value model's current value.
 * Return `undefined` to skip relaxation for that entry.
 */
export type FieldAttractor = (parameter: PhysicalParameter | string, locationKey: string) => number | undefined;

export class SpatialField {
  /** Field values: key is `${parameter}:${locationKey}`. */
  private readonly entries = new Map<string, FieldEntry>();
  /** Known location positions (for falloff + diffusion geometry). */
  private readonly locationPositions = new Map<string, FieldPosition>();
  /** Storey per location (B-A); absent metadata = single-storey legacy. */
  private readonly locationFloors = new Map<string, number>();
  /** Declared adjacency per location (B-A); gates cross-floor coupling. */
  private readonly locationAdjacency = new Map<string, Set<string>>();
  /** Outdoor boundary locations (B-B). */
  private readonly outdoorLocations = new Set<string>();
  /**
   * T-105 (F-PH05): per-location ambient coupling scale (interior buffer).
   * Absent = 1 (direct). Outdoor locations never carry an entry.
   */
  private readonly locationAmbientScale = new Map<string, number>();
  /** T-105 (F-PH05): per-location solar aperture (m², glass zones). */
  private readonly locationGlassAreaM2 = new Map<string, number>();
  /** Per-zone envelope factor overrides (B-B). */
  private readonly locationEnvelopeU = new Map<string, number>();
  /** Per-zone air volumes (m³, T-701) — drives the U·A thermal exchange. */
  private readonly locationVolumeM3 = new Map<string, number>();
  /**
   * T-707: per-(parameter, location) attractor OVERRIDES (ventilation).
   * While an air handler runs, the zone's air-exchange relaxation toward
   * its baseline/global attractor is REPLACED by the ventilation decay the
   * physics layer applies (ACH toward outdoor ppm) — air exchange must not
   * be double-counted. Entries with an active override are SKIPPED by the
   * default relax(); the layer clears the override when ventilation stops.
   */
  private readonly attractorOverrides = new Map<string, number>();
  /**
   * T-701: one-shot warning for thermal pairs with missing floor metadata.
   */
  private warnedMissingFloor = false;
  /** Runtime slab-attenuation override (wins over the constructor rate). */
  private slabAttenuationOverride?: number;
  /** Runtime envelope-factor override (wins over the constructor rate). */
  private envelopeUOverride?: number;
  /** Per-instance rate overrides (P3d); module constants are the fallback. */
  private readonly rates: SpatialFieldRates;
  /**
   * Runtime per-parameter relaxation-rate overrides (FEAT-03): a scenario
   * declaring `parameterPhysics` for a custom zone parameter pins that
   * key's relaxation rate without a constructor rebuild. Wins over both
   * the instance rates and the module constants.
   */
  private readonly relaxationRateOverrides = new Map<string, number>();
  /**
   * Fix-43a/b + R30 Task 2: the cached COUPLING MATRIX — every exchange
   * edge with precomputed coefficients (distances, slab/envelope factors,
   * U·A conductances, per-side thermal masses). The apartment-era diffuse
   * loop paired ALL locations (O(L²) per parameter; 971 zones × 8 params ≈
   * 3.8M pair evaluations per tick, ~90% of runtime CPU measured
   * 2026-08-17); Fix-43 cached the pair index, but the per-tick loop still
   * re-derived distance/factor/U·A per pair × parameter, and
   * syncFieldLocations' idempotent re-registrations invalidated the cache
   * EVERY tick. Now: (a) registration only invalidates on an actual
   * position/metadata CHANGE, (b) coefficients ride the cache — each tick
   * is matrix × value-vector only. Invalidated on any registration/
   * metadata/rate change.
   */
  private couplingMatrixCache?: Array<CoupledPair>;
  /**
   * R30 Task 2: cached per-location thermal relaxation rates (U·A_env/C,
   * 1/s) for volume-registered zones — relax() used to recompute the
   * V^(2/3) wall area per entry per tick. Cleared with the matrix.
   */
  private readonly thermalRelaxRateCache = new Map<string, number>();
  /** R30 Task 2: coupling-matrix rebuild count (test/diagnostic gauge). */
  private matrixBuildCount = 0;

  constructor(rates: SpatialFieldRates = {}) {
    this.rates = rates;
  }

  /** Relaxation rate for a parameter: runtime override → instance override → module constant → default. */
  private relaxationRate(parameter: string): number {
    return this.relaxationRateOverrides.get(parameter) ??
      this.rates.relaxation?.[parameter] ??
      RELAXATION_RATES[parameter] ??
      DEFAULT_RELAXATION_RATE;
  }

  /**
   * Runtime relaxation-rate override for one parameter (FEAT-03 custom
   * parameter physics — a scenario-declared `relaxRatePerSec`).
   */
  setRelaxationRate(parameter: string, ratePerSec: number): void {
    this.relaxationRateOverrides.set(parameter, ratePerSec);
  }

  /**
   * Public read of a parameter's relaxation rate (BUG-09): PhysicsLayer's
   * light drive targets a steady-state lux contribution, so it must
   * integrate at the SAME rate the field relaxes light — including
   * instance-level rate overrides — for the equilibrium to stay
   * dt-independent.
   */
  getRelaxationRate(parameter: string): number {
    return this.relaxationRate(parameter);
  }

  /** Diffusion coefficient for a parameter: instance override → module constant → default. */
  private diffusionRate(parameter: string): number {
    return this.rates.diffusion?.[parameter] ?? DIFFUSION_RATES[parameter] ?? DEFAULT_DIFFUSION_RATE;
  }

  private static key(parameter: PhysicalParameter | string, locationKey: string): string {
    return `${parameter}:${locationKey}`;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /** Register (or update) a location's position for falloff/diffusion geometry. */
  registerLocation(locationKey: string, position: FieldPosition): void {
    // R30: idempotent re-registration (PhysicsLayer.syncFieldLocations
    // re-registers every known location each pass) only invalidates the
    // coupling matrix when the position actually CHANGED — a same-position
    // rewrite is a no-op for the geometry.
    const prior = this.locationPositions.get(locationKey);
    if (
      prior !== undefined &&
      prior.x === position.x && prior.y === position.y &&
      (prior as Coordinate3D).z === (position as Coordinate3D).z
    ) {
      return;
    }
    this.locationPositions.set(locationKey, position);
    this.invalidateCouplingMatrix();
  }

  /**
   * Register (or update) a location's floor + declared adjacency (B-A).
   * The field only couples cross-floor locations that interconnect here.
   */
  registerZoneMetadata(locationKey: string, metadata: ZonePhysicsMetadata): void {
    if (metadata.floor !== undefined) {
      if (this.locationFloors.get(locationKey) !== metadata.floor) {
        this.locationFloors.set(locationKey, metadata.floor);
        this.invalidateCouplingMatrix();
      }
    }
    if (metadata.adjacentZoneIds !== undefined) {
      const next = new Set(metadata.adjacentZoneIds);
      const priorAdj = this.locationAdjacency.get(locationKey);
      const same = priorAdj !== undefined &&
        priorAdj.size === next.size && [...next].every(id => priorAdj.has(id));
      if (!same) {
        this.locationAdjacency.set(locationKey, next);
        this.invalidateCouplingMatrix();
      }
    }
    if (metadata.outdoor !== undefined) {
      const was = this.outdoorLocations.has(locationKey);
      if (metadata.outdoor) this.outdoorLocations.add(locationKey);
      else this.outdoorLocations.delete(locationKey);
      if (was !== metadata.outdoor) this.invalidateCouplingMatrix();
    }
    if (metadata.envelopeU !== undefined) {
      if (this.locationEnvelopeU.get(locationKey) !== metadata.envelopeU) {
        this.locationEnvelopeU.set(locationKey, metadata.envelopeU);
        this.invalidateCouplingMatrix();
      }
    }
    // T-701: remember the zone's volume — it switches temperature exchange
    // for this zone to the energy-conserving U·A model (and, R30, changes
    // the cached U·A conductances and thermal masses).
    if (metadata.volumeM3 !== undefined && Number.isFinite(metadata.volumeM3) && metadata.volumeM3 > 0) {
      if (this.locationVolumeM3.get(locationKey) !== metadata.volumeM3) {
        this.locationVolumeM3.set(locationKey, metadata.volumeM3);
        this.invalidateCouplingMatrix();
      }
    }
    // T-105 (F-PH05): interior ambient coupling buffer. Outdoor locations
    // always relax DIRECTLY to their weather-driven baseline (scale 1).
    if (this.outdoorLocations.has(locationKey)) {
      this.locationAmbientScale.delete(locationKey);
    } else if (metadata.ambientBuffer !== undefined &&
               Number.isFinite(metadata.ambientBuffer) && metadata.ambientBuffer >= 0) {
      this.locationAmbientScale.set(locationKey, Math.min(1, metadata.ambientBuffer));
    } else {
      this.locationAmbientScale.delete(locationKey);
    }
    // T-105 (F-PH05): solar aperture (glass zones) — informational here
    // (checkpoint fidelity); the physics layer drives the live source.
    if (metadata.glassAreaM2 !== undefined &&
        Number.isFinite(metadata.glassAreaM2) && metadata.glassAreaM2 > 0) {
      this.locationGlassAreaM2.set(locationKey, metadata.glassAreaM2);
    } else {
      this.locationGlassAreaM2.delete(locationKey);
    }
  }

  /** Drop the coupling matrix + thermal caches (topology/rate change). */
  private invalidateCouplingMatrix(): void {
    this.couplingMatrixCache = undefined;
    this.thermalRelaxRateCache.clear();
  }

  /** Registered air volume of a location (m³), or undefined (T-701). */
  volumeOf(locationKey: string): number | undefined {
    return this.locationVolumeM3.get(locationKey);
  }

  /**
   * T-701: thermal mass C = ρ·V·c of a location (J/K). A location without a
   * registered volume uses the legacy global 100 m³ default, so a
   * volume-registered zone exchanging with a legacy zone still conserves
   * energy (the legacy side simply has the small default mass).
   */
  private thermalMassJPerK(locationKey: string): number {
    const v = this.locationVolumeM3.get(locationKey) ?? THERMAL_DEFAULT_VOLUME_M3;
    return AIR_HEAT_CAPACITY_J_PER_M3K * v;
  }

  /**
   * T-701: shared-wall area (m²) between two zones, derived from the smaller
   * volume's cross-section V^(2/3) and capped — a physically plausible
   * partition area without requiring explicit wall geometry in the map.
   */
  private static sharedWallAreaM2(volumeA: number, volumeB: number): number {
    const v = Math.min(volumeA, volumeB);
    return Math.min(THERMAL_MAX_WALL_M2, Math.pow(Math.max(v, 1), 2 / 3));
  }

  /** Storey of a location, or undefined when no floor metadata was registered. */
  floorOf(locationKey: string): number | undefined {
    return this.locationFloors.get(locationKey);
  }

  /** Whether a location is an outdoor boundary (B-B). */
  isOutdoor(locationKey: string): boolean {
    return this.outdoorLocations.has(locationKey);
  }

  /** T-105 (F-PH05): the location's solar aperture (m²), or undefined. */
  glassAreaM2Of(locationKey: string): number | undefined {
    return this.locationGlassAreaM2.get(locationKey);
  }

  /**
   * T-105 (F-PH05): every location registered with a solar aperture, for
   * the layer's per-tick solar-gain source registration.
   */
  glassZones(): Array<{ locationKey: string; glassAreaM2: number }> {
    return [...this.locationGlassAreaM2.entries()].map(([locationKey, glassAreaM2]) => ({
      locationKey,
      glassAreaM2,
    }));
  }

  /** Override the cross-floor flux multiplier at runtime (scenario meta). */
  setSlabAttenuation(value: number): void {
    if (this.slabAttenuationOverride === value) return; // no change, no rebuild
    this.slabAttenuationOverride = value;
    this.invalidateCouplingMatrix(); // R30: slab factor rides the matrix
  }

  /** Effective slab attenuation: runtime override → instance rate → default. */
  private slabAttenuation(): number {
    return this.slabAttenuationOverride ?? this.rates.slabAttenuation ?? SLAB_ATTENUATION_DEFAULT;
  }

  /** Override the envelope flux multiplier at runtime (scenario meta). */
  setEnvelopeU(value: number): void {
    if (this.envelopeUOverride === value) return; // no change, no rebuild
    this.envelopeUOverride = value;
    this.invalidateCouplingMatrix(); // R30: envelope factor rides the matrix
  }

  /**
   * T-701: absolute envelope U-value (W/m²·K) for the U·A exchange path:
   * per-zone override → runtime override → instance rate → wall default.
   */
  private thermalEnvelopePairU(indoorLocationKey: string): number {
    return this.locationEnvelopeU.get(indoorLocationKey) ??
      this.envelopeUOverride ??
      this.rates.envelopeU ??
      THERMAL_ENVELOPE_PAIR_U_W_M2K;
  }

  /**
   * Effective envelope factor for an indoor zone exchanging with outdoor:
   * per-zone override → runtime override → instance rate → default.
   */
  private envelopeU(indoorLocationKey: string): number {
    return this.locationEnvelopeU.get(indoorLocationKey) ??
      this.envelopeUOverride ??
      this.rates.envelopeU ??
      ENVELOPE_U_DEFAULT;
  }

  /**
   * Coupling between two locations:
   * - outdoor involved (B-B): an outdoor boundary never joins the
   *   distance-based coupling. An indoor↔outdoor pair couples only when
   *   the declared adjacency interconnects them ('envelope'); two outdoor
   *   boundaries never exchange with each other;
   * - same floor (or no floor metadata on either side): couple by 2D
   *   distance — the legacy behavior, z never participates;
   * - different floors: couple only when the declared adjacency
   *   interconnects the pair (either direction — the scenario loader
   *   symmetrizes, the field tolerates one-sided declarations);
   * - otherwise: no coupling (a slab separates non-shaft neighbors).
   */
  private couplingBetween(locationA: string, locationB: string): 'same-floor' | 'cross-floor' | 'envelope' | null {
    const outdoorA = this.outdoorLocations.has(locationA);
    const outdoorB = this.outdoorLocations.has(locationB);
    if (outdoorA || outdoorB) {
      if (outdoorA && outdoorB) return null;
      const connected =
        this.locationAdjacency.get(locationA)?.has(locationB) === true ||
        this.locationAdjacency.get(locationB)?.has(locationA) === true;
      return connected ? 'envelope' : null;
    }
    const floorA = this.locationFloors.get(locationA) ?? 0;
    const floorB = this.locationFloors.get(locationB) ?? 0;
    if (floorA === floorB) return 'same-floor';
    const connected =
      this.locationAdjacency.get(locationA)?.has(locationB) === true ||
      this.locationAdjacency.get(locationB)?.has(locationA) === true;
    return connected ? 'cross-floor' : null;
  }

  /** 2D distance between two positions, ignoring any z coordinate. */
  private static distance2D(a: FieldPosition, b: FieldPosition): number {
    return Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
  }

  /** Point write: set the field value at one location. Clamped on write. */
  set(parameter: PhysicalParameter | string, locationKey: string, value: number, position?: FieldPosition): void {
    if (position) this.registerLocation(locationKey, position);
    this.setByKey(parameter, SpatialField.key(parameter, locationKey), value);
  }

  /**
   * Localized write: full value at `locationKey`, plus a delta-based,
   * linearly attenuated spillover to other known locations within `radius`.
   *
   * The spillover is delta-based so it works for any parameter scale:
   *   spill_j = value_j + (value - baseline_source) * falloff(d, radius)
   * (a 33.5°C spike in a 31.5°C room adds ~2°C * falloff to a neighbor,
   * it never COOLS the neighbor toward an absolute 33.5 * falloff).
   *
   * T-708 (DevLoop R29, F-PH09): the neighbor's delta is added to its
   * CURRENT value, never to its BASELINE — the old absolute form could
   * LOWER a neighbor whose current value sat above `baseline + delta·falloff`
   * (measured: lab-a 9.999→7.649 — contamination next door made it
   * CLEANER). Additive spillover can only ever add the disturbance.
   *
   * radius <= 0 disables spillover (pure point write).
   */
  setLocalized(
    parameter: PhysicalParameter | string,
    locationKey: string,
    value: number,
    radius: number,
    attractor: FieldAttractor,
  ): void {
    this.set(parameter, locationKey, value);
    if (radius <= 0) return;

    const sourcePos = this.locationPositions.get(locationKey);
    if (!sourcePos) return;

    const sourceBaseline = this.baselineOf(parameter, locationKey, attractor) ?? value;
    const delta = value - sourceBaseline;
    if (Math.abs(delta) < 1e-12) return;

    for (const [otherKey, otherPos] of this.locationPositions) {
      if (otherKey === locationKey) continue;
      // B-A: spillover never crosses a slab — same-floor locations only.
      if (this.couplingBetween(locationKey, otherKey) !== 'same-floor') continue;
      const distance = SpatialField.distance2D(sourcePos, otherPos);
      if (distance >= radius) continue;
      const falloff = SpatialUtils.calculateFalloff(distance, radius, 'linear');
      if (falloff <= 0) continue;
      const otherValue = this.valueOf(parameter, otherKey, attractor) ?? 0;
      this.set(parameter, otherKey, otherValue + delta * falloff);
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Field value at a location, or undefined when the field has none. */
  get(parameter: PhysicalParameter | string, locationKey: string): number | undefined {
    return this.entries.get(SpatialField.key(parameter, locationKey))?.value;
  }

  /** Seeded per-location baseline, or undefined. */
  getBaseline(parameter: PhysicalParameter | string, locationKey: string): number | undefined {
    return this.entries.get(SpatialField.key(parameter, locationKey))?.baseline;
  }

  /**
   * T-707: set/clear a per-(parameter, location) attractor override
   * (ventilation semantics — see {@link attractorOverrides}). `undefined`
   * clears the override and restores default relaxation.
   */
  setAttractorOverride(
    parameter: PhysicalParameter | string,
    locationKey: string,
    value: number | undefined,
  ): void {
    const key = SpatialField.key(parameter, locationKey);
    if (value === undefined) this.attractorOverrides.delete(key);
    else this.attractorOverrides.set(key, value);
  }

  /** Seed a per-location relaxation attractor (does not change the value). */
  setBaseline(parameter: PhysicalParameter | string, locationKey: string, baseline: number): void {
    const key = SpatialField.key(parameter, locationKey);
    const entry = this.entries.get(key) ?? { value: baseline };
    entry.baseline = baseline;
    this.entries.set(key, entry);
  }

  /** Number of tracked (parameter, location) entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Remove every field value for a parameter (baselines are kept). */
  clearParameter(parameter: PhysicalParameter): void {
    const prefix = `${parameter}:`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        const entry = this.entries.get(key)!;
        if (entry.baseline !== undefined) {
          this.entries.set(key, { value: entry.baseline, baseline: entry.baseline });
        } else {
          this.entries.delete(key);
        }
      }
    }
  }

  /** Drop all field state (values, baselines, positions, zone metadata). */
  clear(): void {
    this.entries.clear();
    this.locationPositions.clear();
    this.locationFloors.clear();
    this.locationAdjacency.clear();
    this.outdoorLocations.clear();
    this.locationEnvelopeU.clear();
    this.locationVolumeM3.clear();
    this.attractorOverrides.clear();
    this.invalidateCouplingMatrix();
  }

  /**
   * Fix-43 + R30 Task 2: ALL coupling edges with PRECOMPUTED coefficients,
   * built once per topology epoch. Pair semantics identical to the legacy
   * all-pairs scan:
   *   - same-floor: within DIFFUSION_COUPLING_RANGE_M by 2D center distance
   *     (spatial-hash neighbor cells; outdoor locations excluded — they only
   *     couple via declared adjacency);
   *   - cross-floor: declared-adjacency edges between different floors;
   *   - envelope: declared-adjacency edges where exactly one side is outdoor.
   * Same-floor adjacency beyond the range does NOT couple (legacy rule —
   * same-floor coupling was always distance-only), so adjacency edges are
   * only consulted for cross-floor and envelope pairs.
   */
  private couplingMatrix(): Array<CoupledPair> {
    if (this.couplingMatrixCache !== undefined) return this.couplingMatrixCache;
    this.matrixBuildCount++;

    // T-701 lane gates, resolved once per build (identical to the per-tick
    // conditions the loop used to evaluate per pair × parameter).
    const thermalExchange =
      this.rates.diffusion?.temperature === undefined && this.locationVolumeM3.size > 0;
    const slab = this.slabAttenuation();

    const pairs = new Map<string, CoupledPair>();
    const make = (
      a: string, b: string, kind: CoupledPair['kind'],
      geometry: number, factor: number,
    ): void => {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const key = `${kind}|${lo}|${hi}`;
      if (pairs.has(key)) return;
      let thermalFactor = factor;
      if (thermalExchange && kind === 'same-floor' &&
          (this.locationFloors.get(lo) === undefined || this.locationFloors.get(hi) === undefined)) {
        thermalFactor = factor * THERMAL_MISSING_FLOOR_FACTOR;
        if (!this.warnedMissingFloor) {
          this.warnedMissingFloor = true;
          logger.warn(
            'T-701: thermal exchange between zones without floor metadata — ' +
            'coupling attenuated ×' + THERMAL_MISSING_FLOOR_FACTOR +
            ' (register floor/volumeM3 zone metadata for full-fidelity heat exchange)',
          );
        }
      }
      const volumeA = this.locationVolumeM3.get(lo);
      const volumeB = this.locationVolumeM3.get(hi);
      const wallM2 = SpatialField.sharedWallAreaM2(
        volumeA ?? THERMAL_DEFAULT_VOLUME_M3,
        volumeB ?? THERMAL_DEFAULT_VOLUME_M3,
      );
      // Preserve the legacy float-op order: conductance = U·wallM2·geometry·factor.
      const thermalConductanceWPerK = kind === 'envelope'
        ? this.thermalEnvelopePairU(this.outdoorLocations.has(lo) ? hi : lo) * wallM2
        : THERMAL_PARTITION_U_W_M2K * wallM2 * geometry * thermalFactor;
      pairs.set(key, {
        a: lo, b: hi, kind, geometry, factor,
        thermalConductanceWPerK,
        indoorKey: kind === 'envelope' ? (this.outdoorLocations.has(lo) ? 'b' : 'a') : undefined,
        massA: this.thermalMassJPerK(lo),
        massB: this.thermalMassJPerK(hi),
        thermalEligible: !(volumeA === undefined && volumeB === undefined),
      });
    };

    // Same-floor distance pairs via spatial hash (cell = coupling range).
    const cellSize = DIFFUSION_COUPLING_RANGE_M;
    const cells = new Map<string, Array<{ key: string; pos: FieldPosition }>>();
    for (const [key, pos] of this.locationPositions) {
      if (this.outdoorLocations.has(key)) continue;
      const floor = this.locationFloors.get(key) ?? 0;
      const cellKey = `${Math.floor(pos.x / cellSize)}:${Math.floor(pos.y / cellSize)}:${floor}`;
      const bucket = cells.get(cellKey) ?? [];
      bucket.push({ key, pos });
      cells.set(cellKey, bucket);
    }
    for (const [cellKey, bucket] of cells) {
      const [cx, cy] = cellKey.split(':').map(Number);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const neighbor = cells.get(`${cx + dx}:${cy + dy}:${cellKey.split(':')[2]}`);
          if (!neighbor) continue;
          for (const p of bucket) {
            for (const q of neighbor) {
              if (p.key >= q.key) continue; // each unordered pair once
              const distance = SpatialField.distance2D(p.pos, q.pos);
              if (distance >= DIFFUSION_COUPLING_RANGE_M) continue;
              make(p.key, q.key, 'same-floor', 1 - distance / DIFFUSION_COUPLING_RANGE_M, 1);
            }
          }
        }
      }
    }

    // Declared-adjacency edges: cross-floor shafts + indoor↔outdoor envelopes.
    for (const [a, adj] of this.locationAdjacency) {
      for (const b of adj) {
        if (a === b) continue;
        const outdoorA = this.outdoorLocations.has(a);
        const outdoorB = this.outdoorLocations.has(b);
        if (outdoorA && outdoorB) continue;
        if (outdoorA || outdoorB) {
          make(a, b, 'envelope', 1, this.envelopeU(outdoorA ? b : a));
          continue;
        }
        const floorA = this.locationFloors.get(a) ?? 0;
        const floorB = this.locationFloors.get(b) ?? 0;
        if (floorA !== floorB) make(a, b, 'cross-floor', 1, slab);
        // Same-floor adjacency: distance rule already decided above.
      }
    }

    this.couplingMatrixCache = [...pairs.values()];
    return this.couplingMatrixCache;
  }

  /** R30 Task 2: how many times the coupling matrix was (re)built (gauge). */
  get matrixRebuilds(): number {
    return this.matrixBuildCount;
  }

  // -------------------------------------------------------------------------
  // Dynamics
  // -------------------------------------------------------------------------

  /**
   * Fix-52c: zone activity tracking for simulation LOD. A location is
   * "active" when it has a non-baseline field value (something is happening
   * there — a device effect, an injected event, occupancy heat). Quiet
   * locations can be stepped less frequently with a proportionally larger
   * dt: for a linear system (diffusion + relaxation), stepping every K ticks
   * with dt×K is mathematically equivalent to stepping every tick with dt.
   */
  private stepCount = 0;
  /** Locations with values that deviate from their baselines. */
  private activeLocations = new Set<string>();

  /**
   * Advance the field one physics tick: diffusion between nearby
   * locations, relaxation toward baselines, then safety-net clamping.
   * Fix-52c: every K-th tick, quiet locations (no non-baseline values)
   * are skipped in the diffusion loop; their relaxation still runs every
   * tick (it's O(entries) and cheap). Diffusion pairs touching at least
   * one active location always run.
   */
  step(dt: number, attractor: FieldAttractor): void {
    if (this.entries.size === 0 || dt <= 0) return;
    this.stepCount++;
    // Refresh the active-location set every 10 ticks (cheap scan).
    if (this.stepCount % 10 === 1) {
      this.activeLocations = new Set();
      for (const [key, entry] of this.entries) {
        const sep = key.indexOf(':');
        const loc = key.slice(sep + 1);
        const param = key.slice(0, sep);
        const baseline = entry.baseline;
        // A location is active if any parameter deviates from baseline
        // by more than a small epsilon. Use 0.001 (not 0.05) — diffusion
        // per tick is small (k≈0.0015 × ΔT ≈ 0.03 for a 20°C gradient),
        // so a larger threshold would miss slowly-spreading disturbances.
        if (baseline === undefined || Math.abs(entry.value - baseline) > 0.001) {
          this.activeLocations.add(loc);
        }
      }
    }
    const activeFilter = this.activeLocations;
    this.diffuse(dt, attractor, activeFilter);
    this.relax(dt, attractor);
    this.clampAll();
  }

  /** Locations exchange value with neighbors inside the coupling range. */
  private diffuse(dt: number, attractor: FieldAttractor, activeLocations?: Set<string>): void {
    // Fix-43 + R30: iterate the cached COUPLING MATRIX — pair identities AND
    // coefficients (geometry/factor for concentration diffusion, U·A + per-
    // side masses for the T-701 thermal exchange) are precomputed per
    // topology epoch. The per-tick loop below is matrix × value-vector only.
    // Parameters: those with at least one entry (legacy candidate rule —
    // the old code's per-parameter sets widened LOCATIONS, not parameters).
    const parameters = new Set<string>();
    for (const key of this.entries.keys()) {
      parameters.add(key.slice(0, key.indexOf(':')));
    }

    const matrix = this.couplingMatrix();
    // T-701: volume-registered zones exchange TEMPERATURE as energy (W)
    // through each side's own thermal mass — unless calibration tooling
    // pinned an explicit diffusion rate for temperature (thermalFit),
    // which restores the legacy concentration semantics for every zone.
    const thermalExchange =
      this.rates.diffusion?.temperature === undefined;
    for (const parameter of parameters) {
      if (matrix.length === 0) continue;
      const k = this.diffusionRate(parameter);
      const param = parameter as PhysicalParameter;
      const useThermalExchange =
        thermalExchange &&
        parameter === 'temperature' &&
        (this.locationVolumeM3.size > 0);

      for (const pair of matrix) {
        const { a, b, kind } = pair;
        // Fix-52c: skip pairs where BOTH sides are quiet (no non-baseline
        // values). An all-baseline pair has zero flux (v_a ≈ v_b), so
        // skipping it is semantically safe — it saves the value lookups for
        // the majority of pairs in a large world where most zones are
        // undisturbed.
        if (activeLocations !== undefined && activeLocations.size > 0 &&
            !activeLocations.has(a) && !activeLocations.has(b)) {
          continue;
        }
        // R30: per-(pair, parameter) entry keys, derived once per epoch —
        // the loop body below is lookups + arithmetic only.
        let keys = pair.keys?.get(parameter);
        if (keys === undefined) {
          keys = [SpatialField.key(param, a), SpatialField.key(param, b)];
          (pair.keys ??= new Map()).set(parameter, keys);
        }
        const [keyA, keyB] = keys;
        const valueI = this.entries.get(keyA)?.value ?? attractor(param, a);
        const valueJ = this.entries.get(keyB)?.value ?? attractor(param, b);
        if (valueI === undefined || valueJ === undefined) continue;

        if (useThermalExchange && pair.thermalEligible) {
          // T-701: energy-conserving U·A exchange. q (W) flows from the hot
          // side to the cold side; each side's ΔT is q·dt through its OWN
          // thermal mass (a small zone swings more for the same joules).
          // Pairs where NEITHER side registered a volume keep the legacy
          // concentration semantics (thermalEligible, precomputed).
          const q = pair.thermalConductanceWPerK * (valueJ - valueI); // W, >0: a gains
          if (Math.abs(q) < 1e-9) continue;
          if (kind === 'envelope') {
            // One-way: only the indoor entry moves. The outdoor entry is
            // untouched — its relaxation keeps it glued to its baseline.
            // q above is (T_b − T_a) from pair order; normalize to the
            // heat flow INTO the indoor side (hot day → indoor warms).
            const signedQ = pair.indoorKey === 'a' ? q : -q;
            const indoorValue = pair.indoorKey === 'a' ? valueI : valueJ;
            const mass = pair.indoorKey === 'a' ? pair.massA : pair.massB;
            this.setByKey(param, pair.indoorKey === 'a' ? keyA : keyB,
              indoorValue + (signedQ * dt) / mass);
          } else {
            this.setByKey(param, keyA, valueI + (q * dt) / pair.massA);
            this.setByKey(param, keyB, valueJ - (q * dt) / pair.massB);
          }
          continue;
        }

        const flux = k * (valueJ - valueI) * pair.geometry * pair.factor * dt;
        if (Math.abs(flux) < 1e-12) continue;
        if (kind === 'envelope') {
          // One-way: only the indoor entry moves. The outdoor entry is
          // untouched — its relaxation keeps it glued to its baseline.
          if (pair.indoorKey === 'b') {
            // Materializes the indoor entry when it had none (leak-in).
            this.setByKey(param, keyB, valueJ - flux);
          } else {
            this.setByKey(param, keyA, valueI + flux);
          }
        } else {
          // Materializes entries at locations that had none (spread).
          this.setByKey(param, keyA, valueI + flux);
          this.setByKey(param, keyB, valueJ - flux);
        }
      }
    }
  }

  /**
   * R30: the value-write half of `set` for a PRECOMPUTED entry key — same
   * semantics (clamp on write, entry materialized when absent), minus the
   * per-call key derivation. `set` delegates here.
   */
  private setByKey(parameter: PhysicalParameter | string, key: string, value: number): void {
    const entry = this.entries.get(key) ?? { value: 0 };
    entry.value = clampFieldValue(parameter, value);
    this.entries.set(key, entry);
  }

  /** Every entry drifts toward its baseline (or the caller's attractor). */
  private relax(dt: number, attractor: FieldAttractor): void {
    // T-701: an explicit temperature relaxation override (calibration
    // tooling) restores legacy fixed-fraction semantics for every zone.
    const legacyTemperatureRate = this.rates.relaxation?.temperature;
    for (const [key, entry] of this.entries) {
      const sep = key.indexOf(':');
      const parameter = key.slice(0, sep) as PhysicalParameter;
      const locationKey = key.slice(sep + 1);
      // UX-15: occupancy counters latch (they are headcounts, not
      // concentrations) — no relaxation toward any baseline/attractor.
      if (OCCUPANCY_LATCH_PARAMETERS.has(parameter)) continue;
      // T-707: an attractor OVERRIDE (ventilation) replaces the default
      // relaxation for this entry — the layer's ACH decay already applied
      // the air-exchange pull toward the override value this tick, so the
      // default relax toward baseline/global would double-count it.
      if (this.attractorOverrides.has(key)) continue;
      const target = this.baselineOf(parameter, locationKey, attractor);
      if (target === undefined) continue;
      let rate = this.relaxationRate(parameter);
      if (parameter === 'temperature' && legacyTemperatureRate === undefined) {
        // T-701: volume-registered zones relax through a physical
        // aggregate envelope — rate = U·A/C (1/s), mass-scaled. τ = C/(U·A)
        // ≈ 268·V^(1/3) s (1200 m³ → ≈2850 s, the measured turn-off decay).
        // R30: cached per location (the V^(2/3) wall area was recomputed
        // per entry per tick); cleared with the coupling matrix.
        // T-105: the ambientBuffer scale deliberately does NOT apply here —
        // this rate IS the physical envelope; scaling it double-counts.
        const volumeM3 = this.locationVolumeM3.get(locationKey);
        if (volumeM3 !== undefined) {
          rate = this.cachedThermalRelaxRate(locationKey, volumeM3);
        }
      } else {
        // T-105 (F-PH05): buffered interior coupling — the zone tracks its
        // ambient attractor at the declared fraction of the generic rate.
        const ambientScale = this.locationAmbientScale.get(locationKey);
        if (ambientScale !== undefined) rate *= ambientScale;
      }
      entry.value += (target - entry.value) * rate * dt;
    }
  }

  /** R30: per-location thermal envelope rate U·A_env/C, cached (identical expression and float order to the per-tick derivation). */
  private cachedThermalRelaxRate(locationKey: string, volumeM3: number): number {
    const cached = this.thermalRelaxRateCache.get(locationKey);
    if (cached !== undefined) return cached;
    const wallM2 = SpatialField.sharedWallAreaM2(volumeM3, volumeM3);
    const rate = (THERMAL_ENVELOPE_U_W_M2K * wallM2) /
      (AIR_HEAT_CAPACITY_J_PER_M3K * volumeM3);
    this.thermalRelaxRateCache.set(locationKey, rate);
    return rate;
  }

  /** Apply the safety-net clamps to every entry. */
  private clampAll(): void {
    for (const [key, entry] of this.entries) {
      const parameter = key.slice(0, key.indexOf(':'));
      entry.value = clampFieldValue(parameter, entry.value);
    }
  }

  /** Entry value, falling back to the attractor when no entry exists. */
  private valueOf(
    parameter: PhysicalParameter | string,
    locationKey: string,
    attractor: FieldAttractor,
  ): number | undefined {
    return this.get(parameter, locationKey) ?? attractor(parameter, locationKey);
  }

  /** Per-location baseline when seeded, else the caller's attractor. */
  private baselineOf(
    parameter: PhysicalParameter | string,
    locationKey: string,
    attractor: FieldAttractor,
  ): number | undefined {
    return this.getBaseline(parameter, locationKey) ?? attractor(parameter, locationKey);
  }
}
