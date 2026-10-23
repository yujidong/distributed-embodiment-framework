/**
 * Button — the house button primitive. Variants map onto the existing
 * class conventions (.primary-button / .secondary-button / .ghost-button /
 * .danger-button / .link-button) so visuals stay consistent; `size="sm"`
 * adds .button--sm. Callers may still pass extra className for
 * layout-specific tweaks.
 */

import { forwardRef, type ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'primary-button',
  secondary: 'secondary-button',
  ghost: 'ghost-button',
  danger: 'danger-button',
  link: 'link-button',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size = 'md', className, type = 'button', ...rest },
  ref,
) {
  const classes = [
    variant ? VARIANT_CLASS[variant] : '',
    size === 'sm' ? 'button--sm' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return <button ref={ref} type={type} className={classes || undefined} {...rest} />;
});
