/**
 * @vitest-environment node
 *
 * P4-3 integration tests: ACExecutor × workflow synthesis (no LLM backend).
 *
 * Covers the replacement point of the fake inter-agent planning messages:
 *   - flag OFF (default): legacy path unchanged, LLM never called
 *   - flag ON + multi-step goal: synthesize → validate → deterministic execute,
 *     node calls routed through the SAME three-phase device-capability path
 *   - condition-guarded nodes against the live parameter map
 *   - fault-injected device failure → compensate policy inside an AC run
 *   - synthesis failure → honest fallback to the legacy path
 *   - single-capability goals never trigger synthesis (heuristic)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACExecutor, type ACCollaborationConfig } from '../../execution/ACExecutor.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { CollaborationManager } from '../../management/CollaborationManager.js';
import type { LLMClient } from '@active-collaboration/llm-integration';

// ---------------------------------------------------------------------------
// Mocks (same shapes as ACExecutor.vitest.test.ts)
// ---------------------------------------------------------------------------

interface MockResource {
  id: string;
  execute: ReturnType<typeof vi.fn>;
  getCapabilities: () => Array<{ name: string }>;
}

function makeResource(id: string, capabilities: string[], executeImpl?: (cap: string) => Promise<unknown>): MockResource {
  return {
    id,
    getCapabilities: () => capabilities.map(name => ({ name })),
    execute: vi.fn(executeImpl ?? (async (capability: string) => ({ success: true, result: { capability } }))),
  };
}

function makeService(id: string, deviceId: string, providerAgentId: string, capabilities: string[]) {
  return {
    id,
    name: `${id}-service`,
    deviceId,
    getProviderInfo: () => ({ providerAgentId, providerAgentName: providerAgentId }),
    getCapabilities: () => capabilities,
  };
}

function makeAgent(id: string, capabilities: string[], resources: MockResource[]) {
  return {
    id,
    name: id,
    status: 'idle',
    capabilities,
    resourceManager: {
      getAllResources: vi.fn(() => resources),
      getResource: vi.fn((resourceId: string) => resources.find(r => r.id === resourceId) ?? null),
    },
    serviceRegistry: { getAllServices: vi.fn(() => []) },
    taskManager: { createTask: vi.fn(() => ({ id: `task-${id}`, status: 'pending' })) },
    dialogueManager: {
      sendMessage: vi.fn((_from: string, _to: string, _type: unknown, subject: string, content: string) => ({ subject, content })),
    },
    eventManager: { subscribe: vi.fn() },
    executeDeviceCapability: vi.fn(async () => ({ success: true })),
    requestService: vi.fn(async () => ({ success: true })),
  };
}

// ---------------------------------------------------------------------------
// Fixture: sensor agent (temperature-reading) + HVAC agent (cooling)
// ---------------------------------------------------------------------------

const SENSOR_CAPS = ['temperature-reading'];
const HVAC_CAPS = ['cooling', 'device-control'];

let sensorResource: MockResource;
let hvacResource: MockResource;
let sensorAgent: ReturnType<typeof makeAgent>;
let hvacAgent: ReturnType<typeof makeAgent>;
let mockEnvironment: EnvironmentCenter;
let mockCollaborationManager: CollaborationManager;
let envParameters: Record<string, unknown>;

function planJSON(nodes: unknown[]): string {
  return JSON.stringify({
    id: 'plan-cool-living-room',
    goal: '客厅温度 33°，降温到 26°',
    nodes,
    metadata: { author: 'llm', model: 'mock', createdAt: '2026-07-22T00:00:00.000Z' },
  });
}

const TWO_NODE_PLAN = planJSON([
  { id: 'sense', capability: 'temperature-reading' },
  {
    id: 'cool', capability: 'cooling',
    params: { targetTemperature: 26 },
    dependsOn: ['sense'],
    condition: 'temperature > 30',
  },
]);

function makeLLMClient(queue: Array<string | Error>): { client: LLMClient; quickChat: ReturnType<typeof vi.fn> } {
  const quickChat = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('mock queue exhausted');
    if (next instanceof Error) throw next;
    return { content: next, model: 'mock-model', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
  return { client: { quickChat, getModel: () => 'mock-model' } as unknown as LLMClient, quickChat };
}

function makeConfig(): ACCollaborationConfig {
  return {
    id: 'ac-wf-test',
    name: 'Workflow Synthesis Test AC',
    description: 'P4-3 integration test',
    environment: mockEnvironment,
    initiatorId: 'agent-001',
    participantAgentIds: ['agent-001', 'agent-002'],
    collaborationManager: mockCollaborationManager,
    goals: [
      {
        id: 'goal-cool',
        description: '客厅温度 33°，降温到 26°',
        targetDevices: [],
        targetAgents: ['agent-001', 'agent-002'],
        requiredCapabilities: ['temperature-reading', 'cooling'],
        successCriteria: [],
        priority: 'high',
      },
    ],
  };
}

beforeEach(() => {
  envParameters = { temperature: 33 };
  sensorResource = makeResource('dev-sensor', SENSOR_CAPS);
  hvacResource = makeResource('dev-hvac', HVAC_CAPS);
  sensorAgent = makeAgent('agent-001', SENSOR_CAPS, [sensorResource]);
  hvacAgent = makeAgent('agent-002', HVAC_CAPS, [hvacResource]);

  const agents: Record<string, unknown> = { 'agent-001': sensorAgent, 'agent-002': hvacAgent };
  const services = [
    makeService('svc-sensor', 'dev-sensor', 'agent-001', SENSOR_CAPS),
    makeService('svc-hvac', 'dev-hvac', 'agent-002', HVAC_CAPS),
  ];

  mockEnvironment = {
    getAgent: vi.fn((id: string) => agents[id]),
    listAgents: vi.fn(() => Object.values(agents)),
    getDevice: vi.fn(() => undefined),
    discoverServices: vi.fn(() => services),
    getParameters: vi.fn(() => ({ ...envParameters })),
    eventManager: { publish: vi.fn() },
  } as unknown as EnvironmentCenter;

  mockCollaborationManager = {
    trackACState: vi.fn(async () => undefined),
  } as unknown as CollaborationManager;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ACExecutor × workflow synthesis (P4-3)', () => {
  it('flag OFF (default): legacy path unchanged, LLM never called', async () => {
    const { client, quickChat } = makeLLMClient([TWO_NODE_PLAN]);
    const executor = new ACExecutor();

    // Note: workflowSynthesis.llmClient is present but the flag is off.
    const result = await executor.executeCollaboration(makeConfig(), {
      workflowSynthesis: { llmClient: client },
    });

    expect(quickChat).not.toHaveBeenCalled();
    expect(result.workflowResults).toBeUndefined();
    // Legacy fake planning messages still produced for a 2-agent goal.
    expect(result.agentCommunications.some(c => c.type === 'request')).toBe(true);
    // Legacy three-phase execution happened.
    expect(result.deviceOperations.length).toBeGreaterThan(0);
  });

  it('flag ON + multi-step goal: plan is authored, validated, deterministically executed', async () => {
    const { client, quickChat } = makeLLMClient([TWO_NODE_PLAN]);
    const executor = new ACExecutor();

    const result = await executor.executeCollaboration(makeConfig(), {
      useWorkflowSynthesis: true,
      workflowSynthesis: { llmClient: client },
    });

    expect(quickChat).toHaveBeenCalledTimes(1);

    // The workflow record is traced on the AC result.
    expect(result.workflowResults).toHaveLength(1);
    const wf = result.workflowResults![0];
    expect(wf.planId).toBe('plan-cool-living-room');
    expect(wf.status).toBe('success');
    expect(wf.nodeResults.sense.status).toBe('succeeded');
    expect(wf.nodeResults.cool.status).toBe('succeeded');

    // Node calls went through the three-phase device-capability path —
    // node params flowed through the legacy parameter mapping into the device call.
    expect(sensorResource.execute).toHaveBeenCalledWith('temperature-reading', expect.anything());
    expect(hvacResource.execute).toHaveBeenCalledWith('cooling', expect.objectContaining({ targetTemperature: 26 }));
    expect(result.deviceOperations.some(op => op.deviceId === 'dev-sensor')).toBe(true);
    expect(result.deviceOperations.some(op => op.deviceId === 'dev-hvac')).toBe(true);

    // The fake planning dialogue was REPLACED by one honest plan record.
    expect(result.agentCommunications.some(c => c.type === 'workflow-plan')).toBe(true);
    expect(result.agentCommunications.some(c => c.type === 'request')).toBe(false);
  });

  it('condition guard reads the live parameter map: cool node skipped at 22°', async () => {
    envParameters = { temperature: 22 };
    const { client } = makeLLMClient([TWO_NODE_PLAN]);
    const executor = new ACExecutor();

    const result = await executor.executeCollaboration(makeConfig(), {
      useWorkflowSynthesis: true,
      workflowSynthesis: { llmClient: client },
    });

    const wf = result.workflowResults![0];
    expect(wf.nodeResults.sense.status).toBe('succeeded');
    expect(wf.nodeResults.cool.status).toBe('skipped');
    expect(wf.status).toBe('success'); // skips are not failures
    expect(hvacResource.execute).not.toHaveBeenCalled();
  });

  it('fault-injected device failure: compensate policy runs inside the AC run', async () => {
    // P3d-style fault: the HVAC device rejects cooling commands.
    hvacResource.execute = vi.fn(async (capability: string) => {
      if (capability === 'cooling') throw new Error('fault-injected: hvac offline');
      return { success: true, result: { capability } };
    });

    const compensatePlan = planJSON([
      { id: 'sense', capability: 'temperature-reading' },
      {
        id: 'cool', capability: 'cooling', dependsOn: ['sense'],
        onFail: { policy: 'compensate', compensateNodeId: 'safe' },
      },
      { id: 'safe', capability: 'device-control' },
      { id: 'verify', capability: 'temperature-reading', dependsOn: ['cool'] },
    ]);
    const { client } = makeLLMClient([compensatePlan]);
    const executor = new ACExecutor();

    const result = await executor.executeCollaboration(makeConfig(), {
      useWorkflowSynthesis: true,
      workflowSynthesis: { llmClient: client },
    });

    const wf = result.workflowResults![0];
    expect(wf.nodeResults.sense.status).toBe('succeeded');
    expect(wf.nodeResults.cool.status).toBe('failed');
    expect(wf.nodeResults.safe.status).toBe('succeeded');
    expect(wf.nodeResults.safe.compensationFor).toBe('cool');
    expect(wf.nodeResults.verify.status).toBe('blocked');
    expect(wf.status).toBe('partial');
    // Compensation executed through the same device path.
    expect(hvacResource.execute).toHaveBeenCalledWith('device-control', expect.anything());
    // Failures never throw across the boundary — the AC run completed.
    expect(result.status).not.toBe('error');
  });

  it('synthesis failure falls back to the legacy path honestly', async () => {
    const { client, quickChat } = makeLLMClient(['garbage, not a plan', 'still garbage']);
    const executor = new ACExecutor();

    const result = await executor.executeCollaboration(makeConfig(), {
      useWorkflowSynthesis: true,
      workflowSynthesis: { llmClient: client },
    });

    expect(quickChat).toHaveBeenCalledTimes(2); // try + one repair
    expect(result.workflowResults).toBeUndefined();
    // Legacy path took over: fake planning messages + three-phase execution.
    expect(result.agentCommunications.some(c => c.type === 'request')).toBe(true);
    expect(result.deviceOperations.length).toBeGreaterThan(0);
  });

  it('single-capability goals never trigger synthesis (multi-step heuristic)', async () => {
    const { client, quickChat } = makeLLMClient([TWO_NODE_PLAN]);
    const executor = new ACExecutor();
    const config = makeConfig();
    config.goals[0].requiredCapabilities = ['cooling'];

    const result = await executor.executeCollaboration(config, {
      useWorkflowSynthesis: true,
      workflowSynthesis: { llmClient: client },
    });

    expect(quickChat).not.toHaveBeenCalled();
    expect(result.workflowResults).toBeUndefined();
  });

  it('flag ON but no llmClient: falls back to legacy without calling anything', async () => {
    const executor = new ACExecutor();
    const result = await executor.executeCollaboration(makeConfig(), {
      useWorkflowSynthesis: true,
    });

    expect(result.workflowResults).toBeUndefined();
    expect(result.agentCommunications.some(c => c.type === 'request')).toBe(true);
  });
});
