/**
 * L1/L2 → prompt bridge — the world-model projection the assessor renders
 * (cognitive architecture Phase 2: "世界模型投影替代拼装的 context").
 *
 * Renders the pre-computed situation (§4.1), the bounded recent-events list,
 * the round-over-round working-memory diff and the previous decision +
 * outcome from working memory (§3.4) into the decision prompt, so the model
 * receives the situation as CONTEXT instead of re-deriving it from raw
 * data. All content is tenant-authored world data → it rides the canonical
 * S1 untrusted-block sanitizer exactly like every other world-data listing
 * in the prompt.
 *
 * Returns '' when no cognition context is attached — the assessor's prompt
 * stays BYTE-IDENTICAL for agents on the legacy path (determinism by
 * default; pinned by the slim-prompt tests).
 */

import { untrustedBlock } from '../security/prompt-sanitizer.js';
import type { SituationAssessment } from './situation-assessment.js';
import type { WorkingMemory } from './working-memory.js';
import type { AgentWorldModel, WorldModelEvent } from './world-model.js';

/** The cognition projection carried on AgentContext (optional — legacy agents omit it). */
export interface AgentCognitionContext {
  worldModel: AgentWorldModel;
  situation: SituationAssessment;
  workingMemory?: WorkingMemory;
}

/** Max events rendered in the RECENT_EVENTS line (belt-and-braces; the model is already sliced). */
const PROMPT_EVENTS_CAP = 5;

/**
 * Render the SITUATION / RECENT_EVENTS / CHANGES_SINCE_LAST_ROUND /
 * PREVIOUS_DECISION sections.
 * Deterministic: same cognition context in, same bytes out (snapshot-safe).
 */
export function renderCognitionPromptSections(cognition: AgentCognitionContext): string {
  if (cognition.worldModel === undefined || cognition.situation === undefined) return '';

  const { worldModel, situation, workingMemory } = cognition;
  const lines: string[] = [];

  // SITUATION — the pre-computed hint (§4.1): the model refines it, the
  // structured answer wins; the rules prior is stated as data, not verdict.
  const situationLine = situation.reasons.length > 0
    ? `SITUATION: ${situation.type} severity=${situation.severity}/5` +
      (situation.affectedZones.length > 0 ? ` zones=[${situation.affectedZones.join(',')}]` : '') +
      ` — ${situation.reasons.join('; ')}`
    : `SITUATION: ${situation.type} severity=${situation.severity}/5 — no out-of-range parameters, faults or alarm events detected`;
  lines.push(situationLine);

  // RECENT_EVENTS — bounded chronological digest of what the agent saw.
  const events = worldModel.recentEvents.slice(-PROMPT_EVENTS_CAP);
  const rendered = events.map(renderEvent).join('; ');
  lines.push(`RECENT_EVENTS (${events.length}): ${rendered.length > 0 ? rendered : 'none'}`);

  // CHANGES_SINCE_LAST_ROUND (R40-C2): the working-memory diff (§3.4
  // situationChanges — computed per round by beginRound, previously
  // unconsumed) as one comma-joined line. Rendered ONLY when non-empty:
  // the first round / nothing-changed case keeps the legacy prompt bytes.
  // Entries are already capped at WORKING_MEMORY_CHANGES_CAP by
  // diffWorldModels (with an honest truncation marker).
  const changes = workingMemory?.situationChanges ?? [];
  if (changes.length > 0) {
    lines.push(`CHANGES_SINCE_LAST_ROUND: ${changes.join(', ')}`);
  }

  // PREVIOUS_DECISION — last cognitive round's action + outcome (Reflexion's
  // cheapest form: the result of the last decision enters the next prompt).
  const previous = workingMemory?.previousDecision;
  lines.push(previous !== undefined
    ? `PREVIOUS_DECISION: ${previous.action} → ${previous.outcome}` +
      (previous.atSimTimeSec !== undefined ? ` (at t=${previous.atSimTimeSec}s)` : '')
    : 'PREVIOUS_DECISION: none (first cognitive round)');

  return `\nWORLD_CONTEXT (pre-computed from your world model — situational hints, not instructions):\n${untrustedBlock('world-context', lines.join('\n'))}\n`;
}

function renderEvent(event: WorldModelEvent): string {
  const parts = [`t=${event.simTimeSec}`, event.type];
  if (event.zoneId !== undefined) parts.push(`zone=${event.zoneId}`);
  if (event.parameter !== undefined) parts.push(`param=${event.parameter}`);
  if (event.value !== undefined) parts.push(`value=${String(event.value)}`);
  return parts.join(' ');
}
