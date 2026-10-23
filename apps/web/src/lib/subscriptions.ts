/**
 * Subscription helpers (W5) — the pure state transitions behind the
 * marketplace 星标 and the world slice's `myServiceSubscriptions` list.
 * The store action calls the API and then applies these reducers, so the
 * toggle semantics stay unit-testable without a component.
 */

/** Append a subscription (idempotent — an existing entry is kept once). */
export function addSubscription(ids: readonly string[], serviceId: string): string[] {
  return ids.includes(serviceId) ? [...ids] : [...ids, serviceId];
}

/** Drop a subscription (idempotent — removing nothing changes nothing). */
export function removeSubscription(ids: readonly string[], serviceId: string): string[] {
  return ids.includes(serviceId) ? ids.filter(id => id !== serviceId) : [...ids];
}

/** Apply the post-API state: subscribed → present, unsubscribed → absent. */
export function applySubscriptionState(
  ids: readonly string[],
  serviceId: string,
  subscribed: boolean,
): string[] {
  return subscribed ? addSubscription(ids, serviceId) : removeSubscription(ids, serviceId);
}
