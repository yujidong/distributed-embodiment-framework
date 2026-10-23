/**
 * `eaf agent` — agent instances: list / add (from a YAML/JSON file with
 * name-based device binding) / rm.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { boolFlag, csvFlag, parse, requirePositional, requireString, stringFlag } from '../args.js';
import {
  getWithIdPrefix,
  isEnvProposal,
  proposalAppliedSummary,
  type Ctx,
  type EnvAgent,
  type EnvDetail,
  type EnvProposal,
  type IdRosterEntry,
} from '../ctx.js';
import { EXIT, CliError, usageError } from '../errors.js';

const USAGE_LIST = 'eaf agent list --env <id|name>';
const USAGE_GET = 'eaf agent get <agentId> [--env <id|name]>';
const USAGE_ADD = 'eaf agent add --env <id|name> --file agent.yaml';
const USAGE_UPDATE =
  'eaf agent update <agentId> [--name <n>] [--capabilities a,b] [--bind d1,d2] [--zones z1,z2] [--enable|--disable] [--llm-file llm.yaml]';
const USAGE_RM = 'eaf agent rm <agentId>';
const USAGE_COMMAND = 'eaf agent command <agentId> <text...> [--sim <simId>]';
const USAGE_ASK = 'eaf agent ask <agentId> <text...> [--sim <simId>]';
const USAGE_WHAT_IF = 'eaf agent what-if <agentId> <text...> [--sim <simId>] (text also accepted as --text "…")';

interface AgentFile {
  name: string;
  capabilities: string[];
  bind?: string[];
  zones?: string[];
  llm?: Record<string, unknown>;
  /**
   * R15 (FR15-F02): default visibility for this agent's FUTURE derived
   * services ('members' | 'hidden'). 'hidden' derives them hidden from the
   * first moment (per-bed vitals style); absent keeps the members default.
   */
  derivedServiceVisibility?: 'members' | 'hidden';
}

export async function agentCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  switch (sub) {
    case 'list':
      return listAgents(ctx, argv);
    case 'get':
      return getAgent(ctx, argv);
    case 'add':
      return addAgent(ctx, argv);
    case 'update':
      return updateAgent(ctx, argv);
    case 'rm':
      return removeAgent(ctx, argv);
    case 'command':
      return nlCommand(ctx, argv, 'command');
    case 'ask':
      return nlCommand(ctx, argv, 'ask');
    case 'what-if':
      return whatIfCommand(ctx, argv);
    default:
      throw usageError(`unknown agent subcommand "${sub ?? ''}" (expected list|get|add|update|rm|command|ask|what-if)`);
  }
}

/**
 * T88 (R12, u2-F1): the agent roster the caller can read — one named env, or
 * every visible environment. Best-effort: an unreadable env is skipped (a
 * fully failed scan rethrows the get face's original error).
 */
function agentRoster(ctx: Ctx, envRef: string | undefined): () => Promise<ReadonlyArray<IdRosterEntry>> {
  return async () => {
    if (envRef !== undefined) {
      const detail = await ctx.resolveEnv(envRef);
      return detail.agents.map(agent => ({ id: agent.id, name: agent.name }));
    }
    const entries: IdRosterEntry[] = [];
    for (const env of await ctx.listEnvs()) {
      try {
        const detail = (await ctx.openClient().get(
          `/api/environments/${encodeURIComponent(env.id)}`,
        )) as EnvDetail;
        for (const agent of detail.agents) entries.push({ id: agent.id, name: agent.name });
      } catch {
        continue; // unreadable env — skipped (best-effort roster)
      }
    }
    return entries;
  };
}

/**
 * `eaf agent get <agentId>` (R101 trust-visibility ④): one agent's detail +
 * 履约档案 — the per-capability reputation rows (P4-1, same source the
 * market's service reputation reads) plus the agent's services with their
 * trackRecord/usageSummary. --env skips the env scan when the agent id is
 * already known to live in one environment. T88: <agentId> accepts a short
 * prefix, resolved against the visible roster when the exact id is unknown.
 */
async function getAgent(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { env: { type: 'string' } }, USAGE_GET);
  const id = requirePositional(positionals, 'agentId', USAGE_GET);
  const envRef = stringFlag(flags, 'env');
  const located = await getWithIdPrefix(ctx, {
    kind: 'agent',
    ref: id,
    get: async (full: string): Promise<{ detail: EnvDetail; agent: EnvAgent }> => {
      let detail: EnvDetail;
      if (envRef !== undefined) {
        detail = await ctx.resolveEnv(envRef);
      } else {
        const matches: EnvDetail[] = [];
        for (const env of await ctx.listEnvs()) {
          let candidate: EnvDetail;
          try {
            candidate = (await ctx.openClient().get(`/api/environments/${encodeURIComponent(env.id)}`)) as EnvDetail;
          } catch {
            continue; // unreadable env — not where the agent lives
          }
          if (candidate.agents.some(agent => agent.id === full)) matches.push(candidate);
        }
        if (matches.length === 0) {
          throw new CliError(`agent "${full}" not found in any environment you can read`, EXIT.NOT_FOUND);
        }
        if (matches.length > 1) {
          throw new CliError(
            `agent "${full}" exists in ${matches.length} environments — disambiguate with --env (${matches.map(env => env.name).join(', ')})`,
            EXIT.USAGE,
          );
        }
        detail = matches[0]!;
      }
      const agent = detail.agents.find(row => row.id === full);
      if (agent === undefined) {
        throw new CliError(`agent "${full}" not found in environment "${detail.name}"`, EXIT.NOT_FOUND);
      }
      return { detail, agent };
    },
    roster: agentRoster(ctx, envRef),
    listHint: envRef !== undefined ? `eaf agent list --env ${envRef}` : 'eaf agent list --env <id|name>',
  });
  const { detail, agent } = located;
  const reputation = (await ctx.openClient().get(
    `/api/environments/${encodeURIComponent(detail.id)}/agents/${encodeURIComponent(agent.id)}/reputation`,
  )) as {
    overallScore: number;
    totalAttempts: number;
    capabilities: Array<{
      capability: string;
      score: number;
      attempts: number;
      successes: number;
      failures: number;
    }>;
  };
  const services = ((await ctx.openClient().get(
    `/api/environments/${encodeURIComponent(detail.id)}/services?provider=${encodeURIComponent(agent.id)}`,
  )) as {
    services: Array<{
      id: string;
      name: string;
      trackRecord?: 'established' | 'none';
      /** T79 (R8): drift fact rides the payload — the roster marks it (⚠). */
      declaredByProvider?: boolean;
      usageSummary?: {
        invocations: number;
        succeeded: number;
        failed: number;
        partial?: number;
        other?: number;
        successRate: number | null;
      };
    }>;
  }).services;
  // T9 (R2, u2-F5/u4-F7): the agent provider's PENDING decisions — proposed
  // agreements waiting on this agent's side. The server scopes the list to
  // the caller's party/owner view, so a non-owner viewer simply gets zero
  // rows here (no leak). One line in human mode, a field in --json.
  const pendingProposals = (
    (await ctx.openClient().get(
      `/api/agreements?envId=${encodeURIComponent(detail.id)}&role=provider&status=proposed`,
    )) as {
      agreements: Array<{
        id: string;
        providerAgentId: string | null;
        service?: { name: string } | null;
        consumer?: { displayName: string } | null;
        createdAt: string;
        remindCount?: number;
      }>;
    }
  ).agreements.filter(row => row.providerAgentId === agent.id);
  if (ctx.json) {
    ctx.out.data({ agent, reputation, services, pendingProposals });
    return;
  }
  ctx.out.line(
    `agent ${agent.id} "${agent.name}" (owner ${agent.owner.displayName}` +
    `${agent.enabled === false ? ', disabled' : ''})`,
  );
  ctx.out.line(
    `  capabilities: ${agent.capabilities.join(', ') || '-'} · bound devices: ${agent.boundDeviceIds.length} · env=${detail.name}`,
  );
  // T37 (R3, u4-F4): a zero-sample score is the Bayesian PRIOR — never
  // rendered as a bare measured number (same face as service get).
  // T66a (R6, u1-F10): measured scores render at TWO decimals — the 16-digit
  // float (0.6818455374547898) is machine data, not a human face.
  const round2 = (value: number): string => value.toFixed(2);
  ctx.out.line(
    `  履约档案: ` +
    (reputation.totalAttempts === 0
      ? `overall —（无履约样本） over 0 attempt(s) — 暂无履约记录 (cold start)`
      : `overall score ${round2(reputation.overallScore)} over ${reputation.totalAttempts} attempt(s)`),
  );
  for (const row of reputation.capabilities) {
    ctx.out.line(
      row.attempts === 0
        ? `    ${row.capability}: score —（无履约样本） · 0 attempts / 0 succeeded / 0 failed`
        : `    ${row.capability}: score ${round2(row.score)} · ${row.attempts} attempts / ${row.successes} succeeded / ${row.failures} failed`,
    );
  }
  if (services.length > 0) {
    ctx.out.line(`  services (${services.length}):`);
    for (const service of services) {
      const summary = service.usageSummary;
      const trackRecord = service.trackRecord ?? 'none';
      ctx.out.line(
        `    ${service.name}${service.declaredByProvider === false ? ' ⚠' : ''} [${trackRecord === 'established' ? '有履约记录' : '暂无履约记录'}]` +
        (summary !== undefined
          ? ` — 30d ${summary.invocations} invocations` +
            (summary.successRate !== null ? `, success ${(summary.successRate * 100).toFixed(0)}%` : '')
          : ''),
      );
    }
  }
  // T9: pending decisions on the provider side — visible without polling
  // the agreements list (empty for non-owner viewers by server scoping).
  if (pendingProposals.length > 0) {
    ctx.out.line(`  pending decisions (${pendingProposals.length}):`);
    for (const row of pendingProposals) {
      ctx.out.line(
        `    ${row.id} — ${row.service?.name ?? '(service retired)'} from ${row.consumer?.displayName ?? '?'}` +
        ` since ${row.createdAt}` +
        (row.remindCount !== undefined && row.remindCount > 0 ? `, reminded ${row.remindCount}×` : ''),
      );
    }
  }
}

async function listAgents(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { env: { type: 'string' } }, USAGE_LIST);
  if (positionals.length > 0) throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_LIST}`);
  const detail = await ctx.resolveEnv(requireString(flags, 'env', USAGE_LIST));
  if (ctx.json) {
    ctx.out.data(detail.agents);
    return;
  }
  ctx.out.table(
    detail.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      caps: agent.capabilities.length,
      zones: agent.managedZoneIds.length,
      devices: agent.boundDeviceIds.length,
      llm: agent.llm ? String(agent.llm.provider ?? 'set') : '-',
    })),
    ['id', 'name', 'caps', 'zones', 'devices', 'llm'],
  );
}

function parseAgentFile(path: string): AgentFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw usageError(`cannot read agent file "${path}"`);
  }
  let raw: unknown;
  try {
    raw = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw usageError(`cannot parse agent file "${path}": ${message}`);
  }
  const issues: string[] = [];
  const doc = raw as Partial<AgentFile>;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw usageError(`agent file "${path}" must contain an object {name, capabilities, bind?, zones?, llm?}`);
  }
  if (typeof doc.name !== 'string' || doc.name.trim().length === 0) issues.push('name: required non-empty string');
  if (!Array.isArray(doc.capabilities) || doc.capabilities.some(c => typeof c !== 'string')) {
    issues.push('capabilities: required array of strings');
  }
  if (doc.bind !== undefined && (!Array.isArray(doc.bind) || doc.bind.some(b => typeof b !== 'string'))) {
    issues.push('bind: must be an array of device names or ids');
  }
  if (doc.zones !== undefined && (!Array.isArray(doc.zones) || doc.zones.some(z => typeof z !== 'string'))) {
    issues.push('zones: must be an array of zone ids');
  }
  if (
    doc.derivedServiceVisibility !== undefined &&
    doc.derivedServiceVisibility !== 'members' &&
    doc.derivedServiceVisibility !== 'hidden'
  ) {
    issues.push('derivedServiceVisibility: must be "members" or "hidden"');
  }
  if (issues.length > 0) {
    throw usageError(`invalid agent file "${path}"`, issues);
  }
  return doc as AgentFile;
}

async function addAgent(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { env: { type: 'string' }, file: { type: 'string' } }, USAGE_ADD);
  if (positionals.length > 0) throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_ADD}`);
  const envRef = requireString(flags, 'env', USAGE_ADD);
  const file = requireString(flags, 'file', USAGE_ADD);
  const doc = parseAgentFile(resolve(ctx.io.cwd, file));
  const detail = await ctx.resolveEnv(envRef);

  // Resolve bind entries (device names or ids) within the environment —
  // collect every failure before reporting.
  const errors: string[] = [];
  const boundDeviceIds: string[] = [];
  for (const ref of doc.bind ?? []) {
    const device = detail.devices.find(d => d.id === ref) ?? detail.devices.find(d => d.name === ref);
    if (device) {
      if (!boundDeviceIds.includes(device.id)) boundDeviceIds.push(device.id);
    } else {
      errors.push(`bind "${ref}": no device with that name or id in environment "${detail.name}"`);
    }
  }
  for (const zone of doc.zones ?? []) {
    if (!detail.zones.some(z => z.id === zone)) {
      errors.push(`zone "${zone}": does not exist in environment "${detail.name}"`);
    }
  }
  if (errors.length > 0) {
    throw new CliError(`cannot add agent "${doc.name}"`, EXIT.USAGE, errors);
  }

  const response = (await ctx.authedClient().post(`/api/environments/${encodeURIComponent(detail.id)}/agents`, {
    name: doc.name,
    capabilities: doc.capabilities,
    boundDeviceIds,
    managedZoneIds: doc.zones ?? [],
    ...(doc.llm !== undefined ? { llm: doc.llm } : {}),
    ...(doc.derivedServiceVisibility !== undefined
      ? { derivedServiceVisibility: doc.derivedServiceVisibility }
      : {}),
  })) as EnvAgent | EnvProposal;
  // Fix-7: in a shared environment a builder's add becomes an install-agents
  // proposal — say so plainly instead of pretending the agent exists.
  if (isEnvProposal(response)) {
    if (ctx.json) {
      ctx.out.data({ ...response, proposal: true });
    } else {
      const applied = proposalAppliedSummary(response);
      if (applied) {
        ctx.out.line(applied);
      } else {
        ctx.out.line(
          `proposal ${response.id} submitted (install-agents → ${response.status}) — ` +
          `agent "${doc.name}" lands in the world when the pipeline approves it`,
        );
      }
    }
    return;
  }
  const agent = response;
  if (ctx.json) {
    ctx.out.data(agent);
  } else {
    ctx.out.line(
      `agent ${agent.id} "${agent.name}" added (${agent.capabilities.length} caps, ` +
      `${agent.boundDeviceIds.length} devices, zones: ${agent.managedZoneIds.join(', ') || '-'})`,
    );
  }
}

interface LlmFile {
  provider: string;
  model: string;
  params?: Record<string, unknown>;
  systemPrompt?: string;
}

function parseLlmFile(path: string): LlmFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw usageError(`cannot read llm file "${path}"`);
  }
  let raw: unknown;
  try {
    raw = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw usageError(`cannot parse llm file "${path}": ${message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw usageError(`llm file "${path}" must contain an object {provider, model, params?, systemPrompt?}`);
  }
  const doc = raw as Partial<LlmFile>;
  const issues: string[] = [];
  if (typeof doc.provider !== 'string' || doc.provider.trim().length === 0) issues.push('provider: required non-empty string');
  if (typeof doc.model !== 'string' || doc.model.trim().length === 0) issues.push('model: required non-empty string');
  if (doc.systemPrompt !== undefined && typeof doc.systemPrompt !== 'string') issues.push('systemPrompt: must be a string');
  if (issues.length > 0) {
    throw usageError(`invalid llm file "${path}"`, issues);
  }
  return doc as LlmFile;
}

async function updateAgent(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    {
      name: { type: 'string' },
      capabilities: { type: 'string' },
      bind: { type: 'string' },
      zones: { type: 'string' },
      enable: { type: 'boolean' },
      disable: { type: 'boolean' },
      'llm-file': { type: 'string' },
    },
    USAGE_UPDATE,
  );
  const id = requirePositional(positionals, 'agentId', USAGE_UPDATE);
  const body: Record<string, unknown> = {};
  const name = stringFlag(flags, 'name');
  if (name !== undefined) body.name = name;
  const capabilities = csvFlag(flags, 'capabilities');
  if (capabilities !== undefined) body.capabilities = capabilities;
  const bind = csvFlag(flags, 'bind');
  if (bind !== undefined) body.boundDeviceIds = bind;
  const zones = csvFlag(flags, 'zones');
  if (zones !== undefined) body.managedZoneIds = zones;
  if (boolFlag(flags, 'enable') && boolFlag(flags, 'disable')) {
    throw usageError(`--enable and --disable are mutually exclusive\nusage: ${USAGE_UPDATE}`);
  }
  if (boolFlag(flags, 'enable')) body.enabled = true;
  if (boolFlag(flags, 'disable')) body.enabled = false;
  const llmFile = stringFlag(flags, 'llm-file');
  if (llmFile !== undefined) body.llm = parseLlmFile(resolve(ctx.io.cwd, llmFile));
  if (Object.keys(body).length === 0) {
    throw usageError(
      `nothing to update — pass --name, --capabilities, --bind, --zones, --enable/--disable or --llm-file\nusage: ${USAGE_UPDATE}`,
    );
  }
  let agent: EnvAgent;
  try {
    agent = (await ctx.authedClient().patch(`/api/agents/${encodeURIComponent(id)}`, body)) as EnvAgent;
  } catch (error) {
    // T-048: a builder's direct PATCH is owner-only (403 pointing at the
    // modify-object proposal path). Mirror the server's DELETE conversion
    // client-side — submit the SAME patch as a governed proposal instead of
    // leaving the builder at a dead end. Foreign agents / other failures
    // rethrow untouched.
    if (error instanceof CliError && error.exitCode === EXIT.ERROR && error.message.includes('[FORBIDDEN]')) {
      const proposal = await submitModifyObjectFallback(ctx, id, body);
      if (proposal !== null) {
        reportGovernedProposal(ctx, proposal, 'the change lands when the pipeline approves it');
        return;
      }
    }
    throw error;
  }
  if (ctx.json) {
    ctx.out.data(agent);
  } else {
    ctx.out.line(
      `agent ${agent.id} "${agent.name}" updated (${agent.capabilities.length} caps` +
      `${agent.enabled === false ? ', disabled' : ''}${agent.llm ? `, llm=${String(agent.llm.provider ?? 'set')}` : ''})`,
    );
  }
}

/**
 * T-048: submit a modify-object proposal for an agent the CALLER owns in one
 * of their environments (the server's own DELETE conversion mirrors this).
 * Returns null when no conversion applies — unknown environment, or an agent
 * owned by someone else (no governed path exists; the original 403 stands).
 */
async function submitModifyObjectFallback(
  ctx: Ctx,
  agentId: string,
  patch: Record<string, unknown>,
): Promise<EnvProposal | null> {
  const me = (await ctx.authedClient().get('/api/auth/me')) as { id: string };
  for (const env of await ctx.listEnvs()) {
    let detail: EnvDetail;
    try {
      detail = (await ctx.openClient().get(`/api/environments/${encodeURIComponent(env.id)}`)) as EnvDetail;
    } catch {
      continue; // unreadable env — not where the agent lives
    }
    const agent = detail.agents.find(row => row.id === agentId);
    if (agent === undefined) continue;
    if (agent.owner.id !== me.id) return null; // someone else's agent — no governed path
    const proposal = (await ctx.authedClient().post(
      `/api/environments/${encodeURIComponent(detail.id)}/proposals`,
      { kind: 'modify-object', payload: { targetId: agentId, patch } },
    )) as EnvProposal;
    return proposal;
  }
  return null;
}

/**
 * T-048: report a governed proposal outcome TRUTHFULLY — the json channel
 * flags it `proposal: true` (never masquerading as the object), the human
 * channel names the id/status and what still has to happen. A rule-check
 * rejection surfaces its issues (they teach the fix).
 */
function reportGovernedProposal(ctx: Ctx, proposal: EnvProposal, pendingLine: string): void {
  if (ctx.json) {
    ctx.out.data({ ...proposal, proposal: true });
    return;
  }
  if (proposal.status === 'rejected') {
    throw new CliError(
      `proposal ${proposal.id} was rejected by the rule check`,
      EXIT.USAGE,
      proposal.ruleCheck?.issues,
    );
  }
  if (proposal.status === 'applied') {
    ctx.out.line(`proposal ${proposal.id} applied`);
    return;
  }
  ctx.out.line(`proposal ${proposal.id} submitted (${proposal.kind} → ${proposal.status}) — ${pendingLine}`);
}

/**
 * NL interface (cognitive architecture Phase 3): `eaf agent command` /
 * `eaf agent ask` talk to a RUNNING agent in plain language. The text is
 * everything after the agent id (no quoting needed); --sim disambiguates
 * when the same agent runs in several live simulations.
 */
/**
 * T101 (R16, u3/u4): the ask/command HUMAN face as a pure function (the
 * render-contract discipline — fixture-testable lines). The reply body is
 * the server's naturalLanguageResponse; the structured `jurisdictionNote`
 * (the T100 out-of-jurisdiction disclosure) rides that body when the server
 * joined it, and this face still renders the standalone field when it does
 * not — the R102 line (human ≥ json's interpretive fields) must not depend
 * on one server-side join surviving every refactor.
 */
export function renderAskLines(response: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const main = String(response.naturalLanguageResponse ?? '').trim();
  if (main.length > 0) lines.push(main);
  const note = typeof response.jurisdictionNote === 'string' ? response.jurisdictionNote.trim() : '';
  if (note.length > 0 && !main.includes(note)) lines.push(note);
  // T122 (R17-u3/R19-u4): the env default-simulation disclosure — the
  // structured field renders even when the server-side body join drifts
  // (the jurisdictionNote precedent, R102).
  const simNote = typeof response.defaultSimNote === 'string' ? response.defaultSimNote.trim() : '';
  if (simNote.length > 0 && !main.includes(simNote)) lines.push(simNote);
  return lines;
}

async function nlCommand(ctx: Ctx, argv: string[], kind: 'command' | 'ask'): Promise<void> {
  const usage = kind === 'command' ? USAGE_COMMAND : USAGE_ASK;
  const { flags, positionals } = parse(argv, { sim: { type: 'string' } }, usage);
  if (positionals.length < 2) {
    throw usageError(`expected <agentId> and the ${kind} text\nusage: ${usage}`);
  }
  const agentId = positionals[0];
  const text = positionals.slice(1).join(' ').trim();
  if (text.length === 0) {
    throw usageError(`the ${kind} text must not be empty\nusage: ${usage}`);
  }
  const sim = stringFlag(flags, 'sim');
  const response = (await ctx.authedClient().post(
    `/api/agents/${encodeURIComponent(agentId)}/${kind}`,
    { text, ...(sim !== undefined ? { simId: sim } : {}) },
  )) as Record<string, unknown>;

  if (ctx.json) {
    ctx.out.data(response);
    return;
  }
  for (const line of renderAskLines(response)) {
    ctx.out.line(line);
  }
  if (kind === 'command') {
    const execution = response.executionResult as
      | {
          actions?: Array<{ deviceId: string; command: string; success: boolean; error?: string }>;
          verification?: { verdict?: string; explanation?: string };
        }
      | undefined;
    // R40-B1: the VERIFY-BEFORE-ACT outcome rides the response — surface the
    // verdict (and, for a degradation, WHY the batch was blocked) instead of
    // letting the prediction vanish between --json runs.
    const verification = execution?.verification;
    if (verification !== undefined) {
      const blocked = verification.verdict === 'degradation';
      // R103 (zhao-24): unverified/inconclusive is NOT a ✓ — the reply's
      // icons must agree with its verdict (self-report == verification).
      const affirmed = verification.verdict === 'improvement' || verification.verdict === 'neutral';
      const explanation = (verification.explanation ?? '').replace(/\s+/g, ' ').trim();
      ctx.out.line(
        `  ${affirmed ? '✓' : '⚠'} verification: ${verification.verdict ?? '?'}` +
          (blocked
            ? ` — command BLOCKED, the what-if fork predicted a degradation` +
              (explanation.length > 0 ? `: ${explanation.slice(0, 200)}${explanation.length > 200 ? '…' : ''}` : '')
            : explanation.length > 0
              ? ` — ${explanation.slice(0, 200)}${explanation.length > 200 ? '…' : ''}`
              : ''),
      );
    }
    const actions = execution?.actions ?? [];
    for (const action of actions) {
      ctx.out.line(
        `  ${action.success ? '✓' : '✗'} ${action.deviceId} ${action.command}` +
        `${action.error !== undefined ? ` — ${action.error}` : ''}`,
      );
    }
  }
}

/**
 * R40-B1: the what-if lane's CLI face — `eaf agent what-if` asks a
 * hypothetical ("what if I turn off hvac-1 for 30 minutes?") and the
 * platform answers by simulating BOTH arms on private forks of the live
 * world (never mutating it). Human output: verdict + confidence + a
 * per-metric delta table; --json carries the full series/contributions.
 */
/**
 * T27 (R3, u1-F4): the what-if human face as a PURE function (fixture
 * testable). R102: the fork's PROVENANCE rides the human face — which world
 * was simulated (world-session vs the sim the caller pointed at), at which
 * sim-time anchor, over which window. Batch 2 shipped forkSource/simTimeSec
 * in --json only, so a user watching her own accelerated sim read a
 * "sim-time 270" answer against her live 110,520 world and could not tell
 * the fork had tested a different world.
 */
export interface WhatIfHumanRender {
  /** Lines before the delta table (verdict + fork provenance). */
  header: string[];
  /** The per-metric delta table rows (rendered via out.table). */
  deltaRows: Array<{ metric: string; delta: string }>;
  /** Lines after the table (explanation + disambiguation notes). */
  tail: string[];
}

/**
 * T27 (R3, u1-F4): the what-if human face as a PURE function (fixture
 * testable). R102: the fork's PROVENANCE rides the human face — which world
 * was simulated (world-session vs the sim the caller pointed at), at which
 * sim-time anchor, over which window. Batch 2 shipped forkSource/simTimeSec
 * in --json only, so a user watching her own accelerated sim read a
 * "sim-time 270" answer against her live 110,520 world and could not tell
 * the fork had tested a different world.
 */
export function renderWhatIf(response: Record<string, unknown>): WhatIfHumanRender {
  const result = (response.result ?? {}) as {
    verdict?: string;
    confidence?: number;
    delta?: Record<string, number>;
    explanation?: string;
    notes?: string[];
    scenario?: { durationSec?: number };
  };
  const verdict = result.verdict ?? 'unknown';
  const icon = verdict === 'degradation' ? '✗' : verdict === 'improvement' ? '✓' : '·';
  // T109 (R18, u1-F1): the jurisdiction disclosure leads the face — a
  // cross-district intervention is previewed only under a stated authority
  // boundary (the same first-line discipline as the ask face's T105 note).
  // Standalone-field rendering keeps R102 intact even if the server join
  // shape drifts (renderAskLines precedent).
  const jurisdiction = typeof response.jurisdictionNote === 'string' ? response.jurisdictionNote.trim() : '';
  const header: string[] = [];
  if (jurisdiction.length > 0) header.push(jurisdiction);
  // T122 (R17-u3/R19-u4): the env default-simulation disclosure — the world
  // the resolved agent came from when the owner's binding decided.
  const simNote = typeof response.defaultSimNote === 'string' ? response.defaultSimNote.trim() : '';
  if (simNote.length > 0) header.push(simNote);
  header.push(
    `${icon} what-if: ${verdict}` +
      (typeof result.confidence === 'number' ? ` (confidence ${result.confidence})` : ''),
  );
  // Fork provenance — first-screen, human (T27): kind + sim id + the
  // sim-time anchor + the simulated window. Absent fields (pre-R81 server)
  // skip the line rather than print '?' soup.
  const forkSource = response.forkSource as { kind?: string; simulationId?: string } | undefined;
  const simTimeSec = typeof response.simTimeSec === 'number' ? response.simTimeSec : undefined;
  const durationSec = result.scenario?.durationSec;
  if (forkSource?.simulationId !== undefined && simTimeSec !== undefined) {
    header.push(
      `fork 来源: ${forkSource.kind ?? 'world'} ${forkSource.simulationId} ` +
        `@ sim-time ${simTimeSec}s（${typeof durationSec === 'number' ? `${durationSec}s 模拟窗` : '窗口见 --json'}）`,
    );
  }
  const deltaRows = Object.entries(result.delta ?? {}).map(([metric, change]) => ({
    metric,
    delta: typeof change === 'number' ? `${change >= 0 ? '+' : ''}${Math.round(change * 1000) / 1000}` : String(change),
  }));
  const tail: string[] = [];
  if (result.explanation !== undefined && result.explanation.length > 0) {
    tail.push(String(result.explanation));
  }
  // R101 (zhao-16, third recurrence): the disambiguation block is part of
  // the DEFAULT human output — candidates, the choice basis, and how to
  // pick another device. Two earlier rounds delivered this only in
  // --json notes; users who never pass --json saw nothing.
  for (const note of (result.notes ?? []).filter(n => n.includes('ambiguous target'))) {
    tail.push(`  ⚠ ${note}`);
  }
  return { header, deltaRows, tail };
}

async function whatIfCommand(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { sim: { type: 'string' }, text: { type: 'string' } }, USAGE_WHAT_IF);
  if (positionals.length === 0) {
    throw usageError(`expected <agentId> and the what-if question\nusage: ${USAGE_WHAT_IF}`);
  }
  const agentId = positionals[0];
  const flaggedText = stringFlag(flags, 'text');
  const positionalText = positionals.slice(1).join(' ').trim();
  if (flaggedText !== undefined && positionalText.length > 0) {
    throw usageError(`pass the text either as --text "…" or as trailing words, not both\nusage: ${USAGE_WHAT_IF}`);
  }
  const text = (flaggedText ?? positionalText).trim();
  if (text.length === 0) {
    throw usageError(`the what-if question must not be empty (open with "what if …")\nusage: ${USAGE_WHAT_IF}`);
  }
  const sim = stringFlag(flags, 'sim');
  const response = (await ctx.authedClient().post(
    `/api/agents/${encodeURIComponent(agentId)}/what-if`,
    { text, ...(sim !== undefined ? { simId: sim } : {}) },
  )) as Record<string, unknown>;

  if (ctx.json) {
    ctx.out.data(response);
    return;
  }

  const { header, deltaRows, tail } = renderWhatIf(response);
  for (const line of header) ctx.out.line(line);
  ctx.out.table(deltaRows, ['metric', 'delta']);
  for (const line of tail) ctx.out.line(line);
}

async function removeAgent(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_RM);
  const id = requirePositional(positionals, 'agentId', USAGE_RM);
  const response = await ctx.authedClient().delete(`/api/agents/${encodeURIComponent(id)}`);
  // T-048: a builder removing their OWN agent gets the auto-submitted
  // remove-agents PROPOSAL (201 + body), not a deletion — report that truth.
  // The env-owner path answers 204 (no body); a foreign agent 403s as-is.
  if (isEnvProposal(response)) {
    if (response.status === 'applied') {
      // The pipeline approved it inside the submit call — the agent is gone.
      if (ctx.json) ctx.out.data({ ...response, proposal: true });
      else ctx.out.line(`proposal ${response.id} applied — agent ${id} removed`);
      return;
    }
    reportGovernedProposal(ctx, response, `agent ${id} leaves the world when the pipeline approves it`);
    return;
  }
  if (ctx.json) ctx.out.data({ deleted: id });
  else ctx.out.line(`deleted agent ${id}`);
}
