/**
 * @vitest-environment node
 *
 * Living-worlds P2 — TrajectoryRecorder segmented-log unit tests:
 *
 * - records append to `<outputDir>/<base>/segment-<n>.jsonl`; the active
 *   segment rotates at `segmentMaxBytes` (sealed segments never rewritten,
 *   so nothing is dropped at the cap — the equivalence with a single huge
 *   segment is byte-identical record order);
 * - a pre-P2 legacy single file `<base>.jsonl` stitches in as the OLDEST
 *   segment, and append mode (`append: true`, the P0 resume path) continues
 *   into the newest segment counting history across BOTH;
 * - truncate semantics (default construction) wipes the previous run of the
 *   SAME iteration (segments + legacy file) without touching other sims'
 *   data in the same output dir.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TrajectoryRecorder } from './index.js';
import { listRawFiles, segmentedLogOf } from '../storage/segmented-log.js';

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trajectory-segments-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** Minimal handshake-response record — one write-through lane suffices. */
function writeResponse(
  recorder: TrajectoryRecorder,
  agentId: string,
  seq: number,
): void {
  recorder.recordCollaborationResponse({
    collaborationId: `collab-${seq}`,
    agentId,
    decision: 'accept',
    decisionSource: 'rule',
  });
}

function readAllRaw(log: ReturnType<typeof segmentedLogOf>): string[] {
  const lines: string[] = [];
  for (const file of listRawFiles(log)) {
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      if (line.trim().length > 0) lines.push(line);
    }
  }
  return lines;
}

const BASE = 'test-cond-iter0-unit-test-model';

describe('TrajectoryRecorder segmented log (LW-P2)', () => {
  it('rotates at segmentMaxBytes; a tiny-cap run reads identically to a single-segment run', () => {
    const singleDir = makeDir();
    const multiDir = makeDir();
    const recorderSingle = new TrajectoryRecorder({
      outputDir: singleDir, condition: 'test-cond', scenario: 'unit', iteration: 0,
      model: 'test-model', segmentMaxBytes: 0, // no rotation
    });
    const recorderMulti = new TrajectoryRecorder({
      outputDir: multiDir, condition: 'test-cond', scenario: 'unit', iteration: 0,
      model: 'test-model', segmentMaxBytes: 400, // ~2 records per segment
    });
    for (let i = 0; i < 25; i++) {
      writeResponse(recorderSingle, `agent-${i % 3}`, i);
      writeResponse(recorderMulti, `agent-${i % 3}`, i);
    }

    const singleLog = segmentedLogOf(singleDir, BASE);
    const multiLog = segmentedLogOf(multiDir, BASE);
    expect(readdirSync(singleLog.segmentDir)).toEqual(['segment-000001.jsonl']);
    expect(readdirSync(multiLog.segmentDir).length).toBeGreaterThan(5);

    // Equivalence: the stitched record SEQUENCE is identical (recordedAt
    // timestamps legitimately differ between the two runs — compare the
    // identity fields the record lanes carry).
    const identity = (lines: string[]): Array<[string, string, string]> =>
      lines.map(line => {
        const r = JSON.parse(line) as { agentId: string; collaborationId: string; decision: string };
        return [r.agentId, r.collaborationId, r.decision] as [string, string, string];
      });
    expect(identity(readAllRaw(multiLog))).toEqual(identity(readAllRaw(singleLog)));
    expect(recorderMulti.size).toBe(25);
  });

  it('append mode continues into the newest segment and counts legacy + segment history', () => {
    const dir = makeDir();
    const log = segmentedLogOf(dir, BASE);
    // Pre-P2 dir: the hibernated sim's history sits in a legacy single file.
    writeFileSync(
      log.legacyFile,
      JSON.stringify({ eventId: 'e0', agentId: 'a0', decision: 'accept' }) + '\n',
    );
    const recorder = new TrajectoryRecorder({
      outputDir: dir, condition: 'test-cond', scenario: 'unit', iteration: 0,
      model: 'test-model', append: true, segmentMaxBytes: 0,
    });
    expect(recorder.size).toBe(1); // honest size spans the stitched history
    writeResponse(recorder, 'agent-1', 1);
    writeResponse(recorder, 'agent-2', 2);

    // New writes went to segments; the legacy file is untouched and reads
    // FIRST (oldest).
    expect(existsSync(join(log.segmentDir, 'segment-000001.jsonl'))).toBe(true);
    const records = readAllRaw(log).map(line => JSON.parse(line) as { eventId?: string; agentId: string });
    expect(records.map(r => r.agentId)).toEqual(['a0', 'agent-1', 'agent-2']);
    expect(recorder.size).toBe(3);
  });

  it('truncate semantics wipe the previous run of the same iteration (segments + legacy), neighbors untouched', () => {
    const dir = makeDir();
    const log = segmentedLogOf(dir, BASE);
    const first = new TrajectoryRecorder({
      outputDir: dir, condition: 'test-cond', scenario: 'unit', iteration: 0,
      model: 'test-model', segmentMaxBytes: 300,
    });
    for (let i = 0; i < 6; i++) writeResponse(first, 'agent-1', i);
    expect(readdirSync(log.segmentDir).length).toBeGreaterThan(1);
    // A sibling log (different iteration) must survive the re-run.
    const neighbor = new TrajectoryRecorder({
      outputDir: dir, condition: 'test-cond', scenario: 'unit', iteration: 1,
      model: 'test-model', segmentMaxBytes: 0,
    });
    writeResponse(neighbor, 'agent-9', 99);

    const rerun = new TrajectoryRecorder({
      outputDir: dir, condition: 'test-cond', scenario: 'unit', iteration: 0,
      model: 'test-model', segmentMaxBytes: 300, // default: truncate
    });
    writeResponse(rerun, 'agent-2', 10);

    const iter0 = readAllRaw(log).map(l => JSON.parse(l) as { agentId: string });
    expect(iter0).toHaveLength(1);
    expect(iter0[0]!.agentId).toBe('agent-2');
    const neighborLog = segmentedLogOf(dir, 'test-cond-iter1-unit-test-model');
    expect(readAllRaw(neighborLog)).toHaveLength(1);
  });

  it('a recorder that never records leaves no empty file behind', () => {
    const dir = makeDir();
    const recorder = new TrajectoryRecorder({
      outputDir: dir, condition: 'test-cond', scenario: 'unit', iteration: 0,
      model: 'test-model',
    });
    expect(recorder.size).toBe(0);
    expect(existsSync(recorder.filePath)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
