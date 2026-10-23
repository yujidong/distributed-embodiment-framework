/**
 * T70 (R8, u1-F2): the ONE command-equivalence judgment.
 *
 * R8 found the same ask judged by THREE vocabularies: the NL execution filter
 * (declared face), the verification fork (snapshot face) and the device
 * dispatch (which additionally accepts handler-alias spellings) — so
 * `set-temperature` was "not exposed" by two faces and EXECUTED by the third.
 * Every face now resolves through `resolveCommandEquivalence`; these tests
 * pin the shared computation.
 */
import { describe, expect, test } from 'vitest';
import { resolveCommandEquivalence, temperatureCommandRank } from './command-equivalence.js';

describe('resolveCommandEquivalence', () => {
  test('a verbatim face member resolves to itself', () => {
    expect(resolveCommandEquivalence('turn-on', ['turn-on', 'turn-off'])).toBe('turn-on');
  });

  test("canonical 'set-temperature' maps onto a capability-named face's temperature setter", () => {
    // The R8 shape: D-building Gree ACs declare temperature-control/cooling,
    // not set-temperature — the ask must ride the equivalence, not fall off.
    expect(
      resolveCommandEquivalence('set-temperature', ['temperature-control', 'cooling', 'turn-on', 'turn-off']),
    ).toBe('temperature-control');
  });

  test("'cooling' ask on a file-scenario face maps to the canonical setter", () => {
    expect(resolveCommandEquivalence('cooling', ['set-temperature', 'turn-on'])).toBe('set-temperature');
  });

  test('a command the face cannot serve at all resolves to undefined (reject with teaching, never rewrite)', () => {
    expect(resolveCommandEquivalence('set-temperature', ['turn-on', 'turn-off'])).toBeUndefined();
    expect(resolveCommandEquivalence('open-valve', ['temperature-control', 'turn-on'])).toBeUndefined();
  });

  test('read-only sensor faces never "control" — an ask is not mapped onto a monitoring surface', () => {
    expect(temperatureCommandRank('temperature-reading')).toBe(-1);
    expect(temperatureCommandRank('temperature-monitoring')).toBe(-1);
    expect(resolveCommandEquivalence('set-temperature', ['temperature-reading', 'temperature-monitoring']))
      .toBeUndefined();
  });

  test('among several temperature setters the best-ranked wins (canonical first)', () => {
    expect(
      resolveCommandEquivalence('set-temperature', ['cooling', 'temperature-control', 'turn-on']),
    ).toBe('temperature-control');
  });
});
