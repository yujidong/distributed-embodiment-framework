/**
 * `eaf me` — 我的工作台（Fix-16）：GET /api/me/overview 的概览 +
 * 待办门铃（待批提案 / 待 accept 合约 / 未读通知）。--json 输出原始总览。
 *
 * `eaf me quotas`（P4-4）：我的配额用量（limit + used）。
 *
 * `eaf me webhook`（Wave-4b）：出站通知 webhook 的配置
 *（set <url> / show / clear）。webhook 会收到通知全文（敏感信息留意）。
 */

import { parse, rejectExtraPositionals, requirePositional } from '../args.js';
import type { Ctx } from '../ctx.js';
import { usageError } from '../errors.js';
import { t } from '../i18n/index.js';

const USAGE = 'eaf me [--json]';
const USAGE_QUOTAS = 'eaf me quotas';
const USAGE_WEBHOOK = 'eaf me webhook set <url> | show | clear';

/** GET /api/me/quotas (P4-4): every quota's configured limit + current usage. */
interface MeQuotas {
  quotas: Record<string, { limit: number; used: number }>;
}

interface OverviewTodos {
  pendingProposals: number;
  pendingAgreements: number;
  unreadNotifications: number;
}

interface MeOverview {
  user: { id: string; displayName: string; email: string };
  totals: {
    environments: number;
    myAgents: number;
    myDevices: number;
    myServices: number;
    mySubscriptions: number;
    runningSimulations: number;
    /** T63: the caller's own creations (running/paused) among the above. */
    myRunningSimulations?: number;
  };
  todos: OverviewTodos;
}

export async function meCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  if (sub === 'webhook') return webhookCommand(ctx, argv);
  if (sub === 'quotas') return quotasCommand(ctx, argv);
  // webhook / quotas 之外没有子命令——落在 sub 位置的多半是 trailing 全局
  // flag，并入 argv 一并解析。
  const all = sub !== undefined ? [sub, ...argv] : argv;
  const { positionals } = parse(all, {}, USAGE);
  rejectExtraPositionals(positionals, USAGE);
  const overview = (await ctx.authedClient().get('/api/me/overview')) as MeOverview;
  if (ctx.json) {
    ctx.out.data(overview);
    return;
  }
  const { totals, todos } = overview;
  ctx.out.line(`${overview.user.displayName} <${overview.user.email}>`);
  ctx.out.line(
    t(ctx.lang, 'me.overview', {
      envs: totals.environments,
      devices: totals.myDevices,
      agents: totals.myAgents,
      services: totals.myServices,
      bookmarks: totals.mySubscriptions,
      running: totals.runningSimulations,
    }),
  );
  // T63 (R6, u1-F4/u2-F-2-1): the DUAL figures — the workbench row counts
  // every live sim of every environment you participate in (others' included,
  // the attach semantics), `myRunningSimulations` is your own creations. The
  // old single note ("统计你创建的") contradicted the quotas row's identical
  // wording while the two numbers counted different things.
  ctx.out.line(
    t(ctx.lang, 'me.runningScopeNote', {
      envWide: totals.runningSimulations,
      mine: totals.myRunningSimulations ?? totals.runningSimulations,
    }),
  );
  ctx.out.line(
    t(ctx.lang, 'me.todo.line', {
      pendingProposals: todos.pendingProposals,
      pendingAgreements: todos.pendingAgreements,
      unread: todos.unreadNotifications,
    }),
  );
}

/**
 * `eaf me quotas` (P4-4): each quota's configured limit and the caller's
 * current usage (per-env quotas report the caller's FULLEST owned env).
 */
async function quotasCommand(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_QUOTAS);
  rejectExtraPositionals(positionals, USAGE_QUOTAS);
  const body = (await ctx.authedClient().get('/api/me/quotas')) as MeQuotas;
  if (ctx.json) {
    ctx.out.data(body);
    return;
  }
  ctx.out.table(
    Object.entries(body.quotas).map(([quota, row]) => ({
      quota,
      used: row.used,
      limit: row.limit,
      note: quotaScopeNote(quota, row.used),
    })),
    ['quota', 'used', 'limit', 'note'],
  );
}

/**
 * T38.6 (R3, u2-F-12/u4-F9): the quota's counting SCOPE, inline —
 * `runningSimsPerUser` is env-全局 (every live sim you created, all envs,
 * paused included) and the per-env quotas count only envs you OWN (a shared
 * env full of devices does not raise your used). Pure for the render suite.
 */
export function quotaScopeNote(quota: string, used: number): string {
  if (quota === 'runningSimsPerUser') return '（env 全局：统计你在所有环境创建的 running/paused sims）';
  if ((quota === 'devicesPerEnv' || quota === 'agentsPerEnv') && used === 0) {
    return '（used=0？只统计你拥有的环境）';
  }
  return '';
}

async function webhookCommand(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_WEBHOOK);
  const action = positionals[0];
  switch (action) {
    case 'set': {
      const url = requirePositional(positionals.slice(1), 'url', USAGE_WEBHOOK);
      const body = (await ctx.authedClient().put('/api/me/notification-webhook', { url })) as {
        url: string;
      };
      if (ctx.json) ctx.out.data(body);
      else ctx.out.line(`notification webhook set: ${body.url}`);
      return;
    }
    case 'show': {
      const body = (await ctx.authedClient().get('/api/me/notification-webhook')) as {
        url: string | null;
      };
      if (ctx.json) ctx.out.data(body);
      else ctx.out.line(body.url ?? t(ctx.lang, 'me.webhook.unset'));
      return;
    }
    case 'clear': {
      const body = (await ctx.authedClient().delete('/api/me/notification-webhook')) as {
        url: string | null;
      };
      if (ctx.json) ctx.out.data(body);
      else ctx.out.line('notification webhook cleared');
      return;
    }
    default:
      throw usageError(
        `unknown me webhook action "${action ?? ''}" (expected set|show|clear)`,
      );
  }
}
