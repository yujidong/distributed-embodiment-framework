/**
 * Eval-run routes — 批量评估任务（Wave-3a）
 *
 * REST:
 * - `POST /api/environments/:id/eval-runs`  提交批量评估：body =
 *   `{ runs: [{label, llmClient?, llmModel?, llmPromptVariant?,
 *   agentOverrides?, speed?, steps?}], events: [...], promptVariants? }`
 *   （eval-run-service.ts 的 EvalRunSpec）。任何成员可用（实验工具；
 *   viewer 也可以——批量任务只创建隔离仿真，不改共享世界：Wave-3b 的
 *   agentOverrides 也只作用于该 run 的 scenario 副本）。创建落
 *   command_log 审计（kind 'eval-run'），随后进进程内串行队列异步执行。
 *   201 返回任务行。
 * - `GET /api/eval-runs/:id`                查状态与聚合结果：pending /
 *   running 时只有任务行；done 时带 result（per-run 指标 + 跨 run 对比
 *   表）；failed 时带 error。成员可读。
 * - `GET /api/environments/:id/eval-runs`   T-016：按环境列出历史批量任务
 *   （newest first，摘要行：id/status/created/arms/metrics 摘要）。完整
 *   result 仍走 by-id 端点。成员可读（与 by-id 同门）。
 */

import type { FastifyInstance } from 'fastify';

import type { EnvironmentStore } from '../db/environment-store.js';
import type { EvalRunRow, EvalRunStore } from '../db/eval-run-store.js';
import { getEnvironmentOrThrow, requireEnvRole } from '../env-access.js';
import { ApiError } from '../errors.js';
import { parseEvalRunSpec, type EvalRunService } from '../eval-run-service.js';

export interface EvalRunRoutesContext {
  envStore: EnvironmentStore;
  evalRunStore: EvalRunStore;
  evalRunService: EvalRunService;
}

interface IdParams {
  id: string;
}

export function registerEvalRunRoutes(app: FastifyInstance, ctx: EvalRunRoutesContext): void {
  app.post(
    '/api/environments/:id/eval-runs',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      getEnvironmentOrThrow(ctx.envStore, id);
      requireEnvRole(ctx.envStore, id, user, ['owner', 'builder', 'viewer']);
      const spec = parseEvalRunSpec(request.body);
      const row = ctx.evalRunService.submit(id, user.id, spec);
      return reply.code(201).send(serialize(row));
    },
  );

  app.get('/api/eval-runs/:id', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    const row = ctx.evalRunStore.get(id);
    if (!row) {
      throw new ApiError(404, 'EVAL_RUN_NOT_FOUND', `Eval run "${id}" not found`);
    }
    requireEnvRole(ctx.envStore, row.env_id, request.user!, ['owner', 'builder', 'viewer']);
    return serialize(row);
  });

  // T-016: environment-scoped list, newest first. Summary rows only — the
  // full per-run metrics and comparison table ride the by-id endpoint, so a
  // world with 50 historical batches does not ship 50 result documents on
  // every sidebar open.
  app.get(
    '/api/environments/:id/eval-runs',
    { preHandler: app.authenticate },
    async request => {
      const { id } = request.params as IdParams;
      getEnvironmentOrThrow(ctx.envStore, id);
      requireEnvRole(ctx.envStore, id, request.user!, ['owner', 'builder', 'viewer']);
      return { runs: ctx.evalRunStore.listForEnv(id).map(serializeSummary) };
    },
  );
}

/** Mean of a metric across the batch's metric-bearing arms (null when none). */
function meanOf(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => typeof v === 'number');
  if (present.length === 0) return null;
  return present.reduce((sum, v) => sum + v, 0) / present.length;
}

/**
 * T-016 summary row: id/status/timestamps, `arms` = spec.runs.length, and a
 * compact `metricsDigest` (the three headline rates averaged across arms that
 * produced metrics — same fields the by-id comparison table reports per arm).
 * `metricsDigest` values stay null for pending/running/failed batches and for
 * done batches whose arms produced no labeled data.
 */
function serializeSummary(row: EvalRunRow): Record<string, unknown> {
  const spec = JSON.parse(row.spec_json) as { runs?: unknown[] };
  let metricsDigest: Record<string, number | null> = {
    decisionAccuracy: null,
    handshakeSuccessRate: null,
    effectCheckPassRate: null,
  };
  if (row.result_json !== null) {
    const result = JSON.parse(row.result_json) as {
      runs?: Array<{
        metrics?: {
          decisions?: { accuracy?: number | null };
          handshakes?: { successRate?: number | null };
          effectChecks?: { passRate?: number | null };
        };
      }>;
    };
    metricsDigest = {
      decisionAccuracy: meanOf((result.runs ?? []).map(run => run.metrics?.decisions?.accuracy ?? null)),
      handshakeSuccessRate: meanOf((result.runs ?? []).map(run => run.metrics?.handshakes?.successRate ?? null)),
      effectCheckPassRate: meanOf((result.runs ?? []).map(run => run.metrics?.effectChecks?.passRate ?? null)),
    };
  }
  return {
    id: row.id,
    envId: row.env_id,
    createdBy: row.created_by,
    status: row.status,
    arms: Array.isArray(spec.runs) ? spec.runs.length : 0,
    metricsDigest,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function serialize(row: EvalRunRow): Record<string, unknown> {
  return {
    id: row.id,
    envId: row.env_id,
    createdBy: row.created_by,
    status: row.status,
    spec: JSON.parse(row.spec_json) as unknown,
    ...(row.result_json !== null ? { result: JSON.parse(row.result_json) as unknown } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
