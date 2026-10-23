/**
 * Pure logic for the AC-necessity decision dataset dump
 * (scripts/dump-decision-dataset.ts).
 *
 * Kept free of any world/runner imports so these pieces are unit-testable
 * in isolation (see dataset-dump-lib.vitest.test.ts).
 */

import type {
  AgentEventGroundTruth,
  AgentEventType,
  CollaborationDecision,
  TestEventDef,
} from '../tests/experiments/infrastructure/types.js';

// ---------------------------------------------------------------------------
// Binary label mapping
// ---------------------------------------------------------------------------

/**
 * Binary label for the AC-necessity decision.
 *
 * Mapping (documented in the dataset header):
 *   initiate_ac            → "collaborate"  (agent should alert/coordinate with others)
 *   handle_independently   → "independent"  (agent can act alone)
 *   defer                  → "independent"  (do not initiate AC now)
 *   ignore                 → "independent"  (event not this agent's responsibility)
 *
 * The last three collapse into "independent" because the fine-tuned model only
 * decides whether to initiate collaboration; defer/ignore/handle_independently
 * all mean "do not collaborate".
 */
export type BinaryLabel = 'collaborate' | 'independent';

export function mapDecisionToLabel(decision: CollaborationDecision): BinaryLabel {
  return decision === 'initiate_ac' ? 'collaborate' : 'independent';
}

// ---------------------------------------------------------------------------
// Template reasoning
// ---------------------------------------------------------------------------

/**
 * Deterministic 1-2 sentence English rationale derived from the ground-truth
 * factors (interaction type, correct decision, capability gap, severity).
 * Language matches the system prompt's answer style ("COLLABORATE because …").
 *
 * Severity is mentioned exactly where GroundTruthCalculator.deriveDecision()
 * uses it: Type C (low severity → defer) and Type D (low severity or no
 * required capabilities → ignore).
 */
export function buildReasoning(
  gt: Pick<AgentEventGroundTruth, 'type' | 'correctDecision' | 'gap' | 'actuatorZones'>,
  event: Pick<TestEventDef, 'severity' | 'requiredCapabilities'>,
): string {
  const gap = `[${gt.gap.join(', ')}]`;

  switch (gt.type) {
    case 'A':
      // Coverage>0, Gap=∅ → handle_independently
      return 'Direct coverage and no capability gap — handle independently.';

    case 'B':
      // Direct coverage, Gap≠∅ → initiate_ac
      return `Direct coverage but missing ${gap} — need collaboration.`;

    case 'C':
      // Propagation coverage, Gap≠∅ → initiate_ac, or defer when severity is low
      return gt.correctDecision === 'defer'
        ? `Propagation-only coverage and missing ${gap}; low-severity event — defer.`
        : `Propagation-only coverage and missing ${gap} — need collaboration.`;

    case 'D': {
      // No coverage, Gap≠∅ → sensor-only: initiate_ac; else ignore (low
      // severity / no required capabilities) or defer (significant).
      const isSensorOnly = gt.actuatorZones.length === 0;
      if (gt.correctDecision === 'initiate_ac') {
        return isSensorOnly
          ? `Sensor-only agent with no actuator coverage and missing ${gap} — collaborate to alert capable agents.`
          : `No zone coverage and missing ${gap} — need collaboration.`;
      }
      if (gt.correctDecision === 'ignore') {
        return event.severity === 'low'
          ? `No zone coverage and missing ${gap}; low-severity event outside this agent's responsibility — ignore.`
          : `No zone coverage and no required capabilities to contribute — ignore.`;
      }
      return `No zone coverage and missing ${gap} — defer to agents that cover the zone.`;
    }

    case 'E':
      // No coverage, Gap=∅ → initiate_ac (delegate to an agent with coverage)
      return 'No zone coverage but no capability gap — collaborate to delegate to an agent with zone coverage.';

    default: {
      // Exhaustiveness guard
      const neverType: never = gt.type;
      throw new Error(`Unknown interaction type: ${neverType}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic event-level train/test split
// ---------------------------------------------------------------------------

/** mulberry32 — small deterministic PRNG (same seed → same sequence). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically split event ids into train/test subsets (event-level:
 * every (agent, event) pair of a test event lands in test). Fisher-Yates
 * shuffle driven by mulberry32(seed) — identical (seed, rate, ids) always
 * produce the identical split.
 */
export function splitEventIds(
  eventIds: readonly string[],
  testRate: number,
  seed: number,
): { train: string[]; test: string[] } {
  if (testRate < 0 || testRate >= 1) {
    throw new Error(`testRate must be in [0, 1), got ${testRate}`);
  }
  const rng = mulberry32(seed);
  const shuffled = [...eventIds];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const testCount = testRate === 0 ? 0 : Math.max(1, Math.round(eventIds.length * testRate));
  return {
    test: shuffled.slice(0, testCount),
    train: shuffled.slice(testCount),
  };
}

// ---------------------------------------------------------------------------
// JSONL record shape
// ---------------------------------------------------------------------------

export interface DatasetRecordMeta {
  scenario: string;
  eventId: string;
  agentId: string;
  type: AgentEventType;
  correctDecision: CollaborationDecision;
  label: BinaryLabel;
}

export interface DatasetRecord {
  messages: [
    { role: 'system'; content: string },
    { role: 'user'; content: string },
  ];
  /** Stringified production completion: {"decision":...,"reasoning":...} */
  completion: string;
  meta: DatasetRecordMeta;
}

/** Build the completion string exactly in the production output contract. */
export function buildCompletion(label: BinaryLabel, reasoning: string): string {
  return JSON.stringify({ decision: label, reasoning });
}

export function buildRecord(
  systemPrompt: string,
  userPrompt: string,
  completion: string,
  meta: DatasetRecordMeta,
): DatasetRecord {
  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    completion,
    meta,
  };
}

/**
 * Structural validation of a dataset record (used by tests and available for
 * training-side sanity checks). Returns a list of violations ([] = valid).
 */
export function validateRecord(record: unknown): string[] {
  const violations: string[] = [];
  if (typeof record !== 'object' || record === null) {
    return ['record is not an object'];
  }
  const r = record as Record<string, unknown>;

  // messages
  if (!Array.isArray(r.messages) || r.messages.length !== 2) {
    violations.push('messages must be an array of length 2');
  } else {
    const [sys, usr] = r.messages as Array<{ role?: unknown; content?: unknown }>;
    if (sys?.role !== 'system' || typeof sys?.content !== 'string' || sys.content.length === 0) {
      violations.push('messages[0] must be {role:"system", content:<non-empty string>}');
    }
    if (usr?.role !== 'user' || typeof usr?.content !== 'string' || usr.content.length === 0) {
      violations.push('messages[1] must be {role:"user", content:<non-empty string>}');
    }
  }

  // completion: string containing {"decision":"collaborate"|"independent","reasoning":...}
  let parsedDecision: unknown;
  if (typeof r.completion !== 'string') {
    violations.push('completion must be a string');
  } else {
    try {
      const parsed = JSON.parse(r.completion) as Record<string, unknown>;
      parsedDecision = parsed.decision;
      if (parsed.decision !== 'collaborate' && parsed.decision !== 'independent') {
        violations.push('completion.decision must be "collaborate" or "independent"');
      }
      if (typeof parsed.reasoning !== 'string' || parsed.reasoning.length === 0) {
        violations.push('completion.reasoning must be a non-empty string');
      }
    } catch {
      violations.push('completion must be valid JSON');
    }
  }

  // meta
  if (typeof r.meta !== 'object' || r.meta === null) {
    violations.push('meta must be an object');
  } else {
    const m = r.meta as Record<string, unknown>;
    for (const key of ['scenario', 'eventId', 'agentId', 'correctDecision', 'label'] as const) {
      if (typeof m[key] !== 'string' || (m[key] as string).length === 0) {
        violations.push(`meta.${key} must be a non-empty string`);
      }
    }
    if (!['A', 'B', 'C', 'D', 'E'].includes(m.type as string)) {
      violations.push('meta.type must be one of A,B,C,D,E');
    }
    if (m.label !== 'collaborate' && m.label !== 'independent') {
      violations.push('meta.label must be "collaborate" or "independent"');
    }
    // Cross-field invariant: the label is what the completion says.
    if (parsedDecision !== undefined && m.label !== parsedDecision) {
      violations.push('meta.label must equal completion.decision');
    }
  }

  return violations;
}
