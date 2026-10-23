/**
 * `eaf notifications` — 通知收件箱（Fix-16）：提案裁决、合约提案/决定、
 * 协作应答的持久门铃；WS 掉线错过的事件从这里补拉。
 */

import { boolFlag, numberFlag, parse, requirePositional, stringFlag } from '../args.js';
import { getWithIdPrefix, type Ctx } from '../ctx.js';
import { usageError } from '../errors.js';
import { t } from '../i18n/index.js';

const USAGE_LIST = 'eaf notifications list [--unread] [--kind <k>] [--limit <n>] [--before <iso>]';
const USAGE_READ = 'eaf notifications read <notificationId>';
const USAGE_READ_ALL = 'eaf notifications read-all';

export interface NotificationEntry {
  id: string;
  envId: string;
  kind: string;
  title: string;
  body: Record<string, unknown>;
  refId: string | null;
  readAt: string | null;
  /** R68: unread aggregation — same-key unread repeats merge into one row; the repeat count (absent/1 = a single notification). */
  repeatCount?: number;
  createdAt: string;
}

export async function notificationsCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  switch (sub) {
    case 'list':
      return list(ctx, argv);
    case 'read':
      return read(ctx, argv);
    case 'read-all':
      return readAll(ctx, argv);
    default:
      throw usageError(
        `unknown notifications subcommand "${sub ?? ''}" (expected list|read|read-all)`,
      );
  }
}

async function list(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { unread: { type: 'boolean' }, kind: { type: 'string' }, limit: { type: 'string' }, before: { type: 'string' } },
    USAGE_LIST,
  );
  if (positionals.length > 0) {
    throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_LIST}`);
  }
  const params = new URLSearchParams();
  if (boolFlag(flags, 'unread')) params.set('unread', 'true');
  // T59 (R6, u1-F8): the kind mute face — server-side filter, so limit and
  // pagination describe the FILTERED view (one kind in, e.g. the applied
  // storm, without it drowning out every other kind).
  const kind = stringFlag(flags, 'kind');
  if (kind !== undefined) params.set('kind', kind);
  const limit = numberFlag(flags, 'limit', USAGE_LIST);
  if (limit !== undefined) params.set('limit', String(limit));
  // T-030: backwards cursor (ISO) — strictly older rows, same contract as
  // the activity feed; pass the createdAt of the last row of the previous
  // page to page past the newest-200 clamp.
  const before = stringFlag(flags, 'before');
  if (before !== undefined) {
    if (Number.isNaN(Date.parse(before))) {
      throw usageError(`--before must be an ISO timestamp (got "${before}")\nusage: ${USAGE_LIST}`);
    }
    params.set('before', before);
  }
  const suffix = params.size > 0 ? `?${params}` : '';
  const body = (await ctx.authedClient().get(`/api/notifications${suffix}`)) as {
    notifications: NotificationEntry[];
    unreadCount: number;
  };
  if (ctx.json) {
    ctx.out.data(body);
    return;
  }
  ctx.out.info(t(ctx.lang, 'notifications.unread', { count: body.unreadCount }));
  ctx.out.table(
    body.notifications.map(n => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      // T-059 (§5.3): agreement notifications carry a machine-readable
      // replyHint — 'your move' marks the ones awaiting THIS user's decision.
      yourMove: replyHintOf(n)?.yourMove === true ? '← your move' : '',
      // R68: same-key unread repeats arrive pre-aggregated — show the count.
      x: n.repeatCount !== undefined && n.repeatCount > 1 ? `×${n.repeatCount}` : '',
      unread: n.readAt === null ? '●' : '',
      createdAt: n.createdAt,
    })),
    ['id', 'kind', 'title', 'yourMove', 'x', 'unread', 'createdAt'],
  );
}

/** The T-059 action affordance in a notification body, when present. */
function replyHintOf(n: NotificationEntry): { endpoint: string; allowedDecisions?: string[]; yourMove?: boolean } | undefined {
  const hint = n.body?.replyHint;
  if (typeof hint !== 'object' || hint === null) return undefined;
  return hint as { endpoint: string; allowedDecisions?: string[]; yourMove?: boolean };
}

async function read(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_READ);
  const id = requirePositional(positionals, 'notificationId', USAGE_READ);
  // T124 (R19-u2 F1): the read face joins the prefix family — the list face
  // prints truncated ids; copying one 404'd with NOTIFICATION_NOT_FOUND.
  // The roster is the caller's OWN inbox (the inbox is strictly private, so
  // the resolver cannot leak another user's row); the read POST is
  // idempotent, so the resolve retry is safe.
  const entry = (await getWithIdPrefix(ctx, {
    kind: 'notification',
    ref: id,
    get: full => ctx.authedClient().post(`/api/notifications/${encodeURIComponent(full)}/read`) as Promise<NotificationEntry>,
    roster: async () => {
      const body = (await ctx.authedClient().get('/api/notifications?limit=200')) as {
        notifications: NotificationEntry[];
      };
      return body.notifications.map(n => ({ id: n.id, name: n.title }));
    },
    listHint: 'eaf notifications list (or --kind <k>)',
  })) as NotificationEntry;
  if (ctx.json) ctx.out.data(entry);
  else ctx.out.line(`notification ${entry.id} read (${entry.kind}: ${entry.title})`);
}

async function readAll(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_READ_ALL);
  if (positionals.length > 0) {
    throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_READ_ALL}`);
  }
  const body = (await ctx.authedClient().post('/api/notifications/read-all')) as { marked: number };
  if (ctx.json) ctx.out.data(body);
  else ctx.out.line(`marked ${body.marked} notification(s) read`);
}
