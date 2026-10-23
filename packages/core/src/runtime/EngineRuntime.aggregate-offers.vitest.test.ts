/**
 * @vitest-environment node
 *
 * P3: runtime-side aggregate (semantic) offers — the core-only twin of the
 * world layer's R53 syncAggregateOffers. When an agent's device binding is
 * assembled, EngineRuntime runs semanticOffersOf over the agent's
 * capability union (declared + bound-device capabilities) under the merged
 * rule table (built-ins + scenario rules + operator option rules) and
 * registers each hit into the EnvironmentCenter with origin='aggregate'
 * under the `aggregate:<agentId>:<semanticType>` device slot.
 *
 * The world-layer mirror side (catalog-sync sweeping these keys in favor of
 * the DB rows) is pinned in apps/server/src — here only core behavior.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime } from './index.js';

const QUIET_RULE = {
  semanticType: 'library-quiet-guard',
  label: '图书馆静音保障',
  description: '噪声监测联动情报板播控提醒，维持阅览区安静。',
  requires: ['noise-monitoring', 'content-display'],
  actuates: ['set-message'],
} as const;

function campusWorld() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'aggregate-offers-test', name: 'Aggregate Offers Test' },
    zones: [{ id: 'zone-a', name: 'Zone A' }],
    devices: [
      // 泵站组合：命中内置 drainage-control。
      {
        id: 'pump-a',
        type: 'water-pump',
        capabilities: ['valve-control', 'water-level-monitoring', 'turn-on'],
        zoneId: 'zone-a',
      },
      // 噪声+情报板组合：命中场景自定义 library-quiet-guard。
      {
        id: 'noise-sensor-a',
        type: 'noise-sensor',
        capabilities: ['noise-monitoring'],
        zoneId: 'zone-a',
      },
      {
        id: 'display-a',
        type: 'display',
        capabilities: ['content-display', 'set-message'],
        zoneId: 'zone-a',
      },
      // 纯观测设备：任何规则都没有 actuation backing。
      {
        id: 'weather-a',
        type: 'weather-station',
        capabilities: ['weather-monitoring', 'wind-monitoring'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'steward',
        name: 'Steward',
        capabilities: [],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['pump-a', 'noise-sensor-a', 'display-a'],
      },
      {
        id: 'observer',
        name: 'Observer',
        capabilities: [],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['weather-a'],
      },
    ],
    events: [],
    semanticOfferRules: [QUIET_RULE],
  });
}

const runtimes: EngineRuntime[] = [];

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
});

function aggregateRegistrations(runtime: EngineRuntime) {
  return [...runtime.getEnvironmentCenter().getServices().entries()].filter(([key]) =>
    key.startsWith('aggregate:'),
  );
}

describe('P3 — runtime aggregate (semantic) offers', () => {
  it('a binding combination hitting a rule registers origin=aggregate services', () => {
    const runtime = new EngineRuntime(campusWorld());
    runtimes.push(runtime);

    const registrations = aggregateRegistrations(runtime);
    const keys = registrations.map(([key]) => key).sort();
    expect(keys).toEqual([
      'aggregate:steward:drainage-control:区域排涝调度',
      'aggregate:steward:library-quiet-guard:图书馆静音保障',
    ]);

    const [, drainage] = registrations.find(([key]) => key.includes('drainage-control'))!;
    expect(drainage.agentId).toBe('steward');
    expect(drainage.origin).toBe('aggregate');
    expect(drainage.semanticType).toBe('drainage-control');
    expect(drainage.visibility).toBe('members');
    // Discovery-facing Service shape: category = semantic type, actuation
    // backing = capabilities, provider metadata attached.
    expect(drainage.service.category).toBe('drainage-control');
    expect(drainage.service.capabilities).toEqual(['valve-control']);
    expect(drainage.service.providerAgentId).toBe('steward');

    const [, quiet] = registrations.find(([key]) => key.includes('library-quiet-guard'))!;
    expect(quiet.service.capabilities).toEqual(['set-message']);
  });

  it('an observation-only bundle registers nothing', () => {
    const runtime = new EngineRuntime(campusWorld());
    runtimes.push(runtime);
    const observerRegs = aggregateRegistrations(runtime).filter(([, reg]) =>
      reg.agentId === 'observer',
    );
    expect(observerRegs).toHaveLength(0);
  });

  it('options.semanticOfferRules merge over the built-ins too (operator channel)', () => {
    const scenario = campusWorld();
    // 场景不带规则时，operator 注入的规则同样生效。
    delete scenario.semanticOfferRules;
    const runtime = new EngineRuntime(scenario, { semanticOfferRules: [{ ...QUIET_RULE }] });
    runtimes.push(runtime);
    const keys = aggregateRegistrations(runtime).map(([key]) => key).sort();
    expect(keys).toEqual([
      'aggregate:steward:drainage-control:区域排涝调度',
      'aggregate:steward:library-quiet-guard:图书馆静音保障',
    ]);
  });

  it('no rules anywhere (default) = built-in table only', () => {
    const scenario = campusWorld();
    delete scenario.semanticOfferRules;
    const runtime = new EngineRuntime(scenario);
    runtimes.push(runtime);
    const keys = aggregateRegistrations(runtime).map(([key]) => key);
    expect(keys).toEqual(['aggregate:steward:drainage-control:区域排涝调度']);
  });
});
