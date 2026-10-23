/**
 * T21 (R3, u2-F-01/u4-F1) — `agreement get` human-mode restricted-view
 * rendering regression. Pure render fixtures — no server boot — so the file
 * lives in the CLI fast lane (humanZoneTable / renderStatusHumanLines
 * pattern; T22 discipline: every payload shape branch gets a render test).
 *
 * The Batch 2 regression: the T6 restricted payload
 * (`terminatedAgreementRestrictedJson`, apps/server/src/agreements/view.ts)
 * carries `consumerAgentName`/`consumerAgentId`/`providerAgentName`/
 * `providerAgentId` but NO `consumer`/`provider`
 * owner objects, while the CLI renderer read `agreement.consumer.displayName`
 * unconditionally BEFORE its restricted branch — a TypeError crash, exit 1,
 * on the exact lane R3's new口径 is about (a member reading terminated
 * world history). The fixture below mirrors the server function's output
 * shape field-for-field (shape source of truth: view.ts; the CLI's
 * `RestrictedAgreementEntry` types it).
 */

import { describe, expect, test } from 'vitest';

import {
  agreementListRow,
  isRestrictedAgreement,
  renderAgreementGetLines,
  terminatedDeliveryNote,
  usageTableRow,
  type AgreementEntry,
  type RestrictedAgreementEntry,
  type UsageRecordEntry,
} from '../commands/agreement.js';

/** Mirror of terminatedAgreementRestrictedJson (view.ts) — u2/u4's payload shape. */
const RESTRICTED: RestrictedAgreementEntry = {
  id: '6cf76c68-1f2b-4c9d-8a3e-mu47nrde-t1',
  envId: 'env-xjtu-r2',
  status: 'terminated',
  source: 'explicit',
  collaborationId: null,
  service: { id: 'svc-1', name: '空调启停（D栋）' },
  consumerAgentId: 'agent-consumer-1',
  consumerAgentName: 'D栋能耗管家',
  providerAgentId: 'agent-provider-1',
  providerAgentName: null, // retired provider rows unlink — name may be gone
  outcome: 'success',
  terminatedAt: '2026-09-16T12:00:00.000Z',
  view: 'restricted',
};

const FULL_ACTIVE: AgreementEntry = {
  id: 'agt-full-1',
  envId: 'env-xjtu-r2',
  serviceId: 'svc-1',
  service: { id: 'svc-1', name: '空调启停（D栋）', semanticType: 'turn-on' },
  backingDeviceId: 'dev-1',
  callableActions: ['turn-on', 'turn-off'],
  consumerAgentId: 'agent-consumer-1',
  consumer: { id: 'u-consumer', displayName: '林曦' },
  providerAgentId: 'agent-provider-1',
  provider: { id: 'u-provider', displayName: '王设备商' },
  terms: {},
  counteredTerms: null,
  effectiveTerms: {},
  termsEnforced: false,
  status: 'active',
  createdAt: '2026-09-16T10:00:00.000Z',
  updatedAt: '2026-09-16T10:05:00.000Z',
};

describe('renderAgreementGetLines — restricted view (T21, R3)', () => {
  test('restricted payload renders its own branch: summary + agent parties + note, exit-quality output', () => {
    const lines = renderAgreementGetLines(RESTRICTED);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('agreement 6cf76c68-1f2b-4c9d-8a3e-mu47nrde-t1');
    expect(lines[0]).toContain('空调启停（D栋）');
    expect(lines[0]).toContain('terminated');
    expect(lines[0]).toContain('terminated at 2026-09-16T12:00:00.000Z');
    expect(lines[0]).toContain('outcome: success');
    // Parties as AGENTS (the restricted shape has no owner displayNames).
    expect(lines[1]).toContain('agent D栋能耗管家');
    expect(lines[1]).toContain('agent'); // provider name null → falls back to id
    expect(lines[1]).toContain('agent-provider-1');
    expect(lines[2]).toContain('(restricted view');
    expect(lines[2]).toContain('full detail is for the parties and the env owner');
  });

  test('no full-view field renders on the restricted branch (privacy + crash guard)', () => {
    const joined = renderAgreementGetLines(RESTRICTED).join('\n');
    expect(joined).not.toContain('effective terms');
    expect(joined).not.toContain('callable actions');
    expect(joined).not.toContain('displayName');
    expect(joined).not.toContain('林曦');
    expect(joined).not.toContain('王设备商');
  });

  test('the type guard discriminates the union (compiler-facing contract)', () => {
    expect(isRestrictedAgreement(RESTRICTED)).toBe(true);
    expect(isRestrictedAgreement(FULL_ACTIVE)).toBe(false);
  });
});

describe('renderAgreementGetLines — full view (regression guard)', () => {
  test('active full payload keeps the parties line with owner displayNames', () => {
    const lines = renderAgreementGetLines(FULL_ACTIVE);
    expect(lines[0]).toContain('agreement agt-full-1 — 空调启停（D栋） (active)');
    expect(lines[1]).toContain('consumer: 林曦 (agent agent-consumer-1)');
    expect(lines[1]).toContain('provider: 王设备商 (agent agent-provider-1)');
    expect(lines.join('\n')).toContain('effective terms');
  });

  test('terminated full payload keeps reason/outcome faces (R99/R102 anchors)', () => {
    const lines = renderAgreementGetLines({
      ...FULL_ACTIVE,
      status: 'terminated',
      terminatedAt: '2026-09-16T11:00:00.000Z',
      outcome: 'completed',
      statusReason: '演练结束，双方收口',
    });
    expect(lines[0]).toContain('outcome: completed');
    expect(lines.join('\n')).toContain('reason: 演练结束，双方收口');
    // R102: no recorded reason renders the honest fallback, never null.
    const noReason = renderAgreementGetLines({
      ...FULL_ACTIVE,
      status: 'terminated',
      terminatedAt: '2026-09-16T11:00:00.000Z',
      outcome: 'completed',
    });
    expect(noReason.join('\n')).toContain('reason: （未记录原因）');
  });

  // T22 (R3) 对账：Batch 2 的 T8 (backing) / T9 (remind) 渲染面补上测试。

  test('T8: an aggregate backing view renders the rule/actuates/devices line', () => {
    const lines = renderAgreementGetLines({
      ...FULL_ACTIVE,
      backing: {
        kind: 'rule',
        rule: '校园空气环境保障',
        actuates: ['lighting-control'],
        devices: [{ id: 'dev-1', name: '灯光机组 A' }],
        callableActions: ['set-brightness'],
      },
      callableActions: ['set-brightness'],
    });
    const backing = lines.find(l => l.includes('backing: rule'));
    expect(backing).toBeDefined();
    expect(backing).toContain('校园空气环境保障');
    expect(backing).toContain('lighting-control');
    expect(backing).toContain('灯光机组 A');
  });

  test('T9: the remind trace renders (count + last time); absent stays absent', () => {
    const reminded = renderAgreementGetLines({
      ...FULL_ACTIVE,
      remindCount: 2,
      lastRemindedAt: '2026-09-16T09:30:00.000Z',
    });
    const remind = reminded.find(l => l.includes('reminders:'));
    expect(remind).toBeDefined();
    expect(remind).toContain('2');
    expect(remind).toContain('2026-09-16T09:30:00.000Z');
    // Absent trace → no line (honest empty, not a zero).
    expect(renderAgreementGetLines(FULL_ACTIVE).some(l => l.includes('reminders:'))).toBe(false);
  });
});

describe('agreementListRow — view-aware table rows (T21/T30 forward-compat)', () => {
  test('restricted list rows render agent labels, never owner displayNames', () => {
    const row = agreementListRow(RESTRICTED);
    expect(row.consumer).toBe('D栋能耗管家');
    expect(row.provider).toBe('agent-provider-1'); // null name → agent id
    expect(row.service).toBe('空调启停（D栋）');
    expect(row.updatedAt).toBe(RESTRICTED.terminatedAt);
    expect(JSON.stringify(row)).not.toContain('林曦');
  });

  test('full list rows keep the owner displayNames', () => {
    const row = agreementListRow(FULL_ACTIVE);
    expect(row.consumer).toBe('林曦');
    expect(row.provider).toBe('王设备商');
    expect(row.updatedAt).toBe(FULL_ACTIVE.updatedAt);
  });
});

// ============================================================================
// T40 (R4) — R102 output-discipline completion on the agreement faces.
// ============================================================================

describe('T40a (R4, u3-F2): declaration drift renders on agreement get, shared wording with service get', () => {
  test('a drifted contracted service carries the ⚠ line (same sentence the service face warns)', () => {
    const lines = renderAgreementGetLines({
      ...FULL_ACTIVE,
      declaredByProvider: false,
      declarationDrift: {
        capability: 'turn-on',
        note: 'provider agent does not declare \'turn-on\'',
      },
    });
    const drift = lines.find(l => l.includes('⚠ provider 未声明'));
    expect(drift).toBeDefined();
    expect(drift).toContain("'turn-on'");
    expect(drift).toContain('设备仍可执行');
    expect(drift).toContain('declaredByProvider:false');
  });

  test('a healthy declaration renders no drift line (re-declare → the marker disappears)', () => {
    const lines = renderAgreementGetLines({ ...FULL_ACTIVE });
    expect(lines.some(l => l.includes('⚠ provider 未声明'))).toBe(false);
  });

  test('the drift line falls back to the service semantic type when the detail is absent', () => {
    const lines = renderAgreementGetLines({ ...FULL_ACTIVE, declaredByProvider: false });
    const drift = lines.find(l => l.includes('⚠ provider 未声明'));
    expect(drift).toContain("'turn-on'"); // FULL_ACTIVE.service.semanticType
  });
});

describe('T40b (R4, u1-F4): the reason line covers EVERY status', () => {
  test('an ACTIVE agreement shows the accept reason verbatim (was: hidden behind a 3-state gate)', () => {
    const lines = renderAgreementGetLines({
      ...FULL_ACTIVE,
      statusReason: '同意接入，价格按月结',
    });
    expect(lines.join('\n')).toContain('reason: 同意接入，价格按月结');
  });

  test('an active agreement WITHOUT a recorded reason shows the honest fallback, never null', () => {
    const lines = renderAgreementGetLines({ ...FULL_ACTIVE });
    expect(lines.join('\n')).toContain('reason: （未记录原因）');
  });

  test('rejected/suspended keep their reason faces (R102 anchors hold)', () => {
    const lines = renderAgreementGetLines({
      ...FULL_ACTIVE,
      status: 'rejected',
      statusReason: '配额已满',
    });
    expect(lines.join('\n')).toContain('reason: 配额已满');
  });
});

describe('T40c (R4, u4-P2-4): the list row carries the outcome column', () => {
  test('terminated rows show the outcome 口径; live rows show — (no invented value)', () => {
    const terminated: RestrictedAgreementEntry = {
      ...RESTRICTED,
      outcome: 'success',
    };
    expect(agreementListRow(terminated).outcome).toBe('success');
    expect(agreementListRow(FULL_ACTIVE).outcome).toBe('—');
    const cancelled = agreementListRow({ ...RESTRICTED, outcome: 'cancelled' });
    expect(cancelled.outcome).toBe('cancelled');
  });
});

describe('T40e (R4, u2#1): usage rows fall back to （未记录）, never a blank failure cell', () => {
  const record = (overrides: Partial<UsageRecordEntry>): UsageRecordEntry => ({
    id: 'u-1',
    agreementId: 'agt-1',
    kind: 'invoke',
    action: 'turn-on',
    quantity: 1,
    unit: 'call',
    outcome: 'failure',
    effectRef: null,
    startedAt: '2026-09-16T10:00:00.000Z',
    endedAt: '2026-09-16T10:00:01.000Z',
    ...overrides,
  });

  test('a legacy FAILURE row without failureReason renders （未记录）', () => {
    expect(usageTableRow(record({ failureReason: undefined })).failureReason).toBe('（未记录）');
  });

  test('a recorded reason renders verbatim; success rows stay bare (no noise)', () => {
    expect(usageTableRow(record({ failureReason: '设备离线' })).failureReason).toBe('设备离线');
    expect(usageTableRow(record({ outcome: 'success', failureReason: undefined })).failureReason).toBe('');
  });

  // FEAT-08/UX-04: the attribution columns (origin/source/simulationId) —
  // human ≥ --json (R102); rows predating the columns render （未记录）.
  test('attribution columns render verbatim when present, （未记录） when absent', () => {
    const full = usageTableRow(record({ origin: 'derived', source: 'autoReset', simulationId: 'sim-9' }));
    expect(full.origin).toBe('derived');
    expect(full.source).toBe('autoReset');
    expect(full.simulationId).toBe('sim-9');
    const legacy = usageTableRow(record({}));
    expect(legacy.origin).toBe('（未记录）');
    expect(legacy.source).toBe('（未记录）');
    expect(legacy.simulationId).toBe('（未记录）');
  });
});

describe('UX-16: agreementListRow contention marker', () => {
  test('a contending full-view row marks ⚠×N; absent summary stays bare (restricted rows never mark)', () => {
    const contending = agreementListRow({
      ...FULL_ACTIVE,
      contentionSummary: { count: 2, pairs: 3 },
    });
    expect(contending.contention).toBe('⚠×2');
    expect(agreementListRow(FULL_ACTIVE).contention).toBe('');
    // The restricted shape strips the automation topology — no marker even
    // if a hostile payload smuggled the field in (read through the full-view
    // shape only, like the drift flag).
    expect(agreementListRow(RESTRICTED).contention).toBe('');
  });
});

describe('T40h (R4, u4-P2-2): collaboration-only terminated agreements carry the delivery companion', () => {
  const usage = (kinds: string[]) =>
    kinds.map(kind => ({ kind }));

  test('outcome success + collaboration-only ledger → （协作完成、未见服务调用） on the outcome line', () => {
    const note = terminatedDeliveryNote({ status: 'terminated' }, usage(['ac']));
    expect(note).toBe('（协作完成、未见服务调用）');
    const lines = renderAgreementGetLines({ ...FULL_ACTIVE, status: 'terminated', outcome: 'success' }, note);
    expect(lines[0]).toContain('outcome: success');
    expect(lines[0]).toContain('（协作完成、未见服务调用）');
  });

  test('the restricted view renders the same companion (u4 reads world history)', () => {
    const note = terminatedDeliveryNote(RESTRICTED, usage(['ac']));
    expect(note).toBe('（协作完成、未见服务调用）');
    const lines = renderAgreementGetLines(RESTRICTED, note);
    expect(lines[0]).toContain('outcome: success');
    expect(lines[0]).toContain('（协作完成、未见服务调用）');
  });

  test('a delivered ledger (any invoke/stream/read row) gets NO companion — success means delivered', () => {
    expect(terminatedDeliveryNote({ status: 'terminated' }, usage(['invoke', 'ac']))).toBeUndefined();
    expect(terminatedDeliveryNote({ status: 'terminated' }, usage(['read']))).toBeUndefined();
  });

  test('no ledger access / empty ledger / non-terminated → the companion honestly stays absent', () => {
    expect(terminatedDeliveryNote({ status: 'terminated' }, undefined)).toBeUndefined();
    expect(terminatedDeliveryNote({ status: 'terminated' }, [])).toBeUndefined();
    expect(terminatedDeliveryNote({ status: 'active' }, usage(['ac']))).toBeUndefined();
    // Absent note → byte-identical legacy lines (old anchor discipline).
    expect(renderAgreementGetLines(RESTRICTED)[0]).toBe(
      'agreement 6cf76c68-1f2b-4c9d-8a3e-mu47nrde-t1 — 空调启停（D栋） (terminated) — ' +
      'terminated at 2026-09-16T12:00:00.000Z, outcome: success',
    );
  });
});
