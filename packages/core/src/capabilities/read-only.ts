/**
 * Read-only capability predicate — the SINGLE source of truth for the
 * "this capability names an observation, not an actuation" classification
 * (BUG-04; the R13 "duplicated vocabularies drift" lesson).
 *
 * Before this module FOUR copies of the vocabulary disagreed on the
 * `detect-` verb prefix: the simulation authoring oracle
 * (devices/handlers/capability-contract.ts) matched the `detect` SUBSTRING,
 * while capabilityNameToDeviceCapability, SimulatedDevice.isReadOnlyCommand
 * and the prompt-side isSensorStyleCapability did not — so `detect-smoke`
 * was validated as executable by flows, shown to the LLM as an actuation
 * command, then died at runtime with "no handler / no effect".
 *
 * The predicate below is the UNION of the four historical vocabularies (a
 * superset of every legacy true verdict, so no previously-passing name
 * flips): sensing-noun substrings, the `detect` substring (T-034 heritage:
 * detect-fault on billboards, detect-leak on valves, detect-smoke on smoke
 * detectors — a device detecting its own condition is a query), and the
 * get/read/query/check/measure/sense verb prefixes.
 *
 * Consumers (all four lanes read this ONE predicate):
 * - simulation authoring oracle (isCapabilityExecutable via capability-contract.ts)
 * - capabilityNameToDeviceCapability (runtime/contract.ts capability typing)
 * - SimulatedDevice.isReadOnlyCommand (dispatch no-op tolerance)
 * - prompt surfaces (isSensorStyleCapability in decision/rule-actuation-planner.ts,
 *   the MY_DEVICES inventory filter, world-model command derivation, training export)
 */
export function isReadOnlyCapabilityName(name: string): boolean {
  const lower = name.toLowerCase();
  if (
    lower.includes('reading') || lower.includes('sensing') ||
    lower.includes('monitoring') || lower.includes('detection') ||
    lower.includes('detect')
  ) {
    return true;
  }
  const normalized = lower.replace(/[-_]/g, '');
  return /^(get|read|query|check|measure|sense)/.test(normalized);
}
