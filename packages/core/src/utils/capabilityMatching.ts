/**
 * Shared Capability Matching Utility
 *
 * Single source of truth for semantic capability matching (equivalence
 * lane: `capabilityMatches` & friends; service-text lane:
 * `serviceTextCapabilityMatch` for ServiceBroker). Scenarios extend the
 * synonym registry at load time via `extendCapabilitySynonyms` (P3).
 */

// ---------------------------------------------------------------------------
// Synonym table
// ---------------------------------------------------------------------------

/**
 * Known capability equivalences. Two capabilities in the same group
 * are considered semantically equivalent.
 */
export const CAPABILITY_SYNONYMS: string[][] = [
  // Original 13 groups
  ['temperature-reading', 'temperature-monitoring'],
  ['humidity-reading', 'humidity-monitoring'],
  ['co2-reading', 'co2-monitoring'],
  ['hvac-control', 'temperature-control'],
  ['cooling', 'temperature-control'],
  ['heating', 'temperature-control'],
  ['air-quality-reading', 'air-quality-monitoring'],
  ['air-purification', 'air-quality-control'],
  ['motion-detection', 'presence-detection'],
  ['lighting-control', 'light-control'],
  ['fire-detection', 'fire-suppression'],
  ['emergency-alert', 'alarm'],
  ['water-leak-detection', 'water-shutoff'],

  // Medical imaging — any of these should satisfy a "diagnostic imaging" requirement
  ['ct-scan', 'imaging-service', 'stroke-imaging', 'field-ct-scan', 'diagnostic-imaging'],
  // Cath lab / interventional cardiology
  ['cath-lab-activation', 'pci-procedure', 'coronary-intervention', 'cardiac-intervention'],
  // Controlled substance / thrombolytic dispensing
  ['tpa-dispense', 'thrombolytic-administration', 'thrombolytic-dispense'],
  // Note: 'controlled-substance-dispense' is intentionally NOT in the tPA
  // group — scope-of-practice (Workstream A3) decides whether a given agent
  // class may deliver controlled substances at all.
  // Fall detection
  ['fall-detection', 'immobility-detection', 'fall-event-recognition'],
  // Anaphylaxis treatment
  ['epinephrine-administration', 'anaphylaxis-treatment', 'autoinjector-use'],
  // EMS dispatch
  ['ambulance-dispatch', 'patient-transport', 'ems-dispatch', 'medical-transport'],
  // Blood products
  ['blood-unit-dispatch', 'blood-unit-reserve', 'transfusion-dispatch'],
  // Toxic gas monitoring (industrial-scale air quality)
  ['toxic-gas-monitoring', 'chemical-leak-detection', 'hazardous-atmosphere-monitoring'],
  // Smoke / fire detection (industrial scale)
  ['smoke-detection', 'fire-detection', 'fire-suppression', 'smoke-detected'],
];

// ---------------------------------------------------------------------------
// Synonym registry (process-level extension)
// ---------------------------------------------------------------------------

/**
 * Scenario-registered groups (P3): appended by `extendCapabilitySynonyms`
 * (scenario top-level `capabilitySynonyms`, registered at load time). The
 * built-in table above is NEVER mutated — a process that registers nothing
 * matches exactly as before.
 */
const extendedSynonymGroups: string[][] = [];

/** Dedupe key of a group: order/case-insensitive membership signature. */
function synonymGroupKey(group: readonly string[]): string {
  return [...new Set(group.map(s => s.toLowerCase()))].sort().join('|');
}

/**
 * Register additional capability-equivalence groups (P3, scenario
 * `capabilitySynonyms`). Process-level and append-only: groups land in both
 * matching paths (equivalence via `capabilityMatches`, service-text via
 * `serviceTextCapabilityMatch`). Duplicate groups (same membership as a
 * built-in or an already-registered group) are skipped, so repeated loads
 * of the same scenario (validate → import → bridge) stay idempotent.
 */
export function extendCapabilitySynonyms(groups: readonly (readonly string[])[]): void {
  const known = new Set(
    [...CAPABILITY_SYNONYMS, ...extendedSynonymGroups].map(synonymGroupKey),
  );
  for (const group of groups) {
    if (!Array.isArray(group) || group.length < 2) continue;
    const key = synonymGroupKey(group);
    if (known.has(key)) continue;
    known.add(key);
    extendedSynonymGroups.push([...group]);
  }
}

/** The effective equivalence table: built-ins + scenario-registered groups. */
export function capabilitySynonymGroups(): readonly string[][] {
  return [...CAPABILITY_SYNONYMS, ...extendedSynonymGroups];
}

// ---------------------------------------------------------------------------
// Service-text keyword relations (descriptive matching)
// ---------------------------------------------------------------------------

/**
 * Service-text keyword relations — the ServiceBroker's last-resort fuzzy
 * lane. A requirement naming a KEY is semantically satisfied by service
 * text (name/description/category) mentioning any RELATED term. SUBSTRING
 * semantics, NOT capability equivalences — never feed these into
 * `computeCapabilityGap` ('heating' must not satisfy a 'cooling'
 * requirement; they merely co-occur in temperature-class service prose).
 * Lives here (not in ServiceBroker) so the scenario `capabilitySynonyms`
 * extension registry and this table share one home.
 */
export const SERVICE_TEXT_KEYWORDS: Record<string, string[]> = {
  'temperature': ['hvac', 'thermostat', 'climate', 'heating', 'cooling', 'ac'],
  'humidity': ['humidifier', 'dehumidifier', 'climate', 'humidity'],
  'air-quality': ['purifier', 'ventilation', 'air-filter'],
  'security': ['lock', 'camera', 'alarm', 'sensor'],
  'lighting': ['light', 'lamp', 'bulb', 'dimmer'],
};

/**
 * Service-text semantic match (both arguments already lowercased): the
 * keyword relations above, plus scenario-registered synonym groups read
 * with the same substring semantics (a requirement naming one member is
 * satisfied by service text naming another).
 */
export function serviceTextCapabilityMatch(reqLower: string, serviceTextLower: string): boolean {
  for (const [key, relatedTerms] of Object.entries(SERVICE_TEXT_KEYWORDS)) {
    if (reqLower === key || reqLower.includes(key)) {
      for (const term of relatedTerms) {
        if (serviceTextLower.includes(term)) return true;
      }
    }
  }
  for (const group of extendedSynonymGroups) {
    const lowerGroup = group.map(s => s.toLowerCase());
    if (!lowerGroup.some(term => reqLower === term || reqLower.includes(term))) continue;
    if (lowerGroup.some(term => serviceTextLower.includes(term))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Matching function
// ---------------------------------------------------------------------------

/**
 * Check if a single agent capability matches a single required capability.
 * Uses bidirectional case-insensitive substring matching + synonym table.
 */
export function capabilityMatches(agentCap: string, requiredCap: string): boolean {
  const a = agentCap.toLowerCase();
  const r = requiredCap.toLowerCase();

  // Exact match
  if (a === r) return true;

  // Bidirectional substring match
  if (a.includes(r) || r.includes(a)) return true;

  // Synonym table match (built-ins + scenario-registered groups)
  for (const group of capabilitySynonymGroups()) {
    const lowerGroup = group.map(s => s.toLowerCase());
    if (lowerGroup.includes(a) && lowerGroup.includes(r)) return true;
  }

  return false;
}

/**
 * Compute capability gap: required capabilities that the agent cannot match.
 * Returns both the gap (unmatched) and matched capabilities.
 */
export function computeCapabilityGap(
  agentCapabilities: string[],
  requiredCapabilities: string[],
): { gap: string[]; matched: string[] } {
  if (requiredCapabilities.length === 0) {
    return { gap: [], matched: [] };
  }

  const matched: string[] = [];
  const gap: string[] = [];

  for (const req of requiredCapabilities) {
    const isMatched = agentCapabilities.some(ac => capabilityMatches(ac, req));
    if (isMatched) {
      matched.push(req);
    } else {
      gap.push(req);
    }
  }

  return { gap, matched };
}

/**
 * Check if an agent has all required capabilities.
 */
export function hasAllCapabilities(
  agentCapabilities: string[],
  requiredCapabilities: string[],
): boolean {
  if (requiredCapabilities.length === 0) return true;
  return requiredCapabilities.every(req =>
    agentCapabilities.some(ac => capabilityMatches(ac, req)),
  );
}
