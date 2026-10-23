/**
 * Presence reducer tests (P2e-2): snapshot replaces the roster, online
 * upserts by id, offline removes by id, plus wire parsing robustness.
 */

import { describe, expect, it } from 'vitest';

import type { PresenceMessage, PresenceUserRef } from '../api/types';
import { applyPresenceMessage, parsePresenceMessage } from '../lib/presence';

const userA: PresenceUserRef = { id: 'user-a', displayName: '小A' };
const userB: PresenceUserRef = { id: 'user-b', displayName: '小B' };
const userC: PresenceUserRef = { id: 'user-c', displayName: '小C' };

const online = (user: PresenceUserRef): PresenceMessage => ({
  kind: 'presence',
  action: 'online',
  user,
});
const offline = (user: PresenceUserRef): PresenceMessage => ({
  kind: 'presence',
  action: 'offline',
  user,
});
const snapshot = (users: PresenceUserRef[], anonymousCount = 0): PresenceMessage => ({
  kind: 'presence',
  action: 'snapshot',
  users,
  anonymousCount,
});

describe('parsePresenceMessage', () => {
  it('accepts well-formed snapshot/online/offline frames', () => {
    expect(parsePresenceMessage(snapshot([userA], 2))).toEqual(snapshot([userA], 2));
    expect(parsePresenceMessage(online(userA))).toEqual(online(userA));
    expect(parsePresenceMessage(offline(userA))).toEqual(offline(userA));
  });

  it('rejects non-presence and malformed frames', () => {
    expect(parsePresenceMessage(null)).toBeNull();
    expect(parsePresenceMessage('presence')).toBeNull();
    expect(parsePresenceMessage({ kind: 'world', action: 'created' })).toBeNull();
    expect(parsePresenceMessage({ kind: 'presence', action: 'typing' })).toBeNull();
    expect(parsePresenceMessage({ kind: 'presence', action: 'online' })).toBeNull();
    expect(
      parsePresenceMessage({ kind: 'presence', action: 'online', user: { id: 42 } }),
    ).toBeNull();
    expect(
      parsePresenceMessage({ kind: 'presence', action: 'snapshot', users: [{ id: 'x' }] }),
    ).toBeNull();
    expect(
      parsePresenceMessage({ kind: 'presence', action: 'snapshot', users: [] }),
    ).toBeNull(); // missing anonymousCount
  });
});

describe('applyPresenceMessage', () => {
  it('snapshot replaces the whole roster', () => {
    expect(applyPresenceMessage([userA, userB], snapshot([userC], 1))).toEqual([userC]);
    expect(applyPresenceMessage([userA], snapshot([]))).toEqual([]);
  });

  it('online appends a new user and dedupes an already-online one', () => {
    expect(applyPresenceMessage([userA], online(userB))).toEqual([userA, userB]);
    // Multi-tab: the user is already in the roster — no duplicate entry.
    expect(applyPresenceMessage([userA, userB], online(userB))).toEqual([userA, userB]);
    // Snapshot→online overlap (server excludes the newcomer, but an older
    // server may not): applying online after the snapshot is a no-op.
    expect(applyPresenceMessage([userA], online(userA))).toEqual([userA]);
  });

  it('offline removes the user and ignores unknown users', () => {
    expect(applyPresenceMessage([userA, userB], offline(userA))).toEqual([userB]);
    expect(applyPresenceMessage([userA], offline(userC))).toEqual([userA]);
    expect(applyPresenceMessage([], offline(userA))).toEqual([]);
  });
});
