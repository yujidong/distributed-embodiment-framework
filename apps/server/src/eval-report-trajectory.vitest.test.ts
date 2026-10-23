/**
 * @vitest-environment node
 *
 * plan-r84 F3-2：eval-report 轨迹级小节（aggregateEvalRecords 的纯聚合）。
 * 口径锚点：
 * - llmFailures = kind 'llm-failure' 的写通过账本计数，且不进 chain 分母；
 * - structuredOutput 只统计 decisionSource 'llm'，jsonRate = llm-json 占比；
 * - chain.actionable = decision ∈ handle_independently/initiate_ac（落到执行
 *   路径的决策），completeness = 其中 goalAchieved 已结算的比例；
 *   actionable=0 → completeness null（诚实空态）。
 * 全部来自 trajectory 已有字段，无新埋点。
 */

import { describe, expect, it } from 'vitest';

import type { TrajectoryRecord } from '@active-collaboration/core';

import { aggregateEvalRecords, reconcileMetaAgents } from './eval-report.js';

let seq = 0;
/** 最小 assessment 记录（aggregateEvalRecords 只读这里列出的字段）。 */
function assessment(overrides: Partial<TrajectoryRecord>): TrajectoryRecord {
  seq += 1;
  return {
    recordedAt: new Date().toISOString(),
    scenario: 's',
    condition: 'c',
    iteration: 0,
    eventId: `ev-${seq}`,
    agentId: 'agent-1',
    context: { capabilities: [], partnerServices: [], partnerServicesTotal: 0 },
    decision: 'wait',
    decisionSource: 'rule',
    groundTruth: { correctDecision: 'unknown', interactionType: 'x' },
    correct: null,
    ...overrides,
  } as TrajectoryRecord;
}

describe('eval-report trajectory 小节（F3-2）', () => {
  it('空记录：全零 + 率值诚实 null', () => {
    const m = aggregateEvalRecords([], []);
    expect(m.trajectory).toEqual({
      llmFailures: 0,
      structuredOutput: { llm: 0, json: 0, fsm: 0, jsonRate: null },
      chain: { actionable: 0, withFeedback: 0, completeness: null, unattributedExecutions: 0 },
    });
  });

  it('llm-failure 单独计数，不进 chain / structuredOutput', () => {
    const m = aggregateEvalRecords([
      assessment({ kind: 'llm-failure', decisionSource: 'llm', decision: 'handle_independently', errorMessage: 'HTTP 500' }),
      assessment({ kind: 'llm-failure', decisionSource: 'llm', decision: 'handle_independently' }),
    ], []);
    expect(m.trajectory.llmFailures).toBe(2);
    expect(m.trajectory.structuredOutput.llm).toBe(0);
    expect(m.trajectory.chain.actionable).toBe(0);
  });

  it('结构化输出合规率：llm-json / llm-fsm 分开计', () => {
    const m = aggregateEvalRecords([
      assessment({ decisionSource: 'llm', decisionSubSource: 'llm-json' }),
      assessment({ decisionSource: 'llm', decisionSubSource: 'llm-json' }),
      assessment({ decisionSource: 'llm', decisionSubSource: 'llm-fsm' }),
      assessment({ decisionSource: 'rule' }), // 不计入
    ], []);
    expect(m.trajectory.structuredOutput).toEqual({ llm: 3, json: 2, fsm: 1, jsonRate: 2 / 3 });
  });

  it('链路完整率：actionable 决策里 goalAchieved 已结算的比例', () => {
    const m = aggregateEvalRecords([
      assessment({ decision: 'handle_independently', goalAchieved: true }),
      assessment({ decision: 'handle_independently' }), // 无反馈标注
      assessment({ decision: 'initiate_ac', goalAchieved: false }),
      assessment({ decision: 'wait' }), // 有意不执行，不进 actionable
      assessment({ decision: 'defer' }),
    ], []);
    expect(m.trajectory.chain).toEqual({ actionable: 3, withFeedback: 2, completeness: 2 / 3, unattributedExecutions: 0 });
  });

  it('collaboration-response 记录不进任何轨迹小节', () => {
    const m = aggregateEvalRecords([
      assessment({ kind: 'collaboration-response', decision: 'accept', decisionSource: 'llm', decisionSubSource: 'llm-json', collaborationId: 'c1' }),
    ], []);
    expect(m.trajectory.structuredOutput.llm).toBe(0);
    expect(m.trajectory.chain.actionable).toBe(0);
    expect(m.handshakes.initiated).toBe(1); // 既有握手口径不受影响
  });

  it('R100 (chen-10): eval↔trajectory 对账——unknown 全 unlabeled、initiated 按 initiate_ac 记录数、去重取消可见、设备执行进 effectChecks、覆盖账与口径说明在报告里', () => {
    // chen-10 复演：12 条 precheck 决策全 unknown（含 2 条"自称有能力但零
    // 执行"的 LLM 决策）；同一事件 2 次 initiate_ac（协调器去重留 1 个
    // 组）；该组全员拒绝后 cancelled；7 条 reject 应答；2 条 NL 记录；
    // 2 条设备执行失败。
    const decisions = Array.from({ length: 12 }, (_, i) =>
      assessment({
        decisionSource: i < 10 ? 'precheck' : 'llm',
        decision: 'handle_independently',
        // "自称有能力但零执行"——无 goalAchieved 反馈、ground truth unknown。
      }));
    const initiates = [
      assessment({ decision: 'initiate_ac', eventId: 'ev-night-smoke', agentId: 'agent-a', collaborationId: 'ac-win' }),
      assessment({ decision: 'initiate_ac', eventId: 'ev-night-smoke', agentId: 'agent-b' }),
    ];
    const responses = [
      assessment({ kind: 'collaboration-response', decision: 'reject', collaborationId: 'ac-win', eventId: 'ev-night-smoke', agentId: 'p1' }),
      assessment({ kind: 'collaboration-response', decision: 'reject', collaborationId: 'ac-win', eventId: 'ev-night-smoke', agentId: 'p2' }),
      assessment({ kind: 'collaboration-response', decision: 'cancelled', collaborationId: 'ac-win', eventId: 'ev-night-smoke', agentId: 'agent-a' }),
    ];
    const nl = [
      assessment({ kind: 'nl-interaction', decision: 'get_status', decisionSource: 'rule', nl: { lane: 'ask', stage: 'intent', text: '温度多少', intentAction: 'get_status', parseSource: 'rules' } }),
      assessment({ kind: 'nl-interaction', decision: 'get_status', decisionSource: 'rule', nl: { lane: 'ask', stage: 'intent', text: '湿度多少', intentAction: 'get_status', parseSource: 'rules' } }),
    ];
    const deviceExec = [
      assessment({ kind: 'device-execution', decision: 'failed', decisionSource: 'user:u1', deviceExecution: { deviceId: 'pa-1', command: 'trigger-alert', success: false } }),
      assessment({ kind: 'device-execution', decision: 'failed', decisionSource: 'user:u1', deviceExecution: { deviceId: 'pa-1', command: 'trigger-alert', success: false } }),
    ];
    const m = aggregateEvalRecords([...decisions, ...initiates, ...responses, ...nl, ...deviceExec], []);

    // 1. 无 ground truth 不得计入正确：12 条全 unlabeled，accuracy 诚实 null。
    expect(m.decisions.correct).toBe(0);
    expect(m.decisions.unlabeled).toBe(14); // 12 handle + 2 initiate_ac 均 unknown
    expect(m.decisions.accuracy).toBeNull();
    // 2. initiated == trajectory 的 initiate_ac 条数（去重合并不吞发起）。
    expect(m.handshakes.initiated).toBe(2);
    // 3. 取消单列 + 协调器去重取消可见（组 cancelled 1 + 去重发起 1）。
    expect(m.handshakes.cancelled).toBe(1);
    expect(m.handshakes.cancelledByCoordinator).toBe(1);
    expect(m.handshakes.succeeded).toBe(0);
    // 4. 真实设备调用（含失败）进 effectChecks。
    expect(m.effectChecks.attempts).toBe(2);
    expect(m.effectChecks.failures).toBe(2);
    expect(m.effectChecks.deviceExecutions).toEqual({ attempts: 2, successes: 0, failures: 2 });
    // 5. 记录类型不再是无影黑洞：覆盖账逐类可见。
    expect(m.recordKinds).toMatchObject({
      decision: 14,
      'collaboration-response': 3,
      'nl-interaction': 2,
      'device-execution': 2,
    });
    // 6. 口径说明随报告下发（可复核依据）。
    expect(m.methodology.length).toBeGreaterThanOrEqual(4);
    expect(m.methodology.join(' ')).toContain('unlabeled');
  });

  it('R6-E-F10: device-execution 回执不进决策/chain 口径（执行成功 ≠ 目标达成）', () => {
    const m = aggregateEvalRecords([
      assessment({ decision: 'handle_independently', goalAchieved: true }),
      assessment({
        kind: 'device-execution',
        decision: 'executed',
        decisionSource: 'engine:agent:agent-1',
        deviceExecution: { deviceId: 'hvac-b', command: 'temperature-control', success: true },
      }),
    ], []);
    // 决策口径只看见那一条真决策；回执不稀释 accuracy、不冒充 withFeedback。
    expect(m.decisions.total).toBe(1);
    expect(m.trajectory.structuredOutput.llm).toBe(0);
    expect(m.trajectory.chain).toEqual({ actionable: 1, withFeedback: 1, completeness: 1, unattributedExecutions: 0 });
  });

  it('R5-F14: 带 errorMessage 的 collaboration-response 计入 llmFailures（评估降级不低估）', () => {
    const m = aggregateEvalRecords([
      assessment({ kind: 'collaboration-response', decision: 'accept', decisionSource: 'fallback', collaborationId: 'c1', errorMessage: 'Unterminated string in JSON at position 2100' }),
      assessment({ kind: 'collaboration-response', decision: 'accept', decisionSource: 'llm', collaborationId: 'c2' }),
    ], []);
    expect(m.trajectory.llmFailures).toBe(1); // 只有带 errorMessage 的那条
    expect(m.handshakes.initiated).toBe(2);
  });

  it('既有指标口径不变（决策总数含 llm-failure 账本——与聚合前行为一致）', () => {
    const m = aggregateEvalRecords([
      assessment({ decisionSource: 'rule' }),
      assessment({ kind: 'llm-failure', decisionSource: 'llm' }),
    ], []);
    expect(m.decisions.total).toBe(2); // llm-failure 仍计入 assessments（既有行为）
    expect(m.decisions.bySource).toEqual({ rule: 1, llm: 1 });
  });

  it('R6-C-F04: 带 errorMessage 的 nl-interaction 计入 llmFailures（NL 道降级不低估）', () => {
    const m = aggregateEvalRecords([
      // rules-llm-down + 可认领的调用（传输成功但答案不可用）——recorder 侧
      // 打上 errorMessage 的降级记录。
      assessment({
        kind: 'nl-interaction',
        decision: 'unknown',
        decisionSource: 'rules-llm-down',
        errorMessage: 'LLM intent parse degraded to rules (rules-llm-down) — the call returned an unusable answer',
        nl: { lane: 'command', stage: 'intent', text: '保持客房 26 度', intentAction: 'unknown', parseSource: 'rules-llm-down' },
      }),
      // 正常 NL 记录不受影响。
      assessment({
        kind: 'nl-interaction',
        decision: 'set_parameter',
        decisionSource: 'llm',
        nl: { lane: 'command', stage: 'intent', text: 'make the lobby cooler', intentAction: 'set_parameter', parseSource: 'llm' },
      }),
    ], []);
    expect(m.trajectory.llmFailures).toBe(1);
    expect(m.decisions.total).toBe(0);
  });

  it('nl-interaction 记录（NL 意图道账本）不进任何决策/轨迹口径', () => {
    const m = aggregateEvalRecords([
      assessment({
        kind: 'nl-interaction',
        decision: 'handle_independently',
        decisionSource: 'llm',
        nl: { lane: 'command', stage: 'decision', text: 'make the lobby cooler', intentAction: 'set_parameter', parseSource: 'llm' },
      }),
      assessment({
        kind: 'nl-interaction',
        decision: 'set_parameter',
        decisionSource: 'llm',
        nl: { lane: 'command', stage: 'intent', text: 'make the lobby cooler', intentAction: 'set_parameter', parseSource: 'llm' },
      }),
    ], []);
    expect(m.decisions.total).toBe(0);
    expect(m.events).toBe(0);
    expect(m.trajectory.structuredOutput.llm).toBe(0);
    expect(m.trajectory.chain.actionable).toBe(0);
    expect(m.trajectory.llmFailures).toBe(0);
    expect(m.handshakes.initiated).toBe(0);
  });
});

// ============================================================================
// R101 (chen-14) eval 残留收口：chain 反馈挂接 / responders 质量块 /
// perAgent 同源 / metaAgents 对账 / cancelled 补验证
// ============================================================================

describe('R101 (chen-14): eval residual reconciliation', () => {
  it('chain: 同 (eventId, agentId) 的 decision 触发 device-execution 回执计入 withFeedback；他人回执与手动回执不计', () => {
    const m = aggregateEvalRecords([
      assessment({ decision: 'handle_independently', eventId: 'ev-heat', agentId: 'agent-1' }),
      assessment({ decision: 'handle_independently', eventId: 'ev-heat', agentId: 'agent-2' }),
      // 决策触发的执行回执（带 eventId）——只挂自己的 (eventId, agentId)。
      assessment({
        kind: 'device-execution', eventId: 'ev-heat', agentId: 'agent-1',
        decision: 'executed', decisionSource: 'engine:agent:agent-1',
        deviceExecution: { deviceId: 'hvac-1', command: 'turn-on', success: true },
      }),
      // 手动操作（无 eventId）——永远不给决策记账。
      assessment({
        kind: 'device-execution', agentId: 'unknown', eventId: 'unattributed',
        decision: 'failed', decisionSource: 'user:u1',
        deviceExecution: { deviceId: 'pa-1', command: 'trigger-alert', success: false },
      }),
    ], []);
    // agent-1 被自己的回执挂接；agent-2 无回执无 goalAchieved。
    expect(m.trajectory.chain).toEqual({ actionable: 2, withFeedback: 1, completeness: 0.5, unattributedExecutions: 1 });
    // 回执仍不冒充 goalAchieved（R6-E-F10 语义不破）。
    expect(m.decisions.total).toBe(2);
  });

  it('responders: accept/reject 应答评估单列质量块（44i 口径），不进 decisions', () => {
    const m = aggregateEvalRecords([
      assessment({ decision: 'initiate_ac', eventId: 'ev-smoke' }),
      assessment({ kind: 'collaboration-response', decision: 'accept', decisionSource: 'llm', collaborationId: 'ac-1', eventId: 'ev-smoke', agentId: 'p1', groundTruth: { correctDecision: 'accept', interactionType: 'x' }, correct: true }),
      assessment({ kind: 'collaboration-response', decision: 'accept', decisionSource: 'rule', collaborationId: 'ac-1', eventId: 'ev-smoke', agentId: 'p2' }),
      assessment({ kind: 'collaboration-response', decision: 'reject', decisionSource: 'llm', collaborationId: 'ac-1', eventId: 'ev-smoke', agentId: 'p3', groundTruth: { correctDecision: 'reject', interactionType: 'x' }, correct: false }),
    ], []);
    expect(m.responders.total).toBe(3);
    expect(m.responders.accepts).toBe(2);
    expect(m.responders.rejects).toBe(1);
    expect(m.responders.bySource).toEqual({ llm: 2, rule: 1 });
    // p1 correct + p3 incorrect 标注、1 条 unknown → accuracy 1/2。
    expect(m.responders.unlabeled).toBe(1);
    expect(m.responders.accuracy).toBe(0.5);
    // decisions（发起方面）不受影响。
    expect(m.decisions.total).toBe(1);
  });

  it('perAgent 与 decisions 同源；T29：metaAgents 行保持全历史口径，本窗口数单列标注', () => {
    const m = aggregateEvalRecords([
      assessment({ agentId: 'zhao', decision: 'handle_independently', groundTruth: { correctDecision: 'handle_independently', interactionType: 'x' }, correct: true }),
      assessment({ agentId: 'zhao', decision: 'handle_independently', groundTruth: { correctDecision: 'initiate_ac', interactionType: 'x' }, correct: false }),
      assessment({ agentId: 'wang', decision: 'wait' }),
    ], []);
    expect(m.decisions.perAgent).toEqual([
      { agentId: 'zhao', total: 2, correct: 1, unlabeled: 0, accuracy: 0.5 },
      { agentId: 'wang', total: 1, correct: 0, unlabeled: 1, accuracy: null },
    ]);
    // T29 (R3 u4-F2)：registry 行不再被本窗口值整行覆盖——全历史值原样保留，
    // 本窗口决策数单列在 windowDecisionCount，行标注 window: 'all-history'。
    const reconciled = reconcileMetaAgents(
      [
        { agentId: 'zhao', decisionCount: 3, evaluatedDecisions: 3, successRate: 0, calibrationScore: 0.8 } as never,
        { agentId: 'stranger', decisionCount: 7, evaluatedDecisions: 7, successRate: 0.9 } as never,
      ],
      m.decisions.perAgent,
    );
    expect(reconciled[0]).toMatchObject({
      agentId: 'zhao',
      decisionCount: 3, // 全历史恒定——不再跳变为本窗口的 2
      evaluatedDecisions: 3,
      successRate: 0,
      calibrationScore: 0.8,
      window: 'all-history',
      windowDecisionCount: 2, // 本窗口 2 条决策可见、可复算，不混入行值
    });
    // 无 trajectory 记录的 agent 同样是全历史行（窗口数 0）。
    expect(reconciled[1]).toMatchObject({
      agentId: 'stranger',
      decisionCount: 7,
      successRate: 0.9,
      window: 'all-history',
      windowDecisionCount: 0,
    });
    // R102: trajectory 有决策但 registry 面无条目的 agent（wang）合成行——
    // decisions 面板有 entry 的 agent 在 metaAgents 必有对应条目；
    // T29：合成行显式标注 report-window（本窗口），不与全历史行静默混排。
    const wangRow = reconciled.find(row => row.agentId === 'wang');
    expect(wangRow).toMatchObject({
      agentId: 'wang',
      decisionCount: 1,
      evaluatedDecisions: 0,
      successRate: null,
      window: 'report-window',
    });
    // u3-F5：evaluatedDecisions < 3 的行带 smallSample（样本量小提示）。
    expect(wangRow!.smallSample).toBe(true);
    expect(reconciled[0].smallSample).toBeUndefined(); // 3 条 evaluated → 无提示
    // R103 (chen-21): synthesized rows name the agent readably — env row
    // name when resolvable, a 已删除 marker (never a bare UUID) otherwise.
    expect(wangRow!.agentName).toBe('已删除 Agent（wang…）');
    const named = reconcileMetaAgents([], m.decisions.perAgent, id =>
      id === 'wang' ? '王家管家' : undefined,
    );
    expect(named.find(row => row.agentId === 'wang')!.agentName).toBe('王家管家');
  });

  it('R102/R103 (chen-17): responder GT — accept 有支撑=correct、accept 空承=incorrect、reject 无支撑=correct、reject 全支撑=incorrect、部分支撑 accept 合法', () => {
    const svc = (semanticType: string) => ({ name: semanticType, semanticType, origin: 'published' as const });
    const responseFor = (decision: string, requestedCapabilities: string[], myServices: Array<{ name: string; semanticType: string; origin: 'published' }>) =>
      assessment({
        kind: 'collaboration-response',
        decision,
        decisionSource: 'llm',
        collaborationId: 'ac-gt',
        context: {
          capabilities: [],
          partnerServices: [],
          partnerServicesTotal: 0,
          requestedCapabilities,
          myServices,
        },
      });
    const m = aggregateEvalRecords([
      responseFor('accept', ['cooling'], [svc('temperature-control')]), // temperature-control ⊇ cooling → correct
      responseFor('accept', ['fleet-dispatch'], [svc('temperature-control')]), // 空承（零支撑）→ incorrect
      responseFor('reject', ['fleet-dispatch'], [svc('temperature-control')]), // 无可交付 → correct
      responseFor('reject', ['cooling'], [svc('temperature-control')]), // 有可交付却拒绝 → incorrect
      responseFor('cancelled', ['cooling'], [svc('temperature-control')]), // cancelled 非可交付判定 → unlabeled
      // R103 (chen-17 实测形状): 宽愿望清单 + 部分支撑 accept = correct——
      // deliver-what-you-can 是合法应答（该协作履约确实成功）；此前误判
      // incorrect 导致"记录 unknown、汇总 accuracy=0"的矛盾呈现。
      responseFor(
        'accept',
        ['ventilation', 'air-purification', 'emergency-broadcast'],
        [svc('smoke-monitoring'), svc('access-control'), svc('emergency-broadcast')],
      ),
    ], []);
    expect(m.responders.total).toBe(6);
    expect(m.responders.correct).toBe(3);
    expect(m.responders.unlabeled).toBe(1);
    expect(m.responders.accuracy).toBe(0.6);
  });

  it('cancelled 补验证：取消单列（cancelled=1），不重复计入 cancelledByCoordinator；failed 保持 R5-F05 协商失败口径', () => {
    const m = aggregateEvalRecords([
      assessment({ decision: 'initiate_ac', eventId: 'ev-a', agentId: 'agent-1', collaborationId: 'ac-win' }),
      assessment({ decision: 'initiate_ac', eventId: 'ev-b', agentId: 'agent-2', collaborationId: 'ac-lost' }),
      assessment({ kind: 'collaboration-response', decision: 'accept', collaborationId: 'ac-win', eventId: 'ev-a', agentId: 'p1' }),
      assessment({ kind: 'collaboration-response', decision: 'reject', collaborationId: 'ac-lost', eventId: 'ev-b', agentId: 'p2' }),
      assessment({ kind: 'collaboration-response', decision: 'cancelled', collaborationId: 'ac-lost', eventId: 'ev-b', agentId: 'agent-2' }),
    ], []);
    expect(m.handshakes.initiated).toBe(2);
    expect(m.handshakes.succeeded).toBe(1);
    expect(m.handshakes.cancelled).toBe(1); // 全员拒绝后的取消单列可见
    expect(m.handshakes.cancelledByCoordinator).toBe(0); // 无赢家接住 → 非机制取消
    expect(m.handshakes.negotiationSuccessRate).toBe(0.5);
  });
});

/** P5：最小 accept 应答记录（服务面 + 请求能力覆盖 context）。 */
function acceptResponse(
  collaborationId: string,
  context: TrajectoryRecord['context'],
): TrajectoryRecord {
  return assessment({
    kind: 'collaboration-response',
    decision: 'accept',
    decisionSource: 'rule',
    collaborationId,
    context: {
      capabilities: [],
      partnerServices: [],
      partnerServicesTotal: 0,
      ...context,
    },
  });
}

describe('eval-report services 漏斗小节（P5：语义服务协作占比）', () => {
  it('空记录：0 + 率值诚实 null', () => {
    const m = aggregateEvalRecords([], []);
    expect(m.services).toEqual({ semanticCollaborations: 0, rate: null });
  });

  it('accept 命中 aggregate 服务（semanticType 匹配请求能力）记为语义服务协作', () => {
    const m = aggregateEvalRecords([
      acceptResponse('ac-1', {
        capabilities: [],
        partnerServices: [],
        partnerServicesTotal: 0,
        // R53: the aggregate offer's semantic type joins the provider's
        // declared capabilities, so collaborations request it directly.
        requestedCapabilities: ['drainage-control'],
        myServices: [
          { name: '区域排涝调度', semanticType: 'drainage-control', origin: 'aggregate' },
        ],
      }),
    ], []);
    expect(m.services).toEqual({ semanticCollaborations: 1, rate: 1 });
    expect(m.handshakes.succeeded).toBe(1); // 握手口径不受影响
  });

  it('synonym 匹配也算命中（cooling 请求 ↔ temperature-control 服务面）', () => {
    const m = aggregateEvalRecords([
      acceptResponse('ac-1', {
        capabilities: [],
        partnerServices: [],
        partnerServicesTotal: 0,
        requestedCapabilities: ['cooling'],
        myServices: [
          { name: '校园空气环境保障', semanticType: 'temperature-control', origin: 'published' },
        ],
      }),
    ], []);
    expect(m.services.semanticCollaborations).toBe(1);
  });

  it('derived 原点不算语义服务；reject 协作不算；占比分母为已发起协作', () => {
    const m = aggregateEvalRecords([
      acceptResponse('ac-1', {
        capabilities: [],
        partnerServices: [],
        partnerServicesTotal: 0,
        requestedCapabilities: ['cooling'],
        myServices: [{ name: 'HVAC B: 开启', semanticType: 'cooling', origin: 'derived' }],
      }),
      assessment({ kind: 'collaboration-response', decision: 'reject', decisionSource: 'rule', collaborationId: 'ac-2' }),
    ], []);
    expect(m.handshakes.initiated).toBe(2);
    expect(m.services).toEqual({ semanticCollaborations: 0, rate: 0 });
  });

  it('老记录无 requestedCapabilities 时弱口径：只看 origin（aggregate/published）', () => {
    const m = aggregateEvalRecords([
      acceptResponse('ac-1', {
        capabilities: [],
        partnerServices: [],
        partnerServicesTotal: 0,
        myServices: [{ name: '区域排涝调度', semanticType: 'drainage-control', origin: 'aggregate' }],
      }),
      acceptResponse('ac-2', {
        capabilities: [],
        partnerServices: [],
        partnerServicesTotal: 0,
        myServices: [{ name: 'HVAC B: 开启', semanticType: 'cooling', origin: 'derived' }],
      }),
    ], []);
    expect(m.services).toEqual({ semanticCollaborations: 1, rate: 0.5 });
  });
});

describe('FEAT-04: handshakes.succeededUnmetered（接受但无匹配报价）', () => {
  it('可判定 accept 与请求能力零交集 → 计入 unmetered；有支撑的不计', () => {
    const m = aggregateEvalRecords([
      // Zero-backing accept: the responder's face covers nothing requested —
      // the bridge's P5 skip shape (no ephemeral agreement lands).
      acceptResponse('ac-unmetered', {
        capabilities: [], partnerServices: [], partnerServicesTotal: 0,
        requestedCapabilities: ['welding'],
        myServices: [{ name: '制冷服务', semanticType: 'cooling', origin: 'derived' }],
      }),
      // Backed accept: metered normally.
      acceptResponse('ac-metered', {
        capabilities: [], partnerServices: [], partnerServicesTotal: 0,
        requestedCapabilities: ['cooling'],
        myServices: [{ name: '制冷服务', semanticType: 'cooling', origin: 'derived' }],
      }),
    ], []);
    expect(m.handshakes.succeeded).toBe(2);
    expect(m.handshakes.succeededUnmetered).toBe(1);
    // unmetered ⊆ succeeded — failed 口径不变。
    expect(m.handshakes.failed).toBe(m.handshakes.initiated - m.handshakes.succeeded);
  });

  it('context 不全的 legacy accept 不可判定 → 不入桶（诚实缺省）', () => {
    const m = aggregateEvalRecords([
      acceptResponse('ac-legacy-1', {
        capabilities: [], partnerServices: [], partnerServicesTotal: 0,
        // no requestedCapabilities
        myServices: [{ name: '制冷服务', semanticType: 'cooling', origin: 'derived' }],
      }),
      acceptResponse('ac-legacy-2', {
        capabilities: [], partnerServices: [], partnerServicesTotal: 0,
        requestedCapabilities: ['welding'],
        // no myServices face
      }),
    ], []);
    expect(m.handshakes.succeeded).toBe(2);
    expect(m.handshakes.succeededUnmetered).toBe(0);
  });
});

describe('UX-02: effectChecks.failureBreakdown（失败下钻）', () => {
  it('device-execution 失败按 error 分桶并列出可定位痕迹；goalAchieved=false 决策记 goal-unachieved', () => {
    const m = aggregateEvalRecords([
      assessment({
        kind: 'device-execution',
        eventId: 'ev-heat-1',
        agentId: 'agent-1',
        decision: 'failed',
        deviceExecution: { deviceId: 'dev-hvac-1', command: 'set-temperature', success: false, error: 'value out of range' },
      }),
      assessment({
        kind: 'device-execution',
        eventId: 'ev-heat-2',
        agentId: 'agent-2',
        decision: 'failed',
        deviceExecution: { deviceId: 'dev-hvac-2', command: 'turn-on', success: false, error: 'value out of range' },
      }),
      assessment({
        kind: 'device-execution',
        eventId: 'ev-heat-3',
        agentId: 'agent-1',
        decision: 'executed',
        deviceExecution: { deviceId: 'dev-hvac-1', command: 'turn-off', success: true },
      }),
      // 温度回检道的 trajectory 侧痕迹（4 条失败可逐条定位）。
      assessment({ decision: 'handle_independently', goalAchieved: false, eventId: 'ev-recheck-1' }),
      assessment({ decision: 'initiate_ac', goalAchieved: false, eventId: 'ev-recheck-2' }),
      assessment({ decision: 'handle_independently', goalAchieved: true }), // 成功不入桶
    ], []);
    expect(m.effectChecks.attempts).toBe(3);
    expect(m.effectChecks.failures).toBe(2);
    const breakdown = m.effectChecks.failureBreakdown;
    expect(breakdown.byKind).toEqual({ 'device-execution': 2, 'goal-unachieved': 2 });
    expect(breakdown.byCause).toEqual({
      'value out of range': 2,
      'goal not achieved (world-feedback recheck settled false)': 2,
    });
    expect(breakdown.records).toHaveLength(4);
    const deviceRecord = breakdown.records.find(r => r.kind === 'device-execution');
    expect(deviceRecord).toMatchObject({
      eventId: 'ev-heat-1', agentId: 'agent-1', deviceId: 'dev-hvac-1',
      command: 'set-temperature', error: 'value out of range',
    });
    const goalRecords = breakdown.records.filter(r => r.kind === 'goal-unachieved');
    expect(goalRecords.map(r => ('eventId' in r ? r.eventId : '')).sort()).toEqual(['ev-recheck-1', 'ev-recheck-2']);
  });

  it('无失败：空桶 + 空列表（诚实零态）', () => {
    const m = aggregateEvalRecords([], []);
    expect(m.effectChecks.failureBreakdown).toEqual({
      byKind: { 'device-execution': 0, 'goal-unachieved': 0 },
      byCause: {},
      records: [],
    });
  });
});

// ============================================================================
// R2 T4/T5（Lane B）：eval 口径回归锚点 + 握手失败归因
// T4 = u1-F3 / u4-F1 / u1-F6（ec1980a2 + d7b3988a 的复核锚点）；
// T5 = u1-F4 / B1-4（failures.byCause，只用已落账 trajectory 记录）。
// ============================================================================

describe('R2 T4: eval 口径自洽锚点（ec1980a2/d7b3988a 复核）', () => {
  it('u4-F1：accuracy 只由 labeled 组成——1 labeled + 1 unknown → dc=2 / ev=1 / accuracy=1（不是 50%）', () => {
    const m = aggregateEvalRecords([
      assessment({
        agentId: 'a-good',
        decision: 'handle_independently',
        groundTruth: { correctDecision: 'handle_independently', interactionType: 'x' },
        correct: true,
      }),
      assessment({ agentId: 'a-good', decision: 'handle_independently' }), // unknown → unlabeled
    ], []);
    expect(m.decisions.total).toBe(2);
    expect(m.decisions.unlabeled).toBe(1);
    // 分母只有 labeled：1/1 = 100%，未对账决策绝不进分母。
    expect(m.decisions.accuracy).toBe(1);
    // T29：registry 行保持全历史（不被覆盖）；本窗口数在 windowDecisionCount。
    const reconciled = reconcileMetaAgents(
      [{ agentId: 'a-good', decisionCount: 9, evaluatedDecisions: 9, successRate: 0 } as never],
      m.decisions.perAgent,
    );
    expect(reconciled[0]).toMatchObject({
      decisionCount: 9,
      evaluatedDecisions: 9,
      successRate: 0,
      window: 'all-history',
      windowDecisionCount: 2,
    });
  });

  it('u1-F3：0/2 evaluated → accuracy 诚实 null（人读渲染为 —，不是 100%）', () => {
    const m = aggregateEvalRecords([
      assessment({ agentId: 'g-keeper', decision: 'handle_independently' }),
      assessment({ agentId: 'g-keeper', decision: 'initiate_ac' }),
    ], []);
    expect(m.decisions.total).toBe(2);
    expect(m.decisions.unlabeled).toBe(2);
    expect(m.decisions.accuracy).toBeNull();
    expect(m.decisions.perAgent[0]).toMatchObject({
      agentId: 'g-keeper',
      total: 2,
      unlabeled: 2,
      accuracy: null,
    });
    const reconciled = reconcileMetaAgents([], m.decisions.perAgent);
    expect(reconciled[0]).toMatchObject({ decisionCount: 2, evaluatedDecisions: 0, successRate: null });
    // 人读面的锚点：renderEvalReportHuman 对 null 渲染 '—'（apps/cli/src/test/
    // sim-eval.render.vitest.test.ts 的 pct(null) 用例），此处锚定数据面永不
    // 产出可被读成 100% 的非 null 值。
  });

  it('u1-F6：reputation（全历史计量）与 handshakes（本报告窗口）的口径注释随报告下发', () => {
    const m = aggregateEvalRecords([], [
      { agentId: 'a', capability: 'cooling', attempts: 4, successes: 4, failures: 0 },
    ]);
    expect(m.reputation.totals).toEqual({ attempts: 4, successes: 4, partial: 0, failures: 0 });
    expect(m.handshakes.succeeded).toBe(0); // 同一时刻两个数字可以不等——口径不同源
    const methodology = m.methodology.join(' ');
    expect(methodology).toContain('reputation:');
    expect(methodology).toContain('全历史');
    expect(methodology).toContain('不可直接相加');
  });

  // T71 (R8, u1-F3): the count faces are integer EVENT buckets — a partial
  // outcome owns its bucket and never leaks a 0.5 into ok/failed, and the
  // buckets always add up to attempts.
  it('T71：partial 事件单列整数桶，ok+partial+failed=attempts（权重和仍是分数的事）', () => {
    const m = aggregateEvalRecords([], [
      // Tracker v2 record: 2 success + 1 partial + 1 failure events, weight
      // sums 2.5/1.5 (the old face would have shown 2.5 ok / 1.5 failed).
      {
        agentId: 'a', capability: 'cooling', attempts: 4, successes: 2.5, failures: 1.5,
        successEvents: 2, partialEvents: 1, failureEvents: 1,
      },
      // Legacy row without buckets: integer weight sums reconstruct exactly.
      // (Non-temperature capability — the effectChecks slice stays agent a's.)
      { agentId: 'b', capability: 'air-quality', attempts: 3, successes: 1, failures: 2 },
    ]);
    expect(m.effectChecks).toMatchObject({ attempts: 4, successes: 2, partial: 1, failures: 1 });
    // passRate = successes/attempts — partial is NOT a numerator fraction.
    expect(m.effectChecks.passRate).toBeCloseTo(2 / 4, 10);
    // Integer ok+partial+failed === attempts (u1-F3's 加不拢 is closed).
    expect(m.effectChecks.successes + m.effectChecks.partial + m.effectChecks.failures)
      .toBe(m.effectChecks.attempts);
    // Per-agent reputation totals carry the same integer buckets.
    expect(m.reputation.agents).toHaveLength(2);
    expect(m.reputation.agents[0]).toMatchObject({ agentId: 'a', attempts: 4, successes: 2, partial: 1, failures: 1 });
    expect(m.reputation.totals).toEqual({ attempts: 7, successes: 3, partial: 1, failures: 3 });
  });
});

describe('R2 T5: 握手失败归因 failures.byCause（u1-F4 / B1-4）', () => {
  /** 带一个可发现伙伴的发起记录（shortlist 非空）。 */
  const initiateWithPartner = (overrides: Partial<TrajectoryRecord>): TrajectoryRecord =>
    assessment({
      decision: 'initiate_ac',
      context: {
        capabilities: [],
        partnerServices: [{ serviceName: 'svc', capabilities: ['x'], providerAgentId: 'p' }],
        partnerServicesTotal: 1,
      },
      ...overrides,
    });

  it('u1-F4 形态：四类失败各就其位，byCause 合计 = failed，succeeded + failed = initiated', () => {
    const m = aggregateEvalRecords([
      // no-partner：shortlist 空、无任何响应记录（20 次没进应答环节的典型）。
      assessment({ eventId: 'ev-np', agentId: 'init-1', decision: 'initiate_ac' }),
      // abandoned-before-response：有伙伴、组内只有发起方的 rule 取消。
      initiateWithPartner({ eventId: 'ev-ab', agentId: 'init-2', collaborationId: 'ac-ab' }),
      assessment({ kind: 'collaboration-response', eventId: 'ev-ab', agentId: 'init-2', collaborationId: 'ac-ab', decision: 'cancelled', decisionSource: 'rule' }),
      // all-rejected：组内有 reject、无 accept。
      initiateWithPartner({ eventId: 'ev-ar', agentId: 'init-3', collaborationId: 'ac-ar' }),
      assessment({ kind: 'collaboration-response', eventId: 'ev-ar', agentId: 'p1', collaborationId: 'ac-ar', decision: 'reject', decisionSource: 'llm' }),
      assessment({ kind: 'collaboration-response', eventId: 'ev-ar', agentId: 'p2', collaborationId: 'ac-ar', decision: 'reject', decisionSource: 'rule' }),
      // timeout：取消记录显式带协调器的 decisionSource='timeout' 标记。
      initiateWithPartner({ eventId: 'ev-to', agentId: 'init-4', collaborationId: 'ac-to' }),
      assessment({ kind: 'collaboration-response', eventId: 'ev-to', agentId: 'init-4', collaborationId: 'ac-to', decision: 'cancelled', decisionSource: 'timeout' }),
    ], []);
    expect(m.handshakes.initiated).toBe(4);
    expect(m.handshakes.succeeded).toBe(0);
    expect(m.handshakes.failed).toBe(4);
    expect(m.handshakes.failures.total).toBe(4);
    expect(m.handshakes.failures.byCause).toEqual({
      'no-partner': 1,
      'abandoned-before-response': 1,
      'all-rejected': 1,
      timeout: 1,
      superseded: 0,
      aborted: 0,
      pendingAtSampling: 0,
    });
    // 等式保持：byCause 合计 = failed，succeeded + failed = initiated。
    const byCauseSum = Object.values(m.handshakes.failures.byCause).reduce((s, n) => s + n, 0);
    expect(byCauseSum).toBe(m.handshakes.failed);
    expect(m.handshakes.succeeded + m.handshakes.failed).toBe(m.handshakes.initiated);
  });

  it('superseded：同事件第二次发起被已 accept 的握手去重（机制性失败单列）', () => {
    const m = aggregateEvalRecords([
      initiateWithPartner({ eventId: 'ev-su', agentId: 'init-5', collaborationId: 'ac-su' }),
      // 去重发起：同事件、无自己的组。
      assessment({ eventId: 'ev-su', agentId: 'init-6', decision: 'initiate_ac' }),
      assessment({ kind: 'collaboration-response', eventId: 'ev-su', agentId: 'p2', collaborationId: 'ac-su', decision: 'accept', decisionSource: 'rule' }),
    ], []);
    expect(m.handshakes.initiated).toBe(2);
    expect(m.handshakes.succeeded).toBe(1);
    expect(m.handshakes.failed).toBe(1);
    expect(m.handshakes.cancelledByCoordinator).toBe(1);
    expect(m.handshakes.failures).toEqual({
      total: 1,
      byCause: { 'no-partner': 0, 'abandoned-before-response': 0, 'all-rejected': 0, timeout: 0, superseded: 1, aborted: 0, pendingAtSampling: 0 },
    });
  });

  it('空记录：failures 全零诚实空态；methodology 带归因口径行', () => {
    const m = aggregateEvalRecords([], []);
    expect(m.handshakes.failures).toEqual({
      total: 0,
      byCause: { 'no-partner': 0, 'abandoned-before-response': 0, 'all-rejected': 0, timeout: 0, superseded: 0, aborted: 0, pendingAtSampling: 0 },
    });
    const methodology = m.methodology.join(' ');
    expect(methodology).toContain('handshakes.failures');
    expect(methodology).toContain('no-partner');
    expect(methodology).toContain('superseded');
  });

  it('取消但无超时标记且无 reject → abandoned-before-response（不冒充 timeout）', () => {
    const m = aggregateEvalRecords([
      initiateWithPartner({ eventId: 'ev-amb', agentId: 'init-7', collaborationId: 'ac-amb' }),
      assessment({ kind: 'collaboration-response', eventId: 'ev-amb', agentId: 'init-7', collaborationId: 'ac-amb', decision: 'cancelled', decisionSource: 'rule' }),
    ], []);
    expect(m.handshakes.failures.byCause).toMatchObject({ 'abandoned-before-response': 1, timeout: 0 });
  });

  it('BUG-07：runtime 消亡取消（decisionSource aborted）归 aborted 桶，不混进 abandoned', () => {
    const m = aggregateEvalRecords([
      initiateWithPartner({ eventId: 'ev-rb', agentId: 'init-8', collaborationId: 'ac-rb' }),
      assessment({
        kind: 'collaboration-response', eventId: 'ev-rb', agentId: 'init-8', collaborationId: 'ac-rb',
        decision: 'cancelled', decisionSource: 'aborted', reasoning: 'runtime-rebuild',
      }),
    ], []);
    expect(m.handshakes.failures.byCause).toMatchObject({
      aborted: 1,
      'abandoned-before-response': 0,
      timeout: 0,
      pendingAtSampling: 0,
    });
    // 不变式保持：byCause 合计 = failed。
    const byCauseSum = Object.values(m.handshakes.failures.byCause).reduce((s, n) => s + n, 0);
    expect(byCauseSum).toBe(m.handshakes.failed);
  });

  it('BUG-07：采样时窗口未闭合的无结论握手计 pendingAtSampling，窗口已闭合计 abandoned', () => {
    const now = Date.now();
    const open = new Date(now - 30_000).toISOString(); // 30s 前发起（窗内）
    const closed = new Date(now - 300_000).toISOString(); // 5 分钟前发起（窗外）
    const m = aggregateEvalRecords([
      // 窗内：只有 counter/defer 的未决谈判（组内无任何结论记录）。
      initiateWithPartner({ eventId: 'ev-open', agentId: 'init-9', collaborationId: 'ac-open', recordedAt: open }),
      assessment({ kind: 'collaboration-response', eventId: 'ev-open', agentId: 'p1', collaborationId: 'ac-open', decision: 'defer', decisionSource: 'llm', recordedAt: open }),
      // 窗外：同样无结论 → 真·abandoned。
      initiateWithPartner({ eventId: 'ev-closed', agentId: 'init-10', collaborationId: 'ac-closed', recordedAt: closed }),
      assessment({ kind: 'collaboration-response', eventId: 'ev-closed', agentId: 'p2', collaborationId: 'ac-closed', decision: 'counter', decisionSource: 'llm', recordedAt: closed }),
      // 窗内、连组都没有的发起（零应答记录）→ pendingAtSampling（走 extras 道）。
      initiateWithPartner({ eventId: 'ev-lone', agentId: 'init-11', recordedAt: open }),
    ], []);
    expect(m.handshakes.failures.byCause).toMatchObject({
      pendingAtSampling: 2,
      'abandoned-before-response': 1,
    });
    const byCauseSum = Object.values(m.handshakes.failures.byCause).reduce((s, n) => s + n, 0);
    expect(byCauseSum).toBe(m.handshakes.failed);
    expect(m.handshakes.succeeded + m.handshakes.failed).toBe(m.handshakes.initiated);
  });
});
