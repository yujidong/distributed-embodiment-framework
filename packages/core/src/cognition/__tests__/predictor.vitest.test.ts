/**
 * @vitest-environment node
 *
 * L2 prediction tests — the what-if predictor (cognitive architecture
 * Phase 4, §4.4: the simulation engine AS the world model).
 *
 * Coverage:
 * - validation: teaching errors (never silent drops) for every bad input;
 * - text parsing: the deterministic "what if …" lane (opener, duration
 *   phrases incl. zh units, device commands via the proven prose bridge,
 *   disable semantics, parameter fallback, non-what-if → null);
 * - judgement (pure): energy scale, comfort-band distance, threshold
 *   crossing, neutral flatline, confidence penalties;
 * - runner (real physics): degradation (HVAC off in a hot zone), improvement
 *   (HVAC on in a hot zone), DETERMINISM (same fork source → bit-identical
 *   result), and the no-reflow red line (the live world is untouched).
 *
 * Fixture discipline (lessons.md): baselines are PINNED (wall-clock
 * dependent diurnal defaults would make assertions seasonal) and both arms
 * fork the SAME world export (the clock-anchor discipline).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { loadScenarioFile } from '../../scenario/index.js';
import { EngineRuntime } from '../../runtime/index.js';
import {
  WHAT_IF_ABSOLUTE_MAX_DURATION_SEC,
  WHAT_IF_DEFAULT_DURATION_SEC,
  WHAT_IF_MAX_DURATION_SEC,
  WHAT_IF_RADIUS_PRUNE_MIN_DEVICES,
  WhatIfValidationError,
  describeIntervention,
  judgeWhatIf,
  metricKeyOf,
  normalizeWhatIfScenario,
  normalizedDistanceOutsideRange,
  parseWhatIfText,
  resolveDeviceMentions,
  pruneWhatIfSource,
  runWhatIf,
  whatIfAffectedZoneIds,
  whatIfMaxDurationSecOf,
  type WhatIfDeviceView,
  type WhatIfScenario,
} from '../predictor.js';

// ============================================================================
// Fixture — one hot zone held cool by an HVAC (the spec's worked example)
// ============================================================================

const runtimes: EngineRuntime[] = [];

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
});

function campusScenario(hvacPowered: boolean, metaExtra: Record<string, unknown> = {}) {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: `what-if-test-${hvacPowered ? 'on' : 'off'}`, name: 'What-if Test', ...metaExtra },
    zones: [
      {
        id: 'floor-1',
        name: 'Floor 1',
        // Small room (8×8m): thermal mass ∝ volume — a 20×20 floor cools at
        // ~0.09 °C/min and a test window cannot show the physics. This is a
        // MECHANICS fixture, not a tuning hack: baseline stays pinned.
        bounds: { minX: 0, maxX: 8, minY: 0, maxY: 8 },
        // Pinned hot attractor: without cooling the zone relaxes OUTSIDE the
        // comfort band [18,28] — the degradation case is physical, not tuned.
        baseline: { temperature: 32 },
      },
    ],
    devices: [
      {
        id: 'hvac-1',
        name: 'HVAC 1',
        type: 'hvac',
        capabilities: ['turn-on', 'turn-off', 'set-temperature'],
        zoneId: 'floor-1',
        initialState: { power: hvacPowered, status: hvacPowered ? 'on' : 'off', mode: 'cooling', targetTemperature: 22 },
      },
    ],
    agents: [
      {
        id: 'thermal-ops-1',
        name: 'ThermalOps',
        capabilities: ['temperature-control'],
        managesZoneIds: ['floor-1'],
        boundDeviceIds: ['hvac-1'],
      },
    ],
    events: [],
  });
}

/** Live world, stepped `settleSec` so meters accrue + effects register. */
async function liveWorld(
  hvacPowered: boolean,
  settleSec = 120,
  metaExtra: Record<string, unknown> = {},
): Promise<EngineRuntime> {
  const scenario = campusScenario(hvacPowered, metaExtra);
  const runtime = new EngineRuntime(scenario);
  runtimes.push(runtime);
  if (settleSec > 0) await runtime.step(settleSec);
  return runtime;
}

const DEVICE_VIEWS: WhatIfDeviceView[] = [
  { deviceId: 'hvac-1', name: 'HVAC 1', type: 'hvac', zoneId: 'floor-1', commands: ['turn-on', 'turn-off', 'set-temperature'] },
];

// R83 starter-home-class fixture: an ENV-IMPORTED home — devices key on
// UUIDs and carry CAPABILITY names (temperature-control/cooling), zones
// carry human names. The R83 acceptance question names a ZONE (客厅), not
// a device.
const STARTER_HOME_VIEWS: WhatIfDeviceView[] = [
  { deviceId: '5f120af9-0000-4000-8000-000000000001', name: '客厅温度传感器', type: 'temperature-sensor', zoneId: 'living-room', commands: ['temperature-reading', 'co2-monitoring'] },
  { deviceId: '5f120af9-0000-4000-8000-000000000002', name: '客厅空调', type: 'hvac', zoneId: 'living-room', commands: ['temperature-control', 'cooling', 'heating', 'turn-on', 'turn-off'] },
  { deviceId: '5f120af9-0000-4000-8000-000000000003', name: '客厅智能灯', type: 'smart-light', zoneId: 'living-room', commands: ['lighting-control', 'turn-on', 'turn-off', 'set-brightness'] },
];
const STARTER_HOME_ZONES = [
  { zoneId: 'living-room', name: '客厅' },
  { zoneId: 'bedroom', name: '卧室' },
  { zoneId: 'balcony', name: '阳台' },
];

// R49 city-scale fixture: every district owns same-named valves, and the
// numbered-sibling trap (阀 1 vs 阀 11).
const CITY_VALVES: WhatIfDeviceView[] = [
  { deviceId: 'bao-valve-1', name: '排涝智能阀 1', type: 'smart-valve', zoneId: 'bao-pump', commands: ['turn-on', 'turn-off'] },
  { deviceId: 'yantian-valve-1', name: '排涝智能阀 1', type: 'smart-valve', zoneId: 'yan-tian-pump', commands: ['turn-on', 'turn-off'] },
  { deviceId: 'bao-valve-11', name: '排涝智能阀 11', type: 'smart-valve', zoneId: 'bao-pump', commands: ['turn-on', 'turn-off'] },
];

describe('resolveDeviceMentions (R49: CJK folding + disambiguation)', () => {
  it('folds CJK names so a Chinese mention resolves at all (was: digits only)', () => {
    const { picks } = resolveDeviceMentions('如果关闭 排涝智能阀 1 会怎样', CITY_VALVES);
    // NOT any-of-three arbitrary: the prefix-shadow drop kills nothing
    // here (only 阀 1 matches), but both namesakes match → scope decides.
    expect(picks.map(p => p.deviceId)).toEqual(['bao-valve-1', 'yantian-valve-1']);
    const scoped = resolveDeviceMentions('如果关闭 排涝智能阀 1 会怎样', CITY_VALVES, new Set(['yantian-valve-1']));
    expect(scoped.picks.map(p => p.deviceId)).toEqual(['yantian-valve-1']);
    expect(scoped.notes.some(n => n.includes("agent's own devices"))).toBe(true);
  });

  it('drops prefix-shadowed siblings: mentioning 阀 11 must not resolve to 阀 1', () => {
    const { picks } = resolveDeviceMentions('如果关闭 排涝智能阀 11 会怎样', CITY_VALVES);
    expect(picks.map(p => p.deviceId)).toEqual(['bao-valve-11']);
  });

  it('an exact id mention beats every name mention', () => {
    const { picks } = resolveDeviceMentions('what if bao-valve-1 is disabled', CITY_VALVES);
    expect(picks.map(p => p.deviceId)).toEqual(['bao-valve-1']);
  });
});

// R98 zhao-05: lab-101 holds four ACs — the asker owns one; 「101 的空调」
// matches ALL of them through the 空调 type word. The platform silently
// simulated a colleague's (already-off) AC and answered "no effect".
const LAB_101_ACS: WhatIfDeviceView[] = [
  { deviceId: 'li-ac', name: 'lab-101 格力空调', type: 'hvac', zoneId: 'lab-101', commands: ['turn-on', 'turn-off', 'set-temperature'] },
  { deviceId: 'zhao-ac', name: '赵-101空调', type: 'hvac', zoneId: 'lab-101', commands: ['turn-on', 'turn-off', 'set-temperature'] },
  { deviceId: 'midea-ac', name: 'lab-101 美的空调', type: 'hvac', zoneId: 'lab-101', commands: ['turn-on', 'turn-off'] },
  { deviceId: 'haier-ac', name: 'lab-101 海尔空调', type: 'hvac', zoneId: 'lab-101', commands: ['turn-on', 'turn-off'] },
];

describe('R98: what-if device reference resolution (zhao-05)', () => {
  it('a generic type-word mention prefers the asking agent\'s OWN device over same-zone others', () => {
    const parsed = parseWhatIfText(
      '如果把 101 的空调关掉 30 分钟会怎样？',
      LAB_101_ACS,
      {},
      { deviceIds: new Set(['zhao-ac']) },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      // NOT li-ac (first in list order, a colleague's already-off AC).
      expect(parsed.intervention).toEqual({ type: 'device_command', target: 'zhao-ac', action: 'turn-off' });
      expect(parsed.durationSec).toBe(1800);
      // R99 (zhao-07): even when the bound device wins, the answer DECLARES
      // the full candidate list and the choice basis.
      const ambiguity = parsed.notes.find(note => note.includes('ambiguous target'));
      expect(ambiguity).toBeDefined();
      expect(ambiguity).toContain('lab-101 格力空调');
      expect(ambiguity).toContain('赵-101空调');
      expect(ambiguity).toContain("requester's own bound device");
    }
  });

  it('without an own-scope match the ambiguity is explicit: candidate names + first-match basis', () => {
    const parsed = parseWhatIfText(
      '如果把 101 的空调关掉 30 分钟会怎样？',
      LAB_101_ACS,
      {},
      { deviceIds: new Set(['unrelated-device']) },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      const ambiguity = parsed.notes.find(note => note.includes('ambiguous target'));
      expect(ambiguity).toBeDefined();
      // Every candidate is NAMED, and the note says WHICH one is simulated
      // and on what basis (first match — the requester bound none of them).
      expect(ambiguity).toContain('lab-101 格力空调');
      expect(ambiguity).toContain('赵-101空调');
      expect(ambiguity).toContain('first match');
      expect(parsed.intervention.target).toBe('li-ac');
    }
  });

  it('R101 (zhao-12): the candidate set honors the location token — meeting-202 stays out, the requester\'s 101-named AC stays in and wins', () => {
    const withMeeting = [
      ...LAB_101_ACS,
      { deviceId: 'meeting-ac', name: 'meeting-202 格力空调', type: 'hvac', zoneId: 'meeting-202', commands: ['turn-on', 'turn-off'] },
    ];
    const parsed = parseWhatIfText(
      '如果把 101 的空调关掉 30 分钟会怎样？',
      withMeeting,
      {},
      { deviceIds: new Set(['zhao-ac']) },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      // 归属优先: the requester's own bound AC is the simulated target.
      expect(parsed.intervention.target).toBe('zhao-ac');
      const ambiguity = parsed.notes.find(note => note.includes('ambiguous target'));
      expect(ambiguity).toBeDefined();
      // 候选口径: 赵-101空调 (name carries 101) is IN the candidate set…
      expect(ambiguity).toContain('赵-101空调');
      expect(ambiguity).toContain('lab-101 格力空调');
      // …meeting-202's AC is OUT (「101」 scopes the type-word match).
      expect(ambiguity).not.toContain('meeting-202 格力空调');
    }
  });

  it('a single candidate keeps the old behavior (no ambiguity note)', () => {
    const parsed = parseWhatIfText('What if I turn off HVAC-1 for 30 minutes?', DEVICE_VIEWS);
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention).toEqual({ type: 'device_command', target: 'hvac-1', action: 'turn-off' });
      expect(parsed.notes.some(note => note.includes('ambiguous target'))).toBe(false);
    }
  });

  it('describeIntervention renders the device NAME, never a bare id when a resolver is given; NL face carries no "(name (uuid))" hybrid (T55)', () => {
    const named = describeIntervention(
      { type: 'device_command', target: 'li-ac', action: 'turn-off' },
      id => LAB_101_ACS.find(d => d.deviceId === id)?.name,
    );
    expect(named).toContain('lab-101 格力空调');
    // T55: the prose face must not embed the raw id alongside the name —
    // the structured intervention fields carry the precision instead.
    expect(named).not.toContain('li-ac');
    // No resolver → the legacy id-only rendering (standalone contract unchanged).
    expect(describeIntervention({ type: 'device_command', target: 'li-ac', action: 'turn-off' }))
      .toContain('"li-ac"');
  });
});

// ============================================================================
// Validation (teaching errors — a dropped field changes what is tested)
// ============================================================================

describe('normalizeWhatIfScenario', () => {
  const base = {
    intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-off' },
    metrics: [{ name: 'temperature', zoneId: 'floor-1' }],
    durationSec: 600,
  } satisfies WhatIfScenario;

  it('normalizes a valid scenario (and trims optional metric fields)', () => {
    const normalized = normalizeWhatIfScenario(base);
    expect(normalized).toEqual(base);
    expect(normalized.metrics).toEqual([{ name: 'temperature', zoneId: 'floor-1' }]);
  });

  it('rejects a bad intervention type by naming the accepted ones', () => {
    expect(() =>
      normalizeWhatIfScenario({ ...base, intervention: { type: 'nuke' as never, target: 'x', action: 'y' } }),
    ).toThrowError(/device_command.*parameter_change.*event_injection.*device_disable/);
  });

  it('rejects fields the intervention type does not consume (never drops silently)', () => {
    expect(() =>
      normalizeWhatIfScenario({
        ...base,
        intervention: { type: 'device_disable', target: 'hvac-1', action: 'turn-off' },
      }),
    ).toThrowError(/does not consume "action"/);
  });

  it('requires target and action where the semantics need them', () => {
    expect(() => normalizeWhatIfScenario({ ...base, intervention: { type: 'device_command', action: 'turn-off' } }))
      .toThrowError(/intervention\.target/);
    expect(() => normalizeWhatIfScenario({ ...base, intervention: { type: 'device_command', target: 'hvac-1' } }))
      .toThrowError(/intervention\.action/);
  });

  it('requires a value for parameter_change / event_injection', () => {
    expect(() =>
      normalizeWhatIfScenario({ ...base, intervention: { type: 'parameter_change', target: 'floor-1', action: 'temperature' } }),
    ).toThrowError(/value is required for parameter_change/);
  });

  it('bounds durationSec to [1, 3600] with the window in the message', () => {
    expect(() => normalizeWhatIfScenario({ ...base, durationSec: 0 })).toThrowError(/\[1, 3600\]/);
    expect(() => normalizeWhatIfScenario({ ...base, durationSec: WHAT_IF_MAX_DURATION_SEC + 1 })).toThrowError(/\[1, 3600\]/);
    expect(() => normalizeWhatIfScenario({ ...base, durationSec: 1.5 })).toThrowError(/integer/);
  });

  it('R40-B1 quota: a scenario cap tightens the window and TEACHES the quota', () => {
    // 600s is fine under the platform default but over a 300s quota.
    expect(() => normalizeWhatIfScenario({ ...base, durationSec: 600 }, { maxDurationSec: 300 }))
      .toThrowError(/\[1, 300\].*whatIfQuota\.maxDurationSec \(300\)/);
    expect(() => normalizeWhatIfScenario({ ...base, durationSec: 300 }, { maxDurationSec: 300 }))
      .not.toThrow();
  });

  it('R40-B1 quota: extended cap admits the platform-default ceiling and above', () => {
    expect(() => normalizeWhatIfScenario({ ...base, durationSec: 3660 }, { maxDurationSec: WHAT_IF_ABSOLUTE_MAX_DURATION_SEC }))
      .not.toThrow();
    // The absolute ceiling clamps even a runaway quota value.
    expect(() => normalizeWhatIfScenario({ ...base, durationSec: 9000 }, { maxDurationSec: 9999 }))
      .toThrowError(/\[1, 7200\]/);
  });

  it('requires a non-empty, capped metrics array', () => {
    expect(() => normalizeWhatIfScenario({ ...base, metrics: [] })).toThrowError(/non-empty array/);
    expect(() =>
      normalizeWhatIfScenario({ ...base, metrics: Array.from({ length: 9 }, () => ({ name: 'temperature' })) }),
    ).toThrowError(/capped at/);
  });
});

// ============================================================================
// Text parsing (deterministic, zero LLM)
// ============================================================================

describe('parseWhatIfText', () => {
  it('maps "what if I turn off HVAC-1 for 30 minutes?" onto a device command', () => {
    const parsed = parseWhatIfText('What if I turn off HVAC-1 for 30 minutes?', DEVICE_VIEWS);
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention).toEqual({ type: 'device_command', target: 'hvac-1', action: 'turn-off' });
      expect(parsed.durationSec).toBe(1800);
      expect(parsed.notes.some(note => note.includes('30 minutes'))).toBe(true);
    }
  });

  it('understands hours, minutes, seconds and Chinese duration units', () => {
    const cases: Array<[string, number]> = [
      ['what if hvac-1 is turned off for 1 hour?', 3600],
      ['what if I turn on hvac-1 for 45 min?', 2700],
      ['what if I turn off hvac-1 for 90 seconds?', 90],
      ['如果关闭 hvac-1 30分钟 会怎样？', 1800],
    ];
    for (const [text, expected] of cases) {
      const parsed = parseWhatIfText(text, DEVICE_VIEWS);
      expect(parsed).not.toBeNull();
      expect('error' in parsed!).toBe(false);
      if (!('error' in parsed!)) expect(parsed.durationSec).toBe(expected);
    }
  });

  it('clamps over-cap durations to WHAT_IF_MAX_DURATION_SEC (1h lookahead)', () => {
    const parsed = parseWhatIfText('what if hvac-1 stays off for 2 hours?', DEVICE_VIEWS);
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) expect(parsed.durationSec).toBe(WHAT_IF_MAX_DURATION_SEC);
  });

  it('R40-B1 quota: duration phrases clamp to the scenario quota, not just the platform default', () => {
    const parsed = parseWhatIfText('what if hvac-1 stays off for 30 minutes?', DEVICE_VIEWS, { maxDurationSec: 300 });
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.durationSec).toBe(300);
      expect(parsed.notes.some(note => note.includes('→ 300s'))).toBe(true);
    }
    // A quota ABOVE the platform default lets long horizons through intact.
    const extended = parseWhatIfText('what if hvac-1 stays off for 90 minutes?', DEVICE_VIEWS, {
      maxDurationSec: WHAT_IF_ABSOLUTE_MAX_DURATION_SEC,
    });
    expect(extended).not.toBeNull();
    expect('error' in extended!).toBe(false);
    if (!('error' in extended!)) expect(extended.durationSec).toBe(5400);
  });

  it('defaults the duration when the text carries none', () => {
    const parsed = parseWhatIfText('what if I turn off hvac-1?', DEVICE_VIEWS);
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) expect(parsed.durationSec).toBe(WHAT_IF_DEFAULT_DURATION_SEC);
  });

  it('disable semantics: "what if hvac-1 fails" → device_disable', () => {
    const parsed = parseWhatIfText('what if hvac-1 fails?', DEVICE_VIEWS);
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention).toEqual({ type: 'device_disable', target: 'hvac-1' });
    }
  });

  it('parameter-target prose maps onto the OWN device command when one exists', () => {
    // "set temperature to 35" names a parameter the hvac-1 surface commands —
    // the proven bridge resolves it to set-temperature (better semantics than
    // a raw zone write: it goes through the device's own control loop).
    const parsed = parseWhatIfText('what if the temperature is set to 35 in floor-1 for 10 minutes?', DEVICE_VIEWS);
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention).toEqual({
        type: 'device_command',
        target: 'hvac-1',
        action: 'set-temperature',
        value: 35,
      });
      expect(parsed.durationSec).toBe(600);
    }
  });

  it('parameter fallback fires when no own-device command matches the parameter', () => {
    // humidity is NOT on the hvac-1 surface → the bridge finds nothing →
    // the deterministic "set <param> to <n> in <zone>" fallback applies.
    const parsed = parseWhatIfText('what if humidity is set to 80 in floor-1?', DEVICE_VIEWS);
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention).toEqual({ type: 'parameter_change', target: 'floor-1', action: 'humidity', value: 80 });
    }
  });

  it('returns null for non-what-if text (not this lane)', () => {
    expect(parseWhatIfText('turn off hvac-1', DEVICE_VIEWS)).toBeNull();
    expect(parseWhatIfText('', DEVICE_VIEWS)).toBeNull();
  });

  it('teaches when a what-if question maps onto nothing', () => {
    const parsed = parseWhatIfText('what if it rains tomorrow?', DEVICE_VIEWS);
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(true);
    // R83: the teaching names devices HUMAN-READABLY, not by raw id.
    if ('error' in parsed!) expect(parsed.error).toContain('HVAC 1');
  });

  it('R83: 「把客厅温度调到 35 度会怎样」 maps onto the zone’s AC (capability-name commands)', () => {
    const parsed = parseWhatIfText('如果把客厅温度调到 35 度会怎样', STARTER_HOME_VIEWS, {}, {
      deviceIds: new Set(STARTER_HOME_VIEWS.map(d => d.deviceId)),
      zones: STARTER_HOME_ZONES,
    });
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention).toEqual({
        type: 'device_command',
        target: '5f120af9-0000-4000-8000-000000000002',
        action: 'temperature-control',
        value: 35,
      });
    }
  });

  it('R83: the zone-temperature lane prefers set-temperature and degrades to a zone write', () => {
    // File-scenario surface: 'set-temperature' outranks capability names.
    const preferred = parseWhatIfText('如果把客厅温度调到35度会怎样', [
      { deviceId: 'ac-1', name: '空调', type: 'hvac', zoneId: 'living-room', commands: ['cooling', 'set-temperature'] },
    ], {}, { deviceIds: new Set(['ac-1']), zones: STARTER_HOME_ZONES });
    expect(preferred).not.toBeNull();
    if (preferred !== null && !('error' in preferred)) {
      expect(preferred.intervention).toEqual({ type: 'device_command', target: 'ac-1', action: 'set-temperature', value: 35 });
    } else {
      expect.unreachable('expected a parsed intervention');
    }
    // A zone with NO temperature-capable device falls back to parameter_change.
    const zoneWrite = parseWhatIfText('如果把卧室温度调到 30 度会怎样', STARTER_HOME_VIEWS, {}, {
      deviceIds: new Set(STARTER_HOME_VIEWS.map(d => d.deviceId)),
      zones: STARTER_HOME_ZONES,
    });
    expect(zoneWrite).not.toBeNull();
    if (zoneWrite !== null && !('error' in zoneWrite)) {
      expect(zoneWrite.intervention).toEqual({ type: 'parameter_change', target: 'bedroom', action: 'temperature', value: 30 });
    } else {
      expect.unreachable('expected a parsed intervention');
    }
  });

  it('R83: the unmapped-question error localizes (zh) and names devices, never UUIDs', () => {
    const parsed = parseWhatIfText('如果明天下雨会怎样', STARTER_HOME_VIEWS, { locale: 'zh-CN' }, {
      deviceIds: new Set(STARTER_HOME_VIEWS.map(d => d.deviceId)),
      zones: STARTER_HOME_ZONES,
    });
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(true);
    if ('error' in parsed!) {
      expect(parsed.error).toContain('我理解了这个 what-if 问题');
      expect(parsed.error).toContain('客厅空调');
      expect(parsed.error).not.toContain('5f120af9');
      expect(parsed.error).not.toContain('Known devices');
    }
    // en-US keeps the English original — with device NAMES, not ids.
    const en = parseWhatIfText('如果明天下雨会怎样', STARTER_HOME_VIEWS, { locale: 'en-US' });
    expect(en).not.toBeNull();
    if (en !== null && 'error' in en) {
      expect(en.error).toContain('Known devices');
      expect(en.error).toContain('客厅空调');
      expect(en.error).not.toContain('5f120af9');
    } else {
      expect.unreachable('expected an unmapped-question error');
    }
  });
});

// ============================================================================
// Judgement (pure)
// ============================================================================

describe('judgeWhatIf', () => {
  const scenarioOf = (metrics: WhatIfScenario['metrics']): WhatIfScenario => ({
    intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-off' },
    metrics,
    durationSec: 600,
  });

  it('more energy = degradation; less = improvement (kWh scale, §5.2-weighted)', () => {
    const scenario = scenarioOf([{ name: 'energy', zoneId: 'floor-1' }]);
    const worse = judgeWhatIf(
      scenario,
      { 'energy_floor-1': [100, 100] },
      { 'energy_floor-1': [100, 700] }, // +600 Wh ≈ 0.6 kWh × 0.5 weight
      0,
    );
    expect(worse.verdict).toBe('degradation');
    const better = judgeWhatIf(
      scenario,
      { 'energy_floor-1': [100, 700] },
      { 'energy_floor-1': [100, 150] }, // −550 Wh
      0,
    );
    expect(better.verdict).toBe('improvement');
  });

  it('an energy SAVING cannot cancel a comparable comfort degradation (§5.2)', () => {
    // The spec's worked example: save ~0.5 kWh while the zone drifts outside
    // the band → still a degradation (comfort weighs 2.0, energy 0.5).
    const scenario = scenarioOf([
      { name: 'temperature', zoneId: 'floor-1' },
      { name: 'energy', zoneId: 'floor-1' },
    ]);
    const judged = judgeWhatIf(
      scenario,
      { 'temperature_floor-1': [27, 27], 'energy_floor-1': [100, 600] },
      { 'temperature_floor-1': [27, 31], 'energy_floor-1': [100, 100] }, // −0.5 kWh, +4°C outside
      0,
    );
    expect(judged.verdict).toBe('degradation');
    // The tension stays VISIBLE: both sentences ride the explanation.
    expect(judged.explanation).toContain('kWh');
    expect(judged.explanation).toContain('outside');
  });

  it('drifting outside the comfort band = degradation, pulling inside = improvement', () => {
    const scenario = scenarioOf([{ name: 'temperature', zoneId: 'floor-1' }]);
    // Baseline holds 24 (inside); intervention drifts to 31 (outside 18–28).
    const worse = judgeWhatIf(scenario, { 'temperature_floor-1': [24, 24] }, { 'temperature_floor-1': [24, 31] }, 0);
    expect(worse.verdict).toBe('degradation');
    // Baseline stuck at 31 (outside); intervention pulls to 24 (inside).
    const better = judgeWhatIf(scenario, { 'temperature_floor-1': [31, 31] }, { 'temperature_floor-1': [31, 24] }, 0);
    expect(better.verdict).toBe('improvement');
  });

  // T56 (R6, u1-F3): a CONSTANT comfort series carries no signal — the old
  // band judgment mechanically concluded "outside the comfort band" for a
  // constant 0, contradicting the temperature sentence in the SAME
  // explanation (u1's two-line self-contradiction).
  it('T56: a constant comfort series skips the band judgment — no contradiction with a real temperature line', () => {
    const scenario = scenarioOf([
      { name: 'temperature', zoneId: 'bldg-1' },
      { name: 'comfort', zoneId: 'bldg-1' },
    ]);
    // u1's shape: real temperature data, comfort both arms all-zero.
    const judged = judgeWhatIf(
      scenario,
      { 'temperature_bldg-1': [24.1, 24.1], 'comfort_bldg-1': [0, 0] },
      { 'temperature_bldg-1': [24.1, 24.3], 'comfort_bldg-1': [0, 0] },
      0,
    );
    expect(judged.explanation).toContain('comfort_bldg-1: no comfort signal in this world (series constant 0) — band judgement skipped');
    expect(judged.explanation).not.toContain('comfort band');
    expect(judged.explanation).not.toContain('currently outside it');
    // The temperature line stays a real reading (its own range semantics).
    expect(judged.explanation).toContain('temperature_bldg-1');
    // The contribution is 0 (no fabricated comfort degradation).
    expect(judged.contributions.find(c => c.key === 'comfort_bldg-1')?.contribution).toBe(0);
  });

  it('T56: a non-constant comfort series keeps the band semantics (no regression)', () => {
    const scenario = scenarioOf([{ name: 'comfort', zoneId: 'bldg-1' }]);
    // Comfort dropping further BELOW the band's floor (0 → −5) is a real
    // signal: the band line renders and the verdict degrades.
    const judged = judgeWhatIf(
      scenario,
      { 'comfort_bldg-1': [0, 0] },
      { 'comfort_bldg-1': [0, -5] },
      0,
    );
    expect(judged.explanation).toContain('comfort band 18–28');
    expect(judged.explanation).toContain('currently outside it');
    expect(judged.verdict).toBe('degradation'); // drifting away from the band
  });

  it('T56: a NEUTRAL verdict names its dominant term (no more "neutral without a reason")', () => {
    // +0.4°C inside the band ≈ contribution ±0.0? No: temperature inside the
    // band contributes 0; an energy nudge of +40 Wh ≈ +0.02·0.5 = +0.01 —
    // below the note. Use +200 Wh: contribution = (200/1000)·0.5 = +0.1 →
    // |total| = 0.1, not > 0.1 → neutral WITH a dominant term named.
    const scenario = scenarioOf([{ name: 'energy', zoneId: 'floor-1' }]);
    const judged = judgeWhatIf(
      scenario,
      { 'energy_floor-1': [100, 100] },
      { 'energy_floor-1': [100, 300] },
      0,
    );
    expect(judged.verdict).toBe('neutral');
    expect(judged.explanation).toContain('The dominant term is energy_floor-1');
    expect(judged.explanation).toContain('neutral band');
  });

  it('counts a worse-direction threshold breach the baseline did not have', () => {
    const scenario = scenarioOf([{ name: 'temperature', zoneId: 'floor-1', threshold: 28 }]);
    const judged = judgeWhatIf(scenario, { 'temperature_floor-1': [24, 27] }, { 'temperature_floor-1': [24, 29] }, 0);
    expect(judged.verdict).toBe('degradation');
    expect(judged.explanation).toContain('CROSSES threshold 28');
  });

  it('flat deltas stay neutral with a small confidence penalty', () => {
    const scenario = scenarioOf([{ name: 'temperature', zoneId: 'floor-1' }]);
    // A small NON-zero move (0.4°C, inside the band) — distinct from the
    // all-zero case below (R98: exactly-zero movement is inconclusive).
    const judged = judgeWhatIf(scenario, { 'temperature_floor-1': [24, 24] }, { 'temperature_floor-1': [24, 24.4] }, 0);
    expect(judged.verdict).toBe('neutral');
    expect(judged.confidence).toBeLessThan(0.9);
  });

  it('R98: all-zero deltas are INCONCLUSIVE (low signal), never an affirmative neutral — the explanation names possible causes', () => {
    const scenario = scenarioOf([{ name: 'temperature', zoneId: 'floor-1' }]);
    const judged = judgeWhatIf(scenario, { 'temperature_floor-1': [24, 24] }, { 'temperature_floor-1': [24, 24] }, 0);
    expect(judged.verdict).toBe('inconclusive');
    expect(judged.confidence).toBeLessThanOrEqual(0.6);
    expect(judged.explanation).toContain('cannot be assessed');
    // The zhao-05 cause is named: the device may already be in the requested
    // state, and the user is told to verify WHICH device was simulated.
    expect(judged.explanation).toContain('already in the requested state');
    expect(judged.explanation).toContain('verify');
  });

  it('unsampleable metrics lose confidence and are noted as missing', () => {
    const scenario = scenarioOf([{ name: 'temperature', zoneId: 'floor-1' }, { name: 'nope', zoneId: 'x' }]);
    const judged = judgeWhatIf(scenario, { 'temperature_floor-1': [24, 24] }, { 'temperature_floor-1': [24, 24] }, 0);
    expect(judged.delta['nope_x']).toBeUndefined();
    expect(judged.confidence).toBeLessThan(0.9);
  });

  it('metricKeyOf / normalizedDistanceOutsideRange basics', () => {
    expect(metricKeyOf({ name: 'temperature' })).toBe('temperature');
    expect(metricKeyOf({ name: 'temperature', zoneId: 'floor-1' })).toBe('temperature_floor-1');
    expect(normalizedDistanceOutsideRange(24, { min: 18, max: 28 })).toBe(0);
    // 33 is 5 beyond the 28 edge → 0.5 band-widths.
    expect(normalizedDistanceOutsideRange(33, { min: 18, max: 28 })).toBeCloseTo(0.5, 6);
  });

  it('describeIntervention renders every lane', () => {
    expect(describeIntervention({ type: 'device_command', target: 'hvac-1', action: 'turn-off' }))
      .toContain('turn-off');
    expect(describeIntervention({ type: 'device_disable', target: 'hvac-1' })).toContain('offline');
    expect(describeIntervention({ type: 'parameter_change', target: 'floor-1', action: 'temperature', value: 35 }))
      .toContain('35');
    expect(describeIntervention({ type: 'event_injection', target: 'floor-1', action: 'temperature', value: 35 }))
      .toContain('floor-1');
  });
});

// ============================================================================
// Runner — REAL physics on private forks
// ============================================================================

describe('runWhatIf (dual-fork over the real physics engine)', () => {
  it('DEGRADATION: turning off the cooling HVAC in a hot zone drifts outside the band', async () => {
    const live = await liveWorld(true);
    const before = live.getSnapshot();
    const result = await runWhatIf(
      { scenario: live.scenario, worldState: live.exportWorldState() },
      {
        intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-off' },
        metrics: [
          { name: 'temperature', zoneId: 'floor-1' },
          { name: 'energy', zoneId: 'floor-1' },
          { name: 'comfort', zoneId: 'floor-1' },
        ],
        durationSec: 900,
      },
    );

    expect(result.verdict).toBe('degradation');
    // Temperature rises without cooling (intervention − baseline > 0)…
    expect(result.delta['temperature_floor-1']).toBeGreaterThan(0);
    // …and energy falls (the HVAC stops drawing).
    expect(result.delta['energy_floor-1']).toBeLessThan(0);
    // Series carry t0 + samples and the two arms actually diverged.
    expect(result.baseline['temperature_floor-1'].length).toBeGreaterThan(2);
    expect(result.intervention['temperature_floor-1']).not.toEqual(result.baseline['temperature_floor-1']);
    expect(result.explanation).toContain('degradation');
    expect(result.forkedAtSimTimeSec).toBe(live.getSimTimeSec());

    // The NO-REFLOW red line: the live world is untouched by the prediction.
    const after = live.getSnapshot();
    expect(live.getSimTimeSec()).toBe(before.simTimeSec);
    expect(after.zones).toEqual(before.zones);
    expect(after.devices.map(d => d.state)).toEqual(before.devices.map(d => d.state));
  }, 30_000);

  it('IMPROVEMENT: turning ON the HVAC in a hot uncooled zone pulls the zone back inside the band', async () => {
    const live = await liveWorld(false);
    const result = await runWhatIf(
      { scenario: live.scenario, worldState: live.exportWorldState() },
      {
        intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-on' },
        metrics: [
          { name: 'temperature', zoneId: 'floor-1' },
          { name: 'comfort', zoneId: 'floor-1' },
        ],
        durationSec: 1800,
      },
    );
    expect(result.verdict).toBe('improvement');
    expect(result.delta['temperature_floor-1']).toBeLessThan(0);
    expect(result.explanation).toContain('improvement');
  }, 30_000);

  it('DETERMINISM: the same fork source yields a bit-identical result', async () => {
    const live = await liveWorld(true, 60);
    const source = { scenario: live.scenario, worldState: live.exportWorldState() };
    const scenario: WhatIfScenario = {
      intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-off' },
      metrics: [{ name: 'temperature', zoneId: 'floor-1' }, { name: 'energy', zoneId: 'floor-1' }],
      durationSec: 600,
    };
    const first = await runWhatIf(source, scenario);
    const second = await runWhatIf(source, scenario);
    expect(second).toEqual(first);
  }, 30_000);  it('device_disable takes the device offline (same physics as turn-off, without a command)', async () => {
    const live = await liveWorld(true);
    const result = await runWhatIf(
      { scenario: live.scenario, worldState: live.exportWorldState() },
      {
        intervention: { type: 'device_disable', target: 'hvac-1' },
        metrics: [{ name: 'temperature', zoneId: 'floor-1' }],
        durationSec: 900,
      },
    );
    expect(result.verdict).toBe('degradation');
    expect(result.delta['temperature_floor-1']).toBeGreaterThan(0);
  }, 30_000);

  it('parameter_change and event_injection lanes run through the physics', async () => {
    const live = await liveWorld(true);
    const source = { scenario: live.scenario, worldState: live.exportWorldState() };

    const hotter = await runWhatIf(
      source,
      {
        intervention: { type: 'parameter_change', target: 'floor-1', action: 'temperature', value: 38 },
        metrics: [{ name: 'temperature', zoneId: 'floor-1' }],
        durationSec: 900,
      },
    );
    expect(hotter.verdict).toBe('degradation');

    const spike = await runWhatIf(
      source,
      {
        intervention: { type: 'event_injection', target: 'floor-1', action: 'temperature', value: 40 },
        metrics: [{ name: 'temperature', zoneId: 'floor-1' }],
        durationSec: 300,
      },
    );
    // A one-shot 40°C injection spikes the zone well outside the band.
    expect(spike.delta['temperature_floor-1']).toBeGreaterThan(2);
  }, 30_000);

  it('teaching errors for unknown devices / commands / zones (fixable input)', async () => {
    const live = await liveWorld(true);
    const source = { scenario: live.scenario, worldState: live.exportWorldState() };
    await expect(
      runWhatIf(source, {
        intervention: { type: 'device_command', target: 'hvac-99', action: 'turn-off' },
        metrics: [{ name: 'temperature' }],
        durationSec: 60,
      }),
    ).rejects.toThrowError(/hvac-99.*does not exist/);
    await expect(
      runWhatIf(source, {
        intervention: { type: 'device_command', target: 'hvac-1', action: 'self-destruct' },
        metrics: [{ name: 'temperature' }],
        durationSec: 60,
      }),
    ).rejects.toThrowError(/does not expose command "self-destruct"/);
    await expect(
      runWhatIf(source, {
        intervention: { type: 'parameter_change', target: 'roof-9', action: 'temperature', value: 30 },
        metrics: [{ name: 'temperature' }],
        durationSec: 60,
      }),
    ).rejects.toThrowError(/roof-9.*does not exist/);
  }, 30_000);

  it('unsampleable metrics degrade honestly (note + confidence penalty), verdict still computed', async () => {
    const live = await liveWorld(true, 0);
    const result = await runWhatIf(
      { scenario: live.scenario, worldState: live.exportWorldState() },
      {
        intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-off' },
        metrics: [{ name: 'temperature', zoneId: 'floor-1' }, { name: 'aqi', zoneId: 'floor-1' }],
        durationSec: 300,
      },
    );
    expect(result.notes.some(note => note.includes('"aqi_floor-1"'))).toBe(true);
    expect(result.confidence).toBeLessThanOrEqual(0.75);
    expect(['improvement', 'degradation', 'neutral', 'inconclusive']).toContain(result.verdict);
  }, 30_000);
});

// ============================================================================
// R40-B1 — scenario what-if quota (meta.whatIfQuota)
// ============================================================================

describe('what-if quota (scenario meta.whatIfQuota)', () => {
  it('whatIfMaxDurationSecOf: default 3600, quota wins, runaway values clamp to 7200', () => {
    expect(whatIfMaxDurationSecOf(campusScenario(true))).toBe(WHAT_IF_MAX_DURATION_SEC);
    expect(
      whatIfMaxDurationSecOf(campusScenario(true, { whatIfQuota: { maxDurationSec: 300 } })),
    ).toBe(300);
    // Runaway quota values can only arrive from programmatic scenarios (the
    // file schema caps at 7200) — the helper still clamps, never trusts.
    expect(
      whatIfMaxDurationSecOf({
        meta: { id: 'runaway', name: 'Runaway', description: '', whatIfQuota: { maxDurationSec: 99999 } },
      }),
    ).toBe(WHAT_IF_ABSOLUTE_MAX_DURATION_SEC);
  });

  it('runWhatIf enforces the scenario quota with a TEACHING error (no silent clamp)', async () => {
    const live = await liveWorld(true, 60, { whatIfQuota: { maxDurationSec: 300 } });
    await expect(
      runWhatIf(
        { scenario: live.scenario, worldState: live.exportWorldState() },
        {
          intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-off' },
          metrics: [{ name: 'temperature', zoneId: 'floor-1' }],
          durationSec: 600,
        },
      ),
    ).rejects.toThrowError(WhatIfValidationError);
    await expect(
      runWhatIf(
        { scenario: live.scenario, worldState: live.exportWorldState() },
        {
          intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-off' },
          metrics: [{ name: 'temperature', zoneId: 'floor-1' }],
          durationSec: 600,
        },
      ),
    ).rejects.toThrowError(/\[1, 300\].*whatIfQuota\.maxDurationSec \(300\)/);
  }, 30_000);

  it('runWhatIf honors an EXTENDED quota (beyond the platform default, within 7200)', async () => {
    const live = await liveWorld(false, 60, { whatIfQuota: { maxDurationSec: WHAT_IF_ABSOLUTE_MAX_DURATION_SEC } });
    // 3660s exceeds the platform default 3600 — legal only under the quota.
    const result = await runWhatIf(
      { scenario: live.scenario, worldState: live.exportWorldState() },
      {
        intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-on' },
        metrics: [{ name: 'temperature', zoneId: 'floor-1' }],
        durationSec: 3660,
      },
    );
    expect(result.scenario.durationSec).toBe(3660);
    expect(result.verdict).toBe('improvement');
  }, 30_000);
});

// ============================================================================
// R44-F3 — radius pruning (fork only the affected zone neighborhood)
// ============================================================================
//
// Fixture: a z1—z2—z3 chain on floor 0 plus z4 on floor 1 (adjacent to z1
// ONLY, so z4 sits outside the z2 radius {z1, z2, z3}). hvac-2 cools z2; z4
// carries a QUIET device (off) — the remote zone is undisturbed, which is
// exactly the world where pruning must not change the local physics at all.

function radiusScenarioFixture() {
  return {
    version: '1.0' as const,
    meta: { id: 'what-if-radius-test', name: 'What-if Radius Test' },
    zones: [
      {
        id: 'z1', name: 'Zone 1', floor: 0,
        bounds: { minX: 0, maxX: 8, minY: 0, maxY: 8 },
        adjacentZoneIds: ['z2', 'z4'],
        baseline: { temperature: 32 },
      },
      {
        id: 'z2', name: 'Zone 2', floor: 0,
        bounds: { minX: 8, maxX: 16, minY: 0, maxY: 8 },
        adjacentZoneIds: ['z1', 'z3'],
        baseline: { temperature: 32 },
      },
      {
        id: 'z3', name: 'Zone 3', floor: 0,
        bounds: { minX: 16, maxX: 24, minY: 0, maxY: 8 },
        adjacentZoneIds: ['z2'],
        baseline: { temperature: 32 },
      },
      {
        id: 'z4', name: 'Zone 4', floor: 1,
        bounds: { minX: 0, maxX: 8, minY: 0, maxY: 8 },
        adjacentZoneIds: ['z1'],
        baseline: { temperature: 32 },
      },
    ],
    devices: [
      {
        id: 'hvac-2', name: 'HVAC 2', type: 'hvac',
        capabilities: ['turn-on', 'turn-off', 'set-temperature'],
        zoneId: 'z2',
        initialState: { power: true, status: 'on', mode: 'cooling', targetTemperature: 22 },
      },
      {
        id: 'meter-4', name: 'Meter 4', type: 'sensor',
        capabilities: ['status'],
        zoneId: 'z4',
        initialState: { status: 'off' },
      },
    ],
    agents: [
      {
        id: 'keeper-2', name: 'Zone 2 Keeper',
        capabilities: ['temperature-control'],
        managesZoneIds: ['z2'],
        boundDeviceIds: ['hvac-2'],
      },
      {
        id: 'keeper-4', name: 'Zone 4 Keeper',
        capabilities: ['status'],
        managesZoneIds: ['z4'],
        boundDeviceIds: ['meter-4'],
      },
    ],
    events: [],
  };
}

describe('what-if radius pruning (R44-F3)', () => {
  it('whatIfAffectedZoneIds: target zone + one-hop adjacency, per intervention lane', () => {
    const scenario = loadScenarioFile(radiusScenarioFixture());
    const asSet = (value: ReadonlySet<string> | null): string[] => (value === null ? [] : [...value].sort());
    // Device lanes: the device's zone + its neighbors.
    expect(asSet(whatIfAffectedZoneIds(scenario, { type: 'device_command', target: 'hvac-2', action: 'turn-off' })))
      .toEqual(['z1', 'z2', 'z3']);
    expect(asSet(whatIfAffectedZoneIds(scenario, { type: 'device_disable', target: 'meter-4' })))
      .toEqual(['z1', 'z4']);
    // Parameter/event lanes: the target zone IS the anchor.
    expect(asSet(whatIfAffectedZoneIds(scenario, { type: 'parameter_change', target: 'z2', action: 'temperature', value: 30 })))
      .toEqual(['z1', 'z2', 'z3']);
    // Unresolvable targets → null (the caller forks the full world and the
    // applyIntervention teaching error fires exactly as before).
    expect(whatIfAffectedZoneIds(scenario, { type: 'device_command', target: 'nope', action: 'turn-off' })).toBeNull();
    expect(whatIfAffectedZoneIds(scenario, { type: 'parameter_change', target: 'nope', action: 'temperature', value: 1 })).toBeNull();
  });

  it('pruneWhatIfSource: keeps radius devices/agents + occupancy sources, drops the remote rest', async () => {
    const live = new EngineRuntime(loadScenarioFile(radiusScenarioFixture()));
    runtimes.push(live);
    live.setZoneOccupancy('z4', 3); // a remote zone's occupancy (zone property, not a device)
    await live.step(60);
    const source = { scenario: live.scenario, worldState: live.exportWorldState() };
    expect(source.worldState.zones['z4']!.occupancy).toBe(3);

    const pruned = pruneWhatIfSource(source, new Set(['z1', 'z2', 'z3']));

    // Scenario: only radius devices/agents; zones ALL kept (global models,
    // baselines and field topology must reconstruct exactly).
    expect(pruned.scenario.devices.map(d => d.id)).toEqual(['hvac-2']);
    expect(pruned.scenario.agents.map(a => a.id)).toEqual(['keeper-2']);
    expect(pruned.scenario.zones.map(z => z.id)).toEqual(['z1', 'z2', 'z3', 'z4']);
    // Export: remote device state/agent toggles dropped; remote device
    // effects dropped. Occupancy rides the ZONE state (exports deliberately
    // exclude occupancy virtual sources — restore re-derives them), so the
    // remote zone's occupancy — and its heat boundary — survives pruning.
    expect(Object.keys(pruned.worldState.devices)).toEqual(['hvac-2']);
    expect(Object.keys(pruned.worldState.agents)).toEqual(['keeper-2']);
    expect(pruned.worldState.deviceEffects.filter(e => e.deviceId === 'meter-4')).toEqual([]);
    expect(pruned.worldState.zones['z4']!.occupancy).toBe(3);
    // The input source is untouched (pure function).
    expect(Object.keys(source.worldState.devices)).toEqual(['hvac-2', 'meter-4']);
    expect(source.scenario.devices).toHaveLength(2);
  });

  it('PRUNING DOES NOT CHANGE LOCAL PHYSICS: pruned and full forks yield the identical delta', async () => {
    const live = new EngineRuntime(loadScenarioFile(radiusScenarioFixture()));
    runtimes.push(live);
    await live.step(120);
    const source = { scenario: live.scenario, worldState: live.exportWorldState() };
    const scenario: WhatIfScenario = {
      intervention: { type: 'device_command', target: 'hvac-2', action: 'turn-off' },
      metrics: [
        { name: 'temperature', zoneId: 'z2' },
        { name: 'energy', zoneId: 'z2' },
        { name: 'comfort', zoneId: 'z2' },
      ],
      durationSec: 900,
    };

    const full = await runWhatIf(source, scenario, { radiusPruning: false });
    const pruned = await runWhatIf(source, scenario, { radiusPruning: true });

    // The verdict face is identical, and the delta — the number the user
    // acts on — is BIT-IDENTICAL: pruning cut z4's quiet device without
    // touching the radius physics.
    expect(pruned.verdict).toBe(full.verdict);
    expect(pruned.delta).toEqual(full.delta);
    expect(pruned.baseline['temperature_z2']).toEqual(full.baseline['temperature_z2']);
    expect(pruned.intervention['temperature_z2']).toEqual(full.intervention['temperature_z2']);
    expect(pruned.confidence).toBe(full.confidence);
    expect(pruned.contributions).toEqual(full.contributions);
    // The pruning is visible and honest (note), and the fixture world is
    // small enough that AUTO mode keeps the full fork (no note by default).
    expect(pruned.notes.some(note => note.includes('radius pruning'))).toBe(true);
    expect(full.notes.some(note => note.includes('radius pruning'))).toBe(false);
    const auto = await runWhatIf(source, scenario);
    expect(auto.notes.some(note => note.includes('radius pruning'))).toBe(false);
  }, 30_000);

  it('AUTO: worlds at/above WHAT_IF_RADIUS_PRUNE_MIN_DEVICES prune by default, small worlds never do', async () => {
    const raw = radiusScenarioFixture();
    // Pad z3 (inside the z2 radius, keeps the radius a strict subset) and a
    // remote zone z9 with enough quiet sensors to cross the threshold.
    const sensors = Array.from({ length: WHAT_IF_RADIUS_PRUNE_MIN_DEVICES }, (_, i) => ({
      id: `sensor-${i}`, name: `Sensor ${i}`, type: 'sensor',
      capabilities: ['status'],
      zoneId: i < 10 ? 'z3' : 'z9',
      initialState: { status: 'off' },
    }));
    (raw.zones as unknown[]).push({
      id: 'z9', name: 'Zone 9', floor: 2,
      bounds: { minX: 0, maxX: 8, minY: 0, maxY: 8 },
      adjacentZoneIds: [],
      baseline: { temperature: 32 },
    });
    (raw.devices as unknown[]).push(...sensors);
    (raw.agents as unknown[]).push({
      id: 'keeper-9', name: 'Zone 9 Keeper', capabilities: ['status'],
      managesZoneIds: ['z9'], boundDeviceIds: ['sensor-10'],
    });
    const live = new EngineRuntime(loadScenarioFile(raw));
    runtimes.push(live);
    await live.step(10);
    const source = { scenario: live.scenario, worldState: live.exportWorldState() };
    expect(source.scenario.devices.length).toBeGreaterThanOrEqual(WHAT_IF_RADIUS_PRUNE_MIN_DEVICES);

    const auto = await runWhatIf(source, {
      intervention: { type: 'device_command', target: 'hvac-2', action: 'turn-off' },
      metrics: [{ name: 'temperature', zoneId: 'z2' }],
      durationSec: 60,
    });
    expect(auto.notes.some(note => note.includes('radius pruning'))).toBe(true);
    // Opt-out restores the full-world fork.
    const off = await runWhatIf(
      source,
      { intervention: { type: 'device_command', target: 'hvac-2', action: 'turn-off' }, metrics: [{ name: 'temperature', zoneId: 'z2' }], durationSec: 60 },
      { radiusPruning: false },
    );
    expect(off.notes.some(note => note.includes('radius pruning'))).toBe(false);
    expect(off.verdict).toBe(auto.verdict);
  }, 30_000);
});

// ============================================================================
// T27 (R3, u1-F4): the all-zero verdict 定性 — the HVAC→zone effect chain is
// INTACT (control case moves), so an all-zero "turn it off" answer is
// STATE/WINDOW semantics (setpoint == the zone's relaxation attractor: both
// arms sit inside the dead-band and the 30min window cannot show inertia),
// not broken physics. This pins the fixture behind the CAVEAT copy.
// ============================================================================

describe('T27: dead-band zero-delta is honest, the chain is not broken', () => {
  function deadbandScenario(hvacPowered: boolean) {
    return loadScenarioFile({
      version: '1.0',
      meta: { id: 'what-if-deadband', name: 'What-if Deadband' },
      zones: [
        {
          id: 'floor-1',
          name: 'Floor 1',
          bounds: { minX: 0, maxX: 8, minY: 0, maxY: 8 },
          // The attractor EQUALS the setpoint: the AC is already holding the
          // zone exactly where the outdoor physics relaxes to.
          baseline: { temperature: 24 },
        },
      ],
      devices: [
        {
          id: 'hvac-1',
          name: 'HVAC 1',
          type: 'hvac',
          capabilities: ['turn-on', 'turn-off', 'set-temperature'],
          zoneId: 'floor-1',
          initialState: { power: hvacPowered, status: hvacPowered ? 'on' : 'off', mode: 'cooling', targetTemperature: 24 },
        },
      ],
      agents: [
        {
          id: 'thermal-ops-1',
          name: 'ThermalOps',
          capabilities: ['temperature-control'],
          managesZoneIds: ['floor-1'],
          boundDeviceIds: ['hvac-1'],
        },
      ],
      events: [],
    });
  }

  it('turn-off on an ALREADY-OFF AC (u1\'s idle-session world): all-zero → inconclusive, CAVEAT names the causes', async () => {
    const live = new EngineRuntime(deadbandScenario(false));
    runtimes.push(live);
    await live.step(120);
    const result = await runWhatIf(
      { scenario: live.scenario, worldState: live.exportWorldState() },
      {
        intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-off' },
        metrics: [{ name: 'temperature', zoneId: 'floor-1' }, { name: 'energy', zoneId: 'floor-1' }],
        durationSec: 1800,
      },
    );
    expect(Object.values(result.delta).every(v => v === 0)).toBe(true);
    expect(result.verdict).toBe('inconclusive');
    // The CAVEAT names the checking order: state/dead-band first, then the
    // window's thermal inertia, then the wrong-target possibility.
    expect(result.explanation).toContain('dead-band');
    expect(result.explanation).toContain('thermal inertia');
    expect(result.explanation).toContain('1800s window');
  }, 30_000);

  it('「关空调 30 分钟」 at setpoint == attractor: only the energy meter moves (a small honest saving), not a zero world', async () => {
    const live = new EngineRuntime(deadbandScenario(true));
    runtimes.push(live);
    await live.step(120);
    const result = await runWhatIf(
      { scenario: live.scenario, worldState: live.exportWorldState() },
      {
        intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-off' },
        metrics: [{ name: 'temperature', zoneId: 'floor-1' }, { name: 'energy', zoneId: 'floor-1' }],
        durationSec: 1800,
      },
    );
    // The zone holds (setpoint == attractor — the dead-band), but the AC's
    // meter STOPS: a real, physical, small saving — the chain answers.
    expect(result.delta['temperature_floor-1']).toBe(0);
    expect(result.delta['energy_floor-1']).toBeLessThan(0);
  }, 30_000);

  it('CONTROL (same fixture, cooler setpoint): the chain answers with a real physical delta', async () => {
    const live = new EngineRuntime(deadbandScenario(true));
    runtimes.push(live);
    await live.step(120);
    const result = await runWhatIf(
      { scenario: live.scenario, worldState: live.exportWorldState() },
      {
        intervention: { type: 'device_command', target: 'hvac-1', action: 'set-temperature', value: 18 },
        metrics: [{ name: 'temperature', zoneId: 'floor-1' }, { name: 'energy', zoneId: 'floor-1' }],
        durationSec: 1800,
      },
    );
    // An ask the AC must WORK for moves the zone and the meter — the physics
    // chain the all-zero case was suspected of breaking.
    expect(result.verdict).not.toBe('inconclusive');
    expect(result.delta['temperature_floor-1']).toBeLessThan(0);
    expect(result.delta['energy_floor-1']).toBeGreaterThan(0);
  }, 30_000);
});

// ============================================================================
// R1 (B1-2/B1-3, u1 F2/F3): the taicang-campus replay — cross-building zh
// phrases and zone ids must scope the target, bare-关 maps, and the
// unmapped error is hygienic. Device names/ids/zones are the REAL template
// values (config/scenarios/taicang-campus.json).
// ============================================================================

const D_BUILDING = 'D栋（AI与物联网·图书馆）';
// The REAL parse surface mirrors the runtime: `commands` is the EXPANDED
// vocabulary (temperature-control → set-temperature — the prose-facing name
// the T2 delta patterns match), `rawCommands` the device's LITERAL face the
// T2 equivalence gate maps the proposal back onto.
const TAICANG_HVACS: WhatIfDeviceView[] = [
  { deviceId: 'bldg-m-hvac', name: 'M栋（多功能厅） 空调机组', type: 'hvac', zoneId: 'bldg-m-f1', commands: ['temperature-control', 'set-temperature', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
  { deviceId: 'bldg-s-hvac', name: 'S栋（体育场） 空调机组', type: 'hvac', zoneId: 'bldg-s-f1', commands: ['temperature-control', 'set-temperature', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
  { deviceId: 'bldg-c-hvac', name: 'C栋（创业与企业港） 空调机组', type: 'hvac', zoneId: 'bldg-c-f1', commands: ['temperature-control', 'set-temperature', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
  { deviceId: 'bldg-d-hvac', name: `${D_BUILDING} 空调机组`, type: 'hvac', zoneId: 'bldg-d-f1', commands: ['temperature-control', 'set-temperature', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
  { deviceId: 'bldg-e-hvac', name: 'E栋（智能金融） 空调机组', type: 'hvac', zoneId: 'bldg-e-f1', commands: ['temperature-control', 'set-temperature', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
  { deviceId: 'bldg-h-hvac', name: 'H栋（行政服务） 空调机组', type: 'hvac', zoneId: 'bldg-h-f1', commands: ['temperature-control', 'set-temperature', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
  { deviceId: 'bldg-j-hvac', name: 'J栋（学生中心） 空调机组', type: 'hvac', zoneId: 'bldg-j-f1', commands: ['temperature-control', 'set-temperature', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
  { deviceId: 'bldg-f-hvac', name: 'F栋（物联网与金融） 空调机组', type: 'hvac', zoneId: 'bldg-f-f1', commands: ['temperature-control', 'set-temperature', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
  { deviceId: 'bldg-g-hvac', name: 'G栋（文化科技） 空调机组', type: 'hvac', zoneId: 'bldg-g-f1', commands: ['temperature-control', 'set-temperature', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
  { deviceId: 'bldg-b-hvac', name: 'B栋（学者空间） 空调机组', type: 'hvac', zoneId: 'bldg-b-f1', commands: ['temperature-control', 'set-temperature', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
  { deviceId: 'bldg-a-hvac', name: 'A栋（四学院联合） 空调机组', type: 'hvac', zoneId: 'bldg-a-f1', commands: ['temperature-control', 'set-temperature', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
];
// campus-energy-manager binds METERS only — its own-scope cannot rescue a
// hvac question; correctness must come from the location scoping.
const ENERGY_MANAGER_METERS = new Set(['bldg-m-meter', 'bldg-d-meter', 'bldg-s-meter']);
const D_STEWARD_DEVICES = new Set([
  'bldg-d-sensor', 'bldg-d-hvac', 'bldg-d-light', 'bldg-d-purifier', 'bldg-d-smoke',
]);

describe('R1 what-if target resolution (u1 F2 replay: no more M栋 collapse)', () => {
  it('u1 #1: zh building phrase 「D栋图书馆的空调」 asked of the cross-building energy manager hits bldg-d-hvac', () => {
    const parsed = parseWhatIfText(
      'what if 把 D栋图书馆的空调关掉 30 分钟会怎样？',
      TAICANG_HVACS,
      { locale: 'zh-CN' },
      { deviceIds: ENERGY_MANAGER_METERS },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention.type).toBe('device_command');
      expect(parsed.intervention.target).toBe('bldg-d-hvac');
      expect(parsed.intervention.action).toBe('turn-off');
      expect(parsed.durationSec).toBe(1800);
    }
  });

  it('u1 #2: the zone id 「bldg-d-f1」 scopes the HVAC question to the D building unit', () => {
    const parsed = parseWhatIfText(
      'what if I turn off the HVAC of bldg-d-f1 for 30 minutes?',
      TAICANG_HVACS,
      {},
      { deviceIds: ENERGY_MANAGER_METERS },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention.target).toBe('bldg-d-hvac');
      expect(parsed.intervention.action).toBe('turn-off');
    }
  });

  it('u1 #3: the D steward asking its own district without naming it still wins its own AC (R101 own-device)', () => {
    const parsed = parseWhatIfText(
      'what if I turn off the HVAC for 30 minutes?',
      TAICANG_HVACS,
      {},
      { deviceIds: D_STEWARD_DEVICES },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention.target).toBe('bldg-d-hvac');
    }
  });

  it('multi-candidate disambiguation survives the zh scoping: 「图书馆的空调」 names the candidates, own device wins', () => {
    // A second D-floor AC makes the scoped set ambiguous — the note must
    // declare both candidates and the own-device choice basis.
    const withSecondD = [
      ...TAICANG_HVACS,
      { deviceId: 'bldg-d-hvac-2', name: `${D_BUILDING} 2F 空调机组`, type: 'hvac', zoneId: 'bldg-d-f2', commands: ['turn-on', 'turn-off'] },
    ];
    const parsed = parseWhatIfText(
      'what if 把 D栋图书馆的空调关掉 30 分钟会怎样？',
      withSecondD,
      {},
      { deviceIds: new Set(['bldg-d-hvac-2']) },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      const ambiguity = parsed.notes.find(note => note.includes('ambiguous target'));
      expect(ambiguity).toBeDefined();
      expect(ambiguity).toContain('bldg-d-hvac');
      expect(ambiguity).toContain('bldg-d-hvac-2');
      // No other building leaks into the candidate list.
      expect(ambiguity).not.toContain('M栋');
      expect(parsed.intervention.target).toBe('bldg-d-hvac-2');
    }
  });
});

// ============================================================================
// T25/T26 (R3, u1-F2/F3): the opener dictionary (zh tail questions, hyphen
// spelling) and natural type-word + zone-clue target resolution. Fixtures
// reuse the R1 taicang values (u1's real world).
// ============================================================================

const TAICANG_ZONES: ReadonlyArray<{ zoneId: string; name: string }> = TAICANG_HVACS.map(d => ({
  zoneId: d.zoneId!,
  name: d.name.replace(' 空调机组', '一层'),
}));

/** The D unit's live control state — the delta base for relative asks (T2). */
const TAICANG_WITH_D_STATE: WhatIfDeviceView[] = TAICANG_HVACS.map(d =>
  d.deviceId === 'bldg-d-hvac' ? { ...d, state: { targetTemperature: 24 } } : d,
);

describe('T25 (R3 u1-F2): opener dictionary — zh tail questions + hyphen spelling', () => {
  it('u1 verbatim: 「D栋图书馆 空调 调高2度会怎样」 — no line-initial opener, tail question maps the delta', () => {
    const parsed = parseWhatIfText(
      'D栋图书馆 空调 调高2度会怎样',
      TAICANG_WITH_D_STATE,
      { locale: 'zh-CN' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention).toEqual({
        type: 'device_command', target: 'bldg-d-hvac', action: 'temperature-control', value: 26,
      });
      // The mapping basis is DECLARED (the pick came from type/zone words).
      expect(parsed.notes.some(n => n.includes('type/zone words'))).toBe(true);
    }
  });

  it('u1 verbatim: hyphen spelling "what-if in building D raise AC setpoint by 2 degrees" opens the lane', () => {
    const parsed = parseWhatIfText(
      'what-if in building D raise AC setpoint by 2 degrees',
      TAICANG_WITH_D_STATE,
      { locale: 'en-US' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention).toEqual({
        type: 'device_command', target: 'bldg-d-hvac', action: 'temperature-control', value: 26,
      });
    }
  });

  it('「今天天气会怎样」 is NOT a what-if (no intervention cue → null for the ask lanes)', () => {
    expect(parseWhatIfText(
      '今天天气会怎样',
      TAICANG_WITH_D_STATE,
      { locale: 'zh-CN' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    )).toBeNull();
    expect(parseWhatIfText(
      '明天会下雨吗会怎么样',
      TAICANG_WITH_D_STATE,
      {},
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    )).toBeNull();
  });

  it('the unmapped teaching names the tail-question form (R102: the error teaches usable shapes)', () => {
    const parsed = parseWhatIfText(
      '如果明天下雨会怎样',
      TAICANG_HVACS,
      { locale: 'zh-CN' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    );
    expect(parsed !== null && 'error' in parsed).toBe(true);
    if (parsed !== null && 'error' in parsed) {
      expect(parsed.error).toContain('会怎样');
    }
  });
});

describe('T26 (R3 u1-F3): natural type-word + zone-clue target resolution', () => {
  it('"the AC unit in building D" + failure → device_disable on the D unit', () => {
    const parsed = parseWhatIfText(
      'what if the AC unit in building D fails?',
      TAICANG_HVACS,
      {},
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention).toEqual({ type: 'device_disable', target: 'bldg-d-hvac' });
      expect(parsed.notes.some(n => n.includes('type/zone words'))).toBe(true);
    }
  });

  it('"raise AC setpoint by 2 degrees" with NO building token stays ambiguous (declaring note, no silent pick)', () => {
    const withMState: WhatIfDeviceView[] = TAICANG_WITH_D_STATE.map(d =>
      d.deviceId === 'bldg-m-hvac' ? { ...d, state: { targetTemperature: 20 } } : d,
    );
    const parsed = parseWhatIfText(
      'what if raise AC setpoint by 2 degrees',
      withMState,
      {},
      { deviceIds: new Set(['bldg-m-hvac']), zones: TAICANG_ZONES },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      // The asker's own device wins the tie, and the note names EVERY
      // candidate (the R98 declaring discipline) — never a silent pick.
      expect(parsed.intervention.target).toBe('bldg-m-hvac');
      expect(parsed.intervention.value).toBe(22);
      const note = parsed.notes.find(n => n.includes('ambiguous target'));
      expect(note).toBeDefined();
      expect(note).toContain('bldg-d-hvac');
      expect(note).toContain("requester's own bound device");
    }
  });

  it('a temperature ask on a PURE on/off device teaches with the device face (no internal vocabulary)', () => {
    const withLight: WhatIfDeviceView[] = [
      ...TAICANG_WITH_D_STATE,
      { deviceId: 'bldg-d-light', name: `${D_BUILDING} 智能灯`, type: 'smart-light', zoneId: 'bldg-d-f1', commands: ['lighting-control', 'turn-on', 'turn-off'] },
    ];
    const parsed = parseWhatIfText(
      'what if in building D raise the light setpoint by 2 degrees',
      withLight,
      { locale: 'en-US' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    );
    expect(parsed !== null && 'error' in parsed).toBe(true);
    if (parsed !== null && 'error' in parsed) {
      expect(parsed.error).toContain('智能灯');
      expect(parsed.error).not.toContain('temperature-control');
    }
  });

  it('the word-boundary matcher: "trace" never summons the hvac type word AC', () => {
    const parsed = parseWhatIfText(
      'what if I keep a trace of the failure for 30 minutes?',
      TAICANG_HVACS,
      {},
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    );
    // No device cue → the unmapped teaching, not a random AC picked.
    expect(parsed !== null && 'error' in parsed).toBe(true);
  });
});

// ============================================================================
// T42 (R4, u1-F2): ABSOLUTE zh setpoints WITHOUT the 温度 noun — the error
// copy's officially suggested sentence parses. Fixtures reuse the taicang
// values (u1's real world); the D unit carries its live state so the
// relative examples keep resolving too.
// ============================================================================

describe('T42 (R4 u1-F2): absolute zh setpoints without the 温度 noun', () => {
  it('u1 verbatim: 「D栋（AI与物联网·图书馆） 空调机组 调到 26 度会怎样」 maps onto the D unit at 26', () => {
    const parsed = parseWhatIfText(
      'D栋（AI与物联网·图书馆） 空调机组 调到 26 度会怎样',
      TAICANG_WITH_D_STATE,
      { locale: 'zh-CN' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention).toEqual({
        type: 'device_command', target: 'bldg-d-hvac', action: 'temperature-control', value: 26,
      });
      // The mapping basis is DECLARED — the no-noun lane names its subject.
      expect(parsed.notes.some(n => n.includes('absolute temperature phrase'))).toBe(true);
    }
  });

  it('u1 verbatim: the zone-id form 「bldg-d-f1 的空调调到 26 度会怎样」 (the error copy\'s suggested shape) maps', () => {
    const parsed = parseWhatIfText(
      'bldg-d-f1 的空调调到 26 度会怎样',
      TAICANG_WITH_D_STATE,
      { locale: 'zh-CN' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention).toEqual({
        type: 'device_command', target: 'bldg-d-hvac', action: 'temperature-control', value: 26,
      });
    }
  });

  it('u1 verbatim: the full-name sentence with the 如果 opener maps too', () => {
    const parsed = parseWhatIfText(
      '如果把 D栋（AI与物联网·图书馆） 空调机组 调到 26 度会怎样？',
      TAICANG_WITH_D_STATE,
      { locale: 'zh-CN' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention.target).toBe('bldg-d-hvac');
      expect(parsed.intervention.value).toBe(26);
    }
  });

  it('调至/调成/设为 spellings join the lane (one family, one vocabulary)', () => {
    for (const verb of ['调至', '调成', '设为']) {
      const parsed = parseWhatIfText(
        `D栋 的空调${verb} 26 度会怎样`,
        TAICANG_WITH_D_STATE,
        { locale: 'zh-CN' },
        { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
      );
      expect(parsed).not.toBeNull();
      expect('error' in parsed!).toBe(false);
      if (!('error' in parsed!)) {
        expect(parsed.intervention.target).toBe('bldg-d-hvac');
        expect(parsed.intervention.value).toBe(26);
      }
    }
  });

  it('a zone-phrase subject without type word (「把 D栋调到 26 度会怎样」) resolves through the zone', () => {
    const parsed = parseWhatIfText(
      '把D栋调到 26 度会怎样',
      TAICANG_WITH_D_STATE,
      { locale: 'zh-CN' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention.target).toBe('bldg-d-hvac');
      expect(parsed.intervention.value).toBe(26);
      // The mapping basis is declared either way (name mention or zone).
      expect(parsed.notes.some(n => n.includes('absolute temperature phrase'))).toBe(true);
    }
  });

  it('AMBIGUITY: two hvacs in the scoped zone + absolute set → the disambiguation teaching, never a silent pick', () => {
    const withTwoD = [
      ...TAICANG_WITH_D_STATE,
      { deviceId: 'bldg-d-hvac-2', name: `${D_BUILDING} 2F 空调机组`, type: 'hvac', zoneId: 'bldg-d-f1', commands: ['temperature-control', 'set-temperature', 'cooling', 'turn-on', 'turn-off'] },
    ];
    const parsed = parseWhatIfText(
      'D栋图书馆 空调 调到 26 度会怎样',
      withTwoD,
      { locale: 'zh-CN' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    );
    expect(parsed !== null && 'error' in parsed).toBe(true);
    if (parsed !== null && 'error' in parsed) {
      // The teaching names the candidates by name (never ids) so the user
      // can disambiguate — and never silently picked one of the two.
      expect(parsed.error).toContain('空调机组');
    } else {
      expect.unreachable('expected the unmapped teaching for an ambiguous absolute set');
    }
  });

  it('「把 D 栋温度调到 26 度」: the noun-bearing lane (5c) is untouched', () => {
    const parsed = parseWhatIfText(
      '如果把D栋温度调到 26 度会怎样',
      TAICANG_WITH_D_STATE,
      { locale: 'zh-CN' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention).toEqual({
        type: 'device_command', target: 'bldg-d-hvac', action: 'set-temperature', value: 26,
      });
    }
  });

  it('a NON-temperature device subject falls through honestly (no guessed command, no re-aim at the zone HVAC)', () => {
    const withLight: WhatIfDeviceView[] = [
      ...TAICANG_WITH_D_STATE,
      { deviceId: 'bldg-d-light', name: `${D_BUILDING} 智能灯`, type: 'smart-light', zoneId: 'bldg-d-f1', commands: ['lighting-control', 'turn-on', 'turn-off'] },
    ];
    const parsed = parseWhatIfText(
      '如果把 D栋 智能灯调到 26 度会怎样',
      withLight,
      { locale: 'zh-CN' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: TAICANG_ZONES },
    );
    // The light has no temperature command; the honest fall-through is the
    // unmapped teaching (a guessed command or a silent re-aim at the zone's
    // HVAC would fabricate an intervention the user never asked for).
    expect(parsed !== null && 'error' in parsed).toBe(true);
  });
});

// ============================================================================
// T108 (R17, u2-F1): the setpoint lane (5d) accepts DISPLAY-NAME subjects —
// the punctuation real device names carry (「·（）.」) broke the subject run
// before 调到, so the name resolved (step 3 mentions) but the setpoint lane
// never fired and the question died in the unmapped teaching while listing
// the named device as its first candidate. The verbatim shapes are u2's.
// ============================================================================

describe('T108 (R17 u2-F1): display-name subjects reach the setpoint lane', () => {
  const DISPLAY_NAME = '陈功部署·格力云佳空调1.5匹（D栋2F教室）';
  const VENDOR_AC: WhatIfDeviceView[] = [
    {
      deviceId: 'ac-gree-d2f',
      name: DISPLAY_NAME,
      type: 'hvac',
      zoneId: 'bldg-d-f2',
      commands: ['set-temperature', 'turn-on', 'turn-off'],
    },
  ];
  const SCOPE = {
    deviceIds: new Set(['ac-gree-d2f']),
    zones: [{ zoneId: 'bldg-d-f2', name: 'D栋2F教室' }],
  };

  it('u2 verbatim: 「<display name> 调到 26 度会怎样」 maps onto the named unit at 26', () => {
    const parsed = parseWhatIfText(
      `${DISPLAY_NAME} 调到 26 度会怎样`,
      VENDOR_AC,
      { locale: 'zh-CN' },
      SCOPE,
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      // The named device, the named value — digits inside the name
      // ("1.5匹/2F") never leak into the setpoint slot.
      expect(parsed.intervention).toEqual({
        type: 'device_command', target: 'ac-gree-d2f', action: 'set-temperature', value: 26,
      });
      expect(parsed.notes.some(n => n.includes('is a literal device mention'))).toBe(true);
    }
  });

  it('「把 <display name>调到 20 度会怎样」 (u2\'s second verbatim, 把-opener) maps at 20', () => {
    const parsed = parseWhatIfText(
      `把 ${DISPLAY_NAME}调到 20 度会怎样`,
      VENDOR_AC,
      { locale: 'zh-CN' },
      SCOPE,
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      expect(parsed.intervention).toEqual({
        type: 'device_command', target: 'ac-gree-d2f', action: 'set-temperature', value: 20,
      });
    }
  });

  it('the noun-bearing lane (5c) takes display-name subjects too: 「<display name> 的温度调到 26 度」', () => {
    const parsed = parseWhatIfText(
      `${DISPLAY_NAME} 的温度调到 26 度会怎样`,
      VENDOR_AC,
      { locale: 'zh-CN' },
      SCOPE,
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      expect(parsed.intervention.target).toBe('ac-gree-d2f');
      expect(parsed.intervention.value).toBe(26);
    }
  });
});

// ============================================================================
// T48 (R5, u1-F1/F2 + u2-F2): the HONEST-FACE replay. The real XJTU-R2
// devices carry capability-named commands (NO set-temperature) and state
// without a setpoint; the zone names interleave official words
// (「D栋·AI与先进计算·物联网学院·图书馆 1F」) so a place phrase is a
// SUBSEQUENCE, not a substring. Every fix in this block is proven against
// that world, not the R4 expanded-vocabulary fixture.
// ============================================================================

/** The literal capability face + setpoint-less state, as the runtime ships. */
const HONEST_HVACS: WhatIfDeviceView[] = TAICANG_HVACS.map(d => ({
  ...d,
  commands: d.rawCommands,
  state: { status: 'off' },
}));
/** The REAL zone-name shape (u1's world) for the D building. */
const XJTU_ZONES: ReadonlyArray<{ zoneId: string; name: string }> = TAICANG_ZONES.map(z =>
  z.zoneId === 'bldg-d-f1' ? { zoneId: z.zoneId, name: 'D栋·AI与先进计算·物联网学院·图书馆 1F' } : z,
);

describe('T48 (R5 u1-F2): the verb-less 连写 place phrase resolves on honest faces', () => {
  const SENTENCES = [
    '把 D 栋图书馆空调调到 26 度会怎样',
    '把D栋图书馆空调调到26度会怎样',
    'D栋图书馆空调调到 26 度会怎样',
    '把 D 栋图书馆的空调调到 26 度会怎样',
  ];

  it('each variant maps onto the D-building HVAC at 26 (the R5 acceptance sentence, ×2 reproduced)', () => {
    for (const sentence of SENTENCES) {
      const parsed = parseWhatIfText(
        sentence,
        HONEST_HVACS,
        { locale: 'zh-CN' },
        { deviceIds: D_STEWARD_DEVICES, zones: XJTU_ZONES },
      );
      expect(parsed !== null && !('error' in parsed), `"${sentence}" must map`).toBe(true);
      if (parsed !== null && !('error' in parsed)) {
        expect(parsed.intervention).toEqual({
          type: 'device_command', target: 'bldg-d-hvac', action: 'temperature-control', value: 26,
        });
      }
    }
  });

  it('the cross-building asker (own scope = meters, cannot rescue) still resolves via the 图书馆 zone clue', () => {
    // The R5 production shape: the candidate list was M/C/J/H/A and the D
    // unit was nowhere — the place phrase must scope the type word.
    const parsed = parseWhatIfText(
      '把 D 栋图书馆空调调到 26 度会怎样',
      HONEST_HVACS,
      { locale: 'zh-CN' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: XJTU_ZONES },
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      expect(parsed.intervention.target).toBe('bldg-d-hvac');
    }
  });

  it('u2 F2: 「D栋2F 的空调调到 26 度会怎样」 scopes to the 2F unit (the floor phrase is a subsequence of the zone name)', () => {
    const withSecondFloor = [
      ...HONEST_HVACS,
      { deviceId: 'bldg-d-hvac-2', name: `${D_BUILDING} 2F 空调机组`, type: 'hvac', zoneId: 'bldg-d-f2', commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
    ];
    const zonesWithF2 = [
      ...XJTU_ZONES,
      { zoneId: 'bldg-d-f2', name: 'D栋·AI与先进计算·物联网学院·图书馆 2F' },
    ];
    const parsed = parseWhatIfText(
      'D栋2F 的空调调到 26 度会怎样',
      withSecondFloor,
      { locale: 'zh-CN' },
      { deviceIds: new Set(['bldg-d-hvac-2']), zones: zonesWithF2 },
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      expect(parsed.intervention.target).toBe('bldg-d-hvac-2');
      expect(parsed.intervention.value).toBe(26);
    }
  });

  it('the unmapped teaching ranks the place-phrase device FIRST (never M/C/J/H/A only)', () => {
    // The relative ask still honestly rejects (no setpoint on the face) —
    // but its candidate list must now be led by the D unit the question
    // named (the R5 complaint: 目标楼设备被完全旁路).
    const parsed = parseWhatIfText(
      'D栋空调 调高 2 度会怎样',
      HONEST_HVACS,
      { locale: 'zh-CN' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: XJTU_ZONES },
    );
    expect(parsed !== null && 'error' in parsed).toBe(true);
    if (parsed !== null && 'error' in parsed) {
      expect(parsed.error.indexOf('D栋（AI与物联网·图书馆）')).toBeLessThan(
        parsed.error.indexOf('M栋（多功能厅）'),
      );
    }
  });

  it('T48: the relative lane WORKS on an honest face once the state carries a setpoint (T2 equivalence intact)', () => {
    const withSetpoint: WhatIfDeviceView[] = HONEST_HVACS.map(d =>
      d.deviceId === 'bldg-d-hvac' ? { ...d, state: { status: 'on', targetTemperature: 24 } } : d,
    );
    const parsed = parseWhatIfText(
      'D栋空调 调高 2 度会怎样',
      withSetpoint,
      { locale: 'zh-CN' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: XJTU_ZONES },
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      expect(parsed.intervention).toEqual({
        type: 'device_command', target: 'bldg-d-hvac', action: 'temperature-control', value: 26,
      });
    }
  });

  it('T48: the EN absolute shape ("what if I set the AC in building D to 26 degrees") maps on honest faces', () => {
    const parsed = parseWhatIfText(
      'what if I set the AC in building D to 26 degrees',
      HONEST_HVACS,
      { locale: 'en-US' },
      { deviceIds: ENERGY_MANAGER_METERS, zones: XJTU_ZONES },
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      expect(parsed.intervention).toEqual({
        type: 'device_command', target: 'bldg-d-hvac', action: 'temperature-control', value: 26,
      });
    }
  });
});

describe('T42 (R4 u1-F5): the comfort metric prints its PROXY band, not a temperature range', () => {
  it('a comfort metric sentence labels the band "comfort band" — never an expected temperature range', () => {
    const scenario: WhatIfScenario = {
      intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-off' },
      metrics: [{ name: 'comfort', zoneId: 'floor-1' }],
      durationSec: 600,
    };
    const judged = judgeWhatIf(scenario, { 'comfort_floor-1': [0, 0] }, { 'comfort_floor-1': [0, 0.4] }, 0);
    expect(judged.explanation).toContain('comfort band 18–28');
    expect(judged.explanation).not.toContain('expected range');
    expect(judged.explanation).not.toContain('°C');
  });
});

describe('R1 what-if zh mapping + error hygiene (u1 F3 / B1-3)', () => {
  it('the bare post-noun 关 — 「把 D栋图书馆的空调关 30 分钟」 — maps like 关掉', () => {
    const parsed = parseWhatIfText(
      'what if 我把 D栋图书馆的空调关 30 分钟？',
      TAICANG_HVACS,
      { locale: 'zh-CN' },
      { deviceIds: D_STEWARD_DEVICES },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(false);
    if (!('error' in parsed!)) {
      expect(parsed.intervention.target).toBe('bldg-d-hvac');
      expect(parsed.intervention.action).toBe('turn-off');
    }
  });

  it('关 inside 相关/关键/开关 never misfires as turn-off', () => {
    const parsed = parseWhatIfText(
      'what if 把 D栋图书馆的空调的开关相关的参数调整 30 分钟会怎样？',
      TAICANG_HVACS,
      { locale: 'zh-CN' },
      { deviceIds: D_STEWARD_DEVICES },
    );
    // No turn-off keyword may be synthesized from 相关/开关 — the question
    // has no mappable actuation, so it must land on the (hygienic) error.
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(true);
  });

  it('the unmapped error names at most 5 ranked candidates instead of the full surface (was 115)', () => {
    const parsed = parseWhatIfText(
      'what if 把 D栋图书馆的投影仪关掉 30 分钟会怎样？',
      TAICANG_HVACS,
      { locale: 'zh-CN' },
      { deviceIds: D_STEWARD_DEVICES },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(true);
    if (!('error' in parsed!)) return;
    const message = parsed.error;
    // No full-surface flood: at most 5 candidate labels ride, each @zone.
    const candidateCount = (message.match(/@\S+\(/g) ?? []).length;
    expect(candidateCount).toBeGreaterThan(0);
    expect(candidateCount).toBeLessThanOrEqual(5);
    expect(message).toContain('最相关的候选设备');
    expect(message).toContain('device list --env');
    expect(message).toContain('全名或 id');
    // The ranking is RELEVANT: the location words put the D building first.
    expect(message.indexOf('D栋')).toBeGreaterThanOrEqual(0);
    expect(message.length).toBeLessThan(700);
  });

  it('when nothing about the question ranks, the error honestly carries NO device list', () => {
    const parsed = parseWhatIfText(
      'what if 万物互联 30 分钟会怎样？',
      TAICANG_HVACS,
      { locale: 'zh-CN' },
      { deviceIds: D_STEWARD_DEVICES },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(true);
    if (!('error' in parsed!)) return;
    expect(parsed.error).not.toContain('最相关的候选设备');
    expect(parsed.error).not.toContain('空调机组');
    expect(parsed.error).toContain('device list --env');
  });

  it('the English face keeps the same hygiene (≤5 candidates, next step)', () => {
    const parsed = parseWhatIfText(
      'what if the HVAC in the D building library is broken for 30 minutes?',
      TAICANG_HVACS,
      {},
      { deviceIds: ENERGY_MANAGER_METERS },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(true);
    if (!('error' in parsed!)) return;
    const candidateCount = (parsed.error.match(/@\S+\(/g) ?? []).length;
    expect(candidateCount).toBeGreaterThan(0);
    expect(candidateCount).toBeLessThanOrEqual(5);
    expect(parsed.error).toContain('Closest candidates');
    expect(parsed.error).not.toContain('Known devices');
    expect(parsed.error).toContain('device list --env');
  });

  it('small surfaces keep the R83 exhaustive teaching list (≤5 devices)', () => {
    const parsed = parseWhatIfText(
      'what if it rains tomorrow?',
      TAICANG_HVACS.slice(0, 3),
      { locale: 'zh-CN' },
      { deviceIds: D_STEWARD_DEVICES },
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(true);
    if (!('error' in parsed!)) return;
    expect(parsed.error).toContain('已知设备');
    expect(parsed.error).toContain('空调机组');
  });
});

// ============================================================================
// T2 (R2, u1-F1): what-if temperature asks — device-surface equivalence
// downgrade + honest teaching + relative-delta resolution
// ============================================================================

describe('T2: what-if temperature mapping (R2 u1-F1)', () => {
  /**
   * u1's D-building AC: capability-named surface, real current setpoint.
   * The companion thermostat is what put `set-temperature` into the parse
   * budget's world-wide command UNION at u1's site — the exact shape that
   * let the foreign command sail through to the target device.
   */
  const AC_VIEWS: WhatIfDeviceView[] = [
    {
      deviceId: 'ac-d-f1', name: 'D-Bldg AC', type: 'hvac', zoneId: 'bldg-d-f1',
      commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
      state: { targetTemperature: 24 },
    },
    {
      deviceId: 'thermo-d-lobby', name: 'D-Lobby Thermostat', type: 'thermostat', zoneId: 'bldg-d-f1',
      commands: ['set-temperature', 'temperature-reading'],
      state: { targetTemperature: 20 },
    },
  ];

  it('en "raise the setpoint by 2 degrees" downgrades onto the device surface with delta resolved', () => {
    const parsed = parseWhatIfText(
      "What if I raise D-Bldg AC's setpoint by 2 degrees for 30 minutes?",
      AC_VIEWS,
    );
    expect(parsed).not.toBeNull();
    expect('intervention' in parsed!).toBe(true);
    if (!('intervention' in parsed!)) return;
    // The command lands ON the device's face (never a 400 for a foreign name).
    expect(parsed.intervention.action).toBe('temperature-control');
    expect(parsed.intervention.target).toBe('ac-d-f1');
    // Relative ask resolved against the REAL setpoint: 24 + 2 = 26.
    expect(parsed.intervention.value).toBe(26);
    // The mapping is declared in the notes (honest degradation).
    expect(parsed.notes.some(n => n.includes('mapped to its "temperature-control"'))).toBe(true);
  });

  it('en "set 2 degrees higher" is a RELATIVE ask (was: absolute 2 clamped to 5)', () => {
    const parsed = parseWhatIfText(
      'What if I set D-Bldg AC 2 degrees higher for 30 minutes?',
      AC_VIEWS,
    );
    expect(parsed).not.toBeNull();
    if (!('intervention' in parsed!)) return;
    expect(parsed.intervention.action).toBe('temperature-control');
    expect(parsed.intervention.value).toBe(26);
  });

  it('zh 「调高 2 度」 (no 温度 keyword) reaches the same delta lane', () => {
    const zhViews: WhatIfDeviceView[] = [
      {
        deviceId: 'ac-d-f1', name: 'D栋空调', type: 'hvac', zoneId: 'bldg-d-f1',
        commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        state: { targetTemperature: 24 },
      },
    ];
    const parsed = parseWhatIfText('如果把D栋空调调高2度会怎样？', zhViews, { locale: 'zh-CN' });
    expect(parsed).not.toBeNull();
    if (!('intervention' in parsed!)) return;
    expect(parsed.intervention.action).toBe('temperature-control');
    expect(parsed.intervention.target).toBe('ac-d-f1');
    expect(parsed.intervention.value).toBe(26);
    expect(parsed.notes.some(n => n.includes('mapped to its "temperature-control"'))).toBe(true);
  });

  it('zh zone-relative ask (「客厅温度调高2度」) offsets the zone device setpoint', () => {
    const views: WhatIfDeviceView[] = STARTER_HOME_VIEWS.map(view =>
      view.deviceId.endsWith('0002')
        ? { ...view, state: { targetTemperature: 24 } }
        : view,
    );
    const parsed = parseWhatIfText('如果把客厅温度调高2度会怎样？', views, {
      locale: 'zh-CN',
    }, { deviceIds: new Set<string>(), zones: STARTER_HOME_ZONES });
    expect(parsed).not.toBeNull();
    if (!('intervention' in parsed!)) return;
    expect(parsed.intervention.type).toBe('device_command');
    expect(parsed.intervention.target).toBe('5f120af9-0000-4000-8000-000000000002');
    expect(parsed.intervention.value).toBe(26);
  });

  it('a device with no temperature face gets the teaching error (surface named, no bare command jargon)', () => {
    // A sibling hvac puts set-temperature into the budget UNION (u1's shape);
    // the named Lamp has no temperature face — the teaching error is the
    // honest landing.
    const lampViews: WhatIfDeviceView[] = [
      { deviceId: 'lamp-1', name: 'Lamp', type: 'light', zoneId: 'floor-1', commands: ['turn-on', 'turn-off'] },
      { deviceId: 'hvac-9', name: 'Back HVAC', type: 'hvac', zoneId: 'floor-2', commands: ['set-temperature', 'turn-on'] },
    ];
    const parsed = parseWhatIfText(
      'What if I set the Lamp setpoint to 24 degrees?',
      lampViews,
    );
    expect(parsed).not.toBeNull();
    expect('error' in parsed!).toBe(true);
    if (!('error' in parsed!)) return;
    expect(parsed.error).toContain('no temperature control');
    expect(parsed.error).toContain('turn-on, turn-off');
    expect(parsed.error).not.toContain('set-temperature');
  });

  it('zh teaching error names the face in the request locale', () => {
    const lampViews: WhatIfDeviceView[] = [
      { deviceId: 'lamp-1', name: 'Lamp', type: 'light', zoneId: 'floor-1', commands: ['turn-on', 'turn-off'] },
      { deviceId: 'hvac-9', name: 'Back HVAC', type: 'hvac', zoneId: 'floor-2', commands: ['set-temperature', 'turn-on'] },
    ];
    const parsed = parseWhatIfText('如果把Lamp温度调到24度会怎样？', lampViews, { locale: 'zh-CN' });
    expect(parsed).not.toBeNull();
    if (!('error' in parsed!)) return;
    expect(parsed.error).toContain('不支持温度设定');
    expect(parsed.error).not.toContain('set-temperature');
  });
});

// ============================================================================
// T90 (R12, u1-F-1): EN/ZH type/zone candidate-set PARITY — the same question
// shape must produce the SAME candidate set and the SAME adjudication in both
// languages. Regression: the EN official example's pure-digit segment (the
// setpoint "26") entered the location-subsequence lane and matched device-id
// UUID digit noise, dropping the real D-building unit and summoning random
// others — EN named 2 candidates while the zh twin named 3 on the same world.
// ============================================================================

/** The R12 (XJTU-R2) D-building trio — real names/zones, hvac-typed. */
const T90_D_TRIO: WhatIfDeviceView[] = [
  { deviceId: 'c61b3e06-8105-44be-a652-4fd3c22d0952', name: 'D栋（AI与物联网·图书馆） 空调机组', type: 'hvac', zoneId: 'bldg-d-f1', commands: ['temperature-control', 'turn-on', 'turn-off'] },
  { deviceId: 'fa58f143-bea2-40ea-8381-bfefe91848b6', name: '陈功部署·格力云佳空调1.5匹（D栋2F教室）', type: 'hvac', zoneId: 'bldg-d-f2', commands: ['temperature-control', 'turn-on', 'turn-off'] },
  { deviceId: 'e0ca7528-dd17-4d2d-867e-feb39f72dca6', name: '陈功部署·格力云佳空调1.5匹（D栋3F教室）', type: 'hvac', zoneId: 'bldg-d-f3', commands: ['temperature-control', 'turn-on', 'turn-off'] },
];

/** A foreign unit whose UUID carries the '2'…'6' digit subsequence — exactly
 *  the noise lane the setpoint "26" used to summon (and the AHU used to be
 *  dropped by). */
const T90_NOISY_M_UNIT: WhatIfDeviceView = {
  deviceId: 'aaaa0000-0000-0000-0000-000000a2b6c8',
  name: 'M栋（多功能厅） 空调机组',
  type: 'hvac',
  zoneId: 'bldg-m-f1',
  commands: ['temperature-control', 'turn-on', 'turn-off'],
};

const T90_DEVICES: WhatIfDeviceView[] = [...T90_D_TRIO, T90_NOISY_M_UNIT];

const T90_ZONES: ReadonlyArray<{ zoneId: string; name: string }> = [
  { zoneId: 'bldg-d-f1', name: 'D栋·AI与物联网·图书馆 1F' },
  { zoneId: 'bldg-d-f2', name: 'D栋·AI与物联网·图书馆 2F' },
  { zoneId: 'bldg-d-f3', name: 'D栋·AI与物联网·图书馆 3F' },
  { zoneId: 'bldg-m-f1', name: 'M栋·多功能厅 1F' },
];

/** Device ids named by a disambiguation error's `name (deviceId)@zone` labels. */
function candidateIdsOf(error: string): string[] {
  return [...error.matchAll(/\(([^()\s]+)\)@/g)].map(match => match[1]!).sort();
}

describe('T90 (R12 u1-F-1): EN/ZH type/zone candidate-set parity', () => {
  const EN_ASK = 'what if I set the AC in building D to 26 degrees';
  const ZH_TWIN = '把 D栋 的空调调到 26 度会怎样';

  it('the official EN example and its zh twin name the SAME candidate set (the D-building trio)', () => {
    const en = parseWhatIfText(EN_ASK, T90_DEVICES, { locale: 'en-US' }, { deviceIds: new Set<string>(), zones: T90_ZONES });
    const zh = parseWhatIfText(ZH_TWIN, T90_DEVICES, { locale: 'zh-CN' }, { deviceIds: new Set<string>(), zones: T90_ZONES });
    expect(en !== null && 'error' in en).toBe(true);
    expect(zh !== null && 'error' in zh).toBe(true);
    if (en === null || zh === null || !('error' in en) || !('error' in zh)) return;
    const enIds = candidateIdsOf(en.error);
    const zhIds = candidateIdsOf(zh.error);
    expect(enIds).toEqual(zhIds);
    expect(enIds).toEqual(candidateIdsOf(
      `x (${T90_D_TRIO.map(d => d.deviceId).join(')@z (')})@z`,
    ));
  });

  it('the setpoint digit run ("26") never summons UUID-digit-noise devices', () => {
    const parsed = parseWhatIfText(EN_ASK, T90_DEVICES, { locale: 'en-US' }, { deviceIds: new Set<string>(), zones: T90_ZONES });
    expect(parsed !== null && 'error' in parsed).toBe(true);
    if (parsed === null || !('error' in parsed)) return;
    expect(parsed.error).not.toContain(T90_NOISY_M_UNIT.deviceId);
    expect(parsed.error).toContain('D栋（AI与物联网·图书馆） 空调机组');
  });

  it('own-bound convergence agrees across languages: binding one of the trio resolves BOTH asks onto it', () => {
    const bound = { deviceIds: new Set([T90_D_TRIO[0]!.deviceId]), zones: T90_ZONES };
    const en = parseWhatIfText(EN_ASK, T90_DEVICES, { locale: 'en-US' }, bound);
    const zh = parseWhatIfText(ZH_TWIN, T90_DEVICES, { locale: 'zh-CN' }, bound);
    for (const parsed of [en, zh]) {
      expect(parsed).not.toBeNull();
      expect('error' in parsed!).toBe(false);
      if (!('error' in parsed!)) {
        expect(parsed.intervention.target).toBe(T90_D_TRIO[0]!.deviceId);
        // The declaring note names EVERY candidate (the R98 discipline).
        const note = parsed.notes.find(n => n.includes('type/zone words match'));
        expect(note).toBeDefined();
        for (const device of T90_D_TRIO) expect(note).toContain(device.deviceId);
        expect(note).not.toContain(T90_NOISY_M_UNIT.deviceId);
      }
    }
  });
});

// ============================================================================
// T104 (R16, u4-F3): the setpoint slot takes ANY value — the zone+type
// sentence 「<分区> 的空调调到 N 度会怎样」 used to parse only when the
// literal N happened NOT to collide with device-UUID digit noise: the
// zhao-12 digitTokens lane read the setpoint ("24") as a room number and
// digitSurvivors OUTRANKED the zone-clue survivors, so whether the ask
// resolved depended on whether "24" was a substring of some UUID (u4: 26
// passed on her world; 20/24/25/27 all 400'd — the help's own example
// shape, same sentence, five values, five outcomes). Degree-attached
// numbers are now stripped before location extraction, and THIS guard
// sweeps five values on a world whose TARGET UUID contains every one of
// them (the maximally hostile roster — the pre-fix parse fails it at
// 24/25/26/27).
// ============================================================================

/** Hex payload containing 20, 24, 25, 26 AND 27 as substrings. */
const T104_HOSTILE_UUID = '5a20a24a25a26a27b4b793c35d1e3ba1';
const T104_M_AC: WhatIfDeviceView = {
  deviceId: `5d${T104_HOSTILE_UUID.slice(2)}`,
  name: 'M栋（多功能厅） 空调机组',
  type: 'hvac',
  zoneId: 'bldg-m-f1',
  commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
  rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
};
const T104_D_AC: WhatIfDeviceView = {
  deviceId: 'c61b3e06-8105-44be-a652-4fd3c22d0952',
  name: 'D栋（AI与物联网·图书馆） 空调机组',
  type: 'hvac',
  zoneId: 'bldg-d-f1',
  commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
  rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
};
const T104_DEVICES: WhatIfDeviceView[] = [T104_M_AC, T104_D_AC];
const T104_ZONES = [
  { zoneId: 'bldg-m-f1', name: 'M栋·多功能厅 1F' },
  { zoneId: 'bldg-d-f1', name: 'D栋·AI与物联网·图书馆 1F' },
];

describe('T104 (R16 u4-F3): the setpoint slot parses ANY value (not just the example literal)', () => {
  for (const n of [20, 24, 25, 26, 27]) {
    it(`「M栋多功能厅 的空调调到 ${n} 度会怎样」 maps onto the M-building unit at value ${n}`, () => {
      const parsed = parseWhatIfText(
        `M栋多功能厅 的空调调到 ${n} 度会怎样`,
        T104_DEVICES,
        { locale: 'zh-CN' },
        { deviceIds: new Set([T104_M_AC.deviceId]), zones: T104_ZONES },
      );
      expect(parsed !== null && !('error' in parsed), () =>
        'error' in (parsed ?? {}) ? (parsed as { error: string }).error : 'returned null',
      ).toBe(true);
      if (parsed !== null && !('error' in parsed)) {
        expect(parsed.intervention.target).toBe(T104_M_AC.deviceId);
        expect(parsed.intervention.value).toBe(n);
      }
    });
  }

  it('the EN twin takes the swept values too ("set the AC in building M to 24 degrees")', () => {
    const parsed = parseWhatIfText(
      'what if I set the AC in building M to 24 degrees',
      T104_DEVICES,
      { locale: 'en-US' },
      { deviceIds: new Set([T104_M_AC.deviceId]), zones: T104_ZONES },
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      expect(parsed.intervention.target).toBe(T104_M_AC.deviceId);
      expect(parsed.intervention.value).toBe(24);
    }
  });

  it('zhao-12 room numbers keep their lane (unit-less "101" still scopes by digits)', () => {
    const roomAc: WhatIfDeviceView = {
      deviceId: 'ac-room-101',
      name: '101房间空调',
      type: 'hvac',
      zoneId: 'bldg-m-f1',
      commands: ['temperature-control', 'turn-on', 'turn-off'],
      rawCommands: ['temperature-control', 'turn-on', 'turn-off'],
    };
    const otherAc: WhatIfDeviceView = {
      deviceId: 'ac-room-202',
      name: '202房间空调',
      type: 'hvac',
      zoneId: 'bldg-m-f2',
      commands: ['temperature-control', 'turn-on', 'turn-off'],
      rawCommands: ['temperature-control', 'turn-on', 'turn-off'],
    };
    const zones = [
      { zoneId: 'bldg-m-f1', name: 'M栋 1F' },
      { zoneId: 'bldg-m-f2', name: 'M栋 2F' },
    ];
    const parsed = parseWhatIfText(
      '把 101房间 的空调调到 24 度会怎样',
      [roomAc, otherAc],
      { locale: 'zh-CN' },
      { deviceIds: new Set([roomAc.deviceId]), zones },
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      expect(parsed.intervention.target).toBe(roomAc.deviceId);
      expect(parsed.intervention.value).toBe(24);
    }
  });
});
