/**
 * Shared test render helper: mounts a component under the same providers the
 * app uses — a fresh QueryClient (TanStack Query owns server state now) plus
 * a MemoryRouter. Every test gets an isolated cache, so queries never leak
 * between cases. Retries are disabled so failing requests settle immediately
 * instead of slowing the suite.
 *
 * Usage:
 *   renderWithProviders(<MyPage />, { initialEntries: ['/environments'] });
 */

import type { ReactElement, ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor, type RenderOptions } from '@testing-library/react';
import { expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { createQueryClient } from '../lib/queryClient';
import { useAppStore } from '../store/useAppStore';

export function createTestQueryClient() {
  const client = createQueryClient();
  client.setDefaultOptions({
    queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
  });
  return client;
}

export interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  initialEntries?: string[];
  /** Pass to share a cache across multiple renders in one test. */
  queryClient?: ReturnType<typeof createTestQueryClient>;
}

export function renderWithProviders(
  ui: ReactElement,
  { initialEntries = ['/'], queryClient = createTestQueryClient(), ...options }: RenderWithProvidersOptions = {},
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  return { queryClient, ...render(ui, { wrapper: Wrapper, ...options }) };
}

/**
 * UX-W1: answer the global (store-driven) ConfirmDialog in tests — waits for
 * a pending request, then resolves it. Returns the request's body so tests
 * can assert what the user was asked.
 */
export async function answerConfirm(confirmed: boolean): Promise<string> {
  await waitFor(() => {
    expect(useAppStore.getState().confirmRequest).not.toBeNull();
  });
  const body = useAppStore.getState().confirmRequest?.body ?? '';
  act(() => {
    useAppStore.getState().resolveConfirm(confirmed);
  });
  return body;
}
