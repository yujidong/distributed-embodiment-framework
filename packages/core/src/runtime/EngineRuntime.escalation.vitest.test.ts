/**
 * @vitest-environment node
 *
 * R40-A3（认知架构 §7.5 升级通道）运行时接线：升级决策 →
 *  - 决策记录（snapshot.recentDecisions / trajectory JSONL）带 escalated
 *    + escalationCondition；
 *  - 世界事件流发布 AGENT_ESCALATION（payload 只携带说明数据）；
 *  - 安全语义：什么都不执行——被点名的设备命令一条不发（hvac 保持关机）。
 *
 * 场景与 EngineRuntime.vitest.test.ts 相同（双 zone：zone-b 的 actuator
 * agent 拥有 hvac-b）；Mock LLM 的脚本化答案让 preCheck 落到 LLM 路径
 * （T-014 同款配方：agent 无法满足的 requiredCapabilities）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMClient } from '@active-collaboration/llm-integration';
import { EventType, type SystemEvent } from '../events/index.js';
import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime, type EngineRuntimeOptions } from './index.js';

class ScriptedLLMClient {
  static readonly MODEL = 'scripted-model';
  constructor(private readonly answer: string) {}

  getProviderName(): string {
    return 'scripted';
  }

  getModel(): string {
    return ScriptedLLMClient.MODEL;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  setLoggingCallback(_callback: unknown): void {
    // trajectory 的 LLM 调用日志钩子（assembleLlmLogging 会调用）——本测试
    // 不消费，留空实现。
  }

  setContextProvider(_provider: unknown): void {
    // 同上：trajectory 归因钩子，留空实现。
  }

  async quickChat(): Promise<{ content: string; model: string; usage: Record<string, number> }> {
    return {
      content: this.answer,
      model: ScriptedLLMClient.MODEL,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }

  async chat(params: { messages: Array<{ role: string; content: string }> }) {
    return this.quickChat();
  }
}

function twoZoneScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'escalation-test', name: 'Escalation Test Scenario' },
    zones: [
      { id: 'zone-a', name: 'Zone A', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', name: 'Zone B', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      { id: 'temp-sensor-a', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: 'zone-a' },
      { id: 'hvac-b', type: 'hvac', capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], zoneId: 'zone-b' },
    ],
    agents: [
      {
        id: 'sensor-agent',
        name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
      },
      {
        id: 'actuator-agent',
        name: 'Actuator Agent',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-b'],
        boundDeviceIds: ['hvac-b'],
      },
    ],
    events: [],
  });
}

const runtimes: EngineRuntime[] = [];
const tempDirs: string[] = [];

function makeRuntime(llmAnswer: string): { runtime: EngineRuntime; escalations: SystemEvent[] } {
  const trajectoryDir = mkdtempSync(join(tmpdir(), 'engine-escalation-test-'));
  tempDirs.push(trajectoryDir);
  const escalations: SystemEvent[] = [];
  const runtime = new EngineRuntime(twoZoneScenario(), {
    llmClient: new ScriptedLLMClient(llmAnswer) as unknown as LLMClient,
    trajectoryDir,
    autoInitiateAC: false, // decision-level：不跑 AC 执行
  } satisfies EngineRuntimeOptions);
  runtime.subscribe(event => escalations.push(event), EventType.AGENT_ESCALATION);
  runtimes.push(runtime);
  return { runtime, escalations };
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** 让 actuator-agent 落到 LLM 路径的事件（T-014 配方：能力缺口）。 */
function zoneBFireRiskEvent() {
  return {
    type: 'temperature-spike',
    zoneId: 'zone-b',
    parameter: 'temperature',
    value: 46,
    severity: 'high' as const,
    requiredCapabilities: ['fire-suppression'],
  };
}

function cognitiveAnswer(options: { severity: number; confidence: number; action?: string }): string {
  return JSON.stringify({
    situation: { type: 'emergency', severity: options.severity, affectedZones: ['zone-b'], confidence: 0.7 },
    actionPlan: {
      primary: {
        action: options.action ?? 'handle_independently',
        reasoning: 'try the hvac',
        deviceActions: [{ deviceId: 'hvac-b', command: 'turn-on' }],
      },
    },
    explanation: { summary: 'Cooling attempt.', factors: [] },
    collaboration: { needed: false },
    uncertainty: { overall: options.confidence },
  });
}

describe('EngineRuntime — 升级通道（R40-A3，§7.5）', () => {
  it('高严重度 + 低置信：决策记录带 escalated，AGENT_ESCALATION 上总线，零设备命令', async () => {
    const { runtime, escalations } = makeRuntime(cognitiveAnswer({ severity: 5, confidence: 0.3 }));

    const result = await runtime.injectEvent(zoneBFireRiskEvent());

    // 决策记录：escalated + escalationCondition 落 snapshot。
    const decision = runtime.getSnapshot().recentDecisions
      .find(d => d.eventId === result.eventId && d.agentId === 'actuator-agent');
    expect(decision).toBeDefined();
    expect(decision!.decisionSource).toBe('llm');
    expect(decision!.escalated).toBe(true);
    expect(typeof decision!.escalationCondition).toBe('string');
    expect(decision!.escalationCondition!.length).toBeGreaterThan(0);

    // 世界事件流：AGENT_ESCALATION 发布，payload 只携带说明数据。
    expect(escalations).toHaveLength(1);
    expect(escalations[0].type).toBe(EventType.AGENT_ESCALATION);
    expect(escalations[0].payload).toMatchObject({
      agentId: 'actuator-agent',
      eventId: result.eventId,
      // T-041：声明了 agent 不具备的 requiredCapabilities 时，independent
      // 答案被降级为 defer——升级叠加在其上，决策词是派生的 defer。
      decision: 'defer',
      severity: 5,
      confidence: 0.3,
      zoneId: 'zone-b',
    });
    expect(typeof escalations[0].payload.reason).toBe('string');

    // 安全语义：模型点名的 hvac-b turn-on 一条没发（保持关机）。
    const hvac = runtime.getSnapshot().devices.find(d => d.id === 'hvac-b');
    expect(hvac?.state.power).not.toBe(true);

    // Trajectory JSONL 同步带升级标注（checkpoint/训练面）。
    const trajectoryPath = runtime.getTrajectoryFilePath()!;
    const lines = readFileSync(trajectoryPath, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line));
    const record = lines.find(
      (l: { eventId?: string; agentId?: string }) =>
        l.eventId === result.eventId && l.agentId === 'actuator-agent',
    );
    expect(record).toBeDefined();
    expect(record.escalated).toBe(true);
    expect(typeof record.escalationCondition).toBe('string');
  });

  it('正常决策：不升级、不发布事件（模型答案不触发阈值）', async () => {
    const { runtime, escalations } = makeRuntime(cognitiveAnswer({ severity: 2, confidence: 0.9 }));

    const result = await runtime.injectEvent(zoneBFireRiskEvent());

    const decision = runtime.getSnapshot().recentDecisions
      .find(d => d.eventId === result.eventId && d.agentId === 'actuator-agent');
    expect(decision).toBeDefined();
    expect(decision!.decisionSource).toBe('llm');
    expect(decision!.escalated).toBeUndefined();
    expect(decision!.escalationCondition).toBeUndefined();
    // pressure = (1-0.9)*0.4 = 0.04 << 0.4：无升级事件上总线。
    expect(escalations).toHaveLength(0);
  });
});
