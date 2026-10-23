/**
 * bootstrapAuth tests (R76-F1): the boot session restore (GET /auth/me)
 * retries transient failures — 429 rate limiting, 5xx, network drops — with
 * 1s/2s/4s backoff instead of swallowing them as "logged out" (which used to
 * strand the UI half-logged-in: the Agent wizard bound nothing and silently
 * disabled its buttons). Only a definitive 401 settles user=null at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../api/client';
import { ApiClientError } from '../api/client';
import type { PublicUser } from '../api/types';
import { useAppStore } from '../store/useAppStore';

vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, getMe: vi.fn() };
});

const USER: PublicUser = {
  id: 'user-a',
  email: 'a@example.com',
  displayName: '小A',
  createdAt: '2026-01-01T00:00:00Z',
};

describe('bootstrapAuth (R76-F1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState({ user: null, authChecked: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(api.getMe).mockReset();
  });

  it('settles logged out on a definitive 401 without retrying', async () => {
    vi.mocked(api.getMe).mockRejectedValue(new ApiClientError(401, 'UNAUTHORIZED', 'nope'));

    await useAppStore.getState().bootstrapAuth();

    expect(api.getMe).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().user).toBeNull();
    expect(useAppStore.getState().authChecked).toBe(true);
  });

  it('retries a 429 after 1s and keeps the session when /me recovers', async () => {
    vi.mocked(api.getMe)
      .mockRejectedValueOnce(new ApiClientError(429, 'RATE_LIMITED', 'slow down'))
      .mockResolvedValueOnce(USER);

    const boot = useAppStore.getState().bootstrapAuth();
    await vi.advanceTimersByTimeAsync(1000);
    await boot;

    expect(api.getMe).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().user?.id).toBe('user-a');
    expect(useAppStore.getState().authChecked).toBe(true);
  });

  it('retries a network drop (no status) the same way', async () => {
    vi.mocked(api.getMe)
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(USER);

    const boot = useAppStore.getState().bootstrapAuth();
    await vi.advanceTimersByTimeAsync(1000);
    await boot;

    expect(api.getMe).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().user?.id).toBe('user-a');
  });

  it('backs off 1s/2s/4s on a persistent 5xx, then settles logged out', async () => {
    vi.mocked(api.getMe).mockRejectedValue(new ApiClientError(503, 'HTTP_ERROR', 'HTTP 503'));

    const boot = useAppStore.getState().bootstrapAuth();
    await vi.advanceTimersByTimeAsync(0); // first attempt settles
    expect(api.getMe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.getMe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.getMe).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000);
    await boot;

    expect(api.getMe).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(useAppStore.getState().user).toBeNull();
    expect(useAppStore.getState().authChecked).toBe(true);
  });

  it('does not retry a definitive non-401 4xx', async () => {
    vi.mocked(api.getMe).mockRejectedValue(new ApiClientError(400, 'BAD_REQUEST', 'bad'));

    await useAppStore.getState().bootstrapAuth();

    expect(api.getMe).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().user).toBeNull();
  });

  it('R2-UX-23: a concurrent double boot issues ONE /auth/me (StrictMode in-flight guard)', async () => {
    let resolveMe: (user: PublicUser) => void = () => undefined;
    vi.mocked(api.getMe).mockImplementation(
      () =>
        new Promise<PublicUser>(resolve => {
          resolveMe = resolve;
        }),
    );

    const first = useAppStore.getState().bootstrapAuth();
    const second = useAppStore.getState().bootstrapAuth();

    // The second caller rides the in-flight promise — anonymous boots log
    // ONE expected 401, not two.
    expect(api.getMe).toHaveBeenCalledTimes(1);
    resolveMe(USER);
    await Promise.all([first, second]);
    expect(useAppStore.getState().user?.id).toBe('user-a');
    expect(useAppStore.getState().authChecked).toBe(true);

    // After settle the guard clears — an explicit re-check runs again.
    vi.mocked(api.getMe).mockResolvedValue(USER);
    await useAppStore.getState().bootstrapAuth();
    expect(api.getMe).toHaveBeenCalledTimes(2);
  });
});
