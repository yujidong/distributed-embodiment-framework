/**
 * `eaf scenario-templates` — built-in scenario templates (onboarding).
 *
 * Subcommands (both online, auth required — mirrors the Web create-
 * environment dialog's template picker):
 *   list          — template summaries (id, name, zone/device/agent/event
 *                   counts, mapType)
 *   show <id>     — the full scenario JSON of one template; pipe it into
 *                   `eaf env create --scenario` style flows or POST it to
 *                   /api/environments
 *
 * Exit codes: 0 ok · 1 runtime error · 2 usage error · 3 auth error · 4 not found
 */

import { parse, requirePositional } from '../args.js';
import type { Ctx } from '../ctx.js';
import { usageError } from '../errors.js';

const USAGE_SHOW = 'eaf scenario-templates show <id>';

interface ApiTemplateSummary {
  id: string;
  name: string;
  description?: string;
  counts?: { zones: number; devices: number; agents: number; events: number };
  mapType?: string;
}

export async function scenarioTemplatesCommand(
  ctx: Ctx,
  sub: string | undefined,
  argv: string[],
): Promise<void> {
  switch (sub) {
    case 'list':
      return listTemplates(ctx, argv);
    case 'show':
      return showTemplate(ctx, argv);
    default:
      throw usageError(
        `unknown scenario-templates subcommand "${sub ?? ''}" (expected list|show)`,
      );
  }
}

async function listTemplates(ctx: Ctx, _argv: string[]): Promise<void> {
  // The template names/descriptions are localized server-side; pass the CLI's
  // resolved language (global --lang / EAF_LANG, default en-US) through.
  const result = (await ctx.authedClient().get(
    `/api/scenario-templates?lang=${encodeURIComponent(ctx.lang)}`,
  )) as {
    templates?: ApiTemplateSummary[];
  };
  const templates = result.templates ?? [];
  if (ctx.json) {
    ctx.out.data({ templates });
    return;
  }
  if (templates.length === 0) {
    ctx.io.stdout('(no scenario templates on server)\n');
    return;
  }
  const rows = templates.map(t => ({
    id: t.id,
    name: t.name,
    zones: t.counts?.zones ?? 0,
    devices: t.counts?.devices ?? 0,
    agents: t.counts?.agents ?? 0,
    events: t.counts?.events ?? 0,
    mapType: t.mapType ?? '',
  }));
  const idW = Math.max(2, ...rows.map(r => r.id.length));
  const nameW = Math.max(4, ...rows.map(r => r.name.length));
  ctx.io.stdout(
    `${'id'.padEnd(idW)}  ${'name'.padEnd(nameW)}  z  d  a  e  map\n`,
  );
  for (const r of rows) {
    ctx.io.stdout(
      `${r.id.padEnd(idW)}  ${r.name.padEnd(nameW)}  ${String(r.zones).padStart(1)}  ${String(r.devices).padStart(1)}  ${String(r.agents).padStart(1)}  ${String(r.events).padStart(1)}  ${r.mapType}\n`,
    );
  }
}

async function showTemplate(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_SHOW);
  const id = requirePositional(positionals, '<id>', USAGE_SHOW);
  const scenario = await ctx
    .authedClient()
    .get(`/api/scenario-templates/${encodeURIComponent(id)}`);
  if (ctx.json) {
    ctx.out.data(scenario);
    return;
  }
  // Human mode: the raw JSON is the useful payload here (paste/import).
  ctx.io.stdout(`${JSON.stringify(scenario, null, 2)}\n`);
}
