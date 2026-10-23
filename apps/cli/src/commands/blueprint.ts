/**
 * `eaf blueprint` — application blueprints (Fix-38): packed device+agent+flow
 * templates that install into a zone in one call.
 *
 * Mirrors the Web sidebar "Blueprints" tab and the OpenAPI `blueprints` tag:
 *   list [--builtin-only]  — built-in + custom templates (auth required)
 *   show <id>              — one blueprint's full definition
 *   create --name --file   — register a custom blueprint from a YAML/JSON doc
 *   rm <id>                — delete a CUSTOM blueprint (built-ins refused
 *                            server-side; past installs stay until
 *                            "uninstall" removes them)
 *   install <id> --env --zone — resolve `${zoneId}` template variables and
 *                            create the devices/agents/flows in the target
 *                            environment (builder/owner only)
 *   uninstall <id> --env   — remove every object installed from this
 *                            blueprint in the environment (installed_from
 *                            lineage; idempotent, builder/owner only)
 *
 * Exit codes: 0 ok · 1 runtime error · 2 usage error · 3 auth error · 4 not found
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { boolFlag, parse, requirePositional, requireString, stringFlag } from '../args.js';
import type { Ctx } from '../ctx.js';
import { usageError } from '../errors.js';

const USAGE_LIST = 'eaf blueprint list [--builtin-only]';
const USAGE_SHOW = 'eaf blueprint show <blueprintId>';
const USAGE_CREATE = 'eaf blueprint create --name <n> [--desc <d>] --file definition.yaml';
const USAGE_RM = 'eaf blueprint rm <blueprintId>';
const USAGE_INSTALL = 'eaf blueprint install <blueprintId> --env <id|name> --zone <zoneId>';
const USAGE_UNINSTALL = 'eaf blueprint uninstall <blueprintId> --env <id|name>';

interface BlueprintDefinitionFile {
  devices: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
  flows?: Array<Record<string, unknown>>;
  /** R6-D-S3: optional collaboration-pair metadata {blueprintId, note?}. */
  partnerSuggestion?: { blueprintId: string; note?: string };
}

interface ApiBlueprint {
  id: string;
  name: string;
  description: string;
  definition: {
    devices?: unknown[];
    agents?: unknown[];
    flows?: unknown[];
    partnerSuggestion?: { blueprintId: string; note?: string };
  };
  isBuiltin: boolean;
  createdBy: string | null;
}

interface ApiInstallResult {
  blueprintId: string;
  blueprintName: string;
  envId: string;
  zoneId: string;
  createdIds: { devices: string[]; agents: string[]; flows: string[] };
  summary: { devices: number; agents: number; flows: number };
}

export async function blueprintCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  switch (sub) {
    case 'list':
      return listBlueprints(ctx, argv);
    case 'show':
      return showBlueprint(ctx, argv);
    case 'create':
      return createBlueprint(ctx, argv);
    case 'rm':
      return removeBlueprint(ctx, argv);
    case 'install':
      return installBlueprint(ctx, argv);
    case 'uninstall':
      return uninstallBlueprint(ctx, argv);
    default:
      throw usageError(
        `unknown blueprint subcommand "${sub ?? ''}" (expected list|show|create|rm|install|uninstall)`,
      );
  }
}

// ---------------------------------------------------------------------------
// list / show
// ---------------------------------------------------------------------------

async function listBlueprints(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { 'builtin-only': { type: 'boolean' } }, USAGE_LIST);
  if (positionals.length > 0) {
    throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_LIST}`);
  }
  const query = boolFlag(flags, 'builtin-only') ? '?builtinOnly=true' : '';
  const body = (await ctx.authedClient().get(`/api/blueprints${query}`)) as {
    blueprints?: ApiBlueprint[];
  };
  const blueprints = body.blueprints ?? [];
  if (ctx.json) {
    ctx.out.data(blueprints);
    return;
  }
  if (blueprints.length === 0) {
    ctx.io.stdout('(no blueprints on server)\n');
    return;
  }
  ctx.out.table(
    blueprints.map(bp => ({
      id: bp.id,
      name: bp.name,
      kind: bp.isBuiltin ? 'builtin' : 'custom',
      d: bp.definition.devices?.length ?? 0,
      a: bp.definition.agents?.length ?? 0,
      f: bp.definition.flows?.length ?? 0,
      // R6-D-S3: the collaboration-pair pointer, when the card carries one.
      pair: bp.definition.partnerSuggestion?.blueprintId ?? '',
      description: truncate(bp.description, 48),
    })),
    ['id', 'name', 'kind', 'd', 'a', 'f', 'pair', 'description'],
  );
}

async function showBlueprint(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_SHOW);
  const id = requirePositional(positionals, 'blueprintId', USAGE_SHOW);
  const bp = (await ctx.authedClient().get(`/api/blueprints/${encodeURIComponent(id)}`)) as ApiBlueprint;
  if (ctx.json) {
    ctx.out.data(bp);
    return;
  }
  // Human mode: the raw JSON is the useful payload here (paste/edit/repost).
  ctx.io.stdout(`${JSON.stringify(bp, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// create / rm
// ---------------------------------------------------------------------------

async function createBlueprint(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { name: { type: 'string' }, desc: { type: 'string' }, file: { type: 'string' } },
    USAGE_CREATE,
  );
  if (positionals.length > 0) {
    throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_CREATE}`);
  }
  const name = requireString(flags, 'name', USAGE_CREATE);
  const file = requireString(flags, 'file', USAGE_CREATE);
  const definition = parseDefinitionFile(resolve(ctx.io.cwd, file));
  const bp = (await ctx.authedClient().post('/api/blueprints', {
    name,
    ...(stringFlag(flags, 'desc') !== undefined ? { description: stringFlag(flags, 'desc') } : {}),
    definition,
  })) as ApiBlueprint;
  if (ctx.json) {
    ctx.out.data(bp);
    return;
  }
  ctx.out.line(
    `blueprint ${bp.id} "${bp.name}" created ` +
    `(${definition.devices.length} devices, ${definition.agents.length} agents, ` +
    `${definition.flows?.length ?? 0} flows)`,
  );
}

async function removeBlueprint(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_RM);
  const id = requirePositional(positionals, 'blueprintId', USAGE_RM);
  await ctx.authedClient().delete(`/api/blueprints/${encodeURIComponent(id)}`);
  if (ctx.json) ctx.out.data({ deleted: id });
  else ctx.out.line(`deleted blueprint ${id}`);
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

async function installBlueprint(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    { env: { type: 'string' }, zone: { type: 'string' } },
    USAGE_INSTALL,
  );
  const bpId = requirePositional(positionals, 'blueprintId', USAGE_INSTALL);
  const envRef = requireString(flags, 'env', USAGE_INSTALL);
  const zoneId = requireString(flags, 'zone', USAGE_INSTALL);
  const detail = await ctx.resolveEnv(envRef);
  const result = (await ctx.authedClient().post(
    `/api/environments/${encodeURIComponent(detail.id)}/blueprints/${encodeURIComponent(bpId)}/install`,
    { zoneId },
  )) as ApiInstallResult;
  if (ctx.json) {
    ctx.out.data(result);
    return;
  }
  ctx.out.line(
    `installed blueprint ${result.blueprintId} "${result.blueprintName}" into zone ${result.zoneId} (env ${result.envId})`,
  );
  if (result.createdIds.devices.length > 0) {
    ctx.out.line(`  created ${result.createdIds.devices.length} device(s): ${result.createdIds.devices.join(', ')}`);
  }
  if (result.createdIds.agents.length > 0) {
    ctx.out.line(`  created ${result.createdIds.agents.length} agent(s): ${result.createdIds.agents.join(', ')}`);
  }
  if (result.createdIds.flows.length > 0) {
    ctx.out.line(`  created ${result.createdIds.flows.length} flow(s): ${result.createdIds.flows.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

interface ApiUninstallResult {
  blueprintId: string;
  envId: string;
  removedIds: { devices: string[]; agents: string[]; flows: string[] };
  summary: { devices: number; agents: number; flows: number };
}

async function uninstallBlueprint(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { env: { type: 'string' } }, USAGE_UNINSTALL);
  const bpId = requirePositional(positionals, 'blueprintId', USAGE_UNINSTALL);
  const envRef = requireString(flags, 'env', USAGE_UNINSTALL);
  const detail = await ctx.resolveEnv(envRef);
  const result = (await ctx.authedClient().delete(
    `/api/environments/${encodeURIComponent(detail.id)}/blueprints/${encodeURIComponent(bpId)}/instances`,
  )) as ApiUninstallResult;
  if (ctx.json) {
    ctx.out.data(result);
    return;
  }
  ctx.out.line(
    `uninstalled blueprint ${result.blueprintId} from env ${result.envId}: ` +
    `removed ${result.summary.devices} device(s), ${result.summary.agents} agent(s), ` +
    `${result.summary.flows} flow(s)`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load + validate a blueprint definition document (YAML or JSON by extension). */
function parseDefinitionFile(path: string): BlueprintDefinitionFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw usageError(`cannot read blueprint definition file "${path}"`);
  }
  let raw: unknown;
  try {
    raw = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw usageError(`cannot parse blueprint definition file "${path}": ${message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw usageError(`blueprint definition file "${path}" must contain an object {devices, agents, flows?}`);
  }
  const doc = raw as Partial<BlueprintDefinitionFile>;
  const issues: string[] = [];
  if (!Array.isArray(doc.devices) || doc.devices.length === 0) {
    issues.push('devices: required non-empty array');
  }
  if (doc.agents !== undefined && !Array.isArray(doc.agents)) issues.push('agents: must be an array');
  if (doc.flows !== undefined && !Array.isArray(doc.flows)) issues.push('flows: must be an array');
  // R6-D-S3: optional pair metadata must be {blueprintId: string, note?: string}.
  if (doc.partnerSuggestion !== undefined) {
    const s = doc.partnerSuggestion as Record<string, unknown> | null;
    if (
      typeof s !== 'object' || s === null || Array.isArray(s) ||
      typeof s.blueprintId !== 'string' || s.blueprintId.length === 0 ||
      (s.note !== undefined && typeof s.note !== 'string')
    ) {
      issues.push('partnerSuggestion: must be an object {blueprintId: non-empty string, note?: string}');
    }
  }
  if (issues.length > 0) {
    throw usageError(`invalid blueprint definition file "${path}"`, issues);
  }
  return {
    devices: doc.devices!,
    agents: doc.agents ?? [],
    ...(doc.flows !== undefined ? { flows: doc.flows } : {}),
    ...(doc.partnerSuggestion !== undefined ? { partnerSuggestion: doc.partnerSuggestion } : {}),
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
