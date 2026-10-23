/**
 * T42 (R4, u1-F2) + T48 (R5, u1-F1/F2) — the COPY-CONSISTENCY gate: the
 * what-if error copy and the help text may only ever teach sentence shapes
 * the parser ACTUALLY accepts. R102: an error's suggested retry forms are a
 * hard promise — u1 followed the unmapped error's own suggestion and failed
 * AGAIN, because the parser didn't know the shape it was teaching (or, R5,
 * because the taught relative form silently required a setpoint the real
 * device face never carried). This file makes that failure mode a red test:
 *
 *   1. every example in the core's UNMAPPED_WHAT_IF_EXAMPLES table (the ONE
 *      table the message builders AND `eaf help agent` consume — T48 收编)
 *      parses against an HONEST real-world fixture — substitute the
 *      placeholders, parse, expect an intervention;
 *   2. the sentences quoted verbatim in `eaf help agent` (the what-if
 *      paragraph) parse the same way — the help may not keep a second copy
 *      of examples that drifted from the table (T68b, R7 u1-F1: the EN
 *      examples are interpolated from the table too, and the help's
 *      "building D" sentence must resolve to the D-BUILDING device — it
 *      used to parse onto the wrong building's HVAC);
 *   3. the RELATIVE setpoint lane (「调高 2 度」) stays honest: it parses
 *      ONLY against a device whose live state exposes a setpoint, and it is
 *      no longer taught unconditionally (u1 F1: the campus HVAC face carries
 *      none, so the taught form was a dead loop);
 *   4. `eaf help flow` no longer teaches the retired drift wording
 *      (T40g) and carries the T36 execution-truth form instead.
 *
 * T48 fixture discipline: the devices mirror the REAL XJTU-R2 faces —
 * capability-named commands (temperature-control, NOT set-temperature) and
 * state WITHOUT a setpoint key. A fixture that quietly hands the parser a
 * `set-temperature` command or a `targetTemperature` state is how the R4
 * version of this test passed while the product 400'd.
 */

import { describe, expect, test } from 'vitest';

import {
  UNMAPPED_WHAT_IF_EXAMPLES,
  parseWhatIfText,
  type WhatIfDeviceView,
} from '@active-collaboration/core';

import { COMMAND_HELP } from '../help.js';

/**
 * The XJTU-R2 parse surface (u1's real world; mirrors the env-imported
 * devices): zh-named building HVACs whose `commands` face is the LITERAL
 * capability vocabulary and whose state carries NO setpoint — the honest
 * baseline every taught sentence must survive.
 */
const D_BUILDING = 'D栋（AI与物联网·图书馆）';
const DEVICES: WhatIfDeviceView[] = [
  { deviceId: 'bldg-m-hvac', name: 'M栋（多功能厅） 空调机组', type: 'hvac', zoneId: 'bldg-m-f1', commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], state: { zoneId: 'bldg-m-f1', status: 'off' } },
  { deviceId: 'bldg-s-hvac', name: 'S栋（体育场） 空调机组', type: 'hvac', zoneId: 'bldg-s-f1', commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], state: { status: 'on' } },
  { deviceId: 'bldg-d-hvac', name: `${D_BUILDING} 空调机组`, type: 'hvac', zoneId: 'bldg-d-f1', commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], state: { zoneId: 'bldg-d-f1', status: 'off' } },
];
const ZONES = [
  { zoneId: 'bldg-m-f1', name: 'M栋·多功能中心 1F' },
  { zoneId: 'bldg-s-f1', name: 'S栋·体育中心 1F' },
  { zoneId: 'bldg-d-f1', name: 'D栋·AI与先进计算·物联网学院·图书馆 1F' },
];
const OWN_SCOPE = new Set(['bldg-d-hvac']);

/** Placeholder → real reference on the fixture world. */
const PLACEHOLDERS: Record<string, string> = {
  '<设备>': `${D_BUILDING} 空调机组`,
  '<device>': 'bldg-d-hvac',
  '<分区>': 'D栋',
};

function substitute(example: string): string {
  return Object.entries(PLACEHOLDERS).reduce(
    (text, [token, value]) => text.split(token).join(value),
    example,
  );
}

function expectParses(example: string, locale: string): void {
  const sentence = substitute(example);
  const parsed = parseWhatIfText(
    sentence,
    DEVICES,
    { locale },
    { deviceIds: OWN_SCOPE, zones: ZONES },
  );
  const detail =
    parsed === null
      ? 'returned null (not recognized as a what-if question at all)'
      : 'error' in parsed
        ? `returned the unmapped teaching: ${parsed.error.slice(0, 120)}…`
        : `→ ${parsed.intervention.type}/${parsed.intervention.target ?? ''}/${parsed.intervention.action ?? ''}`;
  expect(
    parsed !== null && !('error' in parsed),
    `the copy teaches "${example}" but the parser cannot parse it (${detail})`,
  ).toBe(true);
}

describe('T42/T48 copy consistency: the error copy only teaches parseable shapes', () => {
  test('every zh example in UNMAPPED_WHAT_IF_EXAMPLES parses (the unmapped error is zh by default)', () => {
    for (const example of UNMAPPED_WHAT_IF_EXAMPLES.zh) {
      expectParses(example, 'zh-CN');
    }
  });

  test('every en example in UNMAPPED_WHAT_IF_EXAMPLES parses (unknown locales keep the English copy)', () => {
    for (const example of UNMAPPED_WHAT_IF_EXAMPLES.en) {
      expectParses(example, 'en-US');
    }
  });

  test('the table no longer teaches the RELATIVE setpoint shapes (u1 F1: dead loop on real faces)', () => {
    for (const example of [...UNMAPPED_WHAT_IF_EXAMPLES.zh, ...UNMAPPED_WHAT_IF_EXAMPLES.en]) {
      expect(example.includes('调高'), `"${example}" teaches the relative ask`).toBe(false);
      expect(/raises?\s+its\s+setpoint|lower/i.test(example), `"${example}" teaches the relative ask`).toBe(false);
    }
  });

  test('the relative lane still WORKS when the device exposes a setpoint (T2, honest boundary not a removal)', () => {
    const withSetpoint: WhatIfDeviceView[] = DEVICES.map(device =>
      device.deviceId === 'bldg-d-hvac'
        ? { ...device, state: { ...device.state, targetTemperature: 24 } }
        : device,
    );
    const parsed = parseWhatIfText(
      'D栋空调 调高 2 度会怎样',
      withSetpoint,
      { locale: 'zh-CN' },
      { deviceIds: OWN_SCOPE, zones: ZONES },
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      expect(parsed.intervention.type).toBe('device_command');
      expect(parsed.intervention.value).toBe(26); // 24 + 2 — the real setpoint offsets
    }
  });

  test('the relative ask on a setpoint-less face honestly rejects (never a guessed base)', () => {
    const parsed = parseWhatIfText(
      'D栋空调 调高 2 度会怎样',
      DEVICES,
      { locale: 'zh-CN' },
      { deviceIds: OWN_SCOPE, zones: ZONES },
    );
    expect(parsed !== null && 'error' in parsed).toBe(true);
  });

  test('the rendered zh error message carries the SAME table (no second copy of the examples)', () => {
    // Render the real error through the parser's own teaching face and make
    // sure every promised example appears in it.
    const parsed = parseWhatIfText(
      '如果明天下雨会怎样',
      DEVICES,
      { locale: 'zh-CN' },
      { deviceIds: OWN_SCOPE, zones: ZONES },
    );
    expect(parsed !== null && 'error' in parsed).toBe(true);
    if (parsed !== null && 'error' in parsed) {
      for (const example of UNMAPPED_WHAT_IF_EXAMPLES.zh) {
        expect(parsed.error).toContain(example);
      }
    }
  });

  test('T87 (R11, u1-F3): the rendered EN error message carries the SAME table (parity with the zh error)', () => {
    const parsed = parseWhatIfText(
      'what if it rains tomorrow',
      DEVICES,
      { locale: 'en-US' },
      { deviceIds: OWN_SCOPE, zones: ZONES },
    );
    expect(parsed !== null && 'error' in parsed).toBe(true);
    if (parsed !== null && 'error' in parsed) {
      for (const example of UNMAPPED_WHAT_IF_EXAMPLES.en) {
        expect(parsed.error).toContain(example);
      }
    }
  });

  test('T48 收编: `eaf help agent` teaches the TABLE, not a second copy', () => {
    const helpText = COMMAND_HELP.agent;
    expect(helpText).toContain('what-if');
    // Every zh example of the table appears verbatim in the help paragraph —
    // the help interpolates the table (one source), it does not re-type it.
    for (const example of UNMAPPED_WHAT_IF_EXAMPLES.zh) {
      expect(helpText).toContain(example);
    }
    // T68b (R7, u1-F1): the EN examples are the TABLE's too — the help's
    // "building D" sentence is the interpolated entry, never a second
    // (driftable) copy.
    for (const example of UNMAPPED_WHAT_IF_EXAMPLES.en) {
      expect(helpText).toContain(example);
    }
    // And every what-if sentence shape the help quotes verbatim parses.
    expectParses('D栋 的空调调到 26 度会怎样', 'zh-CN');
    expectParses('what if I set the AC in building D to 26 degrees', 'en-US');
    // The retired unconditionally-taught relative example is gone from help.
    expect(helpText).not.toContain('调高 2 度会怎样');
    expect(helpText).not.toContain('raises its setpoint by 2 degrees');
  });

  test('T68b (R7, u1-F1): the help-quoted EN building-D sentence resolves to the D-BUILDING device', () => {
    // u1's failure shape: the sentence parsed but landed on the M-building
    // HVAC (first match of a 7-device clause) with a confident neutral
    // verdict. The promise is not merely "parses" — the building clue
    // ("building D") must NARROW the type-word candidates to the D栋 device.
    const parsed = parseWhatIfText(
      'what if I set the AC in building D to 26 degrees',
      DEVICES,
      { locale: 'en-US' },
      { deviceIds: OWN_SCOPE, zones: ZONES },
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      expect(parsed.intervention.target).toBe('bldg-d-hvac');
      expect(parsed.intervention.value).toBe(26);
    }
  });

  test('T48 (u1-F2): the verb-less 连写 place phrase parses (D栋图书馆空调调到 26 度)', () => {
    // The exact acceptance sentence that failed twice in R5 — with and
    // without the 的, with and without spaces.
    expectParses('把 <分区>图书馆空调调到 26 度会怎样', 'zh-CN');
    for (const sentence of [
      '把 D 栋图书馆空调调到 26 度会怎样',
      '把D栋图书馆空调调到26度会怎样',
      'D栋图书馆空调调到 26 度会怎样',
    ]) {
      const parsed = parseWhatIfText(
        sentence,
        DEVICES,
        { locale: 'zh-CN' },
        { deviceIds: OWN_SCOPE, zones: ZONES },
      );
      expect(
        parsed !== null && !('error' in parsed),
        `"${sentence}" must map onto the D-building HVAC`,
      ).toBe(true);
      if (parsed !== null && !('error' in parsed)) {
        expect(parsed.intervention.target).toBe('bldg-d-hvac');
        expect(parsed.intervention.value).toBe(26);
      }
    }
  });

  test('T48 (u2-F2): a facility-place phrase scopes the type word without any device id', () => {
    const parsed = parseWhatIfText(
      'D栋图书馆 的空调调到 26 度会怎样',
      DEVICES,
      { locale: 'zh-CN' },
      { deviceIds: OWN_SCOPE, zones: ZONES },
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      expect(parsed.intervention.target).toBe('bldg-d-hvac');
    }
  });

  test('T40g: `eaf help flow` teaches the CURRENT drift wording (execution truth in the same breath)', () => {
    const flowHelp = COMMAND_HELP.flow;
    expect(flowHelp).not.toContain('no longer declared');
    expect(flowHelp).toContain("not declared by 'agent'");
    expect(flowHelp).toContain('executed via bound devices');
  });

  test('T87 (R11, u1-F3): the help promise is LAYERED — the parser promises the SHAPES, and the type/zone conditional (honest multi-candidate refusal) is named', () => {
    const helpText = COMMAND_HELP.agent;
    expect(helpText).toContain("the parser's own promise AS SHAPES");
    expect(helpText).toContain('honestly refuses');
    expect(helpText).toContain('name one device and ask again');
  });
});

/**
 * T69 (R8, u1-F1): the guard's own lesson — the T68b fixture world had ONE
 * device per building, so the zone clue always converged to a single
 * candidate and the tie branch was unreachable ("a guard that tests a world
 * where the tie cannot exist"). The REAL XJTU-R2 topology: 7+ HVAC devices
 * across buildings, and the D栋 butler bound to TWO same-type Gree ACs on
 * different floors. Every sentence below is judged against THAT shape.
 */
const D_GREE_1 = 'bldg-d-gree-1';
const D_GREE_2 = 'bldg-d-gree-2';
const REAL_DEVICES: WhatIfDeviceView[] = [
  { deviceId: 'bldg-m-hvac', name: 'M栋（多功能厅） 空调机组', type: 'hvac', zoneId: 'bldg-m-f1', commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], state: { status: 'off' } },
  { deviceId: 'bldg-c-hvac', name: 'C栋（实验中心） 空调机组', type: 'hvac', zoneId: 'bldg-c-f1', commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], state: { status: 'on' } },
  { deviceId: 'bldg-j-hvac', name: 'J栋（工程训练） 空调机组', type: 'hvac', zoneId: 'bldg-j-f1', commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], state: { status: 'off' } },
  { deviceId: 'bldg-h-hvac', name: 'H栋（行政楼） 空调机组', type: 'hvac', zoneId: 'bldg-h-f1', commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], state: { status: 'off' } },
  { deviceId: 'bldg-a-hvac', name: 'A栋（主教学楼） 空调机组', type: 'hvac', zoneId: 'bldg-a-f1', commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], state: { status: 'on' } },
  { deviceId: D_GREE_1, name: 'D栋格力空调-1', type: 'hvac', zoneId: 'bldg-d-f1', commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], state: { status: 'off' } },
  { deviceId: D_GREE_2, name: 'D栋格力空调-2', type: 'hvac', zoneId: 'bldg-d-f5', commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], state: { status: 'off' } },
];
const REAL_ZONES = [
  { zoneId: 'bldg-m-f1', name: 'M栋·多功能中心 1F' },
  { zoneId: 'bldg-c-f1', name: 'C栋·实验中心 1F' },
  { zoneId: 'bldg-j-f1', name: 'J栋·工程训练中心 1F' },
  { zoneId: 'bldg-h-f1', name: 'H栋·行政楼 1F' },
  { zoneId: 'bldg-a-f1', name: 'A栋·主教学楼 1F' },
  { zoneId: 'bldg-d-f1', name: 'D栋·AI与先进计算·物联网学院·图书馆 1F' },
  { zoneId: 'bldg-d-f5', name: 'D栋·AI与先进计算·物联网学院·图书馆 5F' },
];
const D_BUILDING_DEVICES = new Set([D_GREE_1, D_GREE_2]);
/** The real butler binds BOTH Gree ACs — the own-scope tie that killed T68b. */
const BUTLER_SCOPE = D_BUILDING_DEVICES;

describe('T69: the real-world shape — a zone clue survives adjudication (never cross-building first-match)', () => {
  test('the help EN sentence resolves into the D-BUILDING device SET on a 7-device cross-building world (own tie)', () => {
    const parsed = parseWhatIfText(
      'what if I set the AC in building D to 26 degrees',
      REAL_DEVICES,
      { locale: 'en-US' },
      { deviceIds: BUTLER_SCOPE, zones: REAL_ZONES },
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      expect(D_BUILDING_DEVICES.has(parsed.intervention.target as string)).toBe(true);
      expect(parsed.intervention.value).toBe(26);
      // The declaring note rides (R98/R99 family): the answer states its basis.
      expect(parsed.notes.join(' ')).toContain('own bound device');
    }
  });

  test('the same sentence names one own device FIRST OF 2 when the butler binds both (declared preference)', () => {
    const parsed = parseWhatIfText(
      'what if I set the AC in building D to 26 degrees',
      REAL_DEVICES,
      { locale: 'en-US' },
      { deviceIds: BUTLER_SCOPE, zones: REAL_ZONES },
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      expect(parsed.notes.join(' ')).toContain('first of 2');
    }
  });

  test('zh type/zone sentence also lands in the D-building set on the real shape', () => {
    const parsed = parseWhatIfText(
      'D栋 的空调调到 26 度会怎样',
      REAL_DEVICES,
      { locale: 'zh-CN' },
      { deviceIds: BUTLER_SCOPE, zones: REAL_ZONES },
    );
    expect(parsed !== null && !('error' in parsed)).toBe(true);
    if (parsed !== null && !('error' in parsed)) {
      expect(D_BUILDING_DEVICES.has(parsed.intervention.target as string)).toBe(true);
    }
  });

  test('NO own convergence: two D-building candidates → honest disambiguation naming BOTH (no single-sided pick)', () => {
    const outsiderScope = new Set(['bldg-m-hvac']); // the asker owns nothing in D
    const parsed = parseWhatIfText(
      'what if I set the AC in building D to 26 degrees',
      REAL_DEVICES,
      { locale: 'en-US' },
      { deviceIds: outsiderScope, zones: REAL_ZONES },
    );
    expect(parsed !== null && 'error' in parsed).toBe(true);
    if (parsed !== null && 'error' in parsed) {
      expect(parsed.error).toContain('D栋格力空调-1');
      expect(parsed.error).toContain('D栋格力空调-2');
      // Never a single-sided verdict about another building.
      expect(parsed.error).not.toContain('bldg-m-hvac');
    }
  });

  test('T87 (R11, u1-F3): every type/zone TABLE example (zh AND en) treats an asker who owns NO candidate the SAME — honest refusal naming ALL clue-hit devices, never a foreign single-sided pick', () => {
    // u1's asymmetry report (EN例句 BAD_REQUEST while the zh twin succeeded)
    // was her world's ROSTER (her agent bound no D-building device), not a
    // locale code path. The guard pins the OUTCOME parity: walked FROM the
    // table (the T48 收编 discipline — a future type/zone entry joins
    // automatically), every locale's twin on an outsider scope must refuse
    // honestly naming the same candidate roster.
    const outsiderScope = new Set(['bldg-m-hvac']);
    const examples: Array<{ example: string; locale: string }> = [
      ...UNMAPPED_WHAT_IF_EXAMPLES.zh
        .filter(example => example.includes('<分区>'))
        .map(example => ({ example, locale: 'zh-CN' })),
      ...UNMAPPED_WHAT_IF_EXAMPLES.en
        .filter(example => example.includes('building D'))
        .map(example => ({ example, locale: 'en-US' })),
    ];
    expect(examples.length).toBe(3); // zh 2 + en 1 — the current type/zone family
    for (const { example, locale } of examples) {
      const parsed = parseWhatIfText(
        substitute(example),
        REAL_DEVICES,
        { locale },
        { deviceIds: outsiderScope, zones: REAL_ZONES },
      );
      expect(
        parsed !== null && 'error' in parsed,
        `"${example}" must honestly refuse for an asker who owns no candidate`,
      ).toBe(true);
      if (parsed !== null && 'error' in parsed) {
        expect(parsed.error).toContain('D栋格力空调-1');
        expect(parsed.error).toContain('D栋格力空调-2');
        // Never a single-sided verdict about a device the asker owns.
        expect(parsed.error).not.toContain('bldg-m-hvac');
      }
    }
  });

  test('a zone clue that hits NO type device never first-matches another building (honest miss)', () => {
    const parsed = parseWhatIfText(
      'what if I set the AC in building H to 26 degrees',
      REAL_DEVICES,
      { locale: 'en-US' },
      { deviceIds: BUTLER_SCOPE, zones: REAL_ZONES },
    );
    // H栋 has no hvac device on the real shape: the parse must NOT silently
    // answer about another building's unit.
    const answeredCrossBuilding =
      parsed !== null && !('error' in parsed) &&
      !REAL_DEVICES.find(d => d.deviceId === parsed.intervention.target)?.zoneId.startsWith('bldg-h');
    expect(answeredCrossBuilding).toBe(false);
  });
});

/**
 * T104 (R16, u4-F3): the setpoint slot takes ANY value, on the REAL id shape.
 * u4's world carried UUID device ids, and the sentence parsed ONLY for the
 * values whose digits happened NOT to collide with those UUIDs (26 passed on
 * her roster; 20/24/25/27 400'd) — the guard fixtures above used clean
 * 'bldg-*-hvac' ids, so the digit-noise lane never fired in CI while the
 * product failed five sentences out of six. This suite pins the numeric slot
 * on UUID-bearing ids across the swept values (20/24/25/26/27 at minimum).
 */
const T104_UUID_WORLD: WhatIfDeviceView[] = [
  // The M-building unit's UUID contains 20, 24, 25, 26 AND 27 — maximally
  // hostile: the pre-fix digitTokens lane read every swept setpoint as a
  // room number and scattered the candidate set.
  { deviceId: '5da20a24a25a26a27b4b793c35d1e3ba1', name: 'M栋（多功能厅） 空调机组', type: 'hvac', zoneId: 'bldg-m-f1', commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
  { deviceId: 'c61b3e06-8105-44be-a652-4fd3c22d0952', name: 'D栋（AI与物联网·图书馆） 空调机组', type: 'hvac', zoneId: 'bldg-d-f1', commands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'], rawCommands: ['temperature-control', 'cooling', 'turn-on', 'turn-off'] },
];
const T104_UUID_ZONES = [
  { zoneId: 'bldg-m-f1', name: 'M栋·多功能厅 1F' },
  { zoneId: 'bldg-d-f1', name: 'D栋·AI与物联网·图书馆 1F' },
];

describe('T104: the setpoint slot parses 20/24/25/26/27 on UUID-bearing device ids (the real roster shape)', () => {
  const SETPOINT_VALUES = [20, 24, 25, 26, 27] as const;
  for (const value of SETPOINT_VALUES) {
    test(`「M栋多功能厅 的空调调到 ${value} 度会怎样」 (zh zone+type family) → M-building unit @ ${value}`, () => {
      const parsed = parseWhatIfText(
        `M栋多功能厅 的空调调到 ${value} 度会怎样`,
        T104_UUID_WORLD,
        { locale: 'zh-CN' },
        { deviceIds: new Set([T104_UUID_WORLD[0]!.deviceId]), zones: T104_UUID_ZONES },
      );
      expect(parsed !== null && !('error' in parsed), () =>
        parsed === null ? 'returned null' : 'error' in parsed ? parsed.error.slice(0, 120) : '').toBe(true);
      if (parsed !== null && !('error' in parsed)) {
        expect(parsed.intervention.target).toBe(T104_UUID_WORLD[0]!.deviceId);
        expect(parsed.intervention.value).toBe(value);
      }
    });
  }

  test('the EN twin sweeps too ("set the AC in building M to N degrees")', () => {
    for (const value of SETPOINT_VALUES) {
      const parsed = parseWhatIfText(
        `what if I set the AC in building M to ${value} degrees`,
        T104_UUID_WORLD,
        { locale: 'en-US' },
        { deviceIds: new Set([T104_UUID_WORLD[0]!.deviceId]), zones: T104_UUID_ZONES },
      );
      expect(parsed !== null && !('error' in parsed)).toBe(true);
      if (parsed !== null && !('error' in parsed)) {
        expect(parsed.intervention.target).toBe(T104_UUID_WORLD[0]!.deviceId);
        expect(parsed.intervention.value).toBe(value);
      }
    }
  });
});
