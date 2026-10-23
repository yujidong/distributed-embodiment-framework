/**
 * ErrorBoundary tests: a crashing child is replaced by the friendly fallback
 * (刷新 / 回工作台 actions) instead of unmounting the tree; the error is
 * logged via console.error.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '../components/ErrorBoundary';
import i18n from '../i18n/config';

// ErrorBoundary reads the active i18next bundle via i18n.t; pin to zh-CN so
// the Chinese fallback-string assertions stay exact.
beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});
afterAll(() => {
  void i18n.changeLanguage('en-US');
});

function Bomb(): never {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>一切正常</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('一切正常')).toBeTruthy();
  });

  it('shows the fallback when a child throws, and logs the error', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <MemoryRouter>
        <ErrorBoundary title="测试面板出错了">
          <Bomb />
        </ErrorBoundary>
      </MemoryRouter>,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('测试面板出错了')).toBeTruthy();
    expect(screen.getByText(/boom/)).toBeTruthy();
    expect(screen.getByText('刷新页面')).toBeTruthy();
    expect(screen.getByText('回工作台')).toBeTruthy();
    expect(consoleError).toHaveBeenCalled();
  });

  it('回工作台 resets the boundary without unmounting the shell', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <MemoryRouter initialEntries={['/broken']}>
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>
      </MemoryRouter>,
    );

    // The reset re-renders the children; Bomb throws again, so the fallback
    // comes straight back — the shell itself never unmounts.
    fireEvent.click(screen.getByText('回工作台'));
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
