/**
 * World-model builder — pure construction tests (§3.1, §8.1 seeding).
 *
 * Pins: input-order preservation, command-surface derivation (sensor-style
 * capabilities excluded — the SAME predicate the assessor MY_DEVICES
 * inventory uses), goal-stack sorting + 5-cap, event slicing to last N,
 * unknown-zone fallback, JSON-serializability, and the AgentProfile goal
 * projection (owner assignments → goal stack).
 */

import { describe, expect, it } from 'vitest';
import { GoalPriority, GoalStatus, GoalType, type AgentProfile } from '../../goal/types.js';
import {
  buildAgentWorldModel,
  deriveDeviceCommands,
  goalsFromAgentProfile,
} from '../world-model-builder.js';

describe('buildAgentWorldModel', () => {
  it('assembles the full structure from the documented inputs', () => {
    const model = buildAgentWorldModel({
      agentId: 'thermal-ops-1',
      capabilities: ['temperature-control', 'hvac-control'],
      devices: [
        {
          deviceId: 'hvac-101',
          type: 'hvac',
          zoneId: 'floor-1',
          state: { power: 'on', setpoint: 26 },
          commands: ['set-temperature', 'power-off'],
        },
      ],
      zones: [
        {
          zoneId: 'floor-1',
          name: 'Floor 1',
          parameters: { temperature: 29.3, humidity: 55 },
          adjacentZoneIds: ['floor-2', 'atrium'],
        },
      ],
      goalStack: [{ goal: 'maintain_comfort', priority: 2 }],
      events: [{ type: 'temperature-spike', zoneId: 'floor-1', parameter: 'temperature', value: 29.3, simTimeSec: 43210 }],
      simTimeSec: 43210,
    });

    expect(model.agentId).toBe('thermal-ops-1');
    expect(model.capabilities).toEqual(['temperature-control', 'hvac-control']);
    expect(model.devices).toEqual([
      {
        deviceId: 'hvac-101',
        type: 'hvac',
        zoneId: 'floor-1',
        state: { power: 'on', setpoint: 26 },
        commands: ['set-temperature', 'power-off'],
      },
    ]);
    expect(model.zones).toEqual([
      {
        zoneId: 'floor-1',
        name: 'Floor 1',
        parameters: { temperature: 29.3, humidity: 55 },
        adjacentZoneIds: ['floor-2', 'atrium'],
      },
    ]);
    expect(model.goalStack).toEqual([{ goal: 'maintain_comfort', priority: 2 }]);
    expect(model.recentEvents).toEqual([
      { type: 'temperature-spike', zoneId: 'floor-1', parameter: 'temperature', value: 29.3, simTimeSec: 43210 },
    ]);
    expect(model.simTimeSec).toBe(43210);
  });

  it('derives device commands from capabilities, excluding sensor-style caps (shared surface)', () => {
    expect(deriveDeviceCommands(['Temperature-Control', 'temperature-sensing', 'get-status', 'power-toggle']))
      .toEqual(['temperature-control', 'power-toggle']);
    expect(deriveDeviceCommands(['temperature-sensing'])).toEqual([]);
  });

  it('defaults zoneId to unknown, zone name to zoneId, and empty structures', () => {
    const model = buildAgentWorldModel({
      agentId: 'a1',
      capabilities: [],
      devices: [{ deviceId: 'd1', type: 'sensor' }],
      zones: [{ zoneId: 'z1' }],
      simTimeSec: 0,
    });
    expect(model.devices[0].zoneId).toBe('unknown');
    expect(model.devices[0].state).toEqual({});
    expect(model.devices[0].commands).toEqual([]);
    expect(model.zones[0]).toEqual({ zoneId: 'z1', name: 'z1', parameters: {}, adjacentZoneIds: [] });
    expect(model.goalStack).toEqual([]);
    expect(model.recentEvents).toEqual([]);
  });

  it('sorts the goal stack by priority and caps it at 5 entries', () => {
    const model = buildAgentWorldModel({
      agentId: 'a1',
      capabilities: [],
      devices: [],
      zones: [],
      goalStack: [
        { goal: 'low', priority: 4 },
        { goal: 'top', priority: 1 },
        { goal: 'mid', priority: 2 },
        { goal: 'g4', priority: 3 },
        { goal: 'g5', priority: 5 },
        { goal: 'g6', priority: 1 },
      ],
      simTimeSec: 0,
    });
    expect(model.goalStack.map(g => g.goal)).toEqual(['top', 'g6', 'mid', 'g4', 'low']);
  });

  it('slices recent events to the last N (default 5, overridable)', () => {
    const events = Array.from({ length: 8 }, (_, i) => ({ type: `e${i}`, simTimeSec: i }));
    const defaultModel = buildAgentWorldModel({ agentId: 'a', capabilities: [], devices: [], zones: [], events, simTimeSec: 8 });
    expect(defaultModel.recentEvents.map(e => e.type)).toEqual(['e3', 'e4', 'e5', 'e6', 'e7']);

    const capped = buildAgentWorldModel({ agentId: 'a', capabilities: [], devices: [], zones: [], events, simTimeSec: 8, maxRecentEvents: 2 });
    expect(capped.recentEvents.map(e => e.type)).toEqual(['e6', 'e7']);
  });

  it('carries scopeOfPractice only when non-empty', () => {
    const withScope = buildAgentWorldModel({ agentId: 'a', capabilities: [], devices: [], zones: [], scopeOfPractice: ['tpa-dispense'], simTimeSec: 0 });
    expect(withScope.scopeOfPractice).toEqual(['tpa-dispense']);

    const emptyScope = buildAgentWorldModel({ agentId: 'a', capabilities: [], devices: [], zones: [], scopeOfPractice: [], simTimeSec: 0 });
    expect(emptyScope.scopeOfPractice).toBeUndefined();
  });

  it('is JSON-serializable (bounded, no Dates, no Maps)', () => {
    const model = buildAgentWorldModel({
      agentId: 'a',
      capabilities: ['c'],
      devices: [{ deviceId: 'd', type: 't', zoneId: 'z', state: { x: 1 }, commands: ['c1'] }],
      zones: [{ zoneId: 'z', parameters: { temperature: 22 }, adjacentZoneIds: [] }],
      goalStack: [{ goal: 'g', priority: 1, deadline: 100 }],
      events: [{ type: 'e', simTimeSec: 1 }],
      simTimeSec: 100,
    });
    expect(() => JSON.stringify(model)).not.toThrow();
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });

  it('does not mutate its inputs', () => {
    const devices = [{ deviceId: 'd', type: 't', commands: ['c'] }];
    const zones = [{ zoneId: 'z', parameters: { temperature: 1 }, adjacentZoneIds: ['q'] }];
    const events = [{ type: 'e', simTimeSec: 1 }];
    buildAgentWorldModel({ agentId: 'a', capabilities: ['c'], devices, zones, events, simTimeSec: 1 });
    expect(devices).toEqual([{ deviceId: 'd', type: 't', commands: ['c'] }]);
    expect(zones).toEqual([{ zoneId: 'z', parameters: { temperature: 1 }, adjacentZoneIds: ['q'] }]);
    expect(events).toEqual([{ type: 'e', simTimeSec: 1 }]);
  });
});

describe('goalsFromAgentProfile (owner assignments → goal stack)', () => {
  const baseGoal = {
    id: 'g1',
    type: GoalType.MAINTENANCE,
    status: GoalStatus.ACTIVE,
    createdAt: new Date('2026-08-26T00:00:00Z'),
    updatedAt: new Date('2026-08-26T00:00:00Z'),
  };

  it('projects primaryGoals with priority ranking (critical=1 … low=4)', () => {
    const profile = {
      id: 'agent-1',
      primaryGoals: [
        { ...baseGoal, id: 'g1', description: 'maintain comfort', priority: GoalPriority.MEDIUM },
        { ...baseGoal, id: 'g2', description: 'ensure safety', priority: GoalPriority.CRITICAL },
      ],
    } as AgentProfile;

    const goals = goalsFromAgentProfile(profile);
    // Profile order preserved; buildAgentWorldModel sorts by priority.
    expect(goals).toEqual([
      { goal: 'maintain comfort', priority: 3 },
      { goal: 'ensure safety', priority: 1 },
    ]);
    const sorted = buildAgentWorldModel({ agentId: 'a', capabilities: [], devices: [], zones: [], goalStack: goals, simTimeSec: 0 }).goalStack;
    expect(sorted.map(g => g.goal)).toEqual(['ensure safety', 'maintain comfort']);
  });

  it('drops achieved/failed goals and handles absent profiles', () => {
    const profile = {
      id: 'agent-1',
      primaryGoals: [
        { ...baseGoal, status: GoalStatus.ACHIEVED, description: 'done', priority: GoalPriority.HIGH },
        { ...baseGoal, status: GoalStatus.SUSPENDED, description: 'paused', priority: GoalPriority.LOW },
      ],
    } as AgentProfile;

    expect(goalsFromAgentProfile(profile)).toEqual([{ goal: 'paused', priority: 4 }]);
    expect(goalsFromAgentProfile(undefined)).toEqual([]);
  });

  it('carries a deadline as epoch-seconds when the profile has one', () => {
    const deadline = new Date('2026-08-27T00:00:00Z');
    const profile = {
      id: 'agent-1',
      primaryGoals: [
        {
          ...baseGoal,
          description: 'report',
          priority: GoalPriority.HIGH,
          metrics: { deadline },
        },
      ],
    } as AgentProfile;

    expect(goalsFromAgentProfile(profile)[0].deadline).toBe(Math.round(deadline.getTime() / 1000));
  });
});
