/**
 * UX-W3 ImportDraftReview (components/ImportDraftReview.tsx): the shared
 * review step of the three import lanes — zone table with rename/remove,
 * warnings area, summary counts, and confirm handing back the EDITED draft.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ImportDraftReview } from '../components/ImportDraftReview';
import i18n from '../i18n/config';
import { renderWithProviders } from './testUtils';

// Assertions use the zh-CN bundle; pin it like the other page tests.
beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});
afterAll(() => {
  void i18n.changeLanguage('en-US');
});

afterEach(cleanup);

const DRAFT = {
  version: '1.0',
  meta: { id: 'demo', name: 'Demo Building' },
  zones: [
    { id: 'z1', name: 'Lobby', type: 'hall', bounds: { floor: 0 } },
    { id: 'z2', name: 'Room 201', type: 'room', bounds: { floor: 2 } },
  ],
  devices: [{ id: 'd1', zoneId: 'z1' }],
  agents: [],
};

function renderReview(overrides: Partial<Parameters<typeof ImportDraftReview>[0]> = {}) {
  const onConfirm = vi.fn();
  const onBack = vi.fn();
  renderWithProviders(
    <ImportDraftReview
      draft={DRAFT}
      warnings={['3 spaces degenerated to estimated grids']}
      busy={false}
      onConfirm={onConfirm}
      onBack={onBack}
      {...overrides}
    />,
  );
  return { onConfirm, onBack };
}

describe('ImportDraftReview', () => {
  it('renders the summary counts, zone rows and warnings', () => {
    renderReview();
    screen.getByText(/草案「Demo Building」：2 区域 · 1 设备 · 0 Agent/);
    screen.getByDisplayValue('Lobby');
    screen.getByDisplayValue('Room 201');
    screen.getByText('导入告警（1）');
    screen.getByText('3 spaces degenerated to estimated grids');
  });

  it('rename edits ride the confirmed draft', () => {
    const { onConfirm } = renderReview();
    fireEvent.change(screen.getByDisplayValue('Lobby'), { target: { value: 'Main Lobby' } });
    screen.getByRole('button', { name: '确认创建' }).click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const edited = onConfirm.mock.calls[0]![0] as typeof DRAFT;
    expect(edited.zones[0]!.name).toBe('Main Lobby');
    // Untouched rows survive verbatim.
    expect(edited.zones[1]).toEqual(DRAFT.zones[1]);
  });

  it('removing a zone drops it (and its devices) from the confirmed draft', async () => {
    const { onConfirm } = renderReview();
    screen.getByRole('button', { name: '删除区域 z1' }).click();
    // The row disappears from the table immediately.
    await waitFor(() => expect(screen.queryByDisplayValue('Lobby')).toBeNull());
    screen.getByRole('button', { name: '确认创建' }).click();
    const edited = onConfirm.mock.calls[0]![0] as typeof DRAFT;
    expect(edited.zones.map(z => z.id)).toEqual(['z2']);
    expect(edited.devices).toEqual([]);
  });

  it('back hands control to the input step without confirming', () => {
    const { onConfirm, onBack } = renderReview();
    screen.getByRole('button', { name: '返回' }).click();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows the create-step error above the actions', () => {
    renderReview({ error: '创建失败：BAD_REQUEST: duplicate name' });
    screen.getByText('创建失败：BAD_REQUEST: duplicate name');
  });
});
