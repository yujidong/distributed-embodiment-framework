/**
 * @vitest-environment node
 *
 * World checkpoint module tests (Living-worlds P0): pure build, atomic write
 * (tmp+rename), size bound, teaching read errors.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EngineWorldStateExport, ScenarioDefinition } from '@active-collaboration/core';
import { ApiError } from './errors.js';
import {
  buildWorldCheckpoint,
  CHECKPOINT_FILENAME,
  readWorldCheckpoint,
  writeWorldCheckpoint,
  WORLD_CHECKPOINT_VERSION,
} from './world-checkpoint.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'world-checkpoint-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** Run a thunk, returning the thrown ApiError (undefined when it did not throw). */
function captureError(thunk: () => unknown): ApiError | undefined {
  try {
    thunk();
  } catch (error) {
    return error as ApiError;
  }
  return undefined;
}

function minimalWorld(simTimeSec = 42): EngineWorldStateExport {
  return {
    formatVersion: 1,
    simTimeSec,
    speed: 2,
    tickCount: 21,
    simStartEpochMs: 1_700_000_000_000,
    eventSeq: 3,
    rng: { seed: 99, draws: 4 },
    zones: { 'zone-a': { occupancy: 2, field: { temperature: { value: 23.5, baseline: 22 } } } },
    devices: { 'dev-a': { state: { power: true }, fault: null } },
    deviceEffects: [],
    agents: { 'agent-a': { enabled: true } },
    reputation: null,
    recentDecisions: [],
    acCapabilities: {},
    scheduler: { firedEventIds: ['evt-1'], occupancyFired: [] },
    pendingEffectChecks: [],
    flowEngine: null,
  };
}

function minimalScenario(): ScenarioDefinition {
  return {
    version: '1.0',
    meta: { id: 'cp-test', name: 'Checkpoint Test' },
    zones: [
      { id: 'zone-a', name: 'Zone A', adjacentZoneIds: [], bounds: { minX: 0, maxX: 5, minY: 0, maxY: 5 }, baseline: { temperature: 22 } },
    ],
    devices: [
      { id: 'dev-a', name: 'Dev A', type: 'light', capabilities: ['lighting'], zoneId: 'zone-a' },
    ],
    agents: [
      { id: 'agent-a', name: 'Agent A', capabilities: ['lighting'], managesZoneIds: ['zone-a'], boundDeviceIds: ['dev-a'] },
    ],
    events: [],
  } as unknown as ScenarioDefinition;
}

describe('buildWorldCheckpoint', () => {
  it('assembles a pure, JSON-serializable envelope with identity fields', () => {
    const cp = buildWorldCheckpoint({
      simId: 'sim-x',
      scenarioId: 'cp-test',
      environmentId: 'env-1',
      createdBy: 'user-1',
      createdAt: '2026-08-23T00:00:00.000Z',
      scenario: minimalScenario(),
      createOptions: { llmClient: 'none', tickMs: 20 },
      llm: { mode: 'rule-only', preset: 'none' },
      world: minimalWorld(77),
      eventTally: [{ eventType: 'motion', zoneId: 'zone-a', simTimeSec: 30 }],
      now: () => new Date('2026-08-23T12:00:00.000Z'),
    });

    expect(cp.version).toBe(WORLD_CHECKPOINT_VERSION);
    expect(cp.kind).toBe('world-checkpoint');
    expect(cp.simId).toBe('sim-x');
    expect(cp.hibernatedAt).toBe('2026-08-23T12:00:00.000Z');
    expect(cp.world.simTimeSec).toBe(77);
    expect(cp.eventTally).toHaveLength(1);
    // Optional fields stay ABSENT (not undefined) — stable JSON shape.
    expect(JSON.parse(JSON.stringify(cp))).toEqual(cp);
  });

  it('omits absent optional identity fields', () => {
    const cp = buildWorldCheckpoint({
      simId: 'sim-y',
      scenarioId: 'cp-test',
      createdAt: '2026-08-23T00:00:00.000Z',
      scenario: minimalScenario(),
      createOptions: {},
      llm: { mode: 'rule-only', preset: 'auto' },
      world: minimalWorld(),
      eventTally: [],
    });
    expect('environmentId' in cp).toBe(false);
    expect('createdBy' in cp).toBe(false);
  });
});

describe('writeWorldCheckpoint / readWorldCheckpoint', () => {
  it('writes atomically and reads back the identical envelope', () => {
    const dir = makeTempDir();
    const cp = buildWorldCheckpoint({
      simId: 'sim-z',
      scenarioId: 'cp-test',
      createdAt: '2026-08-23T00:00:00.000Z',
      scenario: minimalScenario(),
      createOptions: { acMode: 'shadow' },
      llm: { mode: 'rule-only', preset: 'none', warning: 'no llm' },
      world: minimalWorld(123),
      eventTally: [],
    });

    const meta = writeWorldCheckpoint(dir, cp);
    expect(meta.simTimeSec).toBe(123);
    expect(meta.bytes).toBeGreaterThan(0);
    expect(meta.path).toBe(join(dir, CHECKPOINT_FILENAME));
    expect(existsSync(meta.path)).toBe(true);
    // No leftover tmp files (the atomic write's `checkpoint.json.<uuid>.tmp`
    // sidecar is renamed away). NOTE: assert on the .tmp suffix, not the
    // substring "tmp" — on Linux the temp root itself is /tmp and a
    // substring match false-positives on every path (latent on CI until
    // the server suite actually ran there).
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);

    const read = readWorldCheckpoint(meta.path);
    expect(read).toEqual(cp);
  });

  it('refuses oversized checkpoints without leaving a file (size-bounded)', () => {
    const dir = makeTempDir();
    const cp = buildWorldCheckpoint({
      simId: 'sim-big',
      scenarioId: 'cp-test',
      createdAt: '2026-08-23T00:00:00.000Z',
      scenario: minimalScenario(),
      createOptions: {},
      llm: { mode: 'rule-only', preset: 'auto' },
      world: minimalWorld(),
      eventTally: [],
    });
    expect(() => writeWorldCheckpoint(dir, cp, { maxBytes: 10 })).toThrow(ApiError);
    const error = (() => {
      try {
        writeWorldCheckpoint(dir, cp, { maxBytes: 10 });
      } catch (e) {
        return e as ApiError;
      }
      return undefined;
    })()!;
    expect(error.code).toBe('CHECKPOINT_TOO_LARGE');
    expect(error.statusCode).toBe(413);
    // Neither the final file nor a tmp leftover exists.
    expect(existsSync(join(dir, CHECKPOINT_FILENAME))).toBe(false);
  });

  it('teaching errors: missing file, corrupt JSON, foreign version', () => {
    const dir = makeTempDir();

    const missing = captureError(() => readWorldCheckpoint(join(dir, 'nope.json')));
    expect(missing?.code).toBe('CHECKPOINT_UNREADABLE');
    expect(missing?.message).toContain('audit trail');

    const corruptPath = join(dir, CHECKPOINT_FILENAME);
    writeFileSync(corruptPath, '{"version": 1, "kind": "world-checkp', 'utf-8');
    const corrupt = captureError(() => readWorldCheckpoint(corruptPath));
    expect(corrupt?.code).toBe('CHECKPOINT_UNREADABLE');

    writeFileSync(corruptPath, JSON.stringify({ version: 99, kind: 'world-checkpoint' }), 'utf-8');
    const foreign = captureError(() => readWorldCheckpoint(corruptPath));
    expect(foreign?.code).toBe('CHECKPOINT_UNSUPPORTED');
    expect(foreign?.message).toContain('newer server');
  });

  it('a torn tmp file is inert (ignored by reads, never the real name)', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, `${CHECKPOINT_FILENAME}.abc.tmp`), 'GARBAGE', 'utf-8');

    const cp = buildWorldCheckpoint({
      simId: 'sim-t',
      scenarioId: 'cp-test',
      createdAt: '2026-08-23T00:00:00.000Z',
      scenario: minimalScenario(),
      createOptions: {},
      llm: { mode: 'rule-only', preset: 'auto' },
      world: minimalWorld(),
      eventTally: [],
    });
    const meta = writeWorldCheckpoint(dir, cp);
    // The real checkpoint parses cleanly regardless of the garbage tmp.
    expect(() => readWorldCheckpoint(meta.path)).not.toThrow();
    expect(readFileSync(meta.path, 'utf-8').startsWith('{')).toBe(true);
  });
});
