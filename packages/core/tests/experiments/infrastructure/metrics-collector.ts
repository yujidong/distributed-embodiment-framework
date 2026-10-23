/**
 * Paper Metrics Collector — Sprint P13
 *
 * Computes paper-specific quality, collaboration, and efficiency metrics for
 * Active Collaboration framework experiments. Each metric maps directly to a
 * research-question evaluation criterion defined in the paper:
 *   - Zone Targeting Accuracy        → RQ1 (world model effectiveness)
 *   - Capability Appropriateness      → RQ1 / RQ2 (partner selection quality)
 *   - Side-Effect Awareness           → RQ1 (spatial propagation reasoning)
 *   - Physical Plausibility           → RQ1 (action feasibility)
 *   - Correct Decision Rate           → RQ2 (autonomous collaboration)
 *   - Token / wall-clock efficiency   → RQ3 (resource efficiency)
 */

import type {
  AgentEventType,
  AggregatedTypeWiseMetrics,
  ZoneDef,
  DeviceDef,
  TestEventDef,
  EventResult,
  PaperExperimentConfig,
  PaperExperimentResult,
  ClassificationMetrics,
  PerClassMetrics,
  BinaryClassificationMetrics,
  PartnerSelectionMetrics,
  CapabilityMatchMetrics,
  ConfusionMatrix,
  TypeWiseMetrics,
  TypeWiseMetricsMap,
  FilterMetrics,
} from './types.js';
import { COLLABORATION_DECISIONS } from './types.js';

export class MetricsCollector {
  private zones: ZoneDef[];
  private tokenAccumulator = { prompt: 0, completion: 0 };

  constructor(zones: ZoneDef[]) {
    this.zones = zones;
  }

  // ---------------------------------------------------------------------------
  // Decision-quality metrics
  // ---------------------------------------------------------------------------

  /**
   * Fraction of selected devices that actually reside in the event's zone.
   * Returns 0 when no devices are selected.
   */
  computeZoneTargetingAccuracy(
    event: TestEventDef,
    selectedDeviceIds: string[],
    allDevices: DeviceDef[],
  ): number {
    if (selectedDeviceIds.length === 0) {
      return 0;
    }

    const deviceMap = new Map(allDevices.map((d) => [d.id, d]));
    let correctCount = 0;

    for (const id of selectedDeviceIds) {
      const device = deviceMap.get(id);
      if (device && device.zoneId === event.zoneId) {
        correctCount++;
      }
    }

    return correctCount / selectedDeviceIds.length;
  }

  /**
   * Jaccard-like similarity between required and requested capabilities using
   * fuzzy (substring) matching. Returns 1 when the event requires no
   * capabilities.
   */
  computeCapabilityAppropriateness(
    event: TestEventDef,
    requestedCapabilities: string[],
  ): number {
    if ((event.requiredCapabilities?.length ?? 0) === 0) {
      return 1;
    }

    const fuzzyMatch = (a: string, b: string): boolean => {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();
      return aLower.includes(bLower) || bLower.includes(aLower);
    };

    let intersectionCount = 0;
    const matchedRequired = new Set<number>();
    const matchedRequested = new Set<number>();

    for (let i = 0; i < event.requiredCapabilities.length; i++) {
      for (let j = 0; j < requestedCapabilities.length; j++) {
        if (
          !matchedRequired.has(i) &&
          !matchedRequested.has(j) &&
          fuzzyMatch(event.requiredCapabilities[i], requestedCapabilities[j])
        ) {
          intersectionCount++;
          matchedRequired.add(i);
          matchedRequested.add(j);
        }
      }
    }

    const unionCount =
      event.requiredCapabilities.length +
      requestedCapabilities.length -
      intersectionCount;

    if (unionCount === 0) {
      return 0;
    }

    return intersectionCount / unionCount;
  }

  /**
   * Scores (0-3) how aware the LLM reasoning is of adjacent-zone side effects.
   * Returns 0 when there is no reasoning text or when the event's zone has no
   * adjacent zones.
   *
   * Scoring rubric:
   *   1 — Mentions spatial relationships between zones (adjacent, connected, other zone, etc.)
   *   2 — Mentions propagation/spreading mechanisms (propagat, spread, thermal, etc.)
   *   3 — Propagation mention + quantitative reasoning or mitigation strategy
   */
  computeSideEffectAwareness(
    llmReasoning: string | undefined,
    eventZoneHasAdjacentZones: boolean,
  ): number {
    if (!llmReasoning || !eventZoneHasAdjacentZones) {
      return 0;
    }

    const text = llmReasoning.toLowerCase();

    // Level 1: awareness of spatial relationships between zones
    const adjacencyKeywords = [
      'adjacent', 'neighbor', 'nearby', 'next-to', 'beside',
      'other zone', 'other room', 'other area', 'surrounding',
      'nearby zone', 'nearby room', 'connected', 'contiguous',
      'affect.*zone', 'affect.*room', 'affect.*area',
      'impact.*zone', 'impact.*room', 'impact.*area',
      'influence.*zone', 'influence.*room', 'influence.*area',
      'cross-zone', 'multi-zone', 'multi-room',
    ];
    const hasAdjacency = adjacencyKeywords.some(pattern => {
      try { return new RegExp(pattern).test(text); }
      catch { return text.includes(pattern); }
    });

    if (!hasAdjacency) {
      return 0;
    }

    // Level 2: mentions of propagation/spreading mechanisms
    const propagationKeywords = [
      'propagat', 'spread', 'diffus', 'radiat',
      'side.?effect', 'ripple', 'cascade', 'chain',
      'heat.*transfer', 'heat.*flow', 'thermal',
      'air.*flow', 'air.*circulat',
      'leak', 'seep', 'contaminat',
    ];
    const hasPropagation = propagationKeywords.some(pattern => {
      try { return new RegExp(pattern).test(text); }
      catch { return text.includes(pattern); }
    });

    if (!hasPropagation) {
      return 1;
    }

    // Level 3: quantitative reasoning or mitigation strategy
    const quantitativeKeywords = [
      /\b\d+(\.\d+)?\s*(degree|meter|%|percent|celsius|kelvin|unit)\b/,
      /\b(avoid|prevent|mitigat|alternative|instead|compensat)\b/,
      /\b(isolate|contain|limit|restrict|reduce.*impact)\b/,
      /\b(safe|safeguard|protect|shield)\b/,
    ];
    const hasLevel3 = quantitativeKeywords.some(pattern => pattern.test(text));

    return hasLevel3 ? 3 : 2;
  }

  /**
   * Fraction of selected devices that are physically plausible for the event.
   * A device is plausible when it is in the event zone, or it is in an
   * adjacent zone AND is NOT a sensor.
   */
  computePhysicalPlausibility(
    event: TestEventDef,
    selectedDeviceIds: string[],
    allDevices: DeviceDef[],
  ): number {
    if (selectedDeviceIds.length === 0) {
      return 0;
    }

    const eventZone = this.zones.find((z) => z.id === event.zoneId);
    const adjacentZoneIds: Set<string> = eventZone
      ? new Set(eventZone.adjacentZoneIds)
      : new Set();

    const deviceMap = new Map(allDevices.map((d) => [d.id, d]));
    let plausibleCount = 0;

    for (const id of selectedDeviceIds) {
      const device = deviceMap.get(id);
      if (!device) {
        continue;
      }

      // In the event zone — always plausible
      if (device.zoneId === event.zoneId) {
        plausibleCount++;
        continue;
      }

      // In an adjacent zone — plausible only if not a pure sensor
      if (adjacentZoneIds.has(device.zoneId) && device.type !== 'sensor') {
        plausibleCount++;
      }
    }

    return plausibleCount / selectedDeviceIds.length;
  }

  /**
   * Returns true when the agent's actual decision matches the ground-truth
   * correct decision for this event.
   */
  computeCorrectDecision(
    actualDecision: string,
    event: TestEventDef,
  ): boolean {
    return actualDecision === event.correctDecision;
  }

  // ---------------------------------------------------------------------------
  // Token tracking
  // ---------------------------------------------------------------------------

  /** Accumulate prompt and completion token counts. */
  accumulateTokens(usage: {
    promptTokens: number;
    completionTokens: number;
  }): void {
    this.tokenAccumulator.prompt += usage.promptTokens;
    this.tokenAccumulator.completion += usage.completionTokens;
  }

  /** Return accumulated token counts plus total. */
  getTokenUsage(): { prompt: number; completion: number; total: number } {
    return {
      prompt: this.tokenAccumulator.prompt,
      completion: this.tokenAccumulator.completion,
      total: this.tokenAccumulator.prompt + this.tokenAccumulator.completion,
    };
  }

  /** Reset the token accumulator back to zero. */
  resetTokens(): void {
    this.tokenAccumulator.prompt = 0;
    this.tokenAccumulator.completion = 0;
  }

  // ---------------------------------------------------------------------------
  // Classification metrics (precision / recall / F1)
  // ---------------------------------------------------------------------------

  /**
   * Compute comprehensive classification metrics by comparing predicted
   * decisions against ground truth for all events.
   */
  computeClassificationMetrics(
    events: EventResult[],
    scenarioEvents: TestEventDef[],
  ): ClassificationMetrics {
    // Build lookup from eventId to ground truth
    const groundTruth = new Map<string, TestEventDef>();
    for (const e of scenarioEvents) {
      groundTruth.set(e.id, e);
    }

    // 1. Build 4x4 confusion matrix: matrix[expected][actual]
    const classes = COLLABORATION_DECISIONS;
    const classIndex = new Map(classes.map((c, i) => [c, i]));
    const matrix: ConfusionMatrix = Array.from({ length: 4 }, () => Array(4).fill(0));

    for (const event of events) {
      const gt = groundTruth.get(event.eventId);
      if (!gt) continue;

      const ai = classIndex.get(event.decisionMade) ?? -1;
      const ei = classIndex.get(gt.correctDecision) ?? -1;
      if (ai >= 0 && ei >= 0) {
        matrix[ei][ai]++;
      }
    }

    // 2. Per-class metrics
    const perClass: PerClassMetrics[] = classes.map((className, i) => {
      const tp = matrix[i][i];
      const fp = matrix.reduce((sum, row, j) => j !== i ? sum + row[i] : sum, 0);
      const fn = matrix[i].reduce((sum, val, j) => j !== i ? sum + val : sum, 0);
      const support = matrix[i].reduce((sum, val) => sum + val, 0);

      return {
        className,
        precision: tp + fp === 0 ? 0 : tp / (tp + fp),
        recall: tp + fn === 0 ? 0 : tp / (tp + fn),
        f1: tp + fp === 0 || tp + fn === 0 ? 0 : 2 * tp / (2 * tp + fp + fn),
        tp, fp, fn, support,
      };
    });

    // 3. Macro averages
    const macroPrecision = perClass.reduce((s, m) => s + m.precision, 0) / perClass.length;
    const macroRecall = perClass.reduce((s, m) => s + m.recall, 0) / perClass.length;
    const macroF1 = perClass.reduce((s, m) => s + m.f1, 0) / perClass.length;

    // 4. Binary collaboration-trigger F1 (initiate_ac = positive, rest = negative)
    const acIdx = classIndex.get('initiate_ac')!;
    const tpBinary = matrix[acIdx][acIdx];
    const fpBinary = matrix.reduce((sum, row, j) => j !== acIdx ? sum + row[acIdx] : sum, 0);
    const fnBinary = matrix[acIdx].reduce((sum, val, j) => j !== acIdx ? sum + val : sum, 0);
    const tnBinary = matrix.reduce((sum, row, i) =>
      i !== acIdx ? sum + row.reduce((s, val, j) => j !== acIdx ? s + val : s, 0) : sum, 0);

    const collaborationTriggerF1: BinaryClassificationMetrics = {
      precision: tpBinary + fpBinary === 0 ? 0 : tpBinary / (tpBinary + fpBinary),
      recall: tpBinary + fnBinary === 0 ? 0 : tpBinary / (tpBinary + fnBinary),
      f1: tpBinary + fpBinary === 0 || tpBinary + fnBinary === 0
        ? 0 : 2 * tpBinary / (2 * tpBinary + fpBinary + fnBinary),
      tp: tpBinary, fp: fpBinary, tn: tnBinary, fn: fnBinary,
      support: matrix[acIdx].reduce((s, v) => s + v, 0),
    };

    // 5. Partner selection metrics
    const collabEvents = events.filter(e => {
      const gt = groundTruth.get(e.eventId);
      return gt?.requiresCollaboration === true;
    });
    let partnerTP = 0, partnerFP = 0, partnerFN = 0;
    for (const event of collabEvents) {
      const gt = groundTruth.get(event.eventId)!;
      const predicted = event.selectedPartnerAgentId;
      const correct = gt.correctPartnerId;

      if (correct) {
        if (predicted === correct) {
          partnerTP++;
        } else if (predicted) {
          partnerFP++;
          partnerFN++;
        } else {
          partnerFN++;
        }
      } else if (predicted) {
        partnerTP++; // Any partner acceptable
      }
    }
    const partnerSupport = collabEvents.length;
    const partnerSelection: PartnerSelectionMetrics = {
      partnerPrecision: partnerTP + partnerFP === 0 ? 0 : partnerTP / (partnerTP + partnerFP),
      partnerRecall: partnerTP + partnerFN === 0 ? 0 : partnerTP / (partnerTP + partnerFN),
      partnerF1: partnerTP + partnerFP === 0 || partnerTP + partnerFN === 0
        ? 0 : 2 * partnerTP / (2 * partnerTP + partnerFP + partnerFN),
      support: partnerSupport,
    };

    // 6. Capability matching metrics (fuzzy matching consistent with computeCapabilityAppropriateness)
    const capEvents = events.filter(e => {
      const gt = groundTruth.get(e.eventId);
      return gt && (gt.requiredCapabilities?.length ?? 0) > 0;
    });
    let capTP = 0, capFP = 0, capFN = 0;
    for (const event of capEvents) {
      const gt = groundTruth.get(event.eventId)!;
      const predicted = event.requestedCapabilities ?? [];
      const required = gt.requiredCapabilities;

      const matchedRequired = new Set<number>();
      const matchedPredicted = new Set<number>();
      for (let i = 0; i < required.length; i++) {
        for (let j = 0; j < predicted.length; j++) {
          const rLower = required[i].toLowerCase();
          const pLower = predicted[j].toLowerCase();
          if (
            !matchedRequired.has(i) && !matchedPredicted.has(j) &&
            (rLower.includes(pLower) || pLower.includes(rLower))
          ) {
            capTP++;
            matchedRequired.add(i);
            matchedPredicted.add(j);
          }
        }
      }
      capFP += predicted.length - matchedPredicted.size;
      capFN += required.length - matchedRequired.size;
    }
    const capabilityMatch: CapabilityMatchMetrics = {
      precision: capTP + capFP === 0 ? 0 : capTP / (capTP + capFP),
      recall: capTP + capFN === 0 ? 0 : capTP / (capTP + capFN),
      f1: capTP + capFP === 0 || capTP + capFN === 0 ? 0 : 2 * capTP / (2 * capTP + capFP + capFN),
      support: capEvents.length,
    };

    return {
      perClass,
      macroPrecision, macroRecall, macroF1,
      collaborationTriggerF1,
      confusionMatrix: matrix,
      partnerSelection,
      capabilityMatch,
    };
  }

  // ---------------------------------------------------------------------------
  // Type-wise metrics (V5 Phase 4)
  // ---------------------------------------------------------------------------

  /**
   * Compute per-interaction-type metrics by grouping EventResults by
   * their ground-truth AgentEventType (from the `interactionType` field
   * populated during multi-agent evaluation).
   *
   * Events without an `interactionType` are excluded (they come from
   * single-agent evaluation mode where type-wise breakdown is unavailable).
   */
  computeTypeWiseMetrics(events: EventResult[]): TypeWiseMetricsMap {
    const agentEventTypes: AgentEventType[] = ['A', 'B', 'C', 'D', 'E'];

    // Group events by interaction type
    const grouped = new Map<AgentEventType, EventResult[]>();
    for (const t of agentEventTypes) {
      grouped.set(t, []);
    }
    for (const event of events) {
      if (event.interactionType) {
        grouped.get(event.interactionType)!.push(event);
      }
    }

    // Compute metrics for each type
    const result: Partial<TypeWiseMetricsMap> = {};
    for (const type of agentEventTypes) {
      const group = grouped.get(type)!;
      result[type] = this.computeSingleTypeMetrics(type, group);
    }

    return result as TypeWiseMetricsMap;
  }

  /**
   * Compute metrics for a single interaction type.
   */
  private computeSingleTypeMetrics(
    type: AgentEventType,
    events: EventResult[],
  ): TypeWiseMetrics {
    const n = events.length;

    if (n === 0) {
      return this.emptyTypeMetrics(type);
    }

    // Decision accuracy
    const correctCount = events.filter(e => e.correctDecision).length;
    const decisionAccuracy = correctCount / n;

    // Mean quality metrics
    const mean = (vals: number[]) =>
      vals.length === 0 ? 0 : vals.reduce((s, v) => s + v, 0) / vals.length;

    const meanZoneTargetingAccuracy = mean(events.map(e => e.zoneTargetingAccuracy));
    const meanCapabilityAppropriateness = mean(events.map(e => e.capabilityAppropriateness));
    const meanPhysicalPlausibility = mean(events.map(e => e.physicalPlausibility));

    // Decision breakdown
    const decisions: CollaborationDecision[] = [...COLLABORATION_DECISIONS];
    const decisionBreakdown = {} as Record<CollaborationDecision, { predicted: number; correct: number }>;
    for (const d of decisions) {
      decisionBreakdown[d] = {
        predicted: events.filter(e => e.decisionMade === d).length,
        correct: 0, // filled below
      };
    }

    // For "correct" counts, we need to know what the ground-truth correct decision was.
    // In multi-agent mode, events that have correctDecision=true tell us the agent
    // matched the ground truth. We derive which decision was correct from the type:
    //   Type A → handle_independently
    //   Type B → initiate_ac
    //   Type C → initiate_ac/defer (already accounted for in the ground truth)
    //   Type D → defer/ignore
    //   Type E → initiate_ac
    // Since the ground-truth is already evaluated per-event via correctDecision,
    // we count how many had each decision as "correct" by finding the dominant
    // correct decision in the group.
    const correctDecisions = events.filter(e => e.correctDecision);
    for (const d of decisions) {
      decisionBreakdown[d].correct = correctDecisions.filter(e => e.decisionMade === d).length;
    }

    // Trigger F1: binary classification of "should initiate_ac" vs "should not"
    // We determine positive/negative from the actual ground truth:
    // - events where correctDecision=true and decisionMade=initiate_ac → TP
    // - events where correctDecision=false and decisionMade=initiate_ac → FP
    // - events where correctDecision=false and decisionMade!=initiate_ac → FN

    const initiatePredicted = events.filter(e => e.decisionMade === 'initiate_ac');
    const notInitiatePredicted = events.filter(e => e.decisionMade !== 'initiate_ac');

    const tp = initiatePredicted.filter(e => e.correctDecision).length;
    const fp = initiatePredicted.filter(e => !e.correctDecision).length;
    const fn = notInitiatePredicted.filter(e => !e.correctDecision).length;

    const triggerF1 = tp + fp === 0 || tp + fn === 0
      ? 0
      : 2 * tp / (2 * tp + fp + fn);

    return {
      type,
      support: n,
      decisionAccuracy,
      meanZoneTargetingAccuracy,
      meanCapabilityAppropriateness,
      meanPhysicalPlausibility,
      decisionBreakdown,
      triggerF1,
    };
  }

  /**
   * Create a zeroed-out TypeWiseMetrics for a type with no events.
   */
  private emptyTypeMetrics(type: AgentEventType): TypeWiseMetrics {
    const emptyBreakdown = {} as Record<CollaborationDecision, { predicted: number; correct: number }>;
    for (const d of COLLABORATION_DECISIONS) {
      emptyBreakdown[d] = { predicted: 0, correct: 0 };
    }

    return {
      type,
      support: 0,
      decisionAccuracy: 0,
      meanZoneTargetingAccuracy: 0,
      meanCapabilityAppropriateness: 0,
      meanPhysicalPlausibility: 0,
      decisionBreakdown: emptyBreakdown,
      triggerF1: 0,
    };
  }

  /**
   * Merge multiple TypeWiseMetricsMaps from different scenarios or conditions
   * into a single aggregated result using support-weighted averaging.
   */
  mergeTypeWiseMetrics(maps: TypeWiseMetricsMap[]): AggregatedTypeWiseMetrics {
    const types: AgentEventType[] = ['A', 'B', 'C', 'D', 'E'];
    const byType: Partial<TypeWiseMetricsMap> = {};

    for (const type of types) {
      const entries = maps.map(m => m[type]).filter(Boolean);

      if (entries.length === 0) {
        byType[type] = this.emptyTypeMetrics(type);
        continue;
      }

      const totalSupport = entries.reduce((s, e) => s + e.support, 0);

      if (totalSupport === 0) {
        byType[type] = this.emptyTypeMetrics(type);
        continue;
      }

      // Support-weighted means
      const w = (e: TypeWiseMetrics) => e.support / totalSupport;

      const decisionAccuracy = entries.reduce((s, e) => s + e.decisionAccuracy * w(e), 0);
      const meanZoneTargetingAccuracy = entries.reduce((s, e) => s + e.meanZoneTargetingAccuracy * w(e), 0);
      const meanCapabilityAppropriateness = entries.reduce((s, e) => s + e.meanCapabilityAppropriateness * w(e), 0);
      const meanPhysicalPlausibility = entries.reduce((s, e) => s + e.meanPhysicalPlausibility * w(e), 0);

      // Merge decision breakdowns
      const decisionBreakdown = {} as Record<CollaborationDecision, { predicted: number; correct: number }>;
      for (const d of COLLABORATION_DECISIONS) {
        decisionBreakdown[d] = {
          predicted: entries.reduce((s, e) => s + e.decisionBreakdown[d].predicted, 0),
          correct: entries.reduce((s, e) => s + e.decisionBreakdown[d].correct, 0),
        };
      }

      // Trigger F1: support-weighted average of per-entry trigger F1s
      const triggerF1 = entries.reduce((s, e) => s + e.triggerF1 * w(e), 0);

      byType[type] = {
        type,
        support: totalSupport,
        decisionAccuracy,
        meanZoneTargetingAccuracy,
        meanCapabilityAppropriateness,
        meanPhysicalPlausibility,
        decisionBreakdown,
        triggerF1,
      };
    }

    const totalSupport = types.reduce((s, t) => s + (byType[t]?.support ?? 0), 0);

    return {
      byType: byType as TypeWiseMetricsMap,
      mergedCount: maps.length,
      totalSupport,
    };
  }

  // ---------------------------------------------------------------------------
  // Filter efficiency metrics (V5 Phase 7)
  // ---------------------------------------------------------------------------

  /**
   * Compute metrics for the dual-layer filter architecture.
   *
   * Layer 1 (rule-based) events are identified by `assessmentTimeMs === 0`.
   * Layer 2 (LLM) events have `assessmentTimeMs > 0`.
   *
   * Measures:
   *   - Layer 1 precision: how often Layer 1's decisions are correct
   *   - Layer 1 false negative rate: events Layer 1 handled but got wrong
   *   - Layer 2 accuracy: correctness of LLM-evaluated events
   *   - Token savings vs. an all-LLM baseline
   */
  computeFilterMetrics(
    events: EventResult[],
    totalTokens: number,
  ): FilterMetrics {
    const totalEvents = events.length;

    if (totalEvents === 0) {
      return {
        totalEvents: 0,
        layer1Handled: 0,
        layer1FilterRate: 0,
        layer1Correct: 0,
        layer1Precision: 0,
        layer1FalseNegativeRate: 0,
        layer2Handled: 0,
        layer2Correct: 0,
        layer2Accuracy: 0,
        tokenSavingsRate: 0,
        actualTokens: 0,
        estimatedAllLlmTokens: 0,
      };
    }

    // Split events into Layer 1 and Layer 2
    const layer1Events = events.filter(e => e.assessmentTimeMs === 0);
    const layer2Events = events.filter(e => e.assessmentTimeMs > 0);

    const layer1Handled = layer1Events.length;
    const layer2Handled = layer2Events.length;
    const layer1FilterRate = layer1Handled / totalEvents;

    // Layer 1 correctness
    const layer1Correct = layer1Events.filter(e => e.correctDecision).length;
    const layer1Incorrect = layer1Handled - layer1Correct;
    const layer1Precision = layer1Handled === 0 ? 0 : layer1Correct / layer1Handled;

    // False negative rate: events Layer 1 handled that were incorrect
    // (they should have been escalated to LLM)
    const layer1FalseNegativeRate = layer1Handled === 0
      ? 0
      : layer1Incorrect / layer1Handled;

    // Layer 2 correctness
    const layer2Correct = layer2Events.filter(e => e.correctDecision).length;
    const layer2Accuracy = layer2Handled === 0 ? 0 : layer2Correct / layer2Handled;

    // Token savings estimation
    // Average tokens per Layer 2 event
    const avgTokensPerLlmEvent = layer2Handled === 0
      ? 0
      : totalTokens / layer2Handled;

    // Estimated tokens if ALL events went to LLM
    const estimatedAllLlmTokens = avgTokensPerLlmEvent * totalEvents;

    // Token savings rate
    const tokenSavingsRate = estimatedAllLlmTokens === 0
      ? 0
      : 1 - (totalTokens / estimatedAllLlmTokens);

    return {
      totalEvents,
      layer1Handled,
      layer1FilterRate,
      layer1Correct,
      layer1Precision,
      layer1FalseNegativeRate,
      layer2Handled,
      layer2Correct,
      layer2Accuracy,
      tokenSavingsRate,
      actualTokens: totalTokens,
      estimatedAllLlmTokens,
    };
  }

  // ---------------------------------------------------------------------------
  // Aggregation
  // ---------------------------------------------------------------------------

  /**
   * Aggregate per-event results into a single PaperExperimentResult suitable
   * for inclusion in the paper's data tables and figures.
   */
  aggregateResults(
    events: EventResult[],
    config: PaperExperimentConfig,
    iteration: number,
    wallTimeMs: number,
    dualTriggerStats: Record<string, unknown>,
    scenarioEvents?: TestEventDef[],
  ): PaperExperimentResult {
    const n = events.length;

    // Helper: safe mean over an array of numbers (returns 0 for empty arrays)
    const mean = (values: number[]): number =>
      values.length === 0
        ? 0
        : values.reduce((sum, v) => sum + v, 0) / values.length;

    // Decision-quality means
    const meanZoneTargetingAccuracy = mean(
      events.map((e) => e.zoneTargetingAccuracy),
    );
    const meanCapabilityAppropriateness = mean(
      events.map((e) => e.capabilityAppropriateness),
    );
    const meanSideEffectAwareness = mean(
      events.map((e) => e.sideEffectAwareness),
    );
    const meanPhysicalPlausibility = mean(
      events.map((e) => e.physicalPlausibility),
    );
    const meanCorrectDecisionRate =
      n === 0
        ? 0
        : events.filter((e) => e.correctDecision).length / n;

    // Collaboration rates
    const collaborationInitiated = events.filter(
      (e) =>
        e.decisionMade === 'initiate_ac' ||
        e.decisionMade === 'defer',
    );
    const initiationRate = n === 0 ? 0 : collaborationInitiated.length / n;

    const formationSuccesses = collaborationInitiated.filter(
      (e) => e.selectedPartnerAgentId !== undefined,
    );
    const formationSuccessRate =
      collaborationInitiated.length === 0
        ? 0
        : formationSuccesses.length / collaborationInitiated.length;

    const goalAchievedEvents = events.filter(
      (e) => e.goalAchieved === true,
    );
    const goalAchievementRate = n === 0 ? 0 : goalAchievedEvents.length / n;

    // Optimal performance: correct decision AND goal achieved
    const optimalEvents = events.filter(
      (e) => e.correctDecision && e.goalAchieved === true,
    );
    const optimalPerformanceRatio = n === 0 ? 0 : optimalEvents.length / n;

    // Efficiency metrics
    const tokens = this.getTokenUsage();
    const assessmentTimes = events.map((e) => e.assessmentTimeMs);
    const avgAssessmentTimeMs = mean(assessmentTimes);

    // Count Layer-1 filtered events: events with assessmentTimeMs === 0 were
    // handled entirely by the rule-based layer.
    const layer1Filtered = events.filter(
      (e) => e.assessmentTimeMs === 0,
    ).length;
    const layer1FilterRate = n === 0 ? 0 : layer1Filtered / n;

    // LLM call count: events that went through Layer 2 have non-zero
    // assessment time. Each such event corresponds to at least one LLM call.
    const llmCallCount = events.filter((e) => e.assessmentTimeMs > 0).length;

    // Classification metrics (precision/recall/F1)
    const classification = scenarioEvents
      ? this.computeClassificationMetrics(events, scenarioEvents)
      : undefined;

    return {
      config,
      iteration,
      timestamp: new Date().toISOString(),
      events,

      decisionQuality: {
        meanZoneTargetingAccuracy,
        meanCapabilityAppropriateness,
        meanSideEffectAwareness,
        meanPhysicalPlausibility,
        meanCorrectDecisionRate,
      },

      collaboration: {
        initiationRate,
        formationSuccessRate,
        goalAchievementRate,
        optimalPerformanceRatio,
      },

      efficiency: {
        totalEvents: n,
        layer1Filtered,
        layer1FilterRate,
        llmCallCount,
        totalTokens: tokens.total,
        promptTokens: tokens.prompt,
        completionTokens: tokens.completion,
        avgAssessmentTimeMs,
        totalWallTimeMs: wallTimeMs,
      },

      // Robustness metrics — only populated for RQ4
      ...(config.rq === 'RQ4' && config.failureType
        ? {
            robustness: {
              failureType: config.failureType,
              gracefulDegradationCount: events.filter((e) => e.correctDecision).length,
              gracefulDegradationRate: n === 0 ? 0 : events.filter((e) => e.correctDecision).length / n,
              systemAvailability: events.length > 0 ? 1 : 0,
              avgRecoveryTimeMs: mean(events.filter((e) => e.assessmentTimeMs > 0).map((e) => e.assessmentTimeMs)),
            },
          }
        : {}),

      rawDualTriggerStats: dualTriggerStats,
      classification,
    };
  }
}
