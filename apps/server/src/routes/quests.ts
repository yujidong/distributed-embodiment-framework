/**
 * Quest-state route (R6-D-M1, gamification-design.md §2) — split out of
 * routes/environments.ts for the arch-guard file-size ceiling (R21-W1
 * service-layer pattern).
 *
 * - `GET /api/environments/:id/quest-state` — the L1-L6 quest backbone
 *   (安家 → 武装 → 有人值守 → 世界活了 → 第一份合约 → 组合应用), derived by
 *   the pure `deriveQuests` (../quests.ts — no I/O there) from facts gathered
 *   with the SAME store queries the digest / eval-report use. Read model
 *   only; same read gate as the digest (public envs anonymous-readable).
 */

import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { ApiError } from '../errors.js';
import { getEnvironmentOrThrow, requireReadAccess } from '../env-access.js';
import { deriveQuests, type QuestFacts } from '../quests.js';
import { readTrajectoryDirRecordsCounted } from '../trajectory-store.js';
import { worldSessionSimIdOf } from '../sandbox-service.js';
import { terminatedAgreementOutcome, type AgreementStore } from '../db/agreement-store.js';
import {
  parseJsonArray,
  parseMapData,
  type EnvironmentStore,
} from '../db/environment-store.js';
import type { FlowStore } from '../db/flow-store.js';

export interface QuestRoutesContext {
  envStore: EnvironmentStore;
  agreementStore: AgreementStore;
  flowStore: FlowStore;
  /** Fix-22 trajectory base dir; the world session logs under sim-<envId>-world-session. */
  trajectoryBaseDir?: string;
}

export function registerQuestRoutes(app: FastifyInstance, ctx: QuestRoutesContext): void {
  app.get('/api/environments/:id/quest-state', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as { id: string };
    const env = getEnvironmentOrThrow(ctx.envStore, id);
    const role = request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined;
    requireReadAccess(env, role);

    const envRow = ctx.envStore.getEnvironment(env.id);
    if (!envRow) throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${env.id}" not found`);
    const agents = ctx.envStore.agentsOf(env.id);
    const boundAgentIds = agents
      .filter(row => parseJsonArray(row.bound_device_ids_json).length > 0)
      .map(row => row.id);
    const agreements = ctx.agreementStore.agreementsOfEnv(env.id);
    const enabledFlows = ctx.flowStore.listByEnvironment(env.id, { enabledOnly: true });

    // L3: a cognitive decision recorded for a bound agent in the env's
    // authoritative world session (<trajectoryBaseDir>/sim-<envId>-world-session).
    // Rule-only runs record nothing — absence of the dir honestly reads 0.
    let cognitiveDecisions = 0;
    if (ctx.trajectoryBaseDir !== undefined && boundAgentIds.length > 0) {
      const sessionDir = join(ctx.trajectoryBaseDir, worldSessionSimIdOf(env.id));
      for (const agentId of boundAgentIds) {
        const counted = await readTrajectoryDirRecordsCounted(sessionDir, { agentId, cap: 1 });
        if (counted.totalCount > 0) {
          cognitiveDecisions = counted.totalCount;
          break;
        }
      }
    }

    const facts: QuestFacts = {
      zones: parseMapData(envRow).zones.length,
      devices: ctx.envStore.devicesOf(env.id).length,
      boundAgents: boundAgentIds.length,
      cognitiveDecisions,
      // L4 (eval-report handshakes.succeeded 口径的 store 投影): an agreement
      // that ever reached active — AC agreements are born active on handshake
      // success, explicit ones stamp activated_at on activation.
      handshakesSucceeded: agreements.filter(row => row.activated_at !== null).length,
      // L5: terminatedAgreementOutcome 唯一口径 (same as digest
      // completedCollaborations — metered usage outcome wins).
      completedAgreements: agreements
        .filter(row => row.status === 'terminated')
        .filter(row =>
          terminatedAgreementOutcome(row, ctx.agreementStore.usageOf(row.id).at(-1)?.outcome) === 'completed',
        )
        .length,
      enabledFlows: enabledFlows.length,
      // L6a: an enabled flow with ≥1 successful run.
      successfulFlowRuns: enabledFlows.reduce(
        (total, flow) =>
          total + ctx.flowStore.listRuns(flow.id).filter(run => run.status === 'success').length,
        0,
      ),
      // L6b: metered service consumption (usage_records).
      usageRecords: ctx.agreementStore.usageOfEnv(env.id).length,
    };
    return deriveQuests(facts);
  });
}
