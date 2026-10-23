/**
 * T-028/EA-F06: the EpisodesPanel trajectory cache is FIFO-capped — it used
 * to be an unbounded module-level Map holding full LLM transcripts
 * (system+user prompt, rawResponse) for the page lifetime across ALL
 * simulations, unlike every other long-lived buffer in the app
 * (EVENT_LOG_CAP / TRIGGER_HINT_CAP / REPLAY_BUFFER_CAP / TIMESERIES_CAP).
 *
 * The eviction contract: after TRAJECTORY_CACHE_CAP distinct entries, the
 * OLDEST entry is dropped (Map insertion order), so re-opening the first
 * expander re-fetches instead of resurrecting an unbounded cache.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import { loadTrajectory } from '../components/EpisodesPanel';
import * as api from '../api/client';

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return { ...mod, getTrajectory: vi.fn(async () => []) };
});

const getTrajectory = vi.mocked(api.getTrajectory);

afterEach(() => {
  vi.clearAllMocks();
});

describe('trajectory cache FIFO cap (T-028/EA-F06)', () => {
  it('evicts the oldest entry once the cap is exceeded', async () => {
    getTrajectory.mockClear();

    // Prime exactly cap + 5 distinct keys.
    for (let i = 0; i < 45; i += 1) {
      void loadTrajectory('sim-1', `event-${i}`, 'agent-a');
    }
    // Let the insertion promises settle.
    await Promise.resolve();
    expect(getTrajectory.mock.calls.length).toBe(45);

    // Re-request the OLDEST key: evicted → a fresh api call (not served
    // from the module-level cache).
    getTrajectory.mockClear();
    await loadTrajectory('sim-1', 'event-0', 'agent-a');
    expect(getTrajectory).toHaveBeenCalledTimes(1);

    // A RECENT key is still cached: no new api call.
    getTrajectory.mockClear();
    await loadTrajectory('sim-1', 'event-44', 'agent-a');
    expect(getTrajectory).not.toHaveBeenCalled();
  });
});
