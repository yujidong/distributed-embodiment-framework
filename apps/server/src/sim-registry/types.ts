/**
 * Simulation registry — shared types (R21-W4 extraction from
 * simulation-registry.ts; pure move, zero semantic change).
 *
 * simulation-registry.ts re-exports everything below, so consumers keep
 * importing from the registry exactly as before. The types are plain data
 * contracts between the registry coordinator and the extracted lifecycle
 * modules (runtime-builder / seams / records).
 */

import type {
  DeviceFactory,
  EngineRuntime,
  EngineRuntimeState,
  LlmFunctionClients,
  ScenarioDefinition,
} from '@active-collaboration/core';
import type { LLMClient } from '@active-collaboration/llm-integration';

import type { CheckpointMetadata } from '../world-checkpoint.js';

/**
 * LLM preset names accepted by the create-simulation endpoint. 'llm' is the
 * explicit LLM-backed request (R44-B renamed the old backend-named preset
 * when the local backend was removed); 'auto' degrades quietly when the
 * world declares no llm blocks, 'llm' always warns on an unconfigured
 * server, 'none' forces rule-only.
 */
export type LLMPreset = 'auto' | 'llm' | 'none';

export const LLM_PRESETS: readonly LLMPreset[] = ['auto', 'llm', 'none'];

/** Scheduling modes accepted by the create-simulation endpoint (living-worlds P1). */
export type SimulationScheduling = 'tick' | 'lazy';

export const SIMULATION_SCHEDULINGS: readonly SimulationScheduling[] = ['tick', 'lazy'];

export interface CreateSimulationOptions {
  /** LLM preset NAME (not a client instance). Default 'auto'. */
  llmClient?: LLMPreset;
  /**
   * Wave A2: AC mode for A/B comparison. 'enabled' (default) = normal AC.
   * 'disabled' = no AC (agents handle independently). 'shadow' = compute
   * AC decisions but execute independently (for analysis).
   */
  acMode?: 'enabled' | 'disabled' | 'shadow';
  /**
   * T-050/T-051 exposure: actuate agents' OWN bound devices on
   * 'handle_independently' decisions (default true). Set false for
   * decision-only runs (eval harnesses). Precedence per agent: this sim
   * option (operator) > the agent's scenario decisionPolicy (author) >
   * default true — resolved inside EngineRuntime at construction.
   */
  autoActuateIndependent?: boolean;
  /**
   * Per-simulation model override (Wave-3a batch evaluation): wins over
   * LLM_MODEL and the scenario's own llm.model when the shared client is
   * built. Meaningless for rule-only runs (ignored).
   */
  llmModel?: string;
  /**
   * Per-simulation AC-assessor system-prompt override (Wave-3a prompt A/B):
   * threaded to EngineRuntimeOptions.assessorSystemPrompt for every agent.
   */
  llmSystemPrompt?: string;
  trajectoryDir?: string;
  tickMs?: number;
  /**
   * HIL P2 (shadow worlds): explicit engine deviceFactory — wins over the
   * hass:// factory below. NOT serializable: it is dropped from hibernation
   * checkpoints (resume rebuilds without it), so callers must not make the
   * world's SAFETY semantics depend on it (the shadow fork rewrites its
   * hass:// bindings to sim:// precisely so the factory is an observability
   * wrapper, not the safety mechanism).
   */
  deviceFactory?: DeviceFactory;
  /**
   * Living-worlds P1 (design-living-worlds.md §8): advancement scheduling.
   * 'tick' (default) — the historical fixed-interval wall timer (every
   * tickMs one tick of `speed` sim-seconds); behavior unchanged. 'lazy' —
   * no engine timer: the runtime runs in due-driven mode and the registry's
   * lazy driver wakes it at (wall-mapped) due moments only (scheduled
   * events, occupancy boundaries, flow schedules/condition cadence, Fix-12
   * checks, and the terms.read freshness floor when an active data-read
   * agreement carries one). Bit-identical world evolution to a tick run
   * (advanceTo), at a fraction of the tick bodies for sparse schedules.
   */
  scheduling?: SimulationScheduling;
  /**
   * Small-model triage for AC decisions (P4-2). Requires an LLM-backed
   * simulation; ignored for rule-only runs. `model` selects the triage
   * model on the same backend (default server LLM_TRIAGE_MODEL, else
   * 'ac-decision-15b-v2'); `mode` defaults to 'shadow' (record agreement,
   * no behavior change) — 'enforce' lets trusted triage 'independent'
   * answers skip the big-model call.
   */
  triage?: {
    enabled: boolean;
    model?: string;
    mode?: 'shadow' | 'enforce';
    trustIndependent?: boolean;
  };
}

export interface SimulationRecord {
  id: string;
  scenarioId: string;
  /** Set when the runtime was built from an environment (P2a bridge). */
  environmentId?: string;
  /**
   * S2 (device privacy): set when this is a CREATOR-PRIVATE FORK of an
   * environment (sandbox-service) — creation copies full device state for
   * simulation fidelity (the ratified fork trade-off), but READ surfaces
   * project foreign devices through the canonical privacy seam, exactly
   * like env-backed sims. Unlike environmentId it drives NO env-backing
   * behavior (no reputation write-back, no flows/agreement seams).
   */
  sourceEnvId?: string;
  /**
   * P2F (living-worlds §10): the owning SANDBOX row id when this sim is a
   * fork — the explicit lineage key (§10.4). Timeline records stamp it;
   * the simulation read/control gates resolve fork membership through it.
   */
  forkId?: string;
  /**
   * Living-worlds P1W: true for the ENV-owned authoritative world session
   * (design-living-worlds.md §4.3) — one per environment, created on demand
   * by the WorldSessionService, never by the public create route. Sessions
   * are targetable by everyone (no creator), excluded from the per-user sim
   * lanes (list / running-for-env targeting), and carry wall-anchored lazy
   * scheduling.
   */
  envSession?: boolean;
  /**
   * Creator's user id when the create call was authenticated (W5); legacy
   * anonymous creations stay undefined.
   */
  createdBy?: string;
  /**
   * Living-worlds P0: the scenario this runtime was built from (kept verbatim
   * — sims are frozen snapshots, not live views) and the caller's create
   * options, so hibernate can write a SELF-CONTAINED checkpoint and resume
   * can rebuild the identical wiring. Plain data, no live references.
   */
  scenario: ScenarioDefinition;
  createOptions: CreateSimulationOptions;
  /** T-201: env owner id threaded to the flowsProvider (authorship stamping). */
  environmentOwnerId?: string;
  /** How the runtime's agents are wired: shared LLM client or rule-only. */
  llm: 'llm' | 'rule-only';
  /**
   * The model the shared LLM client actually uses (LLM mode only) —
   * surfaced in the sim info responses so the console can show it.
   */
  llmModel?: string;
  /**
   * Explicit degradation notice: set when agents requested an LLM but none
   * is configured, so the sim runs rule-only. Never silent (P1-1).
   */
  llmWarning?: string;
  /**
   * The LLM preset the create call resolved with (living-worlds P0: rides
   * the checkpoint so resume re-resolves the same intent).
   */
  llmPreset: LLMPreset;
  /**
   * Per-simulation trajectory directory (T-005): the registry default
   * `<trajectoryBaseDir>/<simId>/` or an explicit `options.trajectoryDir`.
   * Undefined when recording is off (no base dir, no override) — the
   * sim-timeline endpoint then reports no records. `sim-timeline.jsonl`
   * (zone samples + device state changes) lives here next to the
   * trajectory JSONL.
   */
  trajectoryDir?: string;
  createdAt: string;
  runtime: EngineRuntime;
  /** Living-worlds P1: advancement mode this sim was created with. */
  scheduling: SimulationScheduling;
}

/**
 * Living-worlds P0 (design-living-worlds.md §9): the lightweight record a
 * HIBERNATED simulation leaves in the registry — zero runtime, zero timers,
 * zero subscriptions; identity (same id), the checkpoint metadata, and the
 * plain data resume needs. The checkpoint file itself lives on disk under
 * the sim's trajectory dir.
 */
export interface HibernatedSimulationRecord {
  id: string;
  scenarioId: string;
  environmentId?: string;
  /** S2 (device privacy): fork marker survives the hibernate boundary. */
  sourceEnvId?: string;
  /** P2F §10: fork id survives the hibernate boundary (lineage key). */
  forkId?: string;
  createdBy?: string;
  scenario: ScenarioDefinition;
  createOptions: CreateSimulationOptions;
  environmentOwnerId?: string;
  llm: 'llm' | 'rule-only';
  llmModel?: string;
  llmWarning?: string;
  llmPreset: LLMPreset;
  trajectoryDir: string;
  createdAt: string;
  hibernatedAt: string;
  checkpoint: CheckpointMetadata;
}

export interface SimulationSummary {
  id: string;
  scenarioId: string;
  environmentId?: string;
  createdBy?: string;
  /** Live runtime states, or 'hibernated' (P0: runtime released, checkpoint on disk). */
  state: EngineRuntimeState | 'hibernated';
  simTimeSec: number;
  llm: 'llm' | 'rule-only';
  /** Present in LLM mode: the model the shared client uses. */
  llmModel?: string;
  /** Present when the requested LLM was unavailable (see SimulationRecord). */
  llmWarning?: string;
  /** Living-worlds P1: advancement mode ('tick' default | 'lazy' due-driven). */
  scheduling?: SimulationScheduling;
  /** Present when hibernated: freeze stamp. */
  hibernatedAt?: string;
  /** Present when hibernated: checkpoint metadata (path/bytes/sim-time). */
  checkpoint?: CheckpointMetadata;
  /**
   * C5 (T-087, HO26-F06 — DevLoop R28): present (true) ONLY on the env's
   * authoritative world session as surfaced by listIncludingEnvSessions —
   * the platform-created `sim-<envId>-world-session`. Consumers distinguish
   * it from user sims; per-user sims stay isolated event planes by design.
   */
  platformOwned?: true;
  /**
   * T82 (R9, u3-F1): present ('world-session') ONLY on the authoritative
   * world session row — the explicit TYPE marker the roster face renders as
   * ` [world-session]`. platformOwned answers "who owns it"; kind answers
   * "WHAT it is" (the env's authoritative living world — the row an
   * AGENT_AMBIGUOUS candidate names), so a member reading `sim list` can
   * connect the disambiguation error's session to its roster row.
   */
  kind?: 'world-session';
}

/**
 * The LLM resolution a runtime build produced (R21-W4): the shared client
 * (when LLM-backed) plus the facts the record/summary surfaces need.
 */
export interface LlmResolution {
  client?: LLMClient;
  /**
   * Per-function routed clients (LLM_DECISION_MODEL / LLM_EVAL_MODEL /
   * LLM_NL_MODEL); absent when no routes are configured.
   */
  functionClients?: LlmFunctionClients;
  mode: 'llm' | 'rule-only';
  model?: string;
  warning?: string;
}

/**
 * R14 Wave-A (design-data-services.md): the per-sim injected-event tally —
 * the countSince window for ComputationSpec evaluation. Attached to every
 * environment-backed sim at creation (injections never ride the bus;
 * onInjectedEvent is the only history surface). Living-worlds P0: the ring
 * rides the checkpoint (eventsOf at hibernate, reseed at resume) so
 * countSince windows span the freeze.
 */
export interface EventTallySeam {
  attach(simId: string, runtime: EngineRuntime): void;
  eventsOf?(simId: string): Array<{ eventType: string; zoneId: string; simTimeSec: number }>;
  reseed?(
    simId: string,
    runtime: EngineRuntime,
    events: Array<{ eventType: string; zoneId: string; simTimeSec: number }>,
  ): void;
}

/** An attachable server seam keyed by (environmentId, runtime). */
export interface RuntimeAttacher {
  /**
   * `simulationId` (FEAT-08): the owning SimulationRecord's id — env-backed
   * runtimes carry the ENV id as runtime.id, so seams that attribute
   * per-simulation state (usage metering) need the record id explicitly.
   * Optional: attachers that don't attribute per-sim simply ignore it.
   */
  attach(environmentId: string, runtime: EngineRuntime, simulationId?: string): void;
  /**
   * Optional defensive full-reconciliation entry point (service-catalog-sync):
   * the registry invokes it on a low-frequency timer so slow drift (FK
   * cascades, fault windows) converges even between catalog writes.
   */
  reconcileAll?(): void;
}
