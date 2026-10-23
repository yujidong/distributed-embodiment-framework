/**
 * UX-W1 Toasts tests — icon-per-kind rendering, title + body structure, the
 * explicit close button (the toast body itself no longer dismisses), and the
 * optional action button (runs its callback and dismisses).
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { Toasts } from '../components/Toasts';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ toasts: [] });
});

function seedToasts() {
  useAppStore.setState({
    toasts: [
      { id: 1, text: 'plain info', kind: 'info' },
      { id: 2, text: 'saved', kind: 'success', title: 'Flow' },
      {
        id: 3,
        text: 'delete failed',
        kind: 'error',
        action: { label: 'Retry', onClick: vi.fn() },
      },
    ],
  });
}

describe('Toasts (UX-W1)', () => {
  it('renders kind modifier, title + body, and an explicit close button', () => {
    seedToasts();
    renderWithProviders(<Toasts />);
    expect(document.querySelector('.toast--success')).not.toBeNull();
    expect(screen.getByText('Flow').className).toContain('toast__title');
    // Every toast carries an accessible close button.
    expect(screen.getAllByRole('button', { name: 'Dismiss notification' })).toHaveLength(3);
  });

  it('the close button dismisses; clicking the body does NOT', () => {
    seedToasts();
    renderWithProviders(<Toasts />);
    screen.getByText('plain info').click();
    expect(useAppStore.getState().toasts).toHaveLength(3);
    screen.getAllByRole('button', { name: 'Dismiss notification' })[0].click();
    expect(useAppStore.getState().toasts.map(t => t.id)).toEqual([2, 3]);
  });

  it('the action button runs its callback and dismisses its toast', () => {
    seedToasts();
    renderWithProviders(<Toasts />);
    const action = useAppStore.getState().toasts[2].action;
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(action?.onClick).toHaveBeenCalledOnce();
    expect(useAppStore.getState().toasts.map(t => t.id)).toEqual([1, 2]);
  });

  it('pushToast stays backward compatible and accepts title/action options', () => {
    useAppStore.getState().pushToast('legacy call');
    useAppStore.getState().pushToast('with options', 'warn', {
      title: 'Heads up',
      action: { label: 'Open', onClick: () => {} },
    });
    const [legacy, rich] = useAppStore.getState().toasts;
    expect(legacy.kind).toBe('info');
    expect(legacy.title).toBeUndefined();
    expect(rich.kind).toBe('warn');
    expect(rich.title).toBe('Heads up');
    expect(rich.action?.label).toBe('Open');
  });
});
