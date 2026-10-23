/**
 * Shared test fixture: a minimal but type-complete EngineSnapshot factory.
 */

import type { EngineSnapshot } from '../api/types';

export function makeSnapshot(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return {
    runtimeId: 'sim-test',
    scenarioId: 'cross-brand-home',
    scenarioName: '测试场景',
    state: 'running',
    simTimeSec: 0,
    simTime: new Date(0).toISOString(),
    speed: 1,
    tickCount: 0,
    zones: [],
    devices: [],
    agents: [],
    recentDecisions: [],
    scheduledEvents: [],
    ...overrides,
  };
}
