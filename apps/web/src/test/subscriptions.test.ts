/**
 * Subscription star reducer tests (W5): the pure state transitions behind
 * the marketplace 星标 toggle and the world slice's subscription list.
 */

import { describe, expect, it } from 'vitest';

import {
  addSubscription,
  applySubscriptionState,
  removeSubscription,
} from '../lib/subscriptions';

describe('addSubscription', () => {
  it('appends a new id and is idempotent for an existing one', () => {
    expect(addSubscription([], 's1')).toEqual(['s1']);
    expect(addSubscription(['s1'], 's2')).toEqual(['s1', 's2']);
    expect(addSubscription(['s1', 's2'], 's1')).toEqual(['s1', 's2']);
  });
});

describe('removeSubscription', () => {
  it('drops an existing id and is idempotent for a missing one', () => {
    expect(removeSubscription(['s1', 's2'], 's1')).toEqual(['s2']);
    expect(removeSubscription(['s2'], 's1')).toEqual(['s2']);
  });
});

describe('applySubscriptionState (the star toggle)', () => {
  it('stars (subscribes) and unstars (unsubscribes)', () => {
    const starred = applySubscriptionState([], 's1', true);
    expect(starred).toEqual(['s1']);
    expect(applySubscriptionState(starred, 's1', false)).toEqual([]);
  });

  it('never mutates the input list', () => {
    const before = ['s1'];
    applySubscriptionState(before, 's2', true);
    applySubscriptionState(before, 's1', false);
    expect(before).toEqual(['s1']);
  });
});
