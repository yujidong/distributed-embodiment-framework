/**
 * activeSimulationsOf tests (R12-5c-B): the world view's 运行仿真 checks this
 * derivation before creating a new simulation — only created/running/paused
 * sims of THIS environment block the direct-start path.
 */

import { describe, expect, it } from 'vitest';

import type { SimulationListEntry } from '../api/types';
import { activeSimulationsOf } from '../lib/activeSimulations';

function sim(
  id: string,
  environmentId: string,
  state: SimulationListEntry['state'],
): SimulationListEntry {
  return { id, scenarioId: `sc-${id}`, environmentId, state, simTimeSec: 0, llm: 'rule-only' };
}

describe('activeSimulationsOf', () => {
  it('keeps created/running/paused sims of the given environment', () => {
    const sims = [
      sim('s-run', 'env-1', 'running'),
      sim('s-pause', 'env-1', 'paused'),
      sim('s-created', 'env-1', 'created'),
      sim('s-stopped', 'env-1', 'stopped'),
      sim('s-other', 'env-2', 'running'),
    ];
    expect(activeSimulationsOf(sims, 'env-1').map(s => s.id)).toEqual([
      's-run',
      's-pause',
      's-created',
    ]);
  });

  it('returns empty when the environment has no attachable simulation', () => {
    expect(activeSimulationsOf([sim('s-stopped', 'env-1', 'stopped')], 'env-1')).toEqual([]);
    expect(activeSimulationsOf([], 'env-1')).toEqual([]);
  });
});
