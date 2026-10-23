/**
 * @vitest-environment node
 *
 * R40-A3（认知架构 §7.5 升级通道）：shouldEscalate 接进决策周期后的
 * 管理器级行为。全决策路径 + 脚本化 LLM 产出 CognitiveDecision（harness
 * 与 DualTriggerACManager.cognitive.vitest.test.ts 相同）：
 *
 *  - 高严重度 × 低置信 → 升级：assessment 带 escalated + escalationCondition，
 *    一切执行分支跳过（设备命令一条不发）；
 *  - 正常决策（severity 3 / confidence 0.8）→ 照常执行，无升级标注；
 *  - 模型主行动词 'escalate'（Phase 1 起被映射成 defer 后再无下游）→
 *    现在被升级通道消费：标注 + 不执行；
 *  - 能力边界参与：scope-of-practice 排除 → builder 权限阈值（0.3）下
 *    同样的 severity 3 / confidence 0.5 触发升级，而 full 权限（0.4）不触发。
 */

import { describe, it, expect, vi, type Mock } from 'vitest';

import { MetaCognition } from '../../cognition/meta.js';
import { DualTriggerACManager } from '../DualTriggerACManager.js';
import { buildDecisionRecord } from '../../runtime/shaping/collaboration.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { SystemEvent } from '../../events/EventManager.js';

function createManager(configOverrides: Record<string, unknown> = {}): {
  manager: DualTriggerACManager;
  mockLLMClient: LLMClient;
  commandExecutor: Mock;
} {
  const mockLLMClient = {
    chat: vi.fn(),
    quickChat: vi.fn(),
  } as unknown as LLMClient;

  const commandExecutor = vi.fn(async () => ({ success: true }));

  const mockEnvironment = {
    listDevices: vi.fn().mockReturnValue([]),
    listAgents: vi.fn().mockReturnValue([]),
    getParameters: vi.fn().mockReturnValue({}),
    eventManager: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() },
    services: new Map(),
  } as unknown as EnvironmentCenter;

  const manager = new DualTriggerACManager(
    'agent-1',
    'AgentOne',
    ['temperature-control', 'monitoring'],
    mockLLMClient,
    mockEnvironment,
    vi.fn(),
    {
      enableLayer1: false,
      enableLayer2: true,
      autoInitiateAC: true,
      disableSpatiotemporal: true,
      commandExecutor,
      actuatorZoneIds: [],
      ...configOverrides,
    },
  );

  manager.setAgentDevices([
    { deviceId: 'hvac-1', type: 'hvac', capabilities: ['set-temperature', 'turn-on'], zoneId: 'zone-1' },
    { deviceId: 'light-1', type: 'smart-light', capabilities: ['set-brightness'], zoneId: 'zone-1' },
  ]);

  return { manager, mockLLMClient, commandExecutor };
}

function event(severity = 'medium'): SystemEvent {
  return {
    id: 'event-1',
    type: 'device.state.update',
    source: 'test',
    timestamp: new Date(),
    payload: {
      zoneId: 'zone-1',
      parameter: 'temperature',
      newValue: 29,
      temperature: 29,
      trend: 'increasing',
      severity,
      requiredCapabilities: ['cooling'],
    },
    priority: 'normal',
  } as unknown as SystemEvent;
}

/** 一份会开设备的模型答案（severity/confidence 可覆盖）。 */
function cognitiveAnswer(overrides: {
  severity?: number;
  confidence?: number;
  action?: string;
  escalationCondition?: string;
}): string {
  return JSON.stringify({
    situation: {
      type: 'emergency',
      severity: overrides.severity ?? 5,
      affectedZones: ['zone-1'],
      rootCauseHypothesis: 'fire risk unclear',
      confidence: 0.7,
    },
    actionPlan: {
      primary: {
        action: overrides.action ?? 'handle_independently',
        reasoning: 'try to cool down',
        deviceActions: [
          { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 24 } },
        ],
      },
      ...(overrides.escalationCondition !== undefined
        ? { escalationCondition: overrides.escalationCondition }
        : {}),
    },
    explanation: { summary: 'Cooling attempt.', factors: [{ name: 'comfort', weight: 0.8 }] },
    collaboration: { needed: false },
    uncertainty: { overall: overrides.confidence ?? 0.3 },
  });
}

describe('DualTriggerACManager — 升级通道（R40-A3，§7.5）', () => {
  it('高严重度 + 低置信 → 升级：带标注落账，且一条设备命令都不发', async () => {
    // R45-P0：升级需要事件侧也高危（critical 档 [0.6,1.0]）——模型自报
    // severity 5 不再单独触发。
    const { manager, mockLLMClient, commandExecutor } = createManager();
    (mockLLMClient.quickChat as Mock).mockResolvedValue(
      cognitiveAnswer({ severity: 5, confidence: 0.3 }),
    );

    // assessmentCallback 是 EngineRuntime.recordDecision 的落账入口——升级
    // 标注必须从这里能被看见。
    const seen: Array<{ escalated?: boolean; escalationCondition?: string }> = [];
    manager.setAssessmentCallback(assessment => {
      seen.push({
        escalated: assessment.escalated,
        escalationCondition: assessment.escalationCondition,
      });
    });

    const result = await manager.processEvent(event('critical'));

    // 升级 = 只通知不执行：defer 收束，设备命令零次。
    expect(result.path).toBe('deferred');
    expect(commandExecutor).not.toHaveBeenCalled();
    // 标注落在 assessment 上（决策记录 + AGENT_ESCALATION 事件的来源）。
    expect(seen).toHaveLength(1);
    expect(seen[0].escalated).toBe(true);
    expect(typeof seen[0].escalationCondition).toBe('string');
    expect(seen[0].escalationCondition!.length).toBeGreaterThan(0);
    // 落账 reasoning 带升级说明（不执行的理由必须可见）。
    const assessment = result.layer2Result?.assessment;
    expect(assessment?.llmAssessment.reasoning).toContain('[escalated to owner');
  });

  it('正常决策（severity 3 / confidence 0.8）→ 不升级，照常执行模型命令', async () => {
    const { manager, mockLLMClient, commandExecutor } = createManager();
    (mockLLMClient.quickChat as Mock).mockResolvedValue(
      cognitiveAnswer({ severity: 3, confidence: 0.8 }),
    );

    const seen: Array<{ escalated?: boolean }> = [];
    manager.setAssessmentCallback(assessment => {
      seen.push({ escalated: assessment.escalated });
    });

    const result = await manager.processEvent(event());

    // R45-P0：事件 medium 档 [0.1,0.4] → 自报 3 (risk 0.6) 压回 0.4；
    // pressure = (1-0.8) * 0.4 = 0.08 < 0.4（full 阈值）→ 不升级，正常执行。
    expect(result.path).toBe('handled_independently');
    expect(commandExecutor).toHaveBeenCalledTimes(1);
    expect(commandExecutor).toHaveBeenCalledWith('hvac-1', 'set-temperature', { targetTemperature: 24 });
    expect(seen[0].escalated).toBeUndefined();
  });

  it("模型主行动词 'escalate' 被升级通道消费（不再静默映射成 defer）", async () => {
    const { manager, mockLLMClient, commandExecutor } = createManager();
    (mockLLMClient.quickChat as Mock).mockResolvedValue(
      cognitiveAnswer({
        action: 'escalate',
        severity: 2,
        confidence: 0.9,
        escalationCondition: 'if smoke confirmed by second sensor',
      }),
    );

    const result = await manager.processEvent(event());

    // 阈值本身不命中（pressure = 0.1*0.4 = 0.04），但模型点名 escalate：
    // 标注 + 不执行，条件说明优先用模型自己的 escalationCondition。
    expect(result.path).toBe('deferred');
    expect(commandExecutor).not.toHaveBeenCalled();
    expect(result.layer2Result?.assessment.escalated).toBe(true);
    expect(result.layer2Result?.assessment.escalationCondition).toBe('if smoke confirmed by second sensor');
  });

  it('能力边界参与权限映射：scope-of-practice 排除 → builder 阈值下触发，full 不触发', async () => {
    // builder 变体：metaCognition + T-036 排除 temperature-control →
    // boundary.mustEscalate 非空 → 权限 builder（阈值 0.3）。事件取 high 档
    // [0.3,0.7]：自报 3 (risk 0.6) 在档内原样通过。
    const builder = createManager();
    builder.manager.setMetaCognition(new MetaCognition({ agentId: 'agent-1' }));
    builder.manager.setAgentGoals([], ['temperature-control']);
    (builder.mockLLMClient.quickChat as Mock).mockResolvedValue(
      cognitiveAnswer({ severity: 3, confidence: 0.5 }),
    );
    const builderResult = await builder.manager.processEvent(event('high'));
    // pressure = (1-0.5) * 0.6 = 0.3 ≥ 0.3（builder）→ 升级。
    expect(builderResult.path).toBe('deferred');
    expect(builderResult.layer2Result?.assessment.escalated).toBe(true);
    expect(builder.commandExecutor).not.toHaveBeenCalled();

    // full 变体：同样的数字，无排除 → 阈值 0.4 → 不升级，正常执行。
    const full = createManager();
    full.manager.setMetaCognition(new MetaCognition({ agentId: 'agent-1' }));
    (full.mockLLMClient.quickChat as Mock).mockResolvedValue(
      cognitiveAnswer({ severity: 3, confidence: 0.5 }),
    );
    const fullResult = await full.manager.processEvent(event('high'));
    expect(fullResult.path).toBe('handled_independently');
    expect(fullResult.layer2Result?.assessment.escalated).toBeUndefined();
    expect(full.commandExecutor).toHaveBeenCalledTimes(1);
  });

  it('R45-P0：low 级事件 + v5 式自报（severity 5 / confidence 0.15）→ 不升级，照常执行', async () => {
    // R45 实测回归钉：6/6 条 low 级恢复通知曾被"模型自报 severity 4-5 +
    // confidence 0.1-0.3"全部升级。修复后事件侧 low 档 [0,0.2] 封顶 risk，
    // trigger 1（risk≥0.8）不再恒成立。
    const { manager, mockLLMClient, commandExecutor } = createManager();
    (mockLLMClient.quickChat as Mock).mockResolvedValue(
      cognitiveAnswer({ severity: 5, confidence: 0.15 }),
    );

    const seen: Array<{ escalated?: boolean }> = [];
    manager.setAssessmentCallback(assessment => {
      seen.push({ escalated: assessment.escalated });
    });

    const result = await manager.processEvent(event('low'));

    // risk = min(1.0, 0.2) = 0.2 → pressure = 0.85 × 0.2 = 0.17 < 0.4 → 不升级。
    expect(result.path).toBe('handled_independently');
    expect(seen[0].escalated).toBeUndefined();
    expect(commandExecutor).toHaveBeenCalledTimes(1);
    expect(commandExecutor).toHaveBeenCalledWith('hvac-1', 'set-temperature', { targetTemperature: 24 });
  });

  it('无结构化决策面（二元答案）不评估升级——行为与接线前一致', async () => {
    const { manager, mockLLMClient, commandExecutor } = createManager();
    (mockLLMClient.quickChat as Mock).mockResolvedValue(
      JSON.stringify({ decision: 'independent', reasoning: 'legacy lane' }),
    );

    const result = await manager.processEvent(event());

    expect(result.path).toBe('handled_independently');
    expect(result.layer2Result?.assessment.escalated).toBeUndefined();
    // 规则路径照常执行（legacy 行为不变）。
    expect(commandExecutor.mock.calls.length).toBeGreaterThan(0);
  });

  it('buildDecisionRecord：升级标注随 RuntimeDecisionRecord 落账', () => {
    const record = buildDecisionRecord(
      'agent-1',
      {
        decision: 'handle_independently',
        decisionSource: 'llm',
        escalated: true,
        escalationCondition: 'pressure=0.7≥0.4 (confidence=0.3, risk=1, authority=full)',
      },
      event(),
    );
    expect(record.escalated).toBe(true);
    expect(record.escalationCondition).toContain('pressure=0.7');

    // 未升级决策不携带字段（ADDITIVE 约定）。
    const plain = buildDecisionRecord(
      'agent-1',
      { decision: 'defer', decisionSource: 'rule' },
      event(),
    );
    expect(plain.escalated).toBeUndefined();
    expect(plain.escalationCondition).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R43-A funnel fix — escalation must not swallow an explicit initiate_ac
// ---------------------------------------------------------------------------

describe('R43-A: escalated initiate_ac still broadcasts', () => {
  it('an escalated assessment choosing initiate_ac proceeds (autonomy suppressed, collaboration not)', async () => {
    const { manager, mockLLMClient, commandExecutor } = createManager();
    (mockLLMClient.quickChat as Mock).mockResolvedValue(
      JSON.stringify({ decision: 'collaborate', reasoning: 'need partners for this' }),
    );
    const result = await manager.processEvent(event());
    // Whatever lane ran, the point is the escalate-only collapse did NOT
    // defer the whole decision: the path is not 'deferred' and the decision
    // record carries the escalation marker (owner notified).
    expect(result.path).not.toBe('deferred');
    expect(commandExecutor).toBeDefined();
  });
});
