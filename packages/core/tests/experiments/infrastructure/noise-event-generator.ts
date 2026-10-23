/**
 * Noise Event Generator for Layer 1 Validation
 *
 * Generates routine sensor readings that mimic real IoT device noise:
 * sensor jitter, redundant readings, periodic status reports, etc.
 * These events have low severity and should be filtered by Layer 1.
 *
 * Noise profiles:
 *   - low: 10 events/zone (baseline, ~100 total for 10-zone apartment)
 *   - medium: 50 events/zone (realistic IoT sensor frequency)
 *   - high: 200 events/zone (stress test, simulates high-frequency polling)
 */

import type { TestEventDef, ZoneDef, ExpectedOutcome, CollaborationDecision } from './types.js';

/**
 * A generated noise event with metadata for tracking.
 */
export interface GeneratedNoiseEvent extends TestEventDef {
  /** Flag marking this as a noise event for experiment tracking. */
  _isNoise: true;
}

/**
 * Noise intensity profile controlling event volume per zone.
 */
export type NoiseProfile = 'low' | 'medium' | 'high';

/** Events per zone for each noise profile. */
const PROFILE_EVENTS_PER_ZONE: Record<NoiseProfile, number> = {
  low: 10,
  medium: 50,
  high: 200,
};

// Per-noise-type generators. Each returns a partial TestEventDef without id/zoneId/location.
type NoiseGenerator = (zone: ZoneDef, index: number) => {
  type: string;
  payload: Record<string, unknown>;
  severity: 'low';
  requiresCollaboration: false;
  correctDecision: 'ignore';
  requiredCapabilities: never[];
  expectedOutcome: ExpectedOutcome;
};

// Base value for normal conditions (same as PhysicalEnvironment baseline)
const BASELINE: Record<string, number> = {
  temperature: 22,
  humidity: 45,
  light: 300,
  co2: 400,
  pm25: 25,
  noise: 50,
  motion: 0,
  occupancy: 0,
};

const NOISE_GENERATORS: NoiseGenerator[] = [
  // ── Sensor jitter: tiny fluctuations around baseline ──────────────

  // Temperature: 22°C ± 0.3°C jitter
  (zone, i) => ({
    type: 'temperature-normal',
    payload: { temperature: BASELINE.temperature + (Math.random() - 0.5) * 0.6 },
    severity: 'low' as const,
    requiresCollaboration: false as const,
    correctDecision: 'ignore' as CollaborationDecision,
    requiredCapabilities: [] as never[],
    expectedOutcome: { parameter: 'temperature', location: zone.id, shouldChange: false },
  }),

  // Humidity: 45% ± 2% jitter
  (zone, i) => ({
    type: 'humidity-normal',
    payload: { humidity: BASELINE.humidity + (Math.random() - 0.5) * 4 },
    severity: 'low' as const,
    requiresCollaboration: false as const,
    correctDecision: 'ignore' as CollaborationDecision,
    requiredCapabilities: [] as never[],
    expectedOutcome: { parameter: 'humidity', location: zone.id, shouldChange: false },
  }),

  // Light: 300 ± 15 lux jitter
  (zone, i) => ({
    type: 'light-normal',
    payload: { light: BASELINE.light + (Math.random() - 0.5) * 30 },
    severity: 'low' as const,
    requiresCollaboration: false as const,
    correctDecision: 'ignore' as CollaborationDecision,
    requiredCapabilities: [] as never[],
    expectedOutcome: { parameter: 'light', location: zone.id, shouldChange: false },
  }),

  // CO2: 400 ± 20 ppm (normal indoor)
  (zone, i) => ({
    type: 'co2-normal',
    payload: { co2: BASELINE.co2 + (Math.random() - 0.5) * 40 },
    severity: 'low' as const,
    requiresCollaboration: false as const,
    correctDecision: 'ignore' as CollaborationDecision,
    requiredCapabilities: [] as never[],
    expectedOutcome: { parameter: 'co2', location: zone.id, shouldChange: false },
  }),

  // PM2.5: 25 ± 5 μg/m³ (normal air quality)
  (zone, i) => ({
    type: 'pm25-normal',
    payload: { pm25: BASELINE.pm25 + (Math.random() - 0.5) * 10 },
    severity: 'low' as const,
    requiresCollaboration: false as const,
    correctDecision: 'ignore' as CollaborationDecision,
    requiredCapabilities: [] as never[],
    expectedOutcome: { parameter: 'pm25', location: zone.id, shouldChange: false },
  }),

  // ── Redundant readings: same value repeated (sensor echo) ──────────

  // Temperature echo: exact baseline value
  (zone, i) => ({
    type: 'temperature-normal',
    payload: { temperature: BASELINE.temperature },
    severity: 'low' as const,
    requiresCollaboration: false as const,
    correctDecision: 'ignore' as CollaborationDecision,
    requiredCapabilities: [] as never[],
    expectedOutcome: { parameter: 'temperature', location: zone.id, shouldChange: false },
  }),

  // Humidity echo: exact baseline value
  (zone, i) => ({
    type: 'humidity-normal',
    payload: { humidity: BASELINE.humidity },
    severity: 'low' as const,
    requiresCollaboration: false as const,
    correctDecision: 'ignore' as CollaborationDecision,
    requiredCapabilities: [] as never[],
    expectedOutcome: { parameter: 'humidity', location: zone.id, shouldChange: false },
  }),

  // ── Periodic status reports: device heartbeat ──────────────────────

  // Occupancy: 0 (nobody present)
  (zone, i) => ({
    type: 'occupancy-normal',
    payload: { occupancy: 0 },
    severity: 'low' as const,
    requiresCollaboration: false as const,
    correctDecision: 'ignore' as CollaborationDecision,
    requiredCapabilities: [] as never[],
    expectedOutcome: { parameter: 'occupancy', location: zone.id, shouldChange: false },
  }),

  // Noise level: 45-55 dB (normal ambient)
  (zone, i) => ({
    type: 'noise-normal',
    payload: { noise: BASELINE.noise + (Math.random() - 0.5) * 10 },
    severity: 'low' as const,
    requiresCollaboration: false as const,
    correctDecision: 'ignore' as CollaborationDecision,
    requiredCapabilities: [] as never[],
    expectedOutcome: { parameter: 'noise', location: zone.id, shouldChange: false },
  }),

  // Motion: false (no motion detected)
  (zone, i) => ({
    type: 'motion-normal',
    payload: { motion: false },
    severity: 'low' as const,
    requiresCollaboration: false as const,
    correctDecision: 'ignore' as CollaborationDecision,
    requiredCapabilities: [] as never[],
    expectedOutcome: { parameter: 'motion', location: zone.id, shouldChange: false },
  }),
];

/**
 * Generate noise events across specified zones.
 *
 * @param zones - Zones to generate noise events in
 * @param eventsPerZone - Number of noise events per zone (or use NoiseProfile)
 * @param noiseZoneIds - If provided, only generate noise in these zones.
 *                       Useful for directing noise away from interesting events.
 * @returns Array of noise events ready for injection
 */
export function generateNoiseEvents(
  zones: ZoneDef[],
  eventsPerZone: number | NoiseProfile,
  noiseZoneIds?: string[],
): GeneratedNoiseEvent[] {
  const perZone = typeof eventsPerZone === 'string'
    ? PROFILE_EVENTS_PER_ZONE[eventsPerZone]
    : eventsPerZone;

  const noiseEvents: GeneratedNoiseEvent[] = [];
  const targetZones = noiseZoneIds
    ? zones.filter(z => noiseZoneIds.includes(z.id))
    : zones;

  let noiseIndex = 0;

  for (const zone of targetZones) {
    for (let i = 0; i < perZone; i++) {
      const generator = NOISE_GENERATORS[noiseIndex % NOISE_GENERATORS.length];
      const partial = generator(zone, i);

      // Random point within zone bounds
      const location = {
        x: zone.bounds.minX + Math.random() * (zone.bounds.maxX - zone.bounds.minX),
        y: zone.bounds.minY + Math.random() * (zone.bounds.maxY - zone.bounds.minY),
      };

      noiseEvents.push({
        id: `noise-${zone.id}-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: partial.type,
        zoneId: zone.id,
        location,
        payload: partial.payload,
        severity: partial.severity,
        requiresCollaboration: partial.requiresCollaboration,
        requiredCapabilities: partial.requiredCapabilities,
        correctDecision: partial.correctDecision,
        expectedOutcome: partial.expectedOutcome,
        _isNoise: true,
      });

      noiseIndex++;
    }
  }

  return noiseEvents;
}

/**
 * Get zone IDs that are NOT the interesting event's zone.
 * Used to inject noise in different zones from the interesting event.
 */
export function getNoiseZoneIds(
  allZones: ZoneDef[],
  interestingEventZoneId: string,
): string[] {
  return allZones
    .filter(z => z.id !== interestingEventZoneId)
    .map(z => z.id);
}
