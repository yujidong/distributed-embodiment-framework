/**
 * Phase 2 §14.2 — the UNIFICATION tests (task 6b). The three legacy context
 * builders now project from the world model:
 *
 *   1. DualTriggerACManager.buildAgentContext attaches `cognition` — a
 *      world model built from the SAME availableResources/capability
 *      surface (single source), the runtime zone provider, the bounded
 *      event ring and the owner goal stack — plus the rule-based situation
 *      and the open working-memory round.
 *   2. Decisions are recorded into working memory → the NEXT round's
 *      cognition carries previousDecision (the assessor renders it).
 *   3. AgentContextBuilder reads zones from a wired world-model source.
 *   4. The pure runtime zone-source shaping (managed + adjacent zones,
 *      standard snapshot parameters).
 *
 * The legacy behaviors are pinned by context-builder-pins.vitest.test.ts
 * (written pre-refactor, still green).
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { DualTriggerACManager } from '../../decision/DualTriggerACManager.js';
import { AgentContextBuilder, type AgentInfo } from '../../context/AgentContextBuilder.js';
import { buildAgentZoneSource } from '../../runtime/shaping/cognition.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { ResourceManager } from '../../resource/ResourceManager.js';
import type { ServiceRegistry } from '../../service/ServiceRegistry.js';
import type { AgentContext } from '../../decision/ACNecessityAssessor.js';
import { EventType, EventPriority } from '@active-collaboration/shared';
import type { SystemEvent } from '@active-collaboration/shared';
import { buildAgentWorldModel } from '../world-model-builder.js';

interface ManagerTestAccess {
  resourceManager: ResourceManager | undefined;
  serviceRegistry: ServiceRegistry | undefined;
}

describe('UNIFY: DualTriggerACManager.buildAgentContext → cognition projection', () => {
  let manager: DualTriggerACManager;
  let mockEnvironment: EnvironmentCenter;
  let access: ManagerTestAccess;

  beforeEach(() => {
    const mockLLMClient = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
    mockEnvironment = {
      listDevices: vi.fn().mockReturnValue([]),
      listAgents: vi.fn().mockResolvedValue([]),
      getParameters: vi.fn().mockReturnValue({}),
      getServices: vi.fn().mockReturnValue(new Map([
        ['svc-1', { agentId: 'agent-1', service: { name: 'S', capabilities: [], location: 'floor-1' } }],
      ])),
      physicalEnvironment: { getZone: vi.fn() },
      eventManager: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() },
    } as unknown as EnvironmentCenter;

    manager = new DualTriggerACManager(
      'agent-1', 'TestAgent', ['temperature-control'],
      mockLLMClient, mockEnvironment, vi.fn(),
      { enableLayer1: false, enableLayer2: true, autoInitiateAC: false },
    );
    access = manager as unknown as ManagerTestAccess;
    access.resourceManager = { getResource: vi.fn().mockReturnValue(null) } as unknown as ResourceManager;
    access.serviceRegistry = { getOwnServices: vi.fn().mockReturnValue([]) } as unknown as ServiceRegistry;
  });

  const deviceEvent = (type: string, zoneId: string, parameter?: string, value?: number): SystemEvent => ({
    id: `evt-${type}-${Math.random().toString(36).slice(2, 6)}`,
    type: EventType.ENVIRONMENT_PARAM_CHANGED,
    source: 'unify-test',
    timestamp: new Date(),
    priority: EventPriority.NORMAL,
    payload: { eventType: type, zoneId, ...(parameter !== undefined ? { parameter } : {}), ...(value !== undefined ? { newValue: value } : {}) },
    metadata: {},
  } as unknown as SystemEvent);

  it('attaches cognition: world model from the SAME devices/capabilities + provider zones + goal stack', async () => {
    manager.setAgentDevices([
      { deviceId: 'hvac-101', type: 'hvac', capabilities: ['Temperature-Control', 'temperature-sensing'], zoneId: 'floor-1' },
    ]);
    manager.setAgentGoals([{ goal: 'maintain_comfort', priority: 2 }]);
    manager.setWorldModelProvider(() => ({
      simTimeSec: 43210,
      simStartEpochMs: 0,
      zones: [{ zoneId: 'floor-1', name: 'Floor 1', parameters: { temperature: 31.5 }, adjacentZoneIds: ['floor-2'] }],
    }));

    const ctx = await manager.buildAgentContext();
    expect(ctx.cognition).toBeDefined();
    expect(ctx.cognition!.worldModel.agentId).toBe('agent-1');
    expect(ctx.cognition!.worldModel.capabilities).toEqual(ctx.capabilities); // single source
    expect(ctx.cognition!.worldModel.devices).toEqual([
      {
        deviceId: 'hvac-101', type: 'hvac', zoneId: 'floor-1',
        state: {}, commands: ['temperature-control'], // sensor-style cap excluded
      },
    ]);
    expect(ctx.cognition!.worldModel.zones).toEqual([
      { zoneId: 'floor-1', name: 'Floor 1', parameters: { temperature: 31.5 }, adjacentZoneIds: ['floor-2'] },
    ]);
    expect(ctx.cognition!.worldModel.goalStack).toEqual([{ goal: 'maintain_comfort', priority: 2 }]);
    expect(ctx.cognition!.worldModel.simTimeSec).toBe(43210);
  });

  it('situation rides the context (rule prior from the world model)', async () => {
    manager.setAgentDevices([]);
    manager.setWorldModelProvider(() => ({
      simTimeSec: 100,
      zones: [{ zoneId: 'floor-1', parameters: { temperature: 31.5 }, adjacentZoneIds: [] }],
    }));

    const ctx = await manager.buildAgentContext();
    expect(ctx.cognition!.situation.type).toBe('anomaly');
    expect(ctx.cognition!.situation.severity).toBe(3);
  });

  it('the event ring feeds recentEvents (bounded, sim-time from the provider)', async () => {
    manager.setAgentDevices([]);
    manager.setWorldModelProvider(() => ({ simTimeSec: 500, zones: [] }));

    await manager.processEvent(deviceEvent('temperature-spike', 'floor-1', 'temperature', 31));
    await manager.processEvent(deviceEvent('footfall-spike', 'floor-2'));

    const ctx = await manager.buildAgentContext();
    expect(ctx.cognition!.worldModel.recentEvents.map(e => e.type)).toEqual([
      'temperature-spike', 'footfall-spike',
    ]);
    expect(ctx.cognition!.worldModel.recentEvents[0]).toMatchObject({
      zoneId: 'floor-1', parameter: 'temperature', value: 31, simTimeSec: 500,
    });
  });

  it('working memory: decision outcomes recorded → NEXT round carries previousDecision', async () => {
    manager.setAgentDevices([]);
    manager.setWorldModelProvider(() => ({ simTimeSec: 100, zones: [] }));

    const first = await manager.buildAgentContext();
    expect(first.cognition!.workingMemory.previousDecision).toBeUndefined();
    expect(first.cognition!.workingMemory.situationChanges).toEqual([]); // first round: empty world

    // A decision lands (recorded via noteCognitiveDecision on the assessor paths;
    // simulate the funnel by driving one assessment through the manager):
    (manager as unknown as { noteCognitiveDecision: (a: unknown) => void }).noteCognitiveDecision({
      decision: 'handle_independently',
    });

    const second = await manager.buildAgentContext();
    expect(second.cognition!.workingMemory.previousDecision).toEqual({
      action: 'handle_independently',
      outcome: 'handled-independently',
      atSimTimeSec: 100,
    });
  });

  it('no zone provider → empty zones, cognition still built (embedded contexts degrade honestly)', async () => {
    manager.setAgentDevices([]);
    const ctx = await manager.buildAgentContext();
    expect(ctx.cognition).toBeDefined();
    expect(ctx.cognition!.worldModel.zones).toEqual([]);
    expect(ctx.cognition!.situation.type).toBe('normal');
  });

  it('prompt end-to-end: the manager-built context renders WORLD_CONTEXT in the assessor prompt', async () => {
    // Dedicated manager: direct actuator coverage of the event zone + a
    // DECLARED need the agent lacks (fire-suppression) → preCheck finds the
    // gap and the decision reaches the LLM lane with the cognition context.
    const stubLLM = {
      chat: vi.fn(),
      quickChat: vi.fn().mockResolvedValue(JSON.stringify({ decision: 'independent', reasoning: 'ok' })),
    } as unknown as LLMClient;
    const llmManager = new DualTriggerACManager(
      'agent-1', 'TestAgent', ['temperature-control'],
      stubLLM, mockEnvironment, vi.fn(),
      {
        enableLayer1: false, enableLayer2: true, autoInitiateAC: false,
        actuatorZoneIds: ['floor-1'],
      },
    );
    const llmAccess = llmManager as unknown as ManagerTestAccess;
    llmAccess.resourceManager = { getResource: vi.fn().mockReturnValue(null) } as unknown as ResourceManager;
    llmAccess.serviceRegistry = { getOwnServices: vi.fn().mockReturnValue([]) } as unknown as ServiceRegistry;
    llmManager.setAgentDevices([
      { deviceId: 'hvac-101', type: 'hvac', capabilities: ['temperature-control'], zoneId: 'floor-1' },
    ]);
    llmManager.setWorldModelProvider(() => ({
      simTimeSec: 43210,
      zones: [{ zoneId: 'floor-1', parameters: { temperature: 31.5 }, adjacentZoneIds: [] }],
    }));

    await llmManager.processEvent({
      id: 'evt-e2e', type: EventType.ENVIRONMENT_PARAM_CHANGED, source: 'unify-test',
      timestamp: new Date(), priority: EventPriority.NORMAL,
      payload: {
        eventType: 'temperature-spike', zoneId: 'floor-1', parameter: 'temperature', newValue: 31.5,
        requiredCapabilities: ['fire-suppression'],
      },
      metadata: {},
    } as unknown as SystemEvent);

    const quickChat = stubLLM.quickChat as Mock;
    expect(quickChat).toHaveBeenCalled();
    const prompt = quickChat.mock.calls[0][0] as string;
    expect(prompt).toContain('WORLD_CONTEXT');
    expect(prompt).toMatch(/SITUATION: anomaly severity=3\/5/);
    expect(prompt).toContain('RECENT_EVENTS (1):');
    expect(prompt).toContain('t=43210 temperature-spike zone=floor-1 param=temperature value=31.5');
  });
});

describe('UNIFY: AgentContextBuilder → world-model zone projection', () => {
  const deps = () => {
    const resourceManager = { getAllResources: vi.fn().mockReturnValue([]), getResource: vi.fn() } as unknown as ResourceManager;
    const serviceRegistry = { getAllServices: vi.fn().mockReturnValue([]) } as unknown as ServiceRegistry;
    const environment = {
      id: 'env-1', name: 'Env',
      listAgents: vi.fn().mockResolvedValue([]),
      physicalEnvironment: {
        getAllParameters: vi.fn().mockReturnValue({ global: 1 }),
        getSpatialManager: vi.fn().mockReturnValue({
          getAllZones: vi.fn().mockReturnValue([
            { id: 'legacy-zone', name: 'Legacy', location: 'l', state: {} },
          ]),
        }),
      },
    } as unknown as EnvironmentCenter;
    const agentInfo: AgentInfo = {
      id: 'a', name: 'A', description: 'd', capabilities: [], status: 'online',
    };
    return { resourceManager, serviceRegistry, environment, agentInfo };
  };

  it('default (no source): legacy spatial-manager zones (pin holds)', async () => {
    const d = deps();
    const builder = new AgentContextBuilder(d.agentInfo, d.resourceManager, d.serviceRegistry, d.environment);
    const context = await builder.buildFullContext();
    expect(context.environment.zones).toEqual([{ id: 'legacy-zone', name: 'Legacy', location: 'l', state: {} }]);
  });

  it('with a world-model source: zones project from the world model', async () => {
    const d = deps();
    const builder = new AgentContextBuilder(d.agentInfo, d.resourceManager, d.serviceRegistry, d.environment);
    const worldModel = buildAgentWorldModel({
      agentId: 'a', capabilities: [],
      devices: [],
      zones: [
        { zoneId: 'floor-1', name: 'Floor 1', parameters: { temperature: 29.3, humidity: 55 }, adjacentZoneIds: ['floor-2'] },
      ],
      simTimeSec: 43210,
    });
    builder.setWorldModelSource(() => worldModel);

    const context = await builder.buildFullContext();
    expect(context.environment.zones).toEqual([
      { id: 'floor-1', name: 'Floor 1', location: '', state: { temperature: 29.3, humidity: 55 } },
    ]);
    expect(context.environment.physicalState).toEqual({ global: 1 }); // global face unchanged
  });

  it('a source returning undefined falls back to the legacy path for that build', async () => {
    const d = deps();
    const builder = new AgentContextBuilder(d.agentInfo, d.resourceManager, d.serviceRegistry, d.environment);
    builder.setWorldModelSource(() => undefined);
    const context = await builder.buildFullContext();
    expect(context.environment.zones).toEqual([{ id: 'legacy-zone', name: 'Legacy', location: 'l', state: {} }]);
  });
});

describe('UNIFY: runtime zone-source shaping (pure)', () => {
  it('managed zones + adjacency, standard parameters sampled, failed reads omitted', () => {
    const source = buildAgentZoneSource({
      zoneDefs: [
        { id: 'floor-1', name: 'Floor 1', adjacentZoneIds: ['floor-2'] },
        { id: 'floor-2', name: 'Floor 2', adjacentZoneIds: ['floor-1'] },
        { id: 'far-away', name: 'Far', adjacentZoneIds: [] },
      ],
      managedZoneIds: ['floor-1'],
      getParameterValue: (parameter, zoneId) =>
        zoneId === 'floor-1' && parameter === 'temperature' ? 29.3
          : zoneId === 'floor-1' && parameter === 'humidity' ? 60
            : zoneId === 'floor-2' && parameter === 'temperature' ? 27
              : undefined,
      parameters: ['temperature', 'humidity', 'co2'],
      simTimeSec: 43210,
      simStartEpochMs: 1000,
    });

    expect(source.simTimeSec).toBe(43210);
    expect(source.simStartEpochMs).toBe(1000);
    expect(source.zones).toEqual([
      {
        zoneId: 'floor-1', name: 'Floor 1',
        parameters: { temperature: 29.3, humidity: 60 }, // co2 read failed → omitted
        adjacentZoneIds: ['floor-2'],
      },
      {
        zoneId: 'floor-2', name: 'Floor 2',
        parameters: { temperature: 27 },
        adjacentZoneIds: ['floor-1'],
      },
      // far-away NOT visible (not managed, not adjacent)
    ]);
  });

  it('empty managed zones → empty source (honest, no invented topology)', () => {
    const source = buildAgentZoneSource({
      zoneDefs: [{ id: 'z', adjacentZoneIds: [] }],
      managedZoneIds: [],
      getParameterValue: () => 1,
      parameters: ['temperature'],
      simTimeSec: 0,
      simStartEpochMs: 0,
    });
    expect(source.zones).toEqual([]);
  });
});

// Compile-time presence check: the AgentContext type carries the cognition
// projection (imported above so the type is exercised).
type _CtxHasCognition = AgentContext['cognition'];
