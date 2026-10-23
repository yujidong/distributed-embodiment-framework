/**
 * Seeded RNG (NFR-4) — deterministic random number generation.
 *
 * The platform's determinism principle (P1-5/Fix-5) requires that identical
 * inputs produce identical worlds. `Math.random()` breaks this for opt-in
 * noise and any future stochastic physics. This module provides a
 * mulberry32-based PRNG (fast, good distribution, 32-bit seed) that the
 * runtime can thread through every stochastic path.
 *
 * Usage:
 *   const rng = createSeededRng(42);          // same seed → same sequence
 *   const value = rng();                      // uniform [0, 1)
 *   const gaussian = seededGaussian(rng);     // Box-Muller, uses two draws
 */

/** Mulberry32: fast 32-bit seeded PRNG. Returns uniform [0, 1). */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Gaussian random via Box-Muller transform using a seeded uniform RNG.
 * Consumes two draws per call (cache the second for the next call).
 */
export function seededGaussian(rng: () => number): number {
  const u1 = Math.max(1e-10, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
