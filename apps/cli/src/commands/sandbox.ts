/**
 * `eaf sandbox` — sandbox (fork) lifecycle: create / list / stop (R101).
 *
 * The fork kernel is server-side and already isolated (nothing in a
 * sandbox writes back to the authoritative world); these commands are the
 * CLI接驳 of POST/GET /api/environments/:id/sandboxes and
 * POST /api/sandboxes/:id/stop with the same semantics.
 */

import { csvFlag, parse, requirePositional, requireString, stringFlag } from '../args.js';
import { getWithIdPrefix, type Ctx, type IdRosterEntry } from '../ctx.js';
import { usageError } from '../errors.js';

const USAGE_CREATE =
  'eaf sandbox create --env <id|name> [--from-checkpoint] [--overlays proposalId[,…]]';
const USAGE_LIST = 'eaf sandbox list --env <id|name>';
const USAGE_STOP = 'eaf sandbox stop <sandboxId>';

interface SandboxEntry {
  id: string;
  envId: string;
  parentEnvironmentId: string;
  owner: { id: string; displayName: string };
  forkBase: Record<string, unknown>;
  status: string;
  simulationId: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export async function sandboxCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  switch (sub) {
    case 'create':
      return createSandbox(ctx, argv);
    case 'list':
      return listSandboxes(ctx, argv);
    case 'stop':
      return stopSandbox(ctx, argv);
    default:
      throw usageError(`unknown sandbox subcommand "${sub ?? ''}" (expected create|list|stop)`);
  }
}

async function createSandbox(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    {
      env: { type: 'string' },
      'from-checkpoint': { type: 'boolean' },
      overlays: { type: 'string' },
    },
    USAGE_CREATE,
  );
  if (positionals.length > 0) {
    throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_CREATE}`);
  }
  const detail = await ctx.resolveEnv(requireString(flags, 'env', USAGE_CREATE));
  const overlays = csvFlag(flags, 'overlays');
  const fromCheckpoint = flags['from-checkpoint'] === true;
  const sandbox = (await ctx.authedClient().post(
    `/api/environments/${encodeURIComponent(detail.id)}/sandboxes`,
    {
      ...(overlays !== undefined ? { overlays } : {}),
      ...(fromCheckpoint ? { fromCheckpoint: true } : {}),
    },
  )) as SandboxEntry;
  if (ctx.json) {
    ctx.out.data(sandbox);
    return;
  }
  ctx.out.line(
    `sandbox ${sandbox.id} forked from "${detail.name}" (${sandbox.status})` +
    (sandbox.simulationId !== null ? ` — simulation ${sandbox.simulationId}` : '') +
    ' — 沙箱是只读演练副本：实验零回写正式世界，inside it use sim commands/what-if',
  );
}

async function listSandboxes(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { env: { type: 'string' } }, USAGE_LIST);
  if (positionals.length > 0) {
    throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_LIST}`);
  }
  const detail = await ctx.resolveEnv(requireString(flags, 'env', USAGE_LIST));
  const body = (await ctx.authedClient().get(
    `/api/environments/${encodeURIComponent(detail.id)}/sandboxes`,
  )) as { sandboxes: SandboxEntry[] };
  if (ctx.json) {
    ctx.out.data(body.sandboxes);
    return;
  }
  if (body.sandboxes.length === 0) {
    ctx.out.line('(no sandboxes yet — fork one with `eaf sandbox create --env ...`)');
    return;
  }
  ctx.out.table(
    body.sandboxes.map(sandbox => ({
      id: sandbox.id,
      status: sandbox.status,
      owner: sandbox.owner.displayName,
      simulation: sandbox.simulationId ?? '-',
      createdAt: sandbox.createdAt,
    })),
    ['id', 'status', 'owner', 'simulation', 'createdAt'],
  );
}

async function stopSandbox(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_STOP);
  const id = requirePositional(positionals, 'sandboxId', USAGE_STOP);
  // T124 (R19-u2 F1): the stop face joins the prefix family — the list face
  // prints truncated ids and a copied prefix 404'd as raw NOT_FOUND. The
  // roster is the caller's visible envs' sandbox lists; the probe GET
  // (members face answers for a known sandbox) keeps full ids on the
  // zero-extra-roundtrip path.
  const fullId = await getWithIdPrefix(ctx, {
    kind: 'sandbox',
    ref: id,
    get: async candidate => {
      await ctx.authedClient().get(`/api/sandboxes/${encodeURIComponent(candidate)}/members`);
      return candidate;
    },
    roster: sandboxRoster(ctx),
    listHint: 'eaf sandbox list --env <id|name>',
  });
  const result = (await ctx.authedClient().post(
    `/api/sandboxes/${encodeURIComponent(fullId)}/stop`,
    {},
  )) as SandboxEntry | { id: string; status: string };
  if (ctx.json) {
    ctx.out.data(result);
    return;
  }
  ctx.out.line(`sandbox ${fullId} → ${result.status ?? 'stopped'}`);
}

/** T124: the visible sandbox roster — every env the caller can read, best-effort. */
function sandboxRoster(ctx: Ctx): () => Promise<ReadonlyArray<IdRosterEntry>> {
  return async () => {
    const entries: IdRosterEntry[] = [];
    for (const env of await ctx.listEnvs()) {
      try {
        const body = (await ctx.authedClient().get(
          `/api/environments/${encodeURIComponent(env.id)}/sandboxes`,
        )) as { sandboxes: SandboxEntry[] };
        for (const row of body.sandboxes) {
          entries.push({ id: row.id, name: `${row.status} fork of ${env.name}` });
        }
      } catch {
        // unreadable env — skipped (best-effort roster)
      }
    }
    return entries;
  };
}
