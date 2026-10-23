import { describe, it, expect } from 'vitest';
import {
  selectBestPartner,
  computeBidScore,
  isQuorumReached,
  DEFAULT_COLLABORATION_MODE,
  type PartnerBid,
} from '../ContractNetProtocol.js';

describe('ContractNetProtocol', () => {
  describe('computeBidScore', () => {
    it('uses the 4-weight formula (cap 40% + workload 25% + reliability 20% + proximity 15%)', () => {
      const score = computeBidScore(1.0, 1.0, 1.0, 1.0);
      expect(score).toBe(1.0);
    });

    it('zero capabilities gives low score', () => {
      const score = computeBidScore(0, 1.0, 1.0, 1.0);
      expect(score).toBeCloseTo(0.6, 2); // 0*0.4 + 1*0.25 + 1*0.2 + 1*0.15
    });

    it('weighted average for mixed scores', () => {
      const score = computeBidScore(0.5, 0.75, 0.8, 0.5);
      // 0.5*0.4 + 0.75*0.25 + 0.8*0.2 + 0.5*0.15 = 0.2 + 0.1875 + 0.16 + 0.075 = 0.6225
      expect(score).toBeCloseTo(0.6225, 3);
    });
  });

  describe('selectBestPartner', () => {
    it('returns the highest-scored bid as winner', () => {
      const bids: PartnerBid[] = [
        { agentId: 'a', agentName: 'A', score: 0.5, capabilityScore: 0.5, workloadScore: 0.5, reliabilityScore: 0.5, proximityScore: 0.5, reasoning: '' },
        { agentId: 'b', agentName: 'B', score: 0.9, capabilityScore: 0.9, workloadScore: 0.9, reliabilityScore: 0.9, proximityScore: 0.9, reasoning: '' },
        { agentId: 'c', agentName: 'C', score: 0.7, capabilityScore: 0.7, workloadScore: 0.7, reliabilityScore: 0.7, proximityScore: 0.7, reasoning: '' },
      ];
      const { winner, ranking } = selectBestPartner(bids);
      expect(winner?.agentId).toBe('b');
      expect(ranking[0].agentId).toBe('b');
      expect(ranking[1].agentId).toBe('c');
      expect(ranking[2].agentId).toBe('a');
    });

    it('returns undefined winner for empty bids', () => {
      const { winner, ranking } = selectBestPartner([]);
      expect(winner).toBeUndefined();
      expect(ranking).toEqual([]);
    });

    it('handles single bid', () => {
      const bids: PartnerBid[] = [
        { agentId: 'solo', agentName: 'Solo', score: 0.3, capabilityScore: 0.3, workloadScore: 0.3, reliabilityScore: 0.3, proximityScore: 0.3, reasoning: '' },
      ];
      const { winner } = selectBestPartner(bids);
      expect(winner?.agentId).toBe('solo');
    });
  });

  describe('isQuorumReached', () => {
    it('true when accepted >= required', () => {
      expect(isQuorumReached(3, 3)).toBe(true);
      expect(isQuorumReached(4, 3)).toBe(true);
    });

    it('false when accepted < required', () => {
      expect(isQuorumReached(2, 3)).toBe(false);
      expect(isQuorumReached(0, 1)).toBe(false);
    });
  });

  describe('DEFAULT_COLLABORATION_MODE', () => {
    it('is first-accept for backward compatibility', () => {
      expect(DEFAULT_COLLABORATION_MODE).toBe('first-accept');
    });
  });
});
