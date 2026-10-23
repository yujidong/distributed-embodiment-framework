/**
 * @vitest-environment node
 *
 * plan-r84 Wave F3 runner 的纯函数单测（scripts/eval/gate-lib.mjs）：
 * 两个 runner（decision-regression.mjs / acceptance-gate.mjs）的确定性逻辑
 * —— 样本字段级断言、汇总、门禁判定、失败签名归一化与聚类、趋势追加。
 * core 的校验器/词表映射以 stub 注入（runner 里才接 packages/core dist）。
 */

import { describe, expect, it } from 'vitest';

import {
  SIX_BLOCKS,
  appendTrendLine,
  clusterFailures,
  evaluateDecisionSample,
  extractJsonObject,
  judgeGate,
  normalizeSignature,
  pickSpread,
  stripThink,
  summarizeSamples,
} from '../../scripts/eval/gate-lib.mjs';

// ---------------------------------------------------------------------------
// 注入 stub：仿 validateDecisionV1 / cognitiveActionToLegacyDecision 的形状
// ---------------------------------------------------------------------------

const VALID_ACTIONS = ['handle_independently', 'initiate_ac', 'defer', 'escalate', 'wait', 'invoke_flow'];
const stubValidate = payload => ({
  valid: VALID_ACTIONS.includes(payload?.actionPlan?.primary?.action),
  errors: VALID_ACTIONS.includes(payload?.actionPlan?.primary?.action) ? [] : ['actionPlan.primary.action: not in enum'],
});
const stubToLegacy = action => {
  if (!VALID_ACTIONS.includes(action)) throw new Error(`unknown action: ${action}`);
  if (action === 'initiate_ac') return 'initiate_ac';
  if (action === 'defer' || action === 'escalate') return 'defer';
  return 'handle_independently';
};

const sixBlockPayload = action => JSON.stringify({
  situation: { type: 'anomaly' },
  goals: { primary: '保持温度' },
  actionPlan: { primary: { action, reasoning: '因为 zone-a 过热' } },
  explanation: { summary: 'zone-a 发生 temperature-spike 事件，需要降温' },
  collaboration: { needed: false },
  uncertainty: { level: 'low' },
});
const INSTRUCTION = 'AGENT: x\nEVENT: Zone=zone-a | Event temperature-spike from engine, value=35';

describe('stripThink / extractJsonObject', () => {
  it('剥掉 think 块', () => {
    expect(stripThink('<think>推理</think>{"a":1}')).toBe('{"a":1}');
    expect(stripThink('  plain  ')).toBe('plain');
  });

  it('整串 parse 优先，失败退回首尾大括号切片', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('前缀说明 {"a":1} 后缀')).toEqual({ a: 1 });
    expect(extractJsonObject('not json at all')).toBeNull();
    expect(extractJsonObject('[1,2]')).toEqual([1, 2]); // 数组也是对象（typeof），但不影响断言
    expect(extractJsonObject('')).toBeNull();
  });
});

describe('evaluateDecisionSample — 字段级断言 + rubric', () => {
  const evaluate = (text, target = 'handle_independently') =>
    evaluateDecisionSample({
      text, target, instruction: INSTRUCTION,
      validateDecision: stubValidate, toLegacyAction: stubToLegacy,
    });

  it('合规六块输出全绿', () => {
    const r = evaluate(sixBlockPayload('handle_independently'));
    expect(r.pass).toBe(true);
    expect(r.checks).toMatchObject({
      jsonOk: true, sixBlocks: true, schemaValid: true, actionInVocab: true,
      actionMatch: true, legacyMatch: true, summaryNonEmpty: true, summaryGrounded: true,
    });
    expect(r.action).toBe('handle_independently');
  });

  it('缺块 → sixBlocks false → 门禁不过', () => {
    const payload = JSON.parse(sixBlockPayload('wait'));
    delete payload.collaboration;
    const r = evaluate(JSON.stringify(payload), 'wait');
    expect(r.checks.sixBlocks).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('action 不在词表 → schemaValid + actionInVocab 双红', () => {
    const r = evaluate(sixBlockPayload('destroy_everything'));
    expect(r.checks.schemaValid).toBe(false);
    expect(r.checks.actionInVocab).toBe(false);
    expect(r.schemaErrors.length).toBeGreaterThan(0);
    expect(r.pass).toBe(false);
  });

  it('非 JSON 输出 → jsonOk false，其余检查保持 false', () => {
    const r = evaluate('我决定先观察一下再说');
    expect(r.checks.jsonOk).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('legacy 等价命中但精确 action 不同：actionMatch false / legacyMatch true', () => {
    const r = evaluate(sixBlockPayload('wait'), 'handle_independently');
    expect(r.checks.actionMatch).toBe(false);
    expect(r.checks.legacyMatch).toBe(true); // wait → handle_independently
  });

  it('summary 不落地（不提 zone/事件）→ summaryGrounded false，但不影响门禁', () => {
    const payload = JSON.parse(sixBlockPayload('handle_independently'));
    payload.explanation.summary = '我觉得应该处理一下';
    const r = evaluate(JSON.stringify(payload));
    expect(r.checks.summaryGrounded).toBe(false);
    expect(r.pass).toBe(true); // rubric 不进门禁
  });
});

describe('summarizeSamples', () => {
  it('率值与 action 分布', () => {
    const ok = evaluateDecisionSample({
      text: sixBlockPayload('wait'), target: 'wait', instruction: INSTRUCTION,
      validateDecision: stubValidate, toLegacyAction: stubToLegacy,
    });
    const bad = { pass: false, action: null, checks: { jsonOk: false }, error: 'HTTP 429' };
    const s = summarizeSamples([ok, bad]);
    expect(s.pass).toBe(1);
    expect(s.total).toBe(2);
    expect(s.rate).toBe(0.5);
    expect(s.metrics.json_ok).toBe(0.5);
    expect(s.actionDist).toEqual({ wait: 1 });
  });

  it('空集：rate null', () => {
    const s = summarizeSamples([]);
    expect(s.rate).toBeNull();
    expect(s.metrics.json_ok).toBeNull();
  });
});

describe('judgeGate — 门禁语义', () => {
  it('达阈值过、低于阈值不过', () => {
    expect(judgeGate({ pass: 19, total: 20, threshold: 0.95 })).toEqual({ rate: 0.95, gatePass: true, threshold: 0.95 });
    expect(judgeGate({ pass: 18, total: 20, threshold: 0.95 }).gatePass).toBe(false);
    expect(judgeGate({ pass: 5, total: 5, threshold: 1.0 }).gatePass).toBe(true);
  });

  it('total=0 恒失败（空集没有验收意义）', () => {
    expect(judgeGate({ pass: 0, total: 0, threshold: 0 }).gatePass).toBe(false);
  });
});

describe('pickSpread — 均匀抽样', () => {
  const list = Array.from({ length: 76 }, (_, i) => i);
  it('limit >= 长度 → 全量', () => {
    expect(pickSpread(list, 0)).toHaveLength(76);
    expect(pickSpread(list, 100)).toHaveLength(76);
  });
  it('均匀步进，含首尾', () => {
    const picks = pickSpread(list, 5);
    expect(picks).toHaveLength(5);
    expect(picks[0]).toBe(0);
    expect(picks[picks.length - 1]).toBe(60);
  });
});

describe('normalizeSignature / clusterFailures — 失败聚类', () => {
  it('UUID / 时间戳 / 长数字被抹平，同根因归簇', () => {
    const a = normalizeSignature('device 9f3e20d1-ea3c-409e-806e-585e57fb193b denied at 2026-09-03T06:58:34.575Z');
    const b = normalizeSignature('device 11111111-2222-3333-4444-555555555555 denied at 2026-09-04T01:02:03.000Z');
    expect(a).toBe(b);
    expect(a).toBe('device <uuid> denied at <ts>');
  });

  it('按签名归簇计数，count 降序，样例封顶 3 条', () => {
    const failures = [
      { signature: 'friction:lin:zone-create', detail: 'd1' },
      { signature: 'error:HTTP 429 too many requests', detail: 'run 1' },
      { signature: 'friction:lin:zone-create', detail: 'd2' },
      { signature: 'error:HTTP 429 too many requests' },
      { signature: 'friction:lin:zone-create', detail: 'd3' },
      { signature: 'friction:lin:zone-create', detail: 'd4' },
    ];
    const clusters = clusterFailures(failures);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({ signature: 'friction:lin:zone-create', count: 4 });
    expect(clusters[0].examples).toHaveLength(3);
    expect(clusters[1]).toMatchObject({ signature: 'error:HTTP 429 too many requests', count: 2 });
  });

  it('空输入 → 空簇', () => {
    expect(clusterFailures([])).toEqual([]);
  });
});

describe('appendTrendLine — 趋势追加', () => {
  it('追加一行 ndjson（带 ts），返回行对象', () => {
    const written = [];
    const line = appendTrendLine(text => written.push(text), { model: 'm', pass: 5, total: 5, rate: 1 });
    expect(written).toHaveLength(1);
    expect(written[0].endsWith('\n')).toBe(true);
    const parsed = JSON.parse(written[0]);
    expect(parsed).toMatchObject({ model: 'm', pass: 5, total: 5, rate: 1 });
    expect(typeof parsed.ts).toBe('string');
    expect(line.model).toBe('m');
  });
});

describe('SIX_BLOCKS 契约', () => {
  it('六块清单与 decision-v1 顶层键一致', () => {
    expect(SIX_BLOCKS).toEqual(['situation', 'goals', 'actionPlan', 'explanation', 'collaboration', 'uncertainty']);
  });
});
