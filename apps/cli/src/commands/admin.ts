/**
 * `eaf admin` — operator actions (R15-A2)
 *
 * `eaf admin backup`: consistent live snapshot of the server's SQLite
 * database via POST /api/admin/backup (ADMIN_EMAILS-gated on the server).
 * The server picks the destination; this only reports it. Restore
 * procedure lives in docs/deployment.md.
 *
 * `eaf admin invites list|create|revoke`: platform registration invites for
 * the alpha invite gate (EAF_INVITE_ONLY, schema v57), backed by
 * /api/admin/invites (ADMIN_EMAILS-gated). `create` prints the plaintext
 * code ONCE — hand it to the invitee; `revoke` disables a code immediately.
 *
 * `eaf admin users list`: the registered-account roster behind the invite
 * gate (GET /api/admin/users, ADMIN_EMAILS-gated) — who is in, and which
 * emails are admins.
 */

import { parse, rejectExtraPositionals, requirePositional, stringFlag } from '../args.js';
import type { Ctx } from '../ctx.js';
import { usageError } from '../errors.js';

const USAGE = 'eaf admin backup';
const USAGE_INVITES =
  'eaf admin invites <list | create [--max-uses <n>] [--expires-in-days <d>] | revoke <code>>';
const USAGE_USERS = 'eaf admin users list';

interface BackupResult {
  path: string;
  sizeBytes: number;
  createdAt: string;
}

interface PlatformInvite {
  code: string;
  maxUses: number;
  usedCount: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  isAdmin: boolean;
}

export async function adminCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  switch (sub) {
    case 'backup':
      return backup(ctx, argv);
    case 'invites':
      return invites(ctx, argv);
    case 'users':
      return users(ctx, argv);
    default:
      throw usageError(`unknown admin subcommand "${sub ?? ''}" (expected backup|invites|users)`);
  }
}

async function backup(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE);
  rejectExtraPositionals(positionals, USAGE);
  const result = (await ctx.authedClient().post('/api/admin/backup')) as BackupResult;
  if (ctx.json) {
    ctx.out.data(result);
    return;
  }
  const mib = (result.sizeBytes / 1024 / 1024).toFixed(1);
  ctx.out.line(`backup complete: ${result.path} (${mib} MiB, ${result.createdAt})`);
}

async function invites(ctx: Ctx, argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  switch (action) {
    case 'list': {
      const { positionals } = parse(rest, {}, USAGE_INVITES);
      rejectExtraPositionals(positionals, USAGE_INVITES);
      const body = (await ctx.authedClient().get('/api/admin/invites')) as {
        invites: PlatformInvite[];
      };
      if (ctx.json) {
        ctx.out.data(body.invites);
        return;
      }
      if (body.invites.length === 0) {
        ctx.out.line('no platform invites yet — create one with `eaf admin invites create`');
        return;
      }
      for (const invite of body.invites) {
        ctx.out.line(formatInvite(invite));
      }
      return;
    }
    case 'create': {
      const { flags, positionals } = parse(
        rest,
        { 'max-uses': { type: 'string' }, 'expires-in-days': { type: 'string' } },
        USAGE_INVITES,
      );
      rejectExtraPositionals(positionals, USAGE_INVITES);
      const maxUsesRaw = stringFlag(flags, 'max-uses');
      const expiresRaw = stringFlag(flags, 'expires-in-days');
      const maxUses = maxUsesRaw === undefined ? undefined : Number(maxUsesRaw);
      const expiresInDays = expiresRaw === undefined ? undefined : Number(expiresRaw);
      if (maxUses !== undefined && (!Number.isInteger(maxUses) || maxUses < 1)) {
        throw usageError(`--max-uses must be an integer >= 1 (got "${maxUsesRaw}")`);
      }
      if (expiresInDays !== undefined && (!Number.isInteger(expiresInDays) || expiresInDays < 1)) {
        throw usageError(`--expires-in-days must be an integer >= 1 (got "${expiresRaw}")`);
      }
      const invite = (await ctx.authedClient().post('/api/admin/invites', {
        ...(maxUses !== undefined ? { maxUses } : {}),
        ...(expiresInDays !== undefined ? { expiresInDays } : {}),
      })) as PlatformInvite;
      if (ctx.json) {
        ctx.out.data(invite);
        return;
      }
      ctx.out.line(`invite created: ${invite.code}`);
      ctx.out.line(`  ${formatInvite(invite)}`);
      ctx.out.line('  hand the code to the invitee — register with it via web or `eaf auth register --invite-code`');
      return;
    }
    case 'revoke': {
      const { positionals } = parse(rest, {}, USAGE_INVITES);
      const code = requirePositional(positionals, 'code', USAGE_INVITES);
      const invite = (await ctx
        .authedClient()
        .post(`/api/admin/invites/${encodeURIComponent(code)}/revoke`)) as PlatformInvite;
      if (ctx.json) {
        ctx.out.data(invite);
        return;
      }
      ctx.out.line(`revoked: ${formatInvite(invite)}`);
      return;
    }
    default:
      throw usageError(`unknown admin invites action "${action ?? ''}" (expected list|create|revoke)`);
  }
}

async function users(ctx: Ctx, argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  switch (action) {
    case 'list': {
      const { positionals } = parse(rest, {}, USAGE_USERS);
      rejectExtraPositionals(positionals, USAGE_USERS);
      const body = (await ctx.authedClient().get('/api/admin/users')) as {
        users: AdminUser[];
      };
      if (ctx.json) {
        ctx.out.data(body.users);
        return;
      }
      if (body.users.length === 0) {
        ctx.out.line('no registered users');
        return;
      }
      for (const user of body.users) {
        ctx.out.line(formatUser(user));
      }
      return;
    }
    default:
      throw usageError(`unknown admin users action "${action ?? ''}" (expected list)`);
  }
}

function formatUser(user: AdminUser): string {
  const admin = user.isAdmin ? '  [admin]' : '';
  return `${user.email}  ${user.displayName}  registered ${user.createdAt}${admin}`;
}

function formatInvite(invite: PlatformInvite): string {
  const status =
    invite.revokedAt !== null
      ? `revoked ${invite.revokedAt}`
      : invite.expiresAt !== null && invite.expiresAt <= new Date().toISOString()
        ? `expired ${invite.expiresAt}`
        : invite.usedCount >= invite.maxUses
          ? 'exhausted'
          : 'active';
  const expiry = invite.expiresAt === null ? 'never' : invite.expiresAt;
  return (
    `${invite.code}  uses ${invite.usedCount}/${invite.maxUses}  ${status}` +
    `  expires ${expiry}  by ${invite.createdBy}  created ${invite.createdAt}`
  );
}
