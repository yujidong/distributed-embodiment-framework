/**
 * Runtime persistence seams (R6-E-F15 file-budget extraction from
 * EngineRuntime.ts — pure functions; the class keeps thin delegations so
 * it stays under its size ceiling, same discipline as the R38/R40 shaping
 * extractions).
 *
 *  - P4-1 reputation load: persisted rows → the tracker, then the platform
 *    face is re-pushed into meta-cognition (R40-A2 — the server's
 *    create/resume loads env reputation AFTER runtime construction, so the
 *    assembly-time baseline push could not see those rows).
 *  - R6-E-F15 private experience: serialize/adopt the agents' LEARNED
 *    cognition — the meta-cognition checkpoint (decision-quality ring +
 *    private partner trust) — so the server can persist it per
 *    (env, agent) across sim rebuilds. Transient per-sim cognition (event
 *    ring, working memory, parameter face) deliberately does NOT ride this
 *    seam; it stays on the world-session checkpoint.
 */

import type { CognitiveAgent } from '../agent/CognitiveAgent.js';
import type { AgentExperienceJSON } from '../cognition/meta.js';
import type {
  ReputationRecord,
  ReputationTracker,
  ReputationTrackerLoadJSON,
  ScoredReputation,
} from '../reputation/index.js';
import { pushPlatformReputation } from './shaping/index.js';

/**
 * T71 (R8, u1-F3) file-budget extraction: the single-cell reputation READ
 * face — prior-filled zeros when there is no history, the integer event
 * buckets riding beside the weight sums. Pure projection; EngineRuntime
 * keeps the thin delegation (same discipline as the R38/R40 extractions).
 */
export function reputationCellFace(
  agentId: string,
  capability: string,
  record: ReputationRecord | undefined,
  score: number,
): ScoredReputation {
  return {
    agentId,
    capability,
    attempts: record?.attempts ?? 0,
    successes: record?.successes ?? 0,
    failures: record?.failures ?? 0,
    successEvents: record?.successEvents ?? 0,
    partialEvents: record?.partialEvents ?? 0,
    failureEvents: record?.failureEvents ?? 0,
    lastAt: record?.lastAt ?? 0,
    score,
  };
}

/** P4-1 load path: replace the tracker's contents from a saved snapshot. */
export function loadReputationInto(
  agents: Iterable<CognitiveAgent>,
  reputation: ReputationTracker,
  reputationEnabled: boolean,
  json: ReputationTrackerLoadJSON | undefined | null,
): void {
  reputation.fromJSON(json);
  pushPlatformReputation(agents, reputation, reputationEnabled);
}

/**
 * Serialize every agent's learned cognition. Agents without meta-cognition,
 * or with nothing learned yet, are omitted (an empty snapshot would only
 * write noise rows).
 */
export function collectAgentExperience(
  agents: ReadonlyMap<string, CognitiveAgent>,
): AgentExperienceJSON {
  const out: AgentExperienceJSON['agents'] = [];
  for (const [agentId, agent] of agents) {
    const meta = agent.getDualTriggerACManager()?.getMetaCognition()?.checkpoint() ?? null;
    if (meta === null) continue;
    if (meta.quality.records.length === 0 && meta.trust.partners.length === 0) continue;
    out.push({ agentId, metaCognition: meta });
  }
  return { version: 1, agents: out };
}

/**
 * Adopt saved per-agent experience snapshots (sim-start load). Snapshots
 * for agents the runtime does not hold are skipped; agents WITHOUT a
 * snapshot keep their fresh (empty) state — nothing is polluted.
 * Version-mismatched containers/entries are ignored (honest no-op: a
 * foreign snapshot must not corrupt the live state).
 */
export function applyAgentExperience(
  agents: ReadonlyMap<string, CognitiveAgent>,
  json: AgentExperienceJSON | undefined | null,
): void {
  if (json === undefined || json === null || json.version !== 1) return;
  for (const entry of json.agents) {
    if (entry.metaCognition?.formatVersion !== 1) continue;
    agents.get(entry.agentId)
      ?.getDualTriggerACManager()?.getMetaCognition()?.restore(entry.metaCognition);
  }
}
