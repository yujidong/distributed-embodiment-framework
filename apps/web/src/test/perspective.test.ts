/**
 * Perspective dimming tests (W5): the shared logic behind 全局视角 / 我的视角.
 *
 * Both map tiers (grid + geo) consume `focusOwnerIdOf` + `isDimmed`, so
 * these tests pin the semantics the canvases rely on: in 我的视角 only the
 * caller's own objects stay lit and interactive; the zone focus follows the
 * caller's managed zones; the choice persists per environment.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  focusOwnerIdOf,
  isDimmed,
  loadPerspective,
  myManagedZoneIds,
  savePerspective,
} from '../lib/perspective';

describe('focusOwnerIdOf', () => {
  it('is null in the global perspective, and in 我的视角 without a user', () => {
    expect(focusOwnerIdOf('global', 'u1')).toBeNull();
    expect(focusOwnerIdOf('me', null)).toBeNull();
  });

  it('is the caller id in 我的视角 when logged in', () => {
    expect(focusOwnerIdOf('me', 'u1')).toBe('u1');
  });
});

describe('isDimmed', () => {
  it('dims only objects owned by someone else', () => {
    expect(isDimmed('u1', 'u1')).toBe(false); // mine stays lit
    expect(isDimmed('u2', 'u1')).toBe(true); // theirs dims
  });

  it('dims nothing in the global render (focusOwnerId null)', () => {
    expect(isDimmed('u2', null)).toBe(false);
  });

  it('never dims ownerless objects (legacy scenario models)', () => {
    expect(isDimmed(null, 'u1')).toBe(false);
  });
});

describe('myManagedZoneIds', () => {
  const agents = [
    { ownerId: 'u1', managedZoneIds: ['zone-a', 'zone-b'] },
    { ownerId: 'u2', managedZoneIds: ['zone-b', 'zone-c'] },
    { ownerId: 'u1', managedZoneIds: ['zone-d'] },
  ];

  it('unions the managed zones of the caller’s agents only', () => {
    expect([...myManagedZoneIds(agents, 'u1')].sort()).toEqual(['zone-a', 'zone-b', 'zone-d']);
  });

  it('is empty in the global render', () => {
    expect(myManagedZoneIds(agents, null).size).toBe(0);
  });
});

describe('perspective persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to 全局视角 and round-trips a saved choice per env', () => {
    expect(loadPerspective('env-1')).toBe('global');
    savePerspective('env-1', 'me');
    expect(loadPerspective('env-1')).toBe('me');
    // … and is scoped per environment.
    expect(loadPerspective('env-2')).toBe('global');
    savePerspective('env-1', 'global');
    expect(loadPerspective('env-1')).toBe('global');
  });
});
