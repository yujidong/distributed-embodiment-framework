/**
 * ReputationChip — the P4-1 信誉 badge: score% + use count, colored
 * green (reliable) / amber (below prior) / gray (insufficient data).
 * Purely presentational; derivation lives in lib/reputation.ts.
 */

import { useTranslation } from 'react-i18next';

import {
  reputationChipLabel,
  reputationTier,
  reputationTitle,
  type ReputationView,
} from '../lib/reputation';

export function ReputationChip({ reputation }: { reputation: ReputationView }) {
  const { t } = useTranslation('reputationChip');
  const tier = reputationTier(reputation);
  const className =
    tier === 'good' ? 'badge badge--ok reputation-chip'
      : tier === 'warn' ? 'badge badge--warn reputation-chip'
        : 'badge reputation-chip';
  return (
    <span className={className} title={reputationTitle(reputation)}>
      {reputationChipLabel(reputation)}
      <span className="reputation-chip__uses">{reputation.attempts}{t('usesSuffix')}</span>
    </span>
  );
}
