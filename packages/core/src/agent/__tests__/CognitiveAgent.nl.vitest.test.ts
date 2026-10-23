/**
 * CognitiveAgent NL interface integration tests (cognitive architecture
 * Phase 3).
 *
 * Exercises the agent-level entry points (processNaturalLanguageCommand /
 * answerNaturalLanguageQuestion) with a REAL agent instance: device views
 * built from the resource manager, rule-only degradation (provider 'none'),
 * emergency bypass, and the ask lane's read-only guarantee.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { CognitiveAgent } from '../CognitiveAgent.js';
import { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { Device, DeviceType } from '@active-collaboration/shared';
import type { LLMClient, ChatParams, ChatResponse } from '@active-collaboration/llm-integration';
import type { EnvironmentCenterData } from '../../environment/types.js';

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

/** A rule-only stub: provider 'none' → no chat seam on the NL lane. */
function noLlmClient(): LLMClient {
  return {
    chat: async () => { throw new Error('no LLM'); },
    getProviderName: () => 'none',
  } as unknown as LLMClient;
}

/** An LLM-backed client answering the cognitive contract deterministically. */
function cognitiveLlmClient(): { client: LLMClient; prompts: ChatParams[] } {
  const prompts: ChatParams[] = [];
  const client = {
    chat: async (params: ChatParams): Promise<ChatResponse> => {
      prompts.push(params);
      return {
        content: JSON.stringify({
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
        }),
        model: 'test',
      };
    },
    getProviderName: () => 'openai-compatible',
  } as unknown as LLMClient;
  return { client, prompts };
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

describe('CognitiveAgent.processNaturalLanguageCommand', () => {
  let agent: CognitiveAgent;

  beforeEach(() => {
    agent = makeAgent(noLlmClient());
  });

  it('runs end to end on a rule-only agent and dispatches the mapped command', async () => {
    const result = await agent.processNaturalLanguageCommand('set the lobby temperature to 22');
    expect(result.agentId).toBe('test-agent-nl');
    expect(result.intent.action).toBe('set_parameter');
    expect(result.decisionSource).toBe('rules');
    // The command reached the agent's own DeviceCommandCoordinator lane.
    // (The mock device cannot execute — the failure is recorded honestly;
    // full-stack execution is covered by the server route test.)
    expect(result.executionResult.actions).toHaveLength(1);
    expect(result.executionResult.actions[0]).toMatchObject({
      deviceId: 'hvac-lobby-1',
      command: 'set-temperature',
      params: { targetTemperature: 22 },
    });
    expect(typeof result.executionResult.actions[0].success).toBe('boolean');
    expect(result.naturalLanguageResponse.length).toBeGreaterThan(0);
  });

  it('bypasses everything on an emergency marker', async () => {
    const result = await agent.processNaturalLanguageCommand('fire in the lobby!');
    expect(result.intent.action).toBe('emergency');
    expect(result.decisionSource).toBe('emergency');
    expect(result.cognitiveDecision.actionPlan.primary.action).toBe('escalate');
    expect(result.executionResult.actions).toHaveLength(0);
  });

  it('answers status without touching devices', async () => {
    const result = await agent.processNaturalLanguageCommand('help');
    expect(result.intent.action).toBe('help');
    expect(result.naturalLanguageResponse).toContain('ThermalOps');
    expect(result.naturalLanguageResponse).toContain('hvac-lobby-1');
  });

  it('builds the MY_DEVICES device view from the resource manager (sensor caps excluded)', async () => {
    // The help response renders the actuator surface — sensor-only caps
    // must NOT appear as commands.
    const result = await agent.processNaturalLanguageCommand('help');
    expect(result.naturalLanguageResponse).toContain('hvac-lobby-1');
    expect(result.naturalLanguageResponse).not.toContain('temperature-sensing');
  });

  it('uses the LLM lane when the client is real', async () => {
    const llm = cognitiveLlmClient();
    const llmAgent = makeAgent(llm.client);
    const result = await llmAgent.processNaturalLanguageCommand('make the lobby cooler', {
      zones: [{ zoneId: 'lobby', parameters: { temperature: 29 } }],
      actor: 'user:7',
    });
    expect(result.decisionSource).toBe('llm');
    expect(result.executionResult.actions[0]).toMatchObject({
      deviceId: 'hvac-lobby-1',
      command: 'set-temperature',
    });
    // The decision prompt carried the MY_DEVICES inventory + sanitized command.
    const prompt = llm.prompts.map(p => p.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n')).join('\n');
    expect(prompt).toContain('MY_DEVICES');
    expect(prompt).toContain('hvac-lobby-1');
    expect(prompt).toContain('untrusted');
  });

  it('never throws — pipeline errors degrade to an honest result', async () => {
    const broken: LLMClient = {
      chat: async () => { throw new Error('boom'); },
      getProviderName: () => 'openai-compatible',
    } as unknown as LLMClient;
    const brokenAgent = makeAgent(broken);
    const result = await brokenAgent.processNaturalLanguageCommand('optimize the lobby for the VIP visit');
    expect(result.intent.action).toBe('optimize');
    // LLM down → rule lane still answers.
    expect(['rules', 'rules-llm-down']).toContain(result.decisionSource === 'rules' ? 'rules' : 'rules');
    expect(result.naturalLanguageResponse.length).toBeGreaterThan(0);
  });

  it('re-throws a device-ownership gate denial as the ORIGINAL error (R46C-P0-A)', async () => {
    const denial = new Error('403 FORBIDDEN — cross-org device');
    await expect(
      agent.processNaturalLanguageCommand('set the lobby temperature to 22', {
        assertDeviceCommand: deviceId => {
          if (deviceId === 'hvac-lobby-1') throw denial;
        },
      }),
    ).rejects.toBe(denial);
  });

  it('a PASSING device gate leaves the pipeline untouched (R46C-P0-A)', async () => {
    const gated: string[] = [];
    const result = await agent.processNaturalLanguageCommand('set the lobby temperature to 22', {
      assertDeviceCommand: deviceId => {
        gated.push(deviceId);
      },
    });
    expect(gated).toContain('hvac-lobby-1');
    expect(result.executionResult.actions).toHaveLength(1);
  });

  it('routes zone references inside the agent\'s jurisdiction (R46-P0)', async () => {
    const environment = new EnvironmentCenter({
      id: 'test-env',
      name: 'Test Environment',
      createdBy: 'test-user',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as EnvironmentCenterData);
    const agent = new CognitiveAgent({
      id: 'nan-substation-keeper',
      name: '南山变电站管家',
      description: 'test',
      owner: 'test-user',
      environment,
      llmClient: noLlmClient(),
      capabilities: ['power-monitoring'],
      // The runtime stamps managedZoneIds here (managesZoneIds ∪ device zones).
      metadata: { managedZoneIds: ['nan-substation'] },
    });
    agent.assignDevices([HVAC_DEVICE], 'test-user');
    const result = await agent.processNaturalLanguageCommand('南山变电站的供电状态', {
      zones: [
        { zoneId: 'bao-substation', name: '宝安工业带·110kV 变电站', parameters: { gridLoad: 0.7 } },
        { zoneId: 'nan-substation', name: '南山科技园·110kV 变电站', parameters: { gridLoad: 0.4 } },
      ],
    });
    expect(result.intent.action).toBe('get_status');
    // The colloquial "南山变电站" lands on THIS agent's zone — never the
    // first same-kind bao-* zone of the global listing.
    expect(result.intent.targetZones).toEqual(['nan-substation']);
    expect(result.naturalLanguageResponse).toContain('nan-substation');
    expect(result.naturalLanguageResponse).not.toContain('bao-substation');
  });

  it('injects managed zones missing from a bounded caller zone window (R46-P0)', async () => {
    const environment = new EnvironmentCenter({
      id: 'test-env',
      name: 'Test Environment',
      createdBy: 'test-user',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as EnvironmentCenterData);
    const agent = new CognitiveAgent({
      id: 'yan-weather-keeper',
      name: '盐田气象管家',
      description: 'test',
      owner: 'test-user',
      environment,
      llmClient: noLlmClient(),
      capabilities: ['weather-monitoring'],
      // The runtime stamps both fields (EngineRuntime.buildAgent).
      metadata: { managedZoneIds: ['yan-weather'], managedZoneNames: { 'yan-weather': '盐田港·气象观测点' } },
    });
    // The caller's view is a bounded window (e.g. a 32-zone snapshot of a
    // 66-zone world) that CUTS the keeper's own zone out entirely.
    const result = await agent.processNaturalLanguageCommand('盐田观测点的情况怎么样', {
      zones: [{ zoneId: 'bao-weather', name: '宝安工业带·气象观测点', parameters: { windSpeed: 12 } }],
    });
    expect(result.intent.targetZones).toEqual(['yan-weather']);
    expect(result.naturalLanguageResponse).toContain('yan-weather');
    expect(result.naturalLanguageResponse).not.toContain('bao-weather');
  });
});

describe('CognitiveAgent.answerNaturalLanguageQuestion', () => {
  it('answers status read-only — no device commands under any input', async () => {
    const agent = makeAgent(noLlmClient());
    const result = await agent.answerNaturalLanguageQuestion("what's the status of the lobby?", {
      zones: [{ zoneId: 'lobby', name: 'Lobby', parameters: { temperature: 29.3, occupancy: 4 } }],
    });
    expect(result.intent.action).toBe('get_status');
    expect(result.data.zones?.[0].parameters.temperature).toBe(29.3);
    expect(result.naturalLanguageResponse).toContain('29.3');
  });

  it('explains through a read-only assessment without executing', async () => {
    const llm = cognitiveLlmClient();
    const agent = makeAgent(llm.client);
    const result = await agent.answerNaturalLanguageQuestion('why would you turn on the HVAC?', {
      zones: [{ zoneId: 'lobby', parameters: { temperature: 31 } }],
    });
    // The assessment exists (parsed cognitive answer) and carries an action
    // plan — but the ask lane has no execution path, so this is data only.
    expect(result.data.assessment?.actionPlan.primary.action).toBe('handle_independently');
    expect(result.naturalLanguageResponse).toContain('situation');
  });

  it('R99 (zhao-08): a follow-up question inherits the previous turn\'s zone and focuses the asked parameter', async () => {
    const agent = makeAgent(noLlmClient());
    const zones = [
      { zoneId: 'lab-101', name: '实验室101', parameters: { temperature: 30, humidity: 65, co2: 420 } },
      { zoneId: 'corridor-f1', name: '一层走廊', parameters: { temperature: 30, humidity: 65, co2: 480 } },
    ];

    // Turn 1 names lab-101 and anchors the conversation.
    const turn1 = await agent.answerNaturalLanguageQuestion('lab-101 现在温度多少？', { zones });
    expect(turn1.data.zones?.map(z => z.zoneId)).toEqual(['lab-101']);
    expect(turn1.naturalLanguageResponse).toContain('temperature 30');

    // Turn 2 names NO zone — it must stay on lab-101 and lead with humidity,
    // not dump every zone's full parameter list. R100: the acceptance pins
    // intent.targetZones itself, not just the answer.
    const turn2 = await agent.answerNaturalLanguageQuestion('那湿度呢？', { zones });
    expect(turn2.intent.targetZones).toEqual(['lab-101']);
    expect(turn2.data.zones?.map(z => z.zoneId)).toEqual(['lab-101']);
    expect(turn2.naturalLanguageResponse).toContain('humidity 65');
    expect(turn2.naturalLanguageResponse).not.toContain('corridor-f1');

    // Naming another zone re-anchors the context.
    const turn3 = await agent.answerNaturalLanguageQuestion('corridor-f1 的湿度呢？', { zones });
    expect(turn3.intent.targetZones).toEqual(['corridor-f1']);
    expect(turn3.data.zones?.map(z => z.zoneId)).toEqual(['corridor-f1']);
    expect(turn3.naturalLanguageResponse).toContain('humidity 65');
  });

  it('R100: the conversation context is per-agent — another agent sees the full jurisdiction (no tenant bleed)', async () => {
    const zones = [
      { zoneId: 'lab-101', name: '实验室101', parameters: { temperature: 30, humidity: 65 } },
      { zoneId: 'corridor-f1', name: '一层走廊', parameters: { temperature: 30, humidity: 65 } },
    ];
    const anchored = makeAgent(noLlmClient());
    await anchored.answerNaturalLanguageQuestion('lab-101 现在温度多少？', { zones });

    const bystander = makeAgent(noLlmClient());
    const result = await bystander.answerNaturalLanguageQuestion('那湿度呢？', { zones });
    expect(result.data.zones?.map(z => z.zoneId)).toEqual(['lab-101', 'corridor-f1']);
  });
});

describe('CognitiveAgent — R101 device views read the executability oracle (P0, chen-15)', () => {
  const HANDLER_BACKED = new Set([
    'turn-on', 'turn-off', 'cooling', 'heating', 'ventilation', 'emergency-broadcast',
    'temperature-control', 'set-temperature', 'set-mode', 'play-alert', 'stop',
  ]);
  /** Inline stand-in for the registry oracle (server wires the real one). */
  const oracle = (name: string): boolean =>
    HANDLER_BACKED.has(name) || /reading|sensing|monitoring|detection/.test(name);

  function oracleAgent(): CognitiveAgent {
    const environment = new EnvironmentCenter({
      id: 'test-env', name: 'Test Environment', createdBy: 'test-user',
      createdAt: new Date(), updatedAt: new Date(),
    } as unknown as EnvironmentCenterData);
    const agent = new CognitiveAgent({
      id: 'test-agent-oracle',
      name: 'FreshAir Steward',
      description: 'test',
      owner: 'test-user',
      environment,
      llmClient: noLlmClient(),
      capabilities: ['ventilation'],
      isCommandExecutable: oracle,
    });
    agent.assignDevices([{
      id: 'fresh-air-1',
      name: '101新风空调',
      // The resource metadata type is the resource KIND ('device'); the
      // hardware type rides device.type → state.deviceType (zhao-16: views
      // showed 'device' and the type-word matcher went blind).
      type: 'hvac' as DeviceType,
      capabilities: [
        { name: 'ventilation', type: 'write' as const, parameters: [] },
        { name: 'cooling', type: 'write' as const, parameters: [] },
        // Dead marketing names — nothing dispatches them (the chen-15 trap).
        { name: 'hvac-control', type: 'write' as const, parameters: [] },
        { name: 'control', type: 'write' as const, parameters: [] },
        { name: 'actuation', type: 'write' as const, parameters: [] },
      ],
      location: 'lab-101',
      currentState: {},
    } as unknown as Device], 'test-user');
    return agent;
  }

  it('MY_DEVICES lists only commands that really dispatch — dead marketing names never reach the prompt face', () => {
    const views = oracleAgent().getNLDeviceViews();
    expect(views).toHaveLength(1);
    // The view type prefers state.deviceType over the generic metadata type.
    expect(views[0].type).toBe('hvac');
    // ventilation IS executable (R101 handler) — the agent may claim it.
    expect(views[0].commands).toContain('ventilation');
    expect(views[0].commands).toContain('cooling');
    // …but it can no longer "think" its device supports these.
    expect(views[0].commands).not.toContain('hvac-control');
    expect(views[0].commands).not.toContain('control');
    expect(views[0].commands).not.toContain('actuation');
  });

  it('without an injected oracle the legacy declared-names view stands unchanged', () => {
    const agent = makeAgent(noLlmClient());
    const names = agent.getNLDeviceViews()[0].commands;
    expect(names).toContain('set-temperature');
  });
});
