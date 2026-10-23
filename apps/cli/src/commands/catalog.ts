/**
 * `eaf catalog` — real-hardware device catalog browsing.
 */

import { parse, requirePositional, stringFlag } from '../args.js';
import type { Ctx } from '../ctx.js';
import { usageError } from '../errors.js';

const USAGE_LIST = 'eaf catalog list [--type <t>] [--vendor <v>] [--q <text>]';
const USAGE_GET = 'eaf catalog get <modelId>';

interface CatalogSummary {
  id: string;
  vendor: string;
  model: string;
  name: string;
  deviceType: string;
  capabilities: string[];
  priceCny: number | null;
  source: string;
}

export async function catalogCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  switch (sub) {
    case 'list':
      return listCatalog(ctx, argv);
    case 'get':
      return getModel(ctx, argv);
    default:
      throw usageError(`unknown catalog subcommand "${sub ?? ''}" (expected list|get)`);
  }
}

async function listCatalog(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { type: { type: 'string' }, vendor: { type: 'string' }, q: { type: 'string' } },
    USAGE_LIST,
  );
  if (positionals.length > 0) throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_LIST}`);
  const params = new URLSearchParams();
  if (stringFlag(flags, 'type')) params.set('device_type', stringFlag(flags, 'type')!);
  if (stringFlag(flags, 'vendor')) params.set('vendor', stringFlag(flags, 'vendor')!);
  if (stringFlag(flags, 'q')) params.set('q', stringFlag(flags, 'q')!);
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const models = (await ctx.openClient().get(`/api/catalog${query}`)) as CatalogSummary[];
  if (ctx.json) {
    ctx.out.data(models);
    return;
  }
  ctx.out.table(
    models.map(model => ({
      id: model.id,
      vendor: model.vendor,
      model: model.model,
      name: model.name,
      type: model.deviceType,
      cny: model.priceCny ?? '-',
    })),
    ['id', 'vendor', 'model', 'name', 'type', 'cny'],
  );
}

async function getModel(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_GET);
  const id = requirePositional(positionals, 'modelId', USAGE_GET);
  const model = (await ctx.openClient().get(`/api/catalog/${encodeURIComponent(id)}`)) as CatalogSummary & {
    physics: Record<string, unknown>;
    specs: Record<string, unknown>;
    status: string;
  };
  if (ctx.json) {
    ctx.out.data(model);
    return;
  }
  ctx.out.line(`${model.name} (${model.id})`);
  ctx.out.line(`  vendor=${model.vendor} model=${model.model} type=${model.deviceType} status=${model.status}`);
  ctx.out.line(`  capabilities: ${model.capabilities.join(', ')}`);
  if (model.priceCny !== null) ctx.out.line(`  price: ¥${model.priceCny}`);
  if (Object.keys(model.specs).length > 0) ctx.out.line(`  specs: ${JSON.stringify(model.specs)}`);
}
