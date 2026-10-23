import { describe, it, expect, beforeEach } from 'vitest';
import { InitiatorCoordinator } from '../InitiatorCoordinator.js';

describe('InitiatorCoordinator', () => {
  let nowMs: number;
  let coord: InitiatorCoordinator;

  beforeEach(() => {
    nowMs = 1_000_000;
    coord = new InitiatorCoordinator({
      cooldownMs: 60_000,
      now: () => nowMs,
    });
  });

  describe('tryClaim', () => {
    it('grants the first claim for an event', () => {
      expect(coord.tryClaim('evt-1', 'agent-a')).toBe(true);
    });

    it('rejects a different agent claiming the same event within cooldown', () => {
      expect(coord.tryClaim('evt-1', 'agent-a')).toBe(true);
      expect(coord.tryClaim('evt-1', 'agent-b')).toBe(false);
    });

    it('allows the same agent to re-claim its own event (idempotent)', () => {
      expect(coord.tryClaim('evt-1', 'agent-a')).toBe(true);
      expect(coord.tryClaim('evt-1', 'agent-a')).toBe(true);
    });

    it('transfers the claim after cooldown expires', () => {
      expect(coord.tryClaim('evt-1', 'agent-a')).toBe(true);
      nowMs += 60_001; // past cooldown
      expect(coord.tryClaim('evt-1', 'agent-b')).toBe(true);
    });

    it('keeps the claim within the cooldown window', () => {
      expect(coord.tryClaim('evt-1', 'agent-a')).toBe(true);
      nowMs += 59_999; // 1ms short
      expect(coord.tryClaim('evt-1', 'agent-b')).toBe(false);
    });

    it('treats empty eventId as always-claim (no dedup possible)', () => {
      expect(coord.tryClaim('', 'agent-a')).toBe(true);
      expect(coord.tryClaim('', 'agent-b')).toBe(true);
    });

    it('independent events do not block each other', () => {
      expect(coord.tryClaim('evt-1', 'agent-a')).toBe(true);
      expect(coord.tryClaim('evt-2', 'agent-b')).toBe(true);
      expect(coord.tryClaim('evt-3', 'agent-c')).toBe(true);
    });
  });

  describe('getPrimaryInitiator', () => {
    it('returns the claiming agent id', () => {
      coord.tryClaim('evt-1', 'agent-a');
      expect(coord.getPrimaryInitiator('evt-1')).toBe('agent-a');
    });

    it('returns undefined for unclaimed event', () => {
      expect(coord.getPrimaryInitiator('evt-missing')).toBeUndefined();
    });

    it('returns undefined after cooldown expires', () => {
      coord.tryClaim('evt-1', 'agent-a');
      nowMs += 60_001;
      expect(coord.getPrimaryInitiator('evt-1')).toBeUndefined();
    });
  });

  describe('release', () => {
    it('clears the claim when released by the owner', () => {
      coord.tryClaim('evt-1', 'agent-a');
      coord.release('evt-1', 'agent-a');
      expect(coord.getPrimaryInitiator('evt-1')).toBeUndefined();
      // A different agent can now claim
      expect(coord.tryClaim('evt-1', 'agent-b')).toBe(true);
    });

    it('does nothing when released by a non-owner', () => {
      coord.tryClaim('evt-1', 'agent-a');
      coord.release('evt-1', 'agent-b');
      expect(coord.getPrimaryInitiator('evt-1')).toBe('agent-a');
    });
  });

  describe('gc', () => {
    it('drops expired claims', () => {
      coord.tryClaim('evt-1', 'agent-a');
      coord.tryClaim('evt-2', 'agent-b');
      nowMs += 60_001;
      coord.gc();
      expect(coord.size()).toBe(0);
    });

    it('keeps live claims', () => {
      coord.tryClaim('evt-1', 'agent-a');
      nowMs += 30_000;
      coord.gc();
      expect(coord.size()).toBe(1);
    });
  });

  describe('concurrency race (within cooldown)', () => {
    it('only one of N near-simultaneous agents wins', () => {
      const results = ['a1', 'a2', 'a3', 'a4', 'a5'].map(id =>
        coord.tryClaim('evt-race', `agent-${id}`),
      );
      const winners = results.filter(r => r === true).length;
      expect(winners).toBe(1);
      expect(coord.getPrimaryInitiator('evt-race')).toMatch(/^agent-/);
    });
  });
});
