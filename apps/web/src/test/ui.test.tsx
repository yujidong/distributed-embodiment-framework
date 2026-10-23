/**
 * ui primitive smoke tests (Batch 2): Icon (lucide wrapper with house
 * defaults), Button (variant/size → existing class conventions) and Badge
 * (variant → .badge modifiers). Rendering only — no interaction logic.
 */

import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Star } from 'lucide-react';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Icon } from '../components/ui/Icon';

afterEach(cleanup);

describe('Icon', () => {
  it('renders an aria-hidden svg by default (decorative)', () => {
    const { container } = render(<Icon icon={Star} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('exposes an accessible name when label is given', () => {
    render(<Icon icon={Star} label="已收藏" />);
    expect(screen.getByRole('img', { name: '已收藏' })).toBeTruthy();
  });

  it('applies the house defaults (size 16, strokeWidth 1.8)', () => {
    const { container } = render(<Icon icon={Star} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('16');
    expect(svg?.getAttribute('stroke-width')).toBe('1.8');
  });
});

describe('Button', () => {
  it('maps variants onto the existing class conventions', () => {
    render(
      <>
        <Button variant="primary">主按钮</Button>
        <Button variant="danger">危险</Button>
        <Button variant="ghost">幽灵</Button>
        <Button variant="link">链接</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: '主按钮' }).className).toContain('primary-button');
    expect(screen.getByRole('button', { name: '危险' }).className).toContain('danger-button');
    expect(screen.getByRole('button', { name: '幽灵' }).className).toContain('ghost-button');
    expect(screen.getByRole('button', { name: '链接' }).className).toContain('link-button');
  });

  it('adds the sm class for size="sm" and keeps extra className', () => {
    render(
      <Button variant="ghost" size="sm" className="replay-bar__ctl">
        小按钮
      </Button>,
    );
    const button = screen.getByRole('button', { name: '小按钮' });
    expect(button.className).toContain('ghost-button');
    expect(button.className).toContain('button--sm');
    expect(button.className).toContain('replay-bar__ctl');
  });

  it('renders a plain button without variant and forwards the ref', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>默认</Button>);
    expect(ref.current).not.toBeNull();
    expect(ref.current?.className).toBe('');
  });
});

describe('Badge', () => {
  it('defaults to the neutral .badge look', () => {
    render(<Badge>普通</Badge>);
    expect(screen.getByText('普通').className).toBe('badge');
  });

  it('maps variants onto the semantic modifiers', () => {
    render(
      <>
        <Badge variant="ok">正常</Badge>
        <Badge variant="warn">告警</Badge>
        <Badge variant="danger">危险</Badge>
        <Badge variant="readonly">只读</Badge>
      </>,
    );
    expect(screen.getByText('正常').className).toBe('badge badge--ok');
    expect(screen.getByText('告警').className).toBe('badge badge--warn');
    expect(screen.getByText('危险').className).toBe('badge badge--danger');
    expect(screen.getByText('只读').className).toBe('badge badge--readonly');
  });
});
