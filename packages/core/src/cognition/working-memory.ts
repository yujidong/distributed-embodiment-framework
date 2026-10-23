/**
 * L1 Perception — Working Memory (cognitive architecture §3.4).
 *
 * "What is happening RIGHT NOW": a bounded, per-cognitive-round structure
 * that is the ONLY projection L2 consumes. Lifecycle = one cognitive round:
 * constructed when the round's world model is built (WorkingMemoryStore.
 * beginRound), consumed by the assessor prompt, superseded by the next
 * round. Cross-round state (the previous decision + its outcome) is carried
 * explicitly — never by mutating a stale round's object (ReAct's
 * "observation enters the next prompt" via an explicit field, not reuse).
 *
 * Bounded by construction: one current entry per store, a previous world
 * model kept ONLY for diffing, situationChanges capped.
 */

import type { AgentWorldModel, EnvironmentParamFaceCheckpoint, WorldModelEvent } from './world-model.js';
import type { MetaCognitionCheckpoint } from './meta.js';

/** The last cognitive decision and what came of it (Reflexion's minimal loop). */
export interface PreviousCognitiveDecision {
  /** The decided action (decision vocabulary: initiate_ac / handle_independently / defer / ignore). */
  action: string;
  /** Honest outcome tag: 'ac-initiated' | 'acted' | 'no-action' | 'deferred' | 'ignored' | … */
  outcome: string;
  atSimTimeSec?: number;
}

/** One cognitive round's working memory (§3.4, budget fields arrive with L3). */
export interface WorkingMemory {
  /** The world as of this round (rebuilt per tick — the single source). */
  worldModel: AgentWorldModel;
  /** Last cognitive decision + outcome (previous round's, if any). */
  previousDecision?: PreviousCognitiveDecision;
  /** What changed since the previous round (zone/parameter deltas, capped). */
  situationChanges: string[];
  simTimeSec: number;
}

/** Max rendered "what changed" lines (bounded working memory). */
export const WORKING_MEMORY_CHANGES_CAP = 8;

/**
 * The checkpointable diff baseline: the previous round's zone face (all
 * `diffWorldModels` reads of the previous model) — one entry per visible
 * zone. Pure JSON data — rides the cognition checkpoint envelope across
 * hibernate/resume.
 */
export interface PreviousZoneFace {
  zoneId: string;
  parameters: Record<string, number | boolean>;
}

/**
 * The manager's cognition checkpoint face (world-state export/restore):
 * event ring + last decision (R38-P2), meta-cognition (R38-P5), parameter
 * face (R40-C3) and the working-memory diff baseline (R40-C2). One shared
 * truth for the checkpoint producer and the restore consumer — pure JSON.
 */
export interface CognitionCheckpoint {
  events: WorldModelEvent[];
  lastDecision: { action: string; outcome: string; atSimTimeSec?: number } | null;
  metaCognition?: MetaCognitionCheckpoint | null;
  environmentParams?: Record<string, EnvironmentParamFaceCheckpoint>;
  previousZoneFace?: PreviousZoneFace[];
}

/**
 * Per-agent working-memory store: opens one round at a time, keeps the
 * previous world model ONLY to diff, and records decision outcomes for the
 * next round's PREVIOUS_DECISION context. One object per cognitive round —
 * no unbounded history lives here.
 */
export class WorkingMemoryStore {
  private currentEntry?: WorkingMemory;
  private previousWorldModel?: AgentWorldModel;
  private lastDecision?: PreviousCognitiveDecision;

  /**
   * Open the round for this world model: diffs against the previous round's
   * world model and attaches the last recorded decision. Returns the
   * round's working memory (also exposed via current()).
   */
  beginRound(worldModel: AgentWorldModel): WorkingMemory {
    const changes = diffWorldModels(this.previousWorldModel, worldModel);
    const entry: WorkingMemory = {
      worldModel,
      ...(this.lastDecision !== undefined ? { previousDecision: this.lastDecision } : {}),
      situationChanges: changes,
      simTimeSec: worldModel.simTimeSec,
    };
    this.currentEntry = entry;
    this.previousWorldModel = worldModel;
    return entry;
  }

  /** Record the outcome of the cognitive decision this round produced. */
  recordDecision(decision: PreviousCognitiveDecision): void {
    this.lastDecision = { ...decision };
  }

  /**
   * The last recorded decision (copy) — the checkpoint/export seam.
   * (Named peek* to avoid colliding with the private `lastDecision` field.)
   */
  peekLastDecision(): PreviousCognitiveDecision | undefined {
    return this.lastDecision !== undefined ? { ...this.lastDecision } : undefined;
  }

  /**
   * Adopt a checkpointed decision (R38-P2 world-state restore) — the
   * resumed run's first prompt carries the pre-checkpoint PREVIOUS_DECISION
   * (record-replay parity). Null/undefined clears it.
   */
  restoreDecision(decision: PreviousCognitiveDecision | null | undefined): void {
    this.lastDecision = decision ?? undefined;
  }

  /**
   * The diff-relevant slice of the previous round's world model — the zone
   * face `diffWorldModels` reads (zoneId → parameters; nothing else of the
   * model enters a diff). The checkpoint/export seam for R40-C2: without it
   * a resumed run's first round diffs against nothing and renders
   * "initial perception", diverging from the recorded run's prompt
   * (record-replay parity — same discipline as peekLastDecision).
   */
  peekPreviousZoneFace(): PreviousZoneFace[] | undefined {
    if (this.previousWorldModel === undefined) return undefined;
    return this.previousWorldModel.zones.map(zone => ({
      zoneId: zone.zoneId,
      parameters: { ...zone.parameters },
    }));
  }

  /**
   * Adopt a checkpointed zone face (R40-C2 world-state restore) — the
   * resumed run's first diff runs against the pre-boundary round's zones,
   * so CHANGES_SINCE_LAST_ROUND matches the continuous run byte for byte.
   * Null/undefined clears it (pre-C2 checkpoints: the first resumed round
   * honestly falls back to "initial perception").
   */
  restorePreviousZoneFace(face: PreviousZoneFace[] | null | undefined): void {
    if (face === null || face === undefined) {
      this.previousWorldModel = undefined;
      return;
    }
    // Reconstructed as a minimal model carrying exactly the diff-relevant
    // face (diffWorldModels reads zones only).
    this.previousWorldModel = {
      agentId: '',
      capabilities: [],
      devices: [],
      zones: face.map(zone => ({
        zoneId: zone.zoneId,
        name: zone.zoneId,
        parameters: { ...zone.parameters },
        adjacentZoneIds: [],
      })),
      goalStack: [],
      recentEvents: [],
      simTimeSec: 0,
    };
  }

  /** The open round's working memory (undefined before the first round). */
  current(): WorkingMemory | undefined {
    return this.currentEntry;
  }

  /** Drop all round state (agent stop/reset parity). */
  clear(): void {
    this.currentEntry = undefined;
    this.previousWorldModel = undefined;
    this.lastDecision = undefined;
  }
}

/**
 * Deterministic diff between two consecutive world models → bounded,
 * human-readable change lines (zone parameter additions/changes, device
 * count changes). Pure; capped at WORKING_MEMORY_CHANGES_CAP with an honest
 * truncation marker (silent truncation is the standing usability trap).
 */
export function diffWorldModels(
  previous: AgentWorldModel | undefined,
  next: AgentWorldModel,
): string[] {
  if (previous === undefined) {
    return next.zones.length > 0 || next.recentEvents.length > 0
      ? [`initial perception: ${next.zones.length} zone(s), ${next.recentEvents.length} recent event(s)`]
      : [];
  }

  const changes: string[] = [];
  const prevZones = new Map(previous.zones.map(z => [z.zoneId, z]));
  for (const zone of next.zones) {
    const prev = prevZones.get(zone.zoneId);
    if (prev === undefined) {
      changes.push(`zone ${zone.zoneId}: now visible`);
      continue;
    }
    for (const [param, value] of Object.entries(zone.parameters)) {
      const oldValue = prev.parameters[param];
      if (oldValue === undefined) {
        changes.push(`zone ${zone.zoneId}.${param}=${String(value)} (new)`);
      } else if (oldValue !== value) {
        changes.push(`zone ${zone.zoneId}.${param}: ${String(oldValue)} → ${String(value)}`);
      }
    }
    for (const param of Object.keys(prev.parameters)) {
      if (!(param in zone.parameters)) {
        changes.push(`zone ${zone.zoneId}.${param}: no longer reported`);
      }
    }
  }

  if (changes.length > WORKING_MEMORY_CHANGES_CAP) {
    const kept = changes.slice(0, WORKING_MEMORY_CHANGES_CAP);
    kept.push(`… ${changes.length - WORKING_MEMORY_CHANGES_CAP} more change(s) truncated`);
    return kept;
  }
  return changes;
}
