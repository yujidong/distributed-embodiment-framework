/**
 * Track F 信息分级 tests: the rowBrief lib field assembly plus the
 * three-level disclosure interaction — clicking a sidebar row expands the
 * inline brief WITHOUT opening the detail; only the brief's
 * 「View full details」 button selects the object/service.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { EnvironmentDetail, WorldAgent, WorldDevice, WorldService } from '../api/types';
import { agentBrief, deviceBrief, serviceBrief } from '../lib/rowBrief';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { WorldSidebar } from '../components/world/WorldSidebar';
import { ServicesPanel } from '../components/world/ServicesPanel';
import { renderWithProviders } from './testUtils';

function makeDevice(overrides: Partial<WorldDevice> = {}): WorldDevice {
  return {
    id: 'dev-1',
    envId: 'env-1',
    name: '客厅空调',
    type: 'air_conditioner',
    brand: null,
    capabilities: ['cooling', 'heating'],
    zoneId: 'zone-1',
    position: null,
    initialState: null,
    binding: 'sim://dev-1',
    owner: { id: 'u-me', displayName: '小A' },
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeAgent(overrides: Partial<WorldAgent> = {}): WorldAgent {
  return {
    id: 'agent-1',
    envId: 'env-1',
    name: '空调管家',
    capabilities: ['cooling'],
    boundDeviceIds: ['dev-1', 'dev-2'],
    managedZoneIds: ['zone-1'],
    llm: null,
    enabled: true,
    owner: { id: 'u-me', displayName: '小A' },
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeService(overrides: Partial<WorldService> = {}): WorldService {
  return {
    id: 'svc-1',
    envId: 'env-1',
    name: '空调控制',
    semanticType: 'cooling',
    description: '',
    interface: {},
    origin: 'derived',
    sourceDeviceId: null,
    visibility: 'public',
    unbacked: false,
    consumable: true,
    provider: { id: 'agent-1', name: '空调管家', owner: { id: 'u-me', displayName: '小A' } },
    reputation: { score: 0.7, attempts: 0, successes: 0 },
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeWorld(overrides: Partial<EnvironmentDetail> = {}): EnvironmentDetail {
  return {
    id: 'env-1',
    name: '测试环境',
    description: '',
    mapType: 'grid',
    mapCenter: null,
    mapZoom: null,
    storeyHeight: null,
    floorPlans: [],
    semanticOfferRules: [],
    capabilitySynonyms: [],
    visibility: 'private',
    owner: { id: 'u-me', displayName: '小A' },
    zones: [{ id: 'zone-1', name: '客厅' }],
    events: [],
    devices: [],
    agents: [],
    services: [],
    members: [],
    governance: {
      proposalReview: 'ai-assisted-auto-apply',
      notes: '',
      supervisedZones: [],
      supervisedZoneNote: '',
      humanReview: { maxAgentsPerProposal: 0, maxEventsPerProposal: 0, maxZonesTouched: 0 },
      humanReviewNote: '',
    },
    myRole: 'viewer',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('rowBrief lib', () => {
  it('deviceBrief assembles type · zone · capability count', () => {
    expect(deviceBrief(makeDevice(), '客厅')).toEqual({
      type: 'air_conditioner',
      zoneName: '客厅',
      capabilityCount: 2,
    });
  });

  it('agentBrief reports counts, LLM status and no reputation without services', () => {
    const brief = agentBrief(makeAgent(), []);
    expect(brief.deviceCount).toBe(2);
    expect(brief.zoneCount).toBe(1);
    expect(brief.llm).toBeNull();
    expect(brief.reputation).toBeNull();
  });

  it('agentBrief formats the LLM label and aggregates reputation across offers', () => {
    const agent = makeAgent({ llm: { provider: 'openai', model: 'gpt-x' } });
    const services = [
      makeService({ reputation: { score: 0.9, attempts: 10, successes: 9 } }),
      makeService({
        id: 'svc-2',
        semanticType: 'heating',
        reputation: { score: 0.5, attempts: 5, successes: 2.5 },
      }),
    ];
    const brief = agentBrief(agent, services);
    expect(brief.llm).toBe('openai/gpt-x');
    // Attempts-weighted average: (0.9*10 + 0.5*5) / 15.
    expect(brief.reputation?.attempts).toBe(15);
    expect(brief.reputation?.score).toBeCloseTo(11.5 / 15, 6);
  });

  it('serviceBrief blanks an empty description and labels the provider', () => {
    expect(serviceBrief(makeService()).description).toBeNull();
    expect(serviceBrief(makeService({ description: ' 温控 ' })).description).toBe(' 温控 ');
    expect(serviceBrief(makeService()).providerLabel).toBe('空调管家（小A）');
  });
});

describe('Track F row → brief → detail disclosure', () => {
  beforeAll(() => {
    void i18n.changeLanguage('en-US');
  });

  beforeEach(() => {
    useAppStore.setState({ user: null, selection: null, selectedServiceId: null });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ user: null, selection: null, selectedServiceId: null });
  });

  it('device row click expands the brief; only the detail button selects the device', () => {
    const world = makeWorld({ devices: [makeDevice()] });
    renderWithProviders(<WorldSidebar world={world} tab="devices" onTabChange={() => {}} />);

    // Collapsed: name only, no meta line.
    expect(screen.queryByText(/Capabilities \(2\)/)).toBeNull();

    fireEvent.click(screen.getByText('客厅空调'));
    // Brief opens inline; the device is NOT selected yet.
    expect(screen.getByText(/air_conditioner · 客厅 · Capabilities \(2\)/)).toBeTruthy();
    expect(useAppStore.getState().selection).toBeNull();

    fireEvent.click(screen.getByText('View full details'));
    expect(useAppStore.getState().selection).toEqual({ objectType: 'device', id: 'dev-1' });
  });

  it('agent row click expands the brief; only the detail button selects the agent', () => {
    const world = makeWorld({ agents: [makeAgent()] });
    renderWithProviders(<WorldSidebar world={world} tab="agents" onTabChange={() => {}} />);

    fireEvent.click(screen.getByText('空调管家'));
    expect(screen.getByText(/2 bound device\(s\) · 1 managed zone\(s\)/)).toBeTruthy();
    expect(screen.getByText(/LLM · None \(rule-only\)/)).toBeTruthy();
    expect(useAppStore.getState().selection).toBeNull();

    fireEvent.click(screen.getByText('View full details'));
    expect(useAppStore.getState().selection).toEqual({ objectType: 'agent', id: 'agent-1' });
  });

  it('service row click expands the brief; only the detail button selects the service', () => {
    const world = makeWorld({ services: [makeService({ description: '远程温控' })] });
    renderWithProviders(<ServicesPanel world={world} onShowDevice={() => {}} />);

    // Collapsed: provider meta and description stay out of the row.
    expect(screen.queryByText(/空调管家（小A）/)).toBeNull();

    fireEvent.click(screen.getByText('空调控制'));
    expect(screen.getByText(/空调管家（小A）/)).toBeTruthy();
    expect(screen.getByText('远程温控')).toBeTruthy();
    expect(useAppStore.getState().selectedServiceId).toBeNull();

    fireEvent.click(screen.getByText('View full details'));
    expect(useAppStore.getState().selectedServiceId).toBe('svc-1');
  });

  it('service detail collapses description and interface behind toggles', () => {
    const world = makeWorld({
      services: [makeService({ description: '远程温控', interface: { temperature: 'number' } })],
    });
    useAppStore.setState({ selectedServiceId: 'svc-1' });
    renderWithProviders(<ServicesPanel world={world} onShowDevice={() => {}} />);

    // Both sections render as collapsed toggles: content hidden until opened.
    expect(screen.queryByText('远程温控')).toBeNull();
    expect(screen.queryByText(/temperature/)).toBeNull();

    fireEvent.click(screen.getByText('Description'));
    expect(screen.getByText('远程温控')).toBeTruthy();
    fireEvent.click(screen.getByText('Interface params'));
    expect(screen.getByText(/temperature/)).toBeTruthy();
  });
});
