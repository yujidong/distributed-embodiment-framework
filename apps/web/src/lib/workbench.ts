/**
 * Workbench helpers (W5) — derive the 工作台 view model from the
 * GET /api/me/overview payload, so the page component stays thin and the
 * card/totals semantics are unit-testable.
 *
 * The page renders one card per environment the caller participates in,
 * a totals row across all of them, and two flat sections (我发布的服务 /
 * 我依赖的服务). `unsubscribeFromOverview` recomputes the overview after a
 * successful unsubscribe so the section and the counters never disagree.
 */

import type { MeOverview, MeOverviewEnv } from '../api/types';

/** One env card on the workbench (a MeOverviewEnv plus a sim-console hint). */
export interface WorkbenchCard extends MeOverviewEnv {
  /** First live sim id to attach to, when the 运行中仿真 count is clicked. */
  attachableSimulationId: string | null;
}

/** overview.environments → cards (input order preserved). */
export function workbenchCards(overview: MeOverview): WorkbenchCard[] {
  return overview.environments.map(env => ({
    ...env,
    attachableSimulationId: env.runningSimulationIds[0] ?? null,
  }));
}

/** True when the caller has nothing anywhere (drives the empty-state hint). */
export function isWorkbenchEmpty(overview: MeOverview): boolean {
  return (
    overview.totals.myAgents === 0 &&
    overview.totals.myDevices === 0 &&
    overview.totals.myServices === 0 &&
    overview.totals.mySubscriptions === 0
  );
}

/**
 * Recompute the overview after unsubscribing `serviceId`: the flat list
 * loses the entry and the owning env's counter (plus the totals) drops by
 * one. Server round-trips stay the ground truth — this is the optimistic
 * projection that keeps the page consistent between them.
 */
export function unsubscribeFromOverview(overview: MeOverview, serviceId: string): MeOverview {
  const removed = overview.mySubscriptions.find(service => service.id === serviceId);
  if (!removed) return overview;
  return {
    ...overview,
    environments: overview.environments.map(env =>
      env.id === removed.envId
        ? { ...env, mySubscriptions: Math.max(env.mySubscriptions - 1, 0) }
        : env,
    ),
    totals: {
      ...overview.totals,
      mySubscriptions: Math.max(overview.totals.mySubscriptions - 1, 0),
    },
    mySubscriptions: overview.mySubscriptions.filter(service => service.id !== serviceId),
  };
}
