/**
 * T37 + T38 (R3) — CLI polish render tests: reputation zero-sample face,
 * quota scope notes, and the env session dual-clock note. Pure render
 * fixtures — no server boot — CLI fast lane (T22 discipline: every output
 * change ships with a render-lane assertion).
 */

import { describe, expect, test } from 'vitest';

import { dualClockNote } from '../commands/env.js';
import { quotaScopeNote } from '../commands/me.js';
import { reputationFace } from '../commands/service.js';

// ============================================================================
// T37 (R3, u4-F4): a zero-sample reputation is a PRIOR, not a measured score
// ============================================================================

describe('reputationFace (T37, R3 u4-F4)', () => {
  test('attempts=0 renders —（无履约样本，先验 …） — never a bare "score 0.7"', () => {
    const line = reputationFace({ score: 0.7, attempts: 0, successes: 0, prior: 0.7 });
    expect(line).toContain('—（无履约样本，先验 0.7）');
    expect(line).toContain('attempts 0');
    expect(line).not.toContain('score 0.7');
  });

  test('prior falls back to the score when an older server omits the field', () => {
    const line = reputationFace({ score: 0.7, attempts: 0, successes: 0 });
    expect(line).toContain('先验 0.7');
    expect(line).not.toMatch(/score 0\.7/);
  });

  test('real attempts render the measured score plainly (no prior language)', () => {
    const line = reputationFace({ score: 0.85, attempts: 4, successes: 3 });
    expect(line).toContain('score 0.85');
    expect(line).toContain('attempts 4');
    expect(line).not.toContain('无履约样本');
  });

  test('partial-credit successes keep the zhao-20 named remainder', () => {
    const line = reputationFace({ score: 0.9, attempts: 3, successes: 2.5 });
    expect(line).toContain('succeeded 2 (+0.5 partial credit)');
  });
});

// ============================================================================
// T38.6 (R3, u2-F-12/u4-F9): quota scope notes
// ============================================================================

describe('quotaScopeNote (T38.6, R3)', () => {
  test('runningSimsPerUser is annotated env-全局 (cross-env per user)', () => {
    expect(quotaScopeNote('runningSimsPerUser', 2)).toContain('env 全局');
  });

  test('per-env quotas with used=0 carry the owned-envs-only note', () => {
    expect(quotaScopeNote('devicesPerEnv', 0)).toContain('只统计你拥有的环境');
    expect(quotaScopeNote('agentsPerEnv', 0)).toContain('只统计你拥有的环境');
  });

  test('non-zero per-env rows and other quotas stay bare', () => {
    expect(quotaScopeNote('devicesPerEnv', 5)).toBe('');
    expect(quotaScopeNote('environmentsPerUser', 0)).toBe('');
    expect(quotaScopeNote('sandboxesPerUserPerEnv', 0)).toBe('');
  });
});

// ============================================================================
// T38.5 (R3, u1-F8): the env session dual-clock note
// ============================================================================

describe('dualClockNote (T38.5, R3 u1-F8)', () => {
  test('other running sims are counted and named; independence is stated', () => {
    const note = dualClockNote('sim-env-world-session', [{ id: 'sim-a' }, { id: 'sim-b' }]);
    expect(note).toContain('环境权威世界');
    expect(note).toContain('另有 2 个 sim 正在运行');
    expect(note).toContain('sim-a, sim-b');
    expect(note).toContain('id 与时钟各自独立');
  });

  test('no other running sims: the session-only face still names the independence', () => {
    const note = dualClockNote('sim-env-world-session', []);
    expect(note).toContain('环境权威世界');
    expect(note).toContain('id 与时钟各自独立');
    expect(note).not.toContain('另有');
  });
});

// ============================================================================
// T72 (R8 验收①/R9 协议): `eaf --version` — the artifact fingerprint face.
// Every acceptance capture starts by recording WHICH build answered; this
// face runs in-process (no server) so the fast lane can hold it.
// ============================================================================

describe('eaf --version (T72, R8)', () => {
  test('prints version + loaded-artifact mtime on STDOUT; git rev only when a checkout exists', async () => {
    const { run } = await import('../cli.js');
    const chunks = { out: '', err: '' };
    const io = {
      stdout: (c: string) => (chunks.out += c),
      stderr: (c: string) => (chunks.err += c),
      env: process.env,
    };
    const code = await run(['--version'], io);
    expect(code).toBe(0);
    expect(chunks.out).toMatch(/^eaf \S+ artifact \d{4}-\d{2}-\d{2}T/);
    // Stream discipline: the fingerprint IS the answer — stdout, not stderr.
    expect(chunks.err).toBe('');
    // Any git rev present is a SHORT hash (7-40 hex), never a fabricated label.
    const rev = chunks.out.match(/git ([0-9a-f]+)/);
    if (rev !== null) expect(rev[1].length).toBeGreaterThanOrEqual(7);
  });
});
