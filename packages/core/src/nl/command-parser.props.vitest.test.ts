/**
 * @vitest-environment node
 *
 * Wave F2-1 (docs/plan-r84-verification-framework.md): fast-check property
 * tests for the NL command parser — historical NL/parse bugs distilled into
 * universal properties:
 *
 *   P1 own-first disambiguation (R76-F4): several members place the same
 *      catalog device under the same name; an equal-run tie resolved by
 *      listing order used to land the command on SOMEONE ELSE'S device.
 *      Property: among the longest-run fragment candidates, if any is OWN,
 *      the first pick is own — a foreign device wins only with a STRICTLY
 *      longer run. Rollback check: dropping the own-first tiebreak from
 *      bestNameFragmentMatches turns this property red.
 *   P2 fragment matching determinism (R75-F8): same input → same output,
 *      and the result is always a subset of the input candidates.
 *   P3 arbitrary Unicode input never throws (emoji, zero-width chars,
 *      over-long walls of text) and always yields a vocabulary-legal intent.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  bestNameFragmentMatches,
  classifyAction,
  detectEmergency,
  parseNLCommandIntent,
  ruleParseNLCommand,
} from './command-parser.js';
import type { NLCommandAction, NLDeviceView, NLZoneView } from './types.js';

// ---------------------------------------------------------------------------
// Oracle: longest common run, mirroring the (private) commonRunLength so the
// property can state the expected ordering independently of the impl's
// internal helpers. Char-based, O(n·m·k) — texts/names here are tiny.
// ---------------------------------------------------------------------------
function oracleCommonRunLength(a: string, b: string): number {
  let best = 0;
  for (let i = 0; i < a.length && a.length - i > best; i++) {
    for (let j = 0; j < b.length && b.length - j > best; j++) {
      if (a[i] !== b[j]) continue;
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

function oracleThreshold(name: string, minRun: number): number {
  return Math.max(/[一-鿿]/.test(name) ? 2 : 4, minRun);
}

/** The full expected pick list under the documented ordering. */
function oraclePicks(
  text: string,
  devices: ReadonlyArray<{ deviceId: string; name: string }>,
  max: number,
  minRun: number,
  own: ReadonlySet<string>,
): string[] {
  const lower = text.toLowerCase();
  const scored = devices
    .map((device, index) => {
      const run = oracleCommonRunLength(lower, device.name.toLowerCase());
      return run >= oracleThreshold(device.name, minRun)
        ? { id: device.deviceId, run, own: own.has(device.deviceId), index }
        : null;
    })
    .filter((entry): entry is { id: string; run: number; own: boolean; index: number } => entry !== null)
    .sort((a, b) => b.run - a.run || Number(b.own) - Number(a.own) || a.index - b.index);
  const picks: string[] = [];
  for (const entry of scored) {
    if (!picks.includes(entry.id)) picks.push(entry.id);
    if (picks.length >= max) break;
  }
  return picks;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** fast-check v4 dropped fullUnicodeString/stringOf — build a full-Unicode unit by hand. */
const fullCharArb: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 0x20, max: 0x7e }).map(c => String.fromCodePoint(c)), // ASCII printable
  fc.integer({ min: 0x4e00, max: 0x9fff }).map(c => String.fromCodePoint(c)), // CJK
  fc.integer({ min: 0x1f300, max: 0x1f64f }).map(c => String.fromCodePoint(c)), // emoji
  fc.integer({ min: 0x80, max: 0x2fff }).map(c => String.fromCodePoint(c)), // latin-ext, punctuation, CJK symbols
  fc.constantFrom('​', '‍', '‎', '\n', '\t', '\r', '́'),
);
const unicodeTextArb = (maxLength: number, minLength = 0): fc.Arbitrary<string> =>
  fc.string({ unit: fullCharArb, minLength, maxLength });

const CJK_CHARS = '格力空调会议室楼层温度传感器灯光新风变电站南山宝安人体存在窗帘投影'.split('');
const LATIN_CHARS = 'abcdefghijklmnopqrstuvwxyz'.split('');

const cjkNameArb = fc.string({ unit: fc.constantFrom(...CJK_CHARS), minLength: 2, maxLength: 10 });
const latinNameArb = fc.string({ unit: fc.constantFrom(...LATIN_CHARS), minLength: 4, maxLength: 12 })
  .map(s => `device-${s}`);
const nameArb = fc.oneof(cjkNameArb, latinNameArb);

/** Text that references a name: full name, a ≥threshold fragment, optionally wrapped in command prose. */
function referencingTextArb(names: string[]): fc.Arbitrary<string> {
  const fragmentArb = fc.constantFrom(...names).chain(name => {
    const min = oracleThreshold(name, 0);
    if (name.length < min) return fc.constant(name);
    return fc
      .tuple(fc.integer({ min: 0, max: name.length - min }), fc.integer({ min, max: name.length }))
      .filter(([start, len]) => start + len <= name.length)
      .map(([start, len]) => name.substring(start, start + len));
  });
  return fc.oneof(
    fc.constantFrom(...names),
    fragmentArb,
    fragmentArb.map(f => `打开${f}`),
    fragmentArb.map(f => `please turn on ${f} now`),
    fragmentArb.map(f => `${f}，谢谢`),
    unicodeTextArb(40),
  );
}

interface ParserWorld {
  devices: NLDeviceView[];
  text: string;
  own: Set<string>;
  max: number;
  minRun: number;
}

const worldArb: fc.Arbitrary<ParserWorld> = fc
  .record({
    names: fc.array(nameArb, { minLength: 1, maxLength: 4 }),
    count: fc.integer({ min: 1, max: 8 }),
  })
  .chain(({ names, count }) =>
    fc
      .tuple(
        fc.array(fc.constantFrom(...names), { minLength: count, maxLength: count }),
        referencingTextArb(names),
      )
      .chain(([pickedNames, text]) => {
        const devices: NLDeviceView[] = pickedNames.map((name, i) => ({
          deviceId: `dev-${i}`,
          name,
          type: 'hvac',
          online: true,
          commands: [],
        }));
        return fc
          .tuple(
            fc.subarray(devices.map(d => d.deviceId)),
            fc.integer({ min: 1, max: 5 }),
            fc.constantFrom(0, 3),
          )
          .map(([ownIds, max, minRun]) => ({
            devices,
            text,
            own: new Set(ownIds),
            max,
            minRun,
          }));
      }),
  );

const ACTIONS: readonly NLCommandAction[] = [
  'set_parameter', 'run_flow', 'get_status', 'optimize', 'emergency', 'help', 'unknown',
];

// ---------------------------------------------------------------------------
// P1 — own-first disambiguation (R76-F4)
// ---------------------------------------------------------------------------

describe('bestNameFragmentMatches properties (R76-F4 own-first)', () => {
  it('matches the documented ordering: longest run, own breaks ties, listing order breaks the rest', () => {
    fc.assert(
      fc.property(worldArb, ({ devices, text, own, max, minRun }) => {
        const result = bestNameFragmentMatches(text, devices, max, minRun, own);
        expect(result).toEqual(oraclePicks(text, devices, max, minRun, own));
      }),
      { numRuns: 300 },
    );
  });

  it('never lands on a foreign device while an OWN candidate ties for the longest run', () => {
    fc.assert(
      fc.property(worldArb, ({ devices, text, own, max, minRun }) => {
        const result = bestNameFragmentMatches(text, devices, max, minRun, own);
        const lower = text.toLowerCase();
        const candidates = devices
          .map(d => ({
            id: d.deviceId,
            run: oracleCommonRunLength(lower, d.name.toLowerCase()),
          }))
          .filter(c => {
            const name = devices.find(d => d.deviceId === c.id)!.name;
            return c.run >= oracleThreshold(name, minRun);
          });
        if (candidates.length === 0) {
          expect(result).toEqual([]);
          return;
        }
        const topRun = Math.max(...candidates.map(c => c.run));
        const ownAtTop = candidates.some(c => c.run === topRun && own.has(c.id));
        if (ownAtTop) {
          expect(own.has(result[0])).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a strictly longer foreign run still wins (honest explicit reference)', () => {
    fc.assert(
      fc.property(worldArb, ({ devices, text, own, max, minRun }) => {
        const result = bestNameFragmentMatches(text, devices, max, minRun, own);
        if (result.length === 0) return;
        const lower = text.toLowerCase();
        const candidates = devices
          .map(d => ({ id: d.deviceId, name: d.name, run: oracleCommonRunLength(lower, d.name.toLowerCase()) }))
          .filter(c => c.run >= oracleThreshold(c.name, minRun));
        const topRun = Math.max(...candidates.map(c => c.run));
        const topCandidates = candidates.filter(c => c.run === topRun);
        if (topCandidates.every(c => !own.has(c.id))) {
          // No own candidate at the top run — the pick is a top-run foreign device.
          expect(topCandidates.some(c => c.id === result[0])).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// P2 — fragment matching determinism + candidate subset (R75-F8)
// ---------------------------------------------------------------------------

describe('fragment matching determinism (R75-F8)', () => {
  it('same input → same output; result ⊆ input candidates; unique; ≤ max', () => {
    fc.assert(
      fc.property(worldArb, ({ devices, text, own, max, minRun }) => {
        const a = bestNameFragmentMatches(text, devices, max, minRun, own);
        const b = bestNameFragmentMatches(text, devices, max, minRun, own);
        expect(b).toEqual(a);
        const ids = devices.map(d => d.deviceId);
        for (const id of a) expect(ids).toContain(id);
        expect(new Set(a).size).toBe(a.length);
        expect(a.length).toBeLessThanOrEqual(max);
      }),
      { numRuns: 300 },
    );
  });

  it('ruleParseNLCommand is deterministic end to end', () => {
    const zones: NLZoneView[] = [
      { zoneId: 'zone-a', name: '3F会议室' },
      { zoneId: 'zone-b', name: 'Lobby' },
    ];
    fc.assert(
      fc.property(worldArb, ({ devices, text }) => {
        const a = ruleParseNLCommand({ text, devices, zones });
        const b = ruleParseNLCommand({ text, devices, zones });
        expect(b).toEqual(a);
        const ids = devices.map(d => d.deviceId);
        for (const id of a.targetDevices ?? []) expect(ids).toContain(id);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// P3 — arbitrary Unicode input never throws
// ---------------------------------------------------------------------------

const hostileTextArb = fc.oneof(
  unicodeTextArb(200),
  // Zero-width chars, emoji, RTL marks, combining sequences.
  fc.string({
    unit: fc.constantFrom('​', '‍', '‎', '🔥', '🚨', '́', '打', '开', 'a', '1', ' ', '\n', '\t'),
    maxLength: 120,
  }),
  // Over-long walls of text (the parser caps at MAX_TEXT_LENGTH = 2000).
  unicodeTextArb(6000, 1900),
);

const unicodeDeviceArb: fc.Arbitrary<NLDeviceView> = fc.record({
  deviceId: unicodeTextArb(16, 1),
  name: unicodeTextArb(24, 1),
  type: unicodeTextArb(12),
  online: fc.boolean(),
  commands: fc.constant([] as string[]),
});

const unicodeZoneArb: fc.Arbitrary<NLZoneView> = fc.record({
  zoneId: unicodeTextArb(16, 1),
  name: unicodeTextArb(24, 1),
});

describe('Unicode robustness', () => {
  it('rule lane + classifiers never throw on arbitrary Unicode', () => {
    fc.assert(
      fc.property(
        hostileTextArb,
        fc.array(unicodeDeviceArb, { maxLength: 6 }),
        fc.array(unicodeZoneArb, { maxLength: 6 }),
        (text, devices, zones) => {
          let intent: ReturnType<typeof ruleParseNLCommand> | undefined;
          expect(() => {
            intent = ruleParseNLCommand({ text, devices, zones });
          }).not.toThrow();
          expect(ACTIONS).toContain(intent!.action);
          expect(() => detectEmergency(text)).not.toThrow();
          expect(() => classifyAction(text)).not.toThrow();
          expect(() => bestNameFragmentMatches(text, devices, 3)).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('parseNLCommandIntent (rule-only agent) never rejects on arbitrary Unicode', async () => {
    await fc.assert(
      fc.asyncProperty(
        hostileTextArb,
        fc.array(unicodeDeviceArb, { maxLength: 6 }),
        fc.array(unicodeZoneArb, { maxLength: 6 }),
        async (text, devices, zones) => {
          const intent = await parseNLCommandIntent({ text, devices, zones });
          expect(ACTIONS).toContain(intent.action);
          expect(['rules', 'llm', 'rules-llm-down']).toContain(intent.parseSource);
        },
      ),
      { numRuns: 150 },
    );
  });
});
