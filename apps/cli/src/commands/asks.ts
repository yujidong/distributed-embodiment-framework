/**
 * `eaf env asks` — the standing-ask 需求板 (T-069, DevLoop R23 — R19
 * NW-F04, design-data-services.md §11): a member's persisted demand for a
 * FUTURE counterpart asset ("when you publish X, I want Y"). Service
 * publish/derivation events match open asks → ask.matched notification (+
 * an optional pre-filled PROPOSED agreement when the ask carries
 * --auto-propose).
 */

import { boolFlag, jsonFlag, parse, rejectExtraPositionals, requirePositional, stringFlag } from '../args.js';
import type { Ctx } from '../ctx.js';
import { usageError } from '../errors.js';

const USAGE_LIST = 'eaf env asks list <id|name> [--status open|mine|all]';
const USAGE_CREATE =
  "eaf env asks create <id|name> --type <semanticType> [--zone <zoneId>] [--terms '<{\"quotaPerWindow\":20,\"windowSec\":86400}>'] " +
  "[--note <text>] [--auto-propose] [--expires <iso>]";const USAGE_WITHDRAW = 'eaf env asks withdraw <id|name> <askId>';

/** Ask entry (subset of the wire shape StandingAsk). */
export interface AskEntry {
  id: string;
  envId: string;
  asker: { id: string; displayName: string };
  semanticType: string;
  zoneId?: string;
  desiredTerms: Record<string, unknown>;
  note: string;
  autoPropose: boolean;
  status: 'open' | 'matched' | 'withdrawn' | 'expired';
  matchedServiceId?: string;
  matchedAt?: string;
  expiresAt: string;
  createdAt: string;
}

export async function asksCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  switch (sub) {
    case 'list':
      return listAsks(ctx, argv);
    case 'create':
      return createAsk(ctx, argv);
    case 'withdraw':
      return withdrawAsk(ctx, argv);
    default:
      throw usageError(
        `unknown asks subcommand "${sub ?? ''}" (expected list|create|withdraw)`,
      );
  }
}

async function listAsks(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { status: { type: 'string' } }, USAGE_LIST);
  const ref = requirePositional(positionals.slice(0, 1), 'id|name', USAGE_LIST);
  rejectExtraPositionals(positionals.slice(1), USAGE_LIST);
  const status = stringFlag(flags, 'status') ?? 'open';
  if (!['open', 'mine', 'all'].includes(status)) {
    throw usageError(`--status must be one of open|mine|all (got "${status}")\nusage: ${USAGE_LIST}`);
  }
  const detail = await ctx.resolveEnv(ref);
  const body = (await ctx.authedClient().get(
    `/api/environments/${encodeURIComponent(detail.id)}/asks?status=${status}`,
  )) as { asks: AskEntry[] };
  if (ctx.json) {
    ctx.out.data(body.asks);
    return;
  }
  if (body.asks.length === 0) {
    ctx.out.line(`no ${status === 'open' ? 'open ' : ''}asks on this board — post one with "eaf env asks create"`);
    return;
  }
  ctx.out.table(
    body.asks.map(ask => ({
      id: ask.id.slice(0, 8),
      type: ask.semanticType,
      zone: ask.zoneId ?? '-',
      asker: ask.asker.displayName,
      auto: ask.autoPropose ? 'yes' : 'no',
      status: ask.status,
      matched: ask.matchedServiceId !== undefined ? ask.matchedServiceId.slice(0, 8) : '-',
      note: ask.note.length > 40 ? `${ask.note.slice(0, 40)}…` : ask.note,
      expires: ask.expiresAt.slice(0, 10),
    })),
    ['id', 'type', 'zone', 'asker', 'auto', 'status', 'matched', 'note', 'expires'],
  );
}

async function createAsk(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    {
      type: { type: 'string' },
      zone: { type: 'string' },
      terms: { type: 'string' },
      note: { type: 'string' },
      'auto-propose': { type: 'boolean' },
      expires: { type: 'string' },
    },
    USAGE_CREATE,
  );
  const ref = requirePositional(positionals.slice(0, 1), 'id|name', USAGE_CREATE);
  rejectExtraPositionals(positionals.slice(1), USAGE_CREATE);
  const semanticType = stringFlag(flags, 'type');
  if (semanticType === undefined || semanticType.length === 0) {
    throw usageError(`missing required flag --type <semanticType>\nusage: ${USAGE_CREATE}`);
  }
  // T-503 (EC24-F01) teaching note: --zone pins the ask to derived services
  // only — the server 400s a zone + never-mintable type naming the usable
  // spellings and the drop-zone option.
  const terms = jsonFlag<Record<string, unknown>>(flags, 'terms', USAGE_CREATE);
  const detail = await ctx.resolveEnv(ref);
  const ask = (await ctx.authedClient().post(`/api/environments/${encodeURIComponent(detail.id)}/asks`, {
    semanticType,
    ...(stringFlag(flags, 'zone') !== undefined ? { zoneId: stringFlag(flags, 'zone') } : {}),
    ...(terms !== undefined ? { desiredTerms: terms } : {}),
    ...(stringFlag(flags, 'note') !== undefined ? { note: stringFlag(flags, 'note') } : {}),
    ...(boolFlag(flags, 'auto-propose') ? { autoPropose: true } : {}),
    ...(stringFlag(flags, 'expires') !== undefined ? { expiresAt: stringFlag(flags, 'expires') } : {}),
  })) as AskEntry;
  if (ctx.json) {
    ctx.out.data(ask);
    return;
  }
  ctx.out.line(
    `ask ${ask.id} posted (status ${ask.status}, expires ${ask.expiresAt.slice(0, 10)}) — ` +
      `a matching service publish/derivation will notify you${ask.autoPropose ? ' and pre-fill a proposed agreement' : ''}`,
  );
}

async function withdrawAsk(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, {}, USAGE_WITHDRAW);
  if (Object.keys(flags).length > 0) {
    throw usageError(`unknown flag(s): ${Object.keys(flags).join(', ')}\nusage: ${USAGE_WITHDRAW}`);
  }
  const ref = requirePositional(positionals.slice(0, 1), 'id|name', USAGE_WITHDRAW);
  const askId = requirePositional(positionals.slice(1), 'askId', USAGE_WITHDRAW);
  const detail = await ctx.resolveEnv(ref);
  const ask = (await ctx.authedClient().delete(
    `/api/environments/${encodeURIComponent(detail.id)}/asks/${encodeURIComponent(askId)}`,
  )) as AskEntry;
  if (ctx.json) {
    ctx.out.data(ask);
    return;
  }
  ctx.out.line(`ask ${ask.id} withdrawn (status ${ask.status})`);
}
