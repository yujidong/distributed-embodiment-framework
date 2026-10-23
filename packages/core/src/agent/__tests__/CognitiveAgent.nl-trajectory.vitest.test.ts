/**
 * @vitest-environment node
 *
 * NL 意图道 trajectory 埋点集成测试（训练数据缺口修复）。
 *
 * 按 EngineRuntime 的装配方式接线：真实 LLMClient 指向测试内的本地
 * OpenAI 兼容 HTTP 服务（不 mock 模块，vitest externalize 会绕过
 * vi.mock——用真实 socket 换取确定性）；client 的 logging callback →
 * TrajectoryRecorder.recordLLMCall；agent 的 NLInteractionListener →
 * recorder.recordNLInteraction。断言一次 processNaturalLanguageCommand /
 * answerNaturalLanguageQuestion 产出带 prompt/rawResponse/解析结果的
 * 'nl-interaction' 记录（T-022 精神：NL 道的 LLM 调用与决策道同口径
 * 可观测、可归因）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LLMClient } from '@active-collaboration/llm-integration';
import { CognitiveAgent } from '../CognitiveAgent.js';
import { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import { TrajectoryRecorder, type TrajectoryRecord } from '../../trajectory/index.js';
import type { Device, DeviceType } from '@active-collaboration/shared';
import type { EnvironmentCenterData } from '../../environment/types.js';

const MODEL = 'test-nl-model';

const HVAC_DEVICE: Device = {
  id: 'hvac-lobby-1',
  name: 'Lobby HVAC',
  type: 'hvac' as DeviceType,
  capabilities: [
    { name: 'set-temperature', type: 'write' as const, parameters: [] },
    { name: 'temperature-sensing', type: 'read' as const, parameters: [] },
  ],
  location: 'lobby',
  currentState: { targetTemperature: 26 },
} as unknown as Device;

const INTENT_ANSWER = JSON.stringify({
  action: 'set_parameter',
  targetParameters: { temperature: 22 },
});

const DECISION_ANSWER = JSON.stringify({
  situation: { type: 'normal', severity: 1, affectedZones: ['lobby'], rootCauseHypothesis: '', confidence: 0.8 },
  goals: [],
  actionPlan: {
    primary: {
      action: 'handle_independently',
      reasoning: 'operator asked for cooling',
      deviceActions: [
        { deviceId: 'hvac-lobby-1', command: 'set-temperature', params: { targetTemperature: 22 } },
      ],
    },
  },
  explanation: { summary: 'Cooled the lobby.', factors: [] },
  collaboration: { needed: false },
  uncertainty: { overall: 0.8 },
});

/** 本地 OpenAI 兼容后端：意图解析 prompt 以 INTENT: 收尾，其余按决策应答。 */
function startBackend(): Promise<{ server: Server; baseURL: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(body);
      let user = '';
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ content: string }> };
        user = parsed.messages?.[parsed.messages.length - 1]?.content ?? '';
      } catch {
        // 非 JSON 请求体按决策道应答（防御，实际不会发生）
      }
      const content = user.trimEnd().endsWith('INTENT:') ? INTENT_ANSWER : DECISION_ANSWER;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1704067200,
        model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${port}/v1`, requests });
    });
  });
}

const tempDirs: string[] = [];

function makeRecorder(): TrajectoryRecorder {
  const dir = mkdtempSync(join(tmpdir(), 'nl-trajectory-test-'));
  tempDirs.push(dir);
  return new TrajectoryRecorder({
    outputDir: dir,
    condition: 'test',
    scenario: 'unit',
    iteration: 0,
    model: MODEL,
  });
}

function readRecords(recorder: TrajectoryRecorder): TrajectoryRecord[] {
  let raw: string;
  try {
    raw = readFileSync(recorder.filePath, 'utf-8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as TrajectoryRecord);
}

function makeAgent(llmClient: LLMClient): CognitiveAgent {
  const environment = new EnvironmentCenter({
    id: 'test-env',
    name: 'Test Environment',
    createdBy: 'test-user',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as EnvironmentCenterData);
  const agent = new CognitiveAgent({
    id: 'test-agent-nl',
    name: 'ThermalOps',
    description: 'test',
    owner: 'test-user',
    environment,
    llmClient,
    capabilities: ['temperature-control'],
  });
  agent.assignDevices([HVAC_DEVICE], 'test-user');
  return agent;
}

describe('NL 意图道 trajectory 埋点', () => {
  let backend: { server: Server; baseURL: string; requests: string[] };
  let client: LLMClient;
  let recorder: TrajectoryRecorder;
  let agent: CognitiveAgent;

  beforeEach(async () => {
    backend = await startBackend();
    client = new LLMClient('openai-compatible', { baseURL: backend.baseURL, model: MODEL });
    recorder = makeRecorder();
    // EngineRuntime 装配同款接线（assembleLlmLogging + agent 创建处）。
    client.setLoggingCallback(params => recorder.recordLLMCall(params));
    agent = makeAgent(client);
    agent.setNLInteractionListener(trace => recorder.recordNLInteraction(trace));
  });

  afterEach(async () => {
    await new Promise(resolve => backend.server.close(resolve));
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('一次 NL command 产出带 prompt/rawResponse/解析结果的 nl-interaction 记录', async () => {
    const result = await agent.processNaturalLanguageCommand('make the lobby cooler', {
      zones: [{ zoneId: 'lobby', parameters: { temperature: 29 } }],
      actor: 'user:7',
    });
    expect(result.decisionSource).toBe('llm');

    const records = readRecords(recorder).filter(r => r.kind === 'nl-interaction');
    expect(records).toHaveLength(2);
    const [intentRecord, decisionRecord] = records;

    // 归因 + 解析结果。
    for (const record of records) {
      expect(record.agentId).toBe('test-agent-nl');
      expect(record.nl?.lane).toBe('command');
      expect(record.nl?.text).toBe('make the lobby cooler');
      expect(record.nl?.intentAction).toBe('set_parameter');
      expect(record.model).toBe(MODEL);
      expect(record.correct).toBeNull();
    }

    // 意图解析道：prompt + 原始 JSON 应答落盘。
    expect(intentRecord.nl?.stage).toBe('intent');
    expect(intentRecord.decision).toBe('set_parameter');
    expect(intentRecord.decisionSource).toBe('llm');
    expect(intentRecord.prompt?.userPrompt).toContain('NL_COMMAND');
    expect(intentRecord.rawResponse).toBe(INTENT_ANSWER);

    // 决策道：prompt + rawResponse + 最终决策落盘。
    expect(decisionRecord.nl?.stage).toBe('decision');
    expect(decisionRecord.decision).toBe('handle_independently');
    expect(decisionRecord.decisionSource).toBe('llm');
    expect(decisionRecord.prompt?.userPrompt).toContain('PARSED_INTENT');
    expect(decisionRecord.rawResponse).toBe(DECISION_ANSWER);
  });

  it('emergency（规则短路，无 LLM 调用）落一条 stage rules 记录', async () => {
    const result = await agent.processNaturalLanguageCommand('fire in the lobby!');
    expect(result.intent.action).toBe('emergency');
    expect(backend.requests).toHaveLength(0);

    const records = readRecords(recorder).filter(r => r.kind === 'nl-interaction');
    expect(records).toHaveLength(1);
    expect(records[0].nl?.stage).toBe('rules');
    expect(records[0].prompt).toBeUndefined();
    expect(records[0].decision).toBe('escalate');
    expect(records[0].decisionSource).toBe('emergency');
  });

  it('ask 道同样落盘（read-only 评估的 prompt/rawResponse）', async () => {
    const result = await agent.answerNaturalLanguageQuestion('why would you turn on the HVAC?', {
      zones: [{ zoneId: 'lobby', parameters: { temperature: 31 } }],
    });
    expect(result.data.assessment?.actionPlan.primary.action).toBe('handle_independently');

    const records = readRecords(recorder).filter(r => r.kind === 'nl-interaction');
    expect(records.length).toBeGreaterThanOrEqual(1);
    const decisionRecord = records.find(r => r.nl?.stage === 'decision');
    expect(decisionRecord).toBeDefined();
    expect(decisionRecord?.nl?.lane).toBe('ask');
    expect(decisionRecord?.decisionSource).toBe('llm');
    expect(decisionRecord?.prompt?.userPrompt).toContain('READ-ONLY');
    expect(decisionRecord?.rawResponse).toBe(DECISION_ANSWER);
  });
});
