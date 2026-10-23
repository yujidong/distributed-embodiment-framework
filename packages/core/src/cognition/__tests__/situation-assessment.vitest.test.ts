/**
 * Situation assessment — RULES lane tests (§4.1). Deterministic
 * classification from the world model: normal / anomaly / emergency /
 * opportunity, severity, affected zones, bounded reasons.
 */

import { describe, expect, it } from 'vitest';
import { assessSituation } from '../situation-assessment.js';
import { buildAgentWorldModel } from '../world-model-builder.js';
import type { AgentWorldModel, WorldModelEvent } from '../world-model.js';

function model(overrides: {
  zones?: Array<{ zoneId: string; parameters?: Record<string, number | boolean>; adjacentZoneIds?: string[] }>;
  devices?: Array<{ deviceId: string; type: string; zoneId?: string; state?: Record<string, unknown>; commands?: string[] }>;
  events?: WorldModelEvent[];
} = {}): AgentWorldModel {
  return buildAgentWorldModel({
    agentId: 'a1',
    capabilities: [],
    devices: overrides.devices ?? [],
    zones: (overrides.zones ?? []).map(z => ({
      zoneId: z.zoneId,
      parameters: z.parameters ?? {},
      adjacentZoneIds: z.adjacentZoneIds ?? [],
    })),
    events: overrides.events ?? [],
    simTimeSec: 1000,
  });
}

describe('assessSituation — normal', () => {
  it('classifies all-in-range zones with no events as normal (severity 1, no zones)', () => {
    const result = assessSituation(model({
      zones: [{ zoneId: 'z1', parameters: { temperature: 22, humidity: 50 } }],
    }));
    expect(result).toEqual({ type: 'normal', severity: 1, affectedZones: [], reasons: [] });
  });

  it('empty world model is normal', () => {
    expect(assessSituation(model())).toEqual({ type: 'normal', severity: 1, affectedZones: [], reasons: [] });
  });
});

describe('assessSituation — anomaly', () => {
  it('flags a parameter outside its expected range (severity 3)', () => {
    const result = assessSituation(model({
      zones: [{ zoneId: 'floor-1', parameters: { temperature: 31.5 } }],
    }));
    expect(result.type).toBe('anomaly');
    expect(result.severity).toBe(3);
    expect(result.affectedZones).toEqual(['floor-1']);
    expect(result.reasons[0]).toMatch(/floor-1\.temperature=31\.5 outside expected \[18, 28\]/);
  });

  it('flags a device fault state (severity 2)', () => {
    const result = assessSituation(model({
      devices: [{ deviceId: 'hvac-1', type: 'hvac', zoneId: 'floor-1', state: { status: 'offline' }, commands: ['set-temperature'] }],
    }));
    expect(result.type).toBe('anomaly');
    expect(result.severity).toBe(2);
    expect(result.reasons[0]).toBe('device hvac-1 status=offline');
  });

  it('flags an unexpected/alarm event (severity 3)', () => {
    const result = assessSituation(model({
      events: [{ type: 'temperature-spike', zoneId: 'floor-1', parameter: 'temperature', value: 31, simTimeSec: 999 }],
    }));
    expect(result.type).toBe('anomaly');
    expect(result.severity).toBe(3);
    expect(result.affectedZones).toEqual(['floor-1']);
  });

  it('ignores benign periodic event types', () => {
    const result = assessSituation(model({
      events: [{ type: 'environment.param_changed', zoneId: 'floor-1', simTimeSec: 999 }],
      zones: [{ zoneId: 'floor-1', parameters: { temperature: 22 } }],
    }));
    expect(result.type).toBe('normal');
  });

  it('accepts per-call range overrides (scenario baselines)', () => {
    const result = assessSituation(
      model({ zones: [{ zoneId: 'z', parameters: { temperature: 31.5 } }] }),
      { temperature: { min: 30, max: 33 } }, // a hot-zone scenario
    );
    expect(result.type).not.toBe('anomaly');
  });
});

describe('assessSituation — emergency', () => {
  it('safety event type escalates to emergency severity 5', () => {
    const result = assessSituation(model({
      events: [{ type: 'smoke-detected', zoneId: 'floor-1', simTimeSec: 999 }],
    }));
    expect(result.type).toBe('emergency');
    expect(result.severity).toBe(5);
    expect(result.affectedZones).toEqual(['floor-1']);
  });

  it('safety boolean parameter (smoke=true) escalates to emergency', () => {
    const result = assessSituation(model({
      zones: [{ zoneId: 'floor-2', parameters: { smoke: true, temperature: 22 } }],
    }));
    expect(result.type).toBe('emergency');
    expect(result.severity).toBe(5);
    expect(result.reasons[0]).toMatch(/floor-2\.smoke=true \(safety condition\)/);
  });

  it('safety bound breach (temperature 43) escalates even as a single anomaly', () => {
    const result = assessSituation(model({
      zones: [{ zoneId: 'floor-1', parameters: { temperature: 43 } }],
    }));
    expect(result.type).toBe('emergency');
    expect(result.severity).toBe(5);
    expect(result.reasons[0]).toMatch(/breaches safety bound \[2, 40\]/);
  });

  it('two zones out of range compound into emergency severity 4', () => {
    const result = assessSituation(model({
      zones: [
        { zoneId: 'floor-1', parameters: { temperature: 30 } },
        { zoneId: 'floor-2', parameters: { temperature: 30 } },
      ],
    }));
    expect(result.type).toBe('emergency');
    expect(result.severity).toBe(4);
    expect(result.affectedZones).toEqual(['floor-1', 'floor-2']);
  });

  it('two parameters out in ONE zone compound into emergency severity 4', () => {
    const result = assessSituation(model({
      zones: [{ zoneId: 'floor-1', parameters: { temperature: 30, humidity: 80 } }],
    }));
    expect(result.type).toBe('emergency');
    expect(result.severity).toBe(4);
    expect(result.reasons.some(r => r.includes('2 parameters out of range simultaneously'))).toBe(true);
  });
});

describe('assessSituation — opportunity', () => {
  it('comfort slack + running actuator is an opportunity', () => {
    const result = assessSituation(model({
      zones: [{ zoneId: 'floor-1', parameters: { temperature: 23 } }],
      devices: [{ deviceId: 'hvac-1', type: 'hvac', zoneId: 'floor-1', state: { power: 'on', mode: 'cool' }, commands: ['set-temperature'] }],
    }));
    expect(result.type).toBe('opportunity');
    expect(result.severity).toBe(1);
    expect(result.affectedZones).toEqual(['floor-1']);
    expect(result.reasons[0]).toMatch(/optimization window/);
  });

  it('no opportunity when the actuator is idle', () => {
    const result = assessSituation(model({
      zones: [{ zoneId: 'floor-1', parameters: { temperature: 23 } }],
      devices: [{ deviceId: 'hvac-1', type: 'hvac', zoneId: 'floor-1', state: { power: 'off' }, commands: ['set-temperature'] }],
    }));
    expect(result.type).toBe('normal');
  });

  it('edge-of-range comfort (near the band edge) is NOT an optimization window', () => {
    const result = assessSituation(model({
      zones: [{ zoneId: 'floor-1', parameters: { temperature: 27.8 } }], // inside 18-28 but outside middle half
      devices: [{ deviceId: 'hvac-1', type: 'hvac', zoneId: 'floor-1', state: { power: true }, commands: ['set-temperature'] }],
    }));
    expect(result.type).toBe('normal');
  });
});

describe('assessSituation — safety-first precedence', () => {
  it('emergency wins over opportunity/anomaly in the same model', () => {
    const result = assessSituation(model({
      zones: [
        { zoneId: 'floor-1', parameters: { temperature: 23 } },
        { zoneId: 'floor-2', parameters: { temperature: 50 } },
      ],
      devices: [{ deviceId: 'hvac-1', type: 'hvac', zoneId: 'floor-1', state: { power: true }, commands: ['set-temperature'] }],
    }));
    expect(result.type).toBe('emergency');
    expect(result.severity).toBe(5);
  });

  it('caps reasons at 8 with the most severe first (insertion order = scan order)', () => {
    const zones = Array.from({ length: 12 }, (_, i) => ({
      zoneId: `z${i}`,
      parameters: { temperature: 40.5 }, // safety breach each
    }));
    const result = assessSituation(model({ zones }));
    expect(result.reasons).toHaveLength(8);
    expect(result.reasons[0]).toMatch(/z0\.temperature=40\.5/);
  });
});
