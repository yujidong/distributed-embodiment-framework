/**
 * R6-C-F03 — Proposal ground-truth check (responder-side event verification).
 *
 * The incident (data/usertest-r6/track-c-scenarios.md F03): hotel occupancy
 * events ("lunch-rush" class, no environmental anomaly) induced HALLUCINATED
 * ACs — the initiator invented emergencies ("CO2 breach", "critical
 * temperature spikes", "Emergency HVAC failure") and the responders accepted
 * 17/18, because the evaluation only matched capability semantics and never
 * checked the claimed situation against the physical world.
 *
 * This module is the deterministic core of the fix, shared by both
 * evaluation lanes of CollaborationProposalHandler:
 *
 * - the LLM lane renders `renderGroundTruthSection` into the prompt (the
 *   EVENT GROUND TRUTH section) plus a GROUND-TRUTH CHECK criterion;
 * - the capability fallback ("rule" lane) refuses to auto-accept when the
 *   check returns status 'contradiction'.
 *
 * Data source: the responder's OWN observation face (ProposalGroundTruthFace
 * — world-model parameter projection + observable-zone set + digested event
 * ring). Zone-scoped event delivery already gates what could enter that
 * face, so "observable" here means "this agent actually manages/has
 * devices in/has received readings from the zone".
 *
 * Honesty contract:
 * - unverifiable (trigger zone outside the observation range) is NOT grounds
 *   for rejection — the section says so explicitly and the rule lane proceeds
 *   with normal capability matching;
 * - a missing sensor reading is rendered as missing, never invented;
 * - 'contradiction' fires ONLY when the proposal claims a physical emergency
 *   AND the responder's readings of the trigger zone exist AND everything
 *   observed there is within its expected range AND at least one claimed
 *   parameter is actually observed (or no specific parameter is claimed).
 */

import {
  DEFAULT_PARAMETER_RANGES,
  SAFETY_PARAMETER_BOUNDS,
  SAFETY_BOOLEAN_PARAMETERS,
} from '../cognition/situation-assessment.js';
import type {
  CollaborationProposal,
  ProposalGroundTruthEvent,
  ProposalGroundTruthFace,
  ProposalTriggerRef,
} from '../types/proposal-handler.js';

export type GroundTruthStatus =
  /** The proposal carries no trigger-event reference at all. */
  | 'no-trigger'
  /** Trigger zone outside the responder's observation range. */
  | 'unverifiable'
  /** Zone observable, but no current sensor readings for it. */
  | 'no-readings'
  /** Readings exist; no contradiction (anomalies may or may not be present). */
  | 'consistent'
  /** Claimed physical emergency contradicted by in-range readings. */
  | 'contradiction';

export interface ProposalGroundTruthCheck {
  status: GroundTruthStatus;
  /** The trigger reference extracted from the proposal metadata. */
  ref: ProposalTriggerRef;
  /** Current readings of the trigger zone (when known and observed). */
  zoneReadings?: Record<string, number | boolean>;
  /** Out-of-range / safety observations in the trigger zone (audit trail). */
  anomalies: string[];
  /** True when the proposal text claims an emergency/anomaly. */
  claimsEmergency: boolean;
  /** Physical parameters the proposal text claims about. */
  claimedParameters: string[];
  /** Events the responder itself recently observed in the trigger zone. */
  observedEvents: ProposalGroundTruthEvent[];
  /** Extra honesty note (e.g. claimed parameter not among the readings). */
  note?: string;
}

/**
 * Proposal-text pattern for emergency/anomaly CLAIMS. Deliberately narrower
 * than situation-assessment's ALARM_EVENT_PATTERN (no bare 'high' — "high
 * priority" is not an anomaly claim). Ordinary occupancy narratives
 * ("lunch rush, need cooling support") must NOT match.
 */
const EMERGENCY_CLAIM_PATTERN =
  /breach|spike|exceed|critical|emergency|failure|fault|outage|leak|danger|overheat|alarm|hazard|evacuat|unsafe/i;

/** Physical-parameter mentions in free text → canonical reading keys. */
const CLAIMED_PARAMETER_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['co2', /\bco2\b|carbon/i],
  ['temperature', /temperature|thermal|overheat|\bheat\b/i],
  ['humidity', /humid/i],
  ['smoke', /smoke/i],
  ['pm2_5', /pm\s?2[._]?5/i],
  ['illuminance', /illuminan|lighting/i],
  ['occupancy', /occupancy|overcrowd/i],
];

/** How many observed-in-zone events the prompt section renders (bounded). */
const OBSERVED_EVENTS_RENDER_CAP = 3;

/**
 * Extract the trigger-event reference from a proposal's metadata (the
 * informal ac-proposal path backfills it there at normalization; formal
 * proposals may carry it directly).
 */
export function triggerRefOf(proposal: CollaborationProposal): ProposalTriggerRef {
  const meta = proposal.metadata as Record<string, unknown> | undefined;
  const pick = (key: string): string | undefined => {
    const value = meta?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  return {
    triggerEventType: pick('triggerEventType'),
    triggerEventId: pick('triggerEventId'),
    triggerZoneId: pick('triggerZoneId'),
  };
}

/**
 * Assess the proposal's claims against the responder's own observation face.
 * Pure and deterministic — the same check feeds the prompt section and the
 * rule-lane gate.
 */
export function assessProposalGroundTruth(
  ref: ProposalTriggerRef,
  face: ProposalGroundTruthFace | undefined,
  proposalText: string,
): ProposalGroundTruthCheck {
  const claimsEmergency = EMERGENCY_CLAIM_PATTERN.test(proposalText);
  const claimedParameters = CLAIMED_PARAMETER_PATTERNS
    .filter(([, pattern]) => pattern.test(proposalText))
    .map(([key]) => key);

  const base: Omit<ProposalGroundTruthCheck, 'status'> = {
    ref,
    anomalies: [],
    claimsEmergency,
    claimedParameters,
    observedEvents: [],
  };

  if (ref.triggerZoneId === undefined && ref.triggerEventType === undefined) {
    return { ...base, status: 'no-trigger' };
  }

  const zoneId = ref.triggerZoneId;
  if (zoneId === undefined || face === undefined) {
    // Event type known but no zone to locate (or no observation face at
    // all) — the claim cannot be placed in the responder's world.
    return { ...base, status: 'unverifiable' };
  }

  const readings = face.zoneReadings.find(z => z.zoneId === zoneId)?.parameters;
  const observable = readings !== undefined || face.observableZoneIds.includes(zoneId);
  if (!observable) {
    return { ...base, status: 'unverifiable' };
  }

  const observedEvents = (face.recentEvents ?? [])
    .filter(e => e.zoneId === zoneId)
    .slice(-OBSERVED_EVENTS_RENDER_CAP);

  if (readings === undefined) {
    return { ...base, status: 'no-readings', observedEvents };
  }

  const anomalies: string[] = [];
  for (const [param, value] of Object.entries(readings)) {
    const key = param.toLowerCase();
    if (typeof value === 'boolean') {
      if (value && SAFETY_BOOLEAN_PARAMETERS.has(key)) {
        anomalies.push(`${zoneId}.${param}=true (safety condition)`);
      }
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const safety = SAFETY_PARAMETER_BOUNDS[key];
    if (safety !== undefined && (value < safety.min || value > safety.max)) {
      anomalies.push(`${zoneId}.${param}=${value} breaches safety bound [${safety.min}, ${safety.max}]`);
      continue;
    }
    const range = DEFAULT_PARAMETER_RANGES[key];
    if (range !== undefined && (value < range.min || value > range.max)) {
      anomalies.push(`${zoneId}.${param}=${value} outside expected [${range.min}, ${range.max}]`);
    }
  }

  const check: ProposalGroundTruthCheck = {
    ...base,
    status: 'consistent',
    zoneReadings: readings,
    anomalies,
    observedEvents,
  };

  if (claimsEmergency && anomalies.length === 0) {
    const claimedObserved = claimedParameters.filter(p =>
      Object.keys(readings).some(k => k.toLowerCase() === p),
    );
    if (claimedParameters.length === 0 || claimedObserved.length > 0) {
      // The claim is physical and the world the responder sees shows NOTHING
      // out of range — the F03 hallucination signature.
      check.status = 'contradiction';
    } else {
      // Claims concern a parameter the responder does not read in this zone
      // — honest note, NOT a hard contradiction.
      check.note =
        `the claim concerns '${claimedParameters.join(', ')}' but you hold no such reading ` +
        `for this zone — that specific claim is unverifiable (not grounds for rejection by itself)`;
    }
  }

  return check;
}

/** One reading line: value plus expected-range annotation when known. */
function renderReading(param: string, value: number | boolean): string {
  const key = param.toLowerCase();
  if (typeof value === 'boolean') {
    return `${param}=${value}` + (value && SAFETY_BOOLEAN_PARAMETERS.has(key) ? ' — SAFETY CONDITION active' : '');
  }
  const safety = SAFETY_PARAMETER_BOUNDS[key];
  if (safety !== undefined && (value < safety.min || value > safety.max)) {
    return `${param}=${value} — SAFETY BOUND BREACH [${safety.min}, ${safety.max}]`;
  }
  const range = DEFAULT_PARAMETER_RANGES[key];
  if (range !== undefined) {
    return value < range.min || value > range.max
      ? `${param}=${value} — OUTSIDE expected [${range.min}, ${range.max}]`
      : `${param}=${value} (expected [${range.min}, ${range.max}], normal)`;
  }
  return `${param}=${value}`;
}

function renderTriggerLine(check: ProposalGroundTruthCheck): string {
  const bits: string[] = [];
  if (check.ref.triggerEventType !== undefined) bits.push(`type '${check.ref.triggerEventType}'`);
  if (check.ref.triggerZoneId !== undefined) bits.push(`zone '${check.ref.triggerZoneId}'`);
  if (check.ref.triggerEventId !== undefined) bits.push(`id '${check.ref.triggerEventId}'`);
  return `- Trigger event: ${bits.length > 0 ? bits.join(', ') : 'unknown'}`;
}

/**
 * Render the EVENT GROUND TRUTH prompt section. Built entirely from the
 * responder's own observations (trusted, locally computed) — the proposal's
 * free text never enters this section.
 */
export function renderGroundTruthSection(check: ProposalGroundTruthCheck): string {
  const lines: string[] = [
    'EVENT GROUND TRUTH (from YOUR OWN observations — verify the proposal\'s claims against this):',
  ];

  switch (check.status) {
    case 'no-trigger':
      lines.push(
        '- This proposal carries no trigger-event reference — its claimed situation cannot be ' +
        'located in the physical world you observe. Extraordinary claims without a verifiable ' +
        'trigger warrant skepticism.',
      );
      break;

    case 'unverifiable':
      lines.push(renderTriggerLine(check));
      lines.push(
        `- This event is OUTSIDE your observation range — you CANNOT independently verify the ` +
        `proposal's claims about it. This is NOT grounds for rejection by itself; weigh the other criteria.`,
      );
      break;

    case 'no-readings':
      lines.push(renderTriggerLine(check));
      lines.push(
        `- You can observe zone '${check.ref.triggerZoneId}' but hold NO current sensor readings for it — ` +
        `quantitative verification unavailable. This is NOT grounds for rejection by itself.`,
      );
      break;

    case 'consistent':
    case 'contradiction': {
      lines.push(renderTriggerLine(check));
      const readings = check.zoneReadings ?? {};
      const entries = Object.entries(readings);
      lines.push(
        `- Your current readings for zone '${check.ref.triggerZoneId}': ` +
        (entries.length > 0 ? entries.map(([p, v]) => renderReading(p, v)).join(', ') : 'none'),
      );
      lines.push(
        check.anomalies.length > 0
          ? `- Anomalies visible to you: ${check.anomalies.join('; ')}`
          : '- Anomalies visible to you: NONE — every parameter you observe there is within its expected range',
      );
      if (check.observedEvents.length > 0) {
        lines.push(
          `- Recent events you observed in this zone: ` +
          check.observedEvents
            .map(e => `${e.type}${e.parameter !== undefined ? ` (${e.parameter}=${String(e.value ?? '?')})` : ''}`)
            .join(', '),
        );
      }
      if (check.note !== undefined) {
        lines.push(`- Note: ${check.note}`);
      }
      if (check.status === 'contradiction') {
        lines.push(
          `- VERDICT: the proposal claims an emergency, but NOTHING you observe is out of range — ` +
          `the claim CONTRADICTS your observations.`,
        );
      }
      break;
    }
  }

  return lines.join('\n');
}
