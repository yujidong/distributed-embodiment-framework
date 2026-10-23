/**
 * L1 Perception — world-model builder (cognitive architecture §3.1, §8.1).
 *
 * PURE function that constructs the AgentWorldModel from the agent's bound
 * devices, the visible zone parameters + adjacency topology, the goal stack
 * and a bounded slice of recent events. No I/O, no clocks, no registries —
 * callers gather the inputs (runtime snapshot / manager state / owner
 * assignments) and this function deterministically assembles the structure.
 * Deterministic ordering: devices/zones/goals keep input order (goals are
 * additionally sorted by priority); events keep chronological order and are
 * sliced to the last N.
 */

import { isSensorStyleCapability } from '../decision/rule-actuation-planner.js';
import type { AgentProfile, GoalPriority } from '../goal/types.js';
import {
  WORLD_MODEL_PROMPT_EVENT_CAP,
  type AgentWorldModel,
  type WorldModelDevice,
  type WorldModelEvent,
  type WorldModelGoal,
  type WorldModelZone,
} from './world-model.js';

// ============================================================================
// Inputs
// ============================================================================

/** A bound device as seen by the builder (enrichment already applied). */
export interface WorldModelDeviceInput {
  deviceId: string;
  type: string;
  /** Zone the device sits in ('unknown' when not resolvable). */
  zoneId?: string;
  state?: Record<string, unknown>;
  /** Actuation command surface; derived from capabilities when omitted. */
  commands?: string[];
  /** Declared capabilities — used ONLY to derive `commands` when omitted. */
  capabilities?: string[];
}

/** A visible zone with live parameters and adjacency. */
export interface WorldModelZoneInput {
  zoneId: string;
  name?: string;
  parameters?: Record<string, number | boolean>;
  adjacentZoneIds?: string[];
}

/** A goal-stack entry (already normalized to the world-model shape). */
export interface WorldModelGoalInput {
  goal: string;
  priority: number;
  deadline?: number;
}

export interface WorldModelBuildInput {
  agentId: string;
  /** The T-202-enriched capability surface (declared ∪ device-derived). */
  capabilities: string[];
  scopeOfPractice?: string[];
  devices: readonly WorldModelDeviceInput[];
  zones: readonly WorldModelZoneInput[];
  goalStack?: readonly WorldModelGoalInput[];
  /** Chronological (oldest→newest) digested events; sliced to last N. */
  events?: readonly WorldModelEvent[];
  simTimeSec: number;
  /** Prompt-side event cap (default WORLD_MODEL_PROMPT_EVENT_CAP = 5). */
  maxRecentEvents?: number;
}

// ============================================================================
// Builder
// ============================================================================

/**
 * Derive a device's actuation command surface from its declared
 * capabilities — the SAME predicate/surface the assessor's MY_DEVICES
 * inventory and the cognitive deviceActions bridge validate against (one
 * shared surface, never a second dispatch list).
 */
export function deriveDeviceCommands(capabilities: readonly string[]): string[] {
  return [...new Set(
    capabilities
      .map(cap => (typeof cap === 'string' ? cap.toLowerCase() : ''))
      .filter(cap => cap.length > 0 && !isSensorStyleCapability(cap)),
  )];
}

/** Build the AgentWorldModel (pure, deterministic, JSON-serializable). */
export function buildAgentWorldModel(input: WorldModelBuildInput): AgentWorldModel {
  const devices: WorldModelDevice[] = input.devices.map(device => ({
    deviceId: device.deviceId,
    type: device.type,
    zoneId: device.zoneId !== undefined && device.zoneId.length > 0 ? device.zoneId : 'unknown',
    state: device.state ?? {},
    commands: device.commands ?? deriveDeviceCommands(device.capabilities ?? []),
  }));

  const zones: WorldModelZone[] = input.zones.map(zone => ({
    zoneId: zone.zoneId,
    name: zone.name !== undefined && zone.name.length > 0 ? zone.name : zone.zoneId,
    parameters: { ...(zone.parameters ?? {}) },
    adjacentZoneIds: [...(zone.adjacentZoneIds ?? [])],
  }));

  const goalStack: WorldModelGoal[] = [...(input.goalStack ?? [])]
    .map(goal => ({
      goal: goal.goal,
      priority: Math.max(1, Math.round(goal.priority)),
      ...(goal.deadline !== undefined ? { deadline: goal.deadline } : {}),
    }))
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 5); // §11 goal_stack maxItems 5 — the stack is bounded at birth

  const cap = input.maxRecentEvents ?? WORLD_MODEL_PROMPT_EVENT_CAP;
  const recentEvents: WorldModelEvent[] = [...(input.events ?? [])].slice(-Math.max(0, cap));

  return {
    agentId: input.agentId,
    capabilities: [...input.capabilities],
    ...(input.scopeOfPractice !== undefined && input.scopeOfPractice.length > 0
      ? { scopeOfPractice: [...input.scopeOfPractice] }
      : {}),
    devices,
    zones,
    goalStack,
    recentEvents,
    simTimeSec: Math.max(0, input.simTimeSec),
  };
}

// ============================================================================
// Owner-assignment projection (goal stack sources)
// ============================================================================

/** GoalPriority → world-model priority (1 = highest; unmapped → 3). */
const GOAL_PRIORITY_RANK: Record<GoalPriority, number> = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
};

/**
 * Project an AgentProfile's owner-assigned primaryGoals (§4.2 "持久目标：
 * owner 指派") onto the world-model goal stack. Emergent (situation-driven)
 * goals are L2's to add later — this projection only carries the persistent
 * face. `deadline` is epoch-seconds when the profile carries a wall Date
 * (documented; sim-anchored callers pass sim-time seconds directly).
 */
export function goalsFromAgentProfile(profile: AgentProfile | undefined): WorldModelGoalInput[] {
  if (!profile?.primaryGoals) return [];
  return profile.primaryGoals
    .filter(goal => goal.status !== 'achieved' && goal.status !== 'failed')
    .map(goal => ({
      goal: goal.description || goal.type,
      priority: GOAL_PRIORITY_RANK[goal.priority] ?? 3,
      ...(goal.metrics?.deadline !== undefined
        ? { deadline: Math.round(goal.metrics.deadline.getTime() / 1000) }
        : {}),
    }));
}
