/**
 * PARAM_UNITS — the platform-wide parameter unit table (single source).
 *
 * T46 (R4, u4-P2-3): the read lane labels data-service fields with the same
 * units the CLI's snapshot/ask faces have always shown (previously the table
 * lived CLI-local in apps/cli/src/commands/sim.ts — mirrors, not second
 * authority; the CLI consolidation onto this export is a follow-up). A
 * parameter without an entry renders bare — never an invented unit.
 */
export const PARAM_UNITS: Readonly<Record<string, string>> = {
  temperature: '°C',
  humidity: '%',
  light: 'lx',
  co2: 'ppm',
  pm2_5: 'µg·m⁻³',
  power: 'W',
};

/** The unit for a parameter name, or null when the platform declares none. */
export function unitOf(parameter: string): string | null {
  return PARAM_UNITS[parameter] ?? null;
}
