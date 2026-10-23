/**
 * T40d (R4, u3-F1) — `service list` human rows must SHOW declaration drift.
 * u3's report: `service get` warns "⚠ provider 未声明…" (Batch 3 T28)
 * but the list — where the marketplace is actually browsed — had no marker,
 * so a drifted offer was indistinguishable from a healthy one until opened.
 * Fix: a `drift` column carrying the shared ⚠ marker; pure row fixtures
 * (humanZoneTable pattern, T22 discipline).
 *
 * T40j (R4, u2#3) rides here too: the measured reputation score rounds to
 * two decimals — a 16-digit float is machine data, not a human face.
 */

import { describe, expect, test } from 'vitest';

import { reputationFace, serviceListRow, type ServiceEntry } from '../commands/service.js';

function service(overrides: Partial<ServiceEntry>): ServiceEntry {
  return {
    id: 'svc-1',
    envId: 'env-1',
    name: '空调启停（D栋）',
    semanticType: 'turn-on',
    description: '',
    origin: 'derived',
    visibility: 'members',
    unbacked: false,
    provider: { id: 'agent-1', name: 'D栋空调管家', owner: { id: 'u1', displayName: '林设备商' } },
    reputation: { score: 0.6818455374547898, attempts: 13, successes: 9 },
    createdAt: '2026-09-16T10:00:00.000Z',
    ...overrides,
  };
}

describe('serviceListRow (T40d, R4 u3-F1)', () => {
  test('a DECLARATION-drifted offer carries the ⚠ marker in the drift column', () => {
    const row = serviceListRow(service({ declaredByProvider: false }), 'XJTU-R2');
    expect(row.drift).toBe('⚠');
    expect(row.id).toBe('svc-1');
    expect(row.provider).toBe('D栋空调管家');
    expect(row.env).toBe('XJTU-R2');
  });

  test('a healthy offer renders an EMPTY drift cell — no phantom markers', () => {
    expect(serviceListRow(service({}), 'XJTU-R2').drift).toBe('');
  });

  test('T62: a backing-ambiguous offer carries the ⚠ ambiguous marker; backed/unset stay empty', () => {
    const row = serviceListRow(
      service({ signability: { verdict: 'ambiguous', candidateDevices: ['Meter A', 'Meter B'] } }),
      'XJTU-R2',
    );
    expect(row.signability).toBe('⚠ ambiguous');
    expect(serviceListRow(service({ signability: { verdict: 'backed' } }), 'XJTU-R2').signability).toBe('');
    expect(serviceListRow(service({}), 'XJTU-R2').signability).toBe('');
  });

  test('T68a (R7, u2-F-5): an aggregate offer with rule-lane signability shows unbacked in the column', () => {
    // The 12 no-field aggregate rows now judge the RULE lane — an unbacked
    // one (rule unresolvable, or no bound device holds the actuation
    // capabilities) is visible where the marketplace is browsed.
    const row = serviceListRow(
      service({ origin: 'aggregate', name: '避难安置保障', signability: { verdict: 'unbacked' } }),
      'XJTU-R2',
    );
    expect(row.signability).toBe('unbacked');
    expect(serviceListRow(
      service({ origin: 'aggregate', name: '校园空气环境保障', signability: { verdict: 'backed' } }),
      'XJTU-R2',
    ).signability).toBe('');
  });

  test('a missing env name falls back to the env id (the --all aggregation path)', () => {
    const row = serviceListRow(service({}), undefined);
    expect(row.env).toBe('env-1');
  });
});

describe('reputationFace rounding (T40j, R4 u2#3)', () => {
  test('a 16-digit measured score renders with two decimals — never the raw float', () => {
    const face = reputationFace({ score: 0.6818455374547898, attempts: 13, successes: 9 });
    expect(face).toContain('score 0.68');
    expect(face).not.toContain('0.6818455374547898');
    expect(face).toContain('attempts 13');
  });

  test('the zero-sample prior face keeps its shape (T37 anchor untouched)', () => {
    const face = reputationFace({ score: 0.7, attempts: 0, successes: 0, prior: 0.7 });
    expect(face).toContain('无履约样本');
    expect(face).toContain('先验 0.7');
  });
});
