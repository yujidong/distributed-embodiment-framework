/**
 * @vitest-environment node
 *
 * R28 — the deterministic recommendation→actuation bridge (unit level).
 *
 * The R26 evidence: models REASON about budget devices in prose ("recommend
 * pausing battery charging to reduce load") but will not format the
 * structured actuations array. These tests pin the bridge's mapping rules:
 *   - device matching: deviceId literal > full name > type synonym; sole
 *     budget device resolves name-less clauses; ambiguity rejects honestly;
 *   - command matching: the budget's allowedCommands against the curated
 *     vocabulary; domain (set-*) outranks generic toggles;
 *   - param extraction: degrees → targetTemperature, rate/kW → rate,
 *     pause+charge → rate 0, mode words normalized to the device family;
 *   - honesty: unmappable action clauses become rejectedActuations with
 *     teaching reasons; narrative clauses produce nothing; nothing is guessed.
 * Budget enforcement itself (maxCommands etc.) is NOT here — the runner's
 * existing loop enforces it AFTER parsing (pinned in flow-delegate tests).
 */

import { describe, expect, it } from 'vitest';

import {
  bridgeCognitiveDeviceActions,
  bridgeRecommendationsToActuations,
  clauseLocationSegments,
  type RecommendationBridgeInput,
} from '../delegate-recommendation-bridge.js';
import type { DelegateBudgetDevice } from '../flow-delegate.js';

function inventoryOf(deviceId: string): DelegateBudgetDevice | undefined {
  const known: Record<string, DelegateBudgetDevice> = {
    'cc1b053a': {
      deviceId: 'cc1b053a', name: 'Battery Bank', type: 'battery', zoneId: 'tower-base',
      state: { charging: true, chargingRate: 30 },
    },
    '4131f1aa': { deviceId: '4131f1aa', name: 'UPS A', type: 'ups', zoneId: 'tower-base' },
    '941a30bc': { deviceId: '941a30bc', name: 'Grid-Tie Inverter', type: 'inverter', zoneId: 'tower-base' },
    'hvac-b1': {
      deviceId: 'hvac-b1', name: 'HVAC B1', type: 'hvac', zoneId: 'zone-b',
      state: { power: true, targetTemperature: 24, mode: 'cooling' },
    },
    'hvac-b2': { deviceId: 'hvac-b2', name: 'HVAC B2', type: 'hvac', zoneId: 'zone-b' },
    'bat-2': { deviceId: 'bat-2', name: 'Battery B2', type: 'battery', zoneId: 'tower-base' },
  };
  return known[deviceId];
}

function bridge(
  text: string,
  budget: { maxCommands: number; deviceIds: string[]; allowedCommands: string[] },
  withInventory = true,
): ReturnType<typeof bridgeRecommendationsToActuations> {
  const input: RecommendationBridgeInput = {
    text,
    budget,
    ...(withInventory ? { budgetDeviceOf: inventoryOf } : {}),
  };
  return bridgeRecommendationsToActuations(input);
}

const ENERGY_BUDGET = {
  maxCommands: 2,
  deviceIds: ['cc1b053a', '4131f1aa'],
  allowedCommands: ['set-charging', 'set-power'],
};
const HVAC_BUDGET = {
  maxCommands: 2,
  deviceIds: ['hvac-b1', 'hvac-b2'],
  allowedCommands: ['set-temperature', 'set-mode', 'turn-on', 'turn-off'],
};

describe('bridge — device matching', () => {
  it('matches by type synonym ("the battery" → the battery-type budget device)', () => {
    const result = bridge('pause battery charging to reduce load', ENERGY_BUDGET);
    expect(result.proposals).toEqual([
      { deviceId: 'cc1b053a', command: 'set-charging', params: { rate: 0 } },
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.actionVocabularySeen).toBe(true);
  });

  it('matches by full device name and by literal deviceId', () => {
    expect(bridge('set UPS A power to 5 kW', ENERGY_BUDGET).proposals).toEqual([
      { deviceId: '4131f1aa', command: 'set-power', params: { power: 5 } },
    ]);
    expect(bridge('cc1b053a charging rate 0.5', ENERGY_BUDGET).proposals).toEqual([
      { deviceId: 'cc1b053a', command: 'set-charging', params: { rate: 0.5 } },
    ]);
  });

  it('a name-less clause with a SOLE budget device resolves to it (degenerate budget)', () => {
    const result = bridge('set charging rate to 0', {
      maxCommands: 1, deviceIds: ['cc1b053a'], allowedCommands: ['set-charging'],
    });
    expect(result.proposals).toEqual([
      { deviceId: 'cc1b053a', command: 'set-charging', params: { rate: 0 } },
    ]);
  });

  it('a generic type reference matching SEVERAL budget devices actuates each (budget caps execution)', () => {
    const budget = { maxCommands: 2, deviceIds: ['cc1b053a', 'bat-2'], allowedCommands: ['set-charging'] };
    const result = bridge('pause battery charging', budget);
    // "battery" names the TYPE; both budget devices carry it — the reference
    // is generic, so the command applies to each (maxCommands bounds the
    // EXECUTION downstream, per-command, honestly).
    expect(result.proposals).toEqual([
      { deviceId: 'cc1b053a', command: 'set-charging', params: { rate: 0 } },
      { deviceId: 'bat-2', command: 'set-charging', params: { rate: 0 } },
    ]);
  });
});

describe('bridge — command vocabulary', () => {
  it('domain set-charging outranks the generic turn-off pause verb', () => {
    const result = bridge('recommend pausing battery charging to reduce load', ENERGY_BUDGET);
    expect(result.proposals.map(p => p.command)).toEqual(['set-charging']);
  });

  it('maps "set HVAC to 18 degrees cooling mode" onto temperature + mode', () => {
    const result = bridge('set HVAC B1 to 18 degrees cooling mode', HVAC_BUDGET);
    expect(result.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 18 } },
      { deviceId: 'hvac-b1', command: 'set-mode', params: { mode: 'cooling' } },
    ]);
  });

  it('normalizes loose mode synonyms onto the climate enum (cool → cooling)', () => {
    const result = bridge('switch HVAC B1 mode to cool', HVAC_BUDGET);
    expect(result.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-mode', params: { mode: 'cooling' } },
    ]);
  });

  it('"turn on the HVAC" maps to the generic toggle (no domain keyword present)', () => {
    const result = bridge('turn on HVAC B2', HVAC_BUDGET);
    expect(result.proposals).toEqual([{ deviceId: 'hvac-b2', command: 'turn-on' }]);
  });

  it('an unknown allowed command still matches by its own name words (generic fallback)', () => {
    const result = bridge('set brightness to 80 on HVAC B1', {
      maxCommands: 1, deviceIds: ['hvac-b1'], allowedCommands: ['set-brightness'],
    });
    expect(result.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-brightness', params: { brightness: 80 } },
    ]);
  });

  it('multi-device clauses produce one proposal per referenced device', () => {
    const budget = {
      maxCommands: 3, deviceIds: ['hvac-b1', 'hvac-b2'], allowedCommands: ['turn-off'],
    };
    const result = bridge('turn off HVAC B1 and HVAC B2', budget);
    expect(result.proposals.map(p => p.deviceId).sort()).toEqual(['hvac-b1', 'hvac-b2']);
  });

  it('repeated recommendations dedupe to one proposal per (device, command)', () => {
    const result = bridge('turn off HVAC B1. Also: turn off HVAC B1 again.', HVAC_BUDGET);
    expect(result.proposals).toEqual([{ deviceId: 'hvac-b1', command: 'turn-off' }]);
  });
});

describe('bridge — honesty', () => {
  it('an action clause naming no allowed command rejects with the allowed list', () => {
    const result = bridge('adjust the battery schedule to night rate', ENERGY_BUDGET);
    expect(result.proposals).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('recommendation bridge');
    expect(result.rejected[0].reason).toContain('set-charging, set-power');
    expect(result.actionVocabularySeen).toBe(true);
  });

  it('an action clause naming no budget device rejects naming the budget', () => {
    const result = bridge('set charging rate to 0 on the kitchen sink', ENERGY_BUDGET);
    expect(result.proposals).toEqual([]);
    expect(result.rejected[0].reason).toContain('no budget device matched');
    expect(result.rejected[0].reason).toContain('cc1b053a');
  });

  it('narrative clauses with no action vocabulary produce NOTHING (do-nothing is not a parse failure)', () => {
    const result = bridge('hold. Nothing needs action right now. Load is within limits.', ENERGY_BUDGET);
    expect(result.proposals).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.actionVocabularySeen).toBe(false);
  });

  it('gibberish recommendation text yields honest rejects, never fabricated proposals', () => {
    const result = bridge('flurb the wozzle set', ENERGY_BUDGET);
    expect(result.proposals).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.actionVocabularySeen).toBe(true);
  });

  it('survives a hostile flood (bounded clauses, no throw)', () => {
    const flood = Array.from({ length: 500 }, (_, i) => `set item ${i} to ${i}`).join('. ');
    const result = bridge(flood, ENERGY_BUDGET);
    expect(result.proposals.length).toBeLessThanOrEqual(64);
    expect(result.rejected.length).toBeLessThanOrEqual(16);
  });
});

describe('bridge — degenerate inventory', () => {
  it('without the inventory lookup, literal deviceIds still match and name/type references reject honestly', () => {
    const result = bridge('cc1b053a set charging rate 0.5', ENERGY_BUDGET, false);
    expect(result.proposals).toEqual([
      { deviceId: 'cc1b053a', command: 'set-charging', params: { rate: 0.5 } },
    ]);
    const noInventory = bridge('pause battery charging', ENERGY_BUDGET, false);
    expect(noInventory.proposals).toEqual([]);
    expect(noInventory.rejected[0].reason).toMatch(/no budget device matched|could not map/);
  });
});

// =============================================================================
// R33 (Smart F5) — param safety: delta prose resolves relatively; extracted
// numerics pass the device-safe ranges (temperature 5–40°C, rate 0–1,
// power 0–100%); impossible absolutes reject with a teaching reason.
// The R33 evidence: "reduce by 1-2 degrees" commanded ABSOLUTE
// targetTemperature -1/-2 onto live HVACs with no range guard anywhere.
// =============================================================================

describe('bridge — R33 delta prose (Smart F5)', () => {
  it('"reduce by N degrees" offsets the device\'s CURRENT setpoint, not an absolute', () => {
    // hvac-b1 carries targetTemperature 24 in the inventory.
    const down = bridge('reduce HVAC B1 temperature by 2 degrees', HVAC_BUDGET);
    expect(down.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 22 } },
    ]);
    expect(down.rejected).toEqual([]);
    const up = bridge('raise HVAC B1 temperature by 1.5 degrees', HVAC_BUDGET);
    expect(up.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 25.5 } },
    ]);
  });

  it('staged delta prose ("reduce by 1-2 degrees") stays a per-clause relative change', () => {
    const result = bridge('reduce HVAC B1 temperature by 1-2 degrees', HVAC_BUDGET);
    expect(result.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 23 } },
    ]);
    // THE BUG: this used to produce targetTemperature -1 (an absolute).
    expect(JSON.stringify(result.proposals)).not.toContain('-1');
  });

  it('T2 (R2 u1-F1): post-quantity delta prose ("2 degrees higher") offsets the setpoint', () => {
    // u1's phrasing — "2 degrees higher" used to parse as an ABSOLUTE 2 and
    // clamp to 5°C; it is a relative ask offsetting the current setpoint.
    const result = bridge('set HVAC B1 2 degrees higher', HVAC_BUDGET);
    expect(result.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 26 } },
    ]);
    const cooler = bridge('set HVAC B1 3 degrees cooler', HVAC_BUDGET);
    expect(cooler.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 21 } },
    ]);
  });

  it('T2 (R2 u1-F1): signed degree prose ("setpoint +2 degrees") is a delta; "to -2" stays absolute', () => {
    const up = bridge('raise HVAC B1 setpoint +2 degrees', HVAC_BUDGET);
    expect(up.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 26 } },
    ]);
    // An explicit absolute ("to -2 degrees") keeps the impossible-range
    // rejection — the lookbehind guard keeps the signed-delta pattern away.
    const absolute = bridge('set HVAC B1 to -2 degrees', HVAC_BUDGET);
    expect(absolute.proposals).toEqual([]);
    expect(absolute.rejected).toHaveLength(1);
    expect(absolute.rejected[0].reason).toContain('5–40°C');
  });

  it('T2 (R2 u1-F1): zh relative shape 「调高 2 度」 hits the temperature ask without a 温度 keyword', () => {
    const zhUp = bridge('把HVAC B1调高2度', HVAC_BUDGET);
    expect(zhUp.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 26 } },
    ]);
    const zhDown = bridge('把HVAC B1调低3度', HVAC_BUDGET);
    expect(zhDown.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 21 } },
    ]);
    // Non-degree quantities stay out (「湿度降低 10」 is a humidity ask).
    const humidity = bridge('把湿度降低 10', HVAC_BUDGET);
    expect(humidity.proposals).toEqual([]);
  });

  it('a delta on a device with no readable setpoint rejects with a teaching reason', () => {
    // hvac-b2 has no state in the inventory — nothing to offset.
    const result = bridge('lower HVAC B2 temperature by 2 degrees', HVAC_BUDGET);
    expect(result.proposals).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].deviceId).toBe('hvac-b2');
    expect(result.rejected[0].reason).toContain('RELATIVE change');
    expect(result.rejected[0].reason).toContain('no current setpoint');
    expect(result.rejected[0].reason).toContain('ABSOLUTE');
  });

  it('a delta overshooting the safe range clamps to the boundary (recorded, never silent)', () => {
    const result = bridge('reduce HVAC B1 temperature by 30 degrees', HVAC_BUDGET);
    expect(result.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 5 } },
    ]);
    expect(result.clamped).toHaveLength(1);
    expect(result.clamped[0]).toContain('5–40°C');
  });
});

describe('bridge — R33 device-safe ranges (Smart F5)', () => {
  it('an impossible ABSOLUTE temperature rejects with the range + the relative phrasing', () => {
    const negative = bridge('set HVAC B1 to -2 degrees', HVAC_BUDGET);
    expect(negative.proposals).toEqual([]);
    expect(negative.rejected).toHaveLength(1);
    expect(negative.rejected[0].reason).toContain('5–40°C');
    expect(negative.rejected[0].reason).toContain('NOT actuated');
    expect(negative.rejected[0].reason).toContain('lower by 2 degrees');

    const absurd = bridge('set HVAC B1 to 90 degrees', HVAC_BUDGET);
    expect(absurd.proposals).toEqual([]);
    expect(absurd.rejected[0].reason).toContain('90');
  });

  it('a plausible-but-unsafe absolute clamps to the boundary with a note', () => {
    const hot = bridge('set HVAC B1 to 45 degrees', HVAC_BUDGET);
    expect(hot.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 40 } },
    ]);
    expect(hot.clamped[0]).toContain('40');
    const cold = bridge('set HVAC B1 to 2 degrees', HVAC_BUDGET);
    expect(cold.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 5 } },
    ]);
  });

  it('rate: percent prose converts to 0–1; impossible rates reject', () => {
    const percent = bridge('set battery charging to 50%', {
      maxCommands: 1, deviceIds: ['cc1b053a'], allowedCommands: ['set-charging'],
    });
    expect(percent.proposals).toEqual([
      { deviceId: 'cc1b053a', command: 'set-charging', params: { rate: 0.5 } },
    ]);
    const impossible = bridge('set battery charging rate to 3', {
      maxCommands: 1, deviceIds: ['cc1b053a'], allowedCommands: ['set-charging'],
    });
    expect(impossible.proposals).toEqual([]);
    expect(impossible.rejected[0].reason).toContain('0–1');
  });

  it('power: out-of-range levels clamp or reject per the band', () => {
    const clamped = bridge('set UPS A power to 120%', ENERGY_BUDGET);
    expect(clamped.proposals).toEqual([
      { deviceId: '4131f1aa', command: 'set-power', params: { power: 100 } },
    ]);
    expect(clamped.clamped[0]).toContain('0–100%');
    const impossible = bridge('set UPS A power to 500', ENERGY_BUDGET);
    expect(impossible.proposals).toEqual([]);
    expect(impossible.rejected[0].reason).toContain('0–100%');
  });

  it('in-range values pass through untouched (no clamped noise)', () => {
    const result = bridge('set HVAC B1 to 18 degrees cooling mode', HVAC_BUDGET);
    expect(result.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 18 } },
      { deviceId: 'hvac-b1', command: 'set-mode', params: { mode: 'cooling' } },
    ]);
    expect(result.clamped).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 1 (cognitive architecture §14.1) — the STRUCTURED deviceActions lane
// ---------------------------------------------------------------------------

describe('bridgeCognitiveDeviceActions (Phase 1 structured lane)', () => {
  const budget = {
    maxCommands: 8,
    deviceIds: ['hvac-b1', 'light-l2'],
    allowedCommands: ['set-temperature', 'turn-on', 'set-brightness'],
  };

  it('passes a valid own-device command through untouched', () => {
    const result = bridgeCognitiveDeviceActions({
      deviceActions: [{ deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 24 } }],
      budget,
    });
    expect(result.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 24 } },
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.actionVocabularySeen).toBe(true);
  });

  it('matches device ids case-insensitively and normalizes command case', () => {
    const result = bridgeCognitiveDeviceActions({
      deviceActions: [{ deviceId: 'HVAC-B1', command: 'Turn-On' }],
      budget,
    });
    expect(result.proposals).toEqual([{ deviceId: 'hvac-b1', command: 'turn-on' }]);
  });

  it('REJECTS unbound devices — no type-synonym rescue onto a different device', () => {
    const result = bridgeCognitiveDeviceActions({
      deviceActions: [{ deviceId: 'hvac-999', command: 'set-temperature', params: { targetTemperature: 24 } }],
      budget,
    });
    expect(result.proposals).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('hvac-999');
    expect(result.rejected[0].reason).toContain('not one of your bound devices');
    // teaching: the rejection names the devices the model DOES own
    expect(result.rejected[0].reason).toContain('hvac-b1');
  });

  it('rejects commands outside the allowed surface with a teaching reason', () => {
    const result = bridgeCognitiveDeviceActions({
      deviceActions: [{ deviceId: 'hvac-b1', command: 'self-destruct' }],
      budget,
    });
    expect(result.proposals).toEqual([]);
    expect(result.rejected[0].reason).toContain('self-destruct');
    expect(result.rejected[0].reason).toContain('set-temperature');
  });

  it('applies the R33 device-safe ranges: clamp near-range, reject impossible', () => {
    const clamped = bridgeCognitiveDeviceActions({
      deviceActions: [{ deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 55 } }],
      budget,
    });
    expect(clamped.proposals).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 40 } },
    ]);
    expect(clamped.clamped[0]).toContain('40');

    const impossible = bridgeCognitiveDeviceActions({
      deviceActions: [{ deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: -5 } }],
      budget,
    });
    expect(impossible.proposals).toEqual([]);
    expect(impossible.rejected[0].reason).toContain('device-safe range');
  });

  it('dedupes repeated (device, command) pairs and drops malformed entries honestly', () => {
    const result = bridgeCognitiveDeviceActions({
      deviceActions: [
        { deviceId: 'light-l2', command: 'set-brightness', params: { brightness: 80 } },
        { deviceId: 'light-l2', command: 'set-brightness', params: { brightness: 20 } },
        { deviceId: '', command: 'set-brightness' },
        { deviceId: 'light-l2', command: '' },
      ],
      budget,
    });
    // first occurrence wins; malformed entries reject with reasons
    expect(result.proposals).toEqual([
      { deviceId: 'light-l2', command: 'set-brightness', params: { brightness: 80 } },
    ]);
    expect(result.rejected).toHaveLength(2);
  });

  it('unknown non-numeric params ride verbatim (generic set-* semantics)', () => {
    const result = bridgeCognitiveDeviceActions({
      deviceActions: [{ deviceId: 'light-l2', command: 'set-brightness', params: { brightness: 65 } }],
      budget,
    });
    expect(result.proposals).toEqual([
      { deviceId: 'light-l2', command: 'set-brightness', params: { brightness: 65 } },
    ]);
  });
});

// ============================================================================
// R46-P0 — zh (Chinese) vocabulary: a Chinese clause used to look like
// narrative prose to the keyword table (no hit → no record, nothing mapped).
// ============================================================================

const ZH_INVENTORY: Record<string, DelegateBudgetDevice> = {
  'bao-pump-v1': { deviceId: 'bao-pump-v1', name: '排涝智能阀 1', type: 'smart-valve', zoneId: 'bao-pump' },
  'bao-pump-v2': { deviceId: 'bao-pump-v2', name: '排涝智能阀 2', type: 'smart-valve', zoneId: 'bao-pump' },
  'fu-shelter-h1': { deviceId: 'fu-shelter-h1', name: '避难所空调 1', type: 'hvac', zoneId: 'fu-shelter', state: { targetTemperature: 24 } },
};

const ZH_BUDGET = {
  maxCommands: 4,
  deviceIds: ['bao-pump-v1', 'bao-pump-v2', 'fu-shelter-h1'],
  allowedCommands: ['valve-control', 'open', 'turn-on', 'turn-off', 'set-temperature', 'cooling', 'heating'],
};

function zhBridge(text: string): ReturnType<typeof bridgeRecommendationsToActuations> {
  return bridgeRecommendationsToActuations({
    text,
    budget: ZH_BUDGET,
    budgetDeviceOf: deviceId => ZH_INVENTORY[deviceId],
  });
}

describe('bridge — R46-P0 zh vocabulary', () => {
  it('"把阀门全部打开" maps open onto every smart-valve (domain verb, zh type synonym)', () => {
    const result = zhBridge('把阀门全部打开');
    expect(result.proposals).toEqual([
      { deviceId: 'bao-pump-v1', command: 'open' },
      { deviceId: 'bao-pump-v2', command: 'open' },
    ]);
    expect(result.rejected).toEqual([]);
  });

  it('"把避难所空调温度调到 26 度" extracts targetTemperature 26', () => {
    const result = zhBridge('把避难所空调温度调到 26 度');
    expect(result.proposals).toEqual([
      { deviceId: 'fu-shelter-h1', command: 'set-temperature', params: { targetTemperature: 26 } },
    ]);
  });

  it('"关闭排涝智能阀 2" maps turn-off onto the NAMED valve only', () => {
    const result = zhBridge('关闭排涝智能阀 2');
    expect(result.proposals).toEqual([
      { deviceId: 'bao-pump-v2', command: 'turn-off' },
    ]);
  });

  it('"温度降低 2 度" is a RELATIVE change resolved against the current setpoint', () => {
    const result = zhBridge('把避难所空调温度降低 2 度');
    expect(result.proposals).toEqual([
      { deviceId: 'fu-shelter-h1', command: 'set-temperature', params: { targetTemperature: 22 } },
    ]);
  });

  it('an unmappable zh directive rejects honestly instead of vanishing as narrative', () => {
    const result = zhBridge('请帮我把情况处理好');
    expect(result.proposals).toEqual([]);
    expect(result.actionVocabularySeen).toBe(true);
    expect(result.rejected.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// R99 (zhao-07): disambiguation notes — a generic TYPE-word clause matching
// several devices declares the candidates and the choice basis. Never
// interactive; the answer always states its mapping.
// ============================================================================

describe('bridge — R99 disambiguation notes (zhao-07)', () => {
  it('a type-word clause with several candidates lists them all + the first-match basis', () => {
    const result = bridge('turn off the hvac', HVAC_BUDGET);
    // Behavior unchanged: both devices still get the proposal…
    expect(result.proposals.map(p => p.deviceId)).toEqual(['hvac-b1', 'hvac-b2']);
    // …but the mapping is now DECLARED.
    const note = result.notes.find(n => n.includes('ambiguous target'));
    expect(note).toBeDefined();
    expect(note).toContain('HVAC B1');
    expect(note).toContain('HVAC B2');
    expect(note).toContain('first match');
  });

  it('the requester\'s bound device wins the tie and the note says so', () => {
    const result = bridgeRecommendationsToActuations({
      text: 'turn off the hvac',
      budget: { ...HVAC_BUDGET, scopeDeviceIds: new Set(['hvac-b2']) },
      budgetDeviceOf: inventoryOf,
    });
    expect(result.proposals.map(p => p.deviceId)).toEqual(['hvac-b2']);
    const note = result.notes.find(n => n.includes('ambiguous target'));
    expect(note).toBeDefined();
    expect(note).toContain('HVAC B1');
    expect(note).toContain('HVAC B2');
    expect(note).toContain("requester's own bound device");
  });

  it('a collective marker (全部) is intentional — proposals for all, NO ambiguity note', () => {
    const result = zhBridge('把阀门全部打开');
    expect(result.proposals).toHaveLength(2);
    expect(result.notes.some(n => n.includes('ambiguous target'))).toBe(false);
  });

  it('naming several devices deliberately is intentional — NO ambiguity note', () => {
    const result = bridge('turn off HVAC B1 and HVAC B2', HVAC_BUDGET);
    expect(result.proposals.map(p => p.deviceId)).toEqual(['hvac-b1', 'hvac-b2']);
    expect(result.notes.some(n => n.includes('ambiguous target'))).toBe(false);
  });

  it('a single candidate stays quiet', () => {
    const result = bridge('set HVAC B1 to 18 degrees cooling mode', HVAC_BUDGET);
    expect(result.notes.some(n => n.includes('ambiguous target'))).toBe(false);
  });

  it('R101 (zhao-12): a location token scopes type-word candidates — meeting-202 stays out of a 101 question, the owner\'s 101-named AC stays in', () => {
    const inventory: Record<string, DelegateBudgetDevice> = {
      'zhao-ac': { deviceId: 'zhao-ac', name: '赵-101空调', type: 'hvac', zoneId: 'lab-101' },
      'li-ac': { deviceId: 'li-ac', name: 'lab-101 格力空调', type: 'hvac', zoneId: 'lab-101' },
      'meeting-ac': { deviceId: 'meeting-ac', name: 'meeting-202 格力空调', type: 'hvac', zoneId: 'meeting-202' },
    };
    const budget = {
      maxCommands: 4,
      deviceIds: ['li-ac', 'meeting-ac', 'zhao-ac'],
      allowedCommands: ['turn-off', 'turn-on', 'set-temperature'],
    };
    const result = bridgeRecommendationsToActuations({
      text: '把 101 的空调 turn off 会怎样',
      budget: { ...budget, scopeDeviceIds: new Set(['zhao-ac']) },
      budgetDeviceOf: deviceId => inventory[deviceId],
    });
    // The requester's own bound AC wins the tie…
    expect(result.proposals.map(p => p.deviceId)).toEqual(['zhao-ac']);
    // …the note lists every (scoped) candidate with its zone — and the
    // meeting-202 unit is NOT one of them.
    const note = result.notes.find(n => n.includes('ambiguous target'));
    expect(note).toBeDefined();
    expect(note).toContain('赵-101空调');
    expect(note).toContain('lab-101 格力空调');
    expect(note).not.toContain('meeting-202 格力空调');
    expect(note).toContain("requester's own bound device");
  });
});

// ============================================================================
// T90 (R12, u1-F-1): a pure-digit run is NOT a location segment. Setpoints
// ("to 26 degrees"), counts and durations ride the question text; the
// zhao-12 digitTokens lane owns numerals with EXACT containment. Letting
// "26" into the subsequence lane matched device-id UUID digit noise — the
// EN example's candidate set diverged from its zh twin on the same world.
// ============================================================================

describe('T90: clauseLocationSegments excludes pure-digit runs', () => {
  it('a setpoint number is not a place word; mixed zh place phrases survive', () => {
    const segments = clauseLocationSegments(
      'what if I set the AC in building D to 26 degrees',
      ['ac', 'hvac', '空调'],
    );
    expect(segments).toEqual([]);
    const zh = clauseLocationSegments(
      '把 D栋图书馆空调调到 26 度会怎样',
      ['ac', 'hvac', '空调'],
    );
    expect(zh).toContain('d栋图书馆');
    expect(zh).not.toContain('26');
  });

  it('room numbers stay on the digitTokens lane (exact containment), not the segment lane', () => {
    // 「101」 is scoped via digitSurvivors (zhao-12) — the segment list must
    // not carry it, or every hex device id containing the digits 1→0→1
    // subsequence becomes a fake "location" match. (「分钟」 is a CJK word and
    // was always a segment — not a T90 concern.)
    const segments = clauseLocationSegments('把 101 的空调关掉 30 分钟会怎样', ['ac', 'hvac', '空调']);
    expect(segments).not.toContain('101');
    expect(segments).not.toContain('30');
  });
});
