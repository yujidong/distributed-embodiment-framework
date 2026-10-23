/**
 * R42-A/F3 §7.1: the sim-registry seam wires each agent's `listMyServices`
 * (the AC responder's service face) to its serviceStore rows — derived +
 * published, read LIVE at handshake-evaluation time. Env-backed sims only;
 * legacy scenario sims keep the empty face (mechanism naturally silent).
 */

import { describe, it, expect } from 'vitest';
import type { EngineRuntime, ScenarioDefinition } from '@active-collaboration/core';

import { SimulationSeams } from './seams.js';
import type { ServiceStore, ServiceInstanceRow } from '../db/service-store.js';

function makeAgent() {
  let provider: (() => Array<{ name: string; semanticType: string; visibility?: string }>) | undefined;
  return {
    setMyServicesProvider: (p: typeof provider) => {
      provider = p;
    },
    listMyServices: () => provider?.() ?? [],
  };
}

function makeRuntime(agentIds: string[]) {
  const agents = new Map(agentIds.map(id => [id, makeAgent()]));
  const runtime = {
    getAgent: (id: string) => agents.get(id),
  } as unknown as EngineRuntime;
  return { runtime, agents };
}

function makeRecord(runtime: EngineRuntime, environmentId?: string) {
  return {
    id: 'sim-test',
    scenarioId: 'test',
    environmentId,
    runtime,
    scenario: {
      meta: { id: 'test', name: 'Test' },
      agents: [{ id: 'butler-a' }, { id: 'center-b' }],
      zones: [],
      devices: [],
    } as unknown as ScenarioDefinition,
  } as Parameters<SimulationSeams['attach']>[0];
}

function serviceRow(overrides: Partial<ServiceInstanceRow>): ServiceInstanceRow {
  return {
    id: 'svc',
    env_id: 'env-1',
    provider_agent_id: 'butler-a',
    name: '夜间制冷',
    semantic_type: 'temperature-control',
    description: '',
    interface_json: '{}',
    origin: 'derived',
    source_device_id: null,
    source_flow_id: null,
    visibility: 'public',
    zone_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ServiceInstanceRow;
}

function makeSeams(serviceStore?: ServiceStore): SimulationSeams {
  return new SimulationSeams({
    ...(serviceStore !== undefined ? { serviceStore } : {}),
    zoneSampleEverySimSec: 60,
    simTimelineMaxBytes: 1024 * 1024,
    rollupWindowMs: 0,
  });
}

describe('SimulationSeams — agent service surface wiring (R42-A/F3 §7.1)', () => {
  it('env-backed sims: every agent\'s listMyServices reads its own store rows live', () => {
    const rows = [serviceRow({ id: 'svc-1', provider_agent_id: 'butler-a' })];
    const serviceStore = { servicesOf: (_envId: string) => rows } as unknown as ServiceStore;
    const { runtime, agents } = makeRuntime(['butler-a', 'center-b']);

    makeSeams(serviceStore).attach(makeRecord(runtime, 'env-1'), {});

    // The provider filters by provider_agent_id: butler-a sees its row,
    // center-b gets an empty face. P5: origin rides the face (funnel).
    expect(agents.get('butler-a')!.listMyServices()).toEqual([
      { name: '夜间制冷', semanticType: 'temperature-control', visibility: 'public', origin: 'derived' },
    ]);
    expect(agents.get('center-b')!.listMyServices()).toEqual([]);

    // LIVE read: a row minted after wiring shows up at the next evaluation.
    rows.push(serviceRow({ id: 'svc-2', provider_agent_id: 'butler-a', name: '新风', semantic_type: 'ventilation' }));
    expect(agents.get('butler-a')!.listMyServices()).toHaveLength(2);
  });

  it('legacy scenario sims (no environmentId) and missing store keep the empty face', () => {
    const rows = [serviceRow({})];
    const serviceStore = { servicesOf: () => rows } as unknown as ServiceStore;

    const withStore = makeRuntime(['butler-a', 'center-b']);
    makeSeams(serviceStore).attach(makeRecord(withStore.runtime), {});
    expect(withStore.agents.get('butler-a')!.listMyServices()).toEqual([]);

    const noStore = makeRuntime(['butler-a', 'center-b']);
    makeSeams().attach(makeRecord(noStore.runtime, 'env-1'), {});
    expect(noStore.agents.get('butler-a')!.listMyServices()).toEqual([]);
  });
});
