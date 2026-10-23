/**
 * UX-03 (home page): an unknown ?tab= value used to be silently ignored —
 * now the user gets a toast naming the value (and the param is consumed).
 * Known values (?tab=public) and a missing param stay quiet.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EnvironmentsHomePage } from '../pages/EnvironmentsHomePage';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import { renderWithProviders } from './testUtils';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  void i18n.changeLanguage('zh-CN');
  useAppStore.setState({ toasts: [] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/health')) {
        return jsonResponse({
          status: 'ok',
          version: 'test',
          uptimeSec: 1,
          worlds: { environments: 0, sims: { total: 0, running: 0 } },
          decision: { mode: 'llm', model: 'ac-decision-v5' },
          checks: { database: 'ok' },
        });
      }
      return jsonResponse({ environments: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('home ?tab= handling (UX-03)', () => {
  it('?tab=bogus toasts the unknown value (used to be silently ignored)', async () => {
    renderWithProviders(<EnvironmentsHomePage />, { initialEntries: ['/?tab=bogus'] });

    await screen.findByText('还没有你的环境');
    const toasts = useAppStore.getState().toasts;
    expect(toasts.some(toast => toast.text.includes('bogus'))).toBe(true);
  });

  it('?tab=public lands on the 公开 tab without a toast', async () => {
    renderWithProviders(<EnvironmentsHomePage />, { initialEntries: ['/?tab=public'] });

    await screen.findByText('暂无公开环境。');
    expect(useAppStore.getState().toasts).toHaveLength(0);
  });

  it('no ?tab= param stays quiet', async () => {
    renderWithProviders(<EnvironmentsHomePage />);

    await screen.findByText('还没有你的环境');
    expect(useAppStore.getState().toasts).toHaveLength(0);
  });
});
