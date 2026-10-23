/**
 * A2 zone scoping helpers: all-selected → omit zoneIds; partial → the
 * remaining selected ids; toggle semantics of the exclusion set.
 */

import { describe, expect, it, vi } from 'vitest';

import * as api from '../api/client';
import { resolveScopedZoneIds, toggleZoneExclusion } from '../lib/zoneScope';
import { useAppStore } from '../store/useAppStore';
import { makeSnapshot } from './fixtures';

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return {
    ...mod,
    createSimulationForEnvironment: vi.fn(async () => ({ id: 'sim-1' })),
    getSnapshot: vi.fn(async () => makeSnapshot()),
  };
});

const createMock = vi.mocked(api.createSimulationForEnvironment);

const ALL = ['z-1', 'z-2', 'z-3'];

describe('resolveScopedZoneIds', () => {
  it('returns undefined when nothing is excluded (全选 = 不传 zoneIds)', () => {
    expect(resolveScopedZoneIds(ALL, new Set())).toBeUndefined();
  });

  it('returns the remaining selected ids when some zones are excluded', () => {
    expect(resolveScopedZoneIds(ALL, new Set(['z-2']))).toEqual(['z-1', 'z-3']);
    expect(resolveScopedZoneIds(ALL, new Set(['z-1', 'z-3']))).toEqual(['z-2']);
  });

  it('returns an empty array when everything is excluded (UI blocks the run)', () => {
    expect(resolveScopedZoneIds(ALL, new Set(ALL))).toEqual([]);
  });

  it('ignores exclusion ids that are not part of the world', () => {
    expect(resolveScopedZoneIds(ALL, new Set(['z-999']))).toEqual(['z-1', 'z-2', 'z-3']);
  });
});

describe('toggleZoneExclusion', () => {
  it('adds then removes without mutating the input set', () => {
    const start = new Set<string>();
    const excluded = toggleZoneExclusion(start, 'z-1');
    expect(excluded.has('z-1')).toBe(true);
    expect(start.has('z-1')).toBe(false);
    const restored = toggleZoneExclusion(excluded, 'z-1');
    expect(restored.has('z-1')).toBe(false);
  });
});

describe('startSimulationForEnvironment zoneIds pass-through', () => {
  it('forwards zoneIds as the third argument (body top level), undefined when unscoped', async () => {
    createMock.mockClear();
    await useAppStore.getState().startSimulationForEnvironment('env-1', 'auto', ['z-1', 'z-3']);
    expect(createMock).toHaveBeenCalledWith('env-1', { llmClient: 'auto' }, ['z-1', 'z-3']);

    createMock.mockClear();
    await useAppStore.getState().startSimulationForEnvironment('env-1', 'auto', undefined);
    expect(createMock).toHaveBeenCalledWith('env-1', { llmClient: 'auto' }, undefined);
  });
});
