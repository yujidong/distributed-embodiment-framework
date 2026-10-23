/**
 * Icon — thin wrapper over lucide-react carrying the house defaults
 * (size 16, strokeWidth 1.8). Icons are decorative by default
 * (`aria-hidden`); pass `label` when the icon itself carries meaning
 * (standalone icon buttons, status glyphs) to expose an accessible name.
 */

import { forwardRef } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';

export interface IconProps extends Omit<LucideProps, 'ref'> {
  /** The lucide glyph to render, e.g. `import { Star } from 'lucide-react'`. */
  icon: LucideIcon;
  /** Accessible name. Omit for decorative icons next to text. */
  label?: string;
}

export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { icon: Glyph, size = 16, strokeWidth = 1.8, label, ...rest },
  ref,
) {
  return (
    <Glyph
      ref={ref}
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      {...rest}
    />
  );
});
