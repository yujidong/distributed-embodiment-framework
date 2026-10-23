/**
 * Phase 2 §14.2 unification PINS — the CURRENT behavior of the three
 * context builders the design converges onto the world model:
 *
 *   1. `CognitiveAgent.environmentStateSnapshot` getters
 *      (getEnvironmentStateSnapshot / getEnvironmentState),
 *   2. `DualTriggerACManager.buildAgentContext`,
 *   3. `AgentContextBuilder.buildFullContext` (+ legacy prompt formatting).
 *
 * Written BEFORE the refactor (task 6a); the refactor (task 6b) must keep
 * every assertion green — behavior unchanged, source unified.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { CognitiveAgent } from '../../agent/CognitiveAgent.js';
import { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import { DualTriggerACManager } from '../../decision/DualTriggerACManager.js';
import { AgentContextBuilder, type AgentInfo } from '../../context/AgentContextBuilder.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter as EnvironmentCenterType } from '../../environment/EnvironmentCenter.js';
import type { ResourceManager } from '../../resource/ResourceManager.js';
import type { ServiceRegistry } from '../../service/ServiceRegistry.js';
import { EventType, EventPriority } from '@active-collaboration/shared';
import type { SystemEvent } from '@active-collaboration/shared';

// ===========================================================================
// 1. CognitiveAgent.environmentStateSnapshot — current behavior
// ===========================================================================

function makeEnvParamEvent(payload: {
  parameter: string;
  location: string;
  newValue: number | boolean;
}): SystemEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    type: EventType.ENVIRONMENT_PARAM_CHANGED,
    source: 'pin-test',
    timestamp: new Date(),
    priority: EventPriority.NORMAL,
    payload,
    metadata: {},
  } as SystemEvent;
}

describe('PIN: CognitiveAgent environment snapshot getters (pre-refactor behavior)', () => {
  let agent: CognitiveAgent;
  let environment: EnvironmentCenterType;

  beforeEach(() => {
    // Real EnvironmentCenter (offline-capable; same construction as the
    // p12 CognitiveAgent tests) — the constructor registers the agent with it.
    environment = new EnvironmentCenter({
      id: `pin-env-${Date.now()}`,
      name: 'Pin Env',
      createdBy: 'pin-test',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const stubLLM = {
      chat: vi.fn().mockResolvedValue({ content: 'ok' }),
      quickChat: vi.fn().mockResolvedValue(JSON.stringify({ decision: 'independent', reasoning: 'pin' })),
    } as unknown as LLMClient;

    agent = new CognitiveAgent({
      id: `pin-agent-${Date.now()}`,
      name: 'Pin Agent',
      description: 'pin',
      owner: 'pin-test',
      environment,
      llmClient: stubLLM,
      capabilities: ['temperature-monitoring'],
    });
  });

  it('getEnvironmentStateSnapshot returns key/value/location/timestamp entries', async () => {
    await agent.handleEvent(makeEnvParamEvent({ parameter: 'temperature', location: 'zone-1', newValue: 28.5 }));

    const snapshot = agent.getEnvironmentStateSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].key).toBe('zone-1:temperature');
    expect(snapshot[0].value).toBe(28.5);
    expect(snapshot[0].location).toBe('zone-1');
    expect(snapshot[0].timestamp).toBeInstanceOf(Date);
  });

  it('same location:parameter overwrites (one entry, latest value/timestamp)', async () => {
    await agent.handleEvent(makeEnvParamEvent({ parameter: 'temperature', location: 'zone-1', newValue: 20 }));
    const firstTs = agent.getEnvironmentStateSnapshot()[0].timestamp;
    await new Promise(r => setTimeout(r, 2));
    await agent.handleEvent(makeEnvParamEvent({ parameter: 'temperature', location: 'zone-1', newValue: 22.5 }));

    const snapshot = agent.getEnvironmentStateSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].value).toBe(22.5);
    expect(snapshot[0].timestamp).not.toBe(firstTs);
  });

  it('multiple parameters and boolean values are kept; insertion order preserved', async () => {
    await agent.handleEvent(makeEnvParamEvent({ parameter: 'temperature', location: 'zone-1', newValue: 26 }));
    await agent.handleEvent(makeEnvParamEvent({ parameter: 'humidity', location: 'zone-1', newValue: 65 }));
    await agent.handleEvent(makeEnvParamEvent({ parameter: 'temperature', location: 'zone-1', newValue: 27 }));
    await agent.handleEvent(makeEnvParamEvent({ parameter: 'occupied', location: 'room-A', newValue: true }));

    const snapshot = agent.getEnvironmentStateSnapshot();
    expect(snapshot.map(e => e.key)).toEqual(['zone-1:temperature', 'zone-1:humidity', 'room-A:occupied']);
    expect(snapshot[2].value).toBe(true);
  });

  it('getEnvironmentState point query and full record shapes', async () => {
    const at = new Date();
    await agent.handleEvent(makeEnvParamEvent({ parameter: 'temperature', location: 'zone-1', newValue: 26 }));

    const point = agent.getEnvironmentState('temperature', 'zone-1');
    expect(point.value).toBe(26);
    expect(point.timestamp).toBeInstanceOf(Date);
    expect(point.timestamp.getTime()).toBeGreaterThanOrEqual(at.getTime() - 1000);
    expect(agent.getEnvironmentState('humidity', 'zone-1')).toEqual({});

    const full = agent.getEnvironmentState();
    expect(Object.keys(full)).toEqual(['zone-1:temperature']);
    const entry = full['zone-1:temperature'] as { value: number; location: string; timestamp: Date };
    expect(entry.value).toBe(26);
    expect(entry.location).toBe('zone-1');
  });

  it('non-param events do not touch the snapshot', async () => {
    await agent.handleEvent({
      id: 'e2', type: EventType.COLLABORATION_STARTED, source: 'pin', timestamp: new Date(),
      priority: EventPriority.NORMAL, payload: {}, metadata: {},
    } as unknown as SystemEvent);
    expect(agent.getEnvironmentStateSnapshot()).toHaveLength(0);
  });
});

// ===========================================================================
// 2. DualTriggerACManager.buildAgentContext — current behavior
// ===========================================================================

interface ManagerTestAccess {
  resourceManager: ResourceManager | undefined;
  serviceRegistry: ServiceRegistry | undefined;
  activeACs: Map<string, unknown>;
}

describe('PIN: DualTriggerACManager.buildAgentContext (pre-refactor behavior)', () => {
  let manager: DualTriggerACManager;
  let mockEnvironment: EnvironmentCenter;
  let getResource: Mock;
  let getOwnServices: Mock;
  let access: ManagerTestAccess;

  beforeEach(() => {
    const mockLLMClient = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
    getResource = vi.fn();
    getOwnServices = vi.fn().mockReturnValue([]);
    mockEnvironment = {
      listDevices: vi.fn().mockReturnValue([]),
      listAgents: vi.fn().mockResolvedValue([]),
      getParameters: vi.fn().mockReturnValue({ globalTemp: 25 }),
      getServices: vi.fn().mockReturnValue(new Map()),
      physicalEnvironment: {
        getZone: vi.fn(),
      },
      eventManager: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() },
    } as unknown as EnvironmentCenter;

    manager = new DualTriggerACManager(
      'agent-1', 'TestAgent', ['temperature-control'],
      mockLLMClient, mockEnvironment, vi.fn(),
      { enableLayer1: false, enableLayer2: true, autoInitiateAC: false },
    );
    access = manager as unknown as ManagerTestAccess;
    access.resourceManager = { getResource } as unknown as ResourceManager;
    access.serviceRegistry = { getOwnServices } as unknown as ServiceRegistry;
  });

  it('availableResources: agentDevices enriched with resource state, availability and zoneId fallback', async () => {
    manager.setAgentDevices([
      {
        deviceId: 'hvac-1', type: 'actuator', capabilities: ['temperature-control'],
        zoneId: 'zone-a',
      },
      {
        deviceId: 'sensor-1', type: 'sensor', capabilities: ['temperature-sensing'],
        zoneId: 'zone-b',
      },
    ]);
    getResource.mockImplementation((id: string) =>
      id === 'hvac-1'
        ? {
            getState: () => ({ power: 'on' }),
            isAvailable: () => true,
            location: 'zone-a',
          }
        : null,
    );

    const ctx = await manager.buildAgentContext();
    expect(ctx.availableResources).toEqual([
      {
        deviceId: 'hvac-1', type: 'actuator', capabilities: ['temperature-control'],
        currentState: { power: 'on' }, location: 'zone-a', isOnline: true,
      },
      {
        deviceId: 'sensor-1', type: 'sensor', capabilities: ['temperature-sensing'],
        currentState: {}, location: 'zone-b', isOnline: true,
      },
    ]);
  });

  it('capabilities surface = declared ∪ device-derived (T-202), environmentState from getParameters', async () => {
    manager.setAgentDevices([
      { deviceId: 'd1', type: 'actuator', capabilities: ['humidity-control'], zoneId: 'z' },
    ]);
    getResource.mockReturnValue(null);

    const ctx = await manager.buildAgentContext();
    expect(ctx.capabilities).toEqual(['temperature-control', 'humidity-control']);
    expect(ctx.environmentState).toEqual({ globalTemp: 25 });
  });

  it('managedZoneIds from own service locations; discoverableServices from other agents (Service layer)', async () => {
    (mockEnvironment.getServices as Mock).mockReturnValue(new Map([
      ['svc-1', { agentId: 'agent-1', service: { name: 'Own Service', capabilities: ['temperature-control'], location: 'zone-a' } }],
      ['svc-2', { agentId: 'agent-2', service: { name: 'Partner Service', capabilities: ['cooling'], location: 'zone-b' } }],
    ]));

    const ctx = await manager.buildAgentContext();
    expect(ctx.managedZoneIds).toEqual(['zone-a']);
    expect(ctx.discoverableServices).toEqual([
      { serviceName: 'Partner Service', capabilities: ['cooling'], providerAgentId: 'agent-2', location: 'zone-b' },
    ]);
  });

  it('actuator/adjacent zones from config take priority; physicalEnvironment fallback otherwise', async () => {
    manager.setAgentDevices([{ deviceId: 'd1', type: 'actuator', capabilities: ['temperature-control'], zoneId: 'zone-a' }]);
    getResource.mockReturnValue(null);
    (mockEnvironment.getServices as Mock).mockReturnValue(new Map([
      ['svc-1', { agentId: 'agent-1', service: { name: 'S', capabilities: [], location: 'zone-a' } }],
    ]));
    (mockEnvironment.physicalEnvironment as { getZone: Mock }).getZone.mockReturnValue({ adjacentZoneIds: ['zone-c'] });

    const ctxConfig = await manager.buildAgentContext();
    expect(ctxConfig.actuatorZoneIds).toEqual([]); // no config, fallback logs device zones as unknown → empty
    expect(ctxConfig.adjacentZoneIds).toEqual(['zone-c']); // physicalEnvironment fallback over managed zones
  });

  it('workload maps active AC count vs maxConcurrentACs', async () => {
    manager.setAgentDevices([]);
    getResource.mockReturnValue(null);

    const idle = await manager.buildAgentContext();
    expect(idle.currentWorkload).toBe('idle');

    access.activeACs.set('ac-1', {});
    const light = await manager.buildAgentContext();
    expect(light.currentWorkload).toBe('light');
  });
});

// ===========================================================================
// 3. AgentContextBuilder — current behavior
// ===========================================================================

function makeContextBuilderDeps() {
  const resourceManager = {
    getAllResources: vi.fn().mockReturnValue([]),
    getResource: vi.fn(),
  } as unknown as ResourceManager;
  const serviceRegistry = {
    getAllServices: vi.fn().mockReturnValue([]),
  } as unknown as ServiceRegistry;
  const environment = {
    id: 'env-pin',
    name: 'Pin Environment',
    listAgents: vi.fn().mockResolvedValue([]),
    listDevicesVisibleTo: vi.fn().mockReturnValue([]),
    physicalEnvironment: {
      getAllParameters: vi.fn().mockReturnValue({ temperature: 21.5, humidity: 44 }),
      getSpatialManager: vi.fn().mockReturnValue({
        getAllZones: vi.fn().mockReturnValue([
          { id: 'zone-a', name: 'Zone A', location: 'loc-a', state: { temperature: 22 } },
        ]),
      }),
    },
  } as unknown as EnvironmentCenter;
  const agentInfo: AgentInfo = {
    id: 'agent-1', name: 'Pin Agent', description: 'pin agent',
    capabilities: ['sense'], status: 'online',
  };
  return { resourceManager, serviceRegistry, environment, agentInfo };
}

describe('PIN: AgentContextBuilder full context (pre-refactor behavior)', () => {
  it('environment state projects physicalEnvironment parameters and spatial zones', async () => {
    const deps = makeContextBuilderDeps();
    const builder = new AgentContextBuilder(
      deps.agentInfo, deps.resourceManager, deps.serviceRegistry, deps.environment,
    );

    const context = await builder.buildFullContext();
    expect(context.self).toEqual({
      id: 'agent-1', name: 'Pin Agent', description: 'pin agent',
      capabilities: ['sense'], role: 'general', status: 'online',
    });
    expect(context.environment.id).toBe('env-pin');
    expect(context.environment.name).toBe('Pin Environment');
    expect(context.environment.type).toBe('environment');
    expect(context.environment.physicalState).toEqual({ temperature: 21.5, humidity: 44 });
    expect(context.environment.zones).toEqual([
      { id: 'zone-a', name: 'Zone A', location: 'loc-a', state: { temperature: 22 } },
    ]);
    expect(context.resources).toEqual([]);
    expect(context.availableServices).toEqual({ own: [], fromPeers: [] });
    expect(context.peerAgents).toEqual([]);
    expect(context.temporal.currentTime).toBeInstanceOf(Date);
  });

  it('legacy formatContextForLLM renders the documented section headings', async () => {
    const deps = makeContextBuilderDeps();
    const builder = new AgentContextBuilder(
      deps.agentInfo, deps.resourceManager, deps.serviceRegistry, deps.environment,
    );
    const context = await builder.buildFullContext();
    const formatted = builder.formatContextForLLM(context, 'do the thing');

    expect(formatted).toContain('## Agent Identity');
    expect(formatted).toContain('- **Name**: Pin Agent');
    expect(formatted).toContain('## Environment State');
    expect(formatted).toContain('- **Physical Parameters**:');
    expect(formatted).toContain('- **Zones**:');
    expect(formatted).toContain('## Available Resources (Devices)');
    expect(formatted).toContain('## Current Task\ndo the thing');
    expect(formatted).toContain('## Temporal Information');
  });
});
