/**
 * T70 (R8, u1-F2): the ONE command-equivalence judgment — "which command ON
 * THIS DEVICE'S FACE does this ask dispatch as?"
 *
 * R8 found the same ask answering three different stories: the NL execution
 * filter judged against the agent's declared face, the verification fork
 * judged against the fork world's snapshot face, and the device dispatch
 * additionally accepted handler-alias spellings (Fix-44g) — so
 * `set-temperature` could be rejected by one face, "not exposed" by a second,
 * and EXECUTED by the third. Every face now resolves a command through this
 * module first; a command is judged executable only when it resolves (or is
 * literally on the face), and the RESOLVED name is what gets verified,
 * executed, replied and audited.
 *
 * `temperatureCommandRank` moved here from cognition/predictor (T67 had
 * already made it the shared temperature vocabulary — the signing gate
 * consumes it); predictor re-exports it so the public core API path is
 * unchanged.
 */

/**
 * Rank a command as a temperature setter (lower = preferred; -1 = not one).
 * Env-imported devices carry CAPABILITY names ('temperature-control',
 * 'cooling') where file scenarios carry 'set-temperature' — both are the
 * same ask. Read-only sensor surfaces (temperature-reading/-monitoring) are
 * NOT setters — naming them must never "control" the sensor.
 */
export function temperatureCommandRank(command: string): number {
  if (command === 'set-temperature') return 0;
  if (/read|monitor|sense|measure|meter/i.test(command)) return -1;
  if (/temp/i.test(command)) return 1;
  if (/^(?:cooling|heating)$/i.test(command)) return 2;
  return -1;
}

/**
 * Resolve `command` against a device's literal face: the face member this
 * ask dispatches as, or undefined when the face cannot serve it.
 *
 * - verbatim face member → itself;
 * - temperature-family ask (rank ≥ 0) → the face's best temperature setter
 *   (temperatureCommandRank ordering — the same equivalence the what-if T2
 *   gate and the signing gate already speak);
 * - anything else → undefined (the caller rejects with a teaching reason —
 *   never a silent rewrite onto an unrelated command).
 */
export function resolveCommandEquivalence(
  command: string,
  face: readonly string[],
): string | undefined {
  if (face.includes(command)) return command;
  if (temperatureCommandRank(command) >= 0) {
    const equivalent = face
      .map(c => ({ c, rank: temperatureCommandRank(c) }))
      .filter(e => e.rank >= 0)
      .sort((a, b) => a.rank - b.rank)[0]?.c;
    if (equivalent !== undefined) return equivalent;
  }
  return undefined;
}
