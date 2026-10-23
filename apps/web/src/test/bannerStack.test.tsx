/**
 * UX-W1 BannerStack：优先级排序（safety > governance > info，同级稳定）与
 * 「还有 N 条」折叠计数的守卫。纯函数（sortBannerItems/splitBannerItems）
 * 直测 + 渲染道（可见条数、折叠展开、可关的才有关闭钮）。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  BANNER_STACK_VISIBLE_COUNT,
  BannerStack,
  sortBannerItems,
  splitBannerItems,
  type BannerStackItem,
  type BannerTone,
} from '../components/BannerStack';
import i18n from '../i18n/config';

beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});
afterAll(() => {
  void i18n.changeLanguage('en-US');
});

afterEach(() => {
  cleanup();
});

function item(id: string, tone: BannerTone, onDismiss?: () => void): BannerStackItem {
  return { id, tone, content: <span>{id}</span>, onDismiss };
}

describe('sortBannerItems', () => {
  it('orders safety > governance > info regardless of input order', () => {
    const sorted = sortBannerItems([
      item('guide', 'info'),
      item('drift', 'governance'),
      item('estop', 'safety'),
      item('session', 'info'),
    ]);
    expect(sorted.map(entry => entry.id)).toEqual(['estop', 'drift', 'guide', 'session']);
  });

  it('is stable within the same tone', () => {
    const sorted = sortBannerItems([
      item('a', 'info'),
      item('b', 'info'),
      item('c', 'info'),
    ]);
    expect(sorted.map(entry => entry.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('splitBannerItems', () => {
  it('keeps everything visible at or below the threshold', () => {
    const { visible, collapsedCount } = splitBannerItems([1, 2]);
    expect(visible).toEqual([1, 2]);
    expect(collapsedCount).toBe(0);
  });

  it('collapses the overflow beyond the threshold', () => {
    const { visible, collapsedCount } = splitBannerItems([1, 2, 3, 4]);
    expect(visible).toEqual([1, 2]);
    expect(collapsedCount).toBe(2);
    expect(BANNER_STACK_VISIBLE_COUNT).toBe(2);
  });
});

describe('BannerStack render', () => {
  it('shows the first two by priority and collapses the rest behind 还有 N 条', () => {
    render(
      <BannerStack
        items={[item('guide', 'info'), item('drift', 'governance'), item('estop', 'safety')]}
      />,
    );
    // 折叠态：最高优先级的两条可见，第三条（info/guide）收进折叠。
    expect(screen.queryByText('estop')).not.toBeNull();
    expect(screen.queryByText('drift')).not.toBeNull();
    expect(screen.queryByText('guide')).toBeNull();
    const toggle = screen.getByRole('button', { name: /还有 1 条/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(screen.queryByText('guide')).not.toBeNull();
    expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true');

    // 再点收起回到折叠态。
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByText('guide')).toBeNull();
  });

  it('renders no collapse toggle when everything fits', () => {
    render(<BannerStack items={[item('drift', 'governance'), item('session', 'info')]} />);
    expect(screen.queryByRole('button', { name: /还有/ })).toBeNull();
  });

  it('renders the dismiss button only for dismissible items and fires onDismiss', () => {
    const onDismiss = vi.fn();
    render(
      <BannerStack items={[item('drift', 'governance', onDismiss), item('session', 'info')]} />,
    );
    const dismissButtons = screen.getAllByRole('button', { name: '关闭' });
    expect(dismissButtons).toHaveLength(1);
    fireEvent.click(dismissButtons[0]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for an empty stack', () => {
    const { container } = render(<BannerStack items={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
