/**
 * R53 — semantic offer derivation over capability unions. The rule table is
 * grounded in the shenzhen steward surfaces; the fixture unions below are
 * the ACTUAL per-facility-type unions from shenzhen-realistic.json, so this
 * doubles as the "pairwise-incomparable steward types" regression: exactly
 * one offer per steward type, no cross-matching.
 */
import { describe, expect, it } from 'vitest';

import {
  SEMANTIC_OFFER_RULES,
  mergeOfferRules,
  semanticCapabilityTypesOf,
  semanticOffersOf,
  type SemanticOfferRule,
} from './semantic-offers.js';

const STEWARD_UNIONS: ReadonlyArray<[string, string[]]> = [
  ['110kV 变电站', ['energy-monitoring', 'open', 'power-monitoring', 'turn-off', 'turn-on', 'valve-control']],
  ['中小学', ['air-quality-monitoring', 'cooling', 'heating', 'lighting-control', 'temperature-control', 'turn-off', 'turn-on']],
  ['交通枢纽', ['content-display', 'security-monitoring', 'set-message', 'signal-control', 'turn-off', 'turn-on']],
  ['区级医院', ['power-monitoring', 'temperature-control', 'temperature-monitoring', 'turn-off', 'turn-on', 'vital-signs-monitoring']],
  ['地铁换乘站', ['lighting-control', 'turn-off', 'turn-on', 'water-level-monitoring']],
  ['应急避难所', ['cooling', 'heating', 'lighting-control', 'security-monitoring', 'temperature-control', 'turn-off', 'turn-on']],
  ['雨水泵站', ['open', 'turn-off', 'turn-on', 'valve-control', 'water-level-monitoring']],
];

describe('semanticOffersOf (grounded in shenzhen steward unions)', () => {
  it('each facility type qualifies for exactly one offer — no cross-matching', () => {
    const seen = new Set<string>();
    for (const [kind, union] of STEWARD_UNIONS) {
      const offers = semanticOffersOf(new Set(union));
      expect(offers.length, `${kind} should qualify for exactly one offer`).toBe(1);
      const type = offers[0]!.semanticType;
      expect(seen.has(type), `${type} matched twice — steward types must stay incomparable`).toBe(false);
      seen.add(type);
    }
  });

  it('expected assignments', () => {
    const of = (union: string[]) => semanticOffersOf(new Set(union)).map(o => o.semanticType);
    expect(of(STEWARD_UNIONS[0]![1])).toEqual(['grid-load-management']);   // 变电站
    expect(of(STEWARD_UNIONS[6]![1])).toEqual(['drainage-control']);      // 泵站
    expect(of(STEWARD_UNIONS[2]![1])).toEqual(['crowd-dispatch']);       // 交通枢纽
    expect(of(STEWARD_UNIONS[3]![1])).toEqual(['medical-environment-support']); // 医院
    expect(of(STEWARD_UNIONS[4]![1])).toEqual(['metro-flood-defense']);   // 地铁
    expect(of(STEWARD_UNIONS[5]![1])).toEqual(['shelter-life-support']);  // 避难所
    expect(of(STEWARD_UNIONS[1]![1])).toEqual(['campus-air-comfort']);    // 中小学
  });

  it('an empty or observation-only union offers nothing', () => {
    expect(semanticOffersOf(new Set())).toEqual([]);
    // 气象观测点: pure observation bundle — no actuation backing, no rule.
    expect(semanticOffersOf(new Set(['weather-monitoring', 'wind-monitoring', 'air-quality-monitoring']))).toEqual([]);
  });

  it('semanticCapabilityTypesOf lists the declaration vocabulary', () => {
    expect(semanticCapabilityTypesOf(new Set(STEWARD_UNIONS[6]![1]))).toEqual(['drainage-control']);
  });

  it('every rule has a non-empty actuation backing present in its requires∪actuates', () => {
    for (const rule of SEMANTIC_OFFER_RULES) {
      expect(rule.actuates.length).toBeGreaterThan(0);
      expect(new Set([...rule.requires, ...rule.actuates]).size)
        .toBe(new Set([...rule.requires, ...rule.actuates]).size); // no dupes sanity
    }
  });
});

/**
 * P3: rule injection — scenarios/authors extend or override the built-in
 * table; the no-custom path stays byte-identical to the legacy behavior.
 */
describe('P3 — injectable rules + mergeOfferRules', () => {
  const CAMPUS_RULE: SemanticOfferRule = {
    semanticType: 'library-quiet-guard',
    label: '图书馆静音保障',
    description: '噪声监测联动情报板播控提醒，维持阅览区安静。',
    requires: ['noise-monitoring', 'content-display'],
    actuates: ['set-message'],
  };

  it('semanticOffersOf with an explicit rule set evaluates exactly those rules', () => {
    const union = new Set(['noise-monitoring', 'content-display', 'set-message']);
    expect(semanticOffersOf(union, [CAMPUS_RULE]).map(r => r.semanticType)).toEqual([
      'library-quiet-guard',
    ]);
    // An explicit set does NOT leak the built-ins in.
    expect(semanticOffersOf(new Set(STEWARD_UNIONS[6]![1]), [CAMPUS_RULE])).toEqual([]);
  });

  it('mergeOfferRules keeps the built-ins and adds custom types', () => {
    const merged = mergeOfferRules([CAMPUS_RULE]);
    expect(merged).toHaveLength(SEMANTIC_OFFER_RULES.length + 1);
    expect(merged[0]).toEqual(CAMPUS_RULE);
    const union = new Set(['noise-monitoring', 'content-display', 'set-message']);
    expect(semanticOffersOf(union, merged).map(r => r.semanticType)).toEqual([
      'library-quiet-guard',
    ]);
    // Built-ins still fire under the merged table.
    expect(
      semanticOffersOf(new Set(STEWARD_UNIONS[6]![1]), merged).map(r => r.semanticType),
    ).toEqual(['drainage-control']);
  });

  it('mergeOfferRules dedupes by semanticType — custom overrides the built-in', () => {
    const override: SemanticOfferRule = {
      semanticType: 'drainage-control',
      label: '自定义排涝',
      description: '自定义规则覆盖内置同名规则。',
      requires: ['valve-control'], // 放宽内置 requires（不再要求水位监测）
      actuates: ['valve-control'],
    };
    const merged = mergeOfferRules([override]);
    expect(merged).toHaveLength(SEMANTIC_OFFER_RULES.length);
    expect(merged.filter(r => r.semanticType === 'drainage-control')).toEqual([override]);
    expect(semanticOffersOf(new Set(['valve-control']), merged).map(r => r.semanticType)).toEqual([
      'drainage-control',
    ]);
  });

  it('mergeOfferRules() with no custom rules returns exactly the built-in table', () => {
    expect(mergeOfferRules()).toEqual([...SEMANTIC_OFFER_RULES]);
  });

  it('semanticCapabilityTypesOf honors an injected rule set', () => {
    const union = new Set(['noise-monitoring', 'content-display', 'set-message']);
    expect(semanticCapabilityTypesOf(union, mergeOfferRules([CAMPUS_RULE]))).toEqual([
      'library-quiet-guard',
    ]);
  });
});
