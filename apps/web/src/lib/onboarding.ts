/**
 * W1b onboarding checklist — derive the 新手引导 step states from the
 * workbench overview (GET /api/me/overview), kept pure so the completion
 * rules are unit-testable without rendering.
 *
 * Completion rules (R2-FEAT-07 — the pre-fix rules auto-completed all three
 * steps the moment a template was imported, so the checklist vanished exactly
 * when the newbie needed steps ②③):
 * - ① 创建环境 — the caller participates in at least one environment;
 * - ② 装蓝图   — the caller has at least one BLUEPRINT-INSTALLED object
 *   (`myBlueprintInstalls`, the Fix-38 `installed_from` lineage). Scenario/
 *   template imports credit their devices/agents to the importer too, so the
 *   old "myDevices>0" rule completed ② the instant starter-home landed.
 *   Fallback for pre-R2-FEAT-07 servers (field absent everywhere): any env
 *   has devices/agents created by the caller (the old rule);
 * - ③ 启动仿真 — the caller has EVER created a simulation
 *   (totals/per-env `simulationCount`, which counts stopped runs too). The
 *   R73 auto-started world session no longer counts: it runs without any
 *   user action, so crediting it hid step ③ forever (the old R6-D-F02
 *   branch). Fallback for pre-simulationCount servers: a live sim the caller
 *   created (`myRunningSimulations`), then any live sim at all.
 */

import type { MeOverview } from '../api/types';

export type OnboardingStepId = 'createEnvironment' | 'installBlueprint' | 'runSimulation';

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
}

export interface OnboardingState {
  steps: OnboardingStep[];
  /** All three steps done — the checklist shows its celebration, then hides. */
  allDone: boolean;
  /** First env the caller participates in — deep-link target for steps ②③. */
  firstEnvId: string | null;
}

export function deriveOnboarding(overview: MeOverview): OnboardingState {
  const hasEnvironment = overview.environments.length > 0;
  // R2-FEAT-07: ② counts blueprint installs only. A server that predates the
  // field omits it on EVERY env — detect that and fall back to the old
  // ownership approximation rather than stranding those users on ② forever.
  const blueprintFieldPresent = overview.environments.some(
    env => env.myBlueprintInstalls !== undefined,
  );
  const hasBlueprintInstall = blueprintFieldPresent
    ? overview.environments.some(env => (env.myBlueprintInstalls ?? 0) > 0)
    : overview.environments.some(env => env.myDevices > 0 || env.myAgents > 0);
  const hasEverSimulated =
    (overview.totals.simulationCount ?? 0) > 0 ||
    overview.environments.some(env => (env.simulationCount ?? 0) > 0);
  // Fallback for pre-simulationCount servers: a live sim proves creation too
  // (prefer the caller's own — env-wide live sims may be someone else's).
  const hasLiveSimulation =
    (overview.totals.myRunningSimulations ?? overview.totals.runningSimulations) > 0 ||
    overview.environments.some(env => (env.myRunningSimulations ?? env.runningSimulations) > 0);
  const hasSimulation = hasEverSimulated || hasLiveSimulation;
  const steps: OnboardingStep[] = [
    { id: 'createEnvironment', done: hasEnvironment },
    { id: 'installBlueprint', done: hasBlueprintInstall },
    { id: 'runSimulation', done: hasSimulation },
  ];
  return {
    steps,
    allDone: steps.every(step => step.done),
    firstEnvId: overview.environments[0]?.id ?? null,
  };
}
