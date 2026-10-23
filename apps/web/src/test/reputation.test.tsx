/**
 * Reputation display tests (P4-1).
 *
 * Covers the pure derivation (lib/reputation.ts — tiers, labels, tooltips,
 * per-capability extraction from services) and the rendering of the
 * ReputationChip (green/amber/gray + use count).
 */

import { beforeAll, describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import i18n from '../i18n/config';
import { ReputationChip } from '../components/ReputationChip';
import {
  REPUTATION_MIN_USES,
  formatReputationPercent,
  perCapabilityReputation,
  reputationChipLabel,
  reputationTier,
  reputationTitle,
  summaryView,
} from '../lib/reputation';
import type { WorldService } from '../api/types';

// reputationChipLabel / reputationTitle read the active i18next bundle; pin
// to en-US so assertions are exact strings.
beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

function makeService(
  id: string,
  semanticType: string,
  providerId: string,
  reputation: { score: number; attempts: number; successes: number },
): WorldService {
  return {
    id,
    envId: 'env-1',
    name: `服务${id}`,
    semanticType,
    description: '',
    interface: {},
    origin: 'derived',
    sourceDeviceId: 'd1',
    visibility: 'public',
    unbacked: false,
    consumable: true,
    provider: { id: providerId, name: providerId, owner: { id: 'u1', displayName: '小B' } },
    reputation,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('reputation derivation (P4-1)', () => {
  it('tier: insufficient below the use threshold, regardless of score', () => {
    expect(reputationTier({ score: 1, attempts: 0 })).toBe('insufficient');
    expect(reputationTier({ score: 1, attempts: REPUTATION_MIN_USES - 1 })).toBe('insufficient');
    expect(reputationTier({ score: 0.2, attempts: 1 })).toBe('insufficient');
  });

  it('tier: good at/above the prior (0.7), warn below it', () => {
    expect(reputationTier({ score: 0.9, attempts: 10 })).toBe('good');
    expect(reputationTier({ score: 0.7, attempts: 10 })).toBe('good');
    expect(reputationTier({ score: 0.55, attempts: 10 })).toBe('warn');
    expect(reputationTier({ score: 0.3, attempts: 10 })).toBe('warn');
  });

  it('labels: percentage for judged records, Insufficient data otherwise', () => {
    expect(reputationChipLabel({ score: 0.823, attempts: 12 })).toBe('82%');
    expect(reputationChipLabel({ score: 0.7, attempts: 0 })).toBe('Insufficient data');
    expect(formatReputationPercent(0.55)).toBe('55%');
  });

  it('title carries the full track record and the insufficient-data hint', () => {
    expect(reputationTitle({ score: 0.75, attempts: 8, successes: 6 }))
      .toBe('Reputation 75% · 8 uses (6 successes)');
    expect(reputationTitle({ score: 0.7, attempts: 1, successes: 1 }))
      .toContain('Insufficient data');
  });

  it('perCapabilityReputation dedupes by semantic type and sorts by attempts', () => {
    const services = [
      makeService('s1', 'cooling', 'a1', { score: 0.9, attempts: 10, successes: 9 }),
      // same capability from a second device — same underlying record, dropped
      makeService('s2', 'cooling', 'a1', { score: 0.9, attempts: 10, successes: 9 }),
      makeService('s3', 'turn-on', 'a1', { score: 0.5, attempts: 4, successes: 1 }),
      makeService('s4', 'heating', 'a2', { score: 0.7, attempts: 99, successes: 99 }),
    ];
    const result = perCapabilityReputation(services, 'a1');
    expect(result.map(r => r.capability)).toEqual(['cooling', 'turn-on']);
    expect(result[0]).toMatchObject({ score: 0.9, attempts: 10 });
  });

  it('summaryView maps the snapshot summary to the chip view', () => {
    expect(summaryView({ overallScore: 0.8, totalAttempts: 5, topCapabilities: [] }))
      .toEqual({ score: 0.8, attempts: 5 });
  });
});

describe('ReputationChip rendering', () => {
  it('renders green (badge--ok) with score and uses for a reliable record', () => {
    const { container } = render(
      <ReputationChip reputation={{ score: 0.9, attempts: 10, successes: 9 }} />,
    );
    const chip = container.querySelector('.reputation-chip')!;
    expect(chip.className).toContain('badge--ok');
    expect(chip.textContent).toContain('90%');
    expect(chip.textContent).toContain('10x');
  });

  it('renders amber (badge--warn) for a below-prior record', () => {
    const { container } = render(
      <ReputationChip reputation={{ score: 0.55, attempts: 10, successes: 4 }} />,
    );
    const chip = container.querySelector('.reputation-chip')!;
    expect(chip.className).toContain('badge--warn');
    expect(chip.textContent).toContain('55%');
  });

  it('renders gray (plain badge) Insufficient data when uses are below the threshold', () => {
    render(<ReputationChip reputation={{ score: 0.7, attempts: 0, successes: 0 }} />);
    const chip = screen.getByText('Insufficient data').closest('.reputation-chip')!;
    expect(chip.className).not.toContain('badge--ok');
    expect(chip.className).not.toContain('badge--warn');
  });
});
