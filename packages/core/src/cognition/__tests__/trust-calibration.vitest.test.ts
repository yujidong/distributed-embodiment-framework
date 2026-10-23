/**
 * L5 Meta-cognition — Trust Calibration tests (§7.3).
 *
 * Pins: platform-only trust with no interactions, private experience taking
 * over as interactions accumulate (shrinkage), Laplace smoothing after a
 * first failure, the shouldCollaborate threshold, checkpoint round-trip,
 * partner-list bound.
 */

import { describe, expect, it } from 'vitest';
import { TrustCalibrationStore } from '../trust-calibration.js';

describe('TrustCalibrationStore', () => {
  it('unknown partner is neutral: reputation 0.5, no interactions, shouldCollaborate at neutral', () => {
    const store = new TrustCalibrationStore();
    const trust = store.getTrust('stranger-1');
    expect(trust).toEqual({
      partnerId: 'stranger-1',
      platformReputation: 0.5,
      experienceScore: 0.5,
      interactionCount: 0,
      successfulCollaborations: 0,
      failedCollaborations: 0,
      trustScore: 0.5,
      shouldCollaborate: true,
    });
  });

  it('with zero interactions the platform reputation stands alone', () => {
    const store = new TrustCalibrationStore();
    store.setPlatformReputation('energy-optimizer', 0.82);
    const trust = store.getTrust('energy-optimizer');
    expect(trust.platformReputation).toBe(0.82);
    expect(trust.trustScore).toBe(0.82); // w = 1 → pure platform
    expect(trust.shouldCollaborate).toBe(true);
  });

  it('consistent private SUCCESS raises trust above a weak platform reputation', () => {
    const store = new TrustCalibrationStore();
    store.setPlatformReputation('partner-a', 0.2); // platform distrusts
    for (let i = 0; i < 10; i++) store.recordInteraction('partner-a', true);
    const trust = store.getTrust('partner-a');
    // w = 1/(1+10/5) = 1/3 → 0.333×0.2 + 0.667×(11/12) ≈ 0.678
    expect(trust.trustScore).toBeGreaterThan(0.65);
    expect(trust.trustScore).toBeLessThan(0.7);
    expect(trust.shouldCollaborate).toBe(true);
    expect(trust.experienceScore).toBeCloseTo(11 / 12, 3);
  });

  it('consistent private FAILURE sinks trust below a strong platform reputation', () => {
    const store = new TrustCalibrationStore();
    store.setPlatformReputation('flaky-partner', 0.9);
    for (let i = 0; i < 10; i++) store.recordInteraction('flaky-partner', false);
    const trust = store.getTrust('flaky-partner');
    // w = 1/3 → 0.333×0.9 + 0.667×(1/12) ≈ 0.361
    expect(trust.trustScore).toBeLessThan(0.4);
    expect(trust.shouldCollaborate).toBe(false);
    expect(trust.failedCollaborations).toBe(10);
  });

  it('Laplace smoothing: one failed first contact does not pin trust to 0', () => {
    const store = new TrustCalibrationStore();
    // No platform signal (neutral 0.5).
    store.recordInteraction('new-partner', false);
    const trust = store.getTrust('new-partner');
    // experience = (0+1)/(1+2) = 0.333; w = 1/(1+1/5) ≈ 0.833
    // trust ≈ 0.833×0.5 + 0.167×0.333 ≈ 0.472 — low, not zero.
    expect(trust.trustScore).toBeGreaterThan(0.4);
    expect(trust.trustScore).toBeLessThan(0.5);
  });

  it('half-weight point: at 5 interactions platform and experience weigh equally', () => {
    const store = new TrustCalibrationStore({ halfWeightInteractions: 5 });
    store.setPlatformReputation('p', 1);
    for (let i = 0; i < 5; i++) store.recordInteraction('p', false);
    // w = 1/2; experience = (0+1)/(5+2) ≈ 0.143 → trust = 0.5×1 + 0.5×0.143 ≈ 0.571
    expect(store.getTrust('p').trustScore).toBeCloseTo(0.5 + 0.5 * (1 / 7), 3);
  });

  it('custom threshold flips shouldCollaborate without changing the score', () => {
    const store = new TrustCalibrationStore({ threshold: 0.6 });
    store.setPlatformReputation('p', 0.55);
    const trust = store.getTrust('p');
    expect(trust.trustScore).toBe(0.55);
    expect(trust.shouldCollaborate).toBe(false);
  });

  it('checkpoint round-trips through JSON (hibernate/resume parity)', () => {
    const store = new TrustCalibrationStore();
    store.setPlatformReputation('p1', 0.7);
    store.recordInteraction('p1', true);
    store.recordInteraction('p1', false);
    const snapshot = JSON.parse(JSON.stringify(store.checkpoint()));

    const revived = new TrustCalibrationStore();
    revived.restore(snapshot);
    expect(revived.listPartners()).toEqual(store.listPartners());
    expect(revived.getTrust('p1')).toEqual(store.getTrust('p1'));
  });

  it('listPartners keeps deterministic insertion order and caps the partner set', () => {
    const store = new TrustCalibrationStore({ maxPartners: 3 });
    for (const id of ['a', 'b', 'c', 'd']) store.recordInteraction(id, true);
    const listed = store.listPartners().map(p => p.partnerId);
    // 'a' (oldest) dropped when 'd' arrived.
    expect(listed).toEqual(['b', 'c', 'd']);
  });

  it('rejects malformed partner ids and clamps reputation values', () => {
    const store = new TrustCalibrationStore();
    store.setPlatformReputation('', 0.9);
    store.recordInteraction('', true);
    expect(store.listPartners()).toEqual([]);
    store.setPlatformReputation('p', 7);
    expect(store.getTrust('p').platformReputation).toBe(1);
    store.setPlatformReputation('p', -3);
    expect(store.getTrust('p').platformReputation).toBe(0);
  });
});
