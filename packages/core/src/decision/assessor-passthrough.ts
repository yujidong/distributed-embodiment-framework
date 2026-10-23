/**
 * Precheck pass-through gate + requirement extraction (R43-B/R44) —
 * pure logic extracted from ACNecessityAssessor for the file-size budget.
 */

import { capabilityMatches } from '../utils/capabilityMatching.js';
import { inferCapabilitiesFromCluster } from './inference-tables.js';
import { computeGapNeeds } from './partner-summaries.js';

export interface PrecheckPassThroughPolicy {
  mode: 'off' | 'sample' | 'all';
  rate?: number;
}

/** Pure: should this precheck.independent result go to the LLM anyway? */
export function shouldPassThroughPrecheck(
  reasoningCode: string | undefined,
  policy: PrecheckPassThroughPolicy | undefined,
  llmAvailable: boolean,
  samplerValue: number,
): boolean {
  if (policy === undefined || policy.mode === 'off') return false;
  if (reasoningCode !== 'precheck.independent') return false;
  if (!llmAvailable) return false;
  if (policy.mode === 'all') return true;
  const rate = typeof policy.rate === 'number' && Number.isFinite(policy.rate)
    ? Math.min(Math.max(policy.rate, 0), 1)
    : 0.3;
  return samplerValue < rate;
}

  /**
   * The AUTHOR-DECLARED event requirements: the first cluster finding that
   * carries an explicit `details.requiredCapabilities` array (lowercased).
   * Empty array (author says "nothing required") is meaningful and kept —
   * only `undefined` means "not declared". This mirrors the preCheck's
   * explicit-over-inferred precedence and the ground-truth calculator.
   */
export function extractDeclaredRequiredCapabilities(clusterSummary: { findings?: Array<{ details?: { requiredCapabilities?: unknown } }> }): string[] {
    for (const finding of clusterSummary.findings ?? []) {
      const declared = (finding.details as Record<string, unknown> | undefined)
        ?.requiredCapabilities;
      if (Array.isArray(declared)) {
        return declared
          .filter((c): c is string => typeof c === 'string')
          .map(c => c.toLowerCase());
      }
    }
    return [];
  }

  /**
   * R35 (bundled with §14.1): the requirements list VERDICT paths compute
   * gaps against — the author-declared list when the event carries one
   * (explicit-over-inferred, the same precedence as the preChecks AND the
   * ground-truth calculator deriveDecisionGroundTruth), the inferred keyword
   * table only when the event declares nothing. Deterministic rule answers
   * scored against the declared face must be derived from the declared face.
   */
export function declaredOrInferredRequirements(clusterSummary: { findings?: Array<{ details?: { requiredCapabilities?: unknown } }> }): string[] {
    for (const finding of clusterSummary.findings ?? []) {
      const declared = (finding.details as Record<string, unknown> | undefined)
        ?.requiredCapabilities;
      if (Array.isArray(declared)) {
        return declared
          .filter((c): c is string => typeof c === 'string')
          .map(c => c.toLowerCase());
      }
    }
    return inferCapabilitiesFromCluster(clusterSummary as Parameters<typeof inferCapabilitiesFromCluster>[0]);
  }

  /**
   * Parse-time collaboration request face: the model's OWN
   * actionPlan.primary.collaboration.partnerCapabilities (lowercased) when it
   * named a non-empty one; the keyword-inferred hint table otherwise (the
   * historical default — a hint for prompts/partner search, never a verdict).
   */
export function modelOrInferredCapabilities(
  modelCapabilities: readonly string[] | undefined,
  clusterSummary: Parameters<typeof inferCapabilitiesFromCluster>[0],
): string[] {
  return modelCapabilities !== undefined && modelCapabilities.length > 0
    ? modelCapabilities.map(cap => cap.toLowerCase())
    : inferCapabilitiesFromCluster(clusterSummary);
}

  /**
   * Initiator-side deterministic request face (P5 metering bridge; 8087 实测:
   * capability-less/no-match AC requests are honestly skipped server-side — 16
   * successful handshakes landed 1 ephemeral agreement). The model decides
   * WHETHER to collaborate; this decides WHAT an initiate_ac request carries
   * when the model named no partnerCapabilities of its own: the event's
   * deterministic GAP NEEDS (computeGapNeeds — declared ∪ inferred minus own
   * coverage, the same computation the partner shortlist ranks against)
   * instead of the raw keyword table — self-covered needs are not something
   * to ask a partner for, and the table's generic caps (monitoring /
   * device-control / …) match no offer surface. Returns undefined when the
   * parse-time face stands (non-initiate decisions, or the model's explicit
   * answer — which always wins). An EMPTY gap is returned as empty: insisting
   * on collaboration with full own coverage has no honest meter target, so
   * the bridge's skip stands.
   */
export function initiatorRequestFace(
  decision: 'initiate_ac' | 'handle_independently' | 'defer' | 'ignore',
  modelCapabilities: readonly string[] | undefined,
  clusterSummary: Parameters<typeof inferCapabilitiesFromCluster>[0],
  agentCapabilities: readonly string[],
): string[] | undefined {
  if (decision !== 'initiate_ac') return undefined;
  if (modelCapabilities !== undefined && modelCapabilities.length > 0) return undefined;
  return computeGapNeeds(
    extractDeclaredRequiredCapabilities(clusterSummary),
    inferCapabilitiesFromCluster(clusterSummary),
    agentCapabilities,
  );
}

  /**
   * FEAT-09 (dorm-life D8): the observe-only verdict — TRUE when the event's
   * requirements have ZERO intersection with the agent's own capability
   * surface (declared ∪ bound-device). Such an audience member still
   * OBSERVES the event (world-model ring) but never enters the initiate
   * evaluation (R103 职能错位: a security officer with zero power-domain
   * capability signed grid-load contracts as a consumer; a duty officer
   * managing no zone ran an LLM decision on every event).
   *
   * The requirements face is declaredOrInferredRequirements — the
   * author-declared requiredCapabilities when the event carries them
   * (explicit-over-inferred, the SAME verdict face ruleOnlyVerdict and the
   * ground-truth calculator score against), the inferred keyword table only
   * when nothing is declared. The matching itself reuses computeGapNeeds —
   * the same capabilityMatches semantics selectRelevant ranks partners
   * against. (Declared ∪ inferred would NOT work here: the anomaly padding
   * in the inference table adds generic 'monitoring'/'emergency-response'
   * needs that substring-match nearly every agent, defeating the gate
   * exactly for declared-requirement events.) An event with NO requirements
   * gates nobody.
   */
  export function isZeroIntersectionAudience(
    clusterSummary: { findings?: Array<{ details?: { requiredCapabilities?: unknown } }> },
    agentCapabilities: readonly string[],
  ): boolean {
    const requirements = declaredOrInferredRequirements(clusterSummary);
    if (requirements.length === 0) return false;
    return computeGapNeeds(requirements, [], agentCapabilities).length === requirements.length;
  }

  /**
   * Rule-only fallback verdict (no LLM configured for the agent): agents
   * with full capability coverage act; agents with a gap defer. R35: the gap
   * is computed against the DECLARED face (declaredOrInferredRequirements)
   * so rule answers agree with ground truth wherever the author declared
   * requirements. Pure; the caller logs/stats/assembles the assessment.
   */
export function ruleOnlyVerdict(
  clusterSummary: { findings?: Array<{ details?: { requiredCapabilities?: unknown } }> },
  agentCapabilities: readonly string[],
): {
  decision: 'handle_independently' | 'defer';
  reasoning: string;
  reasoningCode: 'rule.independent' | 'rule.missing_capabilities_defer';
  reasoningParams: { required: string; missing: string };
  requiredCapabilities: string[];
} {
    const requiredCapabilities = declaredOrInferredRequirements(clusterSummary);
    const missingCapabilities = requiredCapabilities.filter(cap =>
      !agentCapabilities.some(ac => capabilityMatches(ac, cap))
    );
    const covered = missingCapabilities.length === 0;
    return {
      decision: covered ? 'handle_independently' : 'defer',
      reasoning: covered
        ? `Rule-only mode (no LLM): agent has all required capabilities [${requiredCapabilities.join(', ') || 'none'}]. Handling independently.`
        : `Rule-only mode (no LLM): agent lacks required capabilities [${missingCapabilities.join(', ')}] and no LLM is available for partner selection. Deferring.`,
      reasoningCode: covered ? 'rule.independent' : 'rule.missing_capabilities_defer',
      reasoningParams: {
        required: requiredCapabilities.join(', '),
        missing: missingCapabilities.join(', '),
        // R2-UX-11: same empty-parens fix as precheck.independent — the
        // no-requirements case rides the i18next context slot.
        ...(covered && requiredCapabilities.length === 0 ? { context: 'none' } : {}),
      },
      requiredCapabilities,
    };
}

