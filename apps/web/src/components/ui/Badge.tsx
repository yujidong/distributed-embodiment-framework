/**
 * Badge — pill label primitive over the existing .badge class conventions.
 * Variants map to the semantic modifiers already defined in styles.css
 * (.badge--ok / --warn / --danger / --readonly); 'neutral' is the base look.
 */

import { forwardRef, type HTMLAttributes } from 'react';

export type BadgeVariant = 'neutral' | 'ok' | 'warn' | 'danger' | 'readonly';

const VARIANT_CLASS: Record<Exclude<BadgeVariant, 'neutral'>, string> = {
  ok: 'badge--ok',
  warn: 'badge--warn',
  danger: 'badge--danger',
  readonly: 'badge--readonly',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { variant = 'neutral', className, ...rest },
  ref,
) {
  const classes = [
    'badge',
    variant === 'neutral' ? '' : VARIANT_CLASS[variant],
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return <span ref={ref} className={classes} {...rest} />;
});
