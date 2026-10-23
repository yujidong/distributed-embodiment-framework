/**
 * Replay routes — P-E 时间窗 → scenario JSON（multi-user-simulation-design.md §7, §10）
 *
 * - `POST /api/environments/:id/replays`  把指定 wall-clock 时间窗内的
 *     observations + command_log 记录转换为一份 scenario JSON v1.0（环境
 *     快照为底 + 回放事件序列）。权限跟随环境读语义（成员可读 observations，
 *     回放生成同样成员可用；public 环境任何人可用）。
 *     请求体：`{ from, to, mode?, name?, description? }`——from/to 为 ISO
 *     wall-time（from 含、to 不含；from >= to 报 400）；mode:
 *     - `download`（默认）：200 返回 `{ scenario, report }`，客户端可存为
 *       文件、走现有 scenario API 跑仿真或 fork 沙箱；
 *     - `save`：写入 scenario-store 用户源（data/scenarios），201 返回
 *       `{ scenarioId, report }`——用户源的写权限跟随现有 scenario API。
 *     report 带 eventCount / skipped / unchanged 等转换统计；空窗口生成
 *     空 events 的 scenario（report.eventCount === 0）。
 */

import type { FastifyInstance } from 'fastify';

import { ApiError } from '../errors.js';
import { getEnvironmentOrThrow, requireReadAccess } from '../env-access.js';
import type { EnvironmentStore } from '../db/environment-store.js';
import type { ReplayService, ReplayWindowInput } from '../replay-service.js';
import type { ScenarioStore } from '../scenario-store.js';

export interface ReplayRoutesContext {
  envStore: EnvironmentStore;
  replayService: ReplayService;
  scenarioStore: ScenarioStore;
}

interface IdParams {
  id: string;
}

export function registerReplayRoutes(app: FastifyInstance, ctx: ReplayRoutesContext): void {
  app.post(
    '/api/environments/:id/replays',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireReadAccess(env, ctx.envStore.roleOf(id, user.id));

      const body = (request.body ?? {}) as Record<string, unknown>;
      const from = requireIso(body.from, 'from');
      const to = requireIso(body.to, 'to');
      let mode: 'download' | 'save' = 'download';
      if (body.mode !== undefined) {
        if (body.mode !== 'download' && body.mode !== 'save') {
          throw new ApiError(400, 'BAD_REQUEST', 'Body field "mode" must be "download" or "save"');
        }
        mode = body.mode;
      }
      const input: ReplayWindowInput = {
        from,
        to,
        ...(typeof body.name === 'string' && body.name.trim().length > 0
          ? { name: body.name.trim() }
          : {}),
        ...(typeof body.description === 'string' && body.description.trim().length > 0
          ? { description: body.description.trim() }
          : {}),
      };

      const { definition, report } = await ctx.replayService.buildReplay(env, input, { userId: user.id });

      if (mode === 'save') {
        const saved = ctx.scenarioStore.create(definition);
        return reply.code(201).send({ scenarioId: saved.definition.meta.id, report });
      }
      return { scenario: definition, report };
    },
  );
}

function requireIso(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be an ISO timestamp`);
  }
  return value;
}
