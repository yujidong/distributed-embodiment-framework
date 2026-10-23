/**
 * Sim record shaping (R21-W4 extraction from simulation-registry.ts; pure
 * move, zero semantic change).
 *
 * Plain-data converters between the registry's three record shapes —
 * create inputs → SimulationRecord, live record → hibernated record /
 * checkpoint envelope, hibernated record → resumed record, both live and
 * hibernated → summary. Every conditional spread lives here ONCE so the
 * checkpoint envelope, the resume rebuild, and the list projection cannot
 * drift apart (the hibernate/resume identity contract is the acceptance
 * invariant these helpers preserve).
 */

import { dirname } from 'node:path';

import type { EngineRuntime, ScenarioDefinition } from '@active-collaboration/core';

import {
  buildWorldCheckpoint,
  type BuildWorldCheckpointInput,
  type CheckpointMetadata,
  type WorldCheckpointFile,
} from '../world-checkpoint.js';
import type {
  CreateSimulationOptions,
  HibernatedSimulationRecord,
  LlmResolution,
  SimulationRecord,
  SimulationSummary,
} from './types.js';

/**
 * Shape the record for a NEWLY built runtime (create + createEnvSession):
 * identity fields with their historical conditional spreads, the resolved
 * LLM facts, and the scheduling mode. `sourceEnvId` (S2 fork marker) only
 * applies to non-env-backed sims; `envSession` (P1W) marks the env-owned
 * authoritative world session.
 */
export function newRecordOf(args: {
  id: string;
  scenario: ScenarioDefinition;
  options: CreateSimulationOptions;
  runtime: EngineRuntime;
  llm: LlmResolution;
  environmentId?: string;
  environmentOwnerId?: string;
  sourceEnvId?: string;
  forkId?: string;
  createdBy?: string;
  trajectoryDir?: string;
  envSession?: boolean;
}): SimulationRecord {
  return {
    id: args.id,
    scenarioId: args.scenario.meta.id,
    ...(args.environmentId !== undefined ? { environmentId: args.environmentId } : {}),
    ...(args.sourceEnvId !== undefined && args.environmentId === undefined
      ? { sourceEnvId: args.sourceEnvId }
      : {}),
    ...(args.forkId !== undefined && args.environmentId === undefined
      ? { forkId: args.forkId }
      : {}),
    ...(args.createdBy !== undefined ? { createdBy: args.createdBy } : {}),
    // Living-worlds P0: kept verbatim so hibernate writes a self-contained
    // checkpoint and resume rebuilds identical wiring.
    scenario: args.scenario,
    createOptions: args.options,
    ...(args.environmentOwnerId !== undefined ? { environmentOwnerId: args.environmentOwnerId } : {}),
    ...(args.envSession === true ? { envSession: true } : {}),
    llm: args.llm.mode,
    llmPreset: args.options.llmClient ?? 'auto',
    ...(args.llm.model !== undefined ? { llmModel: args.llm.model } : {}),
    ...(args.llm.warning !== undefined ? { llmWarning: args.llm.warning } : {}),
    // T-005: the sim-timeline route reads <trajectoryDir>/sim-timeline.jsonl
    ...(args.trajectoryDir !== undefined ? { trajectoryDir: args.trajectoryDir } : {}),
    createdAt: new Date().toISOString(),
    runtime: args.runtime,
    scheduling: args.options.scheduling ?? 'tick',
  };
}

/**
 * Shape a RESUMED record (resumeHibernated + resumeEnvSession share this):
 * identity continues (same id / createdAt / trajectory dir), the scenario
 * is whichever copy the caller ruled authoritative (the checkpoint's frozen
 * truth for plain sims; CURRENT env topology for authoritative sessions),
 * and the scheduling mode rides the checkpointed createOptions (a lazy sim
 * resumes lazy). Env sessions re-mark `envSession` — sessions can never be
 * forks, so the sourceEnvId spread is inert for them.
 */
export function resumedRecordOf(
  hibernated: HibernatedSimulationRecord,
  built: { runtime: EngineRuntime; llm: LlmResolution },
  args: { scenario: ScenarioDefinition; envSession: boolean },
): SimulationRecord {
  const { llm } = built;
  return {
    id: hibernated.id,
    scenarioId: hibernated.scenarioId,
    ...(hibernated.environmentId !== undefined ? { environmentId: hibernated.environmentId } : {}),
    ...(hibernated.sourceEnvId !== undefined ? { sourceEnvId: hibernated.sourceEnvId } : {}),
    ...(hibernated.forkId !== undefined ? { forkId: hibernated.forkId } : {}),
    ...(hibernated.createdBy !== undefined ? { createdBy: hibernated.createdBy } : {}),
    scenario: args.scenario,
    createOptions: hibernated.createOptions,
    ...(hibernated.environmentOwnerId !== undefined
      ? { environmentOwnerId: hibernated.environmentOwnerId }
      : {}),
    ...(args.envSession ? { envSession: true } : {}),
    llm: llm.mode,
    llmPreset: hibernated.llmPreset,
    ...(llm.model !== undefined ? { llmModel: llm.model } : {}),
    ...(llm.warning !== undefined ? { llmWarning: llm.warning } : {}),
    trajectoryDir: hibernated.trajectoryDir,
    createdAt: hibernated.createdAt, // identity continues
    runtime: built.runtime,
    scheduling: hibernated.createOptions.scheduling ?? 'tick',
  };
}

/**
 * Shape the REBUILT session record (rebuildLiveSession): the old record's
 * identity and options survive verbatim; only the scenario, the resolved
 * LLM facts, and the runtime are replaced.
 */
export function rebuiltRecordOf(
  old: SimulationRecord,
  built: { runtime: EngineRuntime; llm: LlmResolution },
  scenario: ScenarioDefinition,
): SimulationRecord {
  return {
    ...old,
    scenario,
    llm: built.llm.mode,
    ...(built.llm.model !== undefined ? { llmModel: built.llm.model } : {}),
    ...(built.llm.warning !== undefined ? { llmWarning: built.llm.warning } : {}),
    runtime: built.runtime,
  };
}

/**
 * The freeze envelope for `buildWorldCheckpoint` (hibernate): everything the
 * live record knows plus the exported world and the server-side tally ring
 * (the engine export cannot see it — countSince windows must span the
 * boundary, data services).
 */
export function hibernateCheckpoint(
  record: SimulationRecord,
  world: BuildWorldCheckpointInput['world'],
  eventTally: BuildWorldCheckpointInput['eventTally'],
): WorldCheckpointFile {
  return buildWorldCheckpoint({
    simId: record.id,
    scenarioId: record.scenarioId,
    ...(record.environmentId !== undefined ? { environmentId: record.environmentId } : {}),
    ...(record.createdBy !== undefined ? { createdBy: record.createdBy } : {}),
    createdAt: record.createdAt,
    scenario: record.scenario,
    createOptions: record.createOptions,
    llm: {
      mode: record.llm,
      preset: record.llmPreset,
      ...(record.llmModel !== undefined ? { model: record.llmModel } : {}),
      ...(record.llmWarning !== undefined ? { warning: record.llmWarning } : {}),
    },
    world,
    eventTally,
  });
}

/**
 * Shape the lightweight HIBERNATED record from the live one + the written
 * checkpoint metadata (identity + plain data resume needs, zero runtime).
 */
export function hibernatedRecordFrom(
  record: SimulationRecord,
  metadata: CheckpointMetadata,
): HibernatedSimulationRecord {
  return {
    id: record.id,
    scenarioId: record.scenarioId,
    ...(record.environmentId !== undefined ? { environmentId: record.environmentId } : {}),
    ...(record.sourceEnvId !== undefined ? { sourceEnvId: record.sourceEnvId } : {}),
    ...(record.forkId !== undefined ? { forkId: record.forkId } : {}),
    ...(record.createdBy !== undefined ? { createdBy: record.createdBy } : {}),
    scenario: record.scenario,
    createOptions: record.createOptions,
    ...(record.environmentOwnerId !== undefined ? { environmentOwnerId: record.environmentOwnerId } : {}),
    llm: record.llm,
    llmPreset: record.llmPreset,
    ...(record.llmModel !== undefined ? { llmModel: record.llmModel } : {}),
    ...(record.llmWarning !== undefined ? { llmWarning: record.llmWarning } : {}),
    trajectoryDir: record.trajectoryDir!,
    createdAt: record.createdAt,
    hibernatedAt: metadata.writtenAt,
    checkpoint: metadata,
  };
}

/**
 * Shape the ADOPTED hibernated record for a cross-process checkpoint (S3):
 * an on-disk file written by a PREVIOUS process becomes the lightweight
 * record the wake path (resumeEnvSession) needs.
 */
export function adoptedRecordFrom(
  path: string,
  bytes: number,
  checkpoint: WorldCheckpointFile,
  args: { environmentOwnerId?: string },
): HibernatedSimulationRecord {
  return {
    id: checkpoint.simId,
    scenarioId: checkpoint.scenarioId,
    ...(checkpoint.environmentId !== undefined ? { environmentId: checkpoint.environmentId } : {}),
    ...(checkpoint.createdBy !== undefined ? { createdBy: checkpoint.createdBy } : {}),
    scenario: checkpoint.scenario,
    createOptions: checkpoint.createOptions,
    ...(args.environmentOwnerId !== undefined
      ? { environmentOwnerId: args.environmentOwnerId }
      : {}),
    llm: checkpoint.llm.mode,
    llmPreset: checkpoint.llm.preset,
    ...(checkpoint.llm.model !== undefined ? { llmModel: checkpoint.llm.model } : {}),
    ...(checkpoint.llm.warning !== undefined ? { llmWarning: checkpoint.llm.warning } : {}),
    trajectoryDir: dirname(path),
    createdAt: checkpoint.createdAt,
    hibernatedAt: checkpoint.hibernatedAt,
    checkpoint: {
      path,
      simTimeSec: checkpoint.world.simTimeSec,
      bytes,
      writtenAt: checkpoint.hibernatedAt,
    },
  };
}

/** Live record → list summary (list()/me lanes; sessions filtered upstream). */
export function liveSummaryOf(record: SimulationRecord): SimulationSummary {
  return {
    id: record.id,
    scenarioId: record.scenarioId,
    ...(record.environmentId !== undefined ? { environmentId: record.environmentId } : {}),
    ...(record.createdBy !== undefined ? { createdBy: record.createdBy } : {}),
    state: record.runtime.getState(),
    simTimeSec: record.runtime.getSimTimeSec(),
    llm: record.llm,
    ...(record.llmModel !== undefined ? { llmModel: record.llmModel } : {}),
    ...(record.llmWarning !== undefined ? { llmWarning: record.llmWarning } : {}),
    scheduling: record.scheduling,
  };
}

/** Hibernated record → list summary (state 'hibernated' + checkpoint metadata). */
export function hibernatedSummaryOf(hibernated: HibernatedSimulationRecord): SimulationSummary {
  return {
    id: hibernated.id,
    scenarioId: hibernated.scenarioId,
    ...(hibernated.environmentId !== undefined ? { environmentId: hibernated.environmentId } : {}),
    ...(hibernated.createdBy !== undefined ? { createdBy: hibernated.createdBy } : {}),
    state: 'hibernated',
    simTimeSec: hibernated.checkpoint.simTimeSec,
    llm: hibernated.llm,
    ...(hibernated.llmModel !== undefined ? { llmModel: hibernated.llmModel } : {}),
    ...(hibernated.llmWarning !== undefined ? { llmWarning: hibernated.llmWarning } : {}),
    scheduling: hibernated.createOptions.scheduling ?? 'tick',
    hibernatedAt: hibernated.hibernatedAt,
    checkpoint: hibernated.checkpoint,
  };
}
