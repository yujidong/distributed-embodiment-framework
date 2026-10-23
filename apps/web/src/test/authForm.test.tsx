/**
 * F6 (R71) regression pin: the register/login tab switch renders the extra
 * displayName field SYNCHRONOUSLY — clicking the tab and asserting on the
 * next line (getBy, not findBy) proves no delayed mount the automation (and
 * the human eye) once raced against.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthPage } from '../pages/AuthPage';
import i18n from '../i18n/config';
import { renderWithProviders } from './testUtils';

beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});
afterAll(() => {
  void i18n.changeLanguage('en-US');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The store's login/register would fire fetch — not needed for the tab test,
// but stub defensively so nothing leaks.
vi.mock('../store/useAppStore', () => ({
  useAppStore: vi.fn((selector: (s: unknown) => unknown) => selector({})),
}));

describe('AuthPage tab switch (F6)', () => {
  it('mounts the register field synchronously on tab click — no async race window', () => {
    renderWithProviders(<AuthPage />);

    // Login mode first: no displayName field.
    expect(screen.queryByLabelText('显示名称')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    // The synchronous assertions (getBy throws if absent on this tick) — the
    // displayName field and the submit label flip in the SAME render.
    expect(screen.getByLabelText('显示名称')).toBeTruthy();
    expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy();
  });
});
