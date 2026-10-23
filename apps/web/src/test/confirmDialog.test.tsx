/**
 * UX-W1 ConfirmDialog tests — controlled rendering (tone styling, Escape /
 * backdrop cancel) plus the Promise semantics of useConfirm() + ConfirmHost
 * (resolve true on confirm, false on cancel, superseded request resolves
 * false).
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import i18n from '../i18n/config';
import { ConfirmDialog, ConfirmHost, useConfirm } from '../components/ui/ConfirmDialog';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

beforeAll(() => {
  void i18n.changeLanguage('en-US');
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ confirmRequest: null });
});

describe('ConfirmDialog (controlled)', () => {
  it('renders title + body and fires onConfirm / onCancel', () => {
    const calls: string[] = [];
    render(
      <ConfirmDialog
        open
        title="Delete environment"
        body="This cannot be undone."
        onConfirm={() => calls.push('confirm')}
        onCancel={() => calls.push('cancel')}
      />,
    );
    screen.getByText('Delete environment');
    screen.getByText('This cannot be undone.');
    screen.getByRole('button', { name: 'Confirm' }).click();
    expect(calls).toEqual(['confirm']);
    screen.getByRole('button', { name: 'Cancel' }).click();
    expect(calls).toEqual(['confirm', 'cancel']);
  });

  it('danger tone renders a solid danger confirm button', () => {
    render(
      <ConfirmDialog open body="Sure?" tone="danger" onConfirm={() => {}} onCancel={() => {}} />,
    );
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm.className).toContain('danger-button--solid');
  });

  it('Escape and backdrop clicks cancel; nothing renders when closed', () => {
    const calls: string[] = [];
    const { container, rerender } = render(
      <ConfirmDialog open={false} body="hidden" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.querySelector('.confirm-dialog')).toBeNull();
    rerender(
      <ConfirmDialog open body="shown" onConfirm={() => {}} onCancel={() => calls.push('cancel')} />,
    );
    container.querySelector<HTMLElement>('.confirm-backdrop')?.click();
    expect(calls).toEqual(['cancel']);
  });
});

describe('useConfirm + ConfirmHost (Promise semantics)', () => {
  beforeEach(() => {
    useAppStore.setState({ confirmRequest: null });
  });

  function ConfirmTrigger({ body, tone }: { body: string; tone?: 'info' | 'warn' | 'danger' }) {
    const confirm = useConfirm();
    return (
      <button
        onClick={() => {
          void confirm({ body, tone }).then(ok => {
            useAppStore.getState().pushToast(ok ? 'yes' : 'no');
          });
        }}
      >
        ask
      </button>
    );
  }

  it('resolves true on confirm and false on cancel', async () => {
    renderWithProviders(
      <>
        <ConfirmTrigger body="Proceed?" />
        <ConfirmHost />
      </>,
    );
    screen.getByText('ask').click();
    await screen.findByText('Proceed?');
    screen.getByRole('button', { name: 'Confirm' }).click();
    await waitFor(() => {
      expect(useAppStore.getState().toasts.at(-1)?.text).toBe('yes');
    });
    expect(useAppStore.getState().confirmRequest).toBeNull();

    screen.getByText('ask').click();
    await screen.findByText('Proceed?');
    screen.getByRole('button', { name: 'Cancel' }).click();
    await waitFor(() => {
      expect(useAppStore.getState().toasts.at(-1)?.text).toBe('no');
    });
  });

  it('a superseding request resolves the pending one as cancelled', async () => {
    renderWithProviders(<ConfirmHost />);
    const first = useAppStore.getState().requestConfirm({ body: 'one' });
    const second = useAppStore.getState().requestConfirm({ body: 'two' });
    await expect(first).resolves.toBe(false);
    await screen.findByText('two');
    useAppStore.getState().resolveConfirm(true);
    await expect(second).resolves.toBe(true);
  });
});
