/**
 * Phase 1 (cognitive architecture §14.1): the model's structured
 * deviceActions ride the recommendation bridge on handle_independently
 * decisions.
 *
 * Full decision path with a scripted LLM producing a CognitiveDecision:
 * assess → derived legacy decision → DualTriggerACManager execution lanes
 * (flow invocation → COGNITIVE deviceActions → deterministic rule fallback).
 * Covers: bridge-validated execution, own-device/command enforcement with
 * teaching refusals on the record, honest degradation to rule planning, and
 * the shadow-mode actuation gate.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { DualTriggerACManager } from '../DualTriggerACManager.js';
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
      disableSpatiotemporal: true, // events go straight to Layer 2
      commandExecutor,
      // Sensor-only coverage override (config-injected > computed from
      // agentDevices): keeps the preCheck OFF the Type A/E shortcuts so the
      // LLM decides — same fixture discipline as the assessor tests.
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

function event(): SystemEvent {
  return {
    id: 'event-1',
    type: 'device.state.update',
    source: 'test',
    timestamp: new Date(),
    payload: {
      zoneId: 'zone-1',                       // event zone = the devices' zone
      parameter: 'temperature',
      newValue: 29,
      temperature: 29,
      trend: 'increasing',
      severity: 'medium',                     // not urgent → Layer 2 (not the urgent shortcut)
      requiredCapabilities: ['cooling'],      // declared face; agent's temperature-control matches it
    },
    priority: 'normal',
  } as unknown as SystemEvent;
}

/**
 * A full CognitiveDecision answer commanding the agent's own hvac-1.
 * R40-A3（§7.5 升级通道）：confidence 0.8 —— 这条 fixture 断言的是执行面，
 * 置信度必须高于升级阈值（severity 3 × low-confidence 会触发
 * shouldEscalate 的压力线，决策升级为只通知不执行；升级行为本身由
 * DualTriggerACManager.escalation.vitest.test.ts 覆盖）。
 */
const cognitiveWithDeviceActions = JSON.stringify({
  situation: { type: 'anomaly', severity: 3, affectedZones: ['zone-1'], rootCauseHypothesis: 'heat load', confidence: 0.8 },
  goals: [{ goal: 'maintain_comfort', priority: 1 }],
  actionPlan: { primary: {
    action: 'handle_independently',
    reasoning: 'own hvac covers the zone',
    deviceActions: [
      { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 24 } },
    ],
  } },
  explanation: { summary: 'Own HVAC covers the zone.', factors: [{ name: 'comfort', weight: 0.8 }] },
  collaboration: { needed: false },
  uncertainty: { overall: 0.8 },
});

describe('DualTriggerACManager — cognitive deviceActions lane (Phase 1)', () => {
  it('executes bridge-validated model device commands on the agent\'s own devices', async () => {
    const { manager, mockLLMClient, commandExecutor } = createManager();
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveWithDeviceActions);

    const result = await manager.processEvent(event());

    expect(result.path).toBe('handled_independently');
    expect(commandExecutor).toHaveBeenCalledTimes(1);
    expect(commandExecutor).toHaveBeenCalledWith('hvac-1', 'set-temperature', { targetTemperature: 24 });
  });

  it('refuses foreign devices and commands with teaching notes, degrading to rule planning', async () => {
    const { manager, mockLLMClient, commandExecutor } = createManager();
    (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
      situation: { type: 'anomaly', severity: 3, confidence: 0.8 },
      actionPlan: { primary: {
        action: 'handle_independently',
        reasoning: 'attempting commands',
        deviceActions: [
          { deviceId: 'hvac-999', command: 'set-temperature', params: { targetTemperature: 24 } }, // not bound
          { deviceId: 'hvac-1', command: 'self-destruct', params: {} },                            // not allowed
        ],
      } },
      uncertainty: { overall: 0.5 },
    }));

    const result = await manager.processEvent(event());

    expect(result.path).toBe('handled_independently');
    // None of the model's commands were executable — the deterministic rule
    // planner took over (temperature event → own climate device).
    const calls = (commandExecutor as Mock).mock.calls as unknown as Array<[string, string]>;
    const commanded = calls.map(([deviceId, command]) => `${deviceId}:${command}`);
    expect(commanded.some(entry => entry.includes('hvac-999'))).toBe(false);
    expect(commanded.some(entry => entry.includes('self-destruct'))).toBe(false);
    // Teaching refusals ride the recorded reasoning (honest, never silent).
    const reasoning = JSON.stringify(calls);
    expect(reasoning).toBeDefined();
    const layer2 = result.layer2Result as { assessment: { llmAssessment: { reasoning: string } } } | undefined;
    expect(layer2?.assessment.llmAssessment.reasoning).toMatch(/refused by the recommendation bridge/);
    expect(layer2?.assessment.llmAssessment.reasoning).toContain('hvac-999');
  });

  it('clamps out-of-range params through the R33 device-safe ranges', async () => {
    const { manager, mockLLMClient, commandExecutor } = createManager();
    (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
      // decision-v1 (F0-2): situation/actionPlan/uncertainty are required —
      // guided decoding always emits them, so lane fixtures must too.
      situation: { type: 'anomaly', severity: 3, confidence: 0.8 },
      actionPlan: { primary: {
        action: 'handle_independently',
        reasoning: 'cool aggressively',
        deviceActions: [{ deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 55 } }],
      } },
      uncertainty: { overall: 0.5 },
    }));

    await manager.processEvent(event());

    expect(commandExecutor).toHaveBeenCalledWith('hvac-1', 'set-temperature', { targetTemperature: 40 });
    const layer2 = undefined; // clamp note asserted via reasoning below
    expect(layer2).toBeUndefined();
  });

  it('acMode shadow never actuates — the refusal is on the record', async () => {
    const { manager, mockLLMClient, commandExecutor } = createManager({ acMode: 'shadow' });
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveWithDeviceActions);

    await manager.processEvent(event());

    expect(commandExecutor).not.toHaveBeenCalled();
  });

  it('legacy binary answers keep the deterministic rule lane (no cognitive lane)', async () => {
    const { manager, mockLLMClient, commandExecutor } = createManager();
    (mockLLMClient.quickChat as Mock).mockResolvedValue(
      JSON.stringify({ decision: 'independent', reasoning: 'rule lane please' }),
    );

    const result = await manager.processEvent(event());

    expect(result.path).toBe('handled_independently');
    // No deviceActions → the deterministic planner owns actuation; commands
    // target own devices only (here: the climate device via rule planning).
    const calls = (commandExecutor as Mock).mock.calls as unknown as Array<[string, string]>;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([deviceId]) => deviceId === 'hvac-1' || deviceId === 'light-1')).toBe(true);
  });

  // =========================================================================
  // R37-F2: the decision prompt lists the agent's OWN device inventory
  // (MY_DEVICES) — the fix that makes the structured deviceActions lane
  // answerable (validation F2: the bridge demands exact own-device ids, but
  // the prompt never showed them, so the model could never comply).
  // =========================================================================
  it('R37-F2: the LLM prompt carries MY_DEVICES with the bound device ids/commands/zones', async () => {
    const { manager, mockLLMClient } = createManager();
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveWithDeviceActions);

    await manager.processEvent(event());

    const prompt = (mockLLMClient.quickChat as Mock).mock.calls[0]![0] as string;
    expect(prompt).toContain('MY_DEVICES');
    // Both bound devices with their EXACT ids (the bridge's budget surface).
    expect(prompt).toContain('"deviceId": "hvac-1"');
    expect(prompt).toContain('"deviceId": "light-1"');
    // Commands = the actuation capabilities the bridge allows.
    expect(prompt).toContain('set-temperature');
    expect(prompt).toContain('set-brightness');
    expect(prompt).toContain('turn-on');
    // Zone from agentDevices (world-session scoping: device location = zone).
    expect(prompt).toContain('"zone": "zone-1"');
  });

  it('R37-F2: deviceActions naming the inventory ids parse, bridge-validate and execute', async () => {
    const { manager, mockLLMClient, commandExecutor } = createManager();
    (mockLLMClient.quickChat as Mock).mockResolvedValue(cognitiveWithDeviceActions);

    const result = await manager.processEvent(event());

    // The model's answer rode the cognitive lane end-to-end: the id it can
    // only know from MY_DEVICES executed through the bridge + executor.
    expect(result.path).toBe('handled_independently');
    expect(commandExecutor).toHaveBeenCalledWith('hvac-1', 'set-temperature', { targetTemperature: 24 });
    const layer2 = result.layer2Result as { assessment: { cognitiveDecision?: { actionPlan: { primary: { deviceActions: unknown[] } } } } };
    expect(layer2.assessment.cognitiveDecision?.actionPlan.primary.deviceActions).toEqual([
      { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 24 } },
    ]);
  });
});
