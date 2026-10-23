/**
 * BUG-09: explicit device-brightness → illuminance mapping.
 *
 * Pre-fix the light/lamp physics effect carried the raw 0-100 `brightness`
 * state as its magnitude, and PhysicsLayer added that number to the zone
 * illuminance on EVERY pass with no deltaTime — so the steady-state reading
 * scaled with 1/dt and drifted with the engine tick rate / LOD substep, and
 * a "brightness" had no defined relationship to lux at all.
 *
 * The mapping below gives brightness a physical meaning: the luminaire's
 * STEADY-STATE illuminance contribution in lux at distance 0 (before
 * spatial falloff), on top of the zone's ambient baseline. PhysicsLayer
 * integrates the drive at the field's light relaxation rate, so the zone
 * converges to `baseline + contribution` regardless of tick dt.
 *
 * Scale: 500 lux at full brightness ≈ EN 12464-1 office/classroom
 * illuminance — bright enough to dominate the ambient day-cycle baseline
 * (500 ± 450 lux) without being unphysical for a small room luminaire.
 *
 * Mapping table (MAX_LUMINAIRE_LUX = 500):
 *
 *   brightness (0-100)     contribution (lux)
 *     0                          0
 *    10                         50
 *    25                        125
 *    50                        250
 *    75                        375
 *   100                        500
 *
 * Legacy 0-1 fraction scale: values in (0, 1] are treated as a fraction of
 * full brightness (0.8 → 80% → 400 lux) — the device family's historical
 * default (`params?.brightness || 0.8`) and several fixtures use it. On
 * this scale 1 means FULL brightness; a caller wanting 1% on the 0-100
 * scale cannot express it (1 reads as the fraction) — the documented edge.
 */
export const MAX_LUMINAIRE_LUX = 500;

/**
 * Map a device brightness to the luminaire's steady-state illuminance
 * contribution in lux (at distance 0, before falloff). Input clamped to
 * the 0-100 percent scale after the legacy 0-1 fraction normalization.
 */
export function brightnessToLuxContribution(brightness: number): number {
  const percent = brightness <= 1 ? brightness * 100 : brightness;
  const clamped = Math.min(100, Math.max(0, percent));
  return (clamped / 100) * MAX_LUMINAIRE_LUX;
}
