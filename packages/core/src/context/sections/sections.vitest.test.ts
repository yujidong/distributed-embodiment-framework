/**
 * Tests for Basic Context Sections
 *
 * Tests for AgentIdentitySection, EnvironmentSection, ResourcesSection,
 * ServicesSection, PeersSection, TemporalSection, TaskSection
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentIdentitySection } from './AgentIdentitySection.js';
import { EnvironmentSection } from './EnvironmentSection.js';
import { ResourcesSection } from './ResourcesSection.js';
import { ServicesSection } from './ServicesSection.js';
import { PeersSection } from './PeersSection.js';
import { TemporalSection } from './TemporalSection.js';
import { TaskSection } from './TaskSection.js';
import type { SectionContext } from './ContextSection.js';
import type { AgentInfo, DeviceStateInfo, ServiceInfo, PeerAgentInfo, EnvironmentState } from '../AgentContextBuilder.js';

/**
 * Helper function to create a mock SectionContext
 */
function createMockSectionContext(overrides: Partial<SectionContext> = {}): SectionContext {
  const mockAgent: AgentInfo = {
    id: 'agent-1',
    name: 'Test Agent',
    description: 'Test agent description',
    capabilities: ['sense', 'actuate'],
    status: 'online',
    metadata: { role: 'test-role' },
  };

  const mockEnvironment: EnvironmentState = {
    id: 'env-1',
    name: 'Test Environment',
    type: 'smart-home',
    physicalState: { temperature: 22.5, humidity: 45 },
    zones: [
      { id: 'zone-1', name: 'Living Room', location: 'living-room', state: { temperature: 23 } },
    ],
  };

  const mockResources: DeviceStateInfo[] = [
    {
      id: 'device-1',
      name: 'Temperature Sensor',
      type: 'sensor',
      location: 'living-room',
      capabilities: ['temperature-reading'],
      currentState: { temperature: 22.5 },
      isOnline: true,
      lastUpdate: new Date(),
    },
  ];

  const mockServices: ServiceInfo[] = [
    {
      id: 'service-1',
      name: 'Temperature Service',
      providerAgentId: 'agent-1',
      providerAgentName: 'Test Agent',
      category: 'monitoring',
      capabilities: ['read-temperature'],
      status: 'available',
      description: 'Temperature monitoring service',
    },
  ];

  const mockPeers: PeerAgentInfo[] = [
    {
      id: 'agent-2',
      name: 'Peer Agent',
      capabilities: ['control'],
      services: [],
      status: 'online',
    },
  ];

  return {
    agent: mockAgent,
    environment: mockEnvironment,
    resources: mockResources,
    services: {
      own: mockServices,
      fromPeers: [],
    },
    peers: mockPeers,
    temporal: {
      currentTime: new Date('2024-01-15T10:30:00Z'),
      timeScale: 1,
    },
    ...overrides,
  };
}

describe('AgentIdentitySection', () => {
  let section: AgentIdentitySection;

  beforeEach(() => {
    section = new AgentIdentitySection();
  });

  it('should have correct id and priority', () => {
    expect(section.id).toBe('agent-identity');
    expect(section.priority).toBe(100);
  });

  it('should always include', () => {
    const context = createMockSectionContext();
    expect(section.shouldInclude(context)).toBe(true);
  });

  it('should build agent identity content', async () => {
    const context = createMockSectionContext();
    const content = await section.build(context);

    expect(content).toContain('## Agent Identity');
    expect(content).toContain('Test Agent');
    expect(content).toContain('agent-1');
    expect(content).toContain('test-role');
    expect(content).toContain('sense, actuate');
    expect(content).toContain('online');
  });

  it('should return metadata', () => {
    const metadata = section.getMetadata();
    expect(metadata.id).toBe('agent-identity');
    expect(metadata.priority).toBe(100);
  });
});

describe('EnvironmentSection', () => {
  let section: EnvironmentSection;

  beforeEach(() => {
    section = new EnvironmentSection();
  });

  it('should have correct id and priority', () => {
    expect(section.id).toBe('environment');
    expect(section.priority).toBe(95);
  });

  it('should always include', () => {
    const context = createMockSectionContext();
    expect(section.shouldInclude(context)).toBe(true);
  });

  it('should build environment content with physical state', async () => {
    const context = createMockSectionContext();
    const content = await section.build(context);

    expect(content).toContain('## Environment State');
    expect(content).toContain('Test Environment');
    expect(content).toContain('smart-home');
    expect(content).toContain('temperature');
    expect(content).toContain('22.5');
  });

  it('should build environment content with zones', async () => {
    const context = createMockSectionContext();
    const content = await section.build(context);

    expect(content).toContain('Zones');
    expect(content).toContain('Living Room');
  });

  it('should handle missing physical state', async () => {
    const context = createMockSectionContext({
      environment: { id: 'env-1', name: 'Basic Environment', type: 'simple' },
    });
    const content = await section.build(context);

    expect(content).toContain('## Environment State');
    expect(content).toContain('Basic Environment');
  });
});

describe('ResourcesSection', () => {
  let section: ResourcesSection;

  beforeEach(() => {
    section = new ResourcesSection();
  });

  it('should have correct id and priority', () => {
    expect(section.id).toBe('resources');
    expect(section.priority).toBe(90);
  });

  it('should only include when resources exist', () => {
    const contextWithResources = createMockSectionContext();
    const contextWithoutResources = createMockSectionContext({ resources: [] });

    expect(section.shouldInclude(contextWithResources)).toBe(true);
    expect(section.shouldInclude(contextWithoutResources)).toBe(false);
  });

  it('should build resources content', async () => {
    const context = createMockSectionContext();
    const content = await section.build(context);

    expect(content).toContain('## Available Resources');
    expect(content).toContain('Temperature Sensor');
    expect(content).toContain('sensor');
    expect(content).toContain('living-room');
    expect(content).toContain('temperature-reading');
    expect(content).toContain('22.5');
  });

  it('should show online status correctly', async () => {
    const context = createMockSectionContext();
    const content = await section.build(context);

    expect(content).toContain('**Online**: Yes');
  });

  it('should handle offline resources', async () => {
    const context = createMockSectionContext({
      resources: [
        {
          id: 'device-2',
          name: 'Offline Device',
          type: 'actuator',
          capabilities: ['control'],
          currentState: {},
          isOnline: false,
        },
      ],
    });
    const content = await section.build(context);

    expect(content).toContain('Offline Device');
    expect(content).toContain('**Online**: No');
  });
});

describe('ServicesSection', () => {
  let section: ServicesSection;

  beforeEach(() => {
    section = new ServicesSection();
  });

  it('should have correct id and priority', () => {
    expect(section.id).toBe('services');
    expect(section.priority).toBe(80);
  });

  it('should include when any services exist', () => {
    const contextWithOwn = createMockSectionContext();
    const contextWithPeer = createMockSectionContext({
      services: { own: [], fromPeers: [{ id: 's1', name: 'Peer Service', providerAgentId: 'a1', providerAgentName: 'A1', category: 'test', capabilities: [], status: 'available' }] },
    });
    const contextWithout = createMockSectionContext({ services: { own: [], fromPeers: [] } });

    expect(section.shouldInclude(contextWithOwn)).toBe(true);
    expect(section.shouldInclude(contextWithPeer)).toBe(true);
    expect(section.shouldInclude(contextWithout)).toBe(false);
  });

  it('should build own services content', async () => {
    const context = createMockSectionContext();
    const content = await section.build(context);

    expect(content).toContain('## Available Services');
    expect(content).toContain('Your Services');
    expect(content).toContain('Temperature Service');
    expect(content).toContain('Temperature monitoring service');
  });

  it('should build peer services content', async () => {
    const context = createMockSectionContext({
      services: {
        own: [],
        fromPeers: [
          {
            id: 'peer-service-1',
            name: 'Peer HVAC Service',
            providerAgentId: 'agent-2',
            providerAgentName: 'Peer Agent',
            category: 'control',
            capabilities: ['hvac-control'],
            status: 'available',
            description: 'HVAC control service',
          },
        ],
      },
    });
    const content = await section.build(context);

    expect(content).toContain('Services from Other Agents');
    expect(content).toContain('Peer HVAC Service');
    expect(content).toContain('from Peer Agent');
  });
});

describe('PeersSection', () => {
  let section: PeersSection;

  beforeEach(() => {
    section = new PeersSection();
  });

  it('should have correct id and priority', () => {
    expect(section.id).toBe('peers');
    expect(section.priority).toBe(70);
  });

  it('should only include when peers exist', () => {
    const contextWithPeers = createMockSectionContext();
    const contextWithoutPeers = createMockSectionContext({ peers: [] });

    expect(section.shouldInclude(contextWithPeers)).toBe(true);
    expect(section.shouldInclude(contextWithoutPeers)).toBe(false);
  });

  it('should build peers content', async () => {
    const context = createMockSectionContext({
      peers: [
        {
          id: 'agent-2',
          name: 'Climate Agent',
          capabilities: ['hvac-control', 'temperature-monitoring'],
          services: [
            { id: 's1', name: 'HVAC Service', providerAgentId: 'agent-2', providerAgentName: 'Climate Agent', category: 'control', capabilities: ['hvac'], status: 'available' },
          ],
          status: 'online',
        },
      ],
    });
    const content = await section.build(context);

    expect(content).toContain('## Peer Agents');
    expect(content).toContain('Climate Agent');
    expect(content).toContain('hvac-control');
    expect(content).toContain('HVAC Service');
  });

  it('should handle peers without services', async () => {
    const context = createMockSectionContext({
      peers: [
        {
          id: 'agent-2',
          name: 'Basic Agent',
          capabilities: ['sense'],
          services: [],
          status: 'online',
        },
      ],
    });
    const content = await section.build(context);

    expect(content).toContain('Basic Agent');
    expect(content).toContain('None');
  });
});

describe('TemporalSection', () => {
  let section: TemporalSection;

  beforeEach(() => {
    section = new TemporalSection();
  });

  it('should have correct id and priority', () => {
    expect(section.id).toBe('temporal');
    expect(section.priority).toBe(40);
  });

  it('should always include', () => {
    const context = createMockSectionContext();
    expect(section.shouldInclude(context)).toBe(true);
  });

  it('should build temporal content', async () => {
    const context = createMockSectionContext();
    const content = await section.build(context);

    expect(content).toContain('## Temporal Information');
    expect(content).toContain('Current Time');
    expect(content).toContain('2024-01-15');
  });

  it('should include time scale when available', async () => {
    const context = createMockSectionContext({
      temporal: { currentTime: new Date('2024-01-15T10:30:00Z'), timeScale: 2 },
    });
    const content = await section.build(context);

    expect(content).toContain('Time Scale');
    expect(content).toContain('2x');
  });
});

describe('TaskSection', () => {
  let section: TaskSection;

  beforeEach(() => {
    section = new TaskSection();
  });

  it('should have correct id and priority', () => {
    expect(section.id).toBe('task');
    expect(section.priority).toBe(60);
  });

  it('should only include when task is provided', () => {
    const contextWithTask = createMockSectionContext({ task: 'Control temperature' });
    const contextWithoutTask = createMockSectionContext();

    expect(section.shouldInclude(contextWithTask)).toBe(true);
    expect(section.shouldInclude(contextWithoutTask)).toBe(false);
  });

  it('should build task content', async () => {
    const context = createMockSectionContext({ task: 'Control temperature in the living room' });
    const content = await section.build(context);

    expect(content).toContain('## Current Task');
    expect(content).toContain('Control temperature in the living room');
  });
});

describe('Section Priority Ordering', () => {
  it('should have correct priority ordering', () => {
    const sections = [
      new AgentIdentitySection(),
      new EnvironmentSection(),
      new ResourcesSection(),
      new ServicesSection(),
      new PeersSection(),
      new TaskSection(),
      new TemporalSection(),
    ];

    // Sort by priority descending
    const sorted = [...sections].sort((a, b) => b.priority - a.priority);

    expect(sorted[0].id).toBe('agent-identity');  // 100
    expect(sorted[1].id).toBe('environment');     // 95
    expect(sorted[2].id).toBe('resources');       // 90
    expect(sorted[3].id).toBe('services');        // 80
    expect(sorted[4].id).toBe('peers');           // 70
    expect(sorted[5].id).toBe('task');            // 60
    expect(sorted[6].id).toBe('temporal');        // 40
  });
});
