/**
 * Semantic offer rules — the AGENT-level service abstraction (R53).
 *
 * The W3 derivation materializes one service per bound device × capability
 * ("排涝智能阀 1: open"). That is a faithful capability projection, but it
 * makes the agent's public face a device-command listing — collaborators
 * cannot contract for OUTCOMES ("排涝调度"), only for device ops, and the
 * catalog reads as if agents exposed their hardware directly.
 *
 * A semantic offer is what an agent can DO with its capability bundle:
 * a steward holding valve-control + water-level-monitoring across its
 * district pumps offers `drainage-control`. Rules are grounded in the
 * facility-type capability surfaces (they deliberately keep the R45
 * "pairwise-incomparable steward types" property — no two facility types
 * match the same rule) and each carries a non-empty actuation backing, so
 * an agreement on the offer authorizes a real executable surface.
 *
 * Pure module: rules + a derivation function over a capability union. The
 * import/backfill sync (server service-store) turns them into
 * origin='aggregate' service rows and unions the semantic types into the
 * agent's declared capabilities, putting the AC partner-matching surface
 * on the semantic level too.
 */

/** One aggregate service an agent may offer when its bundle qualifies. */
export interface SemanticOfferRule {
  /** Stable service semantic type (the contract vocabulary). */
  semanticType: string;
  /** Operator-facing offer name. */
  label: string;
  description: string;
  /** Capabilities that ALL must be present in the agent's union. */
  requires: readonly string[];
  /**
   * Capabilities that back ACTUATION — at least one must be present, and
   * exactly these form the offer's callable surface (agreements authorize
   * this set). Observation-only bundles deliberately have no rule here.
   */
  actuates: readonly string[];
}

export const SEMANTIC_OFFER_RULES: readonly SemanticOfferRule[] = [
  {
    semanticType: 'drainage-control',
    label: '区域排涝调度',
    description: '监控辖区水位并调度排涝阀组：水位告警时按梯度开阀、跨泵站联动排水。',
    requires: ['valve-control', 'water-level-monitoring'],
    actuates: ['valve-control'],
  },
  {
    semanticType: 'grid-load-management',
    label: '电网负荷调度',
    description: '监视变电站负载与能耗，执行负荷转移、削峰与备用电源投切。',
    requires: ['power-monitoring', 'energy-monitoring'],
    actuates: ['turn-on', 'turn-off'],
  },
  {
    semanticType: 'campus-air-comfort',
    label: '校园空气环境保障',
    description: '空气质量联动暖通：PM/CO₂ 超标时调节新风、制冷与制热，保障教学环境。',
    requires: ['air-quality-monitoring', 'temperature-control', 'cooling'],
    actuates: ['temperature-control', 'cooling'],
  },
  {
    semanticType: 'crowd-dispatch',
    label: '客流调度播控',
    description: '信号配时与情报板播控联动，疏导演练与应急时的枢纽客流。',
    requires: ['signal-control', 'content-display', 'set-message'],
    actuates: ['signal-control', 'set-message'],
  },
  {
    semanticType: 'medical-environment-support',
    label: '医疗环境保障',
    description: '病房环境与生命体征监测联动，供电异常时保障诊疗区温控。',
    requires: ['vital-signs-monitoring', 'temperature-control', 'power-monitoring'],
    actuates: ['temperature-control'],
  },
  {
    semanticType: 'shelter-life-support',
    label: '避难安置保障',
    description: '安置区照明、安防与温控联动，台风转移期间维持基本生活保障。',
    requires: ['security-monitoring', 'temperature-control', 'lighting-control'],
    actuates: ['lighting-control'],
  },
  {
    semanticType: 'metro-flood-defense',
    label: '地铁防涝处置',
    description: '出入口水位监视联动站内照明与设备启停，防御区间倒灌。',
    requires: ['water-level-monitoring', 'lighting-control'],
    actuates: ['lighting-control', 'turn-on'],
  },
];

/**
 * Merge scenario-authored rules over the built-in table: custom rules come
 * first, and a custom rule whose semanticType collides with a built-in one
 * REPLACES it (dedupe by semanticType, custom wins). The default
 * (`mergeOfferRules()` / no custom rules) returns exactly the built-in
 * table, so existing callers keep their behavior.
 */
export function mergeOfferRules(
  custom: readonly SemanticOfferRule[] = [],
): SemanticOfferRule[] {
  const customTypes = new Set(custom.map(rule => rule.semanticType));
  return [
    ...custom,
    ...SEMANTIC_OFFER_RULES.filter(rule => !customTypes.has(rule.semanticType)),
  ];
}

/**
 * The semantic offers an agent qualifies for: every required capability
 * present in the union AND at least one actuation capability. The union is
 * the agent's bound-device capabilities (± its own declared capabilities —
 * the caller decides what feeds the union). `rules` defaults to the
 * built-in table; pass `mergeOfferRules(custom)` to evaluate a scenario's
 * authored rules on top of it.
 */
export function semanticOffersOf(
  capabilityUnion: ReadonlySet<string>,
  rules: readonly SemanticOfferRule[] = SEMANTIC_OFFER_RULES,
): SemanticOfferRule[] {
  return rules.filter(
    rule =>
      rule.requires.every(capability => capabilityUnion.has(capability)) &&
      rule.actuates.some(capability => capabilityUnion.has(capability)),
  );
}

/**
 * The semantic vocabulary the agent should DECLARE (its AC
 * partner-matching surface) once its bundle qualifies: exactly the
 * semantic types of its offers.
 */
export function semanticCapabilityTypesOf(
  capabilityUnion: ReadonlySet<string>,
  rules: readonly SemanticOfferRule[] = SEMANTIC_OFFER_RULES,
): string[] {
  return semanticOffersOf(capabilityUnion, rules).map(rule => rule.semanticType);
}
