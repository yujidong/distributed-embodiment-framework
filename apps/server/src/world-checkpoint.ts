/**
 * World checkpoint — versioned world-state snapshot at a sim-time boundary
 * (Living-worlds P0, design-living-worlds.md §9 / §12.3)
 *
 * Hibernation's durable half: everything a server process needs to
 * RECONSTRUCT a simulation runtime that continues the hibernated run
 * bit-for-bit, frozen into one JSON document under the sim's trajectory dir
 * (`<trajectoryDir>/checkpoint.json`). Shaping-module discipline (pure
 * serialization, zero engine logic): `buildWorldCheckpoint` assembles plain
 * data; `writeWorldCheckpoint` is the only I/O (atomic tmp+rename, size
 * bounded); `readWorldCheckpoint` validates and hands the plain data back.
 *
 * Self-containedness: the envelope carries the SCENARIO and the create
 * options next to the engine's world state, so resume never depends on the
 * scenario store or environment rows still holding the exact content the
 * hibernated world was built from (fork semantics — a sim is a frozen
 * snapshot, not a live view of its source). Audit streams (trajectory JSONL,
 * sim-timeline JSONL, command_log, flow_runs) are NOT copied: they are
 * append-only files that the resumed run keeps appending to (identity and
 * history intact — the registry's resume passes `trajectoryAppend`).
 *
 * The engine payload (`world`) is produced by
 * EngineRuntime.exportWorldState() (packages/core runtime/shaping/world-state.ts)
 * — see that module for the per-field determinism rules (RNG as seed+draws,
 * due moments instead of timers, clock anchor for time-dependent models).
 */

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  EngineWorldStateExport,
  ScenarioDefinition,
} from '@active-collaboration/core';

import { ApiError } from './errors.js';
import type { CreateSimulationOptions, LLMPreset } from './simulation-registry.js';

/** Checkpoint file format version (bump = breaking; old files refuse loudly). */
export const WORLD_CHECKPOINT_VERSION = 1;

/** Default size bound (T-012 discipline: snapshots are bounded, 16MB ≫ ~140KB campus). */
export const DEFAULT_CHECKPOINT_MAX_BYTES = 16 * 1024 * 1024;

/** The on-disk filename inside the sim's trajectory dir. */
export const CHECKPOINT_FILENAME = 'checkpoint.json';

/**
 * T95 (R14, u1-F1): the ONE path contract for "where does this env's
 * world-session checkpoint live on disk?" — the deterministic session id
 * (`sim-<envId>-world-session`) inside the trajectory dir. Consumers: the
 * session service's lazy rebind / boot-scan, the sandbox fork's
 * cross-process fallback (P2F §10.1), and (since T95) the agent-NL restart
 * teaching's disk-half judgment. One function so the faces can never
 * disagree about where the world's survival is recorded.
 */
export function worldSessionCheckpointPath(trajectoryDir: string, envId: string): string {
  return join(trajectoryDir, `sim-${envId}-world-session`, CHECKPOINT_FILENAME);
}

/** The envelope written to disk — pure data, JSON round-trip safe. */
export interface WorldCheckpointFile {
  version: typeof WORLD_CHECKPOINT_VERSION;
  kind: 'world-checkpoint';
  /** The simulation's id — resume reuses it (identity continues). */
  simId: string;
  scenarioId: string;
  environmentId?: string;
  createdBy?: string;
  /** Registry record birth time (ISO) — survives hibernate/resume cycles. */
  createdAt: string;
  /** When this checkpoint was written (ISO). */
  hibernatedAt: string;
  /**
   * The scenario the runtime was built from. Sims are frozen snapshots of
   * their source (fork semantics) — resume rebuilds from THIS copy, not from
   * whatever the scenario store holds by then.
   */
  scenario: ScenarioDefinition;
  /**
   * The create options that shaped the runtime (LLM preset, acMode, tickMs,
   * triage…) — plain data, re-applied verbatim on resume.
   */
  createOptions: CreateSimulationOptions;
  /** Resolved LLM wiring at hibernate time (display continuity on resume). */
  llm: {
    mode: 'llm' | 'rule-only';
    preset: LLMPreset;
    model?: string;
    warning?: string;
  };
  /** The engine's exported world state (the deterministic payload). */
  world: EngineWorldStateExport;
  /**
   * Server-side injected-event tally ring (R14 data services): sim-clock
   * anchored, bounded at capture. countSince windows survive the boundary
   * because these events are the ONLY history surface injections have.
   */
  eventTally: Array<{ eventType: string; zoneId: string; simTimeSec: number }>;
}

/** Checkpoint metadata kept in the registry's hibernated record (no runtime). */
export interface CheckpointMetadata {
  /** Absolute path of the checkpoint file. */
  path: string;
  /** Sim-time boundary the world froze at. */
  simTimeSec: number;
  /** File size in bytes. */
  bytes: number;
  /** ISO timestamp of the write. */
  writtenAt: string;
}

// ---------------------------------------------------------------------------
// Build (pure)
// ---------------------------------------------------------------------------

/** Input to `buildWorldCheckpoint` — everything the registry knows at freeze. */
export interface BuildWorldCheckpointInput {
  simId: string;
  scenarioId: string;
  environmentId?: string;
  createdBy?: string;
  createdAt: string;
  scenario: ScenarioDefinition;
  createOptions: CreateSimulationOptions;
  llm: WorldCheckpointFile['llm'];
  world: EngineWorldStateExport;
  eventTally: WorldCheckpointFile['eventTally'];
  /** Clock for the freeze stamp (injectable; default real time). */
  now?: () => Date;
}

/** Assemble the checkpoint envelope — pure, no I/O, deterministic field order. */
export function buildWorldCheckpoint(input: BuildWorldCheckpointInput): WorldCheckpointFile {
  const now = (input.now ?? (() => new Date()))().toISOString();
  return {
    version: WORLD_CHECKPOINT_VERSION,
    kind: 'world-checkpoint',
    simId: input.simId,
    scenarioId: input.scenarioId,
    ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
    ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
    createdAt: input.createdAt,
    hibernatedAt: now,
    scenario: input.scenario,
    createOptions: input.createOptions,
    llm: input.llm,
    world: input.world,
    eventTally: input.eventTally,
  };
}

// ---------------------------------------------------------------------------
// Write / read (the only I/O; atomic + size-bounded)
// ---------------------------------------------------------------------------

/**
 * Serialize and atomically write a checkpoint into a trajectory dir.
 *
 * Atomicity: content lands in `<dir>/checkpoint.json.<uuid>.tmp`, the SIZE
 * GUARD runs against the tmp file, and only then `rename()` swaps it onto
 * `checkpoint.json` — a crash mid-write can never leave a torn checkpoint
 * under the real name (a leftover tmp file is inert and ignored).
 *
 * Size bound (T-012): a checkpoint larger than `maxBytes` is DELETED and
 * hibernation fails with CHECKPOINT_TOO_LARGE — an unbounded snapshot is a
 * disk-GC liability, and refusing beats silently dropping world state.
 */
export function writeWorldCheckpoint(
  trajectoryDir: string,
  checkpoint: WorldCheckpointFile,
  options: { maxBytes?: number } = {},
): CheckpointMetadata {
  const maxBytes = options.maxBytes ?? DEFAULT_CHECKPOINT_MAX_BYTES;
  const payload = JSON.stringify(checkpoint);
  mkdirSync(trajectoryDir, { recursive: true });

  const finalPath = join(trajectoryDir, CHECKPOINT_FILENAME);
  const tmpPath = join(trajectoryDir, `${CHECKPOINT_FILENAME}.${randomUUID()}.tmp`);
  writeFileSync(tmpPath, payload, 'utf-8');

  let bytes: number;
  try {
    bytes = statSync(tmpPath).size;
    if (bytes > maxBytes) {
      unlinkSync(tmpPath);
      throw new ApiError(
        413,
        'CHECKPOINT_TOO_LARGE',
        `World checkpoint for "${checkpoint.simId}" is ${bytes} bytes, over the ` +
          `${maxBytes}-byte cap — the world carries more zones/devices/agents than a ` +
          'checkpoint may freeze. The simulation was NOT hibernated and keeps running; ' +
          'stop it with /stop instead (its trajectory dir remains as the audit trail).',
        undefined,
        { bytes, maxBytes },
      );
    }
    renameSync(tmpPath, finalPath);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Crash between write and rename: sweep the tmp file, surface the failure.
    try { unlinkSync(tmpPath); } catch { /* already gone */ }
    throw new ApiError(
      500,
      'CHECKPOINT_WRITE_FAILED',
      `Writing the world checkpoint for "${checkpoint.simId}" failed: ${(error as Error).message}`,
    );
  }

  return {
    path: finalPath,
    simTimeSec: checkpoint.world.simTimeSec,
    bytes,
    writtenAt: checkpoint.hibernatedAt,
  };
}

/**
 * Read and validate a checkpoint file. Teaching errors, never bare JSON
 * faults: a missing/corrupt/foreign-version file tells the caller WHAT to do
 * (resume is impossible from it; the trajectory dir remains as audit trail —
 * the scenario + command/event logs can still rebuild a world via the replay
 * machinery, design §12.3's slow path).
 */
export function readWorldCheckpoint(path: string): WorldCheckpointFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new ApiError(
      409,
      'CHECKPOINT_UNREADABLE',
      `The checkpoint file for this simulation cannot be read (${(error as Error).message}). ` +
        'Resume needs an intact checkpoint; its trajectory dir (trajectory JSONL + ' +
        'sim-timeline) is still on disk as the audit trail.',
      undefined,
      { path },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ApiError(
      409,
      'CHECKPOINT_UNREADABLE',
      `The checkpoint file for this simulation is not valid JSON (${(error as Error).message}) — ` +
        'it may be truncated. Resume needs an intact checkpoint; the trajectory dir ' +
        'remains as the audit trail.',
      undefined,
      { path },
    );
  }
  if (
    typeof parsed !== 'object' || parsed === null ||
    (parsed as { version?: unknown }).version !== WORLD_CHECKPOINT_VERSION ||
    (parsed as { kind?: unknown }).kind !== 'world-checkpoint'
  ) {
    const version = (parsed as { version?: unknown } | null)?.version;
    throw new ApiError(
      409,
      'CHECKPOINT_UNSUPPORTED',
      `This checkpoint cannot be resumed by this server: expected version ` +
        `${WORLD_CHECKPOINT_VERSION} "world-checkpoint", found ` +
        `${JSON.stringify(version)}${typeof version === 'number' && version > WORLD_CHECKPOINT_VERSION ? ' (written by a newer server)' : ''}. ` +
        'Checkpoints do not cross versions (design §16.9); rebuild from the scenario instead.',
      undefined,
      { path },
    );
  }
  const checkpoint = parsed as WorldCheckpointFile;
  if (checkpoint.world === undefined || checkpoint.scenario === undefined) {
    throw new ApiError(
      409,
      'CHECKPOINT_UNREADABLE',
      'The checkpoint file is structurally incomplete (missing world state or scenario) — ' +
        'resume is impossible from it. The trajectory dir remains as the audit trail.',
      undefined,
      { path },
    );
  }
  return checkpoint;
}
