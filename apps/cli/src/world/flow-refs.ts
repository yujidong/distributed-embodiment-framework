/**
 * Flow reference portability (R1 B1-12 / P-11) — ONE bidirectional
 * name↔id vocabulary for flow node pins.
 *
 * `env export` serializes flow pins with HUMAN names (`deviceName` /
 * `assigneeAgentName`) so documents stay readable and re-applicable in a
 * fresh world; the server's flow schema accepts only ids (`deviceId` /
 * `assigneeAgentId`). `world apply` already translated on import; `flow
 * add`/`flow update` did NOT — the exported vocabulary was rejected with an
 * anonymous additionalProperties 422, stranding non-developers on the most
 * natural path ("export as reference → write my own flow"). Both entrances
 * now share the translation below: the export format feeds every import
 * entrance, and a name that cannot resolve is named IN THE ERROR (never
 * silently dropped, never a bare schema complaint).
 */

/** Recursive export-side rename (ids → names), applied by `env export`. */
export function renameDevicePins(
  node: unknown,
  deviceNameToId: Map<string, string>,
  agentNameToId: Map<string, string>,
): unknown {
  if (Array.isArray(node)) {
    return node.map(entry => renameDevicePins(entry, deviceNameToId, agentNameToId));
  }
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'deviceName' && typeof value === 'string') {
      const id = deviceNameToId.get(value);
      if (id !== undefined) out.deviceId = id;
      continue;
    }
    if (key === 'assigneeAgentName' && typeof value === 'string') {
      const id = agentNameToId.get(value);
      if (id !== undefined) out.assigneeAgentId = id;
      continue;
    }
    out[key] = renameDevicePins(value, deviceNameToId, agentNameToId);
  }
  return out;
}

export interface UnresolvedPin {
  /** The exported vocabulary key as the document carried it. */
  field: 'deviceName' | 'assigneeAgentName';
  /** The exact name as written in the document (echoed verbatim). */
  name: string;
}

/**
 * Import-side translation for `flow add` / `flow update` / `flow adopt`:
 * exported name pins → server ids. Id-shaped fields pass through untouched;
 * a name missing from the environment is KEPT as-is and reported — the
 * caller turns it into a teaching error (hint: `eaf device list --env …`).
 */
export function translateFlowNamePins(
  node: unknown,
  deviceNameToId: Map<string, string>,
  agentNameToId: Map<string, string>,
): { translated: unknown; unresolved: UnresolvedPin[] } {
  const unresolved: UnresolvedPin[] = [];
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'deviceName' && typeof entry === 'string') {
        const id = deviceNameToId.get(entry);
        if (id !== undefined) out.deviceId = id;
        else unresolved.push({ field: 'deviceName', name: entry });
        continue;
      }
      if (key === 'assigneeAgentName' && typeof entry === 'string') {
        const id = agentNameToId.get(entry);
        if (id !== undefined) out.assigneeAgentId = id;
        else unresolved.push({ field: 'assigneeAgentName', name: entry });
        continue;
      }
      out[key] = walk(entry);
    }
    return out;
  };
  return { translated: walk(node), unresolved };
}
