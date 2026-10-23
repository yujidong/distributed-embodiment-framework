/**
 * EmptyState — the house empty-state primitive (icon slot + title + optional
 * description + optional CTA). Emits the existing .empty-state class family
 * (styles.css) so it drops into panels already styled for it; `compact`
 * shrinks the padding for small list/panel empties.
 */

import type { LucideIcon } from 'lucide-react';

import { Icon } from './Icon';

export interface EmptyStateProps {
  /** Decorative leading icon (aria-hidden); omit for text-only empties. */
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Optional call-to-action button. */
  action?: { label: string; onClick: () => void };
  /** Tighter padding for small list/panel empties. */
  compact?: boolean;
  className?: string;
}

export function EmptyState({ icon, title, description, action, compact, className }: EmptyStateProps) {
  const classes = [
    'empty-state',
    compact ? 'empty-state--compact' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes}>
      {icon !== undefined && <Icon icon={icon} size={compact ? 20 : 28} className="empty-state__icon" />}
      <p className="empty-state__title">{title}</p>
      {description !== undefined && <p className="empty-state__note">{description}</p>}
      {action !== undefined && (
        <div className="empty-state__actions">
          <button type="button" className="primary-button" onClick={action.onClick}>
            {action.label}
          </button>
        </div>
      )}
    </div>
  );
}
