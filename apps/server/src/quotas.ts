/**
 * Usage quotas (P4-4) — per-user / per-env creation limits
 *
 * Four quotas, all env-configurable (config.ts):
 *
 * | quota name             | env var                            | default | enforced on |
 * |------------------------|------------------------------------|---------|-------------|
 * | environments_per_user  | QUOTA_MAX_ENVS_PER_USER            | 20      | POST /api/environments (both empty-world and import paths) |
 * | devices_per_env        | QUOTA_MAX_DEVICES_PER_ENV          | 200     | POST …/devices + …/devices:instantiate |
 * | agents_per_env         | QUOTA_MAX_AGENTS_PER_ENV           | 50      | POST …/agents |
 * | running_sims_per_user  | QUOTA_MAX_RUNNING_SIMS_PER_USER    | 3       | POST /api/simulations (authenticated callers only) |
 * | sandboxes_per_user_per_env | QUOTA_MAX_SANDBOXES_PER_USER_PER_ENV | 3 | POST /api/environments/:id/sandboxes (P-C) |
 *
 * Over-quota creates fail 429 `{ error: { code: 'QUOTA_EXCEEDED', quota,
 * limit, current, message } }` — `current` is the usage AT rejection time
 * (== limit when full). `GET /api/me/quotas` (routes/me.ts) reports
 * limit+used per quota for introspection.
 *
 * "Running" simulations are registry entries in state 'running' or 'paused'
 * (mirrors the workbench's LIVE_SIM_STATES); anonymous legacy creations
 * carry no creator and are not quota-checked (they belong to no one).
 * "Active" sandboxes are sandboxes rows in status 'active' (stopped forks
 * release their slot).
 */

import { ApiError } from './errors.js';

export interface QuotaConfig {
  maxEnvsPerUser: number;
  maxDevicesPerEnv: number;
  maxAgentsPerEnv: number;
  /** T-055: zones per environment (install-zones proposals + owner creates). */
  maxZonesPerEnv: number;
  maxRunningSimsPerUser: number;
  /** P-C: active sandboxes one user may hold in one environment. */
  maxSandboxesPerUserPerEnv: number;
}

/** Quota names as they appear in the QUOTA_EXCEEDED error body. */
export type QuotaName =
  | 'environments_per_user'
  | 'devices_per_env'
  | 'agents_per_env'
  | 'zones_per_env'
  | 'running_sims_per_user'
  | 'sandboxes_per_user_per_env';

/**
 * Throw the standard 429 when `current` usage has reached `limit`. The
 * optional `hint` (S3, Task 2) appends HOW to free a slot / raise the limit —
 * a bare "3/3 in use" forces the caller to read docs to self-correct.
 */
export function assertQuota(
  quota: QuotaName,
  limit: number,
  current: number,
  hint?: string,
): void {
  if (current < limit) return;
  throw new ApiError(
    429,
    'QUOTA_EXCEEDED',
    `Quota "${quota}" exhausted: ${current}/${limit} in use` +
      (hint !== undefined ? ` — ${hint}` : ''),
    undefined,
    { quota, limit, current },
  );
}
