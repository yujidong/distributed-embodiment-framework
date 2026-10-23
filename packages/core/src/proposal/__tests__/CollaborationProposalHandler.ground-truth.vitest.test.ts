/**
 * @vitest-environment node
 *
 * CollaborationProposalHandler R6-C-F03 tests — responder-side event
 * ground-truth verification.
 *
 * The incident (data/usertest-r6/track-c-scenarios.md F03): hotel occupancy
 * events (lunch-rush class, no environmental anomaly) induced hallucinated
 * ACs — the front-desk steward invented emergencies ("CO2 breach",
 * "critical temperature spikes", "Emergency HVAC failure") and the
 * responders accepted 17/18, because the evaluation only matched capability
 * semantics and never checked the claimed situation against the physical
 * world. Decision correctness dropped to 0.80 vs 0.96/1.00 in the other
 * domains.
 *
 * The fix pins four behaviors:
 *
 * 1. LLM lane: the evaluation prompt carries an EVENT GROUND TRUTH section
 *    assembled from the RESPONDER's own observations (zone readings vs
 *    expected ranges, the trigger event's factual type/zone), plus a
 *    GROUND-TRUTH CHECK criterion — contradiction → reject with the
 *    contradiction named in the reasoning.
 * 2. Rule/fallback lane: a detected contradiction refuses the auto-accept
 *    the capability match would otherwise produce.
 * 3. Honesty boundaries: unverifiable (trigger zone outside the observation
 *    range) and missing-reading cases are ANNOTATED, never rejected for
 *    that reason alone — and never invented.
 * 4. Legacy pin: an unwired groundTruthSurface keeps the prompt
 *    byte-identical to the pre-F03 shape.
 */

import { describe, it, expect } from 'vitest';

import { CollaborationProposalHandler } from '../CollaborationProposalHandler.js';
import {
  assessProposalGroundTruth,
  triggerRefOf,
} from '../ground-truth.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { ChatParams, ChatResponse, LLMClient } from '@active-collaboration/llm-integration';
import type { ProposalGroundTruthFace } from '../../types/proposal-handler.js';
import { EventManager } from '../../events/EventManager.js';
import { EventType, EventPriority } from '@active-collaboration/shared';

const CANNED_ACCEPT = JSON.stringify({
  benefitScore: 0.9,
  costScore: 0.1,
  benefits: ['can help'],
  costs: [],
  recommendedDecision: 'accept',
  reasoning: 'cheap to help',
});

function okResponse(content: string): ChatResponse {
  return {
    content,
    model: 'mock-model',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** The responder observes the restaurant zone: lunch-rush occupancy, all readings normal. */
const RESTAURANT_NORMAL_FACE: ProposalGroundTruthFace = {
  observableZoneIds: ['restaurant', 'lobby'],
  zoneReadings: [
    { zoneId: 'restaurant', parameters: { temperature: 24, co2: 610, occupancy: 42 } },
  ],
  recentEvents: [
    { type: 'lunch-rush', zoneId: 'restaurant', parameter: 'occupancy', value: 42 },
  ],
};

/** Same zone, but the temperature REALLY is out of range. */
const RESTAURANT_HOT_FACE: ProposalGroundTruthFace = {
  observableZoneIds: ['restaurant', 'lobby'],
  zoneReadings: [
    { zoneId: 'restaurant', parameters: { temperature: 33.5, co2: 610, occupancy: 42 } },
  ],
  recentEvents: [
    { type: 'lunch-rush', zoneId: 'restaurant', parameter: 'occupancy', value: 42 },
  ],
};

function setup(options: {
  chat?: (params: ChatParams) => Promise<ChatResponse>;
  face?: ProposalGroundTruthFace;
}) {
  const prompts: string[] = [];
  const llmClient = {
    chat: async (params: ChatParams) => {
      const content = typeof params.messages[0]?.content === 'string'
        ? params.messages[0].content
        : '';
      prompts.push(content);
      if (options.chat !== undefined) return options.chat(params);
      return okResponse(CANNED_ACCEPT);
    },
  } as unknown as LLMClient;

  const eventManager = new EventManager(1000);
  const handler = new CollaborationProposalHandler({
    llmClient,
    environment: { eventManager } as unknown as EnvironmentCenter,
    agentId: 'agent-1',
    agentName: 'Responder',
    agentCapabilities: ['cooling', 'temperature-control'],
    config: {
      enabled: true,
      criteria: { minBenefitThreshold: 0.5, maxCostThreshold: 0.7 },
      autoExecuteAccepted: false,
      notifyAllProposals: false,
      maxConcurrentCollaborations: 5,
    },
    ...(options.face !== undefined
      ? { groundTruthSurface: () => options.face! }
      : {}),
  });
  const published: Array<Record<string, unknown>> = [];
  eventManager.subscribe({
    subscriberId: 'recorder',
    eventType: EventType.COLLABORATION_MESSAGE,
    handler: event => {
      published.push(event.payload as Record<string, unknown>);
    },
    priority: EventPriority.NORMAL,
  });
  handler.start();
  return { eventManager, handler, published, prompts };
}

function propose(
  eventManager: EventManager,
  extra: Record<string, unknown> = {},
): void {
  eventManager.publish({
    type: EventType.COLLABORATION_MESSAGE,
    source: 'agent-2',
    priority: EventPriority.NORMAL,
    payload: {
      type: 'ac-proposal',
      collaborationId: 'ac-1',
      initiatorId: 'agent-2',
      targetAgentId: 'agent-1',
      requiredCapabilities: ['cooling'],
      description: 'Help with the lunch rush',
      ...extra,
    },
    metadata: {},
  });
}

const HALLUCINATED_EMERGENCY =
  'Emergency: CO2 breach in restaurant, critical levels — immediate response required';

describe('R6-C-F03 LLM lane — the EVENT GROUND TRUTH prompt section', () => {
  it('contradiction: claimed CO2 emergency vs all-normal readings → section shows readings + VERDICT + criterion 7', async () => {
    const { eventManager, handler, published, prompts } = setup({ face: RESTAURANT_NORMAL_FACE });
    propose(eventManager, {
      description: HALLUCINATED_EMERGENCY,
      triggerEventType: 'lunch-rush',
      triggerEventId: 'evt-lunch-1',
      triggerZoneId: 'restaurant',
    });
    await sleep(100);

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    expect(prompt).toContain('EVENT GROUND TRUTH');
    expect(prompt).toContain("type 'lunch-rush'");
    expect(prompt).toContain("zone 'restaurant'");
    expect(prompt).toContain('co2=610 (expected [350, 1000], normal)');
    expect(prompt).toContain('temperature=24 (expected [18, 28], normal)');
    expect(prompt).toContain('Anomalies visible to you: NONE');
    expect(prompt).toContain('CONTRADICTS your observations');
    expect(prompt).toContain('Recent events you observed in this zone: lunch-rush (occupancy=42)');
    expect(prompt).toContain('7. GROUND-TRUTH CHECK');
    expect(prompt).toContain('REJECT and name the contradiction');

    // The LLM still decides — a canned accept stays an accept (prompt-level rule).
    const answers = published.filter(p => p.type === 'join-response');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ acDecision: 'accept', evaluationSource: 'llm' });
    handler.stop();
  });

  it('consistent: readings show a REAL temperature anomaly → flagged, no contradiction verdict', async () => {
    const { eventManager, handler, prompts } = setup({ face: RESTAURANT_HOT_FACE });
    propose(eventManager, {
      description: 'Urgent: temperature spike in restaurant, cooling support needed',
      triggerEventType: 'temperature-spike',
      triggerZoneId: 'restaurant',
    });
    await sleep(100);

    const prompt = prompts[0];
    expect(prompt).toContain('EVENT GROUND TRUTH');
    expect(prompt).toContain('temperature=33.5 — OUTSIDE expected [18, 28]');
    expect(prompt).toContain('Anomalies visible to you: restaurant.temperature=33.5 outside expected [18, 28]');
    expect(prompt).not.toContain('CONTRADICTS your observations');
    handler.stop();
  });

  it('unverifiable: trigger zone outside the observation range → annotated, explicitly NOT grounds for rejection', async () => {
    const { eventManager, handler, prompts } = setup({ face: RESTAURANT_NORMAL_FACE });
    propose(eventManager, {
      description: HALLUCINATED_EMERGENCY,
      triggerEventType: 'lunch-rush',
      triggerZoneId: 'rooftop-garden',
    });
    await sleep(100);

    const prompt = prompts[0];
    expect(prompt).toContain("zone 'rooftop-garden'");
    expect(prompt).toContain('OUTSIDE your observation range');
    expect(prompt).toContain('CANNOT independently verify');
    expect(prompt).toContain('NOT grounds for rejection by itself');
    expect(prompt).not.toContain('CONTRADICTS your observations');
    handler.stop();
  });

  it('no readings: observable zone without sensor data → honest "no current readings" annotation', async () => {
    const { eventManager, handler, prompts } = setup({
      face: { observableZoneIds: ['restaurant'], zoneReadings: [], recentEvents: [] },
    });
    propose(eventManager, {
      description: HALLUCINATED_EMERGENCY,
      triggerEventType: 'lunch-rush',
      triggerZoneId: 'restaurant',
    });
    await sleep(100);

    const prompt = prompts[0];
    expect(prompt).toContain('NO current sensor readings');
    expect(prompt).toContain('NOT grounds for rejection by itself');
    expect(prompt).not.toContain('CONTRADICTS your observations');
    handler.stop();
  });

  it('no trigger reference at all → skepticism note, no invented zone', async () => {
    const { eventManager, handler, prompts } = setup({ face: RESTAURANT_NORMAL_FACE });
    propose(eventManager, { description: HALLUCINATED_EMERGENCY });
    await sleep(100);

    const prompt = prompts[0];
    expect(prompt).toContain('EVENT GROUND TRUTH');
    expect(prompt).toContain('no trigger-event reference');
    expect(prompt).not.toContain('CONTRADICTS your observations');
    handler.stop();
  });

  it('legacy pin: unwired groundTruthSurface → no section, no criterion 7 (byte-identical prompt shape)', async () => {
    const { eventManager, handler, prompts } = setup({});
    propose(eventManager, {
      description: HALLUCINATED_EMERGENCY,
      triggerEventType: 'lunch-rush',
      triggerZoneId: 'restaurant',
    });
    await sleep(100);

    const prompt = prompts[0];
    expect(prompt).not.toContain('EVENT GROUND TRUTH');
    expect(prompt).not.toContain('GROUND-TRUTH CHECK');
    expect(prompt).toContain('6. SERVICE MATCH');
    handler.stop();
  });
});

describe('R6-C-F03 rule/fallback lane — contradiction refuses the auto-accept', () => {
  const llmDown = async (): Promise<ChatResponse> => {
    throw new Error('provider down');
  };

  it('contradiction + full capability match → REJECT (pre-fix: rubber-stamped accept)', async () => {
    const { eventManager, handler, published } = setup({ chat: llmDown, face: RESTAURANT_NORMAL_FACE });
    propose(eventManager, {
      description: HALLUCINATED_EMERGENCY,
      triggerEventType: 'lunch-rush',
      triggerZoneId: 'restaurant',
    });
    await sleep(100);

    const answers = published.filter(p => p.type === 'reject');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ acDecision: 'reject', evaluationSource: 'fallback' });
    expect(String(answers[0].reason)).toContain('Ground-truth rejection');
    expect(String(answers[0].reason)).toContain('restaurant');
    expect(published.filter(p => p.type === 'join-response')).toHaveLength(0);
    handler.stop();
  });

  it('consistent readings + capability match → fallback still ACCEPTs (no regression)', async () => {
    const { eventManager, handler, published } = setup({ chat: llmDown, face: RESTAURANT_HOT_FACE });
    propose(eventManager, {
      description: 'Urgent: temperature spike in restaurant, cooling support needed',
      triggerEventType: 'temperature-spike',
      triggerZoneId: 'restaurant',
    });
    await sleep(100);

    const answers = published.filter(p => p.type === 'join-response');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ acDecision: 'accept', evaluationSource: 'fallback' });
    handler.stop();
  });

  it('unverifiable zone + capability match → fallback ACCEPTs (observing nothing is not a rejection)', async () => {
    const { eventManager, handler, published } = setup({ chat: llmDown, face: RESTAURANT_NORMAL_FACE });
    propose(eventManager, {
      description: HALLUCINATED_EMERGENCY,
      triggerEventType: 'lunch-rush',
      triggerZoneId: 'rooftop-garden',
    });
    await sleep(100);

    const answers = published.filter(p => p.type === 'join-response');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ acDecision: 'accept', evaluationSource: 'fallback' });
    handler.stop();
  });

  it('honest occupancy narrative (no emergency claim) + normal readings → fallback ACCEPTs', async () => {
    const { eventManager, handler, published } = setup({ chat: llmDown, face: RESTAURANT_NORMAL_FACE });
    propose(eventManager, {
      description: 'Lunch rush in restaurant — extra cooling support welcome',
      triggerEventType: 'lunch-rush',
      triggerZoneId: 'restaurant',
    });
    await sleep(100);

    const answers = published.filter(p => p.type === 'join-response');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ acDecision: 'accept', evaluationSource: 'fallback' });
    handler.stop();
  });
});

describe('R6-C-F03 pure check — assessProposalGroundTruth', () => {
  it('claimed parameter NOT among the readings → consistent with an honesty note, never a contradiction', () => {
    const check = assessProposalGroundTruth(
      { triggerEventType: 'alarm', triggerZoneId: 'restaurant' },
      RESTAURANT_NORMAL_FACE,
      'Emergency: smoke hazard in restaurant',
    );
    expect(check.status).toBe('consistent');
    expect(check.claimsEmergency).toBe(true);
    expect(check.claimedParameters).toEqual(['smoke']);
    expect(check.note).toContain("no such reading");
  });

  it('emergency claim without a specific parameter + all-normal readings → contradiction', () => {
    const check = assessProposalGroundTruth(
      { triggerEventType: 'lunch-rush', triggerZoneId: 'restaurant' },
      RESTAURANT_NORMAL_FACE,
      'Emergency HVAC failure — immediate response required',
    );
    expect(check.status).toBe('contradiction');
  });

  it('triggerRefOf reads the normalized metadata face', () => {
    const ref = triggerRefOf({
      id: 'p1',
      proposedBy: 'a',
      proposedTo: 'b',
      type: 'collaboration-invitation',
      goal: 'g',
      capabilities: [],
      metadata: { triggerEventType: 'lunch-rush', triggerEventId: 'evt-1', triggerZoneId: 'restaurant' },
    });
    expect(ref).toEqual({
      triggerEventType: 'lunch-rush',
      triggerEventId: 'evt-1',
      triggerZoneId: 'restaurant',
    });
  });
});
